import assert from "node:assert/strict";
import test from "node:test";
import { decimalString, type Asset } from "../src/modules/assets/domain/asset.js";
import { FeeEngine } from "../src/modules/trading/application/fee-engine.js";
import { ChargedTradeQuote } from '../src/modules/trading/application/charged-trade-quote.js';
import { TradingService } from "../src/modules/trading/application/trading-service.js";
import { digestTransaction, type SolanaTradeTransactionValidator } from "../src/modules/trading/application/solana-trade-transaction-validator.js";
import { baseUnitAmount } from "../src/modules/trading/domain/base-units.js";
import {
  assertTradeOrderTransition,
  TradeOrderState,
  TradingEngineError,
  TradingProviderName,
  type CreateTradeRequest,
  type ProviderOrderRequest,
  type ProviderPreparedOrder,
  type SolanaExecutionGateway,
  type SolanaTransactionStatus,
  type SponsoredTransactionProvider,
  type SponsoredTransactionAuthorizationRequest,
  type SponsoredTransactionRequest,
  type SponsoredTransactionStatus,
  type TradeAggregate,
  type TradeExecution,
  type TradeOrder,
  type TradeOrderRepository,
  type TradeQuote,
  type TradingEngineErrorCode,
  type TradingProvider,
  type TradingWalletLookup,
} from "../src/modules/trading/domain/trading.js";
import {
  TradingChain,
  TradingSide,
  TradingWhitelistStatus,
  type ValidatedTradingPolicy,
} from "../src/modules/transaction-policy/domain/trading-policy.js";

const now = new Date("2026-09-01T00:00:00.000Z");
const walletAddress = "11111111111111111111111111111111";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const asset = sampleAsset();
test('NVDA xStocks DISPLAY Max converts full precision shares into exact raw tokens',async()=>{
  const f=serviceFixture();
  f.policy.asset={...asset,provider:'xstocks',decimals:8,multiplier:decimalString('1.0009180758490996')};
  const order=await f.service.createOrder(createRequest({side:TradingSide.SELL,
    amount:'0.009279731683173690062216',quantityUnit:'DISPLAY'}));
  assert.equal(f.provider.calls[0]?.amount,'927122');
  assert.equal(order.quote?.quantityMultiplier,'1.0009180758490996');
  assert.equal(f.privy.submissions,0);
  f.policy.asset={...f.policy.asset,multiplier:decimalString('1.001')};
  await assert.rejects(f.service.prepareOrderAuthorization({userId:'user-1',walletAddress,orderId:order.order.orderId,riskAcknowledged:true}),/quantity units changed/);
});
test('xStocks legacy TOKEN requests preserve token quantities; BUY snapshots display multiplier',async()=>{
  for(const side of [TradingSide.BUY,TradingSide.SELL]){
    const f=serviceFixture();f.policy.asset={...asset,provider:'xstocks',decimals:8,multiplier:decimalString('1.0009180758490996')};
    const order=await f.service.createOrder(createRequest({side,amount:'1'}));
    assert.equal(f.provider.calls[0]?.amount,side===TradingSide.BUY?'1000000':'100000000');
    assert.equal(order.quote?.quantityMultiplier,'1.0009180758490996');
  }
});

test('Sunrise SELL converts scaled shares to raw tokens and rejects a multiplier change before signing', async()=>{
  const fixture=serviceFixture();
  fixture.policy.asset={...asset,provider:'sunrise',decimals:6,multiplier:decimalString('1.0001068370781347')};
  const order=await fixture.service.createOrder(createRequest({side:TradingSide.SELL,amount:'1.0001068370781347',quantityUnit:'DISPLAY'}));
  assert.equal(fixture.provider.calls[0]?.amount,'1000000');
  assert.equal(order.quote?.quantityMultiplier,'1.0001068370781347');
  await assert.rejects(fixture.service.createOrder(createRequest({side:TradingSide.SELL,amount:'1.0001068370781347',quantityUnit:'TOKEN'})), /idempotency key/);
  fixture.policy.asset={...fixture.policy.asset,multiplier:decimalString('2')};
  await assert.rejects(fixture.service.prepareOrderAuthorization({userId:'user-1',walletAddress,orderId:order.order.orderId,riskAcknowledged:true}), /quantity units changed/);
  assert.equal(fixture.privy.submissions,0);
});

test('legacy Sunrise clients retain token-unit SELL semantics',async()=>{
  const fixture=serviceFixture();
  fixture.policy.asset={...asset,provider:'sunrise',decimals:6,multiplier:decimalString('1.0001068370781347')};
  await fixture.service.createOrder(createRequest({side:TradingSide.SELL,amount:'1'}));
  assert.equal(fixture.provider.calls[0]?.amount,'1000000');
});

