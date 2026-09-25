import assert from "node:assert/strict";
import test from "node:test";
import { AccountingError, type TrackedWallet } from "../src/modules/accounting/domain/accounting.js";
import { PrivyFundsDepositedService } from "../src/modules/funding/application/privy-funds-deposited-service.js";
import {
  PrivyDepositWebhookError,
  type FinalizedDepositIngestor,
  type PrivyDepositWebhookReceipt,
  type PrivyDepositWebhookRepository,
  type PrivyFundsDepositedEvent,
} from "../src/modules/funding/domain/privy-funds-deposited.js";
import { mapPrivyWebhookEvent } from "../src/modules/trading/infrastructure/privy/privy-transaction-webhook-verifier.js";

const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const wallet: TrackedWallet = { userId: "user-1", walletId: "wallet-1", address: "recipient-1" };

test("maps a signed Privy SPL funds deposit payload", () => {
  const mapped = mapPrivyWebhookEvent({
    type: "wallet.funds_deposited",
    idempotency_key: "event-1",
    wallet_id: "privy-wallet-1",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: { type: "spl", address: mint },
    amount: "1000000",
    transaction_hash: "signature-1",
    sender: "sender-1",
    recipient: "recipient-1",
  });
  assert.equal(mapped?.kind, "funds_deposited");
  if (mapped?.kind !== "funds_deposited") return;
  assert.equal(mapped.event.rawAmount, "1000000");
  assert.equal(mapped.event.assetAddress, mint);
});

test("maps the Solana deposit payload emitted by Privy with asset.mint", () => {
  const mapped = mapPrivyWebhookEvent({
    type: "wallet.funds_deposited",
    idempotency_key: "event-solana-1",
    wallet_id: "privy-wallet-1",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: { type: "spl", mint },
    amount: "998810",
    transaction_hash: "signature-solana-1",
    sender: "sender-1",
    recipient: "recipient-1",
  });
  assert.equal(mapped?.kind, "funds_deposited");
  if (mapped?.kind !== "funds_deposited") return;
  assert.equal(mapped.event.assetAddress, mint);
  assert.equal(mapped.event.rawAmount, "998810");
});

test("does not silently acknowledge a malformed supported deposit event", () => {
  const mapped = mapPrivyWebhookEvent({
    type: "wallet.funds_deposited",
    idempotency_key: "event-1",
    wallet_id: "privy-wallet-1",
  });
  assert.deepEqual(mapped, { kind: "malformed_supported", eventType: "wallet.funds_deposited" });
});

test("processes one webhook receipt and delegates finalized evidence to accounting", async () => {
  const repository = new RepositoryStub();
  const accounting = new AccountingStub();
  const result = await service(repository, accounting).handle(event(), "a".repeat(64));
  assert.equal(result.duplicate, false);
  assert.equal(result.queued, false);
  assert.equal(accounting.calls, 1);
  assert.equal(accounting.last?.expectedRawAmount, "1000000");
  assert.deepEqual(repository.processed, ["event-1"]);
});

test("a processed Privy idempotency key never applies accounting twice", async () => {
  const repository = new RepositoryStub({ state: "processed" });
  const accounting = new AccountingStub();
  const result = await service(repository, accounting).handle(event(), "a".repeat(64));
  assert.equal(result.duplicate, true);
  assert.equal(result.queued, false);
  assert.equal(accounting.calls, 0);
});

test("wrong mint fails before receipt claim", async () => {
  const repository = new RepositoryStub();
  const accounting = new AccountingStub();
  await assert.rejects(
    service(repository, accounting).handle({ ...event(), assetAddress: "wrong-mint" }, "a".repeat(64)),
    (error: unknown) => error instanceof PrivyDepositWebhookError && error.code === "PRIVY_DEPOSIT_WRONG_ASSET",
  );
  assert.equal(repository.claims, 0);
  assert.equal(accounting.calls, 0);
});

test("retryable RPC failure is acknowledged after durable signature queueing", async () => {
  const repository = new RepositoryStub();
  const accounting = new AccountingStub();
  accounting.error = new AccountingError("ACCOUNTING_SOLANA_UNAVAILABLE", "RPC unavailable", true);
  const result = await service(repository, accounting).handle(event(), "a".repeat(64));
  assert.deepEqual(result, { duplicate: false, queued: true });
  assert.deepEqual(repository.failed, ["ACCOUNTING_SOLANA_UNAVAILABLE"]);
  assert.equal(accounting.calls, 1);
});

