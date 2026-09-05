import {
  applyTaskSchedulePatch,
  buildCalendarEvent,
  calendarProjectionWindow,
  normalizeScheduleInput,
  planTaskSlots,
  stableCalendarEventId,
} from "../_shared/schedule-core.js";
import { mergeReminderPolicyUpdate, reminderProjectionFields } from "../_shared/reminder-policy-core.js";
import { toTaskModel } from "../_shared/google-tasks-core.js";
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
  constructor(message: string, status = 503, code = "SCHEDULER_UNAVAILABLE") {
    super(message);
    this.status = status;
    this.code = code;
  }
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
  const rows = await rpc("read_google_tasks_credentials", { target_owner: ownerId, encryption_key: TOKEN_ENCRYPTION_KEY });
  const credentials = rows?.[0];
  if (!credentials?.refresh_token || !credentials?.tasklist_id) throw new ApiError("Google Tasks is not connected", 428, "GOOGLE_NOT_CONNECTED");
  const response = await timedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: credentials.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const token = await responsePayload(response);
  if (!response.ok || !token?.access_token) throw new ApiError("Google authorization expired", 401, "GOOGLE_REAUTH_REQUIRED");
  return { accessToken: token.access_token as string, taskListId: credentials.tasklist_id as string };
}

async function googleRequest(accessToken: string, base: string, path: string, init: RequestInit = {}) {
  const response = await timedFetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await responsePayload(response);
  if (!response.ok) {
    const message = body?.error?.message || `Google request failed (${response.status})`;
    const reason = String(body?.error?.errors?.[0]?.reason || body?.error?.status || "");
    if (response.status === 401) throw new ApiError("Google authorization expired", 401, "GOOGLE_REAUTH_REQUIRED");
    if (response.status === 403 && base === CALENDAR_BASE) {
      const detail = `${reason} ${message}`;
      if (/accessNotConfigured|SERVICE_DISABLED|not been used|disabled/i.test(detail)) {
        throw new ApiError("Google Calendar API 尚未启用", 403, "CALENDAR_API_DISABLED");
      }
      if (/insufficientPermissions|insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|scope/i.test(detail)) {
        throw new ApiError("请重新授权 Google Calendar 权限", 403, "CALENDAR_SCOPE_MISSING");
      }
      throw new ApiError(message, 403, "GOOGLE_CALENDAR_PERMISSION_DENIED");
    }
    if (response.status === 404) throw new ApiError(message, 404, "GOOGLE_OBJECT_NOT_FOUND");
    if (response.status === 409) throw new ApiError(message, 409, "GOOGLE_OBJECT_EXISTS");
    if (response.status === 429) throw new ApiError("Google rate limit reached", 429, "RATE_LIMITED");
    throw new ApiError(message, response.status, base === CALENDAR_BASE ? "GOOGLE_CALENDAR_ERROR" : "GOOGLE_TASKS_ERROR");
  }
  return body;
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
  do {
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
  if (!calendarProjectionWindow(normalized)) return { projected: false, reason: "NO_TIME", calendar_event_id: null };
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
  const notificationStatus = normalized.scheduling_status === "cancelled" || task.status === "completed" || task.status === "done"
    ? "disabled"
    : normalized.reminders.length ? "projected" : "not_required";
  const projectedReminderFields = reminderProjectionFields({ ...normalized, notification_status: notificationStatus });
  await markSynced(ownerId, String(task.id), {
    calendar_event_id: eventId,
    ...projectedReminderFields,
    sync_required: false,
    last_sync_error: null,
    last_synced_at: new Date().toISOString(),
  });
  return {
    projected: true,
    calendar_id: calendarId,
    calendar_event_id: eventId,
    summary: event.summary,
    ...projectedReminderFields,
  };
}

function scheduleAfterProjection(schedule: Record<string, unknown>, projection: object) {
  const result = projection as Record<string, unknown>;
  if (result.projected !== true) return schedule;
  return {
    ...schedule,
    ...reminderProjectionFields(result),
    sync_required: false,
    last_sync_error: null,
  };
}

async function removeCalendarProjection(google: { accessToken: string; taskListId: string }, schedule: Record<string, unknown>) {
  if (!schedule?.calendar_event_id) return false;
  try {
    await googleRequest(
      google.accessToken,
      CALENDAR_BASE,
      `/calendars/${encodeURIComponent(String(schedule.calendar_id || "primary"))}/events/${encodeURIComponent(String(schedule.calendar_event_id))}`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  return true;
}

async function scheduleTask(ownerId: string, taskId: string, input: Record<string, unknown>) {
  if (!taskId) throw new ApiError("task_id is required", 400, "INVALID_TASK");
  const google = await googleContext(ownerId);
  const task = await getTask(google, taskId);
  const current = (await schedules(ownerId, taskId))?.[0] || {};
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
  const schedule = await writeSchedule(ownerId, taskId, {
    ...reminderState,
    ...input,
    raw_text: input.raw_text || task.originalIntent,
    title: task.title,
    notes: task.notes,
  });
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
  const preview = normalizeScheduleInput(merged);
  if (!calendarProjectionWindow(preview)) {
    throw new ApiError("Reminder requires an existing scheduled time or an exact deadline time", 409, "REMINDER_REQUIRES_TIME");
  }
  const expectedEventId = await stableCalendarEventId(taskId);
  if (current?.calendar_event_id && current.calendar_event_id !== expectedEventId) {
    throw new ApiError("Existing Calendar Event identity is not canonical", 409, "CALENDAR_EVENT_IDENTITY_CHANGED");
  }
  const schedule = await writeSchedule(ownerId, taskId, merged);
  if (current?.id && schedule?.id !== current.id) {
    throw new ApiError("Schedule identity changed during reminder update", 500, "SCHEDULE_IDENTITY_CHANGED");
  }
  if (current?.calendar_event_id && schedule?.calendar_event_id !== current.calendar_event_id) {
    throw new ApiError("Calendar Event identity changed during reminder update", 500, "CALENDAR_EVENT_IDENTITY_CHANGED");
  }
  const projection = await projectTask(ownerId, google, task, schedule);
  const projectedSchedule = scheduleAfterProjection(schedule, projection);
  return {
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
  return { task_id: taskId, ...(await projectTask(ownerId, google, task, schedule)) };
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

async function runMorningScheduler(ownerId: string, targetDate: string) {
  const google = await googleContext(ownerId);
  const [tasks, existingSchedules, busy] = await Promise.all([
    listTasks(google),
    schedules(ownerId),
    calendarBusy(google.accessToken, targetDate, shiftDate(targetDate, 3)),
  ]);

  let synced = 0;
  const syncErrors = [];
  for (const schedule of existingSchedules.filter((item: Record<string, unknown>) => calendarProjectionWindow(item))) {
    const task = tasks.find((item) => item.id === schedule.google_task_id);
    if (!task) continue;
    try { await projectTask(ownerId, google, task, schedule); synced += 1; }
    catch (error) { syncErrors.push({ task_id: task.id, error: error instanceof Error ? error.message : "sync failed" }); }
  }

  const plan = planTaskSlots(tasks, existingSchedules, busy, { today: targetDate, horizonDays: 3 });
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
    if (action === "schedule" || action === "reschedule") {
      return json({ success: true, ...(await scheduleTask(ownerId, String(input.task_id || ""), input.schedule || input)) });
    }
    if (action === "update_reminder") {
      return json({ success: true, ...(await updateTaskReminder(ownerId, String(input.task_id || ""), input.reminder || input)) });
    }
    if (action === "sync_task") return json({ success: true, ...(await syncTask(ownerId, String(input.task_id || ""))) });
    if (action === "update_task") return json({ success: true, ...(await updateTaskSchedule(ownerId, String(input.task_id || ""), input.changes || {}, input.preserve_reminder_policy === true)) });
    if (action === "delete_task") return json({ success: true, ...(await deleteTaskArtifacts(ownerId, String(input.task_id || ""), String(input.deleted_by || "chatgpt"))) });
    if (action === "cancel_task") return json({ success: true, ...(await cancelProjection(ownerId, String(input.task_id || ""), String(input.title || "已取消任务"))) });
    if (action === "unschedule") return json({ success: true, ...(await unscheduleTask(ownerId, String(input.task_id || ""), input.schedule || input)) });
    if (action === "run") {
      const date = String(input.date || shanghaiDate());
      return json({ success: true, ...(await runMorningScheduler(ownerId, date)) });
    }
    throw new ApiError("Unknown scheduler action", 400, "INVALID_ACTION");
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const apiError = error instanceof ApiError ? error : new ApiError(timedOut ? "Scheduler timed out" : error instanceof Error ? error.message : "Scheduler failed", 503, timedOut ? "API_TIMEOUT" : "SCHEDULER_FAILED");
    console.error("Task scheduler failed", { code: apiError.code, message: apiError.message });
    return json({ success: false, error: apiError.message, code: apiError.code }, apiError.status);
  }
});
