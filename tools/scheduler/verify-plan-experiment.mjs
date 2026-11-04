import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {replayCase} from './replay.mjs';
import {independentCheck,improveRoutes,metrics} from './plan-experiment.mjs';

const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
const records=JSON.parse(readFileSync(arg('--cases'),'utf8')).cases;
const baseline=JSON.parse(readFileSync(arg('--baseline'),'utf8')).results;
const experiment=JSON.parse(readFileSync(arg('--experiment'),'utf8'));
const checks=[],selected=[];
const same=(a,b)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
const preserved=s=>Object.fromEntries(['departures','minutes','parley','generated','consumed','plannedCounts','unmatchedSix','endingInventory'].map(k=>[k,s[k]]));
for(const [i,record] of records.entries()){
 const base=baseline[i],exp=experiment.results[i];
 const plain=replayCase(record);
 assert.equal(plain.ok,base.ok);same(plain.summary,base.summary);
 if(!plain.ok){checks.push({case:i+1,defaultUnchanged:true,blocked:true});continue;}
 const variants=[...new Set(Object.values(exp.comparisons).flatMap(c=>Object.values(c.selected).map(s=>s.variant)))];
 for(const variant of variants){
  const options=experiment.variants.find(v=>v.name===variant)?.options||null;
  const result=variant==='baseline'?plain:replayCase(record,{experiment:options,postprocess:(ctx,r)=>{
   independentCheck(ctx,r);improveRoutes(ctx,r);independentCheck(ctx,r);
   for(const sorties of Object.values(ctx.state.session.schedule))for(const s of sorties){
    const cargo=ctx.getSortieCargoPlan(s.trades);
    s.trades.forEach((t,j)=>assert.equal(!!t.isChained,!!cargo.chained[j]));
   }
  }});
  assert.equal(result.ok,true);
  for(const [mode,c] of Object.entries(exp.comparisons))for(const [profile,s] of Object.entries(c.selected)){
   if(s.variant!==variant)continue;
   const actual=result.summary[mode];
   same(preserved(actual),preserved(s.summary));
   same(actual.schedule.map(s=>s.trades.map(t=>[t.originalIndex,t.execC,t.island])),
    s.summary.schedule.map(s=>s.trades.map(t=>[t.originalIndex,t.execC,t.island])));
   const m=metrics(actual,record),a=metrics(base.summary[mode],record);
   for(const [name,n] of Object.entries(a.tier7Items))assert.ok((m.tier7Items[name]||0)>=n);
   if(profile==='safe')same(m.counts,a.counts);
   selected.push({case:i+1,caseId:record.caseId,mode,profile,variant,metrics:m,summary:actual});
  }
 }
 checks.push({case:i+1,defaultUnchanged:true,verifiedVariants:variants});
 console.log(JSON.stringify(checks.at(-1)));
}
writeFileSync(arg('--out'),JSON.stringify({checks,selected},null,2),{flag:'wx'});
console.log(JSON.stringify({defaultUnchanged:checks.length,selectedPlansVerified:selected.length,passed:true}));
