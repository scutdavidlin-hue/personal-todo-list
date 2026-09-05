import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIntake, taskDispatchPayload } from "../supabase/functions/_shared/personal-os-intake.js";
import { evaluateAutonomy } from "../supabase/functions/_shared/autonomy-policy.js";
import { applyTaskSchedulePatch, buildCalendarEvent, normalizeScheduleInput, stableCalendarEventId } from "../supabase/functions/_shared/schedule-core.js";

test("travel context Date is persisted in Google Tasks and does not invent a Deadline", () => {
  const policy = evaluateAutonomy({
    raw_text: "旅游的时候提醒我从亚朵多拿几个梳子。",
    context: { conversation_trips: [{ title: "东北旅行", start_date: "2026-09-08", end_date: "2026-09-21" }] },
  }, { baseDate: "2026-09-05T12:00:00+08:00" });
  const task = taskDispatchPayload(normalizeIntake(policy.input));
  assert.equal(task.dueDate, "2026-09-08");
  assert.equal(task.schedule.scheduled_date, "2026-09-08");
  assert.equal(task.schedule.deadline, null);
  assert.equal(task.originalIntent, "旅游的时候提醒我从亚朵多拿几个梳子。");
});

test("15 to 16 to 15 patches one Calendar identity and preserves task content", async () => {
  const task = { id: "meeting-1", title: "翔辉到公司", notes: "核对资料", status: "open" };
  let schedule = normalizeScheduleInput({ scheduled_date: "2026-09-05", scheduled_start: "15:00", duration_minutes: 60 });
  const eventId = await stableCalendarEventId(task.id);
  for (const requestedTime of ["16:00", "15:00"]) {
    schedule = applyTaskSchedulePatch(schedule, { requested_time: requestedTime }, "2026-09-05").schedule;
    const event = buildCalendarEvent(task, schedule, eventId);
    assert.equal(event.id, eventId);
    assert.equal(schedule.scheduled_start, requestedTime);
    assert.ok(event.start.dateTime.includes(`T${requestedTime}`));
    assert.equal(task.title, "翔辉到公司");
    assert.equal(task.notes, "核对资料");
  }
});

test("existing lifecycle fields survive reminder normalization and unrelated schedule edits", () => {
  const schedule = normalizeScheduleInput({
    scheduled_date: "2026-09-08", task_type: "follow_up", follow_up_of: "original-1",
    parent_task_id: "original-1", follow_up_sequence: 2,
  });
  const patched = applyTaskSchedulePatch(schedule, { priority: "high" }).schedule;
  assert.equal(patched.task_type, "follow_up");
  assert.equal(patched.follow_up_of, "original-1");
  assert.equal(patched.parent_task_id, "original-1");
  assert.equal(patched.follow_up_sequence, 2);
});
