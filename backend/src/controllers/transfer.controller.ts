import { Request, Response } from 'express';
import { TransferService } from '../services/transfer.service';
import { sendSuccess, sendError } from '../utils/response.util';
import { TrangThaiPhieu } from '@prisma/client';

export class TransferController {
  static async getAll(req: Request, res: Response) {
    try {
      const { khoNguonId, khoDichId, trangThai } = req.query;
      const transfers = await TransferService.getAllTransfers({
        khoNguonId: khoNguonId as string,
        khoDichId: khoDichId as string,
        trangThai: trangThai as TrangThaiPhieu,
      });
      return sendSuccess(res, transfers, 'Lấy danh sách phiếu chuyển kho thành công');
    } catch (error: any) {
      return sendError(res, error.message, 400);
    }
  }

  static async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const transfer = await TransferService.getTransferById(id);
      return sendSuccess(res, transfer, 'Lấy thông tin phiếu chuyển kho thành công');
    } catch (error: any) {
      return sendError(res, error.message, 404);
    }
  }

  static async create(req: Request, res: Response) {
    try {
      if (!req.user) return sendError(res, 'Chưa xác thực người dùng', 401);
      const transfer = await TransferService.createTransfer(req.body, req.user.id);
      return sendSuccess(res, transfer, 'Lập phiếu chuyển kho thành công', 201);
    } catch (error: any) {
      return sendError(res, error.message, 400);
    }
  }

  static async approve(req: Request, res: Response) {
    try {
      if (!req.user) return sendError(res, 'Chưa xác thực người dùng', 401);
      const { id } = req.params;
      const ipAddress = req.ip || req.socket.remoteAddress;
      const approved = await TransferService.approveTransfer(id, req.user.id, ipAddress);
      return sendSuccess(res, approved, 'Phê duyệt và hoàn tất điều chuyển kho thành công');
    } catch (error: any) {
      return sendError(res, error.message, 400);
    }
  }

  static async reject(req: Request, res: Response) {
    try {
      if (!req.user) return sendError(res, 'Chưa xác thực người dùng', 401);
      const { id } = req.params;
      const { lyDo } = req.body;
      const rejected = await TransferService.rejectTransfer(id, req.user.id, lyDo);
      return sendSuccess(res, rejected, 'Từ chối phiếu chuyển kho và giải phóng tồn khả dụng thành công');
    } catch (error: any) {
      return sendError(res, error.message, 400);
    }
  }
}

