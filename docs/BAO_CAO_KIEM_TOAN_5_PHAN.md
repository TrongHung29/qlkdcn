# Báo cáo kiểm toán 5 phần & trạng thái vá lỗi

Ngày kiểm toán: 2026-11-24. Phạm vi: đánh giá tĩnh mã nguồn + đối chiếu kết quả smoke/test.
Sau khi có xác nhận "vá tất cả 5 phần", các mục bên dưới đã được triển khai. Trạng thái được ghi
**trung thực**: có mục chỉ giảm thiểu, có mục bị chặn bởi môi trường/thiếu tài liệu.

## 1. Điểm tuân thủ trước khi vá

| Phần | Tiêu chí | [ĐẠT] | [CHƯA ĐẠT] | [THIỆU SÓT NGHIÊM TRỌNG] | Tỷ lệ |
|---|---:|---:|---:|---:|---:|
| Phần 1 — RBAC/kho/6 phân hệ/Switcher | 8 | 4 | 2 | 2 | 50% |
| Phần 2 — 3 chỉ số tồn/FEFO/kiểm kê/đối soát | 8 | 5 | 2 | 1 | 63% |
| Phần 3 — UUIDv7/Sharding/Saga/Offline/Redlock/CQRS | 11 | 7 | 2 | 2 | 64% |
| Phần 4 — Retry/Idempotency/DLQ/Shutdown/Correlation | 9 | 5 | 3 | 1 | 56% |
| Phần 5 — Compose/tests/đối chiếu PDF | 11 | 7 | 2 | 2 | 64% |
| **Toàn hệ thống** | **47** | **28** | **11** | **8** | **≈ 60%** |

## 2. Kết quả vá theo từng gap

### Phần 1

| Gap | Trạng thái | Thay đổi |
|---|---|---|
| P1.1 JWT/User không mang scope kho | **Đã vá** | `0005_rbac_scope.sql` (bảng `user_warehouses`, `TEXT` khớp `users.id`/`kho.id` v1), `auth.service.ts` nhúng `warehouseIds`/`warehouseCodes` vào JWT/profile, `auth.middleware.ts` hiểu 2 claim này, `scripts/seed-warehouse-scope.ts` gán demo 2 kho. |
| P1.2 `/api/v2` không authorize | **Đã vá** | `distributed.routes.ts` dùng `authorize([...])` theo từng endpoint + `warehouseContext()` gọi `canAccessWarehouse()` cho mọi `:code`. Adjustments/chỉ duyệt kiểm kê chỉ `ADMIN, QUAN_LY_KHO`. |
| P1.3 Switcher chỉ là UI | **Đã vá** | `offline-queue.ts` lưu kho active; `api/client.ts` gắn `x-warehouse-code` cho mọi request; `App.tsx` có `handleSelectWarehouse()` gọi lại `fetchAllData()`. |
| P1.4 API v1 một `DATABASE_URL` | **Giảm thiểu, chưa triệt để** | Đã chặn mọi request v1 mang `khoId/khoNguonId/khoDichId` nếu user không có quyền kho đó (`authorizeWarehouse` trong `routes/index.ts`). Tuy nhiên Prisma v1 vẫn dùng một connection string; để tách vật lý cần Prisma read replica/PgBouncer hoặc migrate hẳn sang API v2. |

### Phần 2

| Gap | Trạng thái | Thay đổi |
|---|---|---|
| P2.1 Kiểm kê 2 chiều chỉ có schema | **Đã vá** | `0003_cycle_count.sql` (`stock_counts`, `stock_count_items`, `difference` generated, unique 4 chiều `NULLS NOT DISTINCT`), `cycle-count.service.ts` (lập/duyệt/từ chối; duyệt phát hành `ADJUSTMENT` trong cùng transaction), 4 route `/api/v2/warehouses/:code/cycle-counts...`. |
| P2.2 3 chỉ số tồn v1 không ledger-backed | **Chưa triệt để** | Đã sửa guard làm tròn ô khác về 0 khi còn `soLuongTamGiu` (`services/inventory.service.ts`) để `soLuongKhaDung` không âm. V1 vẫn không ghi `stock_ledger`: cần ánh xạ `hangHoaId ↔ products.id` (khác không gian ID) mới đồng bộ được. **Khuyến nghị dùng API v2 làm luồng ghi chuẩn.** |
| P2.3 Không đối soát ledger định kỳ | **Đã vá** | `reconcileInventory()` so `physical_qty = SUM(qty_delta)` và `reserved_qty = SUM(ACTIVE reservations)`; route `GET /api/v2/warehouses/:code/reconciliation`; job chạy mỗi `RECONCILE_INTERVAL_MS` trong workers. |

