import test from "node:test";
import assert from "node:assert/strict";

import { executeTaskResolution } from "../supabase/functions/_shared/task-resolution-executor.js";
import { resolveTaskIntent } from "../supabase/functions/_shared/task-resolution-engine.js";

function fakeAdapter(seed = []) {
  const tasks = new Map(seed.map((task) => [task.id, { ...task }]));
  const events = [];
  let sequence = 0;
  const adapter = {
    events,
    tasks,
    async startResolutionAudit(audit, plan) {
      events.push(["audit:start", audit.decision, plan.operations.length]);
      return { id: "10000000-0000-4000-8000-000000000001" };
    },
    async completeResolutionAudit(id, changes) {
      events.push(["audit:complete", id, changes.result_task_ids]);
    },
    async failResolutionAudit(id, changes) {
      events.push(["audit:fail", id, changes.error]);
    },
    async getTask(id) {
      events.push(["task:get", id]);
      return tasks.get(id) || null;
    },
    async createTask(task, context) {
      sequence += 1;
      const created = { ...task, id: `created-${sequence}`, status: "open", parent_task_id: context.parent_task_id || null };
      tasks.set(created.id, created);
      events.push(["task:create", created.id, context.parent_task_id || null]);
      return created;
    },
    async updateTask(id, changes) {
      const updated = { ...tasks.get(id), ...changes, id };
      tasks.set(id, updated);
      events.push(["task:update", id, changes]);
      return updated;
    },
    async upsertTaskProfile(profile) {
      events.push(["profile", profile.google_task_id, profile.canonical_task_id]);
    },
    async upsertRelationships(relationships) {
      events.push(["relationships", relationships]);
    },
    async upsertResourceBindings(bindings) {
      events.push(["resources", bindings]);
    },
    async linkContext(taskId, goalId, projectId) {
      events.push(["context", taskId, goalId, projectId]);
    },
    async linkGoal(taskId, goalId) {
      events.push(["goal", taskId, goalId]);
    },
  };
  return adapter;
}

test("duplicate execution reuses the provider Task and writes only metadata/audit", async () => {
  const existing = { id: "existing", title: "明天整理财务数据", due: "2026-09-06", status: "open" };
  const incoming = { title: "明天记得整理一下财务数据", due: "2026-09-06" };
  const resolution = resolveTaskIntent(incoming, { tasks: [existing] });
  const adapter = fakeAdapter([existing]);
  const result = await executeTaskResolution(incoming, resolution, adapter);
  assert.equal(result.reused, true);
  assert.equal(result.created, false);
  assert.equal(result.task.id, "existing");
  assert.equal(adapter.events.some(([type]) => type === "task:create"), false);
  assert.equal(adapter.events.some(([type]) => type === "audit:complete"), true);
});

test("duplicate execution can add dependencies to the canonical Task without creating one", async () => {
  const existing = { id: "analysis", title: "完成经营分析", status: "open" };
  const prerequisite = { id: "cost", title: "提供成本", status: "open" };
  const incoming = { title: "完成经营分析", depends_on_task_ids: ["cost"] };
  const resolution = resolveTaskIntent(incoming, { tasks: [existing, prerequisite] });
  const adapter = fakeAdapter([existing, prerequisite]);
  const result = await executeTaskResolution(incoming, resolution, adapter);
  assert.equal(result.reused, true);
  assert.equal(result.created, false);
  assert.deepEqual(
    result.relationships.filter((item) => item.relationship_type === "DEPENDS_ON")
      .map((item) => [item.from_task_id, item.to_task_id]),
    [["analysis", "cost"]],
  );
});

test("update execution patches the canonical Task and captures before/after state", async () => {
  const existing = { id: "existing", title: "分析六月七月财务数据", status: "open" };
  const incoming = { title: "八月份也一起分析", raw_text: "八月份也一起分析" };
  const resolution = resolveTaskIntent(incoming, { tasks: [existing] });
  const adapter = fakeAdapter([existing]);
  const result = await executeTaskResolution(incoming, resolution, adapter);
  assert.equal(result.updated, true);
  assert.equal(result.task.title, "分析6、7、8月财务数据");
  assert.deepEqual(adapter.events.find(([type]) => type === "task:update").slice(1, 2), ["existing"]);
  assert.equal(adapter.events.some(([type]) => type === "task:create"), false);
});

