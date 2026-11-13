import {readFileSync,writeFileSync} from 'node:fs';import {replayCase} from './replay.mjs';
const [cases,out,caseId]=process.argv.slice(2),c=JSON.parse(readFileSync(cases)).cases.find(c=>c.caseId===caseId);
const path='barter/frontend/js/domain/routing.js',source=readFileSync(path,'utf8'),report=[];
for(const [interleave,multiway] of [[false,false],[true,false],[false,true],[true,true]]){
 const code=source.replace('true /* ENABLE_INTERLEAVING */',String(interleave)).replace('true /* ENABLE_MULTIWAY */',String(multiway));const result=replayCase(c,{sourceOverrides:{[path]:code}});report.push({interleave,multiway,plans:Object.fromEntries(Object.entries(result.summary).map(([m,s])=>[m,{departures:s.departures,minutes:s.minutes,issues:s.issues}]))});
}
writeFileSync(out,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report));
