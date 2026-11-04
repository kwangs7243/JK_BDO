import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {replayCase} from './replay.mjs';
import {audit} from '../../local_app/tests/scheduler_departure_causality.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const inventoryOf=r=>Object.fromEntries(r.input.inventory.map(i=>[i.programName,i]));
export function independentCheck(ctx,record){
 const input=record.input,initial=inventoryOf(record);
 for(const [mode,sorties] of Object.entries(ctx.state.session.schedule||{})){
  const result=audit(sorties,initial,input.config.ship.normalWeight,input.config.ship.maxWeight,mode,
   input.config.parley.normalCost,input.config.parley.crowCost,input.remainingParley);
  const counts={};
  for(const s of sorties){
   const pair={};
   for(const t of s.trades){
    if(t.isWaypoint)throw Error('unexpected waypoint');
    if(!Number.isSafeInteger(t.execC)||t.execC<=0)throw Error('execution count');
    counts[t.originalIndex]=(counts[t.originalIndex]||0)+t.execC;
    if(t.toTier===5&&t.execC!==t.origC)throw Error('split tier5');
    if(t.toTier===6)pair[t.toClean]=(pair[t.toClean]||0)+t.execC*t.mult;
    if(t.toTier===7&&t.fromTier===6)pair[t.fromClean]=(pair[t.fromClean]||0)-t.execC*t.reqA;
   }
   if(Object.values(pair).some(v=>v!==0))throw Error('unpaired tier6');
  }
  for(const [i,n] of Object.entries(counts))if(n>input.scannedTrades[i].count)throw Error('offer exhausted');
  const forecast=ctx.forecastWarehouseInventory(sorties,initial);
  for(const item of input.inventory)if(result.endingStock[item.programName]!==forecast[item.programName]?.stock)throw Error('independent inventory mismatch:'+item.programName);
 }
}

function rebuild(ctx,s,trades,normal){
 const sim=ctx.simulateWeightsTemp(trades,normal),cargo=ctx.getSortieCargoPlan(trades);
 return {...s,trades:trades.map((t,i)=>({...t,isChained:!!cargo.chained[i],...sim.stepData[i]})),reqItems:cargo.reqItems,
  startWeight:sim.startW,totalTime:sim.totalTime,returnOver:sim.returnOver,returnTime:sim.returnTime};
}
export function improveRoutes(ctx,record){
 const normal=record.input.config.ship.normalWeight,initial=inventoryOf(record);
 let trials=0,accepted=0;
 for(const [mode,sorties] of Object.entries(ctx.state.session.schedule||{})){
  for(let si=0;si<sorties.length;si++){
   let best=sorties[si];
   // Preserve the entire fixed main leg. Only improve its ordinary return tail.
   const lastAnchor=best.trades.findLastIndex(t=>t.toTier===6||t.toTier===7
    ||ctx.getIslandCoords(t.island)?.isOcean||(t.isCoin&&!t.isRandomCoin));
   const begin=lastAnchor+1,n=best.trades.length;
   if(n-begin<2)continue;
   for(let pass=0;pass<3;pass++){
    let winner=null;
    for(let i=begin;i<n;i++)for(let j=begin;j<n;j++){
     if(i===j)continue;
     const routes=[];
     const moved=best.trades.slice();moved.splice(j,0,moved.splice(i,1)[0]);routes.push(moved);
     if(i<j){const reversed=best.trades.slice();reversed.splice(i,j-i+1,...reversed.slice(i,j+1).reverse());routes.push(reversed);}
     for(const order of routes){
      trials++;
      const candidate=rebuild(ctx,best,order,normal);
      if(candidate.totalTime>=(winner||best).totalTime-1e-8)continue;
      const limit=mode==='speed'?normal:record.input.config.ship.maxWeight;
      if(candidate.startWeight>normal||candidate.trades.some(t=>t.afterW>limit)||candidate.returnOver&&mode==='speed')continue;
      let allowed=true;
      for(let ti=0;ti<order.length;ti++){
       const t=order[ti],c=ctx.getIslandCoords(t.island)||{x:0,y:0};
       const before=ti?candidate.trades[ti-1].afterW:candidate.startWeight;
       const prev=ti?(ctx.getIslandCoords(order[ti-1].island)||{x:0,y:0}):{x:0,y:0};
       if(before>normal&&(((t.isCoin||c.isOcean)&&c.x<800&&!t.island.includes('파딕스'))
        ||prev.x>=-500&&c.x< -500||prev.x<=500&&c.x>500)){allowed=false;break;}
      }
      if(!allowed)continue;
      const plan=sorties.map((s,i)=>i===si?candidate:s);
      if(!ctx.validateSortieSequence(plan,initial).valid)continue;
      try{audit(plan,initial,normal,record.input.config.ship.maxWeight,mode,
       record.input.config.parley.normalCost,record.input.config.parley.crowCost,record.input.remainingParley);}catch{continue;}
      winner=candidate;
     }
    }
    if(!winner)break;
    best=winner;sorties[si]=best;accepted++;
   }
  }
 }
 for(const sorties of Object.values(ctx.state.session.schedule||{}))for(let i=0;i<sorties.length;i++)
  sorties[i]=rebuild(ctx,sorties[i],sorties[i].trades,normal);
 ctx.__routeSearch={trials,accepted};
}

