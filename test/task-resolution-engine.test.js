import test from "node:test";
import assert from "node:assert/strict";

import {
  INCOMING_TASK_REF,
  buildResolutionMutationPlan,
  extractIntentProfile,
  findGoalAssociation,
  mergeTaskTitle,
  normalizeResolutionText,
  replaceIncomingTaskRefs,
  resolveTaskIntent,
  resolutionProfileRecord,
  taskCandidateScore,
} from "../supabase/functions/_shared/task-resolution-engine.js";
import {
  buildTaskExecutionGraph,
  canTasksRunInParallel,
  relationshipWouldCreateCycle,
  validateTaskRelationship,
} from "../supabase/functions/_shared/task-graph-core.js";

const openTask = (id, title, extra = {}) => ({
  id,
  task_id: id,
  google_task_id: id,
  title,
  status: "open",
  updated_at: "2026-09-05T00:00:00Z",
  ...extra,
});

test("PRD Test 1: repeated wording resolves to one canonical Task", () => {
  const resolution = resolveTaskIntent(
    { title: "明天记得整理一下财务数据", raw_text: "明天记得整理一下财务数据", due: "2026-09-06" },
    { tasks: [openTask("finance-1", "明天整理财务数据", { due: "2026-09-06" })] },
  );
  assert.equal(resolution.decision, "DUPLICATE");
  assert.equal(resolution.should_create, false);
  assert.equal(resolution.existing_task_id, "finance-1");
  assert.ok(resolution.confidence >= 0.9);
  assert.equal(buildResolutionMutationPlan({ title: "明天记得整理一下财务数据" }, resolution).operations[0].type, "reuse");
});

test("PRD Test 2: additive month wording updates the existing Task", () => {
  const existing = openTask("finance-2", "分析六月七月财务数据");
  const resolution = resolveTaskIntent(
    { title: "八月份也一起分析", raw_text: "八月份也一起分析" },
    { tasks: [existing] },
  );
  assert.equal(resolution.decision, "UPDATE");
  assert.equal(resolution.should_create, false);
  assert.equal(resolution.existing_task_id, "finance-2");
  assert.equal(resolution.update.title, "分析6、7、8月财务数据");
  assert.ok(resolution.confidence <= resolution.candidates[0].score);
  assert.deepEqual(extractIntentProfile(resolution.update).months, [6, 7, 8]);
});

test("numeric month ranges expand without leaving stale scope fragments", () => {
  const resolution = resolveTaskIntent(
    { title: "8月也一起分析", raw_text: "8月也一起分析" },
    { tasks: [{ id: "finance", title: "分析6、7月财务数据", status: "open" }] },
  );
  assert.equal(resolution.decision, "UPDATE");
  assert.equal(resolution.update.title, "分析6、7、8月财务数据");
});

test("a date or explicit note added to the same action updates instead of duplicating", () => {
  const existing = { id: "task-1", title: "跟佳佳核对成本", status: "open", notes: "" };
  const dated = resolveTaskIntent({
    title: "跟佳佳核对成本",
    due: "2026-09-08",
  }, { tasks: [existing] });
  assert.equal(dated.decision, "UPDATE");
  assert.equal(dated.update.due, "2026-09-08");

  const noted = resolveTaskIntent({
    title: "跟佳佳核对成本",
    notes: "同时确认自营团队口径",
  }, { tasks: [existing] });
  assert.equal(noted.decision, "UPDATE");
  assert.match(noted.update.notes, /自营团队口径/);
});

test("multiple same-name candidates block automatic date or note updates", () => {
  const tasks = [
    { id: "a", title: "跟佳佳核对成本", due: "2026-09-08", status: "open", notes: "A项目" },
    { id: "b", title: "跟佳佳核对成本", due: "2026-09-09", status: "open", notes: "B项目" },
  ];
  const dated = resolveTaskIntent({
    title: "跟佳佳核对成本",
    due: "2026-09-10",
  }, { tasks });
  const noted = resolveTaskIntent({
    title: "跟佳佳核对成本",
    notes: "补充新的成本口径",
  }, { tasks });
  for (const resolution of [dated, noted]) {
    assert.notEqual(resolution.decision, "UPDATE");
    assert.notEqual(resolution.decision, "MERGE");
    assert.equal(resolution.should_create, true);
  }
});

