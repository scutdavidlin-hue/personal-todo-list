import {
  goalPlanDispatchPayload,
  normalizeIntake,
  taskDispatchPayload,
} from "../_shared/personal-os-intake.js";
import { findExistingGoalMatch, mergeGoalPlanUpdate } from "../_shared/goal-operations.js";
import { resolveServiceApiKey, serviceApiHeaders } from "../_shared/supabase-api-keys.js";
import { prepareAutonomousIntake, verifyTaskWrite, intakeConfirmation } from "../_shared/autonomy-runtime.js";
import { evaluateAutonomy } from "../_shared/autonomy-policy.js";
import { frozenIntake, intakeBlocker, isMissed, publicRecovery, recoveryDecision, retryAt, safeError } from "../_shared/request-recovery.js";
import { verifyTaskFields } from "../_shared/write-receipt.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const USE_NEW_API_KEYS = Deno.env.get("SUPABASE_USE_NEW_API_KEYS") === "true";
const SERVICE_API_KEY = resolveServiceApiKey({
  secretKeys: Deno.env.get("SUPABASE_SECRET_KEYS"),
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  preferNew: USE_NEW_API_KEYS,
});
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";
const WRITE_TOKEN = Deno.env.get("AUTOMATION_WRITE_TOKEN") ?? "";
const READ_TOKEN = Deno.env.get("AUTOMATION_READ_TOKEN") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-automation-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

