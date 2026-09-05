import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskResolutionContext,
  createTaskResolutionAdapter,
  enrichTaskCandidates,
  loadTaskResolutionContext,
  resolveAndExecuteTask,
  selectGoalCandidateWindow,
  selectTaskCandidateWindow,
} from "../supabase/functions/_shared/task-resolution-runtime.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AUDIT = "22222222-2222-4222-8222-222222222222";

test("candidate retrieval keeps open tasks and only recently completed history", () => {
  const now = new Date("2026-09-05T00:00:00Z");
  const tasks = [
    { id: "open", status: "open", updatedAt: "2024-01-01T00:00:00Z" },
    { id: "recent", status: "completed", completedAt: "2026-08-20T00:00:00Z" },
    { id: "old", status: "completed", completedAt: "2025-01-01T00:00:00Z" },
  ];
  assert.deepEqual(selectTaskCandidateWindow(tasks, { now, recentCompletedDays: 90 }).map((task) => task.id), ["open", "recent"]);
});

test("provider truth is enriched with durable cross-session metadata", () => {
  const tasks = [{ id: "task-1", title: "分析经营数据", status: "open" }];
  const profiles = [{
    google_task_id: "task-1",
    canonical_task_id: "canonical-1",
    normalized_title: "分析经营数据",
    action: "analyze",
    topics: ["finance"],
    entities: ["佳佳"],
    resources: ["financial_records"],
    read_resources: ["financial_records"],
  }];
  const [candidate] = enrichTaskCandidates(tasks, profiles);
  assert.equal(candidate.status, "open");
  assert.equal(candidate.canonical_task_id, "canonical-1");
  assert.deepEqual(candidate.entities, ["佳佳"]);
  assert.deepEqual(candidate.months, []);
});

test("enriched candidates remain valid inputs to the resolver", async () => {
  const context = buildTaskResolutionContext(
    [{ id: "task-1", title: "分析6、7月财务数据", status: "open" }],
    [{
      google_task_id: "task-1",
      canonical_task_id: "task-1",
      normalized_title: "分析6、7月财务数据",
      action: "analyze",
      topics: ["finance"],
      entities: [],
      resources: ["financial_records"],
      read_resources: ["financial_records"],
      write_resources: [],
    }],
    [],
  );
  const store = memoryRest();
  let updated = null;
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER,
    serviceRest: store.rest,
    provider: {
      getTask: async () => context.tasks[0],
      createTask: async () => { throw new Error("must not create"); },
      updateTask: async (_id, changes) => (updated = { ...context.tasks[0], ...changes }),
    },
  });
  const result = await resolveAndExecuteTask({ title: "8月也一起分析", raw_text: "8月也一起分析" }, context, adapter);
  assert.equal(result.resolution.decision, "UPDATE");
  assert.match(updated.title, /8月/);
});

test("closed Goals are not resolution candidates", () => {
  const goals = [
    { id: "active", status: "Active", updated_at: "2026-09-05" },
    { id: "done", status: "Completed", updated_at: "2026-09-06" },
  ];
  assert.deepEqual(selectGoalCandidateWindow(goals).map((goal) => goal.id), ["active"]);
});

test("context loading asks the semantic index and only open Goals for bounded candidates", async () => {
  const calls = [];
  const serviceRest = async (path, init = {}) => {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    if (path === "rpc/search_task_resolution_profiles") return [];
    if (path.startsWith("goals_plans?")) return [];
    throw new Error(`unexpected ${path}`);
  };
  const context = await loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER,
    incoming: { title: "分析财务数据" },
    providerTasks: [{ id: "task-1", title: "整理财务数据", status: "open" }],
  });
  assert.equal(context.tasks.length, 1);
  assert.equal(calls[0].body.target_owner, OWNER);
  assert.equal(calls[0].body.match_count, 20);
  assert.match(calls[1].path, /status=not\.in/);
  assert.match(calls[1].path, /limit=100/);
});

