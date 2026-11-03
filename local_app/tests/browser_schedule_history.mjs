import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(require.resolve('playwright',{paths:[process.env.BDO_NODE_MODULES||process.cwd()]}));
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const temp=await mkdtemp(join(tmpdir(),'bdo-schedule-history-browser-')),base='http://127.0.0.1:18794';
const out=process.env.BDO_SCHEDULE_REPORT_DIR;
assert.equal(await fetch(base+'/api/health').then(()=>true).catch(()=>false),false);
const server=spawn(process.env.PYTHON||'python',['-B','-c',`from local_app.backend.app import create_app;from waitress import serve;serve(create_app(${JSON.stringify(join(temp,'test.sqlite3'))},testing=True),host='127.0.0.1',port=18794)`],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,LOCALAPPDATA:temp,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}});
let browser;
const read=path=>fetch(base+path).then(async r=>{const body=await r.text();assert.ok(r.ok,body);return JSON.parse(body);});
async function wait(fn,label){for(let n=0;n<200;n++){try{if(await fn())return;}catch{}await delay(50);}throw Error('Timed out: '+label);}
try{
 await wait(()=>fetch(base+'/api/health').then(r=>r.ok),'test server');
 let boot=await read('/api/bootstrap');
 const patch=await fetch(base+'/api/inventory',{method:'PATCH',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({mutationId:crypto.randomUUID(),baseRevision:boot.revision,kind:'manual',patch:{items:Object.fromEntries(boot.inventory.map(i=>[i.programName,{stock:100,target:80}]))}})});
 assert.ok(patch.ok,await patch.text());
 browser=await chromium.launch({executablePath:process.env.BDO_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/barter/');await page.waitForFunction(()=>window.__bdoAppState&&document.querySelectorAll('.inventory-row').length===70);
 const before=await read('/api/bootstrap');
 await page.evaluate(async()=>{
  const state=window.__bdoAppState;
  state.session.scannedTrades=[{island:'베이루와 섬',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',reqAmount:1,count:5,yield:3,disabled:false,deleted:false}];
  const config=structuredClone({ship:state.settings.ship,parley:state.settings.parley,tuning:state.settings.tuning});
  config.ship.mode='none';state.session.config=config;state.session.remainingParley=1250000;
  if(!window.__bdoScheduleRuntime.generateSchedule(state,()=>{}))throw Error('generation failed');
  await (await import('/assets/js/persistence.js')).whenPersistenceIdle();
 });
 assert.equal((await read('/api/schedule-history')).cases,1);
 const saved=await read('/api/bootstrap');
 assert.deepEqual(saved.inventory,before.inventory);
 assert.equal(saved.workingSession.remainingParley,1250000);
 assert.ok(saved.workingSession.diagnostics.generationId);
 const generated=structuredClone(saved.workingSession.schedule);
 await page.evaluate(async()=>{
  const p=await import('/assets/js/persistence.js');const state=window.__bdoAppState;
  window.__bdoScheduleRuntime.generateSchedule(state,()=>{});await p.whenPersistenceIdle();
 });
 assert.equal((await read('/api/schedule-history')).cases,1,'same input must not create another case');
 assert.deepEqual((await read('/api/bootstrap')).workingSession.schedule,generated,'recording must not change the plan');
 await page.evaluate(async()=>{
  const s=window.__bdoAppState.session;s.schedule.speed[0].trades[0].execC--;
  window.dispatchEvent(new CustomEvent('bdo:session-changed'));
  await (await import('/assets/js/persistence.js')).whenPersistenceIdle();
 });
 assert.equal((await read('/api/schedule-history')).cases,1,'manual edits cannot replace the original generation');
 await page.reload();await page.waitForFunction(()=>window.__bdoAppState?.session?.schedule);
 assert.equal((await read('/api/schedule-history')).cases,1);
 assert.equal(await page.evaluate(()=>window.__bdoScheduleRuntime.scheduleRecordFor(window.__bdoScheduleRuntime.snapshotWorkingSession(window.__bdoAppState))),null,'restored session is not a fresh generation');
 if(process.env.BDO_SCHEDULE_CASE_PATH){
  const dataset=JSON.parse(await readFile(process.env.BDO_SCHEDULE_CASE_PATH,'utf8'));
  const input=dataset.cases[0].input;
  await page.evaluate(async input=>{
   const p=await import('/assets/js/persistence.js');
   await p.saveInventory(Object.fromEntries(input.inventory.map(i=>[i.programName,{stock:i.stock,target:i.target}])));
   await p.saveSettings({...input.settings,...input.config});
   const s=window.__bdoAppState.session;s.scannedTrades=input.scannedTrades;s.config=input.config;s.remainingParley=input.remainingParley;
   if(!window.__bdoScheduleRuntime.generateSchedule(window.__bdoAppState,()=>{}))throw Error('real-record replay generation failed');
   await p.whenPersistenceIdle();
  },input);
  assert.equal((await read('/api/schedule-history')).cases,2,'a full historical input must also be recorded');
 }
 assert.deepEqual(errors,[]);
 const report={ok:true,isolatedDatabase:true,automaticGenerationCase:true,repeatedGenerationDeduplicated:true,planUnchangedByRecording:true,userEditsDoNotReplaceOriginal:true,reloadDoesNotForgeGeneration:true,inventoryUnchanged:true,history:await read('/api/schedule-history')};
 if(out)await writeFile(join(out,'browser-history.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{
 await browser?.close();server.kill();await new Promise(r=>server.once('exit',r));await delay(200);
 if(temp.startsWith(tmpdir()))await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
