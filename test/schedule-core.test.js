import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCalendarEvent,
  normalizeScheduleInput,
  planTaskSlots,
  stableCalendarEventId,
} from "../supabase/functions/_shared/schedule-core.js";

test("normalizes explicit schedule without copying task state", () => {
  const schedule = normalizeScheduleInput({
    requested_date: "2026-09-05",
    requested_time: "15:00",
    estimated_duration: 45,
    scheduling_source: "explicit_user",
    fixed_time: true,
  });
  assert.deepEqual({
    scheduled_date: schedule.scheduled_date,
    scheduled_start: schedule.scheduled_start,
    scheduled_end: schedule.scheduled_end,
    timezone: schedule.timezone,
    duration_minutes: schedule.duration_minutes,
    scheduling_status: schedule.scheduling_status,
    scheduling_source: schedule.scheduling_source,
    calendar_id: schedule.calendar_id,
    fixed_time: schedule.fixed_time,
    priority: schedule.priority,
    deadline: schedule.deadline,
    deadline_time: schedule.deadline_time,
  }, {
    scheduled_date: "2026-09-05",
    scheduled_start: "15:00",
    scheduled_end: "15:45",
    timezone: "Asia/Shanghai",
    duration_minutes: 45,
    scheduling_status: "scheduled",
    scheduling_source: "explicit_user",
    calendar_id: "primary",
    fixed_time: true,
    priority: "medium",
    deadline: null,
    deadline_time: null,
  });
  assert.equal(schedule.reminder_policy, "smart");
  assert.equal(schedule.reminder_policy_source, "ai_inferred");
  assert.equal(schedule.reminders.length, 1);
});

test("normalizes Postgres time values before building Calendar timestamps", () => {
  const schedule = normalizeScheduleInput({ scheduled_date: "2026-09-05", scheduled_start: "15:00:00", scheduled_end: "15:30:00" });
  assert.equal(schedule.scheduled_start, "15:00");
  assert.equal(schedule.scheduled_end, "15:30");
});

test("stable event id is deterministic and Calendar-safe", async () => {
  const left = await stableCalendarEventId("google-task-123");
  const right = await stableCalendarEventId("google-task-123");
  assert.equal(left, right);
  assert.match(left, /^[a-v0-9]{5,1024}$/);
});

test("Calendar projection keeps one task id and disables completed-task reminders", () => {
  const schedule = { scheduled_date: "2026-09-05", scheduled_start: "15:00", scheduled_end: "15:30", scheduling_source: "explicit_user" };
  const open = buildCalendarEvent({ id: "task-1", title: "导出 ChatGPT 历史数据", status: "open" }, schedule, "posevent");
  const done = buildCalendarEvent({ id: "task-1", title: "导出 ChatGPT 历史数据", status: "completed" }, schedule, "posevent");
  assert.equal(open.id, done.id);
  assert.equal(open.summary, "☐ 导出 ChatGPT 历史数据｜提前开始准备");
  assert.equal(done.summary, "✓ 导出 ChatGPT 历史数据");
  assert.equal(done.extendedProperties.private.googleTaskId, "task-1");
  assert.equal(done.reminders.useDefault, false);
  assert.ok(open.reminders.overrides.length > 0);
  assert.deepEqual(done.reminders.overrides, []);
});

test("morning planner avoids busy time, keeps undated tasks in backlog, and never moves fixed schedules", () => {
  const tasks = [
    { id: "due", title: "今天要做", dueDate: "2026-09-04", status: "open", priority: "high" },
    { id: "undated", title: "以后再做", dueDate: null, status: "open" },
    { id: "fixed", title: "固定事项", dueDate: "2026-09-04", status: "open" },
  ];
  const schedules = [{ google_task_id: "fixed", scheduled_date: "2026-09-04", scheduled_start: "10:00", scheduled_end: "10:30", fixed_time: true }];
  const result = planTaskSlots(tasks, schedules, { "2026-09-04": [{ start: "09:00", end: "10:00" }] }, { today: "2026-09-04" });
  assert.deepEqual(result.plans.map((plan) => plan.google_task_id), ["due"]);
  assert.equal(result.plans[0].scheduled_start, "10:00");
  assert.deepEqual(result.backlog, ["undated"]);
});

test("morning planning preserves an exact deadline anchor and its reminder policy", () => {
  const tasks = [{ id: "deadline", title: "发送材料", dueDate: null, status: "open", priority: "high" }];
  const schedules = [{
    google_task_id: "deadline",
    deadline: "2026-09-05",
    deadline_time: "18:00",
    scheduling_status: "unscheduled",
    fixed_time: false,
  }];
  const result = planTaskSlots(tasks, schedules, {}, { today: "2026-09-05" });
  assert.deepEqual(result.plans, []);
  assert.deepEqual(result.backlog, []);
});
