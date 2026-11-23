const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const refreshFlights = new Map();

export class GoogleProviderError extends Error {
  constructor(message, {
    status = 503,
    code = "GOOGLE_PROVIDER_UNAVAILABLE",
    retryable = false,
    providerLayer = "oauth",
    providerStatus = null,
    providerCode = "",
  } = {}) {
    super(message);
    this.name = "GoogleProviderError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.providerLayer = providerLayer;
    this.providerStatus = providerStatus;
    this.providerCode = providerCode;
  }
}

export function providerErrorDiagnostic(error) {
  if (!(error instanceof GoogleProviderError)) return null;
  return {
    error: error.message,
    status: error.status,
    code: error.code,
    retryable: error.retryable,
    provider_layer: error.providerLayer,
    ...(Number.isInteger(error.providerStatus) ? { provider_status: error.providerStatus } : {}),
    ...(error.providerCode ? { provider_code: error.providerCode } : {}),
  };
}

export function selectRefreshToken(receivedRefreshToken, storedRefreshToken = "") {
  const received = typeof receivedRefreshToken === "string" ? receivedRefreshToken.trim() : "";
  if (received) return received;
  return typeof storedRefreshToken === "string" ? storedRefreshToken : "";
}

async function responsePayload(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function providerCode(payload) {
  if (!payload || typeof payload !== "object") return "";
  return String(payload.error?.errors?.[0]?.reason || payload.error?.status || payload.error || "");
}

function retryAfterMilliseconds(response, maximum) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(maximum, Math.max(0, seconds * 1_000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(maximum, Math.max(0, date - Date.now())) : 0;
}

function transientNetworkError(error, providerLayer) {
  if (error instanceof GoogleProviderError) return error;
  return new GoogleProviderError(
    providerLayer === "oauth" ? "Google authorization service is temporarily unavailable" : "Google service is temporarily unavailable",
    {
      status: 503,
      code: providerLayer === "oauth" ? "GOOGLE_OAUTH_TEMPORARY_UNAVAILABLE" : "GOOGLE_PROVIDER_TEMPORARY_UNAVAILABLE",
      retryable: true,
      providerLayer,
    },
  );
}

export function classifyGoogleOAuthFailure({ status = 0, payload = null } = {}) {
  const oauthCode = providerCode(payload);
  if (oauthCode === "invalid_grant") {
    return new GoogleProviderError("Google authorization must be reconnected", {
      status: 401,
      code: "GOOGLE_REAUTH_REQUIRED",
      retryable: false,
      providerLayer: "oauth",
      providerStatus: status || null,
      providerCode: oauthCode,
    });
  }
  if (oauthCode === "invalid_client" || oauthCode === "deleted_client") {
    return new GoogleProviderError("Google OAuth client configuration is invalid", {
      status: 503,
      code: "GOOGLE_OAUTH_CONFIGURATION_ERROR",
      retryable: false,
      providerLayer: "oauth",
      providerStatus: status || null,
      providerCode: oauthCode,
    });
  }
  if (status === 429) {
    return new GoogleProviderError("Google authorization service is rate limited", {
      status: 429,
      code: "GOOGLE_OAUTH_RATE_LIMITED",
      retryable: true,
      providerLayer: "oauth",
      providerStatus: status,
      providerCode: oauthCode,
    });
  }
  if (status >= 500 || status === 0) {
    return new GoogleProviderError("Google authorization service is temporarily unavailable", {
      status: 503,
      code: "GOOGLE_OAUTH_TEMPORARY_UNAVAILABLE",
      retryable: true,
      providerLayer: "oauth",
      providerStatus: status || null,
      providerCode: oauthCode,
    });
  }
  return new GoogleProviderError("Google authorization request was rejected", {
    status: status >= 400 && status < 500 ? status : 502,
    code: "GOOGLE_OAUTH_REQUEST_REJECTED",
    retryable: false,
    providerLayer: "oauth",
    providerStatus: status || null,
    providerCode: oauthCode,
  });
}

export function classifyGoogleProviderFailure({ status = 0, payload = null, providerLayer = "tasks" } = {}) {
  const code = providerCode(payload);
  const detail = `${code} ${payload?.error?.message || ""}`;
  if (status === 401) {
    return new GoogleProviderError("Google rejected the refreshed access token", {
      status: 401,
      code: "GOOGLE_ACCESS_TOKEN_REJECTED",
      retryable: false,
      providerLayer,
      providerStatus: status,
      providerCode: code,
    });
  }
  if (status === 429 || (status === 403 && /rateLimit|quota|RESOURCE_EXHAUSTED/i.test(detail))) {
    return new GoogleProviderError("Google request rate limit reached", {
      status: 429,
      code: "GOOGLE_RATE_LIMITED",
      retryable: true,
      providerLayer,
      providerStatus: status,
      providerCode: code,
    });
  }
  if (status >= 500 || status === 0) {
    return new GoogleProviderError("Google service is temporarily unavailable", {
      status: 503,
      code: "GOOGLE_PROVIDER_TEMPORARY_UNAVAILABLE",
      retryable: true,
      providerLayer,
      providerStatus: status || null,
      providerCode: code,
    });
  }
  if (status === 403 && /disabled|not been used|accessnotconfigured|SERVICE_DISABLED/i.test(detail)) {
    return new GoogleProviderError(`Google ${providerLayer} API is disabled`, {
      status: 503,
      code: providerLayer === "calendar" ? "CALENDAR_API_DISABLED" : "TASKS_API_DISABLED",
      retryable: false,
      providerLayer,
      providerStatus: status,
      providerCode: code,
    });
  }
  if (status === 403 && /insufficient|permission|scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(detail)) {
    return new GoogleProviderError(`Google ${providerLayer} permission is missing`, {
      status: 403,
      code: providerLayer === "calendar" ? "CALENDAR_SCOPE_MISSING" : "SCOPE_MISSING",
      retryable: false,
      providerLayer,
      providerStatus: status,
      providerCode: code,
    });
  }
  if (status === 404) {
    return new GoogleProviderError("Google object was not found", {
      status: 404,
      code: "GOOGLE_OBJECT_NOT_FOUND",
      retryable: false,
      providerLayer,
      providerStatus: status,
      providerCode: code,
    });
  }
  if (status === 409) {
    return new GoogleProviderError("Google object already exists", {
      status: 409,
      code: "GOOGLE_OBJECT_EXISTS",
      retryable: false,
      providerLayer,
      providerStatus: status,
      providerCode: code,
    });
  }
  if (status === 412) {
    return new GoogleProviderError("Google object changed after it was read", {
      status: 409,
      code: "GOOGLE_OBJECT_CHANGED",
      retryable: false,
      providerLayer,
      providerStatus: status,
      providerCode: code,
    });
  }
  return new GoogleProviderError("Google request failed", {
    status: status >= 400 ? status : 502,
    code: providerLayer === "calendar" ? "GOOGLE_CALENDAR_ERROR" : "GOOGLE_TASKS_ERROR",
    retryable: false,
    providerLayer,
    providerStatus: status || null,
    providerCode: code,
  });
}

async function boundedRetry(work, {
  attempts,
  sleep,
  random,
  baseDelayMs,
  maxDelayMs,
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await work(attempt); }
    catch (error) {
      lastError = error;
      if (!(error instanceof GoogleProviderError) || !error.retryable || attempt >= attempts) throw error;
      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const jitter = Math.floor(Math.max(0, random()) * Math.min(baseDelayMs, maxDelayMs));
      await sleep(Math.min(maxDelayMs, Math.max(error.retryAfterMs || 0, exponential + jitter)));
    }
  }
  throw lastError;
}

async function refreshWithoutSingleflight({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl,
  sleep,
  random,
  attempts,
  timeoutMs,
  baseDelayMs,
  maxDelayMs,
}) {
  if (!clientId || !clientSecret) {
    throw new GoogleProviderError("Google OAuth client configuration is incomplete", {
      status: 503,
      code: "GOOGLE_OAUTH_CONFIGURATION_ERROR",
      retryable: false,
      providerLayer: "oauth",
    });
  }
  if (!refreshToken) {
    throw new GoogleProviderError("Google Tasks is not connected", {
      status: 428,
      code: "GOOGLE_NOT_CONNECTED",
      retryable: false,
      providerLayer: "credential_store",
    });
  }
  return boundedRetry(async () => {
    let response;
    try {
      response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw transientNetworkError(error, "oauth");
    }
    let payload;
    try { payload = await responsePayload(response); }
    catch (error) { throw transientNetworkError(error, "oauth"); }
    if (!response.ok) {
      const error = classifyGoogleOAuthFailure({ status: response.status, payload });
      error.retryAfterMs = retryAfterMilliseconds(response, maxDelayMs);
      throw error;
    }
    if (!payload?.access_token) {
      throw new GoogleProviderError("Google authorization response was incomplete", {
        status: 502,
        code: "GOOGLE_OAUTH_INVALID_RESPONSE",
        retryable: false,
        providerLayer: "oauth",
        providerStatus: response.status,
      });
    }
    return {
      accessToken: String(payload.access_token),
      refreshToken: selectRefreshToken(payload.refresh_token, refreshToken),
      expiresIn: Number(payload.expires_in) || null,
      scope: typeof payload.scope === "string" ? payload.scope : "",
      tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
    };
  }, { attempts, sleep, random, baseDelayMs, maxDelayMs });
}

/** @param {{ownerId: string, clientId: string, clientSecret: string, refreshToken: string, fetchImpl?: typeof fetch, sleep?: (milliseconds: number) => Promise<void>, random?: () => number, attempts?: number, timeoutMs?: number, baseDelayMs?: number, maxDelayMs?: number}} options */
export function refreshGoogleAccessToken({
  ownerId,
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random = Math.random,
  attempts = 3,
  timeoutMs = 10_000,
  baseDelayMs = 500,
  maxDelayMs = 2_000,
} = {}) {
  const ownerKey = String(ownerId || "");
  const options = { clientId, clientSecret, refreshToken, fetchImpl, sleep, random, attempts: Math.max(1, Math.min(3, attempts)), timeoutMs, baseDelayMs, maxDelayMs };
  const current = refreshFlights.get(ownerKey);
  if (current) {
    if (current.refreshToken === refreshToken) return current.promise;
    return current.promise.catch(() => undefined).then(() => refreshGoogleAccessToken({ ownerId, ...options }));
  }
  const promise = refreshWithoutSingleflight(options);
  refreshFlights.set(ownerKey, { refreshToken, promise });
  promise.finally(() => {
    if (refreshFlights.get(ownerKey)?.promise === promise) refreshFlights.delete(ownerKey);
  }).catch(() => undefined);
  return promise;
}

/** @param {{accessToken: string, url: string, init?: RequestInit, providerLayer?: string, fetchImpl?: typeof fetch, sleep?: (milliseconds: number) => Promise<void>, random?: () => number, readAttempts?: number, timeoutMs?: number, baseDelayMs?: number, maxDelayMs?: number}} options */
export async function googleJsonRequest({
  accessToken,
  url,
  init = {},
  providerLayer = "tasks",
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random = Math.random,
  readAttempts = 3,
  timeoutMs = 10_000,
  baseDelayMs = 500,
  maxDelayMs = 2_000,
} = {}) {
  const method = String(init.method || "GET").toUpperCase();
  const safeRead = method === "GET" || method === "HEAD";
  const attempts = safeRead ? Math.max(1, Math.min(3, readAttempts)) : 1;
  return boundedRetry(async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
        signal: init.signal || AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw transientNetworkError(error, providerLayer);
    }
    let payload;
    try { payload = await responsePayload(response); }
    catch (error) { throw transientNetworkError(error, providerLayer); }
    if (!response.ok) {
      const error = classifyGoogleProviderFailure({ status: response.status, payload, providerLayer });
      error.retryAfterMs = retryAfterMilliseconds(response, maxDelayMs);
      throw error;
    }
    return payload;
  }, { attempts, sleep, random, baseDelayMs, maxDelayMs });
}

