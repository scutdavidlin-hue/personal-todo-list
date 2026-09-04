import { classifyAction, parseIntentDate, parseIntentDuration, parseIntentTime } from "./action-router.js";
import { normalizeScheduleInput, validScheduleTime } from "./schedule-core.js";

export const INTAKE_TYPES = Object.freeze([
  "task",
  "calendar_event",
  "project_data",
  "knowledge",
  "gpt_job",
]);

const TYPE_SET = new Set(INTAKE_TYPES);
const DESTINATIONS = Object.freeze({
  task: "google_tasks",
  calendar_event: "google_calendar",
  project_data: "project_data",
  knowledge: "knowledge",
  gpt_job: "gpt_schedule",
});

function cleanString(value, maxLength = 10_000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function destinationFor(type) {
  return DESTINATIONS[type] || "none";
}

export function normalizeIntake(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Request body must be an object");
  const rawText = cleanString(input.raw_text || input.input);
  const explicitType = cleanString(input.type, 40);
  if (!rawText) throw new Error("raw_text is required");
  if (explicitType && !TYPE_SET.has(explicitType)) throw new Error(`type must be one of: ${INTAKE_TYPES.join(", ")}`);

  const route = explicitType
    ? { type: explicitType, confidence: 1, payload: {} }
    : classifyAction(rawText, { baseDate: input.baseDate || options.baseDate });
  const type = route.type === "note" ? "knowledge" : route.type;
  if (!TYPE_SET.has(type)) throw new Error(`Unsupported intake type: ${type}`);

  const due = cleanString(input.due || input.dueDate || route.payload?.dueDate, 10);
  if (due && !validDate(due)) throw new Error("due must be YYYY-MM-DD");
  const title = cleanString(input.title || route.payload?.title || rawText, 200);
  if (type === "task" && !title) throw new Error("title is required for task intake");

  const parsedDate = parseIntentDate(rawText, input.baseDate || options.baseDate ? new Date(input.baseDate || options.baseDate) : new Date());
  const parsedTime = parseIntentTime(rawText);
  const deadline = cleanString(input.deadline || route.payload?.deadline, 10) || null;
  if (deadline && !validDate(deadline)) throw new Error("deadline must be YYYY-MM-DD");
  const requestedDate = cleanString(input.requested_date || input.requestedDate || route.payload?.requestedDate || (!deadline ? due || parsedDate : ""), 10) || null;
  if (requestedDate && !validDate(requestedDate)) throw new Error("requested_date must be YYYY-MM-DD");
  const requestedTime = cleanString(input.requested_time || input.requestedTime || route.payload?.requestedTime || parsedTime, 5) || null;
  if (requestedTime && !validScheduleTime(requestedTime)) throw new Error("requested_time must be HH:MM");
  const estimatedDuration = Number(input.estimated_duration || input.estimatedDuration || route.payload?.estimatedDuration || parseIntentDuration(rawText));
  const priority = cleanString(input.priority || route.payload?.priority, 20) || "medium";
  const fixedTime = input.fixed_time === true || input.fixedTime === true || route.payload?.fixedTime === true;
  const schedulingSource = cleanString(input.scheduling_source || input.schedulingSource || route.payload?.schedulingSource, 30)
    || (requestedDate || requestedTime ? "explicit_user" : "gpt_inferred");
  const schedule = type === "task" && (requestedDate || requestedTime || deadline || input.schedule)
    ? normalizeScheduleInput({
      ...(input.schedule || {}),
      scheduled_date: requestedDate,
      scheduled_start: requestedTime,
      duration_minutes: estimatedDuration,
      deadline,
      priority,
      fixed_time: fixedTime,
      scheduling_source: schedulingSource,
      timezone: cleanString(input.timezone, 80) || "Asia/Shanghai",
    })
    : null;

  return {
    source: cleanString(input.source, 80) || "chatgpt",
    raw_text: rawText,
    type,
    confidence: route.confidence,
    destination: destinationFor(type),
    title,
    notes: cleanString(input.notes || route.payload?.notes),
    due: due || null,
    timezone: cleanString(input.timezone, 80) || "Asia/Shanghai",
    deadline,
    requested_date: requestedDate,
    requested_time: requestedTime,
    estimated_duration: estimatedDuration,
    priority,
    fixed_time: fixedTime,
    scheduling_source: schedulingSource,
    schedule,
    payload: route.payload || {},
  };
}

export function canonicalIntake(intake) {
  return JSON.stringify({
    source: intake.source,
    raw_text: intake.raw_text,
    type: intake.type,
    title: intake.title,
    notes: intake.notes,
    due: intake.due,
    timezone: intake.timezone,
    deadline: intake.deadline,
    requested_date: intake.requested_date,
    requested_time: intake.requested_time,
    estimated_duration: intake.estimated_duration,
    priority: intake.priority,
    fixed_time: intake.fixed_time,
    scheduling_source: intake.scheduling_source,
  });
}

export function taskDispatchPayload(intake) {
  if (intake.type !== "task") throw new Error("Only task intake can be dispatched to Google Tasks");
  return {
    title: intake.title,
    notes: intake.notes,
    dueDate: intake.due,
    originalIntent: intake.raw_text,
    source: intake.source,
    ...(intake.schedule ? { schedule: intake.schedule } : {}),
  };
}
