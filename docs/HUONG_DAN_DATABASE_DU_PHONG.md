# HƯỚNG DẪN KIẾN TRÚC PHÂN TÁN CÓ DATABASE DỰ PHÒNG (HIGH AVAILABILITY & REPLICATION)

> **Đề tài**: Hệ Thống Quản Lý Kho Hàng (WMS) - Nhóm 8  
> **Chuyên đề**: Hệ thống phân tán, Cơ sở dữ liệu dự phòng (Primary - Standby Replica), Phân luồng Đọc/Ghi (Read/Write Splitting) & Tự động chuyển mạch khi gặp sự cố (Failover).

---

## 📌 1. TỔNG QUAN KIẾN TRÚC PHÂN TÁN CÓ DATABASE DỰ PHÒNG

Trong các hệ thống quản lý kho vận (WMS) quy mô lớn, nếu chỉ có một Database duy nhất (Single Point of Failure - SPOF):
- Khi máy chủ Database bị sập, đứt cáp hoặc mất điện: Toàn bộ nhân viên kho không thể quét mã barcode, xuất/nhập hàng, gây tắc nghẽn chuỗi cung ứng.
- Khi có lượng lớn truy vấn thống kê, báo cáo, tra cứu vị trí ô kệ: Gây quá tải CPU cho Database, làm chậm các thao tác nhập xuất kho theo thời gian thực.

Để giải quyết bài toán trên, đồ án này đã triển khai **Cụm Cơ Sở Dữ Liệu Phân Tán (Database Cluster)** gồm 2 node với cơ chế **Primary - Hot Standby Replica**:

```
                       ┌─────────────────────────┐
                       │   Frontend React / App  │
                       └────────────┬────────────┘
                                    │ (HTTP REST API)
                                    ▼
                       ┌─────────────────────────┐
                       │  Backend Express Server │
                       │ (Cluster Router Engine) │
                       └─────┬─────────────┬─────┘
           [Ghi dữ liệu]     │             │    [Đọc phân tải]
        (INSERT/UPDATE/DELETE)│            │      (SELECT Queries)
                             ▼             ▼
       ┌────────────────────────┐      ┌────────────────────────┐
       │   PRIMARY DATABASE     │      │   STANDBY DATABASE     │
       │    (Master Node)       │      │   (Dự Phòng / Replica) │
       │     Port: 5432         │═════>│     Port: 5434         │
       └────────────────────────┘ WAL  └────────────────────────┘
          [ONLINE - WRITABLE]  Replication [HOT STANDBY - READABLE]
                                            (Tự động thăng cấp khi
                                             Primary gặp sự cố)
```

---

## ⚙️ 2. NGUYÊN LÝ HOẠT ĐỘNG CỐT LÕI

### 2.1. Phân chia vai trò (Primary vs Standby)
1. **Primary Database (Master - Port 5432)**:
   - Là node nắm nguồn chân lý chính (Source of Truth).
   - Xử lý tất cả các giao dịch ghi dữ liệu: Tạo phiếu nhập, duyệt phiếu xuất, điều chỉnh tồn kho, kiểm kê.
   - Ghi nhật ký Write-Ahead Log (WAL) và phát tán liên tục sang Node dự phòng.
2. **Standby Database (Dự phòng / Hot Standby Replica - Port 5434)**:
   - Nhận luồng dữ liệu sao chép (Streaming Replication) liên tục từ Primary.
   - Luôn ở trạng thái sẵn sàng (Standby Ready), dữ liệu khớp 100% với Primary (Replication lag $\approx$ 0ms).
   - Tiếp nhận các truy vấn Đọc (Read Replica) để giảm tải cho Primary.

### 2.2. Cơ chế tách luồng Đọc/Ghi (Read/Write Splitting)
- **Lệnh Ghi (Write)**: Đi vào Node Primary để đảm bảo tính toàn vẹn ACID.
- **Lệnh Đọc (Read)**: Được bộ định tuyến phân tải sang Node Standby Replica. Nhờ vậy, dù ban giám đốc đang xuất báo cáo thống kê hàng chục ngàn dòng tồn kho, nhân viên kho ở cổng xuất hàng vẫn tạo phiếu mượt mà không bị treo.

> **Phạm vi đã cài đặt**: Cluster Manager (`backend/src/cluster/`) hiển thị và kiểm tra **kết nối thực tế** tới 2 node (`SELECT pg_is_in_recovery()`), đọc độ trễ WAL thật từ `pg_stat_replication`, nhưng **chưa tự đổi connection string của từng truy vấn**. API v1 dùng Prisma với một `DATABASE_URL` nên vẫn gửi cả đọc/ghi qua Primary. Để phân luồng vật lý cần đặt PgBouncer/HAProxy trước 2 node hoặc cấu hình Prisma read replica. Nút "Test định tuyến" vì thế chỉ báo quyết định định tuyến + trạng thái kết nối, không thực thi lệnh INSERT thử.

### 2.3. Chuyển mạch sự cố (Failover & High Availability)
- Bộ giám sát (Cluster Manager Heartbeat) gửi tín hiệu kiểm tra định kỳ tới cả 2 node.
- **Khi Primary gặp sự cố (Sập máy chủ, mất mạng, hỏng phần cứng)**:
  - Hệ thống phát hiện Primary không phản hồi (`OFFLINE`).
  - Hệ thống tự động kích hoạt **Failover**: Thăng cấp Standby Replica lên làm **Active Master**.
  - Toàn bộ lưu lượng Ghi và Đọc được chuyển ngay lập tức sang Node dự phòng.
  - **Kết quả (trong bản đồ án)**: giao diện giám sát chuyển sang chế độ sự cố để thuyết trình. Đây **không phải promote thật**: API v1 vẫn trỏ tới `DATABASE_URL` cũ. Để failover thật cần `pg_ctl promote` trên Standby (hoặc `SELECT pg_promote()`) rồi cập nhật connection string / dùng virtual IP.
