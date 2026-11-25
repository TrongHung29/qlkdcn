# HỆ THỐNG QUẢN LÝ KHO HÀNG (WAREHOUSE MANAGEMENT SYSTEM - WMS)

> **Nhóm thực hiện**: Nhóm 8 - Đề tài: Hệ thống Quản lý Kho Hàng  
> **Kiến trúc**: Full-Stack Node.js (TypeScript, Express) + PostgreSQL 16 + Prisma ORM + React (TypeScript, Tailwind CSS)  
> **Môi trường**: Docker & Docker Compose (Hỗ trợ chuẩn hóa làm việc nhóm, chống mất mát dữ liệu với persistent volume)
>
> **Bổ sung v2**: Hệ thống có thêm kiến trúc **kho phân tán 2 shard** (`WH-NORTH-01`, `WH-SOUTH-01`) tại `/api/v2/...`, **Lưu trữ CSDL Đa Nguồn (Multi-Source Distributed Storage)** và **Cụm Database dự phòng nóng (Primary - Standby Replica / High Availability / Failover)** có giao diện trực quan trực tiếp trên Dashboard. 
> 
> 📌 **Tài liệu sơ đồ toàn bộ hệ thống**: Xem file [SO_DO_HE_THONG.md](SO_DO_HE_THONG.md) hoặc [docs/SO_DO_HE_THONG.md](docs/SO_DO_HE_THONG.md).  
> 📌 **Hướng dẫn Database dự phòng**: Xem file [docs/HUONG_DAN_DATABASE_DU_PHONG.md](docs/HUONG_DAN_DATABASE_DU_PHONG.md).  
> API v1 và toàn bộ giao diện tiếng Việt hiện tại vẫn giữ nguyên để tương thích và demo.

---

## 📁 1. CẤU TRÚC THƯ MỤC DỰ ÁN

```bash
HTTT/
├── docker-compose.yml          # Cấu hình 2 PostgreSQL 16 + RabbitMQ + Redis + pgAdmin 4
├── .env.example                # Mẫu biến môi trường cho cả nhóm
├── .gitignore                  # Bỏ qua node_modules, pgdata, .env
├── README.md                   # Tài liệu hướng dẫn chi tiết thiết lập & chạy dự án
│
├── backend/                    # Mã nguồn Backend RESTful API
│   ├── .env                    # Cấu hình môi trường riêng của Backend
│   ├── package.json            # Scripts: dev, build, db:migrate, db:push, db:seed, db:studio,
│   │                           #   db:migrate:distributed, db:seed:distributed, workers, test:distributed
│   ├── tsconfig.json
│   ├── prisma/
│   │   ├── schema.prisma       # Thiết kế Database chuẩn hóa theo ERD/DFD (14 bảng, 6 enums)
│   │   └── seed.ts             # Script nạp dữ liệu mẫu ban đầu (Auto-seeding)
│   ├── scripts/                # migrate/seed/test distributed (ts-node)
│   └── src/
│       ├── config/prisma.ts    # Singleton Prisma Client
│       ├── controllers/        # Điều hướng API (Auth, Product, Receipt, Dispatch, Transfer, Inventory, Location)
│       ├── services/           # Nghiệp vụ Transaction (Cộng/Trừ tồn kho an toàn)
│       ├── routes/             # Định tuyến RESTful API
│       ├── middlewares/        # JWT Authentication & RBAC (Role-based access control)
│       ├── utils/              # Helper responses & auto code generators
│       ├── distributed/        # KIẾN TRÚC v2: SQL chuẩn, FEFO, Outbox/Inbox, Saga, workers
│       │   ├── migrations/     # 0001 schema + 0002 chuẩn hóa unique constraint
│       │   ├── services/       # inventory / orders / transfer / saga
│       │   ├── infra/          # RabbitMQ ConfirmChannel + DLX/DLQ
│       │   ├── workers/        # outbox relay, reservation expiry, saga consumers
│       │   └── routes/         # API v2 mounted tại /api/v2
│       └── server.ts           # Server khởi chạy tại cổng 5000
│
└── frontend/                   # Giao diện người dùng (React 18, TypeScript, Tailwind CSS)
    ├── package.json            # Scripts: dev (cổng 5173), build
    ├── vite.config.ts          # Reverse proxy kết nối API backend tự động
    ├── tailwind.config.js
    └── src/
        ├── components/         # Dashboard, Hàng hóa, Nhập kho, Xuất kho, Điều chuyển, Sơ đồ vị trí, Cảnh báo
        ├── types/              # Type definitions đồng bộ với Backend
        └── App.tsx             # Giao diện chính và luồng xử lý
```

