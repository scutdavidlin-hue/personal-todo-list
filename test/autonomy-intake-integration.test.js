import assert from "node:assert/strict";
import test from "node:test";

let importNumber = 0;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function loadIntakeHandler({ taskResult, readTask, context, failPreference = false } = {}) {
  const previousDeno = globalThis.Deno;
  const previousFetch = globalThis.fetch;
  const writes = [];
  const token = `unit-${"x".repeat(32)}`;
  const environment = {
    SUPABASE_URL: "https://personal-os.test",
    SUPABASE_SERVICE_ROLE_KEY: `unit-${"s".repeat(32)}`,
    OWNER_USER_ID: "11111111-1111-4111-8111-111111111111",
    AUTOMATION_WRITE_TOKEN: token,
  };
  let handler;
  let goalPlanReads = 0;
  let lastTask = null;

  globalThis.Deno = {
    env: { get: (name) => environment[name] },
    serve: (nextHandler) => { handler = nextHandler; },
  };
  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    writes.push({ path: `${requestUrl.pathname}${requestUrl.search}`, method: init.method || "GET", body });

    if (requestUrl.pathname.endsWith("/functions/v1/task-status")) {
      if (body.action === "autonomy_context") return json(context || { current_task: null, calendar_events: [], context_warnings: [] });
      if (body.action === "read_task") return json(readTask || { task: lastTask });
      if (body.action === "update_task") {
        lastTask = taskResult?.task || {
          id: body.task_id, title: "下午四点开会", notes: "", dueDate: null,
        };
        return json(taskResult || {
          write_success: true,
          task: lastTask,
          resolution: { decision: "UPDATE" },
        });
      }
      lastTask = taskResult?.task || {
        id: "task-hotel", title: body.title, notes: body.notes, dueDate: body.dueDate,
      };
      return json(taskResult || {
        write_success: true,
        task: lastTask,
      });
    }

    if (requestUrl.pathname.endsWith("/rest/v1/personal_os_intake_audit")) {
      if ((init.method || "GET") === "POST") return json([{ id: "audit-1" }]);
      return json([]);
    }
    if (requestUrl.pathname.endsWith("/rest/v1/goals_plans")) {
      goalPlanReads += 1;
      if (failPreference && (init.method || "GET") === "POST") return json({ message: "plan write unavailable" }, 503);
      return json([]);
    }
    throw new Error(`Unexpected request: ${requestUrl.pathname}`);
  };

  try {
    await import(new URL(`../supabase/functions/personal-os-intake/index.ts?integration=${importNumber += 1}`, import.meta.url));
    assert.equal(typeof handler, "function");
    return {
      writes,
      token,
      goalPlanReads: () => goalPlanReads,
      request: async (body) => handler(new Request("https://personal-os.test/intake", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "integration-key-1" },
        body: JSON.stringify(body),
      })),
      restore: () => {
        globalThis.Deno = previousDeno;
        globalThis.fetch = previousFetch;
      },
    };
  } catch (error) {
    globalThis.Deno = previousDeno;
    globalThis.fetch = previousFetch;
    throw error;
  }
}

function taskStatusWrites(harness) {
  return harness.writes.filter((call) => call.path.endsWith("/functions/v1/task-status"));
}

test("real intake handler writes, reads back, and returns the verified confirmation", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler();
  try {
    const response = await harness.request({ raw_text: "明天提醒我订亚朵酒店", type: "task", title: "订亚朵酒店" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.write_success, true);
    assert.equal(body.verified, true);
    assert.equal(body.message, "已经写进去了");
    assert.deepEqual(taskStatusWrites(harness).map((call) => call.body.action || "create"), ["autonomy_context", "create", "read_task"]);
  } finally {
    harness.restore();
  }
});

test("real intake handler answers pure questions without provider or audit writes", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler();
  try {
    const response = await harness.request({ raw_text: "明天有什么安排？" });
    const body = await response.json();

    assert.equal(body.success, false);
    assert.equal(body.code, "INFORMATION_ONLY");
    assert.equal(body.message, "这是信息查询，未创建任务。");
    assert.equal(harness.writes.length, 0);
  } finally {
    harness.restore();
  }
});

test("real intake handler blocks L3 money operations before any write", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler();
  try {
    const response = await harness.request({ raw_text: "帮我转账 100000 元" });
    const body = await response.json();

    assert.equal(body.success, false);
    assert.equal(body.decision, "ask");
    assert.equal(body.risk_level, "L3");
    assert.equal(harness.writes.length, 0);
  } finally {
    harness.restore();
  }
});

test("short corrections use the provider update route and retain the current task id", { concurrency: false }, async () => {
  const task = { id: "task-current", title: "下午三点开会", notes: "", dueDate: null };
  const harness = await loadIntakeHandler({
    context: { current_task: { ...task, requested_date: "2026-09-06", requested_time: "15:00" }, calendar_events: [], context_warnings: [] },
    taskResult: { write_success: true, task, resolution: { decision: "UPDATE" } },
    readTask: { task },
  });
  try {
    const response = await harness.request({ raw_text: "改成四点", context: { current_task: { id: "task-current" } } });
    const body = await response.json();
    const update = taskStatusWrites(harness).find((call) => call.body.action === "update_task");

    assert.equal(body.success, true);
    assert.equal(body.id, "task-current");
    assert.equal(update.body.task_id, "task-current");
    assert.equal(update.body.changes.requested_time, "16:00");
    assert.equal(taskStatusWrites(harness).some((call) => !call.body.action), false);
  } finally {
    harness.restore();
  }
});

test("a failed provider readback never reports a successful write", { concurrency: false }, async () => {
  const created = { write_success: true, task: { id: "task-hotel", title: "订亚朵酒店", notes: "", dueDate: null } };
  const harness = await loadIntakeHandler({ taskResult: created, readTask: { task: { ...created.task, title: "另一家酒店" } } });
  try {
    const response = await harness.request({ raw_text: "订亚朵酒店", type: "task", title: "订亚朵酒店" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, false);
    assert.equal(body.verified, false);
    assert.equal(body.code, "WRITE_UNVERIFIED");
    assert.equal(body.message, "写入结果尚未核实，请回读原任务，勿重复创建。");
  } finally {
    harness.restore();
  }
});

test("mixed current action and lasting preference reports a partial result", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler({ failPreference: true });
  try {
    const response = await harness.request({ raw_text: "这次订亚朵酒店，以后都住亚朵" });
    const body = await response.json();

    assert.equal(body.success, false);
    assert.equal(body.partial, true);
    assert.equal(body.id, "task-hotel");
    assert.equal(body.message, "部分写入完成，请按返回的对象 ID 继续处理未完成部分。");
    assert.ok(harness.goalPlanReads() >= 2);
  } finally {
    harness.restore();
  }
});
