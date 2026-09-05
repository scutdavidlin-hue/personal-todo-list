import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runTaskConversation, taskConversationVersion } from '../supabase/functions/_shared/task-conversation-runtime.js';
import { markTaskCancelledNotes, toTaskModel, splitTaskNotes } from '../supabase/functions/_shared/google-tasks-core.js';

function fixture() {
  const state = { task: { id:'task-1', title:'祥辉过来', date:'2026-09-05', requested_date:'2026-09-05', requested_time:'15:00', status:'open', notes:'' }, pending:null, events:[], calls:[], responses:new Map(), provider:new Map(), fail:false };
  const adapters = {
    async reserveRequest(input) { const old=state.responses.get(input.request_id); if(old && old.hash!==input.request_hash)return{state:'conflict'}; if(old?.status==='succeeded')return{state:'replay',response:old.response}; if(old?.status==='processing')return{state:'processing'}; state.responses.set(input.request_id,{hash:input.request_hash,status:'processing'});return{state:'new'}; },
    async finishRequest(input) { Object.assign(state.responses.get(input.request_id),input); },
    async getTask() { return structuredClone(state.task); },
    async getPending() { return state.pending && ['awaiting_confirmation','committing','failed'].includes(state.pending.status) ? structuredClone(state.pending):null; },
    async savePending(input) { if(state.pending?.status==='committing')throw new Error('already committing');state.pending={...structuredClone(input),status:'awaiting_confirmation'};return structuredClone(state.pending); },
    async claimPending(input) { if(input.proposal_id!==state.pending?.id || !['awaiting_confirmation','failed'].includes(state.pending.status))return{state:'processing'}; state.pending.status='committing';return{state:'claimed',pending:structuredClone(state.pending)}; },
    async finalizePending(input) { if(state.pending.status==='committing' && ['discarded','superseded'].includes(input.status))throw new Error('already committing');Object.assign(state.pending,input); },
    async appendEvent(input) { state.events.push(structuredClone(input)); },
    async getHistory() { return structuredClone(state.events); },
    async execute(input) {
      state.calls.push(structuredClone(input));
      if(state.fail){state.fail=false;throw new Error('provider unavailable');}
      if(state.provider.has(input.idempotency_key))return structuredClone(state.provider.get(input.idempotency_key));
      assert.equal(input.expected_task_version,taskConversationVersion(state.task),'write must match the preview snapshot');
      let result;
      if(input.operation==='create') result={success:true,task:{id:'child',...input.changes},created_task:{id:'child',...input.changes},message:'已创建并关联下一步任务。'};
      else {state.task={...state.task,...input.changes,status:input.operation==='complete'?'completed':input.operation==='cancel'?'cancelled':state.task.status};result={success:true,task:structuredClone(state.task),message:'已核实'};}
      state.provider.set(input.idempotency_key,structuredClone(result));return result;
    },
  };
  let seq=0;
  const options={now:()=>new Date('2026-09-05T04:00:00Z'),makeProposalId:()=>`proposal-${++seq}`};
  const send=(text,extra={})=>runTaskConversation({task_id:'task-1',text,source:'text',request_id:`req-${++seq}`, ...extra},adapters,options);
  return {state,adapters,send};
}

