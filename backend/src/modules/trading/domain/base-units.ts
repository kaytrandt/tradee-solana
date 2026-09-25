import { parseExactDecimal } from "../../transaction-policy/domain/exact-decimal.js";

const UNSIGNED_INTEGER_PATTERN = /^(0|[1-9]\d*)$/;

export type BaseUnitAmount = string & { readonly __baseUnitAmount: unique symbol };

export class BaseUnitAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaseUnitAmountError";
  }
}

export function baseUnitAmount(value: string): BaseUnitAmount {
  if (!UNSIGNED_INTEGER_PATTERN.test(value)) {
    throw new BaseUnitAmountError("Base-unit amount must be an unsigned integer string.");
  }
  return value as BaseUnitAmount;
}

export function positiveBaseUnitAmount(value: string): BaseUnitAmount {
  const amount = baseUnitAmount(value);
  if (BigInt(amount) <= 0n) {
    throw new BaseUnitAmountError("Base-unit amount must be greater than zero.");
  }
  return amount;
}

export function decimalToBaseUnits(value: string, decimals: number): BaseUnitAmount {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new BaseUnitAmountError("Token decimals are invalid.");
  }
  const decimal = parseExactDecimal(value);
  if (decimal.coefficient <= 0n) {
    throw new BaseUnitAmountError("Amount must be greater than zero.");
  }
  if (decimal.scale > decimals) {
    throw new BaseUnitAmountError(
      `Amount has more than ${decimals} fractional digits for this token.`,
    );
  }
  return baseUnitAmount(
    (decimal.coefficient * (10n ** BigInt(decimals - decimal.scale))).toString(),
  );
}

/** Display shares -> raw tokens; floor once, so a partial sell cannot overspend. */
export function scaledQuantityToBaseUnits(value: string, decimals: number, multiplier: string): BaseUnitAmount {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) throw new BaseUnitAmountError('Invalid decimals');
  const amount = parseExactDecimal(value);
  const scale = parseExactDecimal(multiplier);
  if (amount.coefficient <= 0n || scale.coefficient <= 0n) throw new BaseUnitAmountError('Invalid scaled quantity');
  const raw = amount.coefficient * 10n ** BigInt(decimals + scale.scale) / (scale.coefficient * 10n ** BigInt(amount.scale));
  return positiveBaseUnitAmount(raw.toString());
}

export function addBaseUnits(left: BaseUnitAmount, right: BaseUnitAmount): BaseUnitAmount {
  return baseUnitAmount((BigInt(left) + BigInt(right)).toString());
}

export function subtractBaseUnits(left: BaseUnitAmount, right: BaseUnitAmount): BaseUnitAmount {
  const result = BigInt(left) - BigInt(right);
  if (result < 0n) throw new BaseUnitAmountError("Base-unit subtraction would be negative.");
  return baseUnitAmount(result.toString());
}
