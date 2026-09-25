import type { TrackedWallet } from "../../accounting/domain/accounting.js";

export interface PrivyFundsDepositedEvent {
  readonly type: "wallet.funds_deposited";
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly caip2: string;
  readonly assetType: "spl";
  readonly assetAddress: string;
  readonly rawAmount: string;
  readonly transactionSignature: string;
  readonly sender: string;
  readonly recipient: string;
}

export interface PrivyDepositWebhookReceipt {
  readonly state: "claimed" | "processed" | "busy";
}

export interface PrivyDepositWebhookRepository {
  claim(input: {
    readonly event: PrivyFundsDepositedEvent;
    readonly payloadSha256: string;
    readonly now: Date;
    readonly staleAfterMs: number;
  }): Promise<PrivyDepositWebhookReceipt>;
  resolveWallet(providerWalletId: string, recipientAddress: string): Promise<TrackedWallet | null>;
  markProcessed(idempotencyKey: string, processedAt: Date): Promise<void>;
  markFailed(idempotencyKey: string, failureCode: string, failedAt: Date, retryable: boolean): Promise<void>;
}

export interface FinalizedDepositIngestor {
  ingestFinalizedDeposit(input: {
    readonly wallet: TrackedWallet;
    readonly signature: string;
    readonly expectedMint: string;
    readonly expectedRawAmount: string;
  }): Promise<{ readonly duplicate: boolean }>;
}

export interface StockReceiptHandler {
  isSupportedMint(mint: string): Promise<boolean>;
  ingestFinalizedReceived(input: Parameters<FinalizedDepositIngestor['ingestFinalizedDeposit']>[0]): Promise<{ readonly duplicate: boolean }>;
}

export class PrivyDepositWebhookError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PrivyDepositWebhookError";
  }
}
