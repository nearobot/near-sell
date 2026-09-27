# Validation — 2026-09-27

## Completed

- `npm run typecheck`: strict TypeScript checking passed for source, scripts and tests.
- `npm run build`: production JavaScript emitted to `dist/` with rewritten `.js` imports.
- Compiled `dist/` smoke checks passed: runtime module loading, one-time paper execution, synthetic-key signing and key derivation. The compiled CLI also loaded from a different working directory. No network calls were made by these checks.
- `npm run check`: strict type checking, production build and **78 tests passed, 0 failed** after the npm migration using a clean npm install. HTTP failure recovery, read-only diagnostics, token labels, Nearly readiness, live preflight, Telegram interface and environment configuration checks all pass.
- Network regressions cover HTTP 500 failover at the same block, temporary provider exclusion, API-key isolation, bounded read-only price retries, shared price requests, rejection of stale cached prices, safe error context and single-attempt submission even when a caller omits the write flag. The diagnostic fetch guard rejects transaction methods before any network call.
- A compiled UMBRA diagnostic passed all public snapshot, quote, account, gas and protocol reads. The reported VPS HTTP 500 was not reproduced locally, so its exact originating provider/request remains unconfirmed.
- A compiled read-only UMBRA quote also passed with both FastNEAR endpoints deliberately returning synthetic HTTP 500 responses: reads continued through the actual Shitzu provider to a LiNEAR payout quote. Separate public checks verified UMBRA curve state, gas and protocol fields through Intear. No keys, signatures or broadcasts were used. dRPC and BlockPI failed capability checks and were not added to the defaults.
- Token names/symbols are saved with new targets and backfilled for existing targets from display metadata. Regression checks cover metadata lookup during a failed route, preservation of existing target rules/status, cached names during provider outages, and error/final confirmation delivery when metadata is unavailable.
- Reproduced `Invalid on-chain token amount` in the original live preflight using the actual nested protocol response. Fixed storage pricing to read `runtime_config.storage_amount_per_byte`, matching the [NEAR RPC schema](https://docs.near.org/api/rpc/protocol#protocol-config). The prior test mock incorrectly placed that field at the response root.
- Captured a public mainnet protocol-config excerpt in `test/fixtures/public-protocol-config.json`. Regression checks cover exact storage/gas/reserve boundaries, successful live monitoring through the real preflight implementation with mocked submission, and rejection of malformed protocol fields before signing. Quote amount validation also rejects imprecise JSON numbers and identifies the affected field.
- A fresh read-only ILLIA (`illia.nearlytrade.near`) quote passed through Rhea DCL to wNEAR with its 1% sell tax. This used a public example account and an illustrative 1,000-token quote, not the owner's wallet or target. No signing or broadcast occurred.
- Reproduced the Nearly readiness rejection with a public response for `nillions.nearlytrade.near` at final block **217472022**: factory `step=Done`, `inflight=true`, matching DCL pool `state=Running`, and a successful sell quote. The response excerpt is saved in `test/fixtures/public-nearly-inflight.json`. The current deployed Nearly token page also treats `step=Done` as live without requiring `inflight=false`.
- Completed Nearly launches now require a matching, running DCL pool rather than an idle factory flag. Regression tests still reject missing, mismatched, failed and unfinished launches, stopped pools and wrong pool assets. Waiting notices identify the token/mode; successful monitoring below the trigger clears an obsolete route error without signing.
- `npm run dev -- --paper --live`, `npm start -- --paper --live`, `npm run dev:live -- --paper` and `npm run start:live -- --paper`: argument forwarding verified by the conflicting-mode guard before vault access or network calls. Both compiled start commands built successfully first. `npm run diagnose` without arguments reports the updated npm usage and exits without network calls.
- Source and compiled configuration modules resolve the same project-root `.env` and data directory. Existing local `.env` was preserved.
- Dependencies installed with npm **11.16.0** and pinned in `package-lock.json` (lockfile v3). All direct and transitive package versions match the previous lockfile. Entries use registry URLs and integrity hashes, with no links to the old installation. The old lockfile was removed.
- `npm ci --ignore-scripts --no-audit --no-fund`: clean install passed with 72 packages; `npm ls --depth=0` confirmed all six direct dependencies. The installation used a temporary project-local cache and explicit online mode because the sandbox defaults to offline npm access.
- Eight read-only public quote checks passed after the Nearly readiness fix earlier on this date. These were not rerun for the package-manager migration; the command is now `npm run check:public`:
  - NEARLY → wNEAR (DCL)
  - RICH → NEARLY (DCL)
  - ILLIA → wNEAR, including 1% sell tax (DCL)
  - RHEACAT → RHEA (DCL)
  - ZECAT → ZEC (DCL)
  - JENSEN → NVDAon (DCL)
  - UCAT → NEAR (Umbra curve)
  - UMBRA → LiNEAR (graduated Rhea simple pool; registration plan identified)
- Public FastNEAR FT discovery returned 123 contracts for the public example account in the latest check.
- A historical public UCAT sell's FINAL receipts were classified correctly, including exact NEAR payout. Its public fixture is in `test/fixtures/public-ucat-sell.json`; original transaction: [NearBlocks](https://nearblocks.io/txns/31JNFg7mme8VtiRXUpns93ajkcTrTqPwfxqP6jZDaZoR).
- Telegram command/review/activation and interactive target forms tested with a mock transport. Thirteen interface tests cover dashboard message reuse, wallet/token selection, the four-step form, Back and invalid-input recovery, stale/expired buttons, wallet changes, mode isolation, activation/pause/resume/cancel controls, pagination, settings, HTML escaping, manual token tracking, command-menu setup and edit-message fallback. Trade notifications retain plain-text formatting. All cryptographic signing tests use generated synthetic keys.

## Not yet exercised

- A real Telegram bot connection: the owner must create/provide their own BotFather token through `npm run setup`.
- Import of the owner's real wallet: use the local importer, not chat.
- An actual mainnet sell or storage deposit. No real wallet key was loaded and no transaction was broadcast during development.
- Live receipt verification of every supported token implementation. Contracts and public API schemas can change; unknown responses stop the relevant action.

Read-only quotes validate current route availability and transaction arguments, not future execution or profitability. See `README.md` for scope, fee/registration behavior, custody and recovery.
