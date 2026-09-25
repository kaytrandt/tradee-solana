# Judge guide

## 1. Inspect and run without credentials

Use Node.js 24. From the repository root:

```sh
npm --prefix backend ci --ignore-scripts
npm run verify
```

Dependency installation needs the public npm registry. The tests themselves run offline: `backend/test-support/offline.mjs` blocks socket connections and the default `fetch`; adapters are tested with injected test transports. No API keys, private keys, account login, production database, or wallet funding are required.

| Evidence | Tests to inspect |
| --- | --- |
| Backend whitelist, user/wallet eligibility, exact amount limits | `backend/test/trading-policy-service.test.ts` |
| Deducted fees, integer rounding, unchanged gross buy budget | `trading-fee-engine.test.ts`, `transaction-fees.test.ts`, `charged-transaction-fees.test.ts` |
| Provider abstraction and DFlow request/response validation | `dflow-trading-provider.test.ts` |
| Wrong mints/signers/programs/amounts and modified transaction rejection | `solana-trade-transaction-validator.test.ts`, `trade-economics-security.test.ts` |
| User authorization, co-sign integrity, durable recovery | `privy-solana-transaction-provider.test.ts`, `fee-payer.test.ts` |
| Policy rechecks, repeated submissions, order transitions and confirmation | `trading-service.test.ts`, `trading-state-machine.test.ts`, `solana-rpc-execution-gateway.test.ts` |
| Finalized accounting and USDC-only deposit classification | `accounting-normalizer.test.ts`, `privy-funds-deposited-service.test.ts` |
| Exact issuer metadata | `xstocks-http-provider.test.ts` |

All filenames after the first row are also under `backend/test/`. The original source snapshot passed **169 tests, zero failures**, with TypeScript checking, during publication preparation on 2026-09-25.

## 2. Inspect the real Solana dependencies

Read [onchain/README.md](../onchain/README.md). Addresses are public chain identities, not credentials.

```sh
npm run inspect:chain
# Optional public RPC override, without credentials:
npm run inspect:chain -- https://solana-rpc.publicnode.com
```

Only `getGenesisHash` and `getMultipleAccounts` are called. The command checks account existence, executable program flags, and token-program ownership. It does not prove liquidity, asset eligibility, issuer backing, or a completed Tradee transaction. A public RPC may return rate-limit/network errors; record that separately from offline test results.

## 3. Try the iOS app when external beta access is available

Invitation: [Tradee on TestFlight](https://testflight.apple.com/join/tmPFmzE7).

As of the 2026-09-25 source snapshot, the latest local release notes recorded an uploaded build awaiting external submission. The invitation is configured, but a fresh external install has not been verified. No public demo-video URL was present in this export. If access is unavailable, use the offline review path above and request a live walkthrough from the submitter through the competition channel.

When access works:

1. Install TestFlight and Tradee, sign in with your own supported account, and complete onboarding.
2. Open Home and an available stock detail page. Review the issuer/token information and portfolio screens.
3. Open Deposit to inspect the Solana USDC deposit details. Inspect Buy/Sell and the quote/review flow.
4. This app uses **mainnet real assets**. A source review does not require a deposit or trade. Any optional real transaction must go through the app's normal review, confirmation, and signing flow.
5. After a transaction you choose to make, compare the app's transaction signature and balance with Solana Explorer on mainnet. No sample customer wallet or transaction history is published here.

Test credentials, bypass routes, user data, and production API credentials are intentionally absent. This task did not execute a live trade or change app distribution.
