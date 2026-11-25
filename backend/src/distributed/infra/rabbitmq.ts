import amqp, { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  RABBITMQ_URL,
  SAGA_DLQ,
  SAGA_DLX_EXCHANGE,
  SAGA_EXCHANGE,
} from '../config';
import { runWithCorrelationId } from '../../utils/correlation';

export interface SagaEvent {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  warehouseId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  /** Request gốc (X-Correlation-Id) để truy nguyên xuyên toàn bộ saga. */
  correlationId?: string;
}

type EventHandler = (event: SagaEvent) => Promise<void>;

/**
 * Connection manager dùng ConfirmChannel + topic exchange + DLX/DLQ.
 * At-least-once: duplicate event sẽ được Inbox (processed_events) chặn ở consumer.
 */
class RabbitMQManager {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;

  async connect(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    this.connection = await amqp.connect(RABBITMQ_URL);
    this.connection.on('error', (err: Error) => {
      console.error('[RabbitMQ] connection error:', err.message);
      this.channel = null;
      this.connection = null;
    });
    this.channel = await this.connection.createConfirmChannel();
    await this.assertTopology(this.channel);
    return this.channel;
  }

  private async assertTopology(channel: ConfirmChannel): Promise<void> {
    await channel.assertExchange(SAGA_EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(SAGA_DLX_EXCHANGE, 'topic', { durable: true });
    await channel.assertQueue(SAGA_DLQ, { durable: true });
    await channel.bindQueue(SAGA_DLQ, SAGA_DLX_EXCHANGE, '#');
  }

  async declareConsumerQueue(
    queueName: string,
    routingKeys: string[]
  ): Promise<void> {
    const channel = await this.connect();
    await channel.assertQueue(queueName, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': SAGA_DLX_EXCHANGE,
        'x-dead-letter-routing-key': 'failed',
      },
    });
    for (const key of routingKeys) {
      await channel.bindQueue(queueName, SAGA_EXCHANGE, key);
    }
  }

  async publish(routingKey: string, event: SagaEvent): Promise<void> {
    const channel = await this.connect();
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        SAGA_EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          contentType: 'application/json',
          messageId: event.eventId,
          timestamp: Date.parse(event.occurredAt),
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
    // Chỉ đánh dấu PUBLISHED sau khi broker xác nhận (publisher confirm).
    await channel.waitForConfirms();
  }

  async consume(
    queueName: string,
    handler: EventHandler,
    routingKeys: string[]
  ): Promise<void> {
    await this.declareConsumerQueue(queueName, routingKeys);
    const channel = await this.connect();
    await channel.consume(queueName, async (msg: ConsumeMessage | null) => {
      if (!msg) return;
      let event: SagaEvent;
      try {
        event = JSON.parse(msg.content.toString('utf8')) as SagaEvent;
      } catch (error) {
        console.error(`[RabbitMQ] consumer ${queueName} parse lỗi:`, error);
        channel.nack(msg, false, false);
        return;
      }

      // Dùng correlation-id của request gốc cho mọi log/service trong handler.
      await runWithCorrelationId(event.correlationId || event.eventId, async () => {
        try {
          await handler(event);
          channel.ack(msg);
        } catch (error) {
          // Lỗi hạ tầng/parse: đẩy vào DLQ để không block queue.
          console.error(
            `[RabbitMQ][${event.correlationId || event.eventId}] consumer ${queueName} lỗi:`,
            error
          );
          channel.nack(msg, false, false);
        }
      });
    });
  }

  async getDlqMessageCount(): Promise<number> {
    const channel = await this.connect();
    const info = await channel.checkQueue(SAGA_DLQ);
    return info.messageCount;
  }

  /**
   * Phát lại thư từ DLQ về exchange chính, dùng routing key gốc (x-death)
   * hoặc suy từ eventType. Chỉ ack sau khi broker confirm.
   */
  async redriveFromDlq(
    limit = 50
  ): Promise<{ redriven: number; failed: number; remaining: number }> {
    const channel = await this.connect();
    let redriven = 0;
    let failed = 0;

    for (let index = 0; index < limit; index += 1) {
      const msg = await channel.get(SAGA_DLQ);
      if (!msg) break;
      try {
        const event = JSON.parse(msg.content.toString('utf8')) as SagaEvent;
        const headers = msg.properties.headers as
          | Record<string, unknown>
          | undefined;
        const deaths = headers?.['x-death'] as
          | Array<{ 'routing-keys'?: string[] }>
          | undefined;
        const routingKey = deaths?.[0]?.['routing-keys']?.[0] ||
          `transfer.${event.eventType}`;
        await this.publish(routingKey, event);
        channel.ack(msg);
        redriven += 1;
      } catch (error) {
        console.error('[RabbitMQ] redrive DLQ thất bại:', error);
        channel.nack(msg, false, false);
        failed += 1;
        break;
      }
    }

    return {
      redriven,
      failed,
      remaining: await this.getDlqMessageCount(),
    };
  }

  async close(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
    this.channel = null;
    this.connection = null;
  }
}

export const rabbitMQ = new RabbitMQManager();
