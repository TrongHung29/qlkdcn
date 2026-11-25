export class DistributedError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'DistributedError';
  }
}

export class NotFoundError extends DistributedError {
  constructor(message: string, details?: unknown) {
    super(message, 'NOT_FOUND', 404, details);
  }
}

export class ConflictError extends DistributedError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFLICT', 409, details);
  }
}

export class ValidationError extends DistributedError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class ForbiddenError extends DistributedError {
  constructor(message = 'Bạn không có quyền thao tác trên kho này') {
    super(message, 'FORBIDDEN', 403);
  }
}

/** Bị ném khi UPDATE optimistic locking không khớp version hoặc hết hàng. */
export class StockConflictError extends DistributedError {
  constructor(message = 'Tồn kho đã thay đổi, vui lòng thử lại', details?: unknown) {
    super(message, 'STALE_VERSION', 409, details);
  }
}

export class IdempotencyReplayError extends DistributedError {
  constructor(
    public readonly responseCode: number,
    public readonly responseBody: unknown
  ) {
    super('Yêu cầu đã được xử lý trước đó (idempotent replay)', 'IDEMPOTENT_REPLAY');
  }
}

export function toHttpError(error: unknown): {
  statusCode: number;
  message: string;
  code: string;
  details?: unknown;
} {
  if (error instanceof DistributedError) {
    return {
      statusCode: error.statusCode,
      message: error.message,
      code: error.code,
      details: error.details,
    };
  }
  return {
    statusCode: 500,
    message: error instanceof Error ? error.message : 'Lỗi máy chủ nội bộ',
    code: 'INTERNAL_ERROR',
  };
}