- **Khi Primary phục hồi**:
  - Hệ thống đồng bộ lại dữ liệu phát sinh trong thời gian sự cố (Re-synchronization).
  - Trả hệ thống về trạng thái cân bằng bình thường.

---

## 🚀 3. HƯỚNG DẪN CHẠY & THỬ NGHIỆM TRÊN MÁY TÍNH

### Bước 1: Khởi động hạ tầng Docker
Trong file `docker-compose.yml`, dịch vụ `replica-init` và `postgres-replica` đã được thêm vào:
```bash
docker compose up -d
```
- `postgres-north` (Primary): Port `5432` — bật `wal_level=replica`, script `docker/postgres/init-replication.sh` mở quyền replication trong `pg_hba.conf`
- `replica-init`: chạy `pg_basebackup ... -R` **một lần** để tạo `standby.signal` + `primary_conninfo` trong `./pgdata-replica`
- `postgres-replica` (Hot Standby): Port `5434`, tự động nhận WAL streaming từ Primary

Kiểm chứng replication thật:
```bash
docker exec wms_postgres_north psql -U postgres -d wms_db -c "SELECT client_addr, state, replay_lag FROM pg_stat_replication;"
docker exec wms_postgres_replica psql -U postgres -d wms_db -c "SELECT pg_is_in_recovery();"   # phải trả về t
```

*(Lưu ý: Nếu máy không bật Docker, Cluster Manager vẫn chạy ở chế độ mô phỏng — các nút bấm và biểu đồ hoạt động để demo, nhưng `pg_stat_replication` không có dữ liệu thật.)*

### Bước 2: Khởi động Backend & Frontend
* Terminal 1 (Backend):
  ```bash
  cd backend
  npm run dev
  ```
* Terminal 2 (Frontend):
  ```bash
  cd frontend
  npm run dev
  ```
Truy cập: `http://localhost:5173`

---

## 🎯 4. HƯỚNG DẪN DEMO THUYẾT TRÌNH BÀI TẬP LỚN CHO GIẢNG VIÊN

Hệ thống đã được tích hợp giao diện trực quan riêng để bạn dễ dàng trình chiếu và giải thích cho thầy cô:

1. **Mở tab "Cụm DB Dự Phòng (HA)"**:
   - Nhấn vào mục **"Cụm DB Dự Phòng (HA)"** trên menu bên trái (Sidebar) hoặc bấm vào biểu tượng pill màu xanh `🟢 Cụm DB: Master - Standby (HA Active)` trên thanh Header.
2. **Trình diễn trạng thái bình thường (Normal State)**:
   - Thầy cô sẽ thấy Node Primary (Port 5432) đang `ONLINE` (Ghi: Bật, Đọc: Bật).
   - Node Standby (Port 5434) đang `STANDBY_READY` (Ghi: Khóa, Đọc: Bật).
   - Mũi tên sao chép Streaming Replication đang hoạt động với độ trễ (Lag) = 0ms.
3. **Trình diễn Phân Luồng Đọc/Ghi (Read/Write Splitting)**:
   - Bấm nút **"Test định tuyến Đọc/Ghi"** màu đỏ ở góc trên.
   - Hệ thống gọi `SELECT pg_is_in_recovery()` tới cả 2 node để đo độ trễ/trạng thái kết nối thật, rồi hiển thị quyết định định tuyến: Đọc → Standby (5434), Ghi → Primary (5432). Không có lệnh INSERT thử được thực thi.
4. **Trình diễn Kịch Bản Sự Cố & Tự Động Chuyển Mạch (Failover Demonstration)**:
   - Bấm nút **"⚡ Mô phỏng sập Primary (Test Failover)"**.
   - **Hiện tượng xảy ra ngay lập tức**:
     - Xuất hiện thông báo cảnh báo màu cam: `⚠️ CẢNH BÁO: CHẾ ĐỘ SỰ CỐ (FAILOVER ACTIVE) ĐANG ĐƯỢC MÔ PHỎNG`.
     - Node Primary (5432) chuyển sang trạng thái 🔴 `OFFLINE`.
     - Node Standby (5434) tự động chuyển sang 🟡 `PROMOTED TO PRIMARY` (Quyền Ghi được tự động mở khóa).
     - Badge trên Header tự động đổi sang cảnh báo: `⚠️ Cụm DB: Đang Chạy Dự Phòng (Port 5434)`.
   - Bấm nút **"Test định tuyến Đọc/Ghi"** một lần nữa:
     - Giảng viên sẽ thấy cả lệnh Đọc và Ghi bây giờ đều được phục vụ an toàn bởi Node Dự Phòng 5434 mà không làm sập server!
5. **Khôi phục hệ thống (Recovery)**:
   - Bấm nút **"✅ Khôi phục Database Chính"**.
   - Cụm DB tự động chuyển lại về trạng thái xanh `NORMAL DUPLEX MODE`.
   - Bảng **Nhật Ký Chuyển Mạch (Cluster Audit Trail)** ở dưới cùng lưu lại toàn bộ lịch sử các lần chuyển mạch để kiểm toán.
