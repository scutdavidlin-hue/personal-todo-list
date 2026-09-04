import { buildStatus, shanghaiDate, validDate } from "./status-core.js";
import {
  createGoogleTaskPayload,
  findDuplicateTask,
  toTaskModel,
  updateGoogleTaskPayload,
} from "../_shared/google-tasks-core.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";
const READ_TOKEN = Deno.env.get("AUTOMATION_READ_TOKEN") ?? "";
const WRITE_TOKEN = Deno.env.get("AUTOMATION_WRITE_TOKEN") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
const TOKEN_ENCRYPTION_KEY = Deno.env.get("GOOGLE_TOKEN_ENCRYPTION_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-automation-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 503, code = "TASK_SERVICE_UNAVAILABLE") {
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

function requestToken(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    || request.headers.get("x-automation-token") || "";
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

async function payload(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function requestWithTimeout(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(10_000) });
}

async function restRpc(name: string, body: Record<string, unknown>) {
  const response = await requestWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await payload(response);
  if (!response.ok) throw new ApiError(data?.message || "Credential store unavailable", 503, "CREDENTIAL_STORE_ERROR");
  return data;
}

async function readSchedules() {
  const query = new URLSearchParams({ owner_id: `eq.${OWNER_USER_ID}`, select: "*", order: "scheduled_date.asc,scheduled_start.asc" });
  const response = await requestWithTimeout(`${SUPABASE_URL}/rest/v1/task_schedule_metadata?${query}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  const data = await payload(response);
  if (response.status === 404) return [];
  if (!response.ok) throw new ApiError(data?.message || "Schedule store unavailable", 503, "SCHEDULE_STORE_ERROR");
  return data || [];
}

async function googleContext() {
  const rows = await restRpc("read_google_tasks_credentials", {
    target_owner: OWNER_USER_ID,
    encryption_key: TOKEN_ENCRYPTION_KEY,
  });
  const credentials = rows?.[0];
  if (!credentials?.refresh_token || !credentials?.tasklist_id) throw new ApiError("Google Tasks is not connected", 428, "GOOGLE_NOT_CONNECTED");
  const response = await requestWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: credentials.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const token = await payload(response);
  if (!response.ok || !token?.access_token) throw new ApiError("Google authorization expired", 401, "GOOGLE_REAUTH_REQUIRED");
  return { accessToken: token.access_token, taskListId: credentials.tasklist_id };
}

async function googleRequest(accessToken: string, path: string, init: RequestInit = {}) {
  const response = await requestWithTimeout(`https://tasks.googleapis.com/tasks/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = await payload(response);
  if (!response.ok) {
    const message = data?.error?.message || `Google Tasks request failed (${response.status})`;
    const reason = data?.error?.errors?.[0]?.reason || "";
    if (response.status === 401) throw new ApiError("Google authorization expired", 401, "GOOGLE_REAUTH_REQUIRED");
    if (response.status === 404) throw new ApiError("Task was deleted externally", 404, "TASK_NOT_FOUND");
    if (response.status === 429 || /rateLimit/i.test(reason)) throw new ApiError("Google rate limit reached", 429, "RATE_LIMITED");
    if (response.status === 403 && /disabled|not been used|accessnotconfigured/i.test(`${reason} ${message}`)) {
      throw new ApiError("Google Tasks API is disabled", 503, "TASKS_API_DISABLED");
    }
    if (response.status === 403) throw new ApiError("Google Tasks scope is missing", 403, "SCOPE_MISSING");
    throw new ApiError(message, response.status, "GOOGLE_TASKS_ERROR");
  }
  return data;
}

function tasksPath(taskListId: string, taskId = "") {
  return `/lists/${encodeURIComponent(taskListId)}/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
}

async function allTasks(showCompleted = true) {
  const { accessToken, taskListId } = await googleContext();
  const tasks = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      maxResults: "100",
      showCompleted: String(showCompleted),
      showHidden: String(showCompleted),
      showDeleted: "false",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await googleRequest(accessToken, `${tasksPath(taskListId)}?${params}`);
    tasks.push(...(page?.items || [])
      .filter((task: Record<string, unknown>) => !task.deleted)
      .map((task: Record<string, unknown>) => toTaskModel(task, taskListId)));
    pageToken = page?.nextPageToken || "";
  } while (pageToken);
  return { accessToken, taskListId, tasks };
}

async function readStatus(targetDate: string) {
  const [google, schedules] = await Promise.all([allTasks(true), readSchedules()]);
  return buildStatus(google.tasks, targetDate, new Date(), schedules);
}

async function scheduleProjection(taskId: string, schedule: Record<string, unknown> | null | undefined) {
  if (!schedule) return null;
  const response = await requestWithTimeout(`${SUPABASE_URL}/functions/v1/task-scheduler`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WRITE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "schedule", task_id: taskId, schedule }),
  });
  const result = await payload(response);
  if (!response.ok || result?.success !== true) {
    throw new ApiError(result?.error || "Calendar projection failed", response.status || 503, result?.code || "CALENDAR_PROJECTION_FAILED");
  }
  return result;
}

async function createTask(request: Request) {
  let input;
  try { input = await request.json(); }
  catch { throw new ApiError("Request body must be valid JSON", 400, "INVALID_JSON"); }
  const dueDate = Object.hasOwn(input, "dueDate") ? input.dueDate : input.date || shanghaiDate();
  if (dueDate && !validDate(dueDate)) throw new ApiError("dueDate must be YYYY-MM-DD", 400, "INVALID_DATE");
  const taskInput = { ...input, dueDate };
  const google = await allTasks(false);
  const duplicate = findDuplicateTask(taskInput, google.tasks);
  if (duplicate) {
    const changes: Record<string, unknown> = {};
    if (dueDate && dueDate !== duplicate.dueDate) changes.dueDate = dueDate;
    if (input.notes && input.notes !== duplicate.notes) changes.notes = input.notes;
    if (input.originalIntent && input.originalIntent !== duplicate.originalIntent) changes.originalIntent = input.originalIntent;
    let task = duplicate;
    if (Object.keys(changes).length) {
      const update = updateGoogleTaskPayload({
        ...changes,
        notes: Object.hasOwn(changes, "notes") ? changes.notes : duplicate.notes,
        originalIntent: Object.hasOwn(changes, "originalIntent") ? changes.originalIntent : duplicate.originalIntent,
      });
      task = toTaskModel(await googleRequest(google.accessToken, tasksPath(google.taskListId, duplicate.id), {
        method: "PATCH",
        body: JSON.stringify(update),
      }), google.taskListId);
    }
    console.info("Task Deduplicated", { taskId: task.id, taskListId: google.taskListId });
    const schedule = await scheduleProjection(task.id, input.schedule);
    return json({ task: { ...task, metadata: { ...task.metadata, deduplicated: true } }, deduplicated: true, schedule }, 200);
  }
  let taskBody;
  try { taskBody = createGoogleTaskPayload(taskInput); }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : "Invalid task", 400, "INVALID_TASK"); }
  const created = await googleRequest(google.accessToken, tasksPath(google.taskListId), { method: "POST", body: JSON.stringify(taskBody) });
  const task = toTaskModel(created, google.taskListId);
  console.info("Task Created", { taskId: task.id, taskListId: google.taskListId, source: "automation" });
  const schedule = await scheduleProjection(task.id, input.schedule);
  return json({ task, deduplicated: false, schedule }, 201);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !/^[0-9a-f-]{36}$/i.test(OWNER_USER_ID)
    || READ_TOKEN.length < 32 || WRITE_TOKEN.length < 32 || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || TOKEN_ENCRYPTION_KEY.length < 32) {
    return json({ error: "Server configuration incomplete" }, 503);
  }
  if (rateLimited(request)) return json({ error: "Too many requests" }, 429);
  const token = requestToken(request);
  const canWrite = constantTimeEqual(token, WRITE_TOKEN);
  const canRead = canWrite || constantTimeEqual(token, READ_TOKEN);
  if ((request.method === "GET" && !canRead) || (request.method === "POST" && !canWrite)) return json({ error: "Unauthorized" }, 401);

  try {
    if (request.method === "POST") return await createTask(request);
    const requestedDate = new URL(request.url).searchParams.get("date") || shanghaiDate();
    if (!validDate(requestedDate)) return json({ error: "date must be YYYY-MM-DD" }, 400);
    return json(await readStatus(requestedDate));
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const apiError = error instanceof ApiError
      ? error
      : new ApiError(timedOut ? "Google Tasks request timed out" : "Google Tasks service unavailable", 503, timedOut ? "API_TIMEOUT" : "SERVICE_UNAVAILABLE");
    console.error("Task Sync Failed", apiError.code, apiError.message);
    return json({ error: apiError.message, code: apiError.code }, apiError.status);
  }
});
