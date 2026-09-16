# Google OAuth stability

## Why
Personal OS's provider credential refresh failed with `GOOGLE_REAUTH_REQUIRED` on 2026-09-16. The existing Google Cloud OAuth application was confirmed to be External / Testing. Google limits refresh tokens with Tasks and Calendar scopes issued in Testing to seven days. The error alone does not prove Google's precise invalidation reason, but Testing is a confirmed recurring-expiry cause.

## Goal and acceptance
Keep Google Tasks as the task source of truth and Calendar as the existing projection. Complete the existing app's public branding fields, move it to In production with owner confirmation, reauthorize the same account and existing scopes, then read back Tasks and Calendar. Production does not mean verified and cannot guarantee that refresh tokens never expire or get revoked.

## Implementation
Reuse the existing project, OAuth client, Supabase credential storage and GitHub Pages site. Public pages are `about.html` and `privacy.html`, linked from `index.html`. No new service, dependency, scope, credential store, migration, or Edge Function is needed for this configuration repair.

## Current evidence
- Original authorization restored through the existing webpage on 2026-09-16.
- Personal OS MCP task search succeeded after restoration.
- Independent Google Calendar connector read succeeded; this is a separate authorization and is not proof of Personal OS Calendar projection writes.
- Public page preparation passed the package's existing check/test commands: 337 passed, 2 optional skips, 0 failures.
- Public page deployment and In production transition are pending owner approval. Reauthorization after that transition remains required.

## Recovery and maintenance
1. Confirm the failure layer: MCP login, Supabase session, provider refresh, missing API/scope, or Google API transient error. Current provider code maps multiple refresh failures to a generic reauthorization error; do not infer `invalid_grant` without provider evidence.
2. Check the existing Google Auth Platform audience status. Avoid switching production back to Testing.
3. Reconnect from the existing Personal OS “连接 Tasks” button; preserve Tasks and Calendar Events scopes and the existing account. Never copy OAuth tokens into tickets or logs.
4. Read back an existing task before reporting recovery. Verify Calendar through its relevant authorization path. Do not create duplicate tasks or change real events merely to test authentication.
5. Google revocation or security prompts require the account owner's participation. Never substitute another task store or reminder mechanism.

References:
- https://developers.google.com/identity/protocols/oauth2#expiration
- https://support.google.com/cloud/answer/15549049
