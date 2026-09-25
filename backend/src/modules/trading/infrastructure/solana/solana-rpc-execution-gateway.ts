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

export class SolanaRpcExecutionGateway implements SolanaExecutionGateway {
  private nextRequestId = 1;

  constructor(
    private readonly configuration: SolanaRpcConfiguration,
    private readonly transport: SolanaRpcTransport = fetchTransport,
  ) {}

  async getBlockHeight(): Promise<bigint> {
    return await this.request("getEpochInfo", [{ commitment: "confirmed" }], epochBlockHeight) as bigint;
  }

  async getTransactionStatus(signature: string): Promise<SolanaTransactionStatus> {
    const result = await this.request(
      "getSignatureStatuses",
      [[signature], { searchTransactionHistory: true }],
    );
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
  }

  private async request(method: string, params: readonly unknown[], decode: (value: unknown) => unknown = value => value): Promise<unknown> {
    for (const url of this.configuration.urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.configuration.timeoutMs);
      try {
        const response = await this.transport(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: this.nextRequestId++,
            method,
            params,
          }),
          signal: controller.signal,
        });
        const body = await response.json() as JsonRpcResponse;
        if (!response.ok || body.error !== undefined || !("result" in body)) continue;
        return decode(body.result);
      } catch {
        // A provider outage or rate limit is not an on-chain failure. Try the
        // next configured endpoint before surfacing a recoverable error.
      } finally {
        clearTimeout(timer);
      }
    }
    throw new TradingEngineError(
      "TRADE_CONFIRMATION_FAILED",
      "Solana RPC is temporarily unavailable for confirmation.",
      true,
    );
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
