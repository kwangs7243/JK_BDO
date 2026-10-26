import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.BDO_NODE_MODULES?require.resolve('playwright',{paths:[process.env.BDO_NODE_MODULES]}):'playwright');

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const temp=await mkdtemp(join(tmpdir(),'bdo-briefing-workspace-'));
const database=join(temp,'isolated.sqlite3');
const code=`from local_app.backend.app import create_app; from werkzeug.serving import make_server; server=make_server('127.0.0.1',0,create_app(r'${database}',testing=True),threaded=True); print(server.server_port,flush=True); server.serve_forever()`;
const external=process.env.BDO_EXTERNAL_APP==='1';
if(external&&!process.env.BDO_TEST_URL)throw Error('External tests require an explicit isolated BDO_TEST_URL');
const server=external?null:spawn(process.env.PYTHON||'python',['-B','-c',code],{cwd:root,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
let browser;
try {
  const port=external?null:await new Promise((resolve,reject)=>{
    let stdout='',stderr='';
    const timer=setTimeout(()=>reject(Error('isolated server startup timed out: '+stderr.slice(-500))),15000);
    server.stdout.on('data',data=>{stdout+=data;if(/^\d+\r?\n/.test(stdout)){clearTimeout(timer);resolve(Number(stdout.trim()));}});
    server.stderr.on('data',data=>{stderr+=data;});
    server.on('error',error=>{clearTimeout(timer);reject(error);});
    server.on('exit',code=>{clearTimeout(timer);reject(Error(`isolated server exited ${code}: ${stderr.slice(-500)}`));});
  });
  const url=external?process.env.BDO_TEST_URL.replace(/\/$/,''):`http://127.0.0.1:${port}`;
  browser=await chromium.launch({executablePath:process.env.BDO_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext();
  const open=async()=>{const page=await context.newPage();await page.goto(url+'/barter/');await page.waitForFunction(()=>document.querySelector('#app-content')?.getAttribute('aria-busy')==='false');return page;};

  const page=await open();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const idle=()=>page.evaluate(async()=>{await (await import('/assets/js/persistence.js')).whenPersistenceIdle();});
  const boot=()=>fetch(url+'/api/bootstrap').then(r=>r.json());
  assert.equal(await page.locator('#schedule-dialog').count(),0);
  assert.equal(await page.locator('#briefing-panel').isVisible(),false);
  await page.locator('[data-workspace-view="briefing"]').click();
  assert.equal(await page.locator('#briefing-panel').isVisible(),true);
  assert.equal(await page.locator('dialog[open]').count(),0);
  assert.equal(await page.locator('#workspace-title').textContent(),'출항 브리핑');
  await page.locator('[data-workspace-view="session"]').click();
  await page.locator('#open-schedule').click();
  assert.equal(await page.locator('#briefing-panel').isVisible(),true);
  await page.evaluate(async()=>{
    const p=await import('/assets/js/persistence.js');const {state}=await import('/assets/js/state.js');
    await p.saveInventory({'갈퀴 꽃 씨앗 주머니':{stock:100},'괴생물 촉수':{stock:0}});
    state.session.scannedTrades=[{island:'베이루와 섬',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',reqAmount:1,count:3,yield:3}];
    state.session.remainingParley=1500000;
  });
  await page.locator('#generate-schedule').click();await idle();
  assert.ok(await page.locator('#col-speed .sortie-card').count());
  await page.locator('[data-brief-mode="speed"]').click();await idle();
  await page.locator('#col-speed .route-depart-button').first().click();
  const navigationBefore=await page.evaluate(()=>{
    window.__firstRoute=document.querySelector('#col-speed .route-card');
    const filler=document.createElement('div');filler.id='scroll-test';filler.style.height='2000px';
    document.querySelector('#col-speed').append(filler);document.querySelector('#schedule-columns').scrollTop=200;
    return {timers:JSON.stringify(window.ACTIVE_TIMERS),scroll:document.querySelector('#schedule-columns').scrollTop};
  });
  const durableBefore=await boot();
  await page.locator('[data-workspace-view="inventory"]').click();
  await page.locator('[data-workspace-view="session"]').click();
  await page.locator('#open-schedule').click();
  await page.keyboard.press('Escape');
  const navigationAfter=await page.evaluate(()=>({sameRow:window.__firstRoute===document.querySelector('#col-speed .route-card'),
    timers:JSON.stringify(window.ACTIVE_TIMERS),scroll:document.querySelector('#schedule-columns').scrollTop}));
  assert.equal(navigationAfter.sameRow,true,'navigation must retain route DOM and timers');
  assert.equal(navigationAfter.timers,navigationBefore.timers);
  assert.ok(navigationBefore.scroll>0);assert.equal(navigationAfter.scroll,navigationBefore.scroll);
  assert.deepEqual(await boot(),durableBefore,'navigation must not recalculate or write the session');
  assert.equal(await page.locator('#briefing-panel').isVisible(),true);
  await page.evaluate(()=>{document.querySelector('#scroll-test').remove();document.querySelector('#schedule-columns').scrollTop=0;});
  await page.locator('#col-speed .sortie-heading button').click();
  assert.equal(await page.locator('#waypointModal').isVisible(),true);
  await page.locator('#close-waypoint').click();
  await page.locator('#brief-open-tuning').click();
  assert.equal(await page.locator('#tuning-dialog').isVisible(),true);
  await page.locator('#tuning-dialog [data-close-dialog]').click();
  assert.equal(await page.locator('#briefing-panel').isVisible(),true);
  await page.evaluate(async()=>{const p=await import('/assets/js/persistence.js');await p.saveScheduleSlot(1);await p.loadScheduleSlot(1);});
  await page.locator('#col-speed .route-complete-button').click();await idle();
  const completed=await boot();
  assert.equal(completed.inventory.find(i=>i.programName==='갈퀴 꽃 씨앗 주머니').stock,97);
  assert.equal(completed.inventory.find(i=>i.programName==='괴생물 촉수').stock,9);
  assert.ok(completed.workingSession.schedule.speed[0].trades[0].completed);
  await page.locator('#col-speed .route-complete-button').evaluate(button=>button.click());await idle();
  assert.deepEqual(await boot(),completed,'completion is persisted once');
  const screenshots=process.env.UI_AUDIT_DIR||temp;
  await import('node:fs/promises').then(m=>m.mkdir(screenshots,{recursive:true}));
  const fixture=JSON.parse(await import('node:fs/promises').then(m=>m.readFile(resolve(root,'local_app/tests/fixtures/ui-schedule.json'),'utf8')));
  await page.evaluate(fixture=>{
    window.renderModeColumn('col-speed',fixture.speed,'speed');window.renderModeColumn('col-balance',fixture.balance,'balance');
  },fixture);
  await page.locator('[data-brief-mode="both"]').click();await idle();
  for(const width of [1920,1440,1024]){
    await page.setViewportSize({width,height:1080});
    await page.waitForFunction(()=>Math.abs(document.body.getBoundingClientRect().width-innerWidth)<2);
    const layout=await page.evaluate(()=>{
      const panel=document.querySelector('#briefing-panel').getBoundingClientRect();
      const toolbar=document.querySelector('.briefing-toolbar').getBoundingClientRect();
      const list=document.querySelector('#schedule-columns').getBoundingClientRect();
      return {left:panel.left,right:panel.right,bottom:panel.bottom,width:innerWidth,height:innerHeight,
        listHeight:list.height,toolbarBottom:toolbar.bottom,listTop:list.top,scrollWidth:document.documentElement.scrollWidth,
        grid:getComputedStyle(document.querySelector('#schedule-columns')).gridTemplateColumns.split(' ').length};
    });
    assert.ok(layout.left>=0&&layout.right<=layout.width+2&&layout.bottom<=layout.height+2,JSON.stringify(layout));
    assert.ok(layout.listHeight>150&&layout.toolbarBottom<=layout.listTop+2,JSON.stringify(layout));
    assert.ok(layout.scrollWidth<=layout.width+2,JSON.stringify(layout));
    assert.equal(layout.grid,width===1024?1:2);
    await page.screenshot({path:join(screenshots,`briefing-${width}.png`)});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: briefing workspace navigation, retained DOM/scroll/timers, mode views, generation, slot load, once-only completion, helper dialogs and responsive widths 1024/1440/1920');
} finally {
  await browser?.close();
  if(server&&server.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}
  await rm(temp,{recursive:true,force:true});
}
