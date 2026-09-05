import { runTaskConversation, TaskConversationError } from "../_shared/task-conversation-runtime.js";
import { taskConversationCreatePayload } from "../_shared/task-conversation-adapter.js";
import {
  resolvePublishableApiKey,
  resolveServiceApiKey,
  serviceApiHeaders,
} from "../_shared/supabase-api-keys.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const USE_NEW_API_KEYS = Deno.env.get("SUPABASE_USE_NEW_API_KEYS") === "true";
const SERVICE_API_KEY = resolveServiceApiKey({
  secretKeys: Deno.env.get("SUPABASE_SECRET_KEYS"),
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  preferNew: USE_NEW_API_KEYS,
});
const SUPABASE_PUBLIC_KEY = resolvePublishableApiKey({
  publishableKeys: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
  anonKey: Deno.env.get("SUPABASE_ANON_KEY"),
  preferNew: USE_NEW_API_KEYS,
});
const REQUEST_TIMEOUT_MS = 30_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

class ApiError extends TaskConversationError {}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function parseJson(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function timedFetch(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function authenticatedUser(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) throw new ApiError("请先登录", 401, "AUTH_REQUIRED");
  const response = await timedFetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: authorization },
  });
  const user = await parseJson(response);
  if (!response.ok || !user?.id) throw new ApiError("登录已过期，请重新登录", 401, "AUTH_REQUIRED");
  return user as Record<string, unknown>;
}

async function serviceRest(path: string, init: RequestInit = {}) {
  const response = await timedFetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...serviceApiHeaders(SERVICE_API_KEY),
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const payload = await parseJson(response);
  if (!response.ok) throw new ApiError(payload?.message || "Task conversation store unavailable", 503, "TASK_CONVERSATION_STORE_ERROR");
  return payload;
}

