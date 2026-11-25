import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { SHARDS, ShardName } from './config';

const pools: Partial<Record<ShardName, Pool>> = {};

export function getPool(shard: ShardName): Pool {
  if (!pools[shard]) {
    pools[shard] = new Pool({
      connectionString: SHARDS[shard].url,
      max: Number(process.env.PG_POOL_MAX || 20),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pools[shard]!;
}

export type Queryable = Pick<Pool, 'query'> | PoolClient;

export async function query<T extends QueryResultRow = any>(
  shard: ShardName,
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return getPool(shard).query<T>(text, params);
}

/**
 * Mọi thao tác nghiệp vụ phải đi qua helper này: BEGIN -> fn -> COMMIT.
 * callback nhận PoolClient nên business state + outbox + idempotency luôn cùng 1 ACID tx.
 */
export async function withTransaction<T>(
  shard: ShardName,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool(shard).connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function pingShards(): Promise<Record<ShardName, boolean>> {
  const result = {} as Record<ShardName, boolean>;
  for (const shard of Object.keys(SHARDS) as ShardName[]) {
    try {
      await query(shard, 'SELECT 1');
      result[shard] = true;
    } catch {
      result[shard] = false;
    }
  }
  return result;
}

export async function closeAllPools(): Promise<void> {
  await Promise.all(
    Object.values(pools).map((pool) => (pool ? pool.end() : Promise.resolve()))
  );
}
