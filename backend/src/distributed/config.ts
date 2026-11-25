import dotenv from 'dotenv';

dotenv.config();

export type ShardName = 'north' | 'south';

export interface ShardConfig {
  name: ShardName;
  warehouseCode: string;
  warehouseName: string;
  region: string;
  url: string;
}

const DEFAULT_URLS: Record<ShardName, string> = {
  north: 'postgresql://postgres:postgres@localhost:5432/wms_db?schema=public',
  south: 'postgresql://postgres:postgres@localhost:5433/wms_db?schema=public',
};

export const SHARDS: Record<ShardName, ShardConfig> = {
  north: {
    name: 'north',
    warehouseCode: process.env.WAREHOUSE_NORTH_CODE || 'WH-NORTH-01',
    warehouseName: process.env.WAREHOUSE_NORTH_NAME || 'Kho Miền Bắc (Hà Nội)',
    region: 'NORTH',
    url: process.env.DB_NORTH_URL || DEFAULT_URLS.north,
  },
  south: {
    name: 'south',
    warehouseCode: process.env.WAREHOUSE_SOUTH_CODE || 'WH-SOUTH-01',
    warehouseName: process.env.WAREHOUSE_SOUTH_NAME || 'Kho Miền Nam (TP. HCM)',
    region: 'SOUTH',
    url: process.env.DB_SOUTH_URL || DEFAULT_URLS.south,
  },
};

export const SHARD_NAMES: ShardName[] = ['north', 'south'];

export function shardForWarehouseCode(code: string): ShardName {
  const found = SHARD_NAMES.find((name) => SHARDS[name].warehouseCode === code);
  if (!found) {
    throw new Error(`Mã kho "${code}" không tồn tại trong cấu hình distributed shard`);
  }
  return found;
}

export const RABBITMQ_URL =
  process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

export const SAGA_EXCHANGE =
  process.env.SAGA_EXCHANGE || 'warehouse.saga.events';
export const SAGA_DLX_EXCHANGE =
  process.env.SAGA_DLX_EXCHANGE || 'warehouse.saga.dlx';
export const SAGA_INBOUND_QUEUE =
  process.env.SAGA_INBOUND_QUEUE || 'warehouse.saga.inbound';
export const SAGA_REPLY_QUEUE =
  process.env.SAGA_REPLY_QUEUE || 'warehouse.saga.reply';
export const SAGA_DLQ = process.env.SAGA_DLQ || 'warehouse.saga.dead-letter';

export const OUTBOX_BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE || 50);
export const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS || 1000);
export const RESERVATION_TTL_MINUTES = Number(
  process.env.RESERVATION_TTL_MINUTES || 30
);
export const RESERVATION_CLEANUP_MS = Number(
  process.env.RESERVATION_CLEANUP_MS || 60_000
);

export const SYSTEM_ACTOR_ID =
  process.env.SYSTEM_ACTOR_ID || '01900000-0000-7000-8000-000000000001';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
