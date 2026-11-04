import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {replayCase} from '../../tools/scheduler/replay.mjs';
import {environment,audit} from './scheduler_departure_causality.mjs';
import vm from 'node:vm';
const same=(a,b)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
if(args.includes('--cases')){
 const records=JSON.parse(readFileSync(arg('--cases'))).cases,old=JSON.parse(readFileSync(arg('--baseline'))).results,results=[];
 for(const [i,r] of records.entries()){
  let audited=false;
  const next=replayCase(r,{postprocess:ctx=>{
   audited=true;
   for(const [mode,plan] of Object.entries(ctx.state.session.schedule))audit(plan,Object.fromEntries(r.input.inventory.map(v=>[v.programName,v])),
    r.input.config.ship.normalWeight,r.input.config.ship.maxWeight,mode,r.input.config.parley.normalCost,r.input.config.parley.crowCost,r.input.remainingParley);
  }});
  assert.equal(next.ok,old[i].ok);
  assert.equal(audited,next.ok,'successful generation must run the independent cargo audit');
  for(const [mode,s] of Object.entries(next.summary)){
   const a=old[i].summary[mode];same(s.plannedCounts,a.plannedCounts);same(s.generated,a.generated);same(s.consumed,a.consumed);
   same(s.endingInventory,a.endingInventory);assert.equal(s.parley,a.parley);assert.ok(s.minutes<=a.minutes+1e-8);assert.ok(s.departures<=a.departures);
   same(s.issues,[]);same(s.unmatchedSix,{});
   const main=p=>p.schedule.filter(v=>v.trades.some(t=>t.toTier===6||t.toTier===7));same(main(s),main(a));
   results.push({case:i+1,mode,departures:[a.departures,s.departures],minutes:[a.minutes,s.minutes],ms:next.elapsedMs});
  }
 }
 writeFileSync(arg('--out'),JSON.stringify({passed:true,inputs:records.length,results},null,2),{flag:'wx'});
 console.log(JSON.stringify({passed:true,inputs:records.length,plans:results.length,improved:results.filter(r=>r.minutes[1]<r.minutes[0]-1e-8).length,results:results.filter(r=>r.case===1)}));
}
{
 const {ctx,elements}=environment();elements.normalWeight.value=2000;elements.maxWeight.value=3400;
 vm.runInContext(`Object.assign(islandCoordinates,{'A':{x:1000,y:0},'B':{x:-1000,y:0},'일리야 섬':{x:0,y:0}});APP_CONFIG.SHIP_SPEED=100;APP_CONFIG.OVERLOAD_PENALTY=3;
 inventory={'inA':{stock:2,target:2},'inB':{stock:2,target:2}};
 function trip(island,index){const t={island,originalIndex:index,fromClean:'in'+island,toClean:'out'+island,fromTier:1,toTier:2,execC:2,reqA:1,mult:2};const sim=simulateWeightsTemp([t],2000);return {trades:[{...t,...sim.stepData[0]}],reqItems:getSortieCargoPlan([t]).reqItems,startWeight:sim.startW,totalTime:sim.totalTime,returnTime:sim.returnTime,returnOver:sim.returnOver,parleyUsed:20556};}
 original=[trip('A',0),trip('B',1)];next=improveLocalDepartureRoutes(original,'balance',inventory);`,ctx);
 assert.equal(ctx.next.length,2,'merge with slower overloaded return must be rejected');
 same(ctx.next,ctx.original);
 console.log('slower overloaded merge rejected');
}
