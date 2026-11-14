import assert from 'node:assert/strict';import {startApp} from './helpers/alchemy_workbench.mjs';
const app=await startApp(18748),{page,base,errors}=app;
const ready=()=>page.waitForFunction(()=>document.querySelector('#app-content')?.getAttribute('aria-busy')==='false');
const idle=()=>page.evaluate(async()=>await(await import('/assets/js/persistence.js')).whenPersistenceIdle());
const boot=()=>fetch(base+'/api/bootstrap').then(r=>r.json());
try{
 await page.route('**/api/bootstrap',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'initial offline'}})}));await page.goto(base+'/barter/');await ready();assert.ok(await page.getByRole('button',{name:'불러오기 재시도',exact:true}).isVisible());await page.unroute('**/api/bootstrap');await page.getByRole('button',{name:'불러오기 재시도',exact:true}).click();await page.waitForFunction(()=>window.__bdoAppState.inventory.length===70);await page.locator('#open-schedule').click();await idle();assert.ok(await page.locator('#trade-session-panel').isVisible());assert.equal((await boot()).workingSession,null);
 await page.evaluate(async()=>{await(await import('/assets/js/persistence.js')).saveInventory({'갈퀴 꽃 씨앗 주머니':{stock:100},'괴생물 촉수':{stock:0}});await(await import('/assets/js/trade-ui.js')).applyLiveTradeRows(['베이루와 섬','레마 섬','에베토 섬'].map(island=>({island,fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',reqAmount:1,count:3,yield:3})),'new');});
 await page.locator('#open-schedule').click();await page.waitForFunction(()=>!!window.__bdoAppState.session.schedule&&!document.querySelector('#brief-recalculate').disabled);await idle();
 // Server commits the plan but its response is corrupt. Do not roll the local plan back.
 let lost=true;const bodies=[];
 await page.route('**/api/working-session',async route=>{if(route.request().method()!=='PUT')return route.continue();bodies.push(route.request().postData());if(lost){lost=false;await route.fetch();return route.fulfill({status:200,contentType:'application/json',body:'broken'});}return route.continue();});
 await page.locator('#brief-recalculate').click();await idle();assert.ok(await page.locator('#persistence-recovery').isVisible());assert.equal(await page.evaluate(()=>window.__bdoAppState.session.diagnostics.generatedAt),(await boot()).workingSession.diagnostics.generatedAt);
 const protectedId=(await boot()).workingSession.id;assert.equal(await page.evaluate(async()=>{try{await(await import('/assets/js/persistence.js')).resetWorkingSession();return false;}catch{return true;}}),true);assert.equal((await boot()).workingSession.id,protectedId);await page.reload();await ready();assert.ok(await page.locator('#persistence-recovery').isVisible());await page.locator('#persistence-recovery button').click();await idle();await page.waitForFunction(()=>document.querySelector('#persistence-recovery').hidden);assert.equal(bodies[0],bodies[1]);await page.unroute('**/api/working-session');
 // Autosave failure remains dirty, blocks completion/recalculation, and is retryable.
 await page.route('**/api/working-session',r=>r.request().method()==='PUT'?r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'injected lock'}})}):r.continue());
 await page.locator('[data-workspace-view=session]').click();await page.locator('tr.trade-row:not(.trade-deleted) .trade-toggle input').first().uncheck();await idle();assert.equal(await page.evaluate(()=>window.__bdoAppState.sessionUnsaved),true);const old=(await boot()).workingSession.diagnostics.generatedAt;await page.locator('#open-schedule').click();await idle();assert.equal((await boot()).workingSession.diagnostics.generatedAt,old);assert.ok(await page.locator('#persistence-recovery').isVisible());await page.unroute('**/api/working-session');await page.locator('#persistence-recovery button').click();await idle();assert.equal(await page.evaluate(()=>window.__bdoAppState.sessionUnsaved),false);
 // A confirmed save whose follow-up GET fails must not resend that mutation.
 const countBefore=bodies.length;await page.route('**/api/bootstrap',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'reload failure'}})}));
 const committed=await page.evaluate(async()=>{try{await(await import('/assets/js/persistence.js')).saveInventory({'괴생물 촉수':{stock:7}});}catch(e){return !!e.committed;}});assert.equal(committed,true);
 await page.locator('#open-settings').click();
 await page.waitForFunction(()=>document.querySelector('#persistence-recovery')?.parentElement?.id==='settings-dialog');
 assert.ok(await page.locator('#settings-dialog #persistence-recovery button').isVisible());
 await page.locator('#settings-dialog [data-close-dialog]').click();
 await page.waitForFunction(()=>document.querySelector('#persistence-recovery')?.parentElement===document.body);
 await page.locator('#persistence-recovery button').click();await idle();assert.ok(await page.locator('#persistence-recovery').isVisible());await page.unroute('**/api/bootstrap');await page.locator('#persistence-recovery button').click();await idle();assert.equal((await boot()).inventory.find(i=>i.programName==='괴생물 촉수').stock,7);assert.equal(bodies.length,countBefore);
 // Recovering an unrelated inventory save must not discard an earlier failed session edit.
 await page.locator('[data-workspace-view=session]').click();
 await page.route('**/api/working-session',r=>r.request().method()==='PUT'?r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'session save failure'}})}):r.continue());
 await page.locator('tr.trade-row:not(.trade-deleted) .trade-toggle input').first().check();await idle();
 assert.equal(await page.evaluate(()=>window.__bdoAppState.sessionUnsaved),true);
 const unsavedRows=await page.evaluate(()=>JSON.stringify(window.__bdoAppState.session.scannedTrades));
 await page.route('**/api/bootstrap',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'read failure'}})}));
 assert.equal(await page.evaluate(async()=>{try{await(await import('/assets/js/persistence.js')).saveInventory({'괴생물 촉수':{stock:8}});}catch(e){return !!e.committed;}}),true);
 await page.unroute('**/api/bootstrap');await page.locator('#persistence-recovery button').click();await idle();
 assert.equal(await page.evaluate(()=>JSON.stringify(window.__bdoAppState.session.scannedTrades)),unsavedRows);
 assert.equal(await page.evaluate(()=>window.__bdoAppState.sessionUnsaved),true);
 assert.equal((await boot()).inventory.find(i=>i.programName==='괴생물 촉수').stock,8);
 await page.unroute('**/api/working-session');await page.locator('#persistence-recovery button').click();await idle();
 assert.equal(await page.evaluate(()=>window.__bdoAppState.sessionUnsaved),false);

 const intact=await page.evaluate(()=>{const state=window.__bdoAppState,before=JSON.stringify(state.session),bad=structuredClone(state.session);bad.schedule.speed[0].trades[0].execC=-1;try{window.__bdoScheduleRuntime.restoreWorkingSession(state,bad);return false;}catch{return JSON.stringify(state.session)===before;}});assert.equal(intact,true);const revision=await page.evaluate(()=>window.__bdoAppState.revision);await page.route('**/api/bootstrap',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({revision:999,inventory:'broken',settings:{}})}));assert.equal(await page.evaluate(async()=>{try{await(await import('/assets/js/persistence.js')).refreshPersistentState();return false;}catch{return true;}}),true);assert.equal(await page.evaluate(()=>window.__bdoAppState.revision),revision);await page.unroute('**/api/bootstrap');await page.evaluate(()=>sessionStorage.setItem('bdo-pending-write-v1','broken'));await page.reload();await ready();assert.ok(await page.locator('#persistence-recovery').isVisible());await page.locator('#persistence-recovery button').click();await page.getByRole('button',{name:'최신 상태 확인',exact:true}).click();await idle();assert.equal(await page.locator('#persistence-recovery').isVisible(),false);assert.deepEqual(errors,[]);console.log('PASS: no round entry; first generation; committed response loss; identical retry after reload; autosave dirty retention/retry; confirmed-save refresh failure');
}finally{await app.close();}
