import { escapeHtml, fromDatabaseTask, groupTasksByDue, localDateISO, offsetDate, replaceTask } from "./src/core.js";
import { TaskCloudClient } from "./src/cloud-client.js";

const client = new TaskCloudClient(window.TASK_SYNC_CONFIG || {});
const $ = (selector) => document.querySelector(selector);
let tasks = [];
let user = null;
const pendingIds = new Set();

function setSync(state, message) {
  $("#syncRow").classList.remove("syncing", "error", "offline");
  if (state) $("#syncRow").classList.add(state);
  $("#syncStatus").textContent = message;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 3000);
}

function taskHtml(task) {
  const syncing = pendingIds.has(task.id);
  return `<div class="task ${task.done ? "done" : ""} ${syncing ? "syncing" : ""}" data-id="${task.id}">
    <input class="check" type="checkbox" data-action="toggle" ${task.done ? "checked" : ""} ${syncing ? "disabled" : ""} aria-label="${task.done ? "取消完成" : "标记完成"}">
    <div class="task-main"><div class="name">${escapeHtml(task.title)}</div><div class="meta">${task.dueDate ? `截止 ${escapeHtml(task.dueDate)}` : "未设置日期"} · Google Tasks</div></div>
    <div class="actions"><button data-action="tomorrow" ${syncing ? "disabled" : ""}>明天</button><button class="cancel" data-action="cancel" ${syncing ? "disabled" : ""}>取消</button></div>
  </div>`;
}

function render() {
  const groups = groupTasksByDue(tasks, localDateISO());
  const active = groups.today;
  const done = active.filter((task) => task.done).length;
  const rate = active.length ? Math.round(done / active.length * 100) : 0;
  $("#date").textContent = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  $("#rate").textContent = `${rate}%`;
  $("#bar").style.width = `${rate}%`;
  $("#countPill").textContent = `${done} / ${active.length}`;
  $("#summaryText").textContent = active.length ? `今天 ${active.length} 项，已完成 ${done} 项，剩余 ${active.length - done} 项` : "今天还没有任务";
  $("#todayList").innerHTML = groups.today.length ? groups.today.map(taskHtml).join("") : '<div class="empty">今天还没有任务</div>';
  $("#overdueList").innerHTML = groups.overdue.length ? groups.overdue.map(taskHtml).join("") : '<div class="empty">没有逾期任务</div>';
  $("#upcomingList").innerHTML = groups.upcoming.length ? groups.upcoming.slice(0, 20).map(taskHtml).join("") : '<div class="empty">没有未来任务</div>';
  const history = groups.completed.slice(0, 12);
  $("#history").innerHTML = history.length ? history.map((task) => `<div class="history-row"><span>✓ ${escapeHtml(task.title)}</span><span>${(task.completedAt || "").slice(0, 10)}</span></div>`).join("") : '<div class="empty">还没有完成记录</div>';
  bindTaskEvents();
}

function bindTaskEvents() {
  document.querySelectorAll(".task [data-action]").forEach((control) => control.addEventListener("click", () => {
    const id = control.closest(".task").dataset.id;
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    if (control.dataset.action === "toggle") mutate(id, { status: task.done ? "open" : "completed", completed_at: task.done ? null : new Date().toISOString() }, task.done ? "已恢复为未完成" : "已完成并保存到云端");
    if (control.dataset.action === "tomorrow") mutate(id, { date: offsetDate(1) }, "已移到明天");
    if (control.dataset.action === "cancel" && window.confirm("这会从 Google Tasks 永久删除任务。确定删除吗？")) cancel(id);
  }));
}

async function mutate(id, changes, successMessage) {
  if (pendingIds.has(id)) return;
  pendingIds.add(id);
  render();
  setSync("syncing", "正在保存…");
  try {
    const updated = await client.updateTask(id, changes);
    tasks = replaceTask(tasks, updated);
    client.cacheTasks(user.id, tasks);
    setSync("", "已保存到云端");
    toast(successMessage);
  } catch (error) {
    setSync("error", "保存失败，状态未改变");
    toast(`${error.message}；操作已撤回`, true);
  } finally {
    pendingIds.delete(id);
    render();
  }
}

async function cancel(id) {
  if (pendingIds.has(id)) return;
  pendingIds.add(id);
  render();
  setSync("syncing", "正在从 Google Tasks 删除…");
  try {
    await client.cancelTask(id);
    tasks = tasks.filter((task) => task.id !== id);
    client.cacheTasks(user.id, tasks);
    setSync("", "已保存到云端");
    toast("任务已从 Google Tasks 删除");
  } catch (error) {
    setSync("error", "删除失败，任务仍保留");
    toast(error.message, true);
  } finally {
    pendingIds.delete(id);
    render();
  }
}

