# Calendar Developer MCP recovery

Date: 2026-09-08

## WHY

The Google Calendar connector could be visible while its search/update calls failed with `FORBIDDEN: This conversation is restricted to developer MCPs`. OpenAI's runtime, connector action permissions, service OAuth and local command sandbox are separate controls. Repository code cannot weaken the active conversation's platform policy.

## GOAL

Let the existing Personal OS Developer MCP read existing Google Calendar events and update an exact event in place through the already-authorized Google account. Keep Google Tasks as Task truth and avoid duplicate Calendar events.

## IMPLEMENTATION

Strategy: `EXTEND` the existing Personal OS MCP and `task-scheduler`. The new tools are `search_calendar_events`, `get_calendar_event` and `update_calendar_event`. The update path requires the latest `updated` timestamp, sends the current ETag with `If-Match`, PATCHes the exact event path, then reads that same ID back. No create-event tool is exposed. Calendar events marked as Personal OS Task projections are rejected and must use the Task lifecycle.

## TEST

Initial Calendar MCP recovery validation was 333 total, 331 passed, 0 failed, with 2 existing optional browser tests skipped. Regression hardening after diff review is 339 total, 337 passed, 0 failed, with the same 2 skips; the focused suite is 22/22.

The update runtime now fails closed with `CALENDAR_EVENT_ETAG_REQUIRED` before PATCH when Google GET omits an ETag. Search accepts at most 366 inclusive Shanghai calendar days: 2026-01-01 through 2027-01-01 is accepted, while the additional day through 2027-01-02 is rejected.

Task projection reconciliation compares Google Task due with the active Calendar anchor. An execution projection with `due != scheduled_date`, or a deadline-only projection with `due != deadline`, does not PATCH Calendar and remains `sync_required=true` unless provenance is explicit: `deadline == due` for execution before a deadline, or a genuine `morning_plan`. This rule covers the observed 2026-09-09 vs 2026-09-05 rescheduled row and 2026-09-08 vs 2026-09-06 inferred/unscheduled row even when an earlier incorrect sync made `last_synced_at` newer. Aligned backlog/unscheduled rows return `NO_TIME` and do not enter Calendar projection. A notes-only Google Task update remains successful but surfaces the pending projection as `projection_error`.

## RESULT

Local implementation is ready for a narrow deployment of the existing `google-tasks` and `task-scheduler` functions only. No migration or unrelated function is required. The official Supabase CLI is available, but its saved management profile is currently missing; local checks do not establish deployment. Production acceptance must be read-only or use a dedicated synthetic fixture. Real travel events and the two observed date-conflict Tasks must not be modified.
