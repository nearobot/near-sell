import test from 'node:test';
import assert from 'node:assert/strict';
import { Rpc, jsonRequest } from '../src/network.ts';
import { Market } from '../src/market.ts';
import { rpcStub } from './helpers.ts';
import { diagnosticFetch } from '../src/diagnose.ts';

const response = (status: number, value: unknown = {}) => ({ok:status >= 200 && status < 300,status,json:async()=>value});

test('HTTP 500 reads fail over with the identical block and no leaked provider credentials',async()=>{
  const calls: {url: string; body: string; authorization?: string}[]=[];
  const rpc=new Rpc({urls:['https://free.rpc.fastnear.com','https://backup.example.org/private-key?auth=secret'],apiKey:'synthetic-key',fetchImpl:async(url,options)=>{
    calls.push({url,body:String(options?.body),authorization:(options?.headers as Record<string,string>).authorization});
    return url.includes('fastnear')?response(500):response(200,{result:'verified'});
  }});
  const params={request_type:'call_function',method_name:'get_pool',block_id:'fixed-final-block'};
  assert.equal(await rpc.call('query',params),'verified');assert.equal(calls.length,2);
  assert.equal(calls[0].body,calls[1].body);assert.equal(calls[0].authorization,'Bearer synthetic-key');assert.equal(calls[1].authorization,undefined);
  await rpc.call('query',params);assert.equal(calls.length,3);assert.ok(calls[2].url.includes('backup.example.org'));
});

test('submission selects a healthy provider once and never retries HTTP 500',async()=>{
  const methods: string[]=[];
  const rpc=new Rpc({urls:['https://down.example.org','https://healthy.example.org','https://third.example.org'],fetchImpl:async(url,options)=>{
    const method=JSON.parse(String(options?.body)).method;methods.push(new URL(url).host+' '+method);
    return url.includes('down.')||method==='send_tx'?response(500):response(200,{result:'ok'});
  }});
  await rpc.call('block',{finality:'final'});
  // Submission methods are guarded even if a future caller forgets write:true.
  await assert.rejects(rpc.call('send_tx',{signed_tx_base64:'synthetic'}),/HTTP 500/);
  assert.deepEqual(methods,['down.example.org block','healthy.example.org block','healthy.example.org send_tx']);
});

test('exhausted RPC errors identify providers and view method without URLs or request data',async()=>{
  const rpc=new Rpc({urls:['https://one.example.org/secret-a?api_key=secret-b','https://two.example.org/secret-c'],fetchImpl:async()=>response(500)});
  await assert.rejects(rpc.call('query',{method_name:'get_curve_state',args_base64:'secret-body'}),error=>{
    assert.ok(error instanceof Error);assert.match(error.message,/query\/get_curve_state/);
    assert.match(error.message,/one.example.org: HTTP 500/);assert.match(error.message,/two.example.org: HTTP 500/);
    assert.ok(!error.message.includes('secret'));return true;
  });
});

test('transient RPC internal errors can fail over but contract failures cannot',async()=>{
  let calls=0;
  const rpc=new Rpc({urls:['https://one.example.org','https://two.example.org'],fetchImpl:async()=>++calls===1?response(200,{error:{code:-32603}}):response(200,{result:'ok'})});
  assert.equal(await rpc.call('block',{finality:'final'}),'ok');assert.equal(calls,2);
  calls=0;
  const contract=new Rpc({urls:['https://one.example.org','https://two.example.org'],fetchImpl:async()=>{calls++;return response(200,{result:{error:'contract panic'}});}});
  await assert.rejects(contract.call('query',{}),/contract error/);assert.equal(calls,1);
});

test('GET price reads retry one transient failure; POST requests never retry',async()=>{
  let calls=0;
  const value=await jsonRequest('https://prices.example.org/secret',{}, {retryRead:true,context:'USD prices',fetchImpl:async()=>++calls===1?response(500):response(200,{price:'1'})});
  assert.deepEqual(value,{price:'1'});assert.equal(calls,2);
  calls=0;
  await assert.rejects(jsonRequest('https://rpc.example.org',{method:'POST'},{retryRead:true,fetchImpl:async()=>{calls++;return response(500);}}),/HTTP 500/);
  assert.equal(calls,1);
});

test('parallel token valuation shares one price request and one bounded recovery',async()=>{
  let calls=0;
  const market=new Market(rpcStub(),{fetchImpl:async()=>++calls===1?response(500):response(200,{'wrap.near':{price:'5',decimal:24,symbol:'wNEAR'}})});
  const values=await Promise.all([market.usd('wrap.near'),market.usd('native.near'),market.rates()]);
  assert.equal(calls,2);assert.equal(values[0].price,'5');assert.equal(values[1].price,'5');
});

test('price outage rejects stale cached prices and permits a later fresh recovery',async()=>{
  let calls=0,recovered=false;
  const market=new Market(rpcStub(),{fetchImpl:async()=>{calls++;return recovered?response(200,{'wrap.near':{price:'6',decimal:24,symbol:'wNEAR'}}):response(500);}});
  market.ratesCache={at:Date.now()-21000,prices:{'wrap.near':{price:'5',decimal:24,symbol:'wNEAR'}}};
  await assert.rejects(market.usd('wrap.near'),/Rhea USD prices via api.ref.finance returned HTTP 500/);
  assert.equal(calls,2);recovered=true;assert.equal((await market.usd('wrap.near')).price,'6');assert.equal(calls,3);
});

test('diagnosis blocks transaction requests and prints only safe request labels',async()=>{
  const lines: string[]=[];let calls=0;
  const fetchImpl=diagnosticFetch(line=>lines.push(line),async()=>{calls++;return response(500);});
  await assert.rejects(fetchImpl('https://provider.example.org/private-key?auth=secret',{method:'POST',body:JSON.stringify({method:'send_tx',params:{signed_tx_base64:'secret'}})}),/read-only/);
  assert.equal(calls,0);
  await fetchImpl('https://provider.example.org/private-key?auth=secret',{method:'POST',body:JSON.stringify({method:'query',params:{method_name:'get_curve_state',args_base64:'secret-body'}})});
  assert.deepEqual(lines,['provider.example.org | RPC query/get_curve_state | HTTP 500']);assert.equal(calls,1);
});