### Phần 3

| Gap | Trạng thái | Thay đổi |
|---|---|---|
| P3.1 Legacy v1 sinh UUIDv4 | **Đã vá cho bản ghi mới** | Middleware `prisma.$use` trong `config/prisma.ts` gắn `uuidv7()` cho mọi `create`/`createMany`. Dữ liệu cũ vẫn là UUIDv4 (không tự chuyển). |
| P3.2 Không offline-first, retry đổi key | **Đã vá** | `api/client.ts`: giữ `Idempotency-Key` theo chữ ký request đến khi có response thành công; lỗi mạng giữ key; offline đưa vào `localStorage` queue, `main.tsx` flush khi `online`. Mọi mutate có `X-Correlation-Id` ổn định. |
| P3.3 Không Redlock | **Đã vá** | `infra/redlock.ts` (SET NX PX + Lua release, quorum, retry), gọi qua `withRedlock()` trong `runMutating`. `redis@^4.7.0` đã thêm. Fallback advisory lock khi Redis chết trừ khi `REDLOCK_REQUIRED=true`. |
| P3.4 CQRS chỉ khai báo | **Đã vá một phần** | `infra/read-db.ts` + `getInventorySummary()` đọc từ `DB_REPLICA_URL` (5434) qua route `/inventory/summary`, có fallback primary. API v1 vẫn đọc primary — phân luồng vật lý toàn diện cần PgBouncer/HAProxy. |

### Phần 4

| Gap | Trạng thái | Thay đổi |
|---|---|---|
| P4.1 Idempotency scope theo key | **Đã vá** | `0004_idempotency_scope.sql` đổi PK thành `(warehouse_id, idempotency_key)`; `idempotency.ts` tra/cứu theo cả 2 giá trị. |
| P4.2 DLQ không redrive | **Đã vá** | `rabbitmq.getDlqMessageCount()` / `redriveFromDlq()` (lấy routing key gốc từ `x-death`), route `GET /api/v2/dlq/stats`, `POST /api/v2/dlq/redrive`. |
| P4.3 Graceful shutdown | **Đã vá** | `server.ts` đăng ký `SIGTERM/SIGINT`: `server.close()` → disconnect Prisma/Redlock/read pool/PG pool. `workers/index.ts` đăng ký tín hiệu, dừng relay/consumer/cleaner/reconcile timer. |
| P4.4 Không correlation-id | **Đã vá** | `utils/correlation.ts` (AsyncLocalStorage), `correlation.middleware.ts` đọc/gán `X-Correlation-Id`, `events.ts` nhúng vào `SagaEvent`, consumer RabbitMQ `runWithCorrelationId`, log Saga mang id chung. |

### Phần 5

| Gap | Trạng thái | Thay đổi |
|---|---|---|
| P5.1 Test không qua broker | **Đã vá & đã chạy xanh** | `scripts/test-broker.ts` + `npm run test:broker`: publish qua outbox relay, consumer thật, kiểm tra `COMPLETED`, 1 dòng `TRANSFER_IN`, **không có message mới rơi vào DLQ**. |
| P5.2 Compose chạy được không | **Đã chạy được** | 6 container (`postgres-north/south/replica`, `rabbitmq`, `redis`, `pgadmin`) đều healthy; `docker compose config --quiet` pass. |
| P5.3 Failover mô phỏng đánh lừa UI | **Cải thiện trung thực + script thật** | `cluster.manager.ts` trả `actualWriteTarget`, `failoverNote`, `readWriteSplittingEnabled` theo cấu hình thật; UI hiển thị rõ "ghi thực tế vẫn ở 5432". Thêm `docker/postgres/promote-replica.sh` để promote 5434 thật, sau đó phải đổi `DATABASE_URL`/`DB_NORTH_URL` rồi restart. **Chưa phải failover tự động.** |
| P5.4 Thiếu 2 file PDF | **Bị chặn** | Không tìm thấy `HTTTQL_v2.pdf` / `erd (1).pdf` trong workspace. Cần bạn cung cấp đường dẫn để đối chiếu. |

