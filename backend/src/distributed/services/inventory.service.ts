import { PoolClient } from 'pg';
import { query, Queryable, withTransaction } from '../db';
import { queryRead } from '../infra/read-db';
import { ShardName } from '../config';
import { SYSTEM_ACTOR_ID, RESERVATION_TTL_MINUTES } from '../config';
import {
  NotFoundError,
  StockConflictError,
  ValidationError,
} from '../errors';
import { newId } from '../uuid';
import { insertOutboxEvent } from '../events';

export interface BalanceRow {
  id: string;
  warehouse_id: string;
  location_id: string;
  product_id: string;
  batch_id: string | null;
  physical_qty: string;
  reserved_qty: string;
  available_qty: string;
  version: number;
  updated_at: string;
  expiry_date?: string | null;
  location_type?: string;
}

export interface Allocation {
  balanceId: string;
  locationId: string;
  batchId: string | null;
  productId: string;
  qty: number;
  physicalAfter: number;
}

interface LedgerInput {
  client: Queryable;
  warehouseId: string;
  locationId: string;
  productId: string;
  batchId: string | null;
  movementType:
    | 'INBOUND'
    | 'OUTBOUND'
    | 'TRANSFER_OUT'
    | 'TRANSFER_IN'
    | 'ADJUSTMENT';
  qtyDelta: number;
  balanceAfter: number;
  referenceType: string;
  referenceId: string;
  createdBy?: string;
}

