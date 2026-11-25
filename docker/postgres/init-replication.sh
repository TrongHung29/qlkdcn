#!/bin/sh
set -e

# Chạy lần đầu khi postgres-north khởi tạo data directory.
# Cho phép kết nối replication từ mạng nội bộ Docker (scram-sha-256).
cat >> "$PGDATA/pg_hba.conf" <<'EOF'

# HTTT_N8 - Streaming Replication Primary (5432) -> Standby (5434)
host replication all 0.0.0.0/0 scram-sha-256
host replication all ::/0 scram-sha-256
EOF

echo "Da cau hinh pg_hba.conf cho Streaming Replication."
