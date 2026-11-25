/**
 * Kiểm chứng các invariant phân tán bằng PostgreSQL thật (không cần RabbitMQ).
 * Chạy: npm run test:distributed
 */
import { closeAllPools, query, withTransaction } from '../src/distributed/db';
import { SHARDS, SYSTEM_ACTOR_ID } from '../src/distributed/config';
import { newId } from '../src/distributed/uuid';
import { quickOutbound } from '../src/distributed/services/orders.service';
import {
  createTransfer,
  dispatchTransfer,
  getTransfer,
} from '../src/distributed/services/transfer.service';
import {
  handleTransferDispatched,
  handleTransferReply,
} from '../src/distributed/services/saga.service';
import { SagaEvent } from '../src/distributed/infra/rabbitmq';

let failures = 0;

function check(condition: boolean, label: string, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${label}`, detail ?? '');
  }
}

async function testMasterData() {
  const north = await query('north', 'SELECT id, code FROM warehouses ORDER BY code');
  const south = await query('south', 'SELECT id, code FROM warehouses ORDER BY code');
  check(
    north.rows.some((r) => r.code === SHARDS.north.warehouseCode) &&
      south.rows.some((r) => r.code === SHARDS.south.warehouseCode),
    'Hai shard đều có master data WH-NORTH-01 và WH-SOUTH-01'
  );
}

/** Tạo SKU mới với đúng 10 tồn để phép thử không ảnh hưởng dữ liệu seed. */
async function createIsolatedStock(qty: number) {
  const shard = 'north';
  const warehouse = await query<{ id: string }>(
    shard,
    'SELECT id FROM warehouses WHERE code = $1',
    [SHARDS.north.warehouseCode]
  );
  const warehouseId = warehouse.rows[0].id;
  const location = await query<{ id: string }>(
    shard,
    `SELECT id FROM locations
      WHERE warehouse_id = $1 AND location_type = 'PICKING'`,
    [warehouseId]
  );
  const locationId = location.rows[0].id;

  const productId = newId();
  const batchId = newId();
  const balanceId = newId();
  const suffix = Date.now().toString(36).toUpperCase();

  await withTransaction(shard, async (client) => {
    await client.query(
      `INSERT INTO products (id, sku, name, uom, tracking_type)
       VALUES ($1,$2,$3,'CÁI','BATCH')`,
      [productId, `SP-TEST-${suffix}`, `Hàng kiểm thử ${suffix}`]
    );
    await client.query(
      `INSERT INTO batches (id, product_id, batch_number, expiry_date, status)
       VALUES ($1,$2,$3,$4,'AVAILABLE')`,
      [batchId, productId, `LOT-TEST-${suffix}`, '2030-12-31']
    );
    await client.query(
      `INSERT INTO inventory_balances
         (id, warehouse_id, location_id, product_id, batch_id, physical_qty)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [balanceId, warehouseId, locationId, productId, batchId, qty]
    );
    await client.query(
      `INSERT INTO stock_ledger
         (id, warehouse_id, location_id, product_id, batch_id, movement_type,
          qty_delta, balance_after, reference_type, reference_id, created_by)
       VALUES ($1,$2,$3,$4,$5,'INBOUND',$6,$6,'SEED',$7,$8)`,
      [
        newId(),
        warehouseId,
        locationId,
        productId,
        batchId,
        qty,
        balanceId,
        SYSTEM_ACTOR_ID,
      ]
    );
  });

  return {
    warehouseId,
    locationId,
    productId,
    batchId,
    balanceId,
    sku: `SP-TEST-${suffix}`,
    batchNumber: `LOT-TEST-${suffix}`,
  };
}

