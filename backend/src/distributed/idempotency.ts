import { PoolClient } from 'pg';
import { ValidationError } from './errors';

export interface IdempotentResponse<T = unknown> {
  statusCode: number;
  body: T;
}

export interface IdempotentExecution<T> {
  value: T;
  replayed: boolean;
  statusCode: number;
}

/**
 * Thực thi handler trong CHÍNH transaction đang mở và lưu response vào
 * idempotency_keys cùng transaction đó (outbox/business/idempotency atomic).
 */
export async function runIdempotent<T>(
  client: PoolClient,
  warehouseId: string,
  idempotencyKey: string,
  handler: () => Promise<IdempotentResponse<T>>
): Promise<IdempotentExecution<T>> {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new ValidationError('Idempotency-Key không hợp lệ (tối đa 128 ký tự)');
  }

  // Khóa theo (warehouse, key): cùng key ở 2 kho là 2 nghiệp vụ độc lập,
  // nhưng cùng key trong 1 kho không được chạy business logic 2 lần.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1 || $2))', [
    warehouseId,
    idempotencyKey,
  ]);

  const existing = await client.query<{
    response_code: number;
    response_body: T;
  }>(
    `SELECT response_code, response_body
       FROM idempotency_keys
      WHERE warehouse_id = $1 AND idempotency_key = $2`,
    [warehouseId, idempotencyKey]
  );

  if (existing.rowCount) {
    return {
      value: existing.rows[0].response_body,
      statusCode: existing.rows[0].response_code,
      replayed: true,
    };
  }

  const result = await handler();

  await client.query(
    `INSERT INTO idempotency_keys
        (idempotency_key, warehouse_id, response_code, response_body)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [idempotencyKey, warehouseId, result.statusCode, JSON.stringify(result.body)]
  );

  return { value: result.body, statusCode: result.statusCode, replayed: false };
}
