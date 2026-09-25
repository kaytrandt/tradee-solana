import { createHash } from 'node:crypto';
import type { TradeAggregate } from '../domain/trading.js';

type Result = { refreshRequired: boolean; quotedAt: string | null };
/** Ephemeral proof of a successful fee check, not a replacement quote or policy.
 * The reviewed snapshot is immutable; callers still authorize ownership/policy.
 */
export class RecentFeeValidations {
  private readonly values = new Map<string, { result: Result; startedAt: number }>();
  private readonly pending = new Map<string, Promise<Result>>();
  constructor(private readonly ttlMs = 2_000, private readonly capacity = 512) {}

  async check(aggregate: TradeAggregate, reuse: boolean, now: () => Date, validate: () => Promise<Result>): Promise<Result> {
    const key = createHash('sha256').update(JSON.stringify([
      aggregate.order.userId, aggregate.order.walletAddress, aggregate.order.orderId,
      aggregate.order.assetId, aggregate.order.side, aggregate.order.requestedAmount,
      aggregate.quote, // Includes exact bytes/digest, amounts, benefits and expiry.
    ], (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).digest('hex');
    const startedAt = now().getTime();
    const cached = this.values.get(key);
    if (reuse && cached && startedAt >= cached.startedAt && startedAt - cached.startedAt < this.ttlMs) return cached.result;
    this.values.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const work = (async () => {
      const result = await validate();
      if (!result.refreshRequired && result.quotedAt !== null && now().getTime() - startedAt < this.ttlMs) {
        if (this.values.size >= this.capacity) this.values.delete(this.values.keys().next().value!);
        this.values.set(key, { result, startedAt });
      }
      return result;
    })();
    if (this.pending.size < this.capacity) this.pending.set(key, work);
    try { return await work; }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }
}
