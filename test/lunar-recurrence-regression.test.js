import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntake } from '../supabase/functions/_shared/personal-os-intake.js';
import { normalizeRecurrence, nextRuleDate } from '../supabase/functions/_shared/task-recurrence-core.js';
import { normalizeTaskPatch, hasScheduleChanges } from '../supabase/functions/_shared/task-lifecycle-core.js';
import { applyTaskSchedulePatch } from '../supabase/functions/_shared/schedule-core.js';
import { verifyTaskScheduleDate } from '../supabase/functions/_shared/write-receipt.js';
const schedule = { scheduled_date: '2099-12-20', timezone: 'Asia/Shanghai', reminder_policy: 'none' };
const base = { type: 'task', title: '模拟年重复', due: schedule.scheduled_date, reminder_policy: 'none' };
for (const calendarFields of [{ RSCALE: 'CHINESE' }, { rscale: 'chinese' }, { calendar: 'lunar' },
  { calendarSystem: 'chinese' }, { calendar_system: '农历' }, { rrule: 'FREQ=YEARLY;RSCALE=CHINESE;BYMONTH=11;BYMONTHDAY=12' },
  { rrule: 'RRULE:FREQ=YEARLY; rscale =CHINESE;BYMONTH=11;BYMONTHDAY=12' }]) {
  test(`lunar recurrence cannot silently become Gregorian: ${JSON.stringify(calendarFields)}`, () => {
    const recurrence = { kind: 'yearly', ...calendarFields };
    const rejects = error => error.code === 'UNSUPPORTED_RECURRENCE_CALENDAR';
    assert.throws(() => normalizeIntake({ ...base, raw_text: '模拟重复事项', recurrence }), rejects);
    assert.throws(() => normalizeRecurrence(recurrence, schedule), rejects);
    assert.throws(() => nextRuleDate(schedule.scheduled_date, recurrence), rejects);
  });
}
for (const raw_text of ['每年农历十一月十二提醒整理资料', '每年陰曆十一月十二提醒整理资料', '每年农历11月12日提醒整理资料']) {
  test(`raw lunar semantics survive rejection: ${raw_text}`, () => {
    const input = { ...base, raw_text };
    assert.throws(() => normalizeIntake(input), /UNSUPPORTED_RECURRENCE_CALENDAR/);
    assert.equal(input.raw_text, raw_text);
    assert.equal(input.due, '2099-12-20');
  });
}
test('ordinary Gregorian yearly recurrence remains supported', () => {
  const rule = normalizeRecurrence({ kind: 'yearly' }, schedule);
  assert.equal(nextRuleDate('2099-12-20', rule), '2100-12-20');
});
for (const field of ['dueDate', 'due', 'date']) {
  test(`execution date alias updates schedule and rejects stale readback: ${field}`, () => {
    const patch = normalizeTaskPatch({ changes: { [field]: '2099-12-21' } });
    assert.equal(patch.due, '2099-12-21');
    assert.equal(hasScheduleChanges(patch), true);
    const updated = applyTaskSchedulePatch(schedule, patch).schedule;
    assert.equal(updated.scheduled_date, '2099-12-21');
    assert.throws(() => verifyTaskScheduleDate({ dueDate: patch.due, schedule }, patch), { code: 'SCHEDULE_WRITE_UNVERIFIED' });
    assert.equal(verifyTaskScheduleDate({ dueDate: patch.due, schedule: updated }, patch), true);
  });
}
test('conflicting aliases and execution dates fail before write', () => {
  assert.throws(() => normalizeTaskPatch({ changes: { dueDate: '2099-12-21', due: '2099-12-20' } }), /must match/);
  assert.throws(() => normalizeTaskPatch({ changes: { dueDate: '2099-12-21', requested_date: '2099-12-20' } }), /must match/);
});
test('clearing dueDate clears schedule date and rejects a retained old date', () => {
  const patch = normalizeTaskPatch({ changes: { dueDate: null } });
  const updated = applyTaskSchedulePatch(schedule, patch).schedule;
  assert.equal(updated.scheduled_date, null);
  assert.throws(() => verifyTaskScheduleDate({ schedule }, patch), { code: 'SCHEDULE_WRITE_UNVERIFIED' });
  assert.equal(verifyTaskScheduleDate({ schedule: updated }, patch), true);
});
