import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import { Role } from '@prisma/client';
import {
  authenticate,
  authorize,
  canAccessWarehouse,
} from '../../middlewares/auth.middleware';
import { sendError } from '../../utils/response.util';
import {
  OUTBOX_BATCH_SIZE,
  SHARDS,
  shardForWarehouseCode,
  ShardName,
} from '../config';
import { query, withTransaction } from '../db';
import { ForbiddenError, toHttpError } from '../errors';
import { runIdempotent } from '../idempotency';
import { requireIdempotencyKey } from '../middleware/idempotency.middleware';
import { rabbitMQ } from '../infra/rabbitmq';
import { withRedlock } from '../infra/redlock';
import {
  getInventory,
  getInventorySummary,
  findWarehouseByCode,
  adjustStock,
  reconcileInventory,
} from '../services/inventory.service';
import {
  createInboundOrder,
  createOutboundOrder,
  fulfillOutboundOrder,
  getOrder,
  quickOutbound,
} from '../services/orders.service';
import { createTransfer, dispatchTransfer, getTransfer } from '../services/transfer.service';
import {
  approveCycleCount,
  createCycleCount,
  getCycleCount,
  rejectCycleCount,
} from '../services/cycle-count.service';
import { relayOutboxOnce } from '../workers/outbox-relay';

const router = Router();
router.use(authenticate);
router.use(requireIdempotencyKey);

const ROLES_ALL = [
  Role.ADMIN,
  Role.QUAN_LY_KHO,
  Role.NHAN_VIEN_KHO,
  Role.NHAN_VIEN_MUA_HANG,
  Role.NHAN_VIEN_BAN_HANG,
];
const ROLES_MANAGER = [Role.ADMIN, Role.QUAN_LY_KHO];
const ROLES_WAREHOUSE = [Role.ADMIN, Role.QUAN_LY_KHO, Role.NHAN_VIEN_KHO];
const ROLES_INBOUND = [
  Role.ADMIN,
  Role.QUAN_LY_KHO,
  Role.NHAN_VIEN_KHO,
  Role.NHAN_VIEN_MUA_HANG,
];

interface IdempotentContext {
  req: Request;
  shard: ShardName;
  warehouseId: string;
  createdBy?: string;
}

async function runMutating<T>(
  ctx: IdempotentContext,
  statusCode: number,
  message: string,
  action: (client: PoolClient) => Promise<T>
) {
  // Redlock chặn cùng một key được xử lý đồng thời ở 2 shard; advisory lock
  // trong runIdempotent vẫn là lớp phòng thứ hai khi Redis không khả dụng.
  return withRedlock(
    `v2:${ctx.shard}:${ctx.warehouseId}:${ctx.req.idempotencyKey}`,
    () =>
      withTransaction(ctx.shard, (client) =>
        runIdempotent(
          client,
          ctx.warehouseId,
          ctx.req.idempotencyKey!,
          async () => ({
            statusCode,
            body: { success: true, message, data: await action(client) },
          })
        )
      )
  );
}

function handleError(res: Response, error: unknown) {
  const info = toHttpError(error);
  if (info.code === 'IDEMPOTENT_REPLAY') return;
  return sendError(res, info.message, info.statusCode, {
    code: info.code,
    details: info.details,
  });
}

async function warehouseContext(req: Request, code: string): Promise<IdempotentContext> {
  if (!canAccessWarehouse(req.user, { code })) {
    throw new ForbiddenError('Tài khoản này không được phép thao tác trên kho ' + code);
  }
  const shard = shardForWarehouseCode(code);
  const warehouse = await findWarehouseByCode(shard, code);
  return { req, shard, warehouseId: warehouse.id, createdBy: req.user?.id };
}

