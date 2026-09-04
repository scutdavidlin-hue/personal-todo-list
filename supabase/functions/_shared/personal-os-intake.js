import { classifyAction, parseIntentDate, parseIntentDuration, parseIntentTime } from "./action-router.js";
import { normalizeScheduleInput, validScheduleTime } from "./schedule-core.js";

export const INTAKE_TYPES = Object.freeze([
  "task",
  "goal",
  "plan",
  "long_term_item",
  "financial_item",
  "calendar_event",
  "project_data",
  "contact",
  "client",
  "knowledge",
  "gpt_job",
]);

const TYPE_SET = new Set(INTAKE_TYPES);
const DESTINATIONS = Object.freeze({
  task: "google_tasks",
  goal: "goals_plans",
  plan: "goals_plans",
  long_term_item: "goals_plans",
  financial_item: "goals_plans",
  calendar_event: "google_calendar",
  project_data: "project_data",
  contact: "contacts",
  client: "clients",
  knowledge: "knowledge",
  gpt_job: "gpt_schedule",
});

const GOAL_INTAKE_TYPES = new Set(["goal", "plan", "long_term_item", "financial_item"]);
const GOAL_TYPES = new Set(["Goal", "Plan", "LongTermItem", "FinancialItem", "Idea", "LifePlan", "BusinessPlan", "FamilyPlan"]);
const GOAL_CATEGORIES = new Set(["Career", "Business", "Finance", "Family", "Health", "Travel", "Learning", "Property", "Personal", "Relationship", "Other"]);
const GOAL_STATUSES = new Set(["Inbox", "Thinking", "Planning", "Active", "Paused", "Completed", "Dropped", "Archived"]);
const GOAL_HORIZONS = new Set(["short", "medium", "long"]);
const FINANCIAL_TYPES = new Set(["Receivable", "Payable", "Budget", "SavingGoal", "InvestmentGoal"]);
const GOAL_TYPE_BY_INTAKE = Object.freeze({
  goal: "Goal",
  plan: "Plan",
  long_term_item: "LongTermItem",
  financial_item: "FinancialItem",
});

function cleanString(value, maxLength = 10_000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function optionalNumber(value, name, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
    throw new Error(`${name} is invalid`);
  }
  return number;
}

function enumValue(value, values, fallback, name) {
  const clean = cleanString(value, 40) || fallback;
  if (clean && !values.has(clean)) throw new Error(`${name} is invalid`);
  return clean || null;
}

