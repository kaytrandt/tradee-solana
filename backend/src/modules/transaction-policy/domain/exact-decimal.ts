import { decimalString, type DecimalString } from "../../assets/domain/asset.js";

const DECIMAL_INPUT_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_DECIMAL_CHARACTERS = 512;
const MAX_ABSOLUTE_EXPONENT = 512;

export class ExactDecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExactDecimalError";
  }
}

export interface ExactDecimal {
  readonly value: DecimalString;
  readonly coefficient: bigint;
  readonly scale: number;
}

export function parseExactDecimal(input: string): ExactDecimal {
  if (input.length === 0 || input.length > MAX_DECIMAL_CHARACTERS) {
    throw new ExactDecimalError("Decimal input has an invalid length.");
  }

  const match = DECIMAL_INPUT_PATTERN.exec(input);
  if (match === null) throw new ExactDecimalError("Decimal input is invalid.");

  const sign = match[1] === "-" ? -1n : 1n;
  const integerDigits = match[2] ?? "";
  const fractionalDigits = match[3] ?? "";
  const exponentText = match[4] ?? "0";
  const exponent = Number.parseInt(exponentText, 10);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_ABSOLUTE_EXPONENT) {
    throw new ExactDecimalError("Decimal exponent is outside the supported range.");
  }

  let coefficient = BigInt(`${integerDigits}${fractionalDigits}`) * sign;
  let scale = fractionalDigits.length - exponent;
  if (coefficient === 0n) {
    return { value: decimalString("0"), coefficient: 0n, scale: 0 };
  }

  if (scale < 0) {
    coefficient *= powerOfTen(-scale);
    scale = 0;
  }

  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }

  return {
    value: decimalString(formatCanonicalDecimal(coefficient, scale)),
    coefficient,
    scale,
  };
}

export function compareExactDecimals(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * powerOfTen(scale - left.scale);
  const rightCoefficient = right.coefficient * powerOfTen(scale - right.scale);
  if (leftCoefficient < rightCoefficient) return -1;
  if (leftCoefficient > rightCoefficient) return 1;
  return 0;
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function formatCanonicalDecimal(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;

  const padded = digits.padStart(scale + 1, "0");
  const splitIndex = padded.length - scale;
  return `${negative ? "-" : ""}${padded.slice(0, splitIndex)}.${padded.slice(splitIndex)}`;
}
