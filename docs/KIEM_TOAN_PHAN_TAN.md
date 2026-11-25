# BÁO CÁO KIỂM TOÁN CHUYỂN ĐỔI SANG KHO PHÂN TÁN

> Phạm vi: `backend/prisma/schema.prisma`, `backend/src/services/*`, `backend/src/routes/*`, frontend React 18 (`frontend/src/**`), `docker-compose.yml`, `.env.example`, `README.md`.
> Mục tiêu: đối chiếu 10 invariant của đặc tả AI Engineering trước khi triển khai kiến trúc v2.

---

## 1. Hiện trạng trước khi chuyển đổi

| Hạng mục | Kết quả audit |
|---|---|
| Schema legacy | 19 model Prisma, 8 enum; khóa chính `String @default(uuid())` → **UUID v4** |
| Phân tán | Không có `warehouse_id`; chỉ có `khoId` dạng text. 5 bảng chi tiết (phiếu nhập/xuất/chuyển, tồn, alert...) **không có cả `khoId`** |
| Ràng buộc tồn | Không có `CHECK` DB; unique tồn chỉ 3 chiều `(khoId, viTriId, hangHoaId)`; không phân biệt lô |
| Tồn kho | Một trường `soLuongTon` kiểu Int, vừa physical vừa available; `soLuongTamGiu` dễ lệch |
| Kiểm soát đồng thời | Không có `version`; `dispatch.service.ts` reserve/fulfill chỉ đọc rồi ghi, có thể over-book |
| Nhật ký | Không có `stock_ledger`; `inventory.service.ts` adjust ghi đè tồn, mất lịch sử |
| FEFO | Không có bảng `batches`, không có `expiry_date`, không loại `QUARANTINE/EXPIRED` |
| Điều chuyển | `transfer.service.ts` trừ nguồn + cộng đích trong **một `$transaction`** → vi phạm "không 2PC", không có `IN_TRANSIT` |
| Idempotency | Không có `Idempotency-Key`, không có bảng lưu response |
| Outbox/Inbox | Không có `outbox_events`, `processed_events`; publish/ghi DB không atomic |
| Hạ tầng | `docker-compose.yml` chỉ có 1 PostgreSQL + pgAdmin; không RabbitMQ/Redis |
| Frontend | 13 component giữ toàn bộ chuỗi tiếng Việt; auto-login `admin/Admin@123`; axios `baseURL '/api'`; response đọc `res.data.data` |

## 2. Quyết định thiết kế

1. **Không đập API v1**: mount v2 tại `/api/v2`, giữ nguyên `/api/...`, shape `{success,message,data,meta}` và mọi field contract (`khoId`, `soLuongTon`, `soLuongKhaDung`, `soLuongTamGiu`, ...).
2. **Không dùng Prisma cho v2**: Prisma 5 không biểu diễn được generated column, `NULLS NOT DISTINCT`, partial index, CHECK và trigger append-only → dùng raw SQL + `pg`.
3. **UUIDv7 tại app** (`uuidv7` npm), DB không sinh default.
4. **Master data nhân bản**, dữ liệu nghiệp vụ shard theo `warehouse_id`.
5. **Idempotency lưu trong DB**, cùng transaction với nghiệp vụ + outbox (không dùng Redis làm nguồn chân lý).
6. **Saga thay 2PC**, trạng thái `IN_TRANSIT` bắt buộc, compensation bằng `ADJUSTMENT`.

## 3. Ánh xạ invariant → code

| Invariant | Nơi thực thi |
|---|---|
| UUIDv7 app-layer | `src/distributed/uuid.ts` |
| `warehouse_id` mọi bảng | `migrations/0001_distributed_schema.sql` |
| `CHECK physical/reserved` | `inventory_balances.chk_stock_non_negative` |
| Unique 4 chiều NULLS NOT DISTINCT | `uq_inventory_slot` (0001 + 0002) |
| 3 trường tồn tách biệt | `available_qty GENERATED ALWAYS AS (...) STORED` |
| Optimistic locking | `version` + `AND version = $expected` trong `inventory.service.ts` |
| Ledger append-only | trigger `trg_stock_ledger_append_only`; `adjustStock()` ghi `ADJUSTMENT` |
| FEFO | `reserveStockFefo()` ORDER BY `expiry_date ASC NULLS LAST`, lọc `AVAILABLE` |
| Không 2PC / `IN_TRANSIT` | `dispatchTransfer()` + `services/saga.service.ts` |
| Idempotency + outbox + inbox | `idempotency.ts`, `events.ts`, `workers/*`, `processed_events` |

## 4. Kết quả kiểm chứng

Xem `README.md` mục 4.5 và `backend/scripts/test-distributed.ts`:

- 50 request đồng thời / 10 tồn → 10 success, 40 fail, `physical_qty = 0`.
- `SUM(qty_delta) = physical_qty` sau xuất kho và sau compensation.
- Transfer bị kho B từ chối → kho A hoàn tồn, phiếu `CANCELLED`, event trùng bị Inbox chặn.

**Giới hạn môi trường**: Docker/WSL2 virtualization bị tắt trên máy hiện tại; các test chạy với 2 PostgreSQL portable. RabbitMQ/Redis chưa khởi động được, nên consumer Saga được gọi trực tiếp trong test; cấu hình ConfirmChannel/DLX/DLQ và outbox relay đã được cài sẵn.
