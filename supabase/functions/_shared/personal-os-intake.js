import { classifyAction } from "./action-router.js";

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
  };
}
