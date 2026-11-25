import prisma from '../config/prisma';
import { TrangThaiPhieu, TrangThaiViTri, TrangThaiCanhBao } from '@prisma/client';
import { generateReceiptCode } from '../utils/code-generator.util';

export interface CreateReceiptItemDto {
  hangHoaId: string;
  viTriId: string;
  slYeuCau: number;
  slThucNhap: number;
  donGiaNhap: number;
  ghiChu?: string;
}

export interface CreateReceiptDto {
  khoId: string;
  nhaCungCapId?: string;
  tenNhaCungCapMoi?: string;
  sdtNhaCungCapMoi?: string;
  ketQuaKiemTra?: string;
  ghiChu?: string;
  items: CreateReceiptItemDto[];
}

export class ReceiptService {
  static async getAllReceipts(query: { khoId?: string; trangThai?: TrangThaiPhieu }) {
    const where: any = {};
    if (query.khoId) where.khoId = query.khoId;
    if (query.trangThai) where.trangThai = query.trangThai;

    return prisma.phieuNhapKho.findMany({
      where,
      include: {
        kho: true,
        nhaCungCap: true,
        nguoiLap: { select: { id: true, maNV: true, hoTen: true, username: true } },
        nguoiDuyet: { select: { id: true, maNV: true, hoTen: true, username: true } },
        chiTiet: {
          include: {
            hangHoa: true,
            viTri: true,
          },
        },
      },
      orderBy: { ngayTao: 'desc' },
    });
  }

  static async getReceiptById(id: string) {
    const receipt = await prisma.phieuNhapKho.findUnique({
      where: { id },
      include: {
        kho: true,
        nhaCungCap: true,
        nguoiLap: { select: { id: true, maNV: true, hoTen: true, username: true } },
        nguoiDuyet: { select: { id: true, maNV: true, hoTen: true, username: true } },
        chiTiet: {
          include: {
            hangHoa: true,
            viTri: true,
          },
        },
      },
    });

    if (!receipt) {
      throw new Error('Không tìm thấy phiếu nhập kho');
    }
    return receipt;
  }

  // 1. Tạo phiếu nhập kho (Mặc định ở trạng thái PENDING)
  static async createReceipt(data: CreateReceiptDto, userId: string) {
    if (!data.items || data.items.length === 0) {
      throw new Error('Phiếu nhập kho phải có ít nhất 1 mặt hàng chi tiết');
    }

    // Xử lý tự điền tên Nhà Cung Cấp mới hoặc chọn sẵn
    let finalNhaCungCapId = data.nhaCungCapId;
    if (data.tenNhaCungCapMoi && data.tenNhaCungCapMoi.trim()) {
      const trimmedName = data.tenNhaCungCapMoi.trim();
      let existingNCC = await prisma.nhaCungCap.findFirst({
        where: { tenNCC: { equals: trimmedName, mode: 'insensitive' } },
      });
      if (!existingNCC) {
        const count = await prisma.nhaCungCap.count();
        const randomNum = Math.floor(100 + Math.random() * 900);
        const maNCC = `NCC${count + 1}${randomNum}`;
        existingNCC = await prisma.nhaCungCap.create({
          data: {
            maNCC,
            tenNCC: trimmedName,
            sdt: data.sdtNhaCungCapMoi?.trim() || '0900000000',
            trangThai: true,
          },
        });
      }
      finalNhaCungCapId = existingNCC.id;
    }

    if (!finalNhaCungCapId) {
      throw new Error('Vui lòng chọn hoặc tự nhập tên Nhà Cung Cấp');
    }

    const maPN = await generateReceiptCode();

    // Tính tổng tiền
    let tongTien = 0;
    const itemsData = data.items.map((item) => {
      const thanhTien = item.slThucNhap * item.donGiaNhap;
      tongTien += thanhTien;
      return {
        hangHoaId: item.hangHoaId,
        viTriId: item.viTriId,
        slYeuCau: item.slYeuCau,
        slThucNhap: item.slThucNhap,
        donGiaNhap: item.donGiaNhap,
        thanhTien,
        ghiChu: item.ghiChu,
      };
    });

    const receipt = await prisma.phieuNhapKho.create({
      data: {
        maPN,
        khoId: data.khoId,
        nhaCungCapId: finalNhaCungCapId,
        nguoiLapId: userId,
        trangThai: TrangThaiPhieu.PENDING,
        ketQuaKiemTra: data.ketQuaKiemTra || 'Đã tiếp nhận và kiểm đếm',
        tongTien,
        ghiChu: data.ghiChu,
        chiTiet: {
          create: itemsData,
        },
      },
      include: {
        chiTiet: {
          include: {
            hangHoa: true,
            viTri: true,
          },
        },
      },
    });

    // Ghi nhật ký
    await prisma.lichSuThaoTac.create({
      data: {
        nguoiDungId: userId,
        loaiThaoTac: 'TAO_PHIEU_NHAP',
        doiTuong: 'PhieuNhapKho',
        doiTuongId: receipt.id,
        noiDung: `Lập phiếu nhập kho ${maPN} với ${data.items.length} mặt hàng, tổng tiền: ${tongTien.toLocaleString('vi-VN')} VND`,
      },
    });

    return receipt;
  }

