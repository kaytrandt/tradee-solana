import assert from "node:assert/strict";
import test from "node:test";
import { SolanaRpcExecutionGateway } from "../src/modules/trading/infrastructure/solana/solana-rpc-execution-gateway.js";

const signature = "5".repeat(64);

test("expiry checks use epoch blockHeight, never the larger slot returned by a faulty RPC", async () => {
  const gateway = new SolanaRpcExecutionGateway({ urls: ["https://rpc.example"], timeoutMs: 1000 },
    async (_url, init) => {
      const request = JSON.parse(init.body);
      assert.equal(request.method, "getEpochInfo");
      assert.deepEqual(request.params, [{ commitment: "confirmed" }]);
      return rpcResponse({ blockHeight: 426467950, absoluteSlot: 448427140 });
    });
  assert.equal(await gateway.getBlockHeight(), 426467950n);
});

test("malformed epoch block heights fail over; no fallback to absoluteSlot", async () => {
  for (const malformed of [null, 448427140, { absoluteSlot: 448427140 },
    { blockHeight: -1, absoluteSlot: 2 }, { blockHeight: 3, absoluteSlot: 2 },
    { blockHeight: 1.5, absoluteSlot: 2 }, { blockHeight: Number.MAX_SAFE_INTEGER + 1, absoluteSlot: Number.MAX_SAFE_INTEGER + 1 }]) {
    const calls: string[] = [];
    const gateway = new SolanaRpcExecutionGateway({ urls: ["https://primary", "https://fallback"], timeoutMs: 1000 },
      async url => { calls.push(url); return rpcResponse(url.includes("primary") ? malformed : { blockHeight: 10, absoluteSlot: 20 }); });
    assert.equal(await gateway.getBlockHeight(), 10n);
    assert.equal(calls.length, 2);
    await assert.rejects(gatewayWithResult(malformed).getBlockHeight(), /temporarily unavailable/);
  }
});

test("Solana gateway confirms only confirmed/finalized successful signatures", async () => {
  const gateway = gatewayWithResult({ value: [{ confirmationStatus: "confirmed", err: null }] });
  assert.deepEqual(await gateway.getTransactionStatus(signature), { state: "confirmed", failure: null });

  const pending = gatewayWithResult({ value: [{ confirmationStatus: "processed", err: null }] });
  assert.deepEqual(await pending.getTransactionStatus(signature), { state: "pending", failure: null });

  const failed = gatewayWithResult({ value: [{ confirmationStatus: "confirmed", err: { custom: 1 } }] });
  assert.deepEqual(await failed.getTransactionStatus(signature), {
    state: "failed",
    failure: "onchain_transaction_failed",
  });
});

function gatewayWithResult(result: unknown) {
  return new SolanaRpcExecutionGateway(
    { urls: ["https://rpc.example"], timeoutMs: 1_000 },
    async () => rpcResponse(result),
  );
}

function rpcResponse(result: unknown) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
}

test("Solana gateway fails over without treating an RPC outage as an on-chain failure", async () => {
  const calls: string[] = [];
  const gateway = new SolanaRpcExecutionGateway(
    { urls: ["https://primary.example", "https://fallback.example"], timeoutMs: 1_000 },
    async (url) => {
      calls.push(url);
      return url.includes("primary")
        ? { ok: false, json: async () => ({ error: { code: 429 } }) }
        : rpcResponse({ value: [{ confirmationStatus: "finalized", err: null }] });
    },
  );

  assert.deepEqual(await gateway.getTransactionStatus(signature), {
    state: "confirmed",
    failure: null,
  });
  assert.deepEqual(calls, ["https://primary.example", "https://fallback.example"]);
});
