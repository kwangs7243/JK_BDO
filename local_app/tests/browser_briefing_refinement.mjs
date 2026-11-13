import assert from 'node:assert/strict';
import {startApp} from './helpers/alchemy_workbench.mjs';
const app=await startApp(18747),{page,errors,base}=app;
const idle=()=>page.evaluate(async()=>await(await import('/assets/js/persistence.js')).whenPersistenceIdle());
try {
 await page.goto(base+'/barter/');await page.waitForFunction(()=>document.querySelector('#app-content')?.getAttribute('aria-busy')==='false');
 await page.evaluate(async()=>{await(await import('/assets/js/persistence.js')).saveInventory({'갈퀴 꽃 씨앗 주머니':{stock:100},'괴생물 촉수':{stock:0}});await(await import('/assets/js/trade-ui.js')).applyLiveTradeRows(['베이루와 섬','레마 섬','에베토 섬'].map(island=>({island,fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',reqAmount:1,count:3,yield:3})),'new');});
 await page.locator('#open-schedule').click();await page.waitForFunction(()=>!!window.__bdoAppState.session.schedule&&!document.querySelector('#brief-recalculate').disabled);await idle();await page.locator('#brief-confirm-plan').click();await idle();
 assert.match(await page.locator('#col-speed .v-cargo-caption').innerText(),/일리야 출발 · 첫 목적지/);
 await page.locator('#col-speed .v-show-route').click();await idle();
 const expected=await page.evaluate(()=>{const s=window.__bdoAppState.session.schedule.speed[0];if(s.trades.length!==3)throw Error('fixture must have 3 trades');s.trades[1].execC=0;window.rebuildSortieReq(s);window.renderModeColumn('col-speed',[s],'speed');return s.trades[2].island;});
 assert.equal(await page.locator('#col-speed .v-next strong').innerText(),expected);
 await page.locator('#col-speed .v-current .route-complete-button').click();await idle();await page.locator('#col-speed .v-current .route-complete-button').click();await idle();
 assert.equal(await page.locator('#col-speed .v-next-sortie').innerText(),'복귀 완료 · 계획 마치기');await page.locator('#col-speed .v-next-sortie').click();await idle();
 assert.match(await page.locator('#col-speed .v-return-copy h3').innerText(),/선택한 계획 완료/);assert.equal(await page.locator('#col-speed .v-next-sortie').innerText(),'남은 교환 확인');assert.equal(await page.locator('dialog[open]').count(),0);
 const id=await page.evaluate(()=>window.__bdoAppState.session.id);await page.locator('#col-speed .v-next-sortie').click();assert.equal(await page.locator('#trade-session-panel').isVisible(),true);assert.equal(await page.evaluate(()=>window.__bdoAppState.session.id),id);
 assert.deepEqual(errors,[]);console.log('PASS: loading origin, skipped next destination, plan completion versus round completion, remaining offers navigation');
}finally{await app.close();}
