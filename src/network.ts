import type { Block, FetchLike, RpcPort, TransactionResult } from './types.ts';
import { AppError, assert } from './core.ts';

export const DEFAULT_RPC_URLS = ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com', 'https://rpc.shitzuapes.xyz', 'https://rpc.intea.rs'];
const WRITE_METHODS = new Set(['send_tx', 'broadcast_tx_async', 'broadcast_tx_commit']);
const FALLBACK_CODES = new Set(['NETWORK', 'HTTP', 'INTERNAL_ERROR', 'TIMEOUT_ERROR', 'UNAVAILABLE_SHARD', 'UNKNOWN_BLOCK']);
export class ProviderError extends AppError {
  status?: number;
  constructor(message: string, code: string, status?: number) { super(message, code); this.status = status; }
}
// Paths, query strings, request bodies and auth headers can contain credentials.
export function providerHost(url: string) { try { return new URL(url).host; } catch { return 'configured provider'; } }
export function rpcOperation(method: string, params: unknown) {
  const p = params && typeof params === 'object' ? params as Record<string, unknown> : {};
  const name = typeof p.method_name === 'string' ? p.method_name : p.request_type;
  const view = typeof name === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(name) ? '/' + name : '';
  return method + view;
}
export async function jsonRequest<T = unknown>(url: string, options: RequestInit = {}, { timeout = 12000, fetchImpl = fetch, context = 'Provider', retryRead = false }: { timeout?: number; fetchImpl?: FetchLike; context?: string; retryRead?: boolean } = {}): Promise<T> {
  const attempts = retryRead && ['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase()) ? 2 : 1;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json', ...options.headers } });
      if (!r.ok) throw new ProviderError(`${context} via ${providerHost(url)} returned HTTP ${r.status}.`, 'HTTP', r.status);
      return await r.json() as T;
    } catch (error) {
      const e = error instanceof AppError ? error : new ProviderError(`${context} via ${providerHost(url)} is unavailable or timed out.`, 'NETWORK');
      const transient = e instanceof ProviderError && (e.code === 'NETWORK' || e.status === 408 || (e.status != null && e.status >= 500));
      if (!transient || attempt + 1 >= attempts) throw e;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
export class Rpc implements RpcPort {
  urls: string[]; apiKey: string; fetchImpl: FetchLike;
  private unavailableUntil = new Map<string, number>();
  constructor({ urls = DEFAULT_RPC_URLS, apiKey = '', fetchImpl = fetch }: { urls?: string[]; apiKey?: string; fetchImpl?: FetchLike } = {}) { this.urls = [...new Set(urls)]; this.apiKey = apiKey; this.fetchImpl = fetchImpl; assert(this.urls.length, 'Configure at least one NEAR RPC URL.', 'CONFIG'); }
  async call<T = unknown>(method: string, params: unknown, { write = false } = {}): Promise<T> {
    const submission = write || WRITE_METHODS.has(method), operation = rpcOperation(method, params);
    const healthy = this.urls.filter(url => (this.unavailableUntil.get(url) ?? 0) <= Date.now());
    const available = healthy.length ? healthy : [...this.urls].sort((a, b) => (this.unavailableUntil.get(a) ?? 0) - (this.unavailableUntil.get(b) ?? 0));
    const candidates = submission ? available.slice(0, 1) : available;
    const failures: string[] = []; let last: unknown;
    for (const url of candidates) {
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (this.apiKey && new URL(url).hostname.endsWith('.fastnear.com')) headers.authorization = 'Bearer ' + this.apiKey;
        const d = await jsonRequest<{result?: T; error?: {cause?: {name?: string}; name?: string; code?: number}}>(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'near-target-bot', method, params }) }, { fetchImpl: this.fetchImpl, context: 'RPC ' + operation });
        if (d.error) {
          const reported = d.error.cause?.name || d.error.name || (d.error.code === -32603 ? 'INTERNAL_ERROR' : 'RPC');
          const code = /^[A-Z_]{1,64}$/.test(reported) ? reported : 'RPC';
          throw new AppError(code === 'INVALID_TRANSACTION' ? 'The RPC rejected this transaction before execution.' : `RPC ${operation} via ${providerHost(url)} returned ${code}.`, code);
        }
        assert(d.result != null && !(typeof d.result === 'object' && 'error' in d.result && d.result.error), `RPC ${operation} via ${providerHost(url)} returned a contract error or incomplete result.`, 'CONTRACT');
        this.unavailableUntil.delete(url);
        return d.result;
      } catch(e) {
        last = e;
        if (!(e instanceof AppError) || !FALLBACK_CODES.has(e.code)) throw e;
        this.unavailableUntil.set(url, Date.now() + 30000);
        if (submission) throw e; // One submission only, even if a different provider is healthy.
        failures.push(`${providerHost(url)}: ${e instanceof ProviderError && e.status ? 'HTTP ' + e.status : e.code}`);
      }
    }
    if (last instanceof AppError) throw new AppError(`RPC ${operation} failed (${failures.join('; ')}). Monitoring will check again.`, last.code);
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
