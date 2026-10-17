# Device and T−1h integration: implementation, not deployment

## Current continuation — 2026-10-17

PR #7 resumes from `48fe9319fa45af19741e3deff38a47c885ed7c2f`. PR #8's date
parser repair is separate and supplies no Dynamic Island acceptance evidence.
The previous raw CI log was read again: run `38378357820`, job `115232299890`,
really compiled both unsigned targets with Xcode 16.4 / SDK 18.5 and executed all
ten then-current Swift tests. This cloud environment remains Linux with no Swift,
Xcode, signing identity or physical iPhone connection. The user's reported Apple
Developer login is retained; no account session was read or found expired.

The delegated 2026-10-17 Mac read-only recheck reports macOS 26.5.2 with Command
Line Tools only, no full Xcode/iOS SDK, no iPhone found over USB, and unknown
wireless pairing. This is the current host-installation blocker, not a failed
Apple login. Continue the existing installation task; a selected unlocked/trusted
iPhone connection (or verified existing wireless pairing) is also required for
physical signing/install acceptance.

Apple now documents [local scheduled Live Activity startup on iOS 26+](https://developer.apple.com/documentation/activitykit/activity/request(attributes:content:pushtype:style:alertconfiguration:start:)).
The existing companion now has an explicit **预约提前一小时倒计时** action that
passes the unchanged imported `eventAt - 3600` instant to that API. It uses
`pushType:nil`, the existing local projections and protected close records.
No backend login, device token, APNs key, server store or vault is required for
this fixed imported appointment. Pending/active/stale activities prevent a second
request; re-import ends old appointments; Close cancels them and records the exact
event window. After the permission await, the app checks that the installed
projection is still current and the appointment instant is still in the future.

| Route | Implemented | Remaining dependency |
| --- | --- | --- |
| PWA export | Existing read-only Tasks/Schedule export | Release owner confirms availability alongside the correct production frontend; no PWA ActivityKit access |
| iOS 17+ local alert and manual countdown | Existing source and previous unsigned native tests | Existing approved signing assets, install and physical observation |
| iOS 26+ appointed T−1h start | New native request/demo; unsigned SDK compilation and 13 Swift tests pass | Installed app/permissions, ahead-of-time appointment, real iPhone observation |
| Older-iOS remote unattended start or live canonical synchronization | Existing isolated injected interfaces only | Approved auth/store/vault/APNs/native token bindings and due/end deployment, all still absent |

This makes APNs **conditional**, not mandatory for every automatic-start route.
Local appointment is not continuous Task synchronization: edits, completion and
none require explicit re-import; deletion requires local removal. No signed app
is installed and no actual reminder/island is verified by this source change.
The ActivityKit scheduled-start alert is additional to unchanged configured local
notifications; both may appear together. A timer reaching zero/stale date does
not itself guarantee background termination. These need physical acceptance.

The original KPL 2026-10-16 11:00/12:00 instants are past on this continuation.
They were not moved, recreated or used to claim a retroactive successful alert.
Use the existing synthetic manual test or new 30-second appointment test, followed
by an explicitly selected future existing Task after the export page is released.

### Exact handoff to the existing Mac task

Personal Context lookup is unavailable for this delegated conversation, so an
existing task ID/link could not be verified. Do not create a duplicate. Resume
the existing Mac/Xcode installation/signing task from the first unmet step:

1. Check the currently installed full Xcode/iOS components, retaining the existing
   Apple Developer login. From this branch run
   `bash ios/run-unsigned-checks.sh --preflight-only`. It only reads local tooling
   metadata and writes a local receipt; it never enumerates accounts, keychain,
   physical-device IDs or profiles. On Linux it exits 2 with native phases
   `not_run`; simulated metadata tests also confirm that preflight cannot build,
   sign, install or silently download a missing runtime. Xcode 26+ / SDK 26+
   and an installed iOS 26+ iPhone simulator are required for the new API checks.
2. Run `bash ios/run-unsigned-checks.sh` for unsigned compilation and all current
   XCTest methods. Existing public CI can establish this even before local setup;
   unsigned success is not an installable build. Local preflight success is only
   `ready_for_unsigned_build`, never an implicit test pass.
3. Identify the already approved Apple team, exact app+extension bundle IDs,
   existing matching development certificate/profiles and target iPhone. The
   checked-in identifiers are placeholders. Use existing assets only; do not
   click automatic-signing repair or register/generate missing resources. Such a
   gap needs a separate concrete authorization, not another request to log in.
4. With approved existing assets, sign/install locally; confirm Developer Mode
   and Mac trust only if the selected device actually requests them. On the
   iPhone allow Notifications and Live Activities. Run the manual demo first,
   then on iOS 26+ arrange **30 秒后预约上岛模拟**, tap the appointment action and
   leave/lock the app before the start. Observe the countdown starting without
   reopening, closure and absence of restart. Record model/iOS, permissions/Focus,
   scheduled/observed times and outcomes. No UDID, token, certificate or login
   belongs in a public issue or Git.

The new script requires every checked-in Swift test method to appear as passed
in the actual XCTest log. The old loose five-test threshold no longer certifies
new code. A fresh guarded public-standard macOS run is required for this update;
its result is recorded below only after the log and phase receipt are inspected.

### Fresh unsigned verification — completed

Tested source: `0fad0c6a9dcbce8d72ef7b3d0b81c5006c7a6f3b`.
[Run 39021234814](https://github.com/scutdavidlin-hue/personal-todo-list/actions/runs/39021234814),
job `117363295283`, completed successfully on 2026-10-17 at 09:37:50 UTC.
The raw 562,961-character log and phase receipt were read: Xcode 26.3 (17C529),
iPhoneOS/simulator SDK 26.2; both unsigned builds passed and all **13** Swift
XCTest methods executed with zero failures. The checker found all 13 named
methods, including the three new boundary/disabled/demo cases; the old ten-test
run does not cover them. No ActivityKit appointment is submitted by those logic
tests, so system scheduling/visibility and physical closure remain unverified.

`npm run verify`: **546 tests, 544 passed, two existing browser skips, zero
failures**. The six new handoff tests use simulated metadata/logs and confirm
that an inflated green count with missing methods is refused, failure summaries
are refused, preflight never builds/signs/installs, and old SDKs/missing runtimes
cannot pass. The actual Linux preflight exits 2 with all native phases not_run.

The fresh job used the already-public repository and standard `macos-15`, no
artifact/cache uploads, secrets, signing, account/profile access, SDK downloads
or deployment. Its log contains zero email-like values and no private-key, JWT
or GitHub-token values, production Tasks/Auth URLs or native token observers by
the recorded probes. Public repository handles and runner metadata remain.
This inspection is limited to this log, not a guarantee about all repository
history. Artifact readback returns an empty list. Structured results are in
`docs/ios-unsigned-ci-evidence.json`.

The final handoff/evidence change is documentation only; native source is
identical to this tested candidate. PR #7 remains Draft and the user-facing
mobile release remains blocked at full local Xcode, approved existing signing
assets/phone connection, installation and actual device acceptance. No true
Task or production route was changed; no APNs message was sent.

## Previously tested head and privacy check

GitHub and local diffs agree that `3989e78e5fd76d5f26d63cc4b0b07a6ac90f025a`
differs from tested `2df2d4b8c85e3219e65998c3d025d1048cade650` in exactly:
`docs/ios-unsigned-ci-evidence.json`, `docs/ios-unsigned-ci-readiness.md` and
`docs/mobile-reminders-release.md`. There were no untested native/backend/workflow
changes in that comparison. The current follow-up does change code, and therefore
requires a fresh run of the same proven free public-standard macOS route.

Before the first native CI run, repository metadata already reported `public`.
The historical Pages run response also reported `private:false`. This task has
not changed visibility or called a repository-settings mutation. This confirms
the state before our CI; it does not claim visibility has never changed over the
repository's lifetime.

The complete 444,306-character log of job `115218066606` was inspected. No
email-like values, JWT values, private-key blocks, GitHub token values, production
Tasks/Auth endpoint calls or native APNs token collector were found. The test
resource was `mobile-kpl-synthetic.json`; native code used no production endpoint
or credential. GitHub repository/account handles and runner/toolchain metadata
are publicly visible in the log. This is an inspection of this run, not a
guarantee about all historical repository content or arbitrary future CI.

## Safe work completed in source

`ios/backend/mobile-device-api.js` implements actual Request/Response handlers
with injected authentication, atomic storage, token vault, canonical Tasks reader
and transport adapters. It has no environment reads, network fetch, Deno server,
database connection or default adapter. It is not deployed or wired to a real
token store. `test/mobile-device-api.test.js` invokes the handlers with an
in-memory store/vault, synthetic devices and mocked APNs; no real network sends.

| Route | Behavior |
| --- | --- |
| `POST /devices` | Owner comes from verified caller, never the body. Validates device/OS/environment and last-observed permissions; revision CAS; optional push-to-start token is sealed; checks readback; returns token-presence only. Re-registering rotates tokens. |
| `GET /devices` | Owner-bound, safe projection only; no raw token or ciphertext returned. Refuses a store that returns foreign owner records. |
| `DELETE /devices/:id` | Idempotently revokes the owned device, clears token references and disables future sends; checks readback. Store must also clear instance-token references/follows. |
| `POST /devices/:id/tasks/:taskId/follow` | Explicit per-task follow/unfollow. Reads existing canonical task; never creates/updates it. |
| `POST /devices/:id/tasks/:taskId/close` | Durable tombstone for the exact event/window; no automatic restart allowed. Own-device state only. |
| `POST /devices/:id/tasks/:taskId/activity-token` | Separately seals a rotating instance token after validating the canonical task/event. This token is required for explicit end. |
| `POST /dispatch-due` | Separate verified worker identity. Checks explicit consent, iOS 17.2+, reported visible notification/Live Activity permissions, token and canonical Tasks/Schedule. Claims a unique device/task/event window, rereads state, then calls the injected start transport at T−1h (maximum 60 seconds late). |
| `POST /dispatch-end` | Claims each end once and calls injected instance-token end transport at noon, or for a closed window; distinguishes APNs acceptance from device disappearance. |

Backend permission observations are reported snapshots, valid for at most seven
days, not live verification that the iPhone still allows notifications. Revoked
permissions or Focus settings can change after observation. Every transport
receipt retains `delivered:false` / `deviceDeliveryVerified:false`.

Native source now reads current notification/alert/sound and ActivityKit state
on foreground and after notification permission requests, and displays them.
Permission reads do not themselves request permission or register a device.
`MobileDeviceClient` implements explicit registration and close acknowledgements,
but its endpoint and transport are nil by default: no upload can occur. It accepts
only HTTPS without URL credentials and never retries unknown write outcomes.
No native push-to-start/instance-token sequence or push entitlement is enabled.

App/intent Close also records exact windows in a protected local outbox, with no
automatic upload. Foreground checks suppress matching recorded windows locally.
Manual closure still ends the activity if protected storage is unavailable while
the phone is locked; in that case durable/server suppression remains unverified.
The future authenticated transport must acknowledge outbox records before
enabling automatic follows. An already sent/in-flight push can race a close:
server tombstones block subsequent sends but cannot retract an APNs message.
Do not claim the isolated implementation resolves that distributed race.

## Remote-route production adapter requirements — not configured here

- Reuse existing Supabase user JWT verification and owner policy for device
  calls. Reuse the existing authorized worker identity for due/end routes.
  No client-claimed owner or user_metadata grants authorization. No new native
  login flow or authorization scopes are configured.
- Bind the store to private encrypted device/instance-token projections and an
  owner-bound follow/window ledger in the existing project, not a second Task
  store. CAS and unique claims must be **atomic database operations**, including
  close-before-send and revocation fences. Production RLS/grants/schema and
  retention need separate approved rollout; the synthetic store is not suitable
  for deployment. A device-count quota and cleanup of vault material must be
  implemented by that production adapter.
- Bind the token vault to protected existing server key management after explicit
  approval. The mock vault only maps synthetic references; it is not encryption.
  Revocation must remove token references and securely expire vault ciphertext.
  No APNs keys, tokens, certificate or user JWT were read/generated here.
- Bind start/end transports to the approved APNs team/key/topic/environment.
  Native push capability and token observers remain disabled until this setup
  and the authenticated registration connection are approved.
- Use an approved minutely backend schedule to invoke due/end dispatch. No Cron
  was created. Late windows are reported without replay; uncertain starts and
  ends are never blindly retried. This conservative fence can leave a claimed
  but unsent window needing explicit operator reconciliation.
- The app still needs an authorized existing-session handoff; the client does
  not obtain/store an auth token. It receives one only through a future explicit
  binding, not a file, environment or chat credential.

## Original remote-route human actions (historical)

1. Install compatible full Xcode and the iOS platform/runtime on the user's Mac;
   compile using `bash ios/run-unsigned-checks.sh` if local validation is desired.
2. Approve use of a named existing Apple development team to sign/install this
   exact app+extension on the selected iPhone; allow Notifications and Live
   Activities on-device and run the synthetic timed alert/close check.
3. For **unattended** T−1h startup, approve the concrete backend device/token
   storage, authentication handoff, APNs key/capability and minutely due/end job
   rollout; choose an existing paid team if available. No membership purchase
   or service account creation has occurred. Secrets must go directly into
   protected settings, never chat or Git.
4. After that deployment, explicitly register/follow the existing Task in the
   app and verify the actual 11:00 phone alert, island countdown and manual close.
   Backend APNs acceptance is insufficient evidence of delivery.

That remote-route follow-up did not make automatic island startup available. No real device
token was collected/uploaded, no APNs credential was read/generated, no binary
was signed/installed, and no notification was sent to a phone.

## Follow-up verification

Actual tested code commit: `2fc54b46a5daeb05cd65ed9dc1b9f2c94b59175f`.
[Free standard macOS CI run 38378357820](https://github.com/scutdavidlin-hue/personal-todo-list/actions/runs/38378357820)
completed successfully at 2026-10-13 09:54:16 UTC. The complete job log and phase
receipt were read: Xcode 16.4 (16F6), iPhoneOS and simulator SDK 18.5 builds passed;
all **ten** Swift XCTest methods executed with zero failures. No physical device
or widget-rendering acceptance is claimed.

`npm run verify`: 540 tests, 538 passed, two existing skips, zero failures. The
15 new HTTP-handler tests use only an in-memory store/vault, synthetic owner IDs,
synthetic hex tokens and mocked transport responses. Cases cover authentication,
owner boundaries including broken adapter filters, CAS/readback, permission/OS
gates, exact 11:00 UTC conversion, concurrent claims, unknown-no-retry, terminal
and rescheduled Tasks, manual close/races, revocation and separate instance-token
end. These are simulation results, not accepted/delivered real APNs messages.

The 454,688-character follow-up CI log was checked with the same privacy probes:
zero email-like values; no JWT/private-key/GitHub-token values, production
Tasks/Auth calls or native token observers. Public repository/account handles
remain visible. Structured evidence is in `docs/ios-unsigned-ci-evidence.json`.
The final evidence update is documentation only; native source remains identical
to the tested commit and does not require a second identical runner invocation.