const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_CALENDAR_PROBE = "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1";

export async function googleSubjectForAccessToken(accessToken, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (!accessToken) throw new GoogleProviderError("Google account identity is unavailable", {
    status: 409, code: "GOOGLE_ACCOUNT_UNVERIFIED", providerLayer: "identity",
  });
  let response;
  try {
    response = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) { throw transientNetworkError(error, "identity"); }
  let payload;
  try { payload = await responsePayload(response); }
  catch (error) { throw transientNetworkError(error, "identity"); }
  if (!response.ok || typeof payload?.sub !== "string" || !payload.sub) {
    throw new GoogleProviderError("Google account identity could not be verified", {
      status: response.status === 403 ? 403 : response.status === 429 || response.status >= 500 ? 503 : 409,
      code: response.status === 403 ? "GOOGLE_IDENTITY_SCOPE_MISSING" : "GOOGLE_ACCOUNT_UNVERIFIED",
      retryable: response.status === 429 || response.status >= 500,
      providerLayer: "identity", providerStatus: response.status,
    });
  }
  return payload.sub;
}

export function assertSameGoogleSubject(currentSubject, candidateSubject) {
  if (!currentSubject || !candidateSubject) throw new GoogleProviderError("Original Google account could not be verified", {
    status: 409, code: "GOOGLE_ACCOUNT_UNVERIFIED", providerLayer: "identity",
  });
  if (currentSubject !== candidateSubject) throw new GoogleProviderError("Different Google account selected", {
    status: 409, code: "GOOGLE_ACCOUNT_MISMATCH", providerLayer: "identity",
  });
}

