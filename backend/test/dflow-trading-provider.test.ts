import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { FeeEngine } from "../src/modules/trading/application/fee-engine.js";
import { baseUnitAmount } from "../src/modules/trading/domain/base-units.js";
import { TradingEngineError } from "../src/modules/trading/domain/trading.js";
import {
  DFlowClient,
  type DFlowHttpRequest,
} from "../src/modules/trading/infrastructure/dflow/dflow-client.js";
import { dflowClientConfiguration } from "../src/modules/trading/infrastructure/dflow/dflow-configuration.js";
import { DFlowTradingProvider } from "../src/modules/trading/infrastructure/dflow/dflow-trading-provider.js";

const feeAccount = "FeeAccount1111111111111111111111111111111";
const user = "UserWallet111111111111111111111111111111";
const usdc = "USDCMint11111111111111111111111111111111";
const tsla = "TSLAMint11111111111111111111111111111111";

test("development DFlow client sends no API key and never puts a key in the URL", async () => {
  let captured: DFlowHttpRequest | undefined;
  const client = new DFlowClient(
    dflowClientConfiguration({ DFLOW_ENV: "development" }),
    async (request) => {
      captured = request;
      return response(orderResponse({}));
    },
  );
  await client.getOrder({ inputMint: usdc });
  assert.equal(captured?.headers["x-api-key"], undefined);
  assert.equal(captured?.url.origin, "https://dev-quote-api.dflow.net");
  assert.equal(captured?.url.searchParams.has("apiKey"), false);
  assert.equal(captured?.url.searchParams.has("token"), false);
});

test("production configuration requires key and sends x-api-key header only", async () => {
  assert.throws(
    () => dflowClientConfiguration({ DFLOW_ENV: "production" }),
    /DFLOW_API_KEY is required/,
  );
  let captured: DFlowHttpRequest | undefined;
  const client = new DFlowClient(
    dflowClientConfiguration({ DFLOW_ENV: "production", DFLOW_API_KEY: "production-secret" }),
    async (request) => {
      captured = request;
      return response(orderResponse({}));
    },
  );
  await client.getOrder({ inputMint: usdc });
  assert.equal(captured?.headers["x-api-key"], "production-secret");
  assert.equal(captured?.url.toString().includes("production-secret"), false);
  assert.equal(captured?.headers.authorization, undefined);
});

test("BUY maps gross USDC amount and prepares DFlow for Privy sponsorship", async () => {
  let captured: DFlowHttpRequest | undefined;
  const provider = providerWithResponse(orderResponse({
    inAmount: "100000000",
    outAmount: "250000",
    minimumOutput: "247500",
    platformFee: { amount: "500000", feeBps: 50, mode: "inputMint" },
  }), (request) => { captured = request; });
  const prepared = await provider.createOrder({
    inputMint: usdc,
    outputMint: tsla,
    amount: baseUnitAmount("100000000"),
    userPublicKey: user,
    slippageBps: 50,
    platformFeeBps: 50,
    platformFeeMode: "inputMint",
    feeAccount,
  });

  assert.equal(captured?.url.pathname, "/order");
  assert.equal(captured?.url.searchParams.get("amount"), "100000000");
  assert.equal(captured?.url.searchParams.get("platformFeeMode"), "inputMint");
  assert.equal(captured?.url.searchParams.get("platformFeeBps"), "50");
  assert.equal(captured?.url.searchParams.get("feeAccount"), feeAccount);
  assert.equal(captured?.url.searchParams.get("userPublicKey"), user);
  assert.equal(captured?.url.searchParams.get("sponsoredSwap"), "true");
  assert.equal(captured?.url.searchParams.get("sponsorExec"), "false");
  assert.equal(prepared.inputAmount, "100000000");
  assert.equal(prepared.platformFeeAmount, "500000");
  new FeeEngine().verifyProviderFee(prepared, 50, "inputMint");
});

test("own sponsor is fixed before signing and DFlow cannot replace the signer pair", async () => {
  const payer = Keypair.generate().publicKey, owner = Keypair.generate().publicKey;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.alloc(0) })] }).compileToV0Message());
  let captured: DFlowHttpRequest | undefined;
  let payload = { ...orderResponse({}), transaction: Buffer.from(tx.serialize()).toString("base64") };
  const client = new DFlowClient(dflowClientConfiguration({}), async req => { captured = req; return response(payload); });
  const provider = new DFlowTradingProvider(client, { feeAccountUsdc: feeAccount, sponsor: payer.toBase58(), priorityLamports: "100000" });
  const request = { inputMint: usdc, outputMint: tsla, amount: baseUnitAmount("100000000"), userPublicKey: owner.toBase58(), slippageBps: 50,
    platformFeeBps: 50, platformFeeMode: "inputMint" as const, feeAccount };
  assert.deepEqual((await provider.createOrder(request)).requiredSigners, [payer.toBase58(), owner.toBase58()]);
  assert.equal(captured?.url.searchParams.get("sponsor"), payer.toBase58());
  assert.equal(captured?.url.searchParams.get("sponsorExec"), "false");
  assert.equal(captured?.url.searchParams.get("prioritizationFeeLamports"), "100000");
  assert.equal(captured?.url.searchParams.get("allowAsyncExec"), "false");
  payload = orderResponse({});
  await assert.rejects(provider.createOrder(request), /signer pair/);
});

