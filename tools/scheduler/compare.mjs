import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
for(const name of ['--cases','--baseline','--candidate','--out'])if(!args.includes(name))throw Error(name+' required');
const root=args.includes('--metric-root')?arg('--metric-root'):resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const cases=new Map(JSON.parse(readFileSync(arg('--cases'),'utf8')).cases.map(c=>[c.caseId,c]));
const baseline=JSON.parse(readFileSync(arg('--baseline'),'utf8')).results;
const candidate=new Map(JSON.parse(readFileSync(arg('--candidate'),'utf8')).results.map(c=>[c.caseId,c]));
function commonMinutes(record,schedule){
 const ctx={};ctx.window=ctx;vm.createContext(ctx);
 for(const name of ['constants','routing'])vm.runInContext(readFileSync(resolve(root,'barter/frontend/js/domain/'+name+'.js'),'utf8'),ctx);
 ctx.applyBdoPersistentConfig({...record.input.settings,...record.input.config});
 return schedule.reduce((a,s)=>a+ctx.simulateWeightsTemp(s.trades,record.input.config.ship.normalWeight).totalTime,0);
}
function goals(s){
 const result={T7:0,coin:0};
 for(const t of s.schedule.flatMap(v=>v.trades)){
  if(t.toTier===7)result.T7+=t.execC*t.mult;
  if(t.toTier==='coin')result.coin+=t.execC*t.mult;
  if(t.toTier==='mat')result['material:'+t.toClean]=(result['material:'+t.toClean]||0)+t.execC*t.mult;
 }
 return result;
}
const results=[];
for(const old of baseline){
 const next=candidate.get(old.caseId),record=cases.get(old.caseId);
 if(!next||!record)throw Error('case mismatch');
 if(!old.ok||!next.ok){results.push({caseId:old.caseId,status:old.ok===next.ok?'BOTH_BLOCKED':'GENERATION_CHANGED',baselineNotices:old.notices,candidateNotices:next.notices});continue;}
 for(const mode of ['speed','balance']){
  const a=old.summary[mode],b=next.summary[mode],oldMinutes=commonMinutes(record,a.schedule),newMinutes=commonMinutes(record,b.schedule);
  const ag=goals(a),bg=goals(b),goalDelta=Object.fromEntries([...new Set([...Object.keys(ag),...Object.keys(bg)])].map(k=>[k,(bg[k]||0)-(ag[k]||0)]));
  const stockDelta=Object.fromEntries(record.input.inventory.filter(i=>i.stock!==null).map(i=>[i.programName,(b.endingInventory[i.programName]?.stock??i.stock)-(a.endingInventory[i.programName]?.stock??i.stock)]).filter(([k,v])=>v!==0));
  const deltas=[...Object.values(goalDelta),...Object.values(stockDelta),oldMinutes-newMinutes,a.departures-b.departures];
  let status=deltas.every(v=>Math.abs(v)<1e-9)?'EQUIVALENT':deltas.every(v=>v>=-1e-9)?'DOMINATES':deltas.every(v=>v<=1e-9)?'DOMINATED':'TRADEOFF';
  if(b.issues.length||Object.keys(b.unmatchedSix).length)status='CONSTRAINT_VIOLATION';
  results.push({caseId:old.caseId,mode,status,minutesUnderCommonModel:[oldMinutes,newMinutes],departures:[a.departures,b.departures],
    parley:[a.parley,b.parley],goalDelta,stockDelta});
 }
}
const summary={metricRoot:root,cases:baseline.length,results:Object.fromEntries([...new Set(results.map(r=>r.status))].map(s=>[s,results.filter(r=>r.status===s).length]))};
writeFileSync(arg('--out'),JSON.stringify({version:1,summary,results},null,2),{flag:'wx'});console.log(JSON.stringify(summary));
