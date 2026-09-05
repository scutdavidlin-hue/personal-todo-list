# Automatic task refresh

WHY: Startup and visibility-change reads existed, but a page left open did not fetch later Google Tasks changes.
GOAL: Keep the existing Personal OS views current without repeated manual refresh.
ACCEPTANCE CRITERIA: Visible pages poll every 30 seconds and respond to focus/pageshow/online; hidden, offline, editing, dialog and pending-mutation states defer automatic reads; refreshes do not overlap; automatic failures avoid repeated toasts.
IMPLEMENTATION: EXTEND the two existing cloud refresh functions. No new service, store, dependency or scheduler. Recheck account and UI activity after asynchronous reads, and release the request guard in finally. Loader and service-worker release bumped.
TEST: npm run verify: 323 total, 321 passed, 2 existing optional browser tests skipped. Tests exercise both pages' actual refresh policy for foreground, offline, background, editing, dialog, pending mutation and throttle behavior. git diff --check passed.
RESULT: Ready to deploy via existing GitHub Pages. This is polling, not instantaneous push; the browser can suspend background pages. Open dialogs intentionally defer list refresh until the next eligible check.
