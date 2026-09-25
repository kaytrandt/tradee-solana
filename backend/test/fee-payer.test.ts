import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Keypair, TransactionMessage, TransactionInstruction, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { CoSignTransactionProvider, RoutedSponsoredTransactionProvider } from "../src/modules/wallet/fee-payer/co-sign-transaction-provider.js";
import { FeePayerSigner, encodeBase58, verifyWalletSignature } from "../src/modules/wallet/fee-payer/fee-payer-signer.js";
import { feePayerConfiguration } from "../src/modules/wallet/fee-payer/fee-payer-composition.js";
import { PrivyUserTransactionSigner } from "../src/modules/wallet/fee-payer/privy-user-transaction-signer.js";
import { sponsorInstructionPolicy } from "../src/modules/wallet/fee-payer/sponsor-instruction-policy.js";
import { SolanaFeePayerChain } from "../src/modules/wallet/fee-payer/solana-fee-payer-chain.js";
import { solanaRpcExecutionConfiguration } from "../src/modules/trading/infrastructure/solana/solana-rpc-execution-gateway.js";
import type { FeePayerRecord, FeePayerLimits, FeePayerJournal, FeePayerChain } from "../src/modules/wallet/fee-payer/fee-payer-domain.js";
import { TradingEngineError, type SponsoredTransactionAuthorizationRequest, type SponsoredTransactionProvider } from "../src/modules/trading/domain/trading.js";

const limits: FeePayerLimits = { swapNetworkLamports: 500000n, swapRentLamports: 5000000n,
  withdrawNetworkLamports: 20000n, withdrawRentLamports: 2500000n, minimumBalanceLamports: 10000000n,
  userDailyLamports: 10000000n, globalDailyLamports: 25000000n };
function fixture() {
  const gas = Keypair.generate(), user = Keypair.generate();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: gas.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [new TransactionInstruction({
      programId: SystemProgram.programId, keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(0),
    })] }).compileToV0Message());
  const serializedTransaction = Buffer.from(tx.serialize()).toString("base64");
  const request: SponsoredTransactionAuthorizationRequest = { walletId: "privy-wallet", referenceId: "tradee:test", idempotencyKey: "test",
    serializedTransaction, transactionDigest: createHash("sha256").update(tx.serialize()).digest("hex"),
    feePayerContext: { userId: "user", walletAddress: user.publicKey.toBase58(), operation: "BUY", lastValidBlockHeight: "1000" } };
  let record: FeePayerRecord | null = null, calls = 0;
  const broadcasts: string[] = [];
  const journal: FeePayerJournal = { get: async () => record, prepare: async r => record ??= r,
    commitSigned: async r => { record = r; return r; }, settle: async (_ref, state) => { record = { ...record!, state }; } };
  const chain: FeePayerChain = { blockHeight: async () => 1n, balance: async () => 100000000n,
    preflight: async () => ({ networkFee: 10000n, estimatedDebit: 2049280n, balance: 100000000n }),
    broadcast: async bytes => { assert.equal(record?.signedTransaction, bytes); broadcasts.push(bytes); return encodeBase58(VersionedTransaction.deserialize(Buffer.from(bytes, "base64")).signatures[0]!); },
    status: async () => ({ state: "pending" }) };
  const userSigner = { challenge: () => "challenge", sign: async () => { calls++; const signed = VersionedTransaction.deserialize(Buffer.from(serializedTransaction, "base64")); signed.sign([user]); return Buffer.from(signed.serialize()).toString("base64"); } };
  const signer = new FeePayerSigner(JSON.stringify([...gas.secretKey]), gas.publicKey.toBase58());
  const provider = new CoSignTransactionProvider(gas.publicKey.toBase58(), signer, userSigner, chain, journal, limits, async () => undefined);
  async function authorize() { const challenge = await provider.createAuthorizationChallenge(request); return { ...request, authorizationSignature: Buffer.alloc(64, 1).toString("base64"), authorizationRequestExpiry: challenge.requestExpiry }; }
  return { gas, user, tx, request, journal, chain, userSigner, provider, signer, broadcasts, authorize,
    get record() { return record; }, get calls() { return calls; } };
}
const code = (expected: string) => (error: unknown) => error instanceof TradingEngineError && error.code === expected;

