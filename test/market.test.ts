import type { QuoteTarget } from '../src/market.ts';
import type { Snapshot } from '../src/types.ts';
import { rpcStub, testSnapshot } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Market } from '../src/market.ts';
import { raw, DCL, RHEA } from '../src/core.ts';
import { Rpc } from '../src/network.ts';

const target: QuoteTarget = { account: 'alice.near', token: 'test.nearlytrade.near', settlement: 'pair', slippageBps: 200, maxImpactBps: 5000 };
const snap = testSnapshot({ priceUsd: '1', route: {kind:'dcl', token: target.token, exchange: DCL, poolId:'test.nearlytrade.near|wrap.near|10000',output:'wrap.near',outSymbol:'wNEAR',outDecimals:24,outUsd:'1',sellTaxBps:100} });
const inflightFixture=JSON.parse(fs.readFileSync(new URL('./fixtures/public-nearly-inflight.json',import.meta.url),'utf8'));
function nearlyMarket(launch: unknown=inflightFixture.launch,pool: unknown=inflightFixture.pool){
  const rpc=rpcStub({view:async(contract,method)=>{
    if(method==='ft_metadata')return contract==='wrap.near'?{name:'Wrapped NEAR',symbol:'wNEAR',decimals:24}:inflightFixture.metadata;
    if(method==='get_launch_by_token')return launch;
    if(method==='get_pool')return pool;
    if(method==='get_tax')return inflightFixture.tax;
    if(method==='quote')return inflightFixture.quote;
    if(method==='storage_balance_of')return{total:'1'};
    throw new Error('Unexpected view: '+method);
  }});
  return new Market(rpc,{fetchImpl:async()=>({ok:true,status:200,json:async()=>({'wrap.near':{price:'1',decimal:24,symbol:'wNEAR'}})})});
}

test('completed Nearly launch remains tradable while factory inflight is true',async()=>{
  const market=nearlyMarket(),token=inflightFixture.launch.token;
  assert.equal(inflightFixture.launch.step,'Done');assert.equal(inflightFixture.launch.inflight,true);
  const details=await market.details(token,inflightFixture.block);
  const snapshot: Snapshot={...testSnapshot(),...details,token,block:inflightFixture.block};
  const quote=await market.quote({...target,token},snapshot,raw('1000',details.decimals));
  assert.equal(quote.expectedOut,inflightFixture.quote.amount);assert.equal(quote.output,'wrap.near');
  assert.equal(quote.kind,'ft');assert.equal(details.route.kind,'dcl');
});

test('Nearly still rejects missing, mismatched, failed and unfinished launches',async()=>{
  const token=inflightFixture.launch.token,block=inflightFixture.block;
  await assert.rejects(nearlyMarket(null).details(token,block),/no launch record/);
  await assert.rejects(nearlyMarket({...inflightFixture.launch,token:'other.nearlytrade.near'}).details(token,block),/different launch/);
  for(const step of ['Failed','Deploying','Pending',undefined,{}]){
    for(const inflight of [true,false]){
      await assert.rejects(nearlyMarket({...inflightFixture.launch,step,inflight}).details(token,block),/is not complete \(step:/);
    }
  }
});

test('completed Nearly launches require a running DCL pool with the exact pair identity',async()=>{
  const token=inflightFixture.launch.token,block=inflightFixture.block;
  for(const pool of [null,{...inflightFixture.pool,pool_id:'wrong'}, {...inflightFixture.pool,token_x:'other.nearlytrade.near'}, {...inflightFixture.pool,token_y:'other.near'}]){
    await assert.rejects(nearlyMarket(inflightFixture.launch,pool).details(token,block),/pool identity/);
  }
  for(const state of ['Paused','Stopped',undefined]){
    await assert.rejects(nearlyMarket(inflightFixture.launch,{...inflightFixture.pool,state}).details(token,block),/is not running \(state:/);
  }
});
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
