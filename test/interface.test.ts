import test from 'node:test';
import assert from 'node:assert/strict';
import { botHarness } from './bot-harness.ts';
import { rpcStub, testSnapshot } from './helpers.ts';
import { raw } from '../src/core.ts';
import { Telegram } from '../src/telegram.ts';
import type { FetchLike, Target, TelegramMethods } from '../src/types.ts';

type Harness = ReturnType<typeof botHarness>;
function setup() { const h = botHarness(); h.store.addWallet('alice.near'); return h; }
function current(h: Harness) { const message = h.messages.at(-1); assert.ok(message); return message; }
function find(h: Harness, label: string) {
  const found = current(h).markup?.inline_keyboard.flat().find(b => b.text.includes(label));
  assert.ok(found, 'Missing button: ' + label); return found.callback_data;
}
async function tap(h: Harness, label: string) {
  const data = find(h, label), id = current(h).id;
  return h.bot.handle({ callback_query: { id: 'callback', from: { id: 123 }, message: { message_id: id, chat: { id: 123, type: 'private' } }, data } });
}
function reply(h: Harness, text: string) {
  return h.bot.handle({ message: { from: { id: 123 }, chat: { id: 123, type: 'private' }, text } });
}
async function draft(h: Harness): Promise<Target> {
  const {target} = await h.engine.create({ account: 'alice.near', token: 'test.umbrafun.near', metric: 'holding', direction: 'gte', threshold: '500', quantity: {kind: 'percent', value: '25'}, slippageBps: 200, maxImpactBps: 1500 });
  return target;
}

test('Home is compact, selects the only wallet, and shows one monitoring action', async t => {
  const h = setup(); t.after(() => h.store.close()); await h.bot.home();
  assert.ok(current(h).text.length < 600); assert.match(current(h).text, /PAPER/);
  assert.equal(h.store.setting('selectedWallet'), 'alice.near');
  assert.ok(find(h, 'Pause monitoring')); assert.ok(!current(h).text.includes('/target CONTRACT'));
  await tap(h, 'Pause monitoring'); assert.equal(h.store.setting('paused'), true); assert.ok(find(h, 'Resume monitoring'));
  assert.equal(h.messages.filter(m => !m.edited).length, 1);
  await tap(h, 'Resume monitoring'); assert.equal(h.store.setting('paused'), false);
});

test('no-wallet users can add a public wallet through buttons and one reply', async t => {
  const h = botHarness(); t.after(() => h.store.close());
  h.market.rpc = rpcStub({ query: async () => ({ amount: '0' }) });
  await h.bot.home(); await tap(h, 'My tokens'); assert.match(current(h).text, /YOUR WALLETS/);
  await tap(h, 'Watch a wallet'); await reply(h, 'alice.near');
  assert.deepEqual(h.store.wallets(), ['alice.near']); assert.equal(h.store.setting('selectedWallet'), 'alice.near');
  assert.match(current(h).text, /MY TOKENS/);
});

test('token picker → details → four-step buttons → review never arms a rule implicitly', async t => {
  const h = setup(); t.after(() => h.store.close());
  await h.bot.home(); await tap(h, 'New target'); await tap(h, 'TEST');
  assert.match(current(h).text, /My holdings/); assert.match(current(h).text, /test\.umbrafun\.near/);
  await tap(h, 'Set a sell target'); await tap(h, 'My holdings'); await tap(h, 'At or above');
  await tap(h, '$500.00'); await tap(h, '25%');
  const target = h.store.targets()[0];
  assert.equal(target.status, 'draft'); assert.equal(target.threshold, '500'); assert.equal(target.metric, 'holding');
  assert.deepEqual(target.quantity, {kind: 'percent', value: '25'});
  assert.match(current(h).text, /REVIEW · PAPER/); assert.match(current(h).text, /0\.01 NEAR/);
  await tap(h, 'Activate PAPER'); assert.equal(h.store.target(target.id)?.status, 'active');
  assert.equal(h.messages.filter(m => !m.edited).length, 1);
});

