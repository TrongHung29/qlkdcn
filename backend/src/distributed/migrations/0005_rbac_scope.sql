-- ============================================================================
-- Migration 0005: Phân quyền theo kho (warehouse-scoped RBAC).
-- Chỉ tạo bảng trên shard có schema v1 (users/kho). Shard South bỏ qua.
-- LƯU Ý: users.id và kho.id của schema v1 là TEXT (Prisma String), KHÔNG PHẢI UUID.
--        Dùng TEXT để tránh lỗi "foreign key constraint ... incompatible types".
-- ============================================================================

DO $$
BEGIN
    IF to_regclass('public.users') IS NOT NULL AND to_regclass('public.kho') IS NOT NULL THEN
        CREATE TABLE IF NOT EXISTS user_warehouses (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            warehouse_id TEXT NOT NULL REFERENCES kho(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, warehouse_id)
        );

        CREATE INDEX IF NOT EXISTS idx_user_warehouses_warehouse
            ON user_warehouses (warehouse_id);
    END IF;
END $$;
