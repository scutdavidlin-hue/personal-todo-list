import {
  calendarReminderOverrides,
  reminderActionGuidance,
  reminderNotificationCue,
  reminderProjectionFields,
  resolveReminderPolicy,
} from "./reminder-policy-core.js";

const VALID_STATUS = new Set(["unscheduled", "scheduled", "rescheduled", "backlog", "waiting", "cancelled"]);
const VALID_SOURCE = new Set(["explicit_user", "gpt_inferred", "morning_plan", "rescheduled"]);
const VALID_PRIORITY = new Set(["low", "medium", "high", "urgent"]);
const PRIORITY_WEIGHT = { urgent: 4, high: 3, medium: 2, low: 1 };

export function validScheduleDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function validScheduleTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
}

function normalizeTime(value) {
  return typeof value === "string" && validScheduleTime(value) ? value.slice(0, 5) : value;
}

function minutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return (hour * 60) + minute;
}

function timeFromMinutes(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function addMinutes(time, amount) {
  if (!validScheduleTime(time)) throw new Error("time must be HH:MM");
  const result = minutes(time) + Number(amount);
  if (!Number.isInteger(result) || result < 0 || result >= 24 * 60) throw new Error("time range crosses the calendar day");
  return timeFromMinutes(result);
}

export function normalizeScheduleInput(input = {}, options = {}) {
  const scheduledDate = input.scheduled_date || input.scheduledDate || input.requested_date || input.requestedDate || null;
  const scheduledStart = normalizeTime(input.scheduled_start || input.scheduledStart || input.requested_time || input.requestedTime || null);
  const duration = Number(input.duration_minutes || input.durationMinutes || input.estimated_duration || input.estimatedDuration || 30);
  const scheduledEnd = normalizeTime(input.scheduled_end || input.scheduledEnd || (scheduledStart ? addMinutes(scheduledStart, duration) : null));
  const timezone = String(input.timezone || "Asia/Shanghai").trim();
  const source = String(input.scheduling_source || input.schedulingSource || "gpt_inferred");
  const priority = String(input.priority || "medium");
  const explicitStatus = input.scheduling_status || input.schedulingStatus;
  const deadline = input.deadline || null;
  const deadlineTime = normalizeTime(input.deadline_time || input.deadlineTime || null);
  const taskType = String(input.task_type || input.taskType || "task");
  const parentTaskId = input.parent_task_id ?? input.parentTaskId ?? null;
  const followUpOf = input.follow_up_of ?? input.followUpOf ?? null;
  const followUpSequence = Number(input.follow_up_sequence ?? input.followUpSequence ?? (taskType === "follow_up" ? 2 : 1));
  if (!["task", "follow_up"].includes(taskType)) throw new Error("task_type is invalid");
  for (const value of [parentTaskId, followUpOf]) {
    if (value !== null && (typeof value !== "string" || !value.trim() || value.length > 1024)) throw new Error("Task relationship id is invalid");
  }
  if (!Number.isInteger(followUpSequence) || followUpSequence < 1 || followUpSequence > 99) throw new Error("follow_up_sequence is invalid");
  const status = String(explicitStatus || (scheduledStart ? "scheduled" : scheduledDate || deadline ? "unscheduled" : "backlog"));

  if (scheduledDate && !validScheduleDate(scheduledDate)) throw new Error("scheduled_date must be YYYY-MM-DD");
  if (scheduledStart && !validScheduleTime(scheduledStart)) throw new Error("scheduled_start must be HH:MM");
  if (scheduledEnd && !validScheduleTime(scheduledEnd)) throw new Error("scheduled_end must be HH:MM");
  if ((scheduledStart || scheduledEnd) && !scheduledDate) throw new Error("scheduled_date is required for a timed schedule");
  if ((scheduledStart && !scheduledEnd) || (!scheduledStart && scheduledEnd)) throw new Error("scheduled_start and scheduled_end must be provided together");
  if (scheduledStart && minutes(scheduledEnd) <= minutes(scheduledStart)) throw new Error("scheduled_end must be after scheduled_start");
  if (!Number.isInteger(duration) || duration < 5 || duration > 720) throw new Error("duration_minutes must be between 5 and 720");
  if (!timezone || timezone.length > 80) throw new Error("timezone is invalid");
  if (!VALID_STATUS.has(status)) throw new Error("scheduling_status is invalid");
  if (!VALID_SOURCE.has(source)) throw new Error("scheduling_source is invalid");
  if (!VALID_PRIORITY.has(priority)) throw new Error("priority is invalid");
  if (deadline && !validScheduleDate(deadline)) throw new Error("deadline must be YYYY-MM-DD");
  if (deadlineTime && !validScheduleTime(deadlineTime)) throw new Error("deadline_time must be HH:MM");
  if (deadlineTime && !deadline) throw new Error("deadline is required when deadline_time is set");

  const schedule = {
    scheduled_date: scheduledDate,
    scheduled_start: scheduledStart,
    scheduled_end: scheduledEnd,
    timezone,
    duration_minutes: duration,
    scheduling_status: status,
    scheduling_source: source,
    calendar_id: String(input.calendar_id || input.calendarId || "primary"),
    fixed_time: input.fixed_time === true || input.fixedTime === true || (source === "explicit_user" && Boolean(scheduledStart)),
    priority,
    deadline,
    deadline_time: deadlineTime,
    task_type: taskType,
    parent_task_id: parentTaskId,
    follow_up_of: followUpOf,
    follow_up_sequence: followUpSequence,
  };
  return {
    ...schedule,
    ...reminderProjectionFields(resolveReminderPolicy({ ...input, ...schedule }, options)),
  };
}

function owns(value, key) {
  return Boolean(value && Object.hasOwn(value, key));
}

/**
 * @param {Record<string, any> | null} current
 * @param {Record<string, any>} changes
 * @param {string | null} taskDue
 */
export function applyTaskSchedulePatch(current, changes = {}, taskDue = null, options = {}) {
  const hasCurrent = Boolean(current);
  const next = { ...(current || {}) };
  let touched = false;
  let timingChanged = false;

  if (owns(changes, "due")) {
    next.scheduled_date = changes.due;
    touched = true;
    timingChanged = true;
  }
  if (owns(changes, "requested_date")) {
    next.scheduled_date = changes.requested_date;
    touched = true;
    timingChanged = true;
  }
  if (owns(changes, "requested_time")) {
    next.scheduled_start = changes.requested_time;
    next.scheduled_end = null;
    if (changes.requested_time === null && !owns(changes, "fixed_time")) next.fixed_time = false;
    touched = true;
    timingChanged = true;
  }
  if (owns(changes, "estimated_duration")) {
    next.duration_minutes = changes.estimated_duration;
    next.scheduled_end = null;
    touched = true;
    timingChanged = Boolean(next.scheduled_start) || timingChanged;
  }
  const directFields = {
    deadline_time: "deadline_time",
    deadline: "deadline",
    priority: "priority",
    fixed_time: "fixed_time",
    timezone: "timezone",
    task_type: "task_type",
    parent_task_id: "parent_task_id",
    follow_up_of: "follow_up_of",
    follow_up_sequence: "follow_up_sequence",
  };
  for (const [changeField, scheduleField] of Object.entries(directFields)) {
    if (!owns(changes, changeField)) continue;
    next[scheduleField] = changes[changeField];
    touched = true;
  }
  if (!touched) return { touched: false, schedule: current || null, timing_changed: false };
  if (!hasCurrent && !owns(next, "scheduled_date")) next.scheduled_date = taskDue || null;
  if (!next.scheduled_date) {
    next.scheduled_start = null;
    next.scheduled_end = null;
    next.fixed_time = false;
  } else if (next.scheduled_start && !next.scheduled_end) {
    next.scheduled_end = addMinutes(String(next.scheduled_start).slice(0, 5), Number(next.duration_minutes || 30));
  }
  if (timingChanged) {
    if (!options.preserveReminderPolicy && (next.reminder_policy_source === "ai_inferred" || next.reminder_policy_source === "system_default")) {
      next.reminders = [];
      next.reminder_at = null;
      next.reminder_offset_minutes = null;
    }
    next.scheduling_status = next.scheduled_start ? (hasCurrent ? "rescheduled" : "scheduled") : next.scheduled_date ? "unscheduled" : "backlog";
    next.scheduling_source = hasCurrent ? "rescheduled" : "explicit_user";
  }
  return { touched: true, schedule: normalizeScheduleInput(next, options), timing_changed: timingChanged };
}

export async function stableCalendarEventId(googleTaskId) {
  const id = String(googleTaskId || "");
  if (!id) throw new Error("google_task_id is required");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `pos${hex.slice(0, 40)}`;
}

export function projectionPrefix(taskStatus, schedulingStatus) {
  if (taskStatus === "completed" || taskStatus === "done") return "✓";
  if (schedulingStatus === "cancelled") return "✕";
  if (schedulingStatus === "rescheduled") return "↪";
  return "☐";
}

function shiftedDateTime(date, time, amount) {
  const result = new Date(`${date}T${time}:00Z`);
  result.setUTCMinutes(result.getUTCMinutes() + amount);
  const value = result.toISOString();
  return { date: value.slice(0, 10), time: value.slice(11, 16) };
}

export function calendarProjectionWindow(schedule) {
  if (schedule?.scheduled_date && schedule?.scheduled_start && schedule?.scheduled_end) {
    return {
      kind: "execution",
      start: { date: schedule.scheduled_date, time: String(schedule.scheduled_start).slice(0, 5) },
      end: { date: schedule.scheduled_date, time: String(schedule.scheduled_end).slice(0, 5) },
    };
  }
  if (schedule?.deadline && schedule?.deadline_time) {
    return {
      kind: "deadline",
      start: { date: schedule.deadline, time: String(schedule.deadline_time).slice(0, 5) },
      end: shiftedDateTime(schedule.deadline, String(schedule.deadline_time).slice(0, 5), 5),
    };
  }
  return null;
}

export function buildCalendarEvent(task, schedule, eventId = "") {
  const normalized = normalizeScheduleInput({
    ...schedule,
    raw_text: task.originalIntent || task.original_intent || schedule.raw_text,
    title: task.title,
    notes: task.notes,
  }, { preserveReminderPolicy: Object.hasOwn(schedule, "reminder_policy") });
  const window = calendarProjectionWindow(normalized);
  if (!window) throw new Error("A Calendar projection requires a scheduled time or an exact deadline time");
  const prefix = projectionPrefix(task.status, normalized.scheduling_status);
  const inactive = normalized.scheduling_status === "cancelled" || task.status === "completed" || task.status === "done";
  const guidance = inactive ? "" : reminderActionGuidance(task, normalized);
  const notificationCue = inactive ? "" : reminderNotificationCue(normalized);
  const reminderReason = normalized.reminder_reason ? `\n提醒依据：${normalized.reminder_reason}` : "";
  const overrides = inactive ? [] : calendarReminderOverrides(normalized);
  return {
    ...(eventId ? { id: eventId } : {}),
    summary: `${prefix} ${String(task.title || "").trim()}${window.kind === "deadline" ? "（截止）" : ""}${notificationCue ? `｜${notificationCue}` : ""}`,
    description: `Personal OS Google Task 的时间投影。任务内容与完成状态以 Google Tasks 为准。${guidance ? `\n行动提示：${guidance}` : ""}${reminderReason}`,
    start: { dateTime: `${window.start.date}T${window.start.time}:00`, timeZone: normalized.timezone },
    end: { dateTime: `${window.end.date}T${window.end.time}:00`, timeZone: normalized.timezone },
    transparency: "opaque",
    colorId: prefix === "✓" ? "10" : prefix === "↪" ? "5" : prefix === "✕" ? "8" : "9",
    reminders: { useDefault: false, overrides },
    extendedProperties: {
      private: {
        googleTaskId: String(task.id || task.google_task_id || ""),
        personalOsProjection: "v1",
        reminderPolicy: normalized.reminder_policy,
      },
    },
  };
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function overlaps(start, end, busy) {
  return busy.some((slot) => start < minutes(slot.end) && end > minutes(slot.start));
}

export function planTaskSlots(tasks, schedules = [], busyByDate = {}, options = {}) {
  const today = options.today;
  if (!validScheduleDate(today)) throw new Error("today must be YYYY-MM-DD");
  const horizonDays = Number.isInteger(options.horizonDays) ? options.horizonDays : 3;
  const dayStart = minutes(options.dayStart || "09:00");
  const dayEnd = minutes(options.dayEnd || "21:00");
  const scheduleByTask = new Map(schedules.map((item) => [item.google_task_id, item]));
  const backlog = [];
  const plans = [];

  const candidates = tasks
    .filter((task) => task.status === "open" || task.status === "needsAction")
    .filter((task) => !scheduleByTask.get(task.id)?.fixed_time)
    .map((task) => ({ task, schedule: scheduleByTask.get(task.id) || null }))
    .filter(({ task, schedule }) => {
      if (schedule?.deadline_time && !schedule?.scheduled_start) return false;
      if (schedule?.scheduled_start && schedule.scheduled_date >= today) return false;
      const due = task.dueDate || task.date || schedule?.deadline || null;
      if (!due) { backlog.push(task.id); return false; }
      return due <= shiftDate(today, horizonDays);
    })
    .sort((left, right) => {
      const lp = PRIORITY_WEIGHT[left.schedule?.priority || left.task.priority || "medium"] || 2;
      const rp = PRIORITY_WEIGHT[right.schedule?.priority || right.task.priority || "medium"] || 2;
      if (lp !== rp) return rp - lp;
      return String(left.task.dueDate || left.task.date || left.schedule?.deadline || "").localeCompare(
        String(right.task.dueDate || right.task.date || right.schedule?.deadline || ""),
      );
    });

  const occupied = new Map(Object.entries(busyByDate).map(([date, slots]) => [date, slots.map((slot) => ({ ...slot }))]));
  for (const { task, schedule } of candidates) {
    const due = task.dueDate || task.date || schedule?.deadline;
    let date = due < today ? today : due;
    const duration = Number(schedule?.duration_minutes || task.durationMinutes || task.duration || 30) || 30;
    let placed = null;
    for (let dayOffset = 0; dayOffset <= horizonDays && !placed; dayOffset += 1) {
      const targetDate = shiftDate(date, dayOffset);
      if (targetDate > shiftDate(today, horizonDays)) break;
      const busy = occupied.get(targetDate) || [];
      for (let start = dayStart; start + duration <= dayEnd; start += 15) {
        const end = start + duration;
        if (overlaps(start, end, busy)) continue;
        placed = { google_task_id: task.id, scheduled_date: targetDate, scheduled_start: timeFromMinutes(start), scheduled_end: timeFromMinutes(end), duration_minutes: duration, scheduling_status: schedule ? "rescheduled" : "scheduled", scheduling_source: schedule ? "rescheduled" : "morning_plan", fixed_time: false, priority: schedule?.priority || task.priority || "medium", deadline: schedule?.deadline || null, deadline_time: schedule?.deadline_time || null, timezone: schedule?.timezone || "Asia/Shanghai", calendar_id: schedule?.calendar_id || "primary" };
        busy.push({ start: placed.scheduled_start, end: placed.scheduled_end });
        occupied.set(targetDate, busy);
        break;
      }
    }
    if (placed) plans.push(placed);
    else backlog.push(task.id);
  }
  return { plans, backlog };
}
