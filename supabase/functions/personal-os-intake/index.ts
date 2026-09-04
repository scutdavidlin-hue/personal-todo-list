import {
  canonicalIntake,
  normalizeIntake,
  taskDispatchPayload,
} from "../_shared/personal-os-intake.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
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

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
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

async function dispatchTask(intake: Record<string, unknown>) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/task-status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WRITE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(taskDispatchPayload(intake)),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await responsePayload(response);
  if (!response.ok || !result?.task?.id) {
    throw new IntakeError(result?.error || "Google Tasks write failed", response.status || 503, result?.code || "TASK_WRITE_FAILED");
  }
  return {
    success: true,
    destination: "google_tasks",
    id: result.task.id,
    title: result.task.title,
    due: result.task.dueDate || null,
    deduplicated: result.deduplicated === true,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !/^[0-9a-f-]{36}$/i.test(OWNER_USER_ID) || WRITE_TOKEN.length < 32) {
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
    const intake = normalizeIntake(input);
    const requestHash = await sha256(canonicalIntake(intake));
    const reservation = await reserveAudit(intake, idempotencyKey, requestHash);
    auditId = reservation.row.id;
    if (reservation.replayed) {
      return json({ ...reservation.row.response, replayed: true }, reservation.row.response_status || 200);
    }

    if (intake.type !== "task") {
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

    const result = { ...(await dispatchTask(intake)), idempotency_key: idempotencyKey, replayed: false };
    await updateAudit(auditId, { status: "succeeded", object_id: result.id, response_status: 200, response: result });
    console.info("Personal OS intake succeeded", { auditId, destination: result.destination, objectId: result.id });
    return json(result);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const intakeError = error instanceof IntakeError
      ? error
      : new IntakeError(timedOut ? "Personal OS intake timed out" : "Personal OS intake failed", 503, timedOut ? "INTAKE_TIMEOUT" : "INTAKE_FAILED");
    const failure = { success: false, code: intakeError.code, error: intakeError.message };
    if (auditId) {
      try { await updateAudit(auditId, { status: "failed", error: intakeError.message, response_status: intakeError.status, response: failure }); }
      catch (auditError) { console.error("Personal OS audit update failed", auditError instanceof Error ? auditError.message : "unknown"); }
    }
    console.error("Personal OS intake failed", { auditId: auditId || null, code: intakeError.code });
    return json(failure, intakeError.status);
  }
});