test("BUY creates one idempotent DFlow order using the 100 USDC tiered fee", async () => {
  const fixture = serviceFixture();
  const first = await fixture.service.createOrder(createRequest());
  const repeated = await fixture.service.createOrder(createRequest({ amount: "100.0" }));

  assert.equal(fixture.provider.calls.length, 1);
  const providerRequest = fixture.provider.calls[0];
  assert.equal(providerRequest?.amount, "100000000");
  assert.equal(providerRequest?.platformFeeMode, "inputMint");
  assert.equal(providerRequest?.platformFeeBps, 95);
  assert.equal(providerRequest?.feeAccount, "TradeeUsdcFeeAta");
  assert.equal(first.quote?.grossInputAmount, "100000000");
  assert.equal(first.quote?.economicTradingAmount, "99050000");
  assert.equal(first.quote?.tradeeFee, "950000");
  assert.equal(first.order.state, TradeOrderState.AWAITING_SIGNATURE);
  assert.equal(repeated.order.orderId, first.order.orderId);
});

test("SELL resolves xStock base units and output-USDC platform fee", async () => {
  const fixture = serviceFixture();
  const result = await fixture.service.createOrder(createRequest({
    side: TradingSide.SELL,
    amount: "1.5",
    idempotencyKey: "sell-order-001",
  }));
  assert.equal(fixture.provider.calls.length, 2);
  const providerRequest = fixture.provider.calls[1];
  assert.equal(providerRequest?.inputMint, asset.solanaMint);
  assert.equal(providerRequest?.outputMint, usdc);
  assert.equal(providerRequest?.amount, "1500000000");
  assert.equal(providerRequest?.platformFeeMode, "outputMint");
  assert.equal(providerRequest?.platformFeeBps, 95);
  assert.equal(result.quote?.expectedOutputAmount, "99050000");
  assert.equal(result.quote?.tradeeFee, "950000");
});

test("SELL validates quoted gross USDC, rejecting below one dollar and accepting exactly one", async () => {
  const belowMinimum = serviceFixture(decimalString("0.01"), 999_999n);
  await assert.rejects(
    belowMinimum.service.createOrder(createRequest({
      side: TradingSide.SELL,
      amount: "0.01",
      idempotencyKey: "sell-exact-minimum-001",
    })),
    (error) => error instanceof TradingEngineError
      && error.code === "TRADE_SELL_VALUE_BELOW_MINIMUM",
  );

  const exactMinimum = serviceFixture(decimalString("0.01"), 1_000_000n);
  const exact = await exactMinimum.service.createOrder(createRequest({
    side: TradingSide.SELL, amount: "0.01", idempotencyKey: "sell-inclusive-minimum-001",
  }));
  assert.equal(BigInt(exact.quote!.expectedOutputAmount) + BigInt(exact.quote!.tradeeFee), 1_000_000n);
  assert.equal(exact.quote?.expectedOutputAmount, "900000");

  const aboveMinimum = serviceFixture(decimalString("0.01"), 1_000_001n);
  const created = await aboveMinimum.service.createOrder(createRequest({
    side: TradingSide.SELL,
    amount: "0.01",
    idempotencyKey: "sell-above-minimum-001",
  }));
  assert.equal(created.quote?.expectedOutputAmount, "900001");
  assert.equal(created.quote?.tradeeFee, "100000");
});

test("policy is enforced before DFlow and revalidated immediately before submission", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.createOrder(createRequest());
  assert.equal(fixture.policy.calls.length, 1);
  const submitted = await fixture.service.submitOrder({
    userId: "user-1",
    walletAddress,
    orderId: created.order.orderId,
    userAuthorizationToken: "privy-access-token",
    riskAcknowledged: false,
  });
  assert.equal(fixture.policy.calls.length, 2);
  assert.equal(submitted.order.state, TradeOrderState.SUBMITTED);
  assert.equal(submitted.execution?.transactionSignature, fixture.privy.signature);
  assert.equal(submitted.execution?.gasSponsored, true);
  assert.equal(fixture.privy.submissions, 1);

  const duplicate = await fixture.service.submitOrder({
    userId: "user-1",
    walletAddress,
    orderId: created.order.orderId,
    userAuthorizationToken: "privy-access-token",
    riskAcknowledged: false,
  });
  assert.equal(duplicate.order.state, TradeOrderState.SUBMITTED);
  assert.equal(fixture.privy.submissions, 1);
});

test("signature return remains SUBMITTED until Solana RPC confirms success", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.createOrder(createRequest());
  const submitted = await fixture.service.submitOrder({
    userId: "user-1",
    walletAddress,
    orderId: created.order.orderId,
    userAuthorizationToken: "privy-access-token",
    riskAcknowledged: false,
  });
  assert.equal(submitted.order.state, TradeOrderState.SUBMITTED);

  fixture.solana.status = { state: "confirmed", failure: null };
  const confirmed = await fixture.service.reconcileOrder(
    created.order.orderId,
    "user-1",
    walletAddress,
  );
  assert.equal(confirmed.order.state, TradeOrderState.CONFIRMED);
  assert.equal(confirmed.execution?.confirmedAt, now);
});

