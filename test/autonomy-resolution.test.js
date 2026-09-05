import test from "node:test";
import assert from "node:assert/strict";

import { resolveTaskIntent } from "../supabase/functions/_shared/task-resolution-engine.js";

const incoming = {
  raw_text: "翔辉下午三点过来",
  notes: "翔辉下午三点过来",
  dueDate: "2026-09-05",
  requested_time: "15:00",
};

test("PRD case 2 reuses the same named arrival at the same date and time", () => {
  const resolution = resolveTaskIntent(incoming, {
    tasks: [{ id: "arrival-1", title: "15:00 翔辉到公司", dueDate: "2026-09-05", status: "open" }],
  });

  assert.equal(resolution.decision, "DUPLICATE");
  assert.equal(resolution.should_create, false);
  assert.equal(resolution.existing_task_id, "arrival-1");
  assert.equal(resolution.automatic_action, "REUSE_CANONICAL");
});

test("scheduled lifecycle metadata supplies candidate date and time", () => {
  const resolution = resolveTaskIntent(incoming, {
    tasks: [{
      id: "arrival-1",
      title: "翔辉到公司",
      status: "open",
      schedule: { scheduled_date: "2026-09-05", scheduled_start: "15:00" },
    }],
  });

  assert.equal(resolution.decision, "DUPLICATE");
  assert.equal(resolution.should_create, false);
  assert.equal(resolution.existing_task_id, "arrival-1");
});

test("two equivalent scheduled arrivals require clarification and never create", () => {
  const resolution = resolveTaskIntent(incoming, {
    tasks: [
      { id: "arrival-1", title: "15:00 翔辉到公司", dueDate: "2026-09-05", status: "open" },
      { id: "arrival-2", title: "翔辉下午3点来公司", dueDate: "2026-09-05", status: "open" },
    ],
  });

  assert.equal(resolution.decision, "CONFLICT");
  assert.equal(resolution.requires_clarification, true);
  assert.equal(resolution.should_create, false);
  assert.equal(resolution.automatic_action, "ASK");
});

test("different people, dates, or times are not scheduled-arrival duplicates", () => {
  const cases = [
    { id: "other-person", title: "15:00 王辉到公司", dueDate: "2026-09-05", status: "open" },
    { id: "other-date", title: "15:00 翔辉到公司", dueDate: "2026-09-06", status: "open" },
    { id: "other-time", title: "16:00 翔辉到公司", dueDate: "2026-09-05", status: "open" },
  ];

  for (const task of cases) {
    const resolution = resolveTaskIntent(incoming, { tasks: [task] });
    assert.notEqual(resolution.decision, "DUPLICATE", task.id);
    assert.equal(resolution.should_create, true, task.id);
  }
});

test("a raw-intent note is not treated as new material detail", () => {
  const resolution = resolveTaskIntent({
    title: "15:00 翔辉到公司",
    raw_text: "翔辉下午三点过来",
    notes: "原始请求：翔辉下午三点过来",
    dueDate: "2026-09-05",
    requested_time: "15:00",
  }, {
    tasks: [{ id: "arrival-1", title: "15:00 翔辉到公司", dueDate: "2026-09-05", status: "open" }],
  });

  assert.equal(resolution.decision, "DUPLICATE");
  assert.equal(resolution.should_create, false);
});

test("a multiline raw-intent note is not treated as new material detail", () => {
  const rawText = "翔辉下午三点过来\n到公司见面";
  const resolution = resolveTaskIntent({
    raw_text: rawText,
    notes: rawText,
    dueDate: "2026-09-05",
    requested_time: "15:00",
  }, {
    tasks: [{ id: "arrival-1", title: "15:00 翔辉到公司", dueDate: "2026-09-05", status: "open" }],
  });

  assert.equal(resolution.decision, "DUPLICATE");
  assert.equal(resolution.should_create, false);
});

test("an explicit follow-up is always new and links back to its parent", () => {
  const resolution = resolveTaskIntent({
    task_type: "follow_up",
    title: "【二次跟进】联系供应商确认报价",
    follow_up_of: "parent-1",
    parent_task_id: "parent-1",
    follow_up_sequence: 2,
  }, {
    tasks: [{ id: "parent-1", title: "联系供应商确认报价", status: "open" }],
  });

  assert.equal(resolution.decision, "NEW");
  assert.equal(resolution.should_create, true);
  assert.equal(resolution.existing_task_id, null);
  assert.deepEqual(resolution.relationships, [{
    relationship_type: "PARENT_OF",
    from_task_id: "parent-1",
    to_task_id: "__incoming_task__",
    confidence: 1,
    reason: "An explicitly classified follow-up is a new atomic Task and must retain its parent linkage.",
    metadata: { follow_up: true },
  }]);
});

test("a follow-up remains new even when its full original intent matches the parent", () => {
  const resolution = resolveTaskIntent({
    task_type: "follow_up",
    title: "【二次跟进】联系供应商确认报价",
    originalIntent: "联系供应商确认报价",
    notes: "联系供应商确认报价",
    follow_up_sequence: 2,
  }, {
    tasks: [{ id: "parent-1", title: "联系供应商确认报价", status: "open" }],
  });

  assert.equal(resolution.decision, "NEW");
  assert.equal(resolution.should_create, true);
  assert.deepEqual(resolution.relationships, []);
});