test("parent-child execution creates the parent first and replaces temporary graph ids", async () => {
  const incoming = { title: "做完整经营分析，包括收入、成本和人效", raw_text: "做完整经营分析，包括收入、成本和人效" };
  const resolution = resolveTaskIntent(incoming);
  const adapter = fakeAdapter();
  const result = await executeTaskResolution(incoming, resolution, adapter);
  assert.equal(result.tasks.length, 4);
  assert.deepEqual(
    adapter.events.filter(([type]) => type === "task:create").map(([, id, parent]) => [id, parent]),
    [
      ["created-1", null],
      ["created-2", "created-1"],
      ["created-3", "created-1"],
      ["created-4", "created-1"],
    ],
  );
  assert.equal(result.relationships.every((item) => !item.from_task_id.startsWith("__") && !item.to_task_id.startsWith("__")), true);
  assert.deepEqual(result.relationships.map((item) => item.from_task_id), ["created-1", "created-1", "created-1"]);
});

test("Goal association links the created Task but never creates another Goal", async () => {
  const goal = { id: "goal-1", title: "Personal OS 产品化", status: "Active" };
  const incoming = { title: "做 Task Semantic Resolution" };
  const resolution = resolveTaskIntent(incoming, { goals: [goal] });
  const adapter = fakeAdapter();
  const result = await executeTaskResolution(incoming, resolution, adapter);
  assert.equal(result.goal_link.goal_id, "goal-1");
  assert.deepEqual(adapter.events.find(([type]) => type === "context").slice(1), ["created-1", "goal-1", null]);
});

test("a Project-only association is persisted through the existing context-link layer", async () => {
  const incoming = { title: "整理项目资料", project_id: "project-1" };
  const resolution = resolveTaskIntent(incoming);
  const adapter = fakeAdapter();
  const result = await executeTaskResolution(incoming, resolution, adapter);
  assert.deepEqual(result.context_link, { goal_plan_id: null, project_id: "project-1" });
  assert.deepEqual(adapter.events.find(([type]) => type === "context").slice(1), ["created-1", null, "project-1"]);
});

test("execution failure is audited and never invokes a destructive rollback", async () => {
  const incoming = { title: "新的独立任务" };
  const resolution = resolveTaskIntent(incoming);
  const adapter = fakeAdapter();
  adapter.createTask = async () => { throw new Error("provider unavailable"); };
  await assert.rejects(() => executeTaskResolution(incoming, resolution, adapter), /provider unavailable/);
  assert.equal(adapter.events.some(([type]) => type === "audit:fail"), true);
  assert.equal("deleteTask" in adapter, false);
});


test("provider acknowledgement with stale readback never reports success or discards known id", async () => {
  const incoming = { title: "唯一测试事项", status: "open" };
  const resolution = resolveTaskIntent(incoming);
  const adapter = fakeAdapter();
  adapter.getTask = async id => ({ id, title: "wrong title", status: "open" });
  await assert.rejects(executeTaskResolution(incoming, resolution, adapter), error => {
    assert.equal(error.code, "WRITE_UNVERIFIED");
    assert.deepEqual(error.partial_result.result_task_ids, ["created-1"]);
    return true;
  });
  assert.equal(adapter.tasks.size, 1);
  assert.equal(adapter.events.some(([type]) => type === "audit:complete"), false);
});

test('fee intake with explanatory negative wording never writes the unrelated trip',async()=>{
 const trip={id:'trip-fixture',title:'10月香港行：开户与设备购买',notes:'核对开户费用及资金安排',status:'open',due:'2026-10-15',originalIntent:'10月15日香港行，核对费用'};
 const incoming={title:'跟进合伙人支付九月份费用',raw_text:'月底做个提醒，九月份费用因为现金流不足放到十月底。',notes:'原付款时间四月初待核；不擅自改为十月初。十一月份费用正常支付。',due:'2026-10-31'};
 const adapter=fakeAdapter([trip]);const resolution=resolveTaskIntent(incoming,{tasks:[trip]});assert.equal(resolution.decision,'NEW');await executeTaskResolution(incoming,resolution,adapter);assert.deepEqual(adapter.tasks.get(trip.id),trip);assert.equal(adapter.events.filter(x=>x[0]==='task:update').length,0);assert.equal(adapter.events.filter(x=>x[0]==='task:create').length,1);
});
test('preview and execution agree for the same normalized fee input and provider snapshot',async()=>{
 const {taskResolutionPreview,resolveAndExecuteTask}=await import('../supabase/functions/_shared/task-resolution-runtime.js');
 const task={id:'trip',title:'10月香港行：开户与设备购买',notes:'核对开户费用',status:'open',due:'2026-10-15'};
 const input={title:'跟进九月份费用到账',raw_text:'月底提醒合伙人支付九月份费用，放到十月底。',notes:'不擅自改为十月初。',due:'2026-10-31'};
 const context={tasks:[task]};const preview=taskResolutionPreview(input,context);const adapter=fakeAdapter([task]);const result=await resolveAndExecuteTask(input,context,adapter);assert.equal(preview.decision,'NEW');assert.equal(result.resolution.decision,preview.decision);assert.deepEqual(adapter.tasks.get(task.id),task);assert.equal(adapter.events.filter(x=>x[0]==='task:update').length,0);
});
