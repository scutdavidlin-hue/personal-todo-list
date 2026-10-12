import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

const source=await readFile(new URL('../supabase/functions/personal-os-mcp/index.ts',import.meta.url),'utf8');
// Execute the actual gateway functions with isolated fetch, without importing
// the server's Hono/Zod runtime or connecting to any external service.
const gateway=stripTypeScriptTypes(source.slice(source.indexOf('function uncertainIntakeResult('),source.indexOf('async function updateTaskReminder('))
  +source.slice(source.indexOf('async function captureItem('),source.indexOf('const GOAL_SELECT')));
function load(fetch){return new Function('fetch','SUPABASE_URL','WRITE_TOKEN','reminderArguments','intakeConfirmation',gateway+';return {createTask,captureItem};')(fetch,'https://isolated.test','isolated-token',()=>({}),()=> 'pending');}
const args={title:'isolated task',raw_text:'提醒我交材料',timezone:'Asia/Shanghai',type:'task',idempotency_key:'receipt-test-key'};
test('both gateway paths preserve uncertainty for timeout, abort, malformed and truncated body without retry',async()=>{
 for(const method of ['createTask','captureItem'])for(const fail of [
  async()=>{throw new DOMException('lost response','TimeoutError');},
  async()=>{throw new DOMException('cancelled transport','AbortError');},
  async()=>new Response('not JSON'),
  async()=>new Response(''),
  async()=>new Response(new ReadableStream({start(c){c.error(new Error('body interrupted'));}})),
 ]){
  let calls=0;const r=await load(async()=>{calls++;return fail();})[method](args);
  assert.equal(calls,1);assert.equal(r.isError,true);assert.equal(r.structuredContent.outcome,'unknown');assert.equal(r.structuredContent.idempotency_key,args.idempotency_key);assert.equal(r.structuredContent.retry_requires_user_intent,true);assert.equal(r.structuredContent.verified,false);assert.doesNotMatch(r.content[0].text,/任务未写入|已经/);
 }
});
test('verified receipts and explicit denial preserve request identity and do not retry',async()=>{
 for(const method of ['createTask','captureItem'])for(const body of [
  {success:true,verified:true,write_success:true,request_id:'isolated-request',id:'isolated-task',receipt:{task_save_status:'verified'}},
  {success:false,verified:false,write_success:false,request_id:'isolated-request',code:'USER_CANCELLED'},
  {success:false,verified:false,write_success:false,request_id:'isolated-request',code:'ACTION_DENIED'},
 ]){
  let calls=0;const r=await load(async()=>{calls++;return new Response(JSON.stringify(body));})[method](args);
  assert.equal(calls,1);assert.equal(r.structuredContent.request_id,body.request_id);assert.equal(r.structuredContent.code,body.code);assert.equal(r.structuredContent.idempotency_key,args.idempotency_key);assert.equal(r.isError,!body.success);
 }
});

test('incomplete structured JSON is unknown while preserving available request correlation', async()=>{
 for(const method of ['createTask','captureItem'])for(const body of [
  {success:false}, {success:false,error:'upstream interrupted'},
  {success:false,code:'USER_CANCELLED',write_success:true,verified:true,id:'task',request_id:'known-request'},
  {success:false,request_id:'known-request'},
  {success:false,request_id:'known-request',code:'INTAKE_FAILED'},
  {success:true,verified:true,write_success:true,id:'task',receipt:{task_save_status:'verified'}},
  {success:true,verified:true,write_success:true,id:'task',request_id:'known-request'},
  {success:true,verified:true,write_success:true,id:'task',request_id:'known-request',receipt:{task_save_status:'pending'}},
 ]){
  const r=await load(async()=>new Response(JSON.stringify(body)))[method](args);
  assert.equal(r.isError,true);assert.equal(r.structuredContent.outcome,'unknown');assert.equal(r.structuredContent.retry_requires_user_intent,true);assert.equal(r.structuredContent.idempotency_key,args.idempotency_key);assert.equal(r.structuredContent.request_id,body.request_id);assert.doesNotMatch(r.content[0].text,/没有写进去/);
 }
});
test('explicit prewrite refusal without request id stays rejected and partial verified saves stay partial',async()=>{
 for(const method of ['createTask','captureItem']){
  for(const code of ['USER_CANCELLED','ACTION_DENIED','IDEMPOTENCY_CONFLICT','CLARIFICATION_REQUIRED']){
   const r=await load(async()=>new Response(JSON.stringify({success:false,code})))[method](args);assert.equal(r.structuredContent.code,code);assert.equal(r.structuredContent.outcome,'rejected');assert.equal(r.isError,true);
  }
  const r=await load(async()=>new Response(JSON.stringify({success:false,code:'PROJECTION_PENDING',request_id:'known-request',id:'task',verified:true,write_success:true,receipt:{task_save_status:'verified'}})))[method](args);assert.equal(r.structuredContent.outcome,'partial');assert.equal(r.structuredContent.write_success,true);assert.equal(r.isError,true);
 }
});
