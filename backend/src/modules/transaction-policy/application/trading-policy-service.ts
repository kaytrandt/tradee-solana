import type { DecimalString } from "../../assets/domain/asset.js";
import {
  compareExactDecimals,
  ExactDecimalError,
  parseExactDecimal,
  type ExactDecimal,
} from "../domain/exact-decimal.js";
import {
  TradingPolicyError,
  TradingSide,
  TradingWhitelistStatus,
  type TradingEligibilityContext,
  type TradingPolicyAssetLookup,
  type TradingWhitelist,
  type TradingWhitelistLookup,
  type UserTradingEligibilityService,
  type ValidateTradeRequest,
  type ValidatedTradingPolicy,
  type WalletTradingEligibilityService,
} from "../domain/trading-policy.js";

export class TradingPolicyService {
  constructor(
    private readonly assets: TradingPolicyAssetLookup,
    private readonly whitelists: TradingWhitelistLookup,
    private readonly userEligibility: UserTradingEligibilityService,
    private readonly walletEligibility: WalletTradingEligibilityService,
    private readonly now: () => Date = () => new Date(),
    private readonly migrations?: { pair(id: string): Promise<{enabled:boolean;sourceAssetId:string;destinationAssetId:string}|null> },
  ) {}

  /** An explicit pair grant authorizes only this conversion, never ordinary legacy sales. */
  async validateMigration(request: {pairId:string;userId:string;wallet:ValidateTradeRequest['wallet'];amount:string}): Promise<void> {
    try {
      const pair=await this.migrations?.pair(request.pairId);
      if(!pair?.enabled) throw new TradingPolicyError('asset_trading_disabled','This asset migration is paused.');
      const [source,destination]=await Promise.all([this.assets.findById(pair.sourceAssetId),this.assets.findById(pair.destinationAssetId)]);
      if(!source||!destination||source.solanaMint===destination.solanaMint) throw new TradingPolicyError('asset_not_found','Invalid migration asset pair.');
      // Catalog retirement is allowed only for the source of a server-owned pair.
      validateAssetReadiness({...source,active:true});
      validateAssetReadiness(destination);
      const whitelist=await this.whitelists.findByAssetId(destination.id);
      if(!whitelist||whitelist.status!==TradingWhitelistStatus.ACTIVE||!whitelist.buyEnabled)
        throw new TradingPolicyError('asset_trading_disabled','The destination asset is not available.');
      const amount=parseRequestedAmount(request.amount).value;
      for(const [asset,side] of [[source,TradingSide.SELL],[destination,TradingSide.BUY]] as const) {
        const context={userId:request.userId,wallet:request.wallet,asset,side,amount};
        if(!(await this.userEligibility.checkEligibility(context)).eligible) throw new TradingPolicyError('user_not_eligible','The user is not eligible to migrate.');
        if(!(await this.walletEligibility.checkEligibility(context)).eligible) throw new TradingPolicyError('wallet_not_eligible','The wallet is not eligible to migrate.');
      }
    } catch(error) {
      if(error instanceof TradingPolicyError) throw error;
      throw new TradingPolicyError('policy_unavailable','Migration policy could not be verified.');
    }
  }

  async validateTrade(request: ValidateTradeRequest): Promise<ValidatedTradingPolicy> {
    return this.validate(request, false);
  }

  /** Treasury rewards have their own $1–$5 allocation range, not retail order minimums. */
  async validateReward(request: Omit<ValidateTradeRequest, "side">): Promise<ValidatedTradingPolicy> {
    return this.validate({ ...request, side: TradingSide.BUY }, true);
  }

