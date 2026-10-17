// Actual task-status handler, resolver, executor and Google request adapter.
// Only OAuth RPC, Google HTTP and metadata storage are synthetic; no network.
import assert from "node:assert/strict";
import { createGoogleTaskPayload } from "../../supabase/functions/_shared/google-tasks-core.js";

let imports = 0;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
export async function loadTaskStatusProviderSimulation({ tasks = [], goals = [], account = "account-one", loseCreateResponseOnce = false } = {}) {
  const priorDeno = globalThis.Deno;
  const token = `unit-${"x".repeat(32)}`;
  const writes = [], audits = [], allCalls = [];
  const stored = new Map(tasks.map(task => [task.id, { id: task.id, status: "needsAction",
    ...createGoogleTaskPayload(task), ...(task.dueDate ? { due: `${task.dueDate}T00:00:00.000Z` } : {}) }]));
  let handler;
  globalThis.Deno = { env: { get: name => ({ SUPABASE_URL: "https://personal-os.test",
    SUPABASE_SERVICE_ROLE_KEY: `unit-${"s".repeat(32)}`, OWNER_USER_ID: "11111111-1111-4111-8111-111111111111",
    AUTOMATION_WRITE_TOKEN: token, AUTOMATION_READ_TOKEN: token, GOOGLE_OAUTH_CLIENT_ID: "fixture-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "fixture-secret", GOOGLE_TOKEN_ENCRYPTION_KEY: `unit-${"e".repeat(32)}` })[name] },
    serve: next => { handler = next; } };
  try { await import(new URL(`../../supabase/functions/task-status/index.ts?proposal-provider=${++imports}`, import.meta.url)); }
  finally { globalThis.Deno = priorDeno; }
  assert.equal(typeof handler, "function");
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(String(url)), method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    allCalls.push({ path: parsed.pathname, method, body });
    if (parsed.pathname.endsWith("/rpc/claim_google_auth_refresh")) return json([{ outcome: "cached", access_token: "fixture-access", tasklist_id: "fixture-list", google_subject: account }]);
    if (parsed.hostname === "tasks.googleapis.com") {
      const id = parsed.pathname.match(/\/tasks\/([^/]+)$/)?.[1];
      if (method === "POST") {
        const task = { id: `new-${writes.length + 1}`, status: "needsAction", ...body };
        stored.set(task.id, task); writes.push({ method, id: task.id, body, parent: parsed.searchParams.get("parent") });
        if (loseCreateResponseOnce && writes.length === 1) throw new DOMException("synthetic response lost after Google accepted POST", "TimeoutError");
        return json(task, 201);
      }
      if (method === "PATCH") {
        assert.ok(stored.has(id)); const task = { ...stored.get(id), ...body }; stored.set(id, task); writes.push({ method, id, body }); return json(task);
      }
      if (id) return stored.has(id) ? json(stored.get(id)) : json({ error: { message: "not found" } }, 404);
      return json({ items: [...stored.values()] });
    }
    if (parsed.pathname.endsWith("/functions/v1/task-scheduler")) return json({ success: true, schedule: body.schedule,
      projection: { projected: true, verified_at: new Date().toISOString(), notification_status: "disabled" } });
    const table = parsed.pathname.split("/").pop();
    if (table === "goals_plans") return json(goals);
    if (table === "task_resolution_audit") {
      if (method === "POST") { const row = { id: crypto.randomUUID(), ...body }; audits.push(row); return json([row]); }
      if (method === "PATCH") { const row = audits.find(x => `eq.${x.id}` === parsed.searchParams.get("id")); Object.assign(row, body); return json([row]); }
      return json(audits.filter(x => !parsed.searchParams.get("idempotency_key") || `eq.${x.idempotency_key}` === parsed.searchParams.get("idempotency_key")));
    }
    if (["search_task_resolution_profiles", "task_resolution_profiles", "task_schedule_metadata", "task_relationships", "task_resource_bindings", "task_context_links", "personal_os_intake_audit"].includes(table)) return json(method === "POST" ? [body] : []);
    throw new Error(`Unexpected synthetic provider request: ${parsed.pathname}`);
  };
  return { fetcher, writes, audits, allCalls,
    request: body => handler(new Request("https://personal-os.test/functions/v1/task-status", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })),
  };
}
