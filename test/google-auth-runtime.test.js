import assert from "node:assert/strict";
import test from "node:test";

import {
  GoogleProviderError,
  classifyGoogleOAuthFailure,
  assertSameGoogleSubject,
  assertAuthenticatedGoogleIdentity,
  coordinatedGoogleAccess,
  googleSubjectForAccessToken,
  proveLegacyTaskList,
  googleJsonRequest,
  providerErrorDiagnostic,
  refreshGoogleAccessToken,
  selectRefreshToken,
} from "../supabase/functions/_shared/google-auth-runtime.js";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("OAuth invalid_grant requires reconnect and is not retryable", () => {
  const error = classifyGoogleOAuthFailure({ status: 400, payload: { error: "invalid_grant" } });
  assert.equal(error.code, "GOOGLE_REAUTH_REQUIRED");
  assert.equal(error.status, 401);
  assert.equal(error.retryable, false);
  assert.equal(error.providerLayer, "oauth");
});

test("response body failures after headers follow bounded retry rules", async () => {
  let refreshCalls = 0;
  const token = await refreshGoogleAccessToken({
    ownerId: "owner-body-refresh", clientId: "client", clientSecret: "secret",
    refreshToken: "refresh", sleep: async () => {}, random: () => 0,
    fetchImpl: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) return { ok: true, status: 200, text: async () => { throw new TypeError("body interrupted"); } };
      return jsonResponse({ access_token: "recovered" });
    },
  });
  assert.equal(token.accessToken, "recovered");
  assert.equal(refreshCalls, 2);
  let readCalls = 0;
  await googleJsonRequest({
    accessToken: "access", url: "https://tasks.googleapis.com/read", sleep: async () => {}, random: () => 0,
    fetchImpl: async () => {
      readCalls += 1;
      return readCalls === 1
        ? { ok: true, status: 200, text: async () => { throw new TypeError("body interrupted"); } }
        : jsonResponse({ items: [] });
    },
  });
  assert.equal(readCalls, 2);
  let writeCalls = 0;
  await assert.rejects(() => googleJsonRequest({
    accessToken: "access", url: "https://tasks.googleapis.com/write", init: { method: "POST" },
    fetchImpl: async () => { writeCalls += 1; return { ok: true, status: 200, text: async () => { throw new TypeError("body interrupted"); } }; },
  }), (error) => error.code === "GOOGLE_PROVIDER_TEMPORARY_UNAVAILABLE");
  assert.equal(writeCalls, 1);
});

test("subject comparison rejects a changed account and missing legacy proof", () => {
  assert.throws(() => assertSameGoogleSubject("original", "other"), (error) => error.code === "GOOGLE_ACCOUNT_MISMATCH");
  assert.throws(() => assertSameGoogleSubject("", "new"), (error) => error.code === "GOOGLE_ACCOUNT_UNVERIFIED");
});

test("first connection binds to trusted Supabase Google provider identity", () => {
  const user = { id: "supabase-user", user_metadata: { sub: "spoofed" }, identities: [
    { provider: "google", provider_id: "google-sub" },
  ] };
  assert.doesNotThrow(() => assertAuthenticatedGoogleIdentity(user, "google-sub"));
  assert.throws(() => assertAuthenticatedGoogleIdentity(user, "spoofed"), (error) => error.code === "GOOGLE_LOGIN_ACCOUNT_MISMATCH");
  assert.throws(() => assertAuthenticatedGoogleIdentity({ id: "supabase-user", user_metadata: { sub: "spoofed" } }, "spoofed"),
    (error) => error.code === "GOOGLE_LOGIN_IDENTITY_UNAVAILABLE");
});

test("Google subject comes from bearer userinfo, not client email input", async () => {
  let authorization;
  const subject = await googleSubjectForAccessToken("access", {
    fetchImpl: async (_url, init) => { authorization = init.headers.Authorization; return jsonResponse({ sub: "stable-google-sub", email: "changed@example.com" }); },
  });
  assert.equal(subject, "stable-google-sub");
  assert.equal(authorization, "Bearer access");
});

