import { validScheduleDate, validScheduleTime } from "./schedule-core.js";

const MARKER = /^\[Personal OS recurrence: ([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})\]$/m;
const KINDS = new Set(["daily", "weekly", "monthly", "yearly"]);
const FREQ_BY_KIND = Object.freeze({ daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" });
const KIND_BY_FREQ = Object.freeze({ DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" });
const DAY_CODES = Object.freeze(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);

// This engine implements Gregorian arithmetic only. Validate before any
// normalization can discard the caller's calendar semantics.
export function assertGregorianRecurrence(input, rawText = "") {
  const fields = input && typeof input === "object" ? Object.entries(input) : [];
  const unsupported = /农历|農曆|阴历|陰曆|\blunar\b/i.test(rawText)
    || (typeof input === "string" && /(?:^|[;:])\s*RSCALE\s*=/i.test(input))
    || fields.some(([key, value]) => /^(?:rscale)$/i.test(key)
      || (/^(?:calendar|calendar_system|calendarSystem)$/i.test(key)
        && !/^(?:gregorian|gregory|solar|公历|阳历)$/i.test(String(value)))
      || (/^(?:rrule|rule)$/i.test(key) && /(?:^|[;:])\s*RSCALE\s*=/i.test(String(value))));
  if (unsupported) {
    const error = new Error("UNSUPPORTED_RECURRENCE_CALENDAR: 农历/RSCALE 暂不支持；原始农历语义未转换为公历，请勿按固定公历日期创建重复事项。");
    error.code = "UNSUPPORTED_RECURRENCE_CALENDAR";
    throw error;
  }
}

function dateParts(value) {
  if (!validScheduleDate(value)) throw new Error("Recurrence date is invalid");
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function isoDate(year, month, day) {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return validScheduleDate(value) ? value : null;
}

function addDays(value, days) {
  const instant = Date.parse(`${value}T12:00:00Z`);
  return new Date(instant + days * 86_400_000).toISOString().slice(0, 10);
}

function addMonths(year, month, amount) {
  const index = year * 12 + (month - 1) + amount;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function parseRRule(value) {
  const text = String(value || "").trim().replace(/^RRULE:/i, "").toUpperCase();
  if (!text) return {};
  const entries = text.split(";").map(part => part.trim().split("="));
  if (entries.some(part => part.length !== 2 || !part[0] || !part[1])
    || new Set(entries.map(part => part[0])).size !== entries.length) throw new Error("RRULE is malformed or repeats a field");
  const parts = Object.fromEntries(entries);
  const allowed = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH"]);
  if (Object.keys(parts).some((key) => !allowed.has(key))) throw new Error("RRULE contains an unsupported part");
  const kind = KIND_BY_FREQ[parts.FREQ];
  if (!kind) throw new Error("RRULE frequency is unsupported");
  const weekday = parts.BYDAY ? DAY_CODES.indexOf(parts.BYDAY) : undefined;
  if (parts.BYDAY && weekday < 0) throw new Error("RRULE weekday is unsupported");
  return {
    kind,
    interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1,
    ...(weekday === undefined ? {} : { weekday }),
    ...(parts.BYMONTHDAY ? { month_day: Number(parts.BYMONTHDAY) } : {}),
    ...(parts.BYMONTH ? { month: Number(parts.BYMONTH) } : {}),
  };
}

export function recurrenceInputFields(input) {
  assertGregorianRecurrence(input);
  try {
    const raw = typeof input === "string"
      ? (/^(?:RRULE:)?FREQ=/i.test(input.trim()) ? parseRRule(input) : { kind: input }) : input || {};
    if (Object.keys(raw).some(key => /^(?:count|until)$/i.test(key))) throw new Error("Count and end date are not supported");
    const ruleKey = Object.keys(raw).find(key => /^rrule$/i.test(key));
    if (!ruleKey) return raw;
    if (!String(raw[ruleKey] || "").trim()) throw new Error("RRULE must not be empty");
    const fields = parseRRule(raw[ruleKey]);
    for (const key of ["kind", "interval", "weekday", "month_day", "month"]) {
      if (raw[key] !== undefined && fields[key] !== undefined && String(raw[key]).toLowerCase() !== String(fields[key]).toLowerCase()) {
        throw new Error("RRULE conflicts with structured recurrence fields");
      }
    }
    if (raw.frequency && String(raw.frequency).toLowerCase() !== fields.kind) throw new Error("RRULE conflicts with recurrence frequency");
    return { ...raw, ...fields };
  } catch (error) {
    error.code = "UNSUPPORTED_RECURRENCE_RULE";
    throw error;
  }
}

export function normalizeRecurrence(input, schedule) {
  const parsed = recurrenceInputFields(input);
  const kind = String(parsed.kind || parsed.frequency || "").toLowerCase();
  if (!KINDS.has(kind)) throw new Error("Recurrence must be daily, weekly, monthly, or yearly");
  const interval = Number(parsed.interval ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new Error("Recurrence interval is invalid");
  if (parsed.count !== undefined || parsed.until !== undefined) throw new Error("Count and end date are not supported");
  const anchorDate = String(schedule?.scheduled_date || parsed.anchor_date || "");
  const timezone = String(schedule?.timezone || parsed.timezone || "");
  if (!validScheduleDate(anchorDate)) throw new Error("A recurring task needs an explicit first date");
  if (!timezone || timezone.length > 80) throw new Error("A recurring task needs a timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date()); }
  catch { throw new Error("Recurrence timezone is invalid"); }
  const localTimeValue = String(schedule?.scheduled_start || parsed.local_time || "").slice(0, 5);
  const localTime = localTimeValue ? (validScheduleTime(localTimeValue) ? localTimeValue : null) : null;
  if (localTimeValue && !localTime) throw new Error("Recurrence local time is invalid");
  const anchor = dateParts(anchorDate);
  const anchorWeekday = new Date(`${anchorDate}T12:00:00Z`).getUTCDay();
  const weekday = Number(parsed.weekday ?? (Array.isArray(parsed.weekdays) ? parsed.weekdays[0] : anchorWeekday));
  if (kind === "weekly" && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || weekday !== anchorWeekday
    || (Array.isArray(parsed.weekdays) && parsed.weekdays.length !== 1))) {
    throw new Error("Weekly recurrence must use the first date's single weekday");
  }
  const monthDay = Number(parsed.month_day ?? parsed.by_month_day ?? anchor.day);
  if ((kind === "monthly" || kind === "yearly") && (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31 || monthDay !== anchor.day)) {
    throw new Error("Monthly day must match the first date");
  }
  const month = Number(parsed.month ?? parsed.by_month ?? anchor.month);
  if (kind === "yearly" && (!Number.isInteger(month) || month < 1 || month > 12 || month !== anchor.month)) {
    throw new Error("Yearly month must match the first date");
  }
  const fields = [`FREQ=${FREQ_BY_KIND[kind]}`];
  if (interval !== 1) fields.push(`INTERVAL=${interval}`);
  if (kind === "weekly") fields.push(`BYDAY=${DAY_CODES[weekday]}`);
  if (kind === "monthly" || kind === "yearly") fields.push(`BYMONTHDAY=${monthDay}`);
  if (kind === "yearly") fields.push(`BYMONTH=${month}`);
  return {
    kind, rrule: fields.join(";"), interval, anchor_date: anchorDate, local_time: localTime, timezone,
    weekday: kind === "weekly" ? weekday : null,
    month_day: kind === "monthly" || kind === "yearly" ? monthDay : null,
    month: kind === "yearly" ? month : null,
  };
}

export function recurrenceRuleFromSeries(series) {
  return {
    kind: String(series?.recurrence_kind || ""),
    rrule: String(series?.rrule || ""),
    interval: Number(series?.recurrence_interval || 1),
    weekday: series?.by_weekday === null || series?.by_weekday === undefined ? undefined : Number(series.by_weekday),
    month_day: series?.by_month_day === null || series?.by_month_day === undefined ? undefined : Number(series.by_month_day),
    month: series?.by_month === null || series?.by_month === undefined ? undefined : Number(series.by_month),
    anchor_date: String(series?.current_date || ""),
    local_time: series?.local_time ? String(series.local_time).slice(0, 5) : null,
    timezone: String(series?.timezone || ""),
  };
}

export function nextRuleDate(currentDate, recurrence) {
  assertGregorianRecurrence(recurrence);
  const rule = typeof recurrence === "string" ? { kind: recurrence } : recurrence || {};
  const kind = String(rule.kind || "");
  const interval = Number(rule.interval || 1);
  if (!KINDS.has(kind) || !Number.isInteger(interval) || interval < 1 || interval > 365) throw new Error("Recurrence rule is unsupported");
  const current = dateParts(currentDate);
  if (kind === "daily") return addDays(currentDate, interval);
  if (kind === "weekly") return addDays(currentDate, interval * 7);
  if (kind === "monthly") {
    const monthDay = Number(rule.month_day || current.day);
    for (let offset = interval, attempt = 0; attempt < 2400; offset += interval, attempt += 1) {
      const candidate = addMonths(current.year, current.month, offset);
      const result = isoDate(candidate.year, candidate.month, monthDay);
      if (result) return result;
    }
  }
  if (kind === "yearly") {
    const month = Number(rule.month || current.month);
    const monthDay = Number(rule.month_day || current.day);
    for (let year = current.year + interval, attempt = 0; attempt < 400; year += interval, attempt += 1) {
      const result = isoDate(year, month, monthDay);
      if (result) return result;
    }
  }
  throw new Error("No future occurrence found");
}

export function localDateInZone(instant, timezone) {
  return localDateTimeInZone(instant, timezone).slice(0, 10);
}

export function localDateTimeInZone(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

export function nextOccurrenceDate(currentDate, recurrence, nowLocal, options = {}) {
  const todayLocal = String(nowLocal).slice(0, 10);
  if (!validScheduleDate(currentDate) || !validScheduleDate(todayLocal) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(nowLocal)) {
    throw new Error("Occurrence clock must be a local YYYY-MM-DDTHH:MM");
  }
  const rule = typeof recurrence === "string" ? { kind: recurrence, interval: options.interval || 1,
    month_day: options.month_day, month: options.month } : recurrence;
  const localTime = String(options.local_time || rule?.local_time || "").slice(0, 5);
  if (localTime && !validScheduleTime(localTime)) throw new Error("Recurrence local time is invalid");
  const offset = Number(options.reminder_offset_minutes ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 40_320) throw new Error("Reminder offset is unsupported");
  let candidate = nextRuleDate(currentDate, rule);
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    if (localTime) {
      const reminderClock = new Date(Date.parse(`${candidate}T${localTime}:00Z`) - offset * 60_000).toISOString().slice(0, 16);
      if (reminderClock > nowLocal) return candidate;
    } else if (candidate >= todayLocal) return candidate;
    candidate = nextRuleDate(candidate, rule);
  }
  throw new Error("No future occurrence found within the supported window");
}

export function openOccurrenceReady(currentDate, recurrence, nowLocal, options = {}) {
  if (!validScheduleDate(currentDate) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(nowLocal)) throw new Error("Occurrence clock is invalid");
  const rule = typeof recurrence === "string" ? { kind: recurrence, interval: options.interval || 1,
    month_day: options.month_day, month: options.month } : recurrence;
  const localTime = String(options.local_time || rule?.local_time || "").slice(0, 5);
  const offset = Number(options.reminder_offset_minutes ?? 0);
  if (localTime && !validScheduleTime(localTime)) throw new Error("Recurrence local time is invalid");
  if (!Number.isInteger(offset) || offset < 0 || offset > 40_320) throw new Error("Reminder offset is unsupported");
  const nextDate = nextRuleDate(currentDate, rule);
  if (!localTime) return nowLocal.slice(0, 10) >= nextDate;
  const reminderClock = new Date(Date.parse(`${nextDate}T${localTime}:00Z`) - offset * 60_000).toISOString().slice(0, 16);
  return nowLocal >= reminderClock;
}

export function recurrenceMarker(seriesId, date) {
  if (!/^[0-9a-f-]{36}$/.test(seriesId) || !validScheduleDate(date)) throw new Error("Recurrence correlation is invalid");
  return `[Personal OS recurrence: ${seriesId}:${date}]`;
}

export function recurrenceKeyFromNotes(notes) {
  const match = String(notes || "").match(MARKER);
  return match ? `${match[1]}:${match[2]}` : null;
}

export function recurrenceLeadMinutes(schedule) {
  const offsets = [schedule?.reminder_offset_minutes, ...(Array.isArray(schedule?.reminders)
    ? schedule.reminders.map((reminder) => reminder?.offset_minutes) : [])]
    .filter((value) => value !== null && value !== undefined);
  const numbers = offsets.map(Number);
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 40_320)) {
    throw new Error("Recurring reminder lead time is unsupported");
  }
  return Math.max(0, ...numbers);
}

export function notesWithRecurrenceMarker(notes, seriesId, date) {
  const marker = recurrenceMarker(seriesId, date);
  const clean = String(notes || "").split("\n").filter((line) => !MARKER.test(line)).join("\n").trim();
  return `${clean}${clean ? "\n\n" : ""}${marker}`;
}

export function occurrenceWriteDecision(claim, matchingTasks) {
  if (!claim?.claimed) return "busy_or_cancelled";
  if (matchingTasks.length > 1) return "duplicate_review";
  if (matchingTasks.length === 1) return "recover_existing";
  return claim.creation_started ? "outcome_unknown" : "create_once";
}

export function recurrenceMaintenanceBatch(rows, slot, limit = 20) {
  if (!Array.isArray(rows) || !Number.isInteger(slot) || slot < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("Invalid recurrence maintenance batch");
  }
  if (!rows.length) return { rows: [], page: 0, pages: 0 };
  const pages = Math.ceil(rows.length / limit);
  const page = slot % pages;
  return { rows: rows.slice(page * limit, (page + 1) * limit), page, pages };
}

export function recurrenceSchedule(currentSchedule, nextDate) {
  if (!validScheduleDate(nextDate)) throw new Error("Next occurrence date is invalid");
  return {
    ...currentSchedule,
    scheduled_date: nextDate,
    deadline: null,
    deadline_time: null,
    scheduling_status: "scheduled",
    scheduling_source: "explicit_user",
    fixed_time: Boolean(currentSchedule.scheduled_start),
    reminder_at: null,
    reminder_offset_minutes: currentSchedule.reminder_offset_minutes ?? null,
  };
}
