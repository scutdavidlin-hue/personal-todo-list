import test from "node:test";
import assert from "node:assert/strict";

import {
  CalendarEventRuntimeError,
  updateCalendarEventInPlace,
} from "../supabase/functions/_shared/calendar-events-runtime.js";

function event(overrides = {}) {
  return {
    id: "event-1",
    etag: '"etag-1"',
    updated: "2026-09-08T01:00:00Z",
    eventType: "default",
    summary: "专用合成验收行程",
    start: { dateTime: "2026-09-09T10:00:00+08:00", timeZone: "Asia/Shanghai" },
    end: { dateTime: "2026-09-09T11:00:00+08:00", timeZone: "Asia/Shanghai" },
    ...overrides,
  };
}

test("runtime performs exact GET, conditional PATCH and readback on the authorized owner", async () => {
  const calls = [];
  let stored = event();
  const adapter = {
    async getEvent(identity) { calls.push(["get", identity]); return structuredClone(stored); },
    async patchEvent(request) {
      calls.push(["patch", request]);
      assert.equal(request.etag, '"etag-1"');
      stored = { ...stored, ...request.patch, updated: "2026-09-08T01:01:00Z", etag: '"etag-2"' };
      return structuredClone(stored);
    },
  };
  const result = await updateCalendarEventInPlace({
    ownerId: "authorized-owner",
    calendarId: "primary",
    eventId: "event-1",
    expectedUpdated: "2026-09-08T01:00:00Z",
    changes: { location: "机场" },
  }, adapter);
  assert.deepEqual(calls.map(([method]) => method), ["get", "patch", "get"]);
  assert.ok(calls.every(([, identity]) => identity.ownerId === "authorized-owner"));
  assert.ok(calls.every(([, identity]) => identity.eventId === "event-1"));
  assert.equal(result.readback.id, "event-1");
  assert.equal(result.readback.location, "机场");
});

test("stale updated timestamp prevents PATCH", async () => {
  let patchCalls = 0;
  const adapter = {
    async getEvent() { return event({ updated: "newer" }); },
    async patchEvent() { patchCalls += 1; },
  };
  await assert.rejects(
    updateCalendarEventInPlace({ ownerId: "owner", calendarId: "primary", eventId: "event-1", expectedUpdated: "older", changes: { location: "机场" } }, adapter),
    (error) => error instanceof CalendarEventRuntimeError && error.code === "CALENDAR_EVENT_CHANGED",
  );
  assert.equal(patchCalls, 0);
});

test("missing ETag fails closed before PATCH", async () => {
  let patchCalls = 0;
  const adapter = {
    async getEvent() { return event({ etag: "" }); },
    async patchEvent() { patchCalls += 1; },
  };
  await assert.rejects(
    updateCalendarEventInPlace({ ownerId: "owner", calendarId: "primary", eventId: "event-1", expectedUpdated: "2026-09-08T01:00:00Z", changes: { location: "机场" } }, adapter),
    (error) => error instanceof CalendarEventRuntimeError && error.code === "CALENDAR_EVENT_ETAG_REQUIRED",
  );
  assert.equal(patchCalls, 0);
});

test("Task projection protection prevents direct Calendar mutation", async () => {
  let patchCalls = 0;
  const adapter = {
    async getEvent() { return event({ extendedProperties: { private: { googleTaskId: "task-1", personalOsProjection: "v1" } } }); },
    async patchEvent() { patchCalls += 1; },
  };
  await assert.rejects(
    updateCalendarEventInPlace({ ownerId: "owner", calendarId: "primary", eventId: "event-1", expectedUpdated: "2026-09-08T01:00:00Z", changes: { summary: "错误路径" } }, adapter),
    (error) => error instanceof CalendarEventRuntimeError && error.code === "PERSONAL_OS_PROJECTION_REQUIRES_TASK_UPDATE",
  );
  assert.equal(patchCalls, 0);
});

test("different event id in PATCH or readback fails verification", async () => {
  for (const failureAt of ["patch", "readback"]) {
    let reads = 0;
    const adapter = {
      async getEvent() { reads += 1; return reads === 2 && failureAt === "readback" ? event({ id: "event-2" }) : event(); },
      async patchEvent() { return failureAt === "patch" ? event({ id: "event-2" }) : event({ location: "机场" }); },
    };
    await assert.rejects(
      updateCalendarEventInPlace({ ownerId: "owner", calendarId: "primary", eventId: "event-1", expectedUpdated: "2026-09-08T01:00:00Z", changes: { location: "机场" } }, adapter),
      (error) => error instanceof CalendarEventRuntimeError && ["CALENDAR_EVENT_IDENTITY_CHANGED", "CALENDAR_UPDATE_UNVERIFIED"].includes(error.code),
    );
  }
});