test("legacy account recovery requires access to the exact original Task list", async () => {
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/users\/@me\/lists\/original-list$/);
    assert.equal(init.headers.Authorization, "Bearer candidate");
    return jsonResponse({ id: "original-list" });
  };
  assert.equal(await proveLegacyTaskList("candidate", "original-list", { fetchImpl }), true);
  await assert.rejects(() => proveLegacyTaskList("candidate", "original-list", {
    fetchImpl: async () => jsonResponse({ id: "other-list" }),
  }), (error) => error.code === "GOOGLE_LEGACY_ACCOUNT_UNVERIFIED");
  await assert.rejects(() => proveLegacyTaskList("candidate", "original-list", {
    fetchImpl: async () => jsonResponse({ error: { code: 404 } }, 404),
  }), (error) => error.code === "GOOGLE_LEGACY_ACCOUNT_UNVERIFIED");
});

test("database lease shares a refresh across isolates and persists a rotated token", async () => {
  const state = { refreshToken: "old-refresh", accessToken: "", subject: "bound-sub", leaseId: "", calls: 0 };
  const rpc = async (name, args) => {
    if (name === "claim_google_auth_refresh") {
      if (state.accessToken) return [{ outcome: "cached", access_token: state.accessToken, tasklist_id: "list", google_subject: state.subject }];
      if (state.leaseId) return [{ outcome: "busy", retry_after_ms: 100 }];
      state.leaseId = args.new_lease_id;
      return [{ outcome: "claimed", refresh_token: state.refreshToken, tasklist_id: "list", google_subject: state.subject }];
    }
    if (name === "finish_google_auth_refresh") {
      assert.equal(args.held_lease_id, state.leaseId);
      assert.equal(args.old_refresh_token, "old-refresh");
      state.refreshToken = args.new_refresh_token || state.refreshToken;
      state.accessToken = args.new_access_token;
      state.leaseId = "";
      return true;
    }
    throw new Error(`Unexpected RPC ${name}`);
  };
  const fetchImpl = async () => { state.calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return jsonResponse({ access_token: "shared-access", refresh_token: "rotated-refresh", expires_in: 3600 }); };
  const options = { ownerId: "cross-isolate", encryptionKey: "encryption-key", clientId: "client", clientSecret: "secret", rpc, fetchImpl, sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)) };
  const [first, second] = await Promise.all([coordinatedGoogleAccess(options), coordinatedGoogleAccess(options)]);
  assert.equal(first.accessToken, "shared-access");
  assert.equal(second.accessToken, "shared-access");
  assert.equal(state.calls, 1);
  assert.equal(state.refreshToken, "rotated-refresh");
});

test("cached legacy access token binds its verified subject through a fenced RPC", async () => {
  let boundSubject = null;
  let tokenRefreshes = 0;
  const rpc = async (name, args) => {
    if (name === "claim_google_auth_refresh") return [{
      outcome: "cached", access_token: "legacy-access", tasklist_id: "original-list",
      google_subject: boundSubject,
    }];
    if (name === "bind_google_auth_subject") {
      assert.equal(args.expected_access_token, "legacy-access");
      assert.equal(args.verified_google_subject, "original-sub");
      boundSubject = args.verified_google_subject;
      return true;
    }
    throw new Error(`Unexpected RPC ${name}`);
  };
  const result = await coordinatedGoogleAccess({
    ownerId: "legacy-owner", encryptionKey: "encryption-key", clientId: "client", clientSecret: "secret", rpc,
    fetchImpl: async (url) => {
      if (url === "https://oauth2.googleapis.com/token") tokenRefreshes += 1;
      return jsonResponse({ sub: "original-sub" });
    },
  });
  assert.equal(result.googleSubject, "original-sub");
  assert.equal(boundSubject, "original-sub");
  assert.equal(tokenRefreshes, 0);
});

test("lost cached-token binding rereads current credential instead of returning stale account", async () => {
  let claims = 0;
  const result = await coordinatedGoogleAccess({
    ownerId: "reconnected-owner", encryptionKey: "encryption-key", clientId: "client", clientSecret: "secret",
    rpc: async (name) => {
      if (name === "claim_google_auth_refresh") return [++claims === 1
        ? { outcome: "cached", access_token: "old-access", tasklist_id: "old-list", google_subject: null }
        : { outcome: "cached", access_token: "current-access", tasklist_id: "current-list", google_subject: "current-sub" }];
      if (name === "bind_google_auth_subject") return false;
      throw new Error(`Unexpected RPC ${name}`);
    },
    fetchImpl: async () => jsonResponse({ sub: "old-sub" }),
  });
  assert.equal(claims, 2);
  assert.equal(result.accessToken, "current-access");
  assert.equal(result.googleSubject, "current-sub");
});

