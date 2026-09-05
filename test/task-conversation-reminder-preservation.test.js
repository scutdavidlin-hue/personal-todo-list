import test from "node:test";
import assert from "node:assert/strict";
import { parseConversationInput } from "../supabase/functions/_shared/task-conversation-core.js";
import { applyTaskSchedulePatch, normalizeScheduleInput, buildCalendarEvent } from "../supabase/functions/_shared/schedule-core.js";

const task = { id: "acceptance-task", title: "会议测试", requested_date: "2026-09-06", requested_time: "20:15", originalIntent: "晚上八点十五开会", status: "open" };
const base = {
  scheduled_date: "2026-09-06", scheduled_start: "20:15", scheduled_end: "20:45", duration_minutes: 30,
  fixed_time: true, scheduling_status: "scheduled", scheduling_source: "explicit_user", timezone: "Asia/Shanghai",
  reminder_policy: "none", reminder_policy_source: "system_default", reminders: [], notification_status: "not_required",
};

function reschedule(current) {
  const parsed = parseConversationInput({ text: "改晚上八点半", task: { ...task, schedule: current }, now: "2026-09-06T10:00:00Z" });
  const options = { preserveReminderPolicy: true };
  const patched = applyTaskSchedulePatch(current, parsed.changes, task.requested_date, options).schedule;
  // Mirror updateTaskSchedule -> writeSchedule -> projectTask -> buildCalendarEvent.
  const stored = normalizeScheduleInput(patched, options);
  const projected = normalizeScheduleInput({ ...stored, title: task.title, raw_text: task.originalIntent }, options);
  return { parsed, stored, projected, event: buildCalendarEvent(task, projected, "same-event") };
}

test("conversation timing-only preview cannot turn an existing default-none policy into smart alerts", () => {
  const { parsed, stored, projected, event } = reschedule(base);
  assert.deepEqual(Object.keys(parsed.proposed_changes), ["time"]);
  for (const state of [stored, projected]) {
    assert.equal(state.reminder_policy, "none");
    assert.equal(state.reminder_policy_source, "system_default");
    assert.deepEqual(state.reminders, []);
  }
  assert.match(event.start.dateTime, /20:30:00$/);
  assert.deepEqual(event.reminders, { useDefault: false, overrides: [] });
});

for (const [policy, source] of [["smart", "ai_inferred"], ["custom", "user_explicit"]]) {
  test(`conversation preserves ${policy} reminder count and offset while shifting its time`, () => {
    const current = { ...base, reminder_policy: policy, reminder_policy_source: source,
      reminder_at: "2026-09-06T19:45", reminder_offset_minutes: 30, reminder_type: "preparation",
      reminders: [{ type: "preparation", at: "2026-09-06T19:45", offset_minutes: 30 }] };
    const { parsed, stored, event } = reschedule(current);
    assert.equal(parsed.proposed_changes.reminder.to, "2026-09-06T20:00");
    assert.equal(stored.reminder_policy, policy);
    assert.equal(stored.reminder_policy_source, source);
    assert.deepEqual(stored.reminders, [{ type: "preparation", at: "2026-09-06T20:00", offset_minutes: 30 }]);
    assert.deepEqual(event.reminders.overrides, [{ method: "popup", minutes: 30 }]);
  });
}

test("new task initial scheduling still infers smart reminders", () => {
  const fresh = normalizeScheduleInput({ scheduled_date: "2026-09-06", scheduled_start: "20:30", fixed_time: true, title: "会议测试" });
  assert.equal(fresh.reminder_policy, "smart");
  assert.ok(fresh.reminders.length > 0);
});
