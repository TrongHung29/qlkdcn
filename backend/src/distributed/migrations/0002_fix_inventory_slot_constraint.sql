-- Migration 0002: chuẩn hóa unique 4 chiều thành CONSTRAINT.
-- Nếu shard đã chạy bản 0001 cũ (tạo INDEX thay vì CONSTRAINT), migration này
-- sẽ thay thế index bằng constraint tương đương NULLS NOT DISTINCT.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_inventory_slot'
          AND conrelid = 'inventory_balances'::regclass
    ) THEN
        DROP INDEX IF EXISTS uq_inventory_slot;
        ALTER TABLE inventory_balances
            ADD CONSTRAINT uq_inventory_slot
            UNIQUE NULLS NOT DISTINCT (warehouse_id, location_id, product_id, batch_id);
    END IF;
END $$;
