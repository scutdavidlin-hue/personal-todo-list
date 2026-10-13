import { Hono } from "hono";
import { z } from "zod";

import { completeGoalPatch, filterGoalsForRead, isPersistedObjectResult, mergeGoalText } from "../_shared/goal-operations.js";
import { resolvePublishableApiKey } from "../_shared/supabase-api-keys.js";
import { intakeConfirmation } from "../_shared/autonomy-runtime.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const USE_NEW_API_KEYS = Deno.env.get("SUPABASE_USE_NEW_API_KEYS") === "true";
const SUPABASE_PUBLIC_KEY = resolvePublishableApiKey({
  publishableKeys: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
  anonKey: Deno.env.get("SUPABASE_ANON_KEY"),
  preferNew: USE_NEW_API_KEYS,
});
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";
const WRITE_TOKEN = Deno.env.get("AUTOMATION_WRITE_TOKEN") ?? "";
const FUNCTION_ROOT = `${SUPABASE_URL}/functions/v1/personal-os-mcp`;
const MCP_RESOURCE = `${FUNCTION_ROOT}/mcp`;
const RESOURCE_METADATA = `${FUNCTION_ROOT}/.well-known/oauth-protected-resource`;
const AUTHORIZATION_SERVER = `${SUPABASE_URL}/auth/v1`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMINDER_AT_PATTERN = /^(?:(?:20\d{2}-\d{2}-\d{2})T)?(?:[01]\d|2[0-3]):[0-5]\d$/;
const ReminderSpecInput = z.object({
  type: z.enum(["preparation", "departure", "event"]),
  at: z.string().regex(REMINDER_AT_PATTERN).optional(),
  offset_minutes: z.number().int().min(0).max(40_320).optional(),
}).refine((value) => value.at !== undefined || value.offset_minutes !== undefined, {
  message: "Each reminder requires at or offset_minutes",
});
const REMINDER_ZOD_FIELDS = {
  reminder_policy: z.enum(["none", "smart", "custom"]).optional(),
  reminder_policy_source: z.enum(["user_explicit", "ai_inferred", "system_default"]).optional(),
  reminder_reason: z.string().max(2_000).optional(),
  reminder_at: z.string().regex(REMINDER_AT_PATTERN).nullable().optional(),
  reminder_offset_minutes: z.number().int().min(0).max(40_320).nullable().optional(),
  reminder_type: z.enum(["preparation", "departure", "event"]).optional(),
  reminders: z.array(ReminderSpecInput).max(3).optional(),
  need_preparation: z.boolean().optional(),
  need_travel: z.boolean().optional(),
  preparation_minutes: z.number().int().min(0).max(1_440).optional(),
  travel_minutes: z.number().int().min(0).max(1_440).optional(),
  safety_buffer_minutes: z.number().int().min(0).max(1_440).optional(),
  transportation: z.string().min(1).max(40).optional(),
  pre_event_actions: z.array(z.string().min(1).max(100)).max(20).optional(),
  notification_channel: z.enum(["google_calendar_popup", "google_calendar_email"]).optional(),
};

const RecurrenceInput = z.object({
  kind: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(365).default(1),
  weekday: z.number().int().min(0).max(6).optional(),
  month_day: z.number().int().min(1).max(31).optional(),
  month: z.number().int().min(1).max(12).optional(),
  rrule: z.string().max(200).optional(),
});

const TaskInput = z.object({
  recurrence: RecurrenceInput.optional(),
  context: z.record(z.string(), z.unknown()).optional().describe("Known conversation context: conversation_trips and current_task.id. Server re-reads the task before updates."),
  existing_task_id: z.string().min(1).max(1024).optional(),
  raw_text: z.string().min(1).max(10_000).describe("The user's original wording, preserved for audit."),
  title: z.string().min(1).max(200).describe("A concise actionable task title."),
  notes: z.string().max(10_000).optional().describe("Helpful task details without secrets."),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("Due date in YYYY-MM-DD, or null when no date was requested."),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("Hard deadline date, or null when none was stated."),
  deadline_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional().describe("Exact hard-deadline time, distinct from requested execution time."),
  requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("The execution date explicitly requested by the user."),
  requested_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional().describe("The execution time explicitly requested by the user. Never invent this when only a date was stated."),
  estimated_duration: z.number().int().min(5).max(720).optional().describe("Estimated duration in minutes. Omit when unknown so Personal OS can apply its semantic default."),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  fixed_time: z.boolean().default(false).describe("True when the user explicitly gave the execution time; the automatic scheduler must not move it."),
  goal_id: z.string().regex(UUID_PATTERN).nullable().optional().describe("Existing Goal id when this Task is an explicit next action for that Goal."),
  project_id: z.string().regex(UUID_PATTERN).nullable().optional().describe("Existing Project id when known."),
  resources: z.array(z.string().min(1).max(200)).max(100).default([]).describe("Shared data or system resources used by this Task."),
  read_resources: z.array(z.string().min(1).max(200)).max(100).default([]),
  write_resources: z.array(z.string().min(1).max(200)).max(100).default([]),
  resource_fields: z.array(z.string().min(1).max(200)).max(100).default([]),
  depends_on_task_ids: z.array(z.string().min(1).max(1024)).max(100).default([]).describe("Known prerequisite Google Task ids."),
  ...REMINDER_ZOD_FIELDS,
  timezone: z.string().default("Asia/Shanghai").describe("IANA timezone used to interpret the request."),
  idempotency_key: z.string().min(8).max(200).describe("A unique key for this user intent. Reuse exactly the same key only when retrying the same request."),
});

const TaskOutput = z.object({
  success: z.boolean(),
  write_success: z.boolean().optional(),
  verified: z.boolean().optional(),
  request_id: z.string().optional(),
  outcome: z.string().optional(),
  retry_requires_user_intent: z.boolean().optional(),
  partial: z.boolean().optional(),
  receipt: z.record(z.string(), z.unknown()).nullable().optional(),
  message: z.string().optional(),
  decision: z.string().optional(),
  question: z.string().optional(),
  intent: z.string().optional(),
  destination: z.string().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  due: z.string().nullable().optional(),
  deduplicated: z.boolean().optional(),
  idempotency_key: z.string().optional(),
  replayed: z.boolean().optional(),
  schedule: z.record(z.string(), z.unknown()).nullable().optional(),
  goal_plan_id: z.string().nullable().optional(),
  goal_linked: z.boolean().optional(),
  goal_link_error: z.string().optional(),
  project_id: z.string().nullable().optional(),
  context_linked: z.boolean().optional(),
  operation: z.string().optional(),
  resolution: z.record(z.string(), z.unknown()).nullable().optional(),
  relationships: z.array(z.record(z.string(), z.unknown())).optional(),
  code: z.string().optional(),
  error: z.string().optional(),
});