test("co-sign preserves user signature, journals before send and never signs twice", async () => {
  const f = fixture(), req = await f.authorize();
  const result = await f.provider.signAndSend(req);
  assert.equal(f.calls, 1); assert.equal(f.broadcasts.length, 1);
  const signed = VersionedTransaction.deserialize(Buffer.from(f.record!.signedTransaction!, "base64"));
  assert.ok(verifyWalletSignature(signed, 0)); assert.ok(verifyWalletSignature(signed, 1));
  assert.deepEqual(signed.message.serialize(), f.tx.message.serialize());
  assert.deepEqual(await f.provider.signAndSend(req), result); assert.equal(f.calls, 1);
});
test("signing snapshots Jupiter USD valuation once; recovery never fetches a new price", async () => {
  const f = fixture(); let calls = 0;
  const provider = new CoSignTransactionProvider(f.gas.publicKey.toBase58(), f.signer, f.userSigner, f.chain, f.journal, limits,
    async () => undefined, 60_000, { getPrice: async () => { calls++; return { status: "AVAILABLE", price: {
      source: "JUPITER_PRICE_V3", mint: "So11111111111111111111111111111111111111112", usdPerSol: "150",
      blockId: "123", blockTime: new Date().toISOString(), fetchedAt: new Date().toISOString() } }; } });
  const req = await f.authorize();
  await provider.signAndSend(req);
  assert.equal(f.record?.feeValuation?.estimatedNetworkFeeUsd, "0.0015");
  assert.equal(f.record?.feeValuation?.estimatedPayerDebitUsd, "0.307392");
  await provider.signAndSend(req); await provider.recoverSubmission(req.referenceId);
  assert.equal(calls, 1);
});
test("missing price leaves USD unavailable without disabling lamport policy", async () => {
  const f = fixture(); const req = await f.authorize();
  await f.provider.signAndSend(req);
  assert.equal(f.record?.feeValuation?.status, "UNCONFIGURED");
  assert.equal(f.record?.feeValuation?.estimatedNetworkFeeUsd, null);
});
test("a changed policy ceiling requires reauthorization before user signing", async () => {
  const f = fixture(), req = await f.authorize();
  const provider = new CoSignTransactionProvider(f.gas.publicKey.toBase58(), f.signer, f.userSigner, f.chain, f.journal,
    { ...limits, swapNetworkLamports: 5000000n }, async () => undefined);
  await assert.rejects(provider.signAndSend(req), /policy changed/);
  assert.equal(f.calls, 0); assert.equal(f.broadcasts.length, 0);
});
test("RPC timeout recovers exactly the persisted bytes even with signing disabled", async () => {
  const f = fixture(), req = await f.authorize();
  const broadcast = f.chain.broadcast;
  f.chain.broadcast = async () => { throw new Error("timeout"); };
  await assert.rejects(f.provider.signAndSend(req), code("TRADE_SUBMISSION_AMBIGUOUS"));
  const persisted = f.record!.signedTransaction;
  f.chain.broadcast = broadcast;
  const disabled = new CoSignTransactionProvider(f.gas.publicKey.toBase58(), null, f.userSigner, f.chain, f.journal, limits, async () => undefined);
  await disabled.recoverSubmission(f.request.referenceId);
  assert.deepEqual(f.broadcasts, [persisted]); assert.equal(f.calls, 1);
  await assert.rejects(disabled.createAuthorizationChallenge(f.request));
});
test("DB failure after co-sign never broadcasts; outcome is held for reconciliation", async () => {
  const f = fixture(), req = await f.authorize();
  f.journal.commitSigned = async () => { throw new Error("database lost commit acknowledgement"); };
  await assert.rejects(f.provider.signAndSend(req), code("TRADE_SUBMISSION_AMBIGUOUS"));
  assert.equal(f.broadcasts.length, 0);
});
test("wrong/missing authorization is not a sponsor error and never calls Privy", async () => {
  const f = fixture(), req = await f.authorize();
  await assert.rejects(f.provider.signAndSend({ ...req, authorizationRequestExpiry: req.authorizationRequestExpiry + 1 }), code("TRADE_USER_AUTHORIZATION_INVALID"));
  await assert.rejects(f.provider.signAndSend({ ...req, feePayerContext: { ...req.feePayerContext!, userId: "other" } }), code("TRADE_USER_AUTHORIZATION_INVALID"));
  assert.equal(f.calls, 0); assert.equal(f.broadcasts.length, 0);
});
test("reject changed message or missing/forged user signature from signer", async () => {
  for (const mode of ["missing", "forged", "changed"]) {
    const f = fixture(), req = await f.authorize();
    f.userSigner.sign = async () => {
      if (mode === "changed") { f.tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58(); f.tx.sign([f.user]); }
      if (mode === "forged") f.tx.signatures[1]!.fill(7);
      return Buffer.from(f.tx.serialize()).toString("base64");
    };
    await assert.rejects(f.provider.signAndSend(req), code("TRADE_USER_AUTHORIZATION_INVALID"));
    assert.equal(f.broadcasts.length, 0);
  }
});
test("reject changed digest, signer identity, expired blockhash and oversized gas", async () => {
  const f = fixture();
  await assert.rejects(f.provider.createAuthorizationChallenge({ ...f.request, transactionDigest: "bad" }));
  await assert.rejects(f.provider.createAuthorizationChallenge({ ...f.request, feePayerContext: { ...f.request.feePayerContext!, walletAddress: f.gas.publicKey.toBase58() } }));
  f.chain.preflight = async () => ({ networkFee: 500001n, estimatedDebit: 500001n, balance: 100000000n });
  await assert.rejects(f.authorize(), code("TRADE_GAS_SPONSORSHIP_REJECTED"));
  f.chain.preflight = async () => ({ networkFee: 10000n, estimatedDebit: 5010001n, balance: 100000000n });
  await assert.rejects(f.authorize(), code("TRADE_GAS_SPONSORSHIP_REJECTED"));
  assert.equal(f.calls, 0);
});
test("withdraw uses its lower network fee ceiling; gas key mismatch fails closed", async () => {
  const f = fixture();
  f.chain.preflight = async () => ({ networkFee: 20001n, estimatedDebit: 20001n, balance: 100000000n });
  await assert.rejects(f.provider.createAuthorizationChallenge({ ...f.request, feePayerContext: { ...f.request.feePayerContext!, operation: "WITHDRAW" } }));
  assert.throws(() => new FeePayerSigner(JSON.stringify([...f.gas.secretKey]), f.user.publicKey.toBase58()));
  const base58 = new FeePayerSigner(encodeBase58(f.gas.secretKey), f.gas.publicKey.toBase58());
  base58.sign(f.tx); assert.ok(verifyWalletSignature(f.tx, 0));
});
test("expired unknown signed outcome remains pending and never gets a fresh blockhash", async () => {
  const f = fixture(); await f.provider.signAndSend(await f.authorize());
  f.chain.blockHeight = async () => 1001n;
  await f.provider.recoverSubmission(f.request.referenceId);
  assert.equal(f.broadcasts.length, 1); assert.equal(f.calls, 1);
  assert.equal((await f.provider.getByReferenceId(f.request.referenceId)).state, "pending");
  assert.equal(await f.provider.isDurablySigned(f.request.referenceId), true);
});
test("confirmed receipt stores actual network fee and net payer debit", async () => {
  const f = fixture(); await f.provider.signAndSend(await f.authorize());
  let actual: string[] = [];
  f.journal.settle = async (_ref, state, fee, debit) => { actual = [state, fee, debit]; };
  f.chain.status = async () => ({ state: "confirmed", fee: "110000", debit: "2149280" });
  assert.equal((await f.provider.getByReferenceId(f.request.referenceId)).state, "confirmed");
  assert.deepEqual(actual, ["CONFIRMED", "110000", "2149280"]);
});
test("own-payer failures never fall back to managed Privy sponsorship", async () => {
  const f = fixture(); let legacyCalls = 0;
  const legacy: SponsoredTransactionProvider = { createAuthorizationChallenge: () => { legacyCalls++; return { payloadBase64: "old", requestExpiry: 1 }; },
    signAndSend: async () => { legacyCalls++; throw new Error(); }, getByReferenceId: async ref => ({ referenceId: ref, state: "not_found", transactionSignature: null, providerTransactionId: null }) };
  const router = new RoutedSponsoredTransactionProvider(legacy, f.provider, f.journal);
  await assert.rejects(router.signAndSend(f.request)); assert.equal(legacyCalls, 0);
  const old = new VersionedTransaction(new TransactionMessage({ payerKey: f.user.publicKey, recentBlockhash: f.tx.message.recentBlockhash, instructions: [] }).compileToV0Message());
  assert.equal((await router.createAuthorizationChallenge({ ...f.request, serializedTransaction: Buffer.from(old.serialize()).toString("base64") })).payloadBase64, "old");
  assert.equal(legacyCalls, 1);
});
test("sponsor instruction policy blocks direct SOL transfer from payer", async () => {
  const f = fixture();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: f.gas.publicKey, recentBlockhash: f.tx.message.recentBlockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: f.gas.publicKey, toPubkey: f.user.publicKey, lamports: 1n })] }).compileToV0Message());
  await assert.rejects(sponsorInstructionPolicy({ resolve: async () => [] })(tx), code("TRADE_GAS_SPONSORSHIP_REJECTED"));
});
test("Privy challenge matches SDK sign-only wire request, not sign-and-send", async () => {
  const f = fixture(); let wire: { url: string; init?: RequestInit } | undefined;
  const transport: typeof fetch = async (url, init) => {
    wire = { url: String(url), ...(init ? { init } : {}) };
    return new Response(JSON.stringify({ method: "signTransaction", data: { signed_transaction: "signed", encoding: "base64" } }), { headers: { "content-type": "application/json" } });
  };
  const signer = new PrivyUserTransactionSigner("test-app", "test-secret", transport);
  const expiry = Date.now() + 60000;
  const payload = JSON.parse(Buffer.from(signer.challenge(f.request, expiry), "base64").toString());
  assert.equal(await signer.sign(f.request, expiry, "test-signature"), "signed");
  assert.equal(wire!.url, payload.url);
  assert.deepEqual(JSON.parse(wire!.init!.body as string), payload.body);
  const headers = new Headers(wire!.init!.headers);
  for (const [key, value] of Object.entries(payload.headers)) assert.equal(headers.get(key), value);
  assert.equal(payload.body.method, "signTransaction"); assert.equal(payload.body.sponsor, undefined);
});
test("configuration disabled by default, bounds priority and requires operator address", () => {
  assert.equal(feePayerConfiguration({}).enabled, false);
  assert.throws(() => feePayerConfiguration({ TRADEE_FEE_PAYER_ENABLED: "true" }));
  assert.throws(() => feePayerConfiguration({ TRADEE_FEE_PAYER_SWAP_PRIORITY_LAMPORTS: "5000000" }));
});
test("RPC gets total fee for unchanged message, simulates without signature/blockhash replacement", async () => {
  const f = fixture(), calls: { method: string; params: unknown[] }[] = [];
  const transport: typeof fetch = async (_url, init) => {
    assert.ok(init?.signal); const call = JSON.parse(init!.body as string); calls.push(call);
    const results: Record<string, unknown> = { getGenesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", getEpochInfo: { blockHeight: 1, absoluteSlot: 2000 },
      getFeeForMessage: { value: 110000 }, getBalance: { value: 100000000 }, simulateTransaction: { value: { err: null, accounts: [{ lamports: 97850720 }] } } };
    return new Response(JSON.stringify({ result: results[call.method] }));
  };
  const chain = new SolanaFeePayerChain("https://rpc.invalid", transport);
  assert.deepEqual(await chain.preflight(f.request.serializedTransaction, f.gas.publicKey.toBase58(), "1000"),
    { networkFee: 110000n, estimatedDebit: 2149280n, balance: 100000000n });
  assert.equal(calls.find(c => c.method === "getFeeForMessage")!.params[0], Buffer.from(f.tx.message.serialize()).toString("base64"));
  const config = calls.find(c => c.method === "simulateTransaction")!.params[1] as { replaceRecentBlockhash: boolean; sigVerify: boolean };
  assert.equal(config.replaceRecentBlockhash, false); assert.equal(config.sigVerify, false);
});

