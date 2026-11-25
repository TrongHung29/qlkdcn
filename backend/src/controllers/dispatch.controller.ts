import { Request, Response } from 'express';
import { DispatchService } from '../services/dispatch.service';
import { sendSuccess, sendError } from '../utils/response.util';
import { TrangThaiPhieu } from '@prisma/client';

export class DispatchController {
  static async getAll(req: Request, res: Response) {
    try {
      const { khoId, trangThai } = req.query;
      const dispatches = await DispatchService.getAllDispatches({
        khoId: khoId as string,
        trangThai: trangThai as TrangThaiPhieu,
      });
      return sendSuccess(res, dispatches, 'Lấy danh sách phiếu xuất kho thành công');
    } catch (error: any) {
      return sendError(res, error.message, 400);
    }
  }

  static async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const dispatch = await DispatchService.getDispatchById(id);
      return sendSuccess(res, dispatch, 'Lấy thông tin phiếu xuất kho thành công');
    } catch (error: any) {
      return sendError(res, error.message, 404);
    }
  }

  static async checkAvailability(req: Request, res: Response) {
    try {
      const { khoId, items } = req.body;
      if (!khoId || !items || !Array.isArray(items)) {
        return sendError(res, 'Vui lòng cung cấp khoId và danh sách items cần kiểm tra', 400);
      }
      const check = await DispatchService.checkInventoryAvailability(khoId, items);
      return sendSuccess(res, check, 'Kiểm tra tồn kho thành công');
    } catch (error: any) {
      return sendError(res, error.message, 400);
    }
  }

  static async create(req: Request, res: Response) {
    try {
      if (!req.user) {
        return sendError(res, 'Chưa xác thực người dùng', 401);
      }
      const dispatch = await DispatchService.createDispatch(req.body, req.user.id);
      return sendSuccess(res, dispatch, 'Lập phiếu xuất kho thành công', 201);
    } catch (error: any) {
      return sendError(res, error.message, 400);
    }
  }

  static async approve(req: Request, res: Response) {
    try {
      if (!req.user) {
        return sendError(res, 'Chưa xác thực người dùng', 401);
      }
      const { id } = req.params;
      const ipAddress = req.ip || req.socket.remoteAddress;
      const approved = await DispatchService.approveDispatch(id, req.user.id, ipAddress);
      return sendSuccess(res, approved, 'Phê duyệt và ghi sổ trừ tồn kho thành công');
    } catch (error: any) {
      return sendError(res, error.message, 400);
    }
  }

  static async reject(req: Request, res: Response) {
    try {
      if (!req.user) {
        return sendError(res, 'Chưa xác thực người dùng', 401);
      }
      const { id } = req.params;
      const { lyDo } = req.body;
      const rejected = await DispatchService.rejectDispatch(id, req.user.id, lyDo);
      return sendSuccess(res, rejected, 'Đã từ chối phiếu xuất và hoàn trả tồn khả dụng');
    } catch (error: any) {
      return sendError(res, error.message, 400);
    }
  }

  static async sweepExpired(req: Request, res: Response) {
    try {
      const minutes = req.body.maxAgeMinutes ? Number(req.body.maxAgeMinutes) : 60;
      const result = await DispatchService.autoReleaseExpiredDispatches(minutes);
      return sendSuccess(res, result, `Đã quét và giải phóng ${result.count} phiếu xuất quá hạn giữ chỗ`);
    } catch (error: any) {
      return sendError(res, error.message, 400);
    }
  }
}

