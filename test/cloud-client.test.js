import test from "node:test";
import assert from "node:assert/strict";
import { CloudError, GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_TASKS_SCOPE, TaskCloudClient } from "../src/cloud-client.js";

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function response(body, status = 200) {
  return new Response(body === null ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sessionStorage(extra = {}) {
  return new MemoryStorage({
    "task-sync-auth-session-v1": JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    ...extra,
  });
}

const config = { supabaseUrl: "https://example-project.supabase.co", supabaseAnonKey: "public-anon-key-longer-than-twenty-characters" };

test("configuration rejects placeholders", () => {
  assert.equal(new TaskCloudClient({}, { storage: new MemoryStorage(), fetch: async () => response({}) }).isConfigured(), false);
  assert.equal(new TaskCloudClient(config, { storage: new MemoryStorage(), fetch: async () => response({}) }).isConfigured(), true);
});

test("Google OAuth reuses Supabase Auth and requests Tasks offline scope", () => {
  let assigned = "";
  const client = new TaskCloudClient(config, {
    storage: new MemoryStorage(),
    transientStorage: new MemoryStorage(),
    location: { assign(url) { assigned = url; } },
  });
  const url = client.requestGoogleLogin("https://example.com/today.html");
  const parsed = new URL(url);
  assert.equal(assigned, url);
  assert.equal(parsed.pathname, "/auth/v1/authorize");
  assert.equal(parsed.searchParams.get("provider"), "google");
  assert.equal(parsed.searchParams.get("scopes"), `${GOOGLE_TASKS_SCOPE} ${GOOGLE_CALENDAR_EVENTS_SCOPE}`);
  assert.equal(parsed.searchParams.get("access_type"), "offline");
  assert.equal(parsed.searchParams.get("prompt"), "consent");
  assert.equal(parsed.searchParams.get("redirect_to"), "https://example.com/today.html");
});

test("OAuth callback persists only Supabase session and keeps provider credentials transient", () => {
  const storage = new MemoryStorage();
  const transientStorage = new MemoryStorage();
  const location = {
    hash: "#access_token=supabase-access&refresh_token=supabase-refresh&provider_token=google-access&provider_refresh_token=google-refresh&expires_in=3600",
    pathname: "/today.html",
    search: "",
  };
  const client = new TaskCloudClient(config, { storage, transientStorage, location });
  assert.equal(client.consumeAuthRedirect(), true);
  const persisted = JSON.parse(storage.getItem("task-sync-auth-session-v1"));
  assert.equal(persisted.access_token, "supabase-access");
  assert.equal("provider_refresh_token" in persisted, false);
  assert.equal(client.transientGoogleCredentials().provider_refresh_token, "google-refresh");
});

test("successful OAuth finalization sends provider credentials then clears transient storage", async () => {
  const transientStorage = new MemoryStorage({
    "task-sync-google-oauth-transient-v1": JSON.stringify({ provider_token: "google-access", provider_refresh_token: "google-refresh" }),
  });
  let captured;
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    transientStorage,
    fetch: async (url, init) => {
      captured = { url, method: init.method, body: JSON.parse(init.body) };
      return response({ connected: true, taskListTitle: "Personal OS" });
    },
  });
  const result = await client.finalizeGoogleTasksConnection();
  assert.equal(result.connected, true);
  assert.match(captured.url, /\/functions\/v1\/google-tasks$/);
  assert.deepEqual(captured.body, { action: "connect", provider_token: "google-access", provider_refresh_token: "google-refresh" });
  assert.equal(transientStorage.getItem("task-sync-google-oauth-transient-v1"), null);
});

test("failed OAuth finalization keeps transient credentials for a safe retry", async () => {
  const transientStorage = new MemoryStorage({
    "task-sync-google-oauth-transient-v1": JSON.stringify({ provider_token: "google-access", provider_refresh_token: "google-refresh" }),
  });
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    transientStorage,
    fetch: async () => response({ error: "Temporary failure" }, 503),
  });
  await assert.rejects(() => client.finalizeGoogleTasksConnection(), CloudError);
  assert.equal(client.transientGoogleCredentials().provider_refresh_token, "google-refresh");
});