const TaskConversationInput = z.object({ task_id: z.string().min(1).max(1024), text: z.string().min(1).max(10000), source: z.enum(["text", "voice"]).default("text"), request_id: z.string().min(8).max(200), proposal_id: z.string().max(200).optional() });
const LifecycleIdInput = z.object({ task_id: z.string().min(1).max(1024) });
const LifecycleMutationInput = LifecycleIdInput.extend({
  title: z.string().min(1).max(200).optional(), notes: z.string().max(10_000).nullable().optional(),
  due: z.string().nullable().optional(), deadline: z.string().nullable().optional(), requested_date: z.string().nullable().optional(), requested_time: z.string().nullable().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(), estimated_duration: z.number().int().min(5).max(720).optional(), fixed_time: z.boolean().optional(), timezone: z.string().max(80).optional(),
  task_type: z.enum(["task", "follow_up"]).optional(), parent_task_id: z.string().nullable().optional(), follow_up_of: z.string().nullable().optional(), follow_up_sequence: z.number().int().min(2).max(99).optional(),
  clear_fields: z.array(z.enum(["notes", "due", "deadline", "requested_date", "requested_time", "parent_task_id", "follow_up_of"])).optional(), raw_text: z.string().max(10_000).optional(), request_id: z.string().max(200).optional(), idempotency_key: z.string().min(8).max(200),
});
const LifecycleStateInput = LifecycleIdInput.extend({ raw_text: z.string().max(10_000).optional(), request_id: z.string().max(200).optional(), idempotency_key: z.string().min(8).max(200), reason: z.string().max(1_000).optional() });
const ListRecurrenceSeriesInput = z.object({});
const CancelRecurrenceSeriesInput = z.object({ series_id: z.string().regex(UUID_PATTERN) });
const PauseRecurrenceSeriesInput = CancelRecurrenceSeriesInput;
const ResumeRecurrenceSeriesInput = CancelRecurrenceSeriesInput;
const SkipRecurrenceSeriesInput = CancelRecurrenceSeriesInput.extend({ recurrence_instance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const UpdateRecurrenceSeriesInput = CancelRecurrenceSeriesInput.extend({
  recurrence: RecurrenceInput,
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().min(1).max(80).optional(),
  local_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
});
const ListReminderRequestsInput = z.object({
  idempotency_key: z.string().min(8).max(200).optional(),
  stage: z.enum(["received", "needs_input", "unsupported", "missed", "write_pending", "outcome_unknown", "task_verified", "projection_pending", "reminder_verified", "request_verified", "auth_required", "cancelled", "superseded"]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
});
const RecoverReminderRequestInput = z.object({ request_id: z.string().regex(UUID_PATTERN) });
const AmendReminderRequestInput = RecoverReminderRequestInput.extend({
  recovery_version: z.number().int().min(0),
  requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requested_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
});
const SearchTasksInput = z.object({ query: z.string().max(500).optional(), task_id: z.string().max(1024).optional(), status: z.enum(["open", "completed", "all"]).default("open"), priority: z.enum(["low", "medium", "high", "urgent"]).optional(), task_type: z.enum(["task", "follow_up"]).optional(), date_from: z.string().optional(), date_to: z.string().optional(), deadline_from: z.string().optional(), deadline_to: z.string().optional(), created_from: z.string().max(40).optional(), created_to: z.string().max(40).optional(), updated_from: z.string().max(40).optional(), updated_to: z.string().max(40).optional(), limit: z.number().int().min(1).max(100).default(20) });
const CalendarSearchInput = z.object({
  calendar_id: z.string().min(1).max(200).default("primary"),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  query: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
const CalendarEventInput = z.object({
  calendar_id: z.string().min(1).max(200).default("primary"),
  event_id: z.string().min(1).max(1024),
});
const CalendarEventUpdateInput = CalendarEventInput.extend({
  expected_updated: z.string().min(1).max(80).describe("The exact updated timestamp returned by search_calendar_events or get_calendar_event."),
  summary: z.string().min(1).max(1000).optional(),
  description: z.string().max(8_000).nullable().optional(),
  location: z.string().max(1_000).nullable().optional(),
  start: z.string().max(80).optional().describe("RFC3339 date-time with timezone offset; must be paired with end."),
  end: z.string().max(80).optional().describe("RFC3339 date-time with timezone offset; must be paired with start."),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("All-day start date; must be paired with exclusive end_date."),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("All-day exclusive end date; must be paired with start_date."),
  timezone: z.string().min(1).max(80).optional(),
}).refine((value) => ["summary", "description", "location", "start", "end", "start_date", "end_date"].some((key) => Object.hasOwn(value, key)), {
  message: "At least one Calendar event field must be changed",
});

const UnifiedIntakeInput = z.object({
  recurrence: RecurrenceInput.optional().describe("Recurring Task rule. For 每天/每周/每月/每年 requests, pass this instead of claiming recurrence is unsupported."),
  context: z.record(z.string(), z.unknown()).optional(),
  existing_task_id: z.string().min(1).max(1024).optional(),
  raw_text: z.string().min(1).max(10_000).describe("The user's exact original wording. Personal OS preserves it."),
  type: z.enum(["task", "goal", "plan", "long_term_item", "financial_item"]).optional()
    .describe("Leave unset to let Personal OS classify. Set only when the user's intent is explicit."),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  why: z.string().max(10_000).optional().describe("The user's stated motivation. Never invent it."),
  goal_type: z.enum(["Goal", "Plan", "LongTermItem", "FinancialItem", "Idea", "LifePlan", "BusinessPlan", "FamilyPlan"]).optional(),
  category: z.enum(["Career", "Business", "Finance", "Family", "Health", "Travel", "Learning", "Property", "Personal", "Relationship", "Other"]).optional(),
  status: z.enum(["Inbox", "Thinking", "Planning", "Active", "Paused", "Completed", "Dropped", "Archived"]).optional(),
  horizon: z.enum(["short", "medium", "long"]).optional(),
  existing_goal_id: z.string().regex(UUID_PATTERN).nullable().optional()
    .describe("Use the id returned by get_goals when this message develops an existing Goal."),
  goal_plan_id: z.string().regex(UUID_PATTERN).nullable().optional()
    .describe("For a Task classification, link the resulting Google Task to this existing Goal."),
  project_id: z.string().regex(UUID_PATTERN).nullable().optional(),
  resources: z.array(z.string().min(1).max(200)).max(100).default([]),
  read_resources: z.array(z.string().min(1).max(200)).max(100).default([]),
  write_resources: z.array(z.string().min(1).max(200)).max(100).default([]),
  resource_fields: z.array(z.string().min(1).max(200)).max(100).default([]),
  depends_on_task_ids: z.array(z.string().min(1).max(1024)).max(100).default([]),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  target_month: z.string().regex(/^20\d{2}-(?:0[1-9]|1[0-2])$/).nullable().optional(),
  target_year: z.number().int().min(2000).max(2200).nullable().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  review_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  deadline_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  progress_percent: z.number().int().min(0).max(100).default(0),
  amount_total: z.number().nonnegative().nullable().optional(),
  amount_completed: z.number().nonnegative().default(0),
  currency: z.string().regex(/^[A-Z]{3}$/).default("CNY"),
  counterparty: z.string().max(200).nullable().optional(),
  financial_type: z.enum(["Receivable", "Payable", "Budget", "SavingGoal", "InvestmentGoal"]).nullable().optional(),
  notes: z.string().max(10_000).optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  requested_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  estimated_duration: z.number().int().min(5).max(720).optional(),
  fixed_time: z.boolean().default(false),
  ...REMINDER_ZOD_FIELDS,
  timezone: z.string().default("Asia/Shanghai"),
  idempotency_key: z.string().min(8).max(200),
});

const GoalQueryInput = z.object({
  horizon: z.enum(["short", "medium", "long"]).optional(),
  status: z.enum(["Inbox", "Thinking", "Planning", "Active", "Paused", "Completed", "Dropped", "Archived"]).optional(),
  query: z.string().max(200).optional(),
  include_closed: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
});

const GoalUpdateInput = z.object({
  goal_id: z.string().regex(UUID_PATTERN),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(20_000).optional(),
  replace_summary: z.boolean().default(false),
  horizon: z.enum(["short", "medium", "long"]).optional(),
  status: z.enum(["Inbox", "Thinking", "Planning", "Active", "Paused", "Completed", "Dropped", "Archived"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  progress_percent: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(20_000).optional(),
});

const GoalCompleteInput = z.object({ goal_id: z.string().regex(UUID_PATTERN) });

const UpdateTaskReminderInput = z.object({
  task_id: z.string().min(1).max(1024),
  raw_text: z.string().max(10_000).optional(),
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  scheduled_start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  scheduled_end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  duration_minutes: z.number().int().min(5).max(720).optional(),
  fixed_time: z.boolean().optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  deadline_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  timezone: z.string().optional(),
  ...REMINDER_ZOD_FIELDS,
}).refine((value) => Object.keys(value).some((key) => key !== "task_id"), {
  message: "At least one schedule or reminder field is required",
});

const TaskResolutionPreviewInput = TaskInput.omit({ idempotency_key: true }).extend({
  idempotency_key: z.string().min(8).max(200).optional(),
});
const TaskGraphInput = z.object({});
const ResolutionExplainInput = z.object({
  audit_id: z.string().regex(UUID_PATTERN).optional(),
  task_id: z.string().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const AUTH_SCHEMES = [{ type: "oauth2", scopes: ["openid", "email", "profile"] }];
const REMINDER_TOOL_PROPERTIES = {
  reminder_policy: { type: "string", enum: ["none", "smart", "custom"], description: "Use custom for an exact user instruction, smart for inferred timing, and none only when the user explicitly opts out or no reminder is needed." },
  reminder_policy_source: { type: "string", enum: ["user_explicit", "ai_inferred", "system_default"], description: "User-explicit timing always has highest priority." },
  reminder_reason: { type: "string", maxLength: 2_000, description: "Short explanation of the preparation, travel, or deadline factors used." },
  reminder_at: { anyOf: [{ type: "string", pattern: "^(?:(?:20\\d{2}-\\d{2}-\\d{2})T)?(?:[01]\\d|2[0-3]):[0-5]\\d$" }, { type: "null" }], description: "Exact user-requested local reminder time as HH:MM or YYYY-MM-DDTHH:MM." },
  reminder_offset_minutes: { anyOf: [{ type: "integer", minimum: 0, maximum: 40_320 }, { type: "null" }], description: "Minutes before the Event anchor. Do not use a fixed universal offset." },
  reminder_type: { type: "string", enum: ["preparation", "departure", "event"] },
  reminders: {
    type: "array",
    maxItems: 3,
    description: "Minimum necessary reminder overrides. Never turn these into Tasks or Events.",
    items: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["preparation", "departure", "event"] },
        at: { type: "string", pattern: "^(?:(?:20\\d{2}-\\d{2}-\\d{2})T)?(?:[01]\\d|2[0-3]):[0-5]\\d$" },
        offset_minutes: { type: "integer", minimum: 0, maximum: 40_320 },
      },
      anyOf: [{ required: ["at"] }, { required: ["offset_minutes"] }],
      required: ["type"],
      additionalProperties: false,
    },
  },
  need_preparation: { type: "boolean" },
  need_travel: { type: "boolean" },
  preparation_minutes: { type: "integer", minimum: 0, maximum: 1_440 },
  travel_minutes: { type: "integer", minimum: 0, maximum: 1_440 },
  safety_buffer_minutes: { type: "integer", minimum: 0, maximum: 1_440 },
  transportation: { type: "string", minLength: 1, maxLength: 40, description: "Known mode such as metro, drive, taxi, walk, train, or airport." },
  pre_event_actions: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 100 } },
  notification_channel: { type: "string", enum: ["google_calendar_popup", "google_calendar_email"], default: "google_calendar_popup" },
};

const RECURRENCE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
    interval: { type: "integer", minimum: 1, maximum: 365, default: 1 },
    weekday: { type: "integer", minimum: 0, maximum: 6 },
    month_day: { type: "integer", minimum: 1, maximum: 31 },
    month: { type: "integer", minimum: 1, maximum: 12 },
    rrule: { type: "string", maxLength: 200 },
  },
  required: ["kind"],
  additionalProperties: false,
};

const CREATE_TASK_TOOL = {
  name: "create_task",
  title: "Create a Personal OS task",
  description: "Create or update a one-time or recurring Personal OS task in Google Tasks. For natural-language repetition such as 每天, 每周三, 每月5号, or 每年9月30号, use recurrence (daily/weekly/monthly/yearly) and create the first current instance; never say recurring tasks are unsupported. One action is one Google Task, while the recurrence rule owns future instances. Infer a reasonable Date from the request or context; never invent Deadline. Search and update an existing matching task before creating. Report persistence only with write_success=true and verified=true; use the returned message. Calendar remains the same task's projection.",
  inputSchema: {
    type: "object",
    properties: {
      recurrence: RECURRENCE_TOOL_SCHEMA,
      context: { type: "object", additionalProperties: true, description: "Known context: conversation_trips [{title,start_date,end_date}], current_task {id}. Server refreshes provider state." },
      existing_task_id: { type: "string", minLength: 1, maxLength: 1024 },
      raw_text: { type: "string", minLength: 1, maxLength: 10_000, description: "The user's original wording, preserved for audit." },
      title: { type: "string", minLength: 1, maxLength: 200, description: "A concise actionable task title." },
      notes: { type: "string", maxLength: 10_000, description: "Helpful task details without secrets." },
      due: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }], description: "Due date in YYYY-MM-DD, or null when no date was requested." },
      deadline: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }], description: "Hard deadline date, or null." },
      deadline_time: { anyOf: [{ type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }, { type: "null" }], description: "Exact deadline time. Keep this separate from requested_time." },
      requested_date: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }], description: "Explicit execution date." },
      requested_time: { anyOf: [{ type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }, { type: "null" }], description: "Explicit execution time; never invent it for a date-only request." },
      estimated_duration: { type: "integer", minimum: 5, maximum: 720, description: "Estimated duration in minutes. Omit when unknown; Personal OS applies a semantic default such as 60 minutes for a meeting." },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"], default: "medium" },
      fixed_time: { type: "boolean", default: false, description: "True only when the user explicitly gave the execution time." },
      goal_id: { anyOf: [{ type: "string", pattern: "^[0-9a-fA-F-]{36}$" }, { type: "null" }], description: "Existing Goal id when this Task is its concrete next action." },
      project_id: { anyOf: [{ type: "string", pattern: "^[0-9a-fA-F-]{36}$" }, { type: "null" }], description: "Existing Project id when known." },
      resources: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 100, default: [], description: "Shared data or system resources used by this Task." },
      read_resources: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 100, default: [] },
      write_resources: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 100, default: [] },
      resource_fields: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 100, default: [] },
      depends_on_task_ids: { type: "array", items: { type: "string", maxLength: 1024 }, maxItems: 100, default: [], description: "Known prerequisite Google Task ids." },
      ...REMINDER_TOOL_PROPERTIES,
      timezone: { type: "string", default: "Asia/Shanghai", description: "IANA timezone used to interpret the request." },
      idempotency_key: { type: "string", minLength: 8, maxLength: 200, description: "A unique key for this user intent. Reuse exactly the same key only when retrying the same request." },
    },
    required: ["raw_text", "title", "timezone", "idempotency_key"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      write_success: { type: "boolean" },
      verified: { type: "boolean" },
      message: { type: "string" },
      stage: { type: "string" },
      destination: { type: "string" },
      id: { type: "string" },
      title: { type: "string" },
      due: { anyOf: [{ type: "string" }, { type: "null" }] },
      deduplicated: { type: "boolean" },
      request_id: { type: "string" },
      outcome: { type: "string" },
      retry_requires_user_intent: { type: "boolean" },
      partial: { type: "boolean" },
      receipt: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      idempotency_key: { type: "string" },
      replayed: { type: "boolean" },
      schedule: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      goal_plan_id: { anyOf: [{ type: "string" }, { type: "null" }] },
      goal_linked: { type: "boolean" },
      goal_link_error: { type: "string" },
      project_id: { anyOf: [{ type: "string" }, { type: "null" }] },
      context_linked: { type: "boolean" },
      operation: { type: "string" },
      resolution: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      relationships: { type: "array", items: { type: "object", additionalProperties: true } },
      code: { type: "string" },
      error: { type: "string" },
    },
    required: ["success"],
    additionalProperties: false,
  },
  securitySchemes: AUTH_SCHEMES,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: {
    securitySchemes: AUTH_SCHEMES,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": "正在写入 Google Tasks",
    "openai/toolInvocation/invoked": "任务写入已处理",
  },
};

