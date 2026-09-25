import type { DecimalString } from "../../assets/domain/asset.js";

export enum AccountingEventType {
  DEPOSIT = "DEPOSIT",
  WITHDRAW = "WITHDRAW",
  BUY = "BUY",
  SELL = "SELL",
  TRANSFER_IN = "TRANSFER_IN",
  TRANSFER_OUT = "TRANSFER_OUT",
  FREE_STOCK = "FREE_STOCK",
  REFERRAL_REWARD = "REFERRAL_REWARD",
  FEE = "FEE",
}

export enum AccountingEventSource {
  TRADEE_TRADE = "TRADEE_TRADE",
  SOLANA_EXTERNAL_TRANSFER = "SOLANA_EXTERNAL_TRANSFER",
  REWARD_SYSTEM = "REWARD_SYSTEM",
  REFERRAL_SYSTEM = "REFERRAL_SYSTEM",
  DEPOSIT_SYSTEM = "DEPOSIT_SYSTEM",
  WITHDRAW_SYSTEM = "WITHDRAW_SYSTEM",
  RECONCILIATION = "RECONCILIATION",
}

export enum AccountingEventState {
  NORMALIZED = "NORMALIZED",
  APPLIED = "APPLIED",
  RECONCILED = "RECONCILED",
  FAILED = "FAILED",
}

export enum ChainFinality {
  OBSERVED = "OBSERVED",
  CONFIRMED = "CONFIRMED",
  FINALIZED = "FINALIZED",
  FAILED = "FAILED",
}

export enum ChainProcessingState {
  INGESTED = "INGESTED",
  NORMALIZATION_PENDING = "NORMALIZATION_PENDING",
  APPLIED = "APPLIED",
  FAILED = "FAILED",
}

export enum CostBasisTreatment {
  KNOWN_ACQUISITION = "KNOWN_ACQUISITION",
  KNOWN_DISPOSITION = "KNOWN_DISPOSITION",
  UNKNOWN_ACQUISITION = "UNKNOWN_ACQUISITION",
  TRANSFER_OUT = "TRANSFER_OUT",
  INFORMATIONAL = "INFORMATIONAL",
}

export enum CostBasisStatus {
  KNOWN = "KNOWN",
  PARTIAL = "PARTIAL",
  UNAVAILABLE = "UNAVAILABLE",
}

export enum PnlStatus {
  AVAILABLE = "AVAILABLE",
  PARTIAL = "PARTIAL",
  UNAVAILABLE = "UNAVAILABLE",
}

export enum PositionStatus {
  OPEN = "OPEN",
  CLOSED = "CLOSED",
}

export enum ReconciliationStatus {
  MATCHED = "MATCHED",
  MISMATCH = "MISMATCH",
  PENDING = "PENDING",
}

export type ObservationDirection = "IN" | "OUT";
export type BuyFeeCostBasisPolicy = "CAPITALIZE" | "EXPENSE";
export type RewardCostBasisPolicy = "UNAVAILABLE" | "RECEIPT_VALUE";

export interface AccountingAssetSnapshot {
  readonly assetId: string;
  readonly mint: string;
  readonly decimals: number;
  readonly quantityMultiplier: DecimalString;
  readonly quantityModelVersion: number;
}

export interface TrackedWallet {
  readonly userId: string;
  readonly walletId: string;
  readonly address: string;
}

export interface ChainObservation {
  readonly observationId: string;
  readonly sourceKey: string;
  readonly userId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly signature: string;
  readonly slot: bigint;
  readonly transactionIndex: number;
  readonly eventIndex: number;
  readonly mint: string;
  readonly decimals: number;
  readonly direction: ObservationDirection;
  readonly rawQuantity: string;
  readonly occurredAt: Date;
  readonly observedAt: Date;
  readonly finality: ChainFinality;
}

