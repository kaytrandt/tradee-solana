import type { Pool } from "pg";
import { JupiterPriceClient, isJupiterKeyConfigured } from "../../provider-platform/infrastructure/jupiter/jupiter-price-client.js";
import { JupiterNativeFeePrice } from "../../provider-platform/infrastructure/jupiter/jupiter-native-fee-price.js";
import { PostgresJupiterRequestGate } from "../../provider-platform/infrastructure/postgres/postgres-jupiter-request-gate.js";
import { SolanaFeePayerChain } from "./solana-fee-payer-chain.js";
import type { NativeFeePriceResult, NativeFeePriceSource } from "./fee-usd-valuation.js";

// Runtime Admin factories are per request. Retain the price cache/single flight
// per application pool instead of creating an unbounded queue of HTTP calls.
const sources = new WeakMap<Pool, { identity: string; source: NativeFeePriceSource }>();
export function nativeFeePriceSource(pool: Pool, env: Readonly<Record<string, string | undefined>>, urls: readonly string[]): NativeFeePriceSource {
  const apiKey = env.JUPITER_API_KEY?.trim();
  if (!isJupiterKeyConfigured(apiKey)) return { getPrice: async () => ({ status: "UNCONFIGURED", price: null }) };
  const interval = Number(env.JUPITER_MIN_REQUEST_INTERVAL_MS ?? "1100");
  const identity = JSON.stringify([apiKey, urls, interval]);
  const existing = sources.get(pool);
  if (existing?.identity === identity) return existing.source;
  const gate = new PostgresJupiterRequestGate({ query: (sql: string, values: unknown[]) => {
    const query = { text: sql, values, query_timeout: 2_000 };
    return pool.query(query);
  } } as Pick<Pool, "query">);
  const client = new JupiterPriceClient({ apiKey: apiKey!, minRequestIntervalMs: interval, timeoutMs: 3_000, maxRetries: 0,
    reserveRequestSlot: async interval => {
      const wait = await gate.reserve(interval);
      // A busy market worker must not hold the user's expiring signature prompt.
      if (wait > 1_000) throw new Error("Jupiter fee price request budget is busy.");
      return wait;
    } });
  const chain = new SolanaFeePayerChain(urls);
  const prices = new JupiterNativeFeePrice(client, slot => chain.blockTime(slot));
  const source: NativeFeePriceSource = { getPrice: async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([prices.getPrice(), new Promise<NativeFeePriceResult>(resolve => {
        timer = setTimeout(() => resolve({ status: "UNAVAILABLE", price: null }), 4_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  } };
  sources.set(pool, { identity, source });
  return source;
}
