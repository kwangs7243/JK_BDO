import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.BDO_NODE_MODULES?require.resolve('playwright',{paths:[process.env.BDO_NODE_MODULES]}):'playwright');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),temp=await mkdtemp(join(tmpdir(),'bdo-stock-browser-'));
const out=process.env.BDO_ALCHEMY_REPORT_DIR??join(temp,'report'),base='http://127.0.0.1:18793';
assert.equal(await fetch(base+'/suite-health').then(()=>true).catch(()=>false),false,'test port occupied');
const server=spawn(process.env.PYTHON??'python',['-B','-c',`from local_app.backend.app import create_app;from waitress import serve;serve(create_app(${JSON.stringify(join(temp,'barter.sqlite3'))},testing=True),host='127.0.0.1',port=18793)`],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,LOCALAPPDATA:temp,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}});
let browser;
const read=()=>fetch(base+'/api/alchemy/state').then(r=>r.json());
async function change(changes){const s=await read();const r=await fetch(base+'/api/alchemy/mutations/inventory',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({baseRevision:s.revision,mutationId:crypto.randomUUID(),changes})});assert.equal(r.status,200);}
try{
  for(let n=0;n<120;n++){if(await fetch(base+'/suite-health').then(r=>r.ok).catch(()=>false))break;await delay(100);}
  const catalog=await fetch(base+'/api/alchemy/catalog?full=1').then(r=>r.json());
  const ids=Object.fromEntries(catalog.items.map(i=>[i.name,i.item_id]));
  const recipe=catalog.recipes.find(r=>r.output_item_id===ids['맑은 액체 시약']);
  await change(recipe.inputs.map(i=>({item_id:i.item_id,quantity:20})));
  browser=await chromium.launch({executablePath:process.env.BDO_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>{errors.push('native '+d.type());void d.dismiss();});
  await page.goto(base+'/alchemy/recipes/'+ids['맑은 액체 시약']);
  await page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
  const open=async()=>{await page.locator('#work-start [data-start]').click();await page.locator('#start-form').waitFor();await page.locator('#track-inventory').check();};
  await open();
  const calls=page.locator('#start-form [name=calls]'),salt=page.locator(`[data-start-stock][data-item="${ids['소금']}"]`);
  const start=page.getByRole('button',{name:'작업 시작',exact:true});
  const save=page.locator('#save-start-stock'),reload=page.locator('#reload-start-stock');
  const stored=()=>page.waitForFunction(()=>document.querySelector('#save-start-stock').disabled&&document.querySelector('#status')?.dataset.kind==='success'&&!document.querySelector('#retry-start-stock').checkVisibility());
  await calls.fill('5');await salt.fill('0');assert.equal(await start.isDisabled(),true);
  await save.click();await stored();
  assert.equal((await read()).inventory[ids['소금']],0);assert.equal((await read()).jobs.length,0);
  assert.equal(await calls.inputValue(),'5');assert.equal(await page.locator('#work-dialog').evaluate(e=>e.open),true);
  assert.equal(await start.isDisabled(),true);
  await salt.fill('20');await save.click();await stored();assert.equal(await start.isEnabled(),true);
  await salt.fill('');await save.click();await stored();assert.equal((await read()).inventory[ids['소금']],null);assert.equal(await start.isDisabled(),true);
  await salt.fill('1.5');assert.equal(await save.isDisabled(),true);await reload.click();await page.waitForFunction(id=>document.querySelector(`[data-start-stock][data-item="${id}"]`).value==='',ids['소금']);
  await salt.fill('20');await save.click();await stored();
  // Cancel discards only edits made since the last explicit stock save.
  await salt.fill('3');await page.locator('#start-form [data-close]').click();
  await page.locator('.suite-feedback-cancel').click();assert.equal(await salt.inputValue(),'3');
  await page.locator('#start-form [data-close]').click();await page.locator('.suite-feedback-accept').click();
  assert.equal((await read()).inventory[ids['소금']],20);
  await open();await calls.fill('5');
  // Optimistic revision conflicts cannot silently overwrite a second window's quantity.
  await salt.fill('25');await change([{item_id:ids['소금'],quantity:33}]);await save.click();
  await page.waitForFunction(()=>document.querySelector('#start-stock-status')?.textContent.includes('다른 창'));
  assert.equal((await read()).inventory[ids['소금']],33);assert.equal(await save.isDisabled(),true);
  await reload.click();await page.waitForFunction(id=>document.querySelector(`[data-start-stock][data-item="${id}"]`).value==='33',ids['소금']);assert.equal(await calls.inputValue(),'5');
  // A committed response lost in transit is retried with the original mutation ID.
  let lost=false;
  await page.route('**/api/alchemy/mutations/inventory',async route=>{const response=await route.fetch();if(!lost){lost=true;await route.abort('failed');}else await route.fulfill({response});});
  const before=await read();await salt.fill('40');await save.click();
  await page.locator('#retry-start-stock').waitFor({state:'visible'});assert.equal(await salt.isDisabled(),true);
  await page.locator('#retry-start-stock').click();await stored();
  const after=await read();assert.equal(after.revision,before.revision+1);assert.equal(after.inventory[ids['소금']],40);
  await page.unroute('**/api/alchemy/mutations/inventory');
  // A substitute is saved under its own item ID, preserving the original ingredient.
  const slot=recipe.inputs.find(i=>i.alternatives?.length);
  if(slot){const alternate=slot.alternatives[0];await page.locator(`[data-substitute="${slot.item_id}"]`).selectOption(alternate.item_id);const input=page.locator(`[data-start-stock][data-item="${alternate.item_id}"]`);await input.fill('50');await save.click();await stored();assert.equal((await read()).inventory[alternate.item_id],50);assert.equal((await read()).inventory[slot.item_id],20);}
  while(await page.locator('.suite-toast-close').count()) await page.locator('.suite-toast-close').first().click();
  await mkdir(out,{recursive:true});await page.screenshot({path:join(out,'start-stock-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(out,'start-stock-mobile.png'),fullPage:true});
  assert.ok(await page.locator('#work-dialog').evaluate(e=>e.getBoundingClientRect().width<=innerWidth));
  await page.setViewportSize({width:1440,height:1000});
  await start.click();await page.waitForFunction(()=>!document.querySelector('#work-dialog').open);
  const final=await read();assert.equal(final.jobs.length,1);assert.equal(final.jobs[0].calls,5);assert.equal(final.inventory[ids['소금']],35);
  assert.deepEqual(errors,[]);
  const result={passed:true,stockSavedWithoutStarting:true,zeroAndUnknown:true,invalidBlocked:true,cancellation:true,conflict:true,lostResponseIdempotent:true,substitute:true,callsPreserved:true,startDeductedOnce:true,errors};
  await writeFile(join(out,'stock-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();server.kill();await delay(300);if(dirname(temp)!==resolve(tmpdir()))throw Error('unsafe temp path');await rm(temp,{recursive:true,force:true,maxRetries:6,retryDelay:200});}