test("OAuth invalid_client is a server configuration failure, not user reauthorization", () => {
  const error = classifyGoogleOAuthFailure({ status: 401, payload: { error: "invalid_client" } });
  assert.equal(error.code, "GOOGLE_OAUTH_CONFIGURATION_ERROR");
  assert.equal(error.status, 503);
  assert.equal(error.retryable, false);
});

test("diagnostics expose safe structured provider fields without credential payloads", () => {
  const error = new GoogleProviderError("temporary", {
    status: 503,
    code: "GOOGLE_OAUTH_TEMPORARY_UNAVAILABLE",
    retryable: true,
    providerLayer: "oauth",
    providerStatus: 500,
    providerCode: "server_error",
  });
  assert.deepEqual(providerErrorDiagnostic(error), {
    error: "temporary",
    status: 503,
    code: "GOOGLE_OAUTH_TEMPORARY_UNAVAILABLE",
    retryable: true,
    provider_layer: "oauth",
    provider_status: 500,
    provider_code: "server_error",
  });
});

test("refresh keeps the stored refresh token when Google omits a replacement", async () => {
  const result = await refreshGoogleAccessToken({
    ownerId: "owner-preserve",
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "stored-refresh",
    fetchImpl: async () => jsonResponse({ access_token: "new-access", expires_in: 3600 }),
    sleep: async () => {},
  });
  assert.equal(result.accessToken, "new-access");
  assert.equal(result.refreshToken, "stored-refresh");
  assert.equal(selectRefreshToken(undefined, "stored-refresh"), "stored-refresh");
});

test("concurrent refreshes for one owner and credential share one request", async () => {
  let calls = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    calls += 1;
    await waiting;
    return jsonResponse({ access_token: "shared-access" });
  };
  const options = {
    ownerId: "owner-singleflight",
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetchImpl,
    sleep: async () => {},
  };
  const first = refreshGoogleAccessToken(options);
  const second = refreshGoogleAccessToken(options);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(left.accessToken, "shared-access");
  assert.equal(right.accessToken, "shared-access");
});

test("refresh retries bounded transient failures but does not retry invalid_grant", async () => {
  let transientCalls = 0;
  const recovered = await refreshGoogleAccessToken({
    ownerId: "owner-retry",
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetchImpl: async () => {
      transientCalls += 1;
      return transientCalls < 3
        ? jsonResponse({ error: "server_error" }, 503)
        : jsonResponse({ access_token: "recovered" });
    },
    sleep: async () => {},
    random: () => 0,
  });
  assert.equal(recovered.accessToken, "recovered");
  assert.equal(transientCalls, 3);

  let grantCalls = 0;
  await assert.rejects(() => refreshGoogleAccessToken({
    ownerId: "owner-invalid-grant",
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetchImpl: async () => {
      grantCalls += 1;
      return jsonResponse({ error: "invalid_grant" }, 400);
    },
    sleep: async () => {},
  }), (error) => error.code === "GOOGLE_REAUTH_REQUIRED");
  assert.equal(grantCalls, 1);
});

test("provider reads retry transient failures while mutations execute once", async () => {
  let readCalls = 0;
  const read = await googleJsonRequest({
    accessToken: "access",
    url: "https://tasks.googleapis.com/read",
    fetchImpl: async () => {
      readCalls += 1;
      return readCalls === 1 ? jsonResponse({ error: { status: "UNAVAILABLE" } }, 503) : jsonResponse({ items: [] });
    },
    sleep: async () => {},
    random: () => 0,
  });
  assert.deepEqual(read, { items: [] });
  assert.equal(readCalls, 2);

  let mutationCalls = 0;
  await assert.rejects(() => googleJsonRequest({
    accessToken: "access",
    url: "https://tasks.googleapis.com/write",
    init: { method: "POST", body: "{}" },
    fetchImpl: async () => {
      mutationCalls += 1;
      return jsonResponse({ error: { status: "UNAVAILABLE" } }, 503);
    },
    sleep: async () => {},
  }), (error) => error.code === "GOOGLE_PROVIDER_TEMPORARY_UNAVAILABLE" && error.retryable === true);
  assert.equal(mutationCalls, 1);
});

test("provider network failures are retryable and bounded", async () => {
  let calls = 0;
  await assert.rejects(() => googleJsonRequest({
    accessToken: "access",
    url: "https://tasks.googleapis.com/read",
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError("network unavailable");
    },
    sleep: async () => {},
    random: () => 0,
  }), (error) => error.code === "GOOGLE_PROVIDER_TEMPORARY_UNAVAILABLE" && error.retryable === true);
  assert.equal(calls, 3);
});
