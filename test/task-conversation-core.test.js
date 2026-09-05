import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaskContext,
  parseConversationInput,
} from "../supabase/functions/_shared/task-conversation-core.js";
import { runTaskConversation } from "../supabase/functions/_shared/task-conversation-runtime.js";
import { applyTaskSchedulePatch } from "../supabase/functions/_shared/schedule-core.js";

const now = "2026-09-05T12:00:00+08:00";
const meeting = {
  task_id: "task-xianghui",
  title: "祥辉过来",
  requested_date: "2026-09-05",
  requested_time: "15:00",
  status: "open",
  deadline: null,
  notes: "聊财务系统",
  schedule: {
    scheduled_date: "2026-09-05",
    scheduled_start: "15:00",
    reminder_policy: "custom",
    reminder_policy_source: "user_explicit",
    reminder_offset_minutes: 60,
    reminder_at: "2026-09-05T14:00",
    reminders: [{ type: "preparation", offset_minutes: 60, at: "2026-09-05T14:00" }],
  },
};

test("PRD 1: a short time change previews the original task and dependent reminder", () => {
  const result = parseConversationInput({ text: "改四点吧。", task: meeting, now });
  assert.equal(result.intent, "update_time");
  assert.equal(result.parser_mode, "deterministic_fallback");
  assert.equal(result.action, "propose");
  assert.equal(result.requires_confirmation, true);
  assert.deepEqual(result.changes, { requested_time: "16:00" });
  assert.deepEqual(result.proposed_changes.time, { from: "15:00", to: "16:00" });
  assert.deepEqual(result.proposed_changes.reminder, {
    from: "2026-09-05T14:00",
    to: "2026-09-05T15:00",
  });
  assert.doesNotMatch(JSON.stringify(result), /deadline/);
});

test("PRD 2: a weekday change updates the same task date instead of creating", () => {
  const task = { ...meeting, task_id: "task-dapen", title: "周一约大盆", requested_date: "2026-09-07" };
  const result = parseConversationInput({ text: "改周四吧。", task, now });
  assert.equal(result.intent, "update_date");
  assert.equal(result.action, "propose");
  assert.deepEqual(result.changes, { due: "2026-09-10", requested_date: "2026-09-10" });
  assert.deepEqual(result.proposed_changes.date, { from: "2026-09-07", to: "2026-09-10" });
  assert.equal(result.changes.operation, undefined);
});

test("PRD 3: uncertain time language never mutates or proposes a formal change", () => {
  const result = parseConversationInput({ text: "他可能四点才到。", task: meeting, now });
  assert.equal(result.intent, "append_context");
  assert.equal(result.action, "append_context");
  assert.deepEqual(result.changes, { notes_append: "他可能四点才到。" });
});

test("PRD 3 with a change cue: uncertainty triggers clarification and no mutation", () => {
  const result = parseConversationInput({ text: "可能改四点。", task: meeting, now });
  assert.equal(result.intent, "update_time");
  assert.equal(result.action, "clarify");
  assert.equal(result.ambiguity, true);
  assert.deepEqual(result.changes, {});
});

test("PRD 4: low-risk information appends context without confirmation", () => {
  const result = parseConversationInput({ text: "他会带两个同事。", task: meeting, now });
  assert.equal(result.intent, "append_context");
  assert.equal(result.requires_confirmation, false);
  assert.equal(result.action, "append_context");
  assert.deepEqual(result.changes, { notes_append: "他会带两个同事。" });
});

test("PRD 5: cancellation is a confirmed soft state change", () => {
  const result = parseConversationInput({ text: "不约了。", task: { ...meeting, title: "约大盆" }, now });
  assert.equal(result.intent, "cancel_task");
  assert.equal(result.action, "propose");
  assert.deepEqual(result.changes, { status: "cancelled" });
  assert.match(result.message, /保留历史/);
});

