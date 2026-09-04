import {
  DEFAULT_TASK_LIST_TITLE,
  chooseTaskList,
  createGoogleTaskPayload,
  filterTaskModels,
  findDuplicateTask,
  toTaskModel,
  updateGoogleTaskPayload,
} from "../_shared/google-tasks-core.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
const TOKEN_ENCRYPTION_KEY = Deno.env.get("GOOGLE_TOKEN_ENCRYPTION_KEY") ?? "";
const WRITE_TOKEN = Deno.env.get("AUTOMATION_WRITE_TOKEN") ?? "";
const TASK_LIST_TITLE = Deno.env.get("GOOGLE_TASKS_LIST_TITLE") || DEFAULT_TASK_LIST_TITLE;
const GOOGLE_TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";
const REQUEST_TIMEOUT_MS = 10_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 500, code = "INTERNAL_ERROR") {
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

async function parseJson(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function requestWithTimeout(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function authenticatedUser(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) throw new ApiError("请先使用 Google 登录", 401, "AUTH_REQUIRED");
  const response = await requestWithTimeout(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: authorization },
  });
  const user = await parseJson(response);
  if (!response.ok || !user?.id) throw new ApiError("登录已过期，请重新登录", 401, "AUTH_REQUIRED");
  return user;
}

async function rpc(name: string, body: Record<string, unknown>) {
  const response = await requestWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await parseJson(response);
  if (!response.ok) throw new ApiError(payload?.message || "凭证存储不可用", 503, "CREDENTIAL_STORE_ERROR");
  return payload;
}

async function storedCredentials(userId: string) {
  const rows = await rpc("read_google_tasks_credentials", {
    target_owner: userId,
    encryption_key: TOKEN_ENCRYPTION_KEY,
  });
  const credentials = rows?.[0];
  if (!credentials?.refresh_token || !credentials?.tasklist_id) {
    throw new ApiError("尚未授权 Google Tasks，请点击“连接 Google Tasks”", 428, "GOOGLE_NOT_CONNECTED");
  }
  return credentials;
}

async function refreshGoogleAccessToken(refreshToken: string) {
  const response = await requestWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = await parseJson(response);
  if (!response.ok || !payload?.access_token) {
    throw new ApiError("Google 授权已失效，请重新授权", 401, "GOOGLE_REAUTH_REQUIRED");
  }
  return payload.access_token as string;
}

async function googleRequest(accessToken: string, path: string, init: RequestInit = {}) {
  const response = await requestWithTimeout(`${GOOGLE_TASKS_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    const message = payload?.error?.message || `Google Tasks 请求失败（${response.status}）`;
    const reason = payload?.error?.errors?.[0]?.reason || "";
    if (response.status === 401) throw new ApiError("Google 授权已失效，请重新授权", 401, "GOOGLE_REAUTH_REQUIRED");
    if (response.status === 404) throw new ApiError("Google Tasks 中找不到该任务", 404, "TASK_NOT_FOUND");
    if (response.status === 429 || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
      throw new ApiError("Google Tasks 请求过于频繁，请稍后重试", 429, "RATE_LIMITED");
    }
    if (response.status === 403 && /disabled|not been used|accessnotconfigured/i.test(`${reason} ${message}`)) {
      throw new ApiError("Google Tasks API 尚未启用", 503, "TASKS_API_DISABLED");
    }
    if (response.status === 403 && /insufficient|permission|scope/i.test(`${reason} ${message}`)) {
      throw new ApiError("Google Tasks 权限尚未授权，请重新连接", 403, "SCOPE_MISSING");
    }
    throw new ApiError(message, response.status, "GOOGLE_TASKS_ERROR");
  }
  return payload;
}

function taskPath(taskListId: string, taskId = "") {
  const list = encodeURIComponent(taskListId);
  return `/lists/${list}/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
}

async function listTaskLists(accessToken: string) {
  const taskLists = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await googleRequest(accessToken, `/users/@me/lists?${params}`);
    taskLists.push(...(page?.items || []).map((list: Record<string, unknown>) => ({
      id: String(list.id || ""),
      title: String(list.title || ""),
      updatedAt: list.updated || null,
    })));
    pageToken = page?.nextPageToken || "";
  } while (pageToken);
  return taskLists;
}

async function ensureTaskList(accessToken: string) {
  const taskLists = await listTaskLists(accessToken);
  const existing = chooseTaskList(taskLists, TASK_LIST_TITLE);
  if (existing) return existing;
  const created = await googleRequest(accessToken, "/users/@me/lists", {
    method: "POST",
    body: JSON.stringify({ title: TASK_LIST_TITLE }),
  });
  console.info("Task List Created", { taskListId: created.id, title: created.title });
  return { id: created.id, title: created.title, updatedAt: created.updated || null };
}

