import { decimalString, type DecimalString } from "../../assets/domain/asset.js";
import type { AccountingAssetSnapshot } from "../domain/accounting.js";
import { rawQuantityTimesMultiplier } from "../domain/exact-amount.js";

export class AssetQuantityConverter {
  convertRawQuantity(rawQuantity: string, asset: AccountingAssetSnapshot): {
    readonly rawQuantity: string;
    readonly normalizedTokenQuantity: DecimalString;
    readonly displayQuantity: DecimalString;
    readonly multiplierUsed: DecimalString;
    readonly quantityModelVersion: number;
  } {
    if (!/^(0|[1-9]\d*)$/.test(rawQuantity)) throw new Error("Raw quantity is invalid.");
    const normalizedTokenQuantity = rawQuantityTimesMultiplier(rawQuantity, asset.decimals, "1");
    return {
      rawQuantity,
      normalizedTokenQuantity,
      displayQuantity: rawQuantityTimesMultiplier(rawQuantity, asset.decimals, asset.quantityMultiplier),
      multiplierUsed: asset.quantityMultiplier,
      quantityModelVersion: asset.quantityModelVersion,
    };
  }

  static defaultMultiplier(value: DecimalString | null): DecimalString {
    return value ?? decimalString("1");
  }
}
