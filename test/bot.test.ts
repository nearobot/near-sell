import test from 'node:test';
import assert from 'node:assert/strict';
import { raw } from '../src/core.ts';
import { testSnapshot, testPlan } from './helpers.ts';
import { botHarness } from './bot-harness.ts';

const update = (text: string) => ({ message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, text } });

test('private Telegram command → review → activation creates the requested holdings target', async () => {
  const { store, messages, bot } = botHarness();
  store.addWallet('alice.near'); store.set('selectedWallet', 'alice.near');
  await bot.handle(update('/target test.umbrafun.near value above 500 25%'));
  const t = store.targets()[0];
  assert.equal(t.threshold, '500'); assert.equal(t.metric, 'holding'); assert.equal(t.status, 'draft'); assert.equal(t.mode, 'paper');
  assert.match(messages.at(-1)!.text, /25% of balance at execution/);
  await bot.handle({ callback_query: { id: 'cb', from: { id: 123 }, message: { chat: { id: 123, type: 'private' } }, data: 'arm:' + t.id } });
  assert.equal(store.target(t.id)?.status, 'active');
  await bot.handle(update('/pause')); assert.equal(store.setting('paused'), true);
  await bot.handle(update('/cancel ' + t.id)); assert.equal(store.target(t.id)?.status, 'cancelled'); store.close();
});

test('Telegram token form handles market-cap and exact-quantity selection', async () => {
  const { store, bot, engine } = botHarness();
  store.addWallet('alice.near'); store.set('selectedWallet', 'alice.near');
  engine.market.snapshot = async () => testSnapshot({ priceUsd: '1', marketCapUsd: '100', balanceRaw: raw('1000', 18).toString() });
  engine.market.quote = async () => testPlan(raw('250', 18));
  await bot.beginToken('test.umbrafun.near'); await bot.callback('form:marketcap'); await bot.callback('form:gte'); await bot.text('100000'); await bot.text('250');
  const created = store.targets()[0];
  assert.equal(created.metric, 'marketcap'); assert.deepEqual(created.quantity, { kind: 'tokens', value: '250' }); assert.equal(created.threshold, '100000'); store.close();
});

test('wallet secrets sent to Telegram are never echoed or stored', async () => {
  const { store, messages, bot } = botHarness();
  const sensitive = 'ed25519:synthetic-private-input'; await bot.handle(update(sensitive));
  assert.equal(messages.length, 1); assert.equal(messages[0].text.includes(sensitive), false); assert.match(messages[0].text, /pnpm run import/);
  assert.equal(store.wallets().length, 0); store.close();
});
