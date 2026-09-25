import { compareExact, exactAmount } from "../../../accounting/domain/exact-amount.js";
import { priceIsFresh, type NativeFeePriceResult, type NativeFeePriceSource } from "../../../wallet/fee-payer/fee-usd-valuation.js";
import { asRecord, parseExactJson, requiredExactDecimal } from "../exact-json.js";
import type { JupiterPriceClient } from "./jupiter-price-client.js";

export const SOL_PRICE_MINT = "So11111111111111111111111111111111111111112";
/** Cached/single-flight SOL price. Verify Jupiter's slot timestamp against mainnet;
 * createdAt is token metadata and is deliberately never used for freshness. */
export class JupiterNativeFeePrice implements NativeFeePriceSource {
  private cached?: { until: number; value: NativeFeePriceResult };
  private pending: Promise<NativeFeePriceResult> | undefined;
  private highestBlock = 0n;
  constructor(private readonly client: Pick<JupiterPriceClient, "getPrices">,
    private readonly blockTime: (slot: number) => Promise<number | null>,
    private readonly now: () => number = Date.now) {}

  getPrice(): Promise<NativeFeePriceResult> {
    if (this.cached && this.now() < this.cached.until
      && (this.cached.value.status !== "AVAILABLE" || priceIsFresh(this.cached.value.price, this.now()))) {
      return Promise.resolve(this.cached.value);
    }
    if (this.pending) return this.pending;
    this.pending = this.load().then(value => {
      // The policy still rejects provider block times older than two minutes.
      // Reuse a verified snapshot for one minute so quote preparation does not
      // repeatedly wait on Jupiter plus a Solana getBlockTime request.
      this.cached = { value, until: this.now() + (value.status === "AVAILABLE" ? 60_000 : 5_000) };
      return value;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async load(): Promise<NativeFeePriceResult> {
    try {
      const root = asRecord(parseExactJson(await this.client.getPrices([SOL_PRICE_MINT])));
      const data = asRecord(root?.[SOL_PRICE_MINT]);
      if (!data || data.decimals !== "9" || typeof data.blockId !== "string" || !/^[1-9]\d{0,15}$/.test(data.blockId)) throw new Error();
      const block = BigInt(data.blockId);
      if (block < this.highestBlock) return { status: "STALE", price: null };
      if (block > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
      const price = exactAmount(requiredExactDecimal(data.usdPrice, "usdPrice"));
      if (compareExact(price, "0") <= 0) throw new Error();
      const timestamp = await this.blockTime(Number(block));
      if (timestamp === null || !Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error();
      const snapshot = { source: "JUPITER_PRICE_V3" as const, mint: SOL_PRICE_MINT, usdPerSol: price,
        blockId: data.blockId, blockTime: new Date(timestamp * 1_000).toISOString(), fetchedAt: new Date(this.now()).toISOString() };
      if (!priceIsFresh(snapshot, this.now())) return { status: "STALE", price: null };
      this.highestBlock = block;
      return { status: "AVAILABLE", price: snapshot };
    } catch { return { status: "UNAVAILABLE", price: null }; }
  }
}
