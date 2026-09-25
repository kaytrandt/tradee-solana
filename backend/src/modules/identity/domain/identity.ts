export interface VerifiedPrivyIdentity {
  readonly privyUserId: string;
  readonly sessionId: string;
  readonly solanaWalletAddress: string;
  readonly privyWalletId: string | null;
  readonly teeExecutionEnabled: boolean;
  readonly verifiedEmail: string | null;
  readonly verifiedPhone: string | null;
  readonly contactVerifiedAt: Date | null;
  readonly googleIdentity: GoogleIdentity | null;
  readonly googleIsOnlyLoginMethod: boolean;
}

export interface GoogleIdentity {
  readonly subject: string;
  readonly email: string;
  readonly name: string | null;
}

export interface PrivyGoogleIdentityWebhookEvent {
  readonly type: "user.linked_account" | "user.unlinked_account";
  readonly privyUserId: string;
  readonly googleIdentity: GoogleIdentity | null;
  readonly changedSubject: string;
  readonly googleIsOnlyLoginMethod: boolean;
}

export interface PrivyGoogleIdentityWebhookRepository {
  synchronize(input: {
    readonly svixId: string;
    readonly payloadSha256: string;
    readonly event: PrivyGoogleIdentityWebhookEvent;
    readonly observedAt: Date;
  }): Promise<{ readonly duplicate: boolean; readonly userFound: boolean }>;
}

export class PrivyGoogleIdentityWebhookError extends Error {
  constructor(
    readonly code: "webhook_payload_conflict" | "invalid_google_identity" | "identity_persistence_failed",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PrivyGoogleIdentityWebhookError";
  }
}

export interface VerifiedPrivyUser {
  readonly privyUserId: string;
  readonly sessionId: string;
}

export interface PrivyAccessTokenProvider {
  verifyAccessToken(accessToken: string): Promise<VerifiedPrivyUser>;
}

export interface TradeeIdentitySession {
  readonly tradeeUserId: string;
  readonly privyUserId: string;
  readonly solanaWalletAddress: string;
  readonly onboardingComplete: boolean;
}

export interface PrivyIdentityProvider {
  verifyAccessToken(accessToken: string): Promise<VerifiedPrivyUser>;
  verify(accessToken: string, solanaWalletAddress: string): Promise<VerifiedPrivyIdentity>;
}

export interface IdentityRepository {
  findSession(privyUserId: string, solanaWalletAddress: string): Promise<TradeeIdentitySession | null>;
  synchronize(identity: VerifiedPrivyIdentity): Promise<TradeeIdentitySession>;
}

export class IdentityDomainError extends Error {
  constructor(
    readonly code:
      | "identity_not_configured"
      | "invalid_access_token"
      | "wallet_not_linked"
      | "wallet_conflict"
      | "privy_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "IdentityDomainError";
  }
}