export function metrics(summary,record){
 const goals={tier7:0,coin:0},tier7Items={},special={},produced={},used={},counts={};let actions=0;
 for(const s of summary.schedule)for(const t of s.trades){
  actions+=t.execC;
  counts[t.originalIndex]=(counts[t.originalIndex]||0)+t.execC;
  if(t.toTier===7)goals.tier7+=t.execC*t.mult;
  if(t.toTier===7)tier7Items[t.toClean]=(tier7Items[t.toClean]||0)+t.execC*t.mult;
  if(t.toTier==='coin')goals.coin+=t.execC*t.mult;
  if(t.toTier==='mat')special[t.toClean]=(special[t.toClean]||0)+t.execC*t.mult;
  if(Number.isInteger(t.toTier))produced[t.toTier]=(produced[t.toTier]||0)+t.execC*t.mult;
  if(Number.isInteger(t.fromTier))used[t.fromTier]=(used[t.fromTier]||0)+t.execC*t.reqA;
 }
 const stockByTier={},deficitByTier={},stock={};
 for(const i of record.input.inventory){
  const n=summary.endingInventory[i.programName]?.stock;
  if(n===null||n===undefined)continue;
  stock[i.programName]=n;
  stockByTier[i.tier]=(stockByTier[i.tier]||0)+n;
  deficitByTier[i.tier]=(deficitByTier[i.tier]||0)+Math.max(0,i.target-n);
 }
 return {...goals,tier7Items,special,produced,used,counts,stock,stockByTier,deficitByTier,actions,minutes:summary.minutes,
  departures:summary.departures,parley:summary.parley};
}
const vectorDelta=(a,b)=>Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(k=>[k,(b[k]||0)-(a[k]||0)]).filter(([k,v])=>v!==0));
function difference(a,b){return {minutes:b.minutes-a.minutes,departures:b.departures-a.departures,parley:b.parley-a.parley,
 tier7:b.tier7-a.tier7,coin:b.coin-a.coin,special:vectorDelta(a.special,b.special),stock:vectorDelta(a.stock,b.stock),
 stockByTier:vectorDelta(a.stockByTier,b.stockByTier),deficitByTier:vectorDelta(a.deficitByTier,b.deficitByTier)};}
function nondecreasing(a,b){return Object.keys(a).every(k=>(b[k]||0)>=a[k]);}
function safeImprovement(base,m){return m.tier7>=base.tier7&&nondecreasing(base.tier7Items,m.tier7Items)&&m.coin>=base.coin&&nondecreasing(base.special,m.special)
 &&nondecreasing(base.stock,m.stock)&&m.departures<=base.departures&&m.minutes<=base.minutes+1e-8;}
function scalarShortage(m){return Object.values(m.deficitByTier).reduce((a,n)=>a+n,0);}
function choose(candidates,base,profile){
 const viable=candidates.filter(c=>c.m.tier7>=base.tier7&&nondecreasing(base.tier7Items,c.m.tier7Items)&&c.m.coin>=base.coin&&nondecreasing(base.special,c.m.special));
 if(profile==='safe')return viable.filter(c=>safeImprovement(base,c.m)).sort((a,b)=>a.m.minutes-b.m.minutes||a.m.departures-b.m.departures)[0];
 if(profile==='shortage')return viable.sort((a,b)=>scalarShortage(a.m)-scalarShortage(b.m)||a.m.minutes-b.m.minutes)[0];
 if(profile==='fast')return viable.sort((a,b)=>a.m.minutes-b.m.minutes||scalarShortage(a.m)-scalarShortage(b.m))[0];
 throw Error(profile);
}

