import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {startApp} from './helpers/alchemy_workbench.mjs';
const app=await startApp(18759),{page,base,errors}=app;
const idle=()=>page.evaluate(async()=>await(await import('/assets/js/persistence.js')).whenPersistenceIdle());
const boot=()=>fetch(base+'/api/bootstrap').then(r=>r.json());
const out=process.env.UI_AUDIT_DIR;
try{
 await page.goto(base+'/barter/');await page.waitForFunction(()=>document.querySelector('#app-content').getAttribute('aria-busy')==='false');
 assert.equal(await page.locator('.session-toolbar').isVisible(),false);assert.ok(await page.locator('.empty-session-actions .primary').isVisible());
 await page.locator('[data-workspace-view=inventory]').click();assert.ok(await page.locator('#mainPanel .inventory-tier-tabs').isVisible());
 await page.evaluate(async()=>{await(await import('/assets/js/persistence.js')).saveInventory({'갈퀴 꽃 씨앗 주머니':{stock:100},'괴생물 촉수':{stock:0}});await(await import('/assets/js/trade-ui.js')).applyLiveTradeRows(['베이루와 섬','레마 섬','에베토 섬'].map(island=>({island,fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',reqAmount:1,count:3,yield:3})),'new');});
 await page.locator('[data-workspace-view=session]').click();await page.locator('#open-schedule').click();await page.waitForFunction(()=>!!window.__bdoAppState.session.schedule);await idle();
 assert.equal(await page.locator('#brief-ledger tbody tr').first().locator('.ledger-projected').first().innerText(),'91');assert.equal(await page.locator('#brief-ledger tbody tr').nth(1).locator('.ledger-projected').first().innerText(),'27');
 await page.locator('#brief-confirm-plan').click();await idle();assert.match(await page.locator('#scenario-progress').innerText(),/적재 준비/);await page.locator('#col-speed .v-show-route').click();await idle();assert.match(await page.locator('#scenario-progress').innerText(),/항로 수행/);assert.doesNotMatch(await page.locator('#brief-plan-status').innerText(),/출항 전/);
 const before=await boot();await page.locator('[data-workspace-view=inventory]').click();await page.locator('#inventory-stock-filter').selectOption('needed');assert.equal(await page.locator('.inventory-row:visible').count(),2);await page.locator('#inventory-return-voyage').click();await idle();assert.deepEqual((await boot()).workingSession,before.workingSession);
 for(const [width,height] of [[1920,1080],[1440,900],[1280,720]]){
  await page.setViewportSize({width,height});const button=page.locator('#col-speed .v-current .route-complete-button');await button.scrollIntoViewIfNeeded();const rect=await button.boundingBox();assert.ok(rect.y>=0&&rect.y+rect.height<=height);const layout=await page.locator('#col-speed .v-sailing').evaluate(n=>{const hero=n.querySelector('.v-current'),route=n.querySelector('.voyage-route-scroll');return {hero:hero.getBoundingClientRect().toJSON(),route:route.getBoundingClientRect().toJSON()};});assert.ok(layout.route.x>=layout.hero.right-1,'route must be beside the active exchange');assert.equal(await page.locator('#col-speed .v-stop-body .v-stop-exchange:visible').count(),0);if(out){await mkdir(out,{recursive:true});await page.screenshot({path:out+`/navigation-${width}.png`});}
 }
 await page.locator('[data-workspace-view=session]').click();await page.locator('tr.trade-row .trade-toggle input').last().uncheck();await idle();const dirty=await boot();await page.locator('#open-schedule').click();await idle();assert.equal(await page.locator('dialog[open]').count(),0);assert.ok(await page.locator('#scenario-plan-notice').isVisible());assert.ok(await page.locator('#col-speed .v-current .route-complete-button').isDisabled());await page.locator('#brief-recalculate').click();await page.getByRole('button',{name:'기존 상태 유지',exact:true}).click();await idle();assert.deepEqual((await boot()).workingSession,dirty.workingSession);
 assert.deepEqual(errors,[]);console.log('PASS: empty round, projected stocks, first-exchange phase, inventory return/filter, side route and accessible completion at 3 desktop sizes, dirty read-only/cancel preserves plan');
}finally{await app.close();}
