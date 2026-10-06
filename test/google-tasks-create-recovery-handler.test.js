import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleTaskPayload } from "../supabase/functions/_shared/google-tasks-core.js";

let importNumber = 0;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("duplicate Task with a changed saved Schedule does not create a recurrence series", { concurrency: false }, async () => {
  const oldDeno = globalThis.Deno;
  const oldFetch = globalThis.fetch;
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const requestId = "22222222-2222-4222-8222-222222222222";
  const token = `unit-${"w".repeat(32)}`;
  const task = { id: "task-existing", status: "needsAction", due: "2099-01-01T00:00:00.000Z",
    ...createGoogleTaskPayload({ title: "完成经营分析，包括收入、成本、人效和客户集中度", notes: "完成经营分析，包括收入、成本、人效和客户集中度", originalIntent: "完成经营分析，包括收入、成本、人效和客户集中度", dueDate: "2099-01-01" }) };
  const savedSchedule = { id: "schedule-existing", owner_id: ownerId, google_task_id: task.id,
    scheduled_date: "2099-01-01", scheduled_start: "10:00", scheduled_end: "10:30",
    timezone: "Asia/Shanghai", reminder_policy: "custom", reminder_at: "2099-01-01T10:00",
    notification_status: "projected" };
  const requestedSchedule = { ...savedSchedule, scheduled_start: "15:00", scheduled_end: "15:30",
    reminder_at: "2099-01-01T15:00" };
  const schedulerCalls = [];
  const paths = [];
  let audit;
  let handler;
  globalThis.Deno = { env: { get: (name) => ({
    SUPABASE_URL: "https://personal-os.test", SUPABASE_SERVICE_ROLE_KEY: `unit-${"s".repeat(32)}`,
    SUPABASE_ANON_KEY: `unit-${"p".repeat(32)}`, OWNER_USER_ID: ownerId,
    AUTOMATION_WRITE_TOKEN: token, GOOGLE_OAUTH_CLIENT_ID: "test-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-secret", GOOGLE_TOKEN_ENCRYPTION_KEY: `unit-${"e".repeat(32)}`,
  })[name] }, serve: (next) => { handler = next; } };
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    paths.push(`${init.method || "GET"} ${parsed.pathname}`);
    const body = init.body ? JSON.parse(init.body) : null;
    if (parsed.pathname === "/auth/v1/user") return json({ id: ownerId });
    if (parsed.pathname.endsWith("/rpc/claim_google_auth_refresh")) return json([
      { outcome: "cached", access_token: "test-access", tasklist_id: "list-one", google_subject: "subject-one" },
    ]);
    if (parsed.pathname.endsWith("/rpc/search_task_resolution_profiles")) return json([]);
    if (parsed.pathname.endsWith("/rest/v1/goals_plans")) return json([]);
    if (parsed.pathname.endsWith("/rest/v1/task_schedule_metadata")) return json([savedSchedule]);
    if (parsed.pathname.endsWith("/rest/v1/personal_os_intake_audit")) {
      if (init.method === "POST") { audit = { id: requestId, ...body }; return json([audit]); }
      if (init.method === "PATCH") { audit = { ...audit, ...body }; return json([audit]); }
      return json(audit ? [audit] : []);
    }
    if (parsed.pathname.endsWith("/rest/v1/task_resolution_audit")) {
      if (init.method === "POST") return json([{ id: "resolution-one", ...body }]);
      return json([]);
    }
    if (parsed.pathname.startsWith("/rest/v1/")) return json([]);
    if (parsed.hostname === "tasks.googleapis.com") {
      if (parsed.pathname.endsWith("/tasks")) return json({ items: [task] });
      if (parsed.pathname.endsWith(`/tasks/${task.id}`)) return json(task);
    }
    if (parsed.pathname.endsWith("/functions/v1/task-scheduler")) {
      schedulerCalls.push(body);
      return json({ success: true });
    }
    throw new Error(`Unexpected request ${parsed.pathname}`);
  };
  try {
    await import(new URL(`../supabase/functions/google-tasks/index.ts?recovery=${importNumber += 1}`, import.meta.url));
    const response = await handler(new Request("https://personal-os.test/google-tasks", {
      method: "POST", headers: { Authorization: "Bearer test-user", "Content-Type": "application/json",
        "Idempotency-Key": "test-request-123" },
      body: JSON.stringify({ action: "create", task: { title: "完成经营分析，包括收入、成本、人效和客户集中度", notes: "完成经营分析，包括收入、成本、人效和客户集中度", originalIntent: "完成经营分析，包括收入、成本、人效和客户集中度",
        dueDate: "2099-01-01", schedule: requestedSchedule, recurrence: { kind: "daily" } } }),
    }));
    const result = await response.json();
    assert.equal(result.resolution?.decision, "DUPLICATE", JSON.stringify({result,paths}));
    assert.equal(result.projection?.code, "SCHEDULE_SUPERSEDED");
    assert.equal(result.partial, true);
    assert.equal(response.status, 202);
    assert.deepEqual(schedulerCalls, []);
    assert.equal(audit.target_object_id, task.id);
  } finally {
    globalThis.Deno = oldDeno;
    globalThis.fetch = oldFetch;
  }
});