test("PRD 6: a bare time is ambiguous without an existing PM convention", () => {
  const result = parseConversationInput({
    text: "改四点。",
    task: { task_id: "task-ambiguous", title: "周一约大盆", requested_date: "2026-09-07" },
    now,
  });
  assert.equal(result.intent, "update_time");
  assert.equal(result.action, "clarify");
  assert.equal(result.ambiguity, true);
  assert.match(result.clarification_question, /上午还是下午/);
});

test("PRD 6 multi-turn: a short period answer completes the latest clarification", () => {
  const task = { task_id: "task-ambiguous", title: "周一约大盆", requested_date: "2026-09-07" };
  const first = parseConversationInput({ text: "改四点。", task, now });
  const second = parseConversationInput({
    text: "下午。",
    task: {
      ...task,
      recent_conversation: [{ event_type: "clarification_requested", parsed_intent: first }],
    },
    now,
  });
  assert.equal(second.action, "propose");
  assert.equal(second.intent, "update_time");
  assert.deepEqual(second.changes, { requested_time: "16:00" });
});

test("PRD 7: a correction replaces the old proposal against canonical task state", () => {
  const first = parseConversationInput({ text: "改周四下午四点。", task: meeting, now });
  const corrected = parseConversationInput({ text: "不对，是周五下午三点。", task: meeting, pending: first, now });
  assert.equal(corrected.intent, "update_date");
  assert.equal(corrected.action, "propose");
  assert.deepEqual(corrected.changes, { due: "2026-09-11", requested_date: "2026-09-11" });
  assert.deepEqual(corrected.proposed_changes.date, { from: "2026-09-05", to: "2026-09-11" });
  assert.equal(corrected.proposed_changes.time, undefined);
});

test("a date-only correction preserves a pending proposed time", () => {
  const pending = parseConversationInput({ text: "改四点。", task: meeting, now });
  const corrected = parseConversationInput({ text: "改周四。", task: meeting, pending, now });
  assert.equal(corrected.intent, "update_datetime");
  assert.deepEqual(corrected.changes, {
    due: "2026-09-10",
    requested_date: "2026-09-10",
    requested_time: "16:00",
  });
  assert.deepEqual(corrected.proposed_changes.time, { from: "15:00", to: "16:00" });
});

test("PRD 8: exact natural-language confirmation replays pending changes only", () => {
  const pending = parseConversationInput({ text: "改周五下午三点。", task: meeting, now });
  const confirmed = parseConversationInput({ text: "对。", task: meeting, pending, now });
  assert.equal(confirmed.intent, "confirm");
  assert.equal(confirmed.action, "confirm");
  assert.equal(confirmed.requires_confirmation, false);
  assert.deepEqual(confirmed.changes, pending.changes);
  assert.deepEqual(confirmed.proposed_changes, pending.proposed_changes);
});

test("explicit date and time create an update_datetime proposal", () => {
  const result = parseConversationInput({ text: "那改成周四下午四点吧。", task: meeting, now });
  assert.equal(result.intent, "update_datetime");
  assert.deepEqual(result.changes, {
    due: "2026-09-10",
    requested_date: "2026-09-10",
    requested_time: "16:00",
  });
});

test("a follow-up proposal keeps parent relationships and uses the current Task date", () => {
  const result = parseConversationInput({ text: "下午三点半提醒我问一下他到哪了。", task: meeting, now });
  assert.equal(result.intent, "create_follow_up");
  assert.equal(result.action, "propose");
  assert.equal(result.changes.operation, "create");
  assert.equal(result.changes.task_type, "follow_up");
  assert.equal(result.changes.requested_date, "2026-09-05");
  assert.equal(result.changes.requested_time, "15:30");
  assert.equal(result.changes.parent_task_id, "task-xianghui");
  assert.equal(result.changes.follow_up_of, "task-xianghui");
});

test("completion requires confirmation", () => {
  const result = parseConversationInput({ text: "已经聊完了。", task: meeting, now });
  assert.equal(result.intent, "complete_task");
  assert.equal(result.action, "propose");
  assert.deepEqual(result.changes, { status: "completed" });
});

