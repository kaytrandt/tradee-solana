import type {
  GasSponsorshipDecision,
  GasSponsorshipPolicy,
} from "../domain/trading.js";

export interface GasSponsorshipPolicyConfiguration {
  readonly enabled: boolean;
  readonly windowMs: number;
  readonly perUserLimit: number;
  readonly perWalletLimit: number;
  readonly globalLimit: number;
}

interface Counter { count: number; resetAt: number }

export class InMemoryGasSponsorshipPolicy implements GasSponsorshipPolicy {
  private readonly users = new Map<string, Counter>();
  private readonly wallets = new Map<string, Counter>();
  private readonly acceptedOrders = new Set<string>();
  private global: Counter = { count: 0, resetAt: 0 };

  constructor(
    private readonly configuration: GasSponsorshipPolicyConfiguration,
    private readonly now: () => number = Date.now,
  ) {}

  async evaluate(input: {
    readonly userId: string;
    readonly walletId: string;
    readonly orderId: string;
  }): Promise<GasSponsorshipDecision> {
    if (!this.configuration.enabled) return { eligible: false, reason: "disabled" };
    if (this.acceptedOrders.has(input.orderId)) return { eligible: true, reason: "eligible" };
    const now = this.now();
    const user = current(this.users, input.userId, now, this.configuration.windowMs);
    const wallet = current(this.wallets, input.walletId, now, this.configuration.windowMs);
    this.global = refresh(this.global, now, this.configuration.windowMs);
    if (
      user.count >= this.configuration.perUserLimit
      || wallet.count >= this.configuration.perWalletLimit
      || this.global.count >= this.configuration.globalLimit
    ) {
      return { eligible: false, reason: "rate_limited" };
    }
    user.count += 1;
    wallet.count += 1;
    this.global.count += 1;
    this.acceptedOrders.add(input.orderId);
    return { eligible: true, reason: "eligible" };
  }
}

function current(
  map: Map<string, Counter>,
  key: string,
  now: number,
  windowMs: number,
): Counter {
  const value = refresh(map.get(key) ?? { count: 0, resetAt: 0 }, now, windowMs);
  map.set(key, value);
  return value;
}

function refresh(value: Counter, now: number, windowMs: number): Counter {
  return now >= value.resetAt ? { count: 0, resetAt: now + windowMs } : value;
}
