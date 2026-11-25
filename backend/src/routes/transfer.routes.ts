import { Router } from 'express';
import { TransferController } from '../controllers/transfer.controller';
import { authenticate, authorize } from '../middlewares/auth.middleware';
import { Role } from '@prisma/client';

const router = Router();

router.get('/', authenticate, TransferController.getAll);
router.get('/:id', authenticate, TransferController.getById);

router.post(
  '/',
  authenticate,
  authorize([Role.ADMIN, Role.QUAN_LY_KHO, Role.NHAN_VIEN_KHO]),
  TransferController.create
);

router.post(
  '/:id/approve',
  authenticate,
  authorize([Role.ADMIN, Role.QUAN_LY_KHO]),
  TransferController.approve
);

router.post(
  '/:id/reject',
  authenticate,
  authorize([Role.ADMIN, Role.QUAN_LY_KHO]),
  TransferController.reject
);

export default router;

