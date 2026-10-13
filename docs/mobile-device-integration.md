# Device and T−1h integration: implementation, not deployment

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

## Production adapter requirements — not configured here

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

## Smallest remaining human actions

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

This follow-up does not make automatic island startup available. No real device
token was collected/uploaded, no APNs credential was read/generated, no binary
was signed/installed, and no notification was sent to a phone.
