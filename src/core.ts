import type { Quantity, TargetConfig, Valuation, CurveState, Target } from './types.ts';
import { Decimal } from 'decimal.js';
export const D = Decimal.clone({ precision: 90, rounding: Decimal.ROUND_DOWN, toExpNeg: -90, toExpPos: 90 });
export const WNEAR = 'wrap.near';
export const DCL = 'dclv2.ref-labs.near';
export const RHEA = 'v2.ref-finance.near';
export const YOCTO = 10n ** 24n;
export class AppError extends Error {
  code: string;
  constructor(message: string, code = 'VALIDATION') { super(message); this.code = code; }
}
export function assert(condition: unknown, message: string, code?: string): asserts condition { if (!condition) throw new AppError(message, code); }
export const validAccount = (x: unknown): x is string => typeof x === 'string' && x.length >= 2 && x.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(x);
export function accountId(x: unknown) { assert(validAccount(x), 'Use the full NEAR account or token contract ID.'); return x; }
export function decimal(x: unknown, { zero = false } = {}) {
  assert(typeof x === 'string' && x.length <= 90 && /^\d+(?:\.\d+)?$/.test(x), 'Enter a decimal number, without commas or scientific notation.');
  const n = new D(x); assert(zero ? n.gte(0) : n.gt(0), zero ? 'Amount must not be negative.' : 'Amount must be greater than zero.');
  return n;
}
export function raw(x: string | bigint | number, decimals = 24) {
  assert(Number.isInteger(decimals) && decimals >= 0 && decimals <= 36, 'Unsupported token decimals.');
  const n = decimal(String(x), { zero: true }).mul(new D(10).pow(decimals));
  assert(n.isInteger(), `This token supports ${decimals} decimal places.`);
  return BigInt(n.toFixed(0));
}
export function human(x: string | bigint | number, decimals = 24) { return new D(String(x)).div(new D(10).pow(decimals)).toFixed(); }
export function unsigned(x: unknown, field = 'on-chain token amount') { assert(typeof x === 'string' && /^\d+$/.test(x), `Invalid ${field}. Expected an unsigned integer string.`, 'BAD_DATA'); return BigInt(x); }
export function quantity(spec: Quantity, balance: bigint, decimals: number) {
  let result;
  if (spec.kind === 'percent') result = BigInt(new D(String(balance)).mul(decimal(spec.value)).div(100).floor().toFixed(0));
  else result = raw(spec.value, decimals);
  assert(result > 0n && result <= balance, 'Sell quantity is zero or exceeds the current balance.');
  return result;
}
export function parseQuantity(text: string): Quantity {
  const percent = text.endsWith('%'), value = text.replace(/%$/, '');
  const n = decimal(value); assert(!percent || n.lte(100), 'Percentage must be at most 100%.');
  return { kind: percent ? 'percent' : 'tokens', value: n.toFixed() };
}
export function validateTarget<T extends TargetConfig>(t: T): T {
  accountId(t.account); accountId(t.token);
  assert(['marketcap', 'holding'].includes(t.metric), 'Choose market cap or holdings value.');
  assert(['gte', 'lte'].includes(t.direction), 'Choose above or below.');
  decimal(t.threshold); assert(['percent', 'tokens'].includes(t.quantity?.kind), 'Choose a sell quantity.');
  parseQuantity(t.quantity.value + (t.quantity.kind === 'percent' ? '%' : ''));
  assert(Number.isInteger(t.slippageBps) && t.slippageBps >= 10 && t.slippageBps <= 1000, 'Slippage must be 0.1%–10%.');
  assert(Number.isInteger(t.maxImpactBps) && t.maxImpactBps >= 100 && t.maxImpactBps <= 5000, 'Maximum price impact must be 1%–50%.');
  assert(['near', 'pair'].includes(t.settlement), 'Choose NEAR or pair settlement.');
  assert(['paper', 'live'].includes(t.mode), 'Invalid execution mode.');
  return t;
}
export function measure(t: Pick<TargetConfig, 'metric'>, snapshot: Valuation) {
  assert(snapshot.priceUsd != null && snapshot.marketCapUsd != null, 'No reliable USD price is available.', 'NO_PRICE');
  return t.metric === 'marketcap' ? new D(snapshot.marketCapUsd) : new D(human(snapshot.balanceRaw, snapshot.decimals)).mul(snapshot.priceUsd);
}
export function reached(t: Pick<TargetConfig, 'metric' | 'direction' | 'threshold'>, snapshot: Valuation) { const v = measure(t, snapshot); return t.direction === 'gte' ? v.gte(t.threshold) : v.lte(t.threshold); }
export function minOut(amount: string | bigint, bps: number) { const n = unsigned(String(amount)) * BigInt(10000 - bps) / 10000n; assert(n > 0n, 'Quoted output is too small.'); return n.toString(); }
export function impactBps(amount: string | bigint, decimals: number, priceUsd: string, out: string, outDecimals: number, outUsd: string) {
  const value = new D(human(amount, decimals)).mul(priceUsd);
  if (value.lte(0)) throw new AppError('Cannot validate price impact.');
  return D.max(0, new D(1).minus(new D(human(out, outDecimals)).mul(outUsd).div(value))).mul(10000).ceil().toNumber();
}
export const money = (n: Decimal.Value | null | undefined) => n == null ? 'unpriced' : '$' + new D(n).toFixed(2);
export const compact = (n: Decimal.Value) => new D(n).toSignificantDigits(8).toFixed();
export const tokenText = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) : '';
export function tokenTitle(t: Pick<Target, 'token' | 'tokenName' | 'tokenSymbol'>) {
  const name = tokenText(t.tokenName, 80), symbol = tokenText(t.tokenSymbol, 30);
  return name && symbol && name.toLowerCase() !== symbol.toLowerCase() ? `${name} (${symbol})` : symbol || name || t.token.replace(/\.(nearlytrade|umbrafun)\.near$/, '');
}
export const safeError = (e: unknown) => e instanceof AppError ? e.message : 'The operation failed. Check configuration or retry after the provider recovers.';
export function curveQuote(state: Pick<CurveState, 'graduated' | 'real_reserve' | 'virtual_reserve' | 'curve_tokens' | 'fee_bps'>, amount: bigint) {
  assert(state.graduated === false, 'This curve has graduated. Refresh the route.', 'ROUTE_CHANGED');
  const reserve = unsigned(state.real_reserve), virtual = unsigned(state.virtual_reserve);
  const curveTokens = unsigned(state.curve_tokens) + 73_000_000n * 10n ** 18n;
  const gross = (reserve + virtual) * amount / (curveTokens + amount);
  assert(gross > 0n && gross <= reserve, 'The curve cannot fill this amount.', 'NO_LIQUIDITY');
  assert(Number.isInteger(state.fee_bps) && state.fee_bps >= 0 && state.fee_bps < 10000, 'Invalid curve fee.');
  return (gross - gross * BigInt(state.fee_bps) / 10000n).toString();
}
