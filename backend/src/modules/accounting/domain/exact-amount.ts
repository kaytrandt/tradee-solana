import { decimalString, type DecimalString } from "../../assets/domain/asset.js";
import { parseExactDecimal, type ExactDecimal } from "../../transaction-policy/domain/exact-decimal.js";

const MAX_DIVISION_SCALE = 36;

export function exactAmount(value: string): DecimalString {
  return parseExactDecimal(value).value;
}

export function addExact(left: string, right: string): DecimalString {
  const [a, b, scale] = align(left, right);
  return format(a + b, scale);
}

export function subtractExact(left: string, right: string): DecimalString {
  const [a, b, scale] = align(left, right);
  return format(a - b, scale);
}

export function multiplyExact(left: string, right: string): DecimalString {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  return format(a.coefficient * b.coefficient, a.scale + b.scale);
}

export function divideExact(left: string, right: string, scale = 18): DecimalString {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > MAX_DIVISION_SCALE) {
    throw new Error("Exact division scale is invalid.");
  }
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  if (b.coefficient === 0n) throw new Error("Cannot divide by zero.");
  const exponent = scale + b.scale - a.scale;
  const numerator = exponent >= 0
    ? a.coefficient * powerOfTen(exponent)
    : a.coefficient;
  const denominator = exponent >= 0
    ? b.coefficient
    : b.coefficient * powerOfTen(-exponent);
  // Accounting V1 uses deterministic truncation toward zero at the configured scale.
  return format(numerator / denominator, scale);
}

export function compareExact(left: string, right: string): number {
  const [a, b] = align(left, right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function negateExact(value: string): DecimalString {
  const parsed = parseExactDecimal(value);
  return format(-parsed.coefficient, parsed.scale);
}

export function absoluteExact(value: string): DecimalString {
  const parsed = parseExactDecimal(value);
  return format(parsed.coefficient < 0n ? -parsed.coefficient : parsed.coefficient, parsed.scale);
}

export function baseUnitsToExact(rawQuantity: string, decimals: number): DecimalString {
  requireUnsignedInteger(rawQuantity);
  requireDecimals(decimals);
  return format(BigInt(rawQuantity), decimals);
}

export function rawQuantityTimesMultiplier(
  rawQuantity: string,
  decimals: number,
  multiplier: string,
): DecimalString {
  requireUnsignedInteger(rawQuantity);
  requireDecimals(decimals);
  const parsedMultiplier = parseExactDecimal(multiplier);
  if (parsedMultiplier.coefficient <= 0n) throw new Error("Quantity multiplier must be positive.");
  return format(BigInt(rawQuantity) * parsedMultiplier.coefficient, decimals + parsedMultiplier.scale);
}

export function exactRatioOf(value: string, numerator: bigint, denominator: bigint): DecimalString {
  if (numerator < 0n || denominator <= 0n || numerator > denominator) {
    throw new Error("Exact allocation ratio is invalid.");
  }
  if (numerator === 0n) return decimalString("0");
  if (numerator === denominator) return exactAmount(value);
  return divideExact(multiplyExact(value, numerator.toString()), denominator.toString());
}

export function isZeroExact(value: string): boolean {
  return parseExactDecimal(value).coefficient === 0n;
}

function align(left: string, right: string): readonly [bigint, bigint, number] {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  return [
    a.coefficient * powerOfTen(scale - a.scale),
    b.coefficient * powerOfTen(scale - b.scale),
    scale,
  ];
}

function format(coefficient: bigint, scale: number): DecimalString {
  if (coefficient === 0n) return decimalString("0");
  let normalizedCoefficient = coefficient;
  let normalizedScale = scale;
  while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
    normalizedCoefficient /= 10n;
    normalizedScale -= 1;
  }
  const negative = normalizedCoefficient < 0n;
  const digits = (negative ? -normalizedCoefficient : normalizedCoefficient).toString();
  if (normalizedScale === 0) return decimalString(`${negative ? "-" : ""}${digits}`);
  const padded = digits.padStart(normalizedScale + 1, "0");
  const split = padded.length - normalizedScale;
  return decimalString(`${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`);
}

function requireUnsignedInteger(value: string): void {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("Raw quantity must be an unsigned integer string.");
}

function requireDecimals(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw new Error("Asset decimals are invalid.");
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

export function exactFromParsed(value: ExactDecimal): DecimalString {
  return format(value.coefficient, value.scale);
}
