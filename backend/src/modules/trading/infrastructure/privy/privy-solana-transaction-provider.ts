import {
  APIConnectionError,
  AuthenticationError,
  BadRequestError,
  formatRequestForAuthorizationSignature,
  PermissionDeniedError,
  PrivyClient,
  RateLimitError,
  UnprocessableEntityError,
} from "@privy-io/node";
import {
  TradingEngineError,
  type SponsoredTransactionProvider,
  type SponsoredTransactionAuthorizationChallenge,
  type SponsoredTransactionAuthorizationRequest,
  type SponsoredTransactionRequest,
  type SponsoredTransactionResult,
  type SponsoredTransactionStatus,
} from "../../domain/trading.js";

export interface PrivySolanaTransactionConfiguration {
  readonly appId: string;
  readonly appSecret: string;
  readonly caip2: string;
  readonly requestExpiryMs: number;
}

interface PrivyTransactionRecord {
  readonly id: string;
  readonly status: string;
  readonly transaction_hash: string | null;
  readonly reference_id?: string | null;
}

export interface PrivySponsoredSendInput {
  readonly caip2: string;
  readonly transaction: string;
  readonly sponsor: true;
  readonly reference_id: string;
  readonly idempotency_key: string;
  readonly request_expiry: number;
  readonly authorization_context:
    | { readonly signatures: string[] }
    | { readonly user_jwts: string[] };
}

export type PrivySponsoredSend = (
  walletId: string,
  input: PrivySponsoredSendInput,
) => Promise<{
  readonly hash: string;
  readonly transaction_id?: string | null;
  readonly reference_id?: string | null;
}>;

export type PrivyTransactionFetch = typeof fetch;

export interface PrivyTransactionLogger {
  info(event: string, details: Readonly<Record<string, unknown>>): void;
  error(event: string, details: Readonly<Record<string, unknown>>): void;
}

export class PrivySolanaTransactionProvider implements SponsoredTransactionProvider {
  private readonly client: PrivyClient;
  private readonly send: PrivySponsoredSend;
  private readonly transport: PrivyTransactionFetch;
  private readonly logger: PrivyTransactionLogger | undefined;

  constructor(
    private readonly configuration: PrivySolanaTransactionConfiguration,
    dependencies: {
      readonly send?: PrivySponsoredSend;
      readonly fetch?: PrivyTransactionFetch;
      readonly logger?: PrivyTransactionLogger;
    } = {},
  ) {
    this.client = new PrivyClient({
      appId: configuration.appId,
      appSecret: configuration.appSecret,
    });
    this.send = dependencies.send ?? ((walletId, input) =>
      this.client.wallets().solana().signAndSendTransaction(walletId, input));
    this.transport = dependencies.fetch ?? fetch;
    this.logger = dependencies.logger;
  }

  createAuthorizationChallenge(
    request: SponsoredTransactionAuthorizationRequest,
  ): SponsoredTransactionAuthorizationChallenge {
    const requestExpiry = Date.now() + this.configuration.requestExpiryMs;
    const payload = formatRequestForAuthorizationSignature(
      this.authorizationPayload(request, requestExpiry),
    );
    return {
      payloadBase64: Buffer.from(payload).toString("base64"),
      requestExpiry,
    };
  }

  async signAndSend(request: SponsoredTransactionRequest): Promise<SponsoredTransactionResult> {
    try {
      const authorization = this.authorizationContext(request);
      const result = await this.send(request.walletId, {
        caip2: this.configuration.caip2,
        transaction: request.serializedTransaction,
        sponsor: true,
        reference_id: request.referenceId,
        idempotency_key: request.idempotencyKey,
        request_expiry: authorization.requestExpiry,
        authorization_context: authorization.context,
      });
      if (!validSignature(result.hash)) {
        throw new TradingEngineError(
          "TRADE_SUBMISSION_AMBIGUOUS",
          "Privy accepted the sponsored request but returned an invalid Solana signature.",
          true,
        );
      }
      if (result.reference_id !== undefined && result.reference_id !== null && result.reference_id !== request.referenceId) {
        throw new TradingEngineError(
          "TRADE_SUBMISSION_AMBIGUOUS",
          "Privy returned a mismatched transaction reference.",
          true,
        );
      }
      this.logger?.info("privy_sponsored_transaction_accepted", {
        referenceId: request.referenceId,
        providerTransactionIdPresent: result.transaction_id !== undefined && result.transaction_id !== null,
      });
      return {
        transactionSignature: result.hash,
        providerTransactionId: result.transaction_id ?? null,
        referenceId: request.referenceId,
        sponsored: true,
      };
    } catch (error) {
      this.logger?.error("privy_sponsored_transaction_failed", {
        referenceId: request.referenceId,
        ...privyFailureMetadata(error),
      });
      throw mapPrivyExecutionError(error);
    }
  }

