export type Role = 'ADMIN' | 'QUAN_LY_KHO' | 'NHAN_VIEN_KHO' | 'NHAN_VIEN_MUA_HANG' | 'NHAN_VIEN_BAN_HANG';
export type TrangThaiPhieu = 'PENDING' | 'APPROVED' | 'REJECTED';
export type TrangThaiViTri = 'EMPTY' | 'PARTIAL' | 'FULL' | 'MAINTENANCE';
export type LoaiCanhBao = 'HET_HANG' | 'DUOI_MUC_TOI_THIEU' | 'VUOT_MUC_TOI_DA' | 'CHENH_LECH_KIEM_KE';

export interface User {
  id: string;
  maNV: string;
  username: string;
  hoTen: string;
  email?: string;
  sdt?: string;
  role: Role;
  trangThai?: 'ACTIVE' | 'INACTIVE';
  ngayTao?: string;
  warehouseIds?: string[];
  warehouseCodes?: string[];
}

export interface LoaiHang {
  id: string;
  maLoai: string;
  tenLoai: string;
  moTa?: string;
}

export interface NhaCungCap {
  id: string;
  maNCC: string;
  tenNCC: string;
  sdt: string;
  diaChi?: string;
  nguoiLienHe?: string;
}

export interface KhachHang {
  id: string;
  maKH: string;
  tenKH: string;
  sdt: string;
  diaChi?: string;
}

export interface Product {
  id: string;
  maHH: string;
  tenHH: string;
  donViTinh: string;
  giaNhap: number;
  giaXuat: number;
  dinhMucToiThieu: number;
  dinhMucToiDa: number;
  loaiHangId: string;
  nhaCungCapId?: string;
  moTa?: string;
  tongTon: number;
  tongKhaDung: number;
  loaiHang?: LoaiHang;
  nhaCungCap?: NhaCungCap;
  canhBao?: {
    isUnderMin: boolean;
    isOverMax: boolean;
    isOutOfStock: boolean;
  };
  tonKho?: TonKhoItem[];
}

export interface Kho {
  id: string;
  maKho: string;
  tenKho: string;
  diaChi: string;
}

export interface KhuVuc {
  id: string;
  maKhuVuc: string;
  tenKhuVuc: string;
  khoId: string;
}

export interface ViTriLuuTru {
  id: string;
  maViTri: string;
  khoId: string;
  khuVucId: string;
  ke: string;
  tang: string;
  o: string;
  sucChua: number;
  trangThai: TrangThaiViTri;
  currentStoredQty?: number;
  occupancyRate?: number;
  kho?: Kho;
  khuVuc?: KhuVuc;
  tonKho?: {
    id: string;
    hangHoaId: string;
    soLuongTon: number;
    hangHoa: Product;
  }[];
}

export interface TonKhoItem {
  id: string;
  khoId: string;
  hangHoaId: string;
  viTriId: string;
  soLuongTon: number;
  soLuongKhaDung: number;
  soLuongTamGiu: number;
  kho: Kho;
  hangHoa: Product;
  viTri: ViTriLuuTru;
}

export interface ReceiptItem {
  id?: string;
  hangHoaId: string;
  viTriId: string;
  slYeuCau: number;
  slThucNhap: number;
  donGiaNhap: number;
  thanhTien?: number;
  hangHoa?: Product;
  viTri?: ViTriLuuTru;
}

export interface Receipt {
  id: string;
  maPN: string;
  ngayNhap: string;
  khoId: string;
  nhaCungCapId: string;
  nguoiLapId: string;
  nguoiDuyetId?: string;
  ngayDuyet?: string;
  trangThai: TrangThaiPhieu;
  ketQuaKiemTra?: string;
  tongTien: number;
  ghiChu?: string;
  kho: Kho;
  nhaCungCap: NhaCungCap;
  nguoiLap: User;
  nguoiDuyet?: User;
  chiTiet: ReceiptItem[];
}