const UPDATE_TASK_REMINDER_TOOL = {
  name: "update_task_reminder",
  title: "Update a Task's Smart Reminder",
  description: "Update reminder policy on an existing Google Task and its existing Schedule/Calendar projection. This tool never creates a Google Task or a second Calendar Event. Use the task_id from Personal OS, preserve exact user timing, and use smart inference only when the user did not specify an exact reminder. A scheduled time or exact deadline time must already exist, unless supplied here for a Task that has no Schedule yet.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", minLength: 1, maxLength: 1024, description: "Existing canonical Google Task id." },
      raw_text: { type: "string", maxLength: 10_000, description: "Current user wording or additional pre-event context." },
      scheduled_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      scheduled_start: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
      scheduled_end: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
      duration_minutes: { type: "integer", minimum: 5, maximum: 720 },
      fixed_time: { type: "boolean" },
      deadline: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      deadline_time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
      timezone: { type: "string" },
      ...REMINDER_TOOL_PROPERTIES,
    },
    required: ["task_id"],
    anyOf: [
      { required: ["raw_text"] },
      { required: ["scheduled_date"] },
      { required: ["scheduled_start"] },
      { required: ["scheduled_end"] },
      { required: ["duration_minutes"] },
      { required: ["fixed_time"] },
      { required: ["deadline"] },
      { required: ["deadline_time"] },
      { required: ["timezone"] },
      { required: ["reminder_policy"] },
      { required: ["reminder_policy_source"] },
      { required: ["reminder_reason"] },
      { required: ["reminder_at"] },
      { required: ["reminder_offset_minutes"] },
      { required: ["reminder_type"] },
      { required: ["reminders"] },
      { required: ["need_preparation"] },
      { required: ["need_travel"] },
      { required: ["preparation_minutes"] },
      { required: ["travel_minutes"] },
      { required: ["safety_buffer_minutes"] },
      { required: ["transportation"] },
      { required: ["pre_event_actions"] },
      { required: ["notification_channel"] },
    ],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      task_id: { type: "string" },
      schedule_id: { type: "string" },
      calendar_event_id: { type: "string" },
      task_id_unchanged: { type: "boolean" },
      schedule_id_unchanged: { type: "boolean" },
      calendar_event_id_unchanged: { type: "boolean" },
      google_tasks_count_delta: { type: "integer" },
      schedule: { type: "object", additionalProperties: true },
      projection: { type: "object", additionalProperties: true },
      code: { type: "string" },
      error: { type: "string" },
    },
    required: ["success"],
    additionalProperties: false,
  },
  securitySchemes: AUTH_SCHEMES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: {
    securitySchemes: AUTH_SCHEMES,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": "正在更新智能提醒",
    "openai/toolInvocation/invoked": "智能提醒已处理",
  },
};

const RESOLVE_TASK_INTENT_TOOL = {
  name: "resolve_task_intent",
  title: "Preview Task relationship resolution",
  description: "Read provider truth and preview how Personal OS would classify a new Task intent before writing: NEW, DUPLICATE, UPDATE, MERGE, RELATED, DEPENDENCY, PARENT_CHILD, GOAL_LINK, or CONFLICT. This tool never persists a Task.",
  inputSchema: {
    ...CREATE_TASK_TOOL.inputSchema,
    required: ["raw_text", "title"],
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      resolution: { type: "object", additionalProperties: true },
      code: { type: "string" },
      error: { type: "string" },
    },
    required: ["success"],
    additionalProperties: false,
  },
  securitySchemes: AUTH_SCHEMES,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: {
    securitySchemes: AUTH_SCHEMES,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": "正在解析任务关系",
    "openai/toolInvocation/invoked": "任务关系解析完成",
  },
};

const GET_TASK_GRAPH_TOOL = {
  name: "get_task_graph",
  title: "Read the Personal OS Task graph",
  description: "Read the current Google Tasks execution graph with dependencies, parents and children, related/conflicting Tasks, READY/BLOCKED/WAITING states, topological layers, and safe parallel groups.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", additionalProperties: true },
  securitySchemes: AUTH_SCHEMES,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: {
    securitySchemes: AUTH_SCHEMES,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": "正在读取 Task Graph",
    "openai/toolInvocation/invoked": "Task Graph 读取完成",
  },
};

const EXPLAIN_TASK_RESOLUTION_TOOL = {
  name: "explain_task_resolution",
  title: "Explain a Task resolution",
  description: "Read the durable audit trail for a resolution decision, including original intent, candidates, confidence, reason, before/after state, and affected Task ids.",
  inputSchema: {
    type: "object",
    properties: {
      audit_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$", description: "Exact resolution audit id when known." },
      task_id: { type: "string", minLength: 1, maxLength: 1024, description: "Canonical Google Task id when the audit id is unknown." },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
    additionalProperties: false,
  },
  outputSchema: { type: "object", additionalProperties: true },
  securitySchemes: AUTH_SCHEMES,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: {
    securitySchemes: AUTH_SCHEMES,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": "正在读取解析审计",
    "openai/toolInvocation/invoked": "解析审计读取完成",
  },
};

const CAPTURE_ITEM_TOOL = {
  name: "capture_personal_os_item",
  title: "Capture a Personal OS item",
  description: "Infer → Execute → Verify → Report. Clear reversible life/work actions, including recurring tasks, go directly to Google Tasks without optional-field questions or reconfirmation. For 每天/每周三/每月5号/每年 requests, pass recurrence and create the first current Task instance; never claim Personal OS only supports one-time tasks. The recurrence rule owns future instances and Google Tasks owns current content/completion state. Information questions create nothing; lasting preferences go to Goals & Plans. Preserve raw_text and known conversation context. Use returned message; never claim persistence without write_success=true and verified=true.",
  inputSchema: {
    type: "object",
    properties: {
      recurrence: RECURRENCE_TOOL_SCHEMA,
      context: { type: "object", additionalProperties: true, description: "Known conversation_trips [{title,start_date,end_date}], current_task {id}; readback refreshes the current Task." },
      existing_task_id: { type: "string", minLength: 1, maxLength: 1024 },
      raw_text: { type: "string", minLength: 1, maxLength: 10_000, description: "The user's exact original wording." },
      type: { type: "string", enum: ["task", "goal", "plan", "long_term_item", "financial_item"], description: "Optional explicit classification; omit for automatic classification." },
      title: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 20_000 },
      why: { type: "string", maxLength: 10_000, description: "Only the user's stated motivation." },
      goal_type: { type: "string", enum: ["Goal", "Plan", "LongTermItem", "FinancialItem", "Idea", "LifePlan", "BusinessPlan", "FamilyPlan"] },
      category: { type: "string", enum: ["Career", "Business", "Finance", "Family", "Health", "Travel", "Learning", "Property", "Personal", "Relationship", "Other"] },
      status: { type: "string", enum: ["Inbox", "Thinking", "Planning", "Active", "Paused", "Completed", "Dropped", "Archived"] },
      horizon: { type: "string", enum: ["short", "medium", "long"], description: "Semantic horizon. Explicit user wording takes priority over date arithmetic." },
      existing_goal_id: { anyOf: [{ type: "string", pattern: "^[0-9a-fA-F-]{36}$" }, { type: "null" }], description: "Existing Goal id returned by get_goals when this message develops that Goal." },
      goal_plan_id: { anyOf: [{ type: "string", pattern: "^[0-9a-fA-F-]{36}$" }, { type: "null" }], description: "For Task classification, link the new Task to this Goal." },
      project_id: { anyOf: [{ type: "string", pattern: "^[0-9a-fA-F-]{36}$" }, { type: "null" }] },
      resources: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 100, default: [] },
      read_resources: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 100, default: [] },
      write_resources: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 100, default: [] },
      resource_fields: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 100, default: [] },
      depends_on_task_ids: { type: "array", items: { type: "string", maxLength: 1024 }, maxItems: 100, default: [] },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"], default: "medium" },
      target_date: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
      target_month: { anyOf: [{ type: "string", pattern: "^20\\d{2}-(?:0[1-9]|1[0-2])$" }, { type: "null" }] },
      target_year: { anyOf: [{ type: "integer", minimum: 2000, maximum: 2200 }, { type: "null" }] },
      start_date: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
      review_date: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
      deadline: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
      deadline_time: { anyOf: [{ type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }, { type: "null" }] },
      progress_percent: { type: "integer", minimum: 0, maximum: 100, default: 0 },
      amount_total: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] },
      amount_completed: { type: "number", minimum: 0, default: 0 },
      currency: { type: "string", pattern: "^[A-Z]{3}$", default: "CNY" },
      counterparty: { anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] },
      financial_type: { anyOf: [{ type: "string", enum: ["Receivable", "Payable", "Budget", "SavingGoal", "InvestmentGoal"] }, { type: "null" }] },
      notes: { type: "string", maxLength: 10_000 },
      due: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
      requested_date: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
      requested_time: { anyOf: [{ type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }, { type: "null" }] },
      estimated_duration: { type: "integer", minimum: 5, maximum: 720 },
      fixed_time: { type: "boolean", default: false },
      ...REMINDER_TOOL_PROPERTIES,
      timezone: { type: "string", default: "Asia/Shanghai" },
      idempotency_key: { type: "string", minLength: 8, maxLength: 200, description: "Reuse only when retrying this exact intent." },
    },
    required: ["raw_text", "timezone", "idempotency_key"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      write_success: { type: "boolean" },
      verified: { type: "boolean" },
      message: { type: "string" },
      stage: { type: "string" },
      destination: { type: "string" },
      classification: { type: "string" },
      id: { type: "string" },
      title: { type: "string" },
      due: { anyOf: [{ type: "string" }, { type: "null" }] },
      deduplicated: { type: "boolean" },
      schedule: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      goal_type: { type: "string" },
      status: { type: "string" },
      horizon: { type: "string" },
      operation: { type: "string", enum: ["created", "updated"] },
      matched_existing: { type: "boolean" },
      match_score: { anyOf: [{ type: "number" }, { type: "null" }] },
      goal_plan_id: { anyOf: [{ type: "string" }, { type: "null" }] },
      goal_linked: { type: "boolean" },
      goal_link_error: { type: "string" },
      resolution: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      relationships: { type: "array", items: { type: "object", additionalProperties: true } },
      target_date: { anyOf: [{ type: "string" }, { type: "null" }] },
      target_month: { anyOf: [{ type: "string" }, { type: "null" }] },
      target_year: { anyOf: [{ type: "integer" }, { type: "null" }] },
      amount_remaining: { anyOf: [{ type: "number" }, { type: "null" }] },
      request_id: { type: "string" },
      outcome: { type: "string" },
      retry_requires_user_intent: { type: "boolean" },
      partial: { type: "boolean" },
      receipt: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      idempotency_key: { type: "string" },
      replayed: { type: "boolean" },
      code: { type: "string" },
      error: { type: "string" },
    },
    required: ["success"],
    additionalProperties: false,
  },
  securitySchemes: AUTH_SCHEMES,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: {
    securitySchemes: AUTH_SCHEMES,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": "正在理解并归类",
    "openai/toolInvocation/invoked": "Personal OS 已处理",
  },
};