export function assertAuthenticatedGoogleIdentity(user, candidateSubject) {
  const identities = Array.isArray(user?.identities) ? user.identities : [];
  const googleSubjects = identities
    .filter((identity) => identity?.provider === "google")
    .map((identity) => identity?.provider_id)
    .filter((subject) => typeof subject === "string" && subject.length > 0);
  if (!googleSubjects.length) throw new GoogleProviderError("Authenticated Google identity is unavailable", {
    status: 409, code: "GOOGLE_LOGIN_IDENTITY_UNAVAILABLE", providerLayer: "identity",
  });
  if (!googleSubjects.includes(candidateSubject)) throw new GoogleProviderError("Google Tasks account differs from the signed-in Google account", {
    status: 409, code: "GOOGLE_LOGIN_ACCOUNT_MISMATCH", providerLayer: "identity",
  });
}

export async function proveLegacyTaskList(accessToken, storedTaskListId, { fetchImpl = globalThis.fetch } = {}) {
  if (!accessToken || !storedTaskListId) throw new GoogleProviderError("Original Google task list cannot be verified", {
    status: 409, code: "GOOGLE_LEGACY_ACCOUNT_UNVERIFIED", providerLayer: "identity",
  });
  let taskList;
  try {
    taskList = await googleJsonRequest({
      accessToken,
      url: `https://tasks.googleapis.com/tasks/v1/users/@me/lists/${encodeURIComponent(storedTaskListId)}`,
      providerLayer: "tasks", fetchImpl,
    });
  } catch {
    throw new GoogleProviderError("Original Google task list cannot be verified", {
      status: 409, code: "GOOGLE_LEGACY_ACCOUNT_UNVERIFIED", providerLayer: "identity",
    });
  }
  if (taskList?.id !== storedTaskListId) throw new GoogleProviderError("Original Google task list cannot be verified", {
    status: 409, code: "GOOGLE_LEGACY_ACCOUNT_UNVERIFIED", providerLayer: "identity",
  });
  return true;
}

