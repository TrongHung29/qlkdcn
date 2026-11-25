import { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { ShardName, shardForWarehouseCode, SYSTEM_ACTOR_ID } from '../config';
import { DistributedError } from '../errors';
import { getCorrelationId } from '../../utils/correlation';
import { insertOutboxEvent, SagaEvent } from '../events';
import {
  findWarehouseByCode,
  inboundStock,
} from './inventory.service';
import {
  compensateTransferTx,
  completeTransferTx,
  TransferEventItem,
} from './transfer.service';

class BusinessRejectError extends DistributedError {
  constructor(message: string) {
    super(message, 'BUSINESS_REJECT', 422);
  }
}

interface DispatchedPayload {
  transferId: string;
  transferCode: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  toWarehouseCode: string;
  items: TransferEventItem[];
}

async function markProcessed(
  client: PoolClient,
  warehouseId: string,
  event: SagaEvent,
  consumerName: string
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO processed_events (event_id, warehouse_id, consumer_name)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [event.eventId, warehouseId, consumerName]
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Phase 3 - Warehouse B inbound consumer.
 * Inbox dedup nằm TRONG cùng transaction với cộng tồn + ledger + outbox.
 */
export async function handleTransferDispatched(
  event: SagaEvent,
  localShard: ShardName
): Promise<void> {
  const payload = event.payload as unknown as DispatchedPayload;
  const destinationShard: ShardName = shardForWarehouseCode(payload.toWarehouseCode);
  // Mỗi node chỉ xử lý sự kiện nếu mình là kho đích (master data được replicate
  // ở cả 2 shard nên không được phép chỉ dựa vào warehouseId).
  if (destinationShard !== localShard) return;
  const warehouse = await findWarehouseByCode(destinationShard, payload.toWarehouseCode);

  try {
    await withTransaction(destinationShard, async (client) => {
      if (!(await markProcessed(client, warehouse.id, event, 'WarehouseB_Inbound'))) {
        return; // duplicate event -> ACK ngay, không làm gì thêm
      }
      if (payload.toWarehouseId !== warehouse.id) {
        throw new BusinessRejectError('Mã kho đích trong sự kiện không khớp shard hiện tại');
      }

      const receiving = await client.query<{ id: string }>(
        `SELECT id FROM locations
          WHERE warehouse_id = $1 AND location_type = 'RECEIVING'
          LIMIT 1`,
        [warehouse.id]
      );
      if (!receiving.rowCount) {
        throw new BusinessRejectError('Kho đích chưa cấu hình vị trí RECEIVING');
      }

      for (const item of payload.items) {
        const product = await client.query('SELECT 1 FROM products WHERE id = $1', [
          item.productId,
        ]);
        if (!product.rowCount) {
          throw new BusinessRejectError(
            `SKU không hợp lệ tại kho đích (${item.productId})`
          );
        }
        await inboundStock({
          shard: destinationShard,
          warehouseId: warehouse.id,
          locationId: receiving.rows[0].id,
          productId: item.productId,
          batchId: item.batchId,
          qty: item.qty,
          referenceType: 'TRANSFER_DISPATCH',
          referenceId: payload.transferId,
          movementType: 'TRANSFER_IN',
          createdBy: SYSTEM_ACTOR_ID,
          client,
        });
      }

      await insertOutboxEvent(client, {
        warehouseId: warehouse.id,
        aggregateType: 'STOCK_TRANSFER',
        aggregateId: payload.transferId,
        eventType: 'TransferCompleted',
        payload: {
          transferId: payload.transferId,
          fromWarehouseId: payload.fromWarehouseId,
          toWarehouseId: payload.toWarehouseId,
          items: payload.items,
        },
      });
    });
  } catch (error) {
    if (!(error instanceof BusinessRejectError)) throw error;

    // Rollback đã xảy ra (kể cả processed_events). Ghi rejection ở transaction mới,
    // đánh dấu event đã xử lý để không rơi vào loop redelivery.
    await withTransaction(destinationShard, async (client) => {
      await markProcessed(client, warehouse.id, event, 'WarehouseB_Inbound');
      await insertOutboxEvent(client, {
        warehouseId: warehouse.id,
        aggregateType: 'STOCK_TRANSFER',
        aggregateId: payload.transferId,
        eventType: 'TransferRejected',
        payload: {
          transferId: payload.transferId,
          fromWarehouseId: payload.fromWarehouseId,
          toWarehouseId: payload.toWarehouseId,
          reason: error.message,
          items: payload.items,
        },
      });
    });
    console.warn(
      `[Saga][${getCorrelationId() || event.eventId}] Từ chối hàng tại ${warehouse.code}: ${error.message}`
    );
  }
}

/**
 * Phase 4 - Warehouse A reply consumer (COMPLETED hoặc REJECTED).
 */
export async function handleTransferReply(
  event: SagaEvent,
  shard: ShardName,
  warehouseId: string
): Promise<void> {
  const payload = event.payload as unknown as {
    transferId: string;
    fromWarehouseId: string;
    items: TransferEventItem[];
    reason?: string;
  };

  // Reply events được publish tới topic chung -> CẢ 2 reply queue đều nhận bản copy.
  // Chỉ shard NGUỒN (nơi phiếu điều chuyển được tạo) mới được complete/compensate;
  // shard đích phải ACK bỏ qua, nếu không sẽ nack vào DLQ dù saga đã hoàn tất.
  if (payload.fromWarehouseId) {
    const source = await query<{ code: string }>(
      shard,
      'SELECT code FROM warehouses WHERE id = $1',
      [payload.fromWarehouseId]
    );
    if (
      source.rowCount &&
      shardForWarehouseCode(source.rows[0].code) !== shard
    ) {
      return;
    }
  }

  await withTransaction(shard, async (client) => {
    if (!(await markProcessed(client, warehouseId, event, 'WarehouseA_Reply'))) {
      return;
    }
    if (event.eventType === 'TransferCompleted') {
      await completeTransferTx(
        client,
        warehouseId,
        payload.transferId,
        event.occurredAt
      );
      return;
    }
    if (event.eventType === 'TransferRejected') {
      await compensateTransferTx(
        client,
        warehouseId,
        payload.transferId,
        payload.items,
        payload.reason || 'Kho đích từ chối nhận hàng'
      );
      return;
    }
    throw new DistributedError(
      `Loại sự kiện ${event.eventType} không được hỗ trợ`,
      'UNSUPPORTED_EVENT'
    );
  });
}