test("an explicit Goal id is retrieved directly instead of relying on recent ordering", async () => {
  const goalId = "33333333-3333-4333-8333-333333333333";
  const calls = [];
  const serviceRest = async (path) => {
    calls.push(path);
    if (path === "rpc/search_task_resolution_profiles") return [];
    if (path.startsWith("goals_plans?")) return [{ id: goalId, title: "Existing Goal", status: "Active" }];
    throw new Error(`unexpected ${path}`);
  };
  await loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER,
    incoming: { title: "做下一步", goal_plan_id: goalId },
    providerTasks: [],
  });
  assert.match(calls[1], new RegExp(`id=eq\\.${goalId}`));
  assert.match(calls[1], /status=not\.in/);
});

test("a missing or closed explicit Goal stops before Task persistence", async () => {
  const goalId = "33333333-3333-4333-8333-333333333333";
  const serviceRest = async (path) => {
    if (path === "rpc/search_task_resolution_profiles") return [];
    if (path.startsWith("goals_plans?")) return [];
    throw new Error(`unexpected ${path}`);
  };
  await assert.rejects(() => loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER,
    incoming: { title: "做下一步", goal_plan_id: goalId },
    providerTasks: [],
  }), /not found or is closed/i);
});

test("a Project supplies its canonical Goal context before semantic matching", async () => {
  const projectId = "77777777-7777-4777-8777-777777777777";
  const goalId = "88888888-8888-4888-8888-888888888888";
  const calls = [];
  const serviceRest = async (path) => {
    calls.push(path);
    if (path.startsWith("projects?")) return [{ id: projectId, goal_plan_id: goalId }];
    if (path === "rpc/search_task_resolution_profiles") return [];
    if (path.startsWith("goals_plans?")) return [{ id: goalId, title: "项目所属 Goal", status: "Active" }];
    throw new Error(`unexpected ${path}`);
  };
  const context = await loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER,
    incoming: { title: "推进项目交付", project_id: projectId },
    providerTasks: [],
  });
  assert.equal(context.project_goal_id, goalId);
  assert.match(calls[0], new RegExp(`id=eq\\.${projectId}`));
  assert.match(calls[2], new RegExp(`id=eq\\.${goalId}`));
});

test("conflicting explicit Goal and Project context stops before Task persistence", async () => {
  const serviceRest = async (path) => {
    if (path.startsWith("projects?")) return [{ id: "project", goal_plan_id: "project-goal" }];
    throw new Error(`unexpected ${path}`);
  };
  await assert.rejects(() => loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER,
    incoming: { title: "推进交付", project_id: "project", goal_plan_id: "other-goal" },
    providerTasks: [],
  }), /does not belong/i);
});

test("an unassigned Project cannot be combined with an unrelated explicit Goal", async () => {
  const serviceRest = async (path) => {
    if (path.startsWith("projects?")) return [{ id: "project", goal_plan_id: null }];
    throw new Error(`unexpected ${path}`);
  };
  await assert.rejects(() => loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER,
    incoming: { title: "推进交付", project_id: "project", goal_plan_id: "other-goal" },
    providerTasks: [],
  }), /does not belong/i);
});

test("semantic profile hits outside the provider window are hydrated by stable Task id", async () => {
  const serviceRest = async (path) => {
    if (path === "rpc/search_task_resolution_profiles") return [{
      google_task_id: "outside-window",
      canonical_task_id: "outside-window",
      normalized_title: "核对佳佳成本",
      semantic_key: "verify:cost:佳佳",
      action: "verify",
      entities: ["佳佳"],
      topics: ["finance", "cost"],
      resources: ["financial_records"],
      read_resources: ["financial_records"],
      write_resources: [],
      resource_fields: [],
    }];
    if (path.startsWith("goals_plans?")) return [];
    throw new Error(`unexpected ${path}`);
  };
  const requested = [];
  const context = await loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER,
    incoming: { title: "跟佳佳核对成本" },
    providerTasks: [],
    providerGetTask: async (id) => {
      requested.push(id);
      return { id, title: "跟佳佳核对成本", status: "open" };
    },
  });
  assert.deepEqual(requested, ["outside-window"]);
  assert.equal(context.tasks[0].id, "outside-window");
  assert.deepEqual(context.tasks[0].entities, ["佳佳"]);
});

