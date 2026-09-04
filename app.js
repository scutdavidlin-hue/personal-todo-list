import {
  escapeHtml,
  fromDatabaseTask,
  groupTasksByDue,
  groupTasksForToday,
  localDateISO,
  offsetDate,
  replaceTask,
} from "./src/core.js";
import { TaskCloudClient } from "./src/cloud-client.js";

const client = new TaskCloudClient(window.TASK_SYNC_CONFIG || {});
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let tasks = [];
let schedules = [];
let currentUser = null;
let currentFilter = "all";
let pendingIds = new Set();
let reviewSaveTimer = null;
const firedReminders = new Set();

function formatDate(dateString) {
  if (!dateString) return "无截止日期";
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 11) return "早上好，今天准备做什么？";
  if (hour < 14) return "中午好，看看上午的进展吧";
  if (hour < 18) return "下午好，继续稳稳地推进";
  return "晚上好，给今天收个尾吧";
}

function priorityLabel(value) {
  return { high: "高优先", medium: "中优先", low: "低优先" }[value] || "中优先";
}

function emptyState(text = "今天还没有任务") {
  return `<div class="empty-state"><b>${text}</b><span>点击右上角“添加任务”开始安排。</span></div>`;
}

function setConnection(state, message) {
  const toolbar = $("#syncToolbar");
  toolbar.classList.remove("syncing", "offline", "error");
  if (state) toolbar.classList.add(state);
  $("#syncStatus").textContent = message;
  $("#sidebarSyncText").textContent = message;
}

function showToast(message, tone = "normal") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", tone === "error");
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function showCloudContent(show) {
  ["#todayView", "#tasksView", "#statsView"].forEach((selector) => { $(selector).hidden = !show; });
  $("#addTaskButton").hidden = !show;
  $("#syncToolbar").hidden = !show;
}

function renderTaskItem(task) {
  const syncing = pendingIds.has(task.id);
  const schedule = schedules.find((item) => item.google_task_id === task.id);
  return `
    <div class="task-item ${task.done ? "done" : ""} ${syncing ? "syncing" : ""}" data-id="${task.id}">
      <input class="task-check" type="checkbox" ${task.done ? "checked" : ""} ${syncing ? "disabled" : ""} aria-label="完成 ${escapeHtml(task.title)}">
      <div class="task-copy">
        <strong>${escapeHtml(task.title)}</strong>
        <small>
          ${task.carriedFromDate ? `<span class="carry-chip">↪ ${escapeHtml(task.carriedFromDate)} 延续</span>` : ""}
          ${schedule?.scheduled_start ? `<span class="carry-chip">${schedule.scheduling_status === "rescheduled" ? "↪" : "◷"} ${escapeHtml(schedule.scheduled_date)} ${escapeHtml(schedule.scheduled_start.slice(0, 5))}</span>` : ""}
          <span>Google Tasks</span>
        </small>
      </div>
      <div class="task-menu">
        <button aria-label="任务操作" ${syncing ? "disabled" : ""}>···</button>
        <div class="task-actions">
          <button data-action="edit">编辑</button>
          <button data-action="tomorrow">移到明天</button>
          <button class="danger" data-action="delete">删除任务</button>
        </div>
      </div>
    </div>`;
}

function renderToday() {
  const today = localDateISO();
  let todayTasks = tasks.filter((task) => task.date === today && task.status !== "cancelled");
  if (currentFilter === "open") todayTasks = todayTasks.filter((task) => !task.done);
  if (currentFilter === "done") todayTasks = todayTasks.filter((task) => task.done);
  $("#todayTaskList").innerHTML = todayTasks.length
    ? todayTasks.map(renderTaskItem).join("")
    : emptyState(currentFilter === "done" ? "今天还没有已完成任务" : "这里暂时空空的");

  const allToday = tasks.filter((task) => task.date === today && task.status !== "cancelled");
  const completed = allToday.filter((task) => task.done).length;
  const percent = allToday.length ? Math.round(completed / allToday.length * 100) : 0;
  $("#progressPercent").textContent = `${percent}%`;
  $("#completedCount").textContent = completed;
  $("#importantCount").textContent = allToday.filter((task) => !task.done).length;
  $("#remainingMinutes").textContent = allToday.length;
  $("#ringText").textContent = `${completed}/${allToday.length}`;
  $("#progressRing").style.setProperty("--progress", `${percent * 3.6}deg`);

  const focus = allToday.find((task) => !task.done);
  $("#focusTitle").textContent = focus?.title || "今天的任务已完成";
  $("#focusMeta").textContent = focus
    ? `${formatDate(focus.date)}${focus.notes ? ` · ${focus.notes}` : ""}`
    : "做得很好。可以休息一下，或者提前安排明天。";
  $("#completeFocusButton").dataset.id = focus?.id || "";
  $("#completeFocusButton").textContent = focus ? "标记完成" : "全部完成";
  $("#completeFocusButton").disabled = !focus || pendingIds.has(focus?.id);
}