  // 2. PHÊ DUYỆT PHIẾU NHẬP (BẮT BUỘC DÙNG DATABASE TRANSACTION)
  // Logic: Chuyển trạng thái sang APPROVED -> Tự động ghi sổ nhập kho (CỘNG TỒN KHO)
  static async approveReceipt(id: string, userId: string, ipAddress?: string) {
    const receipt = await prisma.phieuNhapKho.findUnique({
      where: { id },
      include: {
        chiTiet: {
          include: {
            hangHoa: true,
            viTri: true,
          },
        },
      },
    });

    if (!receipt) {
      throw new Error('Không tìm thấy phiếu nhập kho');
    }

    if (receipt.trangThai !== TrangThaiPhieu.PENDING) {
      throw new Error(`Phiếu nhập ${receipt.maPN} không ở trạng thái Chờ duyệt (Trạng thái hiện tại: ${receipt.trangThai})`);
    }

    // BẮT ĐẦU TRANSACTION TOÀN VẸN
    const result = await prisma.$transaction(async (tx) => {
      // a. Cập nhật trạng thái phiếu nhập sang APPROVED
      const approvedReceipt = await tx.phieuNhapKho.update({
        where: { id },
        data: {
          trangThai: TrangThaiPhieu.APPROVED,
          nguoiDuyetId: userId,
          ngayDuyet: new Date(),
        },
      });

      // b. Duyệt qua từng chi tiết hàng và cộng vào TonKho
      for (const item of receipt.chiTiet) {
        // Khóa hàng ô lưu trữ để chống Race Condition khi có nhiều phiếu nhập cùng được duyệt đồng thời
        await tx.$executeRawUnsafe(
          'SELECT id FROM vi_tri_luu_tru WHERE id = $1 FOR UPDATE',
          item.viTriId
        );

        // Kiểm tra sức chứa của ô trước khi nhập
        const viTri = await tx.viTriLuuTru.findUnique({ where: { id: item.viTriId } });
        if (!viTri) throw new Error(`Không tìm thấy vị trí ô lưu trữ`);

        const totalInSlot = await tx.tonKho.aggregate({
          where: { viTriId: item.viTriId },
          _sum: { soLuongTon: true },
        });
        const currentInSlot = totalInSlot._sum.soLuongTon || 0;
        if (currentInSlot + item.slThucNhap > viTri.sucChua) {
          throw new Error(
            `Vị trí ô "${viTri.maViTri}" có sức chứa tối đa là ${viTri.sucChua} sản phẩm (hiện đang chứa ${currentInSlot}). Không thể nhập thêm ${item.slThucNhap} sản phẩm vì sẽ vượt quá hạn mức chứa!`
          );
        }

        // Tìm bản ghi tồn kho hiện tại theo (Kho, Sản phẩm, Vị trí)
        const currentStock = await tx.tonKho.findUnique({
          where: {
            khoId_hangHoaId_viTriId: {
              khoId: receipt.khoId,
              hangHoaId: item.hangHoaId,
              viTriId: item.viTriId,
            },
          },
        });

        if (currentStock) {
          // Cộng thêm vào tồn kho thực tế và tồn khả dụng
          await tx.tonKho.update({
            where: { id: currentStock.id },
            data: {
              soLuongTon: currentStock.soLuongTon + item.slThucNhap,
              soLuongKhaDung: currentStock.soLuongKhaDung + item.slThucNhap,
            },
          });
        } else {
          // Nếu chưa có vị trí này trong sổ kho, tạo mới
          await tx.tonKho.create({
            data: {
              khoId: receipt.khoId,
              hangHoaId: item.hangHoaId,
              viTriId: item.viTriId,
              soLuongTon: item.slThucNhap,
              soLuongKhaDung: item.slThucNhap,
              soLuongTamGiu: 0,
            },
          });
        }

        // c. Cập nhật trạng thái ô lưu trữ (ViTriLuuTru)
        const totalItemsInSlot = await tx.tonKho.aggregate({
          where: { viTriId: item.viTriId },
          _sum: { soLuongTon: true },
        });
        const totalQty = totalItemsInSlot._sum.soLuongTon || 0;

        if (viTri) {
          let newStatus: TrangThaiViTri = TrangThaiViTri.PARTIAL;
          if (totalQty >= viTri.sucChua) {
            newStatus = TrangThaiViTri.FULL;
          } else if (totalQty === 0) {
            newStatus = TrangThaiViTri.EMPTY;
          }
          await tx.viTriLuuTru.update({
            where: { id: item.viTriId },
            data: { trangThai: newStatus },
          });
        }

        // d. Tự động kiểm tra và giải quyết Cảnh Báo Tồn Thấp nếu hàng đã được bổ sung
        const totalProductStock = await tx.tonKho.aggregate({
          where: { khoId: receipt.khoId, hangHoaId: item.hangHoaId },
          _sum: { soLuongTon: true },
        });
        const newProductTotal = totalProductStock._sum.soLuongTon || 0;

        if (newProductTotal >= item.hangHoa.dinhMucToiThieu) {
          // Giải tỏa các cảnh báo tồn thấp đang mở của mặt hàng này tại kho này
          await tx.canhBaoTonKho.updateMany({
            where: {
              khoId: receipt.khoId,
              hangHoaId: item.hangHoaId,
              trangThai: TrangThaiCanhBao.CHUA_XU_LY,
            },
            data: {
              trangThai: TrangThaiCanhBao.DA_XU_LY,
              ngayXuLy: new Date(),
            },
          });
        }
      }

      // e. Ghi nhật ký kiểm toán hệ thống
      await tx.lichSuThaoTac.create({
        data: {
          nguoiDungId: userId,
          loaiThaoTac: 'NHAP_KHO_DUYET',
          doiTuong: 'PhieuNhapKho',
          doiTuongId: receipt.id,
          noiDung: `Phê duyệt phiếu nhập kho ${receipt.maPN}, đã cộng tổng cộng ${receipt.chiTiet.reduce((s, c) => s + c.slThucNhap, 0)} sản phẩm vào sổ kho`,
          ipAddress: ipAddress || '127.0.0.1',
        },
      });

      return approvedReceipt;
    });

    return result;
  }

