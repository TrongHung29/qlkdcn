import { Router } from 'express';
import { InventoryController } from '../controllers/inventory.controller';
import { authenticate, authorize } from '../middlewares/auth.middleware';
import { Role } from '@prisma/client';

const router = Router();

// Tra cứu tồn kho chi tiết (theo kho, theo sản phẩm, theo vị trí)
router.get('/', authenticate, InventoryController.getInventory);

// Thống kê tổng quan cho Dashboard
router.get('/dashboard', authenticate, InventoryController.getDashboard);

// Danh sách cảnh báo tồn kho
router.get('/alerts', authenticate, InventoryController.getAlerts);
router.post(
  '/alerts/:id/resolve',
  authenticate,
  authorize([Role.ADMIN, Role.QUAN_LY_KHO]),
  InventoryController.resolveAlert
);

// Xem nhật ký kiểm toán hệ thống
router.get('/audits', authenticate, authorize([Role.ADMIN, Role.QUAN_LY_KHO]), InventoryController.getAuditLogs);

// Điều chỉnh tồn kho thủ công (Chỉ Quản lý kho và Admin được phép)
router.post(
  '/adjust',
  authenticate,
  authorize([Role.ADMIN, Role.QUAN_LY_KHO]),
  InventoryController.adjustStock
);

export default router;