test("ambiguous additive candidates never trigger an automatic update", () => {
  const tasks = [
    { id: "a", title: "分析6、7月自营团队财务数据", status: "open" },
    { id: "b", title: "分析6、7月非自营团队财务数据", status: "open" },
  ];
  const resolution = resolveTaskIntent({ title: "8月也一起分析财务数据" }, { tasks });
  assert.notEqual(resolution.decision, "UPDATE");
  assert.notEqual(resolution.decision, "MERGE");
  assert.equal(resolution.should_create, true);
});

test("a broad shared topic alone cannot trigger a destructive additive update", () => {
  const resolution = resolveTaskIntent(
    { title: "8月也一起分析财务数据" },
    { tasks: [{ id: "risk", title: "分析公司年度财务风险", status: "open" }] },
  );
  assert.notEqual(resolution.decision, "UPDATE");
  assert.notEqual(resolution.decision, "MERGE");
  assert.equal(resolution.should_create, true);
});

test("a shared month shape cannot update an unrelated named domain", () => {
  const resolution = resolveTaskIntent(
    { title: "8月也一起分析客户投诉" },
    { tasks: [{ id: "finance", title: "分析6、7月财务数据", status: "open" }] },
  );
  assert.notEqual(resolution.decision, "UPDATE");
  assert.notEqual(resolution.decision, "MERGE");
  assert.equal(resolution.should_create, true);
});

test("ambiguous dependency producers require an explicit Task id", () => {
  const tasks = [
    { id: "a", title: "佳佳提供A项目成本", status: "open", write_resources: ["financial_records"] },
    { id: "b", title: "佳佳提供B项目成本", status: "open", write_resources: ["financial_records"] },
  ];
  const resolution = resolveTaskIntent({ title: "成本出来后分析利润", read_resources: ["financial_records"] }, { tasks });
  assert.notEqual(resolution.decision, "DEPENDENCY");
  const explicit = resolveTaskIntent({
    title: "成本出来后分析利润",
    read_resources: ["financial_records"],
    depends_on_task_ids: ["b"],
  }, { tasks });
  assert.equal(explicit.decision, "DEPENDENCY");
  assert.equal(explicit.relationships[0].to_task_id, "b");
});

test("a waiting phrase plus a broad shared topic cannot invent a dependency", () => {
  const resolution = resolveTaskIntent(
    { title: "等财务数据出来后联系客户" },
    { tasks: [{ id: "risk", title: "分析年度财务风险", status: "open" }] },
  );
  assert.notEqual(resolution.decision, "DEPENDENCY");
  assert.equal(resolution.relationships.some((item) => item.relationship_type === "DEPENDS_ON"), false);
});

test("PRD Test 3: result-dependent analysis stays separate and depends on the source Task", () => {
  const resolution = resolveTaskIntent(
    { title: "成本出来后分析利润", raw_text: "成本出来后分析利润" },
    { tasks: [openTask("cost-source", "等佳佳发成本")] },
  );
  assert.equal(resolution.decision, "DEPENDENCY");
  assert.equal(resolution.should_create, true);
  const dependency = resolution.relationships.find((item) => item.relationship_type === "DEPENDS_ON");
  assert.equal(dependency.from_task_id, INCOMING_TASK_REF);
  assert.equal(dependency.to_task_id, "cost-source");
});

test("an explicit prerequisite id is honored outside the semantic top-k", () => {
  const unrelated = Array.from({ length: 25 }, (_, index) => ({
    id: `task-${index}`,
    title: `分析财务数据 ${index}`,
    status: "open",
  }));
  const prerequisite = { id: "exact-prerequisite", title: "给供应商打电话", status: "open" };
  const resolution = resolveTaskIntent({
    title: "完成年度品牌方案",
    depends_on_task_ids: [prerequisite.id],
  }, { tasks: [...unrelated, prerequisite], candidate_limit: 5 });
  assert.equal(resolution.decision, "DEPENDENCY");
  assert.equal(resolution.existing_task_id, prerequisite.id);
  assert.equal(resolution.relationships[0].to_task_id, prerequisite.id);
});

test("all explicit prerequisite ids become dependency edges", () => {
  const tasks = [
    { id: "cost", title: "提供成本", status: "open" },
    { id: "revenue", title: "提供收入", status: "open" },
  ];
  const resolution = resolveTaskIntent({
    title: "计算损益",
    depends_on_task_ids: ["cost", "revenue"],
  }, { tasks });
  assert.equal(resolution.decision, "DEPENDENCY");
  assert.deepEqual(
    resolution.relationships
      .filter((item) => item.relationship_type === "DEPENDS_ON")
      .map((item) => item.to_task_id),
    ["cost", "revenue"],
  );
});

