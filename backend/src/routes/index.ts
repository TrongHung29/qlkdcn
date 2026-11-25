import { Router } from 'express';
import authRoutes from './auth.routes';
import productRoutes from './product.routes';
import receiptRoutes from './receipt.routes';
import dispatchRoutes from './dispatch.routes';
import transferRoutes from './transfer.routes';
import inventoryRoutes from './inventory.routes';
import locationRoutes from './location.routes';
import notificationRoutes from './notification.routes';
import clusterRoutes from './cluster.routes';
import { authorizeWarehouse } from '../middlewares/auth.middleware';

const router = Router();

// Warehouse-scoped RBAC cho API v1: mọi request mang khoId/khoNguonId/khoDichId
// đều bị chặn nếu người dùng không được gán vào kho đó.
router.use(authorizeWarehouse('body', ['khoId', 'khoNguonId', 'khoDichId']));
router.use(authorizeWarehouse('query', ['khoId', 'khoNguonId', 'khoDichId']));
router.use(authorizeWarehouse('params', ['khoId']));

router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/receipts', receiptRoutes);
router.use('/dispatches', dispatchRoutes);
router.use('/transfers', transferRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/locations', locationRoutes);
router.use('/notifications', notificationRoutes);
router.use('/cluster', clusterRoutes);

export default router;

