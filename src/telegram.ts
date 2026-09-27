import crypto from 'node:crypto';
import type { FetchLike, Holding, InlineButton, InlineKeyboard, MessageOptions, TelegramMethods, TelegramPort, TelegramUpdate, Target, TargetInput, Metric, Direction, Portfolio, Snapshot } from './types.ts';
import type { Store } from './store.ts';
import type { Market } from './market.ts';
import type { Engine } from './engine.ts';
import { AppError, assert, accountId, decimal, parseQuantity, money, human, compact, measure, safeError, tokenTitle } from './core.ts';
import { jsonRequest } from './network.ts';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
export const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const code = (value: string) => `<code>${escapeHtml(value)}</code>`;
const button = (text: string, callback_data: string): InlineButton => {
  assert(Buffer.byteLength(callback_data) <= 64, 'This button could not be created.');
  return { text, callback_data };
};
const keyboard = (rows: InlineButton[][]): InlineKeyboard => ({ inline_keyboard: rows });
const homeButton = () => button('⌂ Home', 'home');
const footer = (back?: InlineButton): InlineButton[] => back ? [back, homeButton()] : [homeButton()];
const short = (text: string, length = 24) => text.length > length ? text.slice(0, length - 1) + '…' : text;
const pageNumber = (value = '0') => /^\d{1,6}$/.test(value) ? Number(value) : 0;
const statusLabel: Record<string, string> = {
  draft: '📝 Ready to activate', active: '🟢 Watching', paused: '⏸ Paused', executing: '⏳ Processing',
  filled: '✅ Sold', simulated: '🧪 Simulated', cancelled: '✕ Cancelled', expired: '⌛ Expired',
  needs_review: '⚠ Needs review', refunded: '↩ Refunded', rejected: '⚠ Rejected',
  preparing: '⏳ Preparing', signed: '⏳ Signed', pending: '⏳ Pending', uncertain: '⚠ Checking',
  registered: '✅ Pair ready', reviewed: '✓ Reviewed',
};
const stateLabel = (status: string) => statusLabel[status] ?? status;
const formatQuantity = (t: Target) => `${t.quantity.value}${t.quantity.kind === 'percent' ? '% of balance at execution' : ' tokens'}`;

export class Telegram implements TelegramPort {
  token: string; fetchImpl: FetchLike;
  constructor(token: string, fetchImpl: FetchLike = fetch) {
    assert(/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token), 'Invalid Telegram bot token.');
    this.token = token; this.fetchImpl = fetchImpl;
  }
  async call<K extends keyof TelegramMethods>(method: K, body: Record<string, unknown> = {}): Promise<TelegramMethods[K]> {
    const r = await jsonRequest<{ok: boolean; result: TelegramMethods[K]}>(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, { timeout: method === 'getUpdates' ? 40000 : 12000, fetchImpl: this.fetchImpl });
    assert(r.ok, 'Telegram could not update this screen. Try again.', 'TELEGRAM'); return r.result;
  }
  send(chat: string, text: string, reply_markup?: InlineKeyboard, options: MessageOptions = {}) {
    assert(text.length <= 4000, 'This message is too long. Open a smaller page.');
    return this.call('sendMessage', { chat_id: chat, text, ...options, ...(reply_markup ? { reply_markup } : {}), link_preview_options: { is_disabled: true } });
  }
}

export function authorized(update: TelegramUpdate, owner: string | number) {
  const m = update.message || update.callback_query?.message;
  const from = update.message?.from || update.callback_query?.from;
  return m?.chat?.type === 'private' && String(m.chat.id) === String(owner) && String(from?.id) === String(owner) && !from?.is_bot;
}

export function targetText(t: Target) {
  return `<b>${escapeHtml(tokenTitle(t))}</b> · ${stateLabel(t.status)}\n${code(t.token)}\n\n` +
    `Trigger  ${t.metric === 'marketcap' ? 'Market cap (FDV)' : 'All my holdings in this token'}\n` +
    `${t.direction === 'gte' ? '↗ At or above' : '↘ At or below'} <b>${money(t.threshold)}</b>\n` +
    `Sell  <b>${escapeHtml(formatQuantity(t))}</b>\n\nWallet  ${code(t.account)}\n` +
    `Mode  <b>${t.mode.toUpperCase()}</b>\nSlippage  ${t.slippageBps / 100}% · Max impact  ${t.maxImpactBps / 100}%\n` +
    `Payout  Current paired asset\nID  ${code(t.id)}` +
    (t.lastError ? `\n\n⚠ ${escapeHtml(short(t.lastError, 320))}` : '');
}

export interface BotDependencies {
  telegram: TelegramPort; owner: string | number; store: Store;
  market: Pick<Market, 'portfolio' | 'metadata' | 'snapshot' | 'rpc'>;
  engine: Pick<Engine, 'mode' | 'executor' | 'create' | 'arm' | 'reconcile' | 'describeTarget'>;
}
type Step = 'metric' | 'direction' | 'threshold' | 'quantity';
interface TargetFlow {
  kind: 'target'; id: string; revision: number; expiresAt: number;
  account: string; token: string; symbol: string; snapshot: Snapshot; step: Step;
  metric?: Metric; direction?: Direction; threshold?: string;
}
interface InputFlow {
  kind: 'watch' | 'track' | 'slippage' | 'impact'; expiresAt: number; account?: string;
}
type Flow = TargetFlow | InputFlow;
type PreviewInput = Omit<TargetInput, 'slippageBps' | 'maxImpactBps'> & Partial<Pick<TargetInput, 'slippageBps' | 'maxImpactBps'>>;

