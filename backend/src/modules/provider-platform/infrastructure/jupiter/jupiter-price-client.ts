import { ProviderPlatformError } from "../../domain/provider-contracts.js";
import type { SharedCache } from "../shared-cache.js";

export interface JupiterPriceClientOptions {
  readonly apiKey: string;
  readonly reserveRequestSlot?: (intervalMs: number) => Promise<number>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly minRequestIntervalMs?: number;
  readonly maxRetries?: number;
  readonly cooldownMs?: number;
  readonly cache?: Pick<SharedCache, "get" | "set">;
  readonly logger?: { info(event: string, details: Readonly<Record<string, unknown>>): void };
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function isJupiterKeyConfigured(value: string | undefined): boolean {
  const key = value?.trim();
  return Boolean(key && !/^(YOUR_|REPLACE_|PASTE_|<)/i.test(key));
}

/** One serialized queue per worker; all retries consume the same rate budget.
 * PostgreSQL's worker lock + shared cadence serialize replicas. */
export class JupiterPriceClient {
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private cooldownUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly interval: number;
  private readonly timeout: number;
  private readonly retries: number;

  constructor(private readonly options: JupiterPriceClientOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.interval = options.minRequestIntervalMs ?? 1_100;
    this.timeout = options.timeoutMs ?? 8_000;
    this.retries = options.maxRetries ?? 1;
    for (const [name, value, minimum, maximum] of [
      ["interval", this.interval, 1_000, 60_000], ["timeout", this.timeout, 1, 30_000],
      ["retries", this.retries, 0, 2], ["cooldown", options.cooldownMs ?? 60_000, 1_000, 3_600_000],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid Jupiter ${name}.`);
    }
  }

  getPrices(mints: readonly string[]): Promise<string> {
    if (mints.length < 1 || mints.length > 50) throw new Error("Jupiter price batch must contain 1 to 50 mints.");
    return this.enqueue(mints, "/price/v3", "ids");
  }

  getTokens(mints: readonly string[]): Promise<string> {
    if (mints.length < 1 || mints.length > 100) throw new Error("Jupiter token batch must contain 1 to 100 mints.");
    return this.enqueue(mints, "/tokens/v2/search", "query");
  }

  private enqueue(mints: readonly string[], path: string, parameter: string): Promise<string> {
    const run = this.queue.then(() => this.request(mints, path, parameter));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async request(mints: readonly string[], path: string, parameter: string): Promise<string> {
    if (!isJupiterKeyConfigured(this.options.apiKey)) {
      throw failure("UNCONFIGURED", "JUPITER_API_KEY is not configured.", false);
    }
    const sharedCooldown = await this.options.cache?.get("provider:jupiter:price:cooldown");
    if (sharedCooldown && /^\d+$/.test(sharedCooldown)) this.cooldownUntil = Math.max(this.cooldownUntil, Number(sharedCooldown));
    if (this.now() < this.cooldownUntil) throw failure("RATE_LIMITED", "Jupiter price cooldown is active.", true);
    const url = new URL(path, "https://api.jup.ag");
    url.searchParams.set(parameter, mints.join(","));
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const waitMs = this.nextRequestAt - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      const sharedWait = await this.options.reserveRequestSlot?.(this.interval) ?? 0;
      if (sharedWait > 0) await this.sleep(sharedWait);
      this.nextRequestAt = this.now() + this.interval;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      let error: ProviderPlatformError;
      try {
        const response = await (this.options.fetch ?? fetch)(url, {
          headers: { accept: "application/json", "x-api-key": this.options.apiKey.trim() },
          redirect: "error", signal: controller.signal,
        });
        this.options.logger?.info("jupiter_price_response", { path, status: response.status, assetCount: mints.length, attempt });
        if (response.ok) return await response.text();
        await response.body?.cancel();
        if (response.status === 429) {
          const header = response.headers.get("retry-after");
          const retryMs = header && /^\d+$/.test(header) ? Number(header) * 1_000
            : header ? Date.parse(header) - this.now() : 0;
          const cooldown = Math.max(this.options.cooldownMs ?? 60_000, Number.isFinite(retryMs) ? retryMs : 0);
          this.cooldownUntil = this.now() + cooldown;
          await this.options.cache?.set("provider:jupiter:price:cooldown", String(this.cooldownUntil), Math.ceil(cooldown / 1_000));
          // Yield to the next scheduled tick instead of holding a worker for Retry-After.
          throw failure("RATE_LIMITED", "Jupiter price rate limit reached.", true, response.status);
        }
        if (response.status === 401 || response.status === 403) throw failure("AUTH", "Jupiter price authentication failed.", false, response.status);
        error = failure("UNAVAILABLE", "Jupiter price request failed.", response.status >= 500, response.status);
      } catch (cause) {
        error = cause instanceof ProviderPlatformError ? cause
          : failure(controller.signal.aborted ? "TIMEOUT" : "UNAVAILABLE", "Jupiter price request unavailable.", true);
      } finally { clearTimeout(timer); }
      if (!error.retryable || error.code === "RATE_LIMITED" || attempt === this.retries) throw error;
      this.nextRequestAt = Math.max(this.nextRequestAt, this.now() + 1_500 * 2 ** attempt);
    }
    throw failure("UNAVAILABLE", "Jupiter price request unavailable.", true);
  }
}

function failure(code: ConstructorParameters<typeof ProviderPlatformError>[1], message: string, retryable: boolean, status: number | null = null) {
  return new ProviderPlatformError("JUPITER", code, message, retryable, status);
}
