# Personal OS iPhone companion — unsigned draft

This companion projects an existing Task's configured reminder instants into iOS
local notifications, and provides an ActivityKit countdown during the hour before
the Task's execution time. It does not write Tasks, Schedule, Calendar, auth, or
the production backend.

**Current boundary:** local notification scheduling and foreground-started Live
Activities are implemented in source. Automatic 11:00 background push-to-start
is **not integrated**. This Linux environment cannot compile SwiftUI/ActivityKit,
sign an iOS binary, install it, or demonstrate iPhone delivery. Do not distribute
this draft as an accepted release before the Mac build and device checks below.

## Build on a Mac

1. Open `PersonalOSCompanion.xcodeproj` in Xcode (iOS 17+ SDK).
2. Select the shared `PersonalOSCompanion` scheme and an available iPhone
   simulator. Build and run XCTest before configuring signing.
3. CLI equivalent, replacing the destination with one from
   `xcrun simctl list devices available`:

   ```sh
   xcodebuild -project ios/PersonalOSCompanion.xcodeproj \
     -scheme PersonalOSCompanion -destination 'platform=iOS Simulator,id=SIMULATOR_UDID' \
     CODE_SIGNING_ALLOWED=NO test
   ```

The project is checked in. Regenerate it without dependencies with
`python3 ios/generate-project.py`; verify structure with
`python3 scripts/check-ios-project.py`. Structural verification is not compilation.

## Signing and device installation require the user's approval

After approval, select an existing Apple team in **both** the app and widget
target. Replace `com.example.personalos.companion` and its `.countdown` extension
identifier with team-owned identifiers. Let Xcode manage development signing on
the selected iPhone. Do not put certificates, device identifiers, Apple login,
provisioning profiles, or APNs keys in Git/chat.

No push entitlement, App Group, third-party service or native login is requested
in this draft. Free Personal Team testing may be possible through Xcode; Apple
documents seven-day provisioning limits. Paid membership/TestFlight and APNs
capabilities are a separate decision. See the release document for sources.

## Smallest real-device check

1. Install the signed development build on an approved iPhone. Dynamic Island
   verification needs an iPhone with that hardware; other supported devices
   can verify the Lock Screen presentation.
2. In the app, tap **允许系统通知**, then **两分钟模拟验收** and
   **安排 / 更新这些本机提醒**. Confirm the system pending-request readback says
   1/1. This is not delivery evidence.
3. Tap **启动倒计时**. Leave the app and inspect the Lock Screen/Dynamic Island.
   Confirm a title and decreasing countdown; long-press the island and tap
   **关闭**. Confirm disappearance. Reopening the app must not restart it.
4. Repeat the demo, arrange it, and lock the phone. At 30 seconds, independently
   observe the banner/sound/Lock Screen alert. Record actual device, iOS,
   permission/Focus settings and observed time. This establishes delivery for
   that test only.
5. Test denied notifications, disabled Live Activities, process termination,
   app relaunch, reminder clearing, reschedule and local removal. XCTest verifies
   the payload and window boundaries, not system delivery.

## Import an existing configured Task

The additive `mobile-reminders.html` page must first be released alongside the
existing production frontend by its release owner. It is not linked into or
deployed over the currently changing Calendar flow. In the same Safari/PWA
session already logged in to Personal OS, open the page, select the Task and
export the JSON file. The page re-reads Google Tasks and Schedule immediately
before export. Save/share it to Files, then import it in the companion app.

Review the times and tap **安排 / 更新这些本机提醒**. For the existing KPL plan,
the displayed start must be `2026-10-16 12:00 Asia/Shanghai` and notification
`2026-10-16 11:00 Asia/Shanghai`. Never create a replacement Task to do this.
The import accepts files exported within the preceding 24 hours. At 11:00,
open the notification/app and tap **启动倒计时** for the current manual milestone.

The import contains only Task ID, title, timezone and derived reminder instants.
There is no credential transfer. Stored app data uses complete file protection.
Delete the exported file after import. Task changes outside the app require a
fresh import of the same ID; clearing/terminal snapshots remove local alerts.
Deleted Tasks must be removed locally, because no missing-task inference or
background synchronization is implemented.

## Automatic 11:00 start — pending integration

See [the release handoff](../docs/mobile-reminders-release.md). The offline
ActivityKit payload producer is ready for an authorized backend adapter, but
there is no registered push-to-start token, signing team, authenticated device
registration endpoint, server sender, APNs key, job or production deployment.
The current native request uses `pushType: nil`; it cannot receive remote updates.

The system timer text reaches zero at the event time. `staleDate` does not end
an activity: the current draft ends elapsed activities when foregrounded or
when the user taps Close. A future APNs integration must send an explicit end
and must not restart a user-closed activity through retries.
