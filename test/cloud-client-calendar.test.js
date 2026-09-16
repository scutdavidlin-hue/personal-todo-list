import test from "node:test";
import assert from "node:assert/strict";
import { CloudError, TaskCloudClient } from "../src/cloud-client.js";

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function authenticatedStorage() {
  return new MemoryStorage({
    "task-sync-auth-session-v1": JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
}

const config = {
  supabaseUrl: "https://example-project.supabase.co",
  supabaseAnonKey: "public-anon-key-longer-than-twenty-characters",
};

test("listCalendarEvents recursively splits truncated ranges and deduplicates cross-day events", async () => {
  let request;
  const requests = [];
  const event = {
    id: "event-1",
    calendar_id: "primary",
    summary: "上海会议",
    start: { dateTime: "2026-09-20T09:00:00+08:00", timeZone: "Asia/Shanghai" },
    end: { dateTime: "2026-09-20T10:00:00+08:00", timeZone: "Asia/Shanghai" },
    updated: "2026-09-16T01:00:00.000Z",
    personal_os_projection: false,
  };
  const client = new TaskCloudClient(config, {
    storage: authenticatedStorage(),
    fetch: async (url, init) => {
      request = { url, method: init.method, body: JSON.parse(init.body) };
      requests.push(request.body);
      if (request.body.date_from === "2026-09-01" && request.body.date_to === "2026-09-30") {
        return response({
          success: true,
          calendar_id: "primary",
          date_from: "2026-09-01",
          date_to: "2026-09-30",
          count: 100,
          events: [],
          next_page_token: "parent-page-token",
        });
      }
      return response({
        success: true,
        calendar_id: "primary",
        date_from: request.body.date_from,
        date_to: request.body.date_to,
        count: 1,
        events: [event],
        next_page_token: null,
      });
    },
  });

  const page = await client.listCalendarEvents({
    dateFrom: "2026-09-01",
    dateTo: "2026-09-30",
    query: "会议",
    limit: 100,
  });

  assert.match(request.url, /\/functions\/v1\/task-scheduler$/);
  assert.equal(request.method, "POST");
  assert.deepEqual(requests[0], {
    action: "search_calendar_events",
    calendar_id: "primary",
    date_from: "2026-09-01",
    date_to: "2026-09-30",
    query: "会议",
    limit: 100,
  });
  assert.deepEqual(requests.slice(1).map(({ date_from, date_to }) => [date_from, date_to]), [
    ["2026-09-01", "2026-09-15"],
    ["2026-09-16", "2026-09-30"],
  ]);
  assert.deepEqual(page, {
    calendarId: "primary",
    dateFrom: "2026-09-01",
    dateTo: "2026-09-30",
    count: 1,
    events: [event],
    nextPageToken: null,
    hasMore: false,
    isComplete: true,
    pageTokenPaginationSupported: false,
    paginationStrategy: "range_split",
    incompleteDates: [],
  });
  assert.equal(page.events[0].start.timeZone, "Asia/Shanghai");
});

test("listCalendarEvents reports an incomplete single day that still exceeds the API page limit", async () => {
  let body;
  const client = new TaskCloudClient(config, {
    storage: authenticatedStorage(),
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return response({
        success: true,
        calendar_id: "primary",
        date_from: "2026-09-20",
        date_to: "2026-09-20",
        count: 100,
        events: [{ id: "event-1" }],
        next_page_token: "unconsumable-token",
      });
    },
  });

  const page = await client.listCalendarEvents({ dateFrom: "2026-09-20", dateTo: "2026-09-20" });
  assert.equal(body.limit, 100);
  assert.equal(page.isComplete, false);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextPageToken, "unconsumable-token");
  assert.deepEqual(page.incompleteDates, ["2026-09-20"]);
});

test("getCalendarEvent reads an exact event from the selected calendar", async () => {
  let body;
  const event = { id: "event/a?b", calendar_id: "team@group.calendar.google.com", summary: "评审" };
  const client = new TaskCloudClient(config, {
    storage: authenticatedStorage(),
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return response({ success: true, event });
    },
  });

  assert.deepEqual(
    await client.getCalendarEvent("event/a?b", { calendarId: "team@group.calendar.google.com" }),
    event,
  );
  assert.deepEqual(body, {
    action: "get_calendar_event",
    calendar_id: "team@group.calendar.google.com",
    event_id: "event/a?b",
  });
});

