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

const TaskInput = z.object({
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
const SearchTasksInput = z.object({ query: z.string().max(500).optional(), task_id: z.string().max(1024).optional(), status: z.enum(["open", "completed", "all"]).default("open"), priority: z.enum(["low", "medium", "high", "urgent"]).optional(), task_type: z.enum(["task", "follow_up"]).optional(), date_from: z.string().optional(), date_to: z.string().optional(), deadline_from: z.string().optional(), deadline_to: z.string().optional(), created_from: z.string().max(40).optional(), created_to: z.string().max(40).optional(), updated_from: z.string().max(40).optional(), updated_to: z.string().max(40).optional(), limit: z.number().int().min(1).max(100).default(20) });

const UnifiedIntakeInput = z.object({
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

const CREATE_TASK_TOOL = {
  name: "create_task",
  title: "Create a Personal OS task",
  description: "Execute clear low-risk actions immediately without asking for optional date, hotel, repetition or confirmation. One action is one Google Task. Infer reasonable Date from conversation, Calendar or Travel Plan; never invent Deadline. Search and update existing tasks before creating. Pass context.current_task.id for short corrections such as 改成四点; the server reads current truth. Information questions do not create tasks. High-risk transactions require key parameters and confirmation and are never executed by this task tool. Report persistence only with write_success=true and verified=true; use returned message. Calendar is the same task's projection. GPT automation is only for future GPT work, not ordinary reminders.",
  inputSchema: {
    type: "object",
    properties: {
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
      destination: { type: "string" },
      id: { type: "string" },
      title: { type: "string" },
      due: { anyOf: [{ type: "string" }, { type: "null" }] },
      deduplicated: { type: "boolean" },
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
  description: "Infer → Execute → Verify → Report. Clear reversible life/work actions go directly to Google Tasks without optional-field questions or reconfirmation. Information questions create nothing; lasting preferences go to Goals & Plans; a lasting rule plus current action is saved in both existing layers. Preserve raw_text and known conversation context. Semantic search precedes create, short corrections update context.current_task.id, and partial cancellation keeps unrelated arrangements. Ask only about outcome-changing ambiguity or high-risk acts. Use returned message; never claim persistence without write_success=true and verified=true.",
  inputSchema: {
    type: "object",
    properties: {
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
    const result = { success: false, code: "INTAKE_UNREACHABLE", error: error instanceof Error ? error.message : "Personal OS intake unavailable" };
    return { isError: true, content: [{ type: "text", text: `任务未写入：${result.error}` }], structuredContent: result };
  }

  const text = await response.text();
  let result: z.infer<typeof TaskOutput>;
  try { result = text ? JSON.parse(text) : { success: false }; }
  catch { result = { success: false, code: "INVALID_GATEWAY_RESPONSE", error: "Personal OS returned an invalid response" }; }
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
    const succeeded = response.ok && result.success === true;
    return {
      isError: !succeeded,
      content: [{
        type: "text",
        text: succeeded
          ? `已在原 Task / Schedule / Calendar Event 上更新提醒；Task=${result.task_id}，Schedule ID 与 Event ID 均保持稳定，Google Tasks 数量变化 0。`
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
    const result = { success: false, code: "INTAKE_UNREACHABLE", error: error instanceof Error ? error.message : "Personal OS intake unavailable" };
    return { isError: true, content: [{ type: "text", text: `未写入 Personal OS：${result.error}` }], structuredContent: result };
  }

  const text = await response.text();
  let result: Record<string, unknown>;
  try { result = text ? JSON.parse(text) : { success: false }; }
  catch { result = { success: false, code: "INVALID_GATEWAY_RESPONSE", error: "Personal OS returned an invalid response" }; }
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
      serverInfo: { name: "personal-os", title: "Personal OS", version: "1.5.0" },
      capabilities: { tools: { listChanged: false } },
      instructions: "For task-bound conversational changes, use get_task_conversation and converse_task: preview, clarify, await actual human confirmation, then execute. This specific workflow overrides the general low-risk intake default for date/time/status/follow-up changes; never synthesize confirmation or bypass with CRUD. Google Tasks is Task status truth. Clear low-risk reversible actions are authorized by natural-language intent: infer missing optional fields and execute without asking for date, hotel name, repetition or reconfirmation. Resolve Before Create and update first. Questions create nothing; durable preferences use Goals & Plans; mixed rules and current actions save both. Pass known conversation_trips and current_task.id for short corrections; re-read provider state before changing it. Infer Date from explicit wording, conversation, Calendar, Travel Plan, current context, then a reasonable default. Never invent Deadline. One action is one Task; unfinished tasks remain visible through Today/Overdue, not duplicate daily inserts. L2 asks only about outcome-changing ambiguity; L3 transactions require critical parameters and confirmation and cannot execute through these Task tools. For timed actions perform Smart Reminder reasoning, attach reminders to the same Schedule and stable Calendar Event, and use update_task_reminder for existing reminders. Ordinary reminders go to Google Tasks; automation is for future GPT search, analysis or generated content. Only write_success=true plus verified=true permits 已经写进去了. Prefer the returned short message and report Calendar projection failures separately; projection is not phone delivery.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: [
    TASK_CONVERSATION_TOOL,
    GET_TASK_CONVERSATION_TOOL,
    CREATE_TASK_TOOL,
    SEARCH_TASKS_TOOL,
    GET_TASK_TOOL,
    UPDATE_TASK_TOOL,
    COMPLETE_TASK_TOOL,
    REOPEN_TASK_TOOL,
    DELETE_TASK_TOOL,
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
      create_task: TaskInput,
      search_tasks: SearchTasksInput,
      get_task: LifecycleIdInput,
      update_task: LifecycleMutationInput,
      complete_task: LifecycleStateInput,
      reopen_task: LifecycleStateInput,
      delete_task: LifecycleStateInput,
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
    if (name === "create_task") return rpcResult(id, await createTask(parsed.data as z.infer<typeof TaskInput>));
    if (name === "search_tasks") return rpcResult(id, await lifecycleResult(request, "GET", { action: "search", ...(parsed.data as z.infer<typeof SearchTasksInput>) }));
    if (name === "get_task") return rpcResult(id, await lifecycleResult(request, "GET", { action: "get", task_id: (parsed.data as z.infer<typeof LifecycleIdInput>).task_id }));
    if (name === "update_task") {
      const { task_id, clear_fields, raw_text, request_id, idempotency_key, ...changes } = parsed.data as z.infer<typeof LifecycleMutationInput>;
      return rpcResult(id, await lifecycleResult(request, "PATCH", {}, { action: "update", task_id, changes, clear_fields: clear_fields || [], raw_text, request_id, source: "chatgpt", idempotency_key }));
    }
    if (name === "complete_task" || name === "reopen_task") return rpcResult(id, await lifecycleResult(request, "PATCH", {}, { action: name === "complete_task" ? "complete" : "reopen", ...(parsed.data as z.infer<typeof LifecycleStateInput>), source: "chatgpt" }));
    if (name === "delete_task") return rpcResult(id, await lifecycleResult(request, "DELETE", {}, { action: "delete", ...(parsed.data as z.infer<typeof LifecycleStateInput>), source: "chatgpt" }));
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

functionApp.get("/", (context) => context.json({ name: "personal-os", version: "1.4.0", mcp: "/mcp" }));
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
