import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAutonomy} from '../supabase/functions/_shared/autonomy-policy.js';
import {normalizeScheduleInput} from '../supabase/functions/_shared/schedule-core.js';
import {verifyCalendarProjection} from '../supabase/functions/_shared/write-receipt.js';
test('spoken five cannot overwrite explicit 17:00',()=>{
 const r=evaluateAutonomy({raw_text:'提醒一下我五点的时候跟小英聊聊',type:'task',requested_date:'2026-10-06',requested_time:'17:00',timezone:'Asia/Shanghai',reminder_at:'2026-10-06T17:00'},{baseDate:'2026-10-06T06:05:00Z'});
 assert.equal(r.input.requested_time,'17:00');assert.equal(r.input.reminder_at,'2026-10-06T17:00');
});
test('date-only smart policy does not fabricate opt-out after repeat normalization',()=>{
 const a=normalizeScheduleInput({raw_text:'今晚提醒我取身份证',scheduled_date:'2026-10-06',reminder_policy:'smart',reminder_policy_source:'ai_inferred'});
 const b=normalizeScheduleInput(a);assert.equal(b.reminder_policy_source,'ai_inferred');assert.notEqual(b.reminder_reason,'用户明确要求不提醒');assert.equal(b.reminder_at,null);
});
test('explicit no reminder is retained',()=>{
 const a=normalizeScheduleInput({raw_text:'今天不要提醒',scheduled_date:'2026-10-06',reminder_policy:'none',reminder_policy_source:'user_explicit'});assert.equal(a.notification_status,'disabled');
});
test('Calendar omitted default is equivalent but explicit transparent fails',()=>{
 const e={id:'e',transparency:'opaque',start:{dateTime:'2026-10-06T17:00:00+08:00'},end:{dateTime:'2026-10-06T17:15:00+08:00'},reminders:{useDefault:false,overrides:[{method:'popup',minutes:0}]}};const a={...e};delete a.transparency;
 assert.equal(verifyCalendarProjection(e,a),true);assert.throws(()=>verifyCalendarProjection(e,{...a,transparency:'transparent'}),{code:'CALENDAR_WRITE_UNVERIFIED'});
});