test("an explicit dependency enriches a duplicate instead of creating another Task", () => {
  const tasks = [
    { id: "analysis", title: "完成经营分析", status: "open" },
    { id: "cost", title: "提供成本", status: "open" },
  ];
  const resolution = resolveTaskIntent({
    title: "完成经营分析",
    depends_on_task_ids: ["cost"],
  }, { tasks });
  assert.equal(resolution.decision, "DUPLICATE");
  assert.equal(resolution.should_create, false);
  assert.equal(
    resolution.relationships.some((item) => item.relationship_type === "DEPENDS_ON" && item.to_task_id === "cost"),
    true,
  );
});

test("PRD Test 4: explicit work package creates one parent and atomic children", () => {
  const resolution = resolveTaskIntent({
    title: "做完整经营分析，包括收入、成本、人效和客户集中度。",
    raw_text: "做完整经营分析，包括收入、成本、人效和客户集中度。",
  });
  assert.equal(resolution.decision, "PARENT_CHILD");
  assert.equal(resolution.parent_child.parent.title, "做完整经营分析");
  assert.deepEqual(resolution.parent_child.children.map((item) => item.title), [
    "分析收入",
    "分析成本",
    "计算人效",
    "分析客户集中度",
  ]);
  const plan = buildResolutionMutationPlan({ title: "做完整经营分析" }, resolution);
  assert.equal(plan.operations.filter((item) => item.type === "create").length, 5);
  assert.equal(plan.operations.slice(1).every((item) => item.parent_temp_id === INCOMING_TASK_REF), true);
});

test("a work package can keep its parent-child decision and explicit prerequisites", () => {
  const resolution = resolveTaskIntent({
    title: "完成经营分析，包括收入和成本",
    depends_on_task_ids: ["source-data"],
  }, { tasks: [{ id: "source-data", title: "整理原始数据", status: "open" }] });
  assert.equal(resolution.decision, "PARENT_CHILD");
  assert.equal(resolution.relationships.some((item) => (
    item.relationship_type === "DEPENDS_ON"
      && item.from_task_id === INCOMING_TASK_REF
      && item.to_task_id === "source-data"
  )), true);
});

test("PRD Test 5: highly related independent actions link without merging", () => {
  const goalId = "b139675c-6c89-4f00-9f9c-72b57b20adfe";
  const resolution = resolveTaskIntent(
    { title: "分析 AC&BC 8月客户集中度", goal_plan_id: goalId },
    { tasks: [openTask("revenue", "分析 AC&BC 8月收入", { goal_plan_id: goalId })] },
  );
  assert.equal(resolution.decision, "RELATED");
  assert.equal(resolution.should_create, true);
  assert.equal(resolution.relationships.some((item) => item.relationship_type === "RELATED_TO"), true);
  assert.equal(resolution.relationships.some((item) => item.relationship_type === "MERGED_INTO"), false);
});

test("PRD Test 6: a shared financial database is recorded but never sufficient to merge", () => {
  const resolution = resolveTaskIntent(
    { title: "计算8月自营团队人效" },
    { tasks: [openTask("collections", "整理8月回款")] },
  );
  assert.notEqual(resolution.decision, "MERGE");
  assert.equal(resolution.should_create, true);
  assert.deepEqual(resolution.shared_resources, ["financial_records"]);
  assert.equal(resolution.relationships.some((item) => item.relationship_type === "SHARES_RESOURCE"), true);
});

test("PRD Test 7: a Task links the unique existing Personal OS Goal", () => {
  const goal = {
    id: "goal-personal-os",
    title: "Personal OS 产品化",
    description: "把 Personal OS 做成可以长期使用的产品",
    status: "Active",
  };
  const incoming = { title: "做 Task Semantic Resolution", raw_text: "做 Task Semantic Resolution" };
  assert.equal(findGoalAssociation(incoming, [goal])?.goal.id, goal.id);
  const resolution = resolveTaskIntent(incoming, { goals: [goal] });
  assert.equal(resolution.decision, "GOAL_LINK");
  assert.equal(resolution.goal_link.goal_id, goal.id);
  assert.equal(resolution.should_create, true);
});