export interface DispatchItem {
  id?: string;
  hangHoaId: string;
  viTriId: string;
  slYeuCau: number;
  slThucXuat: number;
  donGiaXuat: number;
  thanhTien?: number;
  hangHoa?: Product;
  viTri?: ViTriLuuTru;
}

export interface Dispatch {
  id: string;
  maPX: string;
  ngayXuat: string;
  khoId: string;
  khachHangId: string;
  nguoiLapId: string;
  nguoiDuyetId?: string;
  ngayDuyet?: string;
  trangThai: TrangThaiPhieu;
  lyDoXuat: string;
  tongTien: number;
  ghiChu?: string;
  kho: Kho;
  khachHang: KhachHang;
  nguoiLap: User;
  nguoiDuyet?: User;
  chiTiet: DispatchItem[];
}

export interface CanhBao {
  id: string;
  khoId: string;
  hangHoaId: string;
  loaiCanhBao: LoaiCanhBao;
  mucTonHienTai: number;
  mucTonToiThieu: number;
  mucTonToiDa: number;
  trangThai: 'CHUA_XU_LY' | 'DA_XU_LY';
  noiDung: string;
  ngayTao: string;
  kho: Kho;
  hangHoa: Product;
}

export interface DashboardStats {
  overview: {
    totalProducts: number;
    totalWarehouses: number;
    totalStockQty: number;
    totalStockValue: number;
    alertCount: number;
    pendingReceipts: number;
    pendingDispatches: number;
  };
  alerts: CanhBao[];
  recentTransactions: {
    receipts: Receipt[];
    dispatches: Dispatch[];
  };
}

export interface NotificationItem {
  id: string;
  type: 'DISPATCH_APPROVED' | 'DISPATCH_REJECTED' | 'DISPATCH_PENDING' | 'RECEIPT_APPROVED' | 'RECEIPT_REJECTED' | 'RECEIPT_PENDING';
  title: string;
  message: string;
  targetTab: 'dispatches' | 'receipts';
  targetId: string;
  targetCode: string;
  status: string;
  createdAt: string;
  actor?: string;
}

// ==========================================
// ĐỊNH NGHĨA KIỂU CỤM DATABASE DỰ PHÒNG (HA)
// ==========================================
export type NodeRole = 'PRIMARY' | 'STANDBY_REPLICA';
export type NodeStatus = 'ONLINE' | 'STANDBY_READY' | 'DEGRADED' | 'OFFLINE';
export type ClusterMode = 'NORMAL' | 'SIMULATED_FAILOVER' | 'FAILOVER_ACTIVE';

export interface DatabaseNodeInfo {
  id: string;
  name: string;
  role: NodeRole;
  host: string;
  port: number;
  database: string;
  status: NodeStatus;
  latencyMs: number;
  isWriteAllowed: boolean;
  isReadAllowed: boolean;
  totalConnections: number;
  version?: string;
  lastHeartbeat: string;
  error?: string | null;
}

export interface ReplicationStats {
  status: 'SYNCHRONIZED' | 'SYNCING' | 'BEHIND' | 'DISCONNECTED';
  replicationLagMs: number;
  lastSyncTime: string;
  syncMethod: string;
  monitoredTables: string[];
  replicatedRecordsCount: number;
}

export interface FailoverEvent {
  id: string;
  timestamp: string;
  type: 'SIMULATION_STARTED' | 'SIMULATION_STOPPED' | 'FAILOVER_TRIGGERED' | 'PRIMARY_RECOVERED' | 'MANUAL_SYNC';
  description: string;
  fromNode: string;
  toNode: string;
}

export interface ClusterState {
  mode: ClusterMode;
  activeNodeForWrite: string;
  activeNodeForRead: string;
  actualWriteTarget?: string;
  failoverNote?: string;
  readWriteSplittingEnabled: boolean;
  primary: DatabaseNodeInfo;
  standby: DatabaseNodeInfo;
  replication: ReplicationStats;
  failoverHistory: FailoverEvent[];
}


