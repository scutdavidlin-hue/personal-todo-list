import test from 'node:test';
import assert from 'node:assert/strict';
import {writeReceipt,verifyCalendarProjection} from '../supabase/functions/_shared/write-receipt.js';
test('partial Task success is not failed Task or delivered notification',()=>{
 const r=writeReceipt({taskId:'t',taskVerified:true,projection:{success:false,code:'CALENDAR_SCOPE_MISSING'}});
 assert.equal(r.task_save_status,'verified'); assert.equal(r.reminder_projection_status,'pending'); assert.equal(r.retryable,false); assert.equal(r.device_delivery_status,'not_verified'); assert.equal(r.next_step,'recover_projection_only');
});
test('HTTP acceptance without readback never means verified reminder',()=>{
 assert.equal(writeReceipt({taskVerified:true,projection:{projected:true,calendar_event_id:'e'}}).reminder_projection_status,'unverified');
 assert.equal(writeReceipt({taskVerified:true,projection:{projected:true,calendar_event_id:'e',verified_at:'2026-09-24T00:00:00Z',notification_status:'projected',reminders:[{method:'popup',minutes:0}]}}).reminder_projection_status,'configured');
});
test('uncertain write asks reconciliation and preserves task identity',()=>{
 const r=writeReceipt({taskId:'t'}); assert.equal(r.task_id,'t'); assert.equal(r.task_save_status,'unknown'); assert.equal(r.next_step,'reconcile_same_request');
});
const event={id:'e',summary:'Test',start:{dateTime:'2026-09-25T15:00:00+08:00'},end:{dateTime:'2026-09-25T16:00:00+08:00'},reminders:{useDefault:false,overrides:[{method:'popup',minutes:30}]},extendedProperties:{private:{googleTaskId:'t'}}};
test('calendar verification compares instants, offsets and stable linked identity',()=>{
 assert.equal(verifyCalendarProjection(event,{...event,start:{dateTime:'2026-09-25T07:00:00Z'}}),true);
 for(const patch of [{id:'other'},{status:'cancelled'},{reminders:{useDefault:true}},{reminders:{useDefault:false,overrides:[{method:'popup',minutes:0}]}},{extendedProperties:{private:{googleTaskId:'wrong'}}},{start:{dateTime:'2026-09-25T08:00:00Z'}}]) assert.throws(()=>verifyCalendarProjection(event,{...event,...patch}),{code:'CALENDAR_WRITE_UNVERIFIED'});
});

test('projection readback understands Calendar normalizing Shanghai wall time',()=>{
 const expected={...event,start:{dateTime:'2026-09-25T15:00:00',timeZone:'Asia/Shanghai'},end:{dateTime:'2026-09-25T16:00:00',timeZone:'Asia/Shanghai'}};
 assert.equal(verifyCalendarProjection(expected,event),true);
});

test('verified event without notifications is not a configured reminder',()=>{
 const r=writeReceipt({taskVerified:true,projection:{projected:true,calendar_event_id:'e',verified_at:'2026-09-24T00:00:00Z',notification_status:'not_required',reminders:[]}});
 assert.equal(r.reminder_projection_status,'not_requested'); assert.equal(r.next_step,null);
 const d=writeReceipt({taskVerified:true,schedule:{scheduled_start:'2026-09-25T15:00',reminder_policy:'none'}});
 assert.equal(d.reminder_projection_status,'disabled');assert.equal(d.next_step,null);
});
test('requested schedule stays pending on non-retryable authorization failure',()=>{
 const r=writeReceipt({taskVerified:true,scheduleRequested:true,error:{code:'GOOGLE_REAUTH_REQUIRED',retryable:false}});
 assert.equal(r.schedule_status,'pending');assert.equal(r.retryable,false);assert.equal(r.reminder_projection_status,'pending');
});
