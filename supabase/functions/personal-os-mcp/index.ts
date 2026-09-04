import { Hono } from "hono";
import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
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
  code: z.string().optional(),
  error: z.string().optional(),
});

const mcp = new McpServer({
  name: "personal-os",
  version: "1.0.0",
  schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
  logger: {
    error: console.error,
    warn: console.warn,
    info: () => {},
    debug: () => {},
  },
});

mcp.tool("create_task", {
  title: "Create a Personal OS task",
  description: "Create an ordinary reminder, todo, or action item in the user's Personal OS Google Tasks list. Use this only when the requested future action merely needs a reminder. Do not use it for meetings, flights, appointments, time blocks, recurring web research, analysis jobs, project facts, or durable knowledge. Report success only when this tool returns success=true.",
  inputSchema: TaskInput,
  outputSchema: TaskOutput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    audience: ["assistant", "user"],
    priority: 1,
  },
  handler: async (args) => {
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
    let result: Record<string, unknown>;
    try { result = text ? JSON.parse(text) : {}; }
    catch { result = { success: false, code: "INVALID_GATEWAY_RESPONSE", error: "Personal OS returned an invalid response" }; }
    const succeeded = response.ok && result.success === true && typeof result.id === "string";
    return {
      isError: !succeeded,
      content: [{
        type: "text",
        text: succeeded
          ? `已真实写入 Google Tasks：${result.title}${result.due ? `（到期 ${result.due}）` : ""}`
          : `任务未写入：${result.error || `Personal OS returned ${response.status}`}`,
      }],
      structuredContent: result,
    };
  },
});

const transport = new StreamableHttpTransport();
const handleMcp = transport.bind(mcp);

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
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: authorization },
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
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !/^[0-9a-f-]{36}$/i.test(OWNER_USER_ID) || WRITE_TOKEN.length < 32) {
    return context.json({ error: "Server configuration incomplete" }, 503);
  }
  if (!await authorize(context.req.raw)) return unauthorized();
  return handleMcp(context.req.raw);
});

app.route("/personal-os-mcp", functionApp);
Deno.serve(app.fetch);