const GET_GOALS_TOOL = {
  name: "get_goals",
  title: "Read Personal OS goals",
  description: "Read Goals & Plans from the real Personal OS database. Use this instead of ChatGPT memory whenever the user asks what their goals are, or before updating/completing a Goal whose id is not already known.",
  inputSchema: {
    type: "object",
    properties: {
      horizon: { type: "string", enum: ["short", "medium", "long"] },
      status: { type: "string", enum: ["Inbox", "Thinking", "Planning", "Active", "Paused", "Completed", "Dropped", "Archived"] },
      query: { type: "string", maxLength: 200 },
      include_closed: { type: "boolean", default: false },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      count: { type: "integer" },
      goals: { type: "array", items: { type: "object", additionalProperties: true } },
      code: { type: "string" },
      error: { type: "string" },
    },
    required: ["success"],
    additionalProperties: false,
  },
  securitySchemes: AUTH_SCHEMES,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: {
    securitySchemes: AUTH_SCHEMES,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": "正在读取 Personal OS Goals",
    "openai/toolInvocation/invoked": "Goals 读取完成",
  },
};

const UPDATE_GOAL_TOOL = {
  name: "update_goal",
  title: "Update an existing Personal OS goal",
  description: "Update one existing Goal returned by get_goals. This never creates a new Goal. By default a summary fragment is merged into the existing summary; set replace_summary only when supplying the full canonical replacement.",
  inputSchema: {
    type: "object",
    properties: {
      goal_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
      title: { type: "string", minLength: 1, maxLength: 200 },
      summary: { type: "string", maxLength: 20_000 },
      replace_summary: { type: "boolean", default: false },
      horizon: { type: "string", enum: ["short", "medium", "long"] },
      status: { type: "string", enum: ["Inbox", "Thinking", "Planning", "Active", "Paused", "Completed", "Dropped", "Archived"] },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      progress_percent: { type: "integer", minimum: 0, maximum: 100 },
      notes: { type: "string", maxLength: 20_000 },
    },
    required: ["goal_id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      operation: { type: "string", enum: ["updated"] },
      goal: { type: "object", additionalProperties: true },
      code: { type: "string" },
      error: { type: "string" },
    },
    required: ["success"],
    additionalProperties: false,
  },
  securitySchemes: AUTH_SCHEMES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: {
    securitySchemes: AUTH_SCHEMES,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": "正在更新 Goal",
    "openai/toolInvocation/invoked": "Goal 更新已处理",
  },
};

const COMPLETE_GOAL_TOOL = {
  name: "complete_goal",
  title: "Complete a Personal OS goal",
  description: "Mark one existing Goal returned by get_goals as Completed with 100% progress. This never creates another Goal.",
  inputSchema: {
    type: "object",
    properties: { goal_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } },
    required: ["goal_id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      operation: { type: "string", enum: ["completed"] },
      goal: { type: "object", additionalProperties: true },
      code: { type: "string" },
      error: { type: "string" },
    },
    required: ["success"],
    additionalProperties: false,
  },
  securitySchemes: AUTH_SCHEMES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: {
    securitySchemes: AUTH_SCHEMES,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": "正在完成 Goal",
    "openai/toolInvocation/invoked": "Goal 完成状态已处理",
  },
};

function reminderArguments(args: object) {
  const record = args as Record<string, unknown>;
  const keys = [
    "reminder_policy",
    "reminder_policy_source",
    "reminder_reason",
    "reminder_at",
    "reminder_offset_minutes",
    "reminder_type",
    "reminders",
    "need_preparation",
    "need_travel",
    "preparation_minutes",
    "travel_minutes",
    "safety_buffer_minutes",
    "transportation",
    "pre_event_actions",
    "notification_channel",
  ];
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
}

function uncertainIntakeResult(key: string, error: unknown, correlation: Record<string, unknown> = {}) {
  const result = { success: false, write_success: false, verified: false, outcome: "unknown", code: "INTAKE_OUTCOME_UNKNOWN", idempotency_key: key,
    ...(typeof correlation.request_id === "string" && correlation.request_id ? { request_id: correlation.request_id } : {}),
    error: error instanceof Error ? error.message : "Intake response unavailable", retry_requires_user_intent: true,
    message: "未收到可靠回执，写入结果未知；请用原 idempotency_key 只读核实，不要自动重试或新建。" };
  return { isError: true, content: [{ type: "text", text: result.message }], structuredContent: result };
}

function normalizeIntakeReceipt(result: Record<string, unknown>, key: string, taskReceipt: boolean) {
  const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  const refusal = result.success === false && (result.write_success === undefined || result.write_success === false)
    && (result.verified === undefined || result.verified === false) && ["USER_CANCELLED", "ACTION_DENIED", "POLICY_DENIED", "UNAUTHORIZED", "PERMISSION_DENIED", "INVALID_IDEMPOTENCY_KEY", "IDEMPOTENCY_CONFLICT", "CLARIFICATION_REQUIRED", "INFORMATION_ONLY", "TASK_TARGET_AMBIGUOUS"].includes(String(result.code || ""));
  if (refusal) return { ...result, outcome: "rejected", write_success: false, verified: false, idempotency_key: key, retry_requires_user_intent: true,
    message: result.message || "请求已拒绝或需要澄清，未自动重试。" };
  const receipt = result.receipt as Record<string, unknown> | undefined;
  const saved = nonempty(result.request_id) && nonempty(result.id) && result.write_success === true && result.verified === true
    && (!taskReceipt || receipt?.task_save_status === "verified");
  if (saved && result.success === true && (result.outcome === undefined || result.outcome === "verified") && result.partial !== true) return { ...result, idempotency_key: key };
  if (saved) return { ...result, success: false, outcome: "partial", idempotency_key: key, message: "任务已保存，提醒或后续步骤仍待核实。" };
  if (result.success === false && result.outcome === "unknown" && nonempty(result.request_id) && nonempty(result.code)
    && result.write_success === false && result.verified === false) return { ...result, idempotency_key: key, message: "写入结果未知；请按原 request_id 或 idempotency_key 只读核实。" };
  return null;
}

async function createTask(args: z.infer<typeof TaskInput>) {
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/personal-os-intake`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WRITE_TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": args.idempotency_key,
      },
      body: JSON.stringify({
        source: "chatgpt",
        recurrence: args.recurrence,
        context: args.context,
        existing_task_id: args.existing_task_id,
        raw_text: args.raw_text,
        type: "task",
        title: args.title,
        notes: args.notes || "",
        due: args.due || null,
        deadline: args.deadline || null,
        deadline_time: args.deadline_time || null,
        requested_date: args.requested_date || null,
        requested_time: args.requested_time || null,
        estimated_duration: args.estimated_duration,
        priority: args.priority,
        fixed_time: args.fixed_time,
        goal_plan_id: args.goal_id || null,
        project_id: args.project_id || null,
        resources: args.resources,
        read_resources: args.read_resources,
        write_resources: args.write_resources,
        resource_fields: args.resource_fields,
        depends_on_task_ids: args.depends_on_task_ids,
        ...reminderArguments(args),
        scheduling_source: args.requested_date || args.requested_time ? "explicit_user" : "gpt_inferred",
        timezone: args.timezone,
        idempotency_key: args.idempotency_key,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return uncertainIntakeResult(args.idempotency_key, error);
  }

  let result: z.infer<typeof TaskOutput>;
  try { result = JSON.parse(await response.text()); if (!result || typeof result.success !== "boolean") throw new Error("Invalid intake receipt"); }
  catch (error) { return uncertainIntakeResult(args.idempotency_key, error); }
  const receipt = normalizeIntakeReceipt(result as Record<string, unknown>, args.idempotency_key, true);
  if (!receipt) return uncertainIntakeResult(args.idempotency_key, new Error("Incomplete intake receipt"), result as Record<string, unknown>);
  result = receipt as z.infer<typeof TaskOutput>;
  const succeeded = response.ok && result.success === true && result.verified === true;
  return {
    isError: !succeeded,
    content: [{
      type: "text",
      text: result.message || intakeConfirmation(result),
    }],
    structuredContent: result,
  };
}

async function updateTaskReminder(args: z.infer<typeof UpdateTaskReminderInput>) {
  try {
    const { task_id: taskId, ...reminder } = args;
    const response = await fetch(`${SUPABASE_URL}/functions/v1/task-scheduler`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WRITE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_reminder", task_id: taskId, reminder }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let result: Record<string, unknown>;
    try { result = text ? JSON.parse(text) : { success: false }; }
    catch { result = { success: false, code: "INVALID_GATEWAY_RESPONSE", error: "Personal OS returned an invalid response" }; }
    const saved = result.schedule as Record<string, unknown> | undefined;
    const clearing = args.reminder_policy === "none";
    const cleared = !clearing || (saved?.reminder_policy === "none" && saved.reminder_at == null
      && saved.reminder_offset_minutes == null && Array.isArray(saved.reminders) && saved.reminders.length === 0);
    const succeeded = response.ok && result.success === true && result.verified === true && saved?.sync_required === false && cleared;
    if (!succeeded && response.ok) Object.assign(result, { success: false, code: "REMINDER_WRITE_UNVERIFIED", error: "提醒修改尚未通过真实回读核实" });
    return {
      isError: !succeeded,
      content: [{
        type: "text",
        text: succeeded
          ? clearing ? "提醒已关闭，保存结果已通过回读核实。" : "提醒更新已通过回读核实。"
          : `智能提醒未更新：${result.error || `Personal OS returned ${response.status}`}`,
      }],
      structuredContent: result,
    };
  } catch (error) {
    const result = { success: false, code: "REMINDER_UPDATE_UNREACHABLE", error: error instanceof Error ? error.message : "Reminder service unavailable" };
    return { isError: true, content: [{ type: "text", text: `智能提醒未更新：${result.error}` }], structuredContent: result };
  }
}

async function taskResolutionService(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/task-status${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${WRITE_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let result: Record<string, unknown>;
  try { result = text ? JSON.parse(text) : { success: response.ok }; }
  catch { result = { success: false, code: "INVALID_GATEWAY_RESPONSE", error: "Personal OS returned an invalid response" }; }
  return { response, result };
}

async function previewTaskIntent(args: z.infer<typeof TaskResolutionPreviewInput>) {
  try {
    const { response, result } = await taskResolutionService("", {
      method: "POST",
      body: JSON.stringify({ action: "preview_resolution", task: args }),
    });
    const succeeded = response.ok && result.success === true;
    const resolution = result.resolution as Record<string, unknown> | undefined;
    return {
      isError: !succeeded,
      content: [{
        type: "text",
        text: succeeded
          ? `解析结果：${resolution?.decision || "UNKNOWN"}（置信度 ${resolution?.confidence ?? "unknown"}）。未写入任何 Task。`
          : `任务关系解析失败：${result.error || `Personal OS returned ${response.status}`}`,
      }],
      structuredContent: result,
    };
  } catch (error) {
    return toolFailure("任务关系解析", error);
  }
}

async function getTaskGraph() {
  try {
    const { response, result } = await taskResolutionService("?resource=graph");
    const succeeded = response.ok && result.success === true;
    return {
      isError: !succeeded,
      content: [{
        type: "text",
        text: succeeded
          ? `Task Graph 已读取：${Array.isArray(result.ready_task_ids) ? result.ready_task_ids.length : 0} 个 READY，${Array.isArray(result.blocked_task_ids) ? result.blocked_task_ids.length : 0} 个 BLOCKED。`
          : `Task Graph 读取失败：${result.error || `Personal OS returned ${response.status}`}`,
      }],
      structuredContent: result,
    };
  } catch (error) {
    return toolFailure("Task Graph 读取", error);
  }
}

async function explainTaskResolution(args: z.infer<typeof ResolutionExplainInput>) {
  try {
    const query = new URLSearchParams({ resource: "resolution", limit: String(args.limit) });
    if (args.audit_id) query.set("audit_id", args.audit_id);
    if (args.task_id) query.set("task_id", args.task_id);
    const { response, result } = await taskResolutionService(`?${query}`);
    const succeeded = response.ok && result.success === true;
    return {
      isError: !succeeded,
      content: [{
        type: "text",
        text: succeeded
          ? `已读取 ${result.count || 0} 条 Task Resolution 审计记录。`
          : `解析审计读取失败：${result.error || `Personal OS returned ${response.status}`}`,
      }],
      structuredContent: result,
    };
  } catch (error) {
    return toolFailure("解析审计读取", error);
  }
}

async function captureItem(args: z.infer<typeof UnifiedIntakeInput>) {
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/personal-os-intake`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WRITE_TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": args.idempotency_key,
      },
      body: JSON.stringify({ source: "chatgpt", ...args }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return uncertainIntakeResult(args.idempotency_key, error);
  }

  let result: Record<string, unknown>;
  try { result = JSON.parse(await response.text()); if (!result || typeof result.success !== "boolean") throw new Error("Invalid intake receipt"); }
  catch (error) { return uncertainIntakeResult(args.idempotency_key, error); }
  const receipt = normalizeIntakeReceipt(result, args.idempotency_key, result.destination === "google_tasks" || args.type === "task");
  if (!receipt) return uncertainIntakeResult(args.idempotency_key, new Error("Incomplete intake receipt"), result);
  result = receipt;
  const succeeded = response.ok && result.success === true && result.verified === true;
  return {
    isError: !succeeded,
    content: [{
      type: "text",
      text: String(result.message || intakeConfirmation(result)),
    }],
    structuredContent: result,
  };
}

