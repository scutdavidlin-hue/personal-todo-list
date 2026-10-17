const $ = id => document.getElementById(id);
let csrf, preview, challenge, approval, dirty = false, busy = false;
const log = message => { $("trace").textContent = `${new Date().toLocaleTimeString()} ${message}\n` + $("trace").textContent; };
const names = { pending: "等待明确确认", claimed: "合成执行准备中", applied: "已模拟执行（仅内存）", revoked: "已拒绝，旧批准作废", superseded: "已改口，旧预览作废", unknown: "模拟结果未知，不自动重发" };
function controls() {
  $("session").disabled = busy; $("build").disabled = busy || !csrf;
  $("revise").disabled = busy || !preview || !["pending", "superseded"].includes(preview.status);
  for (const id of ["approve", "reject", "change"]) $(id).disabled = busy || !challenge || dirty;
  $("execute").disabled = busy || !approval || dirty;
  $("dirty").hidden = !dirty;
}
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-Demo-CSRF": csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.code || `HTTP ${response.status}`); error.code = value.code; throw error; }
  return value;
}
const input = () => ({ title: $("title").value, notes: $("notes").value, raw_text: `提醒我${$("title").value}`,
  requested_date: $("date").value, reminder_policy: "none" });
async function refresh() {
  const state = await api("/demo/state"); $("count").textContent = state.simulated_execution_count;
  if (!preview) return;
  const value = await api(`/demo/preview/${preview.proposal_id}`); preview = value.preview; challenge = value.challenge_id;
  $("status").textContent = names[preview.status] || preview.status;
  const p = preview.scope.payload;
  $("scope").textContent = `标题：${p.title}\n备注：${p.notes || "无"}\n日期：${p.dueDate || "无"}\n范围：仅单条独立创建；无真实提醒或任务写入`;
  $("binding").textContent = `版本 ${preview.version} · ${preview.proposal_id}\n摘要 ${preview.scope_digest.slice(0, 20)}… · 到期 ${new Date(preview.expires_at).toLocaleTimeString()}`;
}
async function action(work) {
  if (busy) return; busy = true; controls();
  try { await work(); }
  catch (error) { $("result").textContent = `合成检查停止：${error.message}`; log(`拒绝 / ${error.message}`); }
  finally { if (csrf) { try { await refresh(); } catch (error) { log(error.message); } } busy = false; controls(); }
}
$("session").addEventListener("click", () => action(async () => {
  const result = await api("/demo/session", { persona: $("persona").value }); csrf = result.csrf;
  preview = challenge = approval = null; dirty = false; $("scope").textContent = "等待新预览。"; $("binding").textContent = "";
  $("identity").textContent = `当前：虚构用户 ${result.persona.toUpperCase()}（无真实认证）`;
  $("status").textContent = "等待合成预览"; $("result").textContent = "尚无已存批准。"; log("选择假身份；没有调用真实 Auth");
}));
$("build").addEventListener("click", () => action(async () => {
  preview = await api("/demo/proposals", { input: input(), conversation_id: "synthetic-ui-thread" });
  approval = null; dirty = false; log(`生成合成预览 v${preview.version}`);
}));
$("revise").addEventListener("click", () => action(async () => {
  preview = await api(`/demo/proposals/${preview.proposal_id}/revise`, { version: preview.version, input: input() });
  approval = null; dirty = false; $("result").textContent = "旧版本已作废，请重新审核。"; log(`生成新预览 v${preview.version}；旧批准不可用于新内容`);
}));
for (const id of ["title", "notes", "date"]) $(id).addEventListener("input", () => { if (preview) dirty = true; controls(); });
for (const [id, decision] of [["approve", "approve_exact"], ["reject", "reject"], ["change", "change_scope"]]) $(id).addEventListener("click", () => action(async () => {
  const review = await api("/demo/review", { challenge_id: challenge, decision });
  if (decision === "approve_exact") {
    approval = { preview: structuredClone(preview), eventId: review.event_id };
    $("result").textContent = "已存合成批准；尚未模拟执行。";
  } else $("result").textContent = review.closure?.code || "旧预览已关闭。";
  log(`服务端记录合成事件 ${decision}；${review.event_id}`);
}));
$("execute").addEventListener("click", () => action(async () => {
  const p = approval.preview;
  const result = await api(`/demo/proposals/${p.proposal_id}/confirm`, { version: p.version, scope_digest: p.scope_digest, reply_event_id: approval.eventId });
  $("result").textContent = result.replayed ? `合成幂等回读：${result.id}，未重复执行。` : `独立校验通过，已模拟执行：${result.id}。真实写入 0。`;
  log(`独立验证器读取内存事件 → ${result.replayed ? "原回执重放" : "内存模拟执行"}`);
}));
controls();
