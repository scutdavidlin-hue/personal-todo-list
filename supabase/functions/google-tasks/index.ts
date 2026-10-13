import { applyTaskSchedulePatch } from "../_shared/schedule-core.js";
import { writeReceipt } from "../_shared/write-receipt.js";
import {
  GoogleProviderError,
  assertAuthenticatedGoogleIdentity,
  assertSameGoogleSubject,
  coordinatedGoogleAccess,
  googleSubjectForAccessToken,
  googleJsonRequest,
  proveLegacyTaskList,
  probeGoogleCapabilities,
  providerErrorDiagnostic,
  refreshGoogleAccessToken,
  selectRefreshToken,
} from "../_shared/google-auth-runtime.js";
import {
  DEFAULT_TASK_LIST_TITLE,
  chooseTaskList,
  createGoogleTaskPayload,
  filterTaskModels,
  markTaskCancelledNotes,
  toTaskModel,
  updateGoogleTaskPayload,
} from "../_shared/google-tasks-core.js";
import {
  resolvePublishableApiKey,
  resolveServiceApiKey,
  serviceApiHeaders,
} from "../_shared/supabase-api-keys.js";
import {
  createTaskResolutionAdapter,
  loadTaskResolutionContext,
  resolveAndExecuteTask,
} from "../_shared/task-resolution-runtime.js";
import { canonicalTaskMutation, googleTaskChanges, hasScheduleChanges, normalizeTaskPatch, searchTaskViews, taskStateFingerprint, taskView } from "../_shared/task-lifecycle-core.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const USE_NEW_API_KEYS = Deno.env.get("SUPABASE_USE_NEW_API_KEYS") === "true";
const SERVICE_API_KEY = resolveServiceApiKey({
  secretKeys: Deno.env.get("SUPABASE_SECRET_KEYS"),
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  preferNew: USE_NEW_API_KEYS,
});
const SUPABASE_PUBLIC_KEY = resolvePublishableApiKey({
  publishableKeys: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
  anonKey: Deno.env.get("SUPABASE_ANON_KEY"),
  preferNew: USE_NEW_API_KEYS,
});
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
const TOKEN_ENCRYPTION_KEY = Deno.env.get("GOOGLE_TOKEN_ENCRYPTION_KEY") ?? "";
const WRITE_TOKEN = Deno.env.get("AUTOMATION_WRITE_TOKEN") ?? "";
const TASK_LIST_TITLE = Deno.env.get("GOOGLE_TASKS_LIST_TITLE") || DEFAULT_TASK_LIST_TITLE;
const GOOGLE_TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";
const REQUEST_TIMEOUT_MS = 10_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  providerLayer: string;
  providerStatus: number | null;
  providerCode: string;
  constructor(message: string, status = 500, code = "INTERNAL_ERROR", diagnostic: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = diagnostic.retryable === true;
    this.providerLayer = String(diagnostic.provider_layer || "");
    this.providerStatus = Number.isInteger(diagnostic.provider_status) ? Number(diagnostic.provider_status) : null;
    this.providerCode = String(diagnostic.provider_code || "");
  }
}

function providerApiError(error: unknown, overrides: Record<string, unknown> = {}) {
  const diagnostic = providerErrorDiagnostic(error);
  if (!diagnostic) return null;
  return new ApiError(
    String(overrides.message || diagnostic.error),
    Number(overrides.status || diagnostic.status),
    String(overrides.code || diagnostic.code),
    diagnostic,
  );
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
  let response;
  try {
    response = await requestWithTimeout(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: authorization },
    });
  } catch {
    throw new ApiError("登录服务暂时不可用，请稍后重试", 503, "AUTH_SERVICE_UNAVAILABLE", { retryable: true, provider_layer: "supabase_auth" });
  }
  const user = await parseJson(response);
  if (response.status === 401 || response.status === 403) throw new ApiError("登录已过期，请重新登录", 401, "AUTH_REQUIRED");
  if (response.status === 429 || response.status >= 500) {
    throw new ApiError("登录服务暂时不可用，请稍后重试", response.status === 429 ? 429 : 503, "AUTH_SERVICE_UNAVAILABLE", {
      retryable: true,
      provider_layer: "supabase_auth",
      provider_status: response.status,
    });
  }
  if (!response.ok || !user?.id) throw new ApiError("登录状态暂时无法核实", 503, "AUTH_SERVICE_UNAVAILABLE", { retryable: true, provider_layer: "supabase_auth", provider_status: response.status });
  return user;
}

