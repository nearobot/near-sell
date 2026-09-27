import type { Block, FetchLike, RpcPort, TransactionResult } from './types.ts';
import { AppError, assert } from './core.ts';

export async function jsonRequest<T = unknown>(url: string, options: RequestInit = {}, { timeout = 12000, fetchImpl = fetch }: { timeout?: number; fetchImpl?: FetchLike } = {}): Promise<T> {
  try {
    const r = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json', ...options.headers } });
    if (!r.ok) throw new AppError(`Provider returned HTTP ${r.status}. No values were assumed.`, 'HTTP');
    return await r.json() as T;
  } catch (e) { if (e instanceof AppError) throw e; throw new AppError('Provider is unavailable or timed out. No values were assumed.', 'NETWORK'); }
}
export class Rpc implements RpcPort {
  urls: string[]; apiKey: string; fetchImpl: FetchLike;
  constructor({ urls = ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com'], apiKey = '', fetchImpl = fetch }: { urls?: string[]; apiKey?: string; fetchImpl?: FetchLike } = {}) { this.urls = urls; this.apiKey = apiKey; this.fetchImpl = fetchImpl; }
  async call<T = unknown>(method: string, params: unknown, { write = false } = {}): Promise<T> {
    let last;
    for (const url of (write ? this.urls.slice(0, 1) : this.urls)) {
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (this.apiKey && new URL(url).hostname.endsWith('.fastnear.com')) headers.authorization = 'Bearer ' + this.apiKey;
        const d = await jsonRequest<{result?: T; error?: {cause?: {name?: string}; name?: string}}>(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'near-target-bot', method, params }) }, { fetchImpl: this.fetchImpl });
        if (d.error) {
          const code = d.error.cause?.name || d.error.name || 'RPC';
          throw new AppError(code === 'INVALID_TRANSACTION' ? 'The RPC rejected this transaction before execution.' : 'RPC could not verify this account, contract, or transaction.', code);
        }
        assert(d.result != null && !(typeof d.result === 'object' && 'error' in d.result && d.result.error), 'The contract returned an error or an incomplete result.', 'CONTRACT');
        return d.result;
      } catch(e) { last = e; if (write || !(e instanceof AppError) || !['NETWORK', 'HTTP'].includes(e.code)) throw e; }
    }
    throw last;
  }
  query<T = unknown>(args: Record<string, unknown>, block?: Block): Promise<T> { return this.call<T>('query', { ...(block ? { block_id: block.hash } : { finality: 'final' }), ...args }); }
  async view<T = unknown>(contract: string, method: string, args: Record<string, unknown> = {}, block?: Block): Promise<T> {
    const r = await this.query<{result: number[]}>({ request_type: 'call_function', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') }, block);
    try { return JSON.parse(Buffer.from(r.result).toString('utf8')) as T; } catch { throw new AppError('Contract returned an unreadable result.', 'BAD_DATA'); }
  }
  async block(): Promise<Block> {
    const r = await this.call<{header: {hash: string; height: number; timestamp_nanosec?: string; timestamp: number}}>('block', { finality: 'final' });
    const at = Number(BigInt(r.header.timestamp_nanosec ?? String(r.header.timestamp)) / 1000000n);
    assert(Number.isFinite(at) && Date.now() - at < 60000 && at - Date.now() < 10000, 'RPC chain data is stale or this computer clock is incorrect.', 'STALE');
    return { hash: r.header.hash, height: r.header.height, at };
  }
  status(hash: string, account: string): Promise<TransactionResult> { return this.call<TransactionResult>('tx', { tx_hash: hash, sender_account_id: account, wait_until: 'NONE' }); }
}
export async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(values.length); let at = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (at < values.length) { const i = at++; out[i] = await fn(values[i], i); }
  })); return out;
}
