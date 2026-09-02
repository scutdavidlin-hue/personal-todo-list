import { buildStatus, publicTask, shanghaiDate, validDate, validTime } from "./status-core.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";
const READ_TOKEN = Deno.env.get("AUTOMATION_READ_TOKEN") ?? "";
const WRITE_TOKEN = Deno.env.get("AUTOMATION_WRITE_TOKEN") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-automation-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

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

function requestToken(request: Request) {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return bearer || request.headers.get("x-automation-token") || "";
}

function rateLimited(request: Request) {
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 60;
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
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.message || payload?.hint || `Database request failed (${response.status})`);
  return payload;
}

async function readStatus(targetDate: string) {
  await rest("rpc/rollover_tasks_for_owner", {
    method: "POST",
    body: JSON.stringify({ target_owner: OWNER_USER_ID, target_date: targetDate }),
  });

  const select = "id,title,date,time,category,priority,duration,notes,status,done,completed_at,created_at,updated_at,source,carried_from_date";
  const rows = await rest(`tasks?owner_id=eq.${encodeURIComponent(OWNER_USER_ID)}&status=neq.cancelled&select=${select}&order=date.asc,time.asc.nullslast,created_at.asc`);
  return buildStatus(rows as Record<string, unknown>[], targetDate);
}

async function createTask(request: Request) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const date = input.date || shanghaiDate();
  if (!title || title.length > 200) return json({ error: "title must contain 1-200 characters" }, 400);
  if (!validDate(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);

  const priority = ["high", "medium", "low"].includes(input.priority) ? input.priority : "medium";
  const duration = Number.isInteger(input.duration) && input.duration >= 0 && input.duration <= 1440 ? input.duration : 30;
  const task = {
    owner_id: OWNER_USER_ID,
    title,
    date,
    time: validTime(input.time) ? input.time : null,
    category: typeof input.category === "string" && input.category.trim() ? input.category.trim().slice(0, 40) : "工作",
    priority,
    duration,
    notes: typeof input.notes === "string" ? input.notes.slice(0, 4000) : "",
    status: "open",
    completed_at: null,
    source: "gpt",
    carried_from_date: null,
  };
  const created = await rest("tasks?select=id,title,date,time,category,priority,duration,notes,status,done,completed_at,created_at,updated_at,source,carried_from_date", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(task),
  });
  return json({ task: publicTask(created[0]) }, 201);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(OWNER_USER_ID) || READ_TOKEN.length < 32 || WRITE_TOKEN.length < 32) {
    return json({ error: "Server configuration incomplete" }, 503);
  }
  if (rateLimited(request)) return json({ error: "Too many requests" }, 429);

  const token = requestToken(request);
  const canWrite = constantTimeEqual(token, WRITE_TOKEN);
  const canRead = canWrite || constantTimeEqual(token, READ_TOKEN);
  if ((request.method === "GET" && !canRead) || (request.method === "POST" && !canWrite)) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    if (request.method === "POST") return await createTask(request);
    const requestedDate = new URL(request.url).searchParams.get("date") || shanghaiDate();
    if (!validDate(requestedDate)) return json({ error: "date must be YYYY-MM-DD" }, 400);
    return json(await readStatus(requestedDate));
  } catch (error) {
    console.error("task-status request failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Task service unavailable" }, 503);
  }
});
