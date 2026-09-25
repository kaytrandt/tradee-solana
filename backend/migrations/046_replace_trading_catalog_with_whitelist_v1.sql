BEGIN;

-- Tradee Whitelist v1 contains 49 unique Solana xStocks grouped into seven
-- product categories. Legacy assets and policy rows are retained for history,
-- but they are not discoverable or executable after this migration.
INSERT INTO asset_sectors (id, slug, name, description)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'ai', 'AI', 'Semiconductors, memory, storage, and infrastructure businesses powering modern AI workloads.'),
  ('00000000-0000-4000-8000-000000000102', 'big-tech', 'Big Tech', 'Large technology platforms spanning cloud, consumer devices, advertising, software, and enterprise services.'),
  ('00000000-0000-4000-8000-000000000103', 'crypto', 'Crypto', 'Public companies whose business or treasury strategy is materially connected to digital assets and markets.'),
  ('00000000-0000-4000-8000-000000000104', 'culture', 'Culture', 'Consumer brands and private-market exposure shaped by technology, entertainment, and investing culture.'),
  ('00000000-0000-4000-8000-000000000105', 'bio', 'Bio', 'Healthcare and biopharmaceutical leaders across metabolic disease, medical devices, insurance, and therapeutics.'),
  ('00000000-0000-4000-8000-000000000106', 'macro', 'Macro', 'Broad US equity, technology, leveraged growth, and gold exposures used to express macro market views.'),
  ('00000000-0000-4000-8000-000000000107', 'defensives', 'Defensives', 'Financial, energy, consumer-staples, and diversified businesses commonly used for defensive positioning.')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  updated_at = NOW();

