import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  calendarReminderOverrides,
  mergeReminderPolicyUpdate,
  reminderActionGuidance,
  resolveReminderPolicy,
} from "../supabase/functions/_shared/reminder-policy-core.js";
import {
  buildCalendarEvent,
  calendarProjectionWindow,
  normalizeScheduleInput,
} from "../supabase/functions/_shared/schedule-core.js";

const fixed = {
  scheduled_date: "2026-09-05",
  scheduled_start: "15:00",
  scheduled_end: "16:00",
  scheduling_source: "explicit_user",
  fixed_time: true,
  timezone: "Asia/Shanghai",
};

test("PRD Test 1: an exact user reminder overrides all inference", () => {
  const policy = resolveReminderPolicy({
    ...fixed,
    raw_text: "15:00开会，12:00提醒。",
    title: "开会",
  });
  assert.equal(policy.reminder_policy, "custom");
  assert.equal(policy.reminder_policy_source, "user_explicit");
  assert.deepEqual(policy.reminders, [{ type: "preparation", offset_minutes: 180, at: "2026-09-05T12:00" }]);
  assert.equal(policy.reminder_at, "2026-09-05T12:00");
});

test("PRD Test 2: going to an airport infers preparation and departure", () => {
  const policy = resolveReminderPolicy({ ...fixed, raw_text: "15:00去机场。", title: "去机场" });
  assert.equal(policy.reminder_policy, "smart");
  assert.equal(policy.reminder_policy_source, "ai_inferred");
  assert.equal(policy.reminder_context.task_kind, "flight");
  assert.equal(policy.reminder_context.need_preparation, true);
  assert.equal(policy.reminder_context.need_travel, true);
  assert.deepEqual(policy.reminders.map((item) => item.type), ["preparation", "departure"]);
  assert.ok(policy.reminders[0].offset_minutes >= 180);
});

test("Level 2 early-reminder intent infers timing without pretending it was exact", () => {
  const policy = resolveReminderPolicy({ ...fixed, raw_text: "15:00开会，早点提醒我。", title: "开会" });
  assert.equal(policy.reminder_policy, "smart");
  assert.equal(policy.reminder_policy_source, "ai_inferred");
  assert.equal(policy.reminders.length, 1);
  assert.ok(policy.reminders[0].offset_minutes > 0);
});

test("PRD Test 3: an ordinary Todo creates no extra reminder", () => {
  const dateOnly = resolveReminderPolicy({
    scheduled_date: "2026-09-05",
    scheduling_source: "explicit_user",
    raw_text: "今天整理桌面。",
    title: "整理桌面",
  });
  assert.equal(dateOnly.reminder_policy, "none");
  assert.equal(dateOnly.reminders.length, 0);

  const flexibleSlot = resolveReminderPolicy({
    ...fixed,
    fixed_time: false,
    scheduling_source: "morning_plan",
    raw_text: "今天整理桌面。",
    title: "整理桌面",
  });
  assert.equal(flexibleSlot.reminder_policy, "none");
  assert.equal(flexibleSlot.reminders.length, 0);
});

test("a scheduled follow-up uses one action reminder on the same Task", () => {
  const policy = resolveReminderPolicy({
    ...fixed,
    scheduling_source: "morning_plan",
    fixed_time: false,
    raw_text: "明天下午跟进小熊学长。",
    title: "跟进小熊学长",
  });
  assert.equal(policy.reminder_context.task_kind, "follow_up");
  assert.deepEqual(policy.reminders, [
    { type: "event", offset_minutes: 0, at: "2026-09-05T15:00" },
  ]);
});

