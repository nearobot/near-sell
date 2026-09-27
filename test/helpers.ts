import * as near from 'near-api-js';
import { raw } from '../src/core.ts';
import type { EngineDependencies } from '../src/engine.ts';
import type { Block, CurvePlan, PreparedTransaction, RpcPort, Snapshot, TelegramMethods, TelegramPort } from '../src/types.ts';

const unexpected = async (): Promise<never> => { throw new Error('Unexpected test dependency call'); };

// Like Rpc.call, this adapter casts only at the untyped transport boundary.
export function rpcStub(handlers: {
  call?: (method: string, params: unknown) => Promise<unknown>;
  query?: (args: Record<string, unknown>, block?: Block) => Promise<unknown>;
  view?: (contract: string, method: string, args: Record<string, unknown>, block?: Block) => Promise<unknown>;
  block?: RpcPort['block']; status?: RpcPort['status'];
} = {}): RpcPort {
  return {
    async call<T>(method: string, params: unknown) { return await (handlers.call ?? unexpected)(method, params) as T; },
    async query<T>(args: Record<string, unknown>, block?: Block) { return await (handlers.query ?? unexpected)(args, block) as T; },
    async view<T>(contract: string, method: string, args: Record<string, unknown> = {}, block?: Block) { return await (handlers.view ?? unexpected)(contract, method, args, block) as T; },
    block: handlers.block ?? unexpected, status: handlers.status ?? unexpected,
  };
}

export function telegramStub(send: TelegramPort['send']): TelegramPort {
  return {
    send,
    async call<K extends keyof TelegramMethods>(method: K): Promise<TelegramMethods[K]> {
      if (method === 'answerCallbackQuery') return true as TelegramMethods[K];
      throw new Error('Unexpected Telegram method: ' + method);
    },
  };
}

export function testSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    account: 'alice.near', token: 'test.umbrafun.near', name: 'Test', symbol: 'TEST',
    balanceRaw: raw('100', 18).toString(), decimals: 18, priceUsd: '2', marketCapUsd: '2000000000',
    priceSource: 'synthetic', rateAt: Date.now(), observedAt: Date.now(), blockAt: Date.now(),
    block: { hash: 'synthetic', height: 1, at: Date.now() },
    route: {
      kind: 'curve', token: 'test.umbrafun.near', output: 'native.near', outSymbol: 'NEAR', outDecimals: 24, outUsd: '1',
      curve: { graduated: false, real_reserve: raw('1000').toString(), virtual_reserve: raw('1000').toString(), curve_tokens: raw('927000000', 18).toString(), spot_price: raw('0.000002').toString(), fee_bps: 100 },
    },
    ...overrides,
  };
}

export function testPlan(amount = raw('25', 18)): CurvePlan {
  return {
    kind: 'curve', account: 'alice.near', token: 'test.umbrafun.near', receiver: 'test.umbrafun.near', method: 'sell',
    amount: amount.toString(), decimals: 18, symbol: 'TEST', args: { amount: amount.toString(), min_out: raw('24.5').toString() },
    gas: '250000000000000', deposit: '1', output: 'native.near', outSymbol: 'NEAR', outDecimals: 24,
    expectedOut: raw('25').toString(), minimumOut: raw('24.5').toString(), impactBps: 200, quotedAt: Date.now(), blockAt: Date.now(),
  };
}

export function testPrepared(): PreparedTransaction {
  return { key: near.KeyPair.fromRandom('ed25519'), nonce: 1n, blockHash: near.baseEncode(new Uint8Array(32)) };
}

export function executorStub(): EngineDependencies['executor'] {
  return { hasKey: () => true, prepare: unexpected, sign: unexpected, broadcast: unexpected, rpc: { status: unexpected } };
}