const GOAL_SELECT = "id,title,description,horizon,type,category,status,priority,progress_percent,target_date,target_month,target_year,start_date,review_date,deadline,notes,created_at,updated_at,archived_at";

function goalView(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    summary: row.description || "",
    horizon: row.horizon || "medium",
    type: row.type,
    category: row.category,
    status: row.status,
    priority: row.priority,
    progress_percent: row.progress_percent,
    target_date: row.target_date,
    target_month: row.target_month,
    target_year: row.target_year,
    start_date: row.start_date,
    review_date: row.review_date,
    deadline: row.deadline,
    notes: row.notes || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function userRest(request: Request, path: string, init: RequestInit = {}) {
  const authorization = request.headers.get("authorization") || "";
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_PUBLIC_KEY,
      Authorization: authorization,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    throw new Error(String(detail.message || detail.error || `Personal OS database returned ${response.status}`));
  }
  return payload;
}

function toolFailure(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Personal OS database unavailable";
  const result = { success: false, code: "GOAL_OPERATION_FAILED", error: message };
  return { isError: true, content: [{ type: "text", text: `${prefix}未完成：${message}` }], structuredContent: result };
}

async function getGoals(request: Request, args: z.infer<typeof GoalQueryInput>) {
  try {
    const query = new URLSearchParams({ select: GOAL_SELECT, order: "updated_at.desc", limit: "100" });
    const rows = await userRest(request, `goals_plans?${query}`) as Array<Record<string, unknown>>;
    const goals = filterGoalsForRead(Array.isArray(rows) ? rows : [], args).slice(0, args.limit).map(goalView);
    const result = { success: true, count: goals.length, goals };
    return {
      content: [{ type: "text", text: `已从 Personal OS 数据库读取 ${goals.length} 个 Goal & Plan。` }],
      structuredContent: result,
    };
  } catch (error) {
    return toolFailure("Goal 查询", error);
  }
}

async function updateGoal(request: Request, args: z.infer<typeof GoalUpdateInput>) {
  try {
    const lookup = new URLSearchParams({ id: `eq.${args.goal_id}`, select: GOAL_SELECT, limit: "1" });
    const currentRows = await userRest(request, `goals_plans?${lookup}`) as Array<Record<string, unknown>>;
    const current = currentRows?.[0];
    if (!current) throw new Error("Goal 不存在或无权修改");
    const changes: Record<string, unknown> = {};
    if (args.title !== undefined) changes.title = args.title;
    if (args.summary !== undefined) changes.description = args.replace_summary ? args.summary : mergeGoalText(current.description, args.summary);
    if (args.horizon !== undefined) changes.horizon = args.horizon;
    if (args.status !== undefined) {
      changes.status = args.status;
      changes.archived_at = args.status === "Archived" ? new Date().toISOString() : null;
    }
    if (args.priority !== undefined) changes.priority = args.priority;
    if (args.progress_percent !== undefined) changes.progress_percent = args.progress_percent;
    if (args.notes !== undefined) changes.notes = mergeGoalText(current.notes, args.notes, "对话补充");
    if (!Object.keys(changes).length) throw new Error("没有提供需要更新的字段");

    const patchQuery = new URLSearchParams({ id: `eq.${args.goal_id}`, select: GOAL_SELECT });
    const rows = await userRest(request, `goals_plans?${patchQuery}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(changes),
    }) as Array<Record<string, unknown>>;
    if (!rows?.[0]) throw new Error("Goal 更新后未返回记录");
    const goal = goalView(rows[0]);
    const result = { success: true, operation: "updated", goal };
    return { content: [{ type: "text", text: `已更新现有 Goal「${goal.title}」。` }], structuredContent: result };
  } catch (error) {
    return toolFailure("Goal 更新", error);
  }
}

async function completeGoal(request: Request, args: z.infer<typeof GoalCompleteInput>) {
  try {
    const query = new URLSearchParams({ id: `eq.${args.goal_id}`, select: GOAL_SELECT });
    const rows = await userRest(request, `goals_plans?${query}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(completeGoalPatch()),
    }) as Array<Record<string, unknown>>;
    if (!rows?.[0]) throw new Error("Goal 不存在或无权修改");
    const goal = goalView(rows[0]);
    const result = { success: true, operation: "completed", goal };
    return { content: [{ type: "text", text: `已将 Goal「${goal.title}」标记为已完成。` }], structuredContent: result };
  } catch (error) {
    return toolFailure("Goal 完成状态更新", error);
  }
}

