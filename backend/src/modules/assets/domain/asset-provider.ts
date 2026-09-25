import type { AssetCorporateActionSyncRecord, DecimalString } from "./asset.js";

export interface AssetProviderAsset {
  readonly providerAssetId: string;
  readonly ticker: string;
  readonly xStockSymbol: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly solanaMint: string;
  readonly decimals: number;
  readonly available: boolean;
  readonly tradingHalted: boolean;
  readonly marketOpen: boolean | null;
  readonly supportsAtomicSwaps: boolean;
  readonly currentPrice: DecimalString | null;
  readonly priceCurrency: string | null;
  readonly priceChangeAbsolute: DecimalString | null;
  readonly priceChangePercent: DecimalString | null;
  readonly priceChangePeriod: string | null;
  readonly multiplier: DecimalString | null;
  readonly pendingMultiplier: DecimalString | null;
  readonly pendingMultiplierActivationAt: Date | null;
  readonly pendingMultiplierReason: string | null;
  readonly corporateActions: readonly AssetCorporateActionSyncRecord[];
  readonly providerCreatedAt: Date | null;
  readonly providerUpdatedAt: Date | null;
  readonly observedAt: Date;
  readonly priceObservedAt: Date | null;
  readonly multiplierObservedAt: Date | null;
}

export interface AssetProvider {
  readonly name: string;
  listSolanaAssets(): Promise<readonly AssetProviderAsset[]>;
}

