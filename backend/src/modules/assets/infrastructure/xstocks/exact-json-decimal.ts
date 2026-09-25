import { decimalString, type DecimalString } from "../../domain/asset.js";

const JSON_NUMBER = "-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?";

export function extractNullableDecimalField(
  json: string,
  field: string,
): DecimalString | null {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`"${escapedField}"\\s*:\\s*(null|"(${JSON_NUMBER})"|(${JSON_NUMBER}))`);
  const match = pattern.exec(json);
  if (!match) {
    throw new Error(`Expected exact decimal field ${field}`);
  }
  if (match[1] === "null") {
    return null;
  }
  const token = match[2] ?? match[3];
  if (token === undefined) {
    throw new Error(`Invalid exact decimal field ${field}`);
  }
  return decimalString(token);
}