export async function insertLedger(input: LedgerInput): Promise<string> {
  const id = newId();
  await input.client.query(
    `INSERT INTO stock_ledger
       (id, warehouse_id, location_id, product_id, batch_id, movement_type,
        qty_delta, balance_after, reference_type, reference_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      input.warehouseId,
      input.locationId,
      input.productId,
      input.batchId,
      input.movementType,
      input.qtyDelta,
      input.balanceAfter,
      input.referenceType,
      input.referenceId,
      input.createdBy || SYSTEM_ACTOR_ID,
    ]
  );
  return id;
}

async function assertWarehouse(
  client: Queryable,
  warehouseId: string
): Promise<void> {
  const { rowCount } = await client.query(
    'SELECT 1 FROM warehouses WHERE id = $1 AND is_active = TRUE',
    [warehouseId]
  );
  if (!rowCount) {
    throw new ValidationError('Kho không tồn tại hoặc đang ngừng hoạt động');
  }
}

function assertPositiveQty(qty: number, label = 'Số lượng'): void {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new ValidationError(`${label} phải lớn hơn 0`);
  }
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Tìm warehouse theo mã (master data được replicate ở mọi shard). */
export async function findWarehouseByCode(
  shard: ShardName,
  code: string
): Promise<{ id: string; code: string; name: string; is_active: boolean }> {
  const result = await query<{
    id: string;
    code: string;
    name: string;
    is_active: boolean;
  }>(
    shard,
    `SELECT id, code, name, is_active FROM warehouses WHERE code = $1`,
    [code]
  );
  if (!result.rowCount) {
    throw new NotFoundError(`Không tìm thấy kho với mã ${code}`);
  }
  return result.rows[0];
}

/** Cộng tồn vào đúng tổ hợp 4 chiều (warehouse, location, product, batch). */
interface InboundInput {
  shard: ShardName;
  warehouseId: string;
  locationId: string;
  productId: string;
  batchId: string | null;
  qty: number;
  referenceType: string;
  referenceId: string;
  movementType?: 'INBOUND' | 'TRANSFER_IN';
  createdBy?: string;
  client?: PoolClient;
}

export async function inboundStock(input: InboundInput): Promise<BalanceRow> {
  assertPositiveQty(input.qty);
  if (input.client) {
    return inboundStockTx(input.client, input);
  }
  return withTransaction(input.shard, (client) => inboundStockTx(client, input));
}

async function inboundStockTx(
  client: PoolClient,
  input: InboundInput
): Promise<BalanceRow> {
    await assertWarehouse(client, input.warehouseId);

    const upsert = await client.query<BalanceRow>(
      `INSERT INTO inventory_balances
         (id, warehouse_id, location_id, product_id, batch_id, physical_qty, reserved_qty, version)
       VALUES ($1,$2,$3,$4,$5,$6,0,1)
       ON CONFLICT ON CONSTRAINT uq_inventory_slot
       DO UPDATE SET
         physical_qty = inventory_balances.physical_qty + EXCLUDED.physical_qty,
         version = inventory_balances.version + 1,
         updated_at = NOW()
       RETURNING *`,
      [
        newId(),
        input.warehouseId,
        input.locationId,
        input.productId,
        input.batchId,
        input.qty,
      ]
    );

    const balance = upsert.rows[0];
    await insertLedger({
      client,
      warehouseId: input.warehouseId,
      locationId: input.locationId,
      productId: input.productId,
      batchId: input.batchId,
      movementType: input.movementType || 'INBOUND',
      qtyDelta: input.qty,
      balanceAfter: toNumber(balance.physical_qty),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      createdBy: input.createdBy,
    });
    return balance;
}

/**
 * FEFO reservation: lấy các lô AVAILABLE ở ô pickable, sort hạn dùng ASC NULLS LAST,
 * khóa từng dòng bằng optimistic locking (version + available_qty).
 */
interface ReserveInput {
  shard: ShardName;
  warehouseId: string;
  productId: string;
  qty: number;
  referenceType: 'OUTBOUND_ORDER' | 'STOCK_TRANSFER';
  referenceId: string;
  createdBy?: string;
  /** Khi được truyền, dùng chung transaction của service cấp trên. */
  client?: PoolClient;
}

interface ConsumeInput {
  shard: ShardName;
  warehouseId: string;
  referenceType: 'OUTBOUND_ORDER' | 'STOCK_TRANSFER';
  referenceId: string;
  movementType: 'OUTBOUND' | 'TRANSFER_OUT';
  orderId?: string;
  createdBy?: string;
  client?: PoolClient;
}

export async function reserveStockFefo(input: ReserveInput): Promise<Allocation[]> {
  assertPositiveQty(input.qty);
  if (input.client) {
    return reserveStockFefoTx(input.client, input);
  }
  return withTransaction(input.shard, (client) => reserveStockFefoTx(client, input));
}

async function reserveStockFefoTx(
  client: PoolClient,
  input: ReserveInput
): Promise<Allocation[]> {
  await assertWarehouse(client, input.warehouseId);

  let remaining = input.qty;
  const allocations: Allocation[] = [];
  // Retry để xử lý stale version khi nhiều request cùng giành một lô.
  for (let attempt = 0; attempt < 8 && remaining > 0; attempt++) {
    const candidates = await client.query<BalanceRow>(
      `SELECT ib.*, b.expiry_date
         FROM inventory_balances ib
         JOIN locations l
           ON l.id = ib.location_id
          AND l.is_pickable = TRUE
          AND l.warehouse_id = ib.warehouse_id
         LEFT JOIN batches b ON b.id = ib.batch_id
        WHERE ib.warehouse_id = $1
          AND ib.product_id = $2
          AND ib.available_qty > 0
          AND (b.id IS NULL OR b.status = 'AVAILABLE')
        ORDER BY b.expiry_date ASC NULLS LAST, ib.id ASC
        -- Khóa dòng tồn: 50 request cùng giành một lô phải xếp hàng. Khi được
        -- cấp khóa, Postgres đọc lại version mới nhất -> không tốn retry và
        -- không để lại tồn (invariant 10 thành công / 40 từ chối).
        FOR UPDATE OF ib`,
      [input.warehouseId, input.productId]
    );

    let progressed = false;
    for (const candidate of candidates.rows) {
      if (remaining <= 0) break;
      const available = toNumber(candidate.available_qty);
      const take = Math.min(available, remaining);

      const updated = await client.query<BalanceRow>(
        `UPDATE inventory_balances
            SET reserved_qty = reserved_qty + $4,
                version = version + 1,
                updated_at = NOW()
          WHERE id = $1
            AND warehouse_id = $2
            AND version = $3
            AND available_qty >= $4
          RETURNING *`,
        [candidate.id, input.warehouseId, candidate.version, take]
      );
      if (!updated.rowCount) continue; // stale -> thử vòng sau

      const reservationId = newId();
      await client.query(
        `INSERT INTO inventory_reservations
           (id, warehouse_id, balance_id, reference_type, reference_id, qty,
            status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE', NOW() + ($7 || ' minutes')::interval)`,
        [
          reservationId,
          input.warehouseId,
          candidate.id,
          input.referenceType,
          input.referenceId,
          take,
          String(RESERVATION_TTL_MINUTES),
        ]
      );

      allocations.push({
        balanceId: candidate.id,
        locationId: candidate.location_id,
        batchId: candidate.batch_id,
        productId: candidate.product_id,
        qty: take,
        physicalAfter: toNumber(updated.rows[0].physical_qty),
      });
      remaining -= take;
      progressed = true;
    }
    if (!progressed) break;
  }

  if (remaining > 0) {
    throw new StockConflictError(
      `Không đủ tồn khả dụng để đặt trước (thiếu ${remaining})`,
      { remaining }
    );
  }
  return allocations;
}