export class Bot {
  telegram: TelegramPort; owner: string; store: Store; market: BotDependencies['market']; engine: BotDependencies['engine'];
  flow: Flow | null = null; pages = new Map<string, Portfolio>(); stopping = false;
  private panelId?: number;
  private lastScreen?: { id: number; signature: string };

  constructor({ telegram, owner, store, market, engine }: BotDependencies) {
    this.telegram = telegram; this.owner = String(owner); this.store = store; this.market = market; this.engine = engine;
  }

  // UI messages share one editable panel. Execution notifications use the normal transport separately.
  async send(text: string, markup: InlineKeyboard = keyboard([footer()])): Promise<unknown> {
    assert(text.length <= 4000, 'This screen is too long. Open a smaller page.');
    const signature = JSON.stringify([text, markup]);
    if (this.panelId != null) {
      if (this.lastScreen?.id === this.panelId && this.lastScreen.signature === signature) return;
      try {
        const result = await this.telegram.call('editMessageText', {
          chat_id: this.owner, message_id: this.panelId, text, parse_mode: 'HTML', reply_markup: markup,
          link_preview_options: { is_disabled: true },
        });
        this.lastScreen = { id: this.panelId, signature }; return result;
      } catch { this.panelId = undefined; /* Deleted or uneditable panels are replaced. */ }
    }
    const result = await this.telegram.send(this.owner, text, markup, { parse_mode: 'HTML' });
    if (result && typeof result === 'object' && 'message_id' in result && typeof result.message_id === 'number') {
      this.panelId = result.message_id; this.lastScreen = { id: result.message_id, signature };
    }
    return result;
  }

  async configureMenu() {
    await this.telegram.call('setMyCommands', { scope: { type: 'chat', chat_id: this.owner }, commands: [
      { command: 'start', description: 'Home dashboard' }, { command: 'portfolio', description: 'My tokens and balances' },
      { command: 'targets', description: 'Manage sell targets' }, { command: 'wallets', description: 'Choose or add a wallet' },
      { command: 'settings', description: 'Slippage and price impact' }, { command: 'help', description: 'Quick guide' },
    ] });
  }

  private selectedWallet() {
    const wallets = this.store.wallets(), selected = this.store.setting('selectedWallet');
    if (selected && wallets.includes(selected)) return selected;
    if (wallets.length === 1) { this.store.set('selectedWallet', wallets[0]); return wallets[0]; }
    return null;
  }
  wallet() { const account = this.selectedWallet(); assert(account, 'Choose a wallet from Wallets first.'); return account; }

  async home(note = '') {
    this.flow = null;
    const wallet = this.selectedWallet(), paused = this.store.setting('paused', false);
    const targets = this.store.targets().filter(t => t.mode === this.engine.mode);
    const active = targets.filter(t => t.status === 'active').length;
    const pending = this.store.executions().filter(e => ['signed', 'pending', 'uncertain', 'needs_review'].includes(e.status)).length;
    const cached = wallet ? this.pages.get(wallet) : undefined;
    const value = cached ? `\nLast portfolio  <b>${money(cached.totalUsd)}</b>${cached.unpriced ? ' + unpriced assets' : ''}` : '';
    return this.send(`<b>NEAR · AUTO SELL</b>\n${this.engine.mode === 'live' ? '🔴 LIVE · Real trades enabled' : '🧪 PAPER · Practice mode'}\n\n` +
      `Wallet  ${wallet ? code(wallet) : 'Choose a wallet to begin'}${value}\n` +
      `Monitor  ${paused ? '⏸ Paused' : '🟢 Running'}\nTargets  ${active} watching · ${targets.filter(t => t.status === 'paused').length} paused` +
      (pending ? `\n⚠ ${pending} transaction(s) need attention` : '') +
      (note ? `\n\n${escapeHtml(note)}` : '\n\nChoose a token, set your target, and let the bot watch it.'), keyboard([
        [button('💰 My tokens', 'portfolio:0'), button('🎯 New target', 'newtarget')],
        [button('📋 My targets', 'targets'), button('👛 Wallets', 'wallets')],
        [button('🧾 Activity', 'history'), button('⚙ Settings', 'settings')],
        [button(paused ? '▶ Resume monitoring' : '⏸ Pause monitoring', paused ? 'resume' : 'pause'), button('❔ Help', 'help')],
        ...(pending ? [[button('↻ Check pending transactions', 'reconcile')]] : []),
      ]));
  }

