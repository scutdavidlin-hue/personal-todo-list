import { Hono } from "hono";
import { z } from "zod";

import { completeGoalPatch, filterGoalsForRead, isPersistedObjectResult, mergeGoalText } from "../_shared/goal-operations.js";
import { resolvePublishableApiKey } from "../_shared/supabase-api-keys.js";

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

const TaskInput = z.object({
  raw_text: z.string().min(1).max(10_000).describe("The user's original wording, preserved for audit."),
  title: z.string().min(1).max(200).describe("A concise actionable task title."),
  notes: z.string().max(10_000).optional().describe("Helpful task details without secrets."),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("Due date in YYYY-MM-DD, or null when no date was requested."),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("Hard deadline date, or null when none was stated."),
  requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("The execution date explicitly requested by the user."),
  requested_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional().describe("The execution time explicitly requested by the user. Never invent this when only a date was stated."),
  estimated_duration: z.number().int().min(5).max(720).default(30).describe("Estimated duration in minutes."),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  fixed_time: z.boolean().default(false).describe("True when the user explicitly gave the execution time; the automatic scheduler must not move it."),
  goal_id: z.string().regex(UUID_PATTERN).nullable().optional().describe("Existing Goal id when this Task is an explicit next action for that Goal."),
  timezone: z.string().default("Asia/Shanghai").describe("IANA timezone used to interpret the request."),
  idempotency_key: z.string().min(8).max(200).describe("A unique key for this user intent. Reuse exactly the same key only when retrying the same request."),
});

const TaskOutput = z.object({
  success: z.boolean(),
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
  code: z.string().optional(),
  error: z.string().optional(),
});

const UnifiedIntakeInput = z.object({
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
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  target_month: z.string().regex(/^20\d{2}-(?:0[1-9]|1[0-2])$/).nullable().optional(),
  target_year: z.number().int().min(2000).max(2200).nullable().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  review_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
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
  estimated_duration: z.number().int().min(5).max(720).default(30),
  fixed_time: z.boolean().default(false),
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

const AUTH_SCHEMES = [{ type: "oauth2", scopes: ["openid", "email", "profile"] }];

const CREATE_TASK_TOOL = {
  name: "create_task",
  title: "Create a Personal OS task",
  description: "Create an ordinary reminder, todo, or action item in the user's Personal OS Google Tasks list. When the user explicitly states an execution time, also pass requested_date/requested_time so Personal OS creates one linked Google Calendar projection. Do not use it for meetings, flights, appointments, recurring web research, analysis jobs, project facts, or durable knowledge. Report success only when this tool returns success=true.",
  inputSchema: {
    type: "object",
    properties: {
      raw_text: { type: "string", minLength: 1, maxLength: 10_000, description: "The user's original wording, preserved for audit." },
      title: { type: "string", minLength: 1, maxLength: 200, description: "A concise actionable task title." },
      notes: { type: "string", maxLength: 10_000, description: "Helpful task details without secrets." },
      due: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }], description: "Due date in YYYY-MM-DD, or null when no date was requested." },
      deadline: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }], description: "Hard deadline date, or null." },
      requested_date: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }], description: "Explicit execution date." },
      requested_time: { anyOf: [{ type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }, { type: "null" }], description: "Explicit execution time; never invent it for a date-only request." },
      estimated_duration: { type: "integer", minimum: 5, maximum: 720, default: 30, description: "Estimated duration in minutes." },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"], default: "medium" },
      fixed_time: { type: "boolean", default: false, description: "True only when the user explicitly gave the execution time." },
      goal_id: { anyOf: [{ type: "string", pattern: "^[0-9a-fA-F-]{36}$" }, { type: "null" }], description: "Existing Goal id when this Task is its concrete next action." },
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