test("explicit prerequisites outside the provider window are fetched and validated", async () => {
  const serviceRest = async (path) => {
    if (path === "rpc/search_task_resolution_profiles") return [];
    if (path.startsWith("goals_plans?")) return [];
    throw new Error(`unexpected ${path}`);
  };
  const requested = [];
  const context = await loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER,
    incoming: { title: "完成报告", depends_on_task_ids: ["cost", "revenue"] },
    providerTasks: [],
    providerGetTask: async (id) => {
      requested.push(id);
      return { id, title: `${id} data`, status: "open" };
    },
  });
  assert.deepEqual(requested, ["cost", "revenue"]);
  assert.deepEqual(context.tasks.map((task) => task.id), ["cost", "revenue"]);
});

test("a missing explicit prerequisite aborts resolution before creating a dangling edge", async () => {
  const serviceRest = async (path) => {
    if (path === "rpc/search_task_resolution_profiles") return [];
    if (path.startsWith("goals_plans?")) return [];
    throw new Error(`unexpected ${path}`);
  };
  await assert.rejects(() => loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER,
    incoming: { title: "完成报告", depends_on_task_ids: ["missing"] },
    providerTasks: [],
    providerGetTask: async () => null,
  }), /not found/i);
});

function memoryRest() {
  const state = {
    audits: [], profiles: [], relationships: [], bindings: [], links: [], outerPatches: [], schedulePatches: [],
  };
  const rest = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (path.startsWith("task_resolution_audit?select") && init.method === "POST") {
      const row = { id: AUDIT, ...body };
      state.audits.push(row);
      return [row];
    }
    if (path.startsWith(`task_resolution_audit?id=eq.${AUDIT}`) && init.method === "PATCH") {
      Object.assign(state.audits[0], body);
      return path.includes("select=*") ? [state.audits[0]] : null;
    }
    if (path.startsWith("personal_os_intake_audit?") && init.method === "PATCH") {
      state.outerPatches.push(body);
      return null;
    }
    if (path.startsWith("task_resolution_profiles?") && !init.method) return state.profiles;
    if (path.startsWith("task_resolution_profiles?on_conflict") && init.method === "POST") {
      state.profiles.push(body);
      return [body];
    }
    if (path.startsWith("task_schedule_metadata?") && init.method === "PATCH") {
      state.schedulePatches.push(body);
      return null;
    }
    if (path.startsWith("task_relationships?") && !init.method) return state.relationships;
    if (path.startsWith("task_relationships?on_conflict") && init.method === "POST") {
      state.relationships.push(...body);
      return body;
    }
    if (path.startsWith("task_resource_bindings?") && !init.method) return state.bindings;
    if (path.startsWith("task_resource_bindings?on_conflict") && init.method === "POST") {
      state.bindings.push(...body);
      return body;
    }
    if (path.startsWith("task_context_links?") && !init.method) return state.links;
    if (path.startsWith("task_context_links?on_conflict") && init.method === "POST") {
      state.links.push(body);
      return [body];
    }
    throw new Error(`Unexpected REST call: ${init.method || "GET"} ${path}`);
  };
  return { rest, state };
}

test("runtime executes one canonical update and persists explainability metadata", async () => {
  const store = memoryRest();
  const existing = { id: "task-1", title: "分析6、7月财务数据", status: "open", updatedAt: "2026-09-05T01:00:00Z" };
  let updated = null;
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER,
    taskListId: "list-1",
    intakeAuditId: "33333333-3333-4333-8333-333333333333",
    serviceRest: store.rest,
    provider: {
      getTask: async () => existing,
      createTask: async () => { throw new Error("must not create"); },
      updateTask: async (_id, changes) => {
        updated = { ...existing, ...changes };
        return updated;
      },
    },
  });
  const context = buildTaskResolutionContext([existing], [], []);
  const result = await resolveAndExecuteTask({
    title: "8月也一起分析",
    raw_text: "8月也一起分析",
  }, context, adapter);

  assert.equal(result.resolution.decision, "UPDATE");
  assert.equal(result.created, false);
  assert.equal(updated.title, "分析6、7、8月财务数据");
  assert.equal(store.state.audits[0].status, "succeeded");
  assert.equal(store.state.profiles[0].google_task_id, "task-1");
  assert.match(store.state.profiles[0].normalized_title, /8月/);
  assert.equal(Object.hasOwn(store.state.profiles[0], "provider_snapshot"), false);
  assert.equal(store.state.outerPatches[0].resolution_audit_id, AUDIT);
});

