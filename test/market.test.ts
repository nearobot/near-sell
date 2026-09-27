import type { QuoteTarget } from '../src/market.ts';
import type { Snapshot } from '../src/types.ts';
import { rpcStub, testSnapshot } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../src/market.ts';
import { raw, DCL, RHEA } from '../src/core.ts';
import { Rpc } from '../src/network.ts';

const target: QuoteTarget = { account: 'alice.near', token: 'test.nearlytrade.near', settlement: 'pair', slippageBps: 200, maxImpactBps: 5000 };
const snap = testSnapshot({ priceUsd: '1', route: {kind:'dcl', token: target.token, exchange: DCL, poolId:'test.nearlytrade.near|wrap.near|10000',output:'wrap.near',outSymbol:'wNEAR',outDecimals:24,outUsd:'1',sellTaxBps:100} });
test('Nearly sell tax is deducted before DCL quote; full amount is passed to ft_transfer_call',async()=>{
  const calls: {c: string; m: string; a: Record<string, unknown>}[] = [];
  const rpc=rpcStub({view:async(c,m,a)=>{calls.push({c,m,a});if(m==='quote')return {amount:raw('98').toString()};if(m==='storage_balance_of')return{total:raw('0.00125').toString()};throw new Error(m);}});
  const plan=await new Market(rpc).quote(target,snap,raw('100',18));
  assert.ok(plan.kind === 'ft');
  assert.equal(calls[0].a.input_amount,raw('99',18).toString());assert.equal(plan.args.amount,raw('100',18).toString());
  assert.equal(JSON.parse(plan.args.msg).Swap.min_output_amount,raw('96.04').toString());assert.equal(JSON.parse(plan.args.msg).Swap.output_token,'wrap.near');
});
test('unregistered pair asset produces a capped registration plan; RPC failure is not treated as unregistered',async()=>{
  const rpc=rpcStub({view:async(c,m)=>m==='quote'?{amount:raw('98').toString()}:m==='storage_balance_of'?null:{min:raw('0.00125').toString()}});
  const plan=await new Market(rpc).quote(target,snap,raw('100',18));assert.ok(plan.registration);assert.equal(plan.registration.receiver,'wrap.near');assert.equal(plan.registration.args.account_id,'alice.near');
  const broken=rpcStub({view:async(c,m)=>{if(m==='quote')return{amount:raw('98').toString()};throw new Error('offline');}});
  await assert.rejects(new Market(broken).quote(target,snap,raw('100',18)));
});
test('graduated Rhea plan explicitly keeps output in the pair asset',async()=>{
  const rpc=rpcStub({view:async(c,m,a)=>{assert.equal(c===RHEA||c==='linear-protocol.near',true);return m==='get_return'?raw('98').toString():{total:'1'};}});
  const s: Snapshot = {...snap,route:{...snap.route,kind:'rhea',exchange:RHEA,poolId:8691,output:'linear-protocol.near',outSymbol:'LINEAR'}};
  const plan=await new Market(rpc).quote({...target,token:'test.umbrafun.near'},s,raw('100',18));
  assert.ok(plan.kind === 'ft');const msg=JSON.parse(plan.args.msg);assert.equal(msg.skip_unwrap_near,true);assert.equal(msg.actions[0].token_out,'linear-protocol.near');
});

test('malformed quote amounts identify the field and never coerce imprecise JSON numbers',async()=>{
  const rhea: Snapshot={...snap,route:{...snap.route,kind:'rhea',exchange:RHEA,poolId:8691,output:'linear-protocol.near',outSymbol:'LINEAR'}};
  for(const value of [undefined,null,1000000000000000000000000,'1e24','-1','1.5']){
    const dclRpc=rpcStub({view:async()=>({amount:value})});
    await assert.rejects(new Market(dclRpc).quote(target,snap,raw('100',18)),/DCL sell quote \(quote.amount\)/);
    const rheaRpc=rpcStub({view:async()=>value});
    await assert.rejects(new Market(rheaRpc).quote({...target,token:'test.umbrafun.near'},rhea,raw('100',18)),/Rhea sell quote \(get_return\)/);
  }
});
test('price impact limit prevents an unexpectedly poor sell',async()=>{
  const rpc=rpcStub({view:async()=>({amount:raw('10').toString()})});
  await assert.rejects(new Market(rpc).quote({...target,maxImpactBps:1000},snap,raw('100',18)),/impact/);
});
test('discovery failure is reported as incomplete, never as an empty complete wallet',async()=>{
  const market=new Market(rpcStub(), {fetchImpl:async()=>{throw new Error('offline');}});
  const d=await market.discover('alice.near',['test.nearlytrade.near']);assert.equal(d.tokens.length,1);assert.match(d.warning ?? '',/incomplete/);
});
test('RPC read failures can use a fallback; submission is never retried',async()=>{
  let count=0;const fetchImpl=async()=>{count++;throw new Error('timeout');};
  const rpc=new Rpc({urls:['https://example.org/rpc1','https://example.org/rpc2'],fetchImpl});
  await assert.rejects(rpc.call('query',{}));assert.equal(count,2);
  count=0;await assert.rejects(rpc.call('send_tx',{signed_tx_base64:'synthetic'},{write:true}));assert.equal(count,1);
});
test('stale block timestamps prevent automated valuation',async()=>{
  const rpc=new Rpc({fetchImpl:async()=>({ok:true,status:200,json:async()=>({result:{header:{hash:'old',height:1,timestamp_nanosec:String(BigInt(Date.now()-120000)*1000000n)}}})})});
  await assert.rejects(rpc.block(),/stale/);
});
