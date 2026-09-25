import type { AssetProvider, AssetProviderAsset } from "./asset-provider.js";

export type XStocksProviderAsset = AssetProviderAsset;
export interface XStocksProvider extends AssetProvider { readonly name: "xstocks"; }

export interface SolanaMintMetadataReader {
  getDecimals(mint: string): Promise<number>;
  getScaledUiMetadata?(mint: string): Promise<{
    decimals: number; multiplier: import('./asset.js').DecimalString;
    pendingMultiplier: import('./asset.js').DecimalString;
    activatesAt: Date; paused: boolean;
  }>;
}

export interface AssetSectorClassifier {
  sectorSlugFor(ticker: string): string | null;
}

export function xStockCompanyName(name: string, ticker: string): string {
  const normalized = name.replace(/(?:\s+|^)xstock\s*$/i, "").trim();
  return normalized.length > 0 ? normalized : ticker.trim().toUpperCase();
}

export class ConfiguredAssetSectorClassifier implements AssetSectorClassifier {
  readonly #assignments: ReadonlyMap<string, string>;

  constructor(assignments: Readonly<Record<string, string>> = {}) {
    this.#assignments = new Map(
      Object.entries(assignments).map(([ticker, slug]) => [ticker.toUpperCase(), slug]),
    );
  }

  sectorSlugFor(ticker: string): string | null {
    return this.#assignments.get(ticker.toUpperCase()) ?? null;
  }
}
