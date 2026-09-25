import type { BaseUnitAmount } from "../../trading/domain/base-units.js";

export const WITHDRAW_PLATFORM_FEE = "0.10";
export const WITHDRAW_ASSET = "USDC" as const;
export const WITHDRAW_NETWORK = "solana" as const;

export enum WithdrawalStatus {
  CREATED = "CREATED",
  READY_FOR_REVIEW = "READY_FOR_REVIEW",
  AWAITING_AUTHORIZATION = "AWAITING_AUTHORIZATION",
  SUBMITTED = "SUBMITTED",
  CONFIRMED = "CONFIRMED",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
  EXPIRED = "EXPIRED",
}

export interface WithdrawContext {
  readonly feeModel?: 'SERVICE_NETWORK_V1';
  readonly walletAddress: string;
  readonly assetSymbol: typeof WITHDRAW_ASSET;
  readonly mint: string;
  readonly network: typeof WITHDRAW_NETWORK;
  readonly withdrawableAmount: string;
  readonly minimumAmount: string | null;
  readonly maximumAmount: string | null;
  readonly gasSponsored: true;
  readonly networkFeeToUser: "0";
  readonly tradeeWithdrawalFee: string;
}

export interface Withdrawal {
  readonly feeQuote?: import('../../transaction-policy/domain/transaction-fees.js').TransactionFeeQuote;
  readonly withdrawalId: string;
  readonly userId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly assetSymbol: typeof WITHDRAW_ASSET;
  readonly mint: string;
  readonly network: typeof WITHDRAW_NETWORK;
  readonly amount: string;
  readonly amountBaseUnits: BaseUnitAmount;
  readonly destinationAddress: string;
  readonly networkFeeToUser: "0";
  readonly tradeeWithdrawalFee: string;
  readonly feeTokenAccount: string | null;
  readonly status: WithdrawalStatus;
  readonly idempotencyKey: string;
  readonly serializedTransaction: string | null;
  readonly transactionDigest: string | null;
  readonly transactionSignature: string | null;
  readonly accountingEventId: string | null;
  readonly privyTransactionId: string | null;
  readonly lastValidBlockHeight: bigint | null;
  readonly submissionClaimedAt: Date | null;
  readonly createdAt: Date;
  readonly readyForReviewAt: Date | null;
  readonly awaitingAuthorizationAt: Date | null;
  readonly submittedAt: Date | null;
  readonly confirmedAt: Date | null;
  readonly failedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly expiredAt: Date | null;
  readonly failureCode: WithdrawErrorCode | null;
}

export interface WithdrawWallet {
  readonly userId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly providerWalletId: string | null;
  readonly userAuthorizationEnabled: boolean;
}

export interface PreparedWithdrawalTransaction {
  readonly feeQuote?: import('../../transaction-policy/domain/transaction-fees.js').TransactionFeeQuote;
  readonly serializedTransaction: string;
  readonly transactionDigest: string;
  readonly lastValidBlockHeight: bigint;
}

export interface WithdrawRepository {
  flagReconciliation?(withdrawalId: string): Promise<void>;
  resolveWallet(userId: string, walletAddress: string): Promise<WithdrawWallet>;
  withdrawableBaseUnits(walletId: string, mint: string, excludingWithdrawalId?: string): Promise<BaseUnitAmount>;
  reserve(input: {
    readonly userId: string;
    readonly wallet: WithdrawWallet;
    readonly amount: string;
    readonly amountBaseUnits: BaseUnitAmount;
    readonly destinationAddress: string;
    readonly mint: string;
    readonly idempotencyKey: string;
    readonly tradeeWithdrawalFee: string;
    readonly feeTokenAccount: string | null;
    readonly now: Date;
  }): Promise<{ readonly withdrawal: Withdrawal; readonly created: boolean }>;
  findForUser(withdrawalId: string, userId: string, walletAddress: string): Promise<Withdrawal | null>;
  findByPrivyReference(referenceId: string): Promise<Withdrawal | null>;
  attachPreparedTransaction(withdrawalId: string, transaction: PreparedWithdrawalTransaction, now: Date): Promise<Withdrawal>;
  markAwaitingAuthorization(withdrawalId: string, now: Date): Promise<Withdrawal>;
  claimSubmission(withdrawalId: string, transactionDigest: string, now: Date): Promise<Withdrawal>;
  releaseSubmissionClaim(withdrawalId: string): Promise<void>;
  markSubmitted(input: {
    readonly withdrawalId: string;
    readonly transactionSignature: string;
    readonly privyTransactionId: string | null;
    readonly now: Date;
  }): Promise<Withdrawal>;
  transition(withdrawalId: string, status: WithdrawalStatus, now: Date, failureCode?: WithdrawErrorCode): Promise<Withdrawal>;
  ensureAccountingHint(withdrawal: Withdrawal): Promise<void>;
  appliedAccountingAmount(walletId: string, signature: string, mint: string): Promise<string | null>;
}

