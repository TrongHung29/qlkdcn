import { PoolClient } from 'pg';
import { SagaEvent } from './infra/rabbitmq';
import { newId } from './uuid';
import { getCorrelationId } from '../utils/correlation';

export type { SagaEvent } from './infra/rabbitmq';

export type OutboxEventType =
  | 'TransferDispatched'
  | 'TransferCompleted'
  | 'TransferRejected';

/**
 * Ghi event vào outbox TRONG CÙNG transaction với thay đổi nghiệp vụ.
 * Không bao giờ được gọi sau COMMIT.
 */
export async function insertOutboxEvent(
  client: PoolClient,
  params: {
    warehouseId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: OutboxEventType;
    payload: Record<string, unknown>;
  }
): Promise<SagaEvent> {
  const eventId = newId();
  const event: SagaEvent = {
    eventId,
    eventType: params.eventType,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    warehouseId: params.warehouseId,
    payload: params.payload,
    occurredAt: new Date().toISOString(),
    correlationId: getCorrelationId() || undefined,
  };

  await client.query(
    `INSERT INTO outbox_events
       (id, warehouse_id, aggregate_type, aggregate_id, event_type, payload, status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PENDING')`,
    [
      eventId,
      params.warehouseId,
      params.aggregateType,
      params.aggregateId,
      params.eventType,
      JSON.stringify(event),
    ]
  );

  return event;
}