test("the current Xianghui case creates two context-aware reminders", () => {
  const policy = resolveReminderPolicy({
    ...fixed,
    raw_text: "今天下午3点祥晖到公司聊天。起床吃早餐，然后运动一下，再自己坐地铁去公司。不让我老婆送。",
    title: "祥晖到公司聊天",
  });
  assert.equal(policy.reminder_context.transportation, "metro");
  assert.deepEqual(policy.reminder_context.pre_event_actions, ["起床", "吃早餐", "运动"]);
  assert.deepEqual(policy.reminders, [
    { type: "preparation", offset_minutes: 165, at: "2026-09-05T12:15" },
    { type: "departure", offset_minutes: 90, at: "2026-09-05T13:30" },
  ]);
  const guidance = reminderActionGuidance({ title: "祥晖到公司聊天" }, { ...fixed, ...policy });
  assert.match(guidance, /起床、吃早餐、运动后/);
  assert.match(guidance, /自己坐地铁过去/);
  const event = buildCalendarEvent({ id: "task-1", title: "祥晖到公司聊天", status: "open" }, { ...fixed, ...policy }, "posevent");
  assert.match(event.summary, /祥晖到公司聊天｜起床、吃早餐、运动后，自己坐地铁过去并预留通勤时间/);
  assert.match(event.description, /行动提示/);
});

