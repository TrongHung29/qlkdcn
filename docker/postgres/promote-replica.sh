#!/bin/sh
# =============================================================================
# Failover THẬT cho cụm WMS: promote Hot Standby (5434) thành Primary.
# Sau khi chạy script này, CẦN đổi connection string và restart backend/workers:
#   DATABASE_URL=...localhost:5434/wms_db
#   DB_NORTH_URL=...localhost:5434/wms_db
#   DB_REPLICA_URL= (xóa hoặc trỏ tới standby mới)
#   docker compose restart backend   (hoặc npm run dev / npm run workers)
# Nút "Mô phỏng sập Primary" trên UI chỉ đổi nhãn/log, KHÔNG gọi script này.
# =============================================================================
set -e

CONTAINER="${REPLICA_CONTAINER:-wms_postgres_replica}"
DATA_DIR="${PGDATA:-/var/lib/postgresql/data}"

echo "[Failover] Đang promote Hot Standby trong container $CONTAINER ..."
docker exec "$CONTAINER" pg_ctl -D "$DATA_DIR" promote

echo "[Failover] Chờ standby kết thúc recovery..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec "$CONTAINER" psql -U postgres -d wms_db -tAc \
      "SELECT CASE WHEN pg_is_in_recovery() THEN 'STANDBY' ELSE 'PRIMARY' END" \
      | grep -q 'PRIMARY'; then
    echo "[Failover] ✅ Node 5434 đã thành PRIMARY, sẵn sàng nhận ghi."
    exit 0
  fi
  sleep 1
done

echo "[Failover] ⚠️  Chưa xác nhận được trạng thái PRIMARY. Kiểm tra log container."
exit 1
