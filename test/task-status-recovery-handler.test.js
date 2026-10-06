import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleTaskPayload } from "../supabase/functions/_shared/google-tasks-core.js";

let importNumber = 0;
const ownerId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function loadHandler() {
  const priorDeno = globalThis.Deno;
  const priorFetch = globalThis.fetch;
  const schedulerCalls = [];
  const token = `unit-${"w".repeat(32)}`;
  const schedule = { scheduled_date: "2099-01-01", scheduled_start: "15:00", scheduled_end: "15:30",
    timezone: "Asia/Shanghai", reminder_policy: "custom", reminder_at: "2099-01-01T15:00", reminders: [{ type: "start", offset_minutes: 0 }] };
  const rawTask = { id: "task-one", status: "needsAction", due: "2099-01-01T00:00:00.000Z",
    ...createGoogleTaskPayload({ title: "交材料", notes: "交材料", originalIntent: "交材料",
      dueDate: "2099-01-01", requestCorrelationId: requestId }) };
  let handler;
  globalThis.Deno = {
    env: { get: (name) => ({ SUPABASE_URL: "https://personal-os.test", SUPABASE_SERVICE_ROLE_KEY: `unit-${"s".repeat(32)}`,
      OWNER_USER_ID: ownerId, AUTOMATION_READ_TOKEN: token, AUTOMATION_WRITE_TOKEN: token,
      GOOGLE_OAUTH_CLIENT_ID: "test-client", GOOGLE_OAUTH_CLIENT_SECRET: "test-secret",
      GOOGLE_TOKEN_ENCRYPTION_KEY: `unit-${"e".repeat(32)}` })[name] },
    serve: (next) => { handler = next; },
  };
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/rest/v1/rpc/claim_google_auth_refresh")) {
      return json([{ outcome: "cached", access_token: "test-access", tasklist_id: "list-one", google_subject: "subject-one" }]);
    }
    if (parsed.pathname.endsWith("/rest/v1/task_resolution_audit")) return json([{ intake_audit_id: requestId, result_task_ids: [rawTask.id] }]);
    if (parsed.pathname.endsWith("/rest/v1/task_schedule_metadata")) return json([]);
    if (parsed.hostname === "tasks.googleapis.com" && parsed.pathname.endsWith("/tasks")) return json({ items: [rawTask] });
    if (parsed.hostname === "tasks.googleapis.com" && parsed.pathname.endsWith(`/tasks/${rawTask.id}`)) return json(rawTask);
    if (parsed.pathname.endsWith("/functions/v1/task-scheduler")) {
      const body = JSON.parse(init.body);
      schedulerCalls.push(body);
      if (body.action === "create_series") return json({ success: true, series: { status: "active", root_task_id: rawTask.id } });
      if (body.action === "schedule") return json({ success: true, schedule,
        projection: { projected: true, verified_at: "2099-01-01T00:00:00Z", notification_status: "projected", reminders: [{ type: "start" }] } });
      throw new Error(`Unexpected scheduler action: ${body.action}`);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    await import(new URL(`../supabase/functions/task-status/index.ts?recovery=${importNumber += 1}`, import.meta.url));
    return { schedulerCalls, task: rawTask, schedule,
      request: (body) => handler(new Request("https://personal-os.test/task-status", { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })),
      restore: () => { globalThis.Deno = priorDeno; globalThis.fetch = priorFetch; } };
  } catch (error) {
    globalThis.Deno = priorDeno;
    globalThis.fetch = priorFetch;
    throw error;
  }
}

test("actual task-status handler reconciles exact request marker and restores only its projection and series", { concurrency: false }, async () => {
  const harness = await loadHandler();
  try {
    const expectedTask = { title: "交材料", notes: "交材料", dueDate: "2099-01-01" };
    const reconciled = await (await harness.request({ action: "reconcile_intake", intake_audit_id: requestId, expected_task: expectedTask })).json();
    assert.equal(reconciled.outcome, "verified");
    assert.equal(reconciled.task.id, "task-one");
    assert.equal(reconciled.account_subject, "subject-one");
    const restored = await (await harness.request({ action: "retry_projection", task_id: "task-one",
      intake_audit_id: requestId, expected_task: expectedTask, schedule: harness.schedule,
      recurrence: { kind: "weekly", weekday: 4 } })).json();
    assert.equal(restored.success, true);
    assert.equal(restored.series.status, "active");
    assert.deepEqual(harness.schedulerCalls.map((call) => call.action), ["schedule", "create_series"]);
    assert.equal(harness.schedulerCalls[0].only_if_absent, true);
  } finally { harness.restore(); }
});