---

## 🚀 2. HƯỚNG DẪN KHỞI CHẠY HỆ THỐNG (DÀNH CHO THÀNH VIÊN TRONG NHÓM)

### BƯỚC 1: Khởi động hạ tầng qua Docker Compose
1. Đảm bảo **Docker Desktop** trên máy tính đã được bật (cần bật virtualization/WSL2 trong BIOS).
2. Tại thư mục gốc dự án, mở terminal chạy lệnh:
   ```bash
   docker compose up -d
   ```
   Compose sẽ khởi động:
   - `postgres-north`: shard `WH-NORTH-01` / Primary tại cổng **5432**
   - `postgres-south`: shard `WH-SOUTH-01` tại cổng **5433**
   - `replica-init` → `postgres-replica`: Hot Standby tại cổng **5434**, tạo bằng `pg_basebackup` và nhận WAL streaming từ `postgres-north`
   - `rabbitmq`: AMQP **5672**, giao diện quản trị **15672**
   - `redis`: **6379** (tùy chọn, cache không phải nguồn chân lý)
   - `pgadmin`: **5050** (tùy chọn)

> **Đảm bảo toàn vẹn dữ liệu**: Dữ liệu được mount vào `./pgdata-north`, `./pgdata-south`, `./rabbitmq-data`, `./redis-data` trên ổ đĩa máy tính, không mất khi khởi động lại máy hoặc xóa container.

> **Lưu ý máy hiện tại**: virtualization/WSL2 đang tắt nên Docker Desktop không chạy được (`HCS_E_HYPERV_NOT_INSTALLED`). Các bước migration/seed/test phía dưới đã được kiểm chứng bằng 2 cụm PostgreSQL portable tại cổng 5432/5433; file `docker-compose.yml` vẫn chuẩn để dùng trên máy có Docker.

*(Tùy chọn) Truy cập pgAdmin tại `http://localhost:5050` (Email: `admin@wms.com` | Password: `admin`) hoặc RabbitMQ Management tại `http://localhost:15672` (`guest`/`guest`).*

---

### BƯỚC 2: Thiết lập Database và nạp dữ liệu mẫu (Seeding)
Mở terminal, di chuyển vào thư mục `backend`:
```bash
cd backend
npm install
npx prisma db push
npm run db:seed
```

Nếu dùng kiến trúc phân tán v2, chạy thêm (sau khi đã `npx prisma db push`/seed cho giao diện v1):
```bash
npm run db:migrate:distributed   # áp 0001..0005 cho CẢ 2 shard
npm run db:seed:distributed      # master data + WH-NORTH-01 / WH-SOUTH-01 + tồn mẫu
npm run db:seed:warehouse-scope  # gán user v1 vào 2 kho (JWT warehouse scope)
```

Script Seeding v1 sẽ tự động nạp sẵn:
- **5 tài khoản kiểm thử** (Mật khẩu băm Bcrypt an toàn):
  1. Quản trị viên (Admin): `admin` / `Admin@123`
  2. Quản lý kho (Manager): `quanlykho` / `Quanly@123`
  3. Nhân viên kho (Staff): `nhanvienkho` / `Nhanvien@123`
  4. Nhân viên mua hàng: `muahang` / `Muahang@123`
  5. Nhân viên kinh doanh: `banhang` / `Banhang@123`