test("duplicate reuse is auditable without creating an invalid self-edge", async () => {
  const store = memoryRest();
  const existing = { id: "task-1", title: "周一跟佳佳核对成本", status: "open" };
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER,
    serviceRest: store.rest,
    provider: {
      getTask: async () => existing,
      createTask: async () => { throw new Error("must not create"); },
      updateTask: async () => { throw new Error("must not update"); },
    },
  });
  const result = await resolveAndExecuteTask(
    { title: "下周一记得跟佳佳核一下成本", raw_text: "下周一记得跟佳佳核一下成本" },
    buildTaskResolutionContext([existing], [], []),
    adapter,
  );
  assert.equal(result.resolution.decision, "DUPLICATE");
  assert.equal(result.relationships.length, 0);
  assert.equal(store.state.relationships.length, 0);
  assert.equal(store.state.audits[0].status, "succeeded");
});

test("profile upsert preserves durable context while adding new resolution evidence", async () => {
  const store = memoryRest();
  store.state.profiles.push({
    google_task_id: "task-1",
    canonical_task_id: "canonical-1",
    entities: ["佳佳"],
    topics: ["cost"],
    resources: ["financial_records"],
    read_resources: ["financial_records"],
    write_resources: [],
    resource_fields: ["cost"],
    source_intent_ids: ["44444444-4444-4444-8444-444444444444"],
    goal_plan_id: "55555555-5555-4555-8555-555555555555",
    project_id: "66666666-6666-4666-8666-666666666666",
    created_from: "chatgpt",
  });
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER,
    serviceRest: store.rest,
    provider: {
      getTask: async () => ({}),
      createTask: async () => ({}),
      updateTask: async () => ({}),
    },
  });
  await adapter.upsertTaskProfile({
    google_task_id: "task-1",
    canonical_task_id: "",
    normalized_title: "分析利润",
    semantic_key: "analyze:profit",
    action: "analyze",
    entities: [],
    topics: ["profit"],
    resources: ["report_output"],
    read_resources: ["report_output"],
    write_resources: [],
    resource_fields: [],
    source_intent_ids: [],
    goal_plan_id: null,
    project_id: null,
    last_semantic_resolution_at: "2026-09-05T00:00:00Z",
  }, { resolution_audit_id: AUDIT });
  const persisted = store.state.profiles.at(-1);
  assert.equal(persisted.canonical_task_id, "canonical-1");
  assert.deepEqual(persisted.topics, ["cost", "profit"]);
  assert.deepEqual(persisted.resources, ["financial_records", "report_output"]);
  assert.equal(persisted.goal_plan_id, "55555555-5555-4555-8555-555555555555");
  assert.equal(persisted.project_id, "66666666-6666-4666-8666-666666666666");
  assert.deepEqual(persisted.source_intent_ids, [
    "44444444-4444-4444-8444-444444444444",
    AUDIT,
  ]);
});

test("resource and Goal upserts preserve stronger existing metadata", async () => {
  const store = memoryRest();
  store.state.bindings.push({
    google_task_id: "task-1",
    resource_key: "financial_records",
    access_type: "write",
    fields: ["cost"],
  });
  store.state.links.push({
    google_task_id: "task-1",
    goal_plan_id: "old-goal",
    project_id: "project-1",
  });
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER,
    serviceRest: store.rest,
    provider: {
      getTask: async () => ({}),
      createTask: async () => ({}),
      updateTask: async () => ({}),
    },
  });
  await adapter.upsertResourceBindings([{
    google_task_id: "task-1",
    resource_key: "financial_records",
    access_type: "read",
    fields: ["revenue"],
  }], { resolution_audit_id: AUDIT });
  await adapter.linkGoal("task-1", "old-goal");
  const binding = store.state.bindings.at(-1);
  const link = store.state.links.at(-1);
  assert.equal(binding.access_type, "read_write");
  assert.deepEqual(binding.fields, ["cost", "revenue"]);
  assert.equal(link.goal_plan_id, "old-goal");
  assert.equal(link.project_id, "project-1");
});

