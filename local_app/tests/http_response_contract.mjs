import assert from 'node:assert/strict';
import {requestJSON} from '../../local_app/frontend/http.js';
const nativeFetch=globalThis.fetch;
try {
 for(const method of ['GET','POST','PUT']) {
  for(const body of ['null','[]','"text"','not-json']) {
   globalThis.fetch=async()=>new Response(body,{status:200});
   await assert.rejects(requestJSON('/probe',{method}),e=>e.code==='invalid_response'&&e.uncertain===(method!=='GET'));
  }
  globalThis.fetch=async()=>{throw Error('offline')};
  await assert.rejects(requestJSON('/probe',{method}),e=>e.code==='connection_failed'&&e.uncertain===(method!=='GET'));
 }
 for(const status of [400,409,422,503]) {
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'rejected',message:'safe failure'}}),{status});
  await assert.rejects(requestJSON('/probe',{method:'POST'}),e=>e.status===status&&e.code==='rejected'&&!e.uncertain&&e.message==='safe failure');
 }
 globalThis.fetch=async()=>new Response('{"ok":true,"revision":1}');
 assert.deepEqual(await requestJSON('/probe'),{ok:true,revision:1});
 console.log('PASS: invalid JSON/shape, transport loss, HTTP conflicts and storage failures preserve retry classification');
} finally {globalThis.fetch=nativeFetch;}
