# Date-only create investigation — reproduction, no parser change

2026-10-14. Independent branch: `investigate/date-only-create-20261014`.
Base: `bb240517727a81ca89059985295b7c9da144403b`, matching the baseline branch
head at this check. This is a source snapshot, not verified deployed-bundle
identity. The PR #7 worktree remains clean at
`48fe9319fa45af19741e3deff38a47c885ed7c2f` and is not edited.

## Ownership and confirmed defects

This repository does own the relevant creation path:
`personal-os-mcp.createTask → personal-os-intake → evaluateAutonomy →
normalizeIntake → isMissed → task-status`.

Three independent defects are reproduced in that source:

1. **Explicit due can be replaced by today.** MCP forwards `due` unchanged
   (`personal-os-mcp/index.ts:840`) and `requested_date` separately. Autonomy calls
   `requestedDate(actionText, source.requested_date, ...)` at
   `_shared/autonomy-policy.js:385`; the helper at line 225 never considers
   `source.due`. If the raw wording is a month-start window or has no exact date,
   it falls back to today. `normalizeIntake` prioritizes this injected
   requested_date over the original due and uses that firstDate as the dispatched
   due. Direct normalization without autonomy preserves the supplied date.
2. **Quantity words become execution clocks.**
   `_shared/autonomy-policy.js:31` uses an unanchored Chinese-number-plus-点
   pattern. “整理一点虚构资料” becomes 01:00; “列出两点虚构说明” becomes
   02:00; “提前一点准备” also becomes 01:00. No clock context or explicit
   no-clock intent is required. The supplied null requested_time is overwritten
   at line 388. A genuine “下午一点” still correctly yields 13:00.
3. **none can be rejected as a missed reminder.**
   `_shared/request-recovery.js:52` never checks reminder_policy/actual reminder
   existence. With reminder_at null and reminders empty, it falls back to
   scheduled_start/requested_time (line 60) and returns missed. The actual intake
   handler rejects before Task dispatch at `personal-os-intake/index.ts:779`.
   This turns a spurious execution clock into REMINDER_MISSED despite none.

The month-start wording is not an ISO/exact day parser match. With an explicit
November 1 anchor it must retain that anchor and not introduce a clock. Without
an anchor, it currently collapses to today; how to resolve or preserve that
future window is a separate precision decision, not permission to invent 01:00.

## Actual-code simulation

Run `node scripts/reproduce-date-only-create.mjs`. It uses a fixed
`2026-10-14T06:00:00Z` clock (14:00 Shanghai), a fictitious title and none policy.
It executes the actual MCP gateway functions with TypeScript stripped and the
actual intake handler using the repository's established simulated harness.
Hono/Zod gateway initialization is not exercised. Every provider fetch and
environment lookup in the intake handler is replaced with synthetic adapters;
unexpected destinations throw. No production endpoint or protected access path
is called, and there are no real Task writes or credentials/APNs operations.

| Synthetic input | Normalized state | Actual handler against mocks |
| --- | --- | --- |
| due=11/1 only; “11月初整理一点虚构资料，无时刻，不要弹窗” | Today 10/14, 01:00, none, no actual reminders | REMINDER_MISSED; zero simulated Task creates |
| due=11/1 only; clockless reconfirmation | Today 10/14, no clock, none | request_verified; one simulated create with due 10/14 |
| due=requested_date=11/1; same quantity wording | 11/1, spurious 01:00, none | One simulated create dated 11/1; not missed at the fixed clock |
| due=requested_date=11/1; precise date-only wording | 11/1, no clock, none | One simulated create dated 11/1 |

Machine-readable capture: `docs/date-only-create-reproduction.json`. All record
identities and wording are fictitious. The original production request ID and
user Task details are intentionally absent.

## Regression status

The original baseline verification passed: 513 tests, 511 passed, two existing
skips, zero failures. New desired-behavior assertions in
`test/date-only-create-regression.test.js` produce **11 tests: four pass, seven
fail** on this unchanged baseline. These are deliberately red investigation
regressions, not a fix or a passing acceptance result. They distinguish explicit
due-only, requested_date-only, matching fields, ISO date, anchored/unanchored
month-start windows, quantity words, no clock, none policy and genuine 13:00.
Consequently full verify including these new tests is expected to fail until
the bounded repair is implemented. The production parser has not been edited.

## Repair scope and incident attribution limits

The narrow candidate repair belongs primarily to `_shared/autonomy-policy.js`
(honor explicit supported date fields before fallback; distinguish actual clock
tokens from quantity/window wording) and `_shared/request-recovery.js` (missed
reminders require an actual enabled reminder plan). Recheck normalization/date
conflicts and preserve explicit genuine clocks, deadlines, recurrence and current
task-update behavior. The unanchored month-window precision rule must be decided
explicitly; the test allows resolution/preservation or clarification and does
not assert that every “月初” means day one.

No evidence here calls for changing Google Tasks provider writes, adding Calendar
alerts, altering auth/permissions, restoring the already corrected real Task, or
touching the native companion/PR #7. No fix, merge or deployment occurred.

**Important attribution limit:** this source reproduces the two reported shapes
when only due is supplied and raw wording contains a quantity-like 一点. If a
valid requested_date=2026-11-01 truly reached this exact handler together with
due, the control retains November 1; it does not reproduce today's date or the
reported missed state. The original raw JSON/wording and exact deployed source
identity were not inspected. Therefore the real historical request cannot yet
be attributed completely to these defects, and its trigger wording must not be
invented. An authorized, redacted comparison of those existing inputs/bundles
could close that gap; this round does not access the restricted service path.