export async function probeGoogleCapabilities(accessToken, {
  fetchImpl = globalThis.fetch, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const probe = async (url, providerLayer) => {
    try {
      await googleJsonRequest({ accessToken, url, providerLayer, fetchImpl, sleep, readAttempts: 1 });
      return "ok";
    } catch (error) {
      if (error?.code === "CALENDAR_SCOPE_MISSING" || error?.code === "SCOPE_MISSING") return "scope_missing";
      return "unavailable";
    }
  };
  const [tasks, calendar] = await Promise.all([
    probe("https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1", "tasks"),
    probe(GOOGLE_CALENDAR_PROBE, "calendar"),
  ]);
  return { tasks, calendar };
}

// `rpc` is the existing service-role PostgREST caller. The lease and cache are
// database-backed so separate Edge isolates observe the same refresh result.
/** @param {{ownerId: string, encryptionKey: string, rpc: (name: string, body: Record<string, unknown>) => Promise<any>, clientId: string, clientSecret: string, fetchImpl?: typeof fetch, sleep?: (milliseconds: number) => Promise<void>, now?: () => number, maxWaitMs?: number}} options */
export async function coordinatedGoogleAccess({
  ownerId, encryptionKey, rpc, clientId, clientSecret,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now, maxWaitMs = 50_000,
} = {}) {
  if (!ownerId || !encryptionKey || typeof rpc !== "function") throw new GoogleProviderError("Google credential store is unavailable", {
    status: 503, code: "CREDENTIAL_STORE_ERROR", providerLayer: "credential_store", retryable: true,
  });
  const started = now();
  while (now() - started < maxWaitMs) {
    const leaseId = crypto.randomUUID();
    const claim = (await rpc("claim_google_auth_refresh", {
      target_owner: ownerId, new_lease_id: leaseId, encryption_key: encryptionKey,
    }))?.[0];
    if (claim?.outcome === "missing") throw new GoogleProviderError("Google Tasks is not connected", {
      status: 428, code: "GOOGLE_NOT_CONNECTED", providerLayer: "credential_store",
    });
    if (claim?.outcome === "cached" && claim.access_token) {
      let subject = claim.google_subject || null;
      if (!subject) {
        try {
          const verified = await googleSubjectForAccessToken(claim.access_token, { fetchImpl });
          const bound = await rpc("bind_google_auth_subject", {
            target_owner: ownerId, expected_access_token: claim.access_token,
            verified_google_subject: verified, encryption_key: encryptionKey,
          });
          if (!bound) continue; // Reconnect or refresh changed the cached token.
          subject = verified;
        } catch (error) {
          if (error instanceof GoogleProviderError && !error.retryable) {
            // A legacy token without identity scope can still serve Tasks, but
            // callers requiring account-bound recovery must reject null.
          } else throw error;
        }
      }
      return { accessToken: claim.access_token, taskListId: claim.tasklist_id, googleSubject: subject,
        capabilities: { tasks: claim.tasks_health || "unknown", calendar: claim.calendar_health || "unknown",
          checkedAt: claim.capability_checked_at || null }, lastSuccessAt: claim.last_success_at || null,
        lastErrorCode: claim.last_error_code || null };
    }
    if (claim?.outcome === "busy") {
      await sleep(Math.min(1_000, Math.max(100, Number(claim.retry_after_ms) || 250)));
      continue;
    }
    if (claim?.outcome !== "claimed" || !claim.refresh_token) throw new GoogleProviderError("Google refresh lease could not be acquired", {
      status: 503, code: "GOOGLE_REFRESH_COORDINATION_ERROR", providerLayer: "credential_store", retryable: true,
    });
    try {
      const token = await refreshGoogleAccessToken({
        ownerId, clientId, clientSecret, refreshToken: claim.refresh_token, fetchImpl, sleep,
      });
      let verifiedSubject = null;
      if (!claim.google_subject) {
        // Legacy rows are backfilled only from their own working credential.
        try { verifiedSubject = await googleSubjectForAccessToken(token.accessToken, { fetchImpl }); }
        catch { /* Tasks can still work; reconnect remains blocked until identity is proven. */ }
      }
      const saved = await rpc("finish_google_auth_refresh", {
        target_owner: ownerId, held_lease_id: leaseId,
        old_refresh_token: claim.refresh_token,
        new_refresh_token: token.refreshToken === claim.refresh_token ? "" : token.refreshToken,
        new_access_token: token.accessToken, expires_in_seconds: token.expiresIn || 3600,
        verified_google_subject: verifiedSubject, encryption_key: encryptionKey,
      });
      if (saved === true) return {
        accessToken: token.accessToken, taskListId: claim.tasklist_id,
        googleSubject: claim.google_subject || verifiedSubject,
        capabilities: { tasks: claim.tasks_health || "unknown", calendar: claim.calendar_health || "unknown",
          checkedAt: claim.capability_checked_at || null },
        lastSuccessAt: new Date().toISOString(), lastErrorCode: null,
      };
      // A reconnect or another owner of the lease won. Read the current state.
      await rpc("fail_google_auth_refresh", {
        target_owner: ownerId, held_lease_id: leaseId,
        safe_error_code: "GOOGLE_REFRESH_STATE_CHANGED",
      });
    } catch (error) {
      try { await rpc("fail_google_auth_refresh", {
        target_owner: ownerId, held_lease_id: leaseId,
        safe_error_code: error?.code || "GOOGLE_REFRESH_ERROR",
      }); } catch { /* Preserve the original provider error. */ }
      throw error;
    }
  }
  throw new GoogleProviderError("Google authorization is still recovering", {
    status: 503, code: "GOOGLE_REFRESH_IN_PROGRESS", providerLayer: "credential_store", retryable: true,
  });
}
