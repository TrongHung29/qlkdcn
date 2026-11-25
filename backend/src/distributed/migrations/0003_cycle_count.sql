-- ============================================================================
-- Migration 0003: Kiểm kê hai chiều (sổ sách vs thực tế) + sinh ADJUSTMENT.
-- Mọi bảng đều có warehouse_id; khóa do tầng ứng dụng sinh (UUIDv7).
-- ============================================================================

CREATE TABLE IF NOT EXISTS stock_counts (
    id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    count_code VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'APPROVED', 'REJECTED')),
    counted_by UUID NOT NULL,
    approved_by UUID,
    counted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (warehouse_id, count_code)
);

CREATE TABLE IF NOT EXISTS stock_count_items (
    id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    count_id UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
    location_id UUID NOT NULL REFERENCES locations(id),
    product_id UUID NOT NULL REFERENCES products(id),
    batch_id UUID REFERENCES batches(id),
    expected_qty NUMERIC(14, 3) NOT NULL CHECK (expected_qty >= 0),
    counted_qty NUMERIC(14, 3) NOT NULL CHECK (counted_qty >= 0),
    difference NUMERIC(14, 3) GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Một ô/lô chỉ xuất hiện một lần trên một phiếu kiểm kê; NULLS NOT DISTINCT
-- để batch_id = NULL được coi là một giá trị cụ thể (giống inventory_balances).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_stock_count_item_slot'
          AND conrelid = 'stock_count_items'::regclass
    ) THEN
        ALTER TABLE stock_count_items
            ADD CONSTRAINT uq_stock_count_item_slot
            UNIQUE NULLS NOT DISTINCT (count_id, location_id, product_id, batch_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stock_counts_warehouse
    ON stock_counts (warehouse_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_count_items
    ON stock_count_items (warehouse_id, count_id);
