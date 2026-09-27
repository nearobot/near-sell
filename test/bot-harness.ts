import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { Bot } from '../src/telegram.ts';
import type { BotDependencies } from '../src/telegram.ts';
import type { InlineKeyboard } from '../src/types.ts';
import { rpcStub, telegramStub, testSnapshot, testPlan, executorStub } from './helpers.ts';

export function botHarness() {
  const store = new Store();
  const messages: { chat: string; text: string; markup?: InlineKeyboard }[] = [];
  const telegram = telegramStub(async (chat, text, markup) => { messages.push({ chat, text, markup }); });
  const market = {
    snapshot: async () => testSnapshot({ priceUsd: '1', marketCapUsd: '1000000000' }),
    quote: async () => testPlan(), rpc: rpcStub(),
    metadata: async () => ({ name: 'Test', symbol: 'TEST', decimals: 18 }),
    portfolio: async (): Promise<never> => { throw new Error('Unexpected portfolio call'); },
  } satisfies BotDependencies['market'] & ConstructorParameters<typeof Engine>[0]['market'];
  const engine = new Engine({ store, market, executor: executorStub(), mode: 'paper' });
  const bot = new Bot({ telegram, owner: '123', store, market, engine });
  return { store, messages, bot, engine };
}
