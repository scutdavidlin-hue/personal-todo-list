// Offline contract only. No credentials, registration, network sender or cron.
import { countdownPhase } from "./mobile-reminders-core.js";

export function activityKitStartRequest(plan, bundleId, now = Date.now() / 1000) {
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId || "")) throw new Error("Invalid bundle ID");
  if (!plan.taskId || !plan.title || !Number.isFinite(plan.eventAt)
    || !Number.isFinite(plan.liveActivityStartAt) || plan.liveActivityStartAt !== plan.eventAt - 3600
    || countdownPhase(plan, now) !== "active") throw new Error("Outside authorized countdown window");
  return {
    headers: {
      "apns-push-type": "liveactivity",
      "apns-topic": `${bundleId}.push-type.liveactivity`,
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(plan.eventAt)),
    },
    body: { aps: {
      timestamp: Math.floor(now), event: "start",
      "attributes-type": "CountdownAttributes",
      attributes: { taskId: plan.taskId, title: plan.title },
      "content-state": { startEpoch: plan.liveActivityStartAt, eventEpoch: plan.eventAt },
      "stale-date": Math.floor(plan.eventAt),
      alert: { title: plan.title, body: `${Math.ceil((plan.eventAt - now) / 60)} 分钟后开始，请准备。`, sound: "default" },
    } },
  };
}

export function activityKitEndRequest(plan, bundleId, now = Date.now() / 1000) {
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId || "")) throw new Error("Invalid bundle ID");
  if (!plan.taskId || !Number.isFinite(plan.eventAt) || !Number.isFinite(plan.liveActivityStartAt)) throw new Error("Invalid activity plan");
  return {
    headers: { "apns-push-type": "liveactivity", "apns-topic": `${bundleId}.push-type.liveactivity`, "apns-priority": "10" },
    body: { aps: { timestamp: Math.floor(now), event: "end", "dismissal-date": Math.floor(now),
      "content-state": { startEpoch: plan.liveActivityStartAt, eventEpoch: plan.eventAt } } },
  };
}