const CAPTURE_ITEM_TOOL = {
  name: "capture_personal_os_item",
  title: "Capture a Personal OS item",
  description: "Classify and persist the user's natural-language input in the correct Personal OS layer. Explicit requests such as 'put this in my medium-term goals' should be written directly without asking for confirmation. A concrete action goes to Google Tasks; a durable direction or state goes to Goals & Plans. Writes are update-first: use existing_goal_id from get_goals when context identifies an existing Goal, otherwise the intake gateway performs conservative matching. Do not invent a deadline, target precision, amount, motivation, or next action. Preserve raw_text exactly and report success only when success=true.",
  inputSchema: {
    type: "object",
    properties: {
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
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"], default: "medium" },
      target_date: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
      target_month: { anyOf: [{ type: "string", pattern: "^20\\d{2}-(?:0[1-9]|1[0-2])$" }, { type: "null" }] },
      target_year: { anyOf: [{ type: "integer", minimum: 2000, maximum: 2200 }, { type: "null" }] },
      start_date: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
      review_date: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
      deadline: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
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
      estimated_duration: { type: "integer", minimum: 5, maximum: 720, default: 30 },
      fixed_time: { type: "boolean", default: false },
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
        raw_text: args.raw_text,
        type: "task",
        title: args.title,
        notes: args.notes || "",
        due: args.due || null,
        deadline: args.deadline || null,
        requested_date: args.requested_date || null,
        requested_time: args.requested_time || null,
        estimated_duration: args.estimated_duration,
        priority: args.priority,
        fixed_time: args.fixed_time,
        goal_plan_id: args.goal_id || null,
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
  const succeeded = isPersistedObjectResult(response.ok, result);
  const relationSuffix = args.goal_id
    ? result.goal_linked
      ? "，并已关联现有 Goal"
      : `；Task 已创建，但 Goal 关联未完成${result.goal_link_error ? `（${result.goal_link_error}）` : ""}`
    : "";
  return {
    isError: !succeeded,
    content: [{
      type: "text",
      text: succeeded
        ? `已真实写入 Google Tasks${args.requested_time ? " 并建立 Calendar 时间投影" : ""}：${result.title}${result.due ? `（到期 ${result.due}）` : ""}${relationSuffix}`
        : `任务未写入：${result.error || `Personal OS returned ${response.status}`}`,
    }],
    structuredContent: result,
  };
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
  const succeeded = isPersistedObjectResult(response.ok, result);
  const classification = String(result.classification || args.type || "item");
  const destination = String(result.destination || "");
  const horizon = { short: "短期", medium: "中期", long: "长期" }[String(result.horizon || args.horizon || "medium")] || "中期";
  return {
    isError: !succeeded,
    content: [{
      type: "text",
      text: succeeded
        ? destination === "google_tasks"
          ? `已归类为 Task 并真实写入 Google Tasks：${result.title}`
          : result.operation === "updated"
            ? `已更新现有 Goal「${result.title}」。`
            : `已加入 Personal OS → ${horizon} Goal & Plan「${result.title}」。`
        : `未写入 Personal OS：${result.error || `Personal OS returned ${response.status}`}`,
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
      serverInfo: { name: "personal-os", title: "Personal OS", version: "1.2.1" },
      capabilities: { tools: { listChanged: false } },
      instructions: "Personal OS is the source of truth. Use get_goals, never memory alone, when the user asks about goals or before changing an unknown goal. If the user explicitly asks to put something in Goal & Plan, call capture_personal_os_item directly without asking again. Writes are update-first: pass existing_goal_id when known. Use update_goal for a known existing goal and complete_goal for completion. Use create_task only for a concrete next action; for a Goal plus action, persist the Goal first and pass its id as goal_id to create_task. A Goal time window is not a Task deadline. Never claim persistence unless the tool returns success=true.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: [CREATE_TASK_TOOL, CAPTURE_ITEM_TOOL, GET_GOALS_TOOL, UPDATE_GOAL_TOOL, COMPLETE_GOAL_TOOL] });
  if (method === "tools/call") {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params as Record<string, unknown> : {};
    const schemas: Record<string, z.ZodTypeAny> = {
      create_task: TaskInput,
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
    if (name === "create_task") return rpcResult(id, await createTask(parsed.data as z.infer<typeof TaskInput>));
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

functionApp.get("/", (context) => context.json({ name: "personal-os", version: "1.2.1", mcp: "/mcp" }));
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
