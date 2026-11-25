import prisma from '../config/prisma';
import { multiSourceManager } from '../cluster/multi-source.manager';

export class ProductService {
  static async getAllProducts(query: { search?: string; loaiHangId?: string; nhaCungCapId?: string }) {
    const where: any = { trangThai: true };

    if (query.search) {
      where.OR = [
        { maHH: { contains: query.search, mode: 'insensitive' } },
        { tenHH: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.loaiHangId) {
      where.loaiHangId = query.loaiHangId;
    }

    if (query.nhaCungCapId) {
      where.nhaCungCapId = query.nhaCungCapId;
    }

    const products = await prisma.hangHoa.findMany({
      where,
      include: {
        loaiHang: true,
        nhaCungCap: true,
        tonKho: {
          include: {
            kho: true,
            viTri: true,
          },
        },
      },
      orderBy: { ngayTao: 'desc' },
    });

    // Tính toán tổng tồn kho thực tế và khả dụng cho từng sản phẩm
    return products.map((p) => {
      const tongTon = p.tonKho.reduce((sum, item) => sum + item.soLuongTon, 0);
      const tongKhaDung = p.tonKho.reduce((sum, item) => sum + item.soLuongKhaDung, 0);
      const isUnderMin = tongTon < p.dinhMucToiThieu;
      const isOverMax = tongTon > p.dinhMucToiDa;

      return {
        ...p,
        tongTon,
        tongKhaDung,
        canhBao: {
          isUnderMin,
          isOverMax,
          isOutOfStock: tongTon === 0,
        },
      };
    });
  }

  static async getProductById(id: string) {
    const product = await prisma.hangHoa.findUnique({
      where: { id },
      include: {
        loaiHang: true,
        nhaCungCap: true,
        tonKho: {
          include: {
            kho: true,
            viTri: true,
          },
        },
      },
    });

    if (!product) {
      throw new Error('Không tìm thấy sản phẩm');
    }

    const tongTon = product.tonKho.reduce((sum, item) => sum + item.soLuongTon, 0);
    const tongKhaDung = product.tonKho.reduce((sum, item) => sum + item.soLuongKhaDung, 0);

    return {
      ...product,
      tongTon,
      tongKhaDung,
    };
  }

  static async createProduct(data: {
    maHH: string;
    tenHH: string;
    donViTinh: string;
    giaNhap: number;
    giaXuat: number;
    dinhMucToiThieu?: number;
    dinhMucToiDa?: number;
    loaiHangId: string;
    nhaCungCapId?: string;
    moTa?: string;
  }) {
    // Kiểm tra trùng mã
    const existing = await prisma.hangHoa.findUnique({
      where: { maHH: data.maHH },
    });
    if (existing) {
      throw new Error(`Mã hàng hóa "${data.maHH}" đã tồn tại trên hệ thống`);
    }

    const created = await prisma.hangHoa.create({
      data: {
        maHH: data.maHH,
        tenHH: data.tenHH,
        donViTinh: data.donViTinh,
        giaNhap: data.giaNhap,
        giaXuat: data.giaXuat,
        dinhMucToiThieu: data.dinhMucToiThieu ?? 10,
        dinhMucToiDa: data.dinhMucToiDa ?? 1000,
        loaiHangId: data.loaiHangId,
        nhaCungCapId: data.nhaCungCapId,
        moTa: data.moTa,
      },
      include: {
        loaiHang: true,
        nhaCungCap: true,
      },
    });

    // Phát tán ghi Master Data sang Đa Nguồn (North, South, Replica) đồng thời
    multiSourceManager.broadcastMasterData('PRODUCT', created).catch(() => {});

    return created;
  }

  static async updateProduct(id: string, data: any) {
    return prisma.hangHoa.update({
      where: { id },
      data,
      include: {
        loaiHang: true,
        nhaCungCap: true,
      },
    });
  }

  static async deleteProduct(id: string) {
    // Soft delete: chuyển trạng thái sang ngưng kinh doanh
    return prisma.hangHoa.update({
      where: { id },
      data: { trangThai: false },
    });
  }

  // Master Data: Danh mục
  static async getAllCategories() {
    return prisma.loaiHang.findMany({
      include: {
        _count: {
          select: { hangHoa: true },
        },
      },
      orderBy: { maLoai: 'asc' },
    });
  }

  // Master Data: Nhà cung cấp
  static async getAllSuppliers() {
    return prisma.nhaCungCap.findMany({
      where: { trangThai: true },
      orderBy: { maNCC: 'asc' },
    });
  }

  // Master Data: Khách hàng
  static async getAllCustomers() {
    return prisma.khachHang.findMany({
      where: { trangThai: true },
      orderBy: { maKH: 'asc' },
    });
  }
}

