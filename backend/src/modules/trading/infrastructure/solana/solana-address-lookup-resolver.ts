import { Connection, PublicKey, type AddressLookupTableAccount } from "@solana/web3.js";
import type { SolanaLookupTableResolver } from "../../application/solana-trade-transaction-validator.js";

// Tables are append-only. Short-lived data is only used to construct/inspect a
// message; the exact message must still pass current on-chain simulation.
const tables = new Map<string, { until: number; value: AddressLookupTableAccount }>();
const pending = new Map<string, Promise<AddressLookupTableAccount>>();

export class SolanaAddressLookupResolver implements SolanaLookupTableResolver {
  private readonly connections: readonly Connection[];

  constructor(rpcUrls: string | readonly string[]) {
    const urls = typeof rpcUrls === "string" ? [rpcUrls] : rpcUrls;
    this.connections = urls.map((url) => new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }) }));
  }

  async resolve(addresses: readonly string[]): Promise<readonly AddressLookupTableAccount[]> {
    let lastError: unknown;
    for (const connection of this.connections) {
      try {
        return await Promise.all(addresses.map(async (address) => {
          const key = JSON.stringify([connection.rpcEndpoint, address]);
          const cached = tables.get(key);
          if (cached && cached.until > Date.now()) return cached.value;
          tables.delete(key);
          const existing = pending.get(key);
          if (existing) return existing;
          const task = connection.getAddressLookupTable(new PublicKey(address)).then(result => {
            if (result.value === null) throw new Error(`Solana address lookup table ${address} was not found.`);
            if (tables.size >= 512) tables.delete(tables.keys().next().value!);
            // Lookup tables are append-only. A longer warm cache is safe for
            // indexes already referenced by this exact provider transaction.
            tables.set(key, { value: result.value, until: Date.now() + 30_000 });
            return result.value;
          }).finally(() => { if (pending.get(key) === task) pending.delete(key); });
          // Bound simultaneous cache entries as well as retained results.
          if (pending.size < 512) pending.set(key, task);
          return task;
        }));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("No Solana RPC endpoint is configured for address lookup tables.");
  }
}
