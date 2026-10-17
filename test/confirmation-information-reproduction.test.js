import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAutonomy } from "../supabase/functions/_shared/autonomy-policy.js";
import { simulateCaptures } from "../scripts/test-support/capture-intake-simulation.mjs";

const explanatoryReply = "是的是的，因为我在考虑怎么样把这些虚构材料放进去，怎么样做数据封装。";
const proposed = { type: "task", title: "整理虚构客户档案", requested_date: "2026-10-19", reminder_policy: "none" };

test("two actual capture/intake invocations reproduce information-only with no request id or simulated write", { concurrency: false }, async () => {
  const result = await simulateCaptures([
    { ...proposed, raw_text: explanatoryReply },
    { ...proposed, raw_text: explanatoryReply, confirmed: true, context: { pending_proposal: "client-claimed", user_confirmed: true, previous_question: "创建上述虚构待办吗？" } },
  ]);
  assert.equal(result.gatewayRequests, 2); // two explicit synthetic calls, no automatic retry
  assert.equal(result.contextReads, 0);
  for (const receipt of result.results) {
    assert.equal(receipt.code, "INFORMATION_ONLY");
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.retry_requires_user_intent, true);
    assert.equal(receipt.request_id_present, false);
    assert.equal(receipt.simulatedAuditPresent, false);
    assert.equal(receipt.simulatedTaskCreateCount, 0);
  }
});
for (const raw_text of ["怎么整理这些虚构档案？", "我在考虑怎么样封装这些虚构数据", "怎么创建一个任务？"]) {
  test(`pure question stays zero-write despite task/type/confirmation claims: ${raw_text}`, { concurrency: false }, async () => {
    const input = { ...proposed, raw_text, confirmed: true, context: { confirmed: true, current_task: { id: "client-made-up" } } };
    assert.equal(evaluateAutonomy(input).intent, "information");
    const result = await simulateCaptures([input]);
    assert.equal(result.results[0].code, "INFORMATION_ONLY");
    assert.equal(result.simulatedTaskCreateCount, 0);
    assert.equal(result.results[0].simulatedAuditPresent, false);
  });
}
test("an explicit reminder command preserves the original supported route even with how-text", { concurrency: false }, async () => {
  const input = { ...proposed, raw_text: "下周提醒我整理虚构客户档案，并研究怎么样做封装" };
  assert.equal(evaluateAutonomy(input).decision, "execute");
  const result = await simulateCaptures([input]);
  assert.equal(result.results[0].success, true);
  assert.equal(result.results[0].request_id_present, true);
  assert.equal(result.simulatedTaskCreateCount, 1);
  assert.equal(result.realTaskWrites, 0);
});
