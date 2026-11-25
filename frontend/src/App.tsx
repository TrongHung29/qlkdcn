import React, { useState, useEffect } from 'react';
import api from './api/client';
import {
  User,
  Product,
  LoaiHang,
  NhaCungCap,
  KhachHang,
  Kho,
  ViTriLuuTru,
  TonKhoItem,
  Receipt,
  Dispatch,
  CanhBao,
  DashboardStats,
  NotificationItem,
  ClusterState
} from './types';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { DashboardView } from './components/DashboardView';
import { ProductsView } from './components/ProductsView';
import { ReceiptsView } from './components/ReceiptsView';
import { DispatchesView } from './components/DispatchesView';
import { TransfersView } from './components/TransfersView';
import { InventoryView } from './components/InventoryView';
import { AlertsView } from './components/AlertsView';
import { AuditsView } from './components/AuditsView';
import { UsersView } from './components/UsersView';
import { ClusterView } from './components/ClusterView';
import { LoginModal } from './components/LoginModal';
import { getWarehouseCode, setWarehouseCode } from './api/offline-queue';

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState('dashboard');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Core Data States
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<LoaiHang[]>([]);
  const [suppliers, setSuppliers] = useState<NhaCungCap[]>([]);
  const [customers, setCustomers] = useState<KhachHang[]>([]);
  const [warehouses, setWarehouses] = useState<Kho[]>([]);
  const [locations, setLocations] = useState<ViTriLuuTru[]>([]);
  const [inventory, setInventory] = useState<TonKhoItem[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [transfers, setTransfers] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<CanhBao[]>([]);
  const [audits, setAudits] = useState<any[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [readNotifIds, setReadNotifIds] = useState<string[]>([]);
  const [clusterState, setClusterState] = useState<ClusterState | null>(null);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>('');

  const fetchClusterStatus = async () => {
    try {
      const res = await api.get('/cluster/status');
      if (res.data?.data) {
        setClusterState(res.data.data);
      }
    } catch {
      // ignore
    }
  };

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // 1. Initial Load: Check token & fetch initial public data
  useEffect(() => {
    const initAuth = async () => {
      const token = localStorage.getItem('wms_token');
      if (token) {
        try {
          const res = await api.get('/auth/me');
          setCurrentUser(res.data.data);
        } catch (e) {
          localStorage.removeItem('wms_token');
          // Auto login as default admin for seamless initial preview
          handleLogin('admin', 'Admin@123');
        }
      } else {
        // Auto login as demo admin on first launch
        handleLogin('admin', 'Admin@123');
      }
    };
    initAuth();
  }, []);

  // 2. Fetch full data when authenticated
  const fetchAllData = async () => {
    try {
      const [
        dashboardRes,
        prodRes,
        catRes,
        supRes,
        custRes,
        whRes,
        locRes,
        invRes,
        recRes,
        dispRes,
        transRes,
        alertRes,
        notifRes,
      ] = await Promise.all([
        api.get('/inventory/dashboard').catch(() => ({ data: { data: null } })),
        api.get('/products').catch(() => ({ data: { data: [] } })),
        api.get('/products/categories').catch(() => ({ data: { data: [] } })),
        api.get('/products/suppliers').catch(() => ({ data: { data: [] } })),
        api.get('/products/customers').catch(() => ({ data: { data: [] } })),
        api.get('/locations/warehouses').catch(() => ({ data: { data: [] } })),
        api.get('/locations').catch(() => ({ data: { data: [] } })),
        api.get('/inventory').catch(() => ({ data: { data: [] } })),
        api.get('/receipts').catch(() => ({ data: { data: [] } })),
        api.get('/dispatches').catch(() => ({ data: { data: [] } })),
        api.get('/transfers').catch(() => ({ data: { data: [] } })),
        api.get('/inventory/alerts').catch(() => ({ data: { data: [] } })),
        api.get('/notifications').catch(() => ({ data: { data: [] } })),
      ]);

      if (dashboardRes.data.data) setStats(dashboardRes.data.data);
      if (prodRes.data.data) setProducts(prodRes.data.data);
      if (catRes.data.data) setCategories(catRes.data.data);
      if (supRes.data.data) setSuppliers(supRes.data.data);
      if (custRes.data.data) setCustomers(custRes.data.data);
      if (whRes.data.data) setWarehouses(whRes.data.data);
      if (locRes.data.data) setLocations(locRes.data.data);
      if (invRes.data.data) setInventory(invRes.data.data);
      if (recRes.data.data) setReceipts(recRes.data.data);
      if (dispRes.data.data) setDispatches(dispRes.data.data);
      if (transRes.data.data) setTransfers(transRes.data.data);
      if (alertRes.data.data) setAlerts(alertRes.data.data);
      if (notifRes.data.data) setNotifications(notifRes.data.data);
      await fetchClusterStatus();

      if (currentUser?.role === 'ADMIN' || currentUser?.role === 'QUAN_LY_KHO') {
        const auditRes = await api.get('/inventory/audits').catch(() => ({ data: { data: [] } }));
        if (auditRes.data.data) setAudits(auditRes.data.data);
      }

      if (currentUser?.role === 'ADMIN') {
        const usersRes = await api.get('/auth/users').catch(() => ({ data: { data: [] } }));
        if (usersRes.data.data) setUsers(usersRes.data.data);
      }
    } catch (err) {
      console.error('Lỗi nạp dữ liệu:', err);
    }
  };

  useEffect(() => {
    if (currentUser) {
      if (currentUser.role !== 'ADMIN' && currentTab === 'users') {
        setCurrentTab('dashboard');
      }
      const stored = localStorage.getItem(`wms_read_notifs_${currentUser.id}`);
      if (stored) {
        try {
          setReadNotifIds(JSON.parse(stored));
        } catch {
          setReadNotifIds([]);
        }
      } else {
        setReadNotifIds([]);
      }
      fetchAllData();
    }
  }, [currentUser]);

  // Warehouse Switcher: đồng bộ kho đang chọn xuống mọi request (header x-warehouse-code).
  useEffect(() => {
    if (!warehouses.length) return;
    if (!getWarehouseCode()) {
      const first = warehouses[0];
      setSelectedWarehouseId(first.id);
      setWarehouseCode(first.maKho);
    }
  }, [warehouses]);

  const handleSelectWarehouse = (warehouseId: string) => {
    setSelectedWarehouseId(warehouseId);
    const selected = warehouses.find((warehouse) => warehouse.id === warehouseId);
    setWarehouseCode(selected?.maKho || '');
    showToast(selected ? `Đã chuyển sang ${selected.tenKho}` : 'Đang xem toàn bộ hệ thống kho');
    void fetchAllData();
  };

  const handleMarkAllNotificationsRead = (silent = false) => {
    if (!currentUser) return;
    const allIds = notifications.map((n) => n.id);
    setReadNotifIds(allIds);
    localStorage.setItem(`wms_read_notifs_${currentUser.id}`, JSON.stringify(allIds));
    if (!silent) {
      showToast('Đã đánh dấu tất cả thông báo là đã đọc');
    }
  };

  const handleSelectNotification = (item: NotificationItem) => {
    if (!currentUser) return;
    if (!readNotifIds.includes(item.id)) {
      const updated = [...readNotifIds, item.id];
      setReadNotifIds(updated);
      localStorage.setItem(`wms_read_notifs_${currentUser.id}`, JSON.stringify(updated));
    }
    setCurrentTab(item.targetTab);
  };

  // Auth actions
  const handleLogin = async (username: string, pass: string) => {
    const res = await api.post('/auth/login', { username, password: pass });
    localStorage.setItem('wms_token', res.data.data.token);
    setCurrentUser(res.data.data.user);
    showToast(`Đăng nhập thành công với vai trò: ${res.data.data.user.role}`);
  };

  const handleRegister = async (registerData: any) => {
    const res = await api.post('/auth/register', registerData);
    localStorage.setItem('wms_token', res.data.data.token);
    setCurrentUser(res.data.data.user);
    showToast(`Đăng ký thành công! Xin chào ${res.data.data.user.hoTen}`);
    fetchAllData();
  };

  const handleLogout = () => {
    localStorage.removeItem('wms_token');
    setCurrentUser(null);
    showToast('Đã đăng xuất tài khoản');
  };

  // Product actions
  const handleAddProduct = async (data: any) => {
    await api.post('/products', data);
    showToast('Đã thêm sản phẩm mới thành công');
    fetchAllData();
  };

  // Receipt actions
  const handleCreateReceipt = async (data: any) => {
    await api.post('/receipts', data);
    showToast('Đã lập phiếu nhập kho mới (Chờ duyệt)');
    fetchAllData();
  };

  const handleApproveReceipt = async (id: string) => {
    await api.post(`/receipts/${id}/approve`);
    showToast('Đã phê duyệt và cộng tồn kho thành công (Transaction Completed)!');
    fetchAllData();
  };

  const handleRejectReceipt = async (id: string, lyDo?: string) => {
    await api.post(`/receipts/${id}/reject`, { lyDo });
    showToast('Đã từ chối phiếu nhập kho');
    fetchAllData();
  };

  // Dispatch actions
  const handleCreateDispatch = async (data: any) => {
    await api.post('/dispatches', data);
    showToast('Đã lập phiếu xuất kho mới (Tạm giữ tồn khả dụng)');
    fetchAllData();
  };

  const handleApproveDispatch = async (id: string) => {
    await api.post(`/dispatches/${id}/approve`);
    showToast('Đã phê duyệt và trừ tồn kho thành công (Transaction Completed)!');
    fetchAllData();
  };

  const handleRejectDispatch = async (id: string, lyDo?: string) => {
    await api.post(`/dispatches/${id}/reject`, { lyDo });
    showToast('Đã từ chối phiếu xuất và hoàn trả tồn khả dụng');
    fetchAllData();
  };

  // Transfer actions
  const handleCreateTransfer = async (data: any) => {
    await api.post('/transfers', data);
    showToast('Đã lập yêu cầu điều chuyển kho');
    fetchAllData();
  };

  const handleApproveTransfer = async (id: string) => {
    await api.post(`/transfers/${id}/approve`);
    showToast('Đã hoàn tất điều chuyển (Trừ nguồn & Cộng đích)!');
    fetchAllData();
  };

  const handleRejectTransfer = async (id: string, lyDo?: string) => {
    await api.post(`/transfers/${id}/reject`, { lyDo });
    showToast('Đã từ chối phiếu chuyển kho và giải phóng tồn khả dụng tại kho nguồn');
    fetchAllData();
  };

  // Alert actions
  const handleResolveAlert = async (id: string) => {
    await api.post(`/inventory/alerts/${id}/resolve`);
    showToast('Đã đánh dấu xử lý cảnh báo tồn kho');
    fetchAllData();
  };

  // Stock Adjustment action
  const handleAdjustStock = async (data: {
    hangHoaId: string;
    viTriId?: string;
    khoId?: string;
    soLuongMoi: number;
    lyDo: string;
    dieuChinhTongTon?: boolean;
  }) => {
    await api.post('/inventory/adjust', data);
    showToast('Đã điều chỉnh tồn kho thành công (Ghi nhận sổ kho & Audit Log)!');
    fetchAllData();
  };

  // User Management actions (Admin only)
  const handleCreateUser = async (data: any) => {
    await api.post('/auth/users', data);
    showToast('Tạo tài khoản nhân viên mới thành công!');
    fetchAllData();
  };

  const handleToggleUserStatus = async (userId: string) => {
    const res = await api.put(`/auth/users/${userId}/status`);
    showToast(res.data?.message || 'Cập nhật trạng thái nhân viên thành công!');
    fetchAllData();
  };

  const canApprove = currentUser?.role === 'ADMIN' || currentUser?.role === 'QUAN_LY_KHO';
  const canManage = currentUser?.role === 'ADMIN' || currentUser?.role === 'QUAN_LY_KHO' || currentUser?.role === 'NHAN_VIEN_MUA_HANG';
  const activeAlertsCount = alerts.filter((a) => a.trangThai === 'CHUA_XU_LY').length;

  return (
    <div className="flex min-h-screen bg-slate-100 font-sans">
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl shadow-xl text-white text-xs font-bold transition-all animate-in slide-in-from-bottom-3 ${toast.type === 'error' ? 'bg-rose-600' : 'bg-slate-900 border border-slate-700'
          }`}>
          {toast.message}
        </div>
      )}

      {/* Sidebar */}
      <Sidebar
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        userRole={currentUser?.role}
        alertCount={activeAlertsCount}
      />

      {/* Main Container */}
      <div className="flex-1 flex flex-col min-w-0">
        <Header
          user={currentUser}
          onOpenLogin={() => setIsLoginOpen(true)}
          onLogout={handleLogout}
          alertCount={activeAlertsCount}
          onAlertClick={() => setCurrentTab('alerts')}
          notifications={notifications}
          readNotificationIds={readNotifIds}
          onMarkAllNotificationsRead={handleMarkAllNotificationsRead}
          onSelectNotification={handleSelectNotification}
          isFailover={clusterState?.mode === 'SIMULATED_FAILOVER'}
          onClusterClick={() => setCurrentTab('cluster')}
          warehouses={warehouses}
          selectedWarehouseId={selectedWarehouseId}
          onSelectWarehouse={handleSelectWarehouse}
        />

        <main className="p-6 max-w-7xl mx-auto w-full flex-1">
          {currentTab === 'dashboard' && (
            <DashboardView
              stats={stats}
              onNavigate={setCurrentTab}
              userRole={currentUser?.role}
              userName={currentUser?.hoTen}
            />
          )}

          {currentTab === 'products' && (
            <ProductsView
              products={products}
              categories={categories}
              suppliers={suppliers}
              locations={locations}
              onAddProduct={handleAddProduct}
              onAdjustStock={handleAdjustStock}
              canManage={canManage}
            />
          )}

          {currentTab === 'receipts' && (
            <ReceiptsView
              receipts={receipts}
              products={products}
              warehouses={warehouses}
              suppliers={suppliers}
              locations={locations}
              onCreateReceipt={handleCreateReceipt}
              onApproveReceipt={handleApproveReceipt}
              onRejectReceipt={handleRejectReceipt}
              canApprove={canApprove}
            />
          )}

          {currentTab === 'dispatches' && (
            <DispatchesView
              dispatches={dispatches}
              products={products}
              warehouses={warehouses}
              customers={customers}
              locations={locations}
              inventory={inventory}
              onCreateDispatch={handleCreateDispatch}
              onApproveDispatch={handleApproveDispatch}
              onRejectDispatch={handleRejectDispatch}
              canApprove={canApprove}
            />
          )}

          {currentTab === 'transfers' && (
            <TransfersView
              transfers={transfers}
              warehouses={warehouses}
              products={products}
              locations={locations}
              onCreateTransfer={handleCreateTransfer}
              onApproveTransfer={handleApproveTransfer}
              onRejectTransfer={handleRejectTransfer}
              canApprove={canApprove}
            />
          )}

          {currentTab === 'inventory' && (
            <InventoryView
              warehouses={warehouses}
              locations={locations}
              inventory={inventory}
              onAdjustStock={handleAdjustStock}
            />
          )}

          {currentTab === 'cluster' && (
            <ClusterView
              clusterState={clusterState}
              onRefresh={fetchClusterStatus}
              showToast={showToast}
            />
          )}

          {currentTab === 'alerts' && (
            <AlertsView
              alerts={alerts}
              onResolveAlert={handleResolveAlert}
              onNavigateToReceipt={() => setCurrentTab('receipts')}
              canManage={canApprove}
            />
          )}

          {currentTab === 'audits' && (
            <AuditsView audits={audits} />
          )}

          {currentTab === 'users' && currentUser?.role === 'ADMIN' && (
            <UsersView
              users={users}
              currentUserId={currentUser?.id}
              onCreateUser={handleCreateUser}
              onToggleStatus={handleToggleUserStatus}
            />
          )}
        </main>
      </div>

      {/* Login & Role Switcher Modal */}
      <LoginModal
        isOpen={isLoginOpen}
        onClose={() => setIsLoginOpen(false)}
        onLogin={handleLogin}
        onRegister={handleRegister}
      />
    </div>
  );
};

export default App;

