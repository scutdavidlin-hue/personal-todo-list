import { parseConversationInput } from "./task-conversation-core.js";
import { taskStateFingerprint } from "./task-lifecycle-core.js";

export class TaskConversationError extends Error {
  constructor(message, status = 500, code = "TASK_CONVERSATION_ERROR", details = null) {
    super(message);
    this.name = "TaskConversationError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function cleanText(value, name, maxLength) {
  const result = String(value || "").trim();
  if (!result || result.length > maxLength) {
    throw new TaskConversationError(`${name} must contain 1-${maxLength} characters`, 400, `INVALID_${name.toUpperCase()}`);
  }
  return result;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export async function conversationRequestHash(input) {
  const value = JSON.stringify(stable({
    task_id: input.task_id,
    text: input.text,
    source: input.source,
    proposal_id: input.proposal_id || null,
  }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function taskConversationVersion(task) {
  return taskStateFingerprint(task);
}

function publicPending(row) {
  if (!row) return null;
  return {
    id: row.id,
    proposal_id: row.id,
    task_id: row.task_id,
    status: row.status,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    proposal: {
      intent: row.intent,
      confidence: row.confidence,
      ambiguity: false,
      requires_confirmation: true,
      clarification_question: null,
      proposed_changes: row.proposed_changes || {},
      changes: row.changes || {},
      message: row.message || "",
    },
  };
}

function eventFor({ input, parsed, task, pending = null, eventType, afterState = null, executorResult = null, confirmation = null }) {
  return {
    task_id: input.task_id,
    event_type: eventType,
    source: input.source,
    raw_input: input.text,
    transcript: input.source === "voice" ? input.text : null,
    parsed_intent: parsed,
    confidence: Number.isFinite(parsed?.confidence) ? parsed.confidence : null,
    before_state: task || null,
    proposed_state: parsed?.proposed_changes || pending?.proposed_changes || null,
    confirmation,
    after_state: afterState,
    executor_result: executorResult,
    proposal_id: pending?.id || input.proposal_id || null,
    request_id: input.request_id,
    message: executorResult?.message || parsed?.message || "",
  };
}

async function responseWithHistory(adapters, response) {
  const history = await adapters.getHistory(response.task_id);
  return { ...response, history };
}

function ensureAdapter(adapters, name) {
  if (typeof adapters?.[name] !== "function") {
    throw new TaskConversationError(`Task conversation adapter ${name} is required`, 500, "INVALID_RUNTIME_ADAPTER");
  }
}

function executionKey(value) {
  return `conversation:${String(value).replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 180)}`;
}

async function executeChange(adapters, input, task, parsed, pending = null) {
  const persistedChanges = pending?.changes || parsed.changes || {};
  let operation = String(persistedChanges.operation || "");
  const intendedIntent = pending?.intent || parsed.intent;
  if (!operation) {
    if (intendedIntent === "complete_task") operation = "complete";
    else if (intendedIntent === "cancel_task") operation = "cancel";
    else operation = "update";
  }
  const changes = { ...persistedChanges };
  delete changes.operation;
  if (Object.hasOwn(changes, "notes_append")) {
    const addition = String(changes.notes_append || "").trim();
    delete changes.notes_append;
    changes.notes = [String((pending?.task_snapshot || task)?.notes || "").trim(), addition].filter(Boolean).join("\n\n");
  }
  if (operation === "create") {
    changes.raw_text = pending?.raw_input || input.text;
    changes.originalIntent = pending?.raw_input || input.text;
    changes.source = "task_conversation";
  }
  return adapters.execute({
    operation,
    task_id: input.task_id,
    changes,
    raw_input: input.text,
    source: input.source,
    request_id: input.request_id,
    idempotency_key: executionKey(pending?.id || input.request_id),
    expected_task_version: pending?.task_version || taskConversationVersion(task),
  });
}

async function processConversation(input, adapters, options) {
  const task = await adapters.getTask(input.task_id);
  if (!task) throw new TaskConversationError("Task not found", 404, "TASK_NOT_FOUND");
  const pending = await adapters.getPending(input.task_id);
  const recentConversation = await adapters.getHistory(input.task_id, { limit: 20, recent: true });
  const parsed = await options.parseInput({
    text: input.text,
    task: { ...task, recent_conversation: recentConversation },
    pending: pending ? publicPending(pending).proposal : null,
    now: options.now(),
  });
  if (!parsed || typeof parsed !== "object" || !parsed.action) {
    throw new TaskConversationError("Intent parser returned an invalid result", 503, "INTENT_PARSE_FAILED");
  }
  if (pending?.status === "committing" && parsed.action !== "confirm") {
    throw new TaskConversationError("A Task change is already being committed", 409, "TASK_CHANGE_IN_PROGRESS");
  }

  if (parsed.action === "propose") {
    const proposal = await adapters.savePending({
      id: options.makeProposalId(),
      task_id: input.task_id,
      task_version: taskConversationVersion(task),
      task_snapshot: task,
      intent: parsed.intent,
      confidence: parsed.confidence,
      proposed_changes: parsed.proposed_changes || {},
      changes: parsed.changes || {},
      raw_input: input.text,
      request_id: input.request_id,
      message: parsed.message || "",
    });
    await adapters.appendEvent(eventFor({ input, parsed, task, pending: proposal, eventType: "proposal_created" }));
    return responseWithHistory(adapters, {
      success: true,
      task_id: input.task_id,
      message: parsed.message,
      pending: publicPending(proposal),
      task,
      intent: parsed.intent,
      ambiguity: false,
      requires_confirmation: true,
    });
  }

  if (parsed.action === "clarify") {
    if (pending) await adapters.finalizePending({ proposal_id: pending.id, status: "superseded", executor_result: { reason: "clarification_replaces_preview" } });
    await adapters.appendEvent(eventFor({ input, parsed, task, pending, eventType: "clarification_requested" }));
    return responseWithHistory(adapters, {
      success: true,
      task_id: input.task_id,
      message: parsed.clarification_question || parsed.message,
      pending: null,
      task,
      intent: parsed.intent,
      ambiguity: true,
      requires_confirmation: false,
      clarification_question: parsed.clarification_question || parsed.message,
    });
  }

  if (parsed.action === "discard") {
    if (!pending) throw new TaskConversationError("There is no pending change to discard", 409, "NO_PENDING_CHANGE");
    if (input.proposal_id && input.proposal_id !== pending.id) {
      throw new TaskConversationError("This proposal is no longer current", 409, "STALE_PROPOSAL");
    }
    await adapters.finalizePending({ proposal_id: pending.id, status: "discarded", executor_result: { message: parsed.message } });
    await adapters.appendEvent(eventFor({ input, parsed, task, pending, eventType: "proposal_discarded", confirmation: false }));
    return responseWithHistory(adapters, {
      success: true,
      task_id: input.task_id,
      message: parsed.message,
      pending: null,
      task,
      intent: parsed.intent,
      ambiguity: false,
      requires_confirmation: false,
    });
  }

  if (parsed.action === "confirm") {
    if (!pending) throw new TaskConversationError("There is no pending change to confirm", 409, "NO_PENDING_CHANGE");
    if (!input.proposal_id || input.proposal_id !== pending.id) {
      throw new TaskConversationError("Confirm the latest proposal from this Task view", 409, "PROPOSAL_TOKEN_REQUIRED");
    }
    if (pending.status !== "failed" && pending.task_version !== taskConversationVersion(task)) {
      await adapters.finalizePending({ proposal_id: pending.id, status: "superseded", executor_result: { reason: "task_changed" } });
      throw new TaskConversationError("The Task changed after this proposal. Please review a new preview.", 409, "TASK_CHANGED_SINCE_PROPOSAL");
    }
    const claimed = await adapters.claimPending({
      proposal_id: pending.id,
      task_id: input.task_id,
      task_version: pending.task_version,
    });
    if (claimed.state === "applied") {
      const replayResult = claimed.pending.executor_result || {};
      return responseWithHistory(adapters, {
        success: true,
        task_id: input.task_id,
        message: replayResult.message || "已经执行过这项修改。",
        pending: null,
        task: replayResult.task || task,
        projection_error: replayResult.projection_error || null,
        replayed: true,
      });
    }
    if (claimed.state !== "claimed") {
      throw new TaskConversationError("This proposal is already being processed", 409, "PROPOSAL_IN_PROGRESS");
    }
    try {
      const result = await executeChange(adapters, input, task, parsed, claimed.pending);
      const createsLinkedTask = claimed.pending?.changes?.operation === "create";
      const createdTask = createsLinkedTask ? (result.created_task || result.task || null) : null;
      const nextTask = createsLinkedTask ? task : (result.task || task);
      await adapters.appendEvent(eventFor({
        input,
        parsed: { ...parsed, intent: claimed.pending.intent, proposed_changes: claimed.pending.proposed_changes },
        task,
        pending: claimed.pending,
        eventType: "execution_succeeded",
        afterState: nextTask,
        executorResult: result,
        confirmation: true,
      }));
      await adapters.finalizePending({ proposal_id: pending.id, status: "applied", executor_result: result });
      return responseWithHistory(adapters, {
        success: true,
        task_id: input.task_id,
        message: result.message || parsed.message || "已经修改。",
        pending: null,
        task: nextTask,
        created_task: createdTask,
        projection_error: result.projection_error || null,
        intent: claimed.pending.intent,
        ambiguity: false,
        requires_confirmation: false,
      });
    } catch (error) {
      await adapters.finalizePending({
        proposal_id: pending.id,
        status: "failed",
        executor_result: { code: error?.code || "EXECUTION_FAILED", error: error instanceof Error ? error.message : "Execution failed" },
      });
      try {
        await adapters.appendEvent(eventFor({
          input,
          parsed,
          task,
          pending,
          eventType: "execution_failed",
          executorResult: { code: error?.code || "EXECUTION_FAILED", error: error instanceof Error ? error.message : "Execution failed" },
          confirmation: true,
        }));
      } catch {
        // Preserve the provider error. A retry uses the same provider idempotency key.
      }
      throw error;
    }
  }

  if (parsed.action === "append_context") {
    let immediate = pending?.status === "failed" && pending.request_id === input.request_id && pending.intent === parsed.intent
      ? pending
      : null;
    if (!immediate) {
      immediate = await adapters.savePending({
        id: options.makeProposalId(),
        task_id: input.task_id,
        task_version: taskConversationVersion(task),
        task_snapshot: task,
        intent: parsed.intent,
        confidence: parsed.confidence,
        proposed_changes: parsed.proposed_changes || {},
        changes: parsed.changes || {},
        raw_input: input.text,
        request_id: input.request_id,
        message: parsed.message || "",
      });
    }
    const claimed = await adapters.claimPending({ proposal_id: immediate.id, task_id: input.task_id, task_version: immediate.task_version });
    if (claimed.state !== "claimed") throw new TaskConversationError("A Task change is already being processed", 409, "TASK_CHANGE_IN_PROGRESS");
    try {
      const result = await executeChange(adapters, input, task, parsed, claimed.pending);
      const nextTask = result.task || task;
      await adapters.appendEvent(eventFor({ input, parsed, task, pending: claimed.pending, eventType: "context_appended", afterState: nextTask, executorResult: result }));
      await adapters.finalizePending({ proposal_id: immediate.id, status: "applied", executor_result: result });
      return responseWithHistory(adapters, {
        success: true,
        task_id: input.task_id,
        message: result.message || parsed.message,
        pending: null,
        task: nextTask,
        projection_error: result.projection_error || null,
        intent: parsed.intent,
        ambiguity: false,
        requires_confirmation: false,
      });
    } catch (error) {
      await adapters.finalizePending({
        proposal_id: immediate.id,
        status: "failed",
        executor_result: { code: error?.code || "EXECUTION_FAILED", error: error instanceof Error ? error.message : "Execution failed" },
      });
      throw error;
    }
  }

  await adapters.appendEvent(eventFor({ input, parsed, task, pending, eventType: "no_change" }));
  return responseWithHistory(adapters, {
    success: true,
    task_id: input.task_id,
    message: parsed.message,
    pending: publicPending(pending),
    task,
    intent: parsed.intent,
    ambiguity: Boolean(parsed.ambiguity),
    requires_confirmation: false,
  });
}

export async function runTaskConversation(rawInput, adapters, options = {}) {
  for (const name of [
    "reserveRequest", "finishRequest", "getTask", "getPending", "savePending",
    "claimPending", "finalizePending", "appendEvent", "getHistory", "execute",
  ]) ensureAdapter(adapters, name);
  const input = {
    task_id: cleanText(rawInput?.task_id, "task_id", 1024),
    text: cleanText(rawInput?.text, "text", 10_000),
    source: rawInput?.source === "voice" ? "voice" : rawInput?.source === "text" ? "text" : "",
    request_id: cleanText(rawInput?.request_id, "request_id", 160),
    proposal_id: rawInput?.proposal_id ? cleanText(rawInput.proposal_id, "proposal_id", 128) : null,
  };
  if (!input.source) throw new TaskConversationError("source must be text or voice", 400, "INVALID_SOURCE");
  const runtimeOptions = {
    parseInput: options.parseInput || parseConversationInput,
    now: options.now || (() => new Date()),
    makeProposalId: options.makeProposalId || (() => crypto.randomUUID()),
  };
  const requestHash = await conversationRequestHash(input);
  const reservation = await adapters.reserveRequest({ ...input, request_hash: requestHash });
  if (reservation.state === "conflict") {
    throw new TaskConversationError("request_id was already used for different input", 409, "REQUEST_ID_CONFLICT");
  }
  if (reservation.state === "processing") {
    throw new TaskConversationError("This conversation request is still processing", 409, "REQUEST_IN_PROGRESS");
  }
  if (reservation.state === "replay") {
    return { response: { ...(reservation.response || {}), replayed: true }, status: reservation.response_status || 200 };
  }
  try {
    const response = await processConversation(input, adapters, runtimeOptions);
    await adapters.finishRequest({ request_id: input.request_id, status: "succeeded", response_status: 200, response });
    return { response, status: 200 };
  } catch (error) {
    const failure = {
      success: false,
      error: error instanceof Error ? error.message : "Task conversation failed",
      code: error?.code || "TASK_CONVERSATION_ERROR",
    };
    try {
      await adapters.finishRequest({
        request_id: input.request_id,
        status: "failed",
        response_status: Number(error?.status || 503),
        response: failure,
        error: failure.error,
      });
    } catch {
      // The original failure remains the most useful error for the caller.
    }
    throw error;
  }
}
