import { decimalString, type DecimalString } from "../../assets/domain/asset.js";

// Provider market payloads commonly encode decimals as JSON numbers. Quote
// numeric tokens before JSON.parse so money never crosses binary floating point.
export function parseExactJson(text: string): unknown {
  return JSON.parse(quoteJsonNumbers(text)) as unknown;
}

export function optionalExactDecimal(value: unknown): DecimalString | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  try { return decimalString(value); }
  catch { return null; }
}

export function requiredExactDecimal(value: unknown, field: string): DecimalString {
  const parsed = optionalExactDecimal(value);
  if (parsed === null) throw new Error(`Expected exact decimal field ${field}.`);
  return parsed;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function quoteJsonNumbers(json: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (character === undefined) break;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      let end = index + 1;
      while (end < json.length && /[0-9eE+\-.]/.test(json[end] ?? "")) end += 1;
      output += `"${json.slice(index, end)}"`;
      index = end - 1;
      continue;
    }
    output += character;
  }
  return output;
}
