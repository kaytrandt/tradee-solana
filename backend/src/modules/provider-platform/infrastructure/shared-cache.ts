export interface SharedCache {
  get(key: string): Promise<string | null>;
  getMany(keys: readonly string[]): Promise<readonly (string | null)[]>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setMany(entries: readonly { readonly key: string; readonly value: string }[], ttlSeconds: number): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  publish(channel: string, value: string): Promise<void>;
  subscribe(channel: string, listener: (value: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** PostgreSQL remains the durable fallback when Redis is intentionally absent. */
export class NullSharedCache implements SharedCache {
  async get(): Promise<null> { return null; }
  async getMany(keys: readonly string[]): Promise<readonly null[]> { return keys.map(() => null); }
  async set(): Promise<void> {}
  async setMany(): Promise<void> {}
  async delete(): Promise<void> {}
  async publish(): Promise<void> {}
  async subscribe(): Promise<() => Promise<void>> { return async () => undefined; }
  async close(): Promise<void> {}
}
