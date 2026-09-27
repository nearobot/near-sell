import type { FetchLike, InlineButton, InlineKeyboard, TelegramMethods, TelegramPort, TelegramUpdate, Target, TargetInput, Metric, Direction, Portfolio } from './types.ts';
import type { Store } from './store.ts';
import type { Market } from './market.ts';
import type { Engine } from './engine.ts';
import crypto from 'node:crypto';
import { AppError, assert, accountId, decimal, parseQuantity, money, human, compact, measure, safeError } from './core.ts';
import { jsonRequest } from './network.ts';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
const button = (text: string, callback_data: string): InlineButton => ({ text, callback_data });
const keyboard = (rows: InlineButton[][]): InlineKeyboard => ({ inline_keyboard: rows });
const menu = keyboard([[button('💼 Wallets', 'wallets'), button('📊 Portfolio', 'portfolio:0')], [button('🎯 New target', 'newtarget'), button('📋 Targets', 'targets')], [button('⏸ Pause all', 'pause'), button('▶ Resume all', 'resume')], [button('🧾 History', 'history'), button('↻ Check pending', 'reconcile')]]);

export class Telegram implements TelegramPort {
  token: string; fetchImpl: FetchLike;
  constructor(token: string, fetchImpl: FetchLike = fetch) { assert(/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token), 'Invalid Telegram bot token.'); this.token = token; this.fetchImpl = fetchImpl; }
  async call<K extends keyof TelegramMethods>(method: K, body: Record<string, unknown> = {}): Promise<TelegramMethods[K]> {
    const r = await jsonRequest<{ok: boolean; result: TelegramMethods[K]}>(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { timeout: method === 'getUpdates' ? 40000 : 12000, fetchImpl: this.fetchImpl });
    assert(r.ok, 'Telegram rejected the request. Check bot configuration or retry.', 'TELEGRAM'); return r.result;
  }
  send(chat: string, text: string, reply_markup?: InlineKeyboard) { return this.call('sendMessage', { chat_id: chat, text: String(text).slice(0, 4000), ...(reply_markup ? { reply_markup } : {}), link_preview_options: { is_disabled: true } }); }
}
export function authorized(update: TelegramUpdate, owner: string | number) {
  const m = update.message || update.callback_query?.message;
  const from = update.message?.from || update.callback_query?.from;
  return m?.chat?.type === 'private' && String(m.chat.id) === String(owner) && String(from?.id) === String(owner) && !from?.is_bot;
}
export function targetText(t: Target) {
  return `${t.id} · ${t.status.toUpperCase()} · ${t.mode.toUpperCase()}\n${t.token}\nWallet: ${t.account}\n${t.metric === 'marketcap' ? 'Market cap (launchpad FDV)' : 'Value of ALL your holdings in this token'} ${t.direction === 'gte' ? '≥' : '≤'} ${money(t.threshold)}\nSell: ${t.quantity.value}${t.quantity.kind === 'percent' ? '% of balance at execution' : ' tokens'}\nSlippage: ${t.slippageBps / 100}% · Max price impact: ${t.maxImpactBps / 100}%\nPayout: current verified pair asset\n${t.lastError ? 'Waiting: ' + t.lastError + '\n' : ''}`;
}
export interface BotDependencies {
 telegram: TelegramPort; owner: string | number; store: Store;
 market: Pick<Market, 'portfolio' | 'metadata' | 'rpc'>;
 engine: Pick<Engine, 'mode' | 'executor' | 'create' | 'arm' | 'reconcile'>;
}
interface Flow { account: string; token?: string; metric?: Metric; direction?: Direction; threshold?: string; step: 'token' | 'metric' | 'direction' | 'threshold' | 'quantity' }
export class Bot {
 telegram: TelegramPort; owner: string; store: Store; market: BotDependencies['market']; engine: BotDependencies['engine'];
 flow: Flow | null; pages: Map<string, Portfolio>; stopping: boolean;
  constructor({ telegram, owner, store, market, engine }: BotDependencies) { this.telegram = telegram; this.owner = String(owner); this.store = store; this.market = market; this.engine = engine; this.flow = null; this.pages = new Map(); this.stopping = false; }
  send(text: string, markup?: InlineKeyboard) { return this.telegram.send(this.owner, text, markup); }
  wallet() { const a = this.store.setting('selectedWallet'); assert(a && this.store.wallets().includes(a), 'Use /wallets to select a wallet first.'); return a; }
  async home() {
    return this.send(`NEAR Target Bot · ${this.engine.mode.toUpperCase()}\n${this.engine.mode === 'paper' ? 'Paper mode: no signing or transactions.' : 'Live mode: activated targets can automatically sell your tokens.'}\n${this.store.setting('paused', false) ? 'All targets paused.' : 'Target monitor running.'}\n\nUse Portfolio to choose a token and set a target. Keys are imported locally with pnpm run import.\n\n/start · /wallets · /portfolio · /targets · /history\n/watch account.near\n/track token.contract.near\n/target CONTRACT mc|value above|below USD 25%|1000\n/pause [target-id] · /resume [target-id] · /cancel target-id\n/slippage 2 · /impact 15 · /reconcile\n/abort cancels an unfinished form.`, menu);
  }
  async wallets() {
    const wallets = this.store.wallets();
    return this.send(wallets.length ? 'Select a wallet. 🔑 = key loaded, 👁 = watch only.' : 'No wallets yet. Import locally with pnpm run import, or use /watch account.near.', keyboard(wallets.map(a => [button(`${this.engine.executor.hasKey(a) ? '🔑' : '👁'} ${a}`, 'wallet:' + hash(a))])));
  }
  async portfolio(page = 0, refresh = false) {
    const account = this.wallet(); let p = this.pages.get(account);
    if (refresh || !p || Date.now() - p.at > 30000) { await this.send('Reading your tokens and prices…'); p = await this.market.portfolio(account, this.store.tracked(account)); this.pages.set(account, p); }
    const pageSize = 6, last = Math.max(0, Math.ceil(p.tokens.length / pageSize) - 1); page = Math.min(Math.max(page, 0), last);
    const rows = p.tokens.slice(page * pageSize, (page + 1) * pageSize);
    let text = `${account}\nPriced holdings: ${money(p.totalUsd)}${p.unpriced ? ` + ${p.unpriced} unpriced/unverified asset(s)` : ''}\n${p.tokens.length} nonzero or unverified balances · Page ${page + 1}/${last + 1}\n`;
    if (p.warning) text += p.warning + '\n';
    for (const t of rows) text += `\n${t.symbol}\n${t.balanceRaw == null ? 'Balance unavailable' : compact(human(t.balanceRaw, t.decimals))} · ${money(t.valueUsd)}\n${t.token}\n${t.route ? `Sell into ${t.route.outSymbol}` : t.warning || (t.token === 'native.near' ? 'Native gas balance' : 'No supported sell route')}\n`;
    text += '\nUSD values are indicative (spot price × balance), not guaranteed sell proceeds.';
    const buttons = rows.filter(t => t.route).map(t => [button('🎯 ' + t.symbol, `token:${hash(account)}:${hash(t.token)}`)]);
    buttons.push([button('‹ Previous', `portfolio:${Math.max(0, page-1)}`), button('Refresh', 'refresh'), button('Next ›', `portfolio:${Math.min(last, page+1)}`)]);
    return this.send(text, keyboard(buttons));
  }
  async beginToken(token: string) {
    accountId(token); this.flow = { account: this.wallet(), token, step: 'metric' };
    return this.send(`Target for ${token}\nChoose what triggers the sell.`, keyboard([[button('Market cap ($)', 'form:marketcap'), button('My token holdings ($)', 'form:holding')]]));
  }
  async preview(input: Omit<TargetInput, 'slippageBps' | 'maxImpactBps'> & Partial<Pick<TargetInput, 'slippageBps' | 'maxImpactBps'>> ) {
    await this.send('Checking your balance, the pair asset and a current sell quote…');
    const defaults = { slippageBps: this.store.setting('slippageBps', 200), maxImpactBps: this.store.setting('maxImpactBps', 1500) };
    const { target: t, snapshot, plan, alreadyReached } = await this.engine.create({ ...defaults, ...input });
    this.flow = null;
    return this.send(`${targetText(t)}\nCurrent trigger value: ${money(measure(t, snapshot))}\nCurrent sell estimate: ${compact(human(plan.amount, plan.decimals))} ${plan.symbol} → ${compact(human(plan.expectedOut, plan.outDecimals))} ${plan.outSymbol}\nPayout contract: ${plan.output}\n${alreadyReached ? '⚠ Target is already met: activating may execute immediately.\n' : ''}Percentages use the balance when the rule executes. Each target executes once; expires in 30 days. Graduation can change the pool and its pair asset. If needed, the bot first registers your wallet on that asset (up to 0.01 NEAR storage deposit, plus gas).\n\n${t.mode === 'live' ? 'Activating authorizes this automatic sell and any required registration while the bot runs.' : 'This is a paper target. No real trade will occur.'}`, keyboard([[button(t.mode === 'live' ? 'Activate LIVE auto-sell' : 'Activate PAPER target', 'arm:' + t.id)], [button('Discard', 'cancel:' + t.id)]]));
  }
  async targets() {
    const targets = this.store.targets().slice(0, 20);
    if (!targets.length) return this.send('No targets. Select a token from /portfolio.');
    for (let start = 0; start < targets.length; start += 4) {
      const chunk = targets.slice(start, start + 4);
      await this.send(chunk.map(targetText).join('\n'), keyboard(chunk.filter(t => ['active', 'paused', 'draft'].includes(t.status)).map(t => [button(`${t.status === 'paused' ? 'Resume' : 'Pause'} ${t.id}`, `${t.status === 'paused' ? 'resumeTarget' : 'pauseTarget'}:${t.id}`), button('Cancel', 'cancel:' + t.id)])));
    }
  }
  async history() {
    const items = this.store.executions().slice(0, 10);
    return this.send(items.length ? items.map(e => `${e.targetId}: ${e.status}\n${e.plan.symbol} → ${e.plan.outSymbol}\n${e.hash ? 'https://nearblocks.io/txns/' + e.hash : 'No transaction signed.'}\n${e.reason || ''}`).join('\n\n') : 'No executions yet.');
  }
  async cancel(id: string) { this.store.change(id, ['draft', 'active', 'paused'], { status: 'cancelled' }); return this.send(`Target ${id} cancelled.`); }
  async pause(id?: string) {
    if (id) this.store.change(id, ['active'], { status: 'paused' }); else this.store.set('paused', true);
    return this.send(id ? `Target ${id} paused.` : 'All targets paused. An already submitted transaction may still finish.');
  }
  async resume(id?: string) {
    if (id) {
      const t = this.store.target(id); assert(t && t.mode === this.engine.mode && Date.now() < t.expiresAt, 'Target mode or expiry prevents resuming.');
      assert(!this.store.pending(t.account), 'Resolve the wallet’s pending transaction first.');
      this.store.change(id, ['paused'], { status: 'active', lastError: null });
    } else this.store.set('paused', false);
    return this.send(id ? `Target ${id} resumed.` : 'Global pause removed. Individually paused targets remain paused.');
  }
  async callback(data: string) {
    const [action, value, extra] = data.split(':');
    if (action === 'wallets') return this.wallets();
    if (action === 'wallet') {
      const account = this.store.wallets().find(a => hash(a) === value); assert(account, 'Wallet selection expired.');
      this.store.set('selectedWallet', account); this.flow = null; return this.portfolio(0, true);
    }
    if (action === 'portfolio') return this.portfolio(Number(value) || 0);
    if (action === 'refresh') return this.portfolio(0, true);
    if (action === 'token') {
      const account = this.wallet(); assert(hash(account) === value, 'Select this wallet again before using the token button.');
      const token = this.pages.get(account)?.tokens.find(t => hash(t.token) === extra)?.token; assert(token, 'Refresh /portfolio to select this token.'); return this.beginToken(token);
    }
    if (action === 'newtarget') { this.flow = { account: this.wallet(), step: 'token' }; return this.send('Send the full token contract ID, e.g. ucat.umbrafun.near.'); }
    if (action === 'form') {
      assert(this.flow, 'This form expired. Use /portfolio again.');
      if (this.flow.step === 'metric' && (value === 'marketcap' || value === 'holding')) {
        this.flow.metric = value; this.flow.step = 'direction';
        return this.send('Trigger when the value rises to the target, or falls to it?', keyboard([[button('At or above', 'form:gte'), button('At or below', 'form:lte')]]));
      }
      if (this.flow.step === 'direction' && (value === 'gte' || value === 'lte')) { this.flow.direction = value; this.flow.step = 'threshold'; return this.send('Enter the target USD value, e.g. 100000 or 500.50.'); }
      throw new AppError('That button is from an earlier step. Continue the current form or /abort.');
    }
    if (action === 'arm') { this.engine.arm(value); return this.send(`Target ${value} activated in ${this.engine.mode.toUpperCase()} mode.${this.store.setting('paused', false) ? ' Global pause is still on; use /resume to run.' : ''}`); }
    if (action === 'cancel') return this.cancel(value);
    if (action === 'pauseTarget') return this.pause(value);
    if (action === 'resumeTarget') return this.resume(value);
    if (action === 'pause') return this.pause();
    if (action === 'resume') return this.resume();
    if (action === 'targets') return this.targets();
    if (action === 'history') return this.history();
    if (action === 'reconcile') { await this.engine.reconcile(); return this.history(); }
    throw new AppError('This button is no longer available. Use /start.');
  }
  async text(text: string) {
    assert(text.length <= 500, 'Message too long. Use the local importer for wallet secrets.');
    if (/ed25519:|\b(seed|mnemonic|private.?key)\b/i.test(text) || (!text.startsWith('/') && text.trim().split(/\s+/).length >= 12)) throw new AppError('Import wallet secrets only using pnpm run import on your PC. Do not send them to Telegram.');
    if (!text.startsWith('/') && this.flow) {
      if (this.flow.step === 'token') return this.beginToken(text.trim());
      if (this.flow.step === 'threshold') { this.flow.threshold = decimal(text.trim()).toFixed(); this.flow.step = 'quantity'; return this.send('How much to sell? Send a percentage (25%, 50%, 100%) or an exact token quantity (1000).'); }
      if (this.flow.step === 'quantity') { const quantity = parseQuantity(text.trim()); const { account, token, metric, direction, threshold } = this.flow; assert(token && metric && direction && threshold, 'This form expired. Start again.'); return this.preview({ account, token, metric, direction, threshold, quantity }); }
      return this.send('Choose one of the buttons in the current form, or /abort.');
    }
    const [rawCommand, ...args] = text.trim().split(/\s+/), command = rawCommand.split('@')[0].toLowerCase();
    if (['/start', '/help'].includes(command)) return this.home();
    if (command === '/abort') { this.flow = null; return this.send('Form cancelled. Existing targets are unchanged.'); }
    if (command === '/wallets') return this.wallets();
    if (command === '/portfolio') return this.portfolio(0, true);
    if (command === '/watch') { const account = accountId(args[0]); await this.market.rpc.query({ request_type: 'view_account', account_id: account }); this.store.addWallet(account); this.store.set('selectedWallet', account); this.flow = null; return this.portfolio(0, true); }
    if (command === '/track') { const token = accountId(args[0]); await this.market.metadata(token); this.store.track(this.wallet(), token); return this.portfolio(0, true); }
    if (command === '/target') {
      assert(args.length === 5, 'Usage: /target CONTRACT mc|value above|below USD 25%|1000');
      assert(['mc', 'value'].includes(args[1]) && ['above', 'below'].includes(args[2]), 'Use mc/value and above/below.');
      return this.preview({ account: this.wallet(), token: accountId(args[0]), metric: args[1] === 'mc' ? 'marketcap' : 'holding', direction: args[2] === 'above' ? 'gte' : 'lte', threshold: decimal(args[3]).toFixed(), quantity: parseQuantity(args[4]) });
    }
    if (command === '/targets') return this.targets();
    if (command === '/history') return this.history();
    if (command === '/pause') return this.pause(args[0]);
    if (command === '/resume') return this.resume(args[0]);
    if (command === '/cancel') return this.cancel(args[0]);
    if (command === '/reconcile') { await this.engine.reconcile(); return this.history(); }
    if (['/slippage', '/impact'].includes(command)) {
      const value = decimal(args[0]).mul(100); assert(value.isInteger(), 'Use at most two decimal places.');
      const bps = value.toNumber(), isSlip = command === '/slippage';
      assert(bps >= (isSlip ? 10 : 100) && bps <= (isSlip ? 1000 : 5000), isSlip ? 'Slippage must be 0.1%–10%.' : 'Maximum impact must be 1%–50%.');
      this.store.set(isSlip ? 'slippageBps' : 'maxImpactBps', bps); return this.send(`New targets will use ${args[0]}% ${isSlip ? 'slippage' : 'maximum price impact'}. Existing targets keep their settings.`);
    }
    return this.send('Use /start for controls.');
  }
  async handle(update: TelegramUpdate) {
    if (!authorized(update, this.owner)) return;
    try {
      if (update.callback_query) {
        await this.telegram.call('answerCallbackQuery', { callback_query_id: update.callback_query.id }).catch(() => {});
        return await this.callback(update.callback_query.data || '');
      }
      if (typeof update.message?.text === 'string') return await this.text(update.message.text);
    } catch(e) { return this.send(safeError(e)); }
  }
  async run() {
    while (!this.stopping) {
      try {
        const offset = this.store.setting('telegramOffset', 0);
        const updates = await this.telegram.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          // Persist receipt first: a crash can lose a command, but cannot replay a financial command.
          assert(typeof u.update_id === 'number', 'Invalid Telegram update.');
          this.store.set('telegramOffset', u.update_id + 1);
          await this.handle(u);
        }
      } catch { await new Promise(resolve => setTimeout(resolve, 5000)); }
    }
  }
}
