import prisma from '../config/prisma';
import { TrangThaiPhieu, LoaiChuyenKho, TrangThaiViTri } from '@prisma/client';
import { generateTransferCode } from '../utils/code-generator.util';

export interface CreateTransferItemDto {
  hangHoaId: string;
  viTriDiId: string;
  viTriDenId: string;
  slChuyen: number;
  ghiChu?: string;
}

export interface CreateTransferDto {
  khoNguonId: string;
  khoDichId: string;
  loaiChuyen?: LoaiChuyenKho;
  ghiChu?: string;
  items: CreateTransferItemDto[];
}

export class TransferService {
  static async getAllTransfers(query: { khoNguonId?: string; khoDichId?: string; trangThai?: TrangThaiPhieu }) {
    const where: any = {};
    if (query.khoNguonId) where.khoNguonId = query.khoNguonId;
    if (query.khoDichId) where.khoDichId = query.khoDichId;
    if (query.trangThai) where.trangThai = query.trangThai;

    return prisma.phieuChuyenKho.findMany({
      where,
      include: {
        khoNguon: true,
        khoDich: true,
        nguoiLap: { select: { id: true, maNV: true, hoTen: true, username: true } },
        nguoiDuyet: { select: { id: true, maNV: true, hoTen: true, username: true } },
        chiTiet: {
          include: {
            hangHoa: true,
            viTriDi: true,
            viTriDen: true,
          },
        },
      },
      orderBy: { ngayTao: 'desc' },
    });
  }

  static async getTransferById(id: string) {
    const transfer = await prisma.phieuChuyenKho.findUnique({
      where: { id },
      include: {
        khoNguon: true,
        khoDich: true,
        nguoiLap: { select: { id: true, maNV: true, hoTen: true, username: true } },
        nguoiDuyet: { select: { id: true, maNV: true, hoTen: true, username: true } },
        chiTiet: {
          include: {
            hangHoa: true,
            viTriDi: true,
            viTriDen: true,
          },
        },
      },
    });

    if (!transfer) throw new Error('Không tìm thấy phiếu chuyển kho');
    return transfer;
  }

  static async createTransfer(data: CreateTransferDto, userId: string) {
    if (!data.items || data.items.length === 0) {
      throw new Error('Phiếu chuyển kho phải có ít nhất 1 mặt hàng chi tiết');
    }

    const maPC = await generateTransferCode();
    const loaiChuyen =
      data.khoNguonId === data.khoDichId
        ? LoaiChuyenKho.NOI_BO_KHO
        : (data.loaiChuyen || LoaiChuyenKho.LIEN_KHO);

    const transfer = await prisma.$transaction(async (tx) => {
      // 1. Kiểm tra tồn khả dụng và tạm giữ tồn tại kho nguồn để tránh xung đột đồng thời
      for (const item of data.items) {
        const sourceStock = await tx.tonKho.findUnique({
          where: {
            khoId_hangHoaId_viTriId: {
              khoId: data.khoNguonId,
              hangHoaId: item.hangHoaId,
              viTriId: item.viTriDiId,
            },
          },
          include: { hangHoa: true, viTri: true },
        });

        if (!sourceStock || sourceStock.soLuongKhaDung < item.slChuyen) {
          throw new Error(
            `Không đủ tồn khả dụng cho hàng "${sourceStock?.hangHoa?.tenHH || 'Chưa rõ'}" tại vị trí nguồn để chuyển (Khả dụng: ${sourceStock?.soLuongKhaDung || 0}, Cần chuyển: ${item.slChuyen})`
          );
        }

        // Tạm giữ tồn tại vị trí nguồn
        await tx.tonKho.update({
          where: { id: sourceStock.id },
          data: {
            soLuongTamGiu: sourceStock.soLuongTamGiu + item.slChuyen,
            soLuongKhaDung: sourceStock.soLuongKhaDung - item.slChuyen,
          },
        });
      }

      // 2. Tạo phiếu chuyển kho
      const created = await tx.phieuChuyenKho.create({
        data: {
          maPC,
          loaiChuyen,
          khoNguonId: data.khoNguonId,
          khoDichId: data.khoDichId,
          nguoiLapId: userId,
          trangThai: TrangThaiPhieu.PENDING,
          ghiChu: data.ghiChu,
          chiTiet: {
            create: data.items.map((i) => ({
              hangHoaId: i.hangHoaId,
              viTriDiId: i.viTriDiId,
              viTriDenId: i.viTriDenId,
              slChuyen: i.slChuyen,
              ghiChu: i.ghiChu,
            })),
          },
        },
        include: { chiTiet: true },
      });

      await tx.lichSuThaoTac.create({
        data: {
          nguoiDungId: userId,
          loaiThaoTac: 'TAO_PHIEU_CHUYEN_KHO',
          doiTuong: 'PhieuChuyenKho',
          doiTuongId: created.id,
          noiDung: `Lập yêu cầu chuyển kho ${maPC} (${loaiChuyen}) với ${data.items.length} mặt hàng, đã tạm giữ tồn kho nguồn an toàn`,
        },
      });

      return created;
    });

    return transfer;
  }

