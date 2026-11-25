import { PoolClient } from 'pg';
import { withTransaction } from '../db';
import { ShardName, SYSTEM_ACTOR_ID } from '../config';
import { newId } from '../uuid';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { adjustStock } from './inventory.service';

interface ServiceBase {
  shard: ShardName;
  warehouseId: string;
  createdBy?: string;
  client?: PoolClient;
}

export interface CycleCountItemInput {
  locationId: string;
  productId: string;
  batchId: string | null;
  countedQty: number;
  reason?: string;
}

function generateCountCode(): string {
  return `KK-${Date.now()}-${newId().slice(0, 8).toUpperCase()}`;
}

/**
 * Lập phiếu kiểm kê 2 chiều: chụp tồn sổ sách (expected_qty) và tồn thực tế
 * (counted_qty). Chưa làm thay đổi tồn kho ở bước này.
 */
export async function createCycleCount(
  input: ServiceBase & { items: CycleCountItemInput[]; note?: string }
) {
  if (!input.items.length) {
    throw new ValidationError('Phiếu kiểm kê cần ít nhất một dòng hàng');
  }
  if (input.client) return createCycleCountTx(input.client, input);
  return withTransaction(input.shard, (client) => createCycleCountTx(client, input));
}

async function createCycleCountTx(
  client: PoolClient,
  input: ServiceBase & { items: CycleCountItemInput[]; note?: string }
) {
  const actor = input.createdBy || SYSTEM_ACTOR_ID;
  const countId = newId();
  const countCode = generateCountCode();

  await client.query(
    `INSERT INTO stock_counts
       (id, warehouse_id, count_code, status, counted_by, counted_at, note)
     VALUES ($1,$2,$3,'DRAFT',$4,NOW(),$5)`,
    [countId, input.warehouseId, countCode, actor, input.note || null]
  );

  const items = [];
  for (const item of input.items) {
    if (!Number.isFinite(item.countedQty) || item.countedQty < 0) {
      throw new ValidationError('Số lượng kiểm đếm thực tế không được âm');
    }

    const expected = await client.query<{ physical_qty: string }>(
      `SELECT physical_qty
         FROM inventory_balances
        WHERE warehouse_id = $1
          AND location_id = $2
          AND product_id = $3
          AND batch_id IS NOT DISTINCT FROM $4`,
      [input.warehouseId, item.locationId, item.productId, item.batchId]
    );
    const expectedQty = expected.rowCount ? Number(expected.rows[0].physical_qty) : 0;

    await client.query(
      `INSERT INTO stock_count_items
         (id, warehouse_id, count_id, location_id, product_id, batch_id,
          expected_qty, counted_qty, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        newId(),
        input.warehouseId,
        countId,
        item.locationId,
        item.productId,
        item.batchId,
        expectedQty,
        item.countedQty,
        item.reason || null,
      ]
    );

    items.push({
      locationId: item.locationId,
      productId: item.productId,
      batchId: item.batchId,
      expectedQty,
      countedQty: item.countedQty,
      difference: item.countedQty - expectedQty,
    });
  }

  return { countId, countCode, status: 'DRAFT', items };
}

/**
 * Duyệt phiếu: mỗi dòng chênh lệch được phát hành một bản ghi ADJUSTMENT mới
 * (không ghi đè lịch sử) trong CÙNG transaction với việc khóa phiếu kiểm kê.
 */
export async function approveCycleCount(
  input: ServiceBase & { countId: string }
) {
  if (input.client) return approveCycleCountTx(input.client, input);
  return withTransaction(input.shard, (client) => approveCycleCountTx(client, input));
}

async function approveCycleCountTx(
  client: PoolClient,
  input: ServiceBase & { countId: string }
) {
  const header = await client.query<{ id: string; count_code: string; status: string }>(
    `SELECT id, count_code, status
       FROM stock_counts
      WHERE id = $1 AND warehouse_id = $2
      FOR UPDATE`,
    [input.countId, input.warehouseId]
  );
  if (!header.rowCount) {
    throw new NotFoundError('Không tìm thấy phiếu kiểm kê');
  }
  if (header.rows[0].status !== 'DRAFT') {
    throw new ConflictError('Phiếu kiểm kê đã được xử lý, không thể duyệt lại');
  }

  const items = await client.query<{
    id: string;
    location_id: string;
    product_id: string;
    batch_id: string | null;
    expected_qty: string;
    counted_qty: string;
    reason: string | null;
  }>(
    `SELECT id, location_id, product_id, batch_id, expected_qty, counted_qty, reason
       FROM stock_count_items
      WHERE count_id = $1 AND warehouse_id = $2
      ORDER BY created_at ASC`,
    [input.countId, input.warehouseId]
  );

  const actor = input.createdBy || SYSTEM_ACTOR_ID;
  let adjustments = 0;

  for (const item of items.rows) {
    const countedQty = Number(item.counted_qty);
    const expectedQty = Number(item.expected_qty);
    if (countedQty === expectedQty) continue;

    const balance = await client.query<{ id: string }>(
      `SELECT id
         FROM inventory_balances
        WHERE warehouse_id = $1
          AND location_id = $2
          AND product_id = $3
          AND batch_id IS NOT DISTINCT FROM $4`,
      [input.warehouseId, item.location_id, item.product_id, item.batch_id]
    );

    if (!balance.rowCount && countedQty > 0) {
      throw new ValidationError(
        'Không tìm thấy dòng tồn để điều chỉnh theo số lượng kiểm đếm thực tế'
      );
    }
    if (!balance.rowCount) continue; // sổ sách 0, thực tế 0 -> không cần ghi

    const reason =
      `Kiểm kê ${header.rows[0].count_code}: sổ ${expectedQty}, thực tế ${countedQty}` +
      (item.reason ? ` - ${item.reason}` : '');

    await adjustStock({
      shard: input.shard,
      warehouseId: input.warehouseId,
      balanceId: balance.rows[0].id,
      newPhysicalQty: countedQty,
      reason,
      createdBy: actor,
      client,
    });
    adjustments += 1;
  }

  await client.query(
    `UPDATE stock_counts
        SET status = 'APPROVED', approved_by = $3, approved_at = NOW()
      WHERE id = $1 AND warehouse_id = $2`,
    [input.countId, input.warehouseId, actor]
  );

  return {
    countId: input.countId,
    countCode: header.rows[0].count_code,
    status: 'APPROVED',
    adjustments,
  };
}

export async function rejectCycleCount(
  input: ServiceBase & { countId: string }
) {
  if (input.client) return rejectCycleCountTx(input.client, input);
  return withTransaction(input.shard, (client) => rejectCycleCountTx(client, input));
}

async function rejectCycleCountTx(
  client: PoolClient,
  input: ServiceBase & { countId: string }
) {
  const result = await client.query<{ count_code: string }>(
    `UPDATE stock_counts
        SET status = 'REJECTED', approved_by = $3, approved_at = NOW()
      WHERE id = $1 AND warehouse_id = $2 AND status = 'DRAFT'
      RETURNING count_code`,
    [input.countId, input.warehouseId, input.createdBy || SYSTEM_ACTOR_ID]
  );
  if (!result.rowCount) {
    throw new ConflictError('Chỉ có thể từ chối phiếu kiểm kê đang ở trạng thái DRAFT');
  }
  return { countId: input.countId, countCode: result.rows[0].count_code, status: 'REJECTED' };
}

export async function getCycleCount(
  shard: ShardName,
  warehouseId: string,
  countId: string
) {
  const header = await withTransaction(shard, async (client) => {
    const result = await client.query(
      `SELECT * FROM stock_counts WHERE id = $1 AND warehouse_id = $2`,
      [countId, warehouseId]
    );
    if (!result.rowCount) throw new NotFoundError('Không tìm thấy phiếu kiểm kê');
    return result.rows[0];
  });
  const items = await withTransaction(shard, async (client) => {
    const result = await client.query(
      `SELECT * FROM stock_count_items
        WHERE count_id = $1 AND warehouse_id = $2
        ORDER BY created_at ASC`,
      [countId, warehouseId]
    );
    return result.rows;
  });
  return { ...header, items };
}
