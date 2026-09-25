import { decimalString, type DecimalString } from "../../assets/domain/asset.js";
import { compareExactDecimals, parseExactDecimal } from "../../transaction-policy/domain/exact-decimal.js";
import type { BaseUnitAmount } from "../domain/base-units.js";
import type { TradeExecutionRisk } from "../domain/trading.js";

const ONE_THOUSAND = 1_000n;
const TEN_THOUSAND = 10_000n;

/**
 * Converts DFlow's normalized price movement into an execution gate without
 * exposing crypto-market terminology to the client UI.
 *
 * Boundaries are intentionally conservative: exactly $1,000 remains in the
 * 1% tier; exactly $10,000 remains in the 3% tier. A warning is required only
 * when the quote is strictly above its tier threshold.
 */
export function assessTradeExecutionRisk(
  settlementAmount: BaseUnitAmount,
  settlementDecimals: number,
  priceImpactPercentagePoints: DecimalString,
): TradeExecutionRisk {
  if (!Number.isSafeInteger(settlementDecimals) || settlementDecimals < 0 || settlementDecimals > 255) {
    throw new Error("Settlement decimals are invalid for trade risk assessment.");
  }

  const scale = 10n ** BigInt(settlementDecimals);
  const amount = BigInt(settlementAmount);
  const threshold = amount <= ONE_THOUSAND * scale
    ? decimalString("1")
    : amount <= TEN_THOUSAND * scale
      ? decimalString("3")
      : decimalString("5");
  const requiresAcknowledgement = compareExactDecimals(
    parseExactDecimal(priceImpactPercentagePoints),
    parseExactDecimal(threshold),
  ) > 0;

  return {
    requiresAcknowledgement,
    reason: requiresAcknowledgement ? "ORDER_PRICE_MOVEMENT" : null,
    thresholdPercent: threshold,
  };
}
