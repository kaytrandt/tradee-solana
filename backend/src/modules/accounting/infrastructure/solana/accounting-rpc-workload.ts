import { AsyncLocalStorage } from "node:async_hooks";

/** Background reads share one paced lane. Foreground reads never queue behind it. */
export class AccountingRpcWorkload {
  private readonly context = new AsyncLocalStorage<boolean>();
  private backgroundTail: Promise<unknown> = Promise.resolve();
  private nextBackgroundAt = 0;
  private foreground = 0;

  constructor(private readonly spacingMs = 1_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}

  get background(): boolean { return this.context.getStore() === true; }
  runBackground<T>(work: () => Promise<T>): Promise<T> { return this.context.run(true, work); }

  async request<T>(work: () => Promise<T>): Promise<T> {
    if (!this.background) {
      this.foreground++;
      try { return await work(); } finally { this.foreground--; }
    }
    const result = this.backgroundTail.then(async () => {
      while (this.foreground > 0 || this.now() < this.nextBackgroundAt) {
        await this.sleep(Math.max(50, this.nextBackgroundAt - this.now()));
      }
      this.nextBackgroundAt = this.now() + this.spacingMs;
      return work();
    });
    this.backgroundTail = result.catch(() => undefined);
    return result;
  }
}
