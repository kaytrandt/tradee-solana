# Solana programs and instructions

## Tradee-owned program status

**There is no Tradee-owned Anchor/Rust program in this source snapshot.** Accordingly, there is no Tradee IDL, custom deployed program address, or program initialization/deployment script to publish. Tradee's Solana integration composes and validates transactions against existing programs. This directory documents those actual dependencies; it is not a placeholder claiming a custom protocol.

The addresses below come from the published integration code. [addresses.json](addresses.json) is the machine-readable inventory. The optional `npm run inspect:chain` command checks selected deployed accounts directly on mainnet; it never deploys or initializes anything.

Publication check on 2026-09-25: a read-only PublicNode mainnet query at finalized slot **450319334** confirmed executable accounts for DFlow, SPL Token, Token-2022, Associated Token Account, and Lighthouse, plus token-program ownership of USDC and the NKE/HOOD examples. This establishes those chain identities at that slot; it is not evidence of a new Tradee trade or custom program deployment.

## Program inventory

| Program | Mainnet address | Role in this integration |
| --- | --- | --- |
| DFlow router | [`DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH`](https://explorer.solana.com/address/DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH) | Provider-built swap routing; constraints parsed and checked by Tradee |
| SPL Token | [`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`](https://explorer.solana.com/address/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA) | Canonical USDC transfers and token accounts |
| Token-2022 | [`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`](https://explorer.solana.com/address/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) | Supported asset token accounts and scaled-UI mint metadata |
| Associated Token Account | [`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`](https://explorer.solana.com/address/ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL) | Derive and create token accounts |
| Compute Budget | `ComputeBudget111111111111111111111111111111` | Compute limit and priority-fee instructions |
| System | `11111111111111111111111111111111` | Native account/rent dependencies; direct SOL transfers are not USDC deposits |
| Lighthouse | [`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`](https://explorer.solana.com/address/L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95) | Narrow read-only assertions permitted when added by an external wallet |

Runtime trading authorization additionally depends on the backend's configured program/destination allowlists. This inventory does not authorize arbitrary instructions from these programs.

## Instruction and RPC inventory

| Operation | What the code constructs or validates | Evidence |
| --- | --- | --- |
| Swap | DFlow `swap` discriminator `[248,198,158,145,225,117,135,200]`; exact input, output, slippage, supported action schemas and fee constraints | [Router constraint parser](../backend/src/modules/trading/infrastructure/dflow/dflow-swap-constraints.ts) |
| Fee collection | SPL Token `TransferChecked`, opcode `12`, with a `u64` amount and explicit USDC decimals, in the same transaction | [Fee composer](../backend/src/modules/trading/infrastructure/solana/fee-transaction-composer.ts) |
| External USDC deposit | ATA `CreateIdempotent` (`1`) and SPL Token `TransferChecked` (`12`); validation also supports defined wallet account-creation variations | [External-deposit gateway](../backend/src/modules/funding/infrastructure/solana-external-deposit-gateway.ts) |
| Compute budget | `SetComputeUnitLimit` (`2`) and `SetComputeUnitPrice` (`3`) where allowed; duplicate/malformed wallet-added instructions rejected | [Deposit validator](../backend/src/modules/funding/infrastructure/solana-external-deposit-gateway.ts) |
| Sponsor boundary | Only approved ATA creation or the pinned DFlow router may receive sponsor authority through these paths | [Sponsor instruction policy](../backend/src/modules/wallet/fee-payer/sponsor-instruction-policy.ts) |
| Wallet-added assertions | Explicit Lighthouse account/token assertion payload validation; not constructed by Tradee | [Lighthouse guard](../backend/src/modules/funding/infrastructure/lighthouse-deposit-guard.ts) |
| Balances and finality | RPC `getTokenAccountsByOwner`, `getSignaturesForAddress`, `getTransaction`, and `getBlock` | [Accounting RPC gateway](../backend/src/modules/accounting/infrastructure/solana/solana-accounting-rpc-gateway.ts) |
| Mint extensions | RPC `getAccountInfo`, mint decimals and Token-2022 metadata | [Mint reader](../backend/src/modules/assets/infrastructure/solana/solana-rpc-mint-metadata-reader.ts) |

The router parser's source comment references the third-party DFlow IDL account `Cp2dCjxCWdktak2JiSrh87X6sz31EnDVKoTGtsHJvhYq`, inspected during the original implementation. That is **DFlow's schema reference**, not a Tradee deployment or a vendored/verified IDL in this repository. The provider selects underlying liquidity instructions; this snapshot does not assert a universal list of all inner instructions for every possible route.

## Settlement and asset examples

- Canonical Solana USDC mint: [`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`](https://explorer.solana.com/address/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v), six decimals.
- xStocks metadata is obtained through the [xStocks adapter](../backend/src/modules/assets/infrastructure/xstocks/xstocks-http-provider.ts), with mint identity/decimals read from Solana.
- Sunrise examples from the [pinned catalog](../backend/src/modules/assets/domain/sunrise-asset-catalog.ts): NKE `NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg`, HOOD `HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A`.

These public addresses are examples of integrated identities, not proof of current whitelist status, market liquidity, or an instruction to transact. Backend policy is revalidated before execution.
