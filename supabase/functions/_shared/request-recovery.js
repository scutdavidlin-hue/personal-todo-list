// Intake recovery metadata is a journal, never an alternative task store.
export const RECOVERY_STAGES = Object.freeze([
  "received", "needs_input", "write_pending", "outcome_unknown",
  "task_verified", "projection_pending", "reminder_verified",
  "auth_required", "missed", "unsupported", "superseded", "cancelled", "request_verified",
]);

export const TERMINAL_STAGES = new Set(["reminder_verified", "unsupported", "superseded", "cancelled", "request_verified"]);

export function retryAt(attempts, now = Date.now()) {
  const capped = Math.min(8, Math.max(0, Number(attempts) || 0));
  const delay = Math.min(300_000, 2_000 * 2 ** capped);
  return new Date(now + delay).toISOString();
}

export function safeError(error) {
  const code = String(error?.code || error?.name || "RECOVERY_ERROR").slice(0, 80);
  return /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "RECOVERY_ERROR";
}

export function frozenIntake(input, receivedAt) {
  const frozen = { ...input, baseDate: receivedAt, received_at: receivedAt };
  delete frozen.idempotency_key;
  return frozen;
}

export function intakeBlocker(intake) {
  if (intake.type !== "task") return null;
  const raw = String(intake.raw_text || "");
  if (/(每周|每月|每天|每日|每星期|每年|周期|循环)/.test(raw) && !intake.recurrence) return "RECURRING_NOT_SUPPORTED";
  if (intake.recurrence && !intake.schedule?.scheduled_date) return "RECURRENCE_DATE_REQUIRED";
  const reminderIntent = /(提醒|叫我|通知我)/.test(raw);
  const hasTime = Boolean(intake.schedule?.reminder_at || intake.schedule?.scheduled_start ||
    (Array.isArray(intake.schedule?.reminders) && intake.schedule.reminders.length));
  // A dated action is valid without a clock, even when phrased as “remind me”.
  // Only an explicitly fixed-time request (or an undated reminder) needs input.
  const hasDate = Boolean(intake.schedule?.scheduled_date || intake.requested_date || intake.due);
  const fixedTime = intake.fixed_time === true || intake.schedule?.fixed_time === true;
  if (!hasTime && (fixedTime || (reminderIntent && !hasDate))) return "REMINDER_TIME_REQUIRED";
  return null;
}

function zonedParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

// Compare wall-clock components in the original zone; this also handles midnight rollover.
export function isMissed(intake, now = new Date()) {
  const schedule = intake?.schedule || {};
  const exact = schedule.reminder_at;
  if (typeof exact === "string" && /(?:Z|[+-]\d\d:\d\d)$/i.test(exact)) {
    const instant = Date.parse(exact);
    return Number.isFinite(instant) && instant < now.valueOf();
  }
  const date = schedule.scheduled_date || intake?.requested_date || intake?.due;
  const time = schedule.reminder_at?.slice(11, 16) || schedule.scheduled_start || intake?.requested_time;
  const reminderDate = schedule.reminder_at?.slice(0, 10) || date;
  if (!reminderDate || !time) return false;
  const timezone = intake?.timezone || schedule.timezone || "Asia/Shanghai";
  const local = zonedParts(now, timezone);
  const current = `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}`;
  return `${reminderDate}T${time}` < current;
}

export function recoveryDecision(row, now = new Date()) {
  if (TERMINAL_STAGES.has(row.stage)) return "complete";
  if (row.stage === "needs_input" || row.stage === "missed") return "needs_input";
  if (row.stage === "auth_required") return "auth_required";
  if (row.next_retry_at && Date.parse(row.next_retry_at) > now.valueOf()) return "later";
  if (row.lease_expires_at && Date.parse(row.lease_expires_at) > now.valueOf()) return "leased";
  if (row.stage === "outcome_unknown" || row.stage === "write_pending") return "reconcile_first";
  if (row.stage === "task_verified" || row.stage === "projection_pending") return "projection_only";
  return "prepare";
}

export function publicRecovery(row) {
  const intake = row.request_payload || {};
  const schedule = intake.schedule || {};
  return {
    request_id: row.id,
    idempotency_key: row.idempotency_key,
    title: intake.title || row.raw_text,
    task_date: intake.due || null,
    execution_time: schedule.scheduled_start || null,
    reminder_time: schedule.reminder_at || null,
    timezone: intake.timezone || null,
    stage: row.stage,
    status: row.status,
    object_id: row.object_id || null,
    operation_version: row.operation_version,
    recovery_version: row.recovery_version,
    retry_count: row.retry_count,
    next_retry_at: row.next_retry_at,
    last_verified_at: row.last_verified_at,
    error_code: row.error_code,
    received_at: row.received_at,
    response: row.response || null,
  };
}
