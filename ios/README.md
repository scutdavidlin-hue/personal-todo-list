# Personal OS iPhone companion — unsigned draft

This companion projects an existing Task's configured reminder instants into iOS
local notifications, and provides an ActivityKit countdown during the hour before
the Task's execution time. It does not write Tasks, Schedule, Calendar, auth, or
the production backend.

**Current boundary (2026-10-17):** local notifications, foreground startup and
an explicit **iOS 26+ local scheduled-start** route are implemented in source.
Before the one-hour window, tap **预约提前一小时倒计时** once to ask ActivityKit
to start at the imported event instant minus 3600 seconds. It uses `pushType:nil`;
no APNs/account/token upload is needed for this local route. On iOS 17–18,
foreground startup remains available; remote unattended start is not integrated.
This Linux environment cannot compile Apple frameworks, sign or install an app,
or observe iPhone delivery. Read the latest CI evidence separately from device
acceptance. Do not distribute this draft as an accepted release.

## Build on a Mac

The previous Mac check reported only Command Line Tools; its current installation
is not visible in this cloud workspace. The user already reported signing into
Apple Developer. No repeat login or session expiry is assumed. Resume that
existing Mac setup task and run this **read-only tooling preflight** first:

```sh
bash ios/run-unsigned-checks.sh --preflight-only
```

It reads toolchain/SDK/simulator metadata and writes local evidence only; it does
not access the Apple account, keychain, profiles, physical devices or APNs, and
does not build, sign, register, install or download anything. A successful
`ready_for_unsigned_build` receipt has every build/test/delivery field `not_run`
or false. Missing tools stop with a concrete next step. Do not publish the raw
local logs if their machine paths are private.

Use full **Xcode 26+ / iOS 26+ SDK** and an installed iPhone simulator runtime.
[Apple's requirements](https://developer.apple.com/xcode/system-requirements/)
list macOS 15.6+ for Xcode 26.3; choose a compatible existing installation.
For a shell-only selection, set `DEVELOPER_DIR` to its `.app/Contents/Developer`
path; no system-wide `xcode-select --switch` is necessary.
Once ready, `bash ios/run-unsigned-checks.sh`
compiles both native targets and executes XCTest without signing; it reports each
phase separately and cannot mistake a structure check for compilation.

1. Open `PersonalOSCompanion.xcodeproj` in Xcode 26+ (deployment remains iOS 17+).
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

After concrete approval of the existing team, app+extension identifiers and
selected iPhone, use **existing** matching certificates/profiles for both targets.
The checked-in `com.example.personalos.companion` / `.countdown` values are
placeholders, not registered identifiers. Do not click automatic-signing repair,
create a signing identity, register an App ID/device or generate a profile as a
shortcut: Xcode automatic signing can create these resources. If matching assets
are absent, report exactly which one is absent and obtain separate authorization.
No certificate, device identifier, Apple login, profile or APNs key belongs in
Git/chat. The signed binary must still pass the device check before release.

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

### iOS 26 local scheduled-start check

After the manual test, tap **30 秒后预约上岛模拟**, arrange its local reminder,
then tap **预约提前一小时倒计时**. Leave the app and lock the phone before the
30-second mark. Observe whether the countdown appears without reopening the app;
it must initially show about one hour. Record model/iOS, Focus and permissions,
the scheduled/observed times, visibility and manual-close result. System request
acceptance or `.pending` is not proof of appearance. Test cancellation before
start, close after start, relaunch, none/completed re-import and reschedule. The
same closed event must not be recreated; a new event requires fresh explicit
import/appointment. Re-import removes any previous activity or appointment.

ActivityKit requires an alert configuration for scheduled start. Existing local
notifications remain unchanged, so both a notification and an activity-start
alert may appear at the same instant. Check this on-device before release; do
not silently remove an explicitly configured reminder to hide a duplicate.
The timer reaches zero but scheduled local start does not add background end or
canonical Task synchronization. Manual Close/foreground cleanup still ends it.

## Import an existing configured Task

The additive `mobile-reminders.html` page must first be released alongside the
existing production frontend by its release owner. It is not linked into or
deployed over the currently changing Calendar flow. In the same Safari/PWA
session already logged in to Personal OS, open the page, select the Task and
export the JSON file. The page re-reads Google Tasks and Schedule immediately
before export. Save/share it to Files, then import it in the companion app.

Review the times and tap **安排 / 更新这些本机提醒**. For the existing KPL plan,
the historical configured start was `2026-10-16 12:00 Asia/Shanghai` and
notification `2026-10-16 11:00 Asia/Shanghai`. These times are now past: do not
reschedule or recreate that real Task to manufacture a new acceptance result.
Use the app's current-clock fictional demo first, then a separately chosen
future existing Task. Never create a replacement Task to test the companion.
The import accepts files exported within the preceding 24 hours. At 11:00,
open the notification/app and tap **启动倒计时** for the manual milestone. On
iOS 26+, explicitly appoint the local start before the one-hour window instead.

The import contains only Task ID, title, timezone and derived reminder instants.
There is no credential transfer. Stored app data uses complete file protection.
Delete the exported file after import. Task changes outside the app require a
fresh import of the same ID; clearing/terminal snapshots remove local alerts.
Deleted Tasks must be removed locally, because no missing-task inference or
background synchronization is implemented.

## Local appointment and remote startup are different routes

[Apple's iOS 26 request API](https://developer.apple.com/documentation/activitykit/activity/request(attributes:content:pushtype:style:alertconfiguration:start:))
supports local scheduled startup with an alert. This source now implements that
route; physical delivery and closure remain unverified. The app must be installed
and the appointment accepted ahead of time. It is not a PWA capability.

See [the release handoff](../docs/mobile-reminders-release.md). The offline
ActivityKit payload producer is ready for an authorized **remote** adapter, but
there is no registered push-to-start token, signing team, authenticated device
registration endpoint, server sender, APNs key, job or production deployment.
All current native requests use `pushType: nil`; they cannot receive remote updates.

The system timer text reaches zero at the event time. `staleDate` does not end
an activity: the current draft ends elapsed activities when foregrounded or
when the user taps Close. A future APNs integration must send an explicit end
and must not restart a user-closed activity through retries.