test("durably co-signed trade stays reserved on missing RPC status after blockhash expiry", async () => {
  const f = serviceFixture(), created = await f.service.createOrder(createRequest());
  await f.service.submitOrder({ userId: "user-1", walletAddress, orderId: created.order.orderId,
    userAuthorizationToken: "test-token", riskAcknowledged: false });
  f.privy.durablySigned = true;
  f.solana.blockHeight = 10000n;
  const recovered = await f.service.reconcileOrder(created.order.orderId, "user-1", walletAddress);
  assert.equal(recovered.order.state, TradeOrderState.SUBMITTED);
  assert.equal(f.privy.submissions, 1); assert.equal(f.privy.recoveryCalls, 1);
});

test("a database failure after Privy accepts a transaction keeps the claim and reconciles without a duplicate send", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.createOrder(createRequest());
  fixture.repository.failNextMarkSubmitted = true;

  await assert.rejects(
    fixture.service.submitOrder({
      userId: "user-1",
      walletAddress,
      orderId: created.order.orderId,
      userAuthorizationToken: "privy-access-token",
      riskAcknowledged: false,
    }),
    (error) => error instanceof TradingEngineError && error.code === "TRADE_SUBMISSION_AMBIGUOUS",
  );
  assert.equal(fixture.repository.releaseCount, 0);
  assert.notEqual((await fixture.repository.findById(created.order.orderId))?.order.submissionClaimedAt, null);

  fixture.privy.status = {
    state: "confirmed",
    transactionSignature: fixture.privy.signature,
    providerTransactionId: "privy-transaction-1",
    referenceId: `tradee:${created.order.orderId}`,
  };
  const recovered = await fixture.service.submitOrder({
    userId: "user-1",
    walletAddress,
    orderId: created.order.orderId,
    userAuthorizationToken: "privy-access-token",
    riskAcknowledged: false,
  });
  assert.equal(recovered.order.state, TradeOrderState.CONFIRMED);
  assert.equal(fixture.privy.submissions, 1);
});

test("an old claimed order missing from Privy is safely released and retried with the same order", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.createOrder(createRequest());
  await fixture.repository.claimSubmission(
    created.order.orderId,
    created.order.userId,
    created.quote?.transactionDigest ?? "missing",
    false,
    fixture.clock.current,
  );
  fixture.clock.current = new Date(fixture.clock.current.getTime() + 5_001);

  const recovered = await fixture.service.submitOrder({
    userId: "user-1",
    walletAddress,
    orderId: created.order.orderId,
    userAuthorizationToken: "privy-access-token",
    riskAcknowledged: false,
  });

  assert.equal(recovered.order.state, TradeOrderState.SUBMITTED);
  assert.equal(fixture.repository.releaseCount, 1);
  assert.equal(fixture.privy.submissions, 1);
});

test("expired lastValidBlockHeight prevents transaction submission", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.createOrder(createRequest());
  fixture.solana.blockHeight = 1_000n;
  const result = await fixture.service.submitOrder({
    userId: "user-1",
    walletAddress,
    orderId: created.order.orderId,
    userAuthorizationToken: "privy-access-token",
    riskAcknowledged: false,
  });
  assert.equal(result.order.state, TradeOrderState.EXPIRED);
  assert.equal(fixture.privy.submissions, 0);
});

test("slippage is controlled by Tradee policy instead of arbitrary client values", async () => {
  const fixture = serviceFixture();
  await assert.rejects(
    fixture.service.createOrder(createRequest({ slippageBps: 301 })),
    (error) => error instanceof TradingEngineError && error.code === "TRADE_INVALID_SLIPPAGE",
  );
  assert.equal(fixture.provider.calls.length, 0);
});

test("amount precision errors are explicit client errors and never reach DFlow", async () => {
  const fixture = serviceFixture();
  await assert.rejects(
    fixture.service.createOrder(createRequest({
      amount: "1.0000001",
      idempotencyKey: "buy-invalid-precision-001",
    })),
    (error) => error instanceof TradingEngineError
      && error.code === "TRADE_INVALID_AMOUNT_PRECISION"
      && error.recoverable,
  );
  assert.equal(fixture.provider.calls.length, 0);
});

test("idempotency key cannot be reused for a different trade", async () => {
  const fixture = serviceFixture();
  await fixture.service.createOrder(createRequest());
  await assert.rejects(
    fixture.service.createOrder(createRequest({ assetId: "22222222-2222-4222-8222-222222222222" })),
    (error) => error instanceof TradingEngineError && error.code === "TRADE_IDEMPOTENCY_CONFLICT",
  );
});