async function rpc(name: string, body: Record<string, unknown>) {
  return serviceRest(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
}

async function googleTasksRequest(request: Request, method: string, body: Record<string, unknown>, idempotencyKey = "") {
  const response = await timedFetch(`${SUPABASE_URL}/functions/v1/google-tasks`, {
    method,
    headers: {
      apikey: SUPABASE_PUBLIC_KEY,
      Authorization: request.headers.get("authorization") || "",
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await parseJson(response);
  if (!response.ok || payload?.success !== true) {
    const error = new ApiError(payload?.error || "Task execution failed", response.status || 503, payload?.code || "TASK_EXECUTION_FAILED", payload);
    throw error;
  }
  return payload;
}

function activePendingQuery(ownerId: string, taskId: string) {
  return new URLSearchParams({
    select: "*",
    owner_id: `eq.${ownerId}`,
    task_id: `eq.${taskId}`,
    status: "in.(awaiting_confirmation,committing,failed)",
    order: "created_at.desc",
    limit: "1",
  });
}

async function pendingFor(ownerId: string, taskId: string) {
  return (await serviceRest(`task_conversation_pending_changes?${activePendingQuery(ownerId, taskId)}`))?.[0] || null;
}

async function historyFor(ownerId: string, taskId: string, options: Record<string, any> = {}) {
  const limit = Math.max(1, Math.min(200, Number(options.limit || 200)));
  const query = new URLSearchParams({
    select: "id,task_id,event_type,source,raw_input,transcript,parsed_intent,confidence,before_state,proposed_state,confirmation,after_state,executor_result,proposal_id,request_id,message,created_at",
    owner_id: `eq.${ownerId}`,
    task_id: `eq.${taskId}`,
    order: "created_at.desc,id.desc",
    limit: String(limit),
  });
  if (options.before) query.set("created_at", `lt.${options.before}`);
  const rows = await serviceRest(`task_conversation_events?${query}`);
  return (rows || []).reverse();
}

async function recentContextFor(ownerId: string, taskId: string, limit = 20) {
  const activityQuery = new URLSearchParams({
    select: "id,task_id,action,source,request_id,old_value,new_value,status,response,error,created_at",
    owner_id: `eq.${ownerId}`,
    task_id: `eq.${taskId}`,
    order: "created_at.desc,id.desc",
    limit: String(limit),
  });
  const [conversation, activities] = await Promise.all([
    historyFor(ownerId, taskId, { limit }),
    serviceRest(`task_activity_log?${activityQuery}`),
  ]);
  return [...conversation, ...(activities || []).map((row: Record<string, any>) => ({
    id: row.id,
    task_id: row.task_id,
    event_type: `lifecycle_${row.action}_${row.status}`,
    source: row.source || "system",
    raw_input: row.response?.raw_text || "",
    transcript: null,
    parsed_intent: { intent: row.action, action: row.action, message: row.response?.message || row.error || "" },
    before_state: row.old_value || null,
    after_state: row.new_value || row.response?.task || null,
    executor_result: row.response || (row.error ? { error: row.error } : null),
    request_id: row.request_id,
    message: row.response?.message || row.error || "",
    created_at: row.created_at,
  }))]
    .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")))
    .slice(-limit);
}

function messageForExecution(operation: string, payload: Record<string, any>) {
  if (payload.projection_error) {
    return "任务接口已处理，但日程、提醒或 Calendar 同步尚未完成；当前任务详情显示回读状态，请勿视为全部修改成功。";
  }
  if (operation === "create") return payload.deduplicated ? "已关联现有任务，未创建重复任务。" : "已创建并关联下一步任务。";
  if (operation === "complete") return "任务已完成。";
  if (operation === "cancel") return "任务已取消，历史已保留。";
  return "已经修改。";
}

function createAdapters(request: Request, ownerId: string) {
  return {
    async reserveRequest(input: Record<string, unknown>) {
      return rpc("begin_task_conversation_request", {
        target_owner: ownerId,
        target_task_id: input.task_id,
        target_request_id: input.request_id,
        target_request_hash: input.request_hash,
      });
    },
    async finishRequest(input: Record<string, unknown>) {
      await rpc("finish_task_conversation_request", {
        target_owner: ownerId,
        target_request_id: input.request_id,
        target_status: input.status,
        target_response_status: input.response_status,
        target_response: input.response,
        target_error: input.error || null,
      });
    },
    async getTask(taskId: string) {
      const query = new URLSearchParams({ action: "get", task_id: taskId });
      const response = await timedFetch(`${SUPABASE_URL}/functions/v1/google-tasks?${query}`, {
        headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: request.headers.get("authorization") || "" },
      });
      const payload = await parseJson(response);
      if (!response.ok || !payload?.task) throw new ApiError(payload?.error || "Task not found", response.status || 503, payload?.code || "TASK_NOT_FOUND");
      return payload.task;
    },
    getPending(taskId: string) {
      return pendingFor(ownerId, taskId);
    },
    savePending(input: Record<string, unknown>) {
      return rpc("replace_task_conversation_pending", {
        target_owner: ownerId,
        target_proposal_id: input.id,
        target_task_id: input.task_id,
        target_task_version: input.task_version,
        target_task_snapshot: input.task_snapshot,
        target_intent: input.intent,
        target_confidence: input.confidence,
        target_proposed_changes: input.proposed_changes,
        target_changes: input.changes,
        target_raw_input: input.raw_input,
        target_request_id: input.request_id,
        target_message: input.message,
      });
    },
    claimPending(input: Record<string, unknown>) {
      return rpc("claim_task_conversation_pending", {
        target_owner: ownerId,
        target_proposal_id: input.proposal_id,
        target_task_id: input.task_id,
        target_task_version: input.task_version,
      });
    },
    finalizePending(input: Record<string, unknown>) {
      return rpc("finalize_task_conversation_pending", {
        target_owner: ownerId,
        target_proposal_id: input.proposal_id,
        target_status: input.status,
        target_executor_result: input.executor_result || null,
      });
    },
    async appendEvent(input: Record<string, unknown>) {
      const rows = await serviceRest("task_conversation_events?select=*", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ owner_id: ownerId, ...input }),
      });
      if (!rows?.[0]) throw new ApiError("Conversation audit write returned no row", 503, "AUDIT_WRITE_FAILED");
      return rows[0];
    },
    getHistory(taskId: string, options: Record<string, any> = {}) {
      return options.recent ? recentContextFor(ownerId, taskId, Number(options.limit || 20)) : historyFor(ownerId, taskId, options);
    },
    async execute(input: Record<string, any>) {
      const common = {
        task_id: input.task_id,
        raw_text: input.raw_input,
        request_id: input.request_id,
        source: "task_conversation",
        idempotency_key: input.idempotency_key,
        expected_task_version: input.expected_task_version,
      };
      let payload;
      if (input.operation === "create") {
        payload = await googleTasksRequest(request, "POST", {
          action: "create",
          source: "task_conversation",
          idempotency_key: input.idempotency_key,
          task: taskConversationCreatePayload(input.changes, input.idempotency_key),
        }, input.idempotency_key);
      } else if (input.operation === "complete" || input.operation === "cancel") {
        payload = await googleTasksRequest(request, "PATCH", { ...common, action: input.operation }, input.idempotency_key);
      } else {
        payload = await googleTasksRequest(request, "PATCH", { ...common, action: "update", changes: input.changes }, input.idempotency_key);
      }
      return {
        ...payload,
        task: payload.task || null,
        created_task: input.operation === "create" ? payload.task || null : null,
        message: messageForExecution(input.operation, payload),
      };
    },
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SERVICE_API_KEY || !SUPABASE_PUBLIC_KEY) {
    return json({ success: false, error: "Task conversation server configuration incomplete", code: "SERVER_CONFIGURATION_ERROR" }, 503);
  }
  try {
    const user = await authenticatedUser(request);
    const ownerId = String(user.id);
    if (request.method === "GET") {
      const taskId = String(new URL(request.url).searchParams.get("task_id") || "").trim();
      if (!taskId) throw new ApiError("task_id is required", 400, "INVALID_TASK_ID");
      const adapters = createAdapters(request, ownerId);
      const url = new URL(request.url);
      const historyLimit = Math.max(1, Math.min(200, Number(url.searchParams.get("history_limit") || 200)));
      const historyBefore = String(url.searchParams.get("history_before") || "");
      const [task, pending, history] = await Promise.all([
        adapters.getTask(taskId),
        adapters.getPending(taskId),
        adapters.getHistory(taskId, { limit: historyLimit, before: historyBefore }),
      ]);
      return json({
        success: true,
        task,
        pending: pending ? {
          id: pending.id,
          proposal_id: pending.id,
          task_id: pending.task_id,
          status: pending.status,
          created_at: pending.created_at,
          updated_at: pending.updated_at,
          proposal: {
            intent: pending.intent,
            confidence: pending.confidence,
            ambiguity: false,
            requires_confirmation: true,
            clarification_question: null,
            proposed_changes: pending.proposed_changes,
            changes: pending.changes,
            message: pending.message,
          },
        } : null,
        history,
        history_has_more: history.length === historyLimit,
        history_cursor: history[0]?.created_at || null,
        parser_mode: "deterministic_fallback",
        llm_available: false,
      });
    }
    if (request.method !== "POST") throw new ApiError("Method not allowed", 405, "METHOD_NOT_ALLOWED");
    let input: Record<string, unknown>;
    try { input = await request.json(); } catch { throw new ApiError("Request body must be JSON", 400, "INVALID_JSON"); }
    const result = await runTaskConversation(input, createAdapters(request, ownerId));
    return json({
      ...result.response,
      parser_mode: "deterministic_fallback",
      llm_available: false,
    }, result.status);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const status = error instanceof TaskConversationError ? error.status : (timedOut ? 504 : 503);
    const code = error instanceof TaskConversationError ? error.code : (timedOut ? "API_TIMEOUT" : "TASK_CONVERSATION_UNAVAILABLE");
    const message = error instanceof Error ? error.message : "Task conversation unavailable";
    console.error("Task conversation failed", { code, message });
    return json({ success: false, error: message, code, parser_mode: "deterministic_fallback", llm_available: false }, status);
  }
});
