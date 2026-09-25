import type { DFlowClientConfiguration } from "./dflow-configuration.js";
import { TradingEngineError } from "../../domain/trading.js";

export interface DFlowHttpRequest {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface DFlowHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type DFlowHttpTransport = (request: DFlowHttpRequest) => Promise<DFlowHttpResponse>;

export interface DFlowLogger {
  info(event: string, details: Readonly<Record<string, unknown>>): void;
  error(event: string, details: Readonly<Record<string, unknown>>): void;
}

export class DFlowClient {
  constructor(
    private readonly configuration: DFlowClientConfiguration,
    private readonly transport: DFlowHttpTransport = fetchTransport,
    private readonly logger?: DFlowLogger,
  ) {}

  async getOrder(query: Readonly<Record<string, string>>): Promise<unknown> {
    const url = new URL("/order", `${this.configuration.tradeApiUrl}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.configuration.apiKey !== undefined) {
      headers["x-api-key"] = this.configuration.apiKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.configuration.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.transport({ url, headers, signal: controller.signal });
      this.logger?.info("dflow_order_response", {
        path: "/order",
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      const body = await safeJson(response);
      if (response.status < 200 || response.status >= 300) {
        throw mapHttpError(response.status, body);
      }
      return body;
    } catch (error) {
      if (error instanceof TradingEngineError) throw error;
      this.logger?.error("dflow_order_failed", {
        path: "/order",
        durationMs: Date.now() - startedAt,
        reason: error instanceof Error && error.name === "AbortError" ? "timeout" : "network",
      });
      throw new TradingEngineError(
        "TRADE_PROVIDER_UNAVAILABLE",
        "The trading provider is temporarily unavailable.",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchTransport(request: DFlowHttpRequest): Promise<DFlowHttpResponse> {
  return fetch(request.url, {
    method: "GET",
    headers: request.headers,
    signal: request.signal,
  });
}

async function safeJson(response: DFlowHttpResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function mapHttpError(status: number, body: unknown): TradingEngineError {
  if (status === 401 || status === 403) {
    return new TradingEngineError(
      "TRADE_PROVIDER_AUTH_FAILED",
      "The trading provider rejected backend authentication.",
    );
  }
  if (status === 429) {
    return new TradingEngineError(
      "TRADE_PROVIDER_RATE_LIMITED",
      "The trading provider rate limit was reached.",
      true,
    );
  }
  if (status >= 500) {
    return new TradingEngineError(
      "TRADE_PROVIDER_UNAVAILABLE",
      "The trading provider is temporarily unavailable.",
      true,
    );
  }
  const providerCode = providerErrorCode(body);
  if (providerCode === "route_not_found" || providerCode === "price_impact_too_high") {
    return new TradingEngineError(
      "TRADE_INVALID_ROUTE",
      "No acceptable trading route is currently available.",
      true,
    );
  }
  return new TradingEngineError(
    "TRADE_PROVIDER_REJECTED",
    "The trading provider rejected the order request.",
  );
}

function providerErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("code" in body)) return null;
  return typeof body.code === "string" ? body.code.toLowerCase() : null;
}