test("PRD Tests 4-6: reminder update keeps identities and never inserts a Task", async () => {
  const eventId = "posstableevent";
  const task = { id: "task-1", title: "祥晖到公司聊天", status: "open" };
  const withoutReminder = buildCalendarEvent(task, {
    ...fixed,
    reminder_policy: "none",
    reminder_policy_source: "user_explicit",
  }, eventId);
  const withReminder = buildCalendarEvent(task, {
    ...fixed,
    reminder_policy: "custom",
    reminder_policy_source: "user_explicit",
    reminder_at: "12:00",
    reminder_type: "preparation",
  }, eventId);
  assert.equal(withoutReminder.id, withReminder.id);
  assert.equal(withReminder.extendedProperties.private.googleTaskId, task.id);
  assert.deepEqual(withReminder.reminders.overrides, [{ method: "popup", minutes: 180 }]);

  const scheduler = await readFile(new URL("../supabase/functions/task-scheduler/index.ts", import.meta.url), "utf8");
  const updateBody = scheduler.slice(scheduler.indexOf("async function updateTaskReminder"), scheduler.indexOf("async function syncTask"));
  assert.match(updateBody, /SCHEDULE_IDENTITY_CHANGED/);
  assert.match(updateBody, /CALENDAR_EVENT_IDENTITY_CHANGED/);
  assert.match(updateBody, /google_tasks_count_delta:\s*0/);
  assert.match(updateBody, /mergeReminderPolicyUpdate/);
  assert.doesNotMatch(updateBody, /TASKS_BASE|tasksPath|method:\s*["']POST["']/);
  assert.match(scheduler, /task\.status === "completed"[\s\S]{0,120}\? "disabled"/);
});

test("switching an existing custom reminder back to smart clears stale exact timing", () => {
  const merged = mergeReminderPolicyUpdate({
    ...fixed,
    reminder_policy: "custom",
    reminder_policy_source: "user_explicit",
    reminder_at: "2026-09-05T12:00",
    reminder_offset_minutes: 180,
    reminder_type: "preparation",
    reminders: [{ type: "preparation", offset_minutes: 180, at: "2026-09-05T12:00" }],
  }, { reminder_policy: "smart" });
  assert.equal(merged.reminder_at, null);
  assert.equal(merged.reminder_offset_minutes, null);
  assert.deepEqual(merged.reminders, []);
  const policy = resolveReminderPolicy({ ...merged, raw_text: "15:00开会", title: "开会" });
  assert.equal(policy.reminder_policy, "smart");
  assert.equal(policy.reminder_policy_source, "ai_inferred");
  assert.notEqual(policy.reminder_at, "2026-09-05T12:00");
});

test("an explicit reminder list replaces an inferred policy as custom", () => {
  const merged = mergeReminderPolicyUpdate({
    ...fixed,
    reminder_policy: "smart",
    reminder_policy_source: "ai_inferred",
    reminder_at: "2026-09-05T14:15",
    reminder_offset_minutes: 45,
    reminder_type: "preparation",
    reminders: [{ type: "preparation", offset_minutes: 45, at: "2026-09-05T14:15" }],
  }, {
    reminders: [{ type: "preparation", at: "12:00" }],
  });
  const policy = resolveReminderPolicy({ ...merged, raw_text: "15:00开会", title: "开会" });
  assert.equal(policy.reminder_policy, "custom");
  assert.equal(policy.reminder_policy_source, "user_explicit");
  assert.deepEqual(policy.reminders, [
    { type: "preparation", offset_minutes: 180, at: "2026-09-05T12:00" },
  ]);
});

test("new travel context refreshes a smart policy without losing its Schedule", () => {
  const merged = mergeReminderPolicyUpdate({
    ...fixed,
    reminder_policy: "smart",
    reminder_policy_source: "ai_inferred",
    reminders: [{ type: "preparation", offset_minutes: 45, at: "2026-09-05T14:15" }],
    reminder_context: {
      task_kind: "meeting",
      need_preparation: true,
      need_travel: false,
      transportation: "none",
      preparation_minutes: 30,
      travel_minutes: 0,
      safety_buffer_minutes: 15,
      pre_event_actions: [],
    },
  }, {
    raw_text: "15:00开会，我改成打车过去。",
  });
  const policy = resolveReminderPolicy({ ...merged, title: "开会" });
  assert.equal(policy.reminder_context.transportation, "taxi");
  assert.equal(policy.reminder_context.need_travel, true);
  assert.equal(policy.reminder_policy, "smart");
});

test("PRD Test 7 projection uses a mobile-capable Calendar popup override", () => {
  const schedule = normalizeScheduleInput({
    ...fixed,
    raw_text: "15:00开会，12:00提醒。",
    title: "开会",
  });
  assert.deepEqual(calendarReminderOverrides(schedule), [{ method: "popup", minutes: 180 }]);
  const event = buildCalendarEvent({ id: "task-1", title: "开会", status: "open" }, schedule, "posevent");
  assert.deepEqual(event.reminders, { useDefault: false, overrides: [{ method: "popup", minutes: 180 }] });
});

test("notification spam protection suppresses Calendar defaults for no-reminder tasks", () => {
  const event = buildCalendarEvent({ id: "task-1", title: "整理桌面", status: "open" }, {
    scheduled_date: "2026-09-05",
    scheduled_start: "10:00",
    scheduled_end: "10:30",
    scheduling_source: "morning_plan",
    fixed_time: false,
  }, "posevent");
  assert.deepEqual(event.reminders, { useDefault: false, overrides: [] });
});

test("an explicit opt-out disables reminders", () => {
  const policy = resolveReminderPolicy({ ...fixed, raw_text: "15:00开会，不要提醒我。", title: "开会" });
  assert.equal(policy.reminder_policy, "none");
  assert.equal(policy.reminder_policy_source, "user_explicit");
  assert.equal(policy.notification_status, "disabled");
  assert.deepEqual(policy.reminders, []);
});

test("a custom policy without timing is rejected instead of silently inferring", () => {
  assert.throws(() => resolveReminderPolicy({
    ...fixed,
    reminder_policy: "custom",
    reminder_policy_source: "user_explicit",
    title: "开会",
  }), /custom reminder policy requires/);
});

test("a deadline time remains distinct and uses the one stable projection anchor", () => {
  const schedule = normalizeScheduleInput({
    deadline: "2026-09-05",
    deadline_time: "18:00",
    duration_minutes: 30,
    raw_text: "今天18:00之前把材料发出去。",
    title: "把材料发出去",
  });
  assert.equal(schedule.scheduled_date, null);
  assert.equal(schedule.scheduled_start, null);
  assert.equal(schedule.deadline, "2026-09-05");
  assert.equal(schedule.deadline_time, "18:00");
  assert.deepEqual(calendarProjectionWindow(schedule), {
    kind: "deadline",
    start: { date: "2026-09-05", time: "18:00" },
    end: { date: "2026-09-05", time: "18:05" },
  });
  assert.deepEqual(schedule.reminders.map((item) => item.offset_minutes), [60, 15]);
});

test("rescheduling recomputes local reminder times from stable offsets", () => {
  const original = normalizeScheduleInput({ ...fixed, raw_text: "15:00开会，提前1小时提醒。", title: "开会" });
  const moved = normalizeScheduleInput({
    ...original,
    scheduled_start: "16:00",
    scheduled_end: "17:00",
  });
  assert.equal(original.reminders[0].at, "2026-09-05T14:00");
  assert.equal(moved.reminders[0].at, "2026-09-05T15:00");
  assert.equal(moved.reminders[0].offset_minutes, 60);
});