test("PublicNode fallback preserves signed bytes, validates mainnet and is not used while primary works", async () => {
  const urls = solanaRpcExecutionConfiguration({ SOLANA_RPC_URL: "https://primary.invalid" }).urls;
  assert.deepEqual(urls, ["https://primary.invalid/", "https://solana-rpc.publicnode.com/"]);
  const f = fixture(); await f.provider.signAndSend(await f.authorize());
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const call = JSON.parse(init!.body as string); calls.push({ url: String(url), ...call });
    if (String(url).includes("primary")) throw new Error("offline");
    return new Response(JSON.stringify({ result: call.method === "getGenesisHash"
      ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" : f.record!.signature }));
  };
  const chain = new SolanaFeePayerChain(urls, transport);
  assert.equal(await chain.broadcast(f.record!.signedTransaction!), f.record!.signature);
  assert.equal(calls.find(c => c.method === "sendTransaction")!.params[0], f.record!.signedTransaction);
  assert.ok(calls.find(c => c.url.includes("publicnode") && c.method === "getGenesisHash"));
  const badNetwork = new SolanaFeePayerChain(urls, async () => new Response(JSON.stringify({ result: "devnet-genesis" })));
  await assert.rejects(badNetwork.broadcast(f.record!.signedTransaction!), code("TRADE_GAS_SPONSORSHIP_REJECTED"));
});

test("co-sign fallback does not mistake slot for block height and still rejects real expiry", async () => {
  const f = fixture();
  let height = 426467950;
  const calls: string[] = [];
  const chain = new SolanaFeePayerChain(["https://primary.invalid", "https://fallback.invalid"], async (url, init) => {
    const call = JSON.parse(init!.body as string); calls.push(call.method);
    if (String(url).includes("primary")) throw new Error("rate limited");
    const result: Record<string, unknown> = {
      getGenesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      getBlockHeight: 448427140,
      getEpochInfo: { blockHeight: height, absoluteSlot: 448427140 },
      getFeeForMessage: { value: 110000 }, getBalance: { value: 100000000 },
      simulateTransaction: { value: { err: null, accounts: [{ lamports: 99890000 }] } },
    };
    return new Response(JSON.stringify({ result: result[call.method] }));
  });
  assert.equal(await chain.blockHeight(), 426467950n);
  assert.equal((await chain.preflight(f.request.serializedTransaction, f.gas.publicKey.toBase58(), "426468098")).networkFee, 110000n);
  height = 426468098; // Inclusive last valid height remains usable.
  await chain.preflight(f.request.serializedTransaction, f.gas.publicKey.toBase58(), "426468098");
  height++;
  await assert.rejects(chain.preflight(f.request.serializedTransaction, f.gas.publicKey.toBase58(), "426468098"), code("TRADE_TRANSACTION_EXPIRED"));
  assert.ok(!calls.includes("getBlockHeight"));
  assert.ok(!calls.includes("sendTransaction"));
});

test('trade admission uses fresh balance/expiry without a fourth simulation, and price runs beside preflight', async () => {
  const f = fixture();
  let simulations = 0, balanceReads = 0, signed = false;
  let releasePrice!: () => void;
  const priceStarted = new Promise<void>(resolve => { releasePrice = resolve; });
  const base = f.chain.preflight;
  f.chain.preflight = async (...args) => {
    simulations++;
    if (simulations === 2) await priceStarted;
    if (simulations === 3) signed = true;
    return base(...args);
  };
  f.chain.balance = async (_payer, expiry) => {
    assert.equal(signed, true);
    assert.equal(expiry, '1000'); balanceReads++; return 100000000n;
  };
  const commit = f.journal.commitSigned;
  f.journal.commitSigned = async (record, limits, readBalance) => {
    assert.equal(await readBalance(), 100000000n);
    return commit(record, limits, readBalance);
  };
  const provider = new CoSignTransactionProvider(f.gas.publicKey.toBase58(), f.signer, f.userSigner, f.chain, f.journal, limits,
    async () => undefined, 60_000, { getPrice: async () => { releasePrice(); return { status: 'UNAVAILABLE', price: null }; } });
  const authorization = await provider.createAuthorizationChallenge(f.request);
  await provider.signAndSend({ ...f.request, authorizationSignature: Buffer.alloc(64, 1).toString('base64'), authorizationRequestExpiry: authorization.requestExpiry });
  assert.equal(simulations, 3); assert.equal(balanceReads, 1);
  assert.equal(f.calls, 1); assert.equal(f.broadcasts.length, 1);
});

test('lightweight admission balance retains mainnet, exact integers and block expiry checks', async () => {
  const methods: string[] = []; let height = 99;
  const chain = new SolanaFeePayerChain('https://rpc.invalid', async (_url, init) => {
    const method = JSON.parse(String(init?.body)).method as string; methods.push(method);
    const result = method === 'getGenesisHash' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
      : method === 'getEpochInfo' ? { blockHeight: height, absoluteSlot: height + 100 } : { value: 100000000 };
    return new Response(JSON.stringify({ result }));
  });
  assert.equal(await chain.balance('payer', '100'), 100000000n);
  assert.deepEqual(methods.sort(), ['getBalance', 'getEpochInfo', 'getGenesisHash'].sort());
  height = 101;
  await assert.rejects(chain.balance('payer', '100'), code('TRADE_TRANSACTION_EXPIRED'));
});