  async wallets(page = 0) {
    this.flow = null;
    const wallets = this.store.wallets(), selected = this.selectedWallet();
    const last = Math.max(0, Math.ceil(wallets.length / 6) - 1); page = Math.min(page, last);
    const rows = wallets.slice(page * 6, page * 6 + 6).map(account => [button(
      `${account === selected ? '✓ ' : ''}${this.engine.executor.hasKey(account) ? '🔑' : '👁'} ${short(account, 34)}`, 'wallet:' + hash(account),
    )]);
    if (last > 0) rows.push([button('‹ Previous', `wallets:${Math.max(0, page - 1)}`), button('Next ›', `wallets:${Math.min(last, page + 1)}`)]);
    rows.push([button('＋ Watch a wallet', 'watch'), button('🔑 Import help', 'importhelp')], footer());
    return this.send(`<b>👛 YOUR WALLETS</b>\n\n${wallets.length ? 'Tap a wallet to see its tokens.\n🔑 Trading key loaded   👁 Watch only' : 'Add a public address to see its tokens.\nImport a trading key when you are ready for live sells.'}\n\nSelected  ${selected ? code(selected) : 'None'}\nPage ${page + 1}/${last + 1}`, keyboard(rows));
  }

  async portfolio(page = 0, refresh = false, choosing = false) {
    this.flow = null;
    if (!this.selectedWallet()) return this.wallets();
    const account = this.wallet(); let p = this.pages.get(account);
    if (refresh || !p || Date.now() - p.at > 30000) {
      await this.send(`<b>💰 Loading your tokens…</b>\n\n${code(account)}\nChecking balances and prices.`, keyboard([footer()]));
      p = await this.market.portfolio(account, this.store.tracked(account)); this.pages.set(account, p);
    }
    const last = Math.max(0, Math.ceil(p.tokens.length / 5) - 1); page = Math.min(Math.max(page, 0), last);
    const tokens = p.tokens.slice(page * 5, page * 5 + 5);
    let text = `<b>${choosing ? '🎯 CHOOSE A TOKEN' : '💰 MY TOKENS'}</b>\n${code(account)}\n\n` +
      `Priced holdings  <b>${money(p.totalUsd)}</b>\n${p.tokens.length} assets${p.unpriced ? ` · ${p.unpriced} unpriced or unverified` : ''}\n`;
    if (p.warning) text += `\n⚠ ${escapeHtml(short(p.warning, 200))}\n`;
    for (const t of tokens) text += `\n<b>${escapeHtml(short(t.symbol, 30))}</b>   ${money(t.valueUsd)}\n` +
      `${t.balanceRaw == null ? 'Balance unavailable' : compact(human(t.balanceRaw, t.decimals))} tokens` +
      (t.route ? ` · Pair: ${escapeHtml(t.route.outSymbol)}` : t.token === 'native.near' ? ' · Gas balance' : ' · View only') + '\n';
    text += tokens.length ? '\nTap a token below for details.\n<i>USD values are estimates, before a sell quote.</i>' : '\nNo tokens found yet. Add a token contract or refresh shortly.';
    const rows = tokens.map(t => [button(`${t.route ? '🎯' : '◉'} ${short(t.symbol, 20)} · ${money(t.valueUsd)}`, `token:${hash(account)}:${hash(t.token)}`)]);
    const nav: InlineButton[] = [];
    if (page > 0) nav.push(button('‹ Previous', `portfolio:${page - 1}`));
    nav.push(button(`↻ Refresh · ${page + 1}/${last + 1}`, `refresh:${page}`));
    if (page < last) nav.push(button('Next ›', `portfolio:${page + 1}`));
    rows.push(nav, [button('＋ Add token', 'track'), button('👛 Change wallet', 'wallets')], footer());
    return this.send(text, keyboard(rows));
  }

  private selectedToken(walletHash: string, tokenHash: string): Holding {
    const account = this.wallet(); assert(hash(account) === walletHash, 'The selected wallet changed. Open My tokens again.');
    const token = this.pages.get(account)?.tokens.find(t => hash(t.token) === tokenHash);
    assert(token, 'This token list expired. Refresh My tokens.'); return token;
  }
  async tokenDetails(walletHash: string, tokenHash: string) {
    this.flow = null;
    const t = this.selectedToken(walletHash, tokenHash), account = this.wallet();
    const rows: InlineButton[][] = [];
    if (t.route) rows.push([button('🎯 Set a sell target', `new:${walletHash}:${tokenHash}`)]);
    rows.push([button('📋 My targets', 'targets'), button('↻ Refresh tokens', 'refresh:0')], footer(button('‹ My tokens', 'portfolio:0')));
    return this.send(`<b>${escapeHtml(short(t.symbol, 30))}</b>\n${code(t.token)}\n\n` +
      `Balance  <b>${t.balanceRaw == null ? 'Unavailable' : compact(human(t.balanceRaw, t.decimals))}</b>\n` +
      `My holdings  <b>${money(t.valueUsd)}</b>\nPrice per token  ${t.priceUsd == null ? 'Unpriced' : '$' + compact(t.priceUsd)}\n` +
      `Payout  ${t.route ? escapeHtml(t.route.outSymbol) : 'No supported sell route'}\nWallet  ${code(account)}\n\n` +
      (t.route ? 'Set a target based on market cap or the value of all your holdings in this token.' : escapeHtml(t.warning || (t.token === 'native.near' ? 'This NEAR is used for transaction fees.' : 'You can view this asset here. Auto-sell is unavailable.'))), keyboard(rows));
  }