test("SELL maps xStock input and collects Tradee fee from net USDC output", async () => {
  let captured: DFlowHttpRequest | undefined;
  const provider = providerWithResponse(orderResponse({
    inputMint: tsla,
    outputMint: usdc,
    inAmount: "1000000",
    outAmount: "99500000",
    minimumOutput: "99000000",
    platformFee: { amount: "500000", feeBps: 50, mode: "outputMint" },
  }), (request) => { captured = request; });
  const prepared = await provider.createOrder({
    inputMint: tsla,
    outputMint: usdc,
    amount: baseUnitAmount("1000000"),
    userPublicKey: user,
    slippageBps: 50,
    platformFeeBps: 50,
    platformFeeMode: "outputMint",
    feeAccount,
  });
  assert.equal(captured?.url.searchParams.get("inputMint"), tsla);
  assert.equal(captured?.url.searchParams.get("outputMint"), usdc);
  assert.equal(captured?.url.searchParams.get("platformFeeMode"), "outputMint");
  assert.equal(prepared.outputAmount, "99500000");
  new FeeEngine().verifyProviderFee(prepared, 50, "outputMint");
});

test("DFlow price impact ratio is normalized to UI percentage points", async () => {
  const oneBasisPoint = await providerWithResponse(orderResponse({
    priceImpactPct: "0.0001",
  })).createOrder(providerRequest());
  const onePercent = await providerWithResponse(orderResponse({
    priceImpactPct: "0.01",
  })).createOrder(providerRequest());

  assert.equal(oneBasisPoint.priceImpact, "0.01");
  assert.equal(onePercent.priceImpact, "1");
});

test("DFlow response mismatches and async spot execution fail closed", async () => {
  const mismatch = providerWithResponse(orderResponse({ inputMint: tsla }));
  await assert.rejects(
    mismatch.createOrder(providerRequest()),
    isEngineError("TRADE_INVALID_ROUTE"),
  );
  const asyncProvider = providerWithResponse(orderResponse({ executionMode: "async" }));
  await assert.rejects(
    asyncProvider.createOrder(providerRequest()),
    isEngineError("TRADE_INVALID_ROUTE"),
  );
});

test("DFlow HTTP errors map to provider-neutral Tradee errors", async () => {
  for (const [status, code] of [[401, "TRADE_PROVIDER_AUTH_FAILED"], [429, "TRADE_PROVIDER_RATE_LIMITED"], [503, "TRADE_PROVIDER_UNAVAILABLE"]] as const) {
    const client = new DFlowClient(
      dflowClientConfiguration({ DFLOW_ENV: "development" }),
      async () => response({ code: "internal" }, status),
    );
    await assert.rejects(client.getOrder({}), isEngineError(code));
  }
  const client = new DFlowClient(
    dflowClientConfiguration({ DFLOW_ENV: "development" }),
    async () => response({ code: "route_not_found", msg: "raw provider details" }, 400),
  );
  await assert.rejects(
    client.getOrder({}),
    (error) => error instanceof TradingEngineError
      && error.code === "TRADE_INVALID_ROUTE"
      && !error.message.includes("raw provider details"),
  );
});

function providerWithResponse(body: unknown, capture?: (request: DFlowHttpRequest) => void) {
  const client = new DFlowClient(
    dflowClientConfiguration({ DFLOW_ENV: "development" }),
    async (request) => {
      capture?.(request);
      return response(body);
    },
  );
  return new DFlowTradingProvider(client, { feeAccountUsdc: feeAccount });
}

function providerRequest() {
  return {
    inputMint: usdc,
    outputMint: tsla,
    amount: baseUnitAmount("100000000"),
    userPublicKey: user,
    slippageBps: 50,
    platformFeeBps: 50,
    platformFeeMode: "inputMint" as const,
    feeAccount,
  };
}

function orderResponse(overrides: {
  readonly inputMint?: string;
  readonly outputMint?: string;
  readonly inAmount?: string;
  readonly outAmount?: string;
  readonly minimumOutput?: string;
  readonly executionMode?: string;
  readonly priceImpactPct?: string;
  readonly platformFee?: { readonly amount: string; readonly feeBps: number; readonly mode: string };
}) {
  const inputMint = overrides.inputMint ?? usdc;
  const outputMint = overrides.outputMint ?? tsla;
  const inAmount = overrides.inAmount ?? "100000000";
  const outAmount = overrides.outAmount ?? "250000";
  return {
    contextSlot: 123,
    executionMode: overrides.executionMode ?? "sync",
    inAmount,
    inputMint,
    minOutAmount: overrides.minimumOutput ?? "247500",
    otherAmountThreshold: overrides.minimumOutput ?? "247500",
    outAmount,
    outputMint,
    priceImpactPct: overrides.priceImpactPct ?? "0.0001",
    slippageBps: 50,
    lastValidBlockHeight: 999999,
    platformFee: overrides.platformFee ?? { amount: "500000", feeBps: 50, mode: "inputMint" },
    routePlan: [{ venue: "test-venue", inputMint, outputMint, inAmount, outAmount }],
    transaction: Buffer.from("prepared transaction").toString("base64"),
  };
}

function response(body: unknown, status = 200) {
  return { status, json: async () => body };
}

function isEngineError(code: TradingEngineError["code"]) {
  return (error: unknown) => error instanceof TradingEngineError && error.code === code;
}
