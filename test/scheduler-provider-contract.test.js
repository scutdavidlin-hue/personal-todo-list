import test from 'node:test';
import assert from 'node:assert/strict';
const owner='11111111-1111-4111-8111-111111111111';
let seq=0;
async function harness(){
 const old={Deno:globalThis.Deno,fetch:globalThis.fetch};let handler;
 const token='unit-'+ 'w'.repeat(40);
 const state={tasks:[{id:'original',title:'Synthetic daily',status:'needsAction',due:'2099-01-01T00:00:00Z',notes:''}],schedules:[{owner_id:owner,google_task_id:'original',scheduled_date:'2099-01-01',scheduled_start:null,scheduled_end:null,timezone:'Asia/Shanghai',duration_minutes:30,sync_required:false,notification_status:'not_required',reminder_policy:'none',reminder_policy_source:'system_default',reminders:[]}],series:[],occurrences:[],posts:0,events:[],timeoutAfterWrite:false};
 const j=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}});
 globalThis.Deno={env:{get:n=>({SUPABASE_URL:'https://fixture.test',SUPABASE_SERVICE_ROLE_KEY:'unit-'+ 's'.repeat(40),SUPABASE_ANON_KEY:'unit-'+ 'a'.repeat(40),OWNER_USER_ID:owner,AUTOMATION_WRITE_TOKEN:token,GOOGLE_OAUTH_CLIENT_ID:'synthetic-client',GOOGLE_OAUTH_CLIENT_SECRET:'synthetic-secret',GOOGLE_TOKEN_ENCRYPTION_KEY:'unit-'+ 'e'.repeat(40)})[n]},serve:x=>handler=x};
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url)),b=init.body?JSON.parse(init.body):{},method=init.method||'GET';
  if(u.pathname.endsWith('/functions/v1/personal-os-intake')){state.recoveryCalls=(state.recoveryCalls||0)+1;assert.equal(b.action,'recover_due');return j({results:[{request_id:'synthetic-recovery',success:false,code:'CALENDAR_WRITE_UNVERIFIED'}],checked_at:'synthetic'});}
  if(u.pathname.endsWith('/rpc/claim_google_auth_refresh'))return j([{outcome:'cached',access_token:'synthetic-access',tasklist_id:'list',google_subject:'synthetic-subject'}]);
  if(u.pathname.endsWith('/rpc/claim_task_schedule_series')){const s=state.series.find(x=>x.id===b.target_series);if(s.status!=='active'||s.current_task_id!==b.expected_task||(s.lease_active&&!state.expireLease))return j({claimed:false});state.expireLease=false;s.lease_active=true;s.pending_date ||= b.proposed_date;s.lease_token=b.claim_token;return j({claimed:true,pending_date:s.pending_date,creation_started:!!s.creation_started});}
  if(u.pathname.endsWith('/rpc/mark_task_schedule_creation_started')){state.series.find(x=>x.lease_token===b.claim_token).creation_started=true;return j(true);}
  if(u.pathname.endsWith('/rpc/finish_task_schedule_occurrence')){const s=state.series.find(x=>x.lease_token===b.claim_token);if(!s||s.status!=='active')return j({finished:false});state.occurrences.push({series_id:s.id,owner_id:owner,occurrence_date:s.pending_date,google_task_id:b.next_task});s.current_task_id=b.next_task;s.current_date=s.pending_date;s.pending_date=null;s.creation_started=false;s.lease_active=false;return j({finished:true});}
  const tables={task_schedule_metadata:state.schedules,task_schedule_series:state.series,task_schedule_occurrence:state.occurrences};
  const name=u.pathname.split('/').pop();if(tables[name]){
   const table=tables[name],match=x=>[...u.searchParams].every(([k,v])=>!v.startsWith('eq.')&&!v.startsWith('neq.')|| (v.startsWith('eq.')?String(x[k])===v.slice(3):String(x[k])!==v.slice(4)));
   if(method==='GET')return j(table.filter(match));
   if(method==='PATCH'){const rows=table.filter(match);rows.forEach(x=>Object.assign(x,b));return j(rows);}
   if(method==='POST'){const keys=name==='task_schedule_series'?['anchor_task_id']:name==='task_schedule_metadata'?['google_task_id']:['series_id','occurrence_date'];let row=table.find(x=>keys.every(k=>x[k]===b[k]));if(!row){row={id:'row-'+table.length,status:'active',...b};table.push(row);}else if(!String(init.headers?.Prefer).includes('ignore-duplicates')&&!(name==='task_schedule_metadata'&&state.ignoreScheduleWrite))Object.assign(row,b);return j([row]);}
  }
  if(u.hostname==='tasks.googleapis.com'){
   if(u.pathname.endsWith('/tasks')){if(method==='GET')return j({items:state.tasks});if(method==='POST'){state.posts++;const row={id:'next-'+state.posts,status:'needsAction',...b};state.tasks.push(row);if(state.cancelDuringPost)state.series[0].status='cancelled';if(state.timeoutAfterWrite){state.timeoutAfterWrite=false;throw new Error('Synthetic timeout after stored Task');}return j(row);}}
   const t=state.tasks.find(x=>x.id===name);if(t)return j(t);
  }
  if(u.hostname==='www.googleapis.com'&&u.pathname.includes('/calendar/v3/')){
   let e=state.events.find(x=>x.id===name);if(method==='DELETE'){if(!state.ignoreDelete)state.events=state.events.filter(x=>x.id!==name);return j({});}if(method==='GET'){if(!e)return j({error:{message:'not found'}},404);const out=structuredClone(e);if(!state.omitEtag)out.etag="synthetic-etag";if(state.omitOpaque)delete out.transparency;if(state.readbackFault==='reminders')out.reminders={useDefault:false,overrides:[{method:'popup',minutes:15}]};return j(out);}if(method==='PATCH'){if(!e)return j({error:{message:'not found'}},404);if(state.ignoreReminderPatch)delete b.reminders;Object.assign(e,b);return j(e);}if(method==='POST'){e={...b,status:'confirmed'};state.events.push(e);return j(e);}
  }
  throw new Error('Unmocked provider route '+u.pathname);
 };
 await import(new URL('../supabase/functions/task-scheduler/index.ts?contract='+(++seq),import.meta.url));
 return {state,request:async(action,args={})=>{const r=await handler(new Request('https://fixture.test/scheduler',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,...args})}));return {status:r.status,body:await r.json()}},restore(){Object.assign(globalThis,old)}};
}
test('actual scheduler provider contract: series lifecycle preserves Task truth, rule changes do not rewrite history, stop cannot revive', {concurrency:false},async()=>{
 const h=await harness();try{
  let r=await h.request('create_series',{task_id:'original',recurrence:{kind:'daily'}});assert.equal(r.body.success,true);const sid=r.body.series.id;
  r=await h.request('create_series',{task_id:'original',recurrence:{kind:'daily'}});assert.equal(r.body.replayed,true);assert.equal(h.state.series.length,1);
  const original=structuredClone(h.state.tasks[0]),schedule=structuredClone(h.state.schedules[0]);
  r=await h.request('update_series',{series_id:sid,recurrence:{kind:'daily',interval:2},effective_date:'2099-01-03'});assert.equal(r.body.updated,true);assert.deepEqual(h.state.tasks[0],original);assert.deepEqual(h.state.schedules[0],schedule);
  r=await h.request('pause_series',{series_id:sid});assert.equal(r.body.series.status,'paused');r=await h.request('advance_series',{task_id:'original'});assert.equal(r.body.reason,'SERIES_PAUSED');assert.equal(h.state.posts,0);
  r=await h.request('resume_series',{series_id:sid});assert.equal(r.body.series.status,'active');assert.equal(h.state.posts,0);
  r=await h.request('skip_series_once',{series_id:sid,recurrence_instance_date:'2099-01-03'});assert.equal(r.body.skipped,true);assert.equal(h.state.occurrences.filter(x=>x.instance_status==='skipped').length,1);
  h.state.tasks[0].status='completed';r=await h.request('advance_series',{task_id:'original'});assert.equal(r.body.advanced,true);assert.equal(h.state.posts,1);assert.equal(h.state.tasks[0].status,'completed');
  for(let i=0;i<3;i++)assert.equal((await h.request('advance_series',{task_id:'original'})).body.reason,'ALREADY_ADVANCED');assert.equal(h.state.posts,1);
  r=await h.request('cancel_series',{series_id:sid});assert.equal(r.body.cancelled,true);assert.equal((await h.request('resume_series',{series_id:sid})).body.code,'SERIES_CANCELLED');assert.equal((await h.request('create_series',{task_id:'original',recurrence:{kind:'daily'}})).body.code,'SERIES_CANCELLED');assert.equal(h.state.tasks[0].status,'completed');
 }finally{h.restore()}
});
test('actual scheduler reconciles timeout after provider save without creating a second occurrence', {concurrency:false},async()=>{
 const h=await harness();try{
  const r=await h.request('create_series',{task_id:'original',recurrence:{kind:'daily'}});assert.equal(r.body.success,true);h.state.tasks[0].status='completed';h.state.timeoutAfterWrite=true;
  assert.equal((await h.request('advance_series',{task_id:'original'})).body.reason,'TASK_WRITE_OUTCOME_UNKNOWN');assert.equal(h.state.posts,1);
  assert.equal((await h.request('advance_series',{task_id:'original'})).body.reason,'SERIES_BUSY_OR_CHANGED');h.state.expireLease=true;
  const recovered=await h.request('advance_series',{task_id:'original'});assert.equal(recovered.body.advanced,true);assert.equal(h.state.posts,1);assert.equal(h.state.tasks.length,2);assert.equal(h.state.tasks[0].status,'completed');
 }finally{h.restore()}
});

