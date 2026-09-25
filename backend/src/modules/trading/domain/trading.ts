import type { DecimalString } from "../../assets/domain/asset.js";
import type { TradingSide } from "../../transaction-policy/domain/trading-policy.js";
import type { BaseUnitAmount } from "./base-units.js";

export enum TradeOrderState {
  CREATED = "CREATED",
  QUOTED = "QUOTED",
  AWAITING_SIGNATURE = "AWAITING_SIGNATURE",
  SUBMITTED = "SUBMITTED",
  CONFIRMED = "CONFIRMED",
  FAILED = "FAILED",
  EXPIRED = "EXPIRED",
  CANCELLED = "CANCELLED",
}

export enum TradingProviderName {
  DFLOW = "DFLOW",
}

export type ProviderExecutionMode = "sync";
export type PlatformFeeMode = "inputMint" | "outputMint";

export interface TradeRouteLeg {
  readonly venue: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmount: BaseUnitAmount;
  readonly outputAmount: BaseUnitAmount;
}

export interface TradeExecutionRisk {
  readonly requiresAcknowledgement: boolean;
  readonly reason: "ORDER_PRICE_MOVEMENT" | null;
  /** Percentage points used by the server-side order-size risk policy. */
  readonly thresholdPercent: DecimalString;
}

export interface TradeQuote {
  readonly feeQuote?: import('../../transaction-policy/domain/transaction-fees.js').TransactionFeeQuote;
  /** Frozen display shares per token; absent only on legacy quotes. */
  readonly quantityMultiplier?: string;
  readonly quoteId: string;
  readonly orderId: string;
  readonly assetId: string;
  readonly side: TradingSide;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly grossInputAmount: BaseUnitAmount;
  readonly economicTradingAmount: BaseUnitAmount;
  readonly expectedOutputAmount: BaseUnitAmount;
  readonly minimumOutputAmount: BaseUnitAmount;
  readonly tradeeFee: BaseUnitAmount;
  readonly tradeeFeeBps: number;
  readonly tradeeFeeAsset: string;
  readonly slippageBps: number;
  /** Percentage points. A value of `0.01` is displayed as `0.01%`. */
  readonly priceImpact: DecimalString;
  readonly executionRisk: TradeExecutionRisk;
  readonly quotedAt: Date;
  readonly lastValidBlockHeight: bigint;
  readonly providerReference: string | null;
  readonly executionMode: ProviderExecutionMode;
  readonly route: readonly TradeRouteLeg[];
  readonly transaction: string;
  readonly transactionDigest: string;
  readonly requiredSigners: readonly string[];
}