async function testConcurrentOutbound() {
  console.log('\n[1] 50 yêu cầu xuất kho đồng thời cho 10 đơn vị tồn');
  const stock = await createIsolatedStock(10);

  const results = await Promise.allSettled(
    Array.from({ length: 50 }, () =>
      quickOutbound({
        shard: 'north',
        warehouseId: stock.warehouseId,
        productId: stock.productId,
        qty: 1,
      })
    )
  );
  const success = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  const finalQty = await query<{ physical_qty: string; reserved_qty: string }>(
    'north',
    'SELECT physical_qty, reserved_qty FROM inventory_balances WHERE id = $1',
    [stock.balanceId]
  );
  const ledger = await query<{ total: string }>(
    'north',
    `SELECT COALESCE(SUM(qty_delta), 0) AS total
       FROM stock_ledger WHERE product_id = $1`,
    [stock.productId]
  );

  check(success === 10, 'Đúng 10 yêu cầu thành công', { success });
  check(failed === 40, 'Đúng 40 yêu cầu bị từ chối', { failed });
  check(
    Number(finalQty.rows[0].physical_qty) === 0,
    'physical_qty = 0 (không âm, không vượt tồn)',
    finalQty.rows
  );
  check(
    Number(finalQty.rows[0].reserved_qty) === 0,
    'reserved_qty = 0 sau khi tiêu thụ hết reservation',
    finalQty.rows
  );
  check(
    Number(ledger.rows[0].total) === Number(finalQty.rows[0].physical_qty),
    'SUM(qty_delta) = physical_qty',
    { sum: ledger.rows[0].total, physical: finalQty.rows[0].physical_qty }
  );

  const staleOrders = await query(
    'north',
    `SELECT COUNT(*)::int AS count FROM stock_orders
      WHERE warehouse_id = $1 AND status = 'PICKING'
        AND id IN (SELECT order_id FROM stock_order_items WHERE product_id = $2)`,
    [stock.warehouseId, stock.productId]
  );
  check(staleOrders.rows[0].count === 0, 'Không có phiếu PICKING sót lại sau rollback');
}

