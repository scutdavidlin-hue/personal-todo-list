import test from "node:test";
import assert from "node:assert/strict";
import { resolveReminderPolicy, reminderNotificationCue, reminderActionGuidance } from "../supabase/functions/_shared/reminder-policy-core.js";
import { normalizeScheduleInput, buildCalendarEvent } from "../supabase/functions/_shared/schedule-core.js";

const fixed = { scheduled_date: "2099-01-08", scheduled_start: "19:00", scheduled_end: "19:30", fixed_time: true, scheduling_source: "explicit_user", timezone: "Asia/Shanghai" };
for (const text of ["乘坐某列车，从某高铁车站出发，提前安检进站", "乘坐某列车，从某车站出发，提前安检进站"]) test(`explicit fictional rail security uses station guidance: ${text}`, () => {
  const policy = resolveReminderPolicy({ ...fixed, title: "某列车出行", raw_text: text });
  assert.equal(policy.reminder_context.task_kind, "train"); assert.equal(policy.reminder_context.transportation, "train");
  assert.match(reminderNotificationCue(policy), /车站|进站/); assert.doesNotMatch(reminderNotificationCue(policy), /机场|值机|登机/);
  assert.doesNotMatch(reminderActionGuidance({ title: "某列车出行" }, policy), /机场|值机|登机/);
});
test("actual Calendar builder does not turn a rail security instruction into an airport projection", () => {
  const text = "乘坐某列车，从某高铁车站出发，提前安检进站";
  const schedule = normalizeScheduleInput({ ...fixed, title: "某列车出行", raw_text: text });
  const event = buildCalendarEvent({ id: "synthetic-rail-task", title: "某列车出行", notes: text, originalIntent: text, dueDate: fixed.scheduled_date }, schedule);
  assert.match(event.summary, /车站|进站/); assert.doesNotMatch(event.summary + event.description, /机场|值机|登机/);
});
test("rail context is recomputed from clear current intent without changing explicit reminder timing", () => {
  const reminders = [{ type: "departure", offset_minutes: 60, at: "2099-01-08T18:00" }];
  const schedule = normalizeScheduleInput({ ...fixed, title: "某列车出行", raw_text: "从某高铁车站乘坐某列车，安检进站",
    reminder_policy: "custom", reminder_policy_source: "user_explicit", reminders,
    reminder_context: { task_kind: "flight", transportation: "train", need_travel: true } }, { preserveReminderPolicy: true });
  assert.equal(schedule.reminder_context.task_kind, "train"); assert.deepEqual(schedule.reminders, reminders);
});
for (const text of ["前往某机场，预留安检登机时间", "先坐某列车到某机场，再乘飞机出行"]) test(`explicit flight cues remain flight rather than being overridden by a rail mention: ${text}`, () => {
  const policy = resolveReminderPolicy({ ...fixed, title: "虚构出行", raw_text: text });
  assert.equal(policy.reminder_context.task_kind, "flight"); assert.match(reminderNotificationCue(policy), /机场值机/);
});
test("caller-provided airport wording is not silently rewritten into a rail-only journey", () => {
  const policy = resolveReminderPolicy({ ...fixed, title: "某列车出行", raw_text: "从某高铁车站出发", notes: "机场值机" });
  assert.equal(policy.reminder_context.task_kind, "flight");
});
