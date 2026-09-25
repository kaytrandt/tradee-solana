CREATE TABLE IF NOT EXISTS trading_whitelists (
  id UUID PRIMARY KEY,
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  buy_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  sell_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  min_buy_amount NUMERIC,
  max_buy_amount NUMERIC,
  min_sell_amount NUMERIC,
  max_sell_amount NUMERIC,
  fee_bps INTEGER NOT NULL DEFAULT 0,
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trading_whitelists_asset_unique UNIQUE (asset_id),
  CONSTRAINT trading_whitelists_status_valid CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT trading_whitelists_fee_bps_non_negative CHECK (fee_bps >= 0),
  CONSTRAINT trading_whitelists_min_buy_non_negative CHECK (min_buy_amount IS NULL OR min_buy_amount >= 0),
  CONSTRAINT trading_whitelists_max_buy_non_negative CHECK (max_buy_amount IS NULL OR max_buy_amount >= 0),
  CONSTRAINT trading_whitelists_min_sell_non_negative CHECK (min_sell_amount IS NULL OR min_sell_amount >= 0),
  CONSTRAINT trading_whitelists_max_sell_non_negative CHECK (max_sell_amount IS NULL OR max_sell_amount >= 0),
  CONSTRAINT trading_whitelists_buy_range_valid CHECK (
    min_buy_amount IS NULL OR max_buy_amount IS NULL OR min_buy_amount <= max_buy_amount
  ),
  CONSTRAINT trading_whitelists_sell_range_valid CHECK (
    min_sell_amount IS NULL OR max_sell_amount IS NULL OR min_sell_amount <= max_sell_amount
  )
);

CREATE INDEX IF NOT EXISTS trading_whitelists_status_asset_idx
  ON trading_whitelists (status, asset_id);

COMMENT ON TABLE trading_whitelists IS
  'Tradee-owned trading authorization. Asset catalog presence does not imply a row or permission here.';

COMMENT ON COLUMN trading_whitelists.min_buy_amount IS 'NULL means no minimum BUY amount.';
COMMENT ON COLUMN trading_whitelists.max_buy_amount IS 'NULL means no maximum BUY amount.';
COMMENT ON COLUMN trading_whitelists.min_sell_amount IS 'NULL means no minimum SELL amount.';
COMMENT ON COLUMN trading_whitelists.max_sell_amount IS 'NULL means no maximum SELL amount.';
