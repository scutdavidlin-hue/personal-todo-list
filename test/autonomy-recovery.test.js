import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAutonomy } from "../supabase/functions/_shared/autonomy-policy.js";
import { resolveAndExecuteTask } from "../supabase/functions/_shared/task-resolution-runtime.js";
import { resolveTaskIntent } from "../supabase/functions/_shared/task-resolution-engine.js";

test("Chinese money and colloquial contract signing require L3 confirmation", () => {
  for (const raw_text of ["把一百万元转账给卖家", "帮我支付二十万元", "帮我签购房合同"]) {
    assert.equal(evaluateAutonomy({ raw_text }).risk_level, "L3", raw_text);
  }
});

test("an outer timeout replays a completed inner resolution without creating again", async () => {
  const task = { id: "existing-1", title: "拿梳子" };
  const result = await resolveAndExecuteTask({ title: "拿梳子" }, {}, {
    findExistingResolution: async () => ({ id: "audit-1", status: "succeeded", result_task_ids: [task.id], decision: "NEW" }),
    getTask: async () => task,
    createTask: async () => { assert.fail("must not create on replay"); },
  });
  assert.equal(result.task.id, task.id);
  assert.equal(result.resolution.decision, "DUPLICATE");
  assert.equal(result.replayed, true);
});

test("an uncertain prior write blocks another insertion", async () => {
  await assert.rejects(resolveAndExecuteTask({ title: "拿梳子" }, {}, {
    findExistingResolution: async () => ({ status: "processing", result_task_ids: [] }),
    createTask: async () => { assert.fail("uncertain write cannot be blindly retried"); },
  }), { code: "RESOLUTION_RECOVERY_REQUIRED" });
});

test("repeated follow-up capture reuses that follow-up, never its parent", () => {
  const incoming = { title: "【二次跟进】确认结果", task_type: "follow_up", follow_up_of: "parent", follow_up_sequence: 2, dueDate: "2026-09-08" };
  const result = resolveTaskIntent(incoming, { tasks: [
    { id: "parent", title: "确认结果", dueDate: "2026-09-08" },
    { ...incoming, id: "followup" },
  ] });
  assert.equal(result.decision, "DUPLICATE");
  assert.equal(result.existing_task_id, "followup");
});
