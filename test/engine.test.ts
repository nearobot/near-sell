import type { EngineDependencies } from '../src/engine.ts';
import type { TargetConfig, Mode, Snapshot, RegistrationPlan } from '../src/types.ts';
import { rpcStub, testSnapshot, testPlan, testPrepared } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as near from 'near-api-js';
import { Store, acquireProcessLock } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { Executor, outcome, validatePlan } from '../src/executor.ts';
import { AppError, raw, human, minOut } from '../src/core.ts';

const targetInput: TargetConfig = { account: 'alice.near', token: 'test.umbrafun.near', metric: 'holding', direction: 'gte', threshold: '100', quantity: { kind: 'percent', value: '25' }, slippageBps: 200, maxImpactBps: 1500, settlement: 'pair', mode: 'live' };
const snapshot = testSnapshot;
const plan = testPlan;
const protocolConfig = JSON.parse(fs.readFileSync(new URL('./fixtures/public-protocol-config.json', import.meta.url), 'utf8')).result;
const final = () => ({ final_execution_status:'FINAL', status:{SuccessValue:Buffer.from(JSON.stringify(raw('25').toString())).toString('base64')}, receipts_outcome:[] });
function harness(mode: Mode = 'live') {
  const store=new Store(); store.addWallet('alice.near'); let broadcasts=0, signs=0;
  const market: EngineDependencies['market'] = {snapshot:async()=>snapshot(),quote:async(t,s,a)=>plan(a)};
  const executor: EngineDependencies['executor'] = {hasKey:()=>true,prepare:async()=>testPrepared(),sign:async()=>{signs++;return {hash:'synthetic-hash',payload:'synthetic-payload'};},broadcast:async()=>{broadcasts++;return final();},rpc:{status:async()=>final()}};
  const engine=new Engine({store,market,executor,mode});
  return {store,market,executor,engine,get broadcasts(){return broadcasts;},get signs(){return signs;}};
}
async function arm(h: ReturnType<typeof harness>) { const {target}=await h.engine.create(targetInput);h.engine.arm(target.id);return target; }
test('a reached live target is signed and submitted only once across repeated ticks',async()=>{
  const h=harness(), t=await arm(h); await h.engine.tick();await h.engine.tick();
  assert.equal(h.broadcasts,1);assert.equal(h.store.target(t.id)!.status,'filled'); h.store.close();
});
test('paper mode never signs; paper targets cannot execute after a live restart',async()=>{
  const h=harness('paper'), t=await arm(h);await h.engine.tick();assert.equal(h.signs,0);assert.equal(h.broadcasts,0);assert.equal(h.store.target(t.id)!.status,'simulated');
  const {target:pending}=await h.engine.create(targetInput);h.engine.arm(pending.id);h.engine.mode='live';await h.engine.tick();assert.equal(h.broadcasts,0);h.store.close();
});
test('timeout persists signed bytes and blocks another rule on the wallet',async()=>{
  const h=harness(), t=await arm(h);await arm(h);h.executor.broadcast=async()=>{throw new AppError('Timed out','NETWORK');};h.executor.rpc.status=async()=>{throw new AppError('Unknown','UNKNOWN_TRANSACTION');};
  await h.engine.tick();await h.engine.tick();assert.equal(h.signs,1);assert.equal(h.store.pending('alice.near'),true);
  const e=h.store.executions()[0];assert.equal(e.hash,'synthetic-hash');assert.equal(e.payload,'synthetic-payload');assert.equal(h.store.target(t.id)!.status,'executing');h.store.close();
});
test('late final confirmation reconciles without a new signature',async()=>{
  const h=harness(),t=await arm(h);h.executor.broadcast=async()=>({final_execution_status:'INCLUDED'});await h.engine.tick();assert.equal(h.store.pending('alice.near'),true);
  await h.engine.tick();assert.equal(h.signs,1);assert.equal(h.store.target(t.id)!.status,'filled');h.store.close();
});
test('a trigger that disappears during preflight does not execute',async()=>{
  const h=harness(),t=await arm(h);let count=0;h.market.snapshot=async()=>({...snapshot(),priceUsd:++count===1?'2':'0.1'});await h.engine.tick();assert.equal(h.signs,0);assert.equal(h.store.target(t.id)!.status,'active');h.store.close();
});
test('global pause and per-target cancellation prevent execution',async()=>{
  const h=harness(),t=await arm(h);h.store.set('paused',true);await h.engine.tick();assert.equal(h.signs,0);h.store.change(t.id,['active'],{status:'cancelled'});h.store.set('paused',false);await h.engine.tick();assert.equal(h.signs,0);h.store.close();
});
test('overlapping ticks never execute the same target twice',async()=>{
  const h=harness();await arm(h);await Promise.all([h.engine.tick(),h.engine.tick(),h.engine.tick()]);assert.equal(h.signs,1);h.store.close();
});
test('replayed activation callback is rejected',async()=>{
  const h=harness(),t=await arm(h);assert.throws(()=>h.engine.arm(t.id));h.store.close();
});
test('unknown price and failed quote do not sign or imply zero balance',async()=>{
  const h=harness();await arm(h);h.market.snapshot=async()=>({...snapshot(),priceUsd:null} as unknown as Snapshot);await h.engine.tick();assert.equal(h.signs,0);assert.match(h.store.targets()[0].lastError ?? '',/price/);h.store.close();
});
test('SQLite restart keeps a signed pending transaction unresolved',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'near-bot-test-')), file=path.join(dir,'state.sqlite');
  const s=new Store(file),t=s.createTarget(targetInput);s.change(t.id,['draft'],{status:'active'});const e=s.begin(s.target(t.id)!,plan());s.updateExecution(e.id,{status:'signed',hash:'synthetic',payload:'bytes'});s.close();
  const again=new Store(file);again.recover();assert.equal(again.pending('alice.near'),true);assert.equal(again.execution(e.id)!.payload,'bytes');again.close();
});
test('restart before signing pauses that target and permits review',()=>{
  const s=new Store(),t=s.createTarget(targetInput);s.change(t.id,['draft'],{status:'active'});s.begin(s.target(t.id)!,plan());s.recover();assert.equal(s.pending('alice.near'),false);assert.equal(s.target(t.id)!.status,'paused');s.close();
});
test('success with zero tokens consumed is a refund, not a fill',()=>{
  const p={...plan(),kind:'ft' as const,output:'wrap.near'};
  const r={...final(),status:{SuccessValue:Buffer.from('"0"').toString('base64')}};assert.equal(outcome(r,p).status,'refunded');
});
test('final FT payout requires matching token contract and recipient',()=>{
  const p={...plan(),kind:'ft' as const,output:'wrap.near'};
  const event={standard:'nep141',event:'ft_transfer',data:[{old_owner_id:'v2.ref-finance.near',new_owner_id:'alice.near',amount:raw('25').toString()}]};
  const r={...final(),receipts_outcome:[{outcome:{executor_id:'wrong.near',logs:['EVENT_JSON:'+JSON.stringify(event)]}}]};
  assert.equal(outcome(r,p).status,'needs_review');r.receipts_outcome[0].outcome.executor_id='wrap.near';assert.equal(outcome(r,p).status,'filled');
  event.data[0].new_owner_id='mallory.near';r.receipts_outcome[0].outcome.logs=['EVENT_JSON:'+JSON.stringify(event)];assert.equal(outcome(r,p).status,'needs_review');
});
test('failed receipt prevents a success claim and blocks the wallet for review',()=>{
  const r={...final(),receipts_outcome:[{outcome:{status:{Failure:{}}}}]};assert.equal(outcome(r,plan()).status,'needs_review');
  const s=new Store(),t=s.createTarget(targetInput);s.change(t.id,['draft'],{status:'active'});const e=s.begin(s.target(t.id)!,plan());s.finish(e.id,'needs_review');assert.equal(s.pending('alice.near'),true);s.close();
});
test('executor produces a verifiable NEAR signature for only the reviewed sell',async()=>{
  const key=near.KeyPair.fromRandom('ed25519'),p=plan(),executor=new Executor(rpcStub(),new Map([['alice.near',key]]));
  const signed=await executor.sign(p,{key,nonce:1n,blockHash:near.baseEncode(new Uint8Array(32))});
  const tx=near.SignedTransaction.decode(Buffer.from(signed.payload,'base64'));
  assert.equal(tx.transaction.receiverId,p.token);assert.equal(tx.transaction.signerId,'alice.near');
  assert.equal(tx.transaction.actions[0].functionCall!.methodName,'sell');
  assert.deepEqual(JSON.parse(Buffer.from(tx.transaction.actions[0].functionCall!.args).toString()),p.args);
  await assert.rejects(executor.sign({...p,quotedAt:Date.now()-30000},{key,nonce:1n,blockHash:near.baseEncode(new Uint8Array(32))}));
  assert.throws(()=>validatePlan({...p,receiver:'mallory.near'}));
});
test('storage registration is capped and cannot redirect the beneficiary',()=>{
  const p: RegistrationPlan = {token: 'test.umbrafun.near', symbol: 'TEST', outSymbol: 'wNEAR', quotedAt: Date.now(), blockAt: Date.now(), kind:'registration',account:'alice.near',receiver:'wrap.near',output:'wrap.near',method:'storage_deposit',args:{account_id:'alice.near',registration_only:true},gas:'30000000000000',deposit:raw('0.00125').toString()};
  validatePlan(p);assert.throws(()=>validatePlan({...p,deposit:raw('1').toString()}));assert.throws(()=>validatePlan({...p,args:{...p.args,account_id:'mallory.near'}}));
});
test('registration confirms once and then the original target sells on a fresh tick',async()=>{
  const h=harness(), t=await arm(h);let registered=false;
  const registration: RegistrationPlan = {kind:'registration',account:'alice.near',token:t.token,receiver:'wrap.near',output:'wrap.near',outSymbol:'wNEAR',symbol:'TEST',method:'storage_deposit',args:{account_id:'alice.near',registration_only:true},gas:'30000000000000',deposit:raw('0.00125').toString(),quotedAt:Date.now(),blockAt:Date.now()};
  h.market.quote=async()=>({...plan(),registration:registered?null:registration});
  h.executor.broadcast=async()=>{if(!registered){registered=true;return{...final(),status:{SuccessValue:Buffer.from(JSON.stringify({total:raw('0.00125').toString(),available:'0'})).toString('base64')}};}return final();};
  await h.engine.tick();assert.equal(h.store.target(t.id)!.status,'active');assert.equal(h.store.executions()[0].status,'registered');
  await h.engine.tick();assert.equal(h.store.target(t.id)!.status,'filled');assert.equal(h.signs,2);h.store.close();
});
test('repeated missing registration cannot spend its storage deposit twice',async()=>{
  const h=harness(),t=await arm(h);const registration: RegistrationPlan = {kind:'registration',account:'alice.near',token:t.token,receiver:'wrap.near',output:'wrap.near',outSymbol:'wNEAR',symbol:'TEST',method:'storage_deposit',args:{account_id:'alice.near',registration_only:true},gas:'30000000000000',deposit:raw('0.00125').toString(),quotedAt:Date.now(),blockAt:Date.now()};
  h.market.quote=async()=>({...plan(),registration});h.executor.broadcast=async()=>({...final(),status:{SuccessValue:Buffer.from(JSON.stringify({total:'1'})).toString('base64')}});
  await h.engine.tick();await h.engine.tick();assert.equal(h.signs,1);assert.match(h.store.target(t.id)!.lastError ?? '',/already paid/);h.store.close();
});
test('disk failure before recording signed bytes prevents broadcast',async()=>{
  const h=harness();await arm(h);const save=h.store.updateExecution.bind(h.store);
  h.store.updateExecution=(id,changes)=>{if(changes.status==='signed')throw new Error('synthetic disk failure');return save(id,changes);};
  await h.engine.tick();assert.equal(h.broadcasts,0);assert.equal(h.store.targets()[0].status,'paused');h.store.close();
});
test('shutdown during preflight prevents starting a new transaction',async()=>{
  const h=harness();await arm(h);h.executor.prepare=async()=>{h.engine.stopping=true;return testPrepared();};
  await h.engine.tick();assert.equal(h.signs,0);h.store.close();
});
test('exclusive database lock blocks a second process session and releases cleanly',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'near-bot-lock-')),file=path.join(dir,'process.sqlite');
  const release=acquireProcessLock(file);assert.throws(()=>acquireProcessLock(file),/Another/);release();const releaseAgain=acquireProcessLock(file);releaseAgain();
});
test('preflight reserves storage, gas and NEAR buffer; rejects low balances',async()=>{
  const key=near.KeyPair.fromRandom('ed25519');let amount=raw('1').toString();
  const rpc=rpcStub({query:async q=>q.request_type==='view_access_key'?{permission:'FullAccess',nonce:100,block_hash:near.baseEncode(new Uint8Array(32))}:{amount,locked:'0',storage_usage:1000},call:async m=>m==='gas_price'?{gas_price:'100000000'}:protocolConfig});
  const executor=new Executor(rpc,new Map([['alice.near',key]]));assert.equal((await executor.prepare(plan())).nonce,101n);
  amount=raw('0.01').toString();await assert.rejects(executor.prepare(plan()),/spendable NEAR/);
  // 0.01 storage + 0.05 buffered gas + 0.02 reserve + the one-yocto deposit.
  amount=raw('0.08').toString();await assert.rejects(executor.prepare(plan()),/spendable NEAR/);
  amount=(raw('0.08')+1n).toString();assert.equal((await executor.prepare(plan())).nonce,101n);
});

