const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function validDate(value) {
  if (!DATE_PATTERN.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validOffsetDateTime(value) {
  return OFFSET_DATE_TIME_PATTERN.test(String(value || "")) && !Number.isNaN(Date.parse(value));
}

function stringValue(value, name, maxLength, { nullable = false } = {}) {
  if (value === null && nullable) return "";
  const result = String(value || "").trim();
  if (!result || result.length > maxLength) throw new Error(`${name} must contain 1-${maxLength} characters`);
  return result;
}

export function normalizeCalendarSearchInput(input = {}, defaults = {}) {
  const dateFrom = String(input.date_from || defaults.date_from || "");
  const dateTo = String(input.date_to || defaults.date_to || "");
  if (!validDate(dateFrom) || !validDate(dateTo)) throw new Error("date_from and date_to must be valid YYYY-MM-DD dates");
  if (dateTo < dateFrom) throw new Error("date_to must not be earlier than date_from");
  const windowDays = Math.round((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000);
  if (windowDays > 366) throw new Error("Calendar search window must not exceed 366 days");
  const limit = Number(input.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100");
  const query = input.query === undefined ? "" : String(input.query).trim();
  if (query.length > 500) throw new Error("query must not exceed 500 characters");
  return {
    calendar_id: stringValue(input.calendar_id || "primary", "calendar_id", 200),
    date_from: dateFrom,
    date_to: dateTo,
    query,
    limit,
  };
}

export function calendarSearchParameters(input) {
  const params = new URLSearchParams({
    timeMin: `${input.date_from}T00:00:00+08:00`,
    timeMax: `${shiftDate(input.date_to, 1)}T00:00:00+08:00`,
    timeZone: "Asia/Shanghai",
    singleEvents: "true",
    orderBy: "startTime",
    showDeleted: "false",
    maxResults: String(input.limit),
  });
  if (input.query) params.set("q", input.query);
  return params;
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function isPersonalOsProjection(event) {
  const metadata = event?.extendedProperties?.private || {};
  return Boolean(metadata.googleTaskId || metadata.personalOsProjection);
}

export function calendarEventView(event, calendarId = "primary") {
  return {
    id: String(event?.id || ""),
    calendar_id: String(calendarId || "primary"),
    summary: String(event?.summary || ""),
    description: String(event?.description || ""),
    location: String(event?.location || ""),
    start: event?.start || null,
    end: event?.end || null,
    status: String(event?.status || ""),
    updated: String(event?.updated || ""),
    etag: String(event?.etag || ""),
    html_link: String(event?.htmlLink || ""),
    event_type: String(event?.eventType || "default"),
    personal_os_projection: isPersonalOsProjection(event),
  };
}

export function buildCalendarEventPatch(current, input = {}) {
  if (!current?.id) throw new Error("Existing Calendar event is required");
  if (current.status === "cancelled") throw new Error("Cancelled Calendar event cannot be updated");
  if (isPersonalOsProjection(current)) throw new Error("Personal OS task projections must be updated through the original Google Task");
  if (current.eventType && current.eventType !== "default") throw new Error("Only standard Calendar events can be updated through Personal OS");

  const patch = {};
  if (Object.hasOwn(input, "summary")) patch.summary = stringValue(input.summary, "summary", 1000);
  if (Object.hasOwn(input, "description")) patch.description = stringValue(input.description, "description", 8_000, { nullable: true });
  if (Object.hasOwn(input, "location")) patch.location = stringValue(input.location, "location", 1_000, { nullable: true });

  const hasStart = Object.hasOwn(input, "start");
  const hasEnd = Object.hasOwn(input, "end");
  const hasStartDate = Object.hasOwn(input, "start_date");
  const hasEndDate = Object.hasOwn(input, "end_date");
  if (hasStart !== hasEnd) throw new Error("start and end must be supplied together");
  if (hasStartDate !== hasEndDate) throw new Error("start_date and end_date must be supplied together");
  if ((hasStart || hasEnd) && (hasStartDate || hasEndDate)) throw new Error("Use timed start/end or all-day start_date/end_date, not both");

  if (hasStart) {
    const start = String(input.start || "");
    const end = String(input.end || "");
    if (!validOffsetDateTime(start) || !validOffsetDateTime(end)) throw new Error("start and end must be RFC3339 date-times with a timezone offset");
    if (Date.parse(end) <= Date.parse(start)) throw new Error("end must be later than start");
    const timeZone = String(input.timezone || current.start?.timeZone || current.end?.timeZone || "Asia/Shanghai");
    patch.start = { dateTime: start, timeZone };
    patch.end = { dateTime: end, timeZone };
  }
  if (hasStartDate) {
    const startDate = String(input.start_date || "");
    const endDate = String(input.end_date || "");
    if (!validDate(startDate) || !validDate(endDate)) throw new Error("start_date and end_date must be valid YYYY-MM-DD dates");
    if (endDate <= startDate) throw new Error("All-day end_date is exclusive and must be later than start_date");
    patch.start = { date: startDate };
    patch.end = { date: endDate };
  }
  if (!Object.keys(patch).length) throw new Error("At least one Calendar event field must be changed");
  return patch;
}

export function verifyCalendarEventPatch(before, after, patch) {
  if (!before?.id || after?.id !== before.id) return false;
  return Object.entries(patch).every(([key, value]) => JSON.stringify(after?.[key]) === JSON.stringify(value));
}
