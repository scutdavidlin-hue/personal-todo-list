// Isolated HTTP implementation. No Deno.serve, credentials, database connection,
// network sender, registration upload or cron. All capabilities are injected.
import { devicePlan } from "../../src/mobile-reminders-core.js";
import { activityKitStartRequest, activityKitEndRequest } from "../../src/activitykit-push-contract.js";

const NOTIFICATION_STATES = new Set(["notDetermined", "denied", "authorized", "provisional", "ephemeral"]);
const MAX_PERMISSION_AGE = 7 * 86400;
class DeviceError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (condition, code, status) => { if (!condition) throw new DeviceError(code, status); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUNDLE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const unix = value => Number.isFinite(value) && value > 0;

function onlyFields(input, allowed) {
  fail(input && typeof input === "object" && !Array.isArray(input), "INVALID_BODY");
  fail(Object.keys(input).every(key => allowed.includes(key)), "UNEXPECTED_FIELD");
}
function permissions(input, now) {
  onlyFields(input, ["notificationAuthorization", "alertsEnabled", "soundEnabled", "liveActivitiesEnabled", "observedAt"]);
  fail(NOTIFICATION_STATES.has(input.notificationAuthorization)
    && ["alertsEnabled", "soundEnabled", "liveActivitiesEnabled"].every(key => typeof input[key] === "boolean")
    && unix(input.observedAt) && input.observedAt <= now + 300 && input.observedAt >= now - MAX_PERMISSION_AGE, "INVALID_PERMISSION_SNAPSHOT");
  return { ...input };
}
function safeDevice(row) {
  return { deviceId: row.deviceId, bundleId: row.bundleId, environment: row.environment, iosVersion: row.iosVersion,
    revision: row.revision, revoked: row.revoked, automaticCountdownEnabled: row.automaticCountdownEnabled,
    permissions: row.permissions, pushToStartTokenRegistered: Boolean(row.pushToStartTokenSealed),
    registered: true, checkedAt: row.updatedAt };
}
function pushSupported(iosVersion) {
  const [major, minor = 0] = iosVersion.split(".").map(Number);
  return major > 17 || (major === 17 && minor >= 2);
}
function eligibility(device, now) {
  if (device.revoked || !device.automaticCountdownEnabled) return "DEVICE_NOT_OPTED_IN";
  if (!pushSupported(device.iosVersion)) return "PUSH_TO_START_UNSUPPORTED";
  if (!device.pushToStartTokenSealed) return "PUSH_TOKEN_MISSING";
  const p = device.permissions;
  if (p.observedAt < now - MAX_PERMISSION_AGE) return "PERMISSIONS_STALE";
  if (p.notificationAuthorization !== "authorized" || !p.alertsEnabled || !p.liveActivitiesEnabled) return "DEVICE_PERMISSIONS_DISABLED";
  return null;
}

async function boundedBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  let bytes = 0, text = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 16384) { await reader.cancel(); throw new DeviceError("BODY_TOO_LARGE", 413); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try { return text ? JSON.parse(text) : {}; } catch { throw new DeviceError("INVALID_JSON"); }
}

/**
 * Production bindings remain gated: authenticateUser must verify existing user
 * JWT; authenticateWorker must verify the existing authorized worker identity.
 * store uses atomic owner-scoped CAS/unique window claims. tokenVault must seal
 * tokens at rest. No raw tokens may be logged or included in public receipts.
 */
