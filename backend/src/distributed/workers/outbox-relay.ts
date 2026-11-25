import { PoolClient } from 'pg';
import { withTransaction } from '../db';
import { OUTBOX_BATCH_SIZE, ShardName, SHARD_NAMES } from '../config';
import { rabbitMQ, SagaEvent } from '../infra/rabbitmq';

async function relayOutboxOnceTx(
  client: PoolClient,
  shard: ShardName
): Promise<{ published: number; failed: number }> {
  const pending = await client.query<{ id: string; payload: SagaEvent; event_type: string }>(
    `SELECT id, payload, event_type
       FROM outbox_events
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [OUTBOX_BATCH_SIZE]
  );

  let published = 0;
  let failed = 0;
  for (const row of pending.rows) {
    try {
      await rabbitMQ.publish(`transfer.${row.event_type}`, row.payload);
      await client.query(
        `UPDATE outbox_events SET status = 'PUBLISHED' WHERE id = $1`,
        [row.id]
      );
      published += 1;
    } catch (error) {
      console.error(`[OutboxRelay] ${shard} không publish được ${row.id}:`, error);
      await client.query(
        `UPDATE outbox_events SET status = 'FAILED' WHERE id = $1`,
        [row.id]
      );
      failed += 1;
    }
  }
  return { published, failed };
}

/** Chạy một lượt relay. Có thể truyền client để nhúng vào transaction hiện tại. */
export async function relayOutboxOnce(
  shard: ShardName,
  client?: PoolClient
): Promise<{ published: number; failed: number }> {
  if (client) return relayOutboxOnceTx(client, shard);
  return withTransaction(shard, (txClient) => relayOutboxOnceTx(txClient, shard));
}

export function startOutboxRelay(shards: ShardName[] = SHARD_NAMES): () => void {
  const timers = shards.map((shard) =>
    setInterval(async () => {
      try {
        await relayOutboxOnce(shard);
      } catch (error) {
        console.error(`[OutboxRelay] lỗi shard ${shard}:`, error);
      }
    }, Number(process.env.OUTBOX_POLL_MS || 1000))
  );
  return () => timers.forEach(clearInterval);
}