function renderAllTasks() {
  const query = ($("#taskSearch")?.value || "").trim().toLowerCase();
  const list = tasks
    .filter((task) => task.status !== "cancelled")
    .filter((task) => task.title.toLowerCase().includes(query) || task.notes.toLowerCase().includes(query));
  const groups = groupTasksByDue(list, localDateISO());
  const taskRow = (task) => `
    <div class="task-row ${pendingIds.has(task.id) ? "syncing" : ""}" data-id="${task.id}">
      <div class="task-row-main">
        <input class="task-check" type="checkbox" ${task.done ? "checked" : ""} ${pendingIds.has(task.id) ? "disabled" : ""} aria-label="完成 ${escapeHtml(task.title)}">
        <span>${escapeHtml(task.title)}</span>
      </div>
      <span>${formatDate(task.dueDate)}</span>
      <span class="category-chip">${escapeHtml(task.category)}</span>
      <span class="status-chip ${task.done ? "done" : "open"}">${task.done ? "已完成" : "进行中"}</span>
    </div>`;
  const sections = [
    ["overdue", "Overdue", "已逾期"],
    ["today", "Today", "今天"],
    ["upcoming", "Upcoming", "未来 / 待安排"],
    ["completed", "Completed", "已完成"],
  ];
  $("#allTaskList").innerHTML = list.length
    ? sections.map(([key, eyebrow, title]) => `
      <section class="task-group">
        <div class="task-group-title"><span><small>${eyebrow}</small><strong>${title}</strong></span><b>${groups[key].length}</b></div>
        <div>${groups[key].length ? (key === "completed" ? groups[key].slice(0, 50) : groups[key]).map(taskRow).join("") : '<div class="group-empty">暂无</div>'}</div>
      </section>`).join("")
    : emptyState("没有找到相关任务");
}

function renderStats() {
  const active = tasks.filter((task) => task.status !== "cancelled");
  const completed = active.filter((task) => task.done);
  const rate = active.length ? Math.round(completed.length / active.length * 100) : 0;
  $("#weeklyRate").textContent = `${rate}%`;
  $("#weeklyMessage").textContent = rate >= 80 ? "你的完成节奏很好，记得也给自己留一点余地。" : rate >= 50 ? "进展不错，优先把最重要的事情做完。" : "从一件小事开始，慢慢建立自己的节奏。";
  $("#totalCompleted").textContent = `${completed.length} 件`;

  const completedDays = new Set(completed.map((task) => (task.completedAt || "").slice(0, 10)));
  let streak = 0;
  const cursor = new Date();
  while (completedDays.has(localDateISO(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  $("#streakCount").textContent = `${streak} 天`;

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    const iso = localDateISO(date);
    const count = completed.filter((task) => (task.completedAt || "").slice(0, 10) === iso).length;
    return { iso, label: date.toLocaleDateString("zh-CN", { weekday: "short" }).replace("周", ""), count };
  });
  const max = Math.max(1, ...days.map((day) => day.count));
  $("#barChart").innerHTML = days.map((day) => `
    <div class="bar-column ${day.iso === localDateISO() ? "today" : ""}">
      <b>${day.count || ""}</b><div class="bar" style="height:${Math.max(5, day.count / max * 155)}px"></div><span>${day.label}</span>
    </div>`).join("");

  const categoryNames = [...new Set(["工作", "学习", "生活", "健康", ...active.map((task) => task.category)])];
  const categoryCounts = categoryNames.map((name) => ({ name, count: active.filter((task) => task.category === name).length }));
  const categoryMax = Math.max(1, ...categoryCounts.map((item) => item.count));
  $("#categoryStats").innerHTML = categoryCounts.map((item) => `
    <div class="category-stat"><span>${escapeHtml(item.name)}</span><div class="category-track"><div class="category-fill" style="width:${item.count / categoryMax * 100}%"></div></div><b>${item.count}</b></div>`).join("");
}

function render() {
  $("#dateLabel").textContent = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  if ($("#todayView").classList.contains("active")) $("#pageTitle").textContent = greeting();
  renderToday();
  renderAllTasks();
  renderStats();
  bindDynamicEvents();
}

function bindDynamicEvents() {
  $$(".task-check").forEach((input) => input.addEventListener("change", (event) => {
    const row = event.target.closest("[data-id]");
    if (row) toggleTask(row.dataset.id, event.target.checked);
  }));
  $$(".task-menu > button").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = button.closest(".task-menu");
    $$(".task-menu").filter((item) => item !== menu).forEach((item) => item.classList.remove("open"));
    menu.classList.toggle("open");
  }));
  $$(".task-actions button").forEach((button) => button.addEventListener("click", () => {
    const id = button.closest(".task-item").dataset.id;
    if (button.dataset.action === "edit") openTaskDialog(tasks.find((task) => task.id === id));
    if (button.dataset.action === "tomorrow") moveToTomorrow(id);
    if (button.dataset.action === "delete") cancelTask(id);
  }));
}

