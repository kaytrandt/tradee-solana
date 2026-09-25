# iOS integration excerpt

The iOS application and Xcode project remain closed-source. This file discloses only the wallet authorization boundary for judge review. It is an exact method excerpt from `OfficialPrivyIdentityService.swift` in the local application snapshot, not a standalone Swift target. Surrounding SDK initialization, session types, wallet preparation, and error mapping are private application dependencies.

## Privy authorization

After the user confirms the reviewed order, the repository requests an authorization signature for the backend-provided challenge. Session generation is checked after wallet preparation so an old session cannot be reused. This is an authorization signature; it does not export a private key or itself broadcast a transaction.

```swift
func authorizationSignature(for payload: Data) async throws -> String {
    let generation = sessionGeneration
    switch await privy.getAuthState() {
    case .authenticated(let user):
        do {
            try await walletPreparation.waitUntilReady()
            guard generation == sessionGeneration else { throw IdentityServiceError.cancelled }
            return try await user.generateAuthorizationSignature(payload: payload)
        } catch {
            throw map(error)
        }
    case .unauthenticated:
        throw IdentityServiceError.expiredSession
    case .authenticatedUnverified:
        throw IdentityServiceError.unverifiedSession
    case .notReady:
        throw IdentityServiceError.providerFailure("Privy is not ready yet.")
    @unknown default:
        throw IdentityServiceError.providerFailure("Privy returned an unsupported authentication state.")
    }
}
```

`DefaultTradingRepository.submitOrder` obtains the backend challenge for the order, verifies session revision, decodes `payloadBase64`, calls this signing boundary, rechecks cancellation and session revision, and sends `authorizationSignature` plus `authorizationRequestExpiry` to the backend's order submission endpoint. The backend retains and validates the transaction bytes, then requests Privy transaction signing.

See the executable backend counterparts: [Privy user signer](../../backend/src/modules/wallet/fee-payer/privy-user-transaction-signer.ts), [co-sign provider](../../backend/src/modules/wallet/fee-payer/co-sign-transaction-provider.ts), and [Privy sponsored provider](../../backend/src/modules/trading/infrastructure/privy/privy-solana-transaction-provider.ts). No UI, analytics, app configuration, credentials, or signing certificates are included in this excerpt. The public export does not claim a new iOS build or distribution.
