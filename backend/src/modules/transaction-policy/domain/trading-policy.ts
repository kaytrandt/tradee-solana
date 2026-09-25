import type { Asset, DecimalString } from "../../assets/domain/asset.js";
import {
  compareExactDecimals,
  ExactDecimalError,
  parseExactDecimal,
} from "./exact-decimal.js";

export enum TradingWhitelistStatus {
  ACTIVE = "ACTIVE",
  DISABLED = "DISABLED",
}

export enum TradingSide {
  BUY = "BUY",
  SELL = "SELL",
}

export enum TradingChain {
  SOLANA = "solana",
}

export interface TradingWallet {
  readonly address: string;
  readonly chain: TradingChain;
}

export interface TradingWhitelist {
  readonly id: string;
  readonly assetId: string;
  readonly status: TradingWhitelistStatus;
  readonly buyEnabled: boolean;
  readonly sellEnabled: boolean;
  readonly minBuyAmount: DecimalString | null;
  readonly maxBuyAmount: DecimalString | null;
  readonly minSellAmount: DecimalString | null;
  readonly maxSellAmount: DecimalString | null;
  readonly feeBps: number;
  readonly enabledAt: Date | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TradingWhitelistConfiguration {
  readonly assetId: string;
  readonly status: TradingWhitelistStatus;
  readonly buyEnabled: boolean;
  readonly sellEnabled: boolean;
  readonly minBuyAmount: string | null;
  readonly maxBuyAmount: string | null;
  readonly minSellAmount: string | null;
  readonly maxSellAmount: string | null;
  readonly feeBps: number;
  readonly enabledAt: Date | null;
  readonly disabledAt: Date | null;
}

export interface TradingWhitelistLookup {
  findByAssetId(assetId: string): Promise<TradingWhitelist | null>;
}

export interface TradingWhitelistRepository extends TradingWhitelistLookup {
  save(configuration: TradingWhitelistConfiguration, now: Date): Promise<TradingWhitelist>;
}

export interface TradingPolicyAssetLookup {
  findById(id: string): Promise<Asset | null>;
}

export interface TradingEligibilityContext {
  readonly userId: string;
  readonly wallet: TradingWallet;
  readonly asset: Asset;
  readonly side: TradingSide;
  readonly amount: DecimalString;
}

export interface TradingEligibilityDecision {
  readonly eligible: boolean;
}

export interface UserTradingEligibilityService {
  checkEligibility(context: TradingEligibilityContext): Promise<TradingEligibilityDecision>;
}

export interface WalletTradingEligibilityService {
  checkEligibility(context: TradingEligibilityContext): Promise<TradingEligibilityDecision>;
}

export interface ValidateTradeRequest {
  readonly userId: string;
  readonly wallet: TradingWallet;
  readonly assetId: string;
  readonly side: TradingSide;
  readonly amount: string;
}

export interface ValidatedTradingPolicy {
  readonly asset: Asset;
  readonly whitelist: TradingWhitelist;
  readonly side: TradingSide;
  readonly amount: DecimalString;
  readonly feeBps: number;
  readonly validatedAt: Date;
}

export type TradingPolicyErrorCode =
  | "asset_not_found"
  | "asset_inactive"
  | "asset_provider_unavailable"
  | "asset_trading_halted"
  | "asset_not_whitelisted"
  | "asset_trading_disabled"
  | "buy_disabled"
  | "sell_disabled"
  | "invalid_trading_side"
  | "invalid_trade_amount"
  | "amount_below_minimum"
  | "amount_above_maximum"
  | "user_not_eligible"
  | "wallet_not_eligible"
  | "invalid_whitelist_configuration"
  | "policy_unavailable";

export class TradingPolicyError extends Error {
  constructor(
    readonly code: TradingPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TradingPolicyError";
  }
}

export function validateTradingWhitelistConfiguration(
  configuration: TradingWhitelistConfiguration,
): Omit<TradingWhitelist, "id" | "createdAt" | "updatedAt"> {
  if (!Number.isSafeInteger(configuration.feeBps) || configuration.feeBps < 0) {
    throw invalidConfiguration("feeBps must be a non-negative integer.");
  }
  if (
    configuration.status !== TradingWhitelistStatus.ACTIVE
    && configuration.status !== TradingWhitelistStatus.DISABLED
  ) {
    throw invalidConfiguration("Whitelist status is invalid.");
  }

  try {
    const minBuyAmount = normalizedLimit(configuration.minBuyAmount, "minBuyAmount");
    const maxBuyAmount = normalizedLimit(configuration.maxBuyAmount, "maxBuyAmount");
    const minSellAmount = normalizedLimit(configuration.minSellAmount, "minSellAmount");
    const maxSellAmount = normalizedLimit(configuration.maxSellAmount, "maxSellAmount");
    requireOrderedRange(minBuyAmount, maxBuyAmount, "BUY");
    requireOrderedRange(minSellAmount, maxSellAmount, "SELL");

    return {
      assetId: configuration.assetId,
      status: configuration.status,
      buyEnabled: configuration.buyEnabled,
      sellEnabled: configuration.sellEnabled,
      minBuyAmount,
      maxBuyAmount,
      minSellAmount,
      maxSellAmount,
      feeBps: configuration.feeBps,
      enabledAt: configuration.enabledAt,
      disabledAt: configuration.disabledAt,
    };
  } catch (error) {
    if (error instanceof TradingPolicyError) throw error;
    if (error instanceof ExactDecimalError) throw invalidConfiguration(error.message);
    throw error;
  }
}

function normalizedLimit(value: string | null, name: string): DecimalString | null {
  if (value === null) return null;
  const parsed = parseExactDecimal(value);
  if (parsed.coefficient < 0n) throw invalidConfiguration(`${name} cannot be negative.`);
  return parsed.value;
}

function requireOrderedRange(
  minimum: DecimalString | null,
  maximum: DecimalString | null,
  side: "BUY" | "SELL",
): void {
  if (
    minimum !== null
    && maximum !== null
    && compareExactDecimals(parseExactDecimal(minimum), parseExactDecimal(maximum)) > 0
  ) {
    throw invalidConfiguration(`${side} minimum cannot exceed maximum.`);
  }
}

function invalidConfiguration(message: string): TradingPolicyError {
  return new TradingPolicyError("invalid_whitelist_configuration", message);
}
