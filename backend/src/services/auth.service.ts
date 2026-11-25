import prisma from '../config/prisma';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { Prisma, Role, UserStatus } from '@prisma/client';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_wms_team8_2026';

export class AuthService {
  /**
   * Phạm vi kho được nhúng vào JWT: Admin thấy tất cả, các role khác chỉ thấy
   * kho được gán qua bảng `user_warehouses` hoặc kho mà họ quản lý trực tiếp.
   */
  private static async getWarehouseScopes(userId: string, role: Role) {
    let assignedIds: string[] = [];
    try {
      const rows = await prisma.$queryRaw<Array<{ warehouse_id: string }>>(
        Prisma.sql`SELECT warehouse_id FROM user_warehouses WHERE user_id = ${userId}`
      );
      assignedIds = rows.map((row) => row.warehouse_id);
    } catch {
      // Bảng chưa được migrate -> vẫn dùng quan hệ nguoiQuanLyId làm fallback.
      assignedIds = [];
    }

    const warehouses = await prisma.kho.findMany({
      where:
        role === Role.ADMIN
          ? {}
          : {
              OR: [
                { nguoiQuanLyId: userId },
                { id: { in: assignedIds } },
              ],
            },
      select: { id: true, maKho: true },
    });

    return {
      warehouseIds: warehouses.map((warehouse) => warehouse.id),
      warehouseCodes: warehouses.map((warehouse) => warehouse.maKho),
    };
  }

  static async login(username: string, pass: string, ipAddress?: string) {
    const user = await prisma.user.findUnique({
      where: { username },
    });

    if (!user) {
      throw new Error('Tài khoản hoặc mật khẩu không chính xác');
    }

    if (user.trangThai !== UserStatus.ACTIVE) {
      throw new Error('Tài khoản này hiện đang bị khóa hoặc ngừng kích hoạt');
    }

    const isMatch = bcrypt.compareSync(pass, user.password);
    if (!isMatch) {
      throw new Error('Tài khoản hoặc mật khẩu không chính xác');
    }

    const scopes = await this.getWarehouseScopes(user.id, user.role);

    // Tạo JWT Token (có phạm vi kho)
    const tokenPayload = {
      id: user.id,
      maNV: user.maNV,
      username: user.username,
      hoTen: user.hoTen,
      role: user.role,
      ...scopes,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, {
      expiresIn: '7d',
    });

    // Ghi log đăng nhập
    await prisma.lichSuThaoTac.create({
      data: {
        nguoiDungId: user.id,
        loaiThaoTac: 'LOGIN',
        doiTuong: 'USER',
        doiTuongId: user.id,
        noiDung: `Người dùng ${user.hoTen} (${user.username}) đăng nhập hệ thống thành công`,
        ipAddress: ipAddress || '127.0.0.1',
      },
    });

    return {
      token,
      user: {
        id: user.id,
        maNV: user.maNV,
        username: user.username,
        hoTen: user.hoTen,
        email: user.email,
        sdt: user.sdt,
        role: user.role,
        ...scopes,
      },
    };
  }

