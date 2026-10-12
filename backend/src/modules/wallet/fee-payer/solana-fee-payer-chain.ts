import { VersionedTransaction } from "@solana/web3.js";
import { sponsorError, type FeePayerChain } from "./fee-payer-domain.js";
import { epochBlockHeight } from "../../trading/infrastructure/solana/solana-block-height.js";
import { TradingEngineError } from "../../trading/domain/trading.js";

const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** Endpoint fallback only reuses identical bytes; the durable journal owns retry identity. */
export class SolanaFeePayerChain implements FeePayerChain {
  private readonly urls: readonly string[];
  private readonly networks = new Map<string, Promise<void>>();
  private readonly health = new Map<string, { failures: number; latency: number }>();

  /** Hedge reads only. A whole preflight stays on one verified endpoint. */
  private read<T>(operation: (url: string, signal: AbortSignal) => Promise<T>,
    accept: (value: T) => boolean = () => true, budgetMs = 8_000): Promise<T> {
    const urls = [...this.urls].sort((a, b) => {
      const left = this.health.get(a), right = this.health.get(b);
      return (left?.failures ?? 0) - (right?.failures ?? 0)
        || (left?.latency ?? 0) - (right?.latency ?? 0);
    });
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let next = 0, active = 0, done = false, hasFallback = false;
      let fallback: T;
      const pending = new Map<string, number>();
      let hedge: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, value?: T) => {
        if (done) return;
        done = true; clearTimeout(deadline); clearTimeout(hedge);
        for (const [url, started] of pending) {
          const old = this.health.get(url);
          this.health.set(url, { failures: old?.failures ?? 0, latency: Math.max(old?.latency ?? 0, performance.now() - started) });
        }
        controller.abort();
        if (error !== undefined) reject(error); else resolve(value as T);
      };
      const unavailable = () => sponsorError("All gas payer RPC endpoints are temporarily unavailable.");
      const deadline = setTimeout(() => {
        if (hasFallback) finish(undefined, fallback); else finish(unavailable());
      }, budgetMs);
      const launch = () => {
        if (done || active >= 2 || next >= urls.length) return;
        const url = urls[next++]!;
        active++; const started = performance.now(); pending.set(url, started);
        void (async () => {
          await this.mainnet(url);
          if (controller.signal.aborted) throw unavailable();
          return operation(url, controller.signal);
        })().then(value => {
          if (done) return;
          pending.delete(url);
          this.health.set(url, { failures: 0, latency: performance.now() - started });
          if (accept(value)) finish(undefined, value);
          else { fallback = value; hasFallback = true; }
        }).catch(error => {
          if (done) return;
          pending.delete(url);
          // Semantic rejection is authoritative, never hidden by another RPC.
          if (error instanceof PreflightRejected) {
            finish(new TradingEngineError(error.code, error.message, true)); return;
          }
          const old = this.health.get(url);
          this.health.set(url, { failures: Math.min((old?.failures ?? 0) + 1, 10), latency: old?.latency ?? 8_000 });
        }).finally(() => {
          active--;
          if (done) return;
          if (next < urls.length) launch();
          if (active === 0 && next >= urls.length) {
            if (hasFallback) finish(undefined, fallback); else finish(unavailable());
          }
        });
      };
      launch();
      hedge = setTimeout(launch, 150);
    });
  }
  constructor(urls: string | readonly string[], private readonly transport: typeof fetch = fetch) {
    this.urls = typeof urls === "string" ? [urls] : [...new Set(urls)];
    if (this.urls.length === 0 || this.urls.length > 5) throw sponsorError("Between one and five gas payer RPC endpoints are required.");
  }
  private async at<T>(url: string, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    try {
      const response = await this.transport(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error();
      const body = await response.json() as { result?: T; error?: unknown };
      if (body.error || body.result === undefined) throw new Error();
      return body.result;
    } catch { throw sponsorError("The gas payer RPC check is temporarily unavailable."); }
  }
  private async mainnet(url: string): Promise<void> {
    let check = this.networks.get(url);
    if (!check) {
      check = this.at<string>(url, "getGenesisHash", []).then(hash => {
        if (hash !== MAINNET) throw sponsorError("Gas sponsorship requires Solana mainnet.");
      }).catch(error => { this.networks.delete(url); throw error; });
      this.networks.set(url, check);
    }
    return check;
  }
  private async rpc<T>(method: string, params: unknown[], decode: (value: unknown) => T = value => value as T): Promise<T> {
    for (const url of this.urls) {
      try { await this.mainnet(url); return decode(await this.at<unknown>(url, method, params)); }
      catch { /* Only the identical RPC request proceeds to the next endpoint. */ }
    }
    throw sponsorError("All gas payer RPC endpoints are temporarily unavailable.");
  }
  async blockHeight(): Promise<bigint> { return this.read(async (url, signal) => epochBlockHeight(await this.at(url, "getEpochInfo", [{ commitment: "confirmed" }], signal))); }
  async balance(payer: string, lastValidBlockHeight: string): Promise<bigint> {
    // Keep the admission-time expiry check, without repeating fee calculation
    // and a full simulation while the database budget lock is held.
    return this.read(async (url, signal) => {
      const [height, balance] = await Promise.all([
        this.at<unknown>(url, "getEpochInfo", [{ commitment: "confirmed" }], signal).then(epochBlockHeight),
        this.at<{ value: unknown }>(url, "getBalance", [payer, { commitment: "confirmed" }], signal),
      ]);
      if (height > BigInt(lastValidBlockHeight)) throw new PreflightRejected("The reviewed transaction has expired.", "TRADE_TRANSACTION_EXPIRED");
      return lamports(balance.value);
    });
  }

  async blockTime(slot: number): Promise<number | null> {
    if (!Number.isSafeInteger(slot) || slot <= 0) throw sponsorError("Invalid price block.");
    return this.read((url, signal) => this.at<number | null>(url, "getBlockTime", [slot], signal));
  }
  async preflight(transaction: string, payer: string, lastValidBlockHeight: string) {
    return this.read((url, signal) => this.preflightAt(url, transaction, payer, lastValidBlockHeight, signal));
  }
  private async preflightAt(url: string, transaction: string, payer: string, lastValidBlockHeight: string, signal: AbortSignal) {
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    const [height, fee, balance, simulation] = await Promise.all([
      this.at<unknown>(url, "getEpochInfo", [{ commitment: "confirmed" }], signal).then(epochBlockHeight),
      this.at<{ value: number | null }>(url, "getFeeForMessage", [Buffer.from(tx.message.serialize()).toString("base64"), { commitment: "confirmed" }], signal),
      this.at<{ value: number }>(url, "getBalance", [payer, { commitment: "confirmed" }], signal),
      this.at<{ value: { err: unknown; accounts?: ({ lamports: number } | null)[] } }>(url, "simulateTransaction", [transaction, {
        encoding: "base64", commitment: "confirmed", sigVerify: tx.signatures.every(s => s.some(b => b !== 0)),
        replaceRecentBlockhash: false, accounts: { encoding: "base64", addresses: [payer] },
      }], signal),
    ]);
    if (height > BigInt(lastValidBlockHeight)) throw new PreflightRejected("The reviewed transaction has expired.", "TRADE_TRANSACTION_EXPIRED");
    if (simulation.value.err || !simulation.value.accounts?.[0]) throw new PreflightRejected("Gas sponsorship simulation failed.");
    const before = lamports(balance.value), after = lamports(simulation.value.accounts[0].lamports);
    const networkFee = lamports(fee.value);
    return { networkFee, balance: before, estimatedDebit: before > after ? before - after : 0n };
  }
  async broadcast(transaction: string): Promise<string> {
    return this.rpc<string>("sendTransaction", [transaction, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 }]);
  }
  async status(signature: string, payer: string) {
    type Receipt = { meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[] } | null;
      transaction: { signatures: string[]; message: { accountKeys: string[] } } };
    // A valid pending answer does not hide a receipt on another endpoint.
    const receipt = await this.read((url, signal) => this.at<Receipt | null>(url, "getTransaction",
      [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }], signal), value => value !== null, 2_500);
    if (!receipt) return { state: "pending" as const };
    if (!receipt.meta || receipt.transaction.signatures[0] !== signature || receipt.transaction.message.accountKeys[0] !== payer) throw sponsorError("Gas receipt identity could not be verified.");
    return { state: receipt.meta.err ? "failed" as const : "confirmed" as const, fee: lamports(receipt.meta.fee).toString(),
      debit: (lamports(receipt.meta.preBalances[0]) - lamports(receipt.meta.postBalances[0])).toString() };
  }
}
class PreflightRejected extends Error {
  constructor(message: string, readonly code: "TRADE_GAS_SPONSORSHIP_REJECTED" | "TRADE_TRANSACTION_EXPIRED" = "TRADE_GAS_SPONSORSHIP_REJECTED") { super(message); }
}
function lamports(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw sponsorError("RPC returned an invalid integer amount.");
  return BigInt(value);
}