test("ambiguous Goals never receive an automatic link unless an exact Goal id is supplied", () => {
  const goals = [
    { id: "goal-a", title: "Personal OS 产品化", status: "Active" },
    { id: "goal-b", title: "Personal OS 产品化", status: "Active" },
  ];
  const incoming = { title: "做 Task Semantic Resolution" };
  assert.equal(findGoalAssociation(incoming, goals), null);
  assert.equal(findGoalAssociation({ ...incoming, goal_plan_id: "goal-b" }, goals)?.goal.id, "goal-b");
});

test("a Project-derived Goal is treated as explicit resolution context", () => {
  const goal = { id: "project-goal", title: "项目所属目标", status: "Active" };
  const resolution = resolveTaskIntent(
    { title: "整理项目交付资料", project_id: "project-1" },
    { goals: [goal], project_goal_id: goal.id },
  );
  assert.equal(resolution.decision, "GOAL_LINK");
  assert.equal(resolution.goal_link.goal_id, goal.id);
});

test("PRD Test 8: low confidence preserves both actions and records only a potential relation", () => {
  const resolution = resolveTaskIntent(
    { title: "跟供应商确认经营数据口径" },
    { tasks: [openTask("maybe-related", "整理经营数据用于月度复盘")] },
  );
  assert.equal(resolution.should_create, true);
  assert.notEqual(resolution.decision, "DUPLICATE");
  assert.notEqual(resolution.decision, "MERGE");
  if (resolution.relationships.length) {
    assert.equal(resolution.relationships.some((item) => ["POTENTIAL_RELATION", "SHARES_RESOURCE"].includes(item.relationship_type)), true);
  }
});

test("PRD Test 9: semantic dedup and technical idempotency remain distinct contracts", () => {
  const resolution = resolveTaskIntent(
    { title: "明天整理财务数据", due: "2026-09-06" },
    { tasks: [openTask("canonical", "明天整理财务数据", { due: "2026-09-06" })] },
  );
  const first = buildResolutionMutationPlan({ title: "明天整理财务数据", idempotency_key: "turn-12345678" }, resolution);
  const retry = buildResolutionMutationPlan({ title: "明天整理财务数据", idempotency_key: "turn-12345678" }, resolution);
  assert.deepEqual(first, retry);
  assert.equal(first.operations.length, 1);
  assert.deepEqual(first.operations[0], { type: "reuse", task_id: "canonical" });
});

test("PRD Test 10: candidate data, not chat memory, enables cross-session resolution", () => {
  const durableCandidate = openTask("three-days-old", "下周一跟佳佳核对成本", {
    due: "2026-09-08",
    updated_at: "2026-09-02T08:00:00Z",
  });
  const resolution = resolveTaskIntent(
    { title: "下周一记得跟佳佳核一下成本", due: "2026-09-08" },
    { tasks: [durableCandidate], conversation: [] },
  );
  assert.equal(resolution.decision, "DUPLICATE");
  assert.equal(resolution.existing_task_id, durableCandidate.id);
});

test("explicit same-deliverable wording supports an auditable non-destructive merge", () => {
  const existing = openTask("report", "完成新自营团队经营分析报告：收入、成本", { goal_plan_id: "g1" });
  const resolution = resolveTaskIntent(
    { title: "把人效并入同一份新自营团队经营分析报告", goal_plan_id: "g1" },
    { tasks: [existing] },
  );
  assert.equal(resolution.decision, "MERGE");
  assert.equal(resolution.should_create, false);
  assert.equal(resolution.existing_task_id, "report");
  assert.ok(resolution.update.title.includes("人效"));
  assert.equal(resolution.relationships[0].relationship_type, "MERGED_INTO");
});

test("explicit merge wording still refuses two near-tied candidates", () => {
  const tasks = [
    openTask("a", "完成8月自营团队经营分析：收入和成本"),
    openTask("b", "完成8月非自营团队经营分析：收入和成本"),
  ];
  const resolution = resolveTaskIntent({
    title: "合并为同一份8月团队经营分析：收入、成本和人效",
  }, { tasks });
  assert.notEqual(resolution.decision, "MERGE");
  assert.equal(resolution.should_create, true);
});

test("write/write overlap is a conflict and never an automatic merge", () => {
  const existing = openTask("schema-a", "重构 Task Schema", {
    write_resources: ["task_schema"],
    resource_fields: ["status"],
  });
  const resolution = resolveTaskIntent(
    { title: "更新 Task Schema 状态字段", write_resources: ["task_schema"], resource_fields: ["status"] },
    { tasks: [existing] },
  );
  assert.equal(resolution.decision, "CONFLICT");
  assert.equal(resolution.should_create, true);
  assert.equal(resolution.relationships.some((item) => item.relationship_type === "CONFLICTS_WITH"), true);
});

