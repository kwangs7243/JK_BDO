import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startApp} from './helpers/alchemy_workbench.mjs';
const app=await startApp(18745),{page,base,errors}=app;
const out=process.env.UI_AUDIT_DIR??app.temp;
try {
 await mkdir(out,{recursive:true});
 await page.addInitScript(()=>{window.__galleryURLs=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);window.__galleryURLs.add(url);return url;};URL.revokeObjectURL=url=>{window.__galleryURLs.delete(url);revoke(url);};});
 await page.setViewportSize({width:1920,height:1080});await page.goto(base+'/barter/');await page.waitForFunction(()=>document.querySelector('#app-content')?.getAttribute('aria-busy')==='false');await page.locator('#open-trade-capture').click();
 const pixels=await readFile(new URL('./fixtures/trade-recognition/Codex 이미지 2026년 9월 25일 오후 08_43_53.png',import.meta.url));
 const add=number=>page.locator('#trade-capture-files').setInputFiles(Array.from({length:number},(_,i)=>({name:`capture-${i}.png`,mimeType:'image/png',buffer:pixels})));
 await add(2);await page.waitForFunction(()=>document.querySelector('#trade-capture-dialog').dataset.queueLength==='2');
 await page.locator('.capture-draft-image').first().evaluate(img=>img.decode());
 assert.match(await page.locator('.capture-gallery-caption').innerText(),/총 2장/);
 assert.equal(await page.locator('.capture-inputs [data-role=capture-list],.capture-inputs [data-action=clear-trade-queue]').count(),0,'all queue manipulation moved out of the sidebar');
 assert.equal(await page.locator('.trade-recognition-panel [data-role=capture-list]').count(),1);
 assert.ok(await page.locator('.trade-recognition-panel [data-action=clear-trade-queue]').isVisible());
 assert.equal(await page.locator('.capture-large-frame').count(),0,'no single-image replacement view');
 const cards=await page.locator('.capture-draft-item').all();
 for(const card of cards){const box=await card.boundingBox();assert.ok(box.width>=240&&box.width<500&&box.height<260,JSON.stringify(box));assert.ok(await card.locator('[data-capture-remove]').isVisible());}
 assert.equal(await page.evaluate(()=>window.__galleryURLs.size),2);
 await page.locator('[data-capture-remove]').first().click();assert.match(await page.locator('.capture-gallery-caption').innerText(),/총 1장/);assert.equal(await page.evaluate(()=>window.__galleryURLs.size),1);
 await add(8);await page.waitForFunction(()=>document.querySelector('#trade-capture-dialog').dataset.queueLength==='9');
 const scroll=await page.locator('#trade-capture-dialog [data-role=capture-list]').evaluate(list=>({top:list.scrollTop,height:list.clientHeight,total:list.scrollHeight}));await page.screenshot({path:join(out,'capture-grid-before-scroll-check.png')});assert.ok(scroll.total>scroll.height&&scroll.top>0,JSON.stringify(scroll));
 assert.equal(await page.evaluate(()=>window.__galleryURLs.size),9,'one URL per card');
 await page.screenshot({path:join(out,'capture-grid-1920.png')});
 await page.locator('#trade-capture-dialog [data-close-trade-capture]').first().click();await page.waitForFunction(()=>window.__galleryURLs.size===0);
 await page.locator('#open-trade-capture').click();assert.equal(await page.locator('.capture-draft-item').count(),9,'reopening retains queued images');
 for(const width of [1440,900,390]){await page.setViewportSize({width,height:1080});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(out,`capture-grid-${width}.png`)});}
 await page.locator('[data-action=clear-trade-queue]').click();assert.equal(await page.evaluate(()=>window.__galleryURLs.size),0);assert.equal(await page.locator('.trade-capture-gallery').isVisible(),false);
 assert.deepEqual(errors,[]);await writeFile(join(out,'capture-gallery.json'),JSON.stringify({ok:true,centralQueueAndDeletion:true,noLargeReplacementPreview:true,boundedURLs:true,reopenPreserved:true,widths:[1920,1440,900,390],errors},null,2));
 console.log('PASS: central screenshot grid, individual/all deletion, scroll, bounded URLs, close/reopen and responsive widths');
} finally {await app.close();}
