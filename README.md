# Tradee — tokenized stocks on Solana

Tradee is an iOS social investing app for people who want to discover tokenized equities, buy and sell with USDC, and follow their on-chain holdings in one mobile experience. This repository publishes the backend and Solana integration work for competition judges.

> **The iOS client is closed-source.** This repo contains selected backend modules, Solana integration snippets, and docs for judges. The app's TestFlight invitation is [Tradee on TestFlight](https://testflight.apple.com/join/tmPFmzE7) (TestFlight may be unavailable due to an ongoing Apple “Beta Contract Missing” issue). External installation availability is not yet verified; see the [judge guide](docs/judge-guide.md).

**Network: Solana mainnet-beta.** The offline tests use synthetic transactions and mocked providers. This is not a devnet deployment. Tradee currently integrates existing Solana programs; there is **no Tradee-owned Anchor/Rust program, IDL, or program deployment** in this snapshot.

## What the app does

1. A user signs in and connects to a Privy embedded Solana wallet.
2. The user deposits canonical Solana USDC. Other received tokens are not classified as cash deposits.
3. The user discovers a tokenized stock and requests a buy or sell quote. Backend policy decides whether the asset, user, wallet, and amount are eligible.
4. DFlow prepares the swap. Tradee checks the transaction, amounts, fee destination, permitted programs, and expiry.
5. The user reviews and confirms in the app, then authorizes the exact request through Privy. The backend submits through the configured signing/sponsorship adapter.
6. Solana confirmation and finalized token balances drive order reconciliation and portfolio accounting.

The public integration includes **xStocks and Sunrise** asset adapters. Asset names alone never authorize trading: mint identity and backend policy are authoritative. A catalog entry does not guarantee a live route. Social UI and AI features are outside this export.

## Why Solana

The assets and settlement USDC are Solana tokens. Swaps, token-account creation, fee collection, and wallet ownership all depend on Solana transactions and token programs. Solana RPC supplies the balance and confirmation facts that the backend reconciles. Privy provides user wallet signing, while DFlow supplies executable swap routes. Solana is the settlement layer of the product.

## Review in five minutes

Requires **Node.js 24** and npm. No `.env`, API key, database server, or funded wallet is needed for the test suite.

```sh
git clone https://github.com/kaytrandt/tradee-solana.git
cd tradee-solana
npm --prefix backend ci --ignore-scripts
npm run verify
```

`verify` checks the publication allowlist and source hashes, type-checks TypeScript, and runs the backend tests with outbound network connections disabled. Tests use injected transports and, where needed, an in-process PGlite database. They cannot broadcast a real transaction.

For an optional **read-only mainnet inspection**, after reviewing the script:

```sh
npm run inspect:chain
```

This checks the mainnet genesis hash, deployed third-party program accounts, and sample token-account owners using a public RPC. It does not sign, send, or create accounts. Public RPC availability/rate limits can affect this check independently of offline tests.

## What to read

| Area | Entry point |
| --- | --- |
| Architecture and signing flow | [Technical overview](docs/architecture.md) |
| Judge instructions and limitations | [Judge guide](docs/judge-guide.md) |
| Programs, addresses, instructions | [On-chain integration](onchain/README.md) |
| Backend trading policy | [TradingPolicyService](backend/src/modules/transaction-policy/application/trading-policy-service.ts) |
| Orders, review binding, submission | [TradingService](backend/src/modules/trading/application/trading-service.ts) |
| DFlow swap integration | [DFlowTradingProvider](backend/src/modules/trading/infrastructure/dflow/dflow-trading-provider.ts) |
| Transaction validation | [SolanaTradeTransactionValidator](backend/src/modules/trading/application/solana-trade-transaction-validator.ts) |
| User signing and fee-payer separation | [Privy signer](backend/src/modules/wallet/fee-payer/privy-user-transaction-signer.ts), [co-sign provider](backend/src/modules/wallet/fee-payer/co-sign-transaction-provider.ts) |
| Balance reads and finalized transactions | [Solana accounting gateway](backend/src/modules/accounting/infrastructure/solana/solana-accounting-rpc-gateway.ts) |
| Minimal iOS integration disclosure | [Privy authorization snippet](integrations/ios/README.md) |
| Included/excluded files | [Publication scope](docs/publication-scope.md) |

## Boundaries

This is a runnable **backend module/test snapshot**, not the complete production server or an iOS build. It contains no production credentials, user records, Xcode project, certificates, provisioning profiles, deployment scripts, UI assets, or analytics integrations. The SQL files are selected test dependencies, not a complete database setup.

The implementation uses exact decimal strings and integer base units. Buy fees are deducted within the user's gross input budget; sell fees are deducted from proceeds. The snapshot contains both the legacy provider-fee path and the newer explicit service/network-fee path; the [architecture notes](docs/architecture.md#fees-and-wallet-ownership) explain that distinction. Tests are evidence of local behavior, not a claim of an independent security audit or a newly executed mainnet trade.

Source snapshot: **2026-09-25**. Original exported files are listed with SHA-256 hashes in [source-manifest.json](source-manifest.json).
