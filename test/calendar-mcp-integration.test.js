import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mcpPath = new URL("../supabase/functions/personal-os-mcp/index.ts", import.meta.url);
const schedulerPath = new URL("../supabase/functions/task-scheduler/index.ts", import.meta.url);

test("Personal OS MCP exposes bounded Calendar reads and in-place update only", async () => {
  const mcp = await readFile(mcpPath, "utf8");
  for (const tool of ["search_calendar_events", "get_calendar_event", "update_calendar_event"]) {
    assert.match(mcp, new RegExp(`\\"${tool}\\"`));
    assert.match(mcp, new RegExp(`${tool}: Calendar`));
  }
  assert.match(mcp, /calendar_event_count_delta=0/);
  assert.match(mcp, /expected_updated from the read result/);
  assert.doesNotMatch(mcp, /create_calendar_event/);
  const schemas = mcp.slice(mcp.indexOf("const CalendarSearchInput"), mcp.indexOf("const UnifiedIntakeInput"));
  assert.doesNotMatch(schemas, /owner_id|ownerId/);
});

test("Calendar actions bind to the request-authorized owner and exact event id", async () => {
  const scheduler = await readFile(schedulerPath, "utf8");
  assert.match(scheduler, /const ownerId = await ownerForRequest\(request\)/);
  assert.match(scheduler, /updateCalendarEvent\(ownerId, input\)/);
  assert.match(scheduler, /updateCalendarEventInPlace\(\{ ownerId, calendarId, eventId, expectedUpdated, changes: input \}/);
  assert.match(scheduler, /calendarEventPath\(calendarId, eventId\)/);
  assert.match(scheduler, /"If-Match": etag/);
});
