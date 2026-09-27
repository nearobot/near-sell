import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { Bot } from '../src/telegram.ts';
import type { BotDependencies } from '../src/telegram.ts';
import type { InlineKeyboard, TelegramMethods, TelegramPort } from '../src/types.ts';
import assert from 'node:assert/strict';
import { rpcStub, testSnapshot, testPlan, executorStub } from './helpers.ts';

export function botHarness() {
  const store = new Store();
  const messages: { chat: string; text: string; markup?: InlineKeyboard; id: number; edited: boolean }[] = [];
  const calls: { method: keyof TelegramMethods; body?: Record<string, unknown> }[] = [];
  let nextId = 1;
  const telegram: TelegramPort = {
    send: async (chat, text, markup, options) => {
      assert.equal(options?.parse_mode, 'HTML');
      const id = nextId++; messages.push({ chat, text, markup, id, edited: false }); return { message_id: id };
    },
    async call<K extends keyof TelegramMethods>(method: K, body?: Record<string, unknown>): Promise<TelegramMethods[K]> {
      calls.push({ method, body });
      if (method === 'answerCallbackQuery' || method === 'setMyCommands') return true as TelegramMethods[K];
      if (method === 'editMessageText') {
        assert.ok(body); assert.equal(body.parse_mode, 'HTML');
        assert.equal(typeof body.text, 'string'); assert.equal(typeof body.message_id, 'number');
        messages.push({ chat: String(body.chat_id), text: body.text as string, markup: body.reply_markup as InlineKeyboard, id: body.message_id as number, edited: true });
        return { message_id: body.message_id } as TelegramMethods[K];
      }
      throw new Error('Unexpected Telegram call: ' + method);
    },
  };
  const market: BotDependencies['market'] & ConstructorParameters<typeof Engine>[0]['market'] = {
    snapshot: async () => testSnapshot({ priceUsd: '1', marketCapUsd: '1000000000' }),
    quote: async () => testPlan(), rpc: rpcStub(),
    metadata: async () => ({ name: 'Test', symbol: 'TEST', decimals: 18 }),
    portfolio: async account => {
      const snapshot = testSnapshot();
      return { account, at: Date.now(), blockAt: Date.now(), totalUsd: '100', unpriced: 0, warning: null,
        tokens: [{ token: snapshot.token, symbol: snapshot.symbol, decimals: 18, balanceRaw: snapshot.balanceRaw, priceUsd: '1', valueUsd: '100', route: snapshot.route }] };
    },
  };
  const engine = new Engine({ store, market, executor: executorStub(), mode: 'paper' });
  const bot = new Bot({ telegram, owner: '123', store, market, engine });
  return { store, messages, bot, engine, market, telegram, calls };
}
