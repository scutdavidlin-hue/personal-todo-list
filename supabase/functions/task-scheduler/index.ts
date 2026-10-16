import { verifyCalendarProjection } from "../_shared/write-receipt.js";
import {
  GoogleProviderError,
  coordinatedGoogleAccess,
  googleJsonRequest,
  providerErrorDiagnostic,
} from "../_shared/google-auth-runtime.js";
import {
  applyTaskSchedulePatch,
  buildCalendarEvent,
  calendarProjectionWindow,
  normalizeScheduleInput,
  planTaskSlots,
  stableCalendarEventId,
  taskScheduleSyncDecision,
} from "../_shared/schedule-core.js";
import { mergeReminderPolicyUpdate, reminderProjectionFields } from "../_shared/reminder-policy-core.js";
import { createGoogleTaskPayload, toTaskModel } from "../_shared/google-tasks-core.js";
import {
  localDateInZone,
  localDateTimeInZone,
  nextOccurrenceDate,
  nextRuleDate,
  normalizeRecurrence,
  occurrenceWriteDecision,
  openOccurrenceReady,
  recurrenceKeyFromNotes,
  recurrenceLeadMinutes,
  recurrenceRuleFromSeries,
  recurrenceSchedule,
} from "../_shared/task-recurrence-core.js";
import {
  calendarEventView,
  calendarSearchParameters,
  normalizeCalendarSearchInput,
} from "../_shared/calendar-events-core.js";
import { CalendarEventRuntimeError, updateCalendarEventInPlace } from "../_shared/calendar-events-runtime.js";
import { shanghaiDate, shiftDate } from "../task-status/status-core.js";
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
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";
const WRITE_TOKEN = Deno.env.get("AUTOMATION_WRITE_TOKEN") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
const TOKEN_ENCRYPTION_KEY = Deno.env.get("GOOGLE_TOKEN_ENCRYPTION_KEY") ?? "";
const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-automation-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  providerLayer: string;
  providerStatus: number | null;
  providerCode: string;
  constructor(message: string, status = 503, code = "SCHEDULER_UNAVAILABLE", diagnostic: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = diagnostic.retryable === true;
    this.providerLayer = String(diagnostic.provider_layer || "");
    this.providerStatus = Number.isInteger(diagnostic.provider_status) ? Number(diagnostic.provider_status) : null;
    this.providerCode = String(diagnostic.provider_code || "");
  }
}

function providerApiError(error: unknown, overrides: Record<string, unknown> = {}) {
  const diagnostic = providerErrorDiagnostic(error);
  if (!diagnostic) return null;
  return new ApiError(
    String(overrides.message || diagnostic.error),
    Number(overrides.status || diagnostic.status),
    String(overrides.code || diagnostic.code),
    diagnostic,
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return mismatch === 0;
}

async function responsePayload(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function timedFetch(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(15_000) });
}

async function ownerForRequest(request: Request) {
  const apiKey = request.headers.get("apikey") || "";
  if (SERVICE_API_KEY.length >= 32 && constantTimeEqual(apiKey, SERVICE_API_KEY)) return OWNER_USER_ID;
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "") || request.headers.get("x-automation-token") || "";
  if (WRITE_TOKEN.length >= 32 && constantTimeEqual(token, WRITE_TOKEN)) return OWNER_USER_ID;
  if (!authorization.toLowerCase().startsWith("bearer ")) throw new ApiError("请先登录", 401, "AUTH_REQUIRED");
  const response = await timedFetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: authorization },
  });
  const user = await responsePayload(response);
  if (!response.ok || !user?.id) throw new ApiError("登录已过期，请重新登录", 401, "AUTH_REQUIRED");
  if (OWNER_USER_ID && user.id !== OWNER_USER_ID) throw new ApiError("Forbidden", 403, "FORBIDDEN");
  return user.id as string;
}

async function rest(path: string, init: RequestInit = {}) {
  const response = await timedFetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...serviceApiHeaders(SERVICE_API_KEY),
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await responsePayload(response);
  if (!response.ok) throw new ApiError(body?.message || "Schedule store unavailable", 503, "SCHEDULE_STORE_ERROR");
  return body;
}