test('Back preserves inputs while obsolete form buttons cannot change the current step', async t => {
  const h = setup(); t.after(() => h.store.close()); await h.bot.beginToken('test.umbrafun.near');
  const oldMetric = find(h, 'Market cap');
  await tap(h, 'My holdings'); await tap(h, 'At or below'); await reply(h, '123.45');
  const oldQuantity = find(h, '25%');
  await tap(h, 'Back'); assert.match(current(h).text, /Previous: \$123.45/);
  await h.bot.handle({ callback_query: { id: 'old', from: {id: 123}, message: {chat: {id: 123, type: 'private'}}, data: oldQuantity } });
  assert.equal(h.store.targets().length, 0); assert.match(current(h).text, /older step/);
  await tap(h, 'Back'); await tap(h, 'Back');
  await assert.rejects(h.bot.callback(oldMetric), /older step/);
  await tap(h, 'Market cap'); await tap(h, 'At or above');
  assert.ok(!current(h).text.includes('Previous:')); await tap(h, 'Cancel'); assert.equal(h.bot.flow, null);
});

test('invalid form values preserve the current step and provide recovery buttons', async t => {
  const h = setup(); t.after(() => h.store.close()); await h.bot.beginToken('test.umbrafun.near');
  await tap(h, 'My holdings'); await tap(h, 'At or above'); await reply(h, 'not-a-number');
  assert.match(current(h).text, /3\/4/); assert.match(current(h).text, /decimal number/); assert.ok(find(h, 'Back'));
  await reply(h, '500'); await reply(h, '101%'); assert.match(current(h).text, /4\/4/);
  assert.match(current(h).text, /at most 100%/); assert.equal(h.store.targets().length, 0);
});

test('wallet changes, expired forms and watch-only live wallets cannot create trades', async t => {
  const h = setup(); t.after(() => h.store.close()); await h.bot.beginToken('test.umbrafun.near');
  const payload = find(h, 'Market cap'); h.store.addWallet('bob.near'); h.store.set('selectedWallet', 'bob.near');
  await assert.rejects(h.bot.callback(payload), /wallet changed/);
  h.store.set('selectedWallet', 'alice.near'); assert.ok(h.bot.flow); h.bot.flow.expiresAt = Date.now() - 1;
  await assert.rejects(h.bot.callback(payload), /expired/);
  h.engine.mode = 'live'; h.engine.executor.hasKey = () => false;
  await h.bot.beginToken('test.umbrafun.near'); assert.match(current(h).text, /ENABLE WALLET TRADING/);
  assert.equal(h.store.targets().length, 0);
});

test('target detail buttons match state and repeated activation cannot arm twice', async t => {
  const h = setup(); t.after(() => h.store.close()); const target = await draft(h);
  await h.bot.targets(); await tap(h, 'Ready to activate'); assert.ok(find(h, 'Activate PAPER'));
  assert.ok(!current(h).markup?.inline_keyboard.flat().some(b => b.text.includes('Pause target')));
  const arm = find(h, 'Activate PAPER'); await tap(h, 'Activate PAPER');
  await assert.rejects(h.bot.callback(arm), /changed/);
  await tap(h, 'Pause target'); assert.equal(h.store.target(target.id)?.status, 'paused');
  await tap(h, 'Resume target'); assert.equal(h.store.target(target.id)?.status, 'active');
  await tap(h, 'Cancel target'); assert.equal(h.store.target(target.id)?.status, 'cancelled');
  assert.ok(!current(h).markup?.inline_keyboard.flat().some(b => /Activate|Resume|Pause|Cancel/.test(b.text)));
});