/**
 * Tiêu thụ reservation: trừ physical + reserved, ghi ledger, đánh dấu FULFILLED.
 * movementType = OUTBOUND cho xuất bán, TRANSFER_OUT cho điều chuyển đi.
 */
export async function consumeReservations(
  input: ConsumeInput
): Promise<Allocation[]> {
  if (input.client) {
    return consumeReservationsTx(input.client, input);
  }
  return withTransaction(input.shard, (client) => consumeReservationsTx(client, input));
}

async function consumeReservationsTx(
  client: PoolClient,
  input: ConsumeInput
): Promise<Allocation[]> {
  const reservations = await client.query<{
    id: string;
    balance_id: string;
    qty: string;
    status: string;
  }>(
    `SELECT id, balance_id, qty, status
       FROM inventory_reservations
      WHERE warehouse_id = $1
        AND reference_type = $2
        AND reference_id = $3
        AND status = 'ACTIVE'
      ORDER BY created_at ASC`,
    [input.warehouseId, input.referenceType, input.referenceId]
  );
  if (!reservations.rowCount) {
    throw new NotFoundError('Không tìm thấy reservation ACTIVE để xuất kho');
  }

  const allocations: Allocation[] = [];
  for (const reservation of reservations.rows) {
    const qty = toNumber(reservation.qty);
    const versionRow = await client.query<{ version: number }>(
      'SELECT version FROM inventory_balances WHERE id = $1 AND warehouse_id = $2',
      [reservation.balance_id, input.warehouseId]
    );
    const updated = await client.query<BalanceRow>(
      `UPDATE inventory_balances
          SET physical_qty = physical_qty - $4,
              reserved_qty = reserved_qty - $4,
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1
          AND warehouse_id = $2
          AND version = $3
          -- available_qty đã giảm khi reserve; tiêu thụ phải đối chiếu
          -- physical_qty và reserved_qty chứ không đối chiếu available_qty.
          AND physical_qty >= $4
          AND reserved_qty >= $4
        RETURNING *`,
      [
        reservation.balance_id,
        input.warehouseId,
        versionRow.rows[0].version,
        qty,
      ]
    );
    if (!updated.rowCount) {
      throw new StockConflictError(
        'Tồn kho đã thay đổi trong lúc xuất kho, yêu cầu bị hủy để tránh tồn âm'
      );
    }
    const balance = updated.rows[0];

    await client.query(
      `UPDATE inventory_reservations
          SET status = 'FULFILLED'
        WHERE id = $1 AND status = 'ACTIVE'`,
      [reservation.id]
    );

    await insertLedger({
      client,
      warehouseId: input.warehouseId,
      locationId: balance.location_id,
      productId: balance.product_id,
      batchId: balance.batch_id,
      movementType: input.movementType,
      qtyDelta: -qty,
      balanceAfter: toNumber(balance.physical_qty),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      createdBy: input.createdBy,
    });

    allocations.push({
      balanceId: balance.id,
      locationId: balance.location_id,
      batchId: balance.batch_id,
      productId: balance.product_id,
      qty,
      physicalAfter: toNumber(balance.physical_qty),
    });
  }

  if (input.orderId) {
    await client.query(
      `UPDATE stock_orders
          SET status = 'COMPLETED', completed_at = NOW()
        WHERE id = $1 AND warehouse_id = $2 AND status <> 'COMPLETED'`,
      [input.orderId, input.warehouseId]
    );
  }
  return allocations;
}

/**
 * Điều chỉnh tồn: KHÔNG ghi đè lịch sử. Ghi bản ghi ADJUSTMENT mới với qty_delta.
 */
interface AdjustInput {
  shard: ShardName;
  warehouseId: string;
  balanceId: string;
  newPhysicalQty: number;
  reason: string;
  createdBy?: string;
  client?: PoolClient;
}

export async function adjustStock(input: AdjustInput): Promise<BalanceRow> {
  if (!Number.isFinite(input.newPhysicalQty) || input.newPhysicalQty < 0) {
    throw new ValidationError('Số lượng tồn mới không được âm');
  }
  if (!input.reason?.trim()) {
    throw new ValidationError('Vui lòng nhập lý do điều chỉnh tồn kho');
  }
  if (input.client) return adjustStockTx(input.client, input);
  return withTransaction(input.shard, (client) => adjustStockTx(client, input));
}