- **Kho bãi & Sơ đồ phân cấp 5 tầng**: Kho Tổng Hà Nội, Kho TP.HCM với đầy đủ Khu vực, Kệ, Tầng, Ô lưu trữ.
- **Hàng hóa, Danh mục, Nhà cung cấp, Khách hàng & Tồn kho thực tế**.
- **Cảnh báo tồn kho mẫu** (Sản phẩm dưới định mức tối thiểu).
- **Phiếu nhập mẫu & Phiếu xuất mẫu** ở trạng thái `PENDING` để bạn có thể test ngay nút **Phê Duyệt** trên giao diện!

---

### BƯỚC 3: Khởi chạy Backend API Server
Vẫn trong thư mục `backend`, chạy:
```bash
npm run dev
```
Backend API sẽ hoạt động tại: **`http://localhost:5000`** (Healthcheck: `http://localhost:5000/api/health`).

Để chạy đầy đủ v2 (outbox relay + hết hạn reservation + consumer Saga), mở terminal khác:
```bash
npm run workers
```
> Khi chưa có RabbitMQ, vẫn có thể chạy kiểm thử nghiệp vụ bằng `npm run test:distributed` (consumer được gọi trực tiếp). Với broker thật chạy `npm run test:broker` (outbox → RabbitMQ → inbox end-to-end). Redis/Redlock là tùy chọn: nếu không đạt quorum, hệ thống fallback về advisory lock của Postgres và in cảnh báo; đặt `REDLOCK_REQUIRED=true` để chặn request khi không có khóa phân tán.

---

### BƯỚC 4: Khởi chạy Frontend Dashboard
Mở một cửa sổ terminal mới, di chuyển vào thư mục `frontend`:
```bash
cd frontend
npm install
npm run dev
```
Trình duyệt sẽ tự động mở giao diện tại: **`http://localhost:5173`**.

---

## ⚙️ 3. LUỒNG NGHIỆP VỤ & RÀNG BUỘC TRANSACTION ĐÃ THỰC THI

> Phần này mô tả luồng **API v1 / giao diện hiện tại** (Prisma, một database). Kiến trúc phân tán v2 với 10 invariant được trình bày ở mục 4 bên dưới.

1. **Phân hệ Hàng hóa & Định mức**:
   - Quản lý định mức tối thiểu (`dinhMucToiThieu`) và tối đa (`dinhMucToiDa`).
2. **Quy trình Nhập kho**:
   - Lập phiếu nhập ở trạng thái `PENDING` kèm thông tin chỉ định cất vào Ô lưu trữ (`viTriId`).
   - Quản lý kho nhấn **"Phê duyệt"** &rarr; Hệ thống kích hoạt **Database Transaction** (`prisma.$transaction`) để:
     - Tăng số lượng thực tế và khả dụng trong `TonKho`.
     - Cập nhật trạng thái ô lưu trữ sang `PARTIAL` hoặc `FULL`.
     - Tự động kiểm tra và giải tỏa cảnh báo thiếu hàng nếu số lượng đã đạt chuẩn.
     - Ghi nhật ký kiểm toán `LichSuThaoTac`.
3. **Quy trình Xuất kho**:
   - Kiểm tra điều kiện tồn kho thực tế trước khi lập phiếu.
   - Khi lập phiếu, tạm giữ tồn khả dụng (`soLuongTamGiu += SL`, `soLuongKhaDung -= SL`).
   - Quản lý kho nhấn **"Phê duyệt"** &rarr; Hệ thống kích hoạt **Database Transaction**:
     - Kiểm tra tồn thực tế lần cuối & trừ tồn kho (`soLuongTon -= SL`).
     - Tự động quét điều kiện: nếu số lượng tồn kho giảm xuống dưới `dinhMucToiThieu` hoặc `= 0`, hệ thống **tự động sinh Cảnh Báo Tồn Kho** ngay lập tức!
     - Nếu bị Từ chối, tự động hoàn trả số lượng tạm giữ vào tồn khả dụng.
4. **Quy trình Chuyển kho**:
   - Trừ tồn kho nguồn và cộng tồn kho đích bằng Transaction liên kho.
5. **Sơ đồ Vị trí Trực quan (Storage Grid Visualizer)**:
   - Hiển thị trực quan toàn bộ các ô kệ trong kho theo tỷ lệ lấp đầy %, mã vị trí và danh sách sản phẩm nằm bên trong khi click chọn ô.

