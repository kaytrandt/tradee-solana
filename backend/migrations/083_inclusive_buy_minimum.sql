-- Correct the legacy strict > $1 catalog default to inclusive >= $1.
-- Preserve explicit custom limits, permissions, fees, and disabled assets.
UPDATE trading_whitelists
SET min_buy_amount = 1, updated_at = NOW()
WHERE min_buy_amount = 1.000001;