async function adjustStockTx(
  client: PoolClient,
  input: AdjustInput
): Promise<BalanceRow> {
    const current = await client.query<BalanceRow>(
      'SELECT * FROM inventory_balances WHERE id = $1 AND warehouse_id = $2 FOR UPDATE',
      [input.balanceId, input.warehouseId]
    );
    if (!current.rowCount) throw new NotFoundError('Không tìm thấy dòng tồn kho');
    const balance = current.rows[0];
    const delta = input.newPhysicalQty - toNumber(balance.physical_qty);
    if (delta === 0) return balance;

    const absDelta = Math.abs(delta);
    const updated = await client.query<BalanceRow>(
      `UPDATE inventory_balances
          SET physical_qty = physical_qty + $4,
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1
          AND warehouse_id = $2
          AND version = $3
          AND (
            $4 >= 0
            OR (available_qty >= $5 AND $4 < 0)
          )
        RETURNING *`,
      [
        balance.id,
        input.warehouseId,
        balance.version,
        delta,
        absDelta,
      ]
    );
    if (!updated.rowCount) {
      throw new StockConflictError(
        'Không thể giảm tồn thấp hơn số lượng đang được giữ chỗ'
      );
    }

    const orderId = newId();
    const orderCode = `ADJ-${Date.now()}-${newId().slice(0, 6).toUpperCase()}`;
    await client.query(
      `INSERT INTO stock_orders
         (id, warehouse_id, order_code, order_type, status, created_by, completed_at)
       VALUES ($1,$2,$3,'ADJUSTMENT','COMPLETED',$4,NOW())`,
      [orderId, input.warehouseId, orderCode, input.createdBy || SYSTEM_ACTOR_ID]
    );
    await client.query(
      `INSERT INTO stock_order_items
         (id, warehouse_id, order_id, product_id, batch_id, location_id, expected_qty, actual_qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [
        newId(),
        input.warehouseId,
        orderId,
        balance.product_id,
        balance.batch_id,
        balance.location_id,
        absDelta,
      ]
    );

    await insertLedger({
      client,
      warehouseId: input.warehouseId,
      locationId: balance.location_id,
      productId: balance.product_id,
      batchId: balance.batch_id,
      movementType: 'ADJUSTMENT',
      qtyDelta: delta,
      balanceAfter: toNumber(updated.rows[0].physical_qty),
      referenceType: 'ADJUSTMENT_ORDER',
      referenceId: orderId,
      createdBy: input.createdBy,
    });
    return updated.rows[0];
}

/** Job mỗi 1 phút: giải phóng reservation hết hạn. */
export async function releaseExpiredReservations(
  shard: ShardName
): Promise<number> {
  return withTransaction(shard, async (client) => {
    const expired = await client.query<{
      id: string;
      warehouse_id: string;
      balance_id: string;
      qty: string;
    }>(
      `SELECT id, warehouse_id, balance_id, qty
         FROM inventory_reservations
        WHERE status = 'ACTIVE' AND expires_at < NOW()
        ORDER BY expires_at ASC
        LIMIT 200`
    );
    let released = 0;

    for (const reservation of expired.rows) {
      const current = await client.query<{ version: number }>(
        'SELECT version FROM inventory_balances WHERE id = $1 AND warehouse_id = $2',
        [reservation.balance_id, reservation.warehouse_id]
      );
      if (!current.rowCount) continue;
      const updated = await client.query(
        `UPDATE inventory_balances
            SET reserved_qty = reserved_qty - $4,
                version = version + 1,
                updated_at = NOW()
          WHERE id = $1
            AND warehouse_id = $2
            AND version = $3
            AND reserved_qty >= $4
            AND physical_qty >= reserved_qty - $4`,
        [
          reservation.balance_id,
          reservation.warehouse_id,
          current.rows[0].version,
          reservation.qty,
        ]
      );
      if (!updated.rowCount) continue;
      await client.query(
        `UPDATE inventory_reservations
            SET status = 'RELEASED'
          WHERE id = $1 AND status = 'ACTIVE'`,
        [reservation.id]
      );
      released += 1;
    }
    return released;
  });
}

export async function getInventory(
  shard: ShardName,
  warehouseId: string,
  productId?: string
): Promise<BalanceRow[]> {
  const result = await query<BalanceRow>(
    shard,
    `SELECT ib.*, p.sku, p.name AS product_name, b.batch_number, l.code AS location_code
       FROM inventory_balances ib
       LEFT JOIN products p ON p.id = ib.product_id
       LEFT JOIN batches b ON b.id = ib.batch_id
       LEFT JOIN locations l ON l.id = ib.location_id
      WHERE ib.warehouse_id = $1
        AND ($2::uuid IS NULL OR ib.product_id = $2)
      ORDER BY p.sku, b.expiry_date NULLS LAST`,
    [warehouseId, productId || null]
  );
  return result.rows;
}

/**
 * Đối soát 3 chỉ số tồn với nguồn chân lý:
 *  - physical_qty  == SUM(stock_ledger.qty_delta)
 *  - reserved_qty  == SUM(inventory_reservations.qty) WHERE status = 'ACTIVE'
 *  - available_qty = physical_qty - reserved_qty (generated column)
 */
export async function reconcileInventory(
  shard: ShardName,
  warehouseId: string
): Promise<{
  warehouseId: string;
  totalBalances: number;
  mismatchCount: number;
  mismatches: Array<{
    balanceId: string;
    physicalQty: number;
    ledgerTotal: number;
    reservedQty: number;
    activeReservations: number;
  }>;
}> {
  const result = await query<{
    id: string;
    physical_qty: string;
    reserved_qty: string;
    ledger_total: string;
    active_reserved: string;
  }>(
    shard,
    `SELECT ib.id,
            ib.physical_qty,
            ib.reserved_qty,
            COALESCE((
              SELECT SUM(sl.qty_delta)
                FROM stock_ledger sl
               WHERE sl.warehouse_id = ib.warehouse_id
                 AND sl.location_id = ib.location_id
                 AND sl.product_id = ib.product_id
                 AND sl.batch_id IS NOT DISTINCT FROM ib.batch_id
            ), 0) AS ledger_total,
            COALESCE((
              SELECT SUM(ir.qty)
                FROM inventory_reservations ir
               WHERE ir.warehouse_id = ib.warehouse_id
                 AND ir.balance_id = ib.id
                 AND ir.status = 'ACTIVE'
            ), 0) AS active_reserved
       FROM inventory_balances ib
      WHERE ib.warehouse_id = $1`,
    [warehouseId]
  );

  const mismatches = result.rows
    .map((row) => ({
      balanceId: row.id,
      physicalQty: Number(row.physical_qty),
      ledgerTotal: Number(row.ledger_total),
      reservedQty: Number(row.reserved_qty),
      activeReservations: Number(row.active_reserved),
    }))
    .filter(
      (row) =>
        Math.abs(row.physicalQty - row.ledgerTotal) > 0.0001 ||
        Math.abs(row.reservedQty - row.activeReservations) > 0.0001
    );

  return {
    warehouseId,
    totalBalances: result.rows.length,
    mismatchCount: mismatches.length,
    mismatches,
  };
}

/** CQRS read model: tổng hợp 3 chỉ số tồn theo sản phẩm, đọc từ read replica. */
export async function getInventorySummary(
  shard: ShardName,
  warehouseId: string
): Promise<{
  source: 'REPLICA' | 'PRIMARY';
  warehouseId: string;
  items: Array<{
    productId: string;
    sku: string | null;
    productName: string | null;
    physicalQty: number;
    reservedQty: number;
    availableQty: number;
  }>;
}> {
  const result = await queryRead<{
    product_id: string;
    sku: string | null;
    product_name: string | null;
    physical_qty: string;
    reserved_qty: string;
    available_qty: string;
  }>(
    shard,
    `SELECT p.id AS product_id,
            p.sku,
            p.name AS product_name,
            SUM(ib.physical_qty) AS physical_qty,
            SUM(ib.reserved_qty) AS reserved_qty,
            SUM(ib.available_qty) AS available_qty
       FROM inventory_balances ib
       JOIN products p ON p.id = ib.product_id
      WHERE ib.warehouse_id = $1
      GROUP BY p.id, p.sku, p.name
      ORDER BY p.sku`,
    [warehouseId]
  );

  const usesReplica =
    shard === 'north' &&
    !!process.env.DB_REPLICA_URL &&
    process.env.REPLICA_READS_ENABLED !== 'false';

  return {
    source: usesReplica ? 'REPLICA' : 'PRIMARY',
    warehouseId,
    items: result.rows.map((row) => ({
      productId: row.product_id,
      sku: row.sku,
      productName: row.product_name,
      physicalQty: Number(row.physical_qty),
      reservedQty: Number(row.reserved_qty),
      availableQty: Number(row.available_qty),
    })),
  };
}

export { insertOutboxEvent };