test("concurrent expired requests share one Supabase session refresh", async () => {
  const storage = sessionStorage();
  storage.setItem("task-sync-auth-session-v1", JSON.stringify({
    access_token: "expired-access",
    refresh_token: "refresh",
    expires_at: 0,
    user: { id: "user-1" },
  }));
  let refreshCalls = 0;
  const client = new TaskCloudClient(config, {
    storage,
    fetch: async (url) => {
      if (url.includes("/auth/v1/token")) {
        refreshCalls += 1;
        await Promise.resolve();
        return response({ access_token: "renewed", refresh_token: "rotated", expires_in: 3600 });
      }
      return response({ tasks: [] });
    },
  });

  await Promise.all([client.listOpenTasks(), client.listOpenTasks(), client.listOpenTasks()]);

  assert.equal(refreshCalls, 1);
  assert.equal(client.session().access_token, "renewed");
  assert.equal(client.session().refresh_token, "rotated");
  assert.equal(client.session().user.id, "user-1");
});

test("transient Supabase refresh failures preserve the local session", async () => {
  const storage = sessionStorage();
  storage.setItem("task-sync-auth-session-v1", JSON.stringify({
    access_token: "expired-access",
    refresh_token: "refresh",
    expires_at: 0,
    user: { id: "user-1" },
  }));
  const client = new TaskCloudClient(config, {
    storage,
    fetch: async () => { throw new TypeError("offline"); },
  });

  await assert.rejects(() => client.listOpenTasks(), (error) => error.code === "NETWORK_ERROR");
  assert.equal(client.session().refresh_token, "refresh");
  assert.equal(client.session().user.id, "user-1");
});

test("a confirmed invalid Supabase refresh token clears only that rejected session", async () => {
  const storage = sessionStorage();
  storage.setItem("task-sync-auth-session-v1", JSON.stringify({
    access_token: "expired-access",
    refresh_token: "invalid-refresh",
    expires_at: 0,
  }));
  const client = new TaskCloudClient(config, {
    storage,
    fetch: async () => response({ code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" }, 400),
  });

  await assert.rejects(() => client.listOpenTasks(), (error) => error.code === "refresh_token_not_found");
  assert.equal(client.session(), null);
});

test("Google provider 401 remains distinct from Supabase auth and does not refresh or sign out", async () => {
  const storage = sessionStorage();
  let refreshCalls = 0;
  const client = new TaskCloudClient(config, {
    storage,
    fetch: async (url) => {
      if (url.includes("/auth/v1/token")) refreshCalls += 1;
      return response({ code: "GOOGLE_REAUTH_REQUIRED", error: "Google authorization expired" }, 401);
    },
  });

  await assert.rejects(() => client.listOpenTasks(), (error) => error.code === "GOOGLE_REAUTH_REQUIRED");
  assert.equal(refreshCalls, 0);
  assert.equal(client.session().refresh_token, "refresh");
});

test("listTasks defaults to unfinished Google Tasks", async () => {
  let capturedUrl;
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    fetch: async (url) => {
      capturedUrl = url;
      return response({ tasks: [{ id: "google-id", title: "云任务", date: "2026-09-03", status: "open", done: false }] });
    },
  });
  const tasks = await client.listTasks();
  assert.match(capturedUrl, /showCompleted=false$/);
  assert.equal(tasks[0].id, "google-id");
  assert.equal(tasks[0].category, "Google Tasks");
});

test("task list and open-task filters use the unified service", async () => {
  const urls = [];
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    fetch: async (url) => {
      urls.push(url);
      if (url.includes("resource=tasklists")) return response({ taskLists: [{ id: "list", title: "Personal OS" }], selectedTaskListId: "list" });
      return response({ tasks: [] });
    },
  });
  const lists = await client.listTaskLists();
  await client.listOpenTasks({ filter: "overdue", date: "2026-09-04" });
  assert.equal(lists.taskLists[0].title, "Personal OS");
  assert.match(urls[1], /filter=overdue/);
  assert.match(urls[1], /date=2026-09-04/);
});