test("high execution-price movement requires explicit acknowledgement before Privy submission", async () => {
  const fixture = serviceFixture(decimalString("1.01"));
  const created = await fixture.service.createOrder(createRequest());
  assert.equal(created.quote?.executionRisk.requiresAcknowledgement, true);
  assert.equal(created.quote?.executionRisk.thresholdPercent, "1");

  await assert.rejects(
    fixture.service.submitOrder({
      userId: "user-1",
      walletAddress,
      orderId: created.order.orderId,
      userAuthorizationToken: "privy-access-token",
      riskAcknowledged: false,
    }),
    (error) => error instanceof TradingEngineError
      && error.code === "TRADE_RISK_ACKNOWLEDGEMENT_REQUIRED",
  );
  assert.equal(fixture.privy.submissions, 0);

  const submitted = await fixture.service.submitOrder({
    userId: "user-1",
    walletAddress,
    orderId: created.order.orderId,
    userAuthorizationToken: "privy-access-token",
    riskAcknowledged: true,
  });
  assert.equal(submitted.order.state, TradeOrderState.SUBMITTED);
  assert.equal(submitted.order.riskAcknowledgedAt, now);
  assert.equal(fixture.privy.submissions, 1);
});

test("SELL execution risk is tiered by quoted gross USDC proceeds, not share quantity", async () => {
  const fixture = serviceFixture(decimalString("1.01"));
  const created = await fixture.service.createOrder(createRequest({
    side: TradingSide.SELL,
    amount: "1.5",
    idempotencyKey: "sell-risk-tier-001",
  }));

  assert.equal(created.quote?.executionRisk.thresholdPercent, "1");
  assert.equal(created.quote?.executionRisk.requiresAcknowledgement, true);
});

test("confirmed response does not wait for social receipt capture", { timeout: 1000 }, async () => {
  let release!: () => void;
  let captureStarted = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const fixture = serviceFixture(undefined, undefined, { prepare: async () => {
    captureStarted = true;
    await blocked;
  } });
  try {
    const created = await fixture.service.createOrder(createRequest());
    await fixture.service.submitOrder({ userId: "user-1", walletAddress,
      orderId: created.order.orderId, riskAcknowledged: false, userAuthorizationToken: "test" });
    fixture.solana.status = { state: "confirmed", failure: null };
    const result = await fixture.service.reconcileOrder(created.order.orderId, "user-1", walletAddress);
    assert.equal(result.order.state, TradeOrderState.CONFIRMED);
    assert.equal(captureStarted, true);
  } finally { release(); }
});

test("receipt failure cannot fail a confirmed trade or escape as an unhandled rejection", async () => {
  const fixture = serviceFixture(undefined, undefined, { prepare: async () => { throw new Error("receipt unavailable"); } });
  const created = await fixture.service.createOrder(createRequest());
  await fixture.service.submitOrder({ userId: "user-1", walletAddress,
    orderId: created.order.orderId, riskAcknowledged: false, userAuthorizationToken: "test" });
  fixture.solana.status = { state: "confirmed", failure: null };
  const result = await fixture.service.reconcileOrder(created.order.orderId, "user-1", walletAddress);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.order.state, TradeOrderState.CONFIRMED);
});

for (const phase of ["prepare", "submit"] as const) {
  test(`${phase} overlaps independent RPC validation and never sends before validation completes`, { timeout: 1000 }, async () => {
    const fixture = serviceFixture();
    const created = await fixture.service.createOrder(createRequest());
    let heightStarted = false;
    let releaseHeight!: () => void;
    const height = new Promise<void>((resolve) => { releaseHeight = resolve; });
    fixture.solana.getBlockHeight = async () => { heightStarted = true; await height; return 1n; };
    const validate = fixture.validator.validate;
    fixture.validator.validate = async (aggregate) => {
      assert.equal(heightStarted, true);
      assert.equal(fixture.privy.submissions, 0);
      releaseHeight();
      return validate(aggregate);
    };
    const request = { userId: "user-1", walletAddress, orderId: created.order.orderId, riskAcknowledged: false };
    if (phase === "prepare") await fixture.service.prepareOrderAuthorization(request);
    else await fixture.service.submitOrder({ ...request, userAuthorizationToken: "test" });
    assert.equal(fixture.privy.submissions, phase === "submit" ? 1 : 0);
  });
}