---

## 🏗️ 4. KIẾN TRÚC KHO PHÂN TÁN v2 (2 SHARD)

### 4.1. Tổng quan

API v2 được mount tại **`/api/v2`**, chạy song song với API v1, **không làm thay đổi** endpoint, response shape `{ success, message, data, meta }`, field contract tiếng Việt hay luồng auto-login `admin/Admin@123` của frontend.

- **2 shard độc lập**: `WH-NORTH-01` (`:5432`) và `WH-SOUTH-01` (`:5433`). Master data (kho, SKU, lô) được nhân bản; dữ liệu tồn kho/phiếu chỉ nằm ở shard của kho đó.
- **Không dùng Prisma cho schema v2**: dùng raw SQL + `pg` vì cần `generated column`, `NULLS NOT DISTINCT`, partial index, `CHECK` và trigger append-only – Prisma 5 không biểu diễn được.
- **UUIDv7 do tầng ứng dụng sinh** (`uuidv7` npm). DB không có `DEFAULT` sinh khóa, tránh collision khi gộp shard.
- **Không 2PC**: điều chuyển liên kho dùng Saga có `IN_TRANSIT`, outbox, inbox và compensating transaction.

### 4.2. 10 invariant đã áp dụng

| # | Invariant | Cách thực thi trong code/SQL |
|---|---|---|
| 1 | UUIDv7 ở app layer | `src/distributed/uuid.ts`; mọi `id` đều `newId()` |
| 2 | `warehouse_id` ở mọi bảng operational | Có ở `inventory_balances`, `reservations`, `stock_orders`, `stock_order_items`, `stock_ledger`, `stock_transfers`, `stock_transfer_items`, `outbox_events`, `processed_events`, `idempotency_keys` |
| 3 | Tồn không âm | `CHECK (physical_qty >= 0 AND reserved_qty >= 0 AND physical_qty >= reserved_qty)` |
| 4 | Unique 4 chiều | `CONSTRAINT uq_inventory_slot UNIQUE NULLS NOT DISTINCT (warehouse_id, location_id, product_id, batch_id)` |
| 5 | Tách 3 loại tồn | `physical_qty`, `reserved_qty`, `available_qty GENERATED ALWAYS AS (physical - reserved) STORED` |
| 6 | Optimistic locking | Mọi `UPDATE` tồn kèm `AND version = $expected`; lệch → `STALE_VERSION` (409) |
| 7 | Ledger append-only, correction = ADJUSTMENT | Trigger `BEFORE UPDATE OR DELETE ON stock_ledger` chặn sửa/xóa; `adjustStock()` ghi `qty_delta` mới |
| 8 | FEFO + loại lô hỏng | `ORDER BY expiry_date ASC NULLS LAST`, chỉ lấy lô `AVAILABLE`, ô `is_pickable = TRUE` |
| 9 | Không 2PC, bắt buộc `IN_TRANSIT` | `dispatchTransfer()` chỉ trừ nguồn + ghi outbox trong 1 local tx, status `IN_TRANSIT`; đích nhận hàng ở tx riêng |
| 10 | Idempotency + outbox atomic + inbox | `Idempotency-Key` lưu trong **cùng transaction** nghiệp vụ; outbox publish với `ConfirmChannel`; `processed_events` chặn event trùng |

### 4.3. API v2 (bắt buộc JWT + `Idempotency-Key` cho mutate)

