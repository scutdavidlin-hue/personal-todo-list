import { readFile } from "node:fs/promises";
import { activityKitStartRequest } from "../src/activitykit-push-contract.js";

const [file, bundleId, at] = process.argv.slice(2);
if (!file || !bundleId || !at) throw new Error("Usage: node scripts/preview-activitykit-push.mjs SNAPSHOT.json BUNDLE_ID SIMULATED_UTC_ISO");
const snapshot = JSON.parse(await readFile(file, "utf8"));
const now = Date.parse(at) / 1000;
if (!Number.isFinite(now)) throw new Error("Invalid simulated time");
console.log(JSON.stringify({ mode: "offline_simulation", sent: false,
  requests: snapshot.plans.filter(plan => plan.enabled).map(plan => activityKitStartRequest(plan, bundleId, now)),
}, null, 2));
