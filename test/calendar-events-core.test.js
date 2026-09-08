import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCalendarEventPatch,
  calendarEventView,
  calendarSearchParameters,
  isPersonalOsProjection,
  normalizeCalendarSearchInput,
  verifyCalendarEventPatch,
} from "../supabase/functions/_shared/calendar-events-core.js";

test("Calendar search is bounded and uses the inclusive Shanghai date window", () => {
  const input = normalizeCalendarSearchInput({ date_from: "2026-09-08", date_to: "2026-09-10", query: "哈尔滨", limit: 20 });
  const params = calendarSearchParameters(input);
  assert.equal(params.get("timeMin"), "2026-09-08T00:00:00+08:00");
  assert.equal(params.get("timeMax"), "2026-09-11T00:00:00+08:00");
  assert.equal(params.get("q"), "哈尔滨");
  const maximum = normalizeCalendarSearchInput({ date_from: "2026-01-01", date_to: "2027-01-01" });
  assert.equal(calendarSearchParameters(maximum).get("timeMax"), "2027-01-02T00:00:00+08:00");
  assert.throws(() => normalizeCalendarSearchInput({ date_from: "2026-01-01", date_to: "2027-01-02" }), /366 days/);
});

test("Calendar event patch updates an existing timed event without changing identity", () => {
  const current = {
    id: "event-1",
    etag: '"v1"',
    eventType: "default",
    summary: "哈尔滨行程",
    start: { dateTime: "2026-09-09T10:00:00+08:00", timeZone: "Asia/Shanghai" },
    end: { dateTime: "2026-09-09T11:00:00+08:00", timeZone: "Asia/Shanghai" },
  };
  const patch = buildCalendarEventPatch(current, {
    summary: "哈尔滨行程（更新）",
    start: "2026-09-09T11:00:00+08:00",
    end: "2026-09-09T12:00:00+08:00",
  });
  const updated = { ...current, ...patch, updated: "2026-09-08T10:00:00Z" };
  assert.equal(patch.summary, "哈尔滨行程（更新）");
  assert.equal(verifyCalendarEventPatch(current, updated, patch), true);
  assert.equal(calendarEventView(updated).id, "event-1");
});

test("Calendar update refuses Task projections and incomplete time changes", () => {
  const projection = { id: "pos-event", eventType: "default", extendedProperties: { private: { googleTaskId: "task-1", personalOsProjection: "v1" } } };
  assert.equal(isPersonalOsProjection(projection), true);
  assert.throws(() => buildCalendarEventPatch(projection, { summary: "wrong path" }), /original Google Task/);
  assert.throws(() => buildCalendarEventPatch({ id: "event-1", eventType: "default" }, { start: "2026-09-09T11:00:00+08:00" }), /supplied together/);
});

test("Calendar verification fails if Google returns another event id or different values", () => {
  const before = { id: "event-1" };
  const patch = { location: "机场" };
  assert.equal(verifyCalendarEventPatch(before, { id: "event-2", location: "机场" }, patch), false);
  assert.equal(verifyCalendarEventPatch(before, { id: "event-1", location: "酒店" }, patch), false);
});
