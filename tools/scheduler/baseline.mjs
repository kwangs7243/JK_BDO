import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {replayCase} from './replay.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const revision='v1.1.0';
let sources;
export function replayBaseline(record){
 sources??=Object.fromEntries(['constants','routing','scheduler','tier7','schedule-edit','timer-ui','completion','scheduler-runtime'].map(name=>{
  const path='barter/frontend/js/domain/'+name+'.js';
  return [path,execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'-C',root,'show',revision+':'+path],{encoding:'utf8',windowsHide:true})];
 }));
 return replayCase(record,{sourceOverrides:sources});
}