  static async register(data: {
    username: string;
    password: string;
    hoTen: string;
    email?: string;
    sdt?: string;
    role?: any;
    maNV?: string;
  }, ipAddress?: string) {
    if (!data.username || !data.password || !data.hoTen) {
      throw new Error('Vui lòng nhập đầy đủ tên đăng nhập, mật khẩu và họ tên');
    }

    if (data.password.length < 6) {
      throw new Error('Mật khẩu phải có độ dài từ 6 ký tự trở lên');
    }

    // Tự sinh mã nhân viên nếu chưa có
    let maNV = data.maNV?.trim();
    if (!maNV) {
      const count = await prisma.user.count();
      const randomSuffix = Math.floor(100 + Math.random() * 900);
      maNV = `NV${count + 1}${randomSuffix}`;
    }

    const assignedRole = data.role || 'NHAN_VIEN_KHO';

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { username: data.username },
          { maNV: maNV },
          ...(data.email ? [{ email: data.email }] : [])
        ]
      }
    });

    if (existing) {
      if (existing.username === data.username) throw new Error(`Tên đăng nhập "${data.username}" đã tồn tại`);
      if (existing.maNV === maNV) throw new Error(`Mã nhân viên "${maNV}" đã tồn tại`);
      if (data.email && existing.email === data.email) throw new Error(`Email "${data.email}" đã được đăng ký`);
    }

    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(data.password, salt);

    const newUser = await prisma.user.create({
      data: {
        maNV,
        username: data.username,
        password: hashedPassword,
        hoTen: data.hoTen,
        email: data.email || null,
        sdt: data.sdt || null,
        role: assignedRole,
        trangThai: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        maNV: true,
        username: true,
        hoTen: true,
        email: true,
        sdt: true,
        role: true,
        trangThai: true,
        ngayTao: true,
      }
    });

    // Ghi log đăng ký
    await prisma.lichSuThaoTac.create({
      data: {
        nguoiDungId: newUser.id,
        loaiThaoTac: 'REGISTER',
        doiTuong: 'USER',
        doiTuongId: newUser.id,
        noiDung: `Người dùng ${newUser.hoTen} (${newUser.username}) đăng ký tài khoản thành công với vai trò ${newUser.role}`,
        ipAddress: ipAddress || '127.0.0.1',
      }
    });

    // Tạo JWT Token tự động để đăng nhập ngay sau đăng ký
    const scopes = await this.getWarehouseScopes(newUser.id, newUser.role as Role);
    const tokenPayload = {
      id: newUser.id,
      maNV: newUser.maNV,
      username: newUser.username,
      hoTen: newUser.hoTen,
      role: newUser.role,
      ...scopes,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, {
      expiresIn: '7d',
    });

    return {
      token,
      user: { ...newUser, ...scopes },
    };
  }

  static async getProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        maNV: true,
        username: true,
        hoTen: true,
        email: true,
        sdt: true,
        role: true,
        trangThai: true,
        ngayTao: true,
      },
    });

    if (!user) {
      throw new Error('Không tìm thấy thông tin người dùng');
    }

    const scopes = await this.getWarehouseScopes(user.id, user.role);
    return { ...user, ...scopes };
  }

  static async getAllUsers() {
    return prisma.user.findMany({
      select: {
        id: true,
        maNV: true,
        username: true,
        hoTen: true,
        email: true,
        sdt: true,
        role: true,
        trangThai: true,
        ngayTao: true,
      },
      orderBy: { ngayTao: 'asc' },
    });
  }

  static async createUser(data: {
    maNV: string;
    username: string;
    password: string;
    hoTen: string;
    email?: string;
    sdt?: string;
    role: any;
  }, adminId: string) {
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { username: data.username },
          { maNV: data.maNV },
          ...(data.email ? [{ email: data.email }] : [])
        ]
      }
    });

    if (existing) {
      if (existing.username === data.username) throw new Error(`Tên đăng nhập "${data.username}" đã tồn tại`);
      if (existing.maNV === data.maNV) throw new Error(`Mã nhân viên "${data.maNV}" đã tồn tại`);
      if (data.email && existing.email === data.email) throw new Error(`Email "${data.email}" đã được đăng ký`);
    }

    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(data.password, salt);

    const newUser = await prisma.user.create({
      data: {
        maNV: data.maNV,
        username: data.username,
        password: hashedPassword,
        hoTen: data.hoTen,
        email: data.email || null,
        sdt: data.sdt || null,
        role: data.role,
        trangThai: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        maNV: true,
        username: true,
        hoTen: true,
        email: true,
        sdt: true,
        role: true,
        trangThai: true,
        ngayTao: true,
      }
    });

    await prisma.lichSuThaoTac.create({
      data: {
        nguoiDungId: adminId,
        loaiThaoTac: 'THEM_NGUOI_DUNG',
        doiTuong: 'USER',
        doiTuongId: newUser.id,
        noiDung: `Thêm nhân viên mới ${newUser.hoTen} (${newUser.maNV}) với vai trò ${newUser.role}`,
      }
    });

    return newUser;
  }

  static async toggleUserStatus(userId: string, adminId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('Không tìm thấy người dùng');
    if (user.id === adminId) throw new Error('Không thể tự khóa tài khoản của chính mình');

    const newStatus = user.trangThai === UserStatus.ACTIVE ? UserStatus.INACTIVE : UserStatus.ACTIVE;
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { trangThai: newStatus },
      select: {
        id: true,
        maNV: true,
        username: true,
        hoTen: true,
        role: true,
        trangThai: true,
      }
    });

    await prisma.lichSuThaoTac.create({
      data: {
        nguoiDungId: adminId,
        loaiThaoTac: 'DOI_TRANG_THAI_USER',
        doiTuong: 'USER',
        doiTuongId: user.id,
        noiDung: `${newStatus === UserStatus.ACTIVE ? 'Mở khóa' : 'Khóa'} tài khoản ${user.hoTen} (${user.username})`,
      }
    });

    return updated;
  }
}

