import { Request, Response, NextFunction } from 'express';
import {
  CORRELATION_HEADER,
  newCorrelationId,
  runWithCorrelationId,
} from '../utils/correlation';

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

/**
 * Gắn một correlation-id cho MỌI request. Nếu client gửi header thì giữ nguyên
 * để truy nguyên xuyên qua API -> outbox -> consumer -> reply.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header(CORRELATION_HEADER)?.trim();
  const id = incoming && incoming.length <= 128 ? incoming : newCorrelationId();

  req.correlationId = id;
  res.setHeader(CORRELATION_HEADER, id);
  return runWithCorrelationId(id, next);
}
