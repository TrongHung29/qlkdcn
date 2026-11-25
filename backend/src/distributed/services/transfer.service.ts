import { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { ShardName, SYSTEM_ACTOR_ID } from '../config';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { newId } from '../uuid';
import { insertOutboxEvent, SagaEvent } from '../events';
import {
  Allocation,
  consumeReservations,
  insertLedger,
  reserveStockFefo,
} from './inventory.service';

export interface TransferItemInput {
  productId: string;
  qty: number;
}

export interface TransferEventItem {
  balanceId: string;
  locationId: string;
  productId: string;
  batchId: string | null;
  qty: number;
}

interface ServiceBase {
  shard: ShardName;
  warehouseId: string;
  createdBy?: string;
  client?: PoolClient;
}

export async function createTransfer(
  input: ServiceBase & {
    fromWarehouseId: string;
    toWarehouseId: string;
    items: TransferItemInput[];
  }
) {
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new ValidationError('Kho nguồn và kho đích phải khác nhau');
  }
  if (!input.items.length) {
    throw new ValidationError('Phiếu điều chuyển cần ít nhất một dòng hàng');
  }
  if (input.client) return createTransferTx(input.client, input);
  return withTransaction(input.shard, (c) => createTransferTx(c, input));
}

async function createTransferTx(
  client: PoolClient,
  input: ServiceBase & {
    fromWarehouseId: string;
    toWarehouseId: string;
    items: TransferItemInput[];
  }
) {
  const actor = input.createdBy || SYSTEM_ACTOR_ID;
  const transferId = newId();
  const transferCode = `DC-${Date.now()}-${newId().slice(0, 8).toUpperCase()}`;
  await client.query(
    `INSERT INTO stock_transfers
       (id, warehouse_id, transfer_code, from_warehouse_id, to_warehouse_id,
        status, created_by)
     VALUES ($1,$2,$3,$4,$5,'APPROVED',$6)`,
    [
      transferId,
      input.warehouseId,
      transferCode,
      input.fromWarehouseId,
      input.toWarehouseId,
      actor,
    ]
  );

  for (const item of input.items) {
    await client.query(
      `INSERT INTO stock_transfer_items
         (id, warehouse_id, transfer_id, product_id, requested_qty)
       VALUES ($1,$2,$3,$4,$5)`,
      [newId(), input.warehouseId, transferId, item.productId, item.qty]
    );
    await reserveStockFefo({
      shard: input.shard,
      warehouseId: input.fromWarehouseId,
      productId: item.productId,
      qty: item.qty,
      referenceType: 'STOCK_TRANSFER',
      referenceId: transferId,
      createdBy: actor,
      client,
    });
  }
  return { transferId, transferCode, status: 'APPROVED' };
}

/**
 * Phase 1 Saga: trừ tồn nguồn + ledger + IN_TRANSIT + outbox trong MỘT local ACID tx.
 * Không 2PC, không đụng vào database của kho đích.
 */
export async function dispatchTransfer(
  input: ServiceBase & { transferId: string }
): Promise<SagaEvent> {
  if (input.client) return dispatchTransferTx(input.client, input);
  return withTransaction(input.shard, (c) => dispatchTransferTx(c, input));
}

async function dispatchTransferTx(
  client: PoolClient,
  input: ServiceBase & { transferId: string }
): Promise<SagaEvent> {
  const actor = input.createdBy || SYSTEM_ACTOR_ID;
  const transfer = await client.query<{
    id: string;
    transfer_code: string;
    from_warehouse_id: string;
    to_warehouse_id: string;
    to_warehouse_code: string;
    status: string;
  }>(
    `SELECT t.id, t.transfer_code, t.from_warehouse_id, t.to_warehouse_id,
            w.code AS to_warehouse_code, t.status
       FROM stock_transfers t
       JOIN warehouses w ON w.id = t.to_warehouse_id
      WHERE t.id = $1 AND t.warehouse_id = $2`,
    [input.transferId, input.warehouseId]
  );
  if (!transfer.rowCount) throw new NotFoundError('Không tìm thấy phiếu điều chuyển');
  const transferRow = transfer.rows[0];
  if (transferRow.status !== 'APPROVED') {
    throw new ConflictError(
      `Phiếu điều chuyển đang ở trạng thái ${transferRow.status}, không thể gửi hàng`
    );
  }

  const allocations: Allocation[] = await consumeReservations({
    shard: input.shard,
    warehouseId: input.warehouseId,
    referenceType: 'STOCK_TRANSFER',
    referenceId: input.transferId,
    movementType: 'TRANSFER_OUT',
    createdBy: actor,
    client,
  });

  await client.query(
    `UPDATE stock_transfers
        SET status = 'IN_TRANSIT', dispatched_at = NOW()
      WHERE id = $1 AND warehouse_id = $2`,
    [input.transferId, input.warehouseId]
  );

  const items: TransferEventItem[] = allocations.map((a) => ({
    balanceId: a.balanceId,
    locationId: a.locationId,
    productId: a.productId,
    batchId: a.batchId,
    qty: a.qty,
  }));
  for (const item of items) {
    await client.query(
      `UPDATE stock_transfer_items
          SET shipped_qty = shipped_qty + $3
        WHERE transfer_id = $1 AND product_id = $2 AND warehouse_id = $4`,
      [input.transferId, item.productId, item.qty, input.warehouseId]
    );
  }

  return insertOutboxEvent(client, {
    warehouseId: input.warehouseId,
    aggregateType: 'STOCK_TRANSFER',
    aggregateId: input.transferId,
    eventType: 'TransferDispatched',
    payload: {
      transferId: input.transferId,
      transferCode: transferRow.transfer_code,
      fromWarehouseId: transferRow.from_warehouse_id,
      toWarehouseId: transferRow.to_warehouse_id,
      toWarehouseCode: transferRow.to_warehouse_code,
      items,
    },
  });
}