  async beginToken(token: string) {
    accountId(token);
    const account = this.wallet();
    if (this.engine.mode === 'live' && !this.engine.executor.hasKey(account)) return this.importHelp();
    await this.send('<b>🎯 Preparing your target…</b>\n\nChecking your current balance and trigger values.');
    const snapshot = await this.market.snapshot(account, token);
    assert(BigInt(snapshot.balanceRaw) > 0n, 'This wallet has no balance in that token. Choose another token.');
    this.flow = { kind: 'target', id: crypto.randomBytes(4).toString('hex'), revision: 0, expiresAt: Date.now() + 15 * 60000,
      account, token, symbol: snapshot.symbol, snapshot, step: 'metric' };
    return this.showFlow();
  }

  private targetFlow(): TargetFlow {
    assert(this.flow?.kind === 'target' && this.flow.expiresAt > Date.now(), 'This form expired. Start a new target.');
    assert(this.wallet() === this.flow.account, 'Your wallet changed. Start a new target for the selected wallet.');
    return this.flow;
  }

  async showFlow(note = '') {
    const flow = this.targetFlow(); flow.revision++;
    const action = (name: string, value: string) => `form:${flow.id}:${flow.revision}:${name}:${value}`;
    const steps: Step[] = ['metric', 'direction', 'threshold', 'quantity'], index = steps.indexOf(flow.step);
    const subtitle = `${escapeHtml(short(flow.symbol, 30))} · ${this.engine.mode.toUpperCase()}\n${code(flow.account)}`;
    let question: string, rows: InlineButton[][];
    if (flow.step === 'metric') {
      question = `<b>What should trigger the sell?</b>\n\nMarket cap → the whole token project.\nMy holdings → your full balance of this token.\n\n` +
        `At form start\nMarket cap  ${money(flow.snapshot.marketCapUsd)}\nMy holdings  ${money(measure({ metric: 'holding' }, flow.snapshot))}`;
      rows = [[button('🌐 Market cap ($)', action('metric', 'marketcap'))], [button('💰 My holdings value ($)', action('metric', 'holding'))]];
    } else if (flow.step === 'direction') {
      question = '<b>When should it sell?</b>\n\nChoose whether the value must rise or fall to your target.';
      rows = [[button('↗ At or above my target', action('direction', 'gte'))], [button('↘ At or below my target', action('direction', 'lte'))]];
    } else if (flow.step === 'threshold') {
      question = `<b>Enter your ${flow.metric === 'marketcap' ? 'market cap' : 'holdings value'} target in USD</b>\n\n` +
        `Value at form start  <b>${money(measure({ metric: flow.metric! }, flow.snapshot))}</b>\n` +
        `${flow.direction === 'gte' ? '↗ At or above' : '↘ At or below'}${flow.threshold ? ' · Previous: ' + money(flow.threshold) : ''}\nType a number, for example ${flow.metric === 'marketcap' ? '100000' : '500'}.`;
      const amounts = flow.metric === 'marketcap' ? ['25000', '100000', '500000'] : ['100', '500', '1000'];
      rows = [amounts.map(value => button(money(value), action('threshold', value)))];
    } else {
      question = `<b>How much should the bot sell?</b>\n\n${flow.metric === 'marketcap' ? 'Market cap' : 'My holdings'} ${flow.direction === 'gte' ? '≥' : '≤'} ${money(flow.threshold)}\n\n` +
        'Choose a percentage, or type an exact token quantity.\nExample: <code>25%</code> or <code>1000</code>.\nPercentages use your balance when the sell executes.';
      rows = [['10%', '25%', '50%', '100%'].map(value => button(value, action('quantity', value)))];
    }
    rows.push([button('‹ Back', action('back', 'previous')), button('✕ Cancel', action('cancel', 'cancel'))]);
    return this.send(`<b>NEW TARGET · ${index + 1}/4</b>\n${subtitle}\n${'●'.repeat(index + 1)}${'○'.repeat(3 - index)}\n\n` +
      (note ? `⚠ ${escapeHtml(note)}\n\n` : '') + question, keyboard(rows));
  }

  private async formCallback(id: string, revision: string, action: string, value: string) {
    const flow = this.targetFlow();
    assert(flow.id === id && String(flow.revision) === revision, 'That button belongs to an older step. Use the current form below.');
    if (action === 'cancel') return this.home('Target form cancelled.');
    if (action === 'back') {
      if (flow.step === 'metric') return this.portfolio();
      const previous: Record<Exclude<Step, 'metric'>, Step> = { direction: 'metric', threshold: 'direction', quantity: 'threshold' };
      flow.step = previous[flow.step]; return this.showFlow();
    }
    assert(action === flow.step, 'Use the current form step.');
    if (action === 'metric') {
      assert(value === 'marketcap' || value === 'holding', 'Choose a trigger type.');
      if (flow.metric !== value) { flow.threshold = undefined; flow.direction = undefined; }
      flow.metric = value; flow.step = 'direction'; return this.showFlow();
    }
    if (action === 'direction') {
      assert(value === 'gte' || value === 'lte', 'Choose above or below.');
      flow.direction = value; flow.step = 'threshold'; return this.showFlow();
    }
    return this.formValue(value);
  }

