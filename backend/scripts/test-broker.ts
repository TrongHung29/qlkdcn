/**
 * Kiểm thử end-to-end qua RabbitMQ thật (khác với test-distributed gọi handler trực tiếp).
 * Yêu cầu: PostgreSQL 5432/5433 + RabbitMQ 5672 đã chạy, migration/seed xong.
 * Chạy: npm run test:broker
 */
import { closeAllPools, query, withTransaction } from '../src/distributed/db';
import { SHARDS, SYSTEM_ACTOR_ID } from '../src/distributed/config';
import { newId } from '../src/distributed/uuid';
import { createTransfer, dispatchTransfer, getTransfer } from '../src/distributed/services/transfer.service';
import { relayOutboxOnce } from '../src/distributed/workers/outbox-relay';
import { startSagaConsumers } from '../src/distributed/workers/saga-consumers';
import { rabbitMQ } from '../src/distributed/infra/rabbitmq';

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  if (condition) console.log(`  ✅ ${label}`);
  else {
    failures += 1;
    console.error(`  ❌ ${label}`, detail ?? '');
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createIsolatedStock(qty: number) {
  const warehouse = await query<{ id: string }>(
    'north',
    'SELECT id FROM warehouses WHERE code = $1',
    [SHARDS.north.warehouseCode]
  );
  const location = await query<{ id: string }>(
    'north',
    `SELECT id FROM locations WHERE warehouse_id = $1 AND location_type = 'PICKING' LIMIT 1`,
    [warehouse.rows[0].id]
  );
  const productId = newId();
  const batchId = newId();
  const balanceId = newId();
  const suffix = Date.now().toString(36).toUpperCase();

  await withTransaction('north', async (client) => {
    await client.query(
      `INSERT INTO products (id, sku, name, uom, tracking_type)
       VALUES ($1,$2,$3,'CÁI','BATCH')`,
      [productId, `SP-BROKER-${suffix}`, `Hàng test broker ${suffix}`]
    );
    await client.query(
      `INSERT INTO batches (id, product_id, batch_number, expiry_date, status)
       VALUES ($1,$2,$3,'2030-12-31','AVAILABLE')`,
      [batchId, productId, `LOT-BROKER-${suffix}`]
    );
    await client.query(
      `INSERT INTO inventory_balances
         (id, warehouse_id, location_id, product_id, batch_id, physical_qty)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [balanceId, warehouse.rows[0].id, location.rows[0].id, productId, batchId, qty]
    );
    await client.query(
      `INSERT INTO stock_ledger
         (id, warehouse_id, location_id, product_id, batch_id, movement_type,
          qty_delta, balance_after, reference_type, reference_id, created_by)
       VALUES ($1,$2,$3,$4,$5,'INBOUND',$6,$6,'BROKER_TEST',$7,$8)`,
      [newId(), warehouse.rows[0].id, location.rows[0].id, productId, batchId, qty, balanceId, SYSTEM_ACTOR_ID]
    );
  });

  // Master data được replicate ở mọi shard.
  await withTransaction('south', async (client) => {
    await client.query(
      `INSERT INTO products (id, sku, name, uom, tracking_type)
       VALUES ($1,$2,$3,'CÁI','BATCH') ON CONFLICT (sku) DO NOTHING`,
      [productId, `SP-BROKER-${suffix}`, `Hàng test broker ${suffix}`]
    );
    await client.query(
      `INSERT INTO batches (id, product_id, batch_number, expiry_date, status)
       VALUES ($1,$2,$3,'2030-12-31','AVAILABLE') ON CONFLICT (product_id, batch_number) DO NOTHING`,
      [batchId, productId, `LOT-BROKER-${suffix}`]
    );
  });

  const southWarehouse = await query<{ id: string }>(
    'north',
    'SELECT id FROM warehouses WHERE code = $1',
    [SHARDS.south.warehouseCode]
  );
  return {
    northWarehouseId: warehouse.rows[0].id,
    southWarehouseId: southWarehouse.rows[0].id,
    productId,
  };
}

async function main(): Promise<void> {
  console.log('=== KIỂM THỬ SAGA QUA RABBITMQ THẬT ===');
  // DLQ có thể chứa message tồn từ các lần chạy trước -> so delta, không so tuyệt đối.
  const dlqBefore = await rabbitMQ.getDlqMessageCount();
  const stock = await createIsolatedStock(4);

  const created = await createTransfer({
    shard: 'north',
    warehouseId: stock.northWarehouseId,
    fromWarehouseId: stock.northWarehouseId,
    toWarehouseId: stock.southWarehouseId,
    items: [{ productId: stock.productId, qty: 4 }],
  });
  await dispatchTransfer({
    shard: 'north',
    warehouseId: stock.northWarehouseId,
    transferId: created.transferId,
  });

  let stopConsumers: (() => Promise<void>) | undefined;
  try {
    stopConsumers = await startSagaConsumers();

    const deadline = Date.now() + 20_000;
    let status = '';
    while (Date.now() < deadline) {
      await relayOutboxOnce('north');
      await relayOutboxOnce('south');
      const transfer = await getTransfer('north', stock.northWarehouseId, created.transferId);
      status = transfer.status;
      if (status === 'COMPLETED' || status === 'CANCELLED') break;
      await wait(250);
    }

    check(status === 'COMPLETED', 'Saga qua broker hoàn tất phiếu điều chuyển', status);

    const inbound = await query<{ count: string }>(
      'south',
      `SELECT COUNT(*)::text AS count FROM stock_ledger
        WHERE product_id = $1 AND movement_type = 'TRANSFER_IN'`,
      [stock.productId]
    );
    check(Number(inbound.rows[0].count) === 1, 'Kho đích ghi đúng 1 dòng TRANSFER_IN', inbound.rows);

    const dlqAfter = await rabbitMQ.getDlqMessageCount();
    check(
      dlqAfter === dlqBefore,
      'Không có sự kiện MỚI nào rơi vào DLQ',
      { before: dlqBefore, after: dlqAfter }
    );
  } finally {
    if (stopConsumers) await stopConsumers();
    else await rabbitMQ.close();
    await closeAllPools();
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} kiểm tra thất bại`);
    process.exit(1);
  }
  console.log('\n✅ Luồng Saga/Outbox/Inbox qua broker hoạt động end-to-end');
}

main().catch(async (error) => {
  console.error('[BrokerTest] ❌', error);
  await closeAllPools();
  process.exit(1);
});
