import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import * as near from 'near-api-js';
import { AppError, assert, accountId, safeError } from './core.ts';
import { loadVault, saveVault, deriveWallet, verifyKey } from './vault.ts';
import { Rpc, jsonRequest } from './network.ts';
import { Market } from './market.ts';
import { Store, acquireProcessLock } from './store.ts';
import { Executor } from './executor.ts';
import { Engine } from './engine.ts';
import { Telegram, Bot } from './telegram.ts';
import { loadConfig, projectRoot } from './config.ts';
import type { Config } from './config.ts';

const dataDir = path.join(projectRoot, 'data'), vaultPath = path.join(dataDir, 'vault.json');
fs.mkdirSync(dataDir, { recursive: true });
async function ask(label: string, hidden = false): Promise<string> {
  assert(process.stdin.isTTY, 'Run this command in an interactive terminal. Secret command-line arguments are not accepted.');
  if (!hidden) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(label, answer => { rl.close(); resolve(answer.trim()); }));
  }
  return new Promise((resolve, reject) => {
    let answer = '';
    process.stdout.write(label); readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    const finish = () => { process.stdin.off('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onKey = (text: string, key: Partial<readline.Key> = {}) => {
      if (key.ctrl && key.name === 'c') { finish(); reject(new AppError('Cancelled.')); return; }
      if (key.name === 'return' || key.name === 'enter') { finish(); resolve(answer); return; }
      if (key.name === 'backspace') { answer = answer.slice(0, -1); return; }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) answer += text;
    };
    process.stdin.on('keypress', onKey);
  });
}
function acquireLock() {
  return acquireProcessLock(path.join(dataDir, 'process.sqlite'));
}
async function pair(telegram: Telegram) {
  const me = await telegram.call('getMe'), webhook = await telegram.call('getWebhookInfo');
  assert(!webhook.url, 'This bot already uses a webhook. Use a dedicated Telegram bot token for this app.');
  const code = crypto.randomBytes(16).toString('hex');
  console.log(`Open https://t.me/${me.username} and send this in its private chat:\n/pair ${code}\nPairing expires in 5 minutes.`);
  const expires = Date.now() + 5 * 60000; let offset = 0;
  while (Date.now() < expires) {
    const updates = await telegram.call('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] });
    for (const u of updates) {
      assert(typeof u.update_id === 'number', 'Invalid Telegram update.');
      offset = u.update_id + 1; const m = u.message;
      if (m?.chat?.type === 'private' && !m.from?.is_bot && m.chat.id === m.from?.id && m.text === '/pair ' + code) {
        return { owner: String(m.from.id), offset, username: me.username };
      }
    }
  }
  throw new AppError('Pairing expired. Run setup again.');
}
async function setup(config: Config) {
  assert(!fs.existsSync(vaultPath), 'A vault already exists. Use import or start; setup never overwrites it.');
  console.log('Create a dedicated bot with @BotFather using /newbot. Set TELEGRAM_BOT_TOKEN in .env or enter it when prompted.\nSetup saves credentials in the encrypted vault.');
  const token = config.telegramToken ?? await ask('Telegram bot token (hidden): ', true);
  const telegram = new Telegram(token); const identity = await pair(telegram);
  const apiKey = config.fastnearApiKey ?? await ask('FastNEAR API key, or Enter for public endpoints (hidden): ', true);
  const password = config.vaultPassword ?? await ask('New vault passphrase, at least 12 characters (hidden): ', true);
  assert(password.length >= 12, 'Passphrase is too short.');
  if (!config.vaultPassword) assert(password === await ask('Repeat passphrase (hidden): ', true), 'Passphrases do not match.');
  saveVault(vaultPath, { token, owner: identity.owner, fastnearApiKey: apiKey, wallets: [] }, password);
  const store = new Store(path.join(dataDir, 'bot.sqlite')); store.set('telegramOffset', identity.offset); store.close();
  console.log(`Setup saved. Owner: ${identity.owner}. Bot: https://t.me/${identity.username}\nNext: run pnpm run import, then pnpm dev --paper.`);
}
async function unlock(config: Config) {
  assert(fs.existsSync(vaultPath), 'Run pnpm run setup first.');
  const password = config.vaultPassword ?? await ask('Vault passphrase (hidden): ', true);
  return { password, vault: loadVault(vaultPath, password) };
}
async function importWallet(config: Config) {
  const { password, vault } = await unlock(config);
  const apiKey = config.fastnearApiKey ?? vault.fastnearApiKey;
  const rpc = new Rpc({ apiKey, urls: config.rpcUrls });
  console.log('NEAR mainnet only. The seed/private key is read locally and is never sent to Telegram.');
  const secret = await ask('Seed phrase or ed25519: private key (hidden): ', true);
  const hd = await ask("Derivation path [m/44'/397'/0']: ") || "m/44'/397'/0'";
  const key = deriveWallet(secret, hd), pub = key.getPublicKey().toString();
  let account = await ask('NEAR account ID (Enter to discover from public key): ');
  if (!account) {
    const headers = apiKey ? { authorization: 'Bearer ' + apiKey } : {};
    const result = await jsonRequest<{account_ids?: unknown[]}>(`https://api.fastnear.com/v0/public_key/${encodeURIComponent(pub)}`, { headers });
    const candidates = (result.account_ids || []).filter((a): a is string => typeof a === 'string');
    assert(candidates.length > 0, 'No account found. Retry and enter your NEAR account ID explicitly.');
    if (candidates.length === 1) account = candidates[0];
    else { console.log('Accounts for this public key:\n' + candidates.join('\n')); account = await ask('Choose the exact account ID: '); assert(candidates.includes(account), 'Choose one of the listed accounts.'); }
  }
  accountId(account); await verifyKey(rpc, account, key);
  assert(!vault.wallets.some(w => w.account === account), 'That wallet is already imported.');
  vault.wallets.push({ account, publicKey: pub, secretKey: key.toString(), hd });
  saveVault(vaultPath, vault, password);
  const store = new Store(path.join(dataDir, 'bot.sqlite')); store.addWallet(account); store.set('selectedWallet', account); store.close();
  console.log(`Imported and verified ${account}. The seed phrase itself was not saved.\nRestart the bot to load the key.`);
}
async function start(config: Config) {
  const { vault } = await unlock(config), live = config.mode === 'live';
  assert(!config.telegramToken || config.telegramToken === vault.token, 'TELEGRAM_BOT_TOKEN differs from the paired vault. Use the original bot token or leave it blank.', 'CONFIG');
  if (live) console.log('LIVE MODE. Only live targets explicitly activated in your private bot chat may execute. Paper targets stay separate.');
  const apiKey = config.fastnearApiKey ?? vault.fastnearApiKey;
  const rpc = new Rpc({ apiKey, urls: config.rpcUrls });
  const keys = new Map(vault.wallets.map(w => [w.account, near.KeyPair.fromString(w.secretKey as `ed25519:${string}`)]));
  const store = new Store(path.join(dataDir, 'bot.sqlite')); store.recover();
  for (const w of vault.wallets) store.addWallet(w.account);
  const telegram = new Telegram(vault.token), market = new Market(rpc, { fastnearApiKey: apiKey });
  const webhook = await telegram.call('getWebhookInfo'); assert(!webhook.url, 'Bot uses a webhook. Choose a dedicated token.');
  const engine = new Engine({ store, market, executor: new Executor(rpc, keys), mode: live ? 'live' : 'paper', notify: text => telegram.send(vault.owner, text) });
  const bot = new Bot({ telegram, owner: vault.owner, store, market, engine });
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; bot.stopping = true; engine.stopping = true; console.log('\nStopping after current work. Pending transaction hashes remain saved.'); });
  process.once('SIGTERM', () => { stopping = true; bot.stopping = true; engine.stopping = true; });
  console.log(`Running ${engine.mode.toUpperCase()}. Keep this window and computer running. Ctrl+C stops the bot.`);
  await bot.home();
  const monitor = (async () => {
    while (!stopping) {
      try { await engine.tick(); } catch { console.error('Monitor could not complete this cycle. No transaction is retried automatically.'); }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
    }
  })();
  await bot.run(); stopping = true; await monitor; store.close(); keys.clear();
}
async function resolve(config: Config) {
  const { vault } = await unlock(config), rpc = new Rpc({ apiKey: config.fastnearApiKey ?? vault.fastnearApiKey, urls: config.rpcUrls });
  const store = new Store(path.join(dataDir, 'bot.sqlite'));
  try {
    const items = store.executions().filter(e => ['needs_review', 'pending', 'signed', 'uncertain'].includes(e.status));
    for (const e of items) console.log(`${e.id}: ${e.status} ${e.plan.symbol} → ${e.plan.outSymbol}\nhttps://nearblocks.io/txns/${e.hash}`);
    assert(items.length, 'No unresolved executions.');
    const id = await ask('Execution ID you reviewed: '), e = items.find(e => e.id === id); assert(e, 'Execution not found.');
    assert(e.hash, 'Execution has no transaction hash to review.');
    const result = await rpc.status(e.hash, e.account); assert(result.final_execution_status === 'FINAL', 'Transaction is not final. It cannot be cleared.');
    console.log('Check the final transaction and all receipts on NearBlocks. This cancels the target and unblocks the wallet; it never repeats the trade.');
    assert(await ask('Type the exact transaction hash to record your review: ') === e.hash, 'Hash did not match.');
    store.db.exec('BEGIN IMMEDIATE');
    try { store.updateExecution(id, { status: 'reviewed', reason: 'Owner reviewed final on-chain receipts locally.' }); store.change(e.targetId, ['executing', 'needs_review'], { status: 'cancelled', lastError: 'Final execution reviewed locally. Create a new target for any future sell.' }); store.db.exec('COMMIT'); }
    catch(e) { store.db.exec('ROLLBACK'); throw e; }
    console.log('Review saved; target cancelled.');
  } finally { store.close(); }
}
let release: (() => void) | undefined;
try {
  const command = process.argv[2];
  assert(['setup', 'import', 'start', 'resolve'].includes(command), 'Commands: setup | import | start [--paper | --live] | resolve');
  const config = loadConfig(projectRoot, process.env, process.argv.slice(3));
  release = acquireLock();
  if (command === 'setup') await setup(config);
  if (command === 'import') await importWallet(config);
  if (command === 'start') await start(config);
  if (command === 'resolve') await resolve(config);
} catch(e) { console.error(safeError(e)); process.exitCode = 1; }
finally { release?.(); }
