import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export function replayCase(record,{sourceRoot=ROOT}={}){
 const input=structuredClone(record.input),elements=Object.fromEntries(['normalWeight','maxWeight','maxParley','parleyPerTrade','parleyCrow'].map(name=>[name,{value:0}]));
 const notices=[];
 const ctx={console:{log(){},warn(){}},document:{getElementById:id=>elements[id]||null,querySelector:()=>null,querySelectorAll:()=>[]},
  alert:m=>notices.push(m),renderModeColumn(){},CustomEvent:class{},dispatchEvent(){},crypto:globalThis.crypto,
  setTimeout,clearTimeout,setInterval(){},clearInterval(){}};
 ctx.window=ctx;vm.createContext(ctx);
 const files={};
 for(const name of ['constants','routing','scheduler','tier7','schedule-edit','timer-ui','completion','scheduler-runtime']){
  const path='barter/frontend/js/domain/'+name+'.js',code=readFileSync(resolve(sourceRoot,path),'utf8');
  files[path]=createHash('sha256').update(code).digest('hex');vm.runInContext(code,ctx,{filename:path});
 }
 ctx.state={inventory:input.inventory,settings:{...input.settings,...input.config},revision:input.inputRevision,
  session:{id:record.sessionId,scannedTrades:input.scannedTrades,config:input.config,remainingParley:input.remainingParley}};
 const start=performance.now();
 let ok=false,error=null;
 try{ok=ctx.__bdoScheduleRuntime.generateSchedule(ctx.state,m=>notices.push(m));}catch(e){error=e.message;}
 const elapsedMs=performance.now()-start,summary={};
 for(const [mode,sorties] of Object.entries(ctx.state.session.schedule||{})){
  const generated={},consumed={},plannedCounts={},issues=[];
  for(const s of sorties)for(const t of s.trades){
   if(t.isWaypoint)continue;
   generated[t.toClean]=(generated[t.toClean]||0)+t.execC*t.mult;
   consumed[t.fromClean]=(consumed[t.fromClean]||0)+t.execC*t.reqA;
   plannedCounts[t.originalIndex]=(plannedCounts[t.originalIndex]||0)+t.execC;
  }
  for(const [i,count] of Object.entries(plannedCounts))if(count>input.scannedTrades[i].count)issues.push('source-count:'+i);
  const validation=ctx.validateSortieSequence(sorties,Object.fromEntries(input.inventory.map(i=>[i.programName,i])));
  if(!validation.valid)issues.push(...validation.issues);
  let actualCost=0;
  for(const s of sorties){
   const sim=ctx.simulateWeightsTemp(s.trades,input.config.ship.normalWeight);
   const cost=s.trades.reduce((a,t)=>a+(t.isWaypoint?0:t.execC*(t.isCoin?input.config.parley.crowCost:input.config.parley.normalCost)),0);
   actualCost+=cost;
   if(cost!==s.parleyUsed)issues.push('parley-summary');
   if(sim.startW>input.config.ship.normalWeight||sim.peakW>(mode==='speed'?input.config.ship.normalWeight:input.config.ship.maxWeight))issues.push('weight');
  }
  if(actualCost>input.remainingParley)issues.push('parley-budget');
  const unmatchedSix={};
  for(const s of sorties)for(const t of s.trades){
   if(t.toTier===6)unmatchedSix[t.toClean]=(unmatchedSix[t.toClean]||0)+t.execC*t.mult;
   if(t.toTier===7&&t.fromTier===6)unmatchedSix[t.fromClean]=(unmatchedSix[t.fromClean]||0)-t.execC*t.reqA;
  }
  summary[mode]={departures:sorties.length,minutes:sorties.reduce((a,s)=>a+s.totalTime,0),parley:actualCost,
   generated,consumed,plannedCounts,unmatchedSix:Object.fromEntries(Object.entries(unmatchedSix).filter(([k,v])=>v)),
   endingInventory:ctx.forecastWarehouseInventory(sorties,Object.fromEntries(input.inventory.map(i=>[i.programName,i]))),issues,
   schedule:sorties.map(s=>({trades:s.trades.map(t=>Object.fromEntries(['island','originalIndex','fromClean','toClean','fromTier','toTier','execC','reqA','mult','isCoin','isChained'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]]))),reqItems:s.reqItems,startWeight:s.startWeight,totalTime:s.totalTime,parleyUsed:s.parleyUsed}))};
 }
 return {caseId:record.caseId,sessionId:record.sessionId,offerGroup:record.offerGroup,ok,error,notices,elapsedMs,engineFiles:files,summary};
}

function main(){
 const args=process.argv.slice(2),get=name=>args[args.indexOf(name)+1];
 if(!args.includes('--cases')||!args.includes('--out'))throw Error('--cases and --out required');
 const cases=JSON.parse(readFileSync(get('--cases'),'utf8')).cases;
 const results=cases.map(record=>replayCase(record,{sourceRoot:args.includes('--source-root')?get('--source-root'):ROOT}));
 const report={version:1,sourceRoot:args.includes('--source-root')?get('--source-root'):ROOT,results,
  summary:{cases:results.length,successful:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).map(r=>({caseId:r.caseId,error:r.error,notices:r.notices})),
   constraintIssues:results.flatMap(r=>Object.entries(r.summary).flatMap(([mode,s])=>s.issues.map(issue=>({caseId:r.caseId,mode,issue}))))}};
 writeFileSync(get('--out'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report.summary));
}
if(resolve(process.argv[1]||'')===fileURLToPath(import.meta.url))main();
