import test from "node:test";
import assert from "node:assert/strict";
import { taskView, searchTaskViews } from "../supabase/functions/_shared/task-lifecycle-core.js";
import { taskScheduleSyncDecision } from "../supabase/functions/_shared/schedule-core.js";

const task = { id: "synthetic-date-task", title: "虚构事项", dueDate: "2099-01-09", status: "open", updatedAt: "2099-01-07T12:00:00Z" };
const schedule = { google_task_id: task.id, scheduled_date: "2099-01-08", fixed_time: false, scheduling_source: "explicit_user",
  scheduling_status: "unscheduled", sync_required: false, last_sync_error: null, last_synced_at: "2099-01-07T10:00:00Z", deadline: null, calendar_event_id: null };
for (const [dueDate, planned] of [["2099-01-09", "2099-01-08"], ["2099-01-08", "2099-01-09"], ["2099-01-08", "2099-01-05"]]) test(`read view flags unexplained synthetic dates ${dueDate}/${planned} without choosing a winner`, () => {
  const current = Object.freeze({ ...task, dueDate }), metadata = Object.freeze({ ...schedule, scheduled_date: planned });
  const before = JSON.stringify([current, metadata]), view = taskView(current, metadata);
  assert.equal(view.date_reconciliation?.required, true); assert.equal(view.date_reconciliation?.reason, "TASK_SCHEDULE_RECONCILIATION_REQUIRED");
  assert.equal(view.date_reconciliation?.task_date, dueDate); assert.equal(view.date_reconciliation?.scheduled_date, planned);
  assert.equal(view.date_reconciliation?.automatic_repair_allowed, false);
  assert.equal(view.due, dueDate); assert.equal(view.requested_date, planned); assert.equal(view.deadline, null);
  assert.equal(view.schedule.sync_required, false); assert.equal(view.schedule.last_synced_at, schedule.last_synced_at);
  assert.equal(JSON.stringify([current, metadata]), before);
});
for (const extra of [{ deadline: task.dueDate }, { scheduling_source: "morning_plan" }]) test(`known independent planning provenance is preserved: ${JSON.stringify(extra)}`, () => {
  const metadata = { ...schedule, ...extra }, decision = taskScheduleSyncDecision(task, metadata), view = taskView(task, metadata);
  assert.equal(decision.sync_required, false); assert.equal(view.date_reconciliation, undefined);
  assert.equal(view.due, task.dueDate); assert.equal(view.requested_date, schedule.scheduled_date);
});
test("newer Google updated time alone does not imply a date conflict or require any repair", () => {
  const view = taskView(task, { ...schedule, scheduled_date: task.dueDate });
  assert.equal(view.date_reconciliation, undefined); assert.equal(view.schedule.sync_required, false);
});
test("missing one date and a standalone explicit deadline are not relabeled as unexplained planned-date differences", () => {
  for (const [current, metadata] of [[{ ...task, dueDate: null }, schedule], [task, null], [task, { ...schedule, scheduled_date: null, deadline: "2099-01-10", deadline_time: "18:00" }]]) {
    assert.equal(taskView(current, metadata).date_reconciliation, undefined);
  }
});
test("search and get views expose the same read-only reconciliation signal", () => {
  const [result] = searchTaskViews([task], [schedule], { task_id: task.id, status: "open" });
  assert.deepEqual(result.date_reconciliation, taskView(task, schedule).date_reconciliation);
  assert.equal(result.date_reconciliation?.required, true);
});
test("actual GET handler returns the derived warning without Task, Calendar or metadata writes", async () => {
  const previous = { Deno: globalThis.Deno, fetch: globalThis.fetch }, calls = []; let handler;
  const owner = "11111111-1111-4111-8111-111111111111";
  const rawTask = { id: task.id, title: task.title, notes: "合成读取样例", status: "needsAction", due: `${task.dueDate}T00:00:00Z`, updated: task.updatedAt };
  const metadata = { ...schedule, owner_id: owner };
  globalThis.Deno = { env: { get: name => ({ SUPABASE_URL: "https://isolated.test", SUPABASE_SERVICE_ROLE_KEY: `unit-${"s".repeat(40)}`,
    SUPABASE_ANON_KEY: `unit-${"p".repeat(40)}`, GOOGLE_OAUTH_CLIENT_ID: "synthetic-client", GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-secret",
    GOOGLE_TOKEN_ENCRYPTION_KEY: `unit-${"e".repeat(40)}` })[name] }, serve: next => { handler = next; } };
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url)), method = init.method || "GET"; calls.push({ host: parsed.hostname, path: parsed.pathname, method });
    if (parsed.pathname === "/auth/v1/user") return Response.json({ id: owner });
    if (parsed.pathname.endsWith("/rpc/claim_google_auth_refresh")) return Response.json([{ outcome: "cached", access_token: "synthetic-access", tasklist_id: "synthetic-list", google_subject: "synthetic-account" }]);
    if (parsed.hostname === "tasks.googleapis.com" && parsed.pathname.endsWith(`/tasks/${task.id}`) && method === "GET") return Response.json(rawTask);
    if (parsed.pathname.endsWith("/task_schedule_metadata") && method === "GET") return Response.json([metadata]);
    throw new Error("Unexpected synthetic request");
  };
  try {
    await import(new URL("../supabase/functions/google-tasks/index.ts?synthetic-date-read-only", import.meta.url));
    const response = await handler(new Request(`https://isolated.test/google-tasks?action=get&task_id=${task.id}`, { headers: { Authorization: "Bearer synthetic-user" } }));
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.task.date_reconciliation.required, true); assert.equal(result.task.due, task.dueDate);
    assert.equal(result.task.requested_date, schedule.scheduled_date); assert.equal(result.task.schedule.sync_required, false);
    assert.equal(result.task.schedule.owner_id, undefined);
    assert.equal(calls.filter(x => x.method !== "GET" && !x.path.endsWith("/rpc/claim_google_auth_refresh")).length, 0);
    assert.equal(calls.some(x => x.path.includes("calendar") || x.path.includes("task-scheduler")), false);
  } finally { Object.assign(globalThis, previous); }
});
