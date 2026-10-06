import {
  CACHE_KEY_PREFIX,
  MIGRATION_FLAG_KEY,
  collectLegacyTasks,
  fromDatabaseTask,
} from "./core.js";
import { cleanGoalWrite, normalizeGoal } from "./goals.js";

export const GOOGLE_TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
export const GOOGLE_CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const SESSION_KEY = "task-sync-auth-session-v1";
const GOOGLE_OAUTH_TRANSIENT_KEY = "task-sync-google-oauth-transient-v1";
const PLANNING_CACHE_KEY_PREFIX = "personal-os-planning-cache-v1";
const PENDING_TASK_MUTATIONS_KEY_PREFIX = "personal-os-pending-task-mutations-v1";
const REQUEST_TIMEOUT_MS = 45_000;
const PENDING_TASK_MUTATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const PENDING_TASK_MUTATION_LIMIT = 50;
const CALENDAR_MUTATION_UNSUPPORTED = "CALENDAR_MUTATION_UNSUPPORTED";

const SUPABASE_AUTH_ERROR_CODES = new Set([
  "auth_required",
  "bad_jwt",
  "invalid_jwt",
  "jwt_expired",
  "pgrst301",
]);

const INVALID_REFRESH_TOKEN_CODES = new Set([
  "bad_refresh_token",
  "invalid_grant",
  "refresh_token_already_used",
  "refresh_token_not_found",
]);