router.get('/warehouses', async (req, res) => {
  try {
    const code = req.header('x-warehouse-code') || SHARDS.north.warehouseCode;
    const shard = shardForWarehouseCode(code);
    const result = await query(shard, `SELECT * FROM warehouses ORDER BY code`);
    const rows =
      req.user?.role === Role.ADMIN
        ? result.rows
        : result.rows.filter((row) => req.user?.warehouseCodes?.includes(row.code));
    return res.json({ success: true, message: 'Danh sách kho (đã nhân bản)', data: rows });
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/warehouses/:code/inventory', async (req, res) => {
  try {
    const ctx = await warehouseContext(req, req.params.code);
    const data = await getInventory(ctx.shard, ctx.warehouseId, req.query.productId as string);
    return res.json({ success: true, message: 'Tồn kho theo shard', data });
  } catch (error) {
    return handleError(res, error);
  }
});

/** CQRS read side: đọc tồn tổng hợp từ replica (5434) khi có cấu hình. */
router.get('/warehouses/:code/inventory/summary', async (req, res) => {
  try {
    const ctx = await warehouseContext(req, req.params.code);
    const data = await getInventorySummary(ctx.shard, ctx.warehouseId);
    return res.json({
      success: true,
      message: `Tổng hợp tồn kho (nguồn đọc: ${data.source})`,
      data,
    });
  } catch (error) {
    return handleError(res, error);
  }
});

/** Đối soát ledger định kỳ theo yêu cầu: 3 chỉ số tồn vs sổ nhật ký. */
router.get('/warehouses/:code/reconciliation', authorize(ROLES_WAREHOUSE), async (req, res) => {
  try {
    const ctx = await warehouseContext(req, req.params.code);
    const data = await reconcileInventory(ctx.shard, ctx.warehouseId);
    return res.json({
      success: true,
      message:
        data.mismatchCount === 0
          ? 'Đối soát tồn kho và sổ nhật ký khớp nhau'
          : `Phát hiện ${data.mismatchCount} dòng tồn không khớp sổ nhật ký`,
      data,
    });
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/warehouses/:code/inbound', authorize(ROLES_INBOUND), async (req, res) => {
  try {
    const ctx = await warehouseContext(req, req.params.code);
    const result = await runMutating(
      ctx,
      201,
      'Nhập kho thành công (đã ghi sổ nhật ký)',
      (client) =>
        createInboundOrder({
          ...ctx,
          lines: req.body.lines || [],
          partnerName: req.body.partnerName,
          client,
        })
    );
    return res.status(result.statusCode).json(result.value);
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/warehouses/:code/orders/outbound', authorize(ROLES_ALL), async (req, res) => {
  try {
    const ctx = await warehouseContext(req, req.params.code);
    const result = await runMutating(
      ctx,
      201,
      'Đã đặt trước hàng theo FEFO',
      (client) =>
        createOutboundOrder({
          ...ctx,
          lines: req.body.lines || [],
          partnerName: req.body.partnerName,
          client,
        })
    );
    return res.status(result.statusCode).json(result.value);
  } catch (error) {
    return handleError(res, error);
  }
});

router.post(
  '/warehouses/:code/orders/:orderId/fulfill',
  authorize(ROLES_WAREHOUSE),
  async (req, res) => {
    try {
      const ctx = await warehouseContext(req, req.params.code);
      const result = await runMutating(
        ctx,
        200,
        'Đã xuất kho, trừ tồn và ghi sổ nhật ký',
        (client) =>
          fulfillOutboundOrder({
            ...ctx,
            orderId: req.params.orderId,
            client,
          })
      );
      return res.status(result.statusCode).json(result.value);
    } catch (error) {
      return handleError(res, error);
    }
  }
);

/** Xuất nhanh phục vụ kiểm thử đồng thời (idempotent theo header). */
router.post(
  '/warehouses/:code/outbound/quick',
  authorize(ROLES_WAREHOUSE),
  async (req, res) => {
    try {
      const ctx = await warehouseContext(req, req.params.code);
      const result = await runMutating(
        ctx,
        200,
        'Xuất kho nhanh thành công',
        (client) =>
          quickOutbound({
            ...ctx,
            productId: req.body.productId,
            qty: Number(req.body.qty),
            client,
          })
      );
      return res.status(result.statusCode).json(result.value);
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.post('/warehouses/:code/adjustments', authorize(ROLES_MANAGER), async (req, res) => {
  try {
    const ctx = await warehouseContext(req, req.params.code);
    const result = await runMutating(
      ctx,
      200,
      'Đã điều chỉnh tồn bằng bản ghi ADJUSTMENT mới',
      (client) =>
        adjustStock({
          ...ctx,
          balanceId: req.body.balanceId,
          newPhysicalQty: Number(req.body.newPhysicalQty),
          reason: req.body.reason,
          client,
        })
    );
    return res.status(result.statusCode).json(result.value);
  } catch (error) {
    return handleError(res, error);
  }
});

// ---------------------------------------------------------------------------
// Kiểm kê 2 chiều
// ---------------------------------------------------------------------------

router.post(
  '/warehouses/:code/cycle-counts',
  authorize(ROLES_WAREHOUSE),
  async (req, res) => {
    try {
      const ctx = await warehouseContext(req, req.params.code);
      const result = await runMutating(ctx, 201, 'Đã lập phiếu kiểm kê 2 chiều', (client) =>
        createCycleCount({
          ...ctx,
          items: req.body.items || [],
          note: req.body.note,
          client,
        })
      );
      return res.status(result.statusCode).json(result.value);
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get('/warehouses/:code/cycle-counts/:countId', async (req, res) => {
  try {
    const ctx = await warehouseContext(req, req.params.code);
    const data = await getCycleCount(ctx.shard, ctx.warehouseId, req.params.countId);
    return res.json({ success: true, message: 'Chi tiết phiếu kiểm kê', data });
  } catch (error) {
    return handleError(res, error);
  }
});

router.post(
  '/warehouses/:code/cycle-counts/:countId/approve',
  authorize(ROLES_MANAGER),
  async (req, res) => {
    try {
      const ctx = await warehouseContext(req, req.params.code);
      const result = await runMutating(
        ctx,
        200,
        'Đã duyệt kiểm kê và phát hành các phiếu điều chỉnh ADJUSTMENT',
        (client) =>
          approveCycleCount({
            ...ctx,
            countId: req.params.countId,
            client,
          })
      );
      return res.status(result.statusCode).json(result.value);
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.post(
  '/warehouses/:code/cycle-counts/:countId/reject',
  authorize(ROLES_MANAGER),
  async (req, res) => {
    try {
      const ctx = await warehouseContext(req, req.params.code);
      const result = await runMutating(ctx, 200, 'Đã từ chối phiếu kiểm kê', (client) =>
        rejectCycleCount({ ...ctx, countId: req.params.countId, client })
      );
      return res.status(result.statusCode).json(result.value);
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get('/warehouses/:code/orders/:orderId', async (req, res) => {
  try {
    const ctx = await warehouseContext(req, req.params.code);
    const data = await getOrder(ctx.shard, ctx.warehouseId, req.params.orderId);
    return res.json({ success: true, message: 'Chi tiết phiếu kho', data });
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/transfers', authorize(ROLES_WAREHOUSE), async (req, res) => {
  try {
    const fromCode = req.body.fromWarehouseCode;
    const toCode = req.body.toWarehouseCode;
    if (
      !canAccessWarehouse(req.user, { code: fromCode }) ||
      !canAccessWarehouse(req.user, { code: toCode })
    ) {
      throw new ForbiddenError('Tài khoản này không được phép điều chuyển giữa 2 kho đã chọn');
    }
    const shard = shardForWarehouseCode(fromCode);
    const [fromWarehouse, toWarehouse] = await Promise.all([
      findWarehouseByCode(shard, fromCode),
      findWarehouseByCode(shard, toCode),
    ]);
    const result = await runMutating(
      { req, shard, warehouseId: fromWarehouse.id },
      201,
      'Đã lập phiếu điều chuyển và giữ chỗ FEFO tại kho nguồn',
      (client) =>
        createTransfer({
          shard,
          warehouseId: fromWarehouse.id,
          fromWarehouseId: fromWarehouse.id,
          toWarehouseId: toWarehouse.id,
          items: req.body.items || [],
          client,
        })
    );
    return res.status(result.statusCode).json(result.value);
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/transfers/:id/dispatch', authorize(ROLES_WAREHOUSE), async (req, res) => {
  try {
    const code =
      req.body.warehouseCode || req.header('x-warehouse-code') || SHARDS.north.warehouseCode;
    const ctx = await warehouseContext(req, code);
    const result = await runMutating(
      ctx,
      200,
      'Hàng đã xuất kho nguồn, trạng thái IN_TRANSIT, sự kiện đã vào outbox',
      (client) =>
        dispatchTransfer({
          ...ctx,
          transferId: req.params.id,
          client,
        })
    );
    return res.status(result.statusCode).json(result.value);
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/transfers/:id', async (req, res) => {
  try {
    const code =
      (req.query.warehouseCode as string) ||
      req.header('x-warehouse-code') ||
      SHARDS.north.warehouseCode;
    const ctx = await warehouseContext(req, code);
    const data = await getTransfer(ctx.shard, ctx.warehouseId, req.params.id);
    return res.json({ success: true, message: 'Chi tiết phiếu điều chuyển', data });
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/outbox', authorize(ROLES_MANAGER), async (req, res) => {
  try {
    const code = (req.query.warehouseCode as string) || SHARDS.north.warehouseCode;
    if (!canAccessWarehouse(req.user, { code })) {
      throw new ForbiddenError('Tài khoản này không được xem outbox của kho ' + code);
    }
    const shard = shardForWarehouseCode(code);
    const result = await query(
      shard,
      `SELECT id, event_type, status, payload, created_at
         FROM outbox_events
        ORDER BY created_at DESC
        LIMIT $1`,
      [Number(req.query.limit || OUTBOX_BATCH_SIZE)]
    );
    return res.json({ success: true, message: 'Outbox events', data: result.rows });
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/outbox/relay', authorize(ROLES_MANAGER), async (req, res) => {
  try {
    const code = req.body.warehouseCode || SHARDS.north.warehouseCode;
    const ctx = await warehouseContext(req, code);
    const result = await runMutating(ctx, 200, 'Đã chạy một lượt outbox relay', (client) =>
      relayOutboxOnce(ctx.shard, client)
    );
    return res.status(result.statusCode).json(result.value);
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/dlq/stats', authorize(ROLES_MANAGER), async (_req, res) => {
  try {
    const remaining = await rabbitMQ.getDlqMessageCount();
    return res.json({
      success: true,
      message: 'Số sự kiện đang nằm trong Dead Letter Queue',
      data: { queue: 'warehouse.saga.dead-letter', remaining },
    });
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/dlq/redrive', authorize(ROLES_MANAGER), async (req, res) => {
  try {
    const result = await rabbitMQ.redriveFromDlq(Number(req.body.limit || 50));
    return res.json({
      success: true,
      message: `Đã phát lại ${result.redriven} sự kiện từ DLQ`,
      data: result,
    });
  } catch (error) {
    return handleError(res, error);
  }
});

export default router;