for (const [text,operation] of [['已经聊完了','complete'],['不约了','cancel']]) test(`real parser confirmation executes ${operation}, never generic update/delete`,async()=>{
  const {state,send}=fixture();const p=await send(text);assert.equal(state.calls.length,0);
  await send('对',{proposal_id:p.response.pending.id});assert.equal(state.calls[0].operation,operation);
});
test('uncertainty and clarification perform no writes; rejection invalidates old preview',async()=>{
  const {state,send}=fixture();await send('他可能四点才到');assert.equal(state.task.requested_time,'15:00');
  const p=await send('改四点');await send('不对');assert.equal(state.pending.status,'superseded');
  await send('对',{proposal_id:p.response.pending.id});assert.equal(state.calls.filter(x=>x.operation!=='update'||x.changes.requested_time).length,0);
});
test('confirmation requires current token and detects external changes',async()=>{
  const {state,send}=fixture();const p=await send('改四点');
  await assert.rejects(send('对'),{code:'PROPOSAL_TOKEN_REQUIRED'});
  await assert.rejects(send('对',{proposal_id:'other'}),{code:'PROPOSAL_TOKEN_REQUIRED'});
  state.task.title='external edit';await assert.rejects(send('对',{proposal_id:p.response.pending.id}),{code:'TASK_CHANGED_SINCE_PROPOSAL'});assert.equal(state.calls.length,0);
});
test('same successful request replays without writing twice; altered input conflicts',async()=>{
  const {state,send}=fixture();const p=await send('改四点');const args={proposal_id:p.response.pending.id,request_id:'stable-confirm'};
  await send('对',args);const result=await send('对',args);assert.equal(result.response.replayed,true);assert.equal(state.calls.length,1);
  await assert.rejects(send('改五点',args),{code:'REQUEST_ID_CONFLICT'});
});
test('failed confirmation retries the same provider key and immutable snapshot',async()=>{
  const {state,send}=fixture();const p=await send('改四点');state.fail=true;const args={proposal_id:p.response.pending.id,request_id:'retry-confirm'};
  await assert.rejects(send('对',args),/provider unavailable/);assert.equal(state.task.requested_time,'15:00');
  await send('对',args);assert.equal(state.task.requested_time,'16:00');assert.equal(state.calls[0].idempotency_key,state.calls[1].idempotency_key);
});
test('failed proposal cannot overwrite a later external edit',async()=>{
  const {state,send}=fixture();const p=await send('改四点');state.fail=true;const args={proposal_id:p.response.pending.id,request_id:'retry-conflict'};
  await assert.rejects(send('对',args));state.task.notes='external information';await assert.rejects(send('对',args),/preview snapshot/);assert.equal(state.task.requested_time,'15:00');
});
test('follow-up keeps original task bound and original semantic input for dedup',async()=>{
  const {state,send}=fixture();const raw='下午三点半提醒我问一下他到哪了';const p=await send(raw);const r=await send('对',{proposal_id:p.response.pending.id});
  assert.equal(r.response.task.id,'task-1');assert.equal(r.response.created_task.id,'child');assert.equal(state.calls[0].operation,'create');assert.equal(state.calls[0].changes.raw_text,raw);assert.equal(state.calls[0].changes.parent_task_id,'task-1');
});
test('low-risk notes append directly and failed retry does not duplicate content',async()=>{
  const {state,send}=fixture();state.fail=true;const args={request_id:'retry-note'};await assert.rejects(send('他会带两个同事',args));await send('他会带两个同事',args);await send('他会带两个同事',args);assert.equal(state.task.notes,'他会带两个同事');
});
test('soft cancellation lives in original Google Task and ordinary notes parsing is backward compatible',()=>{
  assert.deepEqual(splitTaskNotes('note'),{notes:'note',originalIntent:''});
  const task=toTaskModel({id:'same',title:'Meeting',status:'completed',notes:markTaskCancelledNotes('keep history')});assert.equal(task.id,'same');assert.equal(task.status,'cancelled');assert.equal(task.notes,'keep history');assert.equal(task.done,false);
});
test('migration enforces owner-only reads, server-only confirmation, immutable audit and one active proposal',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/202609050004_task_conversation_v1.sql',import.meta.url),'utf8');
  assert.match(sql,/task_conversation_one_active_change/);assert.match(sql,/before update or delete on public.task_conversation_events/);assert.match(sql,/for select to authenticated using/);assert.match(sql,/revoke all on function public.claim_task_conversation_pending.*from public, anon, authenticated/);assert.match(sql,/cannot discard a committing proposal/);
});

test('ordinary notes cannot inject the reserved cancellation status',async()=>{
  const {normalizeTaskPatch}=await import('../supabase/functions/_shared/task-lifecycle-core.js');
  assert.throws(()=>normalizeTaskPatch({changes:{notes:'note\n[Personal OS status: cancelled]'}}),/reserved cancellation marker/);
});
