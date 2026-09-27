import { rpcStub, telegramStub } from './helpers.ts';
import { botHarness } from './bot-harness.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import seedUtils from 'near-seed-phrase';
import { raw, human, quantity, parseQuantity, reached, minOut, curveQuote, validateTarget } from '../src/core.ts';
import { seal, unseal, deriveWallet, verifyKey } from '../src/vault.ts';
import { authorized, Bot } from '../src/telegram.ts';

test('raw token quantities preserve integers beyond floating-point precision', () => {
  const value = '123456789012345678.123456789012345678';
  assert.equal(human(raw(value, 18), 18), value);
  assert.throws(() => raw('1e9', 18)); assert.throws(() => raw('0.0001', 2));
});
test('percent sells round down against current balance; exact amounts never oversell', () => {
  assert.equal(quantity(parseQuantity('25%'), 100000000000000000003n, 18), 25000000000000000000n);
  assert.equal(quantity(parseQuantity('100%'), 101n, 0), 101n);
  assert.throws(() => quantity(parseQuantity('10'), 9n, 0));
  assert.throws(() => quantity(parseQuantity('1%'), 1n, 0));
  assert.throws(() => parseQuantity('101%')); assert.throws(() => parseQuantity('-2%'));
});
test('holdings trigger measures full balance, independent of the amount sold', () => {
  const s = { balanceRaw: raw('100', 18).toString(), decimals: 18, priceUsd: '2.50', marketCapUsd: '9000' };
  assert.equal(reached({ metric: 'holding', direction: 'gte', threshold: '250' }, s), true);
  assert.equal(reached({ metric: 'holding', direction: 'lte', threshold: '249.99' }, s), false);
  assert.equal(reached({ metric: 'marketcap', direction: 'gte', threshold: '9000' }, s), true);
  assert.throws(() => reached({ metric: 'holding', direction: 'gte', threshold: '1' }, { ...s, priceUsd: null }));
});
test('min-output enforces slippage with integer units', () => {
  assert.equal(minOut('10001', 200), '9800'); assert.throws(() => minOut('1', 200));
});
test('curve quote handles fee, insufficient reserve and graduation', () => {
  const state = { real_reserve: raw('1000').toString(), virtual_reserve: raw('1000').toString(), curve_tokens: raw('927000000', 18).toString(), fee_bps: 100, graduated: false };
  assert.equal(curveQuote(state, raw('1000000000', 18)), raw('990').toString());
  assert.throws(() => curveQuote(state, raw('1000000001', 18)));
  assert.throws(() => curveQuote({ ...state, graduated: true }, 1n));
});
test('vault authenticates ciphertext and never stores readable secrets', () => {
  const secret = 'synthetic-wallet-secret', password = 'a strong synthetic test passphrase';
  const sealed = seal({ secret }, password);
  assert.equal(JSON.stringify(sealed).includes(secret), false);
  assert.deepEqual(unseal(sealed, password), { secret });
  assert.throws(() => unseal(sealed, 'wrong passphrase'));
  const tampered = Buffer.from(sealed.cipher, 'base64'); tampered[0] ^= 1;
  assert.throws(() => unseal({ ...sealed, cipher: tampered.toString('base64') }, password));
});
test('seed and private key import derive the same key; errors contain no input', () => {
  const generated = seedUtils.generateSeedPhrase();
  assert.equal(deriveWallet(generated.seedPhrase).getPublicKey().toString(), deriveWallet(generated.secretKey).getPublicKey().toString());
  const secret = 'not a real secret';
  assert.throws(() => deriveWallet(secret), e => e instanceof Error && !e.message.includes(secret));
});
test('import validates the key against that exact account and full access', async () => {
  const key = near.KeyPair.fromRandom('ed25519'); let queried: Record<string, unknown> | undefined;
  await verifyKey(rpcStub({ query: async q => { queried = q; return { permission: 'FullAccess' }; } }), 'alice.near', key);
  assert.ok(queried); assert.equal(queried.account_id, 'alice.near'); assert.equal(queried.public_key, key.getPublicKey().toString());
  await assert.rejects(verifyKey(rpcStub({ query: async () => ({ permission: { FunctionCall: {} } }) }), 'alice.near', key));
});
test('Telegram authorization requires BOTH the owner and their private chat', () => {
  const good = { message: { from: { id: 123 }, chat: { id: 123, type: 'private' } } };
  assert.equal(authorized(good, '123'), true);
  assert.equal(authorized({ message: { from: { id: 999 }, chat: { id: 123, type: 'private' } } }, '123'), false);
  assert.equal(authorized({ message: { from: { id: 123 }, chat: { id: -1, type: 'group' } } }, '123'), false);
  assert.equal(authorized({ callback_query: { id: 'test', from: { id: 123 }, message: { chat: { id: 123, type: 'private' } } } }, '123'), true);
});
test('unauthorized updates produce no messages or side effects', async () => {
  const {bot, store} = botHarness(); bot.telegram = telegramStub(async () => { throw new Error('Must not send'); });
  await bot.handle({ message: { from: { id: 999 }, chat: { id: 999, type: 'private' }, text: '/resume' } }); store.close();
});