export interface WithdrawalTransactionBuilder {
  prepare(input: {
    readonly feeBenefitContext?: import('../../transaction-policy/domain/fee-promotions.js').FeeBenefitContext;
    readonly sourceWallet: string;
    readonly destinationWallet: string;
    readonly mint: string;
    readonly amount: BaseUnitAmount;
    readonly decimals: number;
    readonly tradeeWithdrawalFee?: string;
    readonly feeTokenAccount?: string | null;
  }): Promise<PreparedWithdrawalTransaction>;
}

export interface WithdrawalTransactionValidator {
  validate(withdrawal: Withdrawal): Promise<PreparedWithdrawalTransaction>;
}

export interface WithdrawalAddressValidator {
  canonicalize(address: string): string;
}

export interface WithdrawRateLimiter {
  consume(input: { readonly userId: string; readonly walletId: string; readonly withdrawalId: string }): Promise<boolean>;
}

export type WithdrawErrorCode =
  | "WITHDRAW_NOT_FOUND"
  | "WITHDRAW_IDEMPOTENCY_CONFLICT"
  | "WITHDRAW_INVALID_STATE"
  | "WITHDRAW_INVALID_AMOUNT"
  | "WITHDRAW_INSUFFICIENT_BALANCE"
  | "WITHDRAW_INVALID_DESTINATION"
  | "WITHDRAW_SELF_TRANSFER"
  | "WITHDRAW_WALLET_MISMATCH"
  | "WITHDRAW_WALLET_AUTHORIZATION_REQUIRED"
  | "WITHDRAW_POLICY_REJECTED"
  | "WITHDRAW_RATE_LIMITED"
  | "WITHDRAW_TRANSACTION_MISMATCH"
  | "WITHDRAW_TRANSACTION_EXPIRED"
  | "WITHDRAW_SPONSORSHIP_FAILED"
  | "WITHDRAW_AUTHORIZATION_CANCELLED"
  | "WITHDRAW_SUBMISSION_AMBIGUOUS"
  | "WITHDRAW_CONFIRMATION_FAILED";

export class WithdrawError extends Error {
  constructor(
    readonly code: WithdrawErrorCode,
    message: string,
    readonly status = 422,
    readonly recoverable = false,
  ) {
    super(message);
    this.name = "WithdrawError";
  }
}

const transitions: Readonly<Record<WithdrawalStatus, readonly WithdrawalStatus[]>> = {
  [WithdrawalStatus.CREATED]: [WithdrawalStatus.READY_FOR_REVIEW, WithdrawalStatus.FAILED, WithdrawalStatus.CANCELLED],
  [WithdrawalStatus.READY_FOR_REVIEW]: [WithdrawalStatus.AWAITING_AUTHORIZATION, WithdrawalStatus.FAILED, WithdrawalStatus.CANCELLED, WithdrawalStatus.EXPIRED],
  [WithdrawalStatus.AWAITING_AUTHORIZATION]: [WithdrawalStatus.SUBMITTED, WithdrawalStatus.FAILED, WithdrawalStatus.CANCELLED, WithdrawalStatus.EXPIRED],
  [WithdrawalStatus.SUBMITTED]: [WithdrawalStatus.CONFIRMED, WithdrawalStatus.FAILED],
  [WithdrawalStatus.CONFIRMED]: [],
  [WithdrawalStatus.FAILED]: [],
  [WithdrawalStatus.CANCELLED]: [],
  [WithdrawalStatus.EXPIRED]: [],
};

export function assertWithdrawalTransition(from: WithdrawalStatus, to: WithdrawalStatus): void {
  if (!transitions[from].includes(to)) {
    throw new WithdrawError("WITHDRAW_INVALID_STATE", `Withdrawal cannot transition from ${from} to ${to}.`, 409);
  }
}