function optionalUuid(value, name) {
  const clean = cleanString(value, 36);
  if (clean && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)) {
    throw new Error(`${name} is invalid`);
  }
  return clean || null;
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
  if ((type === "task" || GOAL_INTAKE_TYPES.has(type)) && !title) throw new Error("title is required for task and goal intake");

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

  const targetDate = cleanString(input.target_date || input.targetDate || route.payload?.targetDate, 10) || null;
  if (targetDate && !validDate(targetDate)) throw new Error("target_date must be YYYY-MM-DD");
  const targetMonth = cleanString(input.target_month || input.targetMonth || route.payload?.targetMonth, 7) || null;
  if (targetMonth && !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(targetMonth)) throw new Error("target_month must be YYYY-MM");
  const targetYear = optionalNumber(input.target_year ?? input.targetYear ?? route.payload?.targetYear, "target_year", { integer: true, min: 2000, max: 2200 });
  if ([targetDate, targetMonth, targetYear].filter(Boolean).length > 1) throw new Error("Use only one target precision: target_date, target_month, or target_year");
  const startDate = cleanString(input.start_date || input.startDate, 10) || null;
  if (startDate && !validDate(startDate)) throw new Error("start_date must be YYYY-MM-DD");
  const reviewDate = cleanString(input.review_date || input.reviewDate, 10) || null;
  if (reviewDate && !validDate(reviewDate)) throw new Error("review_date must be YYYY-MM-DD");
  const goalDeadline = GOAL_INTAKE_TYPES.has(type) ? (cleanString(input.deadline, 10) || null) : null;
  const amountTotal = optionalNumber(input.amount_total ?? input.amountTotal ?? route.payload?.amountTotal, "amount_total");
  const amountCompleted = optionalNumber(input.amount_completed ?? input.amountCompleted ?? route.payload?.amountCompleted, "amount_completed") ?? 0;
  if (amountTotal !== null && amountCompleted > amountTotal) throw new Error("amount_completed cannot exceed amount_total");

  const goalType = GOAL_INTAKE_TYPES.has(type)
    ? enumValue(input.goal_type || input.goalType, GOAL_TYPES, GOAL_TYPE_BY_INTAKE[type], "goal_type")
    : null;
  const category = GOAL_INTAKE_TYPES.has(type)
    ? enumValue(input.category || route.payload?.category, GOAL_CATEGORIES, type === "financial_item" ? "Finance" : "Personal", "category")
    : null;
  const goalStatus = GOAL_INTAKE_TYPES.has(type)
    ? enumValue(input.status || route.payload?.status, GOAL_STATUSES, type === "goal" ? "Planning" : type === "plan" ? "Thinking" : "Active", "status")
    : null;
  const financialType = GOAL_INTAKE_TYPES.has(type)
    ? enumValue(input.financial_type || input.financialType || route.payload?.financialType, FINANCIAL_TYPES, type === "financial_item" ? "Budget" : "", "financial_type")
    : null;
  const horizon = GOAL_INTAKE_TYPES.has(type)
    ? enumValue(input.horizon || route.payload?.horizon, GOAL_HORIZONS, "medium", "horizon")
    : null;
  const goalPlanId = type === "task"
    ? optionalUuid(input.goal_plan_id || input.goalPlanId || input.goal_id || input.goalId, "goal_plan_id")
    : null;
  const existingGoalId = GOAL_INTAKE_TYPES.has(type)
    ? optionalUuid(input.existing_goal_id || input.existingGoalId || input.goal_id || input.goalId, "existing_goal_id")
    : null;
  const explicitFields = {
    horizon: Object.hasOwn(input, "horizon") || /(?:短期|中期|长期|接下来(?:的)?几个月|未来几个月|今年年底|本年年底)/.test(rawText),
    status: Object.hasOwn(input, "status"),
    priority: Object.hasOwn(input, "priority"),
    progress_percent: Object.hasOwn(input, "progress_percent") || Object.hasOwn(input, "progressPercent"),
    amount_total: Object.hasOwn(input, "amount_total") || Object.hasOwn(input, "amountTotal") || route.payload?.amountTotal !== undefined,
    amount_completed: Object.hasOwn(input, "amount_completed") || Object.hasOwn(input, "amountCompleted"),
    currency: Object.hasOwn(input, "currency"),
  };

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
    goal_type: goalType,
    category,
    goal_status: goalStatus,
    horizon,
    description: cleanString(input.description || route.payload?.description || input.notes || route.payload?.notes),
    why: cleanString(input.why),
    target_date: targetDate,
    target_month: targetMonth,
    target_year: targetYear,
    start_date: startDate,
    review_date: reviewDate,
    goal_deadline: goalDeadline,
    progress_percent: optionalNumber(input.progress_percent ?? input.progressPercent, "progress_percent", { integer: true, min: 0, max: 100 }) ?? 0,
    amount_total: amountTotal,
    amount_completed: amountCompleted,
    currency: cleanString(input.currency || route.payload?.currency, 3).toUpperCase() || "CNY",
    counterparty: cleanString(input.counterparty || route.payload?.counterparty, 200) || null,
    financial_type: financialType,
    client_id: cleanString(input.client_id || input.clientId, 36) || null,
    contact_id: cleanString(input.contact_id || input.contactId, 36) || null,
    company_id: cleanString(input.company_id || input.companyId, 36) || null,
    goal_plan_id: goalPlanId,
    existing_goal_id: existingGoalId,
    explicit_fields: explicitFields,
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
    goal_type: intake.goal_type,
    category: intake.category,
    goal_status: intake.goal_status,
    horizon: intake.horizon,
    description: intake.description,
    why: intake.why,
    target_date: intake.target_date,
    target_month: intake.target_month,
    target_year: intake.target_year,
    start_date: intake.start_date,
    review_date: intake.review_date,
    goal_deadline: intake.goal_deadline,
    progress_percent: intake.progress_percent,
    amount_total: intake.amount_total,
    amount_completed: intake.amount_completed,
    currency: intake.currency,
    counterparty: intake.counterparty,
    financial_type: intake.financial_type,
    client_id: intake.client_id,
    contact_id: intake.contact_id,
    company_id: intake.company_id,
    goal_plan_id: intake.goal_plan_id,
    existing_goal_id: intake.existing_goal_id,
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

export function goalPlanDispatchPayload(intake) {
  if (!GOAL_INTAKE_TYPES.has(intake.type)) throw new Error("Only goal-related intake can be dispatched to Goals & Plans");
  return {
    title: intake.title,
    description: intake.description,
    why: intake.why,
    type: intake.goal_type,
    category: intake.category,
    status: intake.goal_status,
    horizon: intake.horizon,
    priority: intake.priority,
    progress_percent: intake.progress_percent,
    target_date: intake.target_date,
    target_month: intake.target_month,
    target_year: intake.target_year,
    start_date: intake.start_date,
    review_date: intake.review_date,
    deadline: intake.goal_deadline,
    amount_total: intake.amount_total,
    amount_completed: intake.amount_completed,
    currency: intake.currency,
    counterparty: intake.counterparty,
    financial_type: intake.financial_type,
    client_id: intake.client_id,
    contact_id: intake.contact_id,
    company_id: intake.company_id,
    notes: intake.notes,
    original_input: intake.raw_text,
  };
}