async function main(){
 const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
 const records=JSON.parse(readFileSync(arg('--cases'),'utf8')).cases;
 const old=new Map(JSON.parse(readFileSync(arg('--baseline'),'utf8')).results.map(r=>[r.caseId,r]));
 const variants=[{name:'route-only',options:{}},
  {name:'balanced-restock',options:{balancedRestock:true}},
  {name:'protect-tier4',options:{balancedRestock:true,preserveT4:true}},
  {name:'target-only',options:{targetOnly:true}},
  {name:'balanced-target',options:{balancedRestock:true,preserveT4:true,targetOnly:true}},
  {name:'coin-yield',options:{coinYield:true}}];
 for(const regionOrder of [['east','south','west'],['west','east','south'],['west','south','east'],['south','east','west'],['south','west','east']])
  variants.push({name:'region-'+regionOrder.join('-'),options:{regionOrder}});
 const out=[],start=performance.now();
 for(const [index,record] of records.entries()){
  const baseline=old.get(record.caseId),candidates=[],rejected=[];
  if(baseline.ok)for(const variant of variants){
   if(!record.input.config.ship.mode.startsWith('t7')&&(variant.options.regionOrder||variant.options.coinYield))continue;
   let checkError=null,search=null;
   const result=replayCase(record,{sourceRoot:ROOT,experiment:variant.options,postprocess:(ctx,r)=>{
    try{independentCheck(ctx,r);improveRoutes(ctx,r);independentCheck(ctx,r);search=ctx.__routeSearch;}
    catch(e){checkError=e.message;}
   }});
   if(!result.ok||checkError||Object.values(result.summary).some(s=>s.issues.length||Object.keys(s.unmatchedSix).length)){
    rejected.push({variant:variant.name,checkError,error:result.error,issues:Object.fromEntries(Object.entries(result.summary).map(([m,s])=>[m,s.issues]))});continue;
   }
   candidates.push({variant:variant.name,options:variant.options,result,search});
  }
  const comparisons={};
  if(baseline.ok)for(const mode of ['speed','balance']){
   const base=metrics(baseline.summary[mode],record);
   const pool=[{variant:'baseline',m:base,summary:baseline.summary[mode]},...candidates.map(c=>({variant:c.variant,m:metrics(c.result.summary[mode],record),summary:c.result.summary[mode]}))];
   const selected={};
   for(const profile of ['safe','shortage','fast']){
    const winner=choose(pool,base,profile);
    selected[profile]={variant:winner.variant,metrics:winner.m,delta:difference(base,winner.m),summary:winner.summary};
   }
   comparisons[mode]={baseline:base,selected,candidates:pool.map(c=>({variant:c.variant,metrics:c.m,delta:difference(base,c.m)}))};
  }
  out.push({caseId:record.caseId,sessionId:record.sessionId,offerGroup:record.offerGroup,provenance:record.provenance,
   mode:record.input.config.ship.mode,remainingParley:record.input.remainingParley,blocked:!baseline.ok,
   comparisons,rejected,candidateTiming:candidates.map(c=>({variant:c.variant,ms:c.result.elapsedMs,search:c.search})),
   baselineMs:baseline.elapsedMs});
  console.log(JSON.stringify({case:index+1,total:records.length,mode:record.input.config.ship.mode,candidates:candidates.length,rejected:rejected.length,
   selected:Object.fromEntries(Object.entries(comparisons).map(([mode,s])=>[mode,Object.fromEntries(Object.entries(s.selected).map(([p,c])=>[p,{variant:c.variant,minutes:c.delta.minutes,stock:c.delta.stockByTier,special:c.delta.special}]))]))}));
 }
 writeFileSync(arg('--out'),JSON.stringify({version:1,baselineCommit:'118af4dd7b47eb38b329fb1ccf779d0f64e40367',variants,
  elapsedMs:performance.now()-start,results:out},null,2),{flag:'wx'});
}
if(resolve(process.argv[1]||'')===fileURLToPath(import.meta.url))main();
