import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntake } from '../supabase/functions/_shared/personal-os-intake.js';
import { normalizeRecurrence } from '../supabase/functions/_shared/task-recurrence-core.js';
const base = {type:'task',title:'模拟规则',raw_text:'整理资料',due:'2099-12-20',reminder_policy:'none'};
for (const recurrence of [{kind:'yearly',count:1},{kind:'yearly',until:'2099-12-31'},
  {kind:'yearly',COUNT:1},{kind:'yearly',rrule:'FREQ=YEARLY;COUNT=1'},
  {kind:'yearly',rrule:'FREQ=YEARLY;UNTIL=20991231'},
  {kind:'yearly',rrule:'FREQ=YEARLY;BYSETPOS=1'},
  {kind:'daily',rrule:'FREQ=YEARLY'}, {kind:'yearly',interval:2,rrule:'FREQ=YEARLY'},
  {kind:'yearly',rrule:'FREQ=YEARLY;COUNT'}, {kind:'yearly',rrule:'FREQ=DAILY;FREQ=YEARLY'},
  {kind:'yearly',rrule:'FREQ=YEARLY;UNTIL='},{kind:'yearly',rrule:''}]) {
  test(`explicit recurrence semantics reject before stripping: ${JSON.stringify(recurrence)}`,()=>{
    assert.throws(()=>normalizeIntake({...base,recurrence}),{code:'UNSUPPORTED_RECURRENCE_RULE'});
    assert.throws(()=>normalizeRecurrence(recurrence,{scheduled_date:base.due,timezone:'Asia/Shanghai'}),{code:'UNSUPPORTED_RECURRENCE_RULE'});
  });
}
for (const recurrence of [{kind:'yearly',rrule:'FREQ=YEARLY;INTERVAL=2;BYMONTH=12;BYMONTHDAY=20'},
  {rrule:'FREQ=YEARLY;INTERVAL=2;BYMONTH=12;BYMONTHDAY=20'},
  {RRULE:'FREQ=YEARLY;INTERVAL=2;BYMONTH=12;BYMONTHDAY=20'}]) {
  test(`supported RRULE retains cadence: ${JSON.stringify(recurrence)}`,()=>{
    const normalized=normalizeIntake({...base,recurrence}).recurrence;
    assert.deepEqual(normalized,{kind:'yearly',interval:2,month:12,month_day:20});
  });
}
