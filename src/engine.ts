import type { Store } from './store.ts';
import type { Market } from './market.ts';
import type { Executor } from './executor.ts';
import type { Mode, Plan, TargetInput, TransactionResult, RpcPort } from './types.ts';
import { AppError, assert, validateTarget, quantity, reached, safeError } from './core.ts';
import { outcome } from './executor.ts';

export interface EngineDependencies {
 store: Store; market: Pick<Market, 'snapshot' | 'quote'>;
 executor: Pick<Executor, 'hasKey' | 'prepare' | 'sign' | 'broadcast'> & {rpc: Pick<RpcPort, 'status'>};
 mode?: Mode; notify?: (text: string) => Promise<unknown>;
}
export class Engine {
 store: Store; market: EngineDependencies['market']; executor: EngineDependencies['executor'];
 mode: Mode; notify: (text: string) => Promise<unknown>; busy: boolean; stopping: boolean;
  constructor({ store, market, executor, mode = 'paper', notify = async () => {} }: EngineDependencies) {
    this.store = store; this.market = market; this.executor = executor; this.mode = mode; this.notify = notify; this.busy = false; this.stopping = false;
  }
  async announce(text: string) { try { await this.notify(text); } catch { /* Delivery must never alter transaction state. */ } }
  async create(input: TargetInput) {
    assert(this.store.wallets().includes(input.account), 'Select an imported or watched wallet first.');
    if (this.mode === 'live') assert(this.executor.hasKey(input.account), 'Import this wallet locally before creating live targets.');
    const t = validateTarget({ ...input, mode: this.mode, settlement: 'pair' });
    const snapshot = await this.market.snapshot(t.account, t.token);
    const amount = quantity(t.quantity, BigInt(snapshot.balanceRaw), snapshot.decimals);
    const plan = await this.market.quote(t, snapshot, amount);
    const target = this.store.createTarget(t);
    this.store.track(t.account, t.token);
    return { target, snapshot, plan, alreadyReached: reached(t, snapshot) };
  }
  arm(id: string) {
    const t = this.store.target(id); assert(t && t.mode === this.mode, 'This target belongs to a different execution mode.');
    assert(Date.now() - t.createdAt < 15 * 60000, 'This draft expired. Create a new target.');
    if (this.mode === 'live') assert(this.executor.hasKey(t.account), 'Wallet key is unavailable.');
    return this.store.change(id, ['draft'], { status: 'active' });
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      await this.reconcile();
      if (this.stopping || this.store.setting('paused', false)) return;
      for (const t of this.store.targets().filter(t => t.status === 'active' && t.mode === this.mode).reverse()) {
        if (this.stopping || this.store.setting('paused', false)) break;
        if (Date.now() > t.expiresAt) { this.store.change(t.id, ['active'], { status: 'expired' }); continue; }
        if (this.store.pending(t.account)) continue;
        try {
          let snapshot = await this.market.snapshot(t.account, t.token);
          if (!reached(t, snapshot)) continue;
          let amount = quantity(t.quantity, BigInt(snapshot.balanceRaw), snapshot.decimals);
          let plan: Plan = await this.market.quote(t, snapshot, amount);
          // Recheck balance, trigger, route and quote after preflight before claiming the target.
          let prepared = this.mode === 'live' ? await this.executor.prepare(plan.registration || plan) : null;
          snapshot = await this.market.snapshot(t.account, t.token);
          if (!reached(t, snapshot)) continue;
          amount = quantity(t.quantity, BigInt(snapshot.balanceRaw), snapshot.decimals);
          plan = await this.market.quote(t, snapshot, amount);
          if (this.mode === 'live') {
            // Registration is its own persisted transaction. The next tick rechecks the sell trigger.
            plan = plan.registration || plan;
            if (plan.kind === 'registration') assert(!this.store.executions().some(e => e.targetId === t.id && e.plan.kind === 'registration' && e.plan.output === plan.output && e.status === 'registered'), 'Registration was already paid for this target. Review the pair asset before continuing.');
            prepared = await this.executor.prepare(plan);
          }
          assert(Date.now() - snapshot.blockAt < 60000 && Date.now() - plan.quotedAt < 20000, 'Market snapshot is stale.', 'STALE');
          const current = this.store.target(t.id);
          if (this.stopping || this.store.setting('paused', false) || current?.status !== 'active' || Date.now() > current.expiresAt) continue;
          const execution = this.store.begin(current, plan);
          if (this.mode === 'paper') {
            this.store.finish(execution.id, 'simulated', { reason: 'Paper target triggered. No transaction was signed or sent.' });
            await this.announce(`PAPER target ${t.id} triggered for ${plan.symbol}. Simulated once; no tokens were sold.`); continue;
          }
          let signed;
          try {
            assert(prepared, 'Signing preflight is missing.');
            signed = await this.executor.sign(plan, prepared);
            // Commit the exact signed bytes and hash BEFORE any network submission.
            this.store.updateExecution(execution.id, { status: 'signed', hash: signed.hash, payload: signed.payload });
          } catch(e) {
            this.store.finish(execution.id, 'paused', { reason: safeError(e) }); continue;
          }
          try {
            this.store.updateExecution(execution.id, { status: 'pending', broadcastAt: Date.now() });
            const result = await this.executor.broadcast(signed);
            await this.accept(execution.id, result);
          } catch(e) {
            if (e instanceof AppError && e.code === 'INVALID_TRANSACTION') this.store.finish(execution.id, 'rejected', { reason: safeError(e) });
            else this.store.updateExecution(execution.id, { status: 'pending', reason: 'Submission outcome is unknown. Check this hash; do not repeat the sell.' });
            await this.announce(`Target ${t.id}: ${e instanceof AppError && e.code === 'INVALID_TRANSACTION' ? 'transaction rejected' : 'awaiting transaction confirmation'}.\nhttps://nearblocks.io/txns/${signed.hash}`);
          }
        } catch(e) {
          const message = safeError(e), latest = this.store.target(t.id);
          if (latest?.status === 'active') {
            this.store.note(t.id, message);
            if (latest.lastError !== message) await this.announce(`Target ${t.id} is waiting: ${message}`);
          }
        }
      }
    } finally { this.busy = false; }
  }
  async accept(id: string, result: TransactionResult) {
    const e = this.store.execution(id); assert(e, 'Execution not found.');
    const checked = outcome(result, e.plan);
    if (checked.status === 'pending') { this.store.updateExecution(id, { status: 'pending' }); return; }
    if (checked.status === 'uncertain') { this.store.updateExecution(id, checked); return; }
    this.store.finish(id, checked.status, checked);
    await this.announce(`Target ${e.targetId}: ${checked.status === 'filled' ? 'sell confirmed' : checked.status}.\n${checked.reason || (checked.status === 'registered' ? 'Pair-asset registration confirmed. The sell trigger will be rechecked.' : 'Payout verified in final transaction receipts.')}\nhttps://nearblocks.io/txns/${e.hash}`);
  }
  async reconcile() {
    for (const e of this.store.executions().filter(e => ['signed', 'pending', 'uncertain'].includes(e.status) && e.hash)) {
      try { await this.accept(e.id, await this.executor.rpc.status(e.hash!, e.account)); }
      catch { /* Unknown status never causes a new signature or re-broadcast. */ }
    }
  }
}
