import test from "node:test";
import assert from "node:assert/strict";
import { TaskCloudClient, CloudError } from "../src/cloud-client.js";
import { MIGRATION_FLAG_KEY } from "../src/core.js";

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

test("magic link sends redirect_to as an encoded query parameter", async () => {
  let captured;
  const client = new TaskCloudClient(config, {
    storage: new MemoryStorage(),
    fetch: async (url, init) => { captured = { url, body: JSON.parse(init.body) }; return response({}); },
  });
  await client.requestMagicLink("user@example.com", "https://example.com/today.html");
  assert.match(captured.url, /\/auth\/v1\/otp\?redirect_to=https%3A%2F%2Fexample\.com%2Ftoday\.html$/);
  assert.deepEqual(captured.body, { email: "user@example.com", create_user: true });
});

test("getTasks rolls over first and then reads canonical cloud rows", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("rollover_open_tasks")) return response(1);
    return response([{ id: "11111111-1111-4111-8111-111111111111", title: "云任务", date: "2026-09-03", time: null, category: "工作", priority: "medium", duration: 30, notes: "", status: "open", done: false, completed_at: null, source: "carryover", carried_from_date: "2026-09-02" }]);
  };
  const client = new TaskCloudClient(config, { storage: sessionStorage(), fetch });
  const tasks = await client.getTasks("2026-09-03");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /rpc\/rollover_open_tasks/);
  assert.equal(JSON.parse(calls[0].init.body).target_date, "2026-09-03");
  assert.match(calls[1].url, /status=neq.cancelled/);
  assert.equal(tasks[0].carriedFromDate, "2026-09-02");
});

test("failed checkbox write throws and does not mutate caller task", async () => {
  const task = { id: "11111111-1111-4111-8111-111111111111", status: "open", done: false };
  const client = new TaskCloudClient(config, { storage: sessionStorage(), fetch: async () => response({ message: "database unavailable" }, 503) });
  await assert.rejects(() => client.updateTask(task.id, { status: "done", completed_at: "2026-09-03T01:00:00Z" }), (error) => {
    assert.ok(error instanceof CloudError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.deepEqual(task, { id: "11111111-1111-4111-8111-111111111111", status: "open", done: false });
});

test("migration flag is written only after successful idempotent upsert", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const storage = sessionStorage({
    "richeng-tasks-v1": JSON.stringify([{ id, title: "需要迁移", date: "2026-09-03", done: false }]),
  });
  let shouldFail = true;
  const fetch = async (_url, init) => {
    if (shouldFail) return response({ message: "temporary" }, 503);
    const body = JSON.parse(init.body);
    return response(body.map((task) => ({ ...task, done: false, created_at: "2026-09-03T00:00:00Z", updated_at: "2026-09-03T00:00:00Z" })));
  };
  const client = new TaskCloudClient(config, { storage, fetch });
  await assert.rejects(() => client.migrateLegacyTasks());
  assert.equal(storage.getItem(MIGRATION_FLAG_KEY), null);
  shouldFail = false;
  const result = await client.migrateLegacyTasks();
  assert.equal(result.imported, 1);
  assert.ok(JSON.parse(storage.getItem(MIGRATION_FLAG_KEY)).completedAt);
  assert.equal(client.legacyMigrationPlan().completed, true);
});

test("cancel uses status instead of destructive deletion", async () => {
  let captured;
  const fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return response([{ id: "11111111-1111-4111-8111-111111111111", title: "A", date: "2026-09-03", category: "工作", priority: "medium", duration: 30, notes: "", status: "cancelled", done: false, completed_at: null, source: "manual", carried_from_date: null }]);
  };
  const client = new TaskCloudClient(config, { storage: sessionStorage(), fetch });
  await client.cancelTask("11111111-1111-4111-8111-111111111111");
  assert.deepEqual(captured, { status: "cancelled", completed_at: null });
});

test("local sign out clears the session even when cloud logout fails", async () => {
  const storage = sessionStorage();
  const client = new TaskCloudClient(config, { storage, fetch: async () => { throw new Error("offline"); } });
  await client.signOut();
  assert.equal(client.session(), null);
});