test("does not poll Solana repeatedly on the webhook request path", async () => {
  const repository = new RepositoryStub();
  const accounting = new AccountingStub();
  accounting.error = new AccountingError("ACCOUNTING_INVALID_SOLANA_RESPONSE", "Not finalized yet", true);
  const result = await service(repository, accounting).handle(event(), "a".repeat(64));
  assert.deepEqual(result, { duplicate: false, queued: true });
  assert.equal(accounting.calls, 1);
  assert.deepEqual(repository.failed, ["ACCOUNTING_INVALID_SOLANA_RESPONSE"]);
});

function service(
  repository: RepositoryStub,
  accounting: AccountingStub,
) {
  return new PrivyFundsDepositedService(repository, accounting, {
    canonicalUsdcMint: mint,
    solanaCaip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    staleReceiptAfterMs: 300_000,
  }, () => new Date("2026-09-01T12:10:00.000Z"));
}

test('stock webhook shares signed receipt handling but never calls the USDC deposit path', async () => {
  const repository = new RepositoryStub();
  const deposits = new AccountingStub();
  let calls = 0;
  const stocks = { isSupportedMint: async (value: string) => value === 'spy-mint',
    ingestFinalizedReceived: async (input: {expectedMint: string; expectedRawAmount: string}) => {
      calls++; assert.equal(input.expectedMint, 'spy-mint'); assert.equal(input.expectedRawAmount, '195646');
      return {duplicate: calls > 1};
    } };
  const handler = new PrivyFundsDepositedService(repository, deposits,
    {canonicalUsdcMint: mint, solanaCaip2: event().caip2, staleReceiptAfterMs: 300000}, undefined, stocks);
  assert.deepEqual(await handler.handle({...event(), assetAddress: 'spy-mint', rawAmount: '195646'}, 'a'.repeat(64)),
    {duplicate: false, queued: false});
  assert.equal(deposits.calls, 0); assert.equal(calls, 1);
  assert.deepEqual(repository.processed, ['event-1']);
  for (const change of [{assetAddress: 'fake-SPY'}, {caip2: 'eip155:1'}, {rawAmount: '0'}, {rawAmount: '18446744073709551616'}]) {
    await assert.rejects(handler.handle({...event(), assetAddress: 'spy-mint', ...change}, 'b'.repeat(64)));
  }
  assert.equal(repository.claims, 1);
});

test('stock finality handoff is acknowledged once and wallet mismatches never reach accounting', async () => {
  const repository = new RepositoryStub(); let calls = 0;
  const handler = new PrivyFundsDepositedService(repository, new AccountingStub(),
    {canonicalUsdcMint: mint, solanaCaip2: event().caip2, staleReceiptAfterMs: 300000}, undefined,
    {isSupportedMint: async () => true, ingestFinalizedReceived: async () => {
      calls++; throw new AccountingError('ACCOUNTING_FINALITY_PENDING', 'Awaiting finality', true);
    }});
  assert.deepEqual(await handler.handle({...event(), assetAddress: 'spy-mint'}, 'a'.repeat(64)),
    {duplicate: false, queued: true});
  assert.equal(calls, 1); assert.deepEqual(repository.failed, ['ACCOUNTING_FINALITY_PENDING']);
  repository.resolveWallet = async () => null;
  await assert.rejects(handler.handle({...event(), assetAddress: 'spy-mint'}, 'a'.repeat(64)),
    (error: unknown) => error instanceof PrivyDepositWebhookError && error.code === 'PRIVY_DEPOSIT_WALLET_MISMATCH');
  assert.equal(calls, 1);
});

function event(): PrivyFundsDepositedEvent {
  return {
    type: "wallet.funds_deposited",
    idempotencyKey: "event-1",
    walletId: "privy-wallet-1",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    assetType: "spl",
    assetAddress: mint,
    rawAmount: "1000000",
    transactionSignature: "signature-1",
    sender: "sender-1",
    recipient: wallet.address,
  };
}

class RepositoryStub implements PrivyDepositWebhookRepository {
  claims = 0;
  processed: string[] = [];
  failed: string[] = [];
  constructor(private readonly receipt: PrivyDepositWebhookReceipt = { state: "claimed" }) {}
  async claim() { this.claims += 1; return this.receipt; }
  async resolveWallet(): Promise<TrackedWallet | null> { return wallet; }
  async markProcessed(key: string) { this.processed.push(key); }
  async markFailed(_key: string, code: string) { this.failed.push(code); }
}

class AccountingStub implements FinalizedDepositIngestor {
  calls = 0;
  error: Error | null = null;
  errors: Error[] = [];
  last: { expectedRawAmount: string } | null = null;
  async ingestFinalizedDeposit(input: { expectedRawAmount: string }) {
    this.calls += 1;
    this.last = input;
    const queued = this.errors.shift();
    if (queued !== undefined) throw queued;
    if (this.error !== null) throw this.error;
    return { duplicate: false };
  }
}