async function rpc(name: string, body: Record<string, unknown>) {
  return rest(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
}

async function googleContext(ownerId: string) {
  const result = await coordinatedGoogleAccess({
    ownerId,
    encryptionKey: TOKEN_ENCRYPTION_KEY,
    rpc,
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
  });
  return { accessToken: result.accessToken, taskListId: result.taskListId as string };
}

async function googleRequest(accessToken: string, base: string, path: string, init: RequestInit = {}) {
  const providerLayer = base === CALENDAR_BASE ? "calendar" : "tasks";
  try {
    return await googleJsonRequest({
      accessToken,
      url: `${base}${path}`,
      init,
      providerLayer,
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof GoogleProviderError && error.code === "GOOGLE_OBJECT_CHANGED" && providerLayer === "calendar") {
      throw providerApiError(error, { message: "Calendar event changed after it was read; search again before updating", code: "CALENDAR_EVENT_CHANGED" });
    }
    if (error instanceof GoogleProviderError && error.code === "GOOGLE_RATE_LIMITED") {
      throw providerApiError(error, { message: "Google rate limit reached", code: "RATE_LIMITED" });
    }
    throw providerApiError(error) || error;
  }
}

function taskPath(taskListId: string, taskId = "") {
  return `/lists/${encodeURIComponent(taskListId)}/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
}

async function getTask(google: { accessToken: string; taskListId: string }, taskId: string) {
  const task = await googleRequest(google.accessToken, TASKS_BASE, taskPath(google.taskListId, taskId));
  return toTaskModel(task, google.taskListId);
}

async function listTasks(google: { accessToken: string; taskListId: string }) {
  const tasks = [];
  let pageToken = "";
  const seenTokens = new Set<string>();
  let pageCount = 0;
  do {
    if (pageCount >= 100 || (pageToken && seenTokens.has(pageToken))) {
      throw new ApiError("Google Tasks listing was incomplete; recurrence write must wait", 503, "TASK_LIST_INCOMPLETE");
    }
    if (pageToken) seenTokens.add(pageToken);
    pageCount += 1;
    const params = new URLSearchParams({ maxResults: "100", showCompleted: "true", showHidden: "true", showDeleted: "false" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await googleRequest(google.accessToken, TASKS_BASE, `${taskPath(google.taskListId)}?${params}`);
    tasks.push(...(page?.items || []).filter((task: Record<string, unknown>) => !task.deleted).map((task: Record<string, unknown>) => toTaskModel(task, google.taskListId)));
    pageToken = page?.nextPageToken || "";
  } while (pageToken);
  return tasks;
}

async function schedules(ownerId: string, taskId = "", includeDeleted = false) {
  const query = new URLSearchParams({ select: "*", owner_id: `eq.${ownerId}`, order: "scheduled_date.asc,scheduled_start.asc" });
  if (taskId) query.set("google_task_id", `eq.${taskId}`);
  if (!includeDeleted) query.set("deleted_at", "is.null");
  return rest(`task_schedule_metadata?${query}`);
}

async function seriesRows(ownerId: string, filters: Record<string, string> = {}) {
  const query = new URLSearchParams({ select: "*", owner_id: `eq.${ownerId}`, ...filters });
  return rest(`task_schedule_series?${query}`);
}

async function seriesForTask(ownerId: string, taskId: string) {
  const current = (await seriesRows(ownerId, { current_task_id: `eq.${taskId}`, limit: "1" }))?.[0];
  if (current) return current;
  const occurrence = await rest(`task_schedule_occurrence?${new URLSearchParams({ select: "series_id", owner_id: `eq.${ownerId}`, google_task_id: `eq.${taskId}`, limit: "1" })}`);
  return occurrence?.[0] ? (await seriesRows(ownerId, { id: `eq.${occurrence[0].series_id}`, limit: "1" }))?.[0] || null : null;
}

async function createSeries(ownerId: string, taskId: string, input: Record<string, unknown>) {
  if (!taskId) throw new ApiError("task_id is required", 400, "INVALID_TASK");
  const google = await googleContext(ownerId);
  const [task, scheduleRows] = await Promise.all([getTask(google, taskId), schedules(ownerId, taskId)]);
  const schedule = scheduleRows?.[0];
  let recurrence;
  try { recurrence = normalizeRecurrence(input, schedule); }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : "Unsupported recurrence", 400, "RECURRENCE_UNSUPPORTED"); }
  const existing = (await seriesRows(ownerId, { anchor_task_id: `eq.${taskId}`, limit: "1" }))?.[0];
  if (existing) {
    if (existing.status === "cancelled") throw new ApiError("Stopped recurrence series cannot be restarted by replay", 409, "SERIES_CANCELLED");
    if (existing.rrule !== recurrence.rrule || existing.current_date < recurrence.anchor_date || existing.timezone !== recurrence.timezone) {
      throw new ApiError("The task already belongs to a different recurrence series", 409, "SERIES_CONFLICT");
    }
    return { series: existing, occurrence: { date: recurrence.anchor_date, task_id: taskId }, replayed: true };
  }
  if (!schedule || task.status !== "open" || task.dueDate !== schedule.scheduled_date || schedule.sync_required !== false) {
    throw new ApiError("First occurrence must be an open, verified Task with matching Schedule", 409, "SERIES_FIRST_OCCURRENCE_UNVERIFIED");
  }
  if (calendarProjectionWindow(schedule) && (!schedule.calendar_event_id || !schedule.last_synced_at || schedule.notification_status !== "projected")) {
    throw new ApiError("The first timed occurrence must have a verified Calendar projection", 409, "SERIES_FIRST_OCCURRENCE_UNVERIFIED");
  }
  if (schedule.deadline || schedule.deadline_time) {
    throw new ApiError("Recurring reminders with a separate deadline are not supported", 400, "RECURRENCE_UNSUPPORTED");
  }
  try { if (calendarProjectionWindow(schedule)) recurrenceLeadMinutes(schedule); }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : "Unsupported reminder lead", 400, "RECURRENCE_UNSUPPORTED"); }
  const linkedSeries = await seriesForTask(ownerId, taskId);
  if (linkedSeries && linkedSeries.anchor_task_id !== taskId) {
    throw new ApiError("Task is already an occurrence of another series", 409, "SERIES_CONFLICT");
  }
  const rows = await rest("task_schedule_series?on_conflict=owner_id%2Canchor_task_id&select=*", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ owner_id: ownerId, anchor_task_id: taskId, current_task_id: taskId,
      current_date: recurrence.anchor_date, recurrence_kind: recurrence.kind,
      rrule: recurrence.rrule, recurrence_interval: recurrence.interval,
      by_weekday: recurrence.weekday, by_month_day: recurrence.month_day, by_month: recurrence.month,
      timezone: recurrence.timezone, local_time: recurrence.local_time }),
  });
  const series = rows?.[0] || (await seriesRows(ownerId, { anchor_task_id: `eq.${taskId}`, limit: "1" }))?.[0];
  if (!series || series.rrule !== recurrence.rrule || series.timezone !== recurrence.timezone || series.current_date !== recurrence.anchor_date) {
    throw new ApiError("Recurrence series could not be verified", 503, "SERIES_WRITE_UNVERIFIED");
  }
  await rest("task_schedule_occurrence?on_conflict=series_id%2Coccurrence_date&select=*", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ series_id: series.id, owner_id: ownerId, occurrence_date: recurrence.anchor_date, google_task_id: taskId }),
  });
  const occurrence = await rest(`task_schedule_occurrence?${new URLSearchParams({ select: "*", series_id: `eq.${series.id}`, occurrence_date: `eq.${recurrence.anchor_date}`, limit: "1" })}`);
  if (occurrence?.[0]?.google_task_id !== taskId) throw new ApiError("First occurrence mapping could not be verified", 503, "SERIES_WRITE_UNVERIFIED");
  return { series, occurrence: { date: recurrence.anchor_date, task_id: taskId }, replayed: false };
}

async function advanceSeries(ownerId: string, taskId: string) {
  if (!taskId) throw new ApiError("task_id is required", 400, "INVALID_TASK");
  const series = await seriesForTask(ownerId, taskId);
  if (!series) return { task_id: taskId, advanced: false, reason: "NOT_RECURRING" };
  if (series.status === "paused") return { task_id: taskId, series_id: series.id, advanced: false, reason: "SERIES_PAUSED" };
  if (series.status !== "active") return { task_id: taskId, series_id: series.id, advanced: false, reason: "SERIES_CANCELLED" };
  if (series.current_task_id !== taskId) return { task_id: taskId, series_id: series.id, advanced: false, reason: "ALREADY_ADVANCED", current_task_id: series.current_task_id };
  const google = await googleContext(ownerId);
  const currentTask = await getTask(google, taskId);
  const currentSchedule = (await schedules(ownerId, taskId))?.[0];
  if (!currentSchedule) throw new ApiError("Series Schedule is missing", 409, "SERIES_SCHEDULE_MISSING");
  const recurrence = recurrenceRuleFromSeries(series);
  const nowLocal = localDateTimeInZone(new Date(), String(series.timezone));
  if (currentTask.status === "open" && !openOccurrenceReady(String(series.current_date), recurrence, nowLocal, {
    local_time: series.local_time,
    reminder_offset_minutes: recurrenceLeadMinutes(currentSchedule),
  })) return { task_id: taskId, series_id: series.id, advanced: false, reason: "NEXT_PERIOD_NOT_READY" };
  if (!["open", "completed", "cancelled"].includes(String(currentTask.status))) {
    return { task_id: taskId, series_id: series.id, advanced: false, reason: "CURRENT_STATUS_UNSUPPORTED" };
  }
  let proposedDate = series.next_date_override
    ? String(series.next_date_override)
    : nextOccurrenceDate(String(series.current_date), recurrence, nowLocal, {
      local_time: series.local_time,
      reminder_offset_minutes: recurrenceLeadMinutes(currentSchedule),
    });
  while (proposedDate < nowLocal.slice(0, 10)) proposedDate = nextRuleDate(proposedDate, recurrence);
  if (series.skip_date && proposedDate === String(series.skip_date)) {
    proposedDate = nextOccurrenceDate(proposedDate, recurrence, nowLocal, {
      local_time: series.local_time,
      reminder_offset_minutes: recurrenceLeadMinutes(currentSchedule),
    });
  }
  const claimToken = crypto.randomUUID();
  const claim = await rpc("claim_task_schedule_series", { target_owner: ownerId, target_series: series.id,
    expected_task: taskId, proposed_date: proposedDate, claim_token: claimToken });
  if (!claim?.claimed) return { task_id: taskId, series_id: series.id, advanced: false, reason: "SERIES_BUSY_OR_CHANGED" };
  const nextDate = String(claim.pending_date);
  const markerKey = `${series.id}:${nextDate}`;
  const providerTasks = await listTasks(google);
  const matches = providerTasks.filter((task: Record<string, unknown>) =>
    (task.metadata as Record<string, unknown> | undefined)?.recurrence_key === markerKey || recurrenceKeyFromNotes(task.notes) === markerKey);
  const writeDecision = occurrenceWriteDecision(claim, matches);
  if (writeDecision === "duplicate_review") throw new ApiError("Multiple Tasks have the same recurrence marker", 409, "SERIES_DUPLICATE_REVIEW_REQUIRED");
  let nextTask = matches[0] || null;
  if (writeDecision === "outcome_unknown") return { task_id: taskId, series_id: series.id, advanced: false, reason: "TASK_WRITE_OUTCOME_UNKNOWN", occurrence_date: nextDate };
  if (writeDecision === "create_once") {
    const started = await rpc("mark_task_schedule_creation_started", { target_owner: ownerId, target_series: series.id, claim_token: claimToken });
    if (started !== true) return { task_id: taskId, series_id: series.id, advanced: false, reason: "SERIES_BUSY_OR_CHANGED" };
    const payload = createGoogleTaskPayload({ title: currentTask.title, notes: currentTask.notes,
      originalIntent: currentTask.originalIntent, dueDate: nextDate, metadata: { recurrence_key: markerKey } });
    try {
      const created = await googleRequest(google.accessToken, TASKS_BASE, taskPath(google.taskListId), { method: "POST", body: JSON.stringify(payload) });
      nextTask = await getTask(google, String(created.id));
    } catch (error) {
      return { task_id: taskId, series_id: series.id, advanced: false, reason: "TASK_WRITE_OUTCOME_UNKNOWN", occurrence_date: nextDate,
        error_code: error instanceof ApiError ? error.code : "TASK_WRITE_UNVERIFIED" };
    }
  }
  if (nextTask.dueDate !== nextDate) throw new ApiError("Next Task readback does not match the occurrence", 503, "SERIES_TASK_READBACK_MISMATCH");
  const nextScheduleResult = await insertScheduleIfAbsent(ownerId, String(nextTask.id), recurrenceSchedule({
    ...currentSchedule,
    scheduled_start: series.local_time ? String(series.local_time).slice(0, 5) : null,
    scheduled_end: null,
    timezone: series.timezone,
  }, nextDate), true);
  const nextSchedule = nextScheduleResult.schedule;
  if (nextSchedule.scheduled_date !== nextDate || (series.local_time && String(nextSchedule.scheduled_start || "").slice(0, 5) !== String(series.local_time).slice(0, 5))
    || nextSchedule.timezone !== series.timezone || nextSchedule.scheduling_status === "cancelled") {
    throw new ApiError("The next occurrence Schedule changed and needs review", 409, "SERIES_NEXT_SCHEDULE_CHANGED");
  }
  const finished = await rpc("finish_task_schedule_occurrence", { target_owner: ownerId, target_series: series.id,
    claim_token: claimToken, next_task: nextTask.id });
  if (!finished?.finished) return { task_id: taskId, series_id: series.id, advanced: false, reason: "SERIES_CHANGED_DURING_ADVANCE", occurrence_date: nextDate, next_task_id: nextTask.id };
  const projection = await projectTask(ownerId, google, nextTask, nextSchedule);
  return { task_id: taskId, series_id: series.id, advanced: true, occurrence_date: nextDate, next_task_id: nextTask.id,
    schedule: scheduleAfterProjection(nextSchedule, projection), projection };
}

async function updateSeries(ownerId: string, input: Record<string, unknown>) {
  const seriesId = String(input.series_id || "");
  const series = (await seriesRows(ownerId, { id: `eq.${seriesId}`, limit: "1" }))?.[0];
  if (!series) throw new ApiError("Recurrence series was not found", 404, "SERIES_NOT_FOUND");
  if (series.status === "cancelled") throw new ApiError("Stopped recurrence series cannot be changed", 409, "SERIES_CANCELLED");
  const schedule = (await schedules(ownerId, String(series.current_task_id)))?.[0];
  if (!schedule) throw new ApiError("Series Schedule is missing", 409, "SERIES_SCHEDULE_MISSING");
  const effectiveDate = String(input.effective_date || series.current_date);
  let recurrence;
  try {
    recurrence = normalizeRecurrence(input.recurrence || {}, {
      ...schedule,
      scheduled_date: effectiveDate,
      timezone: String(input.timezone || schedule.timezone || series.timezone),
      scheduled_start: input.local_time === null ? null : input.local_time || schedule.scheduled_start || series.local_time,
    });
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "Unsupported recurrence", 400, "RECURRENCE_UNSUPPORTED");
  }
  if (effectiveDate <= String(series.current_date)) {
    const sameAnchor = recurrence.kind === series.recurrence_kind
      && recurrence.weekday === (series.by_weekday ?? recurrence.weekday)
      && recurrence.month_day === (series.by_month_day ?? recurrence.month_day)
      && recurrence.month === (series.by_month ?? recurrence.month);
    if (!sameAnchor) throw new ApiError("A changed weekday or calendar date needs a future effective_date", 400, "SERIES_EFFECTIVE_DATE_REQUIRED");
  }
  const rows = await rest(`task_schedule_series?${new URLSearchParams({ owner_id: `eq.${ownerId}`, id: `eq.${series.id}`, select: "*" })}`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      recurrence_kind: recurrence.kind, rrule: recurrence.rrule, recurrence_interval: recurrence.interval,
      by_weekday: recurrence.weekday, by_month_day: recurrence.month_day, by_month: recurrence.month,
      timezone: recurrence.timezone, local_time: recurrence.local_time,
      next_date_override: effectiveDate > String(series.current_date) ? effectiveDate : null,
      skip_date: null, pending_date: null, creation_started: false, lease_token: null, lease_until: null,
    }),
  });
  const updated = rows?.[0];
  if (!updated || updated.rrule !== recurrence.rrule || updated.timezone !== recurrence.timezone) {
    throw new ApiError("Series update was not verified", 503, "SERIES_UPDATE_UNVERIFIED");
  }
  return { series: updated, updated: true, applies_after_current: true };
}

async function setSeriesStatus(ownerId: string, input: Record<string, unknown>, status: "active" | "paused") {
  const seriesId = String(input.series_id || "");
  const series = (await seriesRows(ownerId, { id: `eq.${seriesId}`, limit: "1" }))?.[0];
  if (!series) throw new ApiError("Recurrence series was not found", 404, "SERIES_NOT_FOUND");
  if (series.status === "cancelled") throw new ApiError("Stopped recurrence series cannot be resumed", 409, "SERIES_CANCELLED");
  if (series.status === status) return { series, replayed: true };
  const now = new Date().toISOString();
  const rows = await rest(`task_schedule_series?${new URLSearchParams({ owner_id: `eq.${ownerId}`, id: `eq.${series.id}`, select: "*" })}`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify(status === "paused"
      ? { status, paused_at: now, pending_date: null, creation_started: false, lease_token: null, lease_until: null }
      : { status, resumed_at: now }),
  });
  const updated = rows?.[0];
  if (!updated || updated.status !== status) throw new ApiError("Series status was not verified", 503, "SERIES_STATUS_UNVERIFIED");
  const advancement = status === "active" ? await advanceSeries(ownerId, String(updated.current_task_id)) : null;
  return { series: updated, replayed: false, ...(advancement ? { advancement } : {}) };
}

async function skipSeriesOnce(ownerId: string, input: Record<string, unknown>) {
  const seriesId = String(input.series_id || "");
  const series = (await seriesRows(ownerId, { id: `eq.${seriesId}`, limit: "1" }))?.[0];
  if (!series) throw new ApiError("Recurrence series was not found", 404, "SERIES_NOT_FOUND");
  if (series.status === "cancelled") throw new ApiError("Stopped recurrence series cannot skip an occurrence", 409, "SERIES_CANCELLED");
  const recurrence = recurrenceRuleFromSeries(series);
  const requestedDate = String(input.recurrence_instance_date || input.occurrence_date || "");
  const expectedDate = String(series.next_date_override || nextRuleDate(String(series.current_date), recurrence));
  const skipDate = requestedDate || expectedDate;
  if (skipDate !== expectedDate) throw new ApiError("Only the next occurrence can be skipped", 409, "SERIES_SKIP_DATE_MISMATCH");
  const existing = await rest(`task_schedule_occurrence?${new URLSearchParams({ select: "*", series_id: `eq.${series.id}`, occurrence_date: `eq.${skipDate}`, limit: "1" })}`);
  if (existing?.[0]) {
    if (existing[0].instance_status !== "skipped") throw new ApiError("The next occurrence already has a Google Task", 409, "SERIES_OCCURRENCE_EXISTS");
  } else {
    await rest("task_schedule_occurrence?on_conflict=series_id%2Coccurrence_date&select=*", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ series_id: series.id, owner_id: ownerId, occurrence_date: skipDate, google_task_id: null, instance_status: "skipped" }),
    });
  }
  const rows = await rest(`task_schedule_series?${new URLSearchParams({ owner_id: `eq.${ownerId}`, id: `eq.${series.id}`, select: "*" })}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ skip_date: skipDate }),
  });
  const updated = rows?.[0];
  if (!updated || updated.skip_date !== skipDate) throw new ApiError("Skipped occurrence was not verified", 503, "SERIES_SKIP_UNVERIFIED");
  return { series: updated, skipped: true, recurrence_instance_date: skipDate };
}

