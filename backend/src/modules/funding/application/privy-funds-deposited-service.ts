import { AccountingError } from "../../accounting/domain/accounting.js";
import {
  PrivyDepositWebhookError,
  type FinalizedDepositIngestor,
  type PrivyDepositWebhookRepository,
  type PrivyFundsDepositedEvent,
  type StockReceiptHandler,
} from "../domain/privy-funds-deposited.js";

const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export class PrivyFundsDepositedService {
  constructor(
    private readonly repository: PrivyDepositWebhookRepository,
    private readonly accounting: FinalizedDepositIngestor,
    private readonly configuration: {
      readonly canonicalUsdcMint: string;
      readonly solanaCaip2: string;
      readonly staleReceiptAfterMs: number;
    },
    private readonly now: () => Date = () => new Date(),
    private readonly stocks?: StockReceiptHandler,
  ) {}

  async handle(
    event: PrivyFundsDepositedEvent,
    payloadSha256: string,
  ): Promise<{ readonly duplicate: boolean; readonly queued: boolean }> {
    await this.validate(event);
    const receipt = await this.repository.claim({
      event,
      payloadSha256,
      now: this.now(),
      staleAfterMs: this.configuration.staleReceiptAfterMs,
    });
    if (receipt.state === "processed") return { duplicate: true, queued: false };
    if (receipt.state === "busy") {
      throw new PrivyDepositWebhookError(
        "PRIVY_WEBHOOK_ALREADY_PROCESSING",
        "The Privy deposit webhook is already being processed.",
        true,
      );
    }

    try {
      const wallet = await this.repository.resolveWallet(event.walletId, event.recipient);
      if (wallet === null) {
        throw new PrivyDepositWebhookError(
          "PRIVY_DEPOSIT_WALLET_MISMATCH",
          "The Privy wallet and Solana recipient do not match a Tradee wallet.",
          false,
        );
      }
      // One immediate finalized read is attempted on the request path. When the
      // transaction is not finalized yet, the accounting ledger records this
      // exact signature for the fast retry worker. Do not hold the webhook open
      // or fall back to scanning every wallet.
      const input = {
        wallet,
        signature: event.transactionSignature,
        expectedMint: event.assetAddress,
        expectedRawAmount: event.rawAmount,
      };
      // The provider calls both incoming cash and stocks "funds_deposited".
      // Only USDC uses our DEPOSIT classification; stocks retain TRANSFER_IN
      // (or their existing trade/reward context) in the accounting domain.
      const result = event.assetAddress === this.configuration.canonicalUsdcMint
        ? await this.accounting.ingestFinalizedDeposit(input)
        : await this.stocks!.ingestFinalizedReceived(input);
      await this.repository.markProcessed(event.idempotencyKey, this.now());
      return { duplicate: result.duplicate, queued: false };
    } catch (error) {
      const mapped = mapError(error);
      await this.repository.markFailed(event.idempotencyKey, mapped.code, this.now(), mapped.retryable);
      // AccountingError retry failures have already been durably written to
      // accounting_chain_transactions by the ingestor. Acknowledge the webhook
      // after that durable hand-off; the signature retry worker owns finality
      // from here and Privy does not need to redeliver the same event.
      if (error instanceof AccountingError && error.retryable) {
        return { duplicate: false, queued: true };
      }
      throw mapped;
    }
  }

  private async validate(event: PrivyFundsDepositedEvent): Promise<void> {
    if (event.caip2 !== this.configuration.solanaCaip2) {
      throw invalid("PRIVY_DEPOSIT_WRONG_CHAIN", "Only Solana mainnet deposits are accepted.");
    }
    if (event.assetType !== "spl" || (event.assetAddress !== this.configuration.canonicalUsdcMint
      && !await this.stocks?.isSupportedMint(event.assetAddress))) {
      throw invalid("PRIVY_DEPOSIT_WRONG_ASSET", "Only canonical Solana USDC deposits are accepted.");
    }
    if (!/^[1-9]\d{0,19}$/.test(event.rawAmount) || BigInt(event.rawAmount) > 18446744073709551615n) {
      throw invalid("PRIVY_DEPOSIT_INVALID_AMOUNT", "The deposit amount must be positive base units.");
    }
  }
}

export function privyFundsDepositedConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): {
  readonly canonicalUsdcMint: string;
  readonly solanaCaip2: string;
  readonly staleReceiptAfterMs: number;
} {
  return {
    canonicalUsdcMint: environment.TRADEE_USDC_MINT?.trim()
      || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    solanaCaip2: environment.PRIVY_SOLANA_CAIP2?.trim() || SOLANA_MAINNET_CAIP2,
    staleReceiptAfterMs: positiveInteger(
      environment.TRADEE_PRIVY_WEBHOOK_STALE_MS,
      300_000,
      "TRADEE_PRIVY_WEBHOOK_STALE_MS",
    ),
  };
}

function mapError(error: unknown): PrivyDepositWebhookError {
  if (error instanceof PrivyDepositWebhookError) return error;
  if (error instanceof AccountingError) {
    return new PrivyDepositWebhookError(error.code, error.message, error.retryable);
  }
  return new PrivyDepositWebhookError(
    "PRIVY_DEPOSIT_PROCESSING_FAILED",
    "The finalized deposit could not be processed.",
    true,
  );
}

function invalid(code: string, message: string): PrivyDepositWebhookError {
  return new PrivyDepositWebhookError(code, message, false);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
