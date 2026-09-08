import {
  buildCalendarEventPatch,
  isPersonalOsProjection,
  verifyCalendarEventPatch,
} from "./calendar-events-core.js";

export class CalendarEventRuntimeError extends Error {
  constructor(message, code, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function updateCalendarEventInPlace({ ownerId, calendarId, eventId, expectedUpdated, changes }, adapter) {
  if (!ownerId || !calendarId || !eventId || !expectedUpdated) {
    throw new CalendarEventRuntimeError("ownerId, calendarId, eventId and expectedUpdated are required", "INVALID_CALENDAR_EVENT", 400);
  }
  const identity = { ownerId, calendarId, eventId };
  const current = await adapter.getEvent(identity);
  if (!current || current.id !== eventId) {
    throw new CalendarEventRuntimeError("Calendar event identity did not match the requested event", "CALENDAR_EVENT_IDENTITY_CHANGED", 409);
  }
  if (String(current.updated || "") !== expectedUpdated) {
    throw new CalendarEventRuntimeError("Calendar event changed after it was read; search again before updating", "CALENDAR_EVENT_CHANGED", 409);
  }
  if (!String(current.etag || "").trim()) {
    throw new CalendarEventRuntimeError("Calendar event has no ETag; refusing an update without concurrency protection", "CALENDAR_EVENT_ETAG_REQUIRED", 409);
  }
  if (isPersonalOsProjection(current)) {
    throw new CalendarEventRuntimeError("This Calendar event is a Personal OS Task projection; update the original Google Task instead", "PERSONAL_OS_PROJECTION_REQUIRES_TASK_UPDATE", 409);
  }

  let patch;
  try { patch = buildCalendarEventPatch(current, changes); }
  catch (error) {
    throw new CalendarEventRuntimeError(error instanceof Error ? error.message : "Invalid Calendar update", "INVALID_CALENDAR_UPDATE", 400);
  }
  const updated = await adapter.patchEvent({ ...identity, patch, etag: String(current.etag) });
  if (!updated || updated.id !== eventId) {
    throw new CalendarEventRuntimeError("Calendar event identity changed during update", "CALENDAR_EVENT_IDENTITY_CHANGED", 409);
  }
  const readback = await adapter.getEvent(identity);
  if (!verifyCalendarEventPatch(current, readback, patch)) {
    throw new CalendarEventRuntimeError("Calendar event update could not be verified", "CALENDAR_UPDATE_UNVERIFIED", 503);
  }
  return { current, updated, readback, patch };
}
