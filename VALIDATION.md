# Validation — 2026-09-27

## Completed

- `pnpm typecheck`: strict TypeScript checking passed for source, scripts and tests.
- `pnpm build`: production JavaScript emitted to `dist/` with rewritten `.js` imports.
- Compiled `dist/` smoke checks passed: runtime module loading, one-time paper execution, synthetic-key signing and key derivation. The compiled CLI also loaded from a different working directory. No network calls were made by these checks.
- `pnpm test`: **48 passed, 0 failed**, including environment loading, precedence, quoted passwords, mode overrides and invalid configuration rejection.
- `pnpm dev` and `pnpm start`: command/argument forwarding verified by the conflicting-mode guard before vault access or network calls. `pnpm start` automatically compiled successfully first.
- Source and compiled configuration modules resolve the same project-root `.env` and data directory. Existing local `.env` was preserved.
- Dependencies installed with pnpm 10.18.3 and pinned in `pnpm-lock.yaml`.
- `pnpm install --frozen-lockfile --ignore-scripts --offline`: passed using the existing local package store.
- Eight read-only public quote checks passed before migration on this date (historical result, not rerun by the offline TypeScript checks):
  - NEARLY → wNEAR (DCL)
  - RICH → NEARLY (DCL)
  - ILLIA → wNEAR, including 1% sell tax (DCL)
  - RHEACAT → RHEA (DCL)
  - ZECAT → ZEC (DCL)
  - JENSEN → NVDAon (DCL)
  - UCAT → NEAR (Umbra curve)
  - UMBRA → LiNEAR (graduated Rhea simple pool; registration plan identified)
- Public FastNEAR FT discovery returned 106 contracts for the public example account at check time.
- A historical public UCAT sell's FINAL receipts were classified correctly, including exact NEAR payout. Its public fixture is in `test/fixtures/public-ucat-sell.json`; original transaction: [NearBlocks](https://nearblocks.io/txns/31JNFg7mme8VtiRXUpns93ajkcTrTqPwfxqP6jZDaZoR).
- Telegram command/review/activation and interactive target forms tested with a mock transport. All cryptographic signing tests use generated synthetic keys.

## Not yet exercised

- A real Telegram bot connection: the owner must create/provide their own BotFather token through `pnpm run setup`.
- Import of the owner's real wallet: use the local importer, not chat.
- An actual mainnet sell or storage deposit. No real wallet key was loaded and no transaction was broadcast during development.
- Live receipt verification of every supported token implementation. Contracts and public API schemas can change; unknown responses stop the relevant action.

Read-only quotes validate current route availability and transaction arguments, not future execution or profitability. See `README.md` for scope, fee/registration behavior, custody and recovery.
