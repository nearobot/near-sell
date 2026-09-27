# NEAR Target Telegram Bot

Personal Telegram bot built with **TypeScript (strict)** and **pnpm** for NEAR mainnet: import wallets locally, discover fungible tokens, view indicative USD balances, and set automatic sell targets for Nearly and Umbra tokens. Sell proceeds stay in the token's paired asset, as requested.

## প্রথমবার চালু করা

Node.js **24+** এবং pnpm **10** লাগবে। Project folder: `N:\Codex\near-sell-bot`। অন্য PC-তে কপি করলে প্রথমে ওই folder-এ `pnpm install --frozen-lockfile --ignore-scripts` চালাও।

1. Telegram-এ **@BotFather → /newbot** দিয়ে নিজের bot তৈরি করো। Project-এর `.env`-এ `TELEGRAM_BOT_TOKEN` বসাও; `.env` না থাকলে `.env.example` কপি করে নাম দাও `.env`।
2. **`pnpm run setup`** চালাও। Terminal-এ দেখানো `/pair ...` message নিজের bot-এর private chat-এ পাঠাও। তারপর একটি vault password দাও। `.env`-এ token ফাঁকা রাখলে terminal-এ সেটি চাইবে।
3. **`pnpm run import`** চালিয়ে password, seed/private key এবং NEAR wallet address দাও। Address ফাঁকা রাখলে public key দিয়ে account খুঁজবে। একাধিক wallet import করা যায়।
4. **`pnpm dev`** অথবা **`pnpm start`** চালিয়ে Telegram-এ `/start` দাও। Default `.env`-এ `BOT_MODE=paper` আছে। **Wallets → Portfolio → token → target** দিয়ে flow পরীক্ষা করো। **pnpm dev --paper** সবসময় paper mode-এ চালায়।
5. বাস্তব auto-sell চালাতে paper window-তে Ctrl+C দিয়ে বন্ধ করে **pnpm start:live** চালাও। তারপর Telegram-এ নতুন **LIVE target** বানিয়ে **Activate LIVE auto-sell** চাপো। Paper target কখনো নিজে থেকে live হবে না।

এই PC এবং bot-এর window চালু থাকতে হবে। Window বন্ধ/PC sleep/off হলে নতুন target monitor বা sell হবে না। Private key Telegram দিয়ে import করা হয় না; এই PC-র encrypted vault দিয়ে import হয়।

## Environment and run commands

Both commands automatically read the project-root `.env`, including when the CLI is launched from another directory. Existing process environment variables override `.env` values. Restart the bot after changing configuration.

```dotenv
TELEGRAM_BOT_TOKEN=
BOT_MODE=paper
POLL_INTERVAL_MS=10000
FASTNEAR_API_KEY=
NEAR_RPC_URLS=
VAULT_PASSWORD=
```

| Variable | Behavior |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather token used during setup. After pairing, leave blank or use the same token; changing it cannot silently switch the paired bot. |
| `BOT_MODE` | `paper` (default) or `live`. Live mode executes only activated live targets. `--paper` / `--live` overrides this value. |
| `POLL_INTERVAL_MS` | Delay between monitor cycles; integer from 1000 to 300000. Default 10000. |
| `FASTNEAR_API_KEY` | Optional setup/runtime key. Blank uses the saved vault key, or public endpoints if none is saved. |
| `NEAR_RPC_URLS` | Optional comma-separated HTTPS NEAR mainnet RPC URLs. Blank uses built-in FastNEAR endpoints. |
| `VAULT_PASSWORD` | Optional setup/unlock passphrase. Blank prompts locally. A value here is stored as plaintext in `.env`; quote values containing `#` or surrounding spaces. |

Seed phrases and private keys are imported with `pnpm run import` and saved in the encrypted vault. `.env` is ignored by Git; `.env.example` is the shareable blank template. Bot token and API key values placed in `.env` also remain plaintext there; setup saves an encrypted copy in the vault.

After the one-time setup/import, run either command:

```powershell
pnpm dev    # Run TypeScript source using BOT_MODE
pnpm start  # Build, then run compiled JavaScript using BOT_MODE
```

Run one at a time. To force a mode, use `pnpm dev --paper`, `pnpm start --paper`, `pnpm dev:live` or `pnpm start:live`.

## Targets

Two trigger types are implemented:

- **Market cap:** token price × the launchpad's supply convention (FDV). Nearly uses original launch supply, matching its board; Umbra uses `ft_total_supply`.
- **My token holdings:** current wallet balance of the selected token × indicative USD price. This is the value of **all your holdings in that token**, independent of the portion you plan to sell. It is not the combined value of every coin in the wallet.

