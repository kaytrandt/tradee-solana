import type { DecimalString } from "../../assets/domain/asset.js";

/** MOBULA is retained solely to decode persisted historical observations. */
export type ProviderId = "XSTOCKS" | "MOBULA" | "JUPITER" | "ALPACA" | "FINNHUB" | "SOLANA_RPC" | "DFLOW" | "PRIVY" | "MOCK";

export type ProviderCapabilityName =
  | "ASSET_CATALOG"
  | "ASSET_IDENTITY"
  | "CORPORATE_ACTIONS"
  | "TOKEN_PRICE"
  | "TOKEN_OHLCV"
  | "TOKEN_LIQUIDITY"
  | "TOKEN_VOLUME"
  | "EQUITY_OHLCV"
  | "TOKEN_HOLDERS"
  | "WALLET_HOLDINGS_READ_MODEL"
  | "EXTERNAL_PNL_COMPARISON"
  | "COMPANY_NEWS"
  | "COMPANY_PROFILE"
  | "COMPANY_METRICS"
  | "EARNINGS"
  | "MARKET_SESSION"
  | "MARKET_INDICES"
  | "FINALIZED_TRANSACTION_INGESTION"
  | "AUTHORITATIVE_RAW_BALANCES"
  | "DEPOSIT_VERIFICATION"
  | "RECONCILIATION"
  | "EXECUTABLE_QUOTE"
  | "VALIDATED_TRANSACTION"
  | "SIGNING"
  | "SPONSORSHIP";

export interface ProviderRequestContext {
  readonly correlationId?: string;
}

/**
 * Every provider adapter returns this envelope. Application services consume
 * normalized data and provenance, never provider DTOs.
 */
export interface ProviderObservation<T> {
  readonly provider: ProviderId;
  readonly capability: ProviderCapabilityName;
  readonly data: T;
  readonly observedAt: Date;
  readonly sourceTimestamp: Date | null;
  readonly methodology: string;
  readonly authoritative: boolean;
}

export interface SolanaTokenReference {
  readonly chainId: "solana:solana";
  readonly address: string;
}

export interface TimeRange {
  readonly from: Date;
  readonly to: Date;
}

export type OhlcvPeriod = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "6h" | "12h" | "1d" | "1w";

export interface TokenMarketSnapshot {
  readonly token: SolanaTokenReference;
  readonly unitPriceUsd: DecimalString;
  readonly marketCapUsd: DecimalString | null;
  readonly dilutedMarketCapUsd: DecimalString | null;
  readonly liquidityUsd: DecimalString | null;
  readonly maximumPoolLiquidityUsd: DecimalString | null;
  /** Local first observation of this price block, not a fabricated chain timestamp. */
  readonly priceObservedAt?: Date;
  readonly priceBlockId?: string;
  /** Successful price response receipt time; not the time of an onchain trade. */
  readonly priceReceivedAt?: Date;
}

export interface TokenOhlcvCandle {
  readonly openedAt: Date;
  readonly openUsd: DecimalString;
  readonly highUsd: DecimalString;
  readonly lowUsd: DecimalString;
  readonly closeUsd: DecimalString;
  readonly volumeUsd: DecimalString;
}

export interface TokenOhlcvSeries {
  readonly token: SolanaTokenReference;
  readonly candles: readonly TokenOhlcvCandle[];
}

export interface TokenHolderSnapshot {
  readonly token: SolanaTokenReference;
  readonly uniqueWalletCount: number;
}

export interface TokenPriceProvider {
  readonly providerId: ProviderId;
  getTokenMarketSnapshot(
    token: SolanaTokenReference,
    context?: ProviderRequestContext,
  ): Promise<ProviderObservation<TokenMarketSnapshot>>;
  getTokenMarketSnapshots(
    tokens: readonly SolanaTokenReference[],
    context?: ProviderRequestContext,
  ): Promise<ProviderObservation<readonly TokenMarketSnapshot[]>>;
}

export interface TokenMarketDataProvider extends TokenPriceProvider {
  getTokenOhlcv(
    input: {
      readonly token: SolanaTokenReference;
      readonly range: TimeRange;
      readonly period: OhlcvPeriod;
      readonly maximumCandles?: number;
    },
    context?: ProviderRequestContext,
  ): Promise<ProviderObservation<readonly TokenOhlcvCandle[]>>;
  getTokenOhlcvBatch?(
    inputs: readonly {
      readonly token: SolanaTokenReference;
      readonly range: TimeRange;
      readonly period: OhlcvPeriod;
      readonly maximumCandles?: number;
    }[],
    context?: ProviderRequestContext,
  ): Promise<ProviderObservation<readonly TokenOhlcvSeries[]>>;
  getTokenHolders(
    token: SolanaTokenReference,
    context?: ProviderRequestContext,
  ): Promise<ProviderObservation<TokenHolderSnapshot>>;
}

export interface WalletHoldingReadModelItem {
  readonly token: SolanaTokenReference;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
  readonly rawAmount: string | null;
  readonly displayAmount: DecimalString;
  readonly valueUsd: DecimalString;
  readonly unitPriceUsd: DecimalString | null;
  readonly liquidityUsd: DecimalString | null;
}

export interface WalletHoldingsReadModel {
  readonly walletAddress: string;
  readonly totalValueUsd: DecimalString;
  readonly holdings: readonly WalletHoldingReadModelItem[];
}

export interface ExternalPnlPosition {
  readonly token: SolanaTokenReference;
  readonly realizedPnlUsd: DecimalString | null;
  readonly unrealizedPnlUsd: DecimalString | null;
  readonly totalPnlUsd: DecimalString | null;
  readonly averageBuyPriceUsd: DecimalString | null;
  readonly averageSellPriceUsd: DecimalString | null;
}

export interface ExternalPnlComparison {
  readonly walletAddress: string;
  readonly positions: readonly ExternalPnlPosition[];
}

export interface WalletAnalyticsProvider {
  readonly providerId: ProviderId;
  getWalletHoldingsReadModel(
    walletAddress: string,
    context?: ProviderRequestContext,
  ): Promise<ProviderObservation<WalletHoldingsReadModel>>;
  getExternalPnlComparison(
    walletAddress: string,
    context?: ProviderRequestContext,
  ): Promise<ProviderObservation<ExternalPnlComparison>>;
}

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly configured: boolean;
  readonly capabilities: readonly ProviderCapabilityName[];
  readonly role: "AUTHORITATIVE" | "READ_MODEL" | "EXECUTION" | "REFERENCE";
}

export type ProviderPlatformErrorCode =
  | "UNCONFIGURED"
  | "AUTH"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "UNAVAILABLE";

export class ProviderPlatformError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly code: ProviderPlatformErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ProviderPlatformError";
  }
}
