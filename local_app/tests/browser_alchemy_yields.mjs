import assert from 'node:assert/strict';
import {startApp,loaded,saved,openStart,finish} from './helpers/alchemy_workbench.mjs';
const app=await startApp(18696),{page,base,read,errors}=app;
try {
 const catalog=await read('catalog?full=1'),id=catalog.items.find(i=>i.name==='맑은 액체 시약').item_id;
 await page.goto(base+'/alchemy/recipes/'+id);await loaded(page);
 await page.locator('#work-basis').selectOption('outputs');await page.locator('#work-quantity').fill('5');
 assert.equal(await page.locator('#work-start [data-start]').count(),0,'unknown variable yield never guesses required calls');
 await page.locator('#work-basis').selectOption('calls');await openStart(page,{calls:10,tracking:false});await page.locator('#start-form button[type=submit]').click();await saved(page);await finish(page,'맑은 액체 시약',25);
 await page.locator('#work-basis').selectOption('outputs');await page.locator('#work-quantity').fill('5');
 assert.match(await page.locator('#work-estimate').innerText(),/2회/);assert.equal(await page.locator('#work-start [data-start]').getAttribute('data-calls'),'2');
 await page.locator('#work-start [data-start]').click();assert.equal(await page.locator('#start-form [name=calls]').inputValue(),'2');await page.locator('#start-form button[type=submit]').click();await saved(page);await finish(page,'맑은 액체 시약',4);
 let stat=Object.values((await read('state')).yield_statistics).find(v=>v.total_calls===12);assert.equal(stat.total_output,29);
 await app.restart();stat=Object.values((await read('state')).yield_statistics).find(v=>v.total_calls===12);assert.equal(stat.total_output,29);
 await page.locator('#work-basis').selectOption('outputs');await page.locator('#work-quantity').fill('29');assert.equal(await page.locator('#work-start [data-start]').getAttribute('data-calls'),'12');
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 console.log('PASS: unknown yield blocked, completed 29/12 weighted average drives current workbench, preserved after restart, mobile');
} finally {await app.close();}
