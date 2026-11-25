-- ============================================================================
-- Migration 0004: Idempotency-Key chỉ được replay trong CÙNG kho.
-- Khóa chính cũ là (idempotency_key) -> cùng key ở kho khác sẽ trả response cũ.
-- Khóa chính mới là (warehouse_id, idempotency_key).
-- ============================================================================

DROP TABLE IF EXISTS idempotency_keys_new;

CREATE TABLE idempotency_keys_new (
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    idempotency_key VARCHAR(128) NOT NULL,
    response_code INT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (warehouse_id, idempotency_key)
);

INSERT INTO idempotency_keys_new
    (warehouse_id, idempotency_key, response_code, response_body, created_at)
SELECT warehouse_id, idempotency_key, response_code, response_body, created_at
FROM idempotency_keys;

DROP TABLE idempotency_keys;
ALTER TABLE idempotency_keys_new RENAME TO idempotency_keys;
CREATE INDEX IF NOT EXISTS idx_idempotency_created
    ON idempotency_keys (warehouse_id, created_at DESC);