test("an explicit producer-consumer order wins over a generic write conflict", () => {
  const existing = openTask("schema-a", "重构 Task Schema", {
    write_resources: ["task_schema"],
    resource_fields: ["columns"],
  });
  const resolution = resolveTaskIntent({
    title: "等前置结果出来后输出迁移报告",
    read_resources: ["task_schema"],
    write_resources: ["task_schema"],
    resource_fields: ["columns"],
  }, { tasks: [existing] });
  assert.equal(resolution.decision, "DEPENDENCY");
  assert.equal(resolution.relationships.some((item) => item.relationship_type === "DEPENDS_ON"), true);
  assert.equal(resolution.relationships.some((item) => item.relationship_type === "CONFLICTS_WITH"), false);
});

test("completed writers do not create a live execution conflict", () => {
  const completed = {
    id: "completed-writer",
    title: "迁移订单归档",
    status: "completed",
    write_resources: ["shared_db"],
  };
  const resolution = resolveTaskIntent({
    title: "开发发票导入",
    write_resources: ["shared_db"],
  }, { tasks: [completed] });
  assert.notEqual(resolution.decision, "CONFLICT");
});

test("an identical write intent is a duplicate before it can be mistaken for a conflict", () => {
  const existing = {
    id: "schema-1",
    title: "重构 Task Schema",
    status: "open",
    write_resources: ["task_schema"],
  };
  const resolution = resolveTaskIntent({
    title: "重构 Task Schema",
    write_resources: ["task_schema"],
  }, { tasks: [existing] });
  assert.equal(resolution.decision, "DUPLICATE");
  assert.equal(resolution.should_create, false);
});

test("a repeated enumerated work package is reused before child decomposition", () => {
  const text = "完成经营分析，包括收入、成本、人效和客户集中度";
  const resolution = resolveTaskIntent({ title: text, raw_text: text }, {
    tasks: [{ id: "package-1", title: text, originalIntent: text, status: "open" }],
  });
  assert.equal(resolution.decision, "DUPLICATE");
  assert.equal(resolution.existing_task_id, "package-1");
});

test("schema producer precedes UI consumer in the execution graph", () => {
  const resolution = resolveTaskIntent(
    { title: "开发新的 Task UI", read_resources: ["task_schema"] },
    { tasks: [openTask("schema", "重构 Task Schema", { write_resources: ["task_schema"] })] },
  );
  assert.equal(resolution.decision, "DEPENDENCY");
  const createdRelationships = replaceIncomingTaskRefs(resolution.relationships, "ui");
  const graph = buildTaskExecutionGraph([
    openTask("schema", "重构 Task Schema", { write_resources: ["task_schema"] }),
    openTask("ui", "开发新的 Task UI", { read_resources: ["task_schema"] }),
  ], createdRelationships);
  assert.deepEqual(graph.blocked_task_ids, ["ui"]);
  assert.deepEqual(graph.ready_task_ids, ["schema"]);
  assert.equal(graph.valid_dag, true);
});

test("completed prerequisites release blocked tasks", () => {
  const relationships = [{ relationship_type: "DEPENDS_ON", from_task_id: "analysis", to_task_id: "cost" }];
  const blocked = buildTaskExecutionGraph([
    openTask("cost", "拿成本"),
    openTask("analysis", "分析利润"),
  ], relationships);
  assert.deepEqual(blocked.blocked_task_ids, ["analysis"]);
  const ready = buildTaskExecutionGraph([
    openTask("cost", "拿成本", { status: "completed" }),
    openTask("analysis", "分析利润"),
  ], relationships);
  assert.deepEqual(ready.ready_task_ids, ["analysis"]);
});

test("DAG validation rejects cycles and parallel execution respects conflicts", () => {
  const dependency = [{ relationship_type: "DEPENDS_ON", from_task_id: "b", to_task_id: "a" }];
  assert.equal(relationshipWouldCreateCycle(dependency, "a", "b"), true);
  assert.throws(
    () => validateTaskRelationship({ relationship_type: "DEPENDS_ON", from_task_id: "a", to_task_id: "b" }, dependency),
    /cycle/i,
  );
  const left = openTask("left", "更新一", { write_resources: ["financial_records"] });
  const right = openTask("right", "更新二", { write_resources: ["financial_records"] });
  assert.equal(canTasksRunInParallel(left, right), false);
  assert.equal(canTasksRunInParallel(left, openTask("independent", "写报告", { write_resources: ["reports"] })), true);
});

