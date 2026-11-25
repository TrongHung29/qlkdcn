import React, { useState, useEffect } from 'react';
import { ClusterState } from '../types';
import {
  Server,
  Database,
  ArrowRight,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  Zap,
  Activity,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Clock,
  ArrowLeftRight,
  Layers,
  Share2,
  HardDrive
} from 'lucide-react';
import api from '../api/client';

export interface MultiSourceNode {
  id: string;
  name: string;
  role: string;
  port: number;
  region: string;
  status: 'ONLINE' | 'STANDBY_READY' | 'OFFLINE';
  storageScope: string;
  totalRecords: number;
}

export interface MultiSourceTableStat {
  table: string;
  tableNameVi: string;
  primaryNorthCount: number;
  shardSouthCount: number;
  replicaCount: number;
  distributionType: 'REPLICATED_FULL' | 'SHARDED_BY_WAREHOUSE' | 'HOT_STANDBY_MIRROR';
  status: 'SYNCHRONIZED' | 'PARTITIONED' | 'SYNCING';
}

export interface MultiSourceDistributionOverview {
  totalNodes: number;
  activeNodes: number;
  strategy: string;
  nodes: MultiSourceNode[];
  tableStats: MultiSourceTableStat[];
  lastDistributedSync: string;
}

interface ClusterViewProps {
  clusterState: ClusterState | null;
  onRefresh: () => Promise<void>;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const ClusterView: React.FC<ClusterViewProps> = ({
  clusterState,
  onRefresh,
  showToast,
}) => {
  const [loading, setLoading] = useState(false);
  const [routingTestResult, setRoutingTestResult] = useState<any | null>(null);
  const [showTheory, setShowTheory] = useState(false);

  // Lưu trữ Đa Nguồn Phân Tán (Multi-Source Distributed Storage)
  const [multiSourceData, setMultiSourceData] = useState<MultiSourceDistributionOverview | null>(null);
  const [multiSourceLoading, setMultiSourceLoading] = useState(false);
  const [writeTestResult, setWriteTestResult] = useState<any | null>(null);

  const fetchMultiSourceStats = async () => {
    try {
      setMultiSourceLoading(true);
      const res = await api.get('/cluster/multi-source/stats');
      setMultiSourceData(res.data.data);
    } catch (err: any) {
      console.error('Lỗi lấy thống kê đa nguồn:', err);
    } finally {
      setMultiSourceLoading(false);
    }
  };

  useEffect(() => {
    fetchMultiSourceStats();
  }, []);

  if (!clusterState) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="flex flex-col items-center gap-3 text-slate-500">
          <RefreshCw className="w-8 h-8 animate-spin text-red-600" />
          <p className="text-sm">Đang tải trạng thái Cụm Database Phân Tán...</p>
        </div>
      </div>
    );
  }

  const isFailover = clusterState.mode === 'SIMULATED_FAILOVER';

  // Kích hoạt / Tắt mô phỏng Failover
  const handleToggleFailover = async (active: boolean) => {
    try {
      setLoading(true);
      const res = await api.post('/cluster/failover/simulate', {
        active,
        reason: active
          ? 'Mô phỏng sự cố mất điện/đứt cáp mạng tại Node chính (Port 5432)'
          : undefined,
      });
      showToast(res.data.message, active ? 'error' : 'success');
      await onRefresh();
    } catch (err: any) {
      showToast(err.response?.data?.message || err.message || 'Lỗi thao tác failover', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Đồng bộ hóa thủ công
  const handleSyncNow = async () => {
    try {
      setLoading(true);
      const res = await api.post('/cluster/sync');
      showToast(res.data.message, 'success');
      await onRefresh();
    } catch (err: any) {
      showToast(err.response?.data?.message || err.message || 'Lỗi đồng bộ', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Chạy thử phân luồng Đọc/Ghi
  const handleTestRouting = async () => {
    try {
      setLoading(true);
      const res = await api.post('/cluster/test-routing');
      setRoutingTestResult(res.data.data);
      showToast('Đã kiểm tra phân luồng truy vấn Đọc/Ghi thành công!', 'success');
    } catch (err: any) {
      showToast(err.response?.data?.message || err.message || 'Lỗi kiểm tra', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Đồng bộ hóa đa nguồn CSDL
  const handleSyncAllSources = async () => {
    try {
      setLoading(true);
      const res = await api.post('/cluster/multi-source/sync-all');
      showToast(res.data.message || 'Đồng bộ hóa đa nguồn thành công!', 'success');
      await fetchMultiSourceStats();
      await onRefresh();
    } catch (err: any) {
      showToast(err.response?.data?.message || err.message || 'Lỗi đồng bộ đa nguồn', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Thử nghiệm Ghi đồng thời sang Đa Nguồn CSDL
  const handleTestMultiSourceWrite = async () => {
    try {
      setLoading(true);
      const sku = `SKU-DIST-${Date.now().toString().slice(-4)}`;
      const res = await api.post('/cluster/multi-source/test-write', {
        sku,
        name: `Sản phẩm Lưu trữ Đa Nguồn (${sku})`,
        uom: 'Hộp',
        qty: 100,
      });
      setWriteTestResult(res.data.data);
      showToast(`Đã phát tán ghi sản phẩm [${sku}] đồng thời sang 3 nguồn CSDL!`, 'success');
      await fetchMultiSourceStats();
    } catch (err: any) {
      showToast(err.response?.data?.message || err.message || 'Lỗi thử nghiệm ghi đa nguồn', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Header & Quick Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-xl border border-slate-200 shadow-2xs">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-50 border border-red-200 flex items-center justify-center text-red-600">
              <Database className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">
                Cụm Database Phân Tán & Dự Phòng (HA Cluster)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Mô hình Primary - Hot Standby Replica &bull; Tách luồng Đọc/Ghi &bull; Chuyển mạch tức thì (Failover)
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setShowTheory(!showTheory)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
            title="Xem giải thích nguyên lý thiết kế phân tán"
          >
            <HelpCircle className="w-4 h-4 text-slate-500" />
            <span>Nguyên lý kiến trúc</span>
          </button>

          <button
            onClick={handleSyncNow}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Đồng bộ WAL ngay</span>
          </button>

          <button
            onClick={handleTestRouting}
            disabled={loading}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors shadow-2xs cursor-pointer disabled:opacity-50"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Test định tuyến Đọc/Ghi</span>
          </button>
        </div>
      </div>

      {/* 2. Banner Cảnh Báo Trạng Thái Sự Cố / Bình Thường */}
      {isFailover ? (
        <div className="bg-amber-50 border-2 border-amber-400 p-5 rounded-xl shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4 animate-pulse">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-bold text-amber-900 text-sm">
                ⚠️ CẢNH BÁO: CHẾ ĐỘ SỰ CỐ (FAILOVER ACTIVE) ĐANG ĐƯỢC MÔ PHỎNG!
              </h3>
              <p className="text-xs text-amber-800 mt-1 leading-relaxed">
                Đây là <strong>mô phỏng sự cố trên tầng giám sát</strong>: bảng điều khiển chuyển sang
                chế độ dự phòng (Port 5434). Để chuyển mạch thật cần promote Hot Standby và đổi
                connection string của ứng dụng.
              </p>
              {clusterState.failoverNote && (
                <p className="text-[11px] text-amber-900 font-semibold mt-2 leading-relaxed">
                  🔎 {clusterState.failoverNote}
                </p>
              )}
              {clusterState.actualWriteTarget && (
                <p className="text-[11px] text-amber-800 mt-1 break-all">
                  Đích ghi thực tế: <code>{clusterState.actualWriteTarget}</code>
                </p>
              )}
            </div>
          </div>
          <button
            onClick={() => handleToggleFailover(false)}
            disabled={loading}
            className="shrink-0 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg shadow-sm transition-colors cursor-pointer"
          >
            ✅ Khôi phục Database Chính (5432)
          </button>
        </div>
      ) : (
        <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <div>
              <span className="font-bold text-emerald-900 text-xs">
                CỤM DATABASE ĐANG HOẠT ĐỘNG HOÀN HẢO (NORMAL DUPLEX MODE)
              </span>
              <p className="text-[11px] text-emerald-700 mt-0.5">
                Primary Master (5432) tiếp nhận Ghi; Standby Replica (5434) đồng bộ liên tục qua Streaming WAL và sẵn sàng thay thế.
              </p>
            </div>
          </div>
          <button
            onClick={() => handleToggleFailover(true)}
            disabled={loading}
            className="shrink-0 px-3.5 py-1.5 bg-red-600 hover:bg-red-700 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer shadow-2xs"
          >
            ⚡ Mô phỏng sập Primary (Test Failover)
          </button>
        </div>
      )}

      {/* 3. Khung Giải thích Nguyên Lý Thiết Kế (Khi bấm nút) */}
      {showTheory && (
        <div className="bg-slate-900 text-slate-100 p-6 rounded-xl space-y-4 border border-slate-700 shadow-md">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h4 className="font-bold text-sm text-red-400 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-red-400" />
              Kiến Trúc Phân Tán Database Dự Phòng Trong Dự Án (High Availability)
            </h4>
            <span className="text-[11px] text-slate-400">Đề tài: Quản lý Kho Hàng - Nhóm 8</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs leading-relaxed text-slate-300">
            <div className="bg-slate-800/80 p-3.5 rounded-lg border border-slate-700">
              <span className="font-bold text-white block mb-1">1. Primary - Standby Replication</span>
              Node chính (Master - 5432) liên tục ghi nhật ký Write-Ahead Log (WAL) và sao chép sang Node dự phòng (Standby - 5434). Đảm bảo dữ liệu tại 2 node luôn tương đồng và độ trễ gần như bằng 0.
            </div>
            <div className="bg-slate-800/80 p-3.5 rounded-lg border border-slate-700">
              <span className="font-bold text-white block mb-1">2. Read / Write Splitting</span>
              Mọi lệnh Ghi (Tạo phiếu nhập/xuất, sửa hàng) đi vào Primary để đảm bảo ACID. Các truy vấn Đọc nặng (Dashboard, tìm kiếm, báo cáo) được phân tải sang Standby để tránh nghẽn cổ chai Master.
            </div>
            <div className="bg-slate-800/80 p-3.5 rounded-lg border border-slate-700">
              <span className="font-bold text-white block mb-1">3. Failover (mô phỏng / promote)</span>
              Heartbeat phát hiện Primary mất kết nối. Giao diện mô phỏng chuyển mạch sang Standby để thuyết trình; trong triển khai thật cần <code>pg_promote()</code> + đổi connection string (PgBouncer/HAProxy) để nhân viên kho tiếp tục quét hàng.
            </div>
          </div>
        </div>
      )}

      {/* 4. Sơ Đồ Cụm Trực Quan (Interactive Topology) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Node 1: Primary Master */}
        <div
          className={`lg:col-span-5 bg-white p-5 rounded-xl border transition-all ${
            clusterState.primary.status === 'ONLINE'
              ? 'border-emerald-300 ring-2 ring-emerald-500/10'
              : 'border-red-300 bg-red-50/20'
          }`}
        >
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2.5">
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-white ${
                  clusterState.primary.status === 'ONLINE' ? 'bg-emerald-600' : 'bg-red-600'
                }`}
              >
                <Server className="w-5 h-5" />
              </div>
              <div>
                <h4 className="font-bold text-sm text-slate-800">{clusterState.primary.name}</h4>
                <p className="text-[11px] text-slate-500">Node chính tiếp nhận Giao Dịch Gốc</p>
              </div>
            </div>

            <span
              className={`text-xs px-2.5 py-0.5 rounded-full font-bold flex items-center gap-1.5 ${
                clusterState.primary.status === 'ONLINE'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-red-100 text-red-700 border border-red-300'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  clusterState.primary.status === 'ONLINE' ? 'bg-emerald-500' : 'bg-red-500'
                }`}
              />
              {clusterState.primary.status}
            </span>
          </div>

          <div className="mt-4 space-y-2.5 text-xs text-slate-600">
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-400">Địa chỉ / Cổng:</span>
              <span className="font-mono font-bold text-slate-700">
                {clusterState.primary.host}:{clusterState.primary.port}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-400">Database Name:</span>
              <span className="font-mono text-slate-700">{clusterState.primary.database}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-400">Vai trò (Role):</span>
              <span className="font-bold text-emerald-700">{clusterState.primary.role}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-400">Độ trễ Ping (Latency):</span>
              <span className="font-bold text-slate-800">{clusterState.primary.latencyMs} ms</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-400">Cho phép Ghi (Write):</span>
              <span
                className={`font-semibold ${
                  clusterState.primary.isWriteAllowed ? 'text-emerald-600' : 'text-red-500'
                }`}
              >
                {clusterState.primary.isWriteAllowed ? '✅ Được phép (Active)' : '❌ Bị khóa (Offline)'}
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-400">Cho phép Đọc (Read):</span>
              <span className="font-semibold text-emerald-600">
                {clusterState.primary.isReadAllowed ? '✅ Được phép' : '❌ Bị ngắt'}
              </span>
            </div>
          </div>

          {clusterState.primary.error && (
            <div className="mt-3 p-2.5 bg-red-50 border border-red-200 rounded-lg text-[11px] text-red-700">
              <strong>Sự cố:</strong> {clusterState.primary.error}
            </div>
          )}
        </div>

        {/* Trung gian: Replication Link & Sync */}
        <div className="lg:col-span-2 flex flex-col items-center justify-center p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
          <div className="text-[11px] font-bold text-slate-600 text-center uppercase tracking-wider">
            Replication Link
          </div>
          <div className="w-full flex items-center justify-center">
            <div
              className={`p-3 rounded-full ${
                clusterState.replication.status === 'SYNCHRONIZED'
                  ? 'bg-blue-100 text-blue-600'
                  : 'bg-amber-100 text-amber-600'
              }`}
            >
              <ArrowLeftRight className="w-5 h-5 animate-pulse" />
            </div>
          </div>
          <div className="text-center space-y-1">
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                clusterState.replication.status === 'SYNCHRONIZED'
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-amber-100 text-amber-800'
              }`}
            >
              {clusterState.replication.status}
            </span>
            <p className="text-[10px] text-slate-500 font-mono">
              Lag: {clusterState.replication.replicationLagMs} ms
            </p>
          </div>
          <div className="text-[10px] text-slate-400 text-center leading-tight">
            Streaming WAL Mode
          </div>
        </div>

        {/* Node 2: Standby Replica */}
        <div
          className={`lg:col-span-5 bg-white p-5 rounded-xl border transition-all ${
            isFailover
              ? 'border-amber-400 ring-2 ring-amber-500/20 bg-amber-50/20'
              : 'border-blue-300 ring-2 ring-blue-500/10'
          }`}
        >
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2.5">
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-white ${
                  isFailover ? 'bg-amber-500' : 'bg-blue-600'
                }`}
              >
                <Server className="w-5 h-5" />
              </div>
              <div>
                <h4 className="font-bold text-sm text-slate-800">{clusterState.standby.name}</h4>
                <p className="text-[11px] text-slate-500">Node dự phòng nóng &amp; Read-Replica</p>
              </div>
            </div>

            <span
              className={`text-xs px-2.5 py-0.5 rounded-full font-bold flex items-center gap-1.5 ${
                isFailover
                  ? 'bg-amber-100 text-amber-800 border border-amber-300 animate-pulse'
                  : 'bg-blue-50 text-blue-700 border border-blue-200'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${isFailover ? 'bg-amber-500' : 'bg-blue-500'}`}
              />
              {isFailover ? 'FAILOVER PROMOTED' : clusterState.standby.status}
            </span>
          </div>

          <div className="mt-4 space-y-2.5 text-xs text-slate-600">
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-400">Địa chỉ / Cổng:</span>
              <span className="font-mono font-bold text-slate-700">
                {clusterState.standby.host}:{clusterState.standby.port}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-400">Database Name:</span>
              <span className="font-mono text-slate-700">{clusterState.standby.database}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-400">Vai trò (Role):</span>
              <span className="font-bold text-blue-700">
                {isFailover ? 'PROMOTED TO PRIMARY' : clusterState.standby.role}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-400">Độ trễ Ping (Latency):</span>
              <span className="font-bold text-slate-800">{clusterState.standby.latencyMs} ms</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-400">Cho phép Ghi (Write):</span>
              <span
                className={`font-semibold ${
                  clusterState.standby.isWriteAllowed ? 'text-amber-600' : 'text-slate-500'
                }`}
              >
                {clusterState.standby.isWriteAllowed
                  ? '⚡ Đã thăng cấp Ghi (Failover Active)'
                  : '🛡️ Read-Only (Standby)'}
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-400">Cho phép Đọc (Read):</span>
              <span className="font-semibold text-emerald-600">✅ Sẵn sàng (Read-Replica)</span>
            </div>
          </div>
        </div>
      </div>

      {/* 5. Kết quả Kiểm thử Phân Luồng Đọc/Ghi (Routing Test Demonstration) */}
      {routingTestResult && (
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs space-y-3">
          <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
            <h4 className="font-bold text-sm text-slate-800 flex items-center gap-2">
              <Activity className="w-4 h-4 text-red-600" />
              Kết Quả Thử Nghiệm Phân Luồng Truy Vấn Đọc/Ghi (Read-Write Routing Test)
            </h4>
            <span className="text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full font-semibold">
              Live Verified
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {/* Read Query Result */}
            <div className="p-3.5 bg-blue-50/60 border border-blue-200 rounded-lg space-y-1.5">
              <span className="font-bold text-blue-900 block">1. Lệnh Đọc (SELECT Query - Tra cứu tồn kho)</span>
              <p className="text-slate-600 text-[11px] font-mono">{routingTestResult.readQuery.queryType}</p>
              <div className="flex items-center justify-between pt-1 text-[11px]">
                <span className="text-slate-500">Được định tuyến đến:</span>
                <span className="font-bold text-blue-700">{routingTestResult.readQuery.targetNode}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-500">Thời gian thực thi:</span>
                <span className="font-bold text-slate-800">{routingTestResult.readQuery.latencyMs} ms</span>
              </div>
            </div>

            {/* Write Query Result */}
            <div className="p-3.5 bg-emerald-50/60 border border-emerald-200 rounded-lg space-y-1.5">
              <span className="font-bold text-emerald-900 block">2. Lệnh Ghi (INSERT / UPDATE - Thay đổi tồn kho)</span>
              <p className="text-slate-600 text-[11px] font-mono">{routingTestResult.writeQuery.queryType}</p>
              <div className="flex items-center justify-between pt-1 text-[11px]">
                <span className="text-slate-500">Được định tuyến đến:</span>
                <span className="font-bold text-emerald-700">{routingTestResult.writeQuery.targetNode}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-500">Thời gian thực thi:</span>
                <span className="font-bold text-slate-800">{routingTestResult.writeQuery.latencyMs} ms</span>
              </div>
            </div>
          </div>

          <p className="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-md italic">
            {routingTestResult.explanation}
          </p>
        </div>
      )}

      {/* 5.5. Lưu Trữ Dữ Liệu Đa Nguồn Phân Tán (Multi-Source Distributed Storage) */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-2xs space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-600">
              <Share2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-base text-slate-800">
                  Lưu Trữ Dữ Liệu Đa Nguồn Phân Tán (Multi-Source Distributed Storage)
                </h3>
                <span className="text-[11px] bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full font-bold">
                  3 Data Sources Active
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Dữ liệu được lưu trữ và đồng bộ hóa qua 3 nguồn cơ sở dữ liệu vật lý độc lập (North :5432, South :5433, Replica Mirror :5434).
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSyncAllSources}
              disabled={loading || multiSourceLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
              title="Kích hoạt phát tán đồng bộ dữ liệu trên toàn bộ 3 nguồn CSDL"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Đồng bộ 3 nguồn</span>
            </button>

            <button
              onClick={handleTestMultiSourceWrite}
              disabled={loading || multiSourceLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors cursor-pointer shadow-2xs disabled:opacity-50"
              title="Thử nghiệm phát tán ghi đồng thời vào cả 3 nguồn CSDL"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>🧪 Test Ghi Đa Nguồn</span>
            </button>
          </div>
        </div>

        {/* Thông tin 3 Nguồn Dữ Liệu */}
        {multiSourceData && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {multiSourceData.nodes.map((node) => (
              <div
                key={node.id}
                className="p-4 rounded-xl border border-slate-200 bg-slate-50/50 hover:bg-white hover:border-indigo-300 hover:shadow-xs transition-all space-y-2.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-indigo-600" />
                    <span className="font-bold text-xs text-slate-800">{node.name}</span>
                  </div>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                      node.status === 'ONLINE'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-blue-50 text-blue-700 border border-blue-200'
                    }`}
                  >
                    {node.status}
                  </span>
                </div>

                <div className="text-[11px] text-slate-600 space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Cổng / Vùng:</span>
                    <span className="font-mono font-semibold text-slate-700">
                      Port {node.port} ({node.region})
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Vai trò CSDL:</span>
                    <span className="font-semibold text-indigo-700">{node.role}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Tổng bản ghi:</span>
                    <span className="font-bold text-slate-900">{node.totalRecords} records</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-200/60 text-[10px] text-slate-500 leading-tight">
                  <strong className="text-slate-700">Phạm vi lưu trữ:</strong> {node.storageScope}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Kết quả Test Ghi Đa Nguồn */}
        {writeTestResult && (
          <div className="p-4 bg-indigo-50/50 border border-indigo-200 rounded-xl space-y-2.5 text-xs animate-fadeIn">
            <div className="flex items-center justify-between">
              <span className="font-bold text-indigo-950 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                Kết Quả Thử Nghiệm Ghi Đa Nguồn Đồng Thời ({writeTestResult.sku})
              </span>
              <span className="font-mono text-slate-500 text-[11px]">
                Thời gian thực thi tổng: <strong>{writeTestResult.executionTimeMs} ms</strong>
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {writeTestResult.distributionResults.map((item: any, idx: number) => (
                <div key={idx} className="p-3 bg-white rounded-lg border border-indigo-100 space-y-1">
                  <div className="font-bold text-slate-800 text-[11px]">{item.node}</div>
                  <div className="text-[10px] font-mono text-slate-500">{item.action}</div>
                  <div className="flex justify-between text-[10px] pt-1 border-t border-slate-100">
                    <span className="text-emerald-700 font-semibold">{item.result}</span>
                    <span className="text-slate-400">{item.latencyMs} ms</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Bảng Đối Soát Bản Ghi Lưu Trữ Đa Nguồn */}
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-600" />
              <h4 className="font-bold text-xs text-slate-800">
                Bảng Đối Soát Bản Ghi Lưu Trữ Đa Nguồn (Multi-Source Data Inspector)
              </h4>
            </div>
            {multiSourceData?.lastDistributedSync && (
              <span className="text-[11px] text-slate-500">
                Đồng bộ lần cuối: {new Date(multiSourceData.lastDistributedSync).toLocaleTimeString('vi-VN')}
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-600 uppercase text-[10px] tracking-wider font-semibold border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-4">Bảng CSDL</th>
                  <th className="py-2.5 px-4">Chiến lược lưu trữ</th>
                  <th className="py-2.5 px-4 text-center">Nguồn 1: Miền Bắc (:5432)</th>
                  <th className="py-2.5 px-4 text-center">Nguồn 2: Miền Nam (:5433)</th>
                  <th className="py-2.5 px-4 text-center">Nguồn 3: Dự Phòng (:5434)</th>
                  <th className="py-2.5 px-4 text-right">Trạng thái</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {multiSourceData?.tableStats.map((row) => (
                  <tr key={row.table} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-2.5 px-4">
                      <div className="font-bold text-slate-800">{row.tableNameVi}</div>
                      <span className="font-mono text-[10px] text-slate-400">{row.table}</span>
                    </td>
                    <td className="py-2.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          row.distributionType === 'REPLICATED_FULL'
                            ? 'bg-blue-50 text-blue-700 border border-blue-200'
                            : row.distributionType === 'SHARDED_BY_WAREHOUSE'
                            ? 'bg-purple-50 text-purple-700 border border-purple-200'
                            : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        }`}
                      >
                        {row.distributionType === 'REPLICATED_FULL'
                          ? 'Đồng Bộ Toàn Cục (Replicated)'
                          : row.distributionType === 'SHARDED_BY_WAREHOUSE'
                          ? 'Phân Mảnh Theo Kho (Sharded)'
                          : 'Sao Lưu Toàn Bộ (Hot Mirror)'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-center font-mono font-bold text-slate-800">
                      {row.primaryNorthCount}
                    </td>
                    <td className="py-2.5 px-4 text-center font-mono font-bold text-slate-800">
                      {row.shardSouthCount}
                    </td>
                    <td className="py-2.5 px-4 text-center font-mono font-bold text-indigo-700 bg-indigo-50/30">
                      {row.replicaCount}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                        {row.status === 'SYNCHRONIZED' ? 'Đồng bộ' : 'Phân mảnh chuẩn'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 6. Bảng Nhật Ký Chuyển Mạch & Sự Kiện Cụm (Failover & Replication History) */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-500" />
            <h3 className="font-bold text-sm text-slate-800">
              Nhật Ký Chuyển Mạch &amp; Kiểm Toán Cụm Phân Tán (Cluster Audit Trail)
            </h3>
          </div>
          <span className="text-xs text-slate-400">
            {clusterState.failoverHistory.length} sự kiện gần nhất
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-4">Thời gian</th>
                <th className="py-2.5 px-4">Loại sự kiện</th>
                <th className="py-2.5 px-4">Node nguồn</th>
                <th className="py-2.5 px-4">Node đích</th>
                <th className="py-2.5 px-4">Mô tả chi tiết</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {clusterState.failoverHistory.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                    {new Date(item.timestamp).toLocaleTimeString('vi-VN')} {new Date(item.timestamp).toLocaleDateString('vi-VN')}
                  </td>
                  <td className="py-2.5 px-4">
                    <span
                      className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${
                        item.type === 'FAILOVER_TRIGGERED'
                          ? 'bg-amber-100 text-amber-800'
                          : item.type === 'PRIMARY_RECOVERED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}
                    >
                      {item.type}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 font-semibold text-slate-700 whitespace-nowrap">{item.fromNode}</td>
                  <td className="py-2.5 px-4 font-semibold text-slate-700 whitespace-nowrap">{item.toNode}</td>
                  <td className="py-2.5 px-4 text-slate-600">{item.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