## 3. Verification đã chạy sau khi vá

```bash
cd backend && npm.cmd run build -- --noEmit   # ✅ pass
cd frontend && npm.cmd run build              # ✅ pass (vite 5.4.21)
npm run db:migrate:distributed                # ✅ 0001..0005 áp cho CẢ 2 shard
npm run db:seed:warehouse-scope               # ✅ 5 user x 2 kho
npm run test:distributed                      # ✅ pass 2 lần liên tiếp
npm run test:broker                           # ✅ pass (RabbitMQ thật)
```

Trong lần chạy đầu sau khi vá, test đồng thời cho kết quả **6/44** và tồn còn 4 — nguyên nhân là
`reserveStockFefoTx()` chỉ retry optimistic locking tối đa 8 lần nên bị sao nhãng khi 50 request
giành cùng một lô. Đã sửa bằng `FOR UPDATE OF ib` trong câu SELECT FEFO: request xếp hàng, đọc lại
`version` mới nhất khi được cấp khóa. Hai lần chạy sau đều đúng **10/40, `physical_qty = 0`**.

Smoke qua HTTP (backend dev + PG portable 5432/5433):

- ✅ `admin/Admin@123` → JWT có `warehouseCodes = KHO-TONG, WH-NORTH-01, WH-SOUTH-01`.
- ✅ `GET /api/v2/warehouses` → 2 kho; `GET .../reconciliation` → 15 balances, **0 mismatch**.
- ✅ Lập phiếu kiểm kê (sổ 4, thực tế 3) → duyệt → 1 `ADJUSTMENT`, đối soát vẫn **0 mismatch**.
- ✅ `nhanvienkho` gọi `POST .../adjustments` → **HTTP 403** (role + scope hoạt động).

Khi chạy broker thật phát hiện thêm lỗi: reply `TransferCompleted/Rejected` được publish tới topic chung nên **cả 2 reply queue** đều nhận bản copy; shard đích cố complete/compensate phiếu không thuộc mình → nack vào DLQ. Đã sửa trong `saga.service.ts`: `handleTransferReply()` xác định shard nguồn qua `fromWarehouseId` + master data replicate và ACK bỏ qua nếu không phải shard của mình. Sau khi sửa, `npm run test:broker` pass hoàn toàn (không có message mới trong DLQ).

Để chạy lại toàn bộ:

```bash
# khởi động 2 PG portable rồi:
cd backend
npm run db:migrate:distributed
npm run db:seed:distributed
npm run db:seed:warehouse-scope
npm run test:distributed
# (có RabbitMQ) npm run test:broker
```

## 4. Endpoint mới

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/v2/warehouses/:code/inventory/summary` | Tổng hợp 3 chỉ số tồn, đọc từ replica nếu có |
| GET | `/api/v2/warehouses/:code/reconciliation` | Đối soát ledger vs tồn |
| POST | `/api/v2/warehouses/:code/cycle-counts` | Lập phiếu kiểm kê 2 chiều |
| GET | `/api/v2/warehouses/:code/cycle-counts/:countId` | Chi tiết phiếu kiểm kê |
| POST | `/api/v2/warehouses/:code/cycle-counts/:countId/approve` | Duyệt, sinh `ADJUSTMENT` |
| POST | `/api/v2/warehouses/:code/cycle-counts/:countId/reject` | Từ chối phiếu |
| GET | `/api/v2/dlq/stats` | Số message trong DLQ |
| POST | `/api/v2/dlq/redrive` | Phát lại message DLQ |

Tất cả response giữ shape `{ success, message, data }`; mọi thông báo/lỗi bằng Tiếng Việt.
