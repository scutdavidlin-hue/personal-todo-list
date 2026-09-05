import test from "node:test";
import assert from "node:assert/strict";
import { classifyAction } from "../supabase/functions/_shared/action-router.js";
import { normalizeIntake } from "../supabase/functions/_shared/personal-os-intake.js";
import {
  canonicalTaskMutation,
  detectFollowUpIntent,
  ensureFollowUpTitle,
  googleTaskChanges,
  hasScheduleChanges,
  hydrateTaskWriteResult,
  normalizeTaskPatch,
  searchTaskViews,
  taskView,
} from "../supabase/functions/_shared/task-lifecycle-core.js";

const baseDate = "2026-09-04T08:00:00+08:00";

test("create response hydration keeps idempotency metadata and uses canonical Task truth", () => {
  const result = hydrateTaskWriteResult({
    success: true,
    replayed: true,
    idempotency_key: "create-1",
    task_id: "google-1",
    title: undefined,
    schedule_id: "old-schedule",
  }, {
    task_id: "google-1",
    google_task_id: "google-1",
    title: "【二次跟进】跟进小熊",
    due: "2026-09-05",
    date: "2026-09-05",
    status: "open",
    task_type: "follow_up",
    schedule_id: "schedule-1",
  });

  assert.equal(result.success, true);
  assert.equal(result.replayed, true);
  assert.equal(result.idempotency_key, "create-1");
  assert.equal(result.id, "google-1");
  assert.equal(result.title, "【二次跟进】跟进小熊");
  assert.equal(result.due, "2026-09-05");
  assert.equal(result.schedule_id, "schedule-1");
});

test("Follow-up closes Action → Waiting → Follow-up on the earliest result date", () => {
  const text = "小熊明天去了解一下，了解完我还要问他";
  assert.equal(detectFollowUpIntent(text), true);
  const route = classifyAction(text, { baseDate });
  assert.equal(route.type, "task");
  assert.equal(route.payload.taskType, "follow_up");
  assert.equal(route.payload.title, "【二次跟进】跟进小熊了解结果");
  assert.equal(route.payload.dueDate, "2026-09-05");

  const intake = normalizeIntake({ raw_text: text, type: "task", title: "跟进小熊了解结果", due: "2026-09-06" }, { baseDate });
  assert.equal(intake.due, "2026-09-05");
  assert.equal(intake.requested_date, "2026-09-05");
  assert.equal(intake.task_type, "follow_up");
  assert.equal(intake.title, "【二次跟进】跟进小熊了解结果");
});

test("an explicitly later Follow-up date wins and no future user action is not a Follow-up", () => {
  const later = classifyAction("小熊明天去了解，后天我再问他", { baseDate });
  assert.equal(later.payload.dueDate, "2026-09-06");
  assert.equal(detectFollowUpIntent("小熊明天去了解"), false);
  assert.equal(ensureFollowUpTitle("【三次跟进】确认下一步", 3), "【三次跟进】确认下一步");
});

test("Date and Deadline stay independent during intake", () => {
  const deadlineOnly = normalizeIntake({
    raw_text: "最晚 9月8日一定要问清楚",
    type: "task",
    title: "问清楚安排",
    due: null,
    deadline: "2026-09-08",
    requested_date: null,
  }, { baseDate });
  assert.equal(deadlineOnly.due, null);
  assert.equal(deadlineOnly.requested_date, null);
  assert.equal(deadlineOnly.deadline, "2026-09-08");
  assert.equal(deadlineOnly.schedule.scheduled_date, null);
});

