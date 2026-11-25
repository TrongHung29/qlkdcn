-- ============================================================================
-- HTTT_N8 - KIẾN TRÚC KHO PHÂN TÁN
-- Migration 0001: Schema chuẩn cho 2 shard (WH-NORTH-01 / WH-SOUTH-01)
-- PostgreSQL 15+ (đã kiểm chứng với PostgreSQL 16)
-- QUY ƯỚC: UUIDv7 do tầng ứng dụng sinh; DB KHÔNG sinh khóa tự động.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- GROUP 1: MASTER DATA (nhân bản ở mọi shard)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouses (
    id UUID PRIMARY KEY,
    code VARCHAR(32) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    shard_region VARCHAR(32) NOT NULL,
    address TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS locations (
    id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    code VARCHAR(64) NOT NULL,
    location_type VARCHAR(24) NOT NULL CHECK (
        location_type IN ('RECEIVING', 'STORAGE', 'PICKING', 'DAMAGED', 'IN_TRANSIT')
    ),
    max_capacity NUMERIC(14, 3),
    is_pickable BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (warehouse_id, code)
);

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY,
    sku VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    uom VARCHAR(20) NOT NULL,
    tracking_type VARCHAR(20) NOT NULL DEFAULT 'BATCH'
        CHECK (tracking_type IN ('NONE', 'BATCH')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS batches (
    id UUID PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES products(id),
    batch_number VARCHAR(64) NOT NULL,
    manufactured_date DATE,
    expiry_date DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE'
        CHECK (status IN ('AVAILABLE', 'QUARANTINE', 'EXPIRED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (product_id, batch_number)
);

CREATE INDEX IF NOT EXISTS idx_batches_fefo ON batches (product_id, expiry_date ASC NULLS LAST);

-- ----------------------------------------------------------------------------
-- GROUP 2: TỒN KHO & ĐẶT TRƯỚC (shard theo warehouse_id)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_balances (
    id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    location_id UUID NOT NULL REFERENCES locations(id),
    product_id UUID NOT NULL REFERENCES products(id),
    batch_id UUID REFERENCES batches(id),
    physical_qty NUMERIC(14, 3) NOT NULL DEFAULT 0,
    reserved_qty NUMERIC(14, 3) NOT NULL DEFAULT 0,
    available_qty NUMERIC(14, 3) GENERATED ALWAYS AS (physical_qty - reserved_qty) STORED,
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_stock_non_negative CHECK (
        physical_qty >= 0 AND reserved_qty >= 0 AND physical_qty >= reserved_qty
    )
);

-- Dùng UNIQUE CONSTRAINT (không phải index thường) để code có thể dùng
-- ON CONFLICT ON CONSTRAINT uq_inventory_slot.
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

CREATE INDEX IF NOT EXISTS idx_inventory_lookup
    ON inventory_balances (warehouse_id, product_id, available_qty);

CREATE TABLE IF NOT EXISTS inventory_reservations (
    id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    balance_id UUID NOT NULL REFERENCES inventory_balances(id),
    reference_type VARCHAR(32) NOT NULL CHECK (
        reference_type IN ('OUTBOUND_ORDER', 'STOCK_TRANSFER')
    ),
    reference_id UUID NOT NULL,
    qty NUMERIC(14, 3) NOT NULL CHECK (qty > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'FULFILLED', 'RELEASED')),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reservations_ref
    ON inventory_reservations (warehouse_id, reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_reservations_expiry
    ON inventory_reservations (status, expires_at)
    WHERE status = 'ACTIVE';

-- ----------------------------------------------------------------------------
-- GROUP 3: PHIẾU & SỔ NHẬT KÝ KHÔNG THAY ĐỔI (shard theo warehouse_id)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_orders (
    id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    order_code VARCHAR(50) NOT NULL,
    order_type VARCHAR(20) NOT NULL CHECK (
        order_type IN ('INBOUND', 'OUTBOUND', 'ADJUSTMENT')
    ),
    status VARCHAR(24) NOT NULL DEFAULT 'DRAFT' CHECK (
        status IN ('DRAFT', 'CONFIRMED', 'PICKING', 'COMPLETED', 'CANCELLED')
    ),
    partner_name VARCHAR(150),
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (warehouse_id, order_code)
);

CREATE TABLE IF NOT EXISTS stock_order_items (
    id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    order_id UUID NOT NULL REFERENCES stock_orders(id),
    product_id UUID NOT NULL REFERENCES products(id),
    batch_id UUID REFERENCES batches(id),
    location_id UUID REFERENCES locations(id),
    expected_qty NUMERIC(14, 3) NOT NULL CHECK (expected_qty > 0),
    actual_qty NUMERIC(14, 3) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_ledger (
    id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    location_id UUID NOT NULL REFERENCES locations(id),
    product_id UUID NOT NULL REFERENCES products(id),
    batch_id UUID REFERENCES batches(id),
    movement_type VARCHAR(24) NOT NULL CHECK (
        movement_type IN ('INBOUND', 'OUTBOUND', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT')
    ),
    qty_delta NUMERIC(14, 3) NOT NULL,
    balance_after NUMERIC(14, 3) NOT NULL,
    reference_type VARCHAR(32) NOT NULL,
    reference_id UUID NOT NULL,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_audit
    ON stock_ledger (warehouse_id, product_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- GROUP 4: ĐIỀU CHUYỂN LIÊN KHO & HẠ TẦNG PHÂN TÁN
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_transfers (
    id UUID PRIMARY KEY,
    -- Chủ sở hữu shard của phiếu điều chuyển (luôn là kho nguồn).
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    transfer_code VARCHAR(50) UNIQUE NOT NULL,
    from_warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    to_warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    status VARCHAR(24) NOT NULL DEFAULT 'REQUESTED' CHECK (
        status IN (
            'REQUESTED', 'APPROVED', 'IN_TRANSIT',
            'PARTIAL_RECEIVED', 'COMPLETED', 'CANCELLED'
        )
    ),
    created_by UUID NOT NULL,
    dispatched_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_different_warehouses CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
    id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    transfer_id UUID NOT NULL REFERENCES stock_transfers(id),
    product_id UUID NOT NULL REFERENCES products(id),
    batch_id UUID REFERENCES batches(id),
    requested_qty NUMERIC(14, 3) NOT NULL CHECK (requested_qty > 0),
    shipped_qty NUMERIC(14, 3) NOT NULL DEFAULT 0,
    received_qty NUMERIC(14, 3) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    aggregate_type VARCHAR(50) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON outbox_events (status, created_at ASC) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS processed_events (
    event_id UUID PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    consumer_name VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key VARCHAR(128) PRIMARY KEY,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    response_code INT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- RÀNG BUỘC APPEND-ONLY (DB-level, không chỉ là quy ước trong code)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_reject_append_only_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Bảng % là sổ nhật ký append-only: không cho phép UPDATE/DELETE',
        TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_ledger_append_only ON stock_ledger;
CREATE TRIGGER trg_stock_ledger_append_only
    BEFORE UPDATE OR DELETE ON stock_ledger
    FOR EACH ROW EXECUTE FUNCTION fn_reject_append_only_mutation();

CREATE OR REPLACE FUNCTION fn_reject_completed_order_mutation() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'COMPLETED' THEN
        RAISE EXCEPTION
            'Phiếu % đã hoàn tất: không cho phép UPDATE/DELETE (phát hành ADJUSTMENT mới)',
            OLD.order_code
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_completed_order_immutable ON stock_orders;
CREATE TRIGGER trg_completed_order_immutable
    BEFORE UPDATE OR DELETE ON stock_orders
    FOR EACH ROW EXECUTE FUNCTION fn_reject_completed_order_mutation();