export function createMobileDeviceHandler({ authenticateUser, authenticateWorker, store, tokenVault,
  readCanonical, sendActivityStart, sendActivityEnd, clock = () => Date.now() / 1000 } = {}) {
  async function deviceFor(ownerId, deviceId) {
    fail(ID.test(deviceId), "INVALID_DEVICE_ID");
    const device = await store.getDevice(ownerId, deviceId);
    fail(device?.ownerId === ownerId && device.deviceId === deviceId, "DEVICE_NOT_FOUND", 404);
    return device;
  }
  async function seal(token, scope) {
    fail(typeof token === "string" && /^[0-9a-f]{64,1024}$/i.test(token) && token.length % 2 === 0, "INVALID_PUSH_TOKEN");
    fail(typeof tokenVault?.seal === "function", "TOKEN_VAULT_NOT_CONFIGURED", 503);
    const sealed = await tokenVault.seal(token.toLowerCase(), scope);
    fail(typeof sealed === "string" && sealed.length > 0 && sealed !== token, "TOKEN_VAULT_UNVERIFIED", 503);
    return sealed;
  }
  async function dispatch(ownerId, now) {
    // Missing production wiring must fail before claiming a send window.
    fail(typeof readCanonical === "function" && typeof sendActivityStart === "function"
      && typeof tokenVault?.unseal === "function", "DELIVERY_NOT_CONFIGURED", 503);
    const results = [];
    const follows = await store.listFollows(ownerId);
    fail(follows.length <= 100, "BATCH_LIMIT", 503);
    for (const follow of follows) {
      const device = await deviceFor(ownerId, follow.deviceId);
      const blocked = eligibility(device, now);
      if (blocked) { results.push({ deviceId: device.deviceId, taskId: follow.taskId, status: blocked }); continue; }
      const canonical = await readCanonical(ownerId, follow.taskId);
      let plan;
      try { plan = devicePlan(canonical.task, canonical.schedule, now); }
      catch { results.push({ deviceId: device.deviceId, taskId: follow.taskId, status: "CANONICAL_TASK_NOT_ELIGIBLE" }); continue; }
      if (!plan.enabled || now < plan.liveActivityStartAt || now > plan.liveActivityStartAt + 60) {
        results.push({ deviceId: device.deviceId, taskId: follow.taskId, status: "OUTSIDE_START_WINDOW" }); continue;
      }
      const window = { ownerId, deviceId: device.deviceId, taskId: plan.taskId, eventAt: plan.eventAt };
      // Atomic uniqueness + durable claim BEFORE any transport call. A crashed
      // or unknown attempt is never automatically sent again.
      if (!await store.claimWindow(window, { deviceRevision: device.revision, claimedAt: now })) {
        results.push({ deviceId: device.deviceId, taskId: plan.taskId, status: "ALREADY_CLAIMED_OR_CLOSED" }); continue;
      }
      let status = "OUTCOME_UNKNOWN", transportAccepted = false;
      try {
        const current = await deviceFor(ownerId, device.deviceId);
        const latest = await readCanonical(ownerId, follow.taskId);
        const currentPlan = devicePlan(latest.task, latest.schedule, now);
        const stopped = await store.isWindowClosed(window);
        if (stopped || eligibility(current, now) || current.revision !== device.revision
          || !currentPlan.enabled || JSON.stringify(currentPlan) !== JSON.stringify(plan)) {
          status = "STOPPED_BEFORE_SEND";
        } else {
          const token = await tokenVault.unseal(current.pushToStartTokenSealed, { ownerId, deviceId: device.deviceId, kind: "pushToStart" });
          const request = activityKitStartRequest(plan, current.bundleId, now);
          const response = await sendActivityStart({ token, environment: current.environment, request });
          transportAccepted = response?.accepted === true;
          status = transportAccepted ? "APNS_ACCEPTED_DEVICE_UNVERIFIED" : response?.rejected === true ? "APNS_REJECTED" : "OUTCOME_UNKNOWN";
        }
      } catch { /* No provider exception/token text in receipts or logs. */ }
      await store.recordWindowOutcome(window, { status, transportAccepted, delivered: false, checkedAt: now });
      results.push({ deviceId: device.deviceId, taskId: plan.taskId, status, transportAccepted, delivered: false });
    }
    return { results, checkedAt: now, deviceDeliveryVerified: false };
  }

  async function dispatchEnds(ownerId, now) {
    fail(typeof sendActivityEnd === "function" && typeof tokenVault?.unseal === "function", "END_DELIVERY_NOT_CONFIGURED", 503);
    const windows = await store.listEndingWindows(ownerId, now);
    fail(windows.length <= 100, "BATCH_LIMIT", 503);
    const results = [];
    for (const window of windows) {
      const device = await deviceFor(ownerId, window.deviceId);
      if (device.revoked || !window.activityTokenSealed || !await store.claimEnd(window, now)) continue;
      let status = "END_OUTCOME_UNKNOWN", transportAccepted = false;
      try {
        const token = await tokenVault.unseal(window.activityTokenSealed, { ownerId, deviceId: device.deviceId, kind: "activity" });
        const response = await sendActivityEnd({ token, environment: device.environment,
          request: activityKitEndRequest({ taskId: window.taskId, eventAt: window.eventAt, liveActivityStartAt: window.eventAt - 3600 }, device.bundleId, now) });
        transportAccepted = response?.accepted === true;
        status = transportAccepted ? "END_APNS_ACCEPTED_DEVICE_UNVERIFIED" : response?.rejected === true ? "END_APNS_REJECTED" : "END_OUTCOME_UNKNOWN";
      } catch { /* Never echo private token/provider exception content. */ }
      await store.recordEndOutcome(window, { status, transportAccepted, deviceEndedVerified: false, checkedAt: now });
      results.push({ deviceId: window.deviceId, taskId: window.taskId, status, transportAccepted, deviceEndedVerified: false });
    }
    return { results, checkedAt: now, deviceDeliveryVerified: false };
  }

  return async function handle(request) {
    try {
      fail(store, "DEVICE_STORE_NOT_CONFIGURED", 503);
      const now = Math.floor(clock());
      const path = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const worker = path.length === 1 && ["dispatch-due", "dispatch-end"].includes(path[0]);
      const authenticate = worker ? authenticateWorker : authenticateUser;
      fail(typeof authenticate === "function", "AUTH_NOT_CONFIGURED", 503);
      const caller = await authenticate(request);
      fail(typeof caller?.ownerId === "string" && caller.ownerId.length > 0, "UNAUTHORIZED", 401);
      const ownerId = caller.ownerId;
      if (worker) {
        fail(request.method === "POST", "METHOD_NOT_ALLOWED", 405);
        onlyFields(await boundedBody(request), []);
        return json(await (path[0] === "dispatch-due" ? dispatch(ownerId, now) : dispatchEnds(ownerId, now)));
      }
      fail(path[0] === "devices", "NOT_FOUND", 404);
      if (request.method === "GET" && path.length === 1) {
        const rows = await store.listDevices(ownerId);
        fail(rows.length <= 20 && rows.every(row => row.ownerId === ownerId), "DEVICE_READ_UNVERIFIED", 503);
        return json({ devices: rows.map(safeDevice) });
      }
      if (request.method === "POST" && path.length === 1) {
        const input = await boundedBody(request);
        onlyFields(input, ["deviceId", "bundleId", "environment", "iosVersion", "permissions", "automaticCountdownEnabled", "expectedRevision", "pushToStartToken"]);
        fail(ID.test(input.deviceId) && BUNDLE.test(input.bundleId) && input.bundleId.length <= 200
          && ["sandbox", "production"].includes(input.environment) && /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(input.iosVersion)
          && typeof input.automaticCountdownEnabled === "boolean" && Number.isInteger(input.expectedRevision) && input.expectedRevision >= 0, "INVALID_DEVICE");
        const previous = await store.getDevice(ownerId, input.deviceId);
        fail(!previous || (previous.ownerId === ownerId && previous.deviceId === input.deviceId), "DEVICE_READ_UNVERIFIED", 503);
        fail(!previous?.revoked, "DEVICE_REVOKED", 409);
        fail((previous?.revision || 0) === input.expectedRevision, "REVISION_CONFLICT", 409);
        const row = { ownerId, deviceId: input.deviceId, bundleId: input.bundleId, environment: input.environment,
          iosVersion: input.iosVersion, permissions: permissions(input.permissions, now),
          automaticCountdownEnabled: input.automaticCountdownEnabled, revoked: false, revision: input.expectedRevision + 1,
          updatedAt: now, pushToStartTokenSealed: previous?.pushToStartTokenSealed || null };
        // A bundle/environment change must never reuse a token for its old APNs topic.
        if (previous && (previous.bundleId !== row.bundleId || previous.environment !== row.environment)) row.pushToStartTokenSealed = null;
        if (input.pushToStartToken !== undefined) row.pushToStartTokenSealed = await seal(input.pushToStartToken, { ownerId, deviceId: row.deviceId, kind: "pushToStart" });
        fail(await store.compareAndSetDevice(ownerId, row.deviceId, input.expectedRevision, row), "REVISION_CONFLICT", 409);
        const readback = await deviceFor(ownerId, row.deviceId);
        fail(JSON.stringify(safeDevice(readback)) === JSON.stringify(safeDevice(row))
          && readback.pushToStartTokenSealed === row.pushToStartTokenSealed, "DEVICE_WRITE_UNVERIFIED", 503);
        return json(safeDevice(readback));
      }
      const device = await deviceFor(ownerId, path[1]);
      if (request.method === "DELETE" && path.length === 2) {
        onlyFields(await boundedBody(request), ["expectedRevision"]);
        // Revocation is idempotent and owner-bound, even if an old client retries.
        await store.revokeDevice(ownerId, device.deviceId, now);
        const readback = await deviceFor(ownerId, device.deviceId);
        fail(readback.revoked === true && !readback.pushToStartTokenSealed && readback.automaticCountdownEnabled === false, "DEVICE_REVOKE_UNVERIFIED", 503);
        return json(safeDevice(readback));
      }
      fail(!device.revoked, "DEVICE_REVOKED", 409);
      if (path.length === 5 && path[2] === "tasks" && request.method === "POST") {
        const taskId = path[3];
        fail(taskId.length > 0 && new TextEncoder().encode(taskId).length <= 1024, "INVALID_TASK_ID");
        const input = await boundedBody(request);
        if (path[4] === "follow") {
          onlyFields(input, ["enabled"]);
          fail(typeof input.enabled === "boolean", "INVALID_FOLLOW");
          fail(typeof readCanonical === "function", "CANONICAL_READER_NOT_CONFIGURED", 503);
          const canonical = await readCanonical(ownerId, taskId);
          fail(canonical?.task?.id === taskId, "TASK_NOT_FOUND", 404);
          await store.setFollow(ownerId, device.deviceId, taskId, input.enabled);
          fail(await store.isFollowed(ownerId, device.deviceId, taskId) === input.enabled, "FOLLOW_WRITE_UNVERIFIED", 503);
          return json({ deviceId: device.deviceId, taskId, followed: input.enabled });
        }
        if (path[4] === "close") {
          onlyFields(input, ["eventAt"]);
          fail(unix(input.eventAt), "INVALID_WINDOW");
          await store.closeWindow({ ownerId, deviceId: device.deviceId, taskId, eventAt: input.eventAt }, now);
          fail(await store.isWindowClosed({ ownerId, deviceId: device.deviceId, taskId, eventAt: input.eventAt }), "CLOSE_WRITE_UNVERIFIED", 503);
          return json({ deviceId: device.deviceId, taskId, eventAt: input.eventAt, closed: true, automaticRestartAllowed: false });
        }
        if (path[4] === "activity-token") {
          onlyFields(input, ["eventAt", "activityToken"]);
          fail(unix(input.eventAt) && typeof readCanonical === "function", "INVALID_ACTIVITY_WINDOW");
          const canonical = await readCanonical(ownerId, taskId);
          // Decode the current execution time while allowing token registration
          // after its start. Terminal tasks still cannot attach a token.
          const plan = devicePlan(canonical.task, canonical.schedule, input.eventAt - 1);
          fail(plan.enabled && plan.eventAt === input.eventAt, "ACTIVITY_WINDOW_CHANGED", 409);
          const window = { ownerId, deviceId: device.deviceId, taskId, eventAt: input.eventAt };
          const sealed = await seal(input.activityToken, { ownerId, deviceId: device.deviceId, kind: "activity" });
          await store.setActivityToken(window, sealed, now);
          fail(await store.activityTokenMatches(window, sealed), "ACTIVITY_TOKEN_UNVERIFIED", 503);
          return json({ deviceId: device.deviceId, taskId, eventAt: input.eventAt, activityTokenRegistered: true });
        }
      }
      throw new DeviceError("NOT_FOUND", 404);
    } catch (error) {
      return json({ success: false, code: error instanceof DeviceError ? error.code : "DEVICE_OPERATION_UNVERIFIED" }, error instanceof DeviceError ? error.status : 503);
    }
  };
}