function serviceFixture(priceImpact = decimalString("0.01"), sellGrossOutput = 100_000_000n,
  receipts?: { prepare(executionId: string, userId: string): Promise<void> }, chargedQuotes?:ChargedTradeQuote) {
  const policy = new PolicyStub();
  const repository = new InMemoryTradeOrderRepository();
  const provider = new ProviderStub(priceImpact, sellGrossOutput);
  const solana = new SolanaStub();
  const privy = new PrivyStub();
  const clock = { current: now };
  const wallets: TradingWalletLookup = {
    findOwnedSolanaWallet: async (userId, address) => userId === "user-1" && address === walletAddress
      ? { id: "wallet-1", userId, address, providerWalletId: "privy-wallet-1", teeExecutionEnabled: true }
      : null,
  };
  const validator = {
    validate: async (aggregate: TradeAggregate) => ({
      serializedTransaction: aggregate.quote?.transaction ?? "",
      transactionDigest: aggregate.quote?.transactionDigest ?? "",
      programIds: [] as string[],
    }),
  };
  const sponsorship = {
    evaluate: async () => ({ eligible: true, reason: "eligible" as const }),
    inspect: async () => ({ eligible: true, reason: "eligible" as const }),
  };
  const service = new TradingService(
    policy,
    wallets,
    repository,
    provider,
    new FeeEngine(),
    solana,
    privy,
    sponsorship,
    validator as unknown as SolanaTradeTransactionValidator,
    {
      usdcMint: usdc,
      usdcDecimals: 6,
      feeAccountUsdc: "TradeeUsdcFeeAta",
      minimumSellGrossProceeds: baseUnitAmount("1000000"),
      defaultSlippageBps: 50,
      minimumSlippageBps: 1,
      maximumSlippageBps: 300,
      submissionRecoveryDelayMs: 5_000,
    },
    () => clock.current,
    receipts,
    chargedQuotes,
  );
  return { service, policy, repository, provider, solana, privy, clock, validator, sponsorship };
}

test('fee refresh is owned, unsigned-only, leaves the snapshot immutable and never requotes DFlow',async()=>{
 const provider=new ProviderStub(decimalString('0.01'),100_000_000n);
 let debit=10000n;let checkedAt=now;
 const charged=new ChargedTradeQuote(provider,{collect:async transaction=>transaction},{estimate:async()=>({networkLamports:10000n,payerDebitLamports:debit,now:checkedAt,
  price:{source:'JUPITER_PRICE_V3',mint:'So11111111111111111111111111111111111111112',usdPerSol:'100',blockId:'1',blockTime:checkedAt.toISOString(),fetchedAt:checkedAt.toISOString()}})},6);
 const f=serviceFixture(undefined,undefined,undefined,charged);
 const order=await f.service.createOrder(createRequest());const id=order.order.orderId;
 const calls=provider.calls.length;checkedAt=new Date(now.getTime()+20_000);f.clock.current=checkedAt;
 await assert.rejects(f.service.refreshNetworkFee(id,'another-user',walletAddress));
 const result=await f.service.refreshNetworkFee(id,'user-1',walletAddress);
 assert.equal(result.refreshRequired,false);assert.equal(result.quotedAt,checkedAt.toISOString());
 assert.equal(provider.calls.length,calls);
 assert.equal((await f.repository.findById(id))?.quote?.feeQuote?.quotedAt,now.toISOString());
 await f.service.prepareOrderAuthorization({orderId:id,userId:'user-1',walletAddress,riskAcknowledged:true});
 debit=2000000n;
 assert.equal((await f.service.refreshNetworkFee(id,'user-1',walletAddress)).refreshRequired,true);
 await assert.rejects(f.service.prepareOrderAuthorization({orderId:id,userId:'user-1',walletAddress,riskAcknowledged:true}));
 assert.equal(provider.calls.length,calls);
 await f.repository.claimSubmission(id,'user-1','payload',true,checkedAt);
 await assert.rejects(f.service.refreshNetworkFee(id,'user-1',walletAddress));
});

class PolicyStub {
  readonly calls: unknown[] = [];
  asset = asset;
  async validateTrade(request: { readonly side: TradingSide; readonly amount: string }): Promise<ValidatedTradingPolicy> {
    this.calls.push(request);
    return {
      asset: this.asset,
      whitelist: {
        id: "whitelist-1",
        assetId: asset.id,
        status: TradingWhitelistStatus.ACTIVE,
        buyEnabled: true,
        sellEnabled: true,
        minBuyAmount: null,
        maxBuyAmount: null,
        minSellAmount: null,
        maxSellAmount: null,
        feeBps: 50,
        enabledAt: now,
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      },
      side: request.side,
      amount: decimalString(request.amount.replace(/\.0$/, "")),
      feeBps: 50,
      validatedAt: now,
    };
  }
}

