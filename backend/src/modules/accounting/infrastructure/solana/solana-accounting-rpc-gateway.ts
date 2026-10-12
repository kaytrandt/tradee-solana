import { AccountingRpcWorkload } from "./accounting-rpc-workload.js";
import { createHash } from "node:crypto";
import {
  AccountingError,
  ChainFinality,
  type ChainObservation,
  type ChainObservationBatch,
  type SolanaAccountingGateway,
  type TrackedWallet,
} from "../../domain/accounting.js";

interface RpcEnvelope {
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

interface ParsedTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

// Accounting consumes RPC-parsed balance metadata, not signed wire bytes.
// v1 receipts must remain readable without changing any signing/execution path.
const MAX_ACCOUNTING_TRANSACTION_VERSION = 1;

export class SolanaAccountingRpcGateway implements SolanaAccountingGateway {
  readonly workload = new AccountingRpcWorkload();
  private readonly cooldowns = new Map<string, { until: number; failures: number }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly blocks = new Map<number, { signatures: readonly string[]; expiresAt: number; bytes: number }>();
  private blockBytes = 0;
  private readonly preferred = new Map<string, { url: string; until: number }>();
  constructor(
    private readonly configuration: {
      readonly rpcUrl: string;
      readonly fallbackRpcUrls?: readonly string[];
      readonly timeoutMs: number;
      readonly maxAttempts?: number;
      readonly retryBaseDelayMs?: number;
      readonly onTiming?: (details: Readonly<Record<string, unknown>>) => void;
    },
    private readonly transport: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listFinalizedSignatures(
    walletAddress: string,
    options: { readonly before?: string; readonly until?: string; readonly limit: number },
  ): Promise<readonly string[]> {
    const result = await this.rpc("getSignaturesForAddress", [
      walletAddress,
      {
        commitment: "finalized",
        limit: boundedLimit(options.limit),
        ...(options.before === undefined ? {} : { before: options.before }),
        ...(options.until === undefined ? {} : { until: options.until }),
      },
    ]);
    if (!Array.isArray(result)) throw invalidRpc("Signature history response is invalid.");
    return result.map((item) => {
      const record = requireRecord(item, "signature history item");
      return requireString(record.signature, "transaction signature");
    });
  }

  async listTokenAccountAddresses(walletAddress: string, mint: string): Promise<readonly string[]> {
    const result = await this.rpc("getTokenAccountsByOwner", [
      walletAddress,
      { mint },
      { commitment: "finalized", encoding: "base64" },
    ]);
    const value = requireRecord(result, "token account response").value;
    if (!Array.isArray(value)) throw invalidRpc("Token account list is invalid.");
    return [...new Set(value.map((item) =>
      requireString(requireRecord(item, "token account").pubkey, "token account address"),
    ))].sort();
  }

  async listOwnedTokenAccountAddresses(walletAddress: string): Promise<readonly string[]> {
    const addresses = new Set<string>();
    // Two RPC reads cover all holdings, including recipient ATAs absent from the
    // local ledger. No per-stock RPC fanout and no non-USDC deposit crediting.
    for (const programId of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
      const response = await this.rpc("getTokenAccountsByOwner", [walletAddress, { programId },
        { commitment: "finalized", encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
      const value = requireRecord(response, "owned token accounts").value;
      if (!Array.isArray(value)) throw invalidRpc("Owned token account list is invalid.");
      for (const account of value) addresses.add(requireString(requireRecord(account, "owned token account").pubkey, "address"));
    }
    return [...addresses].sort();
  }

  async fetchFinalizedTransaction(signature: string, wallet: TrackedWallet): Promise<ChainObservationBatch> {
    const started = performance.now();
    const transactionValue = await this.sharedRpc("getTransaction", [signature, {
      commitment: "finalized",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: MAX_ACCOUNTING_TRANSACTION_VERSION,
    }]);
    const transactionReadMs = performance.now() - started;
    const transaction = requireRecord(transactionValue, "finalized transaction");
    const slot = requireSafeInteger(transaction.slot, "slot");
    const blockTimeSeconds = transaction.blockTime === null || transaction.blockTime === undefined
      ? requireSafeInteger(await this.rpc("getBlockTime", [slot]), "blockTime")
      : requireSafeInteger(transaction.blockTime, "blockTime");
    const meta = requireRecord(transaction.meta, "transaction metadata");
    if (meta.err !== null) {
      throw new AccountingError("ACCOUNTING_CHAIN_TRANSACTION_FAILED", "Failed Solana transaction cannot affect accounting.");
    }
    const blockStarted = performance.now();
    const blockCached = this.blocks.get(slot);
    const blockCacheHit = !!blockCached && blockCached.expiresAt > this.now().getTime()
      && blockCached.signatures.includes(signature);
    const transactionIndex = await this.findTransactionIndex(slot, signature);
    this.configuration.onTiming?.({ transactionReadMs, blockReadMs: performance.now() - blockStarted,
      finalizedReadMs: performance.now() - started, blockCacheHit });
    const observations = parseWalletTokenBalanceChanges({
      signature,
      slot: BigInt(slot),
      transactionIndex,
      blockTime: new Date(blockTimeSeconds * 1_000),
      wallet,
      preTokenBalances: parseTokenBalances(meta.preTokenBalances),
      postTokenBalances: parseTokenBalances(meta.postTokenBalances),
      observedAt: this.now(),
    });
    return {
      chainTransactionId: deterministicId(`solana:${signature}:${wallet.walletId}`),
      userId: wallet.userId,
      walletId: wallet.walletId,
      walletAddress: wallet.address,
      signature,
      slot: BigInt(slot),
      transactionIndex,
      blockTime: new Date(blockTimeSeconds * 1_000),
      finality: ChainFinality.FINALIZED,
      observations,
      rawMetadata: {
        slot,
        blockTime: blockTimeSeconds,
        transaction: transaction.transaction,
        meta: {
          err: meta.err,
          preTokenBalances: meta.preTokenBalances,
          postTokenBalances: meta.postTokenBalances,
          innerInstructions: meta.innerInstructions,
          logMessages: meta.logMessages,
        },
      },
    };
  }

  /** Display-only background enrichment, without the accounting block-index RPC. */
  async fetchFinalizedTransactionMetadata(signature: string): Promise<unknown> {
    return this.sharedRpc('getTransaction', [signature, {
      commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: MAX_ACCOUNTING_TRANSACTION_VERSION,
    }]);
  }

  async getWalletTokenBalances(walletAddress: string): Promise<ReadonlyMap<string, string>> {
    const balances = new Map<string, bigint>();
    // A missing mint is zero only after BOTH programs have returned valid data.
    for (const programId of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
      const result = await this.sharedRpc("getTokenAccountsByOwner", [walletAddress, { programId },
        { commitment: "finalized", encoding: "jsonParsed" }]);
      const value = requireRecord(result, "token accounts").value;
      if (!Array.isArray(value)) throw invalidRpc("Token account list is invalid.");
      for (const item of value) {
        const account = requireRecord(requireRecord(item, "token account").account, "account");
        if (account.owner !== programId) throw invalidRpc("Token program is invalid.");
        const parsed = requireRecord(requireRecord(account.data, "data").parsed, "parsed data");
        const info = requireRecord(parsed.info, "token info");
        if (parsed.type !== "account" || info.owner !== walletAddress) throw invalidRpc("Token owner is invalid.");
        const mint = requireString(info.mint, "mint");
        const amount = requireString(requireRecord(info.tokenAmount, "token amount").amount, "raw balance");
        if (!/^\d+$/.test(amount)) throw invalidRpc("Raw token balance is invalid.");
        balances.set(mint, (balances.get(mint) ?? 0n) + BigInt(amount));
      }
    }
    return new Map([...balances].map(([mint, amount]) => [mint, amount.toString()]));
  }

  async getTokenBalance(walletAddress: string, mint: string): Promise<string> {
    const result = await this.rpc("getTokenAccountsByOwner", [
      walletAddress,
      { mint },
      { commitment: "finalized", encoding: "jsonParsed" },
    ]);
    const value = requireRecord(result, "token account response").value;
    if (!Array.isArray(value)) throw invalidRpc("Token account list is invalid.");
    let total = 0n;
    for (const item of value) {
      const account = requireRecord(requireRecord(item, "token account").account, "token account data");
      const data = requireRecord(account.data, "parsed token account data");
      const parsed = requireRecord(data.parsed, "parsed token account");
      const info = requireRecord(parsed.info, "parsed token account info");
      const tokenAmount = requireRecord(info.tokenAmount, "token amount");
      const amount = requireString(tokenAmount.amount, "raw token balance");
      if (!/^\d+$/.test(amount)) throw invalidRpc("Raw token balance is invalid.");
      total += BigInt(amount);
    }
    return total.toString();
  }

  private async findTransactionIndex(slot: number, signature: string): Promise<number> {
    const cached = this.blocks.get(slot);
    if (cached && cached.expiresAt > this.now().getTime()) {
      const index = cached.signatures.indexOf(signature);
      if (index >= 0) return index;
      // A cache miss is not permission to invent chain ordering.
      this.blocks.delete(slot); this.blockBytes -= cached.bytes;
    }
    const result = await this.sharedRpc("getBlock", [slot, {
      commitment: "finalized",
      transactionDetails: "signatures",
      rewards: false,
      maxSupportedTransactionVersion: MAX_ACCOUNTING_TRANSACTION_VERSION,
    }]);
    const signatures = requireRecord(result, "block").signatures;
    if (!Array.isArray(signatures) || signatures.some(value => typeof value !== 'string')) throw invalidRpc("Block signatures are invalid.");
    const index = signatures.indexOf(signature);
    if (index < 0) throw invalidRpc("Transaction signature is missing from its finalized block.");
    const bytes = Buffer.byteLength(JSON.stringify(signatures));
    const old = this.blocks.get(slot);
    if (old) { this.blocks.delete(slot); this.blockBytes -= old.bytes; }
    if (bytes <= 8 * 1024 * 1024) {
      while (this.blocks.size >= 64 || this.blockBytes + bytes > 8 * 1024 * 1024) {
        const first = this.blocks.entries().next().value;
        if (!first) break;
        this.blocks.delete(first[0]); this.blockBytes -= first[1].bytes;
      }
      this.blocks.set(slot, { signatures, expiresAt: this.now().getTime() + 60_000, bytes });
      this.blockBytes += bytes;
    }
    return index;
  }

  private sharedRpc(method: string, params: readonly unknown[]): Promise<unknown> {
    // Never make a newly confirmed trade wait for a paced background request.
    const key = JSON.stringify([this.workload.background, method, params]);
    const current = this.inFlight.get(key);
    if (current) return current;
    if (this.inFlight.size >= 128) return this.rpc(method, params);
    const work = this.rpc(method, params).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    const configured = uniqueRpcUrls(this.configuration.rpcUrl, this.configuration.fallbackRpcUrls ?? []);
    const preferred = this.preferred.get(method);
    const rpcUrls = preferred && preferred.until > this.now().getTime()
      ? [preferred.url, ...configured.filter(url => url !== preferred.url)] : configured;
    // Every configured endpoint gets at least one chance. `maxAttempts` remains
    // the upper bound for repeated cycles when fewer endpoints are configured.
    const maxAttempts = Math.max(boundedAttempts(this.configuration.maxAttempts ?? 3), rpcUrls.length);
    const retryBaseDelayMs = boundedRetryDelay(this.configuration.retryBaseDelayMs ?? 200);
    let lastError: AccountingError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const url = rpcUrls[(attempt - 1) % rpcUrls.length]!;
        const result = await this.workload.request(async () => {
          const priorCooldown = this.cooldowns.get(url);
          if ((priorCooldown?.until ?? 0) > this.now().getTime()) {
            throw new AccountingError("ACCOUNTING_RPC_COOLDOWN", "RPC endpoint is cooling down.", true);
          }
          const value = await this.rpcOnce(url, method, params);
          // A concurrent 429 must not be erased by an older successful request.
          if (this.cooldowns.get(url) === priorCooldown) this.cooldowns.delete(url);
          return value;
        });
        // Brief affinity avoids repeatedly querying a lagging primary. Expiry
        // permits recovery; every endpoint remains eligible on failure/null.
        if (!preferred || preferred.url !== url || preferred.until <= this.now().getTime()) {
          this.preferred.set(method, { url, until: this.now().getTime() + 30_000 });
        }
        return result;
      } catch (error) {
        const accountingError = error instanceof AccountingError
          ? error
          : new AccountingError("ACCOUNTING_SOLANA_UNAVAILABLE", `${method} is unavailable.`, true);
        lastError = accountingError;
        // Null is endpoint-local absence, not evidence that the chain is still
        // pending. Probe each configured provider once before yielding to the
        // durable queue; never loop over the same null endpoint in this call.
        if (accountingError.code === "ACCOUNTING_FINALITY_PENDING") {
          if (attempt < rpcUrls.length) continue;
          throw accountingError;
        }
        if (!accountingError.retryable || attempt === maxAttempts) throw accountingError;
        // Probe an eligible fallback immediately; never retry a throttled endpoint
        // before Retry-After. If all are cooling down, durable work resumes later.
        if (rpcUrls.every(url => (this.cooldowns.get(url)?.until ?? 0) > this.now().getTime())) throw accountingError;
        if (accountingError.code === "ACCOUNTING_RPC_COOLDOWN" || accountingError.code === "ACCOUNTING_RPC_RATE_LIMITED") continue;
        await delay(retryDelay(retryBaseDelayMs, attempt));
      }
    }
    throw lastError ?? new AccountingError("ACCOUNTING_SOLANA_UNAVAILABLE", `${method} is unavailable.`, true);
  }

  private async rpcOnce(rpcUrl: string, method: string, params: readonly unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.configuration.timeoutMs);
    try {
      const response = await this.transport(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      if (response.status === 429) {
        const previous = this.cooldowns.get(rpcUrl);
        const failures = Math.min(8, (previous?.failures ?? 0) + 1);
        const backoff = Math.min(60_000, 2_000 * 2 ** (failures - 1));
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now().getTime());
        const cooldownMs = Math.max(backoff, retryAfter ?? 0);
        this.cooldowns.set(rpcUrl, { until: Math.max(previous?.until ?? 0, this.now().getTime() + cooldownMs), failures });
        // Host only: never expose credentials, path, query, wallet or signature.
        this.configuration.onTiming?.({ event: "accounting_rpc_rate_limited", endpoint: new URL(rpcUrl).hostname,
          method, cooldownMs, background: this.workload.background });
        await response.body?.cancel();
        throw new AccountingError("ACCOUNTING_RPC_RATE_LIMITED", `${method} failed with HTTP 429.`, true);
      }
      if (!response.ok) {
        const retryable = isRetryableHttpStatus(response.status);
        throw new AccountingError(
          "ACCOUNTING_SOLANA_UNAVAILABLE",
          `${method} failed with HTTP ${response.status}.`,
          retryable,
        );
      }
      const envelope = await response.json() as RpcEnvelope;
      if (envelope.error !== undefined) {
        const code = typeof envelope.error.code === "number" ? envelope.error.code : null;
        throw new AccountingError(
          "ACCOUNTING_SOLANA_RPC_ERROR",
          `${method} failed${code === null ? "" : ` with RPC ${code}`}.`,
          isRetryableRpcCode(code),
        );
      }
      if (envelope.result === null && (method === "getTransaction" || method === "getBlock" || method === "getBlockTime")) {
        throw new AccountingError("ACCOUNTING_FINALITY_PENDING", `${method} is not available at finalized commitment yet.`, true);
      }
      if (!("result" in envelope) || envelope.result === null) throw invalidRpc(`${method} returned no result.`);
      return envelope.result;
    } catch (error) {
      if (error instanceof AccountingError) throw error;
      throw new AccountingError("ACCOUNTING_SOLANA_UNAVAILABLE", `${method} is unavailable.`, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function uniqueRpcUrls(primary: string, fallbacks: readonly string[]): readonly string[] {
  const values = [...new Set([primary, ...fallbacks].map((value) => value.trim()).filter(Boolean))];
  if (values.length === 0 || values.length > 5) throw new Error("Solana RPC endpoint count is invalid.");
  for (const value of values) {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("Solana RPC endpoints must use HTTPS.");
  }
  return values;
}

export function parseWalletTokenBalanceChanges(input: {
  readonly signature: string;
  readonly slot: bigint;
  readonly transactionIndex: number;
  readonly blockTime: Date;
  readonly wallet: TrackedWallet;
  readonly preTokenBalances: readonly ParsedTokenBalance[];
  readonly postTokenBalances: readonly ParsedTokenBalance[];
  readonly observedAt: Date;
}): readonly ChainObservation[] {
  const balances = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  for (const balance of input.preTokenBalances) {
    if (balance.owner !== input.wallet.address) continue;
    const entry = balances.get(balance.mint) ?? { pre: 0n, post: 0n, decimals: balance.uiTokenAmount.decimals };
    requireCompatibleDecimals(entry.decimals, balance.uiTokenAmount.decimals);
    entry.pre += BigInt(balance.uiTokenAmount.amount);
    balances.set(balance.mint, entry);
  }
  for (const balance of input.postTokenBalances) {
    if (balance.owner !== input.wallet.address) continue;
    const entry = balances.get(balance.mint) ?? { pre: 0n, post: 0n, decimals: balance.uiTokenAmount.decimals };
    requireCompatibleDecimals(entry.decimals, balance.uiTokenAmount.decimals);
    entry.post += BigInt(balance.uiTokenAmount.amount);
    balances.set(balance.mint, entry);
  }
  return [...balances.entries()]
    .filter(([, value]) => value.pre !== value.post)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([mint, value], eventIndex) => {
      const delta = value.post - value.pre;
      const sourceKey = `solana:${input.signature}:balance:${mint}:${input.wallet.address}`;
      return {
        observationId: deterministicId(sourceKey),
        sourceKey,
        userId: input.wallet.userId,
        walletId: input.wallet.walletId,
        walletAddress: input.wallet.address,
        signature: input.signature,
        slot: input.slot,
        transactionIndex: input.transactionIndex,
        eventIndex,
        mint,
        decimals: value.decimals,
        direction: delta > 0n ? "IN" : "OUT",
        rawQuantity: (delta > 0n ? delta : -delta).toString(),
        occurredAt: input.blockTime,
        observedAt: input.observedAt,
        finality: ChainFinality.FINALIZED,
      };
    });
}

function parseTokenBalances(value: unknown): readonly ParsedTokenBalance[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidRpc("Token balance metadata is invalid.");
  return value.map((item) => {
    const record = requireRecord(item, "token balance");
    const amount = requireRecord(record.uiTokenAmount, "uiTokenAmount");
    const raw = requireString(amount.amount, "token amount");
    const decimals = requireSafeInteger(amount.decimals, "token decimals");
    if (!/^\d+$/.test(raw)) throw invalidRpc("Token amount is invalid.");
    return {
      accountIndex: requireSafeInteger(record.accountIndex, "token account index"),
      mint: requireString(record.mint, "token mint"),
      ...(typeof record.owner === "string" ? { owner: record.owner } : {}),
      uiTokenAmount: { amount: raw, decimals },
    };
  });
}

function deterministicId(sourceKey: string): string {
  return createHash("sha256").update(sourceKey).digest("hex");
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) throw new Error("Signature page limit is invalid.");
  return value;
}

function boundedAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) throw new Error("Solana RPC attempt count is invalid.");
  return value;
}

function boundedRetryDelay(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new Error("Solana RPC retry delay is invalid.");
  return value;
}

function isRetryableRpcCode(code: number | null): boolean {
  return code === null || ![-32_600, -32_601, -32_602].includes(code);
}

function isRetryableHttpStatus(status: number): boolean {
  // Authentication/route failures are endpoint-specific configuration failures.
  // They must fail over to another configured RPC, while a JSON-RPC 400 remains
  // fail-closed because repeating an invalid request elsewhere will not repair it.
  return [401, 403, 404, 429].includes(status) || status >= 500;
}

function retryDelay(baseDelayMs: number, attempt: number): number {
  if (baseDelayMs === 0) return 0;
  const exponential = Math.min(5_000, baseDelayMs * (2 ** (attempt - 1)));
  return exponential + Math.floor(Math.random() * Math.max(1, Math.floor(baseDelayMs / 2)));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireCompatibleDecimals(left: number, right: number): void {
  if (left !== right) throw invalidRpc("Mint decimals changed inside one transaction.");
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidRpc(`${name} is invalid.`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalidRpc(`${name} is invalid.`);
  return value;
}

function requireSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidRpc(`${name} is invalid.`);
  return value;
}

function invalidRpc(message: string): AccountingError {
  return new AccountingError("ACCOUNTING_INVALID_SOLANA_RESPONSE", message, true);
}

export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const ms = Number(trimmed) * 1_000;
    return Number.isFinite(ms) ? ms : null;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}
