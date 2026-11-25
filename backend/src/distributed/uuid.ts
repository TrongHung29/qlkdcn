import { uuidv7 } from 'uuidv7';

/**
 * Mọi khóa chính trong kiến trúc phân tán đều là UUIDv7 do tầng ứng dụng sinh.
 * Không dùng SERIAL / IDENTITY / DB default để tránh collision giữa các shard.
 */
export function newId(): string {
  return uuidv7();
}

export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}
