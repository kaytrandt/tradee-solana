import { AuthenticationError, PermissionDeniedError, BadRequestError, PrivyClient, formatRequestForAuthorizationSignature } from "@privy-io/node";
import { TradingEngineError, type SponsoredTransactionAuthorizationRequest } from "../../trading/domain/trading.js";

export interface UserTransactionSigner {
  challenge(request: SponsoredTransactionAuthorizationRequest, expiry: number): string;
  sign(request: SponsoredTransactionAuthorizationRequest, expiry: number, authorization: string): Promise<string>;
}
/** Privy signs for the user only. It neither sponsors nor broadcasts this path. */
export class PrivyUserTransactionSigner implements UserTransactionSigner {
  private readonly client: PrivyClient;
  constructor(private readonly appId: string, appSecret: string, transport?: typeof fetch) {
    this.client = new PrivyClient({ appId, appSecret, timeout: 10_000, maxRetries: 0, ...(transport ? { fetch: transport } : {}) });
  }
  challenge(request: SponsoredTransactionAuthorizationRequest, expiry: number): string {
    return Buffer.from(formatRequestForAuthorizationSignature({ version: 1, method: "POST",
      url: `https://api.privy.io/v1/wallets/${request.walletId}/rpc`, headers: {
        "privy-app-id": this.appId, "privy-idempotency-key": request.idempotencyKey,
        "privy-request-expiry": String(expiry),
      }, body: { method: "signTransaction", chain_type: "solana",
        params: { transaction: request.serializedTransaction, encoding: "base64" } },
    })).toString("base64");
  }
  async sign(request: SponsoredTransactionAuthorizationRequest, expiry: number, authorization: string): Promise<string> {
    try {
      const result = await this.client.wallets().solana().signTransaction(request.walletId, {
        transaction: request.serializedTransaction, idempotency_key: request.idempotencyKey,
        request_expiry: expiry, authorization_context: { signatures: [authorization] },
      });
      if (result.encoding !== "base64") throw new Error();
      return result.signed_transaction;
    } catch (error) {
      const auth = error instanceof PermissionDeniedError || error instanceof BadRequestError;
      throw new TradingEngineError(auth ? "TRADE_USER_AUTHORIZATION_INVALID"
        : error instanceof AuthenticationError ? "TRADE_PROVIDER_AUTH_FAILED" : "TRADE_PROVIDER_UNAVAILABLE",
      auth ? "Privy could not authorize the user signature. Review and authorize again." : "User signing is temporarily unavailable; no transaction was broadcast.", true);
    }
  }
}