async function rpc(name: string, body: Record<string, unknown>) {
  const response = await requestWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      ...serviceApiHeaders(SERVICE_API_KEY),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await parseJson(response);
  if (!response.ok) throw new ApiError(payload?.message || "凭证存储不可用", 503, "CREDENTIAL_STORE_ERROR");
  return payload;
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
  const payload = await parseJson(response);
  if (!response.ok) throw new ApiError(payload?.message || "Task resolution store unavailable", 503, "TASK_RESOLUTION_STORE_ERROR");
  return payload;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
    .map((key) => [key, sortObject((value as Record<string, unknown>)[key])]));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function updateCreateAudit(ownerId: string, auditId: string, changes: Record<string, unknown>) {
  const query = new URLSearchParams({ id: `eq.${auditId}`, owner_id: `eq.${ownerId}` });
  await serviceRest(`personal_os_intake_audit?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(changes),
  });
}

async function updateActivity(ownerId: string, id: string, changes: Record<string, unknown>) {
  await serviceRest(`task_activity_log?${new URLSearchParams({ id: `eq.${id}`, owner_id: `eq.${ownerId}` })}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(changes) });
}

async function reserveActivity(request: Request, ownerId: string, action: string, taskId: string, input: Record<string, unknown>) {
  if (!taskId) throw new ApiError("task_id is required", 400, "INVALID_TASK");
  const idempotencyKey = String(request.headers.get("idempotency-key") || input.idempotency_key || "").trim() || `legacy:${crypto.randomUUID()}`;
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) throw new ApiError("idempotency_key must contain 8-200 characters", 400, "INVALID_IDEMPOTENCY_KEY");
  const requestHash = await sha256(canonicalTaskMutation(action, taskId, input));
  const inserted = await serviceRest("task_activity_log?on_conflict=owner_id%2Cidempotency_key", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ owner_id: ownerId, task_id: taskId, google_task_id: taskId, action, idempotency_key: idempotencyKey, request_hash: requestHash, source: input.source || "personal_os", request_id: input.request_id || null, status: "processing" }) });
  if (inserted?.[0]) return { row: inserted[0], idempotencyKey, replayed: false };
  const rows = await serviceRest(`task_activity_log?${new URLSearchParams({ select: "*", owner_id: `eq.${ownerId}`, idempotency_key: `eq.${idempotencyKey}`, limit: "1" })}`);
  const existing = rows?.[0];
  if (!existing) throw new ApiError("Idempotency record unavailable", 503, "IDEMPOTENCY_UNAVAILABLE");
  if (existing.request_hash !== requestHash) throw new ApiError("Idempotency key was already used for a different request", 409, "IDEMPOTENCY_CONFLICT");
  if (existing.status === "succeeded" && existing.response) return { row: existing, idempotencyKey, replayed: true };
  const touched = Date.parse(existing.updated_at || "");
  if (existing.status === "processing" && Number.isFinite(touched) && Date.now() - touched < 120_000) {
    throw new ApiError("相同修改仍在核实中，请勿重复提交", 409, "IDEMPOTENCY_IN_PROGRESS");
  }
  await updateActivity(ownerId, existing.id, { status: "processing", error: null, response: null, response_status: null });
  return { row: existing, idempotencyKey, replayed: false };
}

async function schedulesFor(ownerId: string, taskId = "") {
  const query = new URLSearchParams({ select: "*", owner_id: `eq.${ownerId}`, deleted_at: "is.null", order: "updated_at.desc" });
  if (taskId) query.set("google_task_id", `eq.${taskId}`);
  return serviceRest(`task_schedule_metadata?${query}`);
}