async function cancelSeries(ownerId: string, input: Record<string, unknown>) {
  const seriesId = String(input.series_id || "");
  const taskId = String(input.task_id || "");
  const series = seriesId ? (await seriesRows(ownerId, { id: `eq.${seriesId}`, limit: "1" }))?.[0] : taskId ? await seriesForTask(ownerId, taskId) : null;
  if (!series) throw new ApiError("Recurrence series was not found", 404, "SERIES_NOT_FOUND");
  if (series.status === "cancelled") {
    const projection = await cancelProjection(ownerId, String(series.current_task_id));
    return { series_id: series.id, cancelled: true, replayed: true, current_task_id: series.current_task_id, projection };
  }
  const rows = await rest(`task_schedule_series?${new URLSearchParams({ owner_id: `eq.${ownerId}`, id: `eq.${series.id}`, status: "neq.cancelled", select: "*" })}`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "cancelled", cancelled_at: new Date().toISOString() }),
  });
  if (!rows?.[0] && (await seriesRows(ownerId, { id: `eq.${series.id}`, limit: "1" }))?.[0]?.status !== "cancelled") {
    throw new ApiError("Series cancellation was not verified", 503, "SERIES_CANCEL_UNVERIFIED");
  }
  const currentTaskId = String(rows?.[0]?.current_task_id || series.current_task_id);
  const projection = await cancelProjection(ownerId, currentTaskId);
  return { series_id: series.id, cancelled: true, current_task_id: currentTaskId, projection };
}

