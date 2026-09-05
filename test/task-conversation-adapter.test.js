import test from "node:test";
import assert from "node:assert/strict";
import { taskConversationCreatePayload } from "../supabase/functions/_shared/task-conversation-adapter.js";
import { parseConversationInput } from "../supabase/functions/_shared/task-conversation-core.js";
import { createGoogleTaskPayload, toTaskModel } from "../supabase/functions/_shared/google-tasks-core.js";
import { normalizeScheduleInput, buildCalendarEvent } from "../supabase/functions/_shared/schedule-core.js";
import { taskView } from "../supabase/functions/_shared/task-lifecycle-core.js";

const meeting = { id: "original-task", title: "祥辉过来", requested_date: "2026-09-05", requested_time: "15:00", status: "open" };
const now = "2026-09-05T04:00:00Z";

function dispatch(text, task = meeting) {
  const parsed = parseConversationInput({ text, task, now });
  assert.equal(parsed.changes.operation, "create");
  const { operation, ...changes } = parsed.changes;
  return taskConversationCreatePayload({ ...changes, raw_text: text, originalIntent: text, source: "task_conversation" }, "conversation:confirmed-proposal");
}

test("confirmed follow-up reaches provider date and Schedule time/linkage contracts", () => {
  const payload = dispatch("下午三点半提醒我问一下他到哪了");
  const provider = createGoogleTaskPayload(payload);
  assert.equal(provider.due, "2026-09-05T00:00:00.000Z");
  const schedule = normalizeScheduleInput(payload.schedule);
  assert.equal(schedule.scheduled_date, "2026-09-05");
  assert.equal(schedule.scheduled_start, "15:30");
  assert.equal(schedule.task_type, "follow_up");
  assert.equal(schedule.parent_task_id, meeting.id);
  assert.equal(schedule.follow_up_of, meeting.id);
  assert.equal(schedule.follow_up_sequence, 2);
  const model = toTaskModel({ id: "new-follow-up", ...provider, status: "needsAction" });
  const readback = taskView(model, schedule);
  assert.equal(readback.requested_date, "2026-09-05");
  assert.equal(readback.requested_time, "15:30");
  assert.equal(readback.follow_up_of, meeting.id);
  const event = buildCalendarEvent(model, schedule, "stable-event");
  assert.match(event.start.dateTime, /^2026-09-05T15:30/);
  assert.equal(payload.idempotency_key, "conversation:confirmed-proposal");
});

test("dated next action survives provider and Schedule without changing the original", () => {
  const snapshot = structuredClone(meeting);
  const payload = dispatch("聊完后记得明天下午四点发送资料");
  assert.equal(createGoogleTaskPayload(payload).due, "2026-09-06T00:00:00.000Z");
  const schedule = normalizeScheduleInput(payload.schedule);
  assert.equal(schedule.scheduled_start, "16:00");
  assert.equal(schedule.parent_task_id, meeting.id);
  assert.equal(schedule.follow_up_of, null);
  assert.deepEqual(meeting, snapshot);
});

test("undated next action stores parent linkage without inventing a date or deadline", () => {
  const payload = dispatch("聊完后记得把资料发给他");
  assert.equal(createGoogleTaskPayload(payload).due, undefined);
  const schedule = normalizeScheduleInput(payload.schedule);
  assert.equal(schedule.scheduled_date, null);
  assert.equal(schedule.scheduled_start, null);
  assert.equal(schedule.deadline, null);
  assert.equal(schedule.scheduling_status, "backlog");
  assert.equal(schedule.parent_task_id, meeting.id);
});

test("incomplete timed create is rejected before an unscheduled provider task can be created", () => {
  assert.throws(() => taskConversationCreatePayload({ title: "Next", requested_time: "16:00", parent_task_id: meeting.id }, "conversation:key"), /scheduled_date is required/);
});