test("moving a Task to a different Goal never carries an incompatible Project link", async () => {
  const store = memoryRest();
  store.state.links.push({
    google_task_id: "task-1",
    goal_plan_id: "old-goal",
    project_id: "old-project",
  });
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER,
    serviceRest: store.rest,
    provider: {
      getTask: async () => ({}),
      createTask: async () => ({}),
      updateTask: async () => ({}),
    },
  });
  await adapter.linkGoal("task-1", "new-goal");
  const link = store.state.links.at(-1);
  assert.equal(link.goal_plan_id, "new-goal");
  assert.equal(link.project_id, null);
});

test("moving a semantic profile to a different Goal clears its old Project", async () => {
  const store = memoryRest();
  store.state.profiles.push({
    google_task_id: "task-1",
    canonical_task_id: "task-1",
    entities: [],
    topics: ["finance"],
    resources: [],
    read_resources: [],
    write_resources: [],
    resource_fields: [],
    source_intent_ids: [],
    goal_plan_id: "old-goal",
    project_id: "old-project",
    created_from: "chatgpt",
  });
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER,
    serviceRest: store.rest,
    provider: {
      getTask: async () => ({}),
      createTask: async () => ({}),
      updateTask: async () => ({}),
    },
  });
  await adapter.upsertTaskProfile({
    google_task_id: "task-1",
    canonical_task_id: "task-1",
    normalized_title: "分析利润",
    semantic_key: "analyze:profit",
    action: "analyze",
    entities: [],
    topics: ["profit"],
    resources: [],
    read_resources: [],
    write_resources: [],
    resource_fields: [],
    source_intent_ids: [],
    goal_plan_id: "new-goal",
    project_id: null,
    last_semantic_resolution_at: "2026-09-05T00:00:00Z",
  }, { resolution_audit_id: AUDIT });
  const profile = store.state.profiles.at(-1);
  assert.equal(profile.goal_plan_id, "new-goal");
  assert.equal(profile.project_id, null);
});

test("linking an unassigned Project clears an incompatible existing Goal", async () => {
  const store = memoryRest();
  store.state.links.push({
    google_task_id: "task-1",
    goal_plan_id: "old-goal",
    project_id: "old-project",
  });
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER,
    serviceRest: store.rest,
    provider: {
      getTask: async () => ({}),
      createTask: async () => ({}),
      updateTask: async () => ({}),
    },
  });
  await adapter.linkContext("task-1", null, "unassigned-project");
  const link = store.state.links.at(-1);
  assert.equal(link.goal_plan_id, null);
  assert.equal(link.project_id, "unassigned-project");
});

test("a Project can be linked without inventing a Goal", async () => {
  const store = memoryRest();
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER,
    serviceRest: store.rest,
    provider: {
      getTask: async () => ({}),
      createTask: async () => ({}),
      updateTask: async () => ({}),
    },
  });
  await adapter.linkContext("task-1", null, "project-1");
  const link = store.state.links.at(-1);
  assert.equal(link.goal_plan_id, null);
  assert.equal(link.project_id, "project-1");
});

test("relationship persistence canonicalizes symmetric edges and rejects dependency cycles", async () => {
  const store = memoryRest();
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER,
    serviceRest: store.rest,
    provider: {
      getTask: async () => ({}),
      createTask: async () => ({}),
      updateTask: async () => ({}),
    },
  });
  await adapter.upsertRelationships([{
    relationship_type: "RELATED_TO",
    from_task_id: "z",
    to_task_id: "a",
    confidence: 0.8,
    reason: "related",
  }]);
  assert.equal(store.state.relationships[0].from_task_id, "a");
  assert.equal(store.state.relationships[0].to_task_id, "z");

  store.state.relationships.push({ relationship_type: "DEPENDS_ON", from_task_id: "b", to_task_id: "a" });
  await assert.rejects(() => adapter.upsertRelationships([{
    relationship_type: "DEPENDS_ON",
    from_task_id: "a",
    to_task_id: "b",
    confidence: 1,
    reason: "cycle",
  }]), /cycle/i);
});
