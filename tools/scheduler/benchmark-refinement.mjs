import {replayBaseline} from './baseline.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {replayCase} from './replay.mjs';
const [input,out]=process.argv.slice(2),all=JSON.parse(readFileSync(input)).cases.filter(c=>c.initial&&c.evaluationGroup==='development');
const selected=[0,4,9,14,19].map(i=>all[i]),times=[];
replayBaseline(selected[0]);replayCase(selected[0]);
for(const [index,c] of selected.entries())for(let repeat=0;repeat<3;repeat++){
 let a,b;if((index+repeat)%2){b=replayCase(c);a=replayBaseline(c);}else{a=replayBaseline(c);b=replayCase(c);}
 times.push({caseId:c.caseId,repeat,baselineMs:a.elapsedMs,candidateMs:b.elapsedMs});
}
const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
const summary={pairs:times.length,baselineMedianMs:median(times.map(t=>t.baselineMs)),candidateMedianMs:median(times.map(t=>t.candidateMs)),pairedDeltaMedianMs:median(times.map(t=>t.candidateMs-t.baselineMs)),pairedDeltaMaxMs:Math.max(...times.map(t=>t.candidateMs-t.baselineMs))};writeFileSync(out,JSON.stringify({summary,times},null,2),{flag:'wx'});console.log(JSON.stringify(summary));
