import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../../../',import.meta.url));
export const loaded=page=>page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
export const saved=page=>page.waitForFunction(()=>document.querySelector('#status')?.dataset.kind==='success');
export async function startApp(port) {
 const temp=await mkdtemp(join(tmpdir(),'bdo-current-alchemy-')),base=`http://127.0.0.1:${port}`;
 assert.equal(await fetch(base+'/suite-health').then(()=>true).catch(()=>false),false,'isolated port occupied');
 let server,browser;
 const launch=()=>spawn(process.env.PYTHON??'python',['-B','-c',`from local_app.backend.app import create_app;create_app(${JSON.stringify(join(temp,'barter.sqlite3'))},testing=True).run(host='127.0.0.1',port=${port},use_reloader=False,threaded=True)`],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,LOCALAPPDATA:temp,PYTHONDONTWRITEBYTECODE:'1'}});
 const ready=async()=>{for(let i=0;i<120;i++){if(await fetch(base+'/suite-health').then(r=>r.ok).catch(()=>false))return;assert.equal(server.exitCode,null);await delay(100);}throw Error('server startup timeout');};
 const stop=async()=>{if(server?.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}};
 try {server=launch();await ready();browser=await chromium.launch({executablePath:process.env.BDO_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});}
 catch(e){await stop();await rm(temp,{recursive:true,force:true});throw e;}
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const read=path=>fetch(base+'/api/alchemy/'+path).then(r=>r.json());
 return {base,temp,browser,page,errors,read,
  async change(action,fields){const state=await read('state');const response=await fetch(base+'/api/alchemy/mutations/'+action,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({mutationId:crypto.randomUUID(),baseRevision:state.revision,...fields})});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;},
  async restart(){await stop();server=launch();await ready();await page.reload();await loaded(page);},
  async close(){await browser.close();await stop();assert.equal(resolve(temp,'..'),resolve(tmpdir()));await rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
 };
}
export async function openStart(page,{calls=5,tracking=true}={}) {
 await page.locator('#work-quantity').fill(String(calls));
 await page.locator('#work-start [data-start]').click();await page.locator('#start-form').waitFor();
 await page.locator('#start-form [name=calls]').fill(String(calls));
 await page.locator('#track-inventory').setChecked(tracking);
}
export async function finish(page,name,quantity,executed) {
 await page.locator('[data-finish]').first().click();
 if(executed!==undefined)await page.locator('#finish-form [name=executed_calls]').fill(String(executed));
 await page.getByRole('spinbutton',{name:name+' 실제 산출량',exact:true}).fill(String(quantity));
 await page.locator('#finish-form button[type=submit]').click();await saved(page);
}