  private async formValue(text: string) {
    const flow = this.targetFlow();
    if (flow.step === 'threshold') { flow.threshold = decimal(text.trim()).toFixed(); flow.step = 'quantity'; return this.showFlow(); }
    if (flow.step === 'quantity') {
      const quantity = parseQuantity(text.trim());
      const { account, token, metric, direction, threshold } = flow;
      assert(metric && direction && threshold, 'This form is incomplete. Start a new target.');
      return this.preview({ account, token, metric, direction, threshold, quantity });
    }
    return this.showFlow('Choose one of the buttons for this step.');
  }

  async preview(input: PreviewInput) {
    const defaults = { slippageBps: this.store.setting('slippageBps', 200), maxImpactBps: this.store.setting('maxImpactBps', 1500) };
    await this.send('<b>Checking your target…</b>\n\nReading your balance and a fresh sell quote.');
    const { target: t, snapshot, plan, alreadyReached } = await this.engine.create({ ...defaults, ...input });
    this.flow = null;
    return this.send(`<b>REVIEW · ${t.mode.toUpperCase()}</b>\n\n${targetText(t)}\n\n` +
      `Current trigger value  <b>${money(measure(t, snapshot))}</b>\n` +
      `Estimated sell  ${compact(human(plan.amount, plan.decimals))} ${escapeHtml(plan.symbol)}\n` +
      `Estimated payout  <b>${compact(human(plan.expectedOut, plan.outDecimals))} ${escapeHtml(plan.outSymbol)}</b>\n` +
      `Payout contract  ${code(plan.output)}\n` +
      (alreadyReached ? '\n⚠ Target already met. Activation may execute immediately.\n' : '') + this.activationTerms(t), this.targetButtons(t, true));
  }

