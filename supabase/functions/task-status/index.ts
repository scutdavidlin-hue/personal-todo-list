import { buildStatus, shanghaiDate, validDate } from "./status-core.js";
import {
  createGoogleTaskPayload,
  toTaskModel,
  updateGoogleTaskPayload,
} from "../_shared/google-tasks-core.js";
import { resolveServiceApiKey, serviceApiHeaders } from "../_shared/supabase-api-keys.js";
import { buildTaskExecutionGraph } from "../_shared/task-graph-core.js";
import { applyTaskSchedulePatch } from "../_shared/schedule-core.js";
import {
  createTaskResolutionAdapter,
  enrichTaskCandidates,
  loadTaskResolutionContext,
  resolveAndExecuteTask,
  taskResolutionPreview,
} from "../_shared/task-resolution-runtime.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const USE_NEW_API_KEYS = Deno.env.get("SUPABASE_USE_NEW_API_KEYS") === "true";
const SERVICE_API_KEY = resolveServiceApiKey({
  secretKeys: Deno.env.get("SUPABASE_SECRET_KEYS"),
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  preferNew: USE_NEW_API_KEYS,
});
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
    headers: { ...serviceApiHeaders(SERVICE_API_KEY), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await payload(response);
  if (!response.ok) throw new ApiError(data?.message || "Credential store unavailable", 503, "CREDENTIAL_STORE_ERROR");
  return data;
}

async function serviceRest(path: string, init: RequestInit = {}) {
  const response = await requestWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...serviceApiHeaders(SERVICE_API_KEY),
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await payload(response);
  if (!response.ok) throw new ApiError(data?.message || "Task resolution store unavailable", 503, "TASK_RESOLUTION_STORE_ERROR");
  return data;
}

