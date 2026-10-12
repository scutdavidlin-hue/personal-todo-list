import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname, "..");
const {applyTaskSchedulePatch}=await import(pathToFileURL(root+'/supabase/functions/_shared/schedule-core.js').href);
let seq=0;
async function harness(status='needsAction') {
  const prior={Deno:globalThis.Deno,fetch:globalThis.fetch};let handler,activity=null;
  const owner='11111111-1111-4111-8111-111111111111', task={id:'isolated-lifecycle',title:'Isolated task',notes:'',status,due:'2099-01-01T00:00:00Z'};
  const schedule={id:'isolated-schedule',owner_id:owner,google_task_id:task.id,scheduled_date:'2099-01-01',scheduled_start:'12:00',scheduled_end:'12:30',duration_minutes:30,fixed_time:true,timezone:'Asia/Shanghai',reminder_policy:'custom',reminder_policy_source:'user_explicit',reminder_at:'2099-01-01T12:00',reminders:[{type:'start',offset_minutes:0}]};
  const taskWrites=[],schedulerCalls=[],calls=[];
  const j=(body,status=200)=>new Response(JSON.stringify(body),{status});
  globalThis.Deno={env:{get:n=>({SUPABASE_URL:'https://isolated.test',SUPABASE_SERVICE_ROLE_KEY:'unit-'+ 's'.repeat(40),SUPABASE_ANON_KEY:'unit-'+ 'p'.repeat(40),OWNER_USER_ID:owner,AUTOMATION_WRITE_TOKEN:'unit-'+ 'w'.repeat(40),GOOGLE_OAUTH_CLIENT_ID:'synthetic-client',GOOGLE_OAUTH_CLIENT_SECRET:'synthetic-secret',GOOGLE_TOKEN_ENCRYPTION_KEY:'unit-'+ 'e'.repeat(40)})[n]},serve:h=>handler=h};
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(String(url)), method=init.method||'GET',body=init.body?JSON.parse(init.body):null;
    calls.push({path:u.pathname,method,body});
    if(u.pathname==='/auth/v1/user')return j({id:owner});
    if(u.pathname.endsWith('/rpc/claim_google_auth_refresh'))return j([{outcome:'cached',access_token:'synthetic-access',tasklist_id:'list',google_subject:'synthetic-subject'}]);
    if(u.pathname.endsWith('/rest/v1/task_schedule_metadata'))return j([schedule]);
    if(u.pathname.endsWith('/rest/v1/task_activity_log')){
      if(method==='POST'){activity={id:'isolated-activity',...body};return j([activity]);}
      if(method==='PATCH'){Object.assign(activity,body);return j([activity]);}
      return j(activity?[activity]:[]);
    }
    if(u.hostname==='tasks.googleapis.com'&&u.pathname.endsWith('/tasks/'+task.id)){
      if(method==='PATCH'){taskWrites.push(body);Object.assign(task,body);}
      return j(task);
    }
    if(u.pathname.endsWith('/functions/v1/task-scheduler')){
      schedulerCalls.push(body);
      if(body.action==='update_task'){
        try{const patch=applyTaskSchedulePatch(schedule,body.changes,task.due.slice(0,10));Object.assign(schedule,patch.schedule);}
        catch(e){return j({success:false,code:'INVALID_SCHEDULE',error:e.message},400);}
      }
      return j({success:true,sync_required:false});
    }
    throw new Error('Unexpected isolated request '+u.pathname);
  };
  try{
    await import(pathToFileURL(root+'/supabase/functions/google-tasks/index.ts').href+'?cloud-mutations='+ ++seq);
    return {task,schedule,taskWrites,schedulerCalls,calls,getActivity:()=>activity,
      request:async(body)=>{const response=await handler(new Request('https://isolated.test/google-tasks',{method:'PATCH',headers:{Authorization:'Bearer synthetic-user','Content-Type':'application/json','Idempotency-Key':'isolated-mutation-key'},body:JSON.stringify({task_id:task.id,...body})}));return {status:response.status,body:await response.json()};},restore(){Object.assign(globalThis,prior);}};
  }catch(e){Object.assign(globalThis,prior);throw e;}
}

for(const action of ['complete','reopen'])test(`actual Google Tasks handler ${action} keeps ordinary lifecycle operation working`,async()=>{
  const h=await harness(action==='complete'?'needsAction':'completed');
  try{
    const r=await h.request({action});
    assert.equal(r.status,200);assert.equal(r.body.success,true);
    assert.equal(h.task.status,action==='complete'?'completed':'needsAction');
    assert.equal(h.taskWrites.length,1);
  }finally{h.restore();}
});

test('actual Google Tasks update validates an impossible timing plan before provider mutation',async()=>{
  const h=await harness();
  try{
    const changes={due:'2099-01-03',requested_date:'2099-01-03',requested_time:'23:50',estimated_duration:30,fixed_time:true};
    assert.throws(()=>applyTaskSchedulePatch(h.schedule,changes,'2099-01-03'));
    const before=JSON.stringify(h.task),r=await h.request({action:'update',changes});
    assert.equal(r.body.success!==true,true);
    assert.equal(h.taskWrites.length,0,'Invalid timing must be rejected before changing the Google Task');
    assert.deepEqual(h.schedulerCalls,[]);
    assert.match(h.getActivity().error,/time range crosses the calendar day/);
    assert.equal(JSON.stringify(h.task),before);
  }finally{h.restore();}
});

test('actual Google Tasks update can clear timing while preserving Task identity and none reminders',async()=>{
  const h=await harness();
  try{
    const changes={due:'2099-01-03',requested_date:'2099-01-03',requested_time:null,fixed_time:false};
    const r=await h.request({action:'update',changes});
    assert.equal(r.status,200);assert.equal(r.body.success,true);
    assert.equal(r.body.task.id,h.task.id);
    assert.equal(h.task.status,'needsAction');
    assert.equal(h.task.due,'2099-01-03T00:00:00.000Z');
    assert.equal(h.taskWrites.length,1);
    assert.equal(h.taskWrites[0].status,undefined);
    assert.equal(h.schedule.scheduled_date,'2099-01-03');
    assert.equal(h.schedule.scheduled_start,null);
    assert.equal(h.schedule.scheduled_end,null);
    assert.equal(h.schedule.reminder_policy,'none');
    assert.equal(h.schedule.reminder_at,null);
    assert.equal(h.schedule.reminder_offset_minutes,null);
    assert.deepEqual(h.schedule.reminders,[]);
    assert.deepEqual(h.schedulerCalls.map(x=>x.action),['update_task']);
  }finally{h.restore();}
});