function updateCachedTasks() {
  if (currentUser) client.cacheTasks(currentUser.id, tasks);
}

async function mutateTask(id, changes, successMessage) {
  if (pendingIds.has(id)) return;
  pendingIds.add(id);
  document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((row) => row.classList.add("syncing"));
  setConnection("syncing", "正在保存到云端…");
  try {
    const updated = await client.updateTask(id, changes);
    tasks = replaceTask(tasks, updated);
    const changedDate = changes.dueDate ?? changes.date;
    if (changedDate) {
      const currentSchedule = schedules.find((item) => item.google_task_id === id);
      const scheduleResult = currentSchedule
        ? await client.rescheduleTask(id, { ...currentSchedule, scheduled_date: changedDate })
        : await client.scheduleTask(id, { scheduled_date: changedDate, scheduling_source: "explicit_user" });
      if (scheduleResult.schedule) schedules = [...schedules.filter((item) => item.google_task_id !== id), scheduleResult.schedule];
    }
    updateCachedTasks();
    setConnection("", `已同步 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
    showToast(successMessage);
  } catch (error) {
    setConnection("error", "保存失败，云端状态未改变");
    showToast(`${error.message}；操作已撤回`, "error");
  } finally {
    pendingIds.delete(id);
    render();
  }
}

function toggleTask(id, done) {
  return mutateTask(id, {
    status: done ? "completed" : "open",
    completed_at: done ? new Date().toISOString() : null,
  }, done ? "已保存：完成一件，做得好。" : "已保存：任务恢复为未完成");
}

function moveToTomorrow(id) {
  return mutateTask(id, { date: offsetDate(1) }, "已保存：任务已安排到明天");
}

async function cancelTask(id) {
  if (!window.confirm("这会从 Google Tasks 永久删除任务。确定删除吗？")) return;
  if (pendingIds.has(id)) return;
  pendingIds.add(id);
  setConnection("syncing", "正在从 Google Tasks 删除…");
  try {
    await client.cancelTask(id);
    tasks = tasks.filter((task) => task.id !== id);
    updateCachedTasks();
    setConnection("", "已同步到云端");
    showToast("任务已从 Google Tasks 删除");
  } catch (error) {
    setConnection("error", "删除失败，任务仍然保留");
    showToast(error.message, "error");
  } finally {
    pendingIds.delete(id);
    render();
  }
}

function openTaskDialog(task = null) {
  const schedule = task ? schedules.find((item) => item.google_task_id === task.id) : null;
  $("#dialogTitle").textContent = task ? "编辑这件事" : "添加一件要做的事";
  $("#taskId").value = task?.id || "";
  $("#taskTitle").value = task?.title || "";
  $("#taskDate").value = task?.date || localDateISO();
  $("#taskNotes").value = task?.notes || "";
  $("#taskTime").value = schedule?.scheduled_start?.slice(0, 5) || "";
  $("#taskDuration").value = schedule?.duration_minutes || 30;
  $("#taskFixedTime").checked = schedule?.fixed_time === true;
  $("#taskDialog").showModal();
  setTimeout(() => $("#taskTitle").focus(), 50);
}

async function saveTask(event) {
  event.preventDefault();
  if (!$("#taskForm").reportValidity()) return;
  const button = $("#saveTaskButton");
  button.disabled = true;
  setConnection("syncing", "正在保存到云端…");
  const id = $("#taskId").value;
  const formData = {
    title: $("#taskTitle").value.trim(),
    dueDate: $("#taskDate").value || null,
    notes: $("#taskNotes").value.trim(),
  };
  const schedule = {
    scheduled_date: formData.dueDate,
    scheduled_start: $("#taskTime").value || null,
    duration_minutes: Number($("#taskDuration").value || 30),
    scheduling_source: "explicit_user",
    fixed_time: $("#taskFixedTime").checked,
  };
  let deduplicated = false;
  try {
    if (id) {
      const updated = await client.updateTask(id, formData);
      tasks = replaceTask(tasks, updated);
      const currentSchedule = schedules.find((item) => item.google_task_id === id);
      const scheduleResult = schedule.scheduled_start
        ? await (currentSchedule ? client.rescheduleTask(id, schedule) : client.scheduleTask(id, schedule))
        : currentSchedule?.scheduled_start
          ? await client.unscheduleTask(id, schedule)
          : await client.scheduleTask(id, schedule);
      if (scheduleResult.schedule) schedules = [...schedules.filter((item) => item.google_task_id !== id), scheduleResult.schedule];
    } else {
      const created = await client.createTask({ ...formData, schedule, status: "open", source: "manual", originalIntent: formData.title });
      deduplicated = created.metadata?.deduplicated === true;
      if (deduplicated) tasks = replaceTask(tasks, created);
      else tasks.push(fromDatabaseTask(created));
    }
    updateCachedTasks();
    $("#taskDialog").close();
    render();
    setConnection("", "已同步到云端");
    showToast(id ? "任务修改已保存" : deduplicated ? "已识别为现有任务并更新" : "新任务已保存到 Google Tasks");
  } catch (error) {
    setConnection("error", "保存失败");
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function loadReview() {
  try {
    const review = await client.getReview(localDateISO());
    $("#dailyNote").value = review.note || "";
    $$('[data-mood]').forEach((button) => button.classList.toggle("active", String(review.mood) === button.dataset.mood));
  } catch (error) {
    showToast(`今日小结读取失败：${error.message}`, "error");
  }
}

async function saveReview() {
  clearTimeout(reviewSaveTimer);
  try {
    await client.saveReview(localDateISO(), {
      note: $("#dailyNote").value,
      mood: Number($("[data-mood].active")?.dataset.mood) || null,
    });
    setConnection("", "今日小结已同步");
  } catch (error) {
    setConnection("error", "今日小结保存失败");
    showToast(error.message, "error");
  }
}

function scheduleReviewSave() {
  setConnection("syncing", "正在保存今日小结…");
  clearTimeout(reviewSaveTimer);
  reviewSaveTimer = setTimeout(saveReview, 700);
}

async function refreshTasks({ quiet = false } = {}) {
  if (!currentUser) return;
  setConnection("syncing", "正在读取云端任务…");
  $("#refreshButton").disabled = true;
  try {
    const [cloudTasks, scheduleResult] = await Promise.all([client.getTasks(), client.listSchedules()]);
    tasks = cloudTasks;
    schedules = scheduleResult.schedules || [];
    updateCachedTasks();
    setConnection("", `已同步 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
    render();
    if (!quiet) showToast("已读取最新云端状态");
  } catch (error) {
    const cached = client.readCachedTasks(currentUser.id);
    if (cached?.tasks?.length || Array.isArray(cached?.tasks)) {
      tasks = cached.tasks;
      render();
      setConnection("offline", `离线只读 · 缓存于 ${new Date(cached.savedAt).toLocaleString("zh-CN")}`);
      showToast("网络不可用，当前显示上次云端缓存；写操作不会假装成功", "error");
    } else {
      setConnection("error", "云端任务读取失败");
      showToast(error.message, "error");
    }
  } finally {
    $("#refreshButton").disabled = false;
  }
}

function updateMigrationPanel() {
  const plan = client.legacyMigrationPlan();
  $("#migrationCount").textContent = plan.tasks.length;
  $("#migrationPanel").hidden = plan.completed || plan.tasks.length === 0;
}

async function migrateLegacy() {
  const button = $("#migrateButton");
  button.disabled = true;
  button.textContent = "正在导入…";
  try {
    const result = await client.migrateLegacyTasks();
    $("#migrationPanel").hidden = true;
    await refreshTasks({ quiet: true });
    showToast(`已安全导入 ${result.imported} 条旧任务`);
  } catch (error) {
    showToast(`导入失败：${error.message}。可稍后重试，不会产生重复任务。`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "导入旧任务";
  }
}

async function requestLogin(event) {
  event.preventDefault();
  const button = $("#loginForm button");
  button.disabled = true;
  $("#loginMessage").textContent = "正在前往 Google 授权…";
  try {
    const redirectTo = `${location.origin}${location.pathname}`;
    client.requestGoogleLogin(redirectTo);
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
  currentUser = null;
  tasks = [];
  showCloudContent(false);
  $("#authPanel").hidden = false;
  $("#migrationPanel").hidden = true;
  showToast("已安全退出");
}

async function enableNotifications() {
  if (!("Notification" in window)) return showToast("当前浏览器不支持桌面提醒");
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    $("#notificationButton strong").textContent = "提醒已开启";
    $("#notificationButton small").textContent = "保持页面打开即可接收";
    new Notification("日程提醒已开启", { body: "到时间后，我会提醒你处理任务。" });
  } else showToast("没有获得通知权限", "error");
}

function checkReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  tasks.filter((task) => task.date === localDateISO() && task.time === time && !task.done && !firedReminders.has(task.id)).forEach((task) => {
    new Notification(`该做：${task.title}`, { body: `${task.category} · 预计 ${task.duration} 分钟` });
    firedReminders.add(task.id);
  });
}

function bindStaticEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => {
    $$(".nav-item").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    $$(".view").forEach((view) => view.classList.remove("active"));
    $(`#${button.dataset.view}View`).classList.add("active");
    const titles = { today: greeting(), tasks: "把所有事情放在一个地方", stats: "看见自己的每一点进展" };
    $("#pageTitle").textContent = titles[button.dataset.view];
  }));
  $$(".filter-pill").forEach((button) => button.addEventListener("click", () => {
    $$(".filter-pill").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    currentFilter = button.dataset.filter;
    renderToday();
    bindDynamicEvents();
  }));
  $("#addTaskButton").addEventListener("click", () => openTaskDialog());
  $("#taskForm").addEventListener("submit", saveTask);
  $("#closeTaskDialog").addEventListener("click", () => $("#taskDialog").close());
  $("#cancelTaskDialog").addEventListener("click", () => $("#taskDialog").close());
  $("#taskSearch").addEventListener("input", () => { renderAllTasks(); bindDynamicEvents(); });
  $("#completeFocusButton").addEventListener("click", (event) => event.currentTarget.dataset.id && toggleTask(event.currentTarget.dataset.id, true));
  $("#notificationButton").addEventListener("click", enableNotifications);
  $("#loginForm").addEventListener("submit", requestLogin);
  $("#connectGoogleButton").addEventListener("click", connectGoogleTasks);
  $("#refreshButton").addEventListener("click", () => refreshTasks());
  $("#signOutButton").addEventListener("click", signOut);
  $("#migrateButton").addEventListener("click", migrateLegacy);
  $("#dailyNote").addEventListener("input", scheduleReviewSave);
  $$('[data-mood]').forEach((button) => button.addEventListener("click", () => {
    $$('[data-mood]').forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    scheduleReviewSave();
  }));
  document.addEventListener("click", () => $$(".task-menu").forEach((item) => item.classList.remove("open")));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentUser) refreshTasks({ quiet: true });
  });
}

async function boot() {
  bindStaticEvents();
  $("#dateLabel").textContent = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  $("#pageTitle").textContent = greeting();
  if (!client.isConfigured()) {
    $("#setupPanel").hidden = false;
    showCloudContent(false);
    return;
  }

  client.consumeAuthRedirect();
  try {
    currentUser = await client.getUser();
  } catch (error) {
    currentUser = client.session()?.user || null;
    if (!currentUser) {
      $("#authPanel").hidden = false;
      $("#loginMessage").textContent = error.message;
      return;
    }
  }
  if (!currentUser) {
    $("#authPanel").hidden = false;
    return;
  }

  try {
    const connection = await client.finalizeGoogleTasksConnection();
    if (connection.connected) showToast(`已连接：${connection.taskListTitle}`);
  } catch (error) {
    $("#loginMessage").textContent = error.message;
    showToast(error.message, "error");
  }

  $("#authPanel").hidden = true;
  $("#userEmail").textContent = currentUser.email || "已登录";
  showCloudContent(true);
  updateMigrationPanel();
  await Promise.all([refreshTasks({ quiet: true }), loadReview()]);
}

boot();
setInterval(checkReminders, 30_000);