export interface TradeOrder {
  readonly orderId: string;
  readonly userId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly assetId: string;
  readonly side: TradingSide;
  readonly requestedAmount: string;
  readonly quantityUnit?: 'TOKEN' | 'DISPLAY';
  readonly quoteId: string | null;
  readonly state: TradeOrderState;
  readonly provider: TradingProviderName;
  readonly idempotencyKey: string;
  readonly submissionClaimedAt: Date | null;
  readonly submissionPayloadHash: string | null;
  readonly riskAcknowledgedAt: Date | null;
  readonly failureCode: TradingEngineErrorCode | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TradeExecution {
  readonly executionId: string;
  readonly orderId: string;
  readonly transactionSignature: string | null;
  readonly privyTransactionId: string | null;
  readonly privyReferenceId: string | null;
  readonly gasSponsored: boolean;
  readonly inputAmount: BaseUnitAmount;
  readonly outputAmount: BaseUnitAmount;
  readonly tradeeFee: BaseUnitAmount;
  readonly submittedAt: Date | null;
  readonly confirmedAt: Date | null;
  readonly failedAt: Date | null;
  readonly failureCode: TradingEngineErrorCode | null;
}

export interface TradeAggregate {
  readonly order: TradeOrder;
  readonly quote: TradeQuote | null;
  readonly execution: TradeExecution | null;
}

export interface CreateTradeRequest {
  readonly quantityUnit?: 'TOKEN' | 'DISPLAY';
  readonly userId: string;
  readonly walletAddress: string;
  readonly assetId: string;
  readonly side: TradingSide;
  readonly amount: string;
  readonly slippageBps?: number;
  readonly idempotencyKey: string;
}

export interface SubmitTradeRequest {
  readonly userId: string;
  readonly walletAddress: string;
  readonly orderId: string;
  readonly riskAcknowledged: boolean;
  readonly authorizationSignature?: string;
  readonly authorizationRequestExpiry?: number;
  /** Test/legacy compatibility only; the trading HTTP API never accepts this field. */
  readonly userAuthorizationToken?: string;
}

export interface PrepareTradeAuthorizationRequest {
  /** Speculative challenge preparation never consumes a sponsorship admission. */
  readonly preparingOnly?: boolean;
  readonly userId: string;
  readonly walletAddress: string;
  readonly orderId: string;
  readonly riskAcknowledged: boolean;
}

export interface ProviderOrderRequest {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amount: BaseUnitAmount;
  readonly userPublicKey: string;
  readonly slippageBps: number;
  readonly platformFeeBps: number;
  readonly platformFeeMode: PlatformFeeMode;
  readonly feeAccount: string;
}

export interface ProviderPreparedOrder {
  readonly requiredSigners?: readonly string[];
  readonly provider: TradingProviderName;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmount: BaseUnitAmount;
  readonly outputAmount: BaseUnitAmount;
  readonly minimumOutputAmount: BaseUnitAmount;
  readonly platformFeeAmount: BaseUnitAmount;
  readonly platformFeeBps: number;
  readonly platformFeeMode: PlatformFeeMode;
  readonly slippageBps: number;
  /** Percentage points normalized from DFlow's fractional `priceImpactPct`. */
  readonly priceImpact: DecimalString;
  readonly lastValidBlockHeight: bigint;
  readonly providerReference: string | null;
  readonly executionMode: ProviderExecutionMode;
  readonly route: readonly TradeRouteLeg[];
  readonly transaction: string;
}

export interface TradingProvider {
  readonly name: TradingProviderName;
  createOrder(request: ProviderOrderRequest): Promise<ProviderPreparedOrder>;
}

export interface TradeOrderRepository {
  findByUserAndIdempotencyKey(userId: string, idempotencyKey: string): Promise<TradeAggregate | null>;
  findById(orderId: string): Promise<TradeAggregate | null>;
  findByPrivyReferenceId(referenceId: string): Promise<TradeAggregate | null>;
  reserve(order: TradeOrder): Promise<{ readonly aggregate: TradeAggregate; readonly created: boolean }>;
  attachQuote(orderId: string, quote: TradeQuote, now: Date): Promise<TradeAggregate>;
  claimSubmission(
    orderId: string,
    userId: string,
    payloadHash: string,
    riskAcknowledged: boolean,
    now: Date,
  ): Promise<TradeAggregate>;
  releaseSubmissionClaim(orderId: string, userId: string): Promise<void>;
  markSubmitted(
    orderId: string,
    userId: string,
    execution: TradeExecution,
    now: Date,
  ): Promise<TradeAggregate>;
  transition(orderId: string, nextState: TradeOrderState, now: Date, failureCode?: TradingEngineErrorCode): Promise<TradeAggregate>;
}

export interface TradingWalletRecord {
  readonly id: string;
  readonly userId: string;
  readonly address: string;
  readonly providerWalletId: string | null;
  readonly teeExecutionEnabled: boolean;
}

export interface TradingWalletLookup {
  findOwnedSolanaWallet(userId: string, address: string): Promise<TradingWalletRecord | null>;
}

export interface SolanaTransactionStatus {
  readonly state: "pending" | "confirmed" | "failed";
  readonly failure: string | null;
}

export interface SolanaExecutionGateway {
  getBlockHeight(): Promise<bigint>;
  getTransactionStatus(signature: string): Promise<SolanaTransactionStatus>;
}

export interface SponsoredTransactionRequest {
  readonly feePayerContext?: FeePayerTransactionContext;
  readonly walletId: string;
  readonly serializedTransaction: string;
  readonly transactionDigest: string;
  readonly referenceId: string;
  readonly idempotencyKey: string;
  /** Direct P-256 owner signature over the canonical Privy Wallet API request. */
  readonly authorizationSignature?: string;
  readonly authorizationRequestExpiry?: number;
  /** Legacy path retained temporarily for withdrawals while their UI is migrated. */
  readonly userAuthorizationToken?: string;
}

export interface SponsoredTransactionAuthorizationRequest {
  readonly feePayerContext?: FeePayerTransactionContext;
  readonly walletId: string;
  readonly serializedTransaction: string;
  readonly transactionDigest: string;
  readonly referenceId: string;
  readonly idempotencyKey: string;
}

export interface SponsoredTransactionAuthorizationChallenge {
  /** Canonical Privy request bytes. The client signs these bytes inside Privy. */
  readonly payloadBase64: string;
  readonly requestExpiry: number;
}

export interface SponsoredTransactionResult {
  readonly transactionSignature: string;
  readonly providerTransactionId: string | null;
  readonly referenceId: string;
  readonly sponsored: true;
}

export interface SponsoredTransactionStatus {
  readonly state: "not_found" | "pending" | "confirmed" | "failed";
  readonly transactionSignature: string | null;
  readonly providerTransactionId: string | null;
  readonly referenceId: string;
}

export interface SponsoredTransactionProvider {
  createAuthorizationChallenge(
    request: SponsoredTransactionAuthorizationRequest,
  ): SponsoredTransactionAuthorizationChallenge | Promise<SponsoredTransactionAuthorizationChallenge>;
  signAndSend(request: SponsoredTransactionRequest): Promise<SponsoredTransactionResult>;
  getByReferenceId(referenceId: string): Promise<SponsoredTransactionStatus>;
  /** Recover only previously signed bytes; never creates a fresh transaction. */
  recoverSubmission?(referenceId: string): Promise<void>;
  /** A persisted signed transaction must not be expired solely because an RPC cannot find it. */
  isDurablySigned?(referenceId: string): Promise<boolean>;
}

/** Supplied by the authorized domain service, never accepted from HTTP clients. */
export interface FeePayerTransactionContext {
  readonly rentWaived?: boolean;
  readonly userId: string;
  readonly walletAddress: string;
  readonly operation: "BUY" | "SELL" | "WITHDRAW";
  readonly lastValidBlockHeight: string;
}

export interface SponsoredTransactionEvent {
  readonly type: "broadcasted" | "confirmed" | "failed";
  readonly walletId: string;
  readonly providerTransactionId: string;
  readonly referenceId: string;
  readonly transactionSignature: string | null;
}

export interface GasSponsorshipDecision {
  readonly eligible: boolean;
  readonly reason: "eligible" | "disabled" | "rate_limited" | "wallet_not_supported";
}

export interface GasSponsorshipPolicy {
  inspect?(input: { readonly userId: string; readonly walletId: string; readonly orderId: string }): Promise<GasSponsorshipDecision>;
  evaluate(input: {
    readonly userId: string;
    readonly walletId: string;
    readonly orderId: string;
  }): Promise<GasSponsorshipDecision>;
}

export type TradingEngineErrorCode =
  | "TRADE_NOT_FOUND"
  | "TRADE_IDEMPOTENCY_CONFLICT"
  | "TRADE_INVALID_STATE"
  | "TRADE_INVALID_AMOUNT_PRECISION"
  | "TRADE_INVALID_SLIPPAGE"
  | "TRADE_PROVIDER_UNAVAILABLE"
  | "TRADE_PROVIDER_AUTH_FAILED"
  | "TRADE_USER_AUTHORIZATION_INVALID"
  | "TRADE_PROVIDER_RATE_LIMITED"
  | "TRADE_PROVIDER_REJECTED"
  | "TRADE_INVALID_ROUTE"
  | "TRADE_FEE_MISMATCH"
  | "TRADE_SELL_VALUE_BELOW_MINIMUM"
  | "TRADE_QUOTE_EXPIRED"
  | "TRADE_RISK_ACKNOWLEDGEMENT_REQUIRED"
  | "TRADE_TRANSACTION_EXPIRED"
  | "TRADE_SUBMISSION_FAILED"
  | "TRADE_SUBMISSION_AMBIGUOUS"
  | "TRADE_GAS_SPONSORSHIP_REJECTED"
  | "TRADE_SPONSORSHIP_RATE_LIMITED"
  | "TRADE_WALLET_EXECUTION_UNSUPPORTED"
  | "TRADE_TRANSACTION_MISMATCH"
  | "TRADE_WALLET_MISMATCH"
  | "TRADE_MINT_MISMATCH"
  | "TRADE_PROGRAM_NOT_ALLOWED"
  | "TRADE_DESTINATION_NOT_ALLOWED"
  | "TRADE_AUTHORIZATION_CANCELLED"
  | "TRADE_CONFIRMATION_FAILED";

export class TradingEngineError extends Error {
  constructor(
    readonly code: TradingEngineErrorCode,
    message: string,
    readonly recoverable = false,
  ) {
    super(message);
    this.name = "TradingEngineError";
  }
}

const ALLOWED_TRANSITIONS: Readonly<Record<TradeOrderState, readonly TradeOrderState[]>> = {
  [TradeOrderState.CREATED]: [TradeOrderState.QUOTED, TradeOrderState.FAILED, TradeOrderState.CANCELLED],
  [TradeOrderState.QUOTED]: [TradeOrderState.AWAITING_SIGNATURE, TradeOrderState.EXPIRED, TradeOrderState.FAILED, TradeOrderState.CANCELLED],
  [TradeOrderState.AWAITING_SIGNATURE]: [TradeOrderState.SUBMITTED, TradeOrderState.EXPIRED, TradeOrderState.FAILED, TradeOrderState.CANCELLED],
  [TradeOrderState.SUBMITTED]: [TradeOrderState.CONFIRMED, TradeOrderState.EXPIRED, TradeOrderState.FAILED],
  [TradeOrderState.CONFIRMED]: [],
  [TradeOrderState.FAILED]: [],
  [TradeOrderState.EXPIRED]: [],
  [TradeOrderState.CANCELLED]: [],
};

export function assertTradeOrderTransition(from: TradeOrderState, to: TradeOrderState): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new TradingEngineError(
      "TRADE_INVALID_STATE",
      `Trade order cannot transition from ${from} to ${to}.`,
    );
  }
}
