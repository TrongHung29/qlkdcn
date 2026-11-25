import {
  SAGA_INBOUND_QUEUE,
  SAGA_REPLY_QUEUE,
  SHARDS,
  SHARD_NAMES,
  ShardName,
} from '../config';
import { rabbitMQ } from '../infra/rabbitmq';
import { findWarehouseByCode } from '../services/inventory.service';
import {
  handleTransferDispatched,
  handleTransferReply,
} from '../services/saga.service';

export async function startSagaConsumers(
  shards: ShardName[] = SHARD_NAMES
): Promise<() => Promise<void>> {
  for (const shard of shards) {
    const localWarehouse = await findWarehouseByCode(shard, SHARDS[shard].warehouseCode);

    await rabbitMQ.consume(
      `${SAGA_INBOUND_QUEUE}.${shard}`,
      (event) => handleTransferDispatched(event, shard),
      ['transfer.TransferDispatched']
    );

    await rabbitMQ.consume(
      `${SAGA_REPLY_QUEUE}.${shard}`,
      (event) => handleTransferReply(event, shard, localWarehouse.id),
      ['transfer.TransferCompleted', 'transfer.TransferRejected']
    );
  }

  return async () => {
    await rabbitMQ.close();
  };
}