test('target pages expose older rules and keep live rules out of paper lists', async t => {
  const h = setup(); t.after(() => h.store.close());
  for (let i = 0; i < 12; i++) await draft(h);
  h.engine.mode = 'live'; const live = await draft(h); h.engine.mode = 'paper';
  await h.bot.targets(); assert.match(current(h).text, /Page 1\/3/);
  await tap(h, 'Next'); assert.match(current(h).text, /Page 2\/3/);
  await tap(h, 'Next'); assert.match(current(h).text, /Page 3\/3/);
  assert.ok(!JSON.stringify(current(h)).includes(live.id));
});

test('settings buttons and custom replies change defaults without mutating existing targets', async t => {
  const h = setup(); t.after(() => h.store.close()); const target = await draft(h);
  await h.bot.settings(); await tap(h, 'Slippage · 0.5%'); assert.equal(h.store.setting('slippageBps'), 50);
  await tap(h, 'Custom impact'); await reply(h, '12.5'); assert.equal(h.store.setting('maxImpactBps'), 1250);
  assert.equal(h.store.target(target.id)?.slippageBps, 200); assert.equal(h.store.target(target.id)?.maxImpactBps, 1500);
  await h.bot.callback('input:slippage'); await reply(h, '25'); assert.match(current(h).text, /0.1%–10%/);
  assert.equal(h.store.setting('slippageBps'), 50);
});

test('token labels are HTML-escaped and unpriced assets stay visible without a sell button', async t => {
  const h = setup(); t.after(() => h.store.close());
  h.market.portfolio = async account => ({ account, at: Date.now(), blockAt: Date.now(), totalUsd: '0', unpriced: 1, warning: null,
    tokens: [{token: 'test.umbrafun.near', symbol: '<b>FAKE & TOKEN</b>', balanceRaw: raw('1', 18).toString(), decimals: 18, priceUsd: null, valueUsd: null, route: null}] });
  await h.bot.portfolio(); assert.match(current(h).text, /&lt;b&gt;FAKE &amp; TOKEN&lt;\/b&gt;/);
  assert.ok(!current(h).text.includes('<b>FAKE & TOKEN</b>')); assert.match(current(h).text, /unpriced/);
  await tap(h, 'FAKE'); assert.ok(!current(h).markup?.inline_keyboard.flat().some(b => b.text.includes('Set a sell')));
});

test('missing token flow tracks the contract for the selected wallet and refreshes balances', async t => {
  const h = setup(); t.after(() => h.store.close()); await h.bot.portfolio(); await tap(h, 'Add token');
  await reply(h, 'new.umbrafun.near'); assert.deepEqual(h.store.tracked('alice.near'), ['new.umbrafun.near']);
  assert.match(current(h).text, /MY TOKENS/);
});

test('editable panels fall back after deletion, and owner-scoped shortcuts register without secrets', async t => {
  const h = setup(); t.after(() => h.store.close()); await h.bot.home();
  const original = h.telegram.call.bind(h.telegram);
  h.telegram.call = async <K extends keyof TelegramMethods>(method: K, body?: Record<string, unknown>): Promise<TelegramMethods[K]> => {
    if (method === 'editMessageText') throw new Error('Synthetic deleted message');
    return original(method, body);
  };
  await h.bot.settings(); assert.equal(h.messages.filter(m => !m.edited).length, 2);
  await h.bot.configureMenu(); const call = h.calls.find(c => c.method === 'setMyCommands');
  assert.deepEqual(call?.body?.scope, {type: 'chat', chat_id: '123'});
});

test('Telegram transport sends HTML only when requested and never adds parsing to trade notices', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: FetchLike = async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
    return {ok: true, status: 200, json: async () => ({ok: true, result: {message_id: 1}})};
  };
  const telegram = new Telegram('123456:synthetic_test_token_1234567890', fetchImpl);
  await telegram.send('123', '<b>Home</b>', undefined, {parse_mode: 'HTML'});
  await telegram.send('123', 'Trade result: <plain text>');
  assert.equal(bodies[0].parse_mode, 'HTML'); assert.equal(bodies[1].parse_mode, undefined);
});
