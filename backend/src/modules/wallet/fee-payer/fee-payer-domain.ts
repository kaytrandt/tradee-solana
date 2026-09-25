import { TradingEngineError, type SponsoredTransactionAuthorizationRequest } from "../../trading/domain/trading.js";
import type { FeeUsdValuation } from "./fee-usd-valuation.js";

export interface FeePayerLimits {
  readonly swapNetworkLamports: bigint;
  readonly swapRentLamports: bigint;
  readonly withdrawNetworkLamports: bigint;
  readonly withdrawRentLamports: bigint;
  readonly minimumBalanceLamports: bigint;
  readonly globalDailyLamports: bigint;
  readonly userDailyLamports: bigint;
}

export interface FeePayerRecord {
  readonly request: SponsoredTransactionAuthorizationRequest;
  readonly payer: string;
  readonly requestExpiry: number;
  readonly reservedLamports: string;
  readonly state: "PREPARED" | "SIGNED" | "CONFIRMED" | "FAILED";
  readonly signedTransaction: string | null;
  readonly signature: string | null;
  readonly feeValuation?: FeeUsdValuation | null;
}

export interface FeePayerJournal {
  get(referenceId: string): Promise<FeePayerRecord | null>;
  prepare(record: FeePayerRecord): Promise<FeePayerRecord>;
  /** Atomic budget admission + durable signed-byte journal, before any broadcast. */
  commitSigned(record: FeePayerRecord, limits: FeePayerLimits, readBalance: () => Promise<bigint>): Promise<FeePayerRecord>;
  settle(referenceId: string, state: "CONFIRMED" | "FAILED", fee: string, debit: string): Promise<void>;
}

export interface FeePayerChain {
  preflight(transaction: string, payer: string, lastValidBlockHeight: string): Promise<{
    networkFee: bigint; estimatedDebit: bigint; balance: bigint;
  }>;
  broadcast(transaction: string): Promise<string>;
  status(signature: string, payer: string): Promise<{
    state: "pending" | "confirmed" | "failed"; fee?: string; debit?: string;
  }>;
  blockHeight(): Promise<bigint>;
  balance(payer: string, lastValidBlockHeight: string): Promise<bigint>;
}

export function sponsorError(message: string): TradingEngineError {
  return new TradingEngineError("TRADE_GAS_SPONSORSHIP_REJECTED", message, true);
}
export function ambiguous(): TradingEngineError {
  return new TradingEngineError("TRADE_SUBMISSION_AMBIGUOUS", "The signed transaction is being reconciled. Do not submit another transaction.", true);
}
export function sameRequest(a: SponsoredTransactionAuthorizationRequest, b: SponsoredTransactionAuthorizationRequest): boolean {
  return a.referenceId === b.referenceId && a.walletId === b.walletId && a.idempotencyKey === b.idempotencyKey
    && a.transactionDigest === b.transactionDigest && a.serializedTransaction === b.serializedTransaction
    && a.feePayerContext?.userId === b.feePayerContext?.userId
    && a.feePayerContext?.walletAddress === b.feePayerContext?.walletAddress
    && a.feePayerContext?.operation === b.feePayerContext?.operation
    && a.feePayerContext?.lastValidBlockHeight === b.feePayerContext?.lastValidBlockHeight
    && (a.feePayerContext?.rentWaived??false) === (b.feePayerContext?.rentWaived??false);
}
