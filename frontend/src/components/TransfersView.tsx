import React, { useState, useEffect } from 'react';
import { Kho, Product, ViTriLuuTru } from '../types';
import {
  ArrowLeftRight,
  Plus,
  CheckCircle2,
  XCircle,
  Clock,
  FileText,
  ShieldCheck,
  Building2,
  ArrowRight,
  X,
  XOctagon
} from 'lucide-react';

interface TransfersViewProps {
  transfers: any[];
  warehouses: Kho[];
  products: Product[];
  locations: ViTriLuuTru[];
  onCreateTransfer: (data: any) => Promise<void>;
  onApproveTransfer: (id: string) => Promise<void>;
  onRejectTransfer?: (id: string, lyDo?: string) => Promise<void>;
  canApprove: boolean;
}

export const TransfersView: React.FC<TransfersViewProps> = ({
  transfers,
  warehouses,
  products,
  locations,
  onCreateTransfer,
  onApproveTransfer,
  onRejectTransfer,
  canApprove,
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // Chế độ chuyển kho: NOI_BO_KHO (nội bộ) hoặc LIEN_KHO (giữa các kho)
  const [loaiChuyen, setLoaiChuyen] = useState<'NOI_BO_KHO' | 'LIEN_KHO'>('NOI_BO_KHO');
  const [khoNguonId, setKhoNguonId] = useState(warehouses[0]?.id || '');
  const [khoDichId, setKhoDichId] = useState(warehouses[1]?.id || warehouses[0]?.id || '');

  const [hangHoaId, setHangHoaId] = useState(products[0]?.id || '');
  const [viTriDiId, setViTriDiId] = useState('');
  const [viTriDenId, setViTriDenId] = useState('');
  const [slChuyen, setSlChuyen] = useState(5);
  const [ghiChu, setGhiChu] = useState('Điều chuyển tối ưu vị trí lưu trữ');

  // Lọc danh sách vị trí theo kho nguồn và kho đích
  const sourceLocations = locations.filter((l) => !khoNguonId || l.khoId === khoNguonId);
  const destLocations = locations.filter((l) =>
    loaiChuyen === 'NOI_BO_KHO'
      ? (!khoNguonId || l.khoId === khoNguonId)
      : (!khoDichId || l.khoId === khoDichId)
  );

  // Close modals on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowCreateModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleOpenModal = () => {
    setShowCreateModal(true);
    const srcK = warehouses[0]?.id || '';
    const dstK = loaiChuyen === 'LIEN_KHO' ? (warehouses[1]?.id || srcK) : srcK;
    setKhoNguonId(srcK);
    setKhoDichId(dstK);

    const sLocs = locations.filter((l) => l.khoId === srcK);
    const dLocs = locations.filter((l) => l.khoId === dstK);

    if (sLocs.length > 0) setViTriDiId(sLocs[0].id);
    if (dLocs.length > 0) {
      if (sLocs.length > 1 && srcK === dstK) {
        setViTriDenId(sLocs[1].id);
      } else {
        setViTriDenId(dLocs[0].id);
      }
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!khoNguonId || !khoDichId) {
      alert('Vui lòng chọn đầy đủ Kho nguồn và Kho đích');
      return;
    }
    if (loaiChuyen === 'LIEN_KHO' && khoNguonId === khoDichId) {
      alert('Điều chuyển liên kho thì Kho nguồn và Kho đích phải khác nhau!');
      return;
    }
    if (!viTriDiId || !viTriDenId) {
      alert('Vui lòng chọn đầy đủ Vị trí đi và Vị trí đến');
      return;
    }
    if (viTriDiId === viTriDenId) {
      alert('Vị trí đi và Vị trí đến phải khác nhau!');
      return;
    }
    if (slChuyen <= 0) {
      alert('Số lượng chuyển phải lớn hơn 0');
      return;
    }

    try {
      await onCreateTransfer({
        khoNguonId,
        khoDichId: loaiChuyen === 'NOI_BO_KHO' ? khoNguonId : khoDichId,
        loaiChuyen,
        ghiChu,
        items: [
          {
            hangHoaId,
            viTriDiId,
            viTriDenId,
            slChuyen,
            ghiChu,
          },
        ],
      });
      setShowCreateModal(false);
      setGhiChu('Điều chuyển tối ưu vị trí lưu trữ');
    } catch (err: any) {
      alert(err.response?.data?.message || err.message || 'Lỗi khi tạo phiếu chuyển');
    }
  };

  const handleApprove = async (id: string) => {
    if (
      !confirm(
        'Xác nhận PHÊ DUYỆT phiếu chuyển? Hệ thống sẽ kích hoạt Database Transaction: Trừ tồn kho nguồn và Cộng tồn kho đích.'
      )
    ) {
      return;
    }
    setLoadingId(id);
    try {
      await onApproveTransfer(id);
    } catch (err: any) {
      alert(err.response?.data?.message || err.message || 'Lỗi khi duyệt phiếu chuyển');
    } finally {
      setLoadingId(null);
    }
  };

  const handleReject = async (id: string) => {
    const lyDo = prompt('Nhập lý do từ chối phiếu điều chuyển (để giải phóng tồn tạm giữ tại kho nguồn):');
    if (lyDo === null) return;
    if (onRejectTransfer) {
      setLoadingId(id);
      try {
        await onRejectTransfer(id, lyDo);
      } catch (err: any) {
        alert(err.response?.data?.message || err.message || 'Lỗi khi từ chối phiếu');
      } finally {
        setLoadingId(null);
      }
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-red-50 text-red-600 rounded-lg">
            <ArrowLeftRight className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-bold text-slate-800 text-lg">Phiếu Điều Chuyển Kho &amp; Vị Trí</h2>
            <p className="text-xs text-slate-500">
              Hỗ trợ chuyển ô kệ nội bộ kho và điều chuyển phân tán giữa các chi nhánh (Liên kho)
            </p>
          </div>
        </div>

        <button
          onClick={handleOpenModal}
          className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors shadow-2xs cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Lập Phiếu Điều Chuyển</span>
        </button>
      </div>

      {/* Transfers Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 font-semibold uppercase tracking-wider border-b border-slate-200">
              <tr>
                <th className="p-3.5">Mã Phiếu</th>
                <th className="p-3.5">Loại Chuyển</th>
                <th className="p-3.5">Mặt Hàng Chuyển</th>
                <th className="p-3.5 text-center">Lộ Trình (Từ Kho &rarr; Đến Kho)</th>
                <th className="p-3.5 text-center">Vị Trí (Đi &rarr; Đến)</th>
                <th className="p-3.5 text-center">SL Chuyển</th>
                <th className="p-3.5">Người Lập</th>
                <th className="p-3.5 text-center">Trạng Thái</th>
                <th className="p-3.5 text-center">Thao Tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {transfers.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-400">
                    Chưa có phiếu chuyển vị trí hoặc điều chuyển kho nào được tạo
                  </td>
                </tr>
              ) : (
                transfers.map((t) => {
                  const firstItem = t.chiTiet?.[0];
                  const isLienKho = t.loaiChuyen === 'LIEN_KHO';
                  return (
                    <tr key={t.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="p-3.5 font-bold text-slate-800 flex items-center gap-2">
                        <FileText className="w-4 h-4 text-red-600 shrink-0" />
                        <span>{t.maPC}</span>
                      </td>

                      <td className="p-3.5">
                        <span
                          className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                            isLienKho
                              ? 'bg-purple-50 text-purple-700 border-purple-200'
                              : 'bg-blue-50 text-blue-700 border-blue-200'
                          }`}
                        >
                          {isLienKho ? '🌐 Liên Kho' : '🏢 Nội Bộ Kho'}
                        </span>
                      </td>

                      <td className="p-3.5 font-semibold text-slate-800">
                        {firstItem?.hangHoa?.tenHH || 'Nhiều mặt hàng'}
                      </td>

                      <td className="p-3.5 text-center">
                        <div className="flex items-center justify-center gap-1.5 font-medium text-slate-700">
                          <span className="font-semibold">{t.khoNguon?.tenKho || 'Kho Nguồn'}</span>
                          <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                          <span className="font-semibold text-emerald-700">{t.khoDich?.tenKho || 'Kho Đích'}</span>
                        </div>
                      </td>

                      <td className="p-3.5 text-center">
                        <div className="flex items-center justify-center gap-1.5 font-mono">
                          <span className="bg-rose-50 text-rose-700 font-bold px-1.5 py-0.5 rounded border border-rose-200 text-[11px]">
                            {firstItem?.viTriDi?.maViTri || '---'}
                          </span>
                          <ArrowRight className="w-3 h-3 text-slate-400" />
                          <span className="bg-emerald-50 text-emerald-700 font-bold px-1.5 py-0.5 rounded border border-emerald-200 text-[11px]">
                            {firstItem?.viTriDen?.maViTri || '---'}
                          </span>
                        </div>
                      </td>

                      <td className="p-3.5 text-center font-bold text-slate-900 text-sm">
                        {firstItem?.slChuyen || 0}
                      </td>

                      <td className="p-3.5 text-slate-600">
                        <div className="font-medium">{t.nguoiLap?.hoTen}</div>
                        <div className="text-[10px] text-slate-400">
                          {new Date(t.ngayLap).toLocaleDateString('vi-VN')}
                        </div>
                      </td>

                      <td className="p-3.5 text-center">
                        {t.trangThai === 'APPROVED' ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                            <CheckCircle2 className="w-3 h-3" /> Đã hoàn tất
                          </span>
                        ) : t.trangThai === 'REJECTED' ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full">
                            <XCircle className="w-3 h-3" /> Bị từ chối
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full animate-pulse">
                            <Clock className="w-3 h-3" /> Chờ phê duyệt
                          </span>
                        )}
                      </td>

                      <td className="p-3.5 text-center">
                        {t.trangThai === 'PENDING' && canApprove ? (
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => handleApprove(t.id)}
                              disabled={loadingId === t.id}
                              className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded font-semibold transition-colors flex items-center gap-1 shadow-2xs cursor-pointer"
                              title="Phê duyệt điều chuyển"
                            >
                              <ShieldCheck className="w-3 h-3" />
                              <span>{loadingId === t.id ? '...' : 'Duyệt'}</span>
                            </button>
                            {onRejectTransfer && (
                              <button
                                onClick={() => handleReject(t.id)}
                                disabled={loadingId === t.id}
                                className="px-2 py-1 bg-slate-100 hover:bg-rose-50 text-rose-700 border border-slate-200 hover:border-rose-300 rounded font-semibold transition-colors flex items-center gap-1 cursor-pointer"
                                title="Từ chối phiếu và nhả tồn giữ chỗ"
                              >
                                <XOctagon className="w-3 h-3" />
                                <span>Hủy</span>
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400">---</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowCreateModal(false);
          }}
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
        >
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[90vh] my-auto animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 bg-gradient-to-r from-red-600 to-rose-700 text-white flex items-center justify-between shrink-0 shadow-sm">
              <div>
                <h3 className="font-bold text-white text-base flex items-center gap-2">
                  <ArrowLeftRight className="w-4 h-4 text-white" />
                  <span>Lập Phiếu Điều Chuyển Hàng Hóa</span>
                </h3>
                <p className="text-[11px] text-red-100 mt-0.5">
                  Phân phối hàng hóa linh hoạt &bull; Đảm bảo toàn vẹn tồn kho
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                title="Đóng (Esc)"
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/20 hover:bg-black/20 text-white font-bold transition-all cursor-pointer shadow-sm"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="p-6 space-y-4 text-xs overflow-y-auto flex-1">
                {/* Chọn loại chuyển */}
                <div>
                  <label className="block font-semibold text-slate-700 mb-1.5">Loại hình điều chuyển *</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setLoaiChuyen('NOI_BO_KHO')}
                      className={`p-2.5 rounded-lg border text-center font-bold transition-all cursor-pointer ${
                        loaiChuyen === 'NOI_BO_KHO'
                          ? 'border-red-600 bg-red-50 text-red-700 ring-2 ring-red-500/10'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      🏢 Nội Bộ Kho (Chuyển Ô Kệ)
                    </button>
                    <button
                      type="button"
                      onClick={() => setLoaiChuyen('LIEN_KHO')}
                      className={`p-2.5 rounded-lg border text-center font-bold transition-all cursor-pointer ${
                        loaiChuyen === 'LIEN_KHO'
                          ? 'border-purple-600 bg-purple-50 text-purple-700 ring-2 ring-purple-500/10'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      🌐 Điều Chuyển Liên Kho
                    </button>
                  </div>
                </div>

                {/* Chọn Kho Nguồn và Kho Đích (Khi chuyển liên kho) */}
                {loaiChuyen === 'LIEN_KHO' && (
                  <div className="p-3.5 bg-purple-50/50 border border-purple-200 rounded-xl space-y-3">
                    <span className="font-bold text-purple-900 block">Chọn Tuyến Kho Vận Chuyển:</span>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block font-semibold text-purple-800 mb-1">Kho Nguồn (Xuất Đi) *</label>
                        <select
                          value={khoNguonId}
                          onChange={(e) => {
                            setKhoNguonId(e.target.value);
                            const srcLocs = locations.filter((l) => l.khoId === e.target.value);
                            if (srcLocs.length > 0) setViTriDiId(srcLocs[0].id);
                          }}
                          className="w-full p-2 border border-purple-300 rounded-lg font-medium text-slate-800 focus:ring-2 focus:ring-purple-500"
                        >
                          {warehouses.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.tenKho}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block font-semibold text-purple-800 mb-1">Kho Đích (Tiếp Nhận) *</label>
                        <select
                          value={khoDichId}
                          onChange={(e) => {
                            setKhoDichId(e.target.value);
                            const dstLocs = locations.filter((l) => l.khoId === e.target.value);
                            if (dstLocs.length > 0) setViTriDenId(dstLocs[0].id);
                          }}
                          className="w-full p-2 border border-purple-300 rounded-lg font-medium text-slate-800 focus:ring-2 focus:ring-purple-500"
                        >
                          {warehouses.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.tenKho}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {/* Chọn mặt hàng */}
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Chọn Hàng Hóa Cần Chuyển *</label>
                  <select
                    value={hangHoaId}
                    onChange={(e) => setHangHoaId(e.target.value)}
                    className="w-full p-2.5 border border-slate-300 rounded-lg font-medium text-slate-800 focus:ring-2 focus:ring-red-500"
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.maHH} - {p.tenHH} (Tồn tổng: {p.tongTon} {p.donViTinh})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Chọn vị trí ô kệ */}
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <div className="flex items-center justify-between text-slate-700 font-bold">
                    <span>Chỉ Định Ô Kệ (Vị Trí Lưu Kho)</span>
                    <ArrowRight className="w-4 h-4 text-red-600" />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-rose-700 mb-1">Vị Trí Đi (Lấy Hàng Ra) *</label>
                      <select
                        value={viTriDiId}
                        onChange={(e) => setViTriDiId(e.target.value)}
                        className="w-full p-2 border border-rose-300 bg-rose-50/50 rounded-lg font-mono font-medium text-slate-800 focus:ring-2 focus:ring-red-500"
                      >
                        {sourceLocations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.maViTri} (Sức chứa: {l.currentStoredQty || 0}/{l.sucChua})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block font-semibold text-emerald-700 mb-1">Vị Trí Đến (Cất Hàng Vào) *</label>
                      <select
                        value={viTriDenId}
                        onChange={(e) => setViTriDenId(e.target.value)}
                        className="w-full p-2 border border-emerald-300 bg-emerald-50/50 rounded-lg font-mono font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500"
                      >
                        {destLocations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.maViTri} (Sức chứa: {l.currentStoredQty || 0}/{l.sucChua})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Số Lượng Chuyển *</label>
                    <input
                      type="number"
                      min={1}
                      value={slChuyen}
                      onChange={(e) => setSlChuyen(parseInt(e.target.value) || 1)}
                      className="w-full p-2.5 border border-slate-300 rounded-lg font-bold text-center text-sm focus:ring-2 focus:ring-red-500"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Lý Do / Ghi Chú</label>
                    <input
                      type="text"
                      value={ghiChu}
                      onChange={(e) => setGhiChu(e.target.value)}
                      placeholder="VD: Điều chuyển cân bằng tải giữa các kho..."
                      className="w-full p-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-red-500"
                    />
                  </div>
                </div>
              </div>

              <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg font-semibold text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  Hủy (Esc)
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold shadow-2xs transition-colors cursor-pointer"
                >
                  Tạo Phiếu Điều Chuyển
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
