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
const REQUEST_TIMEOUT_MS = 45_000;

function taskMutationKey(action = "task") {
  const id = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${action}:${id}`;
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
      const message = payload?.message || payload?.error_description || payload?.error || `云端请求失败（${response.status}）`;
      throw new CloudError(message, { status: response.status, code: payload?.code || "HTTP_ERROR" });
    }
    return payload;
  }

  async refreshSession() {
    const current = this.session();
    if (!current?.refresh_token) return null;
    try {
      const refreshed = await this.rawRequest(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: this.anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: current.refresh_token }),
      });
      const session = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || current.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600),
        token_type: refreshed.token_type || "bearer",
        user: refreshed.user || current.user,
      };
      this.saveSession(session);
      return session;
    } catch (error) {
      if (error.status === 400 || error.status === 401) this.saveSession(null);
      throw error;
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
    try {
      return await this.rawRequest(`${this.url}${path}`, {
        ...init,
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      if (retry && error.status === 401 && error.code !== "GOOGLE_REAUTH_REQUIRED") {
        await this.refreshSession();
        return this.authenticatedRequest(path, init, { retry: false });
      }
      throw error;
    }
  }

  async getUser() {
    const token = await this.accessToken();
    if (!token) return null;
    try {
      const user = await this.authenticatedRequest("/auth/v1/user", { method: "GET" });
      this.saveSession({ ...this.session(), user });
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

  async createTask(task) {
    const idempotencyKey = String(task?.idempotency_key || task?.idempotencyKey || taskMutationKey("create"));
    const result = await this.tasksRequest("POST", { action: "create", task }, "", { idempotencyKey });
    return result.task;
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
    const result = await this.tasksRequest("PATCH", { action: "complete", id, completed }, "", { idempotencyKey: taskMutationKey("complete") });
    return result.task;
  }

  async reopenTask(id) {
    const result = await this.tasksRequest("PATCH", { action: "reopen", id }, "", { idempotencyKey: taskMutationKey("reopen") });
    return result.task;
  }

  async updateTask(id, changes) {
    if (Object.hasOwn(changes, "status") && Object.keys(changes).every((key) => ["status", "completed_at"].includes(key))) {
      return changes.status === "open" ? this.reopenTask(id) : this.completeTask(id, true);
    }
    const result = await this.tasksRequest("PATCH", { action: "update", id, changes }, "", { idempotencyKey: taskMutationKey("update") });
    return result.task;
  }

  async deleteTask(id) {
    return this.tasksRequest("DELETE", { id }, "", { idempotencyKey: taskMutationKey("delete") });
  }

  async cancelTask(id) {
    return this.deleteTask(id);
  }

  async listSchedules() {
    return this.authenticatedRequest("/functions/v1/task-scheduler", { method: "GET" });
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