function lifecycleTool(name: string, title: string, inputSchema: Record<string, unknown>, readOnly = false, destructive = false) {
  return { name, title, description: `${title} through the canonical Google Tasks lifecycle API.`, inputSchema, outputSchema: { type: "object", properties: { success: { type: "boolean" }, task: { type: "object", additionalProperties: true }, tasks: { type: "array", items: { type: "object", additionalProperties: true } }, code: { type: "string" }, error: { type: "string" } }, required: ["success"], additionalProperties: true }, securitySchemes: AUTH_SCHEMES, annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: true, openWorldHint: true }, _meta: { securitySchemes: AUTH_SCHEMES, "openai/visibility": "public" } };
}
const ID_FIELD = { type: "string", minLength: 1, maxLength: 1024 };
const IDEMPOTENCY_FIELD = { type: "string", minLength: 8, maxLength: 200 };
const DATE_FIELD = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const TIME_FIELD = { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" };
const SEARCH_TASKS_TOOL = lifecycleTool("search_tasks", "Search Personal OS tasks", { type: "object", properties: { query: { type: "string", maxLength: 500 }, task_id: ID_FIELD, status: { type: "string", enum: ["open", "completed", "all"], default: "open" }, priority: { type: "string", enum: ["low", "medium", "high", "urgent"] }, task_type: { type: "string", enum: ["task", "follow_up"] }, date_from: DATE_FIELD, date_to: DATE_FIELD, deadline_from: DATE_FIELD, deadline_to: DATE_FIELD, created_from: { type: "string", maxLength: 40 }, created_to: { type: "string", maxLength: 40 }, updated_from: { type: "string", maxLength: 40 }, updated_to: { type: "string", maxLength: 40 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false }, true);
const GET_TASK_TOOL = lifecycleTool("get_task", "Read a Personal OS task", { type: "object", properties: { task_id: ID_FIELD }, required: ["task_id"], additionalProperties: false }, true);
const UPDATE_TASK_TOOL = lifecycleTool("update_task", "Update a Personal OS task", { type: "object", properties: { task_id: ID_FIELD, title: { type: "string", minLength: 1, maxLength: 200 }, notes: { anyOf: [{ type: "string", maxLength: 10_000 }, { type: "null" }] }, due: { anyOf: [DATE_FIELD, { type: "null" }] }, deadline: { anyOf: [DATE_FIELD, { type: "null" }] }, requested_date: { anyOf: [DATE_FIELD, { type: "null" }] }, requested_time: { anyOf: [TIME_FIELD, { type: "null" }] }, priority: { type: "string", enum: ["low", "medium", "high", "urgent"] }, estimated_duration: { type: "integer", minimum: 5, maximum: 720 }, fixed_time: { type: "boolean" }, timezone: { type: "string", minLength: 1, maxLength: 80 }, task_type: { type: "string", enum: ["task", "follow_up"] }, parent_task_id: { anyOf: [ID_FIELD, { type: "null" }] }, follow_up_of: { anyOf: [ID_FIELD, { type: "null" }] }, follow_up_sequence: { type: "integer", minimum: 2, maximum: 99 }, clear_fields: { type: "array", items: { type: "string", enum: ["notes", "due", "deadline", "requested_date", "requested_time", "parent_task_id", "follow_up_of"] } }, raw_text: { type: "string", maxLength: 10_000 }, request_id: { type: "string", maxLength: 200 }, idempotency_key: IDEMPOTENCY_FIELD }, required: ["task_id", "idempotency_key"], additionalProperties: false });
const STATE_SCHEMA = { type: "object", properties: { task_id: ID_FIELD, raw_text: { type: "string", maxLength: 10_000 }, request_id: { type: "string", maxLength: 200 }, idempotency_key: IDEMPOTENCY_FIELD }, required: ["task_id", "idempotency_key"], additionalProperties: false };
const COMPLETE_TASK_TOOL = lifecycleTool("complete_task", "Complete a Personal OS task", STATE_SCHEMA);
const REOPEN_TASK_TOOL = lifecycleTool("reopen_task", "Reopen a Personal OS task", STATE_SCHEMA);
const DELETE_TASK_TOOL = lifecycleTool("delete_task", "Delete a Personal OS task", { ...STATE_SCHEMA, properties: { ...STATE_SCHEMA.properties, reason: { type: "string", maxLength: 1_000 } } }, false, true);

const TASK_CONVERSATION_TOOL = lifecycleTool("converse_task", "Continue a task conversation", { type: "object", properties: { task_id: ID_FIELD, text: { type: "string", minLength: 1, maxLength: 10000, description: "Exact user input; never synthesize a confirmation." }, source: { type: "string", enum: ["text", "voice"] }, request_id: { type: "string", minLength: 8, maxLength: 200 }, proposal_id: { type: "string", maxLength: 200, description: "Pending proposal id returned by get_task_conversation; required for confirming that exact preview." } }, required: ["task_id", "text", "request_id"], additionalProperties: false });
TASK_CONVERSATION_TOOL.description = "Use for task-bound natural-language updates. Server stores a preview first, then executes only after the user's actual confirmation of that proposal. Send corrections to replace the preview. Low-risk notes may append directly. Always display returned diff and message, including partial failures. Never use update_task to bypass this conversation confirmation workflow.";
const GET_TASK_CONVERSATION_TOOL = lifecycleTool("get_task_conversation", "Read task conversation and pending changes", { type: "object", properties: { task_id: ID_FIELD }, required: ["task_id"], additionalProperties: false }, true);

function reminderManagementTool(name: string, title: string, description: string, inputSchema: Record<string, unknown>, readOnly = false, destructive = false) {
  return {
    name, title, description, inputSchema,
    outputSchema: { type: "object", properties: { success: { type: "boolean" }, code: { type: "string" }, error: { type: "string" } }, required: ["success"], additionalProperties: true },
    securitySchemes: AUTH_SCHEMES,
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: true, openWorldHint: true },
    _meta: { securitySchemes: AUTH_SCHEMES, "openai/visibility": "public" },
  };
}

const LIST_RECURRENCE_SERIES_TOOL = reminderManagementTool(
  "list_recurrence_series", "List repeating reminder series",
  "Read all Schedule-backed daily, weekly, monthly, and yearly task series, including paused and stopped series. Google Tasks remains the source of task content and completion status.",
  { type: "object", properties: {}, additionalProperties: false }, true,
);
const UPDATE_RECURRENCE_SERIES_TOOL = reminderManagementTool(
  "update_recurrence_series", "Change future occurrences in a repeating task series",
  "Change only future occurrences. Historical Google Tasks and the current instance remain unchanged. Supply effective_date when changing the weekday or calendar date.",
  { type: "object", properties: { series_id: { type: "string", pattern: UUID_PATTERN.source }, recurrence: RECURRENCE_TOOL_SCHEMA,
    effective_date: DATE_FIELD, timezone: { type: "string", minLength: 1, maxLength: 80 },
    local_time: { anyOf: [TIME_FIELD, { type: "null" }] } }, required: ["series_id", "recurrence"], additionalProperties: false },
);
const PAUSE_RECURRENCE_SERIES_TOOL = reminderManagementTool(
  "pause_recurrence_series", "Pause future occurrences in a repeating task series",
  "Pause generation of future instances. The current Google Task and history remain unchanged.",
  { type: "object", properties: { series_id: { type: "string", pattern: UUID_PATTERN.source } }, required: ["series_id"], additionalProperties: false },
);
const RESUME_RECURRENCE_SERIES_TOOL = reminderManagementTool(
  "resume_recurrence_series", "Resume a paused repeating task series",
  "Resume future instance generation and catch up to the next valid future occurrence without duplicating history.",
  { type: "object", properties: { series_id: { type: "string", pattern: UUID_PATTERN.source } }, required: ["series_id"], additionalProperties: false },
);
const SKIP_RECURRENCE_SERIES_TOOL = reminderManagementTool(
  "skip_recurrence_occurrence", "Skip the next occurrence in a repeating task series",
  "Skip exactly the next recurrence instance and retain a skipped-history ledger entry. This never deletes the current Google Task.",
  { type: "object", properties: { series_id: { type: "string", pattern: UUID_PATTERN.source }, recurrence_instance_date: DATE_FIELD }, required: ["series_id"], additionalProperties: false },
);
const CANCEL_RECURRENCE_SERIES_TOOL = reminderManagementTool(
  "cancel_recurrence_series", "Stop an entire repeating reminder series",
  "Use only when the user explicitly asks to stop the entire repeating series. Stops future occurrences and disables the current Calendar reminder; it does not cancel or delete the Google Task. Do not use for a single occurrence.",
  { type: "object", properties: { series_id: { type: "string", pattern: UUID_PATTERN.source } }, required: ["series_id"], additionalProperties: false }, false, true,
);
const LIST_REMINDER_REQUESTS_TOOL = reminderManagementTool(
  "list_reminder_requests", "List reminder and synchronization requests",
  "Read the durable Personal OS request ledger, including pending, missed, unsupported, completed, and cancelled requests. Pass idempotency_key for exact read-only outcome verification; an empty result only means not registered at check time, not proof of no write. Results are paged; follow has_more and next_offset to see all matching requests.",
  { type: "object", properties: { idempotency_key: IDEMPOTENCY_FIELD, stage: { type: "string", enum: ["received", "needs_input", "unsupported", "missed", "write_pending", "outcome_unknown", "task_verified", "projection_pending", "reminder_verified", "request_verified", "auth_required", "cancelled", "superseded"] }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, offset: { type: "integer", minimum: 0, maximum: 100_000, default: 0 } }, additionalProperties: false }, true,
);
const RECOVER_REMINDER_REQUEST_TOOL = reminderManagementTool(
  "recover_reminder_request", "Recheck and recover one reminder request",
  "Continue one existing durable request by request_id. This does not create a new intent; pending, leased, missed, and authorization-blocked results must not be reported as arranged reminders.",
  { type: "object", properties: { request_id: { type: "string", pattern: UUID_PATTERN.source } }, required: ["request_id"], additionalProperties: false },
);
const AMEND_REMINDER_REQUEST_TOOL = reminderManagementTool(
  "amend_reminder_request", "Supply the date and time for a pending reminder",
  "Use only when the user supplied the missing or corrected local date and time for an existing request. Pass its current recovery_version from list_reminder_requests; a version conflict requires another read.",
  { type: "object", properties: { request_id: { type: "string", pattern: UUID_PATTERN.source }, recovery_version: { type: "integer", minimum: 0 }, requested_date: DATE_FIELD, requested_time: TIME_FIELD }, required: ["request_id", "recovery_version", "requested_date", "requested_time"], additionalProperties: false },
);

function calendarTool(name: string, title: string, description: string, inputSchema: Record<string, unknown>, readOnly = false) {
  return {
    name,
    title,
    description,
    inputSchema,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        count: { type: "integer" },
        event: { type: "object", additionalProperties: true },
        events: { type: "array", items: { type: "object", additionalProperties: true } },
        event_id: { type: "string" },
        event_id_unchanged: { type: "boolean" },
        calendar_event_count_delta: { type: "integer" },
        verified: { type: "boolean" },
        code: { type: "string" },
        error: { type: "string" },
      },
      required: ["success"],
      additionalProperties: true,
    },
    securitySchemes: AUTH_SCHEMES,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { securitySchemes: AUTH_SCHEMES, "openai/visibility": "public" },
  };
}