  private activationTerms(t: Target) {
    return '\nOne execution · Expires in 30 days. Pair may change after graduation.\n' +
      'Pair registration, if needed: up to 0.01 NEAR plus gas. The trigger is rechecked afterward.\n\n' +
      (t.mode === 'live' ? '<b>Activation authorizes this live sell and any required registration.</b>' : '🧪 Practice only. No real trade will be sent.');
  }
  private targetButtons(t: Target, reviewing = false) {
    const rows: InlineButton[][] = [], sameMode = t.mode === this.engine.mode;
    if (t.status === 'draft' && sameMode && Date.now() - t.createdAt < 15 * 60000) {
      rows.push([button(t.mode === 'live' ? '🔴 Activate LIVE sell' : '🧪 Activate PAPER target', 'arm:' + t.id)]);
    }
    if (t.status === 'active' && sameMode) rows.push([button('⏸ Pause target', 'pauseTarget:' + t.id)]);
    if (t.status === 'paused' && sameMode && Date.now() < t.expiresAt) rows.push([button('▶ Resume target', 'resumeTarget:' + t.id)]);
    if (['draft', 'active', 'paused'].includes(t.status)) rows.push([button(reviewing ? '✕ Discard' : '✕ Cancel target', 'cancel:' + t.id)]);
    if (['executing', 'needs_review'].includes(t.status)) rows.push([button('↻ Check transaction', 'reconcile')]);
    rows.push(footer(button('‹ My targets', 'targets'))); return keyboard(rows);
  }
  async targetDetails(id: string, note = '') {
    this.flow = null;
    const stored = this.store.target(id); assert(stored, 'This target no longer exists. Open My targets.');
    const t = await this.engine.describeTarget(stored);
    const expiry = t.status === 'draft' && Date.now() - t.createdAt >= 15 * 60000 ? '\n\n⌛ Draft expired. Create a new target for a fresh quote.' : '';
    return this.send(`<b>🎯 TARGET DETAILS</b>\n\n${targetText(t)}${expiry}` +
      (t.status === 'draft' ? this.activationTerms(t) : '') + (note ? `\n\n${escapeHtml(note)}` : ''), this.targetButtons(t));
  }
  async targets(page = 0, filter = 'open') {
    this.flow = null;
    const current = this.store.targets().filter(t => t.mode === this.engine.mode);
    const items = filter === 'all' ? current : current.filter(t => ['active', 'paused', 'draft', 'executing', 'needs_review'].includes(t.status));
    const last = Math.max(0, Math.ceil(items.length / 5) - 1); page = Math.min(page, last);
    const rows: InlineButton[][] = [[button(`${filter === 'open' ? '✓ ' : ''}Open`, 'targets:0:open'), button(`${filter === 'all' ? '✓ ' : ''}All`, 'targets:0:all')]];
    let text = `<b>📋 MY TARGETS · ${this.engine.mode.toUpperCase()}</b>\n${items.length} ${filter === 'all' ? 'total' : 'open'} targets · Page ${page + 1}/${last + 1}\n`;
    if (this.store.setting('paused', false)) text += '\n⏸ Monitoring paused. Resume from Home to run active rules.\n';
    const visible = await Promise.all(items.slice(page * 5, page * 5 + 5).map(t => this.engine.describeTarget(t)));
    for (const t of visible) {
      text += `\n<b>${escapeHtml(tokenTitle(t))}</b> · ${stateLabel(t.status)}\n` +
        `${t.metric === 'marketcap' ? 'Market cap' : 'My holdings'} ${t.direction === 'gte' ? '≥' : '≤'} ${money(t.threshold)} → ${escapeHtml(t.quantity.value)}${t.quantity.kind === 'percent' ? '%' : ' tokens'}\n`;
      rows.push([button(`${short(t.tokenSymbol || tokenTitle(t), 22)} · ${stateLabel(t.status)}`, 'target:' + t.id)]);
    }
    if (!items.length) text += '\nYour targets will appear here. Choose a token to create one.';
    if (last > 0) rows.push([button('‹ Previous', `targets:${Math.max(0, page - 1)}:${filter}`), button('Next ›', `targets:${Math.min(last, page + 1)}:${filter}`)]);
    rows.push([button('＋ New target', 'newtarget')], footer());
    return this.send(text, keyboard(rows));
  }
  async history(page = 0) {
    this.flow = null;
    const all = this.store.executions(), last = Math.max(0, Math.ceil(all.length / 4) - 1); page = Math.min(page, last);
    let text = `<b>🧾 ACTIVITY</b>\nPage ${page + 1}/${last + 1}\n`;
    const visible = await Promise.all(all.slice(page * 4, page * 4 + 4).map(async e => {
      const target = this.store.target(e.targetId);
      return { e, named: target ? await this.engine.describeTarget(target) : { token: e.plan.token, tokenSymbol: e.plan.symbol } };
    }));
    for (const { e, named } of visible) {
      text += `\n<b>${escapeHtml(tokenTitle(named))} → ${escapeHtml(short(e.plan.outSymbol, 30))}</b>\n${stateLabel(e.status)} · Target ${code(e.targetId)}\n`;
      if (e.reason) text += escapeHtml(short(e.reason, 220)) + '\n';
      if (e.hash && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(e.hash)) text += `<a href="https://nearblocks.io/txns/${e.hash}">View transaction ↗</a>\n`;
    }
    if (!all.length) text += '\nNo executions yet. Activated targets will appear here when they trigger.';
    const rows = [[button('↻ Check pending', 'reconcile')]];
    if (last > 0) rows.push([button('‹ Previous', `history:${Math.max(0, page - 1)}`), button('Next ›', `history:${Math.min(last, page + 1)}`)]);
    rows.push(footer()); return this.send(text, keyboard(rows));
  }
  async cancel(id: string) {
    this.store.change(id, ['draft', 'active', 'paused'], { status: 'cancelled' });
    return this.targetDetails(id, 'Target cancelled.');
  }
  async pause(id?: string) {
    if (id) { this.store.change(id, ['active'], { status: 'paused' }); return this.targetDetails(id, 'Paused. Resume whenever you are ready.'); }
    this.store.set('paused', true); return this.home('Monitoring paused. Submitted transactions may still finish.');
  }
  async resume(id?: string) {
    if (id) {
      const t = this.store.target(id); assert(t && t.mode === this.engine.mode && Date.now() < t.expiresAt, 'This target belongs to another mode or has expired.');
      assert(!this.store.pending(t.account), 'Check the wallet’s pending transaction from Activity first.');
      this.store.change(id, ['paused'], { status: 'active', lastError: null });
      return this.targetDetails(id, this.store.setting('paused', false) ? 'Target active. Global monitoring is still paused.' : 'Target resumed.');
    }
    this.store.set('paused', false); return this.home('Monitoring resumed. Individually paused targets stay paused.');
  }

  async settings(note = '') {
    this.flow = null;
    const slippage = this.store.setting('slippageBps', 200), impact = this.store.setting('maxImpactBps', 1500);
    return this.send(`<b>⚙ SELL SETTINGS</b>\n\nSlippage  <b>${slippage / 100}%</b>\nHow far the fill may move from the fresh quote.\n\n` +
      `Max price impact  <b>${impact / 100}%</b>\nBlocks quotes that are too far below spot value.\n\n` +
      `Mode  <b>${this.engine.mode.toUpperCase()}</b>\nChanges apply to new targets only.${note ? '\n\n' + escapeHtml(note) : ''}`, keyboard([
        [button('Slippage · 0.5%', 'set:slippage:50'), button('1%', 'set:slippage:100'), button('2%', 'set:slippage:200')],
        [button('Impact · 5%', 'set:impact:500'), button('10%', 'set:impact:1000'), button('15%', 'set:impact:1500')],
        [button('Custom slippage', 'input:slippage'), button('Custom impact', 'input:impact')], footer(),
      ]));
  }
  private setPreference(kind: 'slippage' | 'impact', value: string) {
    const n = decimal(value).mul(100); assert(n.isInteger(), 'Use up to two decimal places.');
    const bps = n.toNumber(), slip = kind === 'slippage';
    assert(bps >= (slip ? 10 : 100) && bps <= (slip ? 1000 : 5000), slip ? 'Slippage must be 0.1%–10%.' : 'Maximum impact must be 1%–50%.');
    this.store.set(slip ? 'slippageBps' : 'maxImpactBps', bps);
    return this.settings(`Saved ${value}% ${slip ? 'slippage' : 'maximum impact'} for new targets.`);
  }

