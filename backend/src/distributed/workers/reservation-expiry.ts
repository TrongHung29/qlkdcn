import { RESERVATION_CLEANUP_MS, ShardName, SHARD_NAMES } from '../config';
import { releaseExpiredReservations } from '../services/inventory.service';

export function startReservationExpiryCleaner(
  shards: ShardName[] = SHARD_NAMES
): () => void {
  const run = async (shard: ShardName) => {
    try {
      const released = await releaseExpiredReservations(shard);
      if (released > 0) {
        console.log(`[ReservationCleaner] ${shard}: giải phóng ${released} reservation hết hạn`);
      }
    } catch (error) {
      console.error(`[ReservationCleaner] lỗi shard ${shard}:`, error);
    }
  };

  const timers = shards.map((shard) => {
    void run(shard); // chạy ngay khi start
    return setInterval(() => void run(shard), RESERVATION_CLEANUP_MS);
  });
  return () => timers.forEach(clearInterval);
}