test("updateCalendarEvent performs an optimistic in-place update with explicit timezone", async () => {
  let body;
  const updated = {
    id: "event-1",
    updated: "2026-09-16T02:00:00.000Z",
    start: { dateTime: "2026-09-20T11:00:00+08:00", timeZone: "Asia/Shanghai" },
    end: { dateTime: "2026-09-20T12:00:00+08:00", timeZone: "Asia/Shanghai" },
  };
  const client = new TaskCloudClient(config, {
    storage: authenticatedStorage(),
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return response({
        success: true,
        event: updated,
        event_id: "event-1",
        event_id_unchanged: true,
        calendar_event_count_delta: 0,
        verified: true,
      });
    },
  });

  const result = await client.updateCalendarEvent("event-1", {
    start: "2026-09-20T11:00:00+08:00",
    end: "2026-09-20T12:00:00+08:00",
    timezone: "Asia/Shanghai",
  }, {
    expectedUpdated: "2026-09-16T01:00:00.000Z",
  });

  assert.deepEqual(body, {
    action: "update_calendar_event",
    calendar_id: "primary",
    event_id: "event-1",
    expected_updated: "2026-09-16T01:00:00.000Z",
    start: "2026-09-20T11:00:00+08:00",
    end: "2026-09-20T12:00:00+08:00",
    timezone: "Asia/Shanghai",
  });
  assert.equal(result.verified, true);
  assert.equal(result.event_id_unchanged, true);
  assert.equal(result.calendar_event_count_delta, 0);
});

test("updateCalendarEvent refuses stale-blind and task-projection writes before network access", async () => {
  let requests = 0;
  const client = new TaskCloudClient(config, {
    storage: authenticatedStorage(),
    fetch: async () => { requests += 1; return response({ success: true }); },
  });

  await assert.rejects(
    () => client.updateCalendarEvent("event-1", { summary: "缺少版本" }),
    (error) => error instanceof CloudError && error.code === "INVALID_CALENDAR_EVENT" && error.status === 400,
  );
  await assert.rejects(
    () => client.updateCalendarEvent("task-event", {
      summary: "错误路径",
      expected_updated: "2026-09-16T01:00:00.000Z",
      personal_os_projection: true,
    }),
    (error) => error instanceof CloudError
      && error.code === "PERSONAL_OS_PROJECTION_REQUIRES_TASK_UPDATE"
      && error.status === 409,
  );
  assert.equal(requests, 0);
});

test("unsupported Calendar create/delete never invent a second mutation path", async () => {
  let requests = 0;
  const client = new TaskCloudClient(config, {
    storage: authenticatedStorage(),
    fetch: async () => { requests += 1; return response({ success: true }); },
  });

  await assert.rejects(
    () => client.createCalendarEvent({ summary: "新行程" }),
    (error) => error instanceof CloudError && error.code === "CALENDAR_MUTATION_UNSUPPORTED" && error.status === 405,
  );
  await assert.rejects(
    () => client.deleteCalendarEvent("event-1"),
    (error) => error instanceof CloudError && error.code === "CALENDAR_MUTATION_UNSUPPORTED" && error.status === 405,
  );
  await assert.rejects(
    () => client.deleteCalendarEvent("task-event", { personal_os_projection: true }),
    (error) => error instanceof CloudError && error.code === "PERSONAL_OS_PROJECTION_REQUIRES_TASK_UPDATE",
  );
  assert.equal(requests, 0);
});

test("Calendar access and backend concurrency errors retain actionable CloudError codes", async () => {
  const signedOut = new TaskCloudClient(config, {
    storage: new MemoryStorage(),
    fetch: async () => response({ success: true }),
  });
  await assert.rejects(
    () => signedOut.listCalendarEvents({ dateFrom: "2026-09-01", dateTo: "2026-09-30" }),
    (error) => error instanceof CloudError && error.code === "AUTH_REQUIRED" && error.status === 401,
  );

  const stale = new TaskCloudClient(config, {
    storage: authenticatedStorage(),
    fetch: async () => response({
      success: false,
      code: "CALENDAR_EVENT_CHANGED",
      error: "Calendar event changed after it was read; search again before updating",
    }, 409),
  });
  await assert.rejects(
    () => stale.updateCalendarEvent("event-1", { summary: "新标题" }, { expectedUpdated: "old" }),
    (error) => error instanceof CloudError && error.code === "CALENDAR_EVENT_CHANGED" && error.status === 409,
  );
});

test("Calendar reads and writes fail closed when the backend cannot verify the same event identity", async () => {
  const wrongRead = new TaskCloudClient(config, {
    storage: authenticatedStorage(),
    fetch: async () => response({ success: true, event: { id: "different-event" } }),
  });
  await assert.rejects(
    () => wrongRead.getCalendarEvent("event-1"),
    (error) => error instanceof CloudError && error.code === "CALENDAR_EVENT_IDENTITY_CHANGED",
  );

  const unverifiedUpdate = new TaskCloudClient(config, {
    storage: authenticatedStorage(),
    fetch: async () => response({
      success: true,
      event: { id: "event-1" },
      event_id: "event-1",
      event_id_unchanged: true,
      calendar_event_count_delta: 0,
      verified: false,
    }),
  });
  await assert.rejects(
    () => unverifiedUpdate.updateCalendarEvent("event-1", { summary: "新标题" }, { expectedUpdated: "current" }),
    (error) => error instanceof CloudError && error.code === "CALENDAR_UPDATE_UNVERIFIED" && error.status === 502,
  );
});