| Method | Endpoint | Mục đích |
|---|---|---|
| `GET` | `/api/v2/warehouses` | Danh sách kho đã nhân bản ở cả 2 shard |
| `GET` | `/api/v2/warehouses/:code/inventory` | Tồn theo shard/lô/hạn dùng |
| `POST` | `/api/v2/warehouses/:code/inbound` | Nhập kho, cộng tồn + ledger |
| `POST` | `/api/v2/warehouses/:code/orders/outbound` | Đặt trước FEFO |
| `POST` | `/api/v2/warehouses/:code/orders/:orderId/fulfill` | Tiêu thụ reservation, trừ tồn + ledger |
| `POST` | `/api/v2/warehouses/:code/outbound/quick` | Xuất nhanh (dùng cho test đồng thời) |
| `POST` | `/api/v2/warehouses/:code/adjustments` | Điều chỉnh bằng ADJUSTMENT |
| `POST` | `/api/v2/transfers` | Lập phiếu điều chuyển + giữ chỗ nguồn |
| `POST` | `/api/v2/transfers/:id/dispatch` | Chuyển `IN_TRANSIT`, ghi `TransferDispatched` vào outbox |
| `GET` | `/api/v2/transfers/:id` | Trạng thái phiếu điều chuyển |
| `GET` | `/api/v2/outbox` / `POST` | Xem / chạy một lượt outbox relay |

Ví dụ:
```bash
curl -X POST http://localhost:5000/api/v2/warehouses/WH-NORTH-01/outbound/quick \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: px-2026-0001" \
  -H "Content-Type: application/json" \
  -d '{"productId":"<uuidv7>","qty":1}'
```
Gửi lại đúng key trên → response cũ được replay, không trừ tồn lần hai.

### 4.4. Saga điều chuyển liên kho

1. **A dispatch** (local tx): reservation → `TRANSFER_OUT` ledger → `IN_TRANSIT` → `TransferDispatched` vào outbox.
2. **Outbox relay**: `FOR UPDATE SKIP LOCKED`, publish topic `transfer.TransferDispatched`, confirm rồi mới đánh `PUBLISHED`.
3. **B inbound**: kiểm tra `processed_events`; nếu SKU hợp lệ → `TRANSFER_IN` ledger + outbox `TransferCompleted`; nếu từ chối → `TransferRejected`.
4. **A reply**: `COMPLETED` hoặc compensation cộng lại tồn + ledger `ADJUSTMENT` dương, phiếu → `CANCELLED`.
5. Event trùng bị Inbox chặn; lỗi hạ tầng đi DLX/DLQ `warehouse.saga.dead-letter`.

### 4.5. Kiểm thử đã chạy

```bash
cd backend
npm run build -- --noEmit
npm run db:migrate:distributed
npm run db:seed:distributed
npm run test:distributed
npm run test:broker          # cần RabbitMQ đang chạy
```

Kết quả thực tế (PostgreSQL portable, 2 shard 5432/5433):

- ✅ **50 request xuất kho đồng thời / 10 item tồn** → đúng **10 thành công, 40 bị từ chối**, `physical_qty = 0`, không có phiếu `PICKING` sót sau rollback.
- ✅ **SUM(qty_delta) = physical_qty** cả sau xuất kho lẫn sau compensation.
- ✅ **Transfer bị kho B từ chối** → kho A hoàn lại đúng 5 đơn vị, ledger ghi `ADJUSTMENT` dương, phiếu `CANCELLED`, kho B không cộng tồn.
- ✅ Duplicate event bị `processed_events` chặn ở cả kho đích và kho nguồn.

> `npm run test:distributed` gọi trực tiếp consumer/handler (không cần broker). `npm run test:broker` kiểm chứng luồng publish/confirm/DLX thật với RabbitMQ — **đã chạy xanh** khi cả 6 container Docker đều healthy. Xem `docs/BAO_CAO_KIEM_TOAN_5_PHAN.md` để biết hạng mục nào đã vá và hạng mục nào còn là mô phỏng.

### 4.6. Các file chính

- `backend/src/distributed/migrations/0001_distributed_schema.sql`, `0002_fix_inventory_slot_constraint.sql`
- `backend/src/distributed/services/inventory.service.ts` (reserve/consume FEFO, adjust, expiry)
- `backend/src/distributed/services/transfer.service.ts` (dispatch/compensate)
- `backend/src/distributed/services/saga.service.ts` (B inbound + A reply, inbox)
- `backend/src/distributed/infra/rabbitmq.ts`, `backend/src/distributed/workers/*`
- `backend/src/distributed/routes/distributed.routes.ts`
- `backend/scripts/{migrate-distributed,seed-distributed,test-distributed}.ts`