test("canonical CRUD methods use the Google Tasks Edge Function", async () => {
  const calls = [];
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method, body, headers: init.headers });
      if (init.method === "DELETE") return response({ deleted: true });
      return response({ task: { id: body.id || "created", title: body.task?.title || "A", date: body.task?.date || body.changes?.date || "2026-09-03", status: body.completed === false ? "open" : "done" } }, init.method === "POST" ? 201 : 200);
    },
  });
  await client.createTask({ title: "A", notes: "说明", date: "2026-09-03" });
  await client.completeTask("created");
  await client.reopenTask("created");
  await client.updateTask("created", { date: "2026-09-04" });
  await client.deleteTask("created");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "PATCH", "PATCH", "PATCH", "DELETE"]);
  assert.deepEqual(calls.map((call) => call.body.action), ["create", "complete", "reopen", "update", undefined]);
  assert.equal(calls[4].body.id, "created");
  assert.ok(calls.every((call) => /^\w+:[0-9a-z-]+$/i.test(call.headers["Idempotency-Key"])));
});

test("task mutations preserve receipt and partial projection evidence on the compatible task result", async () => {
  const receipt = {
    request_id: "request-1",
    task_id: "task-1",
    task_save_status: "verified",
    schedule_status: "saved",
    reminder_projection_status: "pending",
    device_delivery_status: "not_verified",
    readback_at: "2026-09-24T03:00:00.000Z",
    error_category: "CALENDAR_SYNC_FAILED",
    retryable: true,
    next_step: "retry_projection",
    message: "任务已保存，提醒待恢复",
  };
  const projectionError = { success: false, code: "CALENDAR_SYNC_FAILED" };
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    fetch: async () => response({
      success: true,
      task: { id: "task-1", title: "交材料" },
      projection: projectionError,
      projection_error: projectionError,
      receipt,
      idempotency_key: "create:stable-key",
      replayed: false,
    }),
  });

  const task = await client.createTask({ title: "交材料" });

  assert.equal(task.id, "task-1");
  assert.deepEqual(task.write_receipt, receipt);
  assert.deepEqual(task.projection_error, projectionError);
  assert.deepEqual(task.projection, projectionError);
  assert.equal(task.idempotency_key, "create:stable-key");
  assert.equal(task.request_id, "request-1");
});

test("an uncertain explicit mutation retry reuses its account-scoped idempotency identity", async () => {
  const storage = sessionStorage();
  storage.setItem("task-sync-auth-session-v1", JSON.stringify({
    access_token: "access",
    refresh_token: "refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "account-a" },
  }));
  const keys = [];
  let attempt = 0;
  const client = new TaskCloudClient(config, {
    storage,
    fetch: async (_url, init) => {
      keys.push(init.headers["Idempotency-Key"]);
      attempt += 1;
      if (attempt === 1) throw new DOMException("Timed out", "TimeoutError");
      return response({ task: { id: "task-1", title: "更新后" } });
    },
  });

  await assert.rejects(() => client.updateTask("task-1", { title: "更新后" }), (error) => error.code === "API_TIMEOUT");
  assert.equal(client.readPendingTaskMutations().length, 1);
  assert.equal("body" in client.readPendingTaskMutations()[0], false);
  assert.equal(JSON.stringify(client.readPendingTaskMutations()).includes("更新后"), false);

  const task = await client.updateTask("task-1", { title: "更新后" });

  assert.equal(task.id, "task-1");
  assert.equal(keys[0], keys[1]);
  assert.equal(client.readPendingTaskMutations().length, 0);
});

test("pending mutation identities are isolated by account and never replayed on account change", async () => {
  const storage = sessionStorage();
  storage.setItem("task-sync-auth-session-v1", JSON.stringify({
    access_token: "access-a",
    refresh_token: "refresh-a",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "account-a" },
  }));
  const keys = [];
  const client = new TaskCloudClient(config, {
    storage,
    fetch: async (_url, init) => {
      keys.push(init.headers["Idempotency-Key"]);
      throw new DOMException("Timed out", "TimeoutError");
    },
  });

  await assert.rejects(() => client.completeTask("task-1"));
  storage.setItem("task-sync-auth-session-v1", JSON.stringify({
    access_token: "access-b",
    refresh_token: "refresh-b",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "account-b" },
  }));
  assert.equal(client.readPendingTaskMutations().length, 0);
  await assert.rejects(() => client.completeTask("task-1"));

  assert.notEqual(keys[0], keys[1]);
  assert.equal(client.readPendingTaskMutations("account-a").length, 1);
  assert.equal(client.readPendingTaskMutations("account-b").length, 1);
});