  async prompt(kind: InputFlow['kind'], note = '') {
    if (kind === 'track' && !this.selectedWallet()) return this.wallets();
    this.flow = { kind, expiresAt: Date.now() + 15 * 60000, ...(kind === 'track' ? { account: this.wallet() } : {}) };
    const messages = {
      watch: '<b>👁 WATCH A WALLET</b>\n\nSend its public NEAR account ID.\nExample: <code>alice.near</code>\n\nYou can view tokens without a trading key.',
      track: '<b>＋ ADD A TOKEN</b>\n\nSend the full token contract ID.\nExample: <code>ucat.umbrafun.near</code>\n\nUse this when a new token is missing from your list.',
      slippage: '<b>CUSTOM SLIPPAGE</b>\n\nSend a percentage between 0.1 and 10.\nExample: <code>1.5</code>\nApplies to new targets only.',
      impact: '<b>CUSTOM MAX IMPACT</b>\n\nSend a percentage between 1 and 50.\nExample: <code>10</code>\nApplies to new targets only.',
    };
    return this.send(messages[kind] + (note ? '\n\n⚠ ' + escapeHtml(note) : ''), keyboard([footer(button('✕ Cancel', kind === 'watch' ? 'wallets' : kind === 'track' ? 'portfolio:0' : 'settings'))]));
  }
  async importHelp() {
    this.flow = null;
    return this.send('<b>🔑 ENABLE WALLET TRADING</b>\n\n' +
      '1. Stop the bot on your PC or VPS.\n2. In the project terminal run:\n<code>npm run import</code>\n' +
      '3. Enter your vault password and wallet key locally.\n4. Restart the bot, then choose your wallet.\n\n' +
      'Use Watch a wallet to view balances right away. Wallet secrets stay in your encrypted vault; do not paste them into this chat.',
      keyboard([[button('👁 Watch a wallet', 'watch')], footer(button('‹ Wallets', 'wallets'))]));
  }
  async help() {
    this.flow = null;
    return this.send('<b>❔ QUICK GUIDE</b>\n\n' +
      '<b>1 · Choose</b>\nOpen My tokens and tap a token.\n\n<b>2 · Set</b>\nPick market cap or holdings value, your USD target, and how much to sell.\n\n' +
      '<b>3 · Activate</b>\nReview the payout and activate the target.\n\n' +
      '🧪 PAPER simulates. 🔴 LIVE can sell real tokens.\nMy targets lets you pause, resume or cancel each rule.\n\n' +
      'The bot must keep running on your PC/VPS. Targets sell into the paired asset. USD values are estimates.\n\n' +
      'Need a fresh screen? Send /start.\nAdvanced command: <code>/target CONTRACT mc|value above|below USD 25%|1000</code>',
      keyboard([[button('🎯 Create a target', 'newtarget')], [button('🔑 Import help', 'importhelp')], footer()]));
  }

  async callback(data: string): Promise<unknown> {
    const [action, value, extra, detail, choice] = data.split(':');
    if (action === 'home' || action === 'abort') return this.home();
    if (action === 'help') return this.help();
    if (action === 'importhelp') return this.importHelp();
    if (action === 'wallets') return this.wallets(pageNumber(value));
    if (action === 'wallet') {
      const account = this.store.wallets().find(a => hash(a) === value); assert(account, 'Wallet selection expired. Open Wallets again.');
      this.store.set('selectedWallet', account); this.flow = null; return this.portfolio(0, true);
    }
    if (action === 'portfolio') return this.portfolio(pageNumber(value));
    if (action === 'refresh') return this.portfolio(pageNumber(value), true);
    if (action === 'token') return this.tokenDetails(value, extra);
    if (action === 'new') return this.beginToken(this.selectedToken(value, extra).token);
    if (action === 'newtarget') return this.portfolio(0, false, true);
    if (action === 'form') return this.formCallback(value, extra, detail, choice);
    if (action === 'watch' || action === 'track') return this.prompt(action);
    if (action === 'settings') return this.settings();
    if (action === 'input') { assert(value === 'slippage' || value === 'impact', 'Choose a setting.'); return this.prompt(value); }
    if (action === 'set') {
      assert(value === 'slippage' || value === 'impact', 'Choose a setting.');
      assert(/^\d{1,4}$/.test(extra), 'Invalid setting.'); return this.setPreference(value, String(Number(extra) / 100));
    }
    if (action === 'arm') {
      this.engine.arm(value);
      return this.targetDetails(value, this.store.setting('paused', false) ? 'Target activated. Resume monitoring from Home to run it.' : 'Target activated. The bot is watching.');
    }
    if (action === 'target') return this.targetDetails(value);
    if (action === 'targets') return this.targets(pageNumber(value), extra === 'all' ? 'all' : 'open');
    if (action === 'cancel') return this.cancel(value);
    if (action === 'pauseTarget') return this.pause(value);
    if (action === 'resumeTarget') return this.resume(value);
    if (action === 'pause') return this.pause();
    if (action === 'resume') return this.resume();
    if (action === 'history') return this.history(pageNumber(value));
    if (action === 'reconcile') { await this.engine.reconcile(); return this.history(); }
    throw new AppError('This button has expired. Open Home to continue.');
  }