class ProviderStub implements TradingProvider {
  readonly name = TradingProviderName.DFLOW;
  readonly calls: ProviderOrderRequest[] = [];
  constructor(
    private readonly priceImpact: ReturnType<typeof decimalString>,
    private readonly sellGrossOutput: bigint,
  ) {}
  async createOrder(request: ProviderOrderRequest): Promise<ProviderPreparedOrder> {
    this.calls.push(request);
    const buy = request.platformFeeMode === "inputMint";
    const feeBase = buy ? BigInt(request.amount) : this.sellGrossOutput;
    const platformFeeAmount = feeBase * BigInt(request.platformFeeBps) / 10_000n;
    return {
      provider: this.name,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputAmount: request.amount,
      outputAmount: baseUnitAmount(buy ? "250000" : (feeBase - platformFeeAmount).toString()),
      minimumOutputAmount: baseUnitAmount(
        buy ? "247500" : ((feeBase - platformFeeAmount) * 99n / 100n).toString(),
      ),
      platformFeeAmount: baseUnitAmount(platformFeeAmount.toString()),
      platformFeeBps: request.platformFeeBps,
      platformFeeMode: request.platformFeeMode,
      slippageBps: request.slippageBps,
      priceImpact: this.priceImpact,
      lastValidBlockHeight: 999n,
      providerReference: "provider-ref",
      executionMode: "sync",
      route: [],
      transaction: preparedTransaction(),
    };
  }
}

class SolanaStub implements SolanaExecutionGateway {
  blockHeight = 10n;
  status: SolanaTransactionStatus = { state: "pending", failure: null };
  async getBlockHeight(): Promise<bigint> { return this.blockHeight; }
  async getTransactionStatus(): Promise<SolanaTransactionStatus> { return this.status; }
}

class PrivyStub implements SponsoredTransactionProvider {
  durablySigned = false;
  recoveryCalls = 0;
  async isDurablySigned() { return this.durablySigned; }
  async recoverSubmission() { this.recoveryCalls++; }
  readonly signature = "5".repeat(64);
  submissions = 0;
  status: SponsoredTransactionStatus | null = null;
  createAuthorizationChallenge(request: SponsoredTransactionAuthorizationRequest) {
    return {
      payloadBase64: Buffer.from(request.transactionDigest).toString("base64"),
      requestExpiry: Date.now() + 30_000,
    };
  }
  async signAndSend(request: SponsoredTransactionRequest) {
    this.submissions += 1;
    return {
      transactionSignature: this.signature,
      providerTransactionId: "privy-transaction-1",
      referenceId: request.referenceId,
      sponsored: true as const,
    };
  }
  async getByReferenceId(referenceId: string): Promise<SponsoredTransactionStatus> {
    return this.status ?? { state: "not_found", transactionSignature: null, providerTransactionId: null, referenceId };
  }
}

class InMemoryTradeOrderRepository implements TradeOrderRepository {
  private readonly values = new Map<string, TradeAggregate>();
  failNextMarkSubmitted = false;
  releaseCount = 0;
  async findByUserAndIdempotencyKey(userId: string, key: string): Promise<TradeAggregate | null> {
    return [...this.values.values()].find((value) => value.order.userId === userId && value.order.idempotencyKey === key) ?? null;
  }
  async findById(orderId: string): Promise<TradeAggregate | null> { return this.values.get(orderId) ?? null; }
  async findByPrivyReferenceId(referenceId: string): Promise<TradeAggregate | null> {
    return [...this.values.values()].find((value) => value.execution?.privyReferenceId === referenceId) ?? null;
  }
  async reserve(order: TradeOrder) {
    const existing = await this.findByUserAndIdempotencyKey(order.userId, order.idempotencyKey);
    if (existing !== null) return { aggregate: existing, created: false as const };
    const aggregate = { order, quote: null, execution: null };
    this.values.set(order.orderId, aggregate);
    return { aggregate, created: true as const };
  }
  async attachQuote(orderId: string, quote: TradeQuote, updatedAt: Date): Promise<TradeAggregate> {
    const value = required(this.values.get(orderId));
    const aggregate = {
      order: { ...value.order, quoteId: quote.quoteId, state: TradeOrderState.AWAITING_SIGNATURE, updatedAt },
      quote,
      execution: null,
    };
    this.values.set(orderId, aggregate);
    return aggregate;
  }
  async claimSubmission(
    orderId: string,
    _userId: string,
    hash: string,
    riskAcknowledged: boolean,
    claimedAt: Date,
  ): Promise<TradeAggregate> {
    const value = required(this.values.get(orderId));
    if (value.order.submissionClaimedAt !== null) {
      throw new TradingEngineError("TRADE_SUBMISSION_AMBIGUOUS", "already claimed");
    }
    const aggregate = {
      ...value,
      order: {
        ...value.order,
        submissionClaimedAt: claimedAt,
        submissionPayloadHash: hash,
        riskAcknowledgedAt: riskAcknowledged ? claimedAt : value.order.riskAcknowledgedAt,
      },
    };
    this.values.set(orderId, aggregate);
    return aggregate;
  }
  async releaseSubmissionClaim(orderId: string): Promise<void> {
    this.releaseCount += 1;
    const value = required(this.values.get(orderId));
    this.values.set(orderId, { ...value, order: { ...value.order, submissionClaimedAt: null, submissionPayloadHash: null } });
  }
  async markSubmitted(orderId: string, _userId: string, execution: TradeExecution, updatedAt: Date): Promise<TradeAggregate> {
    if (this.failNextMarkSubmitted) {
      this.failNextMarkSubmitted = false;
      throw new Error("simulated database write failure");
    }
    const value = required(this.values.get(orderId));
    const aggregate = {
      ...value,
      order: { ...value.order, state: TradeOrderState.SUBMITTED, updatedAt },
      execution,
    };
    this.values.set(orderId, aggregate);
    return aggregate;
  }
  async transition(orderId: string, next: TradeOrderState, updatedAt: Date, failureCode?: TradingEngineErrorCode): Promise<TradeAggregate> {
    const value = required(this.values.get(orderId));
    if (value.order.state !== next) assertTradeOrderTransition(value.order.state, next);
    const execution = value.execution === null ? null : {
      ...value.execution,
      confirmedAt: next === TradeOrderState.CONFIRMED ? updatedAt : value.execution.confirmedAt,
      failedAt: next === TradeOrderState.FAILED || next === TradeOrderState.EXPIRED ? updatedAt : value.execution.failedAt,
      failureCode: failureCode ?? value.execution.failureCode,
    };
    const aggregate = {
      ...value,
      order: { ...value.order, state: next, updatedAt, failureCode: failureCode ?? value.order.failureCode },
      execution,
    };
    this.values.set(orderId, aggregate);
    return aggregate;
  }
}