const SEARCH_CALENDAR_EVENTS_TOOL = calendarTool(
  "search_calendar_events",
  "Search existing Google Calendar events",
  "Read existing Google Calendar events in a bounded Shanghai date range. Use this before changing an event. This tool never creates or modifies an event.",
  { type: "object", properties: { calendar_id: { type: "string", minLength: 1, maxLength: 200, default: "primary" }, date_from: DATE_FIELD, date_to: DATE_FIELD, query: { type: "string", maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, required: ["date_from", "date_to"], additionalProperties: false },
  true,
);
const GET_CALENDAR_EVENT_TOOL = calendarTool(
  "get_calendar_event",
  "Read an existing Google Calendar event",
  "Read one existing Google Calendar event by its exact event_id. This tool never creates or modifies an event.",
  { type: "object", properties: { calendar_id: { type: "string", minLength: 1, maxLength: 200, default: "primary" }, event_id: ID_FIELD }, required: ["event_id"], additionalProperties: false },
  true,
);
const UPDATE_CALENDAR_EVENT_TOOL = calendarTool(
  "update_calendar_event",
  "Update an existing Google Calendar event in place",
  "Update the exact event_id returned by a fresh search/get call, then read it back. This tool never creates another event and reports event_id_unchanged plus calendar_event_count_delta=0. Pass expected_updated from the read result to prevent stale writes. Personal OS Task projection events must be updated through the original Google Task instead.",
  { type: "object", properties: { calendar_id: { type: "string", minLength: 1, maxLength: 200, default: "primary" }, event_id: ID_FIELD, expected_updated: { type: "string", minLength: 1, maxLength: 80 }, summary: { type: "string", minLength: 1, maxLength: 1000 }, description: { anyOf: [{ type: "string", maxLength: 8_000 }, { type: "null" }] }, location: { anyOf: [{ type: "string", maxLength: 1_000 }, { type: "null" }] }, start: { type: "string", maxLength: 80 }, end: { type: "string", maxLength: 80 }, start_date: DATE_FIELD, end_date: DATE_FIELD, timezone: { type: "string", minLength: 1, maxLength: 80 } }, required: ["event_id", "expected_updated"], additionalProperties: false },
);

async function conversationResult(request: Request, args: Record<string, unknown>, readOnly = false) {
  const url = new URL(`${SUPABASE_URL}/functions/v1/task-conversation`);
  if (readOnly) url.searchParams.set("task_id", String(args.task_id));
  const response = await fetch(url, { method: readOnly ? "GET" : "POST", headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: request.headers.get("authorization") || "", "Content-Type": "application/json" }, body: readOnly ? undefined : JSON.stringify(args), signal: AbortSignal.timeout(40_000) });
  const result = await response.json();
  return { isError: !response.ok || result.success === false, content: [{ type: "text", text: result.message || result.error || "已读取任务对话" }], structuredContent: result };
}

async function lifecycleApi(request: Request, method: string, query: Record<string, unknown> = {}, body: Record<string, unknown> | null = null) {
  const url = new URL(`${SUPABASE_URL}/functions/v1/google-tasks`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  return fetch(url, { method, headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: request.headers.get("authorization") || "", "Content-Type": "application/json", ...(body?.idempotency_key ? { "Idempotency-Key": String(body.idempotency_key) } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
}

async function lifecycleResult(request: Request, method: string, query: Record<string, unknown> = {}, body: Record<string, unknown> | null = null) {
  const response = await lifecycleApi(request, method, query, body);
  const text = await response.text();
  let result: Record<string, unknown>;
  try { result = text ? JSON.parse(text) : {}; } catch { result = { success: false, code: "INVALID_GATEWAY_RESPONSE", error: "Google Tasks returned invalid JSON" }; }
  const succeeded = response.ok && result.success === true;
  return { isError: !succeeded, content: [{ type: "text", text: succeeded ? "任务操作已核实。" : `任务操作未完成：${result.error || response.status}` }], structuredContent: result };
}

async function calendarResult(action: string, args: Record<string, unknown>) {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/task-scheduler`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WRITE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...args }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let result: Record<string, unknown>;
    try { result = text ? JSON.parse(text) : {}; }
    catch { result = { success: false, code: "INVALID_GATEWAY_RESPONSE", error: "Calendar service returned invalid JSON" }; }
    const succeeded = response.ok && result.success === true && (action !== "update_calendar_event" || result.verified === true);
    const message = succeeded
      ? action === "search_calendar_events"
        ? `已读取 ${result.count || 0} 条既有 Calendar 行程。`
        : action === "get_calendar_event"
          ? "已读取既有 Calendar 行程。"
          : `已原位更新并回读 Calendar 行程；Event ID=${result.event_id}，数量变化 0。`
      : `Calendar 操作未完成：${result.error || response.status}`;
    return { isError: !succeeded, content: [{ type: "text", text: message }], structuredContent: result };
  } catch (error) {
    return toolFailure("Calendar 操作", error);
  }
}

function managementFailure(label: string, code: string, error: string, details: Record<string, unknown> = {}) {
  const result = { success: false, code, error, ...details };
  return { isError: true, content: [{ type: "text", text: `${label}待核实：${error}` }], structuredContent: result };
}

async function internalJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let result: Record<string, unknown>;
  try { result = text ? JSON.parse(text) : {}; }
  catch { result = { success: false, code: "INVALID_GATEWAY_RESPONSE", error: "Personal OS returned invalid JSON" }; }
  return { response, result };
}

function publicSeries(row: Record<string, unknown>) {
  return Object.fromEntries([
    "id", "anchor_task_id", "current_task_id", "current_date", "recurrence_kind", "rrule", "recurrence_interval",
    "by_weekday", "by_month_day", "by_month", "next_date_override", "skip_date", "timezone",
    "local_time", "status", "created_at", "updated_at", "paused_at", "resumed_at", "cancelled_at",
  ].map((key) => [key, row[key]]));
}

async function recurrenceSeriesResult(action: "list_series" | "update_series" | "pause_series" | "resume_series" | "skip_series_once" | "cancel_series", args: Record<string, unknown> = {}) {
  try {
    const { response, result } = await internalJson(`${SUPABASE_URL}/functions/v1/task-scheduler`, {
      method: "POST", headers: { Authorization: `Bearer ${WRITE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...args }),
    });
    if (!response.ok || result.success !== true) return managementFailure("重复提醒系列", String(result.code || "SERIES_UNVERIFIED"), String(result.error || "服务未核实结果"));
    if (action === "list_series") {
      if (!Array.isArray(result.series)) return managementFailure("重复提醒系列", "SERIES_READBACK_INVALID", "系列列表格式无效");
      const output = { success: true, series: result.series.map((row: Record<string, unknown>) => publicSeries(row)) };
      return { content: [{ type: "text", text: `已读取 ${result.series.length} 个循环任务系列，包含暂停和已停止的系列。` }], structuredContent: output };
    }
    const readback = await internalJson(`${SUPABASE_URL}/functions/v1/task-scheduler`, {
      method: "POST", headers: { Authorization: `Bearer ${WRITE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list_series" }),
    });
    const series = Array.isArray(readback.result.series)
      ? readback.result.series.find((item: Record<string, unknown>) => item.id === args.series_id) : null;
    if (!readback.response.ok || readback.result.success !== true || !series) {
      return managementFailure("循环任务系列", "SERIES_READBACK_PENDING", "操作已发送，但系列状态回读失败", { series_id: args.series_id });
    }
    if (action === "update_series") {
      if (result.updated !== true || series.rrule !== (result.series as Record<string, unknown> | undefined)?.rrule) {
        return managementFailure("循环规则修改", "SERIES_UPDATE_READBACK_PENDING", "未来循环规则未能回读核实", { series_id: args.series_id });
      }
      return { content: [{ type: "text", text: "已修改未来循环规则；当前实例和历史任务保持不变。" }], structuredContent: { success: true, updated: true, series: publicSeries(series) } };
    }
    if (action === "pause_series" || action === "resume_series") {
      const expected = action === "pause_series" ? "paused" : "active";
      if (series.status !== expected) return managementFailure("循环系列状态", "SERIES_STATUS_READBACK_PENDING", "系列状态未能回读核实", { series_id: args.series_id });
      return { content: [{ type: "text", text: expected === "paused" ? "已暂停未来循环实例；当前 Google Task 与历史保留。" : "已恢复循环系列，并核对下一次实例。" }],
        structuredContent: { success: true, status: expected, series: publicSeries(series), advancement: result.advancement } };
    }
    if (action === "skip_series_once") {
      if (result.skipped !== true || series.skip_date !== result.recurrence_instance_date) {
        return managementFailure("跳过一次", "SERIES_SKIP_READBACK_PENDING", "跳过日期未能回读核实", { series_id: args.series_id });
      }
      return { content: [{ type: "text", text: `已跳过 ${result.recurrence_instance_date} 这一次；系列之后继续。` }],
        structuredContent: { success: true, skipped: true, recurrence_instance_date: result.recurrence_instance_date, series: publicSeries(series) } };
    }
    if (result.cancelled !== true || series.status !== "cancelled") {
      return managementFailure("重复提醒系列停止", "SERIES_CANCEL_READBACK_PENDING", "系列停止结果未能回读核实", { series_id: args.series_id });
    }
    const currentReminderDisabled = (result.projection as Record<string, unknown> | undefined)?.notification_status === "disabled";
    const output = { success: true, cancelled: true, series_id: args.series_id, series: publicSeries(series),
      current_task_id: result.current_task_id, current_reminder_verified_disabled: currentReminderDisabled };
    return { content: [{ type: "text", text: currentReminderDisabled
      ? "已停止整个重复提醒系列，并核实当前日历提醒已关闭；原 Google Task 保留。"
      : "已核实整个重复提醒系列停止；当前日历提醒状态仍需核实，原 Google Task 保留。" }], structuredContent: output };
  } catch (error) {
    return managementFailure("重复提醒系列", "SERIES_SERVICE_UNAVAILABLE", error instanceof Error ? error.message : "服务暂不可用");
  }
}

async function reminderRequestResult(action: "list" | "recover" | "amend", args: Record<string, unknown>) {
  try {
    const url = new URL(`${SUPABASE_URL}/functions/v1/personal-os-intake`);
    if (action === "list") for (const key of ["idempotency_key", "stage", "limit", "offset"]) {
      if (args[key] !== undefined) url.searchParams.set(key, String(args[key]));
    }
    const { response, result } = await internalJson(url.toString(), {
      method: action === "list" ? "GET" : "POST",
      headers: { Authorization: `Bearer ${WRITE_TOKEN}`, "Content-Type": "application/json" },
      ...(action === "list" ? {} : { body: JSON.stringify({ action: action === "recover" ? "recover" : "amend_request", ...args }) }),
    });
    if (!response.ok) return managementFailure("提醒请求", String(result.code || "REQUEST_SERVICE_ERROR"), String(result.error || "请求服务暂不可用"));
    if (action === "list") {
      if (!Array.isArray(result.requests) || typeof result.has_more !== "boolean") return managementFailure("提醒请求", "REQUEST_LIST_INVALID", "请求列表格式无效");
      const output = { ...result, success: true };
      return { content: [{ type: "text", text: `已读取 ${result.requests.length} 条提醒请求${result.has_more ? "；还有下一页，请按 next_offset 继续读取" : ""}。` }], structuredContent: output };
    }
    if (action === "recover") {
      const item = Array.isArray(result.results) ? result.results.find((row: Record<string, unknown>) => row.request_id === args.request_id) : null;
      if (!item || item.success !== true || item.verified !== true) {
        return managementFailure("提醒请求恢复", String(item?.code || item?.decision || "RECOVERY_PENDING"), "请求仍待核实或需要进一步处理", { request_id: args.request_id, result: item || result });
      }
      return { content: [{ type: "text", text: "该请求的写入和所需投影已核实；如有设备提醒，送达仍需真机确认。" }], structuredContent: { success: true, request_id: args.request_id, result: item, checked_at: result.checked_at } };
    }
    if (result.success !== true || result.verified !== true) {
      return managementFailure("提醒请求补充", String(result.code || "AMENDMENT_PENDING"), String(result.message || "补充已接收，结果仍待核实"), { request_id: args.request_id, result });
    }
    return { content: [{ type: "text", text: "补充时间后的任务与提醒配置已核实；设备送达仍需真机确认。" }], structuredContent: result };
  } catch (error) {
    return managementFailure("提醒请求", "REQUEST_SERVICE_UNAVAILABLE", error instanceof Error ? error.message : "服务暂不可用");
  }
}

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handleMcp(request: Request) {
  if (request.method === "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE" } });
  }
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE" } });

  let rpc: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JSON-RPC payload");
    rpc = parsed as Record<string, unknown>;
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const id = rpc.id;
  const method = rpc.method;
  if (rpc.jsonrpc !== "2.0" || typeof method !== "string") return rpcError(id, -32600, "Invalid Request");

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return new Response(null, { status: 202 });
  }
  if (method === "initialize") {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params as Record<string, unknown> : {};
    const requestedVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
    return rpcResult(id, {
      protocolVersion: requestedVersion,
      serverInfo: { name: "personal-os", title: "Personal OS", version: "1.7.0" },
      capabilities: { tools: { listChanged: false } },
      instructions: "For task-bound conversational changes, use get_task_conversation and converse_task: preview, clarify, await actual human confirmation, then execute. This specific workflow overrides the general low-risk intake default for date/time/status/follow-up changes; never synthesize confirmation or bypass with CRUD. Google Tasks is Task status truth. Clear low-risk reversible actions are authorized by natural-language intent: infer missing optional fields and execute without asking for date, hotel name, repetition or reconfirmation. Resolve Before Create and update first. Questions create nothing; durable preferences use Goals & Plans; mixed rules and current actions save both. Pass known conversation_trips and current_task.id for short corrections; re-read provider state before changing it. Infer Date from explicit wording, conversation, Calendar, Travel Plan, current context, then a reasonable default. Never invent Deadline. One action is one Task; unfinished tasks remain visible through Today/Overdue, not duplicate daily inserts. L2 asks only about outcome-changing ambiguity; L3 transactions require critical parameters and confirmation and cannot execute through these Task tools. For timed actions perform Smart Reminder reasoning, attach reminders to the same Schedule and stable Calendar Event, and use update_task_reminder for existing reminders. Ordinary reminders go to Google Tasks; automation is for future GPT search, analysis or generated content. Only write_success=true plus verified=true permits 已经写进去了. Prefer the returned short message and report Calendar projection failures separately; projection is not phone delivery. Natural-language recurring tasks are supported: 每天=daily; 每周三=weekly with weekday 3; 每月5号=monthly with month_day 5; 每年9月30号=yearly with month 9 and month_day 30. Pass recurrence to create_task or capture_personal_os_item and create only the first current instance; never say recurrence is unsupported. Use list_recurrence_series to identify a series. Recurrence supports DAILY, WEEKLY, MONTHLY, and YEARLY RRULE-compatible rules. Modify only future instances, pause/resume without changing Google Task history, skip exactly the next instance, and stop an entire series only on explicit intent. Use list_reminder_requests to find pending or missed requests, then recover_reminder_request or amend_reminder_request with the exact request_id and recovery_version; pending recovery is not arranged success. For an existing independent Calendar event, search or get it through this Personal OS server, then update the exact event_id in place with expected_updated; never create a replacement when an update fails. Task projection events must still be changed through the original Google Task.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: [
    TASK_CONVERSATION_TOOL,
    GET_TASK_CONVERSATION_TOOL,
    LIST_RECURRENCE_SERIES_TOOL,
    UPDATE_RECURRENCE_SERIES_TOOL,
    PAUSE_RECURRENCE_SERIES_TOOL,
    RESUME_RECURRENCE_SERIES_TOOL,
    SKIP_RECURRENCE_SERIES_TOOL,
    CANCEL_RECURRENCE_SERIES_TOOL,
    LIST_REMINDER_REQUESTS_TOOL,
    RECOVER_REMINDER_REQUEST_TOOL,
    AMEND_REMINDER_REQUEST_TOOL,
    CREATE_TASK_TOOL,
    SEARCH_TASKS_TOOL,
    GET_TASK_TOOL,
    UPDATE_TASK_TOOL,
    COMPLETE_TASK_TOOL,
    REOPEN_TASK_TOOL,
    DELETE_TASK_TOOL,
    SEARCH_CALENDAR_EVENTS_TOOL,
    GET_CALENDAR_EVENT_TOOL,
    UPDATE_CALENDAR_EVENT_TOOL,
    UPDATE_TASK_REMINDER_TOOL,
    RESOLVE_TASK_INTENT_TOOL,
    GET_TASK_GRAPH_TOOL,
    EXPLAIN_TASK_RESOLUTION_TOOL,
    CAPTURE_ITEM_TOOL,
    GET_GOALS_TOOL,
    UPDATE_GOAL_TOOL,
    COMPLETE_GOAL_TOOL,
  ] });
  if (method === "tools/call") {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params as Record<string, unknown> : {};
    const schemas: Record<string, z.ZodTypeAny> = {
      converse_task: TaskConversationInput,
      get_task_conversation: LifecycleIdInput,
      list_recurrence_series: ListRecurrenceSeriesInput,
      update_recurrence_series: UpdateRecurrenceSeriesInput,
      pause_recurrence_series: PauseRecurrenceSeriesInput,
      resume_recurrence_series: ResumeRecurrenceSeriesInput,
      skip_recurrence_occurrence: SkipRecurrenceSeriesInput,
      cancel_recurrence_series: CancelRecurrenceSeriesInput,
      list_reminder_requests: ListReminderRequestsInput,
      recover_reminder_request: RecoverReminderRequestInput,
      amend_reminder_request: AmendReminderRequestInput,
      create_task: TaskInput,
      search_tasks: SearchTasksInput,
      get_task: LifecycleIdInput,
      update_task: LifecycleMutationInput,
      complete_task: LifecycleStateInput,
      reopen_task: LifecycleStateInput,
      delete_task: LifecycleStateInput,
      search_calendar_events: CalendarSearchInput,
      get_calendar_event: CalendarEventInput,
      update_calendar_event: CalendarEventUpdateInput,
      update_task_reminder: UpdateTaskReminderInput,
      resolve_task_intent: TaskResolutionPreviewInput,
      get_task_graph: TaskGraphInput,
      explain_task_resolution: ResolutionExplainInput,
      capture_personal_os_item: UnifiedIntakeInput,
      get_goals: GoalQueryInput,
      update_goal: GoalUpdateInput,
      complete_goal: GoalCompleteInput,
    };
    const name = typeof params.name === "string" ? params.name : "";
    const schema = schemas[name];
    if (!schema) return rpcError(id, -32602, "Unknown tool");
    const parsed = schema.safeParse(params.arguments || {});
    if (!parsed.success) {
      return rpcResult(id, {
        isError: true,
        content: [{ type: "text", text: "Personal OS 未写入：参数无效。" }],
        structuredContent: { success: false, code: "INVALID_ARGUMENTS", error: "Invalid intake arguments" },
      });
    }
    if (name === "converse_task") return rpcResult(id, await conversationResult(request, parsed.data as z.infer<typeof TaskConversationInput>));
    if (name === "get_task_conversation") return rpcResult(id, await conversationResult(request, parsed.data as z.infer<typeof LifecycleIdInput>, true));
    if (name === "list_recurrence_series") return rpcResult(id, await recurrenceSeriesResult("list_series"));
    if (name === "update_recurrence_series") return rpcResult(id, await recurrenceSeriesResult("update_series", parsed.data as z.infer<typeof UpdateRecurrenceSeriesInput>));
    if (name === "pause_recurrence_series") return rpcResult(id, await recurrenceSeriesResult("pause_series", parsed.data as z.infer<typeof PauseRecurrenceSeriesInput>));
    if (name === "resume_recurrence_series") return rpcResult(id, await recurrenceSeriesResult("resume_series", parsed.data as z.infer<typeof ResumeRecurrenceSeriesInput>));
    if (name === "skip_recurrence_occurrence") return rpcResult(id, await recurrenceSeriesResult("skip_series_once", parsed.data as z.infer<typeof SkipRecurrenceSeriesInput>));
    if (name === "cancel_recurrence_series") return rpcResult(id, await recurrenceSeriesResult("cancel_series", parsed.data as z.infer<typeof CancelRecurrenceSeriesInput>));
    if (name === "list_reminder_requests") return rpcResult(id, await reminderRequestResult("list", parsed.data as z.infer<typeof ListReminderRequestsInput>));
    if (name === "recover_reminder_request") return rpcResult(id, await reminderRequestResult("recover", parsed.data as z.infer<typeof RecoverReminderRequestInput>));
    if (name === "amend_reminder_request") return rpcResult(id, await reminderRequestResult("amend", parsed.data as z.infer<typeof AmendReminderRequestInput>));
    if (name === "create_task") return rpcResult(id, await createTask(parsed.data as z.infer<typeof TaskInput>));
    if (name === "search_tasks") return rpcResult(id, await lifecycleResult(request, "GET", { action: "search", ...(parsed.data as z.infer<typeof SearchTasksInput>) }));
    if (name === "get_task") return rpcResult(id, await lifecycleResult(request, "GET", { action: "get", task_id: (parsed.data as z.infer<typeof LifecycleIdInput>).task_id }));
    if (name === "update_task") {
      const { task_id, clear_fields, raw_text, request_id, idempotency_key, ...changes } = parsed.data as z.infer<typeof LifecycleMutationInput>;
      return rpcResult(id, await lifecycleResult(request, "PATCH", {}, { action: "update", task_id, changes, clear_fields: clear_fields || [], raw_text, request_id, source: "chatgpt", idempotency_key }));
    }
    if (name === "complete_task" || name === "reopen_task") return rpcResult(id, await lifecycleResult(request, "PATCH", {}, { action: name === "complete_task" ? "complete" : "reopen", ...(parsed.data as z.infer<typeof LifecycleStateInput>), source: "chatgpt" }));
    if (name === "delete_task") return rpcResult(id, await lifecycleResult(request, "DELETE", {}, { action: "delete", ...(parsed.data as z.infer<typeof LifecycleStateInput>), source: "chatgpt" }));
    if (name === "search_calendar_events") return rpcResult(id, await calendarResult(name, parsed.data as z.infer<typeof CalendarSearchInput>));
    if (name === "get_calendar_event") return rpcResult(id, await calendarResult(name, parsed.data as z.infer<typeof CalendarEventInput>));
    if (name === "update_calendar_event") return rpcResult(id, await calendarResult(name, parsed.data as z.infer<typeof CalendarEventUpdateInput>));
    if (name === "update_task_reminder") return rpcResult(id, await updateTaskReminder(parsed.data as z.infer<typeof UpdateTaskReminderInput>));
    if (name === "resolve_task_intent") return rpcResult(id, await previewTaskIntent(parsed.data as z.infer<typeof TaskResolutionPreviewInput>));
    if (name === "get_task_graph") return rpcResult(id, await getTaskGraph());
    if (name === "explain_task_resolution") return rpcResult(id, await explainTaskResolution(parsed.data as z.infer<typeof ResolutionExplainInput>));
    if (name === "capture_personal_os_item") return rpcResult(id, await captureItem(parsed.data as z.infer<typeof UnifiedIntakeInput>));
    if (name === "get_goals") return rpcResult(id, await getGoals(request, parsed.data as z.infer<typeof GoalQueryInput>));
    if (name === "update_goal") return rpcResult(id, await updateGoal(request, parsed.data as z.infer<typeof GoalUpdateInput>));
    return rpcResult(id, await completeGoal(request, parsed.data as z.infer<typeof GoalCompleteInput>));
  }
  return rpcError(id, -32601, "Method not found");
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA}", scope="openid email profile"`,
    },
  });
}

async function authorize(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: authorization },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id === OWNER_USER_ID ? user : null;
}

const app = new Hono();
const functionApp = new Hono();

functionApp.get("/", (context) => context.json({ name: "personal-os", version: "1.6.0", mcp: "/mcp" }));
functionApp.get("/.well-known/oauth-protected-resource", (context) => context.json({
  resource: MCP_RESOURCE,
  authorization_servers: [AUTHORIZATION_SERVER],
  scopes_supported: ["openid", "email", "profile"],
  bearer_methods_supported: ["header"],
  resource_documentation: "https://scutdavidlin-hue.github.io/personal-todo-list/",
}));
functionApp.all("/mcp", async (context) => {
  if (!SUPABASE_URL || !SUPABASE_PUBLIC_KEY || !/^[0-9a-f-]{36}$/i.test(OWNER_USER_ID) || WRITE_TOKEN.length < 32) {
    return context.json({ error: "Server configuration incomplete" }, 503);
  }
  if (!await authorize(context.req.raw)) return unauthorized();
  return handleMcp(context.req.raw);
});

app.route("/personal-os-mcp", functionApp);
Deno.serve(app.fetch);