/** Warehouse A: nhận TransferCompleted. */
export async function completeTransferTx(
  client: PoolClient,
  warehouseId: string,
  transferId: string,
  receivedAt: string
): Promise<void> {
  const result = await client.query(
    `UPDATE stock_transfers
        SET status = 'COMPLETED', received_at = $3
      WHERE id = $1 AND warehouse_id = $2 AND status = 'IN_TRANSIT'`,
    [transferId, warehouseId, receivedAt]
  );
  if (!result.rowCount) {
    throw new ConflictError('Không thể hoàn tất phiếu điều chuyển đang không IN_TRANSIT');
  }
}

/** Warehouse A: hoàn tồn khi Warehouse B từ chối (compensating transaction). */
export async function compensateTransferTx(
  client: PoolClient,
  warehouseId: string,
  transferId: string,
  items: TransferEventItem[],
  reason: string,
  createdBy = SYSTEM_ACTOR_ID
): Promise<void> {
  void reason; // lý do được consumer log lại ở lớp trên
  for (const item of items) {
    const current = await client.query<{
      location_id: string;
      product_id: string;
      batch_id: string | null;
      version: number;
    }>(
      `SELECT location_id, product_id, batch_id, version
         FROM inventory_balances
        WHERE id = $1 AND warehouse_id = $2`,
      [item.balanceId, warehouseId]
    );
    if (!current.rowCount) {
      throw new NotFoundError(`Không tìm thấy balanceId ${item.balanceId} để hoàn tồn`);
    }
    const balance = current.rows[0];
    const restored = await client.query<{ physical_qty: string }>(
      `UPDATE inventory_balances
          SET physical_qty = physical_qty + $4,
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1 AND warehouse_id = $2 AND version = $3
        RETURNING physical_qty`,
      [item.balanceId, warehouseId, balance.version, item.qty]
    );
    await insertLedger({
      client,
      warehouseId,
      locationId: balance.location_id,
      productId: balance.product_id,
      batchId: balance.batch_id,
      movementType: 'ADJUSTMENT',
      qtyDelta: item.qty,
      balanceAfter: Number(restored.rows[0].physical_qty),
      referenceType: 'TRANSFER_REJECTION',
      referenceId: transferId,
      createdBy,
    });
  }

  await client.query(
    `UPDATE stock_transfers
        SET status = 'CANCELLED', received_at = NOW()
      WHERE id = $1 AND warehouse_id = $2`,
    [transferId, warehouseId]
  );
}

export async function getTransfer(
  shard: ShardName,
  warehouseId: string,
  transferId: string
) {
  const result = await query(
    shard,
    `SELECT t.*,
            COALESCE(json_agg(json_build_object(
              'id', i.id, 'productId', i.product_id, 'batchId', i.batch_id,
              'requestedQty', i.requested_qty, 'shippedQty', i.shipped_qty,
              'receivedQty', i.received_qty
            )) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
       FROM stock_transfers t
       LEFT JOIN stock_transfer_items i ON i.transfer_id = t.id
      WHERE t.id = $1 AND t.warehouse_id = $2
      GROUP BY t.id`,
    [transferId, warehouseId]
  );
  if (!result.rowCount) throw new NotFoundError('Không tìm thấy phiếu điều chuyển');
  return result.rows[0];
}