class IntakeError extends Error {
  status: number;
  code: string;
  requestId?: string;
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

async function reserveAudit(intake: Record<string, unknown>, idempotencyKey: string, requestHash: string, receivedAt: string) {
  const leaseOwner = crypto.randomUUID();
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
      request_payload: intake,
      received_at: receivedAt,
      target_object_id: intake.existing_task_id || null,
      stage: "received",
      provider_attempted: false,
      lease_owner: leaseOwner,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  if (inserted?.[0]) return { row: inserted[0], replayed: false, leaseOwner };

  const query = new URLSearchParams({
    select: "*",
    owner_id: `eq.${OWNER_USER_ID}`,
    idempotency_key: `eq.${idempotencyKey}`,
    limit: "1",
  });
  const rows = await rest(`personal_os_intake_audit?${query}`);
  const existing = rows?.[0];
  if (!existing) throw new IntakeError("Idempotency record unavailable", 503, "IDEMPOTENCY_UNAVAILABLE");
  if (existing.request_hash !== requestHash) {
    const conflict = new IntakeError("Idempotency key was already used for a different request", 409, "IDEMPOTENCY_CONFLICT");
    conflict.requestId = existing.id;
    throw conflict;
  }
  return { row: existing, replayed: true, leaseOwner: null };
}

async function updateAudit(id: string, changes: Record<string, unknown>, leaseOwner?: string) {
  const query = new URLSearchParams({ id: `eq.${id}`, owner_id: `eq.${OWNER_USER_ID}`, select: "*" });
  if (leaseOwner) query.set("lease_owner", `eq.${leaseOwner}`);
  const rows = await rest(`personal_os_intake_audit?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(changes),
  });
  if (leaseOwner && !rows?.[0]) throw new IntakeError("Recovery lease was lost", 409, "LEASE_LOST");
  return rows?.[0] || null;
}

async function claimAudit(row: Record<string, any>) {
  const leaseOwner = crypto.randomUUID();
  const query = new URLSearchParams({
    id: `eq.${row.id}`, owner_id: `eq.${OWNER_USER_ID}`,
    recovery_version: `eq.${row.recovery_version}`,
    or: `(lease_expires_at.is.null,lease_expires_at.lt.${new Date().toISOString()})`, select: "*",
  });
  const rows = await rest(`personal_os_intake_audit?${query}`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ lease_owner: leaseOwner, lease_expires_at: new Date(Date.now() + 60_000).toISOString(), recovery_version: row.recovery_version + 1 }),
  });
  if (!rows?.[0]) throw new IntakeError("Request is being recovered", 409, "RECOVERY_IN_PROGRESS");
  return { row: rows[0], leaseOwner };
}

async function recordRecoveryFailure(row: Record<string, any>, leaseOwner: string, error: unknown) {
  const code = safeError(error);
  const query = new URLSearchParams({ id: `eq.${row.id}`, owner_id: `eq.${OWNER_USER_ID}`,
    lease_owner: `eq.${leaseOwner}`, select: "*", limit: "1" });
  let current = row;
  try { current = (await rest(`personal_os_intake_audit?${query}`))?.[0] || row; }
  catch { /* The fenced update below still determines whether our lease is valid. */ }
  const authRequired = ["AUTH_RECONNECT_REQUIRED", "GOOGLE_REAUTH_REQUIRED", "GOOGLE_AUTH_REQUIRED",
    "GOOGLE_NOT_CONNECTED", "ACCOUNT_MISMATCH", "ACCOUNT_UNVERIFIED", "GOOGLE_ACCOUNT_UNVERIFIED"].includes(code);
  const stoppedStage = code === "USER_CANCELLED" ? "cancelled" : ["ACTION_DENIED", "POLICY_DENIED", "PERMISSION_DENIED"].includes(code) ? "unsupported" : null;
  const stage = stoppedStage || (authRequired ? "auth_required"
    : ["task_verified", "projection_pending"].includes(current.stage) ? "projection_pending"
    : current.provider_attempted || ["write_pending", "outcome_unknown"].includes(current.stage)
      ? "outcome_unknown" : "received");
  const result = { success: false, request_id: row.id, object_id: current.object_id || null,
    code, stage, retryable: !authRequired && !stoppedStage,
    message: stoppedStage ? "恢复已取消或拒绝，原有对象仍可只读核实。" : authRequired ? "原请求已保存；请重连原 Google 账号后核实。"
      : "恢复暂未完成；系统将在稍后重试，且不会重复创建任务。" };
  await updateAudit(row.id, { stage, status: stoppedStage ? "failed" : "processing", error_code: code,
    retry_count: Number(current.retry_count || 0) + 1,
    next_retry_at: authRequired || stoppedStage ? null : retryAt(current.retry_count),
    response: result, response_status: 202, lease_owner: null, lease_expires_at: null }, leaseOwner);
  return result;
}

async function latestTargetVersion(targetId: string) {
  const query = new URLSearchParams({ owner_id: `eq.${OWNER_USER_ID}`, target_object_id: `eq.${targetId}`, select: "operation_version,stage", order: "operation_version.desc", limit: "1" });
  return (await rest(`personal_os_intake_audit?${query}`))?.[0] || null;
}

async function listRequests(url: URL) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const query = new URLSearchParams({ owner_id: `eq.${OWNER_USER_ID}`, select: "*", order: "received_at.desc,id.desc", limit: String(limit + 1), offset: String(offset) });
  const key = url.searchParams.get("idempotency_key");
  if (key !== null) {
    if (key.length < 8 || key.length > 200) throw new IntakeError("Invalid idempotency_key", 400, "INVALID_IDEMPOTENCY_KEY");
    query.set("idempotency_key", `eq.${key}`);
    query.set("offset", "0");
  }
  const stage = url.searchParams.get("stage");
  if (stage && key === null) query.set("stage", `eq.${stage}`);
  const rows = await rest(`personal_os_intake_audit?${query}`);
  const requests: Record<string, any>[] = rows.slice(0, limit).map(publicRecovery);
  if (key !== null) for (let i = 0; i < requests.length; i++) {
    const row = rows[i];
    if (row.classification !== "task" || ["cancelled", "superseded", "needs_input"].includes(row.stage)) continue;
    try {
      const checked = await reconcileTask(row);
      const mismatch = row.account_subject && checked.account_subject && row.account_subject !== checked.account_subject;
      requests[i].task_check = { outcome: mismatch ? "account_mismatch" : checked.outcome, task_id: mismatch ? null : checked.task?.id || null, checked_at: new Date().toISOString() };
    } catch { requests[i].task_check = { outcome: "unknown", task_id: null, checked_at: new Date().toISOString() }; }
  }
  return { requests, ...(key !== null ? { idempotency_key: key, lookup_status: requests.length ? "registered" : "not_registered_at_check", readonly: true } : {}), has_more: rows.length > limit,
    next_offset: rows.length > limit ? offset + limit : null, checked_at: new Date().toISOString() };
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
    receipt: result.receipt || null,
    projection_error: result.projection_error || null,
    account_subject: result.account_subject || null,
    goal_plan_id: linkedGoalId,
    goal_linked: Boolean(linkedGoalId),
    project_id: linkedProjectId,
    context_linked: Boolean(linkedGoalId || linkedProjectId),
  };
}

function projectionPending(intake: Record<string, any>, dispatched: Record<string, any>) {
  if (!dispatched.verified) return false;
  const reminderExpected = intake.type === "task" && intake.schedule?.reminder_policy !== "none"
    && Boolean(intake.schedule?.reminder_at || intake.schedule?.reminders?.length);
  const receiptState = dispatched.receipt?.reminder_projection_status;
  return Boolean(dispatched.projection_error) || Boolean(intake.type === "task" && intake.schedule && (
    reminderExpected ? receiptState !== "configured"
      : !["configured", "disabled", "not_requested"].includes(receiptState)
  ));
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

async function reconcileTask(row: Record<string, any>) {
  const expected = expectedTaskFields(row.request_payload || {});
  if (row.object_id) {
    const found = await taskService({ action: "read_task", task_id: row.object_id });
    if (found?.task?.id === row.object_id) {
      try { verifyTaskFields(found.task, expected); }
      catch { return { outcome: "changed", ...found }; }
      return { outcome: "verified", ...found };
    }
    return { outcome: "unknown" };
  }
  return await taskService({ action: "reconcile_intake", intake_audit_id: row.id, resolution_idempotency_key: row.idempotency_key,
    expected_task: expected });
}

function expectedTaskFields(intake: Record<string, any>) {
  if (intake.existing_task_id) {
    const patch = intake.update_patch || {};
    return {
      ...(Object.hasOwn(patch, "title") ? { title: patch.title } : {}),
      ...(Object.hasOwn(patch, "notes") ? { notes: patch.notes } : {}),
      ...(Object.hasOwn(patch, "due") || Object.hasOwn(patch, "requested_date") ? { dueDate: patch.due || patch.requested_date } : {}),
    };
  }
  return { title: intake.title, notes: intake.notes, dueDate: intake.due };
}

async function resumeTask(row: Record<string, any>, leaseOwner: string, allowPrewriteRetry = false) {
  let intake = row.request_payload;
  if (!intake || row.classification !== "task") {
    const result = { success: false, request_id: row.id, object_id: row.object_id || null,
      code: "ORIGINAL_REQUEST_UNAVAILABLE", message: "旧请求缺少原排程资料，已保留任务身份，需核实后处理。" };
    await updateAudit(row.id, { stage: "needs_input", error_code: result.code, response: result,
      lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  const account = await taskService({ action: "account_context" });
  if (!account.account_subject || (row.account_subject && account.account_subject !== row.account_subject)
    || (!row.account_subject && row.provider_attempted === true)) {
    const result = { success: false, code: row.account_subject ? "ACCOUNT_MISMATCH" : "ACCOUNT_UNVERIFIED",
      request_id: row.id, object_id: row.object_id || null,
      message: "原请求的 Google 账号身份尚未核实，未写入任务。" };
    await updateAudit(row.id, { stage: "auth_required", status: "failed", error_code: result.code,
      response: result, response_status: 409, lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  if (!row.account_subject) {
    row = await updateAudit(row.id, { account_subject: account.account_subject }, leaseOwner);
  }
  if (intake.context_pending) {
    const policy = await prepareAutonomousIntake(intake.original_input || { raw_text: intake.raw_text },
      { resolveContext: resolveAutonomyContext }, { baseDate: row.received_at || row.created_at });
    if (policy.decision !== "execute") {
      const result = { success: false, code: "CLARIFICATION_REQUIRED", request_id: row.id,
        message: intakeConfirmation({ decision: policy.decision, question: policy.question }), question: policy.question };
      await updateAudit(row.id, { stage: "needs_input", status: "failed", error_code: result.code,
        response: result, response_status: 200, lease_owner: null, lease_expires_at: null }, leaseOwner);
      return result;
    }
    intake = { ...normalizeIntake(frozenIntake(policy.input, row.received_at || row.created_at),
      { baseDate: row.received_at || row.created_at }), existing_task_id: policy.input.existing_task_id,
      update_patch: policy.input.update_patch };
    if (intake.type !== "task") {
      const result = { success: false, code: "INTENT_CHANGED", request_id: row.id,
        message: "恢复时请求类型需要重新确认，未写入任务。" };
      await updateAudit(row.id, { stage: "needs_input", status: "failed", error_code: result.code,
        response: result, response_status: 200, lease_owner: null, lease_expires_at: null }, leaseOwner);
      return result;
    }
    row = await updateAudit(row.id, { request_payload: intake, target_object_id: intake.existing_task_id || null }, leaseOwner);
  }
  if (row.response?.preference_outcome_unknown === true || (row.stage !== "projection_pending" && row.response?.partial && row.response?.preference === null && row.response?.id && !row.response?.projection_error)) {
    const result = { ...row.response, success: false, code: "PREFERENCE_OUTCOME_UNKNOWN", request_id: row.id,
      message: "任务已核实；附加偏好写入结果待核实。" };
    await updateAudit(row.id, { stage: "needs_input", status: "failed", error_code: result.code, response: result,
      lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  if (row.stage === "received" || (row.stage === "auth_required" && row.provider_attempted === false)) {
    if (isMissed(intake)) {
      const result = { success: false, code: "REMINDER_MISSED", request_id: row.id,
        message: "提醒时间已过，请决定是否重新安排。" };
      await updateAudit(row.id, { stage: "missed", status: "failed", response: result, response_status: 200,
        lease_owner: null, lease_expires_at: null }, leaseOwner);
      return result;
    }
    await updateAudit(row.id, { stage: "write_pending", provider_attempted: true }, leaseOwner);
    const dispatched = await dispatchTask(intake, row.id, row.idempotency_key);
    const hasReminder = intake.schedule?.reminder_policy !== "none" && Boolean(intake.schedule?.reminder_at || intake.schedule?.reminders?.length);
    const stage = !dispatched.verified ? "outcome_unknown" : projectionPending(intake, dispatched) ? "projection_pending"
      : hasReminder ? "reminder_verified" : "request_verified";
    const result = { ...dispatched, success: dispatched.success && ["reminder_verified", "request_verified"].includes(stage), request_id: row.id,
      message: stage === "projection_pending" ? "任务已保存，提醒待恢复。" : intakeConfirmation(dispatched) };
    await updateAudit(row.id, { stage, status: result.success ? "succeeded" : "processing", object_id: dispatched.id || null,
      target_object_id: dispatched.id || intake.existing_task_id || null, account_subject: row.account_subject || dispatched.account_subject || null,
      response: result, response_status: result.success ? 200 : 202, last_verified_at: dispatched.verified ? new Date().toISOString() : null,
      lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  const targetId = row.target_object_id || row.object_id;
  if (targetId) {
    const latest = await latestTargetVersion(targetId);
    if (latest && Number(latest.operation_version) > Number(row.operation_version)) {
      const result = { success: false, code: "SUPERSEDED", request_id: row.id, message: "此请求已被较新的修改覆盖。" };
      await updateAudit(row.id, { stage: "superseded", status: "failed", response: result, response_status: 200, lease_owner: null, lease_expires_at: null }, leaseOwner);
      return result;
    }
  }
  const reconciled = await reconcileTask(row);
  if (!allowPrewriteRetry && reconciled?.outcome === "not_written" && reconciled.code === "PREWRITE_REJECTED") {
    // Background reconciliation preserves the original no-write evidence;
    // only an explicit recover action may re-evaluate the original intent.
    await updateAudit(row.id, { lease_owner: null, lease_expires_at: null }, leaseOwner);
    return { success: false, request_id: row.id, code: "PREWRITE_REJECTED", verified: false,
      write_success: false, message: "原请求在写入前被拦截，可按原请求编号恢复。" };
  }
  if (allowPrewriteRetry && reconciled?.outcome === "not_written" && reconciled.code === "PREWRITE_REJECTED"
    && !row.object_id && !row.target_object_id
    && (!row.account_subject || row.account_subject === reconciled.account_subject)) {
    return await resumeTask({ ...row, stage: "received", provider_attempted: false }, leaseOwner);
  }
  if (reconciled?.outcome === "changed") {
    const result = { success: false, code: "SUPERSEDED", request_id: row.id, object_id: row.object_id,
      message: "任务内容已更新，旧请求不会覆盖当前内容。" };
    await updateAudit(row.id, { stage: "superseded", status: "failed", response: result, response_status: 200,
      lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  if (row.account_subject && reconciled?.account_subject && row.account_subject !== reconciled.account_subject) {
    const result = { success: false, code: "ACCOUNT_MISMATCH", request_id: row.id, message: "连接的 Google 账号与原请求不一致。" };
    await updateAudit(row.id, { stage: "auth_required", status: "failed", error_code: "ACCOUNT_MISMATCH", response: result,
      response_status: 409, lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  if (reconciled?.outcome !== "verified" || !reconciled.task?.id) {
    const result = { success: false, code: "OUTCOME_UNKNOWN", request_id: row.id, retryable: true, message: "写入结果待核实；不会重复创建任务。" };
    await updateAudit(row.id, { stage: "outcome_unknown", status: "processing", error_code: "OUTCOME_UNKNOWN", retry_count: Number(row.retry_count || 0) + 1, next_retry_at: retryAt(row.retry_count), response: result, response_status: 202, lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  const task = reconciled.task;
  const newestForTask = await latestTargetVersion(task.id);
  if (newestForTask && Number(newestForTask.operation_version) > Number(row.operation_version)) {
    const result = { success: false, code: "SUPERSEDED", request_id: row.id, object_id: task.id,
      message: "此请求已被较新的修改覆盖。" };
    await updateAudit(row.id, { stage: "superseded", status: "failed", response: result, response_status: 200,
      lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  if (row.account_subject && reconciled.account_subject && row.account_subject !== reconciled.account_subject) {
    const result = { success: false, code: "ACCOUNT_MISMATCH", request_id: row.id, message: "连接的 Google 账号与原请求不一致。" };
    await updateAudit(row.id, { stage: "auth_required", status: "failed", error_code: "ACCOUNT_MISMATCH", response: result, response_status: 409, lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  if (task.status === "completed" || task.status === "cancelled" || task.deleted === true) {
    const result = { success: false, code: "TASK_NO_LONGER_ACTIVE", request_id: row.id, object_id: task.id, message: "任务已完成或取消，旧提醒不会恢复。" };
    await updateAudit(row.id, { stage: "cancelled", status: "failed", response: result, response_status: 200, lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  if (isMissed(intake)) {
    const result = { success: false, code: "REMINDER_MISSED", request_id: row.id, object_id: task.id,
      message: "提醒时间已过，请决定是否重新安排。" };
    await updateAudit(row.id, { stage: "missed", status: "failed", object_id: task.id, target_object_id: task.id,
      last_verified_at: new Date().toISOString(), response: result, response_status: 200,
      lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  await updateAudit(row.id, { stage: "task_verified", object_id: task.id, target_object_id: task.id, account_subject: row.account_subject || reconciled.account_subject || null, last_verified_at: new Date().toISOString() }, leaseOwner);
  if (!intake.schedule) {
    const result = { success: true, write_success: true, verified: true, id: task.id, destination: "google_tasks", request_id: row.id, message: "任务已核实。" };
    await updateAudit(row.id, { stage: "request_verified", status: "succeeded", response: result, response_status: 200, lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  const projected = await taskService({ action: "retry_projection", task_id: task.id, schedule: intake.schedule,
    recurrence: intake.recurrence || null, intake_audit_id: row.id, expected_task: expectedTaskFields(intake) });
  if (["SCHEDULE_SUPERSEDED", "TASK_CHANGED_SINCE_REQUEST", "TASK_NO_LONGER_ACTIVE"].includes(projected?.code)) {
    const result = { success: false, request_id: row.id, object_id: task.id, code: "SUPERSEDED",
      message: "任务或提醒已被更新，旧请求不会覆盖当前设置。" };
    await updateAudit(row.id, { stage: "superseded", status: "failed", error_code: projected.code,
      response: result, response_status: 200, lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  const readback = await taskService({ action: "read_task", task_id: task.id });
  const expectedReminder = intake.schedule.reminder_policy !== "none" && Boolean(intake.schedule.reminder_at || intake.schedule.reminders?.length);
  const receiptStatus = projected?.receipt?.reminder_projection_status;
  const projectionVerified = projected?.receipt?.task_save_status === "verified" &&
    (expectedReminder ? receiptStatus === "configured" : ["disabled", "not_requested", "configured"].includes(receiptStatus));
  if (projected?.projection_error || !readback?.schedule || readback.schedule.sync_required || !projectionVerified) {
    const result = { success: false, partial: true, write_success: true, verified: true, id: task.id, code: "PROJECTION_PENDING", request_id: row.id, message: "任务已保存，提醒待恢复。" };
    await updateAudit(row.id, { stage: "projection_pending", status: "processing", error_code: "PROJECTION_PENDING", retry_count: Number(row.retry_count || 0) + 1, next_retry_at: retryAt(row.retry_count), response: result, response_status: 202, lease_owner: null, lease_expires_at: null }, leaseOwner);
    return result;
  }
  const result = { success: true, write_success: true, verified: true, id: task.id, schedule: readback.schedule, destination: "google_tasks", request_id: row.id, message: "任务与提醒配置已核实。" };
  await updateAudit(row.id, { stage: expectedReminder ? "reminder_verified" : "request_verified", status: "succeeded", error_code: null, last_verified_at: new Date().toISOString(), response: result, response_status: 200, lease_owner: null, lease_expires_at: null }, leaseOwner);
  return result;
}

async function resumeNonTask(row: Record<string, any>, leaseOwner: string) {
  const result = { success: false, request_id: row.id, object_id: row.object_id || null,
    code: "NON_TASK_RECONCILIATION_REQUIRED", message: "此请求需要核实原目标对象，未重复写入。" };
  await updateAudit(row.id, { stage: "needs_input", status: "failed", error_code: result.code,
    response: result, response_status: 200, lease_owner: null, lease_expires_at: null }, leaseOwner);
  return result;
}

async function amendRequest(input: Record<string, any>) {
  const requestId = String(input.request_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new IntakeError("request_id is required", 400, "INVALID_REQUEST_ID");
  if (!Number.isInteger(input.recovery_version) || input.recovery_version < 0) {
    throw new IntakeError("recovery_version is required", 400, "VERSION_REQUIRED");
  }
  const query = new URLSearchParams({ owner_id: `eq.${OWNER_USER_ID}`, id: `eq.${requestId}`, select: "*", limit: "1" });
  const row = (await rest(`personal_os_intake_audit?${query}`))?.[0];
  if (!row) throw new IntakeError("Request was not found", 404, "REQUEST_NOT_FOUND");
  if (row.recovery_version !== input.recovery_version) throw new IntakeError("Request changed; refresh before editing", 409, "VERSION_CONFLICT");
  if (!["needs_input", "missed", "unsupported"].includes(row.stage) || row.classification !== "task") {
    throw new IntakeError("This request cannot be amended", 409, "AMENDMENT_NOT_ALLOWED");
  }
  const identity = await taskService({ action: "account_context" });
  if (!identity.account_subject || !row.account_subject || identity.account_subject !== row.account_subject) {
    throw new IntakeError("Original Google account cannot be verified", 409, "ACCOUNT_MISMATCH");
  }
  if (row.object_id) {
    const latest = await latestTargetVersion(row.object_id);
    if (latest && Number(latest.operation_version) > Number(row.operation_version)) {
      throw new IntakeError("A newer task update exists", 409, "SUPERSEDED");
    }
    const current = await taskService({ action: "read_task", task_id: row.object_id });
    if (row.account_subject && current.account_subject && row.account_subject !== current.account_subject) {
      throw new IntakeError("Google account changed", 409, "ACCOUNT_MISMATCH");
    }
    if (current.task?.status !== "open") throw new IntakeError("Task is no longer active", 409, "TASK_NO_LONGER_ACTIVE");
  }
  const { schedule: _oldSchedule, ...original } = row.request_payload || {};
  const receivedAt = row.received_at || row.created_at;
  const amended = normalizeIntake({ ...original,
    raw_text: input.raw_text || original.raw_text,
    requested_date: input.requested_date || original.requested_date,
    requested_time: input.requested_time || original.requested_time,
    timezone: input.timezone || original.timezone,
    baseDate: receivedAt,
  }, { baseDate: receivedAt });
  const blocker = intakeBlocker(amended);
  if (blocker) throw new IntakeError(blocker === "RECURRENCE_DATE_REQUIRED" ? "A recurring task needs a first date"
    : blocker === "REMINDER_TIME_REQUIRED" ? "Reminder time is required" : "Recurrence is unsupported", 400, blocker);
  if (isMissed(amended)) throw new IntakeError("Reminder time is in the past", 400, "REMINDER_MISSED");
  const claimed = await claimAudit(row);
  const updated = await updateAudit(row.id, { request_payload: amended, stage: row.object_id ? "write_pending" : "received",
    error_code: null, next_retry_at: null, retry_count: 0, response: null, response_status: null }, claimed.leaseOwner);
  if (!row.object_id) return await resumeTask(updated, claimed.leaseOwner);
  const change = { requested_date: amended.requested_date, requested_time: amended.requested_time,
    reminder_at: amended.schedule?.reminder_at || null, reminder_policy: amended.schedule?.reminder_policy || "none" };
  const dispatched = await dispatchTask({ ...amended, existing_task_id: row.object_id, update_patch: change }, row.id, row.idempotency_key);
  const expectedReminder = amended.schedule?.reminder_policy !== "none" && Boolean(amended.schedule?.reminder_at || amended.schedule?.reminders?.length);
  const receiptStatus = dispatched.receipt?.reminder_projection_status;
  const pending = !dispatched.verified || Boolean(dispatched.projection_error) ||
    (expectedReminder ? receiptStatus !== "configured" : !["configured", "disabled", "not_requested"].includes(receiptStatus));
  const result = { ...dispatched, success: dispatched.success && !pending, request_id: row.id,
    message: !dispatched.verified ? "写入结果待核实。" : pending ? "任务已保存，提醒待恢复。" : "任务与提醒配置已核实。" };
  await updateAudit(row.id, { stage: !dispatched.verified ? "outcome_unknown" : pending ? "projection_pending" : expectedReminder ? "reminder_verified" : "request_verified",
    status: result.success ? "succeeded" : "processing", object_id: row.object_id, target_object_id: row.object_id,
    response: result, response_status: result.success ? 200 : 202, last_verified_at: dispatched.verified ? new Date().toISOString() : null,
    next_retry_at: pending ? retryAt(0) : null, lease_owner: null, lease_expires_at: null }, claimed.leaseOwner);
  return result;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "POST"].includes(request.method)) return json({ success: false, error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_API_KEY || !/^[0-9a-f-]{36}$/i.test(OWNER_USER_ID) || WRITE_TOKEN.length < 32) {
    return json({ success: false, error: "Server configuration incomplete" }, 503);
  }
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    || request.headers.get("x-automation-token") || "";
  const canWrite = constantTimeEqual(token, WRITE_TOKEN);
  if (!canWrite && !(request.method === "GET" && READ_TOKEN.length >= 32 && constantTimeEqual(token, READ_TOKEN))) return json({ success: false, error: "Unauthorized" }, 401);

  let auditId = "";
  let leaseOwner = "";
  let receiptKey = String(request.headers.get("idempotency-key") || "").trim();
  try {
    if (request.method === "GET") return json(await listRequests(new URL(request.url)));
    const input = await request.json();
    if (input?.action === "amend_request") {
      const result = await amendRequest(input);
      return json(result, result.success ? 200 : 202);
    }
    if (input?.action === "recover" || input?.action === "recover_due") {
      const query = new URLSearchParams({ owner_id: `eq.${OWNER_USER_ID}`, select: "*", order: "received_at.asc", limit: input.action === "recover" ? "1" : "20" });
      if (input.action === "recover") {
        if (!/^[0-9a-f-]{36}$/i.test(String(input.request_id || ""))) throw new IntakeError("request_id is required", 400, "INVALID_REQUEST_ID");
        query.set("id", `eq.${input.request_id}`);
      } else {
        const now = new Date().toISOString();
        query.set("stage", input.after_reconnect === true
          ? "in.(received,write_pending,outcome_unknown,task_verified,projection_pending,auth_required)"
          : "in.(received,write_pending,outcome_unknown,task_verified,projection_pending)");
        query.set("and", `(or(next_retry_at.is.null,next_retry_at.lte.${now}),or(lease_expires_at.is.null,lease_expires_at.lte.${now}))`);
      }
      const rows = await rest(`personal_os_intake_audit?${query}`);
      const results = [];
      for (const row of rows || []) {
        if (input.action === "recover_due" && row.stage === "received" && row.provider_attempted !== true) {
          results.push({ request_id: row.id, success: false, code: "USER_CONTINUATION_REQUIRED", stage: row.stage, message: "未开始写入的请求需明确继续，不会后台新建。" });
          continue;
        }
        const decision = recoveryDecision(row);
        if (decision === "complete" || decision === "needs_input" || decision === "later" || decision === "leased") {
          results.push({ request_id: row.id, decision, stage: row.stage });
          continue;
        }
        let claimed = null;
        try {
          claimed = await claimAudit(row);
          results.push(claimed.row.classification === "task"
            ? await resumeTask(claimed.row, claimed.leaseOwner, input.action === "recover")
            : await resumeNonTask(claimed.row, claimed.leaseOwner));
        } catch (error) {
          if (!claimed) {
            results.push({ request_id: row.id, success: false, code: safeError(error),
              message: "请求正在恢复，稍后再核实。" });
            continue;
          }
          try { results.push(await recordRecoveryFailure(claimed.row, claimed.leaseOwner, error)); }
          catch {
            results.push({ request_id: row.id, success: false, code: "RECOVERY_CHECKPOINT_FAILED",
              message: "恢复状态暂未保存，请按原请求编号再核实。" });
          }
        }
      }
      return json({ results, checked_at: new Date().toISOString() }, input.action === "recover" && !rows?.length ? 404 : 200);
    }
    const receivedAt = new Date().toISOString();
    const idempotencyKey = String(request.headers.get("idempotency-key") || input.idempotency_key || "").trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new IntakeError("idempotency_key must contain 8-200 characters", 400, "INVALID_IDEMPOTENCY_KEY");
    }
    receiptKey = idempotencyKey;
    const requestHash = await sha256(stableRequest(input));
    const preliminary = evaluateAutonomy(input, { baseDate: receivedAt });
    const provisional = preliminary.decision === "execute"
      ? normalizeIntake(frozenIntake(preliminary.input, receivedAt), { baseDate: receivedAt }) : null;
    let earlyReservation = null;
    if (provisional?.type === "task") {
      earlyReservation = await reserveAudit({ ...provisional, context_pending: true, original_input: input }, idempotencyKey, requestHash, receivedAt);
      auditId = earlyReservation.row.id;
      leaseOwner = earlyReservation.leaseOwner || "";
      if (earlyReservation.replayed) {
        const row = earlyReservation.row;
        const decision = recoveryDecision(row);
        if (["complete", "needs_input", "later", "leased"].includes(decision)) return json({ ...(row.response || { success: false, write_success: false, verified: false, outcome: "unknown" }), request_id: row.id, idempotency_key: idempotencyKey, stage: row.stage, replayed: true, decision }, row.response_status || 202);
        const claimed = await claimAudit(row);
        leaseOwner = claimed.leaseOwner;
        const recovered = await resumeTask(claimed.row, leaseOwner);
        return json({ ...recovered, idempotency_key: idempotencyKey, replayed: true }, recovered.success ? 200 : 202);
      }
    }
    let policy;
    try {
      policy = await prepareAutonomousIntake(input, { resolveContext: resolveAutonomyContext }, { baseDate: receivedAt });
    } catch (error) {
      // Context reads may refresh an expired Google credential. Keep an
      // actionable request before that read can fail, with its original clock.
      const preliminary = evaluateAutonomy(input, { baseDate: receivedAt });
      const provisional = preliminary.decision === "execute"
        ? normalizeIntake(frozenIntake(preliminary.input, receivedAt), { baseDate: receivedAt }) : null;
      if (!provisional || provisional.type !== "task") throw error;
      const reservation = earlyReservation || await reserveAudit({ ...provisional, context_pending: true,
        original_input: input }, idempotencyKey, requestHash, receivedAt);
      auditId = reservation.row.id;
      leaseOwner = reservation.leaseOwner || "";
      if (reservation.replayed) {
        const previous = reservation.row;
        return json({ ...(previous.response || {}), request_id: previous.id, stage: previous.stage,
          replayed: true }, previous.response_status || 202);
      }
      const code = safeError(error);
      const terminalStage = code === "USER_CANCELLED" ? "cancelled" : ["ACTION_DENIED", "POLICY_DENIED", "PERMISSION_DENIED"].includes(code) ? "unsupported" : null;
      if (terminalStage) {
        const stopped = { success: false, write_success: false, verified: false, outcome: "rejected", code, request_id: auditId, idempotency_key: idempotencyKey, message: "请求已取消或拒绝，不会自动继续执行。" };
        await updateAudit(auditId, { stage: terminalStage, status: "failed", error_code: code, next_retry_at: null, response: stopped, response_status: 409, lease_owner: null, lease_expires_at: null }, leaseOwner);
        return json(stopped, 409);
      }
      const requiresAuth = /AUTH|ACCOUNT|NOT_CONNECTED|SCOPE/.test(code);
      const result = { success: false, write_success: false, verified: false, code,
        request_id: auditId, idempotency_key: idempotencyKey, outcome: "unknown", message: requiresAuth
          ? "请求已保存；请连接原 Google 账号后继续。" : "请求已保存，上下文尚未核实；需明确继续后恢复。" };
      await updateAudit(auditId, { stage: requiresAuth ? "auth_required" : "received",
        status: "processing", error_code: code, next_retry_at: requiresAuth ? null : retryAt(0),
        response: result, response_status: 202, lease_owner: null, lease_expires_at: null }, leaseOwner);
      return json(result, 202);
    }
    if (policy.decision !== "execute") {
      const result = { success: false, write_success: false, verified: false, intent: policy.intent, decision: policy.decision, risk_level: policy.risk_level, question: policy.question, code: policy.decision === "ask" ? "CLARIFICATION_REQUIRED" : "INFORMATION_ONLY" };
      if (auditId && leaseOwner) await updateAudit(auditId, { stage: "needs_input", status: "failed", response: result, response_status: 200, lease_owner: null, lease_expires_at: null }, leaseOwner);
      return json({ ...result, ...(auditId ? { request_id: auditId } : {}), idempotency_key: idempotencyKey, message: intakeConfirmation(result) });
    }
    const intake = { ...normalizeIntake(frozenIntake(policy.input, receivedAt), { baseDate: receivedAt }), existing_task_id: policy.input.existing_task_id, update_patch: policy.input.update_patch };
    const reservation = earlyReservation || await reserveAudit(intake, idempotencyKey, requestHash, receivedAt);
    auditId = reservation.row.id;
    leaseOwner = reservation.leaseOwner || "";
    if (reservation.replayed) {
      const row = reservation.row;
      const decision = recoveryDecision(row);
      if (decision === "complete" || decision === "needs_input" || decision === "later" || decision === "leased") {
        return json({ ...(row.response || {}), request_id: row.id, stage: row.stage, replayed: true, decision }, row.response_status || 200);
      }
      const claimed = await claimAudit(row);
      leaseOwner = claimed.leaseOwner;
      const recovered = claimed.row.classification === "task"
        ? await resumeTask(claimed.row, leaseOwner)
        : await resumeNonTask(claimed.row, leaseOwner);
      return json({ ...recovered, replayed: true }, recovered.success ? 200 : 202);
    }

    if (earlyReservation) await updateAudit(auditId, { request_payload: intake, target_object_id: intake.existing_task_id || null }, leaseOwner);
    const identity = await taskService({ action: "account_context" });
    if (!identity?.account_subject) {
      const result = { success: false, write_success: false, verified: false, code: "ACCOUNT_UNVERIFIED",
        request_id: auditId, message: "Google 账号身份尚未核实，请连接原账号后继续。" };
      await updateAudit(auditId, { stage: "auth_required", status: "processing", error_code: result.code,
        response: result, response_status: 202, lease_owner: null, lease_expires_at: null }, leaseOwner);
      return json(result, 202);
    }
    await updateAudit(auditId, { account_subject: identity.account_subject }, leaseOwner);

    const blocker = intakeBlocker(intake);
    if (blocker) {
      const needsTime = ["REMINDER_TIME_REQUIRED", "RECURRENCE_TIME_REQUIRED"].includes(blocker);
      const stage = needsTime ? "needs_input" : "unsupported";
      const result = { success: false, write_success: false, verified: false, code: blocker, request_id: auditId, stage, message: needsTime ? "请提供提醒的具体时间。" : "当前排程不支持此周期提醒。" };
      await updateAudit(auditId, { stage, status: "failed", error_code: blocker, response_status: 200, response: result, lease_owner: null, lease_expires_at: null }, leaseOwner);
      return json(result);
    }
    if (intake.type === "task" && isMissed(intake)) {
      const result = { success: false, write_success: false, verified: false, code: "REMINDER_MISSED",
        request_id: auditId, stage: "missed", message: "提醒时间已过，请决定是否重新安排。" };
      await updateAudit(auditId, { stage: "missed", status: "failed", error_code: result.code, response_status: 200,
        response: result, lease_owner: null, lease_expires_at: null }, leaseOwner);
      return json(result);
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
      await updateAudit(auditId, { stage: "unsupported", status: "failed", error_code: unsupported.code, error: unsupported.error, response_status: 501, response: unsupported, lease_owner: null, lease_expires_at: null }, leaseOwner);
      return json(unsupported, 501);
    }

    await updateAudit(auditId, { stage: "write_pending", request_payload: intake, provider_attempted: true }, leaseOwner);
    const dispatched: Record<string, any> = intake.type === "task"
      ? await dispatchTask(intake, auditId, idempotencyKey)
      : await dispatchGoalPlan(intake);
    let preference = null;
    let partial = false;
    if (policy.intent === "mixed" && policy.preference_text && dispatched.success) {
      try {
        preference = await dispatchGoalPlan(normalizeIntake({ raw_text: policy.preference_text, type: "plan", title: policy.preference_text, horizon: "long" }));
      } catch { partial = true; }
    }
    const pendingReminder = projectionPending(intake, dispatched);
    const result: Record<string, any> = { ...dispatched, success: dispatched.success && !partial && !pendingReminder, partial: partial || pendingReminder, preference_outcome_unknown: partial, preference, risk_level: policy.risk_level, idempotency_key: idempotencyKey, request_id: auditId, replayed: false, message: "" };
    result.message = intakeConfirmation(result);
    if (pendingReminder) result.message = "任务已保存，提醒待恢复。";
    const hasReminder = intake.type === "task" && intake.schedule?.reminder_policy !== "none"
      && Boolean(intake.schedule?.reminder_at || intake.schedule?.reminders?.length);
    const stage = !dispatched.verified ? "outcome_unknown" : pendingReminder ? "projection_pending"
      : hasReminder ? "reminder_verified" : "request_verified";
    try { await updateAudit(auditId, { stage, status: result.success ? "succeeded" : "processing", object_id: result.id || null, target_object_id: result.id || intake.existing_task_id || null, account_subject: identity.account_subject, error_code: result.code || (pendingReminder ? "PROJECTION_PENDING" : null), last_verified_at: dispatched.verified ? new Date().toISOString() : null, next_retry_at: result.success ? null : retryAt(0), retry_count: result.success ? 0 : 1, response_status: result.success ? 200 : 202, response: result, lease_owner: null, lease_expires_at: null }, leaseOwner); }
    catch { Object.assign(result, { audit_warning: "Write result verified but audit finalization failed; retain object id for recovery" }); }
    console.info("Personal OS intake succeeded", { auditId, destination: result.destination, objectId: result.id });
    return json(result);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const intakeError = error instanceof IntakeError
      ? error
      : new IntakeError(timedOut ? "Personal OS intake timed out" : "Personal OS intake failed", 503, timedOut ? "INTAKE_TIMEOUT" : "INTAKE_FAILED");
    auditId ||= intakeError.requestId || "";
    const failure = { success: false, write_success: false, verified: false, outcome: intakeError.code === "IDEMPOTENCY_CONFLICT" ? "rejected" : "unknown", idempotency_key: receiptKey || undefined, request_id: auditId || undefined, code: intakeError.code, error: intakeError.message,
      ...(intakeError.code === "TASK_TARGET_AMBIGUOUS" ? { decision: "ask", question: "有多个匹配任务，要修改哪一个？" } : {}), message: "" };
    failure.message = intakeError.code === "IDEMPOTENCY_CONFLICT" ? "此幂等键对应另一个已登记请求；本次内容已拒绝，未重写。请按原请求ID只读核实。" : auditId ? "请求已登记，执行结果待核实；请按原 request_id 或 idempotency_key 只读核实。" : "未取得持久回执，结果待核实；请按原 idempotency_key 查询，不能据此判断已写入或未写入。";
    if (auditId && leaseOwner) {
      const authRequired = ["AUTH_RECONNECT_REQUIRED", "GOOGLE_REAUTH_REQUIRED", "GOOGLE_AUTH_REQUIRED",
        "GOOGLE_NOT_CONNECTED", "ACCOUNT_MISMATCH", "ACCOUNT_UNVERIFIED"].includes(intakeError.code);
      try { await updateAudit(auditId, { stage: authRequired ? "auth_required" : "outcome_unknown", status: "processing", error_code: intakeError.code, error: safeError(intakeError), retry_count: 1, next_retry_at: authRequired ? null : retryAt(0), response_status: 202, response: failure, lease_owner: null, lease_expires_at: null }, leaseOwner); }
      catch (auditError) { console.error("Personal OS audit update failed", auditError instanceof Error ? auditError.message : "unknown"); }
    }
    console.error("Personal OS intake failed", { auditId: auditId || null, code: intakeError.code });
    return json(failure, intakeError.status);
  }
});