  private authorizationPayload(
    request: SponsoredTransactionAuthorizationRequest,
    requestExpiry: number,
  ) {
    return {
      version: 1 as const,
      method: "POST" as const,
      url: `https://api.privy.io/v1/wallets/${request.walletId}/rpc`,
      headers: {
        "privy-app-id": this.configuration.appId,
        "privy-idempotency-key": request.idempotencyKey,
        "privy-request-expiry": String(requestExpiry),
      },
      body: {
        caip2: this.configuration.caip2,
        sponsor: true as const,
        reference_id: request.referenceId,
        method: "signAndSendTransaction" as const,
        chain_type: "solana" as const,
        params: {
          transaction: request.serializedTransaction,
          encoding: "base64" as const,
        },
      },
    };
  }

  private assertAuthorization(signature: string, requestExpiry: number): void {
    const now = Date.now();
    const decoded = /^[A-Za-z0-9+/]+={0,2}$/.test(signature)
      ? Buffer.from(signature, "base64")
      : Buffer.alloc(0);
    if (decoded.byteLength < 8 || decoded.byteLength > 256) {
      throw new TradingEngineError(
        "TRADE_USER_AUTHORIZATION_INVALID",
        "The Privy wallet authorization signature is invalid.",
        true,
      );
    }
    if (!Number.isSafeInteger(requestExpiry)
      || requestExpiry <= now
      || requestExpiry > now + this.configuration.requestExpiryMs + 5_000) {
      throw new TradingEngineError(
        "TRADE_USER_AUTHORIZATION_INVALID",
        "The Privy wallet authorization signature expired.",
        true,
      );
    }
  }

  private authorizationContext(request: SponsoredTransactionRequest): {
    readonly requestExpiry: number;
    readonly context: PrivySponsoredSendInput["authorization_context"];
  } {
    if (request.authorizationSignature !== undefined
      && request.authorizationRequestExpiry !== undefined) {
      this.assertAuthorization(request.authorizationSignature, request.authorizationRequestExpiry);
      return {
        requestExpiry: request.authorizationRequestExpiry,
        context: { signatures: [request.authorizationSignature] },
      };
    }
    if (request.userAuthorizationToken !== undefined
      && request.userAuthorizationToken.length > 0) {
      return {
        requestExpiry: Date.now() + this.configuration.requestExpiryMs,
        context: { user_jwts: [request.userAuthorizationToken] },
      };
    }
    throw new TradingEngineError(
      "TRADE_USER_AUTHORIZATION_INVALID",
      "Privy wallet authorization is required.",
      true,
    );
  }

  async getByReferenceId(referenceId: string): Promise<SponsoredTransactionStatus> {
    try {
      const url = new URL("/v1/transactions", "https://api.privy.io");
      url.searchParams.set("reference_id", referenceId);
      const response = await this.transport(url, {
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${this.configuration.appId}:${this.configuration.appSecret}`).toString("base64")}`,
          "privy-app-id": this.configuration.appId,
        },
      });
      if (response.status === 404) return notFound(referenceId);
      if (!response.ok) throw new Error(`Privy transaction lookup returned ${response.status}.`);
      const payload = await response.json() as unknown;
      const records = transactionRecords(payload);
      const record = records.find((item) => item.reference_id === referenceId);
      if (record === undefined) return notFound(referenceId);
      return {
        state: normalizeStatus(record.status),
        transactionSignature: record.transaction_hash,
        providerTransactionId: record.id,
        referenceId,
      };
    } catch (error) {
      if (error instanceof TradingEngineError) throw error;
      throw new TradingEngineError(
        "TRADE_SUBMISSION_AMBIGUOUS",
        "Privy transaction status is temporarily unavailable.",
        true,
      );
    }
  }
}

