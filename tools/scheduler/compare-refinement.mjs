import {replayBaseline} from './baseline.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {replayCase} from './replay.mjs';
import {audit} from '../../local_app/tests/scheduler_departure_causality.mjs';
const [inputPath,group,outPath]=process.argv.slice(2);
const cases=JSON.parse(readFileSync(inputPath)).cases.filter(c=>c.evaluationGroup===group);
const results=[];
const same=(a,b)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
const counts=s=>{const r={};for(const v of s)for(const t of v.trades)if(!t.isWaypoint)r[t.originalIndex]=(r[t.originalIndex]||0)+t.execC;return r;};
for(const [index,c] of cases.entries()){
 const baseline=replayBaseline(c);
 const next=replayCase(c,{postprocess:ctx=>{for(const [mode,plan] of Object.entries(ctx.state.session.schedule))audit(plan,Object.fromEntries(c.input.inventory.map(i=>[i.programName,i])),c.input.config.ship.normalWeight,c.input.config.ship.maxWeight,mode,c.input.config.parley.normalCost,c.input.config.parley.crowCost,c.input.remainingParley);}});
 assert.equal(next.ok,baseline.ok);assert.equal(next.error,baseline.error);
 if(baseline.ok)for(const mode of ['speed','balance']){
  const a=baseline.summary[mode],b=next.summary[mode];
  same(a.plannedCounts,counts(c.recordedOutput.schedule[mode]));
  for(const key of ['plannedCounts','generated','consumed','endingInventory','parley','unmatchedSix'])same(b[key],a[key]);
  same(a.issues,[]);same(b.issues,[]);
  assert.ok(b.minutes<=a.minutes+1e-8);assert.ok(b.departures<=a.departures);
  const protectedTrips=s=>s.filter(v=>v.trades.some(t=>t.toTier===6||t.toTier===7));same(protectedTrips(a.schedule),protectedTrips(b.schedule));
 }
 results.push({caseId:c.caseId,sessionId:c.sessionId,initial:c.initial,mode:c.input.config.ship.mode,baseline,next});
 console.log(group,index+1,'/',cases.length);
}
const primary=results.filter(r=>r.initial),plans=primary.flatMap(r=>['speed','balance'].map(mode=>({caseId:r.caseId,mode,before:r.baseline.summary[mode],after:r.next.summary[mode]})));
const gains=plans.map(r=>({caseId:r.caseId,mode:r.mode,departures:[r.before.departures,r.after.departures],minutes:[r.before.minutes,r.after.minutes],saved:r.before.minutes-r.after.minutes}));
const report={group,sourceSha256:createHash('sha256').update(readFileSync('barter/frontend/js/domain/routing.js')).digest('hex'),cases:results.length,primarySessions:primary.length,improved:gains.filter(r=>r.saved>1e-8).length,unchanged:gains.filter(r=>r.saved<=1e-8).length,departureReductions:gains.filter(r=>r.departures[1]<r.departures[0]).length,gains,results};
writeFileSync(outPath,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({group,primarySessions:report.primarySessions,plans:plans.length,improved:report.improved,unchanged:report.unchanged,departureReductions:report.departureReductions}));
