import React from 'react';
import {
  LayoutDashboard,
  Package,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  Warehouse,
  Bell,
  ClipboardList,
  ChevronLeft,
  Users,
  Database
} from 'lucide-react';
import { Role } from '../types';

interface SidebarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  userRole?: Role;
  alertCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  setCurrentTab,
  userRole,
  alertCount,
}) => {
  const menuItems = [
    { id: 'dashboard', label: 'Dashboard Tổng quan', icon: LayoutDashboard },
    { id: 'products', label: 'Quản lý Hàng hóa', icon: Package },
    { id: 'receipts', label: 'Phiếu Nhập kho', icon: ArrowDownLeft },
    { id: 'dispatches', label: 'Phiếu Xuất kho', icon: ArrowUpRight },
    { id: 'transfers', label: 'Phiếu Chuyển Vị Trí', icon: ArrowLeftRight },
    { id: 'inventory', label: 'Tra cứu & Sơ đồ Vị trí', icon: Warehouse },
    { id: 'cluster', label: 'Cụm DB Dự Phòng (HA)', icon: Database },
    { id: 'alerts', label: 'Cảnh báo Tồn kho', icon: Bell, badge: alertCount },
    { id: 'audits', label: 'Nhật ký Thao tác', icon: ClipboardList, roles: ['ADMIN', 'QUAN_LY_KHO'] },
    { id: 'users', label: 'Quản lý Nhân sự', icon: Users, roles: ['ADMIN'] },
  ];

  return (
    <aside className="w-64 bg-white text-slate-700 flex flex-col shrink-0 min-h-screen border-r border-slate-200 shadow-xs">
      {/* Brand Logo & Name */}
      <div className="h-16 flex items-center px-5 gap-3 border-b border-slate-200">
        <div className="w-9 h-9 rounded-lg bg-red-600 flex items-center justify-center text-white font-bold shadow-md shadow-red-600/20 shrink-0">
          <Warehouse className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <h1 className="font-bold text-slate-800 text-sm tracking-tight leading-tight">
            Hệ thống Quản lý Kho
          </h1>
          <p className="text-xs text-red-600 font-semibold mt-0.5">Nhóm 8</p>
        </div>
      </div>

      {/* Nav Menu */}
      <nav className="p-3 space-y-1 flex-1">
        {menuItems
          .filter((item) => !item.roles || (userRole && item.roles.includes(userRole)))
          .map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setCurrentTab(item.id)}
                className={`w-full flex items-center justify-between py-2.5 rounded-lg text-xs transition-all cursor-pointer ${isActive
                  ? 'bg-red-50 text-red-600 font-bold border-l-4 border-red-600 pl-3 pr-3 shadow-2xs'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-red-600 font-medium pl-4 pr-3'
                  }`}
              >
                <div className="flex items-center gap-3">
                  <Icon className={`w-4 h-4 ${isActive ? 'text-red-600' : 'text-slate-400'}`} />
                  <span>{item.label}</span>
                </div>
                {item.badge && item.badge > 0 ? (
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-red-600 text-white">
                    {item.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
      </nav>

      {/* Thanh thu gọn màu đỏ ở góc dưới cùng như trong ảnh */}
      <div
        title="Thu gọn menu"
        className="h-10 bg-red-600 hover:bg-red-700 text-white flex items-center justify-center cursor-pointer transition-colors shrink-0"
      >
        <ChevronLeft className="w-5 h-5 text-white" />
      </div>
    </aside>
  );
};