async function readSchedules() {
  const query = new URLSearchParams({ owner_id: `eq.${OWNER_USER_ID}`, select: "*", order: "scheduled_date.asc,scheduled_start.asc" });
  const response = await requestWithTimeout(`${SUPABASE_URL}/rest/v1/task_schedule_metadata?${query}`, {
    headers: serviceApiHeaders(SERVICE_API_KEY),
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

async function allTasks(showCompleted = true, options: Record<string, unknown> = {}) {
  const { accessToken, taskListId } = await googleContext();
  const tasks = [];
  let pageToken = "";
  const maxTasks = Math.max(1, Math.min(5_000, Number(options.maxTasks || 5_000)));
  do {
    const params = new URLSearchParams({
      maxResults: String(Math.min(100, maxTasks - tasks.length)),
      showCompleted: String(showCompleted),
      showHidden: String(showCompleted),
      showDeleted: "false",
    });
    if (options.completedMin) params.set("completedMin", String(options.completedMin));
    if (options.updatedMin) params.set("updatedMin", String(options.updatedMin));
    if (pageToken) params.set("pageToken", pageToken);
    const page = await googleRequest(accessToken, `${tasksPath(taskListId)}?${params}`);
    tasks.push(...(page?.items || [])
      .filter((task: Record<string, unknown>) => !task.deleted)
      .map((task: Record<string, unknown>) => toTaskModel(task, taskListId)));
    pageToken = page?.nextPageToken || "";
  } while (pageToken && tasks.length < maxTasks);
  if (pageToken) throw new ApiError("Task candidate retrieval was truncated; refusing unsafe creation", 503, "TASK_SEARCH_INCOMPLETE");
  return { accessToken, taskListId, tasks };
}

async function readStatus(targetDate: string) {
  const [google, schedules] = await Promise.all([allTasks(true), readSchedules()]);
  return buildStatus(google.tasks, targetDate, new Date(), schedules);
}

async function readCanonicalTask(id: string) {
  if (!id) throw new ApiError("task_id is required", 400, "INVALID_TASK");
  const google = await googleContext();
  const task = toTaskModel(await googleRequest(google.accessToken, tasksPath(google.taskListId, id)), google.taskListId);
  const schedule = (await readSchedules()).find((row: Record<string, unknown>) => row.google_task_id === id) || null;
  return { task, schedule };
}

async function readAutonomyContext(input: Record<string, unknown>) {
  const current = input.task_id ? await readCanonicalTask(String(input.task_id)) : null;
  const context: Record<string, unknown> = {
    current_task: current ? {
      ...current.task,
      requested_date: current.schedule?.scheduled_date || current.task.dueDate,
      requested_time: current.schedule?.scheduled_start,
    } : null,
    calendar_events: [],
    context_warnings: [],
  };
  if (input.travel !== true) return context;
  try {
    const google = await googleContext();
    const params = new URLSearchParams({
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "250",
    });
    const response = await requestWithTimeout(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${google.accessToken}` },
    });
    const result = await payload(response);
    if (!response.ok) throw new Error("Calendar context unavailable");
    context.calendar_events = (result?.items || [])
      .filter((event: Record<string, unknown>) => /旅行|旅游|入住|酒店|亚朵|出差/.test(String(event.summary || "")))
      .map((event: { summary?: string; start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } }) => ({
        title: event.summary,
        start_date: (event.start?.date || event.start?.dateTime || "").slice(0, 10),
        end_date: (event.end?.date || event.end?.dateTime || "").slice(0, 10),
      }));
  } catch {
    context.context_warnings = ["Calendar context unavailable; using remaining context priorities"];
  }
  return context;
}

async function updateCanonicalTask(input: Record<string, unknown>) {
  const id = String(input.task_id || "");
  const current = await readCanonicalTask(id);
  const patch = (input.changes || {}) as Record<string, unknown>;
  const changes = Object.fromEntries(["title", "notes", "dueDate"].filter((key) => Object.hasOwn(patch, key)).map((key) => [key, patch[key]]));
  if (Object.hasOwn(patch, "requested_date")) changes.dueDate = patch.requested_date;
  const google = await googleContext();
  let task = current.task;
  if (Object.keys(changes).length) {
    const body = updateGoogleTaskPayload({ ...changes, originalIntent: current.task.originalIntent });
    task = toTaskModel(await googleRequest(google.accessToken, tasksPath(google.taskListId, id), {
      method: "PATCH", body: JSON.stringify(body),
    }), google.taskListId);
  }
  const schedulePatch = applyTaskSchedulePatch(current.schedule, patch, task.dueDate);
  const scheduleInput = schedulePatch.schedule;
  let schedule = null;
  let projectionError = null;
  try { schedule = await scheduleProjection(id, scheduleInput); }
  catch { projectionError = "Calendar projection pending; retry the same task id"; }
  const expectedSchedule = Object.fromEntries([
    ...(Object.hasOwn(patch, "requested_time") ? [["scheduled_start", patch.requested_time]] : []),
    ...(Object.hasOwn(patch, "requested_date") ? [["scheduled_date", patch.requested_date]] : []),
  ]);
  return json({ task, schedule, expected_schedule: expectedSchedule, projection_error: projectionError, write_success: Object.keys(changes).length > 0 || Boolean(schedule) || schedulePatch.touched, resolution: { decision: "UPDATE" } });
}

async function readTaskGraph() {
  const completedMin = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const google = await allTasks(true, { completedMin, maxTasks: 1_000 });
  const profileQuery = new URLSearchParams({
    owner_id: `eq.${OWNER_USER_ID}`,
    superseded_by: "is.null",
    select: "*",
    order: "updated_at.desc",
    limit: "1000",
  });
  const relationshipQuery = new URLSearchParams({
    owner_id: `eq.${OWNER_USER_ID}`,
    active: "eq.true",
    superseded_at: "is.null",
    select: "*",
    order: "updated_at.desc",
    limit: "2000",
  });
  const [profiles, relationships] = await Promise.all([
    serviceRest(`task_resolution_profiles?${profileQuery}`),
    serviceRest(`task_relationships?${relationshipQuery}`),
  ]);
  const tasks = enrichTaskCandidates(google.tasks, profiles || []);
  const nativeParentRelationships = tasks
    .filter((task) => task.parent_task_id)
    .map((task) => ({
      relationship_type: "PARENT_OF",
      from_task_id: task.parent_task_id,
      to_task_id: task.id,
      confidence: 1,
      reason: "Google Tasks native parent relationship.",
    }));
  const graph = buildTaskExecutionGraph(tasks, [...(relationships || []), ...nativeParentRelationships]);
  return { success: true, generated_at: new Date().toISOString(), task_list_id: google.taskListId, ...graph };
}

async function explainResolution(url: URL) {
  const auditId = String(url.searchParams.get("audit_id") || "").trim();
  const taskId = String(url.searchParams.get("task_id") || "").trim();
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 10)));
  const query = new URLSearchParams({
    owner_id: `eq.${OWNER_USER_ID}`,
    select: "*",
    order: "created_at.desc",
    limit: String(limit),
  });
  if (auditId) query.set("id", `eq.${auditId}`);
  else if (taskId) query.set("canonical_task_id", `eq.${taskId}`);
  const rows = await serviceRest(`task_resolution_audit?${query}`) || [];
  return {
    success: true,
    count: rows.length,
    resolutions: rows.map(({ owner_id: _ownerId, ...row }: Record<string, unknown>) => row),
  };
}

async function previewTaskResolution(input: Record<string, unknown>) {
  const taskInput = input.task && typeof input.task === "object" && !Array.isArray(input.task)
    ? input.task as Record<string, unknown>
    : input;
  const incoming = {
    ...taskInput,
    raw_text: taskInput.raw_text || taskInput.originalIntent || taskInput.title,
    goal_plan_id: taskInput.goal_plan_id || taskInput.goal_id || null,
  };
  const completedMin = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const google = await allTasks(true, { completedMin, maxTasks: 5_000 });
  const schedulesForPreview = await readSchedules();
  const previewById = new Map<string, Record<string, any>>(schedulesForPreview.map((row: Record<string, any>) => [String(row.google_task_id), row]));
  const context = await loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER_USER_ID,
    incoming,
    providerTasks: google.tasks.map((task: Record<string, any>) => ({ ...task, schedule: previewById.get(task.id) || null, task_type: previewById.get(task.id)?.task_type || "task", follow_up_of: previewById.get(task.id)?.follow_up_of || null })),
    options: { openLimit: 5_000 },
    providerGetTask: async (id: string) => toTaskModel(
      await googleRequest(google.accessToken, tasksPath(google.taskListId, id)),
      google.taskListId,
    ),
  });
  return { success: true, resolution: taskResolutionPreview(incoming, context) };
}

async function scheduleProjection(taskId: string, schedule: unknown) {
  if (!schedule) return null;
  if (typeof schedule !== "object" || Array.isArray(schedule)) throw new ApiError("Invalid schedule", 400, "INVALID_SCHEDULE");
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

async function createTask(input: Record<string, unknown>) {
  if (!String(input.title || "").trim()) throw new ApiError("title is required", 400, "INVALID_TASK");
  const dueDate = Object.hasOwn(input, "dueDate") ? input.dueDate : input.date || shanghaiDate();
  if (dueDate && !validDate(dueDate)) throw new ApiError("dueDate must be YYYY-MM-DD", 400, "INVALID_DATE");
  const taskInput = {
    ...input,
    dueDate,
    raw_text: input.raw_text || input.originalIntent || input.title,
    goal_plan_id: input.goal_plan_id || input.goal_id || null,
  };
  const completedMin = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const google = await allTasks(true, { completedMin, maxTasks: 5_000 });
  const scheduleRows = await readSchedules();
  const scheduleById = new Map<string, Record<string, any>>(scheduleRows.map((row: Record<string, any>) => [String(row.google_task_id), row]));
  const candidates = google.tasks.map((task: Record<string, any>) => ({ ...task, schedule: scheduleById.get(task.id) || null, task_type: scheduleById.get(task.id)?.task_type || "task", follow_up_of: scheduleById.get(task.id)?.follow_up_of || null }));
  const resolutionContext = await loadTaskResolutionContext({
    serviceRest,
    ownerId: OWNER_USER_ID,
    incoming: taskInput,
    providerTasks: candidates,
    options: { openLimit: 5_000 },
    providerGetTask: async (id: string) => toTaskModel(
      await googleRequest(google.accessToken, tasksPath(google.taskListId, id)),
      google.taskListId,
    ),
  });
  const provider = {
    getTask: async (id: string) => toTaskModel(
      await googleRequest(google.accessToken, tasksPath(google.taskListId, id)),
      google.taskListId,
    ),
    createTask: async (task: Record<string, unknown>, metadata: Record<string, unknown> = {}) => {
      let taskBody;
      try { taskBody = createGoogleTaskPayload(task); }
      catch (error) { throw new ApiError(error instanceof Error ? error.message : "Invalid task", 400, "INVALID_TASK"); }
      const params = new URLSearchParams();
      const parentId = metadata.parent_task_id || task.parent_task_id;
      if (parentId) {
        await googleRequest(google.accessToken, tasksPath(google.taskListId, String(parentId)));
        params.set("parent", String(parentId));
      }
      const query = params.toString();
      const path = `${tasksPath(google.taskListId)}${query ? `?${query}` : ""}`;
      const created = await googleRequest(google.accessToken, path, { method: "POST", body: JSON.stringify(taskBody) });
      return toTaskModel(created, google.taskListId);
    },
    updateTask: async (id: string, changes: Record<string, unknown>) => {
      const current = toTaskModel(
        await googleRequest(google.accessToken, tasksPath(google.taskListId, id)),
        google.taskListId,
      );
      let taskBody;
      try {
        taskBody = updateGoogleTaskPayload({
          ...changes,
          notes: Object.hasOwn(changes, "notes") ? changes.notes : current.notes,
          originalIntent: Object.hasOwn(changes, "originalIntent") ? changes.originalIntent : current.originalIntent,
        });
      } catch (error) {
        throw new ApiError(error instanceof Error ? error.message : "Invalid task update", 400, "INVALID_TASK");
      }
      const updated = await googleRequest(google.accessToken, tasksPath(google.taskListId, id), {
        method: "PATCH",
        body: JSON.stringify(taskBody),
      });
      return toTaskModel(updated, google.taskListId);
    },
  };
  const adapter = createTaskResolutionAdapter({
    ownerId: OWNER_USER_ID,
    taskListId: google.taskListId,
    intakeAuditId: String(input.intake_audit_id || "") || null,
    resolutionIdempotencyKey: String(input.resolution_idempotency_key || "") || null,
    createdFrom: String(input.source || "personal_os_intake"),
    projectId: input.project_id || null,
    projectGoalId: resolutionContext.project_goal_id || null,
    serviceRest,
    provider,
  });
  let result;
  try { result = await resolveAndExecuteTask(taskInput, resolutionContext, adapter); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "TASK_TARGET_AMBIGUOUS") {
      throw new ApiError("存在多个同名事项，需要指定要修改的任务。", 409, "TASK_TARGET_AMBIGUOUS");
    }
    throw error;
  }
  const task = result.task;
  let schedule = null;
  let projectionError = null;
  const existingSchedule = scheduleById.get(task.id);
  const projectionInput = result.resolution.decision === "DUPLICATE"
    ? existingSchedule?.sync_required ? existingSchedule : null
    : input.schedule;
  try { schedule = projectionInput ? await scheduleProjection(task.id, projectionInput) : existingSchedule ? { schedule: existingSchedule } : null; }
  catch { projectionError = "Calendar projection pending; retry the same task id"; }
  const deduplicated = result.resolution.decision === "DUPLICATE";
  console.info("Task Resolved", {
    taskId: task.id,
    taskListId: google.taskListId,
    decision: result.resolution.decision,
    auditId: result.resolution.audit_id,
  });
  return json({
    task: deduplicated ? { ...task, metadata: { ...task.metadata, deduplicated: true } } : task,
    tasks: result.tasks,
    deduplicated,
    resolution: result.resolution,
    relationships: result.relationships,
    goal_link: result.goal_link,
    context_link: result.context_link,
    schedule,
    projection_error: projectionError,
    write_success: result.created || result.updated || Boolean(projectionInput && schedule),
  }, result.created ? 201 : 200);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_API_KEY || !/^[0-9a-f-]{36}$/i.test(OWNER_USER_ID)
    || READ_TOKEN.length < 32 || WRITE_TOKEN.length < 32 || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || TOKEN_ENCRYPTION_KEY.length < 32) {
    return json({ error: "Server configuration incomplete" }, 503);
  }
  if (rateLimited(request)) return json({ error: "Too many requests" }, 429);
  const token = requestToken(request);
  const canWrite = constantTimeEqual(token, WRITE_TOKEN);
  const canRead = canWrite || constantTimeEqual(token, READ_TOKEN);
  if ((request.method === "GET" && !canRead) || (request.method === "POST" && !canWrite)) return json({ error: "Unauthorized" }, 401);

  try {
    if (request.method === "POST") {
      let input: Record<string, unknown>;
      try { input = await request.json(); }
      catch { throw new ApiError("Request body must be valid JSON", 400, "INVALID_JSON"); }
      if (input.action === "preview_resolution") return json(await previewTaskResolution(input));
      if (input.action === "read_task") return json(await readCanonicalTask(String(input.task_id || "")));
      if (input.action === "autonomy_context") return json(await readAutonomyContext(input));
      if (input.action === "update_task") return await updateCanonicalTask(input);
      return await createTask(input);
    }
    const url = new URL(request.url);
    if (url.searchParams.get("resource") === "graph") return json(await readTaskGraph());
    if (url.searchParams.get("resource") === "resolution") return json(await explainResolution(url));
    const requestedDate = url.searchParams.get("date") || shanghaiDate();
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
