export const GOOGLE_TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
export const DEFAULT_TASK_LIST_TITLE = "Personal OS";

const ORIGINAL_INTENT_PREFIX = "原始意图：";
const TASK_STATUS = new Set(["open", "completed", "cancelled"]);

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function dateToGoogleDue(date) {
  if (!validDate(date)) throw new Error("dueDate must be YYYY-MM-DD");
  return `${date}T00:00:00.000Z`;
}

export function googleDueToDate(due) {
  return typeof due === "string" && /^\d{4}-\d{2}-\d{2}T/.test(due) ? due.slice(0, 10) : null;
}

export function splitTaskNotes(value) {
  const lines = String(value || "").split("\n");
  const index = lines.findLastIndex((line) => line.startsWith(ORIGINAL_INTENT_PREFIX));
  if (index < 0) return { notes: String(value || ""), originalIntent: "" };
  const originalIntent = lines[index].slice(ORIGINAL_INTENT_PREFIX.length).trim();
  lines.splice(index, 1);
  return { notes: lines.join("\n").trim(), originalIntent };
}

export function composeTaskNotes(notes, originalIntent) {
  const cleanNotes = String(notes || "").trim();
  const cleanIntent = String(originalIntent || "").replace(/\s+/g, " ").trim();
  const combined = cleanIntent
    ? `${cleanNotes}${cleanNotes ? "\n\n" : ""}${ORIGINAL_INTENT_PREFIX}${cleanIntent}`
    : cleanNotes;
  return combined.slice(0, 8192);
}

export function toTaskModel(task, taskListId = "") {
  const completed = task.status === "completed";
  const parsedNotes = splitTaskNotes(task.notes);
  const dueDate = googleDueToDate(task.due);
  return {
    id: task.id,
    externalId: task.id,
    provider: "google_tasks",
    taskListId,
    title: task.title || "",
    notes: parsedNotes.notes,
    status: completed ? "completed" : "open",
    dueDate,
    createdAt: null,
    updatedAt: task.updated || null,
    completedAt: task.completed || null,
    source: "google_tasks",
    sourceConversationId: null,
    projectId: null,
    customerId: null,
    originalIntent: parsedNotes.originalIntent,
    priority: "medium",
    parent_task_id: task.parent || null,
    metadata: {},
    date: dueDate || "",
    time: "",
    category: "Google Tasks",
    duration: 0,
    done: completed,
    completed_at: task.completed || null,
    created_at: null,
    updated_at: task.updated || null,
    carried_from_date: null,
  };
}

export const toPublicTask = toTaskModel;

export function createGoogleTaskPayload(input) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 200) throw new Error("title must contain 1-200 characters");
  const dueDate = input.dueDate || input.due || input.date || "";
  const payload = {
    title,
    notes: composeTaskNotes(input.notes, input.originalIntent),
  };
  if (dueDate) payload.due = dateToGoogleDue(dueDate);
  if (input.status === "completed" || input.status === "done") payload.status = "completed";
  return payload;
}

export function updateGoogleTaskPayload(changes) {
  const payload = {};
  if (Object.hasOwn(changes, "title")) {
    const title = typeof changes.title === "string" ? changes.title.trim() : "";
    if (!title || title.length > 200) throw new Error("title must contain 1-200 characters");
    payload.title = title;
  }
  if (Object.hasOwn(changes, "notes") || Object.hasOwn(changes, "originalIntent")) {
    payload.notes = composeTaskNotes(changes.notes, changes.originalIntent);
  }
  const hasDueDate = ["dueDate", "due", "date"].some((key) => Object.hasOwn(changes, key));
  if (hasDueDate) {
    const dueDate = changes.dueDate ?? changes.due ?? changes.date;
    payload.due = dueDate ? dateToGoogleDue(dueDate) : null;
  }
  if (Object.hasOwn(changes, "status")) {
    if (!TASK_STATUS.has(changes.status) && changes.status !== "done") throw new Error("status must be open or completed");
    const completed = changes.status === "completed" || changes.status === "done";
    payload.status = completed ? "completed" : "needsAction";
    if (!completed) payload.completed = null;
  }
  return payload;
}

export function normalizeTaskTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/(?:今天|明天|后天|本周|这周|下周末|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天])/g, "")
    .replace(/(?:提醒我|记得|麻烦|请|一下|那个|这个|的)/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function characterBigrams(value) {
  if (value.length < 2) return new Set(value ? [value] : []);
  return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
}

export function taskTitleSimilarity(left, right) {
  const normalizedLeft = normalizeTaskTitle(left);
  const normalizedRight = normalizeTaskTitle(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return Math.min(normalizedLeft.length, normalizedRight.length) / Math.max(normalizedLeft.length, normalizedRight.length);
  }
  const leftBigrams = characterBigrams(normalizedLeft);
  const rightBigrams = characterBigrams(normalizedRight);
  const overlap = [...leftBigrams].filter((part) => rightBigrams.has(part)).length;
  return (2 * overlap) / (leftBigrams.size + rightBigrams.size || 1);
}

export function findDuplicateTask(input, tasks, threshold = 0.82) {
  const dueDate = input.dueDate || input.due || input.date || "";
  return tasks
    .filter((task) => task.status === "open" || task.status === "needsAction")
    .map((task) => ({ task, score: taskTitleSimilarity(input.title, task.title) }))
    .filter(({ task, score }) => score >= threshold && (!dueDate || !task.dueDate || task.dueDate === dueDate))
    .sort((left, right) => right.score - left.score)[0]?.task || null;
}

export function filterTaskModels(tasks, filter = "all", date = "") {
  const open = tasks.filter((task) => task.status === "open");
  if (filter === "completed") return tasks.filter((task) => task.status === "completed");
  if (filter === "today") return open.filter((task) => task.dueDate === date);
  if (filter === "overdue") return open.filter((task) => task.dueDate && task.dueDate < date);
  if (filter === "upcoming") return open.filter((task) => !task.dueDate || task.dueDate > date);
  if (filter === "open") return open;
  return tasks;
}

export function chooseTaskList(taskLists, preferredTitle = DEFAULT_TASK_LIST_TITLE) {
  const normalized = preferredTitle.trim().toLocaleLowerCase();
  return taskLists.find((list) => String(list.title || "").trim().toLocaleLowerCase() === normalized) || null;
}