async function addTask(event) {
  event.preventDefault();
  const input = $("#newTask");
  const button = $("#addForm button");
  const title = input.value.trim();
  if (!title) return;
  button.disabled = true;
  input.disabled = true;
  setSync("syncing", "正在添加…");
  try {
    const created = await client.createTask({ title, dueDate: localDateISO(), notes: "", status: "open", source: "manual", originalIntent: title });
    if (created.metadata?.deduplicated) tasks = replaceTask(tasks, created);
    else tasks.push(fromDatabaseTask(created));
    client.cacheTasks(user.id, tasks);
    input.value = "";
    setSync("", "已保存到云端");
    toast(created.metadata?.deduplicated ? "已识别为现有任务并更新" : "新任务已添加到 Google Tasks");
    render();
  } catch (error) {
    setSync("error", "添加失败");
    toast(error.message, true);
  } finally {
    button.disabled = false;
    input.disabled = false;
  }
}

async function refresh({ quiet = false } = {}) {
  if (!user) return;
  $("#refreshButton").disabled = true;
  setSync("syncing", "正在读取云端…");
  try {
    tasks = await client.getTasks();
    client.cacheTasks(user.id, tasks);
    render();
    setSync("", `已同步 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
    if (!quiet) toast("已读取最新状态");
  } catch (error) {
    const cached = client.readCachedTasks(user.id);
    if (Array.isArray(cached?.tasks)) {
      tasks = cached.tasks;
      render();
      setSync("offline", "离线只读 · 显示上次缓存");
      toast("网络不可用；当前为只读缓存，写操作不会假装成功", true);
    } else {
      setSync("error", "读取失败");
      toast(error.message, true);
    }
  } finally {
    $("#refreshButton").disabled = false;
  }
}

function updateMigration() {
  const plan = client.legacyMigrationPlan();
  $("#migrationCount").textContent = plan.tasks.length;
  $("#migrationPanel").hidden = plan.completed || !plan.tasks.length;
}

async function migrate() {
  const button = $("#migrateButton");
  button.disabled = true;
  try {
    const result = await client.migrateLegacyTasks();
    $("#migrationPanel").hidden = true;
    await refresh({ quiet: true });
    toast(`已导入 ${result.imported} 条旧任务`);
  } catch (error) {
    toast(`导入失败：${error.message}。稍后可安全重试。`, true);
  } finally {
    button.disabled = false;
  }
}

async function login(event) {
  event.preventDefault();
  const button = $("#loginForm button");
  button.disabled = true;
  $("#loginMessage").textContent = "正在前往 Google 授权…";
  try {
    client.requestGoogleLogin(`${location.origin}${location.pathname}`);
  } catch (error) {
    $("#loginMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function connectGoogleTasks() {
  client.requestGoogleLogin(`${location.origin}${location.pathname}`);
}

async function signOut() {
  await client.signOut();
  user = null;
  tasks = [];
  $("#cloudContent").hidden = true;
  $("#authPanel").hidden = false;
  toast("已安全退出");
}

async function boot() {
  $("#date").textContent = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  $("#loginForm").addEventListener("submit", login);
  $("#connectGoogleButton").addEventListener("click", connectGoogleTasks);
  $("#addForm").addEventListener("submit", addTask);
  $("#refreshButton").addEventListener("click", () => refresh());
  $("#signOutButton").addEventListener("click", signOut);
  $("#migrateButton").addEventListener("click", migrate);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && user) refresh({ quiet: true });
  });

  if (!client.isConfigured()) {
    $("#setupPanel").hidden = false;
    return;
  }
  client.consumeAuthRedirect();
  try {
    user = await client.getUser();
  } catch (error) {
    user = client.session()?.user || null;
    if (!user) {
      $("#authPanel").hidden = false;
      $("#loginMessage").textContent = error.message;
      return;
    }
  }
  if (!user) {
    $("#authPanel").hidden = false;
    return;
  }
  try {
    const connection = await client.finalizeGoogleTasksConnection();
    if (connection.connected) toast(`已连接：${connection.taskListTitle}`);
  } catch (error) {
    $("#loginMessage").textContent = error.message;
    toast(error.message, true);
  }
  $("#authPanel").hidden = true;
  $("#cloudContent").hidden = false;
  updateMigration();
  await refresh({ quiet: true });
}

boot();
