import { TaskCloudClient } from "./src/cloud-client.js";
import { escapeHtml } from "./src/core.js";
import { devicePlan, makeDeviceSnapshot, countdownPhase, formatDeviceTime } from "./src/mobile-reminders-core.js";

const client = new TaskCloudClient(window.TASK_SYNC_CONFIG || {});
const $ = selector => document.querySelector(selector);
let rows = [], schedules = [], demoMode = false, loading = false;
let loadedUserId = null;
const selected = new Set(), closedCountdowns = new Set();

function render() {
  $("#tasks").innerHTML = rows.map(task => {
    let plan, error = "";
    try { plan = devicePlan(task, schedules.find(s => s.google_task_id === task.id)); } catch (e) { error = e.message; }
    const times = plan?.reminderAt.map(at => formatDeviceTime(at, plan.timezone)).join("、");
    return `<article><label><input type="checkbox" data-select="${escapeHtml(task.id)}" ${selected.has(task.id) ? "checked" : ""} ${error ? "disabled" : ""}>${escapeHtml(task.title)}</label><p class="detail">${escapeHtml(error || (plan.enabled ? `提醒 ${times} · 开始 ${formatDeviceTime(plan.eventAt, plan.timezone)} · ${plan.timezone}` : "提醒已停用：导入可移除这条任务的本机提醒"))}</p>${plan?.enabled ? `<p class="countdown" data-countdown="${escapeHtml(task.id)}"></p><button data-close="${escapeHtml(task.id)}">关闭网页倒计时</button>` : ""}</article>`;
  }).join("") || "<p>没有可导出的任务。</p>";
  $("#export").disabled = loading || !selected.size || demoMode;
  tick();
}

function tick() {
  for (const element of document.querySelectorAll("[data-countdown]")) {
    if (closedCountdowns.has(element.dataset.countdown)) { element.textContent = "网页倒计时已关闭"; continue; }
    const task = rows.find(t => t.id === element.dataset.countdown);
    try {
      const plan = devicePlan(task, schedules.find(s => s.google_task_id === task.id));
      const phase = countdownPhase(plan);
      const seconds = Math.max(0, Math.ceil(plan.eventAt - Date.now() / 1000));
      element.textContent = phase === "waiting" ? `倒计时从 ${formatDeviceTime(plan.liveActivityStartAt, plan.timezone)} 开始`
        : phase === "active" ? `网页倒计时 ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : "开始时刻已到";
    } catch { element.textContent = "请刷新任务"; }
  }
}

async function load() {
  if (loading) return;
  loading = true; demoMode = false; loadedUserId = null; rows = []; schedules = []; selected.clear(); render();
  $("#status").textContent = "正在只读获取 Tasks 与 Schedule…";
  try {
    const user = await client.getUser();
    if (!user) throw new Error("请返回 Personal OS，在同一浏览器登录后再打开此页。");
    const [tasks, result] = await Promise.all([client.getTasks(), client.listSchedules()]);
    if (client.session()?.user?.id !== user.id) throw new Error("登录状态已改变，请重新读取。");
    loadedUserId = user.id; rows = tasks; schedules = result.schedules || [];
    $("#status").textContent = `已读取 ${rows.length} 条现有任务。尚未安装或验证手机通知。`;
  } catch (error) { $("#status").textContent = error.message; }
  finally { loading = false; render(); }
}

$("#refresh").addEventListener("click", load);
$("#demo").addEventListener("click", () => {
  if (loading) return;
  demoMode = true; loadedUserId = null; selected.clear(); closedCountdowns.clear();
  const event = new Date(Date.now() + 120_000);
  const wall = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(event).replace(" ", "T");
  rows = [{ id: "synthetic-preview", title: "模拟抢票 · 不是真实任务", date: wall.slice(0, 10), status: "open" }];
  schedules = [{ google_task_id: rows[0].id, scheduled_date: wall.slice(0, 10), scheduled_start: wall.slice(11), timezone: "Asia/Shanghai", reminder_policy: "custom", reminders: [{ at: new Date(event - 60_000).toISOString().replace(".000", "").replace(/\.\d{3}Z$/, "Z") }] }];
  $("#status").textContent = "模拟数据：没有读取、修改真实任务，也没有手机送达记录。";
  render();
});
$("#tasks").addEventListener("change", event => {
  const id = event.target.dataset.select;
  if (id) { event.target.checked ? selected.add(id) : selected.delete(id); $("#export").disabled = !selected.size || demoMode || loading; }
});
$("#tasks").addEventListener("click", event => { if (event.target.dataset.close) { closedCountdowns.add(event.target.dataset.close); tick(); } });
$("#export").addEventListener("click", async () => {
  if (demoMode || loading || !selected.size) return;
  const ids = new Set(selected), expectedUser = loadedUserId;
  $("#export").disabled = true;
  try {
    // Re-read both sources on export: don't arm a stale page snapshot.
    const user = await client.getUser();
    if (!expectedUser || user?.id !== expectedUser) throw new Error("登录账户已改变，请重新读取。");
    const [tasks, result] = await Promise.all([client.getTasks(), client.listSchedules()]);
    if (client.session()?.user?.id !== expectedUser) throw new Error("登录账户已改变，请重新读取。");
    const chosen = tasks.filter(task => ids.has(task.id));
    if (chosen.length !== ids.size) throw new Error("所选任务已删除或不可读，请重新读取；本机旧提醒需在 App 移除。");
    const snapshot = makeDeviceSnapshot(chosen, result.schedules || []);
    const file = new File([JSON.stringify(snapshot, null, 2)], "personal-os-reminders.json", { type: "application/json" });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: "Personal OS 手机提醒配置" });
    else {
      const url = URL.createObjectURL(file), link = document.createElement("a");
      link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    $("#status").textContent = "已导出最新配置。请在伴随 App 导入并安排；导出不代表手机提醒已安排或送达。";
  } catch (error) { $("#status").textContent = error.name === "AbortError" ? "已取消导出。" : error.message; }
  finally { $("#export").disabled = !selected.size || demoMode; }
});
setInterval(tick, 1000);
load();