function privyFailureMetadata(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) return { errorName: "UnknownError" };
  const candidate = error as Error & {
    readonly status?: unknown;
    readonly error?: unknown;
    readonly headers?: unknown;
  };
  const providerError = typeof candidate.error === "object" && candidate.error !== null
    ? candidate.error as Record<string, unknown>
    : null;
  const providerCode = providerError === null ? null
    : typeof providerError.code === "string" ? providerError.code
      : typeof providerError.error_code === "string" ? providerError.error_code
        : null;
  const providerMessage = providerError === null ? null
    : safeDiagnosticString(providerError.message)
      ?? safeDiagnosticString(providerError.error)
      ?? null;
  const headers = candidate.headers instanceof Headers ? candidate.headers : null;
  return {
    errorName: error.name,
    status: typeof candidate.status === "number" ? candidate.status : null,
    providerCode,
    providerMessage,
    requestId: headers?.get("x-request-id") ?? headers?.get("request-id") ?? null,
  };
}

/**
 * Provider diagnostics are useful for distinguishing an authorization failure
 * from an invalid Solana transaction, but must never turn a transaction or JWT
 * into a log field. Privy error messages are short prose; reject anything that
 * resembles a serialized payload and cap the remaining text.
 */
function safeDiagnosticString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  const withoutOpaqueValues = normalized.replace(/[A-Za-z0-9+/_=-]{48,}/g, "[redacted]");
  return withoutOpaqueValues.slice(0, 320);
}

function mapPrivyExecutionError(error: unknown): TradingEngineError {
  if (error instanceof TradingEngineError) return error;
  if (isInvalidUserJwt(error)) {
    return new TradingEngineError(
      "TRADE_USER_AUTHORIZATION_INVALID",
      "The Privy user authorization token must be refreshed before this trade can be signed.",
      true,
    );
  }
  if (error instanceof RateLimitError) {
    return new TradingEngineError(
      "TRADE_SPONSORSHIP_RATE_LIMITED",
      "Gas sponsorship is temporarily rate limited.",
      true,
    );
  }
  if (
    error instanceof PermissionDeniedError
    || error instanceof BadRequestError
    || error instanceof UnprocessableEntityError
  ) {
    return new TradingEngineError(
      "TRADE_GAS_SPONSORSHIP_REJECTED",
      "Privy rejected gas sponsorship for this transaction.",
      true,
    );
  }
  if (error instanceof AuthenticationError) {
    return new TradingEngineError(
      "TRADE_PROVIDER_AUTH_FAILED",
      "Privy rejected Tradee's server credentials.",
    );
  }
  if (error instanceof APIConnectionError) {
    return new TradingEngineError(
      "TRADE_SUBMISSION_AMBIGUOUS",
      "The sponsored transaction outcome is unknown and will be reconciled before any retry.",
      true,
    );
  }
  return new TradingEngineError(
    "TRADE_SUBMISSION_AMBIGUOUS",
    "The sponsored transaction outcome is unknown and will be reconciled before any retry.",
    true,
  );
}

function isInvalidUserJwt(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { readonly error?: unknown };
  if (typeof candidate.error !== "object" || candidate.error === null) return false;
  const providerError = candidate.error as Record<string, unknown>;
  const code = typeof providerError.code === "string" ? providerError.code.toLowerCase() : "";
  const message = typeof providerError.message === "string" ? providerError.message.toLowerCase()
    : typeof providerError.error === "string" ? providerError.error.toLowerCase()
      : "";
  return code === "invalid_data" && message.includes("invalid jwt token");
}

function transactionRecords(value: unknown): readonly PrivyTransactionRecord[] {
  if (typeof value !== "object" || value === null) return [];
  const object = value as Record<string, unknown>;
  const data = typeof object.data === "object" && object.data !== null && !Array.isArray(object.data)
    ? object.data as Record<string, unknown>
    : null;
  const items = Array.isArray(object.transactions) ? object.transactions
    : Array.isArray(object.data) ? object.data
      : Array.isArray(data?.transactions) ? data.transactions : [];
  return items.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.status !== "string") return [];
    return [{
      id: record.id,
      status: record.status,
      transaction_hash: typeof record.transaction_hash === "string" ? record.transaction_hash : null,
      reference_id: typeof record.reference_id === "string" ? record.reference_id : null,
    }];
  });
}

function normalizeStatus(value: string): SponsoredTransactionStatus["state"] {
  if (value === "confirmed" || value === "finalized") return "confirmed";
  if (value === "failed" || value === "execution_reverted" || value === "provider_error") return "failed";
  return "pending";
}

function notFound(referenceId: string): SponsoredTransactionStatus {
  return {
    state: "not_found",
    transactionSignature: null,
    providerTransactionId: null,
    referenceId,
  };
}

function validSignature(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value);
}