async function reserveCreateAudit(request: Request, ownerId: string, input: Record<string, unknown>) {
  const task = input.task && typeof input.task === "object" && !Array.isArray(input.task)
    ? input.task as Record<string, unknown>
    : {};
  const suppliedKey = String(request.headers.get("idempotency-key") || input.idempotency_key || task.idempotency_key || "").trim();
  const idempotencyKey = suppliedKey || `legacy:${crypto.randomUUID()}`;
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new ApiError("idempotency_key must contain 8-200 characters", 400, "INVALID_IDEMPOTENCY_KEY");
  }
  const requestHash = await sha256(JSON.stringify(sortObject({ action: "create", task })));
  const rawText = String(task.raw_text || task.originalIntent || task.title || "Create Task").trim().slice(0, 10_000) || "Create Task";
  const source = String(task.source || input.source || "personal_os_app").trim().slice(0, 80) || "personal_os_app";
  const inserted = await serviceRest("personal_os_intake_audit?on_conflict=owner_id%2Cidempotency_key", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      owner_id: ownerId,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      source,
      raw_text: rawText,
      classification: "task",
      destination: "google_tasks",
      status: "processing",
      stage: "received",
      received_at: new Date().toISOString(),
      request_payload: {type:"task",title:task.title,notes:task.notes || "",raw_text:rawText,due:task.dueDate || task.due || task.date || null,timezone:(task.schedule as any)?.timezone || task.timezone || "Asia/Shanghai",requested_date:(task.schedule as any)?.scheduled_date || task.dueDate || null,requested_time:(task.schedule as any)?.scheduled_start || null,schedule:task.schedule || null,recurrence:task.recurrence || null},
      lease_owner: crypto.randomUUID(),
      lease_expires_at: new Date(Date.now()+120_000).toISOString(),
    }),
  });
  if (inserted?.[0]) return { row: inserted[0], idempotencyKey, replayed: false };

  const query = new URLSearchParams({
    owner_id: `eq.${ownerId}`,
    idempotency_key: `eq.${idempotencyKey}`,
    select: "*",
    limit: "1",
  });
  const existing = (await serviceRest(`personal_os_intake_audit?${query}`))?.[0];
  if (!existing) throw new ApiError("Idempotency record unavailable", 503, "IDEMPOTENCY_UNAVAILABLE");
  if (existing.request_hash !== requestHash) {
    throw new ApiError("Idempotency key was already used for a different request", 409, "IDEMPOTENCY_CONFLICT");
  }
  if (existing.status === "succeeded" && existing.response) {
    return { row: existing, idempotencyKey, replayed: true };
  }
  const updatedAt = Date.parse(existing.updated_at || "");
  if (existing.status === "processing" && Number.isFinite(updatedAt) && Date.now() - updatedAt < 120_000) {
    throw new ApiError("An identical Task creation is still processing", 409, "IDEMPOTENCY_IN_PROGRESS");
  }
  const recovered = await intakeProxy(ownerId,"recover",{request_id:existing.id});
  const id = recovered.id || recovered.object_id;
  if (id) {
    const task = await getTaskView(ownerId,String(id));
    return {row:{...existing,response:{...recovered,task,receipt:recovered.receipt || writeReceipt({requestId:existing.id,taskId:task.id,taskVerified:true,error:recovered.success ? null : {code:recovered.code || "RECOVERY_PENDING"}})},response_status:recovered.success ? 200 : 202},idempotencyKey,replayed:true};
  }
  throw new ApiError("原请求写入结果待核实，请在提醒与同步中查看",409,"WRITE_OUTCOME_UNKNOWN");
}

async function storedCredentials(userId: string) {
  const rows = await rpc("read_google_auth_credentials", {
    target_owner: userId,
    encryption_key: TOKEN_ENCRYPTION_KEY,
  });
  const credentials = rows?.[0];
  if (!credentials?.refresh_token || !credentials?.tasklist_id) {
    throw new ApiError("尚未授权 Google Tasks，请点击“连接 Google Tasks”", 428, "GOOGLE_NOT_CONNECTED");
  }
  return credentials;
}

async function coordinatedContext(ownerId: string) {
  return coordinatedGoogleAccess({
    ownerId, encryptionKey: TOKEN_ENCRYPTION_KEY, rpc,
    clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET,
  });
}

async function googleRequest(accessToken: string, path: string, init: RequestInit = {}) {
  try {
    return await googleJsonRequest({
      accessToken,
      url: `${GOOGLE_TASKS_BASE}${path}`,
      init,
      providerLayer: "tasks",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof GoogleProviderError && error.code === "GOOGLE_OBJECT_NOT_FOUND") {
      throw providerApiError(error, { message: "Google Tasks 中找不到该任务", code: "TASK_NOT_FOUND" });
    }
    if (error instanceof GoogleProviderError && error.code === "GOOGLE_RATE_LIMITED") {
      throw providerApiError(error, { message: "Google Tasks 请求过于频繁，请稍后重试", code: "RATE_LIMITED" });
    }
    throw providerApiError(error) || error;
  }
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

async function connect(user: Record<string, any>, input: Record<string, unknown>) {
  const userId = String(user.id);
  const providerAccessToken = typeof input.provider_token === "string" ? input.provider_token : "";
  const providerRefreshToken = typeof input.provider_refresh_token === "string" ? input.provider_refresh_token : "";
  let existing = null;
  try { existing = await storedCredentials(userId); } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "GOOGLE_NOT_CONNECTED") throw error;
  }
  const refreshToken = selectRefreshToken(providerRefreshToken, existing?.refresh_token || "");
  if (!refreshToken) throw new ApiError("Google 未返回离线刷新凭证，请重新同意授权", 400, "GOOGLE_REFRESH_TOKEN_MISSING");
  // The supplied access token and refresh token must prove the same Google
  // subject. A client cannot bind one account using another account's token.
  const refreshed = await refreshGoogleAccessToken({
    ownerId: userId, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET,
    refreshToken,
  });
  const candidateSubject = await googleSubjectForAccessToken(refreshed.accessToken);
  if (providerAccessToken) assertSameGoogleSubject(candidateSubject, await googleSubjectForAccessToken(providerAccessToken));
  if (!existing) assertAuthenticatedGoogleIdentity(user, candidateSubject);
  if (existing) {
    let originalSubject = existing.google_subject || "";
    if (!originalSubject) {
      if (refreshToken === existing.refresh_token) {
        originalSubject = candidateSubject;
      } else {
        try {
          const originalToken = await refreshGoogleAccessToken({
            ownerId: `${userId}:legacy`, clientId: GOOGLE_CLIENT_ID,
            clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: existing.refresh_token,
          });
          originalSubject = await googleSubjectForAccessToken(originalToken.accessToken);
        } catch {
          // A revoked legacy token has no subject to query. The saved task
          // list is still an account-bound resource; require Google to prove
          // that the candidate owns that exact original list.
          await proveLegacyTaskList(refreshed.accessToken, existing.tasklist_id);
          originalSubject = candidateSubject;
        }
      }
    }
    assertSameGoogleSubject(originalSubject, candidateSubject);
  }
  const taskList = await ensureTaskList(refreshed.accessToken);
  const saved = await rpc("connect_google_auth_credentials", {
    target_owner: userId,
    new_refresh_token: refreshed.refreshToken,
    new_tasklist_id: taskList.id,
    new_google_subject: candidateSubject,
    old_refresh_token: existing?.refresh_token || null,
    old_tasklist_id: existing?.tasklist_id || null,
    encryption_key: TOKEN_ENCRYPTION_KEY,
  });
  if (saved !== true) throw new ApiError("Google 连接在核实时发生变化，请重新检查", 409, "GOOGLE_CONNECTION_CHANGED");
  const capabilities = await probeGoogleCapabilities(refreshed.accessToken);
  await rpc("record_google_auth_capabilities", {
    target_owner: userId, new_tasks_health: capabilities.tasks,
    new_calendar_health: capabilities.calendar,
  });
  console.info("OAuth Connected", { userId, taskListId: taskList.id });
  return { connected: true, taskListId: taskList.id, taskListTitle: taskList.title,
    capabilities, calendarNeedsAuthorization: capabilities.calendar === "scope_missing" };
}