test('actual scheduler Calendar contract: omitted opaque passes, wrong popup stays pending, recovery preserves Event and Task', {concurrency:false},async()=>{
 const h=await harness();try{
 h.state.omitOpaque=true;const spec={scheduled_date:'2099-01-01',scheduled_start:'17:00',duration_minutes:15,timezone:'Asia/Shanghai',fixed_time:true,reminder_policy:'custom',reminder_policy_source:'user_explicit',reminder_at:'2099-01-01T17:00',reminder_type:'event'};
 let r=await h.request('schedule',{task_id:'original',schedule:spec});assert.equal(r.body.success,true);assert.equal(h.state.events.length,1);const eid=h.state.events[0].id;
 h.state.readbackFault='reminders';r=await h.request('schedule',{task_id:'original',schedule:spec});assert.equal(r.body.code,'CALENDAR_WRITE_UNVERIFIED');assert.equal(h.state.schedules[0].sync_required,true);assert.equal(h.state.events.length,1);
 h.state.readbackFault=null;r=await h.request('sync_task',{task_id:'original'});assert.equal(r.body.success,true);assert.equal(h.state.events[0].id,eid);assert.equal(h.state.events.length,1);assert.equal(h.state.tasks.length,1);assert.equal(h.state.schedules[0].sync_required,false);
 }finally{h.restore()}
});