async function testTransferCompensation() {
  console.log('\n[2] Điều chuyển bị kho đích từ chối -> hoàn tồn kho nguồn');
  const stock = await createIsolatedStock(5);
  const southWarehouse = await query<{ id: string }>(
    'north',
    'SELECT id FROM warehouses WHERE code = $1',
    [SHARDS.south.warehouseCode]
  );
  const southId = southWarehouse.rows[0].id;

  const created = await createTransfer({
    shard: 'north',
    warehouseId: stock.warehouseId,
    fromWarehouseId: stock.warehouseId,
    toWarehouseId: southId,
    items: [{ productId: stock.productId, qty: 5 }],
  });

  const dispatched = await dispatchTransfer({
    shard: 'north',
    warehouseId: stock.warehouseId,
    transferId: created.transferId,
  });
  const inTransit = await getTransfer('north', stock.warehouseId, created.transferId);
  check(inTransit.status === 'IN_TRANSIT', 'Trạng thái IN_TRANSIT tồn tại sau dispatch', inTransit.status);

  const afterDispatch = await query<{ physical_qty: string }>(
    'north',
    'SELECT physical_qty FROM inventory_balances WHERE id = $1',
    [stock.balanceId]
  );
  check(
    Number(afterDispatch.rows[0].physical_qty) === 0,
    'Kho A đã trừ 5 đơn vị trước khi có xác nhận từ kho B'
  );

  // Mô phỏng kho B từ chối: SKU không tồn tại trong master data của kho đích.
  const rejectedPayload = {
    ...dispatched.payload,
    items: [
      {
        ...(dispatched.payload.items as Array<Record<string, unknown>>)[0],
        productId: newId(), // SKU lạ -> BusinessRejectError ở consumer
      },
    ],
  };
  await handleTransferDispatched(
    { ...dispatched, payload: rejectedPayload },
    'south'
  );

  const rejectedRows = await query<{ payload: SagaEvent }>(
    'south',
    `SELECT payload FROM outbox_events
      WHERE event_type = 'TransferRejected' AND aggregate_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [created.transferId]
  );
  check(rejectedRows.rowCount === 1, 'Kho B phát sự kiện TransferRejected', rejectedRows.rowCount);

  const southBalance = await query(
    'south',
    `SELECT COUNT(*)::int AS count FROM inventory_balances
      WHERE product_id = $1`,
    [(rejectedPayload.items as Array<{ productId: string }>)[0].productId]
  );
  check(southBalance.rows[0].count === 0, 'Kho B không cộng tồn hàng bị từ chối');

  await handleTransferReply(
    rejectedRows.rows[0].payload,
    'north',
    stock.warehouseId
  );

  const afterCompensation = await query<{ physical_qty: string; reserved_qty: string }>(
    'north',
    'SELECT physical_qty, reserved_qty FROM inventory_balances WHERE id = $1',
    [stock.balanceId]
  );
  check(
    Number(afterCompensation.rows[0].physical_qty) === 5,
    'Kho A được hoàn lại đúng 5 đơn vị',
    afterCompensation.rows
  );
  check(
    Number(afterCompensation.rows[0].reserved_qty) === 0,
    'Reservation tại kho A đã được tiêu thụ, không giữ chỗ oan',
    afterCompensation.rows
  );

  const cancelled = await getTransfer('north', stock.warehouseId, created.transferId);
  check(cancelled.status === 'CANCELLED', 'Phiếu điều chuyển chuyển sang CANCELLED', cancelled.status);

  const ledger = await query<{ total: string }>(
    'north',
    `SELECT COALESCE(SUM(qty_delta), 0) AS total
       FROM stock_ledger WHERE product_id = $1`,
    [stock.productId]
  );
  check(
    Number(ledger.rows[0].total) === Number(afterCompensation.rows[0].physical_qty),
    'SUM(qty_delta) = physical_qty sau compensation (ADJUSTMENT dương)',
    { sum: ledger.rows[0].total, physical: afterCompensation.rows[0].physical_qty }
  );

  // Duplicate event phải bị Inbox chặn (processed_events).
  await handleTransferReply(
    rejectedRows.rows[0].payload,
    'north',
    stock.warehouseId
  );
  const afterDuplicate = await query<{ physical_qty: string }>(
    'north',
    'SELECT physical_qty FROM inventory_balances WHERE id = $1',
    [stock.balanceId]
  );
  check(
    Number(afterDuplicate.rows[0].physical_qty) === 5,
    'Inbox chặn event trùng: không hoàn tồn lần 2',
    afterDuplicate.rows
  );
}

async function testInboxDedupOnDestination() {
  console.log('\n[3] Inbox tại kho đích chặn duplicated TransferDispatched');
  const stock = await createIsolatedStock(3);
  // Master data được replicate: SKU kiểm thử cũng phải có ở kho đích.
  await withTransaction('south', async (client) => {
    await client.query(
      `INSERT INTO products (id, sku, name, uom, tracking_type)
       VALUES ($1,$2,$3,'CÁI','BATCH')
       ON CONFLICT (sku) DO NOTHING`,
      [stock.productId, stock.sku, 'Hàng kiểm thử']
    );
    await client.query(
      `INSERT INTO batches (id, product_id, batch_number, expiry_date, status)
       VALUES ($1,$2,$3,'2030-12-31','AVAILABLE')
       ON CONFLICT (product_id, batch_number) DO NOTHING`,
      [stock.batchId, stock.productId, stock.batchNumber]
    );
  });
  const southWarehouse = await query<{ id: string }>(
    'north',
    'SELECT id FROM warehouses WHERE code = $1',
    [SHARDS.south.warehouseCode]
  );
  const created = await createTransfer({
    shard: 'north',
    warehouseId: stock.warehouseId,
    fromWarehouseId: stock.warehouseId,
    toWarehouseId: southWarehouse.rows[0].id,
    items: [{ productId: stock.productId, qty: 3 }],
  });
  const dispatched = await dispatchTransfer({
    shard: 'north',
    warehouseId: stock.warehouseId,
    transferId: created.transferId,
  });

  await handleTransferDispatched(dispatched, 'south');
  await handleTransferDispatched(dispatched, 'south'); // duplicate

  const count = await query<{ count: string }>(
    'south',
    `SELECT COUNT(*) AS count FROM stock_ledger
      WHERE product_id = $1 AND movement_type = 'TRANSFER_IN'`,
    [stock.productId]
  );
  check(Number(count.rows[0].count) === 1, 'Chỉ ghi nhận 1 lần TRANSFER_IN', count.rows);
}

async function main(): Promise<void> {
  console.log('=== KIỂM THỬ KIẾN TRÚC KHO PHÂN TÁN HTTT_N8 ===');
  await testMasterData();
  await testConcurrentOutbound();
  await testTransferCompensation();
  await testInboxDedupOnDestination();
  await closeAllPools();

  if (failures > 0) {
    console.error(`\n❌ ${failures} kiểm tra thất bại`);
    process.exit(1);
  }
  console.log('\n✅ Tất cả kiểm tra đã vượt qua');
}

main().catch(async (error) => {
  console.error('[Test] ❌ Lỗi không mong đợi:', error);
  await closeAllPools();
  process.exit(1);
});