async function advanceReadySeries(ownerId: string) {
  const active = await seriesRows(ownerId, { status: "eq.active", order: "updated_at.asc", limit: "500" });
  if (!active?.length) return { advanced: 0, pending: 0, errors: [] };
  const google = await googleContext(ownerId);
  const tasks = await listTasks(google);
  const byId = new Map(tasks.map((task: Record<string, unknown>) => [String(task.id), task]));
  let advanced = 0;
  let pending = 0;
  const errors = [];
  for (const series of active) {
    const current = byId.get(String(series.current_task_id));
    if (!current) {
      errors.push({ series_id: series.id, code: "SERIES_CURRENT_TASK_NOT_FOUND" });
      continue;
    }
    if (current.status === "open") {
      const nextDate = String(series.next_date_override || nextRuleDate(String(series.current_date), recurrenceRuleFromSeries(series)));
      const localToday = localDateInZone(new Date(), String(series.timezone));
      if (nextDate > shiftDate(localToday, 1)) continue;
    }
    try {
      const result = await advanceSeries(ownerId, String(series.current_task_id));
      if (result.advanced) advanced += 1;
      else if (result.reason !== "NEXT_PERIOD_NOT_READY") pending += 1;
    } catch (error) {
      errors.push({ series_id: series.id, code: error instanceof ApiError ? error.code : "SERIES_ADVANCE_FAILED" });
    }
  }
  return { advanced, pending, errors, truncated: active.length === 500 };
}

async function writeSchedule(ownerId: string, taskId: string, input: Record<string, unknown>, preserveReminderPolicy = false) {
  const normalized = normalizeScheduleInput(input, { preserveReminderPolicy });
  const current = (await schedules(ownerId, taskId))?.[0] || null;
  const calendarEventId = calendarProjectionWindow(normalized) ? await stableCalendarEventId(taskId) : null;
  const rescheduled = Boolean(current?.scheduled_date && normalized.scheduled_date && current.scheduled_date !== normalized.scheduled_date);
  const cancelled = normalized.scheduling_status === "cancelled";
  const rows = await rest("task_schedule_metadata?on_conflict=owner_id%2Cgoogle_task_id&select=*", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      owner_id: ownerId,
      google_task_id: taskId,
      ...normalized,
      calendar_event_id: calendarEventId,
      sync_required: true,
      last_sync_error: null,
      previous_scheduled_date: rescheduled ? current.scheduled_date : current?.previous_scheduled_date || null,
      rescheduled_at: rescheduled ? new Date().toISOString() : current?.rescheduled_at || null,
      cancelled_at: cancelled ? new Date().toISOString() : current?.cancelled_at || null,
      deleted_at: null,
      deleted_by: null,
    }),
  });
  if (!rows?.[0]) throw new ApiError("Schedule upsert returned no row", 503, "SCHEDULE_STORE_ERROR");
  return rows[0];
}