function splitCalendarDateRange(dateFrom, dateTo) {
  const start = Date.parse(`${dateFrom}T00:00:00Z`);
  const end = Date.parse(`${dateTo}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
  const midpoint = new Date(start + Math.floor((end - start) / 2 / 86_400_000) * 86_400_000);
  const rightStart = new Date(midpoint.valueOf() + 86_400_000);
  return [midpoint.toISOString().slice(0, 10), rightStart.toISOString().slice(0, 10)];
}

function taskMutationKey(action = "task") {
  const id = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${action}:${id}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hashMutation(value) {
  const input = new TextEncoder().encode(canonicalJson(value));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (const byte of input) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function jwtSubject(accessToken) {
  const payload = String(accessToken || "").split(".")[1];
  if (!payload || typeof globalThis.atob !== "function") return "";
  try {
    const decoded = globalThis.atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    return String(JSON.parse(decoded)?.sub || "");
  } catch {
    return "";
  }
}

function isSupabaseAuthError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "");
  return error?.status === 401 && (
    SUPABASE_AUTH_ERROR_CODES.has(code)
    || /invalid jwt|jwt (?:has )?expired|token is expired/i.test(message)
  );
}

function isInvalidRefreshToken(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return error?.status === 401
    || INVALID_REFRESH_TOKEN_CODES.has(code)
    || (error?.status === 400 && /invalid refresh token|refresh token (?:not found|already used|has been revoked)/i.test(message));
}

function isUncertainMutationError(error) {
  const code = String(error?.code || "").toUpperCase();
  return error?.status === 0
    || error?.status === 408
    || error?.status === 425
    || error?.status === 429
    || error?.status >= 500
    || ["API_TIMEOUT", "NETWORK_ERROR", "NO_FETCH", "IDEMPOTENCY_IN_PROGRESS"].includes(code);
}

function taskWithMutationOutcome(result) {
  if (!result?.task || typeof result.task !== "object") return result?.task;
  const task = { ...result.task };
  const fields = [
    "projection",
    "projection_error",
    "idempotency_key",
    "request_id",
    "replayed",
    "changed",
    "activity_id",
    "audit_id",
  ];
  for (const field of fields) {
    if (Object.hasOwn(result, field)) task[field] = result[field];
  }
  if (Object.hasOwn(result, "receipt")) task.write_receipt = result.receipt;
  else if (Object.hasOwn(result, "write_receipt")) task.write_receipt = result.write_receipt;
  if (!Object.hasOwn(task, "request_id") && task.write_receipt?.request_id) {
    task.request_id = task.write_receipt.request_id;
  }
  return task;
}

export class CloudError extends Error {
  constructor(message, { status = 0, code = "", cause } = {}) {
    super(message, { cause });
    this.name = "CloudError";
    this.status = status;
    this.code = code;
  }
}

export class TaskCloudClient {
  constructor(config = {}, options = {}) {
    this.url = String(config.supabaseUrl || "").replace(/\/$/, "");
    this.anonKey = String(config.supabaseAnonKey || "");
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this.storage = options.storage || globalThis.localStorage;
    this.transientStorage = options.transientStorage || globalThis.sessionStorage;
    this.location = options.location || globalThis.location;
    this.refreshInFlight = null;
    this.googleOAuthScopes = [...new Set([
      ...String(config.googleOAuthScopes || "").split(/[\s,]+/).filter(Boolean),
      GOOGLE_TASKS_SCOPE,
      GOOGLE_CALENDAR_EVENTS_SCOPE,
    ])].join(" ");
  }

  isConfigured() {
    return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(this.url)
      && this.anonKey.length > 20
      && !/YOUR_|PLACEHOLDER/i.test(this.anonKey);
  }

  session() {
    try { return JSON.parse(this.storage?.getItem(SESSION_KEY) || "null"); } catch { return null; }
  }

  saveSession(session) {
    if (!session) this.storage?.removeItem(SESSION_KEY);
    else this.storage?.setItem(SESSION_KEY, JSON.stringify(session));
  }

  saveTransientGoogleCredentials(credentials) {
    if (!credentials?.provider_refresh_token && !credentials?.provider_token) return;
    this.transientStorage?.setItem(GOOGLE_OAUTH_TRANSIENT_KEY, JSON.stringify(credentials));
  }

  transientGoogleCredentials() {
    try { return JSON.parse(this.transientStorage?.getItem(GOOGLE_OAUTH_TRANSIENT_KEY) || "null"); } catch { return null; }
  }

  consumeAuthRedirect() {
    const hash = this.location?.hash || "";
    if (!hash.includes("access_token=")) return false;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    if (!accessToken || !refreshToken) return false;
    const expiresIn = Number(params.get("expires_in") || 3600);
    this.saveSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      token_type: params.get("token_type") || "bearer",
    });
    this.saveTransientGoogleCredentials({
      provider_token: params.get("provider_token") || "",
      provider_refresh_token: params.get("provider_refresh_token") || "",
    });
    if (globalThis.history?.replaceState && this.location) {
      globalThis.history.replaceState(null, "", `${this.location.pathname}${this.location.search || ""}`);
    }
    return true;
  }

  googleOAuthUrl(redirectTo) {
    const params = new URLSearchParams({
      provider: "google",
      redirect_to: redirectTo,
      scopes: this.googleOAuthScopes,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    });
    return `${this.url}/auth/v1/authorize?${params}`;
  }

  requestGoogleLogin(redirectTo) {
    const url = this.googleOAuthUrl(redirectTo);
    if (typeof this.location?.assign === "function") this.location.assign(url);
    else if (this.location) this.location.href = url;
    return url;
  }

  async rawRequest(url, init = {}) {
    if (!this.fetch) throw new CloudError("当前环境无法访问网络", { code: "NO_FETCH" });
    let response;
    try {
      response = await this.fetch(url, {
        ...init,
        signal: init.signal || globalThis.AbortSignal?.timeout?.(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      if (cause?.name === "TimeoutError" || cause?.name === "AbortError") {
        throw new CloudError("云端请求超时，请稍后重试", { code: "API_TIMEOUT", cause });
      }
      throw new CloudError("无法连接云端，请检查网络后重试", { code: "NETWORK_ERROR", cause });
    }
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    if (!response.ok) {
      const message = payload?.message || payload?.msg || payload?.error_description || payload?.error || `云端请求失败（${response.status}）`;
      throw new CloudError(message, { status: response.status, code: payload?.code || "HTTP_ERROR" });
    }
    return payload;
  }

  async refreshSession() {
    if (this.refreshInFlight) return this.refreshInFlight;
    const current = this.session();
    if (!current?.refresh_token) return null;
    const refreshToken = current.refresh_token;
    const operation = (async () => {
      try {
        const refreshed = await this.rawRequest(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { apikey: this.anonKey, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!refreshed?.access_token) {
          throw new CloudError("登录续期响应不完整，请稍后重试", {
            status: 503,
            code: "SESSION_REFRESH_INVALID_RESPONSE",
          });
        }
        const latest = this.session();
        // A response from an old login must never restore a signed-out user or overwrite another account.
        if (!latest || latest.refresh_token !== refreshToken || latest.user?.id !== current.user?.id) {
          throw new CloudError("登录状态已改变，请重新执行当前操作", { status: 409, code: "SESSION_CHANGED" });
        }
        const session = {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || refreshToken,
          expires_at: Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600),
          token_type: refreshed.token_type || "bearer",
          user: refreshed.user || latest?.user || current.user,
        };
        this.saveSession(session);
        return session;
      } catch (error) {
        if (isInvalidRefreshToken(error) && this.session()?.refresh_token === refreshToken) this.saveSession(null);
        throw error;
      }
    })();
    this.refreshInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.refreshInFlight === operation) this.refreshInFlight = null;
    }
  }

  async accessToken() {
    const current = this.session();
    if (!current?.access_token) return null;
    if (Number(current.expires_at || 0) <= Math.floor(Date.now() / 1000) + 60) {
      return (await this.refreshSession())?.access_token || null;
    }
    return current.access_token;
  }

  async authenticatedRequest(path, init = {}, { retry = true } = {}) {
    const token = await this.accessToken();
    if (!token) throw new CloudError("请先使用 Google 登录", { status: 401, code: "AUTH_REQUIRED" });
    const started = this.session();
    if (started?.access_token !== token) throw new CloudError("登录状态已改变，请重新执行当前操作", { status: 409, code: "SESSION_CHANGED" });
    const startedUserId = started.user?.id || null;
    const requestWithToken = (bearer) => this.rawRequest(`${this.url}${path}`, {
      ...init,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    try {
      return await requestWithToken(token);
    } catch (error) {
      if (retry && isSupabaseAuthError(error)) {
        const latest = this.session();
        if (!latest || (startedUserId ? latest.user?.id !== startedUserId : latest.access_token !== token)) {
          throw new CloudError("登录状态已改变，请重新执行当前操作", { status: 409, code: "SESSION_CHANGED" });
        }
        if (latest.access_token === token) await this.refreshSession();
        const renewed = this.session();
        if (!renewed?.access_token || (startedUserId && renewed.user?.id !== startedUserId)) {
          throw new CloudError("登录状态已改变，请重新执行当前操作", { status: 409, code: "SESSION_CHANGED" });
        }
        // Retry with the captured same-account token. A later login cannot
        // receive this request body, even if the session changes again.
        return requestWithToken(renewed.access_token);
      }
      throw error;
    }
  }

  async getUser() {
    const token = await this.accessToken();
    if (!token) return null;
    const startedUserId = this.session()?.user?.id || null;
    try {
      const user = await this.authenticatedRequest("/auth/v1/user", { method: "GET" });
      const latest = this.session();
      if (!latest || (startedUserId && startedUserId !== user?.id)
        || (latest.user?.id && latest.user.id !== user?.id)
        || (!startedUserId && latest.access_token !== token)) {
        throw new CloudError("登录状态已改变，请重新执行当前操作", { status: 409, code: "SESSION_CHANGED" });
      }
      this.saveSession({ ...latest, user });
      return user;
    } catch (error) {
      if (error.status === 401) return null;
      throw error;
    }
  }

  async finalizeGoogleTasksConnection() {
    const credentials = this.transientGoogleCredentials();
    if (!credentials) return { connected: false, skipped: true };
    const result = await this.authenticatedRequest("/functions/v1/google-tasks", {
      method: "POST",
      body: JSON.stringify({ action: "connect", ...credentials }),
    });
    this.transientStorage?.removeItem(GOOGLE_OAUTH_TRANSIENT_KEY);
    return result;
  }

  async signOut() {
    try {
      if (this.session()?.access_token) await this.authenticatedRequest("/auth/v1/logout", { method: "POST" }, { retry: false });
    } catch {
      // A local logout must still succeed when the network is unavailable.
    } finally {
      this.saveSession(null);
      this.transientStorage?.removeItem(GOOGLE_OAUTH_TRANSIENT_KEY);
    }
  }

  async tasksRequest(method, body = null, query = "", { idempotencyKey = "" } = {}) {
    return this.authenticatedRequest(`/functions/v1/google-tasks${query}`, {
      method,
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      body: body === null ? undefined : JSON.stringify(body),
    });
  }

  currentAccountId() {
    const current = this.session();
    return String(current?.user?.id || jwtSubject(current?.access_token) || "");
  }

  pendingMutationStorageKey(accountId = this.currentAccountId()) {
    return accountId ? `${PENDING_TASK_MUTATIONS_KEY_PREFIX}:${accountId}` : "";
  }

  readPendingTaskMutations(accountId = this.currentAccountId()) {
    const storageKey = this.pendingMutationStorageKey(accountId);
    if (!storageKey) return [];
    let stored;
    try { stored = JSON.parse(this.storage?.getItem(storageKey) || "null"); } catch { stored = null; }
    const now = Date.now();
    return (Array.isArray(stored?.operations) ? stored.operations : [])
      .filter((item) => item?.fingerprint && item?.idempotencyKey && now - Number(item.updatedAt || 0) <= PENDING_TASK_MUTATION_TTL_MS)
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, PENDING_TASK_MUTATION_LIMIT);
  }

  writePendingTaskMutations(accountId, operations) {
    const storageKey = this.pendingMutationStorageKey(accountId);
    if (!storageKey) return;
    try {
      if (!operations.length) this.storage?.removeItem(storageKey);
      else this.storage?.setItem(storageKey, JSON.stringify({ version: 1, operations }));
    } catch {
      // A blocked or full cache must not prevent the authorized cloud mutation.
    }
  }

  async reserveTaskMutation(action, body, suppliedKey = "") {
    const accountId = this.currentAccountId();
    const fingerprint = await hashMutation({ action, body });
    const operations = this.readPendingTaskMutations(accountId);
    const existing = operations.find((item) => item.fingerprint === fingerprint);
    const now = Date.now();
    const reservation = {
      accountId,
      fingerprint,
      idempotencyKey: String(suppliedKey || existing?.idempotencyKey || taskMutationKey(action)),
      attempts: Number(existing?.attempts || 0) + 1,
      createdAt: Number(existing?.createdAt || now),
      updatedAt: now,
      state: "in_flight",
    };
    if (accountId) {
      this.writePendingTaskMutations(accountId, [
        reservation,
        ...operations.filter((item) => item.fingerprint !== fingerprint),
      ].slice(0, PENDING_TASK_MUTATION_LIMIT));
    }
    return reservation;
  }

  settleTaskMutation(reservation, error = null) {
    if (!reservation.accountId) return;
    const operations = this.readPendingTaskMutations(reservation.accountId)
      .filter((item) => item.fingerprint !== reservation.fingerprint);
    if (error && isUncertainMutationError(error)) {
      operations.unshift({
        ...reservation,
        state: "uncertain",
        updatedAt: Date.now(),
      });
    }
    this.writePendingTaskMutations(reservation.accountId, operations.slice(0, PENDING_TASK_MUTATION_LIMIT));
  }

  async taskMutationRequest(method, body, action, { idempotencyKey = "" } = {}) {
    const reservation = await this.reserveTaskMutation(action, body, idempotencyKey);
    try {
      const result = await this.tasksRequest(method, body, "", { idempotencyKey: reservation.idempotencyKey });
      this.settleTaskMutation(reservation);
      return result;
    } catch (error) {
      this.settleTaskMutation(reservation, error);
      throw error;
    }
  }

  async getTaskConversation(taskId, { historyBefore = "" } = {}) {
    const query = new URLSearchParams({ task_id: taskId });
    if (historyBefore) query.set("history_before", historyBefore);
    return this.authenticatedRequest(`/functions/v1/task-conversation?${query}`, { method: "GET" });
  }

  async sendTaskConversation(input) {
    return this.authenticatedRequest("/functions/v1/task-conversation", { method: "POST", body: JSON.stringify(input) });
  }

  async createTask(task) {
    const idempotencyKey = String(task?.idempotency_key || task?.idempotencyKey || "");
    const result = await this.taskMutationRequest("POST", { action: "create", task }, "create", { idempotencyKey });
    return taskWithMutationOutcome(result);
  }

  async listTaskLists() {
    const result = await this.tasksRequest("GET", null, "?resource=tasklists");
    return result;
  }

  async listTasks({ showCompleted = false, filter = "", date = "" } = {}) {
    const params = new URLSearchParams({ showCompleted: showCompleted ? "true" : "false" });
    if (filter) params.set("filter", filter);
    if (date) params.set("date", date);
    const result = await this.tasksRequest("GET", null, `?${params}`);
    return result.tasks.map(fromDatabaseTask);
  }

  async listOpenTasks({ filter = "open", date = "" } = {}) {
    return this.listTasks({ showCompleted: false, filter, date });
  }

  async getTasks() {
    return this.listTasks({ showCompleted: true, filter: "all" });
  }

  async completeTask(id, completed = true) {
    const result = await this.taskMutationRequest("PATCH", { action: "complete", id, completed }, "complete");
    return taskWithMutationOutcome(result);
  }

  async reopenTask(id) {
    const result = await this.taskMutationRequest("PATCH", { action: "reopen", id }, "reopen");
    return taskWithMutationOutcome(result);
  }

  async updateTask(id, changes) {
    if (Object.hasOwn(changes, "status") && Object.keys(changes).every((key) => ["status", "completed_at"].includes(key))) {
      return changes.status === "open" ? this.reopenTask(id) : this.completeTask(id, true);
    }
    const result = await this.taskMutationRequest("PATCH", { action: "update", id, changes }, "update");
    return taskWithMutationOutcome(result);
  }

  async deleteTask(id) {
    return this.taskMutationRequest("DELETE", { id }, "delete");
  }

  async cancelTask(id) {
    return this.deleteTask(id);
  }

  async listSchedules() {
    return this.authenticatedRequest("/functions/v1/task-scheduler", { method: "GET" });
  }

  async calendarRequest(action, input = {}) {
    return this.authenticatedRequest("/functions/v1/task-scheduler", {
      method: "POST",
      body: JSON.stringify({ ...input, action }),
    });
  }

  async listCalendarEvents(range = {}) {
    const baseInput = {
      calendar_id: range.calendarId || range.calendar_id || "primary",
      query: range.query || "",
      limit: range.limit ?? 100,
    };
    const readWindow = async (dateFrom, dateTo) => this.calendarRequest("search_calendar_events", {
      ...baseInput,
      date_from: dateFrom,
      date_to: dateTo,
    });
    const first = await readWindow(range.dateFrom || range.date_from, range.dateTo || range.date_to);
    const dateFrom = first.date_from;
    const dateTo = first.date_to;

    const resolveWindow = async (page) => {
      const nextPageToken = page.next_page_token || null;
      if (!nextPageToken) return { events: page.events || [], incomplete: [] };
      const split = splitCalendarDateRange(page.date_from, page.date_to);
      if (!split) {
        return {
          events: page.events || [],
          incomplete: [{ date: page.date_from, nextPageToken }],
        };
      }
      const [leftDateTo, rightDateFrom] = split;
      const [left, right] = await Promise.all([
        readWindow(page.date_from, leftDateTo),
        readWindow(rightDateFrom, page.date_to),
      ]);
      const [resolvedLeft, resolvedRight] = await Promise.all([
        resolveWindow(left),
        resolveWindow(right),
      ]);
      return {
        events: [...resolvedLeft.events, ...resolvedRight.events],
        incomplete: [...resolvedLeft.incomplete, ...resolvedRight.incomplete],
      };
    };

    const resolved = await resolveWindow(first);
    const eventsById = new Map();
    for (const event of resolved.events) {
      const key = event?.id || JSON.stringify(event);
      if (!eventsById.has(key)) eventsById.set(key, event);
    }
    const events = [...eventsById.values()];
    const nextPageToken = resolved.incomplete[0]?.nextPageToken || null;
    return {
      calendarId: first.calendar_id,
      dateFrom,
      dateTo,
      count: events.length,
      events,
      nextPageToken,
      hasMore: resolved.incomplete.length > 0,
      isComplete: resolved.incomplete.length === 0,
      pageTokenPaginationSupported: false,
      paginationStrategy: "range_split",
      incompleteDates: resolved.incomplete.map((item) => item.date),
    };
  }

  async getCalendarEvent(eventId, { calendarId = "primary" } = {}) {
    const result = await this.calendarRequest("get_calendar_event", {
      calendar_id: calendarId,
      event_id: eventId,
    });
    if (!result.event || result.event.id !== eventId) {
      throw new CloudError("读取到的日历行程与请求的 Event ID 不一致", {
        status: 502,
        code: "CALENDAR_EVENT_IDENTITY_CHANGED",
      });
    }
    return result.event;
  }

  async updateCalendarEvent(eventId, changes = {}, options = {}) {
    if (changes.personal_os_projection || changes.personalOsProjection) {
      throw new CloudError("这是 Personal OS 任务的日历投影，请通过原 Google Task 修改", {
        status: 409,
        code: "PERSONAL_OS_PROJECTION_REQUIRES_TASK_UPDATE",
      });
    }
    const expectedUpdated = options.expectedUpdated
      || changes.expectedUpdated
      || changes.expected_updated;
    if (!expectedUpdated) {
      throw new CloudError("更新日历行程前需要先读取最新版本", {
        status: 400,
        code: "INVALID_CALENDAR_EVENT",
      });
    }
    const calendarId = options.calendarId || changes.calendarId || changes.calendar_id || "primary";
    const input = {
      calendar_id: calendarId,
      event_id: eventId,
      expected_updated: expectedUpdated,
    };
    const fields = ["summary", "description", "location", "start", "end", "timezone"];
    for (const field of fields) if (Object.hasOwn(changes, field)) input[field] = changes[field];
    if (Object.hasOwn(changes, "startDate") || Object.hasOwn(changes, "start_date")) {
      input.start_date = changes.startDate ?? changes.start_date;
    }
    if (Object.hasOwn(changes, "endDate") || Object.hasOwn(changes, "end_date")) {
      input.end_date = changes.endDate ?? changes.end_date;
    }
    const result = await this.calendarRequest("update_calendar_event", input);
    if (result.verified !== true
      || result.event_id !== eventId
      || result.event?.id !== eventId
      || result.event_id_unchanged !== true
      || result.calendar_event_count_delta !== 0) {
      throw new CloudError("日历行程更新未能核实，请重新读取后再试", {
        status: 502,
        code: "CALENDAR_UPDATE_UNVERIFIED",
      });
    }
    return result;
  }

  async createCalendarEvent() {
    throw new CloudError("当前 Personal OS 仅支持读取和原位更新既有日历行程", {
      status: 405,
      code: CALENDAR_MUTATION_UNSUPPORTED,
    });
  }

  async deleteCalendarEvent(_eventId, event = {}) {
    if (event.personal_os_projection || event.personalOsProjection) {
      throw new CloudError("这是 Personal OS 任务的日历投影，请通过原 Google Task 修改", {
        status: 409,
        code: "PERSONAL_OS_PROJECTION_REQUIRES_TASK_UPDATE",
      });
    }
    throw new CloudError("当前 Personal OS 不支持删除独立日历行程", {
      status: 405,
      code: CALENDAR_MUTATION_UNSUPPORTED,
    });
  }

  async listReminderRequests() {
    let offset = 0;
    const rows = new Map();
    let result;
    do {
      result = await this.tasksRequest("GET", null, `?resource=requests&offset=${offset}`);
      for (const row of result.requests || []) rows.set(row.request_id,row);
      if (result.has_more && !(Number(result.next_offset)>offset)) throw new CloudError("请求分页未完成，请刷新重试",{code:"REQUEST_PAGINATION_INCOMPLETE"});
      offset=Number(result.next_offset);
    } while(result.has_more);
    return {...result, requests:[...rows.values()]};
  }

  async amendReminderRequest(requestId, recoveryVersion, requestedDate, requestedTime) {
    return this.tasksRequest("POST",{action:"amend_request",request_id:requestId,recovery_version:recoveryVersion,requested_date:requestedDate,requested_time:requestedTime});
  }

  async recoverReminderRequest(requestId) {
    return this.tasksRequest("POST", {action:"recover", request_id:requestId});
  }

  async recoverPendingRequests() {
    return this.tasksRequest("POST", {action:"recover_due"});
  }

  async scheduleTask(id, schedule) {
    return this.authenticatedRequest("/functions/v1/task-scheduler", {
      method: "POST",
      body: JSON.stringify({ action: "schedule", task_id: id, schedule }),
    });
  }

  async rescheduleTask(id, schedule) {
    return this.authenticatedRequest("/functions/v1/task-scheduler", {
      method: "POST",
      body: JSON.stringify({ action: "reschedule", task_id: id, schedule: { ...schedule, scheduling_source: "rescheduled", scheduling_status: "rescheduled" } }),
    });
  }

  async updateTaskReminder(id, reminder) {
    return this.authenticatedRequest("/functions/v1/task-scheduler", {
      method: "POST",
      body: JSON.stringify({ action: "update_reminder", task_id: id, reminder }),
    });
  }

  async unscheduleTask(id, schedule = {}) {
    return this.authenticatedRequest("/functions/v1/task-scheduler", {
      method: "POST",
      body: JSON.stringify({ action: "unschedule", task_id: id, schedule }),
    });
  }

  async runMorningScheduler(date) {
    return this.authenticatedRequest("/functions/v1/task-scheduler", {
      method: "POST",
      body: JSON.stringify({ action: "run", date }),
    });
  }

  async getReview(date) {
    const rows = await this.authenticatedRequest(`/rest/v1/daily_reviews?date=eq.${date}&select=date,note,mood,updated_at`, { method: "GET" });
    return rows[0] || { date, note: "", mood: null };
  }

  async saveReview(date, review) {
    const rows = await this.authenticatedRequest("/rest/v1/daily_reviews?on_conflict=owner_id,date&select=date,note,mood,updated_at", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ date, note: review.note || "", mood: review.mood || null }),
    });
    return rows[0];
  }

  async listGoals() {
    const rows = await this.authenticatedRequest("/rest/v1/goals_plans?select=*&order=updated_at.desc", { method: "GET" });
    return rows.map(normalizeGoal);
  }

  async createGoal(goal) {
    const payload = cleanGoalWrite({
      ...goal,
      original_input: goal.original_input || goal.title,
    });
    const rows = await this.authenticatedRequest("/rest/v1/goals_plans?select=*", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload),
    });
    return normalizeGoal(rows[0]);
  }

  async updateGoal(id, changes) {
    const rows = await this.authenticatedRequest(`/rest/v1/goals_plans?id=eq.${encodeURIComponent(id)}&select=*`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(cleanGoalWrite(changes)),
    });
    if (!rows[0]) throw new CloudError("目标不存在或无权修改", { status: 404, code: "GOAL_NOT_FOUND" });
    return normalizeGoal(rows[0]);
  }

  async listProjects() {
    return this.authenticatedRequest("/rest/v1/projects?select=*&order=updated_at.desc", { method: "GET" });
  }

  async createProject(project) {
    const payload = {
      goal_plan_id: project.goal_plan_id || null,
      title: String(project.title || "").trim(),
      description: String(project.description || "").trim(),
      status: project.status || "Planning",
      priority: project.priority || "medium",
      progress_percent: Number(project.progress_percent) || 0,
      start_date: project.start_date || null,
      target_date: project.target_date || null,
      original_input: String(project.original_input || project.title || "").trim(),
    };
    const rows = await this.authenticatedRequest("/rest/v1/projects?select=*", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload),
    });
    return rows[0];
  }

  async updateProject(id, changes) {
    const allowed = ["goal_plan_id", "title", "description", "status", "priority", "progress_percent", "start_date", "target_date", "original_input", "archived_at"];
    const payload = Object.fromEntries(Object.entries(changes).filter(([key]) => allowed.includes(key)));
    const rows = await this.authenticatedRequest(`/rest/v1/projects?id=eq.${encodeURIComponent(id)}&select=*`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload),
    });
    if (!rows[0]) throw new CloudError("项目不存在或无权修改", { status: 404, code: "PROJECT_NOT_FOUND" });
    return rows[0];
  }

  async listTaskContextLinks() {
    return this.authenticatedRequest("/rest/v1/task_context_links?select=*&order=updated_at.desc", { method: "GET" });
  }

  async linkTaskContext(googleTaskId, goalPlanId, projectId = null) {
    const rows = await this.authenticatedRequest("/rest/v1/task_context_links?on_conflict=owner_id%2Cgoogle_task_id&select=*", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        google_task_id: googleTaskId,
        goal_plan_id: goalPlanId || null,
        project_id: projectId || null,
      }),
    });
    return rows[0];
  }

  async unlinkTaskContext(googleTaskId) {
    await this.authenticatedRequest(`/rest/v1/task_context_links?google_task_id=eq.${encodeURIComponent(googleTaskId)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
    return { unlinked: true };
  }

  cachePlanning(userId, snapshot) {
    this.storage?.setItem(`${PLANNING_CACHE_KEY_PREFIX}:${userId}`, JSON.stringify({ savedAt: new Date().toISOString(), ...snapshot }));
  }

  readCachedPlanning(userId) {
    try { return JSON.parse(this.storage?.getItem(`${PLANNING_CACHE_KEY_PREFIX}:${userId}`) || "null"); } catch { return null; }
  }

  migrationState() {
    try { return JSON.parse(this.storage?.getItem(MIGRATION_FLAG_KEY) || "null"); } catch { return null; }
  }

  legacyMigrationPlan() {
    if (this.migrationState()?.completedAt) return { tasks: [], malformedSources: 0, completed: true };
    return { ...collectLegacyTasks(this.storage), completed: false };
  }

  async migrateLegacyTasks() {
    const plan = this.legacyMigrationPlan();
    if (plan.completed || !plan.tasks.length) return { imported: 0, ...plan };
    const created = [];
    const existing = await this.listTasks({ showCompleted: true, filter: "all" });
    for (const task of plan.tasks.filter((item) => item.status !== "cancelled")) {
      const result = await this.createTask({
        title: task.title,
        dueDate: task.date,
        notes: task.notes,
        status: task.status === "done" ? "completed" : "open",
        originalIntent: task.title,
      });
      if (result.metadata?.deduplicated) continue;
      created.push(result);
      existing.push(fromDatabaseTask(result));
    }
    this.storage?.setItem(MIGRATION_FLAG_KEY, JSON.stringify({ completedAt: new Date().toISOString(), imported: created.length }));
    return { imported: created.length, tasks: created.map(fromDatabaseTask), malformedSources: plan.malformedSources };
  }

  cacheTasks(userId, tasks) {
    this.storage?.setItem(`${CACHE_KEY_PREFIX}:${userId}`, JSON.stringify({ savedAt: new Date().toISOString(), tasks }));
  }

  readCachedTasks(userId) {
    try { return JSON.parse(this.storage?.getItem(`${CACHE_KEY_PREFIX}:${userId}`) || "null"); } catch { return null; }
  }
}
