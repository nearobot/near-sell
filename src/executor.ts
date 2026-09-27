import type { RpcPort, TransactionResult, Plan, Outcome, AccessKey, AccountState, PreparedTransaction, SignedPayload } from './types.ts';
export type OutcomePlan = { kind: 'registration' } | { kind: 'curve' | 'ft'; output: string; account: string; minimumOut: string };
import * as near from 'near-api-js';
import { AppError, assert, DCL, RHEA, unsigned, YOCTO } from './core.ts';

export function outcome(result: TransactionResult, plan: OutcomePlan): Outcome {
  if (result?.final_execution_status !== 'FINAL') return { status: 'pending' };
  const outcomes = [result.transaction_outcome, ...(result.receipts_outcome || [])];
  if (result.status?.Failure || outcomes.some(r => r?.outcome?.status?.Failure)) return { status: 'needs_review', reason: 'A finalized receipt failed. Review the transaction; the bot will not repeat it.' };
  if (typeof result.status?.SuccessValue !== 'string') return { status: 'uncertain', reason: 'Final transaction result was incomplete.' };
  let value;
  try { value = JSON.parse(Buffer.from(result.status.SuccessValue, 'base64').toString()); } catch { value = null; }
  if (plan.kind === 'registration') return value && typeof value.total === 'string' && /^\d+$/.test(value.total) && BigInt(value.total) > 0n ? { status: 'registered' } : { status: 'needs_review', reason: 'Registration result could not be verified.' };
  if (plan.kind === 'curve' && plan.output === 'native.near') {
    if (typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) >= BigInt(plan.minimumOut)) return { status: 'filled', actualOut: value };
  }
  let output = 0n;
  for (const r of outcomes) {
    if (r?.outcome?.executor_id !== plan.output) continue;
    for (const log of r.outcome.logs || []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(log.slice(11));
        if (e.standard !== 'nep141' || e.event !== 'ft_transfer') continue;
        for (const item of e.data || []) if (item.new_owner_id === plan.account && typeof item.amount === 'string' && /^\d+$/.test(item.amount)) output += BigInt(item.amount);
      } catch { /* Ignore unrelated logs. */ }
    }
  }
  if (output >= BigInt(plan.minimumOut)) return { status: 'filled', actualOut: output.toString() };
  if (plan.kind === 'ft' && (value === '0' || value === 0) && output === 0n) return { status: 'refunded', reason: 'The swap refunded the tokens. Target stopped; it will not retry automatically.' };
  return { status: 'needs_review', reason: 'Transaction finalized, but the minimum payout could not be verified. Review its receipts before further trades.' };
}
export function validatePlan(plan: Plan) {
  if (plan.kind === 'registration') {
    assert(plan.method === 'storage_deposit' && plan.receiver === plan.output && plan.args.account_id === plan.account && plan.args.registration_only === true && plan.gas === '30000000000000' && unsigned(plan.deposit) > 0n && unsigned(plan.deposit) <= 10n ** 22n, 'Unexpected storage registration.');
    return;
  }
  assert(plan.receiver === plan.token && /\.(nearlytrade|umbrafun)\.near$/.test(plan.token), 'Unexpected sell receiver.');
  assert(plan.deposit === '1' && plan.gas === '250000000000000', 'Unexpected transaction funding.');
  assert(unsigned(plan.amount) > 0n && unsigned(plan.minimumOut) > 0n, 'Invalid sell amounts.');
  if (plan.method === 'sell') {
    assert(plan.kind === 'curve' && plan.token.endsWith('.umbrafun.near') && plan.args.amount === plan.amount && plan.args.min_out === plan.minimumOut, 'Unexpected curve sell.');
  } else {
    assert(plan.method === 'ft_transfer_call' && plan.kind === 'ft' && [DCL, RHEA].includes(plan.args.receiver_id) && plan.args.amount === plan.amount, 'Unexpected swap.');
    const msg = JSON.parse(plan.args.msg);
    if (plan.args.receiver_id === DCL) assert(msg.Swap?.output_token === plan.output && msg.Swap.min_output_amount === plan.minimumOut && !msg.Swap.swap_out_recipient, 'Unexpected DCL payout.');
    else assert(msg.actions?.length === 1 && msg.actions[0].token_out === plan.output && msg.actions[0].min_amount_out === plan.minimumOut && !msg.receiver_id, 'Unexpected Rhea payout.');
  }
}
export class Executor {
  rpc: RpcPort; keys: Map<string, near.KeyPair>;
  constructor(rpc: RpcPort, keys: Map<string, near.KeyPair>) { this.rpc = rpc; this.keys = keys; }
  hasKey(account: string) { return this.keys.has(account); }
  async prepare(plan: Plan): Promise<PreparedTransaction> {
    validatePlan(plan);
    const key = this.keys.get(plan.account); assert(key, 'Import this wallet locally before enabling live sells.');
    const [access, state, gas, config] = await Promise.all([
      this.rpc.query<AccessKey>({ request_type: 'view_access_key', account_id: plan.account, public_key: key.getPublicKey().toString() }),
      this.rpc.query<AccountState>({ request_type: 'view_account', account_id: plan.account }),
      this.rpc.call<{gas_price: string}>('gas_price', [null]),
      this.rpc.call<{storage_amount_per_byte: string}>('EXPERIMENTAL_protocol_config', { finality: 'final' })
    ]);
    assert(access.permission === 'FullAccess' && Number.isSafeInteger(access.nonce), 'Signing key or nonce could not be verified.');
    const storage = BigInt(state.storage_usage) * unsigned(config.storage_amount_per_byte);
    const held = storage > unsigned(state.locked) ? storage - unsigned(state.locked) : 0n;
    const required = BigInt(plan.gas) * unsigned(gas.gas_price) * 2n + YOCTO / 50n + unsigned(plan.deposit);
    assert(unsigned(state.amount) >= held + required, 'Not enough spendable NEAR for gas and the 0.02 NEAR reserve.');
    return { key, nonce: BigInt(access.nonce) + 1n, blockHash: access.block_hash };
  }
  async sign(plan: Plan, prepared: PreparedTransaction): Promise<SignedPayload> {
    validatePlan(plan);
    assert(Date.now() - plan.quotedAt < 20000 && Date.now() - plan.blockAt < 60000, 'The quote expired. Refresh the target.', 'STALE');
    const action = near.actions.functionCall(plan.method, plan.args, BigInt(plan.gas), BigInt(plan.deposit));
    const transaction = near.createTransaction(plan.account, prepared.key.getPublicKey(), plan.receiver, prepared.nonce, [action], near.baseDecode(prepared.blockHash));
    const { txHash, signedTransaction } = await new near.KeyPairSigner(prepared.key).signTransaction(transaction);
    return { hash: near.baseEncode(txHash), payload: Buffer.from(signedTransaction.encode()).toString('base64') };
  }
  broadcast(signed: SignedPayload): Promise<TransactionResult> { return this.rpc.call<TransactionResult>('send_tx', { signed_tx_base64: signed.payload, wait_until: 'NONE' }, { write: true }); }
}