  // PHÊ DUYỆT CHUYỂN KHO (DATABASE TRANSACTION: TRỪ NGUỒN, CỘNG ĐÍCH)
  static async approveTransfer(id: string, userId: string, ipAddress?: string) {
    const transfer = await prisma.phieuChuyenKho.findUnique({
      where: { id },
      include: {
        chiTiet: {
          include: {
            hangHoa: true,
            viTriDi: true,
            viTriDen: true,
          },
        },
      },
    });

    if (!transfer) throw new Error('Không tìm thấy phiếu chuyển kho');
    if (transfer.trangThai !== TrangThaiPhieu.PENDING) {
      throw new Error(`Phiếu chuyển ${transfer.maPC} không ở trạng thái Chờ duyệt`);
    }

    const result = await prisma.$transaction(async (tx) => {
      for (const item of transfer.chiTiet) {
        // 1. Kiểm tra và trừ tồn kho tại vị trí xuất đi (Kho nguồn)
        const sourceStock = await tx.tonKho.findUnique({
          where: {
            khoId_hangHoaId_viTriId: {
              khoId: transfer.khoNguonId,
              hangHoaId: item.hangHoaId,
              viTriId: item.viTriDiId,
            },
          },
        });

        if (!sourceStock || sourceStock.soLuongTon < item.slChuyen) {
          throw new Error(
            `Không đủ hàng "${item.hangHoa.tenHH}" tại vị trí nguồn ${item.viTriDi.maViTri} để điều chuyển (Tồn: ${sourceStock?.soLuongTon || 0}, Chuyển: ${item.slChuyen})`
          );
        }

        // Trừ tại nguồn và giải phóng số lượng tạm giữ tương ứng
        const newSourceTon = sourceStock.soLuongTon - item.slChuyen;
        const newSourceTamGiu = Math.max(0, sourceStock.soLuongTamGiu - item.slChuyen);
        const newSourceKhaDung = Math.max(0, newSourceTon - newSourceTamGiu);

        await tx.tonKho.update({
          where: { id: sourceStock.id },
          data: {
            soLuongTon: newSourceTon,
            soLuongTamGiu: newSourceTamGiu,
            soLuongKhaDung: newSourceKhaDung,
          },
        });

        // 2. Khóa hàng và kiểm tra sức chứa tại vị trí nhận đến (Kho đích)
        await tx.$executeRawUnsafe(
          'SELECT id FROM vi_tri_luu_tru WHERE id = $1 FOR UPDATE',
          item.viTriDenId
        );

        const destSlot = await tx.viTriLuuTru.findUnique({ where: { id: item.viTriDenId } });
        if (!destSlot) throw new Error('Không tìm thấy vị trí ô lưu trữ đích');

        const destSlotTotal = await tx.tonKho.aggregate({
          where: { viTriId: item.viTriDenId },
          _sum: { soLuongTon: true },
        });
        const currentDestQty = destSlotTotal._sum.soLuongTon || 0;
        if (currentDestQty + item.slChuyen > destSlot.sucChua) {
          throw new Error(
            `Vị trí đích "${destSlot.maViTri}" có hạn mức sức chứa là ${destSlot.sucChua} sản phẩm (hiện đang chứa ${currentDestQty}). Không thể chuyển thêm ${item.slChuyen} sản phẩm vì sẽ vượt quá hạn mức!`
          );
        }

        // 3. Cộng tồn kho tại vị trí nhận đến (Kho đích)
        const destStock = await tx.tonKho.findUnique({
          where: {
            khoId_hangHoaId_viTriId: {
              khoId: transfer.khoDichId,
              hangHoaId: item.hangHoaId,
              viTriId: item.viTriDenId,
            },
          },
        });

        if (destStock) {
          await tx.tonKho.update({
            where: { id: destStock.id },
            data: {
              soLuongTon: destStock.soLuongTon + item.slChuyen,
              soLuongKhaDung: destStock.soLuongKhaDung + item.slChuyen,
            },
          });
        } else {
          await tx.tonKho.create({
            data: {
              khoId: transfer.khoDichId,
              hangHoaId: item.hangHoaId,
              viTriId: item.viTriDenId,
              soLuongTon: item.slChuyen,
              soLuongKhaDung: item.slChuyen,
              soLuongTamGiu: 0,
            },
          });
        }
      }

      // 4. Cập nhật trạng thái phiếu chuyển sang APPROVED
      const approved = await tx.phieuChuyenKho.update({
        where: { id },
        data: {
          trangThai: TrangThaiPhieu.APPROVED,
          nguoiDuyetId: userId,
          ngayDuyet: new Date(),
        },
      });

      // 5. Ghi log
      await tx.lichSuThaoTac.create({
        data: {
          nguoiDungId: userId,
          loaiThaoTac: 'CHUYEN_KHO_DUYET',
          doiTuong: 'PhieuChuyenKho',
          doiTuongId: transfer.id,
          noiDung: `Phê duyệt phiếu chuyển kho ${transfer.maPC}, trừ tồn nguồn và cộng tồn đích thành công`,
          ipAddress: ipAddress || '127.0.0.1',
        },
      });

      return approved;
    });

    return result;
  }

