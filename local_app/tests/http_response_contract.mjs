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
 globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'unexpected_error'}}),{status:500});
 await assert.rejects(requestJSON('/probe',{method:'POST'}),e=>e.status===500&&e.uncertain);
 globalThis.fetch=async()=>new Response('{"ok":true,"revision":1}');
 assert.deepEqual(await requestJSON('/probe'),{ok:true,revision:1});
 globalThis.fetch=async(_path,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}));
 await assert.rejects(requestJSON('/probe',{method:'POST',timeoutMs:5}),e=>e.code==='request_timeout'&&e.uncertain);
 const nativeSetTimeout=globalThis.setTimeout;
 const delays=[];
 try {
  globalThis.setTimeout=(callback,ms,...args)=>{delays.push(ms);return nativeSetTimeout(callback,ms,...args);};
  globalThis.fetch=async()=>new Response('{"ok":true}');
  await requestJSON('/api/bootstrap');await requestJSON('/api/inventory',{method:'PATCH'});
  await requestJSON('/api/warehouse-scan',{method:'POST'});
  assert.deepEqual(delays,[20000,30000,330000]);
 } finally {globalThis.setTimeout=nativeSetTimeout;}
 console.log('PASS: invalid JSON/shape, transport loss, HTTP conflicts and storage failures preserve retry classification');
} finally {globalThis.fetch=nativeFetch;}
