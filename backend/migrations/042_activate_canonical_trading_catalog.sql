-- Activate the complete canonical Tradee catalog only after every existing
-- whitelist asset is ready for Solana execution. BUY uses USDC base-unit
-- precision, so 1.000001 is the smallest representable value strictly above
-- one dollar. SELL remains value-gated after the finalized DFlow quote.
DO $$
DECLARE
  canonical_count INTEGER;
  unready_count INTEGER;
  updated_count INTEGER;
BEGIN
  SELECT COUNT(*)::int
    INTO canonical_count
    FROM trading_whitelists whitelist
    JOIN assets asset ON asset.id = whitelist.asset_id
   WHERE asset.provider = 'xstocks';

  -- A brand-new environment runs schema migrations before the manual catalog
  -- sync. Leave that environment unblocked; configure-tradee-assets creates
  -- the same ACTIVE policy when it later inserts the canonical rows.
  IF canonical_count = 0 THEN
    RAISE NOTICE 'Canonical trading activation skipped because the catalog is not populated.';
    RETURN;
  END IF;

  IF canonical_count <> 121 THEN
    RAISE EXCEPTION
      'Canonical trading activation requires exactly 121 xStocks whitelist rows; found %.',
      canonical_count;
  END IF;

  SELECT COUNT(*)::int
    INTO unready_count
    FROM trading_whitelists whitelist
    JOIN assets asset ON asset.id = whitelist.asset_id
   WHERE asset.provider = 'xstocks'
     AND (
       asset.is_active = FALSE
       OR asset.provider_active = FALSE
       OR asset.provider_trading_halted = TRUE
       OR asset.solana_mint IS NULL
       OR BTRIM(asset.solana_mint) = ''
       OR asset.decimals < 0
     );

  IF unready_count <> 0 THEN
    RAISE EXCEPTION
      'Canonical trading activation refused because % whitelist assets are not execution-ready.',
      unready_count;
  END IF;

  UPDATE trading_whitelists whitelist
     SET status = 'ACTIVE',
         buy_enabled = TRUE,
         sell_enabled = TRUE,
         min_buy_amount = 1.000001,
         max_buy_amount = NULL,
         min_sell_amount = NULL,
         max_sell_amount = NULL,
         fee_bps = 0,
         enabled_at = COALESCE(whitelist.enabled_at, NOW()),
         disabled_at = NULL,
         updated_at = NOW()
    FROM assets asset
   WHERE asset.id = whitelist.asset_id
     AND asset.provider = 'xstocks';

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 121 THEN
    RAISE EXCEPTION
      'Canonical trading activation expected to update 121 rows; updated %.',
      updated_count;
  END IF;
END $$;

COMMENT ON TABLE trading_whitelists IS
  'Backend-authoritative execution policy. Canonical xStocks allow BUY and SELL; BUY must exceed 1 USDC and SELL must exceed 1 USDC in finalized gross quote value.';
