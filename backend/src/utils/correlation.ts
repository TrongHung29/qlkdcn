import { AsyncLocalStorage } from 'async_hooks';
import { uuidv7 } from 'uuidv7';

export const CORRELATION_HEADER = 'x-correlation-id';

const storage = new AsyncLocalStorage<string>();

/** Chạy một đoạn code với correlation-id hiện tại (dùng ở consumer RabbitMQ). */
export function runWithCorrelationId<T>(id: string, fn: () => T): T {
  return storage.run(id || uuidv7(), fn);
}

/** Lấy correlation-id của luồng hiện tại; trả về undefined nếu không có. */
export function getCorrelationId(): string | undefined {
  return storage.getStore();
}

/** Sinh id mới cho request không gửi header (vẫn là UUIDv7). */
export function newCorrelationId(): string {
  return uuidv7();
}