test("normalization and profile records preserve explainable semantic features", () => {
  assert.equal(normalizeResolutionText("下周一记得跟佳佳核一下成本"), "下周一跟佳佳核对成本");
  const score = taskCandidateScore(
    { title: "跟佳佳核对成本" },
    { title: "记得跟佳佳核一下成本" },
  );
  assert.ok(score.score >= 0.9);
  const record = resolutionProfileRecord(openTask("x", "整理8月回款"), { confidence: 0.91, reason: "test" });
  assert.equal(record.google_task_id, "x");
  assert.deepEqual(record.resources, ["financial_records"]);
  assert.equal(record.resolution_confidence, 0.91);
});

test("title merge preserves existing meaning while adding new scope", () => {
  assert.equal(
    mergeTaskTitle(openTask("x", "分析六月七月财务数据"), { title: "八月份也一起分析" }),
    "分析6、7、8月财务数据",
  );
});

test('generated explanatory notes cannot authorize an update or merge', () => {
 const p=extractIntentProfile({title:'跟进合伙人支付九月份费用',raw_text:'月底提醒合伙人支付九月份费用，现金流不足放到十月底。',notes:'原付款时间四月初待核；不擅自改为十月初。不要合并，也一起补充说明。'});
 assert.equal(p.explicit_update,false);assert.equal(p.explicit_merge,false);assert.equal(p.additive,false);
});
test('negated and quoted update language is not an operation instruction', () => {
 for(const raw of ['不要改为十月初','不擅自改为十月初','别把已有任务改到月底','原话是“改为十月初”，现在只是记录这句话','他说「改到月底」，请记录说明'])assert.equal(extractIntentProfile({raw_text:raw,title:'记录费用说明'}).explicit_update,false,raw);
 assert.equal(extractIntentProfile({raw_text:'不要改已有标题；把日期改到10月31日',title:'已有任务'}).explicit_update,true);
});
test('shared fees and months cannot establish an unrelated update target', () => {
 const tasks=[{id:'trip',title:'10月香港行：开户与设备购买',notes:'核对开户费用及资金安排',status:'open',due:'2026-10-15',originalIntent:'10月15日香港行，核对费用'}];
 const incoming={title:'跟进合伙人支付九月份费用',raw_text:'月底做个提醒，九月份费用因为现金流不足放到十月底。',notes:'原付款时间四月初待核；不擅自改为十月初。十一月份费用正常支付。',due:'2026-10-31'};
 const r=resolveTaskIntent(incoming,{tasks});assert.equal(r.decision,'NEW');assert.equal(r.existing_task_id,null);assert.equal(r.normalized_intent.explicit_update,false);
 const explicit=resolveTaskIntent({...incoming,raw_text:'把九月份费用到账日期改到十月底'},{tasks});assert.notEqual(explicit.decision,'UPDATE');assert.notEqual(explicit.decision,'MERGE');
});
test('a clearly identified same task retains date update and ordinary duplicate behavior',()=>{
 const task={id:'fee',title:'核对合伙人九月份费用到账',status:'open',due:'2026-10-15'};
 const input={title:task.title,raw_text:'把这条费用任务日期改到10月31日',existing_task_id:'fee',due:'2026-10-31'};
 const r=resolveTaskIntent(input,{tasks:[task]});assert.equal(r.decision,'UPDATE');assert.equal(r.existing_task_id,'fee');assert.equal(r.update.due,'2026-10-31');
 const d=resolveTaskIntent({title:task.title,due:task.due},{tasks:[task]});assert.equal(d.decision,'DUPLICATE');
});
test('an explicit id cannot fall back to another task when missing or closed',()=>{
 for(const tasks of [[{id:'other',title:'费用核对',status:'open'}],[{id:'target',title:'费用核对',status:'completed'}]])assert.throws(()=>resolveTaskIntent({title:'费用核对',raw_text:'把日期改到月底',existing_task_id:'target',due:'2026-10-31'},{tasks}),/missing or closed/);
});
test('weak update keyword candidates are not promoted to high-confidence updates',()=>{
 const r=resolveTaskIntent({title:'九月费用到账',raw_text:'将九月费用日期改为十月底',due:'2026-10-31'},{tasks:[{id:'trip',title:'10月香港行核对开户费用',status:'open',due:'2026-10-15'}]});assert.notEqual(r.decision,'UPDATE');assert.notEqual(r.decision,'MERGE');
});
