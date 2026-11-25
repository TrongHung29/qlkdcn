import { startOutboxRelay } from './outbox-relay';
import { startReservationExpiryCleaner } from './reservation-expiry';
import { startSagaConsumers } from './saga-consumers';
import { closeAllPools, query } from '../db';
import { SHARD_NAMES } from '../config';
import { reconcileInventory } from '../services/inventory.service';
import { closeReadPool } from '../infra/read-db';
import { closeRedlock } from '../infra/redlock';

const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 300_000);

async function reconcileAllShards(): Promise<void> {
  for (const shard of SHARD_NAMES) {
    try {
      const warehouses = await query<{ id: string }>(shard, 'SELECT id FROM warehouses');
      for (const warehouse of warehouses.rows) {
        const report = await reconcileInventory(shard, warehouse.id);
        if (report.mismatchCount > 0) {
          console.warn(
            `[Reconciliation] ${shard}/${warehouse.id}: ${report.mismatchCount} dòng lệch sổ`,
            report.mismatches.slice(0, 5)
          );
        }
      }
    } catch (error) {
      console.error(`[Reconciliation] lỗi shard ${shard}:`, error);
    }
  }
}

export async function startAllWorkers(): Promise<() => Promise<void>> {
  const stopRelay = startOutboxRelay();
  const stopCleaner = startReservationExpiryCleaner();
  const stopConsumers = await startSagaConsumers();

  void reconcileAllShards();
  const reconcileTimer = setInterval(() => void reconcileAllShards(), RECONCILE_INTERVAL_MS);

  console.log('[Workers] Outbox relay + Reservation cleaner + Saga consumers + Reconciliation đã sẵn sàng');

  return async () => {
    clearInterval(reconcileTimer);
    stopRelay();
    stopCleaner();
    await stopConsumers();
    await closeRedlock();
    await closeReadPool();
    await closeAllPools();
  };
}

if (require.main === module) {
  let stop: (() => Promise<void>) | undefined;

  const shutdown = async (signal: string) => {
    console.log(`[Workers] Nhận ${signal}, đang đóng worker gracefully...`);
    if (stop) await stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  startAllWorkers()
    .then((fn) => {
      stop = fn;
    })
    .catch((error) => {
      console.error('[Workers] Khởi động thất bại:', error);
      process.exit(1);
    });
}
