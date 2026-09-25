export type DecimalString = string & { readonly __decimalString: unique symbol };

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function decimalString(value: string): DecimalString {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`Invalid exact decimal value: ${value}`);
  }
  return value as DecimalString;
}

export interface AssetSector {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
}

export interface AssetPrice {
  readonly value: DecimalString;
  readonly currency: string | null;
  readonly observedAt: Date;
}

export interface AssetPriceChange {
  readonly absolute: DecimalString | null;
  readonly percent: DecimalString | null;
  readonly period: string | null;
  readonly observedAt: Date | null;
}

export interface AssetProviderTimestamps {
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  readonly observedAt: Date;
  readonly priceObservedAt: Date | null;
  readonly multiplierObservedAt: Date | null;
}

export interface Asset {
  readonly assetClass?: "stocks" | "stockmemes";
  readonly stockmeme?: import("./stockmeme.js").StockmemeMetadata | null;
  readonly id: string;
  readonly provider?: string;
  readonly providerAssetId?: string;
  readonly ticker: string;
  readonly xStockSymbol: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly solanaMint: string;
  readonly decimals: number;
  readonly sector: AssetSector | null;
  readonly providerAvailable: boolean;
  readonly providerTradingHalted?: boolean;
  readonly providerMarketOpen?: boolean | null;
  readonly supportsAtomicSwaps?: boolean;
  readonly active: boolean;
  readonly currentPrice: AssetPrice | null;
  readonly priceChange: AssetPriceChange | null;
  readonly multiplier: DecimalString | null;
  readonly pendingMultiplier?: DecimalString | null;
  readonly pendingMultiplierActivationAt?: Date | null;
  readonly pendingMultiplierReason?: string | null;
  readonly providerTimestamps: AssetProviderTimestamps;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AssetSyncRecord {
  readonly provider: string;
  readonly providerAssetId: string;
  readonly ticker: string;
  readonly xStockSymbol: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly solanaMint: string;
  readonly decimals: number;
  readonly sectorSlug: string | null;
  readonly providerAvailable: boolean;
  readonly providerTradingHalted: boolean;
  readonly providerMarketOpen: boolean | null;
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
  readonly providerObservedAt: Date;
  readonly providerPriceObservedAt: Date | null;
  readonly providerMultiplierObservedAt: Date | null;
}

export interface AssetCorporateActionSyncRecord {
  readonly providerEventId: string;
  readonly reason: string;
  readonly previousMultiplier: DecimalString;
  readonly multiplier: DecimalString;
  readonly activatesAt: Date;
}

export interface AssetQuery {
  readonly search?: string;
  readonly sectorSlug?: string;
  readonly active?: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface AssetSyncResult {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly deactivated: number;
  readonly total: number;
}

export interface AssetRepository {
  synchronizeProviderAssets(
    provider: string,
    records: readonly AssetSyncRecord[],
    synchronizedAt: Date,
  ): Promise<AssetSyncResult>;

  list(query: AssetQuery): Promise<readonly Asset[]>;
  findById(id: string): Promise<Asset | null>;
  findByIds?(ids: readonly string[]): Promise<readonly Asset[]>;
  findByTickers(tickers: readonly string[]): Promise<readonly Asset[]>;
}
