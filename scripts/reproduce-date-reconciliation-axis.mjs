// Read fixed source snapshots and compare pure functions on fictional data.
// No Auth, Google, Supabase, task, Calendar or logging API requests are made.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as currentLifecycle from "../supabase/functions/_shared/task-lifecycle-core.js";
import * as currentSchedule from "../supabase/functions/_shared/schedule-core.js";
const reviewed = "611ffd162d9b4bea2750199a0362c9f91df20785";
const cwd = fileURLToPath(new URL("../", import.meta.url));
const source = path => execFileSync("git", ["show", `${reviewed}:${path}`], { cwd, encoding: "utf8" });
const moduleURL = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const reminderURL = moduleURL(source("supabase/functions/_shared/reminder-policy-core.js"));
const scheduleURL = moduleURL(source("supabase/functions/_shared/schedule-core.js").replace('"./reminder-policy-core.js"', JSON.stringify(reminderURL)));
const oldSchedule = await import(scheduleURL);
const oldLifecycle = await import(moduleURL(source("supabase/functions/_shared/task-lifecycle-core.js").replace('"./schedule-core.js"', JSON.stringify(scheduleURL))));
const task = { id: "synthetic-axis-task", title: "虚构事项", dueDate: "2099-01-09", status: "open" };
const schedule = { google_task_id: task.id, scheduled_date: "2099-01-08", scheduled_start: null, scheduled_end: null,
  scheduling_source: "morning_plan", deadline: "2099-01-10", deadline_time: "18:00", fixed_time: false,
  scheduling_status: "unscheduled", calendar_event_id: null, sync_required: false };
function result(lifecycle, projector, current, metadata) {
  const view = lifecycle.taskView(current, metadata);
  return { task_date: view.due, planned_date: view.requested_date, deadline: view.deadline,
    stored_sync_required: view.schedule.sync_required, read_warning: view.date_reconciliation || null,
    projection_decision: projector.taskScheduleSyncDecision(current, metadata) };
}
const cases = [
  ["morning_plan_with_unrelated_deadline", task, schedule],
  ["unexplained_plan_with_unrelated_deadline", task, { ...schedule, scheduling_source: "explicit_user" }],
  ["malformed_task_date", { ...task, dueDate: "2099-02-29" }, { ...schedule, scheduling_source: "explicit_user", deadline: null, deadline_time: null }],
  ["malformed_planned_date", task, { ...schedule, scheduled_date: "not-a-date", scheduling_source: "explicit_user", deadline: null, deadline_time: null }],
];
console.log(JSON.stringify({ mode: "synthetic-pure-source-reproduction", reviewedCommit: reviewed,
  realProviderCalls: 0, realWrites: 0,
  cases: cases.map(([name, current, metadata]) => ({ name,
    before: result(oldLifecycle, oldSchedule, current, metadata),
    after: result(currentLifecycle, currentSchedule, current, metadata) })),
  limits: ["No read warning does not certify malformed source dates as valid.", "Projection guards retain their existing independent deadline-axis decision.", "No real event provenance or user date intent is established."] }, null, 2));