export interface ChainObservationBatch {
  readonly chainTransactionId: string;
  readonly userId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly signature: string;
  readonly slot: bigint;
  readonly transactionIndex: number;
  readonly blockTime: Date;
  readonly finality: ChainFinality;
  readonly observations: readonly ChainObservation[];
  readonly rawMetadata: Readonly<Record<string, unknown>>;
}

export interface AccountingEvent {
  readonly eventId: string;
  readonly sourceKey: string;
  readonly userId: string;
  readonly walletId: string;
  readonly type: AccountingEventType;
  readonly source: AccountingEventSource;
  readonly state: AccountingEventState;
  readonly assetId: string | null;
  readonly assetMint: string;
  readonly rawQuantity: string;
  readonly displayQuantity: DecimalString;
  readonly multiplierUsed: DecimalString;
  readonly quantityModelVersion: number;
  readonly quoteAssetMint: string | null;
  readonly quoteAmount: DecimalString | null;
  readonly totalValue: DecimalString | null;
  readonly feeAmount: DecimalString | null;
  readonly feeAssetMint: string | null;
  readonly costBasisTreatment: CostBasisTreatment;
  readonly affectsPosition: boolean;
  readonly sourceTransactionSignature: string;
  readonly slot: bigint;
  readonly transactionIndex: number;
  readonly eventIndex: number;
  readonly tradeOrderId: string | null;
  readonly tradeExecutionId: string | null;
  readonly rewardId: string | null;
  readonly occurredAt: Date;
  readonly ingestedAt: Date;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PositionSnapshot {
  /** Present on database read projections; raw quantity is in these base units. */
  readonly tokenDecimals?: number;
  readonly userId: string;
  readonly walletId: string;
  readonly assetId: string;
  readonly rawQuantity: string;
  readonly knownRawQuantity: string;
  readonly unknownRawQuantity: string;
  readonly displayQuantity: DecimalString;
  readonly knownDisplayQuantity: DecimalString;
  readonly unknownDisplayQuantity: DecimalString;
  readonly totalCostBasis: DecimalString;
  readonly weightedAverageCost: DecimalString | null;
  readonly realizedPnl: DecimalString;
  readonly costBasisStatus: CostBasisStatus;
  readonly pnlStatus: PnlStatus;
  readonly status: PositionStatus;
  readonly lastAccountingEventAt: Date | null;
  readonly lastReconciledAt: Date | null;
  readonly version: bigint;
}

export interface ValuedPositionSnapshot extends PositionSnapshot {
  readonly positionId?: string;
  readonly closedAt?: Date;
  readonly marketPrice: DecimalString | null;
  readonly marketValue: DecimalString | null;
  readonly unrealizedPnl: DecimalString | null;
  readonly valuedAt: Date;
  readonly priceStale?: boolean;
}

export interface ReconciliationResult {
  readonly reconciliationId: string;
  readonly walletId: string;
  readonly assetId: string;
  readonly chainRawQuantity: string;
  readonly accountingRawQuantity: string;
  readonly difference: string;
  readonly status: ReconciliationStatus;
  readonly checkedAt: Date;
}

export interface AccountingTradeContext {
  readonly orderId: string;
  readonly executionId: string;
  readonly side: "BUY" | "SELL";
  readonly asset: AccountingAssetSnapshot;
  readonly usdcMint: string;
  readonly usdcDecimals: number;
  readonly grossInputAmount: string;
  readonly economicTradingAmount: string;
  readonly netOutputAmount: string;
  readonly minimumOutputAmount: string;
  readonly feeAmount: string;
  /** Atomic fee collection bound to the reviewed, signed trade transaction. */
  readonly exactFee?: boolean;
}

export interface AccountingClassificationHint {
  /** Server-verified finalized reward receipt; never accepted from client metadata. */
  readonly acquisition?: { readonly value: DecimalString; readonly receivedBaseUnits: string };
  readonly type:
    | AccountingEventType.DEPOSIT
    | AccountingEventType.WITHDRAW
    | AccountingEventType.FREE_STOCK
    | AccountingEventType.REFERRAL_REWARD;
  readonly asset: AccountingAssetSnapshot | null;
  readonly mint: string;
  readonly rewardId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ReceivedStockBasis {
  readonly value: DecimalString | null;
  readonly tokenPrice: string | null;
  readonly priceObservedAt: string | null;
  readonly source: 'JUPITER_TOKEN_UNIT_PRICE';
}

export interface AccountingContextResolver {
  resolveReceivedBasis?(assetId: string, mint: string, rawQuantity: string, receivedAt: Date): Promise<ReceivedStockBasis | null>;
  resolveMigration?(signature: string, walletId: string): Promise<null | {pending:true} | {
    pending:false;id:string;source:AccountingAssetSnapshot;destination:AccountingAssetSnapshot;
    rawAmount:string;minimumOutput:string;costBasis:DecimalString;
  }>;
  resolveTrade(signature: string, walletId: string): Promise<AccountingTradeContext | null>;
  resolveHint(signature: string, walletId: string): Promise<AccountingClassificationHint | null>;
  findAssetByMint(mint: string): Promise<AccountingAssetSnapshot | null>;
}

export interface AccountingLedgerRepository {
  listTrackedWallets(limit: number, afterWalletId?: string): Promise<readonly TrackedWallet[]>;
  withWalletScanLease<T>(walletId: string, operation: () => Promise<T>): Promise<T | null>;
  latestProcessedSignature(walletId: string): Promise<string | null>;
  scanCursor(walletId: string, accountAddress: string): Promise<string | null>;
  saveScanCursor(walletId: string, accountAddress: string, signature: string): Promise<void>;
  listRetryableTransactions(limit: number, now: Date): Promise<readonly { readonly wallet: TrackedWallet; readonly signature: string }[]>;
  applyBatch(batch: ChainObservationBatch, events: readonly AccountingEvent[]): Promise<{ readonly duplicate: boolean; readonly affectedPositions: number }>;
  recordPending(batch: ChainObservationBatch, reason: string): Promise<void>;
  recordFailure(input: { readonly batch: ChainObservationBatch | null; readonly signature: string; readonly wallet: TrackedWallet; readonly reason: string; readonly retryable: boolean; readonly failedAt: Date }): Promise<void>;
  listPositionEvents(walletId: string, assetId: string): Promise<readonly AccountingEvent[]>;
  listPositions(input: {
    readonly userId?: string;
    readonly walletId?: string;
    readonly assetId?: string;
    readonly status?: PositionStatus;
    readonly excludeDemo?: boolean;
  }): Promise<readonly PositionSnapshot[]>;
  recordReconciliation(result: ReconciliationResult): Promise<void>;
}

export interface SolanaAccountingGateway {
  listFinalizedSignatures(walletAddress: string, options: { readonly before?: string; readonly until?: string; readonly limit: number }): Promise<readonly string[]>;
  listTokenAccountAddresses(walletAddress: string, mint: string): Promise<readonly string[]>;
  listOwnedTokenAccountAddresses?(walletAddress: string): Promise<readonly string[]>;
  fetchFinalizedTransaction(signature: string, wallet: TrackedWallet): Promise<ChainObservationBatch>;
  getTokenBalance(walletAddress: string, mint: string): Promise<string>;
}

export interface MarketPriceReader {
  getAssetPriceSnapshots?(assetIds: readonly string[]): Promise<ReadonlyMap<string, {
    readonly price: DecimalString; readonly observedAt: Date; readonly stale: boolean;
  }>>;
  getAssetPrice(assetId: string): Promise<DecimalString | null>;
  getAssetPrices?(assetIds: readonly string[]): Promise<ReadonlyMap<string, DecimalString | null>>;
}

export class AccountingError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "AccountingError";
  }
}
