import {
  goalPlanDispatchPayload,
  normalizeIntake,
  taskDispatchPayload,
} from "../_shared/personal-os-intake.js";
import { findExistingGoalMatch, mergeGoalPlanUpdate } from "../_shared/goal-operations.js";
import { resolveServiceApiKey, serviceApiHeaders } from "../_shared/supabase-api-keys.js";
import { prepareAutonomousIntake, verifyTaskWrite, intakeConfirmation } from "../_shared/autonomy-runtime.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const USE_NEW_API_KEYS = Deno.env.get("SUPABASE_USE_NEW_API_KEYS") === "true";
const SERVICE_API_KEY = resolveServiceApiKey({
  secretKeys: Deno.env.get("SUPABASE_SECRET_KEYS"),
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  preferNew: USE_NEW_API_KEYS,
});
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";
const WRITE_TOKEN = Deno.env.get("AUTOMATION_WRITE_TOKEN") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-automation-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class IntakeError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "INVALID_INTAKE") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return mismatch === 0;
}

async function responsePayload(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableRequest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableRequest).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableRequest(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...serviceApiHeaders(SERVICE_API_KEY),
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(10_000),
  });
  const body = await responsePayload(response);
  if (!response.ok) throw new IntakeError(body?.message || "Audit store unavailable", 503, "AUDIT_STORE_ERROR");
  return body;
}

async function reserveAudit(intake: Record<string, unknown>, idempotencyKey: string, requestHash: string) {
  const inserted = await rest("personal_os_intake_audit?on_conflict=owner_id%2Cidempotency_key", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      owner_id: OWNER_USER_ID,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      source: intake.source,
      raw_text: intake.raw_text,
      classification: intake.type,
      destination: intake.destination,
      status: "processing",
    }),
  });
  if (inserted?.[0]) return { row: inserted[0], replayed: false };

  const query = new URLSearchParams({
    select: "id,idempotency_key,request_hash,status,response_status,response,updated_at",
    owner_id: `eq.${OWNER_USER_ID}`,
    idempotency_key: `eq.${idempotencyKey}`,
    limit: "1",
  });
  const rows = await rest(`personal_os_intake_audit?${query}`);
  const existing = rows?.[0];
  if (!existing) throw new IntakeError("Idempotency record unavailable", 503, "IDEMPOTENCY_UNAVAILABLE");
  if (existing.request_hash !== requestHash) {
    throw new IntakeError("Idempotency key was already used for a different request", 409, "IDEMPOTENCY_CONFLICT");
  }
  if (existing.status !== "processing" && existing.response) {
    return { row: existing, replayed: true };
  }
  const updatedAt = Date.parse(existing.updated_at || "");
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt < 120_000) {
    throw new IntakeError("An identical request is still processing", 409, "IDEMPOTENCY_IN_PROGRESS");
  }
  await updateAudit(existing.id, { status: "processing", error: null, response: null, response_status: null });
  return { row: existing, replayed: false };
}

