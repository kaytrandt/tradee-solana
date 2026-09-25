import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SolanaMintMetadataReader } from "../../domain/xstocks-provider.js";
import { parseExactDecimal } from "../../../transaction-policy/domain/exact-decimal.js";

export class SolanaRpcMintMetadataReader implements SolanaMintMetadataReader {
  #requestGate: Promise<void> = Promise.resolve();
  #nextRequestAt = 0;

  constructor(
    private readonly rpcUrl: string,
    private readonly request: typeof fetch = fetch,
    private readonly requestTimeoutMs = 15_000,
    private readonly minimumRequestIntervalMs = 275,
  ) {}

  async getDecimals(mint: string): Promise<number> {
    const value = await this.lookup(mint);
    const decimals = readDecimals(value);
    if (decimals === null) throw new Error(`Solana mint ${mint} did not return parsed decimals`);
    return decimals;
  }

  async getScaledUiMetadata(mint: string) {
    const value = await this.lookup(mint);
    const decimals = readDecimals(value);
    const account = isObject(value) && isObject(value.result) ? value.result.value : null;
    const parsed = isObject(account) && isObject(account.data) ? account.data.parsed : null;
    const extensions = isObject(parsed) && isObject(parsed.info) ? parsed.info.extensions : null;
    if (decimals === null || !isObject(account) || account.owner !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' || !Array.isArray(extensions)) {
      throw new Error('Sunrise mint requires verified Token-2022 metadata');
    }
    const scaled = extensions.filter(e => isObject(e) && e.extension === 'scaledUiAmountConfig');
    const state = scaled.length === 1 && isObject(scaled[0]) ? scaled[0].state : null;
    if (!isObject(state)) throw new Error('Sunrise mint requires scaled UI metadata');
    const exactPositive = (input: unknown) => {
      // RPC encodes these f64 extension values as decimal strings. Never accept
      // a JSON number that has already passed through binary arithmetic.
      if (typeof input !== 'string') throw new Error('Invalid scaled UI multiplier encoding');
      const value = parseExactDecimal(input);
      if (value.coefficient <= 0n) throw new Error('Invalid scaled UI multiplier');
      return value.value;
    };
    const timestamp = String(state.newMultiplierEffectiveTimestamp);
    if (!/^-?\d+$/.test(timestamp)) throw new Error('Invalid scaled UI activation');
    const ms = BigInt(timestamp) * 1000n;
    if (ms < -8640000000000000n || ms > 8640000000000000n) throw new Error('Invalid scaled UI activation');
    const pause = extensions.find(e => isObject(e) && e.extension === 'pausableConfig');
    return { decimals, multiplier: exactPositive(state.multiplier), pendingMultiplier: exactPositive(state.newMultiplier),
      activatesAt: new Date(Number(ms)), paused: isObject(pause) && isObject(pause.state) && pause.state.paused === true };
  }

  private async lookup(mint: string): Promise<unknown> {
    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.#waitForRequestSlot();
      response = await this.request(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "getAccountInfo",
          params: [mint, { encoding: "jsonParsed", commitment: "finalized" }],
        }),
      });
      if (response.status !== 429 && response.status < 500) break;
      await delay((attempt + 1) * 1_000);
    }

    if (response === null || !response.ok) {
      throw new Error(`Solana mint lookup failed with HTTP ${response?.status ?? "no response"}`);
    }
    return response.json();
  }

  async #waitForRequestSlot(): Promise<void> {
    let release: (() => void) | undefined;
    const previous = this.#requestGate;
    this.#requestGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, this.#nextRequestAt - Date.now());
      if (waitMs > 0) await delay(waitMs);
      this.#nextRequestAt = Date.now() + this.minimumRequestIntervalMs;
    } finally {
      release?.();
    }
  }
}

function readDecimals(value: unknown): number | null {
  if (!isObject(value)) return null;
  const result = value.result;
  if (!isObject(result) || !isObject(result.value) || !isObject(result.value.data)) return null;
  const parsed = result.value.data.parsed;
  if (!isObject(parsed) || !isObject(parsed.info)) return null;
  const decimals = parsed.info.decimals;
  return typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255
    ? decimals
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