async function connect(userId: string, input: Record<string, unknown>) {
  const providerAccessToken = typeof input.provider_token === "string" ? input.provider_token : "";
  const providerRefreshToken = typeof input.provider_refresh_token === "string" ? input.provider_refresh_token : "";
  let existing = null;
  try { existing = await storedCredentials(userId); } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "GOOGLE_NOT_CONNECTED") throw error;
  }
  const refreshToken = providerRefreshToken || existing?.refresh_token || "";
  if (!refreshToken) throw new ApiError("Google 未返回离线刷新凭证，请重新同意授权", 400, "GOOGLE_REFRESH_TOKEN_MISSING");
  const accessToken = providerAccessToken || await refreshGoogleAccessToken(refreshToken);
  const taskList = await ensureTaskList(accessToken);
  await rpc("upsert_google_tasks_credentials", {
    target_owner: userId,
    new_refresh_token: refreshToken,
    new_tasklist_id: taskList.id,
    encryption_key: TOKEN_ENCRYPTION_KEY,
  });
  console.info("OAuth Connected", { userId, taskListId: taskList.id });
  return { connected: true, taskListId: taskList.id, taskListTitle: taskList.title };
}

async function context(userId: string) {
  const credentials = await storedCredentials(userId);
  const accessToken = await refreshGoogleAccessToken(credentials.refresh_token);
  return { ...credentials, accessToken };
}

async function listTasksWithContext(accessToken: string, taskListId: string, showCompleted: boolean) {
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
    const page = await googleRequest(accessToken, `${taskPath(taskListId)}?${params}`);
    tasks.push(...(page?.items || [])
      .filter((task: Record<string, unknown>) => !task.deleted)
      .map((task: Record<string, unknown>) => toTaskModel(task, taskListId)));
    pageToken = page?.nextPageToken || "";
  } while (pageToken);
  return tasks;
}

async function listTasks(userId: string, showCompleted: boolean) {
  const google = await context(userId);
  return listTasksWithContext(google.accessToken, google.tasklist_id, showCompleted);
}

async function patchTaskWithContext(accessToken: string, taskListId: string, id: string, changes: Record<string, unknown>) {
  if (!id) throw new ApiError("id is required", 400, "INVALID_TASK");
  let mergedChanges = changes;
  if (Object.hasOwn(changes, "notes") || Object.hasOwn(changes, "originalIntent")) {
    const current = toTaskModel(await googleRequest(accessToken, taskPath(taskListId, id)), taskListId);
    mergedChanges = {
      ...changes,
      notes: Object.hasOwn(changes, "notes") ? changes.notes : current.notes,
      originalIntent: Object.hasOwn(changes, "originalIntent") ? changes.originalIntent : current.originalIntent,
    };
  }
  let payload;
  try { payload = updateGoogleTaskPayload(mergedChanges); }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : "任务参数无效", 400, "INVALID_TASK"); }
  if (!Object.keys(payload).length) throw new ApiError("没有可更新的 Google Tasks 字段", 400, "NO_SUPPORTED_CHANGES");
  const task = await googleRequest(accessToken, taskPath(taskListId, id), { method: "PATCH", body: JSON.stringify(payload) });
  return toTaskModel(task, taskListId);
}

async function createTask(userId: string, input: Record<string, unknown>) {
  const google = await context(userId);
  const taskListId = String(input.taskListId || google.tasklist_id);
  let payload;
  try { payload = createGoogleTaskPayload(input); }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : "任务参数无效", 400, "INVALID_TASK"); }
  const duplicate = findDuplicateTask(input, await listTasksWithContext(google.accessToken, taskListId, false));
  if (duplicate) {
    const changes: Record<string, unknown> = {};
    const dueDate = String(input.dueDate || input.due || input.date || "");
    if (dueDate && dueDate !== duplicate.dueDate) changes.dueDate = dueDate;
    if (input.notes && input.notes !== duplicate.notes) changes.notes = input.notes;
    if (input.originalIntent && input.originalIntent !== duplicate.originalIntent) changes.originalIntent = input.originalIntent;
    const task = Object.keys(changes).length
      ? await patchTaskWithContext(google.accessToken, taskListId, duplicate.id, changes)
      : duplicate;
    console.info("Task Deduplicated", { taskId: task.id, taskListId });
    return { task: { ...task, metadata: { ...task.metadata, deduplicated: true } }, deduplicated: true };
  }
  const task = await googleRequest(google.accessToken, taskPath(taskListId), { method: "POST", body: JSON.stringify(payload) });
  const model = toTaskModel(task, taskListId);
  console.info("Task Created", { taskId: model.id, taskListId });
  return { task: model, deduplicated: false };
}

