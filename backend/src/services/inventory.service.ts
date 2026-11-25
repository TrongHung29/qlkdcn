import prisma from '../config/prisma';
import { TrangThaiCanhBao, TrangThaiPhieu, TrangThaiViTri, LoaiCanhBao } from '@prisma/client';

export class InventoryService {
  // 1. Tra cứu tồn kho chi tiết (theo Kho, Sản phẩm, Vị trí)
  static async getInventory(query: { khoId?: string; hangHoaId?: string; viTriId?: string; search?: string }) {
    const where: any = {};
    if (query.khoId) where.khoId = query.khoId;
    if (query.hangHoaId) where.hangHoaId = query.hangHoaId;
    if (query.viTriId) where.viTriId = query.viTriId;

    if (query.search) {
      where.OR = [
        { hangHoa: { tenHH: { contains: query.search, mode: 'insensitive' } } },
        { hangHoa: { maHH: { contains: query.search, mode: 'insensitive' } } },
        { viTri: { maViTri: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    return prisma.tonKho.findMany({
      where,
      include: {
        kho: true,
        hangHoa: {
          include: { loaiHang: true, nhaCungCap: true },
        },
        viTri: {
          include: { khuVuc: true },
        },
      },
      orderBy: [{ kho: { maKho: 'asc' } }, { hangHoa: { maHH: 'asc' } }],
    });
  }

  // 2. Thống kê tổng quan Dashboard nhà quản lý (Mục tiêu 6 trong Báo cáo)
  static async getDashboardStats() {
    // a. Tổng số mặt hàng
    const totalProducts = await prisma.hangHoa.count({ where: { trangThai: true } });

    // b. Tổng số kho
    const totalWarehouses = await prisma.kho.count({ where: { trangThai: true } });

    // c. Tổng số lượng và giá trị tồn kho
    const allStock = await prisma.tonKho.findMany({
      include: { hangHoa: true },
    });

    const totalStockQty = allStock.reduce((sum, item) => sum + item.soLuongTon, 0);
    const totalStockValue = allStock.reduce((sum, item) => sum + item.soLuongTon * Number(item.hangHoa.giaNhap), 0);

    // d. Cảnh báo tồn kho đang mở
    const pendingAlerts = await prisma.canhBaoTonKho.findMany({
      where: { trangThai: TrangThaiCanhBao.CHUA_XU_LY },
      include: {
        kho: true,
        hangHoa: true,
      },
      orderBy: { ngayTao: 'desc' },
    });

    // e. Số phiếu nhập / xuất đang chờ duyệt
    const pendingReceipts = await prisma.phieuNhapKho.count({
      where: { trangThai: TrangThaiPhieu.PENDING },
    });
    const pendingDispatches = await prisma.phieuXuatKho.count({
      where: { trangThai: TrangThaiPhieu.PENDING },
    });

    // f. Giao dịch gần nhất
    const recentReceipts = await prisma.phieuNhapKho.findMany({
      take: 5,
      orderBy: { ngayTao: 'desc' },
      include: { nhaCungCap: true, kho: true },
    });

    const recentDispatches = await prisma.phieuXuatKho.findMany({
      take: 5,
      orderBy: { ngayTao: 'desc' },
      include: { khachHang: true, kho: true },
    });

    return {
      overview: {
        totalProducts,
        totalWarehouses,
        totalStockQty,
        totalStockValue,
        alertCount: pendingAlerts.length,
        pendingReceipts,
        pendingDispatches,
      },
      alerts: pendingAlerts,
      recentTransactions: {
        receipts: recentReceipts,
        dispatches: recentDispatches,
      },
    };
  }

  // 3. Quản lý cảnh báo tồn kho
  static async getAlerts(khoId?: string) {
    const where: any = {};
    if (khoId) where.khoId = khoId;

    return prisma.canhBaoTonKho.findMany({
      where,
      include: {
        kho: true,
        hangHoa: {
          include: { loaiHang: true },
        },
      },
      orderBy: [{ trangThai: 'asc' }, { ngayTao: 'desc' }],
    });
  }

  static async resolveAlert(id: string) {
    return prisma.canhBaoTonKho.update({
      where: { id },
      data: {
        trangThai: TrangThaiCanhBao.DA_XU_LY,
        ngayXuLy: new Date(),
      },
    });
  }

  // 4. Lịch sử thao tác hệ thống (Audit Logs)
  static async getAuditLogs(limit = 50) {
    return prisma.lichSuThaoTac.findMany({
      take: limit,
      include: {
        nguoiDung: {
          select: { id: true, maNV: true, hoTen: true, role: true },
        },
      },
      orderBy: { thoiGian: 'desc' },
    });
  }

  // 5. Điều chỉnh tồn kho thủ công (Manual Stock Adjustment)
  static async adjustStock(
    data: {
      hangHoaId: string;
      viTriId?: string;
      khoId?: string;
      soLuongMoi: number;
      lyDo: string;
      dieuChinhTongTon?: boolean;
    },
    userId: string,
    ipAddress?: string
  ) {
    if (data.soLuongMoi < 0) {
      throw new Error('Số lượng tồn kho mới không thể âm');
    }

    const hangHoa = await prisma.hangHoa.findUnique({
      where: { id: data.hangHoaId },
      include: { tonKho: true },
    });
    if (!hangHoa) throw new Error('Không tìm thấy thông tin hàng hóa');

    // Xác định kho
    let khoId = data.khoId;
    if (!khoId) {
      const defaultKho = await prisma.kho.findFirst({ where: { trangThai: true } });
      if (!defaultKho) throw new Error('Không tìm thấy kho hoạt động trong hệ thống');
      khoId = defaultKho.id;
    }

    // Xác định vị trí ô lưu trữ
    let viTriId = data.viTriId;
    if (!viTriId) {
      const existingStock = hangHoa.tonKho.find((t) => t.khoId === khoId);
      if (existingStock) {
        viTriId = existingStock.viTriId;
      } else {
        const firstSlot = await prisma.viTriLuuTru.findFirst({ where: { khoId } });
        if (!firstSlot) throw new Error('Chưa có vị trí lưu trữ nào trong kho');
        viTriId = firstSlot.id;
      }
    }

    const viTri = await prisma.viTriLuuTru.findUnique({ where: { id: viTriId } });
    if (!viTri) throw new Error('Vị trí lưu trữ không hợp lệ');

    // Kiểm tra ràng buộc sức chứa tối đa của ô lưu trữ
    const otherInSlot = await prisma.tonKho.aggregate({
      where: {
        viTriId,
        hangHoaId: { not: data.hangHoaId },
      },
      _sum: { soLuongTon: true },
    });
    const otherQty = otherInSlot._sum.soLuongTon || 0;
    const maxCapacity = viTri.sucChua - otherQty;

    if (data.soLuongMoi > maxCapacity) {
      throw new Error(
        `Vị trí ô "${viTri.maViTri}" có hạn mức sức chứa tối đa là ${viTri.sucChua} sản phẩm${otherQty > 0 ? ` (hiện đã chứa ${otherQty} sản phẩm khác)` : ''}. Không thể lưu trữ quá ${maxCapacity} sản phẩm!`
      );
    }

    // Thực hiện điều chỉnh trong Transaction
    const result = await prisma.$transaction(async (tx) => {
      const currentStock = await tx.tonKho.findUnique({
        where: {
          khoId_hangHoaId_viTriId: {
            khoId,
            hangHoaId: data.hangHoaId,
            viTriId,
          },
        },
      });

      const soLuongCu = currentStock ? currentStock.soLuongTon : 0;
      const chenhLech = data.soLuongMoi - soLuongCu;

      let updatedStock;
      if (currentStock) {
        // Đảm bảo Invariant: Tồn thực tế mới không được nhỏ hơn lượng hàng đang bị tạm giữ bởi các phiếu xuất/chuyển chờ duyệt
        if (data.soLuongMoi < currentStock.soLuongTamGiu) {
          throw new Error(
            `Không thể điều chỉnh tồn kho xuống ${data.soLuongMoi} vì đang có ${currentStock.soLuongTamGiu} sản phẩm bị tạm giữ bởi các phiếu chờ duyệt! Vui lòng từ chối hoặc xử lý các phiếu chờ duyệt trước khi giảm tồn.`
          );
        }

        updatedStock = await tx.tonKho.update({
          where: { id: currentStock.id },
          data: {
            soLuongTon: data.soLuongMoi,
            soLuongKhaDung: data.soLuongMoi - currentStock.soLuongTamGiu,
          },
        });
      } else {
        updatedStock = await tx.tonKho.create({
          data: {
            khoId,
            hangHoaId: data.hangHoaId,
            viTriId,
            soLuongTon: data.soLuongMoi,
            soLuongKhaDung: data.soLuongMoi,
            soLuongTamGiu: 0,
          },
        });
      }

      // Nếu điều chỉnh cho Tổng Tồn Kho của mặt hàng: Đưa các ô lưu trữ khác về 0
      if (data.dieuChinhTongTon) {
        const otherStocks = await tx.tonKho.findMany({
          where: {
            hangHoaId: data.hangHoaId,
            khoId,
            viTriId: { not: viTriId },
          },
        });
        for (const other of otherStocks) {
          // Không được đưa ô khác về 0 khi vẫn có hàng đang giữ chỗ, nếu không
          // soLuongKhaDung = soLuongTon - soLuongTamGiu sẽ bị âm.
          if (other.soLuongTamGiu > 0) {
            throw new Error(
              `Không thể gom tồn về ô này vì ô ${other.viTriId} đang giữ ${other.soLuongTamGiu} sản phẩm cho phiếu chờ duyệt`
            );
          }
          await tx.tonKho.update({
            where: { id: other.id },
            data: { soLuongTon: 0, soLuongKhaDung: 0, soLuongTamGiu: 0 },
          });
          const otherTotal = await tx.tonKho.aggregate({
            where: { viTriId: other.viTriId },
            _sum: { soLuongTon: true },
          });
          const sum = otherTotal._sum.soLuongTon || 0;
          await tx.viTriLuuTru.update({
            where: { id: other.viTriId },
            data: { trangThai: sum === 0 ? TrangThaiViTri.EMPTY : TrangThaiViTri.PARTIAL },
          });
        }
      }

      // Cập nhật trạng thái ô lưu trữ
      const totalInSlot = await tx.tonKho.aggregate({
        where: { viTriId },
        _sum: { soLuongTon: true },
      });
      const currentSlotTotal = totalInSlot._sum.soLuongTon || 0;
      let newStatus: TrangThaiViTri = TrangThaiViTri.PARTIAL;
      if (currentSlotTotal === 0) newStatus = TrangThaiViTri.EMPTY;
      else if (currentSlotTotal >= viTri.sucChua) newStatus = TrangThaiViTri.FULL;

      await tx.viTriLuuTru.update({
        where: { id: viTriId },
        data: { trangThai: newStatus },
      });

      // Kiểm tra và sinh / giải tỏa cảnh báo tồn kho
      const totalWarehouseStock = await tx.tonKho.aggregate({
        where: { khoId, hangHoaId: data.hangHoaId },
        _sum: { soLuongTon: true },
      });
      const totalStock = totalWarehouseStock._sum.soLuongTon || 0;

      if (totalStock === 0) {
        await tx.canhBaoTonKho.create({
          data: {
            khoId,
            hangHoaId: data.hangHoaId,
            loaiCanhBao: LoaiCanhBao.HET_HANG,
            mucTonHienTai: 0,
            mucTonToiThieu: hangHoa.dinhMucToiThieu,
            mucTonToiDa: hangHoa.dinhMucToiDa,
            noiDung: `Hàng hóa "${hangHoa.tenHH}" đã HẾT HÀNG (Tồn = 0) sau điều chỉnh thủ công`,
          },
        });
      } else if (totalStock < hangHoa.dinhMucToiThieu) {
        await tx.canhBaoTonKho.create({
          data: {
            khoId,
            hangHoaId: data.hangHoaId,
            loaiCanhBao: LoaiCanhBao.DUOI_MUC_TOI_THIEU,
            mucTonHienTai: totalStock,
            mucTonToiThieu: hangHoa.dinhMucToiThieu,
            mucTonToiDa: hangHoa.dinhMucToiDa,
            noiDung: `Hàng hóa "${hangHoa.tenHH}" tồn kho ${totalStock} ${hangHoa.donViTinh}, dưới mức tối thiểu (${hangHoa.dinhMucToiThieu})`,
          },
        });
      } else {
        // Nếu tồn mới >= định mức tối thiểu, tự động giải tỏa cảnh báo
        await tx.canhBaoTonKho.updateMany({
          where: {
            khoId,
            hangHoaId: data.hangHoaId,
            trangThai: TrangThaiCanhBao.CHUA_XU_LY,
          },
          data: {
            trangThai: TrangThaiCanhBao.DA_XU_LY,
            ngayXuLy: new Date(),
          },
        });
      }

      // Ghi nhật ký kiểm toán (Audit Trail)
      await tx.lichSuThaoTac.create({
        data: {
          nguoiDungId: userId,
          loaiThaoTac: 'DIEU_CHINH_TON_KHO',
          doiTuong: 'HangHoa',
          doiTuongId: data.hangHoaId,
          noiDung: `Điều chỉnh thủ công tồn kho mặt hàng "${hangHoa.tenHH}" tại ô ${viTri.maViTri}: từ ${soLuongCu} thành ${data.soLuongMoi} (${chenhLech >= 0 ? '+' : ''}${chenhLech} ${hangHoa.donViTinh}). Lý do: ${data.lyDo || 'Điều chỉnh kiểm kê'}`,
          duLieuThayDoi: {
            soLuongCu,
            soLuongMoi: data.soLuongMoi,
            chenhLech,
            viTri: viTri.maViTri,
            lyDo: data.lyDo,
          },
          ipAddress: ipAddress || '127.0.0.1',
        },
      });

      return {
        hangHoaId: data.hangHoaId,
        viTriId,
        soLuongCu,
        soLuongMoi: data.soLuongMoi,
        chenhLech,
        updatedStock,
      };
    });

    return result;
  }
}

