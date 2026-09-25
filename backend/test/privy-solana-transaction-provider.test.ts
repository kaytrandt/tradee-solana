import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestError } from "@privy-io/node";
import {
  PrivySolanaTransactionProvider,
  type PrivySponsoredSendInput,
} from "../src/modules/trading/infrastructure/privy/privy-solana-transaction-provider.js";
import { TradingEngineError } from "../src/modules/trading/domain/trading.js";

test("Privy provider sends a direct owner signature over the same canonical sponsored request", async () => {
  let captured: { walletId: string; input: PrivySponsoredSendInput } | undefined;
  const provider = new PrivySolanaTransactionProvider({
    appId: "app", appSecret: "secret", caip2: "solana:mainnet", requestExpiryMs: 30_000,
  }, {
    send: async (walletId, input) => {
      captured = { walletId, input };
      return { hash: "5".repeat(64), transaction_id: "privy-tx", reference_id: input.reference_id };
    },
  });
  const challenge = provider.createAuthorizationChallenge({
    walletId: "privy-wallet", serializedTransaction: "AQID", transactionDigest: "digest",
    referenceId: "tradee:order", idempotencyKey: "tradee-sponsor:order",
  });
  const payload = JSON.parse(Buffer.from(challenge.payloadBase64, "base64").toString("utf8")) as {
    url: string;
    body: { sponsor: boolean; params: { transaction: string } };
    headers: Record<string, string>;
  };
  assert.equal(payload.url, "https://api.privy.io/v1/wallets/privy-wallet/rpc");
  assert.equal(payload.body.sponsor, true);
  assert.equal(payload.body.params.transaction, "AQID");
  assert.equal(payload.headers["privy-request-expiry"], String(challenge.requestExpiry));

  const authorizationSignature = Buffer.from("direct-owner-signature").toString("base64");
  const result = await provider.signAndSend({
    walletId: "privy-wallet", serializedTransaction: "AQID", transactionDigest: "digest",
    referenceId: "tradee:order", idempotencyKey: "tradee-sponsor:order",
    authorizationSignature,
    authorizationRequestExpiry: challenge.requestExpiry,
  });
  assert.equal(captured?.walletId, "privy-wallet");
  assert.equal(captured?.input.sponsor, true);
  assert.ok(captured !== undefined && "signatures" in captured.input.authorization_context);
  assert.deepEqual(captured.input.authorization_context.signatures, [authorizationSignature]);
  assert.equal(captured?.input.reference_id, "tradee:order");
  assert.equal(result.sponsored, true);
});

test("Privy reconciliation reads nested transaction records by reference id", async () => {
  const provider = new PrivySolanaTransactionProvider({
    appId: "app", appSecret: "secret", caip2: "solana:mainnet", requestExpiryMs: 30_000,
  }, {
    send: async () => { throw new Error("unused"); },
    fetch: async () => new Response(JSON.stringify({ data: { transactions: [{
      id: "privy-tx", status: "confirmed", transaction_hash: "5".repeat(64), reference_id: "tradee:order",
    }] } }), { status: 200 }),
  });
  const status = await provider.getByReferenceId("tradee:order");
  assert.equal(status.state, "confirmed");
  assert.equal(status.transactionSignature, "5".repeat(64));
});

test("an unknown Privy send error is treated as ambiguous so the order cannot be submitted twice", async () => {
  const provider = new PrivySolanaTransactionProvider({
    appId: "app", appSecret: "secret", caip2: "solana:mainnet", requestExpiryMs: 30_000,
  }, {
    send: async () => { throw new TypeError("connection reset after request write"); },
  });

  await assert.rejects(
    provider.signAndSend({
      walletId: "privy-wallet", serializedTransaction: "AQID", transactionDigest: "digest",
      referenceId: "tradee:order", idempotencyKey: "tradee-sponsor:order",
      userAuthorizationToken: "user-jwt",
    }),
    (error) => error instanceof TradingEngineError && error.code === "TRADE_SUBMISSION_AMBIGUOUS",
  );
});

test("Privy failures log bounded provider diagnostics without opaque payloads", async () => {
  const logged: Array<Readonly<Record<string, unknown>>> = [];
  const provider = new PrivySolanaTransactionProvider({
    appId: "app", appSecret: "secret", caip2: "solana:mainnet", requestExpiryMs: 30_000,
  }, {
    send: async () => {
      throw new BadRequestError(400, {
        code: "invalid_data",
        message: `Invalid transaction ${"A".repeat(80)}`,
      }, "Bad request", new Headers({ "x-request-id": "request-1" }));
    },
    logger: {
      info: () => undefined,
      error: (_event, details) => logged.push(details),
    },
  });

  await assert.rejects(provider.signAndSend({
    walletId: "privy-wallet", serializedTransaction: "AQID", transactionDigest: "digest",
    referenceId: "tradee:order", idempotencyKey: "tradee-sponsor:order",
    userAuthorizationToken: "user-jwt",
  }));

  assert.equal(logged[0]?.providerCode, "invalid_data");
  assert.equal(logged[0]?.providerMessage, "Invalid transaction [redacted]");
  assert.equal(logged[0]?.requestId, "request-1");
});

test("an invalid Privy user JWT is surfaced as refreshable user authorization", async () => {
  const provider = new PrivySolanaTransactionProvider({
    appId: "app", appSecret: "secret", caip2: "solana:mainnet", requestExpiryMs: 30_000,
  }, {
    send: async () => {
      throw new BadRequestError(400, {
        code: "invalid_data",
        message: "Invalid JWT token provided",
      }, "Bad request", new Headers());
    },
  });

  await assert.rejects(provider.signAndSend({
    walletId: "privy-wallet", serializedTransaction: "AQID", transactionDigest: "digest",
    referenceId: "tradee:order", idempotencyKey: "tradee-sponsor:order",
    userAuthorizationToken: "user-jwt",
  }), (error) => error instanceof TradingEngineError
    && error.code === "TRADE_USER_AUTHORIZATION_INVALID"
    && error.recoverable);
});