  private async watch(account: string) {
    accountId(account); await this.market.rpc.query({ request_type: 'view_account', account_id: account });
    this.store.addWallet(account); this.store.set('selectedWallet', account); this.flow = null; return this.portfolio(0, true);
  }
  private async track(token: string) {
    accountId(token); await this.market.metadata(token); this.store.track(this.wallet(), token); this.flow = null; return this.portfolio(0, true);
  }

  async text(text: string): Promise<unknown> {
    assert(text.length <= 500, 'Message too long. Send one value at a time.');
    if (/ed25519:|\b(seed|mnemonic|private.?key)\b/i.test(text) || (!text.startsWith('/') && text.trim().split(/\s+/).length >= 12)) {
      throw new AppError('Import wallet secrets using npm run import on your PC/VPS. Do not send them to Telegram.');
    }
    if (!text.startsWith('/') && this.flow) {
      assert(this.flow.expiresAt > Date.now(), 'This form expired. Open Home to begin again.');
      if (this.flow.kind === 'target') return this.formValue(text);
      if (this.flow.kind === 'watch') return this.watch(accountId(text.trim()));
      if (this.flow.kind === 'track') { assert(this.wallet() === this.flow.account, 'Your wallet changed. Add the token again.'); return this.track(accountId(text.trim())); }
      return this.setPreference(this.flow.kind, text.trim().replace(/%$/, ''));
    }
    const [rawCommand, ...args] = text.trim().split(/\s+/), command = rawCommand.split('@')[0].toLowerCase();
    if (command === '/start') return this.home();
    if (command === '/help') return this.help();
    if (command === '/abort') return this.home('Form cancelled.');
    if (command === '/wallets') return this.wallets();
    if (command === '/portfolio') return this.portfolio(0, true);
    if (command === '/watch') return args[0] ? this.watch(accountId(args[0])) : this.prompt('watch');
    if (command === '/track') return args[0] ? this.track(accountId(args[0])) : this.prompt('track');
    if (command === '/target' && !args.length) return this.portfolio(0, false, true);
    if (command === '/target') {
      assert(args.length === 5, 'Use New target for the guided form, or: /target CONTRACT mc|value above|below USD 25%|1000');
      assert(['mc', 'value'].includes(args[1]) && ['above', 'below'].includes(args[2]), 'Use mc/value and above/below.');
      return this.preview({ account: this.wallet(), token: accountId(args[0]), metric: args[1] === 'mc' ? 'marketcap' : 'holding', direction: args[2] === 'above' ? 'gte' : 'lte', threshold: decimal(args[3]).toFixed(), quantity: parseQuantity(args[4]) });
    }
    if (command === '/targets') return this.targets();
    if (command === '/history') return this.history();
    if (command === '/settings') return this.settings();
    if (command === '/pause') return this.pause(args[0]);
    if (command === '/resume') return this.resume(args[0]);
    if (command === '/cancel') { assert(args[0], 'Open My targets and choose the target to cancel.'); return this.cancel(args[0]); }
    if (command === '/reconcile') { await this.engine.reconcile(); return this.history(); }
    if (command === '/slippage' || command === '/impact') {
      const kind = command === '/slippage' ? 'slippage' : 'impact';
      return args[0] ? this.setPreference(kind, args[0]) : this.prompt(kind);
    }
    return this.home('Choose an action below to continue.');
  }

  async handle(update: TelegramUpdate) {
    if (!authorized(update, this.owner)) return;
    try {
      if (update.callback_query) {
        await this.telegram.call('answerCallbackQuery', { callback_query_id: update.callback_query.id }).catch(() => {});
        if (update.callback_query.message?.message_id != null) this.panelId = update.callback_query.message.message_id;
        return await this.callback(update.callback_query.data || '');
      }
      if (typeof update.message?.text === 'string') {
        // Commands start a fresh panel near the bottom of the chat; form replies update their prompt.
        if (update.message.text.startsWith('/')) this.panelId = undefined;
        return await this.text(update.message.text);
      }
    } catch (error) {
      const message = safeError(error);
      if (this.flow?.kind === 'target' && this.flow.expiresAt > Date.now() && this.selectedWallet() === this.flow.account) return this.showFlow(message);
      if (this.flow && this.flow.kind !== 'target' && this.flow.expiresAt > Date.now()) return this.prompt(this.flow.kind, message);
      this.flow = null;
      return this.send(`<b>Let’s try that again</b>\n\n${escapeHtml(message)}`, keyboard([[button('👛 Wallets', 'wallets'), button('📋 My targets', 'targets')], footer()]));
    }
  }

  async run() {
    while (!this.stopping) {
      try {
        const offset = this.store.setting('telegramOffset', 0);
        const updates = await this.telegram.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          // Persist receipt first: a crash can lose a command, but cannot replay a financial command.
          assert(typeof u.update_id === 'number', 'Invalid Telegram update.');
          this.store.set('telegramOffset', u.update_id + 1); await this.handle(u);
        }
      } catch { await new Promise(resolve => setTimeout(resolve, 5000)); }
    }
  }
}
