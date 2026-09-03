export const LEGACY_TASK_KEYS = ["richeng-tasks-v1", "gpt-personal-tasks-v1"];
export const MIGRATION_FLAG_KEY = "task-sync-cloud-migration-v1";
export const CACHE_KEY_PREFIX = "task-sync-cache-v1";

const KNOWN_SAMPLE_TITLES = new Set([
  "完成本周工作计划",
  "阅读 30 分钟",
  "晚饭后散步",
  "整理书桌和文件",
  "回顾昨天的会议记录",
  "准备下周学习清单",
  "推进企业微信接入督办",
  "搭建团队督办系统",
  "完善 MacBook / Codex 无人值守模式",
  "重建 Obsidian 长期知识镜像",
]);

export function localDateISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function offsetDate(days, from = new Date()) {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return localDateISO(date);
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function createUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error("This browser cannot create secure task identifiers");
}

export function fromDatabaseTask(row) {
  const completed = row.status === "completed" || row.status === "done" || row.done === true;
  const dueDate = row.dueDate || row.date || "";
  return {
    id: row.id,
    externalId: row.externalId || row.id,
    provider: row.provider || "google_tasks",
    taskListId: row.taskListId || "",
    title: row.title || "",
    notes: row.notes || "",
    status: row.status === "cancelled" ? "cancelled" : completed ? "completed" : "open",
    dueDate: dueDate || null,
    createdAt: row.createdAt || row.created_at || null,
    updatedAt: row.updatedAt || row.updated_at || null,
    completedAt: row.completedAt || row.completed_at || null,
    source: row.source || "google_tasks",
    sourceConversationId: row.sourceConversationId || null,
    projectId: row.projectId || null,
    customerId: row.customerId || null,
    originalIntent: row.originalIntent || "",
    priority: row.priority || "medium",
    metadata: row.metadata || {},
    date: dueDate,
    time: row.time ? String(row.time).slice(0, 5) : "",
    category: row.category || "Google Tasks",
    duration: Number(row.duration || 0),
    done: completed,
    carriedFromDate: row.carried_from_date || null,
  };
}

export function toDatabaseTask(task, { includeId = true } = {}) {
  const status = task.status || (task.done ? "done" : "open");
  const payload = {
    title: String(task.title || "").trim(),
    date: task.date,
    time: task.time || null,
    category: task.category || "工作",
    priority: ["high", "medium", "low"].includes(task.priority) ? task.priority : "medium",
    duration: Math.max(0, Math.min(1440, Number(task.duration) || 0)),
    notes: task.notes || "",
    status,
    completed_at: status === "done" ? (task.completedAt || new Date().toISOString()) : null,
    source: ["manual", "gpt", "carryover"].includes(task.source) ? task.source : "manual",
    carried_from_date: task.carriedFromDate || null,
  };
  if (includeId) payload.id = isUuid(task.id) ? task.id : createUuid();
  return payload;
}

function normalizeLegacyTask(task) {
  if (!task || typeof task !== "object") return null;
  const title = String(task.title || "").trim();
  const date = task.date || task.due;
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  if (KNOWN_SAMPLE_TITLES.has(title)) return null;
  const done = task.status === "done" || task.done === true;
  const cancelled = task.status === "cancelled";
  return toDatabaseTask({
    id: task.id,
    title,
    date,
    time: task.time || "",
    category: task.category || "工作",
    priority: task.priority || "medium",
    duration: task.duration ?? 30,
    notes: task.notes || "",
    status: cancelled ? "cancelled" : done ? "done" : "open",
    completedAt: done ? (task.completedAt || task.completed_at || new Date().toISOString()) : null,
    source: String(task.source || "").toLowerCase() === "gpt" ? "gpt" : task.carryCount ? "carryover" : "manual",
    carriedFromDate: task.carriedFromDate || task.carried_from_date || task.rolledFrom || null,
  });
}

export function collectLegacyTasks(storage) {
  const byId = new Map();
  let malformedSources = 0;
  for (const key of LEGACY_TASK_KEYS) {
    const raw = storage?.getItem(key);
    if (!raw) continue;
    try {
      const value = JSON.parse(raw);
      if (!Array.isArray(value)) throw new Error("Legacy task value is not an array");
      for (const candidate of value) {
        const normalized = normalizeLegacyTask(candidate);
        if (normalized) byId.set(normalized.id, normalized);
      }
    } catch {
      malformedSources += 1;
    }
  }
  return { tasks: [...byId.values()], malformedSources };
}

export function groupTasksForToday(tasks, date = localDateISO()) {
  const active = tasks.filter((task) => task.status !== "cancelled" && task.date === date);
  return {
    todayNew: active.filter((task) => !task.carriedFromDate),
    carryover: active.filter((task) => Boolean(task.carriedFromDate)),
    open: active.filter((task) => !task.done && task.status !== "done" && task.status !== "completed"),
    done: active.filter((task) => task.done || task.status === "done" || task.status === "completed"),
  };
}

export function groupTasksByDue(tasks, date = localDateISO()) {
  const open = tasks.filter((task) => task.status === "open");
  const byDueDate = (left, right) => String(left.dueDate || "9999-12-31").localeCompare(String(right.dueDate || "9999-12-31"));
  return {
    today: open.filter((task) => task.dueDate === date).sort(byDueDate),
    overdue: open.filter((task) => task.dueDate && task.dueDate < date).sort(byDueDate),
    upcoming: open.filter((task) => !task.dueDate || task.dueDate > date).sort(byDueDate),
    completed: tasks
      .filter((task) => task.status === "completed")
      .sort((left, right) => String(right.completedAt || right.updatedAt || "").localeCompare(String(left.completedAt || left.updatedAt || ""))),
  };
}

export function replaceTask(tasks, updated) {
  const normalized = fromDatabaseTask(updated);
  return tasks.map((task) => task.id === normalized.id ? normalized : task);
}

export function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
}
