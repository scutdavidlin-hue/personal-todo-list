# Phone reminders and Dynamic Island release handoff

Date: 2026-10-13. Source: `bb240517727a81ca89059985295b7c9da144403b`
(merged PR #6 on `baseline/personal-os-v18-20261010`). Independent work directory:
`/workspace/personal-os-mobile`. KNOWU and production resources were not edited.
All changes in this draft are additive; no existing Calendar cancellation files
are replaced. `main` is not used as the production baseline.

## WHY / GOAL

The user requires both functions to be implemented and released: a visibly timed
11:00 phone reminder for the already configured October 16 noon KPL ticket Task,
and a countdown starting one hour before, with manual closure. Existing Task
dates and reminder configuration must remain untouched.

The repository currently has a PWA shell, authenticated Google Tasks/Schedule
reads, Calendar projection and a foreground browser Notification timer. It has
no Swift client, WidgetKit extension, push subscription store, Web Push sender
or APNs token registration. The browser timer checks Task time rather than a
separate Schedule reminder, and cannot establish background phone delivery.

## Official platform evidence

- [WebKit: Web Push for Home Screen web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/):
  iOS/iPadOS 16.4+ Home Screen apps can request push permission after user
  interaction. Web Push can appear on the Lock Screen and in Notification Center;
  Apple Developer paid membership is not required for Web Push. This still needs
  a subscription and a service-side sender. Web Push is not an ActivityKit API.
- [Apple: Meet ActivityKit](https://developer.apple.com/videos/play/wwdc2023/10184/):
  the documented local request starts from the foreground; users can dismiss an
  activity. Its Lock Screen and compact/minimal/expanded island views are supplied
  by SwiftUI/WidgetKit. A stale date does not terminate the activity.
- [Apple: ActivityKit push start/update/end](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications):
  remote startup requires the native ActivityKit push route. The JSON body was
  not fully retrievable here (Apple serves JavaScript and the Markdown fetch
  failed), so the offline start contract still requires SDK/device confirmation.
  Do not assume a newer local scheduled-start API exists or is unavailable on all
  future/current SDKs. Verify with the target user's iOS/SDK before choosing an
  alternative to APNs.
- [Apple: Update Live Activities with push](https://developer.apple.com/videos/play/wwdc2023/10185/):
  APNs uses the `liveactivity` push type, bundle-ID topic suffix, token-based
  connection, Unix timestamp and the default Codable content-state decoding.
- [Apple developer accounts](https://developer.apple.com/help/account/basics/about-your-developer-account):
  Xcode Personal Team testing has limited devices/App IDs and seven-day profiles.
  This source does not verify this exact widget target's Personal Team signing.
- [Apple Developer Program](https://developer.apple.com/programs/): $99 annual
  membership (local pricing may differ) includes advanced capabilities and
  TestFlight distribution. No membership purchase was made.

## Implemented source

- A read-only mobile export page uses the existing session and reads both sources
  again at export. It blocks mismatched Task/Schedule identities, dates and
  malformed times; never infers the reminder from title or edits real tasks.
- Device projection contains explicit Unix instants. Shanghai noon is 04:00 UTC;
  its 11:00 alert and countdown window start are 03:00 UTC. Browser timezone does
  not change these values; ambiguous DST wall clocks are rejected.
- An unsigned iOS 17+ project has app, Live Activity widget and XCTest targets.
  Local notification requests use UTC calendar triggers and stable task-specific
  IDs. Import replaces old pending alerts, verifies the new pending IDs/triggers,
  and distinguishes that receipt from delivery. Terminal/none import removes
  alerts and countdown; old imported generation times are refused.
- A system-rendered timer and Close LiveActivityIntent cover all island layouts
  and Lock Screen. Startup is explicit and allowed only within the one-hour
  window. Foregrounding never restarts user-dismissed activities.
- An offline producer builds `start` and `end` APNs request contracts, matched to
  the Swift numeric epoch content state. There is no sender or token collection.

## Verification evidence

| Layer | Result | Practical limit |
| --- | --- | --- |
| Node regression | `npm run verify`: 525 tests, 523 passed, 2 skipped, 0 failed | Synthetic records/provider mocks; no production writes |
| New logic | 11/11 pass | One-hour boundaries, epochs, DST, identity, terminal/none, reschedule, APNs offline JSON |
| Isolated Chromium | 1/1 pass, 390×844 screenshot inspected | All external requests intercepted; fresh export, none removal, account fence, manual page close; no iPhone |
| Xcode project structure | Reproducible generator/plist/scheme checks pass | Structural checks alone do not compile Swift |
| Actual native CI build | iPhoneOS and simulator build passed, Xcode 16.4 / SDK 18.5, candidate `2df2d4b` | Unsigned; no phone installation |
| Swift XCTest | Five methods executed and passed in actual macOS CI | iPhone SE simulator / iOS 26.2; logic only, no alert or island rendering |
| iPhone install / alert / island | Not performed | No signed build, authorized device or device access |
| APNs accepted / delivered | Not performed | No token, key, sender or authorized registration |
| Production frontend/backend | Not deployed | Release owner must compose with concurrent Calendar work |

Run `python3 scripts/check-ios-project.py`, the new JS syntax checks, and
`npm run verify`. See `ios/README.md` for the unsigned Mac build and real-device
test procedure. Screenshot: `/tmp/personal-os-mobile-preview.png` in this
workspace only. It shows a **synthetic webpage**, not an island or notification.

2026-10-13 native follow-up: after read-only cost verification and reporting,
the isolated public branch ran a standard free `macos-15` GitHub-hosted job.
[CI run and logs](https://github.com/scutdavidlin-hue/personal-todo-list/actions/runs/38374114519)
and `docs/ios-unsigned-ci-evidence.json` record actual compilation and five passing
Swift tests. There were no artifact/cache uploads, signing or production steps.
See `docs/ios-unsigned-ci-readiness.md` for free-runner conditions and the user's
Mac installation steps. Newer SDK/device behavior and physical phone delivery
remain outside this verified milestone.

Offline KPL contract preview (never sends):

```sh
node scripts/preview-activitykit-push.mjs \
  test/fixtures/mobile-kpl-synthetic.json com.example.personalos.companion \
  2026-10-16T03:00:00Z
```

## Release and approval dependencies

1. **First milestone, no push service:** developer uses an existing Mac/Xcode
   and iOS SDK to compile/run XCTest; after user approval, sign and install the
   app+extension on the specified iPhone. The user allows notifications and Live
   Activities, runs the two-minute synthetic device test, and confirms actual
   visibility plus closure. No new service account, APNs secret, native OAuth or
   subscription is needed for local scheduling/foreground startup.
2. **Timed KPL phone alert:** release owner adds the new export page alongside the
   current deployed frontend without overriding Calendar changes. User exports
   the existing KPL Task, confirms 11:00/12:00 on device, imports and schedules.
   This does not create or reschedule the production Task. Device pending readback
   alone is insufficient; observe a bounded synthetic timed alert first.
3. **Automatic 11:00 island:** requires a concrete separately approved native
   push configuration and backend integration. Reuse the existing Supabase
   infrastructure rather than creating a third-party push account. Approve team
   capability/signing, APNs key in protected server secrets, authenticated
   owner-bound device token registration/storage and revocation, and a due-job
   adapter reading canonical Tasks/Schedules. Recheck completion/none/reschedule
   immediately before sending; deduplicate starts per device/Task/window. Track
   push-to-start token updates (iOS 17.2+), activity instance tokens and user-close
   acknowledgements; never blindly retry uncertain start delivery or restart a
   closed activity. APNs acceptance must be separate from observed delivery.
   An explicit `end` at noon is needed; stale-date alone is insufficient.
4. **Distribution choice:** a Personal Team development install is time-limited
   and conditional on target signing support. Existing paid team/ad hoc/TestFlight
   may be appropriate for durable use. No fee, external account, TestFlight upload
   or App Store release is authorized by this draft. Confirm exact existing team
   status and preferred installation method without asking for secrets in chat.

The full requested outcome is still **blocked**, not shipped. This draft is a
reviewable implementation milestone. In particular, manually opening the App at
11:00 does not satisfy unattended automatic 11:00 island startup. A production
   release cannot be claimed before signing, installation,
permissions, backend route (if needed) and actual device acceptance are completed.
