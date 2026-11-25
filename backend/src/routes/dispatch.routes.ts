import { Router } from 'express';
import { DispatchController } from '../controllers/dispatch.controller';
import { authenticate, authorize } from '../middlewares/auth.middleware';
import { Role } from '@prisma/client';

const router = Router();

// Xem danh sách và chi tiết phiếu xuất
router.get('/', authenticate, DispatchController.getAll);
router.get('/:id', authenticate, DispatchController.getById);

// Kiểm tra tồn kho khả dụng trước khi lập phiếu
router.post('/check-availability', authenticate, DispatchController.checkAvailability);

// Lập phiếu xuất kho (Kinh doanh, Mua hàng, Kho, Quản lý, Admin)
router.post(
  '/',
  authenticate,
  authorize([Role.ADMIN, Role.QUAN_LY_KHO, Role.NHAN_VIEN_KHO, Role.NHAN_VIEN_BAN_HANG, Role.NHAN_VIEN_MUA_HANG]),
  DispatchController.create
);

// Phê duyệt phiếu xuất kho (Chỉ Quản lý kho và Admin) - KÍCH HOẠT TRANSACTION TRỪ TỒN
router.post(
  '/:id/approve',
  authenticate,
  authorize([Role.ADMIN, Role.QUAN_LY_KHO]),
  DispatchController.approve
);

// Từ chối phiếu xuất kho (Giải phóng tồn khả dụng)
router.post(
  '/:id/reject',
  authenticate,
  authorize([Role.ADMIN, Role.QUAN_LY_KHO]),
  DispatchController.reject
);

// Quét và giải phóng các phiếu giữ chỗ quá hạn TTL
router.post(
  '/sweep-expired',
  authenticate,
  authorize([Role.ADMIN, Role.QUAN_LY_KHO]),
  DispatchController.sweepExpired
);

export default router;