test('actual scheduler two callers compete for one lease and produce one next Task', {concurrency:false},async()=>{
 const h=await harness();try{
 await h.request('create_series',{task_id:'original',recurrence:{kind:'daily'}});h.state.tasks[0].status='completed';
 const results=await Promise.all([h.request('advance_series',{task_id:'original'}),h.request('advance_series',{task_id:'original'})]);
 assert.equal(results.filter(x=>x.body.advanced===true).length,1);assert.equal(h.state.posts,1);assert.equal(h.state.tasks.length,2);assert.equal(h.state.tasks[0].status,'completed');
 assert.ok(results.some(x=>['SERIES_BUSY_OR_CHANGED','ALREADY_ADVANCED'].includes(x.body.reason)));
 }finally{h.restore()}
});
test('actual scheduler stop during provider creation cannot revive series or publish success', {concurrency:false},async()=>{
 const h=await harness();try{
 await h.request('create_series',{task_id:'original',recurrence:{kind:'daily'}});h.state.tasks[0].status='completed';h.state.cancelDuringPost=true;
 const r=await h.request('advance_series',{task_id:'original'});assert.equal(r.body.success,false);assert.equal(r.body.reason,'SERIES_CHANGED_DURING_ADVANCE');assert.equal(h.state.series[0].status,'cancelled');assert.equal(h.state.posts,1);assert.equal(h.state.series[0].current_task_id,'original');assert.equal(h.state.tasks[0].status,'completed');
 const replay=await h.request('advance_series',{task_id:'original'});assert.equal(replay.body.reason,'SERIES_CANCELLED');assert.equal(h.state.posts,1);
 }finally{h.restore()}
});

test('existing five-minute scheduler does not consume ordinary recovery backlog',{concurrency:false},async()=>{
 const h=await harness();try{for(let i=0;i<2;i++){const r=await h.request('run_recurrence');assert.equal(r.body.success,true);assert.equal(r.body.recovery,undefined);assert.equal(r.body.recurrence.advanced,0);}assert.equal(h.state.recoveryCalls||0,0);assert.equal(h.state.posts,0);}finally{h.restore()}
});