async function updateAudit(id: string, changes: Record<string, unknown>) {
  const query = new URLSearchParams({ id: `eq.${id}`, owner_id: `eq.${OWNER_USER_ID}` });
  await rest(`personal_os_intake_audit?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(changes),
  });
}

async function taskService(input: Record<string, unknown>) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/task-status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WRITE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await responsePayload(response);
  if (!response.ok) throw new IntakeError(result?.error || "Task service unavailable", response.status, result?.code || "TASK_SERVICE_ERROR");
  return result;
}

async function resolveAutonomyContext(input: Record<string, unknown>) {
  const supplied = (input.context || {}) as Record<string, any>;
  const travel = /旅行|旅游|入住|酒店|亚朵|出差/.test(String(input.raw_text || ""));
  const currentId = input.existing_task_id || supplied.current_task?.id;
  const context = await taskService({ action: "autonomy_context", task_id: currentId || null, travel });
  let travelPlans: Record<string, unknown>[] = [];
  if (travel) {
    try {
      const query = new URLSearchParams({ owner_id: `eq.${OWNER_USER_ID}`, category: "eq.Travel", status: "not.in.(Completed,Dropped,Archived)", select: "id,title,start_date,target_date,deadline", order: "updated_at.desc", limit: "100" });
      travelPlans = (await rest(`goals_plans?${query}`)).map((goal: Record<string, unknown>) => ({ ...goal, start_date: goal.start_date || goal.target_date, end_date: goal.deadline || goal.target_date }));
    } catch { context.context_warnings.push("Travel Plans context unavailable"); }
  }
  return { ...supplied, ...context, conversation_trips: supplied.conversation_trips || [], travel_plans: travelPlans };
}

async function dispatchTask(intake: Record<string, unknown>, auditId: string, idempotencyKey: string) {
  const result = await taskService(intake.existing_task_id ? {
    action: "update_task", task_id: intake.existing_task_id, changes: intake.update_patch || {},
  } : { ...taskDispatchPayload(intake), intake_audit_id: auditId, resolution_idempotency_key: idempotencyKey });
  let verified;
  try { verified = await verifyTaskWrite(result, (id: string) => taskService({ action: "read_task", task_id: id })); }
  catch {
    return { success: false, write_success: result.write_success === true, verified: false, id: result?.task?.id || null, task_snapshot: result?.task || null, expected_schedule: result.expected_schedule || {}, destination: "google_tasks", code: "WRITE_UNVERIFIED", error: "Google Tasks 写入结果尚未核实，请回读原任务，勿重复创建。" };
  }
  const linkedGoalId = result.goal_link?.goal_id || intake.goal_plan_id || null;
  const linkedProjectId = result.context_link?.project_id || intake.project_id || null;
  return {
    success: verified.write_success || result.deduplicated === true,
    write_success: verified.write_success,
    verified: true,
    destination: "google_tasks",
    id: result.task.id,
    title: result.task.title,
    due: result.task.dueDate || null,
    deduplicated: result.deduplicated === true,
    operation: result.resolution?.decision === "UPDATE" || result.resolution?.decision === "MERGE"
      ? "updated"
      : result.deduplicated ? "reused" : "created",
    resolution: result.resolution || null,
    relationships: result.relationships || [],
    schedule: result.schedule || null,
    projection_error: result.projection_error || null,
    goal_plan_id: linkedGoalId,
    goal_linked: Boolean(linkedGoalId),
    project_id: linkedProjectId,
    context_linked: Boolean(linkedGoalId || linkedProjectId),
  };
}

async function dispatchGoalPlan(intake: Record<string, unknown>) {
  const payload = goalPlanDispatchPayload(intake);
  const query = new URLSearchParams({
    owner_id: `eq.${OWNER_USER_ID}`,
    select: "*",
    order: "updated_at.desc",
    limit: "100",
  });
  if (intake.existing_goal_id) query.set("id", `eq.${intake.existing_goal_id}`);
  else query.set("status", "not.in.(Completed,Dropped,Archived)");
  const candidates = await rest(`goals_plans?${query}`);

  let match = null;
  if (intake.existing_goal_id) {
    if (!candidates?.[0]) throw new IntakeError("Existing Goal was not found", 404, "GOAL_NOT_FOUND");
    match = { goal: candidates[0], score: 1 };
  } else {
    match = findExistingGoalMatch({ ...payload, raw_text: intake.raw_text }, candidates || []);
  }

  const rows = match
    ? await rest(`goals_plans?id=eq.${encodeURIComponent(match.goal.id)}&owner_id=eq.${OWNER_USER_ID}&select=*`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(mergeGoalPlanUpdate(match.goal, payload, intake.explicit_fields || {})),
    })
    : await rest("goals_plans?select=*", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ owner_id: OWNER_USER_ID, ...payload }),
    });
  const item = rows?.[0];
  if (!item?.id) throw new IntakeError("Goals & Plans write failed", 503, "GOAL_WRITE_FAILED");
  const readback = await rest(`goals_plans?id=eq.${encodeURIComponent(item.id)}&owner_id=eq.${OWNER_USER_ID}&select=id,title,description`);
  if (readback?.[0]?.id !== item.id || readback[0].title !== item.title || readback[0].description !== item.description) {
    throw new IntakeError("Goals & Plans readback failed", 503, "GOAL_READBACK_FAILED");
  }
  return {
    success: true,
    write_success: true,
    verified: true,
    destination: "goals_plans",
    classification: intake.type,
    id: item.id,
    title: item.title,
    goal_type: item.type,
    status: item.status,
    horizon: item.horizon,
    operation: match ? "updated" : "created",
    matched_existing: Boolean(match),
    match_score: match?.score ?? null,
    target_date: item.target_date || null,
    target_month: item.target_month || null,
    target_year: item.target_year || null,
    amount_remaining: item.amount_remaining ?? null,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_API_KEY || !/^[0-9a-f-]{36}$/i.test(OWNER_USER_ID) || WRITE_TOKEN.length < 32) {
    return json({ success: false, error: "Server configuration incomplete" }, 503);
  }
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    || request.headers.get("x-automation-token") || "";
  if (!constantTimeEqual(token, WRITE_TOKEN)) return json({ success: false, error: "Unauthorized" }, 401);

  let auditId = "";
  try {
    const input = await request.json();
    const idempotencyKey = String(request.headers.get("idempotency-key") || input.idempotency_key || "").trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new IntakeError("idempotency_key must contain 8-200 characters", 400, "INVALID_IDEMPOTENCY_KEY");
    }
    const policy = await prepareAutonomousIntake(input, { resolveContext: resolveAutonomyContext });
    if (policy.decision !== "execute") {
      const result = { success: false, write_success: false, verified: false, intent: policy.intent, decision: policy.decision, risk_level: policy.risk_level, question: policy.question, code: policy.decision === "ask" ? "CLARIFICATION_REQUIRED" : "INFORMATION_ONLY" };
      return json({ ...result, message: intakeConfirmation(result) });
    }
    const intake = { ...normalizeIntake(policy.input), existing_task_id: policy.input.existing_task_id, update_patch: policy.input.update_patch };
    const requestHash = await sha256(stableRequest(input));
    const reservation = await reserveAudit(intake, idempotencyKey, requestHash);
    auditId = reservation.row.id;
    if (reservation.replayed) {
      const saved = { ...reservation.row.response, replayed: true };
      if (saved.code === "WRITE_UNVERIFIED" && saved.task_snapshot?.id) {
        try {
          const checked = await verifyTaskWrite({ task: saved.task_snapshot, write_success: saved.write_success, expected_schedule: saved.expected_schedule }, (id: string) => taskService({ action: "read_task", task_id: id }));
          Object.assign(saved, { success: true, verified: checked.verified, code: null, error: null });
          if (policy.intent === "mixed" && policy.preference_text) saved.partial = true;
        } catch { return json(saved); }
      }
      if (saved.partial && policy.intent === "mixed" && policy.preference_text && saved.verified) {
        try {
          saved.preference = await dispatchGoalPlan(normalizeIntake({ raw_text: policy.preference_text, type: "plan", title: policy.preference_text, horizon: "long" }));
          saved.partial = false;
          saved.success = true;
        } catch { return json(saved); }
      }
      saved.message = intakeConfirmation(saved);
      await updateAudit(auditId, { status: saved.success ? "succeeded" : "failed", response: saved, response_status: 200 });
      return json(saved, reservation.row.response_status || 200);
    }

    const isGoalPlan = ["goal", "plan", "long_term_item", "financial_item"].includes(intake.type);
    if (intake.type !== "task" && !isGoalPlan) {
      const unsupported = {
        success: false,
        destination: intake.destination,
        classification: intake.type,
        code: "ADAPTER_NOT_CONFIGURED",
        error: `${intake.destination} adapter is not configured in this P0`,
        idempotency_key: idempotencyKey,
      };
      await updateAudit(auditId, { status: "failed", error: unsupported.error, response_status: 501, response: unsupported });
      return json(unsupported, 501);
    }

    const dispatched = intake.type === "task"
      ? await dispatchTask(intake, auditId, idempotencyKey)
      : await dispatchGoalPlan(intake);
    let preference = null;
    let partial = false;
    if (policy.intent === "mixed" && policy.preference_text && dispatched.success) {
      try {
        preference = await dispatchGoalPlan(normalizeIntake({ raw_text: policy.preference_text, type: "plan", title: policy.preference_text, horizon: "long" }));
      } catch { partial = true; }
    }
    const result = { ...dispatched, success: dispatched.success && !partial, partial, preference, risk_level: policy.risk_level, idempotency_key: idempotencyKey, replayed: false, message: "" };
    result.message = intakeConfirmation(result);
    if ("projection_error" in dispatched && dispatched.projection_error) result.message += " Calendar 投影待同步。";
    try { await updateAudit(auditId, { status: result.success ? "succeeded" : "failed", object_id: result.id, response_status: 200, response: result }); }
    catch { Object.assign(result, { audit_warning: "Write result verified but audit finalization failed; retain object id for recovery" }); }
    console.info("Personal OS intake succeeded", { auditId, destination: result.destination, objectId: result.id });
    return json(result);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const intakeError = error instanceof IntakeError
      ? error
      : new IntakeError(timedOut ? "Personal OS intake timed out" : "Personal OS intake failed", 503, timedOut ? "INTAKE_TIMEOUT" : "INTAKE_FAILED");
    const failure = { success: false, write_success: false, verified: false, code: intakeError.code, error: intakeError.message,
      ...(intakeError.code === "TASK_TARGET_AMBIGUOUS" ? { decision: "ask", question: "有多个匹配任务，要修改哪一个？" } : {}), message: "" };
    failure.message = intakeConfirmation(failure);
    if (auditId) {
      try { await updateAudit(auditId, { status: "failed", error: intakeError.message, response_status: intakeError.status, response: failure }); }
      catch (auditError) { console.error("Personal OS audit update failed", auditError instanceof Error ? auditError.message : "unknown"); }
    }
    console.error("Personal OS intake failed", { auditId: auditId || null, code: intakeError.code });
    return json(failure, intakeError.status);
  }
});