test("PATCH preserves omitted fields and supports explicit null or clear_fields", () => {
  const priorityOnly = normalizeTaskPatch({ changes: { priority: "high" } });
  assert.deepEqual(priorityOnly, { priority: "high" });
  assert.equal(Object.hasOwn(priorityOnly, "due"), false);

  assert.deepEqual(normalizeTaskPatch({ changes: { notes: null } }), { notes: null });
  assert.deepEqual(normalizeTaskPatch({ changes: {}, clear_fields: ["due", "deadline"] }), { due: null, deadline: null });
  assert.throws(() => normalizeTaskPatch({ changes: { title: null } }), /title cannot be cleared/);
  assert.deepEqual(googleTaskChanges({ due: null, deadline: null, priority: "high" }), { due: null });
  assert.equal(hasScheduleChanges({ priority: "high" }), true);
  assert.equal(hasScheduleChanges({ title: "New" }), false);
});

test("public Task view exposes stable IDs and Schedule/Follow-up metadata", () => {
  const task = taskView({ id: "google-1", title: "【二次跟进】跟进小熊", dueDate: "2026-09-05", status: "open", updatedAt: "2026-09-04T12:00:00Z" }, {
    id: "schedule-1",
    owner_id: "must-not-leak",
    google_task_id: "google-1",
    scheduled_date: "2026-09-05",
    scheduled_start: "17:00",
    scheduled_end: "17:45",
    duration_minutes: 45,
    fixed_time: true,
    timezone: "Asia/Shanghai",
    calendar_event_id: "calendar-1",
    priority: "high",
    task_type: "follow_up",
    parent_task_id: "google-0",
    follow_up_of: "google-0",
    follow_up_sequence: 2,
    updated_at: "2026-09-04T13:00:00Z",
  });
  assert.equal(task.id, "google-1");
  assert.equal(task.task_id, "google-1");
  assert.equal(task.google_task_id, "google-1");
  assert.equal(task.schedule_id, "schedule-1");
  assert.equal(task.date, "2026-09-05");
  assert.equal(task.requested_date, "2026-09-05");
  assert.equal(task.requested_time, "17:00");
  assert.equal(task.estimated_duration, 45);
  assert.equal(task.fixed_time, true);
  assert.equal(task.timezone, "Asia/Shanghai");
  assert.equal(task.calendar_event_id, "calendar-1");
  assert.equal(task.priority, "high");
  assert.equal(task.updated_at, "2026-09-04T13:00:00Z");
  assert.equal(Object.hasOwn(task.schedule, "owner_id"), false);
});

test("search matches ID/title/notes and applies lifecycle filters without mutation", () => {
  const tasks = [
    { id: "a", title: "【二次跟进】跟进小熊了解阿东安排", notes: "等待小熊反馈", dueDate: "2026-09-05", status: "open", updatedAt: "2026-09-04T10:00:00Z" },
    { id: "b", title: "跟进小熊课程资料", notes: "与课程有关", dueDate: "2026-09-06", status: "open", updatedAt: "2026-09-04T09:00:00Z" },
    { id: "c", title: "阿东安排已确认", notes: "小熊", dueDate: "2026-09-05", status: "completed", updatedAt: "2026-09-04T11:00:00Z" },
  ];
  const schedules = [
    { id: "sa", google_task_id: "a", task_type: "follow_up", priority: "high", deadline: "2026-09-06" },
    { id: "sb", google_task_id: "b", task_type: "task", priority: "medium" },
  ];
  const matches = searchTaskViews(tasks, schedules, { query: "阿东 小熊", status: "open", priority: "high", date_from: "2026-09-05", date_to: "2026-09-05" });
  assert.deepEqual(matches.map((task) => task.task_id), ["a"]);
  assert.equal(searchTaskViews(tasks, schedules, { task_id: "b", status: "all" })[0].title, "跟进小熊课程资料");
  assert.equal(searchTaskViews(tasks, schedules, { query: "小熊", status: "completed" })[0].task_id, "c");
});

test("idempotency hash is stable across object key ordering", () => {
  const left = canonicalTaskMutation("update", "a", { changes: { priority: "high", due: "2026-09-05" }, clear_fields: [] });
  const right = canonicalTaskMutation("update", "a", { clear_fields: [], changes: { due: "2026-09-05", priority: "high" } });
  assert.equal(left, right);
});
