import { Pool } from 'pg';
import { getPool } from '../db';
import { ShardName } from '../config';

let replicaPool: Pool | null = null;

/**
 * CQRS read side: ưu tiên Hot Standby (5434) cho các truy vấn báo cáo.
 * Shard South chưa có replica riêng -> vẫn đọc từ primary của shard đó.
 * Fallback tự động khi replica chưa khởi động (môi trường local).
 */
export function getReadPool(shard: ShardName): Pool {
  const replicaUrl = process.env.DB_REPLICA_URL;
  if (
    shard === 'north' &&
    replicaUrl &&
    process.env.REPLICA_READS_ENABLED !== 'false'
  ) {
    if (!replicaPool) {
      replicaPool = new Pool({
        connectionString: replicaUrl,
        max: Number(process.env.PG_READ_POOL_MAX || 10),
        connectionTimeoutMillis: 1500,
        idleTimeoutMillis: 30_000,
      });
    }
    return replicaPool;
  }
  return getPool(shard);
}

export async function queryRead<T extends import('pg').QueryResultRow = any>(
  shard: ShardName,
  text: string,
  params: unknown[] = []
) {
  return getReadPool(shard).query<T>(text, params);
}

export async function closeReadPool(): Promise<void> {
  if (replicaPool) {
    await replicaPool.end();
    replicaPool = null;
  }
}
