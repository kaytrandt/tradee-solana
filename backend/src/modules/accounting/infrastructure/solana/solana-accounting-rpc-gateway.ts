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

export class SolanaAccountingRpcGateway implements SolanaAccountingGateway {
  constructor(
    private readonly configuration: {
      readonly rpcUrl: string;
      readonly fallbackRpcUrls?: readonly string[];
      readonly timeoutMs: number;
      readonly maxAttempts?: number;
      readonly retryBaseDelayMs?: number;
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
    const transactionValue = await this.rpc("getTransaction", [signature, {
      commitment: "finalized",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    }]);
    const transaction = requireRecord(transactionValue, "finalized transaction");
    const slot = requireSafeInteger(transaction.slot, "slot");
    const blockTimeSeconds = transaction.blockTime === null || transaction.blockTime === undefined
      ? requireSafeInteger(await this.rpc("getBlockTime", [slot]), "blockTime")
      : requireSafeInteger(transaction.blockTime, "blockTime");
    const meta = requireRecord(transaction.meta, "transaction metadata");
    if (meta.err !== null) {
      throw new AccountingError("ACCOUNTING_CHAIN_TRANSACTION_FAILED", "Failed Solana transaction cannot affect accounting.");
    }
    const transactionIndex = await this.findTransactionIndex(slot, signature);
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
    return this.rpc('getTransaction', [signature, {
      commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0,
    }], true);
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
    const result = await this.rpc("getBlock", [slot, {
      commitment: "finalized",
      transactionDetails: "signatures",
      rewards: false,
      maxSupportedTransactionVersion: 0,
    }]);
    const signatures = requireRecord(result, "block").signatures;
    if (!Array.isArray(signatures)) throw invalidRpc("Block signatures are invalid.");
    const index = signatures.indexOf(signature);
    if (index < 0) throw invalidRpc("Transaction signature is missing from its finalized block.");
    return index;
  }

  private async rpc(method: string, params: readonly unknown[], historicalFallback = false): Promise<unknown> {
    const rpcUrls = uniqueRpcUrls(this.configuration.rpcUrl, this.configuration.fallbackRpcUrls ?? []);
    // Every configured endpoint gets at least one chance. `maxAttempts` remains
    // the upper bound for repeated cycles when fewer endpoints are configured.
    const maxAttempts = Math.max(boundedAttempts(this.configuration.maxAttempts ?? 3), rpcUrls.length);
    const retryBaseDelayMs = boundedRetryDelay(this.configuration.retryBaseDelayMs ?? 200);
    let lastError: AccountingError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.rpcOnce(rpcUrls[(attempt - 1) % rpcUrls.length]!, method, params);
      } catch (error) {
        const accountingError = error instanceof AccountingError
          ? error
          : new AccountingError("ACCOUNTING_SOLANA_UNAVAILABLE", `${method} is unavailable.`, true);
        lastError = accountingError;
        // A null finalized read is normal immediately after confirmation. The
        // durable queue schedules its next poll; do not occupy a worker lane
        // with several identical RPC reads and nested backoffs.
        if (accountingError.code === "ACCOUNTING_FINALITY_PENDING") {
          // Old finalized receipts can be pruned by one provider but retained by
          // another. Only background attribution probes each configured provider;
          // normal deposit finality reads still yield immediately to the queue.
          if (historicalFallback && attempt < rpcUrls.length) continue;
          throw accountingError;
        }
        if (!accountingError.retryable || attempt === maxAttempts) throw accountingError;
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
