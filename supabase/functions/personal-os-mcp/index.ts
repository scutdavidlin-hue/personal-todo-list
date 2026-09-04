import { Hono } from "hono";
import { z } from "zod";

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
  code: z.string().optional(),
  error: z.string().optional(),
});

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
  const succeeded = response.ok && result.success === true && typeof result.id === "string";
  return {
    isError: !succeeded,
    content: [{
      type: "text",
      text: succeeded
        ? `已真实写入 Google Tasks${args.requested_time ? " 并建立 Calendar 时间投影" : ""}：${result.title}${result.due ? `（到期 ${result.due}）` : ""}`
        : `任务未写入：${result.error || `Personal OS returned ${response.status}`}`,
    }],
    structuredContent: result,
  };
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
      serverInfo: { name: "personal-os", title: "Personal OS", version: "1.1.0" },
      capabilities: { tools: { listChanged: false } },
      instructions: "Use create_task only for ordinary reminders and todos that the user wants written to Personal OS Google Tasks.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: [CREATE_TASK_TOOL] });
  if (method === "tools/call") {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params as Record<string, unknown> : {};
    if (params.name !== "create_task") return rpcError(id, -32602, "Unknown tool");
    const parsed = TaskInput.safeParse(params.arguments);
    if (!parsed.success) {
      return rpcResult(id, {
        isError: true,
        content: [{ type: "text", text: "任务未写入：参数无效。" }],
        structuredContent: { success: false, code: "INVALID_ARGUMENTS", error: "Invalid task arguments" },
      });
    }
    return rpcResult(id, await createTask(parsed.data));
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

functionApp.get("/", (context) => context.json({ name: "personal-os", version: "1.0.0", mcp: "/mcp" }));
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
