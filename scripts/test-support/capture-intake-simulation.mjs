// Reuse the established synthetic adapters; never import test registrations.
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { intakeConfirmation } from "../../supabase/functions/_shared/autonomy-runtime.js";

let loadHarness;
export async function simulateCaptures(inputs) {
  const harnessURL = new URL("../../test/autonomy-intake-integration.test.js", import.meta.url);
  const harnessSource = await readFile(harnessURL, "utf8");
  const harnessBody = harnessSource.slice(harnessSource.indexOf("let importNumber = 0;"), harnessSource.indexOf("function taskStatusWrites("))
    .replaceAll("import.meta.url", JSON.stringify(harnessURL.href));
  // Preserve the harness import counter across invocations, so each handler
  // import executes Deno.serve instead of resolving an earlier module cache.
  loadHarness ||= new Function("assert", harnessBody + ";return loadIntakeHandler;")(assert);
  const mcp = await readFile(new URL("../../supabase/functions/personal-os-mcp/index.ts", import.meta.url), "utf8");
  const gatewayBody = stripTypeScriptTypes(mcp.slice(mcp.indexOf("function reminderArguments("), mcp.indexOf("async function updateTaskReminder("))
    + mcp.slice(mcp.indexOf("async function captureItem("), mcp.indexOf("const GOAL_SELECT")));
  const harness = await loadHarness();
  const previousLog = console.log, previousInfo = console.info;
  console.log = () => {}; console.info = () => {};
  let gatewayRequests = 0;
  try {
    const capture = new Function("fetch", "SUPABASE_URL", "WRITE_TOKEN", "intakeConfirmation", gatewayBody + ";return captureItem;")(
      async (_url, init) => { gatewayRequests += 1; return harness.request(JSON.parse(init.body)); },
      "https://personal-os.test", harness.token, intakeConfirmation);
    const results = [];
    for (const input of inputs) {
      const response = await capture({ ...input, idempotency_key: "synthetic-confirmation-diagnosis" });
      const receipt = response.structuredContent;
      results.push({ code: receipt.code ?? null, outcome: receipt.outcome ?? null, success: receipt.success,
        retry_requires_user_intent: receipt.retry_requires_user_intent ?? false,
        request_id_present: Object.hasOwn(receipt, "request_id"), simulatedTaskCreateCount: harness.createAttempts(),
        simulatedAuditPresent: harness.getAudit() !== null });
    }
    return { mode: "actual_functions_with_synthetic_adapters", realNetworkAccess: false, realTaskWrites: 0,
      gatewayRequests, results, simulatedTaskCreateCount: harness.createAttempts(),
      contextReads: harness.writes.filter(x => x.body?.action === "autonomy_context").length };
  } finally { harness.restore(); console.log = previousLog; console.info = previousInfo; }
}