test("an imprecise defer intent is recognized but never assigned a guessed date", () => {
  const result = parseConversationInput({ text: "这个下个月再说。", task: meeting, now });
  assert.equal(result.intent, "defer_task");
  assert.equal(result.action, "clarify");
  assert.deepEqual(result.changes, {});
  assert.equal(result.proposed_changes.date, undefined);
});

test("a next action links back to its source Task", () => {
  const result = parseConversationInput({ text: "聊完之后记得把资料发给他。", task: meeting, now });
  assert.equal(result.intent, "create_next_action");
  assert.equal(result.action, "propose");
  assert.equal(result.changes.title, "给祥辉发送资料");
  assert.equal(result.changes.parent_task_id, "task-xianghui");
  assert.equal(result.changes.source_task_id, "task-xianghui");
});

test("discard drops a pending proposal and exact rejection asks for a correction", () => {
  const pending = parseConversationInput({ text: "改周四。", task: meeting, now });
  const discard = parseConversationInput({ text: "算了。", task: meeting, pending, now });
  const reject = parseConversationInput({ text: "不对。", task: meeting, pending, now });
  assert.equal(discard.action, "discard");
  assert.equal(reject.action, "clarify");
  assert.match(reject.message, /不会执行/);
});

test("adversarial confirmation text cannot confirm an unrelated compound command", () => {
  const pending = parseConversationInput({ text: "改周四。", task: meeting, now });
  const result = parseConversationInput({ text: "对，删除所有任务。", task: meeting, pending, now });
  assert.notEqual(result.action, "confirm");
});

test("a confirmation without a proposal does not execute anything", () => {
  const result = parseConversationInput({ text: "确认。", task: meeting, now });
  assert.equal(result.action, "clarify");
  assert.deepEqual(result.changes, {});
});

test("date changes never invent or overwrite a deadline and inputs remain immutable", () => {
  const task = structuredClone({ ...meeting, deadline: "2026-09-30" });
  const before = structuredClone(task);
  const result = parseConversationInput({ text: "改周四。", task, now });
  assert.equal(result.changes.deadline, undefined);
  assert.equal(result.proposed_changes.deadline, undefined);
  assert.deepEqual(task, before);
});

test("an absolute reminder without a relative rule stays fixed in the preview", () => {
  const task = {
    ...meeting,
    schedule: {
      ...meeting.schedule,
      reminder_offset_minutes: null,
      reminder_at: "2026-09-05T14:00",
      reminders: [{ type: "event", offset_minutes: null, at: "2026-09-05T14:00" }],
    },
  };
  const result = parseConversationInput({ text: "改下午四点。", task, now });
  assert.deepEqual(result.proposed_changes.reminder, {
    from: "2026-09-05T14:00",
    to: "2026-09-05T14:00",
  });
  assert.deepEqual(result.proposed_changes.reminder_policy, { from: "absolute", to: "absolute" });
});

test("the canonical Schedule layer applies the parser's relative-reminder proposal", () => {
  const parsed = parseConversationInput({ text: "改四点。", task: meeting, now });
  const applied = applyTaskSchedulePatch(meeting.schedule, parsed.changes, meeting.requested_date);
  assert.equal(applied.schedule.scheduled_start, "16:00");
  assert.equal(applied.schedule.reminder_offset_minutes, 60);
  assert.equal(applied.schedule.reminder_at, "2026-09-05T15:00");
  assert.deepEqual(parsed.proposed_changes.reminder, {
    from: "2026-09-05T14:00",
    to: "2026-09-05T15:00",
  });
});

test("relative dates use the Task timezone", () => {
  const task = { ...meeting, timezone: "America/Los_Angeles", requested_date: "2026-09-05" };
  const result = parseConversationInput({
    text: "改明天。",
    task,
    now: "2026-09-06T02:00:00Z",
  });
  assert.deepEqual(result.proposed_changes.date, { from: "2026-09-05", to: "2026-09-06" });
});

