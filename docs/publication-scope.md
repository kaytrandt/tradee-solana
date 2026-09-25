# Publication scope

This is a curated, independently buildable subset of the local Tradee workspace, prepared for public technical review on 2026-09-25.

## Included

- Trading/domain services, exact fee calculations, transaction policy, DFlow adapters, Solana transaction validation, and selected signing/sponsorship adapters.
- Solana mint/balance reads, xStocks/Sunrise metadata adapters, external-deposit construction, finalized accounting and funding verification.
- Their transitive TypeScript dependencies and selected original tests. PostgreSQL interfaces remain where required; tests use stubs or PGlite.
- Four SQL files required by policy tests. These are historical test inputs, not an installation schema or authorization to activate assets.
- One documented Swift authorization excerpt. The full iOS client remains closed-source.
- Original-file hashes, judge documentation, publication checks, and an optional read-only chain inspection script.

The files in [source-manifest.json](../source-manifest.json) are byte-for-byte copies of the local source. This manifest contains relative paths and SHA-256 digests, not local machine paths or credentials. The root tooling, README/docs, minimal npm configuration, and offline network guard were added for the public snapshot.

## Excluded

The iOS project, UI/design system, web frontends, App Store files, signing certificates, provisioning profiles, private keys, mnemonics, API keys, `.env` files, deployment/runtime configuration, database dumps, logs, customer records, operational reports, analytics, social features, and AI services are not part of the publication. No existing private Git history is imported.

No full production server entry point, database migration runner, deployment workflow, or transaction-execution CLI is provided. The original local application and deployed services are unchanged by this export.

## Publication checks

```sh
node scripts/check-publication.mjs
```

The check verifies the allowed file list, original-file hashes, dependency registry URLs, and common credential patterns. A separate local audit compared the export against configured backend secret values without printing or publishing those values. These checks reduce accidental disclosure; they are not a guarantee that arbitrary future additions are safe.

To update the repository, curate the new source files, refresh the manifest deliberately, inspect the diff, run `npm run verify`, and repeat secret review before publishing. `.gitignore` is an additional guard, not a replacement for review.