async function insertScheduleIfAbsent(ownerId: string, taskId: string, input: Record<string, unknown>, preserveReminderPolicy = false) {
  const current = (await schedules(ownerId, taskId))?.[0];
  if (current) return { schedule: current, inserted: false };
  const normalized = normalizeScheduleInput(input, { preserveReminderPolicy });
  const calendarEventId = calendarProjectionWindow(normalized) ? await stableCalendarEventId(taskId) : null;
  const rows = await rest("task_schedule_metadata?on_conflict=owner_id%2Cgoogle_task_id&select=*", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ owner_id: ownerId, google_task_id: taskId, ...normalized,
      calendar_event_id: calendarEventId, sync_required: true, last_sync_error: null }),
  });
  const schedule = rows?.[0] || (await schedules(ownerId, taskId))?.[0];
  if (!schedule) throw new ApiError("Schedule insert could not be verified", 503, "SCHEDULE_WRITE_UNVERIFIED");
  return { schedule, inserted: Boolean(rows?.[0]) };
}

async function markSynced(ownerId: string, taskId: string, changes: Record<string, unknown>) {
  const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, google_task_id: `eq.${taskId}` });
  await rest(`task_schedule_metadata?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(changes),
  });
}

async function projectTask(ownerId: string, google: { accessToken: string; taskListId: string }, task: Record<string, unknown>, schedule: Record<string, unknown>) {
  const normalized = normalizeScheduleInput({
    ...schedule,
    raw_text: task.originalIntent || task.original_intent,
    title: task.title,
    notes: task.notes,
  }, { preserveReminderPolicy: true });
  if (!calendarProjectionWindow(normalized)) {
    const verifiedAt = new Date().toISOString();
    await markSynced(ownerId, String(task.id), { sync_required: false, notification_status: "not_required",
      last_sync_error: null, last_synced_at: verifiedAt });
    return { projected: false, reason: "NO_TIME", calendar_event_id: null, notification_status: "not_required",
      sync_required: false, verified_at: verifiedAt };
  }
  const eventId = String(schedule.calendar_event_id || await stableCalendarEventId(task.id));
  const calendarId = String(normalized.calendar_id || "primary");
  const event = buildCalendarEvent(task, normalized, eventId);
  const patchBody = { ...event };
  delete (patchBody as Record<string, unknown>).id;
  try {
    await googleRequest(google.accessToken, CALENDAR_BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
      method: "PATCH",
      body: JSON.stringify(patchBody),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) {
      await markSynced(ownerId, String(task.id), { sync_required: true, notification_status: "projection_failed", last_sync_error: error instanceof Error ? error.message : "Calendar sync failed" });
      throw error;
    }
    try {
      await googleRequest(google.accessToken, CALENDAR_BASE, `/calendars/${encodeURIComponent(calendarId)}/events`, {
        method: "POST",
        body: JSON.stringify(event),
      });
    } catch (insertError) {
      if (insertError instanceof ApiError && insertError.status === 409) {
        try {
          await googleRequest(google.accessToken, CALENDAR_BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
            method: "PATCH",
            body: JSON.stringify(patchBody),
          });
        } catch (retryError) {
          await markSynced(ownerId, String(task.id), { sync_required: true, notification_status: "projection_failed", last_sync_error: retryError instanceof Error ? retryError.message : "Calendar sync failed" });
          throw retryError;
        }
      } else {
        await markSynced(ownerId, String(task.id), { sync_required: true, notification_status: "projection_failed", last_sync_error: insertError instanceof Error ? insertError.message : "Calendar sync failed" });
        throw insertError;
      }
    }
  }
  // API acceptance alone is not proof that the intended reminder is configured.
  let verifiedAt: string;
  try {
    const readback = await googleRequest(google.accessToken, CALENDAR_BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    verifyCalendarProjection(event, readback);
    verifiedAt = new Date().toISOString();
  } catch (error) {
    await markSynced(ownerId, String(task.id), { sync_required: true, notification_status: "projection_failed", last_sync_error: "CALENDAR_WRITE_UNVERIFIED" });
    if (error instanceof ApiError) throw error;
    throw new ApiError("任务已保存，日历提醒结果待核实", 503, "CALENDAR_WRITE_UNVERIFIED", { retryable: true, provider_layer: "calendar" });
  }
  const notificationStatus = normalized.scheduling_status === "cancelled" || task.status === "completed" || task.status === "done"
    ? "disabled"
    : normalized.reminders.length ? "projected" : "not_required";
  const projectedReminderFields = reminderProjectionFields({ ...normalized, notification_status: notificationStatus });
  await markSynced(ownerId, String(task.id), {
    calendar_event_id: eventId,
    ...projectedReminderFields,
    sync_required: false,
    last_sync_error: null,
    last_synced_at: verifiedAt,
  });
  return {
    verified_at: verifiedAt,
    device_delivery_status: "not_verified",
    projected: true,
    sync_required: false,
    calendar_id: calendarId,
    calendar_event_id: eventId,
    summary: event.summary,
    ...projectedReminderFields,
  };
}

async function reconcileTaskProjection(
  ownerId: string,
  google: { accessToken: string; taskListId: string },
  task: Record<string, unknown>,
  schedule: Record<string, unknown>,
) {
  const decision = taskScheduleSyncDecision(task, schedule);
  if (decision.project) return projectTask(ownerId, google, task, schedule);
  if (decision.sync_required !== true) return { projected: false, ...decision };
  await markSynced(ownerId, String(task.id), {
    sync_required: true,
    last_sync_error: decision.reason,
  });
  return { projected: false, ...decision };
}

function scheduleAfterProjection(schedule: Record<string, unknown>, projection: object) {
  const result = projection as Record<string, unknown>;
  if (result.projected !== true) return result.sync_required === false
    ? { ...schedule, notification_status: result.notification_status || "not_required", sync_required: false,
      last_sync_error: null, last_synced_at: result.verified_at || schedule.last_synced_at }
    : schedule;
  return {
    ...schedule,
    ...reminderProjectionFields(result),
    sync_required: false,
    last_sync_error: null,
  };
}

async function removeCalendarProjection(google: { accessToken: string; taskListId: string }, schedule: Record<string, unknown>) {
  if (!schedule?.calendar_event_id) return false;
  const taskId = String(schedule.google_task_id || "");
  if (!taskId || schedule.calendar_event_id !== await stableCalendarEventId(taskId)) throw new ApiError("Refusing to remove a noncanonical Calendar object", 409, "CALENDAR_EVENT_IDENTITY_CHANGED");
  const path = `/calendars/${encodeURIComponent(String(schedule.calendar_id || "primary"))}/events/${encodeURIComponent(String(schedule.calendar_event_id))}`;
  let existing;
  try { existing = await googleRequest(google.accessToken, CALENDAR_BASE, path); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return true; throw error; }
  if (existing.extendedProperties?.private?.googleTaskId !== taskId || existing.extendedProperties?.private?.personalOsProjection !== "v1") throw new ApiError("Calendar object is not this Task projection", 409, "CALENDAR_EVENT_IDENTITY_CHANGED");
  if (typeof existing.etag !== "string" || !existing.etag) throw new ApiError("Calendar projection has no concurrency token", 409, "CALENDAR_ETAG_REQUIRED");
  try {
    await googleRequest(
      google.accessToken,
      CALENDAR_BASE,
      `/calendars/${encodeURIComponent(String(schedule.calendar_id || "primary"))}/events/${encodeURIComponent(String(schedule.calendar_event_id))}`,
      { method: "DELETE", headers: { "If-Match": existing.etag } },
    );
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  try { await googleRequest(google.accessToken, CALENDAR_BASE, path); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return true; throw error; }
  throw new ApiError("Calendar projection removal is not verified", 503, "CALENDAR_WRITE_UNVERIFIED");
}

async function scheduleTask(ownerId: string, taskId: string, input: Record<string, unknown>, onlyIfAbsent = false, preserveReminderPolicy = false) {
  if (!taskId) throw new ApiError("task_id is required", 400, "INVALID_TASK");
  const google = await googleContext(ownerId);
  const task = await getTask(google, taskId);
  const current = (await schedules(ownerId, taskId))?.[0] || {};
  if (onlyIfAbsent && current.id) {
    return { task_id: taskId, schedule: current, skipped_existing: true,
      projection: { projected: false, reason: "SCHEDULE_ALREADY_EXISTS" } };
  }
  const reminderState = Object.fromEntries([
    "reminder_policy",
    "reminder_policy_source",
    "reminder_reason",
    "reminder_at",
    "reminder_offset_minutes",
    "reminder_type",
    "reminders",
    "reminder_context",
    "notification_channel",
  ].filter((key) => Object.hasOwn(current, key)).map((key) => [key, current[key]]));
  const proposed = {
    ...reminderState,
    ...input,
    raw_text: input.raw_text || task.originalIntent,
    title: task.title,
    notes: task.notes,
  };
  if (!onlyIfAbsent && current?.calendar_event_id && !calendarProjectionWindow(normalizeScheduleInput(proposed, { preserveReminderPolicy }))) await removeCalendarProjection(google, current);
  let schedule;
  if (onlyIfAbsent) {
    const result = await insertScheduleIfAbsent(ownerId, taskId, proposed, preserveReminderPolicy);
    schedule = result.schedule;
    if (!result.inserted) return { task_id: taskId, schedule, skipped_existing: true,
      projection: { projected: false, reason: "SCHEDULE_ALREADY_EXISTS" } };
  } else {
    schedule = await writeSchedule(ownerId, taskId, proposed, preserveReminderPolicy);
  }
  const projection = await projectTask(ownerId, google, task, schedule);
  return { task_id: taskId, schedule: scheduleAfterProjection(schedule, projection), projection };
}

async function updateTaskReminder(ownerId: string, taskId: string, input: Record<string, unknown>) {
  if (!taskId) throw new ApiError("task_id is required", 400, "INVALID_TASK");
  const current = (await schedules(ownerId, taskId))?.[0] || null;
  const google = await googleContext(ownerId);
  const task = await getTask(google, taskId);
  const reminderInput = input.reminder && typeof input.reminder === "object" && !Array.isArray(input.reminder)
    ? input.reminder as Record<string, unknown>
    : input;
  const suppliesScheduledTime = Object.hasOwn(reminderInput, "scheduled_start") || Object.hasOwn(reminderInput, "scheduledStart");
  const merged = {
    ...mergeReminderPolicyUpdate(current || {}, reminderInput),
    ...(suppliesScheduledTime ? {
      scheduling_source: "explicit_user",
      fixed_time: Object.hasOwn(reminderInput, "fixed_time")
        ? reminderInput.fixed_time
        : Object.hasOwn(reminderInput, "fixedTime") ? reminderInput.fixedTime : true,
    } : {}),
    raw_text: reminderInput.raw_text || task.originalIntent,
    title: task.title,
    notes: task.notes,
  };
  const disabling = reminderInput.reminder_policy === "none" || reminderInput.reminderPolicy === "none";
  const preview = normalizeScheduleInput(merged, { preserveReminderPolicy: disabling });
  if (!calendarProjectionWindow(preview) && !disabling) {
    throw new ApiError("Reminder requires an existing scheduled time or an exact deadline time", 409, "REMINDER_REQUIRES_TIME");
  }
  const expectedEventId = await stableCalendarEventId(taskId);
  if (current?.calendar_event_id && current.calendar_event_id !== expectedEventId) {
    throw new ApiError("Existing Calendar Event identity is not canonical", 409, "CALENDAR_EVENT_IDENTITY_CHANGED");
  }
  if (!calendarProjectionWindow(preview) && current?.calendar_event_id) await removeCalendarProjection(google, current);
  const schedule = await writeSchedule(ownerId, taskId, preview, true);
  if (current?.id && schedule?.id !== current.id) {
    throw new ApiError("Schedule identity changed during reminder update", 500, "SCHEDULE_IDENTITY_CHANGED");
  }
  if (calendarProjectionWindow(preview) && current?.calendar_event_id && schedule?.calendar_event_id !== current.calendar_event_id) {
    throw new ApiError("Calendar Event identity changed during reminder update", 500, "CALENDAR_EVENT_IDENTITY_CHANGED");
  }
  const projection = await projectTask(ownerId, google, task, schedule);
  const readback = (await schedules(ownerId, taskId))?.[0] || null;
  const canonicalReadback = readback ? normalizeScheduleInput(readback, { preserveReminderPolicy: true }) : null;
  if (!readback || !canonicalReadback || (["reminder_policy", "reminder_at", "reminder_offset_minutes", "reminders", "scheduled_date", "scheduled_start"] as const).some(key => JSON.stringify(canonicalReadback[key] ?? null) !== JSON.stringify(preview[key] ?? null))
    || readback.sync_required !== false || !projection.verified_at) {
    throw new ApiError("Reminder update did not match canonical readback", 503, "REMINDER_WRITE_UNVERIFIED");
  }
  const projectedSchedule = scheduleAfterProjection(readback, projection);
  return {
    verified: true,
    task_id: taskId,
    schedule_id: schedule.id,
    calendar_event_id: projection.calendar_event_id,
    task_id_unchanged: true,
    schedule_id_unchanged: !current?.id || schedule.id === current.id,
    calendar_event_id_unchanged: !current?.calendar_event_id || projection.calendar_event_id === current.calendar_event_id,
    google_tasks_count_delta: 0,
    schedule: projectedSchedule,
    projection,
  };
}

async function syncTask(ownerId: string, taskId: string) {
  const schedule = (await schedules(ownerId, taskId))?.[0];
  if (!schedule) return { task_id: taskId, projected: false, reason: "NOT_SCHEDULED" };
  const google = await googleContext(ownerId);
  const task = await getTask(google, taskId);
  return { task_id: taskId, ...(await reconcileTaskProjection(ownerId, google, task, schedule)) };
}

async function updateTaskSchedule(ownerId: string, taskId: string, changes: Record<string, unknown>, preserveReminderPolicy = false) {
  if (!taskId) throw new ApiError("task_id is required", 400, "INVALID_TASK");
  const google = await googleContext(ownerId);
  const task = await getTask(google, taskId);
  const current = (await schedules(ownerId, taskId))?.[0] || null;
  const patched = applyTaskSchedulePatch(current, changes, task.dueDate || null, { preserveReminderPolicy });
  if (!patched.touched) return syncTask(ownerId, taskId);

  const next = patched.schedule;
  if (!next) throw new ApiError("Schedule patch produced no metadata", 500, "INVALID_SCHEDULE_PATCH");
  if (current?.calendar_event_id && (!calendarProjectionWindow(next) || current.calendar_id !== next.calendar_id)) {
    await removeCalendarProjection(google, current);
  }
  const schedule = await writeSchedule(ownerId, taskId, next, preserveReminderPolicy);
  if (!calendarProjectionWindow(schedule)) {
    await markSynced(ownerId, taskId, {
      calendar_event_id: null,
      sync_required: false,
      last_sync_error: null,
      last_synced_at: new Date().toISOString(),
    });
    return {
      task_id: taskId,
      schedule: { ...schedule, calendar_event_id: null, sync_required: false },
      projection: { projected: false, removed: Boolean(current?.calendar_event_id), reason: "NO_TIME" },
    };
  }
  return { task_id: taskId, schedule, projection: await projectTask(ownerId, google, task, schedule) };
}

async function deleteTaskArtifacts(ownerId: string, taskId: string, deletedBy = "chatgpt") {
  if (!taskId) throw new ApiError("task_id is required", 400, "INVALID_TASK");
  const current = (await schedules(ownerId, taskId))?.[0] || null;
  if (!current) return { task_id: taskId, schedule_removed: false, calendar_projection_removed: false };
  const google = await googleContext(ownerId);
  const calendarProjectionRemoved = await removeCalendarProjection(google, current);
  await markSynced(ownerId, taskId, {
    scheduling_status: "cancelled",
    calendar_event_id: null,
    sync_required: false,
    last_sync_error: null,
    last_synced_at: new Date().toISOString(),
    cancelled_at: new Date().toISOString(),
    deleted_at: new Date().toISOString(),
    deleted_by: String(deletedBy || "chatgpt").slice(0, 80),
  });
  return { task_id: taskId, schedule_removed: true, calendar_projection_removed: calendarProjectionRemoved };
}

async function cancelProjection(ownerId: string, taskId: string, title = "已取消任务") {
  const schedule = (await schedules(ownerId, taskId))?.[0];
  if (!schedule) return { task_id: taskId, projected: false, reason: "NOT_SCHEDULED" };
  schedule.scheduling_status = "cancelled";
  const cancelledSchedule = await writeSchedule(ownerId, taskId, schedule);
  if (!calendarProjectionWindow(cancelledSchedule)) return { task_id: taskId, projected: false, reason: "NO_TIME" };
  const google = await googleContext(ownerId);
  return { task_id: taskId, ...(await projectTask(ownerId, google, { id: taskId, title, status: "open" }, cancelledSchedule)) };
}

async function unscheduleTask(ownerId: string, taskId: string, input: Record<string, unknown>) {
  const current = (await schedules(ownerId, taskId))?.[0];
  if (!current) return { task_id: taskId, unscheduled: true, projection_removed: false };
  const google = current.calendar_event_id || current.deadline_time ? await googleContext(ownerId) : null;
  if (current.calendar_event_id && !current.deadline_time) {
    try {
      await googleRequest(google!.accessToken, CALENDAR_BASE, `/calendars/${encodeURIComponent(current.calendar_id || "primary")}/events/${current.calendar_event_id}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  }
  const schedule = await writeSchedule(ownerId, taskId, {
    ...current,
    ...input,
    scheduled_start: null,
    scheduled_end: null,
    scheduling_status: input.scheduled_date ? "unscheduled" : "backlog",
    scheduling_source: "rescheduled",
  });
  if (schedule.deadline_time && google) {
    const task = await getTask(google, taskId);
    const projection = await projectTask(ownerId, google, task, schedule);
    return {
      task_id: taskId,
      unscheduled: true,
      projection_removed: false,
      projection_rebased: "deadline",
      schedule: scheduleAfterProjection(schedule, projection),
      projection,
    };
  }
  await markSynced(ownerId, taskId, { calendar_event_id: null, sync_required: false, last_sync_error: null, last_synced_at: new Date().toISOString() });
  return { task_id: taskId, unscheduled: true, projection_removed: Boolean(current.calendar_event_id), schedule };
}

