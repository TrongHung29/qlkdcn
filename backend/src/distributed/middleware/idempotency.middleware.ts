import { NextFunction, Request, Response } from 'express';
import { IDEMPOTENCY_HEADER } from '../config';
import { sendError } from '../../utils/response.util';

declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
    }
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Mọi endpoint mutate của /api/v2 bắt buộc phải có Idempotency-Key. */
export function requireIdempotencyKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!MUTATING_METHODS.has(req.method)) {
    return next();
  }

  const key = req.header(IDEMPOTENCY_HEADER)?.trim();
  if (!key) {
    return sendError(
      res,
      'Thiếu header Idempotency-Key cho yêu cầu thay đổi dữ liệu',
      400
    );
  }
  if (key.length > 128) {
    return sendError(res, 'Idempotency-Key không được vượt quá 128 ký tự', 400);
  }

  req.idempotencyKey = key;
  return next();
}