  // 3. Từ chối duyệt phiếu nhập
  static async rejectReceipt(id: string, userId: string, lyDo?: string) {
    const receipt = await prisma.phieuNhapKho.findUnique({ where: { id } });
    if (!receipt) throw new Error('Không tìm thấy phiếu nhập kho');
    if (receipt.trangThai !== TrangThaiPhieu.PENDING) {
      throw new Error('Chỉ có thể từ chối phiếu đang ở trạng thái Chờ duyệt');
    }

    const updated = await prisma.phieuNhapKho.update({
      where: { id },
      data: {
        trangThai: TrangThaiPhieu.REJECTED,
        nguoiDuyetId: userId,
        ngayDuyet: new Date(),
        ghiChu: lyDo ? `${receipt.ghiChu || ''} [Lý do từ chối: ${lyDo}]` : receipt.ghiChu,
      },
    });

    await prisma.lichSuThaoTac.create({
      data: {
        nguoiDungId: userId,
        loaiThaoTac: 'TU_CHOI_NHAP_KHO',
        doiTuong: 'PhieuNhapKho',
        doiTuongId: id,
        noiDung: `Từ chối phiếu nhập kho ${receipt.maPN}. Lý do: ${lyDo || 'Không có lý do cụ thể'}`,
      },
    });

    return updated;
  }
}
