import {
  addBaseUnits,
  baseUnitAmount,
  subtractBaseUnits,
  type BaseUnitAmount,
} from "../domain/base-units.js";
import {
  TradingEngineError,
  type PlatformFeeMode,
  type ProviderPreparedOrder,
} from "../domain/trading.js";

const BASIS_POINT_DENOMINATOR = 10_000n;

export interface BuyFeeEconomics {
  readonly grossInput: BaseUnitAmount;
  readonly tradeeFee: BaseUnitAmount;
  readonly economicTradingAmount: BaseUnitAmount;
}

export interface SellFeeEconomics {
  readonly grossOutput: BaseUnitAmount;
  readonly tradeeFee: BaseUnitAmount;
  readonly netOutput: BaseUnitAmount;
}

export interface TieredFeeTerms {
  readonly targetFee: BaseUnitAmount;
  readonly effectiveFeeBps: number;
}

export interface SolanaFeeSchedule {
 readonly lowFixedUsdc: string;
 readonly midBps: number;
 readonly plateauUsdc: string;
 readonly highBps: number;
}
export class FeeEngine {
 constructor(private readonly schedule: SolanaFeeSchedule = {lowFixedUsdc:"0.10",midBps:200,plateauUsdc:"0.95",highBps:50}) {}
  calculateFee(amount: BaseUnitAmount, feeBps: number): BaseUnitAmount {
    validateFeeBps(feeBps);
    return baseUnitAmount(
      ((BigInt(amount) * BigInt(feeBps)) / BASIS_POINT_DENOMINATOR).toString(),
    );
  }

  buyEconomics(grossInput: BaseUnitAmount, feeBps: number): BuyFeeEconomics {
    const tradeeFee = this.calculateFee(grossInput, feeBps);
    return {
      grossInput,
      tradeeFee,
      economicTradingAmount: subtractBaseUnits(grossInput, tradeeFee),
    };
  }

  buyEconomicsWithProviderFee(
    grossInput: BaseUnitAmount,
    providerFee: BaseUnitAmount,
  ): BuyFeeEconomics {
    if (BigInt(providerFee) >= BigInt(grossInput)) {
      throw feeMismatch("The platform fee must be smaller than the gross BUY amount.");
    }
    return {
      grossInput,
      tradeeFee: providerFee,
      economicTradingAmount: subtractBaseUnits(grossInput, providerFee),
    };
  }

  solanaTieredFee(amount: BaseUnitAmount, usdcDecimals: number): TieredFeeTerms {
    if (!Number.isSafeInteger(usdcDecimals) || usdcDecimals < 2 || usdcDecimals > 18) {
      throw feeMismatch("USDC decimals are invalid for the Solana fee schedule.");
    }
    validateFeeBps(this.schedule.midBps);
    validateFeeBps(this.schedule.highBps);
    const rawAmount = BigInt(amount);
    const unit = 10n ** BigInt(usdcDecimals);
    const fiveUsdc = 5n * unit;
    const fortySevenFiftyUsdc = 475n * unit / 10n;
    const oneHundredNinetyUsdc = 190n * unit;

    const targetFee = rawAmount < fiveUsdc
      ? exactUsdcUnits(this.schedule.lowFixedUsdc, unit)
      : rawAmount < fortySevenFiftyUsdc
        ? rawAmount * BigInt(this.schedule.midBps) / BASIS_POINT_DENOMINATOR
        : rawAmount < oneHundredNinetyUsdc
          ? exactUsdcUnits(this.schedule.plateauUsdc, unit)
          : rawAmount * BigInt(this.schedule.highBps) / BASIS_POINT_DENOMINATOR;

    if (targetFee <= 0n || targetFee >= rawAmount) {
      throw feeMismatch("The trade amount is too small for the Solana fee schedule.");
    }

    return {
      targetFee: baseUnitAmount(targetFee.toString()),
      effectiveFeeBps: nearestFeeBps(rawAmount, targetFee),
    };
  }

  sellEconomics(netOutput: BaseUnitAmount, providerFee: BaseUnitAmount): SellFeeEconomics {
    return {
      grossOutput: addBaseUnits(netOutput, providerFee),
      tradeeFee: providerFee,
      netOutput,
    };
  }

  verifyProviderFee(
    prepared: ProviderPreparedOrder,
    requestedFeeBps: number,
    requestedMode: PlatformFeeMode,
  ): void {
    validateFeeBps(requestedFeeBps);
    if (prepared.platformFeeBps !== requestedFeeBps || prepared.platformFeeMode !== requestedMode) {
      throw feeMismatch("DFlow returned different platform-fee terms.");
    }

    const feeBase = requestedMode === "inputMint"
      ? prepared.inputAmount
      : addBaseUnits(prepared.outputAmount, prepared.platformFeeAmount);
    const expected = this.calculateFee(feeBase, requestedFeeBps);
    if (expected !== prepared.platformFeeAmount) {
      throw feeMismatch("DFlow returned an unexpected platform-fee amount.");
    }
  }
}

function nearestFeeBps(amount: bigint, targetFee: bigint): number {
  const scaled = targetFee * BASIS_POINT_DENOMINATOR;
  const lower = scaled / amount;
  const upper = lower + (scaled % amount === 0n ? 0n : 1n);
  const candidates = [lower, upper].filter((value) => value >= 0n && value <= 10_000n);
  if (candidates.length === 0) throw feeMismatch("The tiered platform fee cannot be represented in basis points.");
  let best = candidates[0]!;
  let bestDifference = absolute(amount * best / BASIS_POINT_DENOMINATOR - targetFee);
  for (const candidate of candidates.slice(1)) {
    const difference = absolute(amount * candidate / BASIS_POINT_DENOMINATOR - targetFee);
    if (difference < bestDifference) {
      best = candidate;
      bestDifference = difference;
    }
  }
  return Number(best);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function validateFeeBps(feeBps: number): void {
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new TradingEngineError(
      "TRADE_FEE_MISMATCH",
      "Tradee fee basis points are outside the supported range.",
    );
  }
}

function feeMismatch(message: string): TradingEngineError {
  return new TradingEngineError("TRADE_FEE_MISMATCH", message);
}

function exactUsdcUnits(value: string, unit: bigint): bigint {
 if(!/^\d+(\.\d{1,6})?$/.test(value))throw feeMismatch("Invalid exact fee value.");
 const [whole,fraction=""]=value.split(".");
 const numerator=BigInt(whole!+fraction);
 const denominator=10n**BigInt(fraction.length);
 if(numerator*unit%denominator!==0n)throw feeMismatch("Fee exceeds token precision.");
 return numerator*unit/denominator;
}
