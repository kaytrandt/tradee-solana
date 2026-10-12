import {
  TradingEngineError,
  type SolanaExecutionGateway,
  type SolanaTransactionStatus,
} from "../../domain/trading.js";
import { epochBlockHeight } from "./solana-block-height.js";

interface SolanaRpcConfiguration {
  readonly urls: readonly string[];
  readonly timeoutMs: number;
}

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

export interface SolanaRpcHttpResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type SolanaRpcTransport = (
  url: string,
  init: { readonly method: "POST"; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly signal: AbortSignal },
) => Promise<SolanaRpcHttpResponse>;

interface EndpointHealth { readonly latencyMs: number; readonly retryAfter: number }
// Runtime constructs gateways per execution. Keep read-endpoint health across
// those instances; injected transports remain isolated for deterministic tests.
const sharedHealth = new Map<string, EndpointHealth>();

export class SolanaRpcExecutionGateway implements SolanaExecutionGateway {
  private nextRequestId = 1;
  private readonly health: Map<string, EndpointHealth>;

  constructor(
    private readonly configuration: SolanaRpcConfiguration,
    private readonly transport: SolanaRpcTransport = fetchTransport,
  ) { this.health = transport === fetchTransport ? sharedHealth : new Map(); }

  async getBlockHeight(): Promise<bigint> {
    return await this.request("getEpochInfo", [{ commitment: "confirmed" }], epochBlockHeight) as bigint;
  }

  async getTransactionStatus(signature: string): Promise<SolanaTransactionStatus> {
    return await this.request(
      "getSignatureStatuses",
      [[signature], { searchTransactionHistory: true }],
      (result): SolanaTransactionStatus => {
        if (typeof result !== "object" || result === null || !("value" in result)) {
          throw confirmationFailure("Solana RPC returned an invalid signature status.");
        }
        const values = (result as { value?: unknown }).value;
        if (!Array.isArray(values)) {
          throw confirmationFailure("Solana RPC returned an invalid signature status.");
        }
        const status = values[0];
        if (status === null || status === undefined) return { state: "pending", failure: null };
        if (typeof status !== "object") {
          throw confirmationFailure("Solana RPC returned an invalid signature status.");
        }
        const record = status as Record<string, unknown>;
        if (record.err !== null && record.err !== undefined) {
          return { state: "failed", failure: "onchain_transaction_failed" };
        }
        if (record.confirmationStatus === "confirmed" || record.confirmationStatus === "finalized") {
          return { state: "confirmed", failure: null };
        }
        return { state: "pending", failure: null };
      },
    ) as SolanaTransactionStatus;
  }

  private async request(method: string, params: readonly unknown[], decode: (value: unknown) => unknown = value => value): Promise<unknown> {
    const now = Date.now();
    const urls = this.configuration.urls.map((url, index) => ({ url, index, health: this.health.get(url) }))
      .sort((left, right) => Number((left.health?.retryAfter ?? 0) > now) - Number((right.health?.retryAfter ?? 0) > now)
        || (left.health?.latencyMs ?? 250) - (right.health?.latencyMs ?? 250) || left.index - right.index)
      .map(item => item.url);
    return new Promise((resolve, reject) => {
      let settled = false;
      let next = 0;
      let active = 0;
      const controllers = new Set<AbortController>();
      let hedge: NodeJS.Timeout | undefined;
      const deadline = setTimeout(() => finish(false), this.configuration.timeoutMs);
      const finish = (success: boolean, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (hedge) clearTimeout(hedge);
        for (const controller of controllers) controller.abort();
        success ? resolve(value) : reject(confirmationFailure("Solana RPC is temporarily unavailable for confirmation."));
      };
      const remember = (url: string, value: EndpointHealth) => {
        if (this.health.size >= 32 && !this.health.has(url)) this.health.delete(this.health.keys().next().value!);
        this.health.set(url, value);
      };
      const launch = () => {
        if (settled || active >= 2 || next >= urls.length) return;
        const url = urls[next++]!;
        const controller = new AbortController();
        controllers.add(controller);
        active++;
        const started = Date.now();
        // Reserve time for every endpoint, even if a transport ignores abort.
        const attemptMs = Math.min(this.configuration.timeoutMs,
          Math.max(250, Math.floor(this.configuration.timeoutMs / Math.ceil(urls.length / 2))));
        let attemptTimer: NodeJS.Timeout | undefined;
        void (async () => {
          try {
            const value = await Promise.race([
              (async () => {
                const response = await this.transport(url, { method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ jsonrpc: "2.0", id: this.nextRequestId++, method, params }), signal: controller.signal });
                const body = await response.json() as JsonRpcResponse;
                if (!response.ok || !body || body.error !== undefined || !("result" in body)) throw new Error("InvalidRPCResponse");
                return decode(body.result);
              })(),
              new Promise<never>((_, reject) => {
                attemptTimer = setTimeout(() => { controller.abort(); reject(new Error("RPCAttemptTimeout")); }, attemptMs);
                controller.signal.addEventListener("abort", () => reject(new Error("RPCAborted")), { once: true });
              }),
            ]);
            if (settled) return;
            remember(url, { latencyMs: Date.now() - started, retryAfter: 0 });
            finish(true, value);
          } catch {
            if (!settled) remember(url, { latencyMs: this.configuration.timeoutMs, retryAfter: Date.now() + 30_000 });
          } finally {
            if (attemptTimer) clearTimeout(attemptTimer);
            controller.abort();
            controllers.delete(controller);
            active--;
            if (!settled) {
              launch();
              if (active === 0 && next >= urls.length) finish(false);
            }
          }
        })();
        // Hedge only idempotent reads, never signing or transaction broadcasts.
        if (hedge) clearTimeout(hedge);
        if (next < urls.length && active < 2) hedge = setTimeout(launch, Math.min(250, Math.max(1, Math.floor(this.configuration.timeoutMs / 2))));
      };
      launch();
      if (urls.length === 0) finish(false);
    });
  }

}

async function fetchTransport(
  url: string,
  init: { readonly method: "POST"; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly signal: AbortSignal },
): Promise<SolanaRpcHttpResponse> {
  return fetch(url, init);
}

export function solanaRpcExecutionConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): SolanaRpcConfiguration {
  const configured = environment.SOLANA_TRADING_RPC_URLS?.split(",")
    .map((value) => value.trim()).filter(Boolean) ?? [];
  const primary = environment.SOLANA_RPC_URL?.trim();
  const values = configured.length > 0 ? configured : primary ? [primary] : [];
  if (values.length === 0) {
    throw new Error("SOLANA_RPC_URL or SOLANA_TRADING_RPC_URLS is required for trading execution.");
  }
  const fallbacks = (environment.SOLANA_RPC_FALLBACK_URLS ?? "https://solana-rpc.publicnode.com")
    .split(",").map(value => value.trim()).filter(Boolean);
  const urls = [...new Set([...values, ...fallbacks].map(value => new URL(value).toString()))].map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("Solana trading RPC URLs must use HTTPS.");
    return url.toString();
  });
  if (urls.length > 5) throw new Error("SOLANA_TRADING_RPC_URLS supports at most 5 endpoints.");
  return {
    urls,
    timeoutMs: positiveInteger(environment.SOLANA_RPC_TIMEOUT_MS, 10_000),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error("SOLANA_RPC_TIMEOUT_MS must be a positive integer.");
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("SOLANA_RPC_TIMEOUT_MS must be a positive integer.");
  }
  return parsed;
}

function confirmationFailure(message: string): TradingEngineError {
  return new TradingEngineError("TRADE_CONFIRMATION_FAILED", message, true);
}