DO $$
DECLARE
  provider_asset_count INTEGER;
  canonical_count INTEGER;
  unready_count INTEGER;
  active_policy_count INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO provider_asset_count
    FROM assets
   WHERE provider = 'xstocks';

  -- Fresh installations run schema migrations before the manual xStocks sync.
  -- configure-tradee-assets applies the same replacement after sync completes.
  IF provider_asset_count = 0 THEN
    RAISE NOTICE 'Tradee Whitelist v1 replacement skipped because the xStocks catalog is not populated.';
    RETURN;
  END IF;

  WITH canonical(ticker, sector_slug) AS (
    VALUES
      ('NVDA','ai'),('TSM','ai'),('AVGO','ai'),('AMD','ai'),('SKHY','ai'),
      ('MU','ai'),('MRVL','ai'),('INTC','ai'),('SNDK','ai'),('PLTR','ai'),
      ('MSFT','big-tech'),('GOOGL','big-tech'),('AAPL','big-tech'),('AMZN','big-tech'),
      ('META','big-tech'),('ORCL','big-tech'),('CRM','big-tech'),('IBM','big-tech'),('ACN','big-tech'),
      ('COIN','crypto'),('MSTR','crypto'),('CRCL','crypto'),('HOOD','crypto'),
      ('DFDV','crypto'),('BMNR','crypto'),('STRC','crypto'),
      ('TSLA','culture'),('SPCX','culture'),('NFLX','culture'),('GME','culture'),
      ('LLY','bio'),('NVO','bio'),('ABT','bio'),('UNH','bio'),('PFE','bio'),
      ('SPY','macro'),('QQQ','macro'),('TQQQ','macro'),('GLD','macro'),
      ('BRK.B','defensives'),('JPM','defensives'),('MA','defensives'),('XOM','defensives'),
      ('CVX','defensives'),('WMT','defensives'),('KO','defensives'),('PEP','defensives'),
      ('MCD','defensives'),('PG','defensives')
  )
  SELECT COUNT(*)::int INTO canonical_count
    FROM assets asset
    JOIN canonical ON canonical.ticker = UPPER(asset.ticker)
   WHERE asset.provider = 'xstocks';

  IF canonical_count <> 49 THEN
    RAISE NOTICE
      'Tradee Whitelist v1 found % of 49 xStocks assets. Missing assets remain unavailable until catalog sync.',
      canonical_count;
  END IF;

  WITH canonical(ticker) AS (
    VALUES
      ('NVDA'),('TSM'),('AVGO'),('AMD'),('SKHY'),('MU'),('MRVL'),('INTC'),('SNDK'),('PLTR'),
      ('MSFT'),('GOOGL'),('AAPL'),('AMZN'),('META'),('ORCL'),('CRM'),('IBM'),('ACN'),
      ('COIN'),('MSTR'),('CRCL'),('HOOD'),('DFDV'),('BMNR'),('STRC'),
      ('TSLA'),('SPCX'),('NFLX'),('GME'),('LLY'),('NVO'),('ABT'),('UNH'),('PFE'),
      ('SPY'),('QQQ'),('TQQQ'),('GLD'),('BRK.B'),('JPM'),('MA'),('XOM'),('CVX'),
      ('WMT'),('KO'),('PEP'),('MCD'),('PG')
  )
  SELECT COUNT(*)::int INTO unready_count
    FROM assets asset
    JOIN canonical ON canonical.ticker = UPPER(asset.ticker)
   WHERE asset.provider = 'xstocks'
     AND (
       asset.provider_active = FALSE
       OR asset.provider_trading_halted = TRUE
       OR asset.solana_mint IS NULL
       OR BTRIM(asset.solana_mint) = ''
       OR asset.decimals < 0
     );

  IF unready_count <> 0 THEN
    RAISE NOTICE
      'Tradee Whitelist v1 leaves % selected assets unavailable because they are not execution-ready.',
      unready_count;
  END IF;

  WITH canonical(ticker, sector_slug) AS (
    VALUES
      ('NVDA','ai'),('TSM','ai'),('AVGO','ai'),('AMD','ai'),('SKHY','ai'),
      ('MU','ai'),('MRVL','ai'),('INTC','ai'),('SNDK','ai'),('PLTR','ai'),
      ('MSFT','big-tech'),('GOOGL','big-tech'),('AAPL','big-tech'),('AMZN','big-tech'),
      ('META','big-tech'),('ORCL','big-tech'),('CRM','big-tech'),('IBM','big-tech'),('ACN','big-tech'),
      ('COIN','crypto'),('MSTR','crypto'),('CRCL','crypto'),('HOOD','crypto'),
      ('DFDV','crypto'),('BMNR','crypto'),('STRC','crypto'),
      ('TSLA','culture'),('SPCX','culture'),('NFLX','culture'),('GME','culture'),
      ('LLY','bio'),('NVO','bio'),('ABT','bio'),('UNH','bio'),('PFE','bio'),
      ('SPY','macro'),('QQQ','macro'),('TQQQ','macro'),('GLD','macro'),
      ('BRK.B','defensives'),('JPM','defensives'),('MA','defensives'),('XOM','defensives'),
      ('CVX','defensives'),('WMT','defensives'),('KO','defensives'),('PEP','defensives'),
      ('MCD','defensives'),('PG','defensives')
  )
  UPDATE assets asset
     SET is_active = (
           asset.provider_active = TRUE
           AND asset.provider_trading_halted = FALSE
           AND asset.solana_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
           AND asset.decimals >= 0
         ),
         sector_id = sector.id,
         updated_at = NOW()
    FROM canonical
    JOIN asset_sectors sector ON sector.slug = canonical.sector_slug
   WHERE asset.provider = 'xstocks'
     AND UPPER(asset.ticker) = canonical.ticker;

  WITH canonical(ticker) AS (
    VALUES
      ('NVDA'),('TSM'),('AVGO'),('AMD'),('SKHY'),('MU'),('MRVL'),('INTC'),('SNDK'),('PLTR'),
      ('MSFT'),('GOOGL'),('AAPL'),('AMZN'),('META'),('ORCL'),('CRM'),('IBM'),('ACN'),
      ('COIN'),('MSTR'),('CRCL'),('HOOD'),('DFDV'),('BMNR'),('STRC'),
      ('TSLA'),('SPCX'),('NFLX'),('GME'),('LLY'),('NVO'),('ABT'),('UNH'),('PFE'),
      ('SPY'),('QQQ'),('TQQQ'),('GLD'),('BRK.B'),('JPM'),('MA'),('XOM'),('CVX'),
      ('WMT'),('KO'),('PEP'),('MCD'),('PG')
  )
  UPDATE assets asset
     SET is_active = FALSE,
         updated_at = NOW()
   WHERE asset.provider = 'xstocks'
     AND NOT EXISTS (SELECT 1 FROM canonical WHERE canonical.ticker = UPPER(asset.ticker));

  WITH canonical(ticker) AS (
    VALUES
      ('NVDA'),('TSM'),('AVGO'),('AMD'),('SKHY'),('MU'),('MRVL'),('INTC'),('SNDK'),('PLTR'),
      ('MSFT'),('GOOGL'),('AAPL'),('AMZN'),('META'),('ORCL'),('CRM'),('IBM'),('ACN'),
      ('COIN'),('MSTR'),('CRCL'),('HOOD'),('DFDV'),('BMNR'),('STRC'),
      ('TSLA'),('SPCX'),('NFLX'),('GME'),('LLY'),('NVO'),('ABT'),('UNH'),('PFE'),
      ('SPY'),('QQQ'),('TQQQ'),('GLD'),('BRK.B'),('JPM'),('MA'),('XOM'),('CVX'),
      ('WMT'),('KO'),('PEP'),('MCD'),('PG')
  )
  UPDATE trading_whitelists whitelist
     SET status = 'DISABLED',
         buy_enabled = FALSE,
         sell_enabled = FALSE,
         disabled_at = COALESCE(whitelist.disabled_at, NOW()),
         updated_at = NOW()
    FROM assets asset
   WHERE asset.id = whitelist.asset_id
     AND asset.provider = 'xstocks'
     AND NOT EXISTS (SELECT 1 FROM canonical WHERE canonical.ticker = UPPER(asset.ticker));

  UPDATE trading_whitelists whitelist
     SET status = 'DISABLED',
         buy_enabled = FALSE,
         sell_enabled = FALSE,
         disabled_at = COALESCE(whitelist.disabled_at, NOW()),
         updated_at = NOW()
    FROM assets asset
   WHERE asset.id = whitelist.asset_id
     AND asset.provider = 'xstocks'
     AND asset.is_active = FALSE;

  WITH canonical(ticker) AS (
    VALUES
      ('NVDA'),('TSM'),('AVGO'),('AMD'),('SKHY'),('MU'),('MRVL'),('INTC'),('SNDK'),('PLTR'),
      ('MSFT'),('GOOGL'),('AAPL'),('AMZN'),('META'),('ORCL'),('CRM'),('IBM'),('ACN'),
      ('COIN'),('MSTR'),('CRCL'),('HOOD'),('DFDV'),('BMNR'),('STRC'),
      ('TSLA'),('SPCX'),('NFLX'),('GME'),('LLY'),('NVO'),('ABT'),('UNH'),('PFE'),
      ('SPY'),('QQQ'),('TQQQ'),('GLD'),('BRK.B'),('JPM'),('MA'),('XOM'),('CVX'),
      ('WMT'),('KO'),('PEP'),('MCD'),('PG')
  )
  INSERT INTO trading_whitelists (
    id, asset_id, status, buy_enabled, sell_enabled,
    min_buy_amount, max_buy_amount, min_sell_amount, max_sell_amount,
    fee_bps, enabled_at, disabled_at, created_at, updated_at
  )
  SELECT md5(asset.id::text || ':tradee-whitelist-v1')::uuid, asset.id,
         'ACTIVE', TRUE, TRUE, 1.000001, NULL, NULL, NULL,
         0, NOW(), NULL, NOW(), NOW()
   FROM assets asset
    JOIN canonical ON canonical.ticker = UPPER(asset.ticker)
   WHERE asset.provider = 'xstocks'
     AND asset.is_active = TRUE
  ON CONFLICT (asset_id) DO UPDATE SET
    status = 'ACTIVE',
    buy_enabled = TRUE,
    sell_enabled = TRUE,
    min_buy_amount = 1.000001,
    max_buy_amount = NULL,
    min_sell_amount = NULL,
    max_sell_amount = NULL,
    fee_bps = 0,
    enabled_at = COALESCE(trading_whitelists.enabled_at, NOW()),
    disabled_at = NULL,
    updated_at = NOW();

  SELECT COUNT(*)::int INTO active_policy_count
    FROM trading_whitelists whitelist
    JOIN assets asset ON asset.id = whitelist.asset_id
   WHERE asset.provider = 'xstocks'
     AND asset.is_active = TRUE
     AND whitelist.status = 'ACTIVE'
     AND whitelist.buy_enabled = TRUE
     AND whitelist.sell_enabled = TRUE;

  IF active_policy_count <> 49 THEN
    RAISE NOTICE
      'Tradee Whitelist v1 currently has % of 49 active Buy/Sell policies; catalog sync is required.',
      active_policy_count;
  END IF;
END $$;

COMMENT ON TABLE trading_whitelists IS
  'Backend-authoritative execution policy. Tradee Whitelist v1 contains 49 active xStocks; legacy rows remain disabled for historical integrity.';

COMMIT;
