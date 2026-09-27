import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FetchLike, Target } from './types.ts';
import { accountId, assert, quantity, raw, safeError, tokenTitle, unsigned } from './core.ts';
import { loadConfig, projectRoot } from './config.ts';
import type { Config } from './config.ts';
import { Rpc, providerHost, rpcOperation } from './network.ts';
import { Market } from './market.ts';

const READ_METHODS = new Set(['block', 'query', 'gas_price', 'EXPERIMENTAL_protocol_config']);
export function diagnosticFetch(log: (line: string) => void, fetchImpl: FetchLike = fetch): FetchLike {
  return async (url, options) => {
    const method = (options?.method || 'GET').toUpperCase();
    let operation = 'GET prices';
    if (method === 'POST') {
      const body = JSON.parse(String(options?.body)) as {method: string; params: unknown};
      assert(READ_METHODS.has(body.method), 'Diagnosis only permits read-only RPC calls.');
      operation = 'RPC ' + rpcOperation(body.method, body.params);
    } else assert(method === 'GET', 'Diagnosis only permits read-only requests.');
    const label = `${providerHost(url)} | ${operation}`;
    try {
      const response = await fetchImpl(url, options);
      log(`${label} | HTTP ${response.status}`); return response;
    } catch {
      log(`${label} | network error`);
      throw new Error('Diagnostic provider request failed.');
    }
  };
}

export async function diagnose(reference: string, config: Config = loadConfig()) {
  assert(reference, 'Usage: npm run diagnose -- TARGET_ID or npm run diagnose -- token.contract.near');
  let target: Target | undefined;
  if (/^[a-f0-9]{12}$/.test(reference)) {
    const file = path.join(projectRoot, 'data', 'bot.sqlite');
    assert(fs.existsSync(file), 'No target database found in this project. You can pass a token contract instead.');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare('SELECT body FROM targets WHERE id=?').get(reference);
      assert(row, 'Target not found in this project.'); target = JSON.parse(String(row.body)) as Target;
    } finally { db.close(); }
  }
  const token = accountId(target?.token ?? reference), account = target?.account ?? 'nearlytrade.near';
  console.log(`Read-only diagnosis: ${target ? tokenTitle(target) + ' | Target ' + target.id : token}`);
  console.log(target ? 'Using the saved target balance and sell settings.' : 'Using a public example account and an illustrative 1,000-token quote.');
  const fetchImpl = diagnosticFetch(line => console.log(line));
  const rpc = new Rpc({ urls: config.rpcUrls, apiKey: config.fastnearApiKey, fetchImpl });
  const market = new Market(rpc, { fetchImpl, fastnearApiKey: config.fastnearApiKey });
  let failed = false;
  try {
    const snapshot = await market.snapshot(account, token);
    const amount = target ? quantity(target.quantity, BigInt(snapshot.balanceRaw), snapshot.decimals) : raw('1000', snapshot.decimals);
    const plan = await market.quote(target ?? { account, token, settlement: 'pair', slippageBps: 200, maxImpactBps: 5000 }, snapshot, amount);
    console.log(`Quote OK: ${snapshot.symbol} -> ${plan.outSymbol}; route ${snapshot.route.kind}; registration ${plan.registration ? 'needed' : 'not needed'}.`);
  } catch (e) { failed = true; console.log('Snapshot/quote failed: ' + safeError(e)); }
  try {
    const state = await rpc.query<{amount: string}>({request_type:'view_account',account_id:account});
    unsigned(state.amount, 'NEAR account balance');
    const gas = await rpc.call<{gas_price: string}>('gas_price',[null]); unsigned(gas.gas_price,'NEAR gas price');
    const protocol = await rpc.call<{runtime_config: {storage_amount_per_byte: string}}>('EXPERIMENTAL_protocol_config',{finality:'final'});
    unsigned(protocol?.runtime_config?.storage_amount_per_byte,'NEAR storage price');
    console.log('Account, gas and protocol reads OK.');
  } catch (e) { failed = true; console.log('Preflight reads failed: ' + safeError(e)); }
  console.log('No vault opened, no signing, no transactions, no target changes.');
  if (failed) process.exitCode = 1;
}

if (import.meta.main) {
  try { await diagnose(process.argv[2] || ''); }
  catch (e) { console.error(safeError(e)); process.exitCode = 1; }
}
