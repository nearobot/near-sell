import type { RpcPort, FetchLike, TokenMetadata, PriceList, Block, AccountState, Holding, Portfolio, Pricing, NearlyLaunch, CurveState, SimplePool, Snapshot, TargetConfig, SellPlan, CurvePlan, FtPlan, RegistrationPlan } from './types.ts';
import { D, DCL, RHEA, WNEAR, AppError, assert, accountId, unsigned, human, minOut, impactBps, curveQuote } from './core.ts';
import { jsonRequest, mapLimit } from './network.ts';

export type QuoteTarget = Pick<TargetConfig, 'account' | 'token' | 'settlement' | 'slippageBps' | 'maxImpactBps'>;
export class Market {
 rpc: RpcPort; fetchImpl: FetchLike; fastnearApiKey: string;
 cache = new Map<string, TokenMetadata>(); ratesCache?: {prices: PriceList; at: number};
  constructor(rpc: RpcPort, { fetchImpl = fetch, fastnearApiKey = '' }: { fetchImpl?: FetchLike; fastnearApiKey?: string } = {}) { this.rpc = rpc; this.fetchImpl = fetchImpl; this.fastnearApiKey = fastnearApiKey; this.cache = new Map(); }
  async get<T>(url: string): Promise<T> { return jsonRequest<T>(url, {}, { fetchImpl: this.fetchImpl }); }
  async metadata(token: string, block?: Block): Promise<TokenMetadata> {
    if (token === 'native.near') return { symbol: 'NEAR', decimals: 24, name: 'NEAR' };
    const key = 'meta:' + token;
    if (!this.cache.has(key)) {
      const m = await this.rpc.view<TokenMetadata>(token, 'ft_metadata', {}, block);
      assert(m && Number.isInteger(m.decimals) && m.decimals >= 0 && m.decimals <= 36 && typeof m.symbol === 'string', 'Token metadata is invalid.', 'BAD_DATA');
      this.cache.set(key, { decimals: m.decimals, symbol: m.symbol.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 30), name: String(m.name).slice(0, 80) });
    }
    return this.cache.get(key)!;
  }
  async rates() {
    const cached = this.ratesCache; if (cached && Date.now() - cached.at < 20000) return cached;
    const prices = await this.get<PriceList>('https://api.ref.finance/list-token-price');
    assert(prices && typeof prices === 'object' && !Array.isArray(prices), 'USD prices are unavailable.', 'NO_PRICE');
    const value = { prices, at: Date.now() }; this.ratesCache = value; return value;
  }
  async usd(token: string) {
    const rates = await this.rates(), p = rates.prices[token === 'native.near' ? WNEAR : token]?.price;
    assert(p != null && new D(p).isFinite() && new D(p).gt(0), 'This pair asset has no USD price. Automatic USD targets are paused.', 'NO_PRICE');
    return { price: new D(p).toFixed(), at: rates.at, source: 'Rhea price API' };
  }
  async discover(account: string, extras: string[] = []) {
    accountId(account);
    const headers = this.fastnearApiKey ? { authorization: 'Bearer ' + this.fastnearApiKey } : {};
    let contracts: string[], warning: string | null = null;
    try {
      const d = await jsonRequest<{tokens: {contract_id: string}[]}>(`https://api.fastnear.com/v1/account/${encodeURIComponent(account)}/ft`, { headers }, { fetchImpl: this.fetchImpl });
      assert(Array.isArray(d.tokens), 'Token discovery returned an invalid response.', 'BAD_DATA');
      contracts = d.tokens.map(t => accountId(t.contract_id));
    } catch {
      contracts = []; warning = 'Automatic token discovery is unavailable. Showing tracked tokens only; this portfolio is incomplete.';
    }
    return { tokens: [...new Set([...contracts, ...extras])], warning };
  }
  async portfolio(account: string, extras: string[] = []): Promise<Portfolio> {
    const block = await this.rpc.block(), discovered = await this.discover(account, extras);
    const state = await this.rpc.query<AccountState>({ request_type: 'view_account', account_id: account }, block);
    const rate = await this.usd(WNEAR).catch(() => null);
    const native = { token: 'native.near', symbol: 'NEAR', decimals: 24, balanceRaw: state.amount, priceUsd: rate?.price ?? null, valueUsd: rate ? new D(human(state.amount)).mul(rate.price).toFixed() : null, route: null };
    const rows = await mapLimit<string, Holding | null>(discovered.tokens, 3, async token => {
      try {
        const balance = unsigned(await this.rpc.view<string>(token, 'ft_balance_of', { account_id: account }, block));
        if (balance === 0n) return null;
        const meta = await this.metadata(token, block);
        let pricing;
        try { pricing = await this.details(token, block); }
        catch { pricing = { priceUsd: (await this.usd(token).catch(() => null))?.price ?? null, route: null, priceSource: 'Rhea API / indicative', warning: 'No verified sell route or quote.' }; }
        return { token, ...meta, ...pricing, balanceRaw: balance.toString(), valueUsd: pricing.priceUsd != null ? new D(human(balance, meta.decimals)).mul(pricing.priceUsd).toFixed() : null };
      } catch { return { token, symbol: token, balanceRaw: null, valueUsd: null, priceUsd: null, warning: 'Balance could not be verified.' }; }
    });
    const tokens = [native, ...rows.filter((t): t is Holding => t !== null)].sort((a, b) => new D(b.valueUsd || 0).cmp(a.valueUsd || 0));
    return { account, at: Date.now(), blockAt: block.at, tokens, warning: discovered.warning, totalUsd: tokens.reduce((sum, t) => sum.plus(t.valueUsd || 0), new D(0)).toFixed(), unpriced: tokens.filter(t => t.valueUsd == null).length };
  }
  async details(token: string, block: Block): Promise<Pricing> {
    accountId(token); const meta = await this.metadata(token, block);
    if (token.endsWith('.nearlytrade.near')) {
      const launch = await this.rpc.view<NearlyLaunch>('nearlytrade.near', 'get_launch_by_token', { token }, block);
      assert(launch?.token === token && launch.step === 'Done' && !launch.inflight, 'This Nearly launch is not ready for trading.', 'NO_ROUTE');
      const pair = String(launch.quote || WNEAR); accountId(pair);
      const pool = await this.rpc.view<{current_point: number}>(DCL, 'get_pool', { pool_id: launch.pool_id }, block);
      const parts = launch.pool_id.split('|');
      assert(parts.length === 3 && parts.slice(0, 2).includes(token) && parts.slice(0, 2).includes(pair), 'Unexpected DCL pool assets.', 'BAD_DATA');
      assert(Number.isInteger(pool.current_point) && Math.abs(pool.current_point) <= 800000, 'Invalid DCL pool price.', 'BAD_DATA');
      const pairMeta = await this.metadata(pair, block), usd = await this.usd(pair);
      let price = new D('1.0001').pow(pool.current_point);
      if (parts[0] !== token) price = new D(1).div(price);
      price = price.mul(new D(10).pow(meta.decimals - pairMeta.decimals));
      const priceUsd = price.mul(usd.price).toFixed();
      const tax = await this.rpc.view<{sell_bps: number} | null>('nearlytrade.near', 'get_tax', { launch_id: String(launch.id) }, block);
      const sellTaxBps = tax === null ? 0 : tax.sell_bps;
      assert(Number.isInteger(sellTaxBps) && sellTaxBps >= 0 && sellTaxBps <= 400, 'Unexpected sell tax. Review this contract.', 'BAD_DATA');
      return { ...meta, priceUsd, marketCapUsd: new D(human(launch.total_supply, meta.decimals)).mul(priceUsd).toFixed(), priceSource: 'Final Rhea DCL pool price × Rhea USD rate', rateAt: usd.at, route: { kind: 'dcl', token, exchange: DCL, poolId: launch.pool_id, output: pair, outSymbol: pairMeta.symbol, outDecimals: pairMeta.decimals, outUsd: usd.price, sellTaxBps } };
    }
    if (token.endsWith('.umbrafun.near')) {
      assert(meta.decimals === 18, 'Unexpected Umbra token decimals.', 'BAD_DATA');
      const curve = await this.rpc.view<CurveState>(token, 'get_curve_state', {}, block);
      const supply = await this.rpc.view<string>(token, 'ft_total_supply', {}, block); unsigned(supply);
      if (!curve.graduated) {
        const output = curve.quote_token || 'native.near', outMeta = await this.metadata(output, block), usd = await this.usd(output);
        const price = new D(human(curve.spot_price, outMeta.decimals));
        const priceUsd = price.mul(usd.price).toFixed();
        return { ...meta, priceUsd, marketCapUsd: new D(human(supply, 18)).mul(priceUsd).toFixed(), priceSource: 'Final Umbra curve price × Rhea USD rate', rateAt: usd.at, route: { kind: 'curve', token, output, outSymbol: outMeta.symbol, outDecimals: outMeta.decimals, outUsd: usd.price, curve } };
      }
      assert(typeof curve.migration === 'object' && curve.migration.Done && curve.dex?.exchange === RHEA, 'Umbra graduation is not complete or uses an unknown exchange.', 'NO_ROUTE');
      const poolId = curve.migration.Done.pool_id;
      assert(Number.isSafeInteger(poolId) && poolId >= 0, 'Invalid Rhea pool ID.');
      const pool = await this.rpc.view<SimplePool>(RHEA, 'get_pool', { pool_id: poolId }, block);
      assert(pool.pool_kind === 'SIMPLE_POOL' && pool.token_account_ids?.length === 2 && pool.token_account_ids.includes(token), 'Unsupported Rhea pool.', 'NO_ROUTE');
      const index = pool.token_account_ids.indexOf(token), output = pool.token_account_ids[1-index], outMeta = await this.metadata(output, block), usd = await this.usd(output);
      const inReserve = new D(human(pool.amounts[index], meta.decimals)), outReserve = new D(human(pool.amounts[1-index], outMeta.decimals));
      assert(inReserve.gt(0) && outReserve.gt(0), 'Pool has no liquidity.', 'NO_LIQUIDITY');
      const priceUsd = outReserve.div(inReserve).mul(usd.price).toFixed();
      return { ...meta, priceUsd, marketCapUsd: new D(human(supply, 18)).mul(priceUsd).toFixed(), priceSource: 'Final Rhea pool price × Rhea USD rate', rateAt: usd.at, route: { kind: 'rhea', token, exchange: RHEA, poolId, output, outSymbol: outMeta.symbol, outDecimals: outMeta.decimals, outUsd: usd.price } };
    }
    throw new AppError('Detected token, but automated sells currently support Nearly and Umbra launchpad contracts only.', 'NO_ROUTE');
  }
  async snapshot(account: string, token: string): Promise<Snapshot> {
    const block = await this.rpc.block();
    const balanceRaw = await this.rpc.view<string>(token, 'ft_balance_of', { account_id: account }, block); unsigned(balanceRaw);
    const details = await this.details(token, block);
    return { ...details, token, account, balanceRaw, observedAt: Date.now(), blockAt: block.at, block };
  }
  async quote(target: QuoteTarget, snapshot: Snapshot, amount: bigint): Promise<SellPlan> {
    const r = snapshot.route; assert(r, 'No verified sell route.', 'NO_ROUTE');
    assert(target.settlement === 'pair' || [WNEAR, 'native.near'].includes(r.output), 'No direct NEAR route. Use pair settlement.', 'NO_ROUTE');
    let out: string;
    let transaction: Pick<CurvePlan, 'kind' | 'method' | 'args'> | Pick<FtPlan, 'kind' | 'method' | 'args'>;
    if (r.kind === 'curve') {
      out = curveQuote(r.curve, amount);
      transaction = {kind: 'curve', method: 'sell', args: { amount: amount.toString(), min_out: minOut(out, target.slippageBps) }};
    } else if (r.kind === 'dcl') {
      const net = amount - amount * BigInt(r.sellTaxBps) / 10000n;
      const q = await this.rpc.view<{amount: string}>(DCL, 'quote', { pool_ids: [r.poolId], input_token: target.token, output_token: r.output, input_amount: net.toString(), tag: null }, snapshot.block);
      out = unsigned(q.amount).toString();
      transaction = {kind: 'ft', method: 'ft_transfer_call', args: { receiver_id: DCL, amount: amount.toString(), msg: JSON.stringify({ Swap: { pool_ids: [r.poolId], output_token: r.output, min_output_amount: minOut(out, target.slippageBps) } }) }};
    } else if (r.kind === 'rhea') {
      out = String(await this.rpc.view(RHEA, 'get_return', { pool_id: r.poolId, token_in: target.token, amount_in: amount.toString(), token_out: r.output }, snapshot.block)); unsigned(out);
      
      transaction = {kind: 'ft', method: 'ft_transfer_call', args: { receiver_id: RHEA, amount: amount.toString(), msg: JSON.stringify({ force: 0, actions: [{ pool_id: r.poolId, token_in: target.token, token_out: r.output, amount_in: amount.toString(), min_amount_out: minOut(out, target.slippageBps) }], skip_unwrap_near: true }) }};
    } else throw new AppError('Unsupported route.');
    const impact = impactBps(amount, snapshot.decimals, snapshot.priceUsd, out, r.outDecimals, r.outUsd);
    assert(impact <= target.maxImpactBps, `Estimated price impact is ${(impact / 100).toFixed(2)}%, above the target limit.`, 'IMPACT');
    let registration: RegistrationPlan | null = null;
    if (r.output !== 'native.near') {
      const storage = await this.rpc.view<{total: string} | null>(r.output, 'storage_balance_of', { account_id: target.account }, snapshot.block);
      if (!storage || unsigned(storage.total) === 0n) {
        const bounds = await this.rpc.view<{min: string}>(r.output, 'storage_balance_bounds', {}, snapshot.block);
        const deposit = unsigned(bounds.min);
        assert(deposit > 0n && deposit <= 10n ** 22n, `This pair needs more than 0.01 NEAR storage registration. Register it in your wallet first.`, 'REGISTRATION');
        registration = { kind: 'registration', account: target.account, token: target.token, receiver: r.output, output: r.output, outSymbol: r.outSymbol, symbol: snapshot.symbol, method: 'storage_deposit', args: { account_id: target.account, registration_only: true }, deposit: deposit.toString(), gas: '30000000000000', quotedAt: Date.now(), blockAt: snapshot.blockAt };
      }
    }
    return { ...transaction, account: target.account, token: target.token, amount: amount.toString(), decimals: snapshot.decimals, symbol: snapshot.symbol, receiver: target.token, gas: '250000000000000', deposit: '1', output: r.output, outSymbol: r.outSymbol, outDecimals: r.outDecimals, expectedOut: out, minimumOut: minOut(out, target.slippageBps), impactBps: impact, quotedAt: Date.now(), blockAt: snapshot.blockAt, registration };
  }
}
