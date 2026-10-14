import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { evaluateAutonomy } from "../supabase/functions/_shared/autonomy-policy.js";
import { normalizeIntake, taskDispatchPayload } from "../supabase/functions/_shared/personal-os-intake.js";
import { frozenIntake, isMissed } from "../supabase/functions/_shared/request-recovery.js";

const receivedAt = "2026-10-14T06:00:00Z";
const target = "2026-11-01";
const ActualDate = globalThis.Date;
class FixedDate extends ActualDate {
  constructor(...args) { super(...(args.length ? args : [receivedAt])); }
  static now() { return ActualDate.parse(receivedAt); }
}

// Reuse the repository's established fully simulated actual-intake harness.
// Do not import its test registrations or read any actual environment/secrets.
const harnessURL = new URL("../test/autonomy-intake-integration.test.js", import.meta.url);
const harnessSource = await readFile(harnessURL, "utf8");
const harnessBody = harnessSource.slice(harnessSource.indexOf("let importNumber = 0;"), harnessSource.indexOf("function taskStatusWrites("))
  .replaceAll("import.meta.url", JSON.stringify(harnessURL.href));
const loadHarness = new Function("assert", harnessBody + "; return loadIntakeHandler;")(assert);

const mcp = await readFile(new URL("../supabase/functions/personal-os-mcp/index.ts", import.meta.url), "utf8");
const gatewayBody = stripTypeScriptTypes(mcp.slice(mcp.indexOf("function reminderArguments("), mcp.indexOf("async function updateTaskReminder(")));
const scenarios = [
  { name: "due-only plus quantity word", raw_text: "11月初整理一点虚构资料，无时刻，不要弹窗", due: target },
  { name: "due-only after clockless reconfirmation", raw_text: "确认11月初整理虚构资料，无时刻，不要弹窗", due: target },
  { name: "both explicit date fields plus quantity control", raw_text: "11月初整理一点虚构资料，无时刻，不要弹窗", due: target, requested_date: target },
  { name: "both explicit date fields pure-date control", raw_text: "2026-11-01整理虚构资料，无时刻，不要弹窗", due: target, requested_date: target },
];
const results = [];
const previousLog = console.log;
const previousInfo = console.info;
// The actual handler logs synthetic successes. Keep stdout machine-readable;
// its captured writes/receipts remain in the result rather than console noise.
console.log = () => {};
console.info = () => {};
globalThis.Date = FixedDate;
try {
  for (const scenario of scenarios) {
    const input = { type: "task", title: "整理虚构资料", requested_time: null, fixed_time: false,
      reminder_policy: "none", timezone: "Asia/Shanghai", ...scenario };
    delete input.name;
    const direct = normalizeIntake(input, { baseDate: receivedAt });
    const policy = evaluateAutonomy(input, { baseDate: receivedAt });
    const normalized = normalizeIntake(frozenIntake(policy.input, receivedAt), { baseDate: receivedAt });
    const harness = await loadHarness();
    try {
      let forwarded, handlerReply;
      const gateway = new Function("fetch", "SUPABASE_URL", "WRITE_TOKEN", "intakeConfirmation", gatewayBody + ";return createTask;")(
        async (_url, init) => {
          forwarded = JSON.parse(init.body);
          const response = await harness.request(forwarded);
          handlerReply = await response.clone().json();
          return response;
        }, "https://isolated.test", "synthetic-token", () => "synthetic confirmation");
      await gateway({ ...input, idempotency_key: "synthetic-date-diagnosis" });
      const created = harness.writes.find(call => call.path.endsWith("/functions/v1/task-status") && call.body?.title);
      results.push({ scenario: scenario.name, supplied: { due: input.due ?? null, requested_date: input.requested_date ?? null },
        gatewayForwarded: { due: forwarded.due, requested_date: forwarded.requested_date, requested_time: forwarded.requested_time, reminder_policy: forwarded.reminder_policy },
        directNormalizeDate: direct.due,
        afterAutonomy: { due: normalized.due, requested_date: normalized.requested_date, requested_time: normalized.requested_time,
          reminder_policy: normalized.schedule?.reminder_policy, reminder_at: normalized.schedule?.reminder_at, missed: isMissed(normalized, new FixedDate()) },
        actualHandler: { code: handlerReply.code ?? null, stage: harness.getAudit()?.stage, simulatedTaskCreateCount: harness.createAttempts(),
          simulatedCreatedDate: created?.body?.dueDate ?? null },
        helperDispatchDate: taskDispatchPayload(normalized).dueDate });
    } finally { harness.restore(); }
  }
} finally { globalThis.Date = ActualDate; console.log = previousLog; console.info = previousInfo; }
console.log(JSON.stringify({ mode: "pure_simulation", actualNetworkAccess: false, realTaskWrites: 0, receivedAt, results }, null, 2));
