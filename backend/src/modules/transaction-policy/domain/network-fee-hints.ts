import { createHash } from "node:crypto";
import type { SharedCache } from "../../provider-platform/infrastructure/shared-cache.js";

export interface NetworkFeeHintStore {
  get(key: string, minimum: bigint, gross: bigint): Promise<bigint>;
  set(key: string, units: bigint): void;
}

/** Optimization only: a hint is never a quote or permission to sign. Every
 * candidate must pass a fresh simulation of its exact final message. */
export class NetworkFeeHints implements NetworkFeeHintStore {
  private readonly values = new Map<string, { units: bigint; expires: number }>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 90_000,
    private readonly capacity = 2_000,
    private readonly shared?: Pick<SharedCache, "get" | "set">,
    private readonly namespace = "default") {}
  async get(key: string, minimum: bigint, gross: bigint): Promise<bigint> {
    const value = this.values.get(key);
    if (value && value.expires > this.now() && value.units >= minimum && value.units < gross) return value.units;
    this.values.delete(key);
    if (this.shared) {
      try {
        const encoded = await this.shared.get(this.sharedKey(key));
        if (encoded !== null && /^\d+$/.test(encoded)) {
          const units = BigInt(encoded);
          if (units >= minimum && units < gross) {
            this.remember(key, units);
            return units;
          }
        }
      } catch {
        // Hints are optional. Cache degradation must never block a quote.
      }
    }
    return minimum;
  }
  set(key: string, units: bigint): void {
    this.remember(key, units);
    if (this.shared) {
      void this.shared.set(this.sharedKey(key), units.toString(), Math.max(1, Math.ceil(this.ttlMs / 1_000))).catch(() => undefined);
    }
  }
  private remember(key: string, units: bigint): void {
    this.values.delete(key);
    if (this.values.size >= this.capacity) this.values.delete(this.values.keys().next().value!);
    this.values.set(key, { units, expires: this.now() + this.ttlMs });
  }
  private sharedKey(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return `tradee:network-fee-hint:${this.namespace}:${digest}`;
  }
}
// Shared across request-scoped service factories. Contains no signed messages.
export const networkFeeHints = new NetworkFeeHints();
