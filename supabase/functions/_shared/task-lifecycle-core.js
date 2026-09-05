const VALID_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const VALID_TASK_TYPES = new Set(["task", "follow_up"]);
const CLEARABLE_FIELDS = new Set([
  "notes",
  "due",
  "deadline",
  "requested_date",
  "requested_time",
  "parent_task_id",
  "follow_up_of",
]);
const PATCH_FIELDS = new Set([
  "title",
  "notes",
  "due",
  "date",
  "deadline",
  "requested_date",
  "requested_time",
  "priority",
  "estimated_duration",
  "fixed_time",
  "timezone",
  "task_type",
  "parent_task_id",
  "follow_up_of",
  "follow_up_sequence",
]);

function hasOwn(value, key) {
  return Boolean(value && Object.hasOwn(value, key));
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function cleanOptionalString(value, name, maxLength) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string or null`);
  const clean = value.trim();
  if (!clean || clean.length > maxLength) throw new Error(`${name} must contain 1-${maxLength} characters`);
  return clean;
}

function normalizedText(value) {
  return String(value || "")
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function newestTimestamp(...values) {
  return values
    .filter(Boolean)
    .map(String)
    .sort((left, right) => right.localeCompare(left))[0] || null;
}

export function detectFollowUpIntent(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/【(?:二|三|四|五|六|七|八|九|十|\d+)次跟进】/.test(text)) return true;
  const waitingForResult = /(?:了解|处理|确认|沟通|申请|询问|问|核实|反馈|回复|审批|调查|查看).{0,24}(?:完(?:成)?|以后|之后|后|有结果|出结果|反馈)/;
  const nextUserAction = /(?:我|我们|本人).{0,20}(?:再|还要|仍要|需要|继续|届时|然后)?.{0,16}(?:问|追问|跟进|确认|决定|推进|处理|联系)/;
  return waitingForResult.test(text) && nextUserAction.test(text);
}

export function followUpTimingText(value) {
  const text = String(value || "");
  const marker = /(?:了解完(?:成)?|处理完(?:成)?|确认完(?:成)?|沟通完(?:成)?|申请完(?:成)?|询问完(?:成)?|问完|核实完(?:成)?|有结果(?:以后|之后|后)?|出结果(?:以后|之后|后)?|反馈(?:以后|之后|后))/g;
  let match;
  let lastIndex = -1;
  while ((match = marker.exec(text))) lastIndex = match.index + match[0].length;
  if (lastIndex < 0) return text;
  const after = text.slice(lastIndex);
  return /(?:20\d{2}[-年]|\d{1,2}月\d{1,2}|今天|明天|后天|周|星期)/.test(after) ? after : text;
}

const FOLLOW_UP_NUMERALS = new Map([
  [2, "二"], [3, "三"], [4, "四"], [5, "五"], [6, "六"],
  [7, "七"], [8, "八"], [9, "九"], [10, "十"],
]);

export function ensureFollowUpTitle(value, sequence = 2) {
  const title = String(value || "").trim();
  if (!title) return title;
  if (/^【(?:二|三|四|五|六|七|八|九|十|\d+)次跟进】/.test(title)) return title;
  const number = FOLLOW_UP_NUMERALS.get(Number(sequence)) || String(sequence);
  return `【${number}次跟进】${title}`;
}

export function suggestedFollowUpTitle(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(.{1,30}?)(?:(?:今天|明天|后天|本周|这周|下周(?:[一二三四五六日天末])?|周[一二三四五六日天]|星期[一二三四五六日天]|20\d{2}[-年]\d{1,2}[-月]\d{1,2}[日号]?|\d{1,2}月\d{1,2}[日号]?))?(?:会|要|需要|先|去|帮忙|帮我|过去|再)*\s*(了解|处理|确认|沟通|申请|询问|问|核实|查看)/);
  if (!match) return "跟进处理结果";
  const subject = match[1]
    .replace(/^(?:让|请|麻烦)/, "")
    .replace(/(?:需要|先|会|要|去)$/g, "")
    .trim();
  return subject ? `跟进${subject}${match[2]}结果` : `跟进${match[2]}结果`;
}

/** @returns {Record<string, unknown>} */
export function normalizeTaskPatch(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("changes must be an object");
  const source = input.changes && typeof input.changes === "object" && !Array.isArray(input.changes)
    ? input.changes
    : input;
  const changes = {};
  for (const field of PATCH_FIELDS) {
    if (hasOwn(source, field)) changes[field] = source[field];
  }
  for (const field of input.clear_fields || source.clear_fields || []) {
    if (!CLEARABLE_FIELDS.has(field)) throw new Error(`clear_fields contains unsupported field: ${field}`);
    changes[field] = null;
  }
  if (hasOwn(changes, "date")) {
    if (hasOwn(changes, "due") && changes.due !== changes.date) throw new Error("date and due must match when both are provided");
    changes.due = changes.date;
    delete changes.date;
  }
  if (hasOwn(changes, "title")) {
    if (changes.title === null) throw new Error("title cannot be cleared");
    changes.title = cleanOptionalString(changes.title, "title", 200);
  }
  if (hasOwn(changes, "notes") && changes.notes !== null) {
    if (typeof changes.notes !== "string" || changes.notes.length > 10_000) throw new Error("notes must contain at most 10000 characters");
  }
  for (const field of ["due", "deadline", "requested_date"]) {
    if (hasOwn(changes, field) && changes[field] !== null && !validDate(changes[field])) {
      throw new Error(`${field} must be YYYY-MM-DD or null`);
    }
  }
  if (hasOwn(changes, "requested_time") && changes.requested_time !== null && !validTime(changes.requested_time)) {
    throw new Error("requested_time must be HH:MM or null");
  }
  if (hasOwn(changes, "priority") && !VALID_PRIORITIES.has(changes.priority)) throw new Error("priority is invalid");
  if (hasOwn(changes, "estimated_duration")) {
    const duration = Number(changes.estimated_duration);
    if (!Number.isInteger(duration) || duration < 5 || duration > 720) throw new Error("estimated_duration must be between 5 and 720");
    changes.estimated_duration = duration;
  }
  if (hasOwn(changes, "fixed_time") && typeof changes.fixed_time !== "boolean") throw new Error("fixed_time must be a boolean");
  if (hasOwn(changes, "timezone")) changes.timezone = cleanOptionalString(changes.timezone, "timezone", 80);
  if (hasOwn(changes, "task_type") && !VALID_TASK_TYPES.has(changes.task_type)) throw new Error("task_type is invalid");
  for (const field of ["parent_task_id", "follow_up_of"]) {
    if (hasOwn(changes, field) && changes[field] !== null) changes[field] = cleanOptionalString(changes[field], field, 1024);
  }
  if (hasOwn(changes, "follow_up_sequence")) {
    const sequence = Number(changes.follow_up_sequence);
    if (!Number.isInteger(sequence) || sequence < 2 || sequence > 99) throw new Error("follow_up_sequence must be between 2 and 99");
    changes.follow_up_sequence = sequence;
  }
  if (!Object.keys(changes).length) throw new Error("At least one field must be updated or cleared");
  return changes;
}

/** @returns {Record<string, unknown>} */
export function googleTaskChanges(changes) {
  const result = {};
  for (const field of ["title", "notes", "due"]) if (hasOwn(changes, field)) result[field] = changes[field];
  return result;
}

export function hasScheduleChanges(changes) {
  return [
    "due", "requested_date", "requested_time", "deadline", "priority",
    "estimated_duration", "fixed_time", "timezone", "task_type",
    "parent_task_id", "follow_up_of", "follow_up_sequence",
  ].some((field) => hasOwn(changes, field));
}

/**
 * @param {Record<string, any>} task
 * @param {Record<string, any> | null} schedule
 * @returns {Record<string, any>}
 */
export function taskView(task, schedule = null) {
  const googleTaskId = String(task?.google_task_id || task?.task_id || task?.id || "");
  const due = task?.dueDate || task?.due || task?.date || null;
  const taskType = schedule?.task_type || (/^【(?:二|三|四|五|六|七|八|九|十|\d+)次跟进】/.test(String(task?.title || "")) ? "follow_up" : "task");
  const safeSchedule = schedule ? Object.fromEntries(Object.entries(schedule).filter(([key]) => key !== "owner_id")) : null;
  return {
    ...task,
    id: googleTaskId,
    task_id: googleTaskId,
    google_task_id: googleTaskId,
    schedule_id: schedule?.id || null,
    date: due,
    due,
    deadline: schedule?.deadline ?? task?.deadline ?? null,
    priority: schedule?.priority || task?.priority || "medium",
    task_type: taskType,
    parent_task_id: schedule?.parent_task_id || null,
    follow_up_of: schedule?.follow_up_of || null,
    follow_up_sequence: schedule?.follow_up_sequence || (taskType === "follow_up" ? 2 : null),
    requested_date: schedule?.scheduled_date || null,
    requested_time: schedule?.scheduled_start ? String(schedule.scheduled_start).slice(0, 5) : null,
    estimated_duration: schedule?.duration_minutes || null,
    fixed_time: schedule?.fixed_time === true,
    timezone: schedule?.timezone || null,
    calendar_event_id: schedule?.calendar_event_id || null,
    created_at: task?.createdAt || task?.created_at || schedule?.created_at || null,
    updated_at: newestTimestamp(task?.updatedAt, task?.updated_at, schedule?.updated_at),
    schedule: safeSchedule,
  };
}

/**
 * Hydrate a create-task write result with a canonical readback of the same
 * stable Google Task. Write metadata (especially idempotency state) remains
 * authoritative, while Task fields come from the current source of truth.
 *
 * @param {Record<string, any>} writeResult
 * @param {Record<string, any> | null} canonicalTask
 * @returns {Record<string, any>}
 */
export function hydrateTaskWriteResult(writeResult, canonicalTask = null) {
  const write = writeResult && typeof writeResult === "object" ? writeResult : {};
  const readback = canonicalTask && typeof canonicalTask === "object" ? canonicalTask : {};
  const merged = { ...write, ...readback };
  for (const field of [
    "success",
    "destination",
    "deduplicated",
    "idempotency_key",
    "replayed",
    "projection",
    "goal_plan_id",
    "goal_linked",
    "goal_link_error",
    "code",
    "error",
  ]) {
    if (hasOwn(write, field)) merged[field] = write[field];
  }
  const taskId = String(readback.task_id || readback.google_task_id || readback.id
    || write.task_id || write.google_task_id || write.id || "");
  if (taskId) {
    merged.id = taskId;
    merged.task_id = taskId;
    merged.google_task_id = taskId;
  }
  return merged;
}

function within(value, from, to) {
  if (!value) return false;
  const comparable = String(value);
  return (!from || comparable >= from) && (!to || comparable <= to);
}

function queryScore(task, query) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return 1;
  const tokens = cleanQuery.split(/\s+/).map(normalizedText).filter(Boolean);
  const id = normalizedText(task.task_id);
  const title = normalizedText(task.title);
  const notes = normalizedText(task.notes);
  const intent = normalizedText(task.originalIntent || task.original_intent);
  const combined = `${id} ${title} ${notes} ${intent}`;
  if (!tokens.every((token) => combined.includes(token))) return 0;
  let score = 0;
  for (const token of tokens) {
    if (id === token) score += 100;
    else if (id.includes(token)) score += 40;
    if (title === token) score += 50;
    else if (title.includes(token)) score += 20;
    if (notes.includes(token)) score += 6;
    if (intent.includes(token)) score += 3;
  }
  return score || 1;
}

export function searchTaskViews(tasks, schedules = [], options = {}) {
  const scheduleByTask = new Map(schedules.map((schedule) => [String(schedule.google_task_id), schedule]));
  const status = String(options.status || "open");
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
  return tasks
    .map((task) => taskView(task, scheduleByTask.get(String(task.id || task.task_id || task.google_task_id)) || null))
    .map((task) => ({ task, score: queryScore(task, options.query || options.task_id || "") }))
    .filter(({ task, score }) => {
      if (!score) return false;
      if (options.task_id && task.task_id !== options.task_id) return false;
      if (status !== "all" && task.status !== status) return false;
      if (options.priority && task.priority !== options.priority) return false;
      if (options.task_type && task.task_type !== options.task_type) return false;
      if ((options.date_from || options.date_to) && !within(task.date, options.date_from, options.date_to)) return false;
      if ((options.deadline_from || options.deadline_to) && !within(task.deadline, options.deadline_from, options.deadline_to)) return false;
      if ((options.created_from || options.created_to) && !within(task.created_at, options.created_from, options.created_to)) return false;
      if ((options.updated_from || options.updated_to) && !within(task.updated_at, options.updated_from, options.updated_to)) return false;
      return true;
    })
    .sort((left, right) => right.score - left.score
      || String(right.task.updated_at || "").localeCompare(String(left.task.updated_at || ""))
      || String(left.task.date || "9999-12-31").localeCompare(String(right.task.date || "9999-12-31")))
    .slice(0, limit)
    .map(({ task, score }) => ({ ...task, match_score: score }));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

export function canonicalTaskMutation(action, taskId, input = {}) {
  return JSON.stringify(sortObject({
    action,
    task_id: taskId,
    changes: input.changes || null,
    clear_fields: input.clear_fields || [],
  }));
}