test("failed checkbox write throws and does not mutate caller task", async () => {
  const task = { id: "google-id", status: "open", done: false };
  const client = new TaskCloudClient(config, { storage: sessionStorage(), fetch: async () => response({ error: "Google unavailable" }, 503) });
  await assert.rejects(() => client.completeTask(task.id), (error) => {
    assert.ok(error instanceof CloudError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.deepEqual(task, { id: "google-id", status: "open", done: false });
});

test("browser request timeout becomes a clear API timeout error", async () => {
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    fetch: async () => { throw new DOMException("Timed out", "TimeoutError"); },
  });
  await assert.rejects(() => client.listOpenTasks(), (error) => {
    assert.ok(error instanceof CloudError);
    assert.equal(error.code, "API_TIMEOUT");
    assert.match(error.message, /请求超时/);
    return true;
  });
});

test("delete is destructive in Google Tasks and is not a local cancelled status", async () => {
  let captured;
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    fetch: async (_url, init) => { captured = { method: init.method, body: JSON.parse(init.body) }; return response({ deleted: true }); },
  });
  await client.deleteTask("google-id");
  assert.deepEqual(captured, { method: "DELETE", body: { id: "google-id" } });
});

test("local sign out clears the session even when cloud logout fails", async () => {
  const storage = sessionStorage();
  const client = new TaskCloudClient(config, { storage, transientStorage: new MemoryStorage(), fetch: async () => { throw new Error("offline"); } });
  await client.signOut();
  assert.equal(client.session(), null);
});

test("schedule and reschedule use the dedicated projection service", async () => {
  const calls = [];
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return response({ success: true }); },
  });
  await client.scheduleTask("task-1", { scheduled_date: "2026-09-05", scheduled_start: "15:00" });
  await client.rescheduleTask("task-1", { scheduled_date: "2026-09-05", scheduled_start: "16:00" });
  await client.updateTaskReminder("task-1", { reminder_at: "12:00", reminder_type: "preparation" });
  await client.unscheduleTask("task-1", { scheduled_date: "2026-09-05" });
  assert.match(calls[0].url, /\/functions\/v1\/task-scheduler$/);
  assert.equal(calls[0].body.action, "schedule");
  assert.equal(calls[1].body.schedule.scheduling_status, "rescheduled");
  assert.equal(calls[2].body.action, "update_reminder");
  assert.equal(calls[2].body.task_id, "task-1");
  assert.equal(calls[2].body.reminder.reminder_at, "12:00");
  assert.equal(calls[3].body.action, "unschedule");
});

test("goals, projects, and Google Task context use Supabase without copying task status", async () => {
  const calls = [];
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method, body });
      if (url.includes("/goals_plans") && init.method === "POST") {
        return response([{ id: "goal-1", ...body, amount_remaining: "20000.00" }], 201);
      }
      if (url.includes("/projects") && init.method === "POST") return response([{ id: "project-1", ...body }], 201);
      if (url.includes("/task_context_links") && init.method === "POST") return response([{ id: "link-1", ...body }], 201);
      return response([]);
    },
  });
  const goal = await client.createGoal({
    title: "小斌欠款",
    type: "FinancialItem",
    amount_total: 30000,
    amount_completed: 10000,
    original_input: "小斌还欠我 3 万元",
  });
  await client.createProject({ goal_plan_id: "goal-1", title: "分期回款" });
  await client.linkTaskContext("google-task-1", "goal-1", "project-1");
  assert.equal(goal.amount_remaining, 20000);
  assert.equal(calls[0].body.original_input, "小斌还欠我 3 万元");
  assert.equal("status" in calls[2].body, false);
  assert.match(calls[2].url, /on_conflict=owner_id%2Cgoogle_task_id/);
});

test("planning cache supports offline read-only recovery", () => {
  const storage = new MemoryStorage();
  const client = new TaskCloudClient(config, { storage, fetch: async () => response({}) });
  client.cachePlanning("user-1", { goals: [{ id: "g1" }], projects: [], links: [] });
  const cached = client.readCachedPlanning("user-1");
  assert.equal(cached.goals[0].id, "g1");
  assert.ok(cached.savedAt);
});

