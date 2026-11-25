import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { sendError } from '../utils/response.util';

export interface AuthenticatedUser {
  id: string;
  maNV: string;
  username: string;
  hoTen: string;
  role: Role;
  /** Kho (bảng `kho` v1) mà người dùng được phép thao tác. */
  warehouseIds?: string[];
  /** Mã kho tương ứng (`maKho`), dùng cho API v2 phân tán. */
  warehouseCodes?: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_wms_team8_2026';

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendError(res, 'Chưa đăng nhập hoặc token không hợp lệ', 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthenticatedUser;
    req.user = decoded;
    next();
  } catch (error) {
    return sendError(res, 'Phiên đăng nhập đã hết hạn hoặc token không hợp lệ', 401);
  }
};

export const authorize = (allowedRoles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return sendError(res, 'Yêu cầu xác thực tài khoản', 401);
    }

    // Role ADMIN luôn có toàn quyền
    if (req.user.role === Role.ADMIN || allowedRoles.includes(req.user.role)) {
      return next();
    }

    return sendError(res, 'Bạn không có quyền thực hiện thao tác này', 403);
  };
};

/** Kiểm tra một người dùng có được phép làm việc với kho này không. */
export function canAccessWarehouse(
  user: AuthenticatedUser | undefined,
  target: { id?: string; code?: string }
): boolean {
  if (!user) return false;
  if (user.role === Role.ADMIN) return true;
  if (target.id && user.warehouseIds?.includes(target.id)) return true;
  if (target.code && user.warehouseCodes?.includes(target.code)) return true;
  return false;
}

/**
 * Middleware v1: chặn mọi request có `khoId` trong params/query/body nếu người
 * dùng không được gán vào kho đó. Request không mang `khoId` vẫn đi continue
 * (controller chịu trách nhiệm lọc danh sách theo phạm vi của user).
 */
export const authorizeWarehouse = (
  source: 'params' | 'query' | 'body' | 'header' = 'body',
  key: string | string[] = 'khoId'
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const keys = Array.isArray(key) ? key : [key];
    const container =
      source === 'params'
        ? req.params
        : source === 'query'
          ? req.query
          : source === 'header'
            ? req.headers
            : req.body || {};

    const found = keys
      .map((name) =>
        source === 'header'
          ? (req.header(name) as string | undefined)
          : (container as Record<string, unknown>)[name]
      )
      .find((value) => value !== undefined && value !== null && value !== '');

    if (found === undefined) return next();
    const raw = found;

    const value = String(raw);
    if (
      canAccessWarehouse(req.user, {
        id: value,
        code: value,
      })
    ) {
      return next();
    }

    return sendError(res, 'Bạn không có quyền thao tác trên kho này', 403);
  };
};