function createRequest(overrides: Partial<CreateTradeRequest> = {}): CreateTradeRequest {
  return {
    userId: "user-1",
    walletAddress,
    assetId: asset.id,
    side: TradingSide.BUY,
    amount: "100",
    idempotencyKey: "buy-order-001",
    ...overrides,
  };
}

function sampleAsset(): Asset {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ticker: "TSLA",
    xStockSymbol: "TSLAx",
    name: "Tesla",
    logoUrl: null,
    solanaMint: "TSLAMint11111111111111111111111111111111",
    decimals: 9,
    sector: null,
    providerAvailable: true,
    active: true,
    currentPrice: null,
    priceChange: null,
    multiplier: null,
    providerTimestamps: {
      createdAt: null,
      updatedAt: null,
      observedAt: now,
      priceObservedAt: null,
      multiplierObservedAt: null,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function preparedTransaction(): string {
  return serializedTransaction([Buffer.alloc(64), Buffer.alloc(64)]);
}

function serializedTransaction(signatures: readonly Buffer[]): string {
  return Buffer.concat([
    Buffer.from([signatures.length]),
    ...signatures,
    Buffer.from([0x80, 1, 2, 3, 4]),
  ]).toString("base64");
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test value");
  return value;
}

for (const side of [TradingSide.BUY, TradingSide.SELL]) {
  test(`Stockmemes ${side} uses 10% DFlow slippage with identical fee terms and policy checks`, async () => {
    const stock = serviceFixture(), meme = serviceFixture();
    meme.policy.asset = { ...meme.policy.asset, assetClass: "stockmemes" };
    const amount = side === TradingSide.BUY ? "100" : "1";
    const normal = await stock.service.createOrder(createRequest({side,amount}));
    const result = await meme.service.createOrder(createRequest({side,amount,slippageBps:50}));
    assert.equal(result.quote?.slippageBps,1000);
    assert.equal(normal.quote?.slippageBps,50);
    assert.equal(result.quote?.tradeeFeeBps,normal.quote?.tradeeFeeBps);
    assert.equal(result.quote?.tradeeFee,normal.quote?.tradeeFee);
    assert.equal(result.quote?.grossInputAmount,normal.quote?.grossInputAmount);
    assert.equal(meme.policy.calls.length,1);
    assert.equal(meme.privy.submissions,0);
    assert.ok(meme.provider.calls.every(call=>call.slippageBps===1000));
  });
}

for (const state of ['confirmed', 'failed'] as const) {
  test(`terminal ${state} status returns without waiting for sponsored recovery`, async () => {
    const f = serviceFixture();
    const created = await f.service.createOrder(createRequest());
    await f.service.submitOrder({ orderId: created.order.orderId, userId: 'user-1', walletAddress, riskAcknowledged: false, userAuthorizationToken: 'test' });
    let recoveryCalls = 0;
    (f.privy as SponsoredTransactionProvider).recoverSubmission = async () => { recoveryCalls++; throw new Error('slow recovery must not block'); };
    f.solana.status = { state, failure: state === 'failed' ? 'onchain_transaction_failed' : null };
    const result = await f.service.reconcileOrder(created.order.orderId, 'user-1', walletAddress);
    assert.equal(result.order.state, state === 'confirmed' ? TradeOrderState.CONFIRMED : TradeOrderState.FAILED);
    assert.equal(recoveryCalls, 0);
  });
}

test('pending status and status transport failures retain identical-order recovery', async () => {
  const f = serviceFixture();
  const created = await f.service.createOrder(createRequest());
  await f.service.submitOrder({ orderId: created.order.orderId, userId: 'user-1', walletAddress, riskAcknowledged: false, userAuthorizationToken: 'test' });
  let recoveryCalls = 0;
  (f.privy as SponsoredTransactionProvider).recoverSubmission = async () => { recoveryCalls++; };
  await f.service.reconcileOrder(created.order.orderId, 'user-1', walletAddress);
  assert.equal(recoveryCalls, 1);
  let reads = 0;
  f.solana.getTransactionStatus = async () => { if (++reads === 1) throw new Error('RPC unavailable'); return { state: 'confirmed', failure: null }; };
  const result = await f.service.reconcileOrder(created.order.orderId, 'user-1', walletAddress);
  assert.equal(result.order.state, TradeOrderState.CONFIRMED);
  assert.equal(recoveryCalls, 2);
});

test('recent fee proof is reused across refresh/authorization/submit without extending the reviewed route', async () => {
  const provider = new ProviderStub(decimalString('0.01'),100_000_000n);
  let checks = 0, checkedAt = now;
  const charged = new ChargedTradeQuote(provider,{collect:async transaction=>transaction},{estimate:async()=>{
    checks++;
    return {networkLamports:10000n,payerDebitLamports:10000n,now:checkedAt,
      price:{source:'JUPITER_PRICE_V3',mint:'So11111111111111111111111111111111111111112',usdPerSol:'100',blockId:'1',blockTime:checkedAt.toISOString(),fetchedAt:checkedAt.toISOString()}};
  }},6);
  const f = serviceFixture(undefined,undefined,undefined,charged);
  const order = await f.service.createOrder(createRequest()); const id = order.order.orderId;
  checkedAt = new Date(now.getTime()+20_000); f.clock.current = checkedAt;
  const before = checks;
  await f.service.refreshNetworkFee(id,'user-1',walletAddress);
  await f.service.prepareOrderAuthorization({orderId:id,userId:'user-1',walletAddress,riskAcknowledged:true});
  assert.equal(checks,before+1);
  // Public fee refresh remains an explicit fresh read, even within the proof TTL.
  await f.service.refreshNetworkFee(id,'user-1',walletAddress);
  assert.equal(checks,before+2);
  f.clock.current = checkedAt = new Date(now.getTime()+22_001);
  await f.service.prepareOrderAuthorization({orderId:id,userId:'user-1',walletAddress,riskAcknowledged:true});
  assert.equal(checks,before+3);
  const policies = f.policy.calls.length;
  await f.service.submitOrder({orderId:id,userId:'user-1',walletAddress,riskAcknowledged:true,userAuthorizationToken:'test'});
  assert.equal(checks,before+3);
  assert.ok(f.policy.calls.length>policies);
  assert.equal((await f.repository.findById(id))?.quote?.feeQuote?.quotedAt,now.toISOString());
});

test('speculative authorization checks eligibility but never admits, signs or submits', async () => {
  const f = serviceFixture(); let admits = 0, previews = 0;
  f.sponsorship.evaluate = async () => { admits++; return { eligible: true, reason: 'eligible' }; };
  f.sponsorship.inspect = async () => { previews++; return { eligible: true, reason: 'eligible' }; };
  const created = await f.service.createOrder(createRequest());
  const request = { orderId: created.order.orderId, userId: 'user-1', walletAddress, riskAcknowledged: false };
  await f.service.prepareOrderAuthorization({ ...request, preparingOnly: true });
  assert.equal(previews, 1); assert.equal(admits, 0); assert.equal(f.privy.submissions, 0);
  await f.service.submitOrder({ ...request, userAuthorizationToken: 'test' });
  assert.equal(admits, 1); assert.equal(f.privy.submissions, 1);
});

test('speculative preparation cannot implicitly acknowledge a high-risk trade', async () => {
  const f = serviceFixture(decimalString('20'));
  const created = await f.service.createOrder(createRequest());
  assert.equal(created.quote!.executionRisk.requiresAcknowledgement, true);
  await assert.rejects(f.service.prepareOrderAuthorization({ orderId: created.order.orderId, userId: 'user-1', walletAddress,
    riskAcknowledged: true, preparingOnly: true }), /explicit confirmation/);
  assert.equal(f.privy.submissions, 0);
});
