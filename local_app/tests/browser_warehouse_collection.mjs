import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const temporary = await mkdtemp(join(tmpdir(), 'bdo-warehouse-collection-'));
const socket = createServer();
await new Promise(resolve => socket.listen(0,'127.0.0.1',resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const source = `
import base64,hashlib,io,json
from pathlib import Path
from PIL import Image
from flask import jsonify
from local_app.backend.app import create_app
app=create_app(${JSON.stringify(join(temporary,'test.sqlite3'))},testing=True)
store=app.extensions['bdo_storage']
name=next(n for n,t in store.catalog.items() if t==1)
raw=io.BytesIO(); Image.new('RGB',(70,70)).save(raw,format='PNG'); image=raw.getvalue()
def recognize(path):
 patch={'type':'master_inventory_patch','version':1,'items':{name:5}}
 return patch,{'input':{'sha256':hashlib.sha256(Path(path).read_bytes()).hexdigest()},'grid':{'slotWidth':70},'patch':patch,
 'slots':[{'slot':'R1C1','x':0,'y':0,'width':70,'height':70,'decision':'MATCH','finalItem':name,'bestCandidate':name,'quantity':{'value':5,'status':'QUANTITY_MATCH'}}]}
app.extensions['trade_batch_runtime'].recognize_warehouse=recognize
@app.get('/__test__/image')
def image_data():return jsonify({'base64':base64.b64encode(image).decode(),'name':name})
@app.get('/__test__/collections')
def counts():
 from contextlib import closing
 with closing(store.connect()) as c:
  r=c.execute('SELECT count(*),coalesce(sum(length(image_png)),0) FROM warehouse_scan').fetchone()
  return jsonify({'scans':r[0],'imageBytes':r[1],'feedback':c.execute('SELECT count(*) FROM warehouse_feedback').fetchone()[0]})
app.run(host='127.0.0.1',port=${port},use_reloader=False,threaded=True)
`;
const server = spawn(process.env.PYTHON ?? 'python',['-B','-c',source],{cwd:new URL('../../',import.meta.url),windowsHide:true,stdio:'ignore',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
let browser;
try {
  for(let i=0;;i++){
    try {if((await fetch(`${base}/api/health`)).ok)break;}catch{}
    if(i>100)throw Error('Isolated app did not start');
    await delay(150);
  }
  browser=await chromium.launch({executablePath:process.env.BDO_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage(); const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/barter/`);
  await page.waitForFunction(()=>document.querySelector('#app-content').getAttribute('aria-busy')==='false');
  const fixture=await fetch(`${base}/__test__/image`).then(r=>r.json());
  const open = edit => page.evaluate(async ({fixture,edit})=>{
    const blob=new Blob([Uint8Array.from(atob(fixture.base64),c=>c.charCodeAt(0))],{type:'image/png'});
    const form=new FormData();form.append('image',blob,'capture.png');
    const result=await fetch('/api/warehouse-scan',{method:'POST',body:form}).then(r=>r.json());
    if(!result.ok)throw Error(JSON.stringify(result));
    window.__scanId=result.report.scanId;
    if(edit)result.report.slots[0].decision='QUANTITY_UNKNOWN';
    (await import('/assets/js/patch-review.js')).openPatchReview(result.patch,result.report,{imageFile:blob,setStatus:()=>{},onApplied:()=>{}});
  },{fixture,edit});
  await open(false); const scanId=await page.evaluate(()=>window.__scanId);
  assert.equal(await page.locator('.patch-correction-row').count(),0);
  await page.locator('.patch-review-footer [data-action="apply"]').click();
  await page.waitForFunction(()=>!document.querySelector('.patch-review-dialog').open);
  let counts=await fetch(`${base}/__test__/collections`).then(r=>r.json());
  assert.deepEqual(counts,{scans:1,imageBytes:0,feedback:0});
  await open(true);assert.equal(await page.evaluate(()=>window.__scanId),scanId);
  await page.locator('.patch-correction-quantity').fill('6');
  await page.locator('.patch-item-check').selectOption('item_only');
  await page.locator('.patch-review-footer [data-action="apply"]').click();
  await page.waitForFunction(()=>!document.querySelector('.patch-review-dialog').open);
  counts=await fetch(`${base}/__test__/collections`).then(r=>r.json());
  assert.equal(counts.scans,1);assert.ok(counts.imageBytes>0);assert.equal(counts.feedback,1);
  const snapshot=await fetch(`${base}/api/bootstrap`).then(r=>r.json());
  assert.equal(snapshot.inventory.find(r=>r.programName===fixture.name).stock,6);
  assert.deepEqual(errors,[]);
  console.log('PASS: normal scans store no images, repeated scans deduplicate, edited values retain the matching original and apply once');
} finally {
  await browser?.close();server.kill();
  if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));
  await rm(temporary,{recursive:true,force:true});
}