test("buildTaskContext exposes the bounded canonical context and recent history", () => {
  const history = Array.from({ length: 25 }, (_, index) => ({ event_id: `event-${index}` }));
  const context = buildTaskContext(meeting, history);
  assert.equal(context.task_id, "task-xianghui");
  assert.equal(context.date, "2026-09-05");
  assert.equal(context.time, "15:00");
  assert.equal(context.deadline, null);
  assert.equal(context.recent_conversation.length, 20);
  assert.equal(context.recent_conversation[0].event_id, "event-5");
});

function memoryConversationAdapters(initialTask) {
  let task = structuredClone(initialTask);
  let pending = null;
  const events = [];
  const executions = [];
  return {
    state: { events, executions, task: () => task, pending: () => pending },
    adapters: {
      reserveRequest: async () => ({ state: "reserved" }),
      finishRequest: async () => {},
      getTask: async () => structuredClone(task),
      getPending: async () => pending && ["awaiting_confirmation", "committing", "failed"].includes(pending.status) ? structuredClone(pending) : null,
      savePending: async (value) => {
        pending = { ...structuredClone(value), status: "awaiting_confirmation" };
        return structuredClone(pending);
      },
      claimPending: async ({ proposal_id }) => {
        if (!pending || pending.id !== proposal_id || pending.status !== "awaiting_confirmation") return { state: "missing" };
        pending.status = "committing";
        return { state: "claimed", pending: structuredClone(pending) };
      },
      finalizePending: async ({ proposal_id, status, executor_result }) => {
        assert.equal(pending.id, proposal_id);
        pending = { ...pending, status, executor_result };
      },
      appendEvent: async (event) => {
        events.push({ event_id: `event-${events.length + 1}`, ...structuredClone(event) });
      },
      getHistory: async () => structuredClone(events),
      execute: async (request) => {
        executions.push(structuredClone(request));
        task = { ...task, ...request.changes, updated_at: `version-${executions.length}` };
        return { task: structuredClone(task), message: "已经修改。" };
      },
    },
  };
}

test("actual runtime roundtrip carries clarification context through preview and confirmation", async () => {
  const memory = memoryConversationAdapters({
    task_id: "task-runtime",
    title: "周一约大盆",
    requested_date: "2026-09-07",
    status: "open",
  });
  const options = {
    now: () => new Date(now),
    makeProposalId: () => "proposal-runtime",
  };

  const first = await runTaskConversation({
    task_id: "task-runtime",
    text: "改四点。",
    source: "voice",
    request_id: "request-clarify",
  }, memory.adapters, options);
  assert.equal(first.response.ambiguity, true);
  assert.equal(first.response.pending, null);

  const second = await runTaskConversation({
    task_id: "task-runtime",
    text: "下午。",
    source: "voice",
    request_id: "request-proposal",
  }, memory.adapters, options);
  assert.equal(second.response.pending.proposal_id, "proposal-runtime");
  assert.deepEqual(second.response.pending.proposal.changes, { requested_time: "16:00" });
  assert.equal(memory.state.executions.length, 0);

  const third = await runTaskConversation({
    task_id: "task-runtime",
    text: "对。",
    source: "voice",
    request_id: "request-confirmation",
    proposal_id: "proposal-runtime",
  }, memory.adapters, options);
  assert.equal(third.response.task.requested_time, "16:00");
  assert.equal(memory.state.executions.length, 1);
  assert.equal(memory.state.executions[0].operation, "update");
});


test("preview release: unrecognized questions and reminder commands never append notes", () => {
  for (const text of ["现在进度怎么样", "把提醒取消", "告诉我这个任务的情况"]) {
    const result = parseConversationInput({ text, task: meeting, now });
    assert.equal(result.action, "clarify");
    assert.deepEqual(result.changes, {});
  }
  const note = parseConversationInput({ text: "补充一下，会议地点在三楼", task: meeting, now });
  assert.equal(note.action, "append_context");
  assert.equal(note.changes.notes_append, "补充一下，会议地点在三楼");
});