  // TỪ CHỐI DUYỆT PHIẾU CHUYỂN KHO (HOÀN TRẢ TỒN TẠM GIỮ TẠI KHO NGUỒN)
  static async rejectTransfer(id: string, userId: string, lyDo?: string) {
    const transfer = await prisma.phieuChuyenKho.findUnique({
      where: { id },
      include: { chiTiet: true },
    });

    if (!transfer) throw new Error('Không tìm thấy phiếu chuyển kho');
    if (transfer.trangThai !== TrangThaiPhieu.PENDING) {
      throw new Error('Chỉ có thể từ chối phiếu đang ở trạng thái Chờ duyệt');
    }

    const result = await prisma.$transaction(async (tx) => {
      // Hoàn trả tồn tạm giữ tại kho nguồn về lại tồn khả dụng
      for (const item of transfer.chiTiet) {
        const sourceStock = await tx.tonKho.findUnique({
          where: {
            khoId_hangHoaId_viTriId: {
              khoId: transfer.khoNguonId,
              hangHoaId: item.hangHoaId,
              viTriId: item.viTriDiId,
            },
          },
        });
        if (sourceStock) {
          const newTamGiu = Math.max(0, sourceStock.soLuongTamGiu - item.slChuyen);
          const newKhaDung = Math.min(
            sourceStock.soLuongTon,
            sourceStock.soLuongKhaDung + item.slChuyen
          );
          await tx.tonKho.update({
            where: { id: sourceStock.id },
            data: {
              soLuongTamGiu: newTamGiu,
              soLuongKhaDung: newKhaDung,
            },
          });
        }
      }

      const updated = await tx.phieuChuyenKho.update({
        where: { id },
        data: {
          trangThai: TrangThaiPhieu.REJECTED,
          nguoiDuyetId: userId,
          ngayDuyet: new Date(),
          ghiChu: lyDo
            ? `${transfer.ghiChu || ''} [Lý do từ chối: ${lyDo}]`
            : transfer.ghiChu,
        },
      });

      await tx.lichSuThaoTac.create({
        data: {
          nguoiDungId: userId,
          loaiThaoTac: 'TU_CHOI_CHUYEN_KHO',
          doiTuong: 'PhieuChuyenKho',
          doiTuongId: id,
          noiDung: `Từ chối phiếu chuyển kho ${transfer.maPC}, đã giải phóng tồn khả dụng tại kho nguồn`,
        },
      });

      return updated;
    });

    return result;
  }
}

