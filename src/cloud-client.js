import {
  CACHE_KEY_PREFIX,
  MIGRATION_FLAG_KEY,
  collectLegacyTasks,
  fromDatabaseTask,
  toDatabaseTask,
} from "./core.js";

const SESSION_KEY = "task-sync-auth-session-v1";
const TASK_SELECT = "id,title,date,time,category,priority,duration,notes,status,done,completed_at,created_at,updated_at,source,carried_from_date";

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
    this.location = options.location || globalThis.location;
  }

  isConfigured() {
    return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(this.url)
      && this.anonKey.length > 20
      && !/YOUR_|PLACEHOLDER/i.test(this.anonKey);
  }

  session() {
    try {
      return JSON.parse(this.storage?.getItem(SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  saveSession(session) {
    if (!session) this.storage?.removeItem(SESSION_KEY);
    else this.storage?.setItem(SESSION_KEY, JSON.stringify(session));
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
    if (globalThis.history?.replaceState && this.location) {
      globalThis.history.replaceState(null, "", `${this.location.pathname}${this.location.search || ""}`);
    }
    return true;
  }

  async rawRequest(url, init = {}) {
    if (!this.fetch) throw new CloudError("当前环境无法访问网络", { code: "NO_FETCH" });
    let response;
    try {
      response = await this.fetch(url, init);
    } catch (cause) {
      throw new CloudError("无法连接云端，请检查网络后重试", { code: "NETWORK_ERROR", cause });
    }
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    if (!response.ok) {
      const message = payload?.msg || payload?.message || payload?.error_description || payload?.error || `云端请求失败（${response.status}）`;
      throw new CloudError(message, { status: response.status, code: payload?.code || "HTTP_ERROR" });
    }
    return payload;
  }

  async requestMagicLink(email, redirectTo) {
    const redirect = encodeURIComponent(redirectTo);
    return this.rawRequest(`${this.url}/auth/v1/otp?redirect_to=${redirect}`, {
      method: "POST",
      headers: { apikey: this.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
    });
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
        user: refreshed.user,
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
    if (!token) throw new CloudError("请先登录", { status: 401, code: "AUTH_REQUIRED" });
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
      if (retry && error.status === 401) {
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
      const current = this.session();
      this.saveSession({ ...current, user });
      return user;
    } catch (error) {
      if (error.status === 401) return null;
      throw error;
    }
  }

  async signOut() {
    try {
      if (this.session()?.access_token) await this.authenticatedRequest("/auth/v1/logout", { method: "POST" }, { retry: false });
    } catch {
      // A local logout must still succeed when the network is unavailable.
    } finally {
      this.saveSession(null);
    }
  }

  async rollover(date) {
    return this.authenticatedRequest("/rest/v1/rpc/rollover_open_tasks", {
      method: "POST",
      body: JSON.stringify({ target_date: date }),
    });
  }

  async getTasks(date) {
    await this.rollover(date);
    const rows = await this.authenticatedRequest(`/rest/v1/tasks?select=${TASK_SELECT}&status=neq.cancelled&order=date.asc,time.asc.nullslast,created_at.asc`, { method: "GET" });
    return rows.map(fromDatabaseTask);
  }

  async createTask(task) {
    const payload = toDatabaseTask(task, { includeId: false });
    const rows = await this.authenticatedRequest(`/rest/v1/tasks?select=${TASK_SELECT}`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload),
    });
    return rows[0];
  }

  async updateTask(id, changes) {
    const payload = {};
    const keys = ["title", "date", "time", "category", "priority", "duration", "notes", "status", "completed_at", "source", "carried_from_date"];
    for (const key of keys) if (Object.hasOwn(changes, key)) payload[key] = changes[key];
    const rows = await this.authenticatedRequest(`/rest/v1/tasks?id=eq.${encodeURIComponent(id)}&select=${TASK_SELECT}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload),
    });
    if (!rows[0]) throw new CloudError("任务不存在或无权修改", { status: 404, code: "TASK_NOT_FOUND" });
    return rows[0];
  }

  async cancelTask(id) {
    return this.updateTask(id, { status: "cancelled", completed_at: null });
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
    const rows = await this.authenticatedRequest(`/rest/v1/tasks?on_conflict=id&select=${TASK_SELECT}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(plan.tasks),
    });
    this.storage?.setItem(MIGRATION_FLAG_KEY, JSON.stringify({ completedAt: new Date().toISOString(), imported: rows.length }));
    return { imported: rows.length, tasks: rows.map(fromDatabaseTask), malformedSources: plan.malformedSources };
  }

  cacheTasks(userId, tasks) {
    this.storage?.setItem(`${CACHE_KEY_PREFIX}:${userId}`, JSON.stringify({ savedAt: new Date().toISOString(), tasks }));
  }

  readCachedTasks(userId) {
    try { return JSON.parse(this.storage?.getItem(`${CACHE_KEY_PREFIX}:${userId}`) || "null"); } catch { return null; }
  }
}