async function context(userId: string) {
  const result = await coordinatedContext(userId);
  return { accessToken: result.accessToken, tasklist_id: result.taskListId,
    google_subject: result.googleSubject };
}

async function listTasksWithContext(
  accessToken: string,
  taskListId: string,
  showCompleted: boolean,
  options: Record<string, unknown> = {},
) {
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
    const page = await googleRequest(accessToken, `${taskPath(taskListId)}?${params}`);
    tasks.push(...(page?.items || [])
      .filter((task: Record<string, unknown>) => !task.deleted)
      .map((task: Record<string, unknown>) => toTaskModel(task, taskListId)));
    pageToken = page?.nextPageToken || "";
  } while (pageToken && tasks.length < maxTasks);
  if (pageToken && !options.maxTasks) throw new ApiError("任务列表超过当前完整读取上限，不能显示为全部结果", 503, "TASK_LIST_TRUNCATED");
  return tasks;
}

async function listTasks(userId: string, showCompleted: boolean) {
  const google = await context(userId);
  return listTasksWithContext(google.accessToken, google.tasklist_id, showCompleted);
}

async function getTaskView(userId: string, id: string) {
  if (!id) throw new ApiError("task_id is required", 400, "INVALID_TASK");
  const google = await context(userId);
  const [raw, schedules] = await Promise.all([googleRequest(google.accessToken, taskPath(google.tasklist_id, id)), schedulesFor(userId, id)]);
  return taskView(toTaskModel(raw, google.tasklist_id), schedules?.[0] || null);
}