Each can trigger at or above the target, or at or below it. Specify a percentage of the **balance at execution time**, or an exact token quantity. Percentages on separate targets are recalculated after earlier sells: selling 25%, then 25%, sells 43.75% of the original holdings. Use fixed quantities when you want allocations based on the original balance.

Examples, after selecting a wallet:

```text
/target ucat.umbrafun.near mc above 100000 25%
/target ucat.umbrafun.near value above 500 1000
/target nearly-993927.nearlytrade.near value below 200 50%
```

The bot shows a review with wallet, token contract, trigger, quantity, current estimate, payout asset, slippage and execution mode. Activation is required. A target already met may execute immediately. Targets execute once and expire after 30 days; activation drafts expire after 15 minutes.

The monitor waits 10 seconds between cycles by default (`POLL_INTERVAL_MS`); RPC and Telegram latency add to that interval. These are monitored triggers, not exchange-resident limit orders. The target value is not a guaranteed fill price. On-chain minimum-output checks enforce the configured slippage against the fresh sell quote, subject to each token's contract behavior. Quotes include the supported pool fees and Nearly input-token sell tax. The price-impact cap includes these costs.

Default slippage: **2%**. Default maximum impact: **15%**. `/slippage 1` and `/impact 10` change defaults for future targets only. Rules wait when quotes, USD prices, balance, gas, graduation state or price impact cannot be verified. The bot rechecks the trigger and balance before signing.

## Pair settlement and supported tokens

| Asset | Discovery/value | Sell path |
|---|---|---|
| Nearly launches | FastNEAR + final on-chain balance/pool reads | Token → its quote asset through Rhea DCL; sell tax accounted for |
| Umbra before graduation | Standard NEP-141 balance + final curve state | Token contract `sell`, paying NEAR or its stock pair |
| Umbra after graduation | Final migration and Rhea pool state | Token → actual paired asset through the graduated simple pool |
| Other NEAR fungible tokens | Indexed discovery, verified balances; USD if listed by Rhea | Displayed; automated sells are not enabled for unrelated contracts |
| Native NEAR | Balance/value | Kept for gas; no native-NEAR sell rule |

For example, a Nearly NEAR pair pays **wNEAR**; a NEARLY pair pays **NEARLY**. An Umbra NEAR curve pays **NEAR** and, after graduation into a LiNEAR pool, pays **LiNEAR**. The bot does not convert these proceeds to USD or automatically unwrap wNEAR. Targets explicitly authorize the current verified pair at execution, including a graduation-related change.

If output-token storage registration is needed, a separate journaled transaction registers **your own account**, capped at **0.01 NEAR per pair asset per target**, plus gas. The activation review discloses this. The trigger is rechecked after registration. Registrations above the cap require using the wallet/launchpad first. Every sell leaves a 0.02 NEAR reserve beyond account storage, with a conservative gas allowance.

“All tokens” means indexed NEAR fungible-token contracts. Newly created contracts can lag in the indexer: `/track full.contract.near` adds one immediately. NFTs, balances on other chains, NEAR Intents internal multi-token balances, LP positions and staked validator positions are outside this version. Unpriced tokens remain visible as **unpriced**, not zero. Discovery failure clearly marks the portfolio incomplete.

USD conversions come from Rhea's public price API, refreshed every 20 seconds. That API does not supply a per-price freshness timestamp; these are indicative prices, not an independently validated oracle. On-chain snapshots are read at one final block, with stale blocks rejected. The totals exclude unpriced balances and represent spot valuation, not the cash available from selling the whole wallet.

## Commands

| Command | Purpose |
|---|---|
| `/start`, `/help` | Menu and mode |
| `/wallets` | Select imported or watched wallet |
| `/watch account.near` | Watch-only public account |
| `/portfolio` | Detect tokens and refresh balances/values |
| `/track token.contract.near` | Manually add an unindexed FT |
| `/target CONTRACT mc\|value above\|below USD 25%\|1000` | Create a reviewable target |
| `/targets` | Status and pause/cancel buttons |
| `/pause`, `/resume` | Global monitor pause/resume |
| `/pause ID`, `/resume ID`, `/cancel ID` | Manage a single target |
| `/history`, `/reconcile` | Final results and pending transaction checks |
| `/slippage 2`, `/impact 15` | Defaults for future targets |
| `/abort` | Cancel an unfinished input form |

## Key custody and persistence

