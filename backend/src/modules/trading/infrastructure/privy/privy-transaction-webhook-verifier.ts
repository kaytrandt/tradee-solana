import { PrivyClient } from "@privy-io/node";
import type { PrivyFundsDepositedEvent } from "../../../funding/domain/privy-funds-deposited.js";
import type { PrivyGoogleIdentityWebhookEvent } from "../../../identity/domain/identity.js";
import type { SponsoredTransactionEvent } from "../../domain/trading.js";

export type VerifiedPrivyWebhookEvent =
  | { readonly kind: "sponsored_transaction"; readonly event: SponsoredTransactionEvent }
  | { readonly kind: "funds_deposited"; readonly event: PrivyFundsDepositedEvent }
  | { readonly kind: "google_identity"; readonly event: PrivyGoogleIdentityWebhookEvent }
  | { readonly kind: "malformed_supported"; readonly eventType: string };

export class PrivyTransactionWebhookVerifier {
  private readonly client: PrivyClient;

  constructor(configuration: {
    readonly appId: string;
    readonly appSecret: string;
    readonly webhookSigningSecret: string;
  }) {
    this.client = new PrivyClient({
      appId: configuration.appId,
      appSecret: configuration.appSecret,
      webhookSigningSecret: configuration.webhookSigningSecret,
    });
  }

  verify(payload: string, headers: {
    readonly svixId: string;
    readonly svixTimestamp: string;
    readonly svixSignature: string;
  }): VerifiedPrivyWebhookEvent | null {
    const event = this.client.webhooks().verify({
      payload,
      headers: {
        "svix-id": headers.svixId,
        "svix-timestamp": headers.svixTimestamp,
        "svix-signature": headers.svixSignature,
      },
    });
    return mapPrivyWebhookEvent(event as unknown);
  }
}

export function mapPrivyWebhookEvent(value: unknown): VerifiedPrivyWebhookEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.type === "wallet.funds_deposited") {
    return mapFundsDeposited(event) ?? { kind: "malformed_supported", eventType: event.type };
  }
  if (event.type === "user.linked_account" || event.type === "user.unlinked_account") {
    return mapGoogleIdentity(event) ?? { kind: "malformed_supported", eventType: event.type };
  }
  if (
    event.type !== "transaction.broadcasted"
    && event.type !== "transaction.confirmed"
    && event.type !== "transaction.failed"
    && event.type !== "transaction.execution_reverted"
    && event.type !== "transaction.provider_error"
  ) return null;
  if (
    typeof event.reference_id !== "string"
    || typeof event.wallet_id !== "string"
    || typeof event.transaction_id !== "string"
  ) return { kind: "malformed_supported", eventType: String(event.type) };
  return {
    kind: "sponsored_transaction",
    event: {
      type: event.type === "transaction.broadcasted"
        ? "broadcasted"
        : event.type === "transaction.confirmed" ? "confirmed" : "failed",
      walletId: event.wallet_id,
      providerTransactionId: event.transaction_id,
      referenceId: event.reference_id,
      transactionSignature: typeof event.transaction_hash === "string" ? event.transaction_hash : null,
    },
  };
}

function mapGoogleIdentity(event: Record<string, unknown>): VerifiedPrivyWebhookEvent | null {
  const account = record(event.account);
  const user = record(event.user);
  if (
    account?.type !== "google_oauth"
    || typeof account.subject !== "string"
    || typeof user?.id !== "string"
  ) return null;

  const linkedAccounts = Array.isArray(user.linked_accounts)
    ? user.linked_accounts.map(record).filter((candidate): candidate is Record<string, unknown> => candidate !== null)
    : [];
  const googleIdentity = event.type === "user.linked_account"
    && typeof account.email === "string"
    ? {
        subject: account.subject,
        email: account.email,
        name: typeof account.name === "string" ? account.name : null,
      }
    : null;

  return {
    kind: "google_identity",
    event: {
      type: event.type as "user.linked_account" | "user.unlinked_account",
      privyUserId: user.id,
      googleIdentity,
      changedSubject: account.subject,
      googleIsOnlyLoginMethod: googleIdentity !== null && countLoginMethods(linkedAccounts) === 1,
    },
  };
}

function countLoginMethods(accounts: readonly Record<string, unknown>[]): number {
  return accounts.filter((account) => {
    if (account.type === "smart_wallet") return false;
    const embedded = account.connector_type === "embedded" || account.wallet_client_type === "privy";
    return !embedded;
  }).length;
}

function mapFundsDeposited(event: Record<string, unknown>): VerifiedPrivyWebhookEvent | null {
  const asset = record(event.asset);
  const assetAddress = typeof asset?.mint === "string"
    ? asset.mint
    : typeof asset?.address === "string" ? asset.address : null;
  if (
    typeof event.idempotency_key !== "string"
    || typeof event.wallet_id !== "string"
    || typeof event.caip2 !== "string"
    || typeof event.amount !== "string"
    || typeof event.transaction_hash !== "string"
    || typeof event.sender !== "string"
    || typeof event.recipient !== "string"
    || asset?.type !== "spl"
    || assetAddress === null
  ) return null;
  return {
    kind: "funds_deposited",
    event: {
      type: "wallet.funds_deposited",
      idempotencyKey: event.idempotency_key,
      walletId: event.wallet_id,
      caip2: event.caip2,
      assetType: "spl",
      assetAddress,
      rawAmount: event.amount,
      transactionSignature: event.transaction_hash,
      sender: event.sender,
      recipient: event.recipient,
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
