import { Router } from 'express';
import { ClusterController } from '../controllers/cluster.controller';

const router = Router();

// Không bắt buộc token khắt khe cho status để UI hoặc load balancer / monitoring probe có thể gọi health check
router.get('/status', ClusterController.getStatus);
router.post('/failover/simulate', ClusterController.toggleSimulatedFailover);
router.post('/sync', ClusterController.syncData);
router.post('/test-routing', ClusterController.testRouting);

// Đa nguồn CSDL (Multi-Source Distributed Storage)
router.get('/multi-source/stats', ClusterController.getMultiSourceStats);
router.post('/multi-source/sync-all', ClusterController.syncAllSources);
router.post('/multi-source/test-write', ClusterController.testMultiSourceWrite);

export default router;