- Only the paired Telegram user, in that user's private chat, can control the bot. Group chats, other users, and forwarded callback contexts are rejected.
- The importer supports valid BIP39 English phrases and NEAR `ed25519:` private keys. Default derivation path: `m/44'/397'/0'`; custom hardened paths are supported. It verifies full-access permission against the chosen account before saving.
- `data/vault.json` uses AES-256-GCM with scrypt (`N=131072, r=8, p=1`) and a random salt/nonce. It contains bot credentials and derived private keys. Seed phrases themselves are not saved. The password is requested locally at startup unless you supply `VAULT_PASSWORD` in the environment. JavaScript cannot promise immediate secret-memory zeroization.
- Keys never go to Telegram, RPCs, indexers, history, exports or logs. Public wallet addresses go to FastNEAR/NEAR RPCs; balances and target details go to your private Telegram bot chat. Only signed transactions are broadcast.
- `data/bot.sqlite` stores public wallet IDs, targets, update offsets, execution history, signed transaction bytes and hashes. WAL/FULL synchronization commits the exact signed payload **before** broadcast. Network submission has no automatic retry or re-signing.
- Unknown outcomes block further orders on that wallet and are checked by transaction hash. A zero-consumption FT refund is not marked filled. A final failed receipt or unverifiable payout requires review. After inspecting its final receipts, stop the bot and run **pnpm review** to acknowledge it locally and cancel that target. This never repeats a trade.
- An exclusive SQLite lock prevents two instances/importers using the same data directory at once. Keep the entire `data` folder backed up while the bot is stopped. Do not delete history or lock databases to bypass pending-state protection.
- This is a single-owner local bot, not a hosted multi-user custody service. No vault, bot token or actual wallet has been configured during development.

## Development and validation

Node.js **24+**, pnpm **10.18.3**, TypeScript **5.9.3**. Dependencies are pinned in `pnpm-lock.yaml`; the package manager version is recorded in `package.json`.

```powershell
cd N:\Codex\near-sell-bot
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

`pnpm check` runs strict type checking for source, scripts and tests, builds to `dist/`, then runs all offline tests. Source imports use `.ts`; the compiler rewrites them to `.js` for the production build. Node 24 runs development TypeScript directly with native type stripping; `pnpm typecheck` performs the separate type check.

| Command | Purpose |
|---|---|
| `pnpm run setup` | Pair your Telegram bot and create the encrypted vault |
| `pnpm run import` | Import a wallet through hidden local prompts |
| `pnpm dev` | Run TypeScript source using `.env` mode (default paper) |
| `pnpm dev:live` | Run TypeScript source in live mode |
| `pnpm build` | Compile production JavaScript into `dist/` |
| `pnpm start` | Build and run compiled JavaScript using `.env` mode (default paper) |
| `pnpm start:live` | Build and run compiled JavaScript in live mode |
| `pnpm review` | Review a final unresolved execution locally |
| `pnpm typecheck` | Check all TypeScript without emitting files |
| `pnpm test` | Run offline tests against TypeScript source |
| `pnpm check:public` | Read-only public discovery and quote checks |

`pnpm start` and `pnpm start:live` build automatically and stop if compilation fails. Both source and compiled entry points use the same project-root `.env` and `data/` directory.

Use the full `pnpm run setup` and `pnpm run import` commands: `setup` and `import` also name built-in pnpm commands.

Offline tests exercise authorization, seed/key validation, encrypted-vault tamper rejection, exact integer amounts, target semantics, real SDK signing with synthetic keys, slippage/tax, gas checks, storage caps, persistence/restart behavior, duplicate prevention, refunds and payout verification.

The read-only public check obtains quotes for eight public tokens across Nearly NEAR/NEARLY/RHEA/ZEC/stock pairs and Umbra curve/graduated pools. It loads **no keys** and contains **no transaction submission**. Actual mainnet sells and a connected Telegram session still need user-side configuration and live acceptance testing; passing a read-only quote test is not proof of an actual fill.

Implementation references verified on 2026-09-27:

- [Nearly documentation](https://nearly.trade/docs), its deployed public client and `nearlytrade.near` factory views.
- [Umbra](https://umbrapad.app/), its deployed public client, and public `get_curve_state` / `get_pool` responses.
- [NEAR RPC](https://docs.near.org/api/rpc/contracts) and [transaction RPC](https://docs.near.org/api/rpc/transactions).
- [FastNEAR account/FT API](https://github.com/fastnear/fastnear-api-server-rs).
- [Rhea/Ref SDK](https://github.com/ref-finance/ref-sdk) for DCL and simple-pool transaction shapes.
- [Telegram Bot API](https://core.telegram.org/bots/api).
