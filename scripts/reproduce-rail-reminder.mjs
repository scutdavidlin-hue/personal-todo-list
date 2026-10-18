// Pure synthetic source reproduction; no credentials, provider calls or writes.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as reminder from "../supabase/functions/_shared/reminder-policy-core.js";
import * as schedule from "../supabase/functions/_shared/schedule-core.js";
import * as lifecycle from "../supabase/functions/_shared/task-lifecycle-core.js";
const baseline = "bb240517727a81ca89059985295b7c9da144403b";
const cwd = fileURLToPath(new URL("../", import.meta.url));
const source = path => execFileSync("git", ["show", `${baseline}:${path}`], { cwd, encoding: "utf8" });
const moduleURL = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const oldReminderURL = moduleURL(source("supabase/functions/_shared/reminder-policy-core.js"));
const oldReminder = await import(oldReminderURL);
const oldSchedule = await import(moduleURL(source("supabase/functions/_shared/schedule-core.js").replace('"./reminder-policy-core.js"', JSON.stringify(oldReminderURL))));
const oldLifecycle = await import(moduleURL(source("supabase/functions/_shared/task-lifecycle-core.js")));
const fixed = { scheduled_date: "2099-01-08", scheduled_start: "19:00", scheduled_end: "19:30", scheduling_source: "explicit_user", fixed_time: true };
const text = "乘坐某列车，从某高铁车站出发，提前安检进站";
function railResult(policyModule, scheduleModule) {
  const policy = policyModule.resolveReminderPolicy({ ...fixed, title: "某列车出行", raw_text: text });
  const metadata = scheduleModule.normalizeScheduleInput({ ...fixed, title: "某列车出行", raw_text: text });
  const event = scheduleModule.buildCalendarEvent({ id: "synthetic-rail-task", title: "某列车出行", originalIntent: text, notes: text, dueDate: fixed.scheduled_date }, metadata);
  return { kind: policy.reminder_context.task_kind, transportation: policy.reminder_context.transportation, cue: policyModule.reminderNotificationCue(policy), summary: event.summary, description: event.description };
}
const task = { id: "synthetic-date-task", title: "虚构事项", dueDate: "2099-01-09", status: "open", updatedAt: "2099-01-07T12:00:00Z" };
const metadata = { google_task_id: task.id, scheduled_date: "2099-01-08", fixed_time: false, scheduling_source: "explicit_user", scheduling_status: "unscheduled", deadline: null, calendar_event_id: null, sync_required: false, last_synced_at: "2099-01-07T10:00:00Z", last_sync_error: null };
function dateResult(module) {
  const view = module.taskView(task, metadata);
  return { task_date: view.due, scheduled_date: view.requested_date, deadline: view.deadline,
    stored_sync_required: view.schedule.sync_required, derived: view.date_reconciliation || null };
}
console.log(JSON.stringify({ mode: "pure-functions-and-synthetic-data", baseline,
  realAuthOrProviderCalls: 0, realTaskOrCalendarWrites: 0,
  rail: { input: text, before: railResult(oldReminder, oldSchedule), after: railResult(reminder, schedule) },
  dates: { before: dateResult(oldLifecycle), after: dateResult(lifecycle), existingProjectionGuard: schedule.taskScheduleSyncDecision(task, metadata) },
  limits: ["Synthetic reproduction does not establish which input produced an existing real event.", "Different dates and a newer Google update timestamp do not prove which date is intended.", "No date, stored sync flag, event or provider data is changed by reading the warning."] }, null, 2));