test('live monitoring passes real executor preflight with the public nested protocol response',async t=>{
  const h=harness();t.after(()=>h.store.close());
  const rpc=rpcStub({
    query:async q=>q.request_type==='view_access_key'?{permission:'FullAccess',nonce:100,block_hash:near.baseEncode(new Uint8Array(32))}:{amount:raw('1').toString(),locked:'0',storage_usage:1000},
    call:async method=>method==='gas_price'?{gas_price:'100000000'}:protocolConfig,
  });
  const executor=new Executor(rpc,new Map([['alice.near',near.KeyPair.fromRandom('ed25519')]]));
  h.executor.prepare=executor.prepare.bind(executor);
  const originalSign=h.executor.sign;
  h.executor.sign=async(p,prepared)=>{assert.equal(prepared.nonce,101n);return originalSign(p,prepared);};
  const target=await arm(h);await h.engine.tick();await h.engine.tick();
  assert.equal(h.store.target(target.id)?.status,'filled');assert.equal(h.signs,1);assert.equal(h.broadcasts,1);
});

test('invalid protocol storage prices block live signing with a specific field error',async t=>{
  const badConfigs: unknown[]=[null,{}, {storage_amount_per_byte:'10000000000000000000'}, {runtime_config:null}, {runtime_config:{}},
    ...[null,10000000000000000000,'1e19','1.5','-1',''].map(value=>({runtime_config:{storage_amount_per_byte:value}}))];
  for(const config of badConfigs){
    const h=harness();t.after(()=>h.store.close());
    const rpc=rpcStub({
      query:async q=>q.request_type==='view_access_key'?{permission:'FullAccess',nonce:1,block_hash:near.baseEncode(new Uint8Array(32))}:{amount:raw('1').toString(),locked:'0',storage_usage:1000},
      call:async method=>method==='gas_price'?{gas_price:'100000000'}:config,
    });
    const executor=new Executor(rpc,new Map([['alice.near',near.KeyPair.fromRandom('ed25519')]]));
    h.executor.prepare=executor.prepare.bind(executor);
    const target=await arm(h);await h.engine.tick();
    assert.match(h.store.target(target.id)?.lastError??'',/NEAR storage price \(runtime_config\.storage_amount_per_byte\)/);
    assert.equal(h.store.target(target.id)?.status,'active');assert.equal(h.store.executions().length,0);
    assert.equal(h.signs,0);assert.equal(h.broadcasts,0);
  }
});
test('historical public Umbra sell receipt is recognized without signing or broadcasting',()=>{
  const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/public-ucat-sell.json',import.meta.url),'utf8'));
  const checked=outcome(fixture,{kind:'curve',account:'0xhaimio.near',output:'native.near',minimumOut:'1'});
  assert.equal(checked.status,'filled');assert.equal(checked.actualOut,'7633995866302075482791804');
});