test("task conversation retains exact proposal and retry identity through authentication retry", async () => {
  const sent = [];
  let unauthorized = true;
  const client = new TaskCloudClient(config, {
    storage: sessionStorage(),
    fetch: async (url, init) => {
      if (url.includes('/auth/v1/token')) return response({ access_token: 'renewed', refresh_token: 'refresh', expires_in: 3600 });
      sent.push(JSON.parse(init.body));
      if (unauthorized) { unauthorized = false; return response({ error: 'expired', code: 'AUTH_REQUIRED' }, 401); }
      return response({ success: true, message: '已核实', pending: null });
    },
  });
  const input = { task_id: 'original-task', text: '对', source: 'voice', proposal_id: 'shown-proposal', request_id: 'stable-request-123' };
  const result = await client.sendTaskConversation(input);
  assert.equal(result.success, true);
  assert.deepEqual(sent, [input, input]);
});

test("conversation history requests are scoped to the encoded current task", async () => {
  let requested;
  const client = new TaskCloudClient(config, { storage: sessionStorage(), fetch: async (url) => { requested = new URL(url); return response({ pending: null, history: [] }); } });
  await client.getTaskConversation('task/a?owner=other');
  assert.equal(requested.searchParams.get('task_id'), 'task/a?owner=other');
  assert.equal(requested.searchParams.has('owner'), false);
});

for (const change of ['logout','switch']) test(`in-flight refresh never overwrites ${change}`, async()=>{
 let resolve;
 const client=new TaskCloudClient(config,{storage:sessionStorage(),fetch:()=>new Promise(r=>{resolve=r;})});
 const pending=client.refreshSession();
 const next=change==='logout'?null:{access_token:'account-b',refresh_token:'refresh-b',user:{id:'b'},expires_at:9999999999};
 client.saveSession(next);
 resolve(response({access_token:'stale-a',refresh_token:'rotated-a',user:{id:'a'}}));
 await assert.rejects(pending,{code:'SESSION_CHANGED'});
 assert.deepEqual(client.session(),next);
});

test("an old account authorization failure never retries a mutation under a new login", async () => {
  const storage = sessionStorage();
  const sent = [];
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const pendingResponse = new Promise((resolve) => { release = resolve; });
  const client = new TaskCloudClient(config, { storage, fetch: async (_url, init) => {
    sent.push(init.headers.Authorization);
    started();
    return await pendingResponse;
  } });
  client.saveSession({ access_token: "access-a", refresh_token: "refresh-a", expires_at: 9999999999, user: { id: "account-a" } });
  const mutation = client.authenticatedRequest("/functions/v1/google-tasks", { method: "PATCH", body: JSON.stringify({ action: "update", task_id: "task-a" }) });
  await requestStarted;
  client.saveSession({ access_token: "access-b", refresh_token: "refresh-b", expires_at: 9999999999, user: { id: "account-b" } });
  release(response({ error: "expired", code: "AUTH_REQUIRED" }, 401));
  await assert.rejects(mutation, (error) => error.code === "SESSION_CHANGED");
  assert.deepEqual(sent, ["Bearer access-a"]);
  assert.equal(client.session().user.id, "account-b");
});

test("delayed user lookup cannot attach an old user to a new session", async () => {
  const storage = sessionStorage();
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const pendingResponse = new Promise((resolve) => { release = resolve; });
  const client = new TaskCloudClient(config, { storage, fetch: async () => { started(); return pendingResponse; } });
  client.saveSession({ access_token: "access-a", refresh_token: "refresh-a", expires_at: 9999999999, user: { id: "account-a" } });
  const lookup = client.getUser();
  await requestStarted;
  client.saveSession({ access_token: "access-b", refresh_token: "refresh-b", expires_at: 9999999999, user: { id: "account-b" } });
  release(response({ id: "account-a" }));
  await assert.rejects(lookup, (error) => error.code === "SESSION_CHANGED");
  assert.equal(client.session().user.id, "account-b");
});

test('reminder request listing follows all pages and retains old pending requests',async()=>{
 const calls=[];
 const client=new TaskCloudClient(config,{storage:sessionStorage(),fetch:async(url)=>{calls.push(url);return response(url.includes('offset=100')?{requests:[{request_id:'old',stage:'projection_pending'}],has_more:false}:{requests:Array.from({length:100},(_,i)=>({request_id:String(i),stage:'reminder_verified'})),has_more:true,next_offset:100});}});
 const result=await client.listReminderRequests();assert.equal(result.requests.length,101);assert.equal(result.requests.at(-1).request_id,'old');assert.equal(calls.length,2);
});
