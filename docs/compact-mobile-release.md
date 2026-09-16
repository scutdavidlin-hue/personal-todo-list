# Compact mobile release

## WHY
The approved prototype prioritizes monthly planning, continuous task lists and compact iPhone delivery before further feature expansion.

## GOAL
Extend the existing Personal OS app with Today / Calendar / Tasks / Plans, preserving Google Tasks as the sole task content and completion source, Calendar as projection and existing Goals data.

## ACCEPTANCE CRITERIA
- Monthly 7-column grid; prior/next month; selected-day agenda; same-ID event edit.
- Task title/date open existing editor; today/tomorrow/day-after/week/no-date shortcuts; continuous previous/today/future/no-date groups.
- Short/medium/long plan sections visible together.
- Existing login, intake/conversation, schedules, goal links and review retained.
- Existing iPhone entry upgrades through cache release; legacy today URL forwards preserving OAuth return data.
- No seed data, migrations, new task store or new service.

## IMPLEMENTATION
Strategy EXTEND: reuse TaskCloudClient, task-scheduler calendar event actions and task lifecycle; compact presentation override; calendar view module. Calendar updates use concurrency token and server readback, task projections route to original Task via schedule event ID. Unsupported standalone event create/delete are not offered. Default calendar is the existing primary calendar; times are explicitly Shanghai time.

## TEST
Repository npm run verify; new calendar range, timezone, projection deduplication and client verification tests. Manual browser checks and production readback recorded separately. Unit checks cannot establish iPhone acceptance.

## RESULT
Implementation staged for release. Production deployment and iPhone acceptance pending.
