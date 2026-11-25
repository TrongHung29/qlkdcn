import { closeAllPools, query, withTransaction } from '../src/distributed/db';
import {
  SHARDS,
  SHARD_NAMES,
  ShardName,
  SYSTEM_ACTOR_ID,
} from '../src/distributed/config';
import { newId } from '../src/distributed/uuid';

const warehouseIds = { north: newId(), south: newId() };

const products = [
  { sku: 'SP-SS-S24', name: 'Điện thoại Samsung S24', uom: 'CÁI' },
  { sku: 'SP-SUN-NC18', name: 'Nồi cơm Sunhouse NC18', uom: 'CÁI' },
  { sku: 'SP-VNM-SUA1L', name: 'Sữa Vinamilk 1L', uom: 'HỘP' },
];

const batches = [
  {
    productSku: products[0].sku,
    batchNumber: 'LOT-SS-S24-A',
    expiryDate: '2026-12-31',
  },
  {
    productSku: products[0].sku,
    batchNumber: 'LOT-SS-S24-B',
    expiryDate: '2027-06-30',
  },
  {
    productSku: products[1].sku,
    batchNumber: 'LOT-SUN-NC18-A',
    expiryDate: '2028-01-31',
  },
];

const locationIds: Record<ShardName, Record<string, string>> = {
  north: {
    RECEIVING: newId(),
    PICKING: newId(),
    STORAGE: newId(),
    DAMAGED: newId(),
  },
  south: {
    RECEIVING: newId(),
    PICKING: newId(),
    STORAGE: newId(),
    DAMAGED: newId(),
  },
};

/** Master data được nhân bản ở cả 2 shard; upsert để script chạy lại được. */
async function seedMasterData(): Promise<void> {
  for (const shard of SHARD_NAMES) {
    await withTransaction(shard, async (client) => {
      for (const name of ['north', 'south'] as const) {
        const wh = SHARDS[name];
        await client.query(
          `INSERT INTO warehouses (id, code, name, shard_region, address, is_active)
           VALUES ($1,$2,$3,$4,$5,TRUE)
           ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
           RETURNING id`,
          [
            warehouseIds[name],
            wh.warehouseCode,
            wh.warehouseName,
            wh.region,
            `Trụ sở ${wh.warehouseName}`,
          ]
        );
      }

      const productIds = new Map<string, string>();
      for (const product of products) {
        const row = await client.query<{ id: string }>(
          `INSERT INTO products (id, sku, name, uom, tracking_type)
           VALUES ($1,$2,$3,$4,'BATCH')
           ON CONFLICT (sku) DO UPDATE SET sku = EXCLUDED.sku
           RETURNING id`,
          [newId(), product.sku, product.name, product.uom]
        );
        productIds.set(product.sku, row.rows[0].id);
      }

      for (const batch of batches) {
        await client.query(
          `INSERT INTO batches (id, product_id, batch_number, expiry_date, status)
           VALUES ($1,$2,$3,$4,'AVAILABLE')
           ON CONFLICT (product_id, batch_number)
           DO UPDATE SET batch_number = EXCLUDED.batch_number
           RETURNING id`,
          [
            newId(),
            productIds.get(batch.productSku)!,
            batch.batchNumber,
            batch.expiryDate,
          ]
        );
      }
    });
  }
}

async function seedLocations(
  shard: ShardName,
  warehouseId: string
): Promise<Record<string, string>> {
  return withTransaction(shard, async (client) => {
    const result: Record<string, string> = {};
    for (const [type, id] of Object.entries(locationIds[shard])) {
      const row = await client.query<{ id: string }>(
        `INSERT INTO locations
           (id, warehouse_id, code, location_type, max_capacity, is_pickable)
         VALUES ($1,$2,$3,$4,1000,$5)
         ON CONFLICT (warehouse_id, code) DO UPDATE SET code = EXCLUDED.code
         RETURNING id`,
        [
          id,
          warehouseId,
          `${SHARDS[shard].warehouseCode}-${type}`,
          type,
          type !== 'DAMAGED',
        ]
      );
      result[type] = row.rows[0].id;
    }
    return result;
  });
}