test('explicit none survives old example text and inferred provenance and is read back', {concurrency:false},async()=>{
 const h=await harness();try{
  let r=await h.request('schedule',{task_id:'original',schedule:{scheduled_date:'2099-01-01',scheduled_start:'12:00',duration_minutes:30,fixed_time:true,reminder_policy:'custom',reminder_policy_source:'user_explicit',reminder_at:'2099-01-01T12:00'}});assert.equal(r.body.success,true);
  r=await h.request('update_reminder',{task_id:'original',reminder:{reminder_policy:'none',reminder_policy_source:'ai_inferred',reminder_at:null,reminder_offset_minutes:null,reminders:[],raw_text:'举例提醒我12点抢票，提前一小时提醒'}});
  assert.equal(r.body.success,true);assert.equal(r.body.verified,true);assert.equal(h.state.schedules[0].reminder_policy,'none');assert.equal(h.state.schedules[0].reminder_at,null);assert.deepEqual(h.state.schedules[0].reminders,[]);assert.deepEqual(h.state.events[0].reminders,{useDefault:false,overrides:[]});assert.equal(h.state.posts,0);
 }finally{h.restore();}
});
test('clearing timing removes only the bound simulated projection and preserves unrelated activity', {concurrency:false},async()=>{
 const h=await harness();try{
  await h.request('schedule',{task_id:'original',schedule:{scheduled_date:'2099-01-01',scheduled_start:'12:00',duration_minutes:30,fixed_time:true,reminder_policy:'custom',reminder_policy_source:'user_explicit',reminder_at:'2099-01-01T12:00'}});
  const other={id:'unrelated-calendar-event',summary:'Unrelated real activity',status:'confirmed'};h.state.events.push(other);
  const r=await h.request('update_task',{task_id:'original',changes:{requested_date:'2099-01-03',requested_time:null,fixed_time:false}});
  assert.equal(r.body.success,true);assert.equal(h.state.schedules[0].scheduled_date,'2099-01-03');assert.equal(h.state.schedules[0].scheduled_start,null);assert.equal(h.state.schedules[0].reminder_policy,'none');assert.equal(h.state.schedules[0].calendar_event_id,null);assert.deepEqual(h.state.events,[other]);assert.equal(h.state.posts,0);
 }finally{h.restore();}
});
test('Calendar reminder or projection-clear readback mismatch never returns success', {concurrency:false},async()=>{
 for(const clearTime of [false,true]){
 const h=await harness();try{
  await h.request('schedule',{task_id:'original',schedule:{scheduled_date:'2099-01-01',scheduled_start:'12:00',duration_minutes:30,fixed_time:true,reminder_policy:'custom',reminder_policy_source:'user_explicit',reminder_at:'2099-01-01T12:00'}});
  h.state.ignoreReminderPatch=true;h.state.ignoreDelete=true;
  const r=clearTime?await h.request('update_task',{task_id:'original',changes:{requested_time:null}}):await h.request('update_reminder',{task_id:'original',reminder:{reminder_policy:'none',reminders:[]}});
  assert.equal(r.body.success,false);assert.equal(r.body.code,'CALENDAR_WRITE_UNVERIFIED');assert.equal(h.state.events.length,1);
 }finally{h.restore();}}
});

test('acknowledged but ignored reminder metadata write is rejected by readback', {concurrency:false},async()=>{
 const h=await harness();try{
  await h.request('schedule',{task_id:'original',schedule:{scheduled_date:'2099-01-01',scheduled_start:'12:00',duration_minutes:30,fixed_time:true,reminder_policy:'custom',reminder_policy_source:'user_explicit',reminder_at:'2099-01-01T12:00'}});
  h.state.ignoreScheduleWrite=true;
  const r=await h.request('update_reminder',{task_id:'original',reminder:{reminder_policy:'none',reminders:[]}});
  assert.equal(r.body.success,false);assert.equal(r.body.code,'REMINDER_WRITE_UNVERIFIED');assert.equal(h.state.schedules[0].reminder_policy,'custom');
 }finally{h.restore();}
});

test('timing clear refuses unrelated Calendar identity or missing concurrency proof', {concurrency:false},async()=>{
 for(const noEtag of [false,true]){
 const h=await harness();try{
  await h.request('schedule',{task_id:'original',schedule:{scheduled_date:'2099-01-01',scheduled_start:'12:00',duration_minutes:30,fixed_time:true,reminder_policy:'custom',reminder_policy_source:'user_explicit',reminder_at:'2099-01-01T12:00'}});
  if(noEtag)h.state.omitEtag=true;else h.state.events[0].extendedProperties.private.googleTaskId='another-task';
  const r=await h.request('update_task',{task_id:'original',changes:{requested_time:null}});
  assert.equal(r.body.success,false);assert.equal(r.body.code,noEtag?'CALENDAR_ETAG_REQUIRED':'CALENDAR_EVENT_IDENTITY_CHANGED');assert.equal(h.state.events.length,1);
 }finally{h.restore();}}
});