async function patchTaskWithContext(accessToken: string, taskListId: string, id: string, changes: Record<string, unknown>) {
  if (!id) throw new ApiError("id is required", 400, "INVALID_TASK");
  let mergedChanges = changes;
  if (Object.hasOwn(changes, "notes") || Object.hasOwn(changes, "originalIntent")) {
    const current = toTaskModel(await googleRequest(accessToken, taskPath(taskListId, id)), taskListId);
    mergedChanges = {
      ...changes,
      metadata: current.metadata,
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
  if (!String(input.title || "").trim()) throw new ApiError("title is required", 400, "INVALID_TASK");
  const google = await context(userId);
  const taskListId = String(input.taskListId || google.tasklist_id);
  const taskInput = {
    ...input,
    raw_text: input.raw_text || input.originalIntent || input.title,
    goal_plan_id: input.goal_plan_id || input.goal_id || null,
  };
  const completedMin = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const candidates = await listTasksWithContext(google.accessToken, taskListId, true, { completedMin, maxTasks: 500 });
  const resolutionContext = await loadTaskResolutionContext({
    serviceRest,
    ownerId: userId,
    incoming: taskInput,
    providerTasks: candidates,
    providerGetTask: async (id: string) => toTaskModel(
      await googleRequest(google.accessToken, taskPath(taskListId, id)),
      taskListId,
    ),
  } as any);
  const adapter = createTaskResolutionAdapter({
    ownerId: userId,
    taskListId,
    intakeAuditId: String(input.intake_audit_id || "") || null,
    resolutionIdempotencyKey: String(input.resolution_idempotency_key || "") || null,
    createdFrom: String(input.source || "personal_os_app"),
    projectId: input.project_id || null,
    projectGoalId: resolutionContext.project_goal_id || null,
    serviceRest,
    provider: {
      getTask: async (id: string) => toTaskModel(
        await googleRequest(google.accessToken, taskPath(taskListId, id)),
        taskListId,
      ),
      createTask: async (taskInput: Record<string, unknown>, metadata: Record<string, unknown> = {}) => {
        let taskBody;
        try { taskBody = createGoogleTaskPayload({ ...taskInput, requestCorrelationId: input.intake_audit_id || input.resolution_idempotency_key }); }
        catch (error) { throw new ApiError(error instanceof Error ? error.message : "任务参数无效", 400, "INVALID_TASK"); }
        const params = new URLSearchParams();
        if (metadata.parent_task_id) params.set("parent", String(metadata.parent_task_id));
        const query = params.toString();
        const path = `${taskPath(taskListId)}${query ? `?${query}` : ""}`;
        return toTaskModel(await googleRequest(google.accessToken, path, {
          method: "POST",
          body: JSON.stringify(taskBody),
        }), taskListId);
      },
      updateTask: async (id: string, changes: Record<string, unknown>) => patchTaskWithContext(
        google.accessToken,
        taskListId,
        id,
        changes,
      ),
    },
  });
  const result = await resolveAndExecuteTask(taskInput, resolutionContext, adapter);
  const deduplicated = result.resolution.decision === "DUPLICATE";
  console.info("Task Resolved", {
    taskId: result.task.id,
    taskListId,
    decision: result.resolution.decision,
    auditId: result.resolution.audit_id,
  });
  return {
    task: deduplicated
      ? { ...result.task, metadata: { ...result.task.metadata, deduplicated: true } }
      : result.task,
    tasks: result.tasks,
    deduplicated,
    resolution: result.resolution,
    relationships: result.relationships,
    goal_link: result.goal_link,
    context_link: result.context_link,
    created: result.created,
  };
}

async function runAuditedCreate(request: Request, ownerId: string, input: Record<string, unknown>) {
  const taskInput = input.task && typeof input.task === "object" && !Array.isArray(input.task)
    ? input.task as Record<string, unknown>
    : {};
  if (!String(taskInput.title || "").trim()) throw new ApiError("title is required", 400, "INVALID_TASK");
  const reservation = await reserveCreateAudit(request, ownerId, input);
  if (reservation.replayed) {
    return json({ ...reservation.row.response, replayed: true }, reservation.row.response_status || 200);
  }
  let providerWriteStarted = false;
  try {
    const identity = await context(ownerId);
    if(!identity.google_subject) throw new ApiError("原 Google 账号暂无法核实",409,"ACCOUNT_UNVERIFIED");
    await updateCreateAudit(ownerId,reservation.row.id,{account_subject:identity.google_subject,stage:"write_pending",provider_attempted:true});
    providerWriteStarted = true;
    const result = await createTask(ownerId, { ...taskInput, intake_audit_id: reservation.row.id, resolution_idempotency_key: `create:${reservation.row.id}` });
    const schedule = taskInput.schedule as Record<string, unknown> | undefined;
    const priorSchedule = (await schedulesFor(ownerId,result.task.id))?.[0];
    const reused = result.resolution?.decision === "DUPLICATE";
    const scheduleChanged = reused && priorSchedule && schedule && ["scheduled_date","scheduled_start","scheduled_end","reminder_policy","reminder_at","timezone"].some(key=>Object.hasOwn(schedule,key) && (key.includes("start") || key.includes("end") ? String(schedule[key] || "").slice(0,5) !== String(priorSchedule[key] || "").slice(0,5) : String(schedule[key] || "") !== String(priorSchedule[key] || "")));
    let projection = scheduleChanged ? {success:false,code:"SCHEDULE_SUPERSEDED"} : reused && priorSchedule ? await schedulerSync("sync_task",result.task.id) : schedule ? await schedulerSync("schedule", result.task.id, {
      only_if_absent:reused,
      schedule: {
        ...schedule,
        raw_text: taskInput.raw_text || taskInput.originalIntent || result.task.originalIntent,
        title: result.task.title,
        notes: result.task.notes,
      },
    }) : null;
    if (taskInput.recurrence && !scheduleChanged) {
      const series = await schedulerSync("create_series",result.task.id,{recurrence:taskInput.recurrence});
      if (series?.series?.status !== "active") projection = {...projection,success:false,code:series.code || "SERIES_PENDING",series};
      else projection = {...projection,series:series.series};
    }
    const currentSchedule = (await schedulesFor(ownerId, result.task.id))?.[0] || null;
    const readbackTask = await getTaskView(ownerId, result.task.id);
    const task = taskView(readbackTask, currentSchedule);
    const pending = projection?.success === false || projection?.sync_required === true;
    const responseStatus = pending ? 202 : result.created ? 201 : 200;
    const response = {
      ...result,
      success: !pending,
      partial: pending,
      receipt: writeReceipt({ requestId: reservation.row.id, taskId: task.id, taskVerified: true, schedule: currentSchedule, scheduleRequested: Boolean(schedule), projection }),
      task,
      id: task.id,
      task_id: task.task_id,
      google_task_id: task.google_task_id,
      schedule_id: task.schedule_id,
      calendar_event_id: task.calendar_event_id,
      projection,
      projection_error: projection?.success === false ? projection : null,
      idempotency_key: reservation.idempotencyKey,
      replayed: false,
    };
    await updateCreateAudit(ownerId, reservation.row.id, {
      status: pending ? "processing" : "succeeded",
      stage: pending ? "projection_pending" : "reminder_verified",
      lease_owner: null, lease_expires_at: null,
      target_object_id: result.task.id,
      object_id: result.task.id,
      response_status: responseStatus,
      response,
      error: null,
    });
    return json(response, responseStatus);
  } catch (error) {
    try {
      await updateCreateAudit(ownerId, reservation.row.id, {
        status: "processing",
        stage: !providerWriteStarted ? "received" : error instanceof ApiError && error.code === "GOOGLE_REAUTH_REQUIRED" ? "auth_required" : "outcome_unknown",
        lease_owner: null, lease_expires_at: null,
        response_status: error instanceof ApiError ? error.status : 503,
        error: error instanceof Error ? error.message : "Task creation failed",
      });
    } catch (auditError) {
      console.error("Task creation audit update failed", auditError instanceof Error ? auditError.message : "unknown");
    }
    throw error;
  }
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

function requireSchedulerSync(result: Record<string, unknown>) {
  if (result?.success === true) return result;
  throw new ApiError(String(result?.error || "Task changed, but Calendar/Schedule reconciliation is still required"), 503, String(result?.code || "CALENDAR_SYNC_FAILED"));
}

async function runAuditedMutation(request: Request, ownerId: string, action: string, taskId: string, input: Record<string, unknown>, work: (activity: Record<string, unknown>, recordOld: (value: unknown) => Promise<void>) => Promise<Record<string, unknown>>) {
  const reservation = await reserveActivity(request, ownerId, action, taskId, input);
  if (reservation.replayed) return json({ ...reservation.row.response, replayed: true }, reservation.row.response_status || 200);
  const recordOld = async (value: unknown) => updateActivity(ownerId, reservation.row.id, { old_value: value });
  try {
    const outcome = await work(reservation.row, recordOld);
    const { audit_new, ...publicOutcome } = outcome;
    const partial = Boolean(outcome.projection_error || (outcome.projection as any)?.sync_required);
    const response = { ...publicOutcome, success: !partial, partial, receipt: writeReceipt({ requestId: reservation.row.id, taskId, taskVerified: true, projection: outcome.projection, error: outcome.projection_error }), task_id: taskId, google_task_id: taskId, activity_id: reservation.row.id, idempotency_key: reservation.idempotencyKey, replayed: false };
    await updateActivity(ownerId, reservation.row.id, { status: partial ? "failed" : "succeeded", new_value: audit_new ?? outcome.task ?? null, response_status: partial ? 202 : 200, response, error: partial ? "Projection requires recovery" : null });
    return json(response, partial ? 202 : 200);
  } catch (error) {
    await updateActivity(ownerId, reservation.row.id, { status: "failed", error: error instanceof Error ? error.message : "Task mutation failed", response_status: error instanceof ApiError ? error.status : 503 });
    throw error;
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

function verifyLifecycleStatus(task: Record<string, unknown>, expected: string) {
  if (task.status !== expected) throw new ApiError("Google Tasks readback did not match the requested status", 503, "WRITE_UNVERIFIED");
}

function verifyProviderPatch(task: Record<string, unknown>, changes: Record<string, unknown>) {
  for (const key of ["title", "notes", "due"]) {
    if (!Object.hasOwn(changes, key)) continue;
    const expected = key === "notes" ? String(changes[key] || "") : (changes[key] ?? null);
    const actual = key === "notes" ? String(task.notes || "") : (task[key] ?? null);
    if (actual !== expected) throw new ApiError(`Google Tasks readback did not match ${key}`, 503, "WRITE_UNVERIFIED");
  }
}

function verifyExpectedTaskVersion(task: Record<string, unknown>, input: Record<string, unknown>) {
  const expected = String(input.expected_task_version || "");
  if (expected && taskStateFingerprint(task) !== expected) {
    throw new ApiError("Task changed after the proposed preview", 409, "TASK_VERSION_CONFLICT");
  }
}

async function intakeProxy(userId: string, action: string, input: Record<string, unknown> = {}) {
  const ownerId = Deno.env.get("OWNER_USER_ID") || "";
  if (!ownerId || userId !== ownerId) throw new ApiError("仅原账号可以查看或恢复请求",403,"OWNER_REQUIRED");
  if (WRITE_TOKEN.length < 32) throw new ApiError("请求恢复服务未配置",503,"RECOVERY_NOT_CONFIGURED");
  const method = action === "list" ? "GET" : "POST";
  const response = await requestWithTimeout(`${SUPABASE_URL}/functions/v1/personal-os-intake${method === "GET" ? `?limit=100&offset=${Math.max(0,Math.floor(Number(input.offset)||0))}` : ""}`, {
    method, headers:{Authorization:`Bearer ${WRITE_TOKEN}`,"Content-Type":"application/json"},
    ...(method === "POST" ? {body:JSON.stringify({action, ...(input.request_id ? {request_id:input.request_id}: {}),...(input.after_reconnect === true ? {after_reconnect:true}: {}),...(action === "amend_request" ? {recovery_version:input.recovery_version,requested_date:input.requested_date,requested_time:input.requested_time}: {})})}: {}),
  });
  const result = await parseJson(response);
  if (!response.ok) throw new ApiError(result?.error || "请求恢复暂不可用",response.status,result?.code || "RECOVERY_UNAVAILABLE");
  return result;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SERVICE_API_KEY || !SUPABASE_PUBLIC_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || TOKEN_ENCRYPTION_KEY.length < 32) {
    return json({ error: "Google Tasks 服务端配置不完整", code: "SERVER_CONFIGURATION_ERROR" }, 503);
  }
  try {
    const user = await authenticatedUser(request);
    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.get("resource") === "requests") return json(await intakeProxy(user.id,"list",{offset:url.searchParams.get("offset")}));
      if (url.searchParams.get("resource") === "tasklists") {
        const google = await context(user.id);
        return json({ taskLists: await listTaskLists(google.accessToken), selectedTaskListId: google.tasklist_id });
      }
      const action = String(url.searchParams.get("action") || "");
      const taskId = String(url.searchParams.get("task_id") || url.searchParams.get("id") || "");
      if (action === "get" || taskId) return json({ success: true, task: await getTaskView(user.id, taskId) });
      if (action === "search") {
        const google = await context(user.id);
        const status = String(url.searchParams.get("status") || "open");
        const [tasks, schedules] = await Promise.all([listTasksWithContext(google.accessToken, google.tasklist_id, status !== "open"), schedulesFor(user.id)]);
        const matches = searchTaskViews(tasks, schedules, { query: url.searchParams.get("query") || "", task_id: taskId, status, priority: url.searchParams.get("priority") || "", task_type: url.searchParams.get("task_type") || "", date_from: url.searchParams.get("date_from") || "", date_to: url.searchParams.get("date_to") || "", deadline_from: url.searchParams.get("deadline_from") || "", deadline_to: url.searchParams.get("deadline_to") || "", created_from: url.searchParams.get("created_from") || "", created_to: url.searchParams.get("created_to") || "", updated_from: url.searchParams.get("updated_from") || "", updated_to: url.searchParams.get("updated_to") || "", limit: Number(url.searchParams.get("limit") || 20) });
        return json({ success: true, tasks: matches, count: matches.length, unique_match: matches.length === 1 });
      }
      const showCompleted = url.searchParams.get("showCompleted") === "true";
      const filter = url.searchParams.get("filter") || (showCompleted ? "all" : "open");
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      const tasks = await listTasks(user.id, showCompleted || filter === "completed" || filter === "all");
      return json({ tasks: filterTaskModels(tasks, filter, date) });
    }
    let input: Record<string, unknown> = {};
    try { input = await request.json(); } catch { throw new ApiError("请求正文必须是 JSON", 400, "INVALID_JSON"); }
    if (request.method === "POST" && ["recover","recover_due","amend_request"].includes(String(input.action))) return json(await intakeProxy(user.id,String(input.action),input));
    if (request.method === "POST" && input.action === "connect") {
      const connected = await connect(user,input);
      let recovery;
      try { recovery = await intakeProxy(user.id,"recover_due",{after_reconnect:true}); }
      catch { recovery = {success:false,code:"RECOVERY_PENDING"}; }
      return json({...connected,recovery});
    }
    if (request.method === "POST" && input.action === "create") {
      return await runAuditedCreate(request, user.id, input);
    }
    if (request.method === "PATCH" && (input.action === "complete" || input.action === "reopen")) {
      const id = String(input.task_id || input.id || ""); const action = input.action === "complete" ? "complete" : "reopen";
      return await runAuditedMutation(request, user.id, action, id, input, async (activity, recordOld) => { const expectedStatus = action === "complete" ? "completed" : "open"; const oldTask = await getTaskView(user.id, id); verifyExpectedTaskVersion(oldTask, input); if (!activity.old_value) await recordOld(oldTask); if (oldTask.status !== expectedStatus) await patchTask(user.id, id, { ...(oldTask.status === "cancelled" ? { notes: oldTask.notes, originalIntent: oldTask.originalIntent } : {}), status: expectedStatus }); const writtenTask = await getTaskView(user.id, id); verifyLifecycleStatus(writtenTask, expectedStatus); let projection = await schedulerSync("sync_task", id); if(action === "complete"){const series=await schedulerSync("advance_series",id);if(series.success === false)projection={...projection,success:false,code:series.code || "SERIES_PENDING"};else projection={...projection,series};} const task = await getTaskView(user.id, id); return { task, projection, projection_error: projection.success === true && projection.sync_required !== true ? null : projection, changed: oldTask.status !== expectedStatus }; });
    }
    if (request.method === "PATCH" && input.action === "cancel") {
      const id = String(input.task_id || input.id || "");
      return await runAuditedMutation(request, user.id, "cancel", id, input, async (activity, recordOld) => { const oldTask = await getTaskView(user.id, id); verifyExpectedTaskVersion(oldTask, input); if (!activity.old_value) await recordOld(oldTask); if (oldTask.status !== "cancelled") await patchTask(user.id, id, { notes: markTaskCancelledNotes(oldTask.notes), originalIntent: oldTask.originalIntent, status: "completed" }); const writtenTask = await getTaskView(user.id, id); verifyLifecycleStatus(writtenTask, "cancelled"); const projection = await schedulerSync("cancel_task", id, { title: oldTask.title }); const task = await getTaskView(user.id, id); return { task, projection, projection_error: projection.success === true ? null : projection, changed: oldTask.status !== "cancelled" }; });
    }
    if (request.method === "PATCH" && input.action === "update") {
      const id = String(input.task_id || input.id || ""); let changes: Record<string, unknown>;
      try { changes = normalizeTaskPatch({ changes: input.changes || {}, clear_fields: input.clear_fields || [] }) as unknown as Record<string, unknown>; } catch (error) { throw new ApiError(error instanceof Error ? error.message : "Invalid Task patch", 400, "INVALID_TASK_PATCH"); }
      return await runAuditedMutation(request, user.id, "update", id, { ...input, changes }, async (activity, recordOld) => { const oldTask = await getTaskView(user.id, id); verifyExpectedTaskVersion(oldTask, input); if (hasScheduleChanges(changes)) applyTaskSchedulePatch(oldTask.schedule, changes, (changes.due || oldTask.dueDate) as string, { preserveReminderPolicy: input.source === "task_conversation" }); if (!activity.old_value) await recordOld(oldTask); const providerChanges = googleTaskChanges(changes) as Record<string, unknown>; if (Object.keys(providerChanges).length) await patchTask(user.id, id, providerChanges); const writtenTask = await getTaskView(user.id, id); verifyProviderPatch(writtenTask, providerChanges); const projection = await schedulerSync(hasScheduleChanges(changes) ? "update_task" : "sync_task", id, hasScheduleChanges(changes) ? { changes, preserve_reminder_policy: input.source === "task_conversation" } : {}); const task = await getTaskView(user.id, id); return { task, projection, projection_error: projection.success === true && projection.sync_required !== true ? null : projection, changed: true }; });
    }
    if (request.method === "DELETE") {
      const id = String(input.task_id || input.id || "");
      return await runAuditedMutation(request, user.id, "delete", id, input, async (activity, recordOld) => { let oldTask: Record<string, unknown>; try { oldTask = await getTaskView(user.id, id); } catch (error) { if (error instanceof ApiError && error.code === "TASK_NOT_FOUND" && activity.old_value && typeof activity.old_value === "object") return { deleted: true, changed: false, deleted_task: activity.old_value, projection: null, projection_error: { code: "DELETE_RETRY_PROVIDER_MISSING" }, audit_new: { deleted: true, retried: true } }; throw error; } if (!activity.old_value) await recordOld(oldTask); const projection = requireSchedulerSync(await schedulerSync("delete_task", id, { deleted_by: input.source || "personal_os" })); await deleteTask(user.id, id); try { await getTaskView(user.id, id); throw new ApiError("Google Tasks deletion readback failed", 503, "DELETE_UNVERIFIED"); } catch (error) { if (!(error instanceof ApiError) || error.code !== "TASK_NOT_FOUND") throw error; } return { deleted: true, changed: true, deleted_task: oldTask, projection, projection_error: null, audit_new: { deleted: true } }; });
    }
    throw new ApiError("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const apiError = error instanceof ApiError
      ? error
      : providerApiError(error) || new ApiError(timedOut ? "Google Tasks 请求超时，请重试" : "Google Tasks 服务暂时不可用", 503, timedOut ? "API_TIMEOUT" : "SERVICE_UNAVAILABLE");
    console.error("Task Sync Failed", { code: apiError.code, status: apiError.status, retryable: apiError.retryable, providerLayer: apiError.providerLayer || undefined });
    return json({
      error: apiError.message,
      code: apiError.code,
      ...(apiError.providerLayer ? { retryable: apiError.retryable, provider_layer: apiError.providerLayer } : {}),
      ...(apiError.providerStatus !== null ? { provider_status: apiError.providerStatus } : {}),
      ...(apiError.providerCode ? { provider_code: apiError.providerCode } : {}),
    }, apiError.status);
  }
});
