import { Rpc } from '../src/network.ts';
import { Market } from '../src/market.ts';
import { AppError, raw, human } from '../src/core.ts';
const rpc = new Rpc(), market = new Market(rpc);
const cases = ['nearly-993927.nearlytrade.near', 'rich.nearlytrade.near', 'illia.nearlytrade.near', 'rheacat.nearlytrade.near', 'zecat.nearlytrade.near', 'jensen.nearlytrade.near', 'ucat.umbrafun.near', 'umbra.umbrafun.near'];
let failures = 0;
for (const token of cases) {
  try {
    const snapshot = await market.snapshot('nearlytrade.near', token);
    const plan = await market.quote({account:'nearlytrade.near',token,slippageBps:200,maxImpactBps:5000,settlement:'pair'}, snapshot, raw('1000',snapshot.decimals));
    console.log(JSON.stringify({ token, route:snapshot.route.kind, priceUsd:snapshot.priceUsd, marketCapUsd:snapshot.marketCapUsd, sell:'1000', expected:human(plan.expectedOut,plan.outDecimals), payout:plan.outSymbol, taxBps:snapshot.route.kind === 'dcl' ? snapshot.route.sellTaxBps : 0, registrationNeeded:!!plan.registration }));
  } catch(e) { failures++; console.log(JSON.stringify({token,error:e instanceof AppError ? e.code : 'ERROR',message:e instanceof Error ? e.message : 'Unknown failure'})); }
}
const d = await market.discover('nearlytrade.near');
console.log(JSON.stringify({discoveryCount:d.tokens.length,warning:d.warning}));
if (!d.tokens.length || d.warning) failures++;
console.log(`Read-only check: ${cases.length - failures}/${cases.length} route checks; no keys loaded, no signing, no transactions.`);
process.exitCode = failures ? 1 : 0;