  private async validate(request: ValidateTradeRequest, reward: boolean): Promise<ValidatedTradingPolicy> {
    try {
      const asset = await this.assets.findById(request.assetId);
      if (asset === null) {
        throw new TradingPolicyError("asset_not_found", "The requested asset does not exist.");
      }
      validateAssetReadiness(asset);

      const whitelist = await this.whitelists.findByAssetId(asset.id);
      if (whitelist === null) {
        throw new TradingPolicyError(
          "asset_not_whitelisted",
          "The requested asset is not approved for trading.",
        );
      }
      if (whitelist.status !== TradingWhitelistStatus.ACTIVE) {
        throw new TradingPolicyError(
          "asset_trading_disabled",
          "Trading is disabled for the requested asset.",
        );
      }

      validateSide(request.side, whitelist);
      const amount = parseRequestedAmount(request.amount);
      if (reward) {
        if (compareExactDecimals(amount, parseExactDecimal("1")) < 0 || compareExactDecimals(amount, parseExactDecimal("5")) > 0) {
          throw new TradingPolicyError("invalid_trade_amount", "Reward value must be between 1 and 5 USDC.");
        }
      } else validateAmountLimits(request.side, amount, whitelist);

      const eligibilityContext: TradingEligibilityContext = {
        userId: request.userId,
        wallet: request.wallet,
        asset,
        side: request.side,
        amount: amount.value,
      };
      const userDecision = await this.userEligibility.checkEligibility(eligibilityContext);
      if (!userDecision.eligible) {
        throw new TradingPolicyError("user_not_eligible", "The user is not eligible to trade.");
      }
      const walletDecision = await this.walletEligibility.checkEligibility(eligibilityContext);
      if (!walletDecision.eligible) {
        throw new TradingPolicyError("wallet_not_eligible", "The wallet is not eligible to trade.");
      }

      return {
        asset,
        whitelist,
        side: request.side,
        amount: amount.value,
        feeBps: whitelist.feeBps,
        validatedAt: this.now(),
      };
    } catch (error) {
      if (error instanceof TradingPolicyError) throw error;
      throw new TradingPolicyError(
        "policy_unavailable",
        "Trading policy could not be evaluated. Trading is not permitted.",
      );
    }
  }
}

function validateAssetReadiness(asset: ValidatedTradingPolicy["asset"]): void {
  if (!asset.active) {
    throw new TradingPolicyError("asset_inactive", "This stock is not currently available for trading.");
  }
  if (!asset.providerAvailable || asset.solanaMint.trim().length === 0) {
    throw new TradingPolicyError(
      "asset_provider_unavailable",
      "The trading provider is not currently available for this stock.",
    );
  }
  if (asset.provider === 'sunrise' && (asset.multiplier === null || asset.providerTimestamps.multiplierObservedAt === null)) {
    throw new TradingPolicyError('asset_provider_unavailable', 'Stock quantity metadata is updating. Please request a new quote shortly.');
  }
  if (asset.providerTradingHalted === true) {
    throw new TradingPolicyError(
      "asset_trading_halted",
      "Trading is temporarily paused for this stock.",
    );
  }
}

function validateSide(side: TradingSide, whitelist: TradingWhitelist): void {
  switch (side) {
    case TradingSide.BUY:
      if (!whitelist.buyEnabled) {
        throw new TradingPolicyError("buy_disabled", "Buying is disabled for this asset.");
      }
      return;
    case TradingSide.SELL:
      if (!whitelist.sellEnabled) {
        throw new TradingPolicyError("sell_disabled", "Selling is disabled for this asset.");
      }
      return;
    default:
      throw new TradingPolicyError("invalid_trading_side", "The trading side is invalid.");
  }
}

function parseRequestedAmount(value: string): ExactDecimal {
  try {
    const amount = parseExactDecimal(value);
    if (amount.coefficient <= 0n) {
      throw new TradingPolicyError("invalid_trade_amount", "Trade amount must be greater than zero.");
    }
    return amount;
  } catch (error) {
    if (error instanceof TradingPolicyError) throw error;
    if (error instanceof ExactDecimalError) {
      throw new TradingPolicyError("invalid_trade_amount", "Trade amount must be an exact decimal string.");
    }
    throw error;
  }
}

function validateAmountLimits(
  side: TradingSide,
  amount: ExactDecimal,
  whitelist: TradingWhitelist,
): void {
  const [minimum, maximum]: readonly [DecimalString | null, DecimalString | null] =
    side === TradingSide.BUY
      ? [whitelist.minBuyAmount, whitelist.maxBuyAmount]
      // SELL minimums are value-based and can only be enforced against the
      // provider's finalized gross-USDC quote in TradingService.
      : [null, whitelist.maxSellAmount];

  if (minimum !== null && compareExactDecimals(amount, parseExactDecimal(minimum)) < 0) {
    throw new TradingPolicyError("amount_below_minimum", "Trade amount is below the allowed minimum.");
  }
  if (maximum !== null && compareExactDecimals(amount, parseExactDecimal(maximum)) > 0) {
    throw new TradingPolicyError("amount_above_maximum", "Trade amount is above the allowed maximum.");
  }
}
