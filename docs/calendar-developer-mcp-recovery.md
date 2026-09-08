# Calendar Developer MCP recovery

Date: 2026-09-08

## WHY

The Google Calendar connector could be visible while its search/update calls failed with `FORBIDDEN: This conversation is restricted to developer MCPs`. OpenAI's runtime, connector action permissions, service OAuth and local command sandbox are separate controls. Repository code cannot weaken the active conversation's platform policy.

## GOAL

Let the existing Personal OS Developer MCP read existing Google Calendar events and update an exact event in place through the already-authorized Google account. Keep Google Tasks as Task truth and avoid duplicate Calendar events.

## IMPLEMENTATION

Strategy: `EXTEND` the existing Personal OS MCP and `task-scheduler`. The new tools are `search_calendar_events`, `get_calendar_event` and `update_calendar_event`. The update path requires the latest `updated` timestamp, sends the current ETag with `If-Match`, PATCHes the exact event path, then reads that same ID back. No create-event tool is exposed. Calendar events marked as Personal OS Task projections are rejected and must use the Task lifecycle.

## TEST

`npm run verify`: 333 total, 331 passed, 0 failed, 2 existing optional browser tests skipped. The runtime test simulates Google GET → conditional PATCH → GET and verifies owner binding, exact event identity, stale-write rejection, Task projection protection and failed readback. Production read/update acceptance is tracked separately.

## RESULT

Local implementation is ready for the existing two-function deployment. A real modification is accepted only when a dedicated synthetic event is identified; real travel events are out of scope for test mutation.