async function patchTask(userId: string, id: string, changes: Record<string, unknown>) {
  const google = await context(userId);
  const task = await patchTaskWithContext(google.accessToken, google.tasklist_id, id, changes);
  const event = task.status === "completed" ? "Task Completed" : changes.status ? "Task Reopened" : "Task Updated";
  console.info(event, { taskId: id, taskListId: google.tasklist_id });
  return task;
}

async function schedulerSync(action: string, taskId: string, extra: Record<string, unknown> = {}) {
  if (WRITE_TOKEN.length < 32) return { success: false, code: "SCHEDULER_NOT_CONFIGURED" };
  try {
    const response = await requestWithTimeout(`${SUPABASE_URL}/functions/v1/task-scheduler`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WRITE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, task_id: taskId, ...extra }),
    });
    const result = await parseJson(response);
    return response.ok ? result : { success: false, code: result?.code || "CALENDAR_SYNC_FAILED", error: result?.error || "Calendar sync failed" };
  } catch (error) {
    return { success: false, code: "CALENDAR_SYNC_FAILED", error: error instanceof Error ? error.message : "Calendar sync failed" };
  }
}

async function deleteTask(userId: string, id: string) {
  if (!id) throw new ApiError("id is required", 400, "INVALID_TASK");
  const google = await context(userId);
  await googleRequest(google.accessToken, taskPath(google.tasklist_id, id), { method: "DELETE" });
  console.info("Task Deleted", { taskId: id, taskListId: google.tasklist_id });
}

async function getTaskBeforeDelete(userId: string, id: string) {
  if (!id) throw new ApiError("id is required", 400, "INVALID_TASK");
  const google = await context(userId);
  const task = await googleRequest(google.accessToken, taskPath(google.tasklist_id, id));
  return toTaskModel(task, google.tasklist_id);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || TOKEN_ENCRYPTION_KEY.length < 32) {
    return json({ error: "Google Tasks 服务端配置不完整", code: "SERVER_CONFIGURATION_ERROR" }, 503);
  }
  try {
    const user = await authenticatedUser(request);
    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.get("resource") === "tasklists") {
        const google = await context(user.id);
        return json({ taskLists: await listTaskLists(google.accessToken), selectedTaskListId: google.tasklist_id });
      }
      const showCompleted = url.searchParams.get("showCompleted") === "true";
      const filter = url.searchParams.get("filter") || (showCompleted ? "all" : "open");
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      const tasks = await listTasks(user.id, showCompleted || filter === "completed" || filter === "all");
      return json({ tasks: filterTaskModels(tasks, filter, date) });
    }
    let input: Record<string, unknown> = {};
    try { input = await request.json(); } catch { throw new ApiError("请求正文必须是 JSON", 400, "INVALID_JSON"); }
    if (request.method === "POST" && input.action === "connect") return json(await connect(user.id, input));
    if (request.method === "POST" && input.action === "create") {
      const result = await createTask(user.id, (input.task || {}) as Record<string, unknown>);
      const schedule = (input.task as Record<string, unknown> | undefined)?.schedule as Record<string, unknown> | undefined;
      const projection = schedule ? await schedulerSync("schedule", result.task.id, { schedule }) : null;
      return json({ ...result, projection }, result.deduplicated ? 200 : 201);
    }
    if (request.method === "PATCH" && input.action === "complete") {
      const task = await patchTask(user.id, String(input.id || ""), { status: input.completed === false ? "open" : "completed" });
      return json({ task, projection: await schedulerSync("sync_task", task.id) });
    }
    if (request.method === "PATCH" && input.action === "reopen") {
      const task = await patchTask(user.id, String(input.id || ""), { status: "open" });
      return json({ task, projection: await schedulerSync("sync_task", task.id) });
    }
    if (request.method === "PATCH" && input.action === "update") {
      const task = await patchTask(user.id, String(input.id || ""), (input.changes || {}) as Record<string, unknown>);
      return json({ task, projection: await schedulerSync("sync_task", task.id) });
    }
    if (request.method === "DELETE") {
      const id = String(input.id || "");
      let title = "已取消任务";
      try { title = (await getTaskBeforeDelete(user.id, id)).title || title; } catch { /* deletion still uses Google Tasks as truth */ }
      await deleteTask(user.id, id);
      return json({ deleted: true, projection: await schedulerSync("cancel_task", id, { title }) });
    }
    throw new ApiError("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const apiError = error instanceof ApiError
      ? error
      : new ApiError(timedOut ? "Google Tasks 请求超时，请重试" : "Google Tasks 服务暂时不可用", 503, timedOut ? "API_TIMEOUT" : "SERVICE_UNAVAILABLE");
    console.error("Task Sync Failed", apiError.code, apiError.message);
    return json({ error: apiError.message, code: apiError.code }, apiError.status);
  }
});
