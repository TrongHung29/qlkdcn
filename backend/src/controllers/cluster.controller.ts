import { Request, Response } from 'express';
import { clusterManager } from '../cluster/cluster.manager';
import { multiSourceManager } from '../cluster/multi-source.manager';
import { sendSuccess, sendError } from '../utils/response.util';

export class ClusterController {
  static async getStatus(req: Request, res: Response) {
    try {
      const state = await clusterManager.getClusterState();
      return sendSuccess(res, state, 'Lấy thông tin cụm Database phân tán thành công');
    } catch (error: any) {
      return sendError(res, error.message || 'Lỗi khi kiểm tra cụm Database', 500);
    }
  }

  static async toggleSimulatedFailover(req: Request, res: Response) {
    try {
      const { active, reason } = req.body;
      const state = clusterManager.setSimulatedFailover(Boolean(active), reason);
      const msg = active
        ? 'Đã kích hoạt mô phỏng sự cố: Tự động chuyển mạch sang Database Dự phòng (Standby 5434)'
        : 'Đã tắt mô phỏng sự cố: Database chính đã phục hồi, hệ thống trở về trạng thái bình thường';
      return sendSuccess(res, state, msg);
    } catch (error: any) {
      return sendError(res, error.message || 'Lỗi khi kích hoạt chuyển mạch', 500);
    }
  }

  static async syncData(req: Request, res: Response) {
    try {
      const result = await clusterManager.syncReplication();
      return sendSuccess(res, result, result.message);
    } catch (error: any) {
      return sendError(res, error.message || 'Lỗi khi đồng bộ dữ liệu', 500);
    }
  }

  static async testRouting(req: Request, res: Response) {
    try {
      const result = await clusterManager.testRouting();
      return sendSuccess(res, result, 'Kiểm tra phân luồng Đọc/Ghi phân tán thành công');
    } catch (error: any) {
      return sendError(res, error.message || 'Lỗi khi kiểm tra phân luồng', 500);
    }
  }

  static async getMultiSourceStats(req: Request, res: Response) {
    try {
      const overview = await multiSourceManager.getDistributionOverview();
      return sendSuccess(res, overview, 'Lấy bảng thống kê phân tán đa nguồn CSDL thành công');
    } catch (error: any) {
      return sendError(res, error.message || 'Lỗi khi lấy dữ liệu đa nguồn', 500);
    }
  }

  static async syncAllSources(req: Request, res: Response) {
    try {
      const result = await multiSourceManager.syncAllSourcesNow();
      return sendSuccess(res, result, result.message);
    } catch (error: any) {
      return sendError(res, error.message || 'Lỗi khi đồng bộ đa nguồn CSDL', 500);
    }
  }

  static async testMultiSourceWrite(req: Request, res: Response) {
    try {
      const payload = req.body || {
        sku: 'TEST-SKU-' + Date.now().toString().slice(-4),
        name: 'Sản phẩm thử nghiệm Đa Nguồn',
        uom: 'Cái',
        qty: 100,
      };
      const result = await multiSourceManager.testMultiSourceWrite(payload);
      return sendSuccess(res, result, 'Thử nghiệm ghi đồng thời vào đa nguồn CSDL thành công');
    } catch (error: any) {
      return sendError(res, error.message || 'Lỗi khi thử nghiệm ghi đa nguồn', 500);
    }
  }
}
