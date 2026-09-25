import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  TradingWhitelistStatus,
  validateTradingWhitelistConfiguration,
  type TradingWhitelist,
  type TradingWhitelistConfiguration,
  type TradingWhitelistRepository,
} from "../../domain/trading-policy.js";

interface TradingWhitelistRow {
  readonly id: string;
  readonly asset_id: string;
  readonly status: TradingWhitelistStatus;
  readonly buy_enabled: boolean;
  readonly sell_enabled: boolean;
  readonly min_buy_amount: string | null;
  readonly max_buy_amount: string | null;
  readonly min_sell_amount: string | null;
  readonly max_sell_amount: string | null;
  readonly fee_bps: number;
  readonly enabled_at: Date | null;
  readonly disabled_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresTradingWhitelistRepository implements TradingWhitelistRepository {
  constructor(private readonly pool: Pool) {}

  async findByAssetId(assetId: string): Promise<TradingWhitelist | null> {
    const result = await this.pool.query<TradingWhitelistRow>(
      "SELECT * FROM trading_whitelists WHERE asset_id = $1 LIMIT 1",
      [assetId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapTradingWhitelist(row);
  }

  async save(
    configuration: TradingWhitelistConfiguration,
    now: Date,
  ): Promise<TradingWhitelist> {
    const policy = validateTradingWhitelistConfiguration(configuration);
    const result = await this.pool.query<TradingWhitelistRow>(
      `INSERT INTO trading_whitelists (
         id, asset_id, status, buy_enabled, sell_enabled,
         min_buy_amount, max_buy_amount, min_sell_amount, max_sell_amount,
         fee_bps, enabled_at, disabled_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::numeric, $7::numeric, $8::numeric, $9::numeric,
         $10, $11, $12, $13, $13
       )
       ON CONFLICT (asset_id) DO UPDATE SET
         status = EXCLUDED.status,
         buy_enabled = EXCLUDED.buy_enabled,
         sell_enabled = EXCLUDED.sell_enabled,
         min_buy_amount = EXCLUDED.min_buy_amount,
         max_buy_amount = EXCLUDED.max_buy_amount,
         min_sell_amount = EXCLUDED.min_sell_amount,
         max_sell_amount = EXCLUDED.max_sell_amount,
         fee_bps = EXCLUDED.fee_bps,
         enabled_at = EXCLUDED.enabled_at,
         disabled_at = EXCLUDED.disabled_at,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        randomUUID(),
        policy.assetId,
        policy.status,
        policy.buyEnabled,
        policy.sellEnabled,
        policy.minBuyAmount,
        policy.maxBuyAmount,
        policy.minSellAmount,
        policy.maxSellAmount,
        policy.feeBps,
        policy.enabledAt,
        policy.disabledAt,
        now,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Trading whitelist persistence returned no row.");
    return mapTradingWhitelist(row);
  }
}

function mapTradingWhitelist(row: TradingWhitelistRow): TradingWhitelist {
  const policy = validateTradingWhitelistConfiguration({
    assetId: row.asset_id,
    status: row.status,
    buyEnabled: row.buy_enabled,
    sellEnabled: row.sell_enabled,
    minBuyAmount: row.min_buy_amount,
    maxBuyAmount: row.max_buy_amount,
    minSellAmount: row.min_sell_amount,
    maxSellAmount: row.max_sell_amount,
    feeBps: row.fee_bps,
    enabledAt: row.enabled_at,
    disabledAt: row.disabled_at,
  });
  return {
    id: row.id,
    ...policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
