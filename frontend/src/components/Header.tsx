import React, { useState } from 'react';
import { User, NotificationItem, Kho } from '../types';
import { UserCheck, LogOut, Bell, Building2 } from 'lucide-react';
import { NotificationDropdown } from './NotificationDropdown';

interface HeaderProps {
  user: User | null;
  onOpenLogin: () => void;
  onLogout: () => void;
  alertCount: number;
  onAlertClick: () => void;
  notifications?: NotificationItem[];
  readNotificationIds?: string[];
  onMarkAllNotificationsRead?: (silent?: boolean) => void;
  onSelectNotification?: (item: NotificationItem) => void;
  isFailover?: boolean;
  onClusterClick?: () => void;
  warehouses?: Kho[];
  selectedWarehouseId?: string;
  onSelectWarehouse?: (id: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  onOpenLogin,
  onLogout,
  alertCount,
  onAlertClick,
  notifications = [],
  readNotificationIds = [],
  onMarkAllNotificationsRead,
  onSelectNotification,
  isFailover = false,
  onClusterClick,
  warehouses = [],
  selectedWarehouseId = '',
  onSelectWarehouse,
}) => {
  const [showNotifications, setShowNotifications] = useState(false);
  const unreadNotifCount = notifications.filter((n) => !readNotificationIds.includes(n.id)).length;
  const getRoleBadge = (role?: string) => {
    switch (role) {
      case 'ADMIN':
        return <span className="bg-red-50 text-red-700 border border-red-200 text-xs px-2.5 py-0.5 rounded-full font-semibold">Admin Quản trị</span>;
      case 'QUAN_LY_KHO':
        return <span className="bg-rose-50 text-rose-700 border border-rose-200 text-xs px-2.5 py-0.5 rounded-full font-semibold">Quản lý kho</span>;
      case 'NHAN_VIEN_KHO':
        return <span className="bg-slate-100 text-slate-700 border border-slate-200 text-xs px-2.5 py-0.5 rounded-full font-semibold">Nhân viên kho</span>;
      case 'NHAN_VIEN_MUA_HANG':
        return <span className="bg-amber-50 text-amber-700 border border-amber-200 text-xs px-2.5 py-0.5 rounded-full font-semibold">NV Mua hàng</span>;
      case 'NHAN_VIEN_BAN_HANG':
        return <span className="bg-blue-50 text-blue-700 border border-blue-200 text-xs px-2.5 py-0.5 rounded-full font-semibold">NV Kinh doanh</span>;
      default:
        return null;
    }
  };

  return (
    <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between shrink-0 sticky top-0 z-20">
      {/* Kho active info & Cụm DB status */}
      <div className="flex items-center gap-3 text-sm text-slate-600">
        <div className="flex items-center gap-2">
          <Building2 className="w-4 h-4 text-red-600" />
          {warehouses && warehouses.length > 1 ? (
            <select
              value={selectedWarehouseId}
              onChange={(e) => onSelectWarehouse && onSelectWarehouse(e.target.value)}
              className="text-xs font-bold text-slate-800 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:ring-2 focus:ring-red-500 cursor-pointer"
              title="Chọn chi nhánh kho làm việc"
            >
              <option value="">🏢 Toàn Bộ Hệ Thống Kho</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  📍 {w.tenKho} ({w.maKho})
                </option>
              ))}
            </select>
          ) : (
            <span className="font-bold text-slate-800">
              {warehouses?.[0]?.tenKho || 'Kho Tổng Trung Tâm'}
            </span>
          )}
        </div>

        {/* Status Pill cho Cụm DB Phân Tán Dự Phòng */}
        {onClusterClick && (
          <button
            onClick={onClusterClick}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-semibold transition-all cursor-pointer ${
              isFailover
                ? 'bg-amber-50 text-amber-700 border border-amber-300 ring-2 ring-amber-400/20 animate-pulse'
                : 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
            }`}
            title="Nhấn để xem chi tiết Cụm Database Dự Phòng (HA)"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isFailover ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
            />
            <span>
              {isFailover
                ? '⚠️ Cụm DB: Đang Chạy Dự Phòng (Port 5434)'
                : '🟢 Cụm DB: Master - Standby (HA Active)'}
            </span>
          </button>
        )}
      </div>

      {/* Right controls */}
      <div className="flex items-center gap-4">
        {/* Notification button with dropdown */}
        <div className="relative">
          <button
            onClick={() => {
              const willOpen = !showNotifications;
              setShowNotifications(willOpen);
              if (willOpen && unreadNotifCount > 0 && onMarkAllNotificationsRead) {
                onMarkAllNotificationsRead(true);
              }
            }}
            className="relative p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
            title="Xem thông báo duyệt phiếu & yêu cầu"
          >
            <Bell className="w-5 h-5" />
            {unreadNotifCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 bg-red-600 text-white text-[10px] font-bold min-w-4 h-4 px-1 rounded-full flex items-center justify-center ring-2 ring-white animate-pulse">
                {unreadNotifCount > 9 ? '9+' : unreadNotifCount}
              </span>
            )}
          </button>

          <NotificationDropdown
            isOpen={showNotifications}
            onClose={() => setShowNotifications(false)}
            notifications={notifications}
            readIds={readNotificationIds}
            onMarkAllAsRead={onMarkAllNotificationsRead || (() => {})}
            onSelectNotification={(item) => {
              if (onSelectNotification) onSelectNotification(item);
            }}
            alertCount={alertCount}
            onViewAlerts={onAlertClick}
          />
        </div>

        {/* User Account / Role switcher */}
        {user ? (
          <div className="flex items-center gap-3 pl-3 border-l border-slate-200">
            <div className="text-right">
              <div className="text-sm font-semibold text-slate-800 flex items-center justify-end gap-2">
                {user.hoTen}
                {getRoleBadge(user.role)}
              </div>
              <div className="text-xs text-slate-500">Mã NV: {user.maNV} (@{user.username})</div>
            </div>
            <button
              onClick={onOpenLogin}
              className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 px-2.5 py-1.5 rounded-lg font-medium border border-slate-300 transition-colors cursor-pointer"
              title="Đổi vai trò để test phân quyền"
            >
              Đổi vai trò
            </button>
            <button
              onClick={onLogout}
              className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
              title="Đăng xuất"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={onOpenLogin}
            className="flex items-center gap-2 px-3.5 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium shadow-sm transition-colors cursor-pointer"
          >
            <UserCheck className="w-4 h-4" />
            <span>Đăng nhập hệ thống</span>
          </button>
        )}
      </div>
    </header>
  );
};