/** Lấy ID thật sau upsert để seed tồn kho không bị lệch giữa các lần chạy. */
async function canonicalIds(shard: ShardName) {
  const productRows = await query<{ id: string; sku: string }>(
    shard,
    `SELECT id, sku FROM products WHERE sku = ANY($1::varchar[])`,
    [products.map((p) => p.sku)]
  );
  const productBySku = new Map(productRows.rows.map((p) => [p.sku, p.id]));

  const batchRows = await query<{ id: string; sku: string; batch_number: string }>(
    shard,
    `SELECT b.id, p.sku, b.batch_number
       FROM batches b
       JOIN products p ON p.id = b.product_id
      WHERE p.sku = ANY($1::varchar[])`,
    [products.map((p) => p.sku)]
  );
  const batchKey = new Map(
    batchRows.rows.map((b) => [`${b.sku}:${b.batch_number}`, b.id])
  );
  return { productBySku, batchKey };
}

async function seedBalance(input: {
  shard: ShardName;
  warehouseId: string;
  locationId: string;
  productId: string;
  batchId: string;
  qty: number;
}): Promise<void> {
  await withTransaction(input.shard, async (client) => {
    const inserted = await client.query<{ id: string; physical_qty: string }>(
      `INSERT INTO inventory_balances
         (id, warehouse_id, location_id, product_id, batch_id, physical_qty)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ON CONSTRAINT uq_inventory_slot DO NOTHING
       RETURNING id, physical_qty`,
      [
        newId(),
        input.warehouseId,
        input.locationId,
        input.productId,
        input.batchId,
        input.qty,
      ]
    );
    if (!inserted.rowCount) return; // seed idempotent

    await client.query(
      `INSERT INTO stock_ledger
         (id, warehouse_id, location_id, product_id, batch_id, movement_type,
          qty_delta, balance_after, reference_type, reference_id, created_by)
       VALUES ($1,$2,$3,$4,$5,'INBOUND',$6,$6,'SEED',$7,$8)`,
      [
        newId(),
        input.warehouseId,
        input.locationId,
        input.productId,
        input.batchId,
        input.qty,
        inserted.rows[0].id,
        SYSTEM_ACTOR_ID,
      ]
    );
  });
}

async function main(): Promise<void> {
  await seedMasterData();

  const northWarehouse = await query<{ id: string }>(
    'north',
    'SELECT id FROM warehouses WHERE code = $1',
    [SHARDS.north.warehouseCode]
  );
  const southWarehouse = await query<{ id: string }>(
    'south',
    'SELECT id FROM warehouses WHERE code = $1',
    [SHARDS.south.warehouseCode]
  );
  const northId = northWarehouse.rows[0].id;
  const southId = southWarehouse.rows[0].id;

  const northLocations = await seedLocations('north', northId);
  const southLocations = await seedLocations('south', southId);
  const northIds = await canonicalIds('north');
  const southIds = await canonicalIds('south');

  const key = (productSku: string, batchNumber: string) =>
    `${productSku}:${batchNumber}`;

  await seedBalance({
    shard: 'north',
    warehouseId: northId,
    locationId: northLocations.PICKING,
    productId: northIds.productBySku.get(products[0].sku)!,
    batchId: northIds.batchKey.get(key(products[0].sku, batches[0].batchNumber))!,
    qty: 4, // lô hết hạn sớm hơn -> FEFO chọn trước
  });
  await seedBalance({
    shard: 'north',
    warehouseId: northId,
    locationId: northLocations.PICKING,
    productId: northIds.productBySku.get(products[0].sku)!,
    batchId: northIds.batchKey.get(key(products[0].sku, batches[1].batchNumber))!,
    qty: 6,
  });
  await seedBalance({
    shard: 'north',
    warehouseId: northId,
    locationId: northLocations.STORAGE,
    productId: northIds.productBySku.get(products[1].sku)!,
    batchId: northIds.batchKey.get(key(products[1].sku, batches[2].batchNumber))!,
    qty: 100,
  });
  await seedBalance({
    shard: 'south',
    warehouseId: southId,
    locationId: southLocations.PICKING,
    productId: southIds.productBySku.get(products[0].sku)!,
    batchId: southIds.batchKey.get(key(products[0].sku, batches[0].batchNumber))!,
    qty: 50,
  });

  const check = await query(
    'north',
    `SELECT p.sku, b.batch_number, ib.physical_qty, ib.reserved_qty
       FROM inventory_balances ib
       JOIN products p ON p.id = ib.product_id
       JOIN batches b ON b.id = ib.batch_id
      ORDER BY p.sku, b.expiry_date`
  );
  console.log('[Seed] ✅ Dữ liệu distributed đã sẵn sàng. Tồn kho NORTH:');
  console.table(check.rows);
  await closeAllPools();
}

main().catch(async (error) => {
  console.error('[Seed] ❌', error);
  await closeAllPools();
  process.exit(1);
});