async function calendarBusy(accessToken: string, startDate: string, endDate: string) {
  const params = new URLSearchParams({
    timeMin: `${startDate}T00:00:00+08:00`,
    timeMax: `${shiftDate(endDate, 1)}T00:00:00+08:00`,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const result = await googleRequest(accessToken, CALENDAR_BASE, `/calendars/primary/events?${params}`);
  const busy: Record<string, Array<{ start: string; end: string }>> = {};
  for (const event of result?.items || []) {
    const start = event.start?.dateTime;
    const end = event.end?.dateTime;
    if (!start || !end || event.status === "cancelled") continue;
    const date = start.slice(0, 10);
    (busy[date] ||= []).push({ start: start.slice(11, 16), end: end.slice(11, 16) });
  }
  return busy;
}

function calendarEventPath(calendarId: string, eventId = "") {
  const root = `/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${root}/${encodeURIComponent(eventId)}` : root;
}

async function searchCalendarEvents(ownerId: string, input: Record<string, unknown>) {
  const dateFrom = String(input.date_from || shanghaiDate());
  const normalized = normalizeCalendarSearchInput(input, { date_from: dateFrom, date_to: shiftDate(dateFrom, 30) });
  const google = await googleContext(ownerId);
  const params = calendarSearchParameters(normalized);
  const page = await googleRequest(google.accessToken, CALENDAR_BASE, `${calendarEventPath(normalized.calendar_id)}?${params}`);
  const events = (page?.items || [])
    .filter((event: Record<string, unknown>) => event.status !== "cancelled")
    .map((event: Record<string, unknown>) => calendarEventView(event, normalized.calendar_id));
  return {
    calendar_id: normalized.calendar_id,
    date_from: normalized.date_from,
    date_to: normalized.date_to,
    count: events.length,
    events,
    next_page_token: page?.nextPageToken || null,
  };
}

async function getCalendarEvent(ownerId: string, input: Record<string, unknown>) {
  const calendarId = String(input.calendar_id || "primary");
  const eventId = String(input.event_id || "");
  if (!eventId) throw new ApiError("event_id is required", 400, "INVALID_CALENDAR_EVENT");
  const google = await googleContext(ownerId);
  const event = await googleRequest(google.accessToken, CALENDAR_BASE, calendarEventPath(calendarId, eventId));
  return { event: calendarEventView(event, calendarId) };
}

async function updateCalendarEvent(ownerId: string, input: Record<string, unknown>) {
  const calendarId = String(input.calendar_id || "primary");
  const eventId = String(input.event_id || "");
  const expectedUpdated = String(input.expected_updated || "");
  if (!eventId || !expectedUpdated) throw new ApiError("event_id and expected_updated are required", 400, "INVALID_CALENDAR_EVENT");
  const google = await googleContext(ownerId);
  const path = calendarEventPath(calendarId, eventId);
  let update;
  try {
    update = await updateCalendarEventInPlace({ ownerId, calendarId, eventId, expectedUpdated, changes: input }, {
      getEvent: () => googleRequest(google.accessToken, CALENDAR_BASE, path),
      patchEvent: ({ patch, etag }: { patch: Record<string, unknown>; etag: string }) => googleRequest(google.accessToken, CALENDAR_BASE, path, {
        method: "PATCH",
        headers: { "If-Match": etag },
        body: JSON.stringify(patch),
      }),
    });
  } catch (error) {
    if (error instanceof CalendarEventRuntimeError) throw new ApiError(error.message, error.status, error.code);
    throw error;
  }
  return {
    event: calendarEventView(update.readback, calendarId),
    event_id: eventId,
    event_id_unchanged: update.updated?.id === eventId && update.readback?.id === eventId,
    calendar_event_count_delta: 0,
    verified: true,
  };
}

async function runMorningScheduler(ownerId: string, targetDate: string) {
  const google = await googleContext(ownerId);
  const [tasks, existingSchedules, busy] = await Promise.all([
    listTasks(google),
    schedules(ownerId),
    calendarBusy(google.accessToken, targetDate, shiftDate(targetDate, 3)),
  ]);

  let synced = 0;
  const syncErrors = [];
  const reconciliationBlocked = new Set<string>();
  for (const schedule of existingSchedules) {
    const task = tasks.find((item) => item.id === schedule.google_task_id);
    if (!task) continue;
    try {
      const result = await reconcileTaskProjection(ownerId, google, task, schedule);
      if (result.projected) synced += 1;
      else if ("sync_required" in result && result.sync_required) {
        reconciliationBlocked.add(String(task.id));
        syncErrors.push({ task_id: task.id, code: result.reason, error: "Task due and execution schedule require reconciliation" });
      }
    }
    catch (error) { syncErrors.push({ task_id: task.id, error: error instanceof Error ? error.message : "sync failed" }); }
  }

  const plan = planTaskSlots(tasks.filter((task) => !reconciliationBlocked.has(String(task.id))), existingSchedules, busy, { today: targetDate, horizonDays: 3 });
  const projected = [];
  for (const item of plan.plans) {
    const task = tasks.find((candidate) => candidate.id === item.google_task_id);
    if (!task) continue;
    const schedule = await writeSchedule(ownerId, task.id, {
      ...item,
      raw_text: task.originalIntent || task.original_intent,
      title: task.title,
      notes: task.notes,
    });
    projected.push(await projectTask(ownerId, google, task, schedule));
  }
  for (const taskId of plan.backlog) {
    if (!existingSchedules.some((item: Record<string, unknown>) => item.google_task_id === taskId)) {
      const task = tasks.find((candidate) => candidate.id === taskId);
      await writeSchedule(ownerId, taskId, {
        scheduling_status: "backlog",
        scheduling_source: "gpt_inferred",
        raw_text: task?.originalIntent || task?.original_intent,
        title: task?.title,
        notes: task?.notes,
      });
    }
  }
  return { date: targetDate, synced, scheduled: projected.length, backlog: plan.backlog.length, sync_errors: syncErrors };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SERVICE_API_KEY || !SUPABASE_PUBLIC_KEY || !OWNER_USER_ID || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || TOKEN_ENCRYPTION_KEY.length < 32) {
    return json({ success: false, error: "Server configuration incomplete" }, 503);
  }
  try {
    const ownerId = await ownerForRequest(request);
    if (request.method === "GET") return json({ schedules: await schedules(ownerId) });
    if (request.method !== "POST") throw new ApiError("Method not allowed", 405, "METHOD_NOT_ALLOWED");
    const input = await request.json();
    const action = String(input.action || "schedule");
    if (action === "create_series") return json({ success: true, ...(await createSeries(ownerId, String(input.task_id || ""), input.recurrence || {})) });
    if (action === "advance_series") {
      const result = await advanceSeries(ownerId, String(input.task_id || ""));
      const pending = ["SERIES_BUSY_OR_CHANGED", "TASK_WRITE_OUTCOME_UNKNOWN", "SERIES_CHANGED_DURING_ADVANCE"].includes(String(result.reason || ""));
      return json({ success: !pending, ...result }, pending ? 503 : 200);
    }
    if (action === "update_series") return json({ success: true, ...(await updateSeries(ownerId, input)) });
    if (action === "pause_series") return json({ success: true, ...(await setSeriesStatus(ownerId, input, "paused")) });
    if (action === "resume_series") return json({ success: true, ...(await setSeriesStatus(ownerId, input, "active")) });
    if (action === "skip_series_once") return json({ success: true, ...(await skipSeriesOnce(ownerId, input)) });
    if (action === "cancel_series") return json({ success: true, ...(await cancelSeries(ownerId, input)) });
    if (action === "list_series") return json({ success: true, series: await seriesRows(ownerId) });
    if (action === "run_recurrence") return json({ success: true, recurrence: await advanceReadySeries(ownerId) });
    if (action === "schedule" || action === "reschedule") {
      return json({ success: true, ...(await scheduleTask(ownerId, String(input.task_id || ""), input.schedule || input, input.only_if_absent === true, input.preserve_reminder_policy === true)) });
    }
    if (action === "update_reminder") {
      return json({ success: true, ...(await updateTaskReminder(ownerId, String(input.task_id || ""), input.reminder || input)) });
    }
    if (action === "sync_task") return json({ success: true, ...(await syncTask(ownerId, String(input.task_id || ""))) });
    if (action === "update_task") return json({ success: true, ...(await updateTaskSchedule(ownerId, String(input.task_id || ""), input.changes || {}, input.preserve_reminder_policy === true)) });
    if (action === "delete_task") return json({ success: true, ...(await deleteTaskArtifacts(ownerId, String(input.task_id || ""), String(input.deleted_by || "chatgpt"))) });
    if (action === "cancel_task") return json({ success: true, ...(await cancelProjection(ownerId, String(input.task_id || ""), String(input.title || "已取消任务"))) });
    if (action === "unschedule") return json({ success: true, ...(await unscheduleTask(ownerId, String(input.task_id || ""), input.schedule || input)) });
    if (action === "search_calendar_events") return json({ success: true, ...(await searchCalendarEvents(ownerId, input)) });
    if (action === "get_calendar_event") return json({ success: true, ...(await getCalendarEvent(ownerId, input)) });
    if (action === "update_calendar_event") return json({ success: true, ...(await updateCalendarEvent(ownerId, input)) });
    if (action === "run") {
      const date = String(input.date || shanghaiDate());
      const morning = await runMorningScheduler(ownerId, date);
      return json({ success: true, ...morning, recurrence: await advanceReadySeries(ownerId) });
    }
    throw new ApiError("Unknown scheduler action", 400, "INVALID_ACTION");
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const apiError = error instanceof ApiError
      ? error
      : providerApiError(error) || new ApiError(timedOut ? "Scheduler timed out" : error instanceof Error ? error.message : "Scheduler failed", 503, timedOut ? "API_TIMEOUT" : "SCHEDULER_FAILED");
    console.error("Task scheduler failed", { code: apiError.code, status: apiError.status, retryable: apiError.retryable, providerLayer: apiError.providerLayer || undefined });
    return json({
      success: false,
      error: apiError.message,
      code: apiError.code,
      ...(apiError.providerLayer ? { retryable: apiError.retryable, provider_layer: apiError.providerLayer } : {}),
      ...(apiError.providerStatus !== null ? { provider_status: apiError.providerStatus } : {}),
      ...(apiError.providerCode ? { provider_code: apiError.providerCode } : {}),
    }, apiError.status);
  }
});
