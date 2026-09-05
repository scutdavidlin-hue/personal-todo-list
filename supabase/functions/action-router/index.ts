import { classifyAction } from "../_shared/action-router.js";
import { normalizeIntake } from "../_shared/personal-os-intake.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const WRITE_TOKEN = Deno.env.get("AUTOMATION_WRITE_TOKEN") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-automation-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || WRITE_TOKEN.length < 32) return json({ error: "Server configuration incomplete" }, 503);
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    || request.headers.get("x-automation-token") || "";
  if (!constantTimeEqual(token, WRITE_TOKEN)) return json({ error: "Unauthorized" }, 401);

  try {
    const input = await request.json();
    const route = classifyAction(input.input, { baseDate: input.baseDate });
    if (route.type !== "task") return json({ ...route, dispatched: false });
    const intake = normalizeIntake({ raw_text: input.input, source: input.source || "action_router" }, { baseDate: input.baseDate });
    const idempotencyKey = String(
      request.headers.get("idempotency-key")
        || input.idempotency_key
        || `action-router:${crypto.randomUUID()}`,
    );
    const response = await fetch(`${SUPABASE_URL}/functions/v1/personal-os-intake`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WRITE_TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ ...intake, idempotency_key: idempotencyKey }),
      signal: AbortSignal.timeout(25_000),
    });
    const result = await response.json();
    if (!response.ok) return json({ ...route, dispatched: false, error: result.error || "Task dispatch failed" }, response.status);
    const taskId = result.task_id || result.google_task_id || result.id;
    const compatibleResult = {
      ...result,
      task: {
        id: taskId,
        task_id: taskId,
        google_task_id: result.google_task_id || taskId,
        title: result.title,
        dueDate: result.due,
        status: "open",
        metadata: { deduplicated: result.deduplicated === true },
      },
    };
    console.info("Action Routed", { type: route.type, taskId, deduplicated: result.deduplicated === true });
    return json({ ...route, dispatched: true, result: compatibleResult }, response.status);
  } catch (error) {
    console.error("Action Router Failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "无法判断这条输入，请稍后重试" }, 400);
  }
});
