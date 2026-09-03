import test from "node:test";
import assert from "node:assert/strict";
import { CloudError, GOOGLE_TASKS_SCOPE, TaskCloudClient } from "../src/cloud-client.js";

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
  assert.equal(parsed.searchParams.get("scopes"), GOOGLE_TASKS_SCOPE);
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
      calls.push({ url, method: init.method, body });
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
