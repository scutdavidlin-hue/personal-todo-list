const STORAGE_KEY = "richeng-tasks-v1";
const REVIEW_KEY = "richeng-reviews-v1";

const todayISO = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

function offsetDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const sampleTasks = [
  { id: crypto.randomUUID(), title: "完成本周工作计划", date: todayISO(), time: "09:30", category: "工作", priority: "high", duration: 45, notes: "明确三个核心目标，并安排好时间。", done: false, completedAt: null },
  { id: crypto.randomUUID(), title: "阅读 30 分钟", date: todayISO(), time: "12:30", category: "学习", priority: "medium", duration: 30, notes: "", done: false, completedAt: null },
  { id: crypto.randomUUID(), title: "晚饭后散步", date: todayISO(), time: "19:30", category: "健康", priority: "low", duration: 30, notes: "不带手机，轻松走一走。", done: false, completedAt: null },
  { id: crypto.randomUUID(), title: "整理书桌和文件", date: todayISO(), time: "20:30", category: "生活", priority: "medium", duration: 20, notes: "", done: true, completedAt: new Date().toISOString() },
  { id: crypto.randomUUID(), title: "回顾昨天的会议记录", date: offsetDate(-1), time: "10:00", category: "工作", priority: "medium", duration: 25, notes: "", done: true, completedAt: new Date(Date.now() - 86400000).toISOString() },
  { id: crypto.randomUUID(), title: "准备下周学习清单", date: offsetDate(1), time: "18:00", category: "学习", priority: "low", duration: 20, notes: "", done: false, completedAt: null }
];

let tasks = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || sampleTasks;
let currentFilter = "all";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function formatDate(dateString) {
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
  return { high: "高优先", medium: "中优先", low: "低优先" }[value];
}

function emptyState(text = "今天还没有任务") {
  return `<div class="empty-state"><b>${text}</b><span>点击右上角“添加任务”开始安排。</span></div>`;
}

function renderTaskItem(task) {
  return `
    <div class="task-item ${task.done ? "done" : ""}" data-id="${task.id}">
      <input class="task-check" type="checkbox" ${task.done ? "checked" : ""} aria-label="完成 ${escapeHtml(task.title)}">
      <div class="task-copy">
        <strong>${escapeHtml(task.title)}</strong>
        <small>
          <span><i class="priority-mark priority-${task.priority}"></i>${priorityLabel(task.priority)}</span>
          ${task.time ? `<span>◷ ${task.time}</span>` : ""}
          <span>${escapeHtml(task.category)} · ${task.duration} 分钟</span>
        </small>
      </div>
      <div class="task-menu">
        <button aria-label="任务操作">···</button>
        <div class="task-actions">
          <button data-action="edit">编辑</button>
          <button data-action="tomorrow">移到明天</button>
          <button class="danger" data-action="delete">删除</button>
        </div>
      </div>
    </div>`;
}

function renderToday() {
  let todayTasks = tasks.filter(task => task.date === todayISO());
  if (currentFilter === "open") todayTasks = todayTasks.filter(task => !task.done);
  if (currentFilter === "done") todayTasks = todayTasks.filter(task => task.done);
  $("#todayTaskList").innerHTML = todayTasks.length ? todayTasks.map(renderTaskItem).join("") : emptyState(currentFilter === "done" ? "今天还没有已完成任务" : "这里暂时空空的");

  const allToday = tasks.filter(task => task.date === todayISO());
  const completed = allToday.filter(task => task.done).length;
  const percent = allToday.length ? Math.round(completed / allToday.length * 100) : 0;
  $("#progressPercent").textContent = `${percent}%`;
  $("#completedCount").textContent = completed;
  $("#importantCount").textContent = allToday.filter(task => task.priority === "high" && !task.done).length;
  $("#remainingMinutes").textContent = allToday.filter(task => !task.done).reduce((sum, task) => sum + Number(task.duration || 0), 0);
  $("#ringText").textContent = `${completed}/${allToday.length}`;
  $("#progressRing").style.setProperty("--progress", `${percent * 3.6}deg`);

  const focus = allToday.find(task => task.priority === "high" && !task.done) || allToday.find(task => !task.done);
  $("#focusTitle").textContent = focus?.title || "今天的任务已完成";
  $("#focusMeta").textContent = focus ? `${focus.time || "待安排时间"} · 预计 ${focus.duration} 分钟${focus.notes ? ` · ${focus.notes}` : ""}` : "做得很好。可以休息一下，或者提前安排明天。";
  $("#completeFocusButton").dataset.id = focus?.id || "";
  $("#completeFocusButton").textContent = focus ? "标记完成" : "全部完成";
  $("#completeFocusButton").disabled = !focus;
}

function renderAllTasks() {
  const query = ($("#taskSearch")?.value || "").trim().toLowerCase();
  const list = tasks
    .filter(task => task.title.toLowerCase().includes(query) || task.category.toLowerCase().includes(query))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
  $("#allTaskList").innerHTML = list.length ? list.map(task => `
    <div class="task-row" data-id="${task.id}">
      <div class="task-row-main">
        <input class="task-check" type="checkbox" ${task.done ? "checked" : ""}>
        <span>${escapeHtml(task.title)}</span>
      </div>
      <span>${formatDate(task.date)}${task.time ? ` ${task.time}` : ""}</span>
      <span class="category-chip">${escapeHtml(task.category)}</span>
      <span class="status-chip ${task.done ? "done" : "open"}">${task.done ? "已完成" : "进行中"}</span>
    </div>`).join("") : emptyState("没有找到相关任务");
}

function renderStats() {
  const completed = tasks.filter(task => task.done);
  const rate = tasks.length ? Math.round(completed.length / tasks.length * 100) : 0;
  $("#weeklyRate").textContent = `${rate}%`;
  $("#weeklyMessage").textContent = rate >= 80 ? "你的完成节奏很好，记得也给自己留一点余地。" : rate >= 50 ? "进展不错，优先把最重要的事情做完。" : "从一件小事开始，慢慢建立自己的节奏。";
  $("#totalCompleted").textContent = `${completed.length} 件`;

  const completedDays = new Set(completed.map(task => (task.completedAt || "").slice(0, 10)));
  let streak = 0;
  const cursor = new Date();
  while (completedDays.has(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`)) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  $("#streakCount").textContent = `${streak} 天`;

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - i));
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const count = completed.filter(task => (task.completedAt || "").slice(0, 10) === iso).length;
    return { iso, label: date.toLocaleDateString("zh-CN", { weekday: "short" }).replace("周", ""), count };
  });
  const max = Math.max(1, ...days.map(day => day.count));
  $("#barChart").innerHTML = days.map(day => `
    <div class="bar-column ${day.iso === todayISO() ? "today" : ""}">
      <b>${day.count || ""}</b>
      <div class="bar" style="height:${Math.max(5, day.count / max * 155)}px"></div>
      <span>${day.label}</span>
    </div>`).join("");

  const categories = ["工作", "学习", "生活", "健康"];
  const categoryCounts = categories.map(name => ({ name, count: tasks.filter(task => task.category === name).length }));
  const categoryMax = Math.max(1, ...categoryCounts.map(item => item.count));
  $("#categoryStats").innerHTML = categoryCounts.map(item => `
    <div class="category-stat">
      <span>${item.name}</span>
      <div class="category-track"><div class="category-fill" style="width:${item.count / categoryMax * 100}%"></div></div>
      <b>${item.count}</b>
    </div>`).join("");
}

function render() {
  $("#dateLabel").textContent = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  $("#pageTitle").textContent = greeting();
  renderToday();
  renderAllTasks();
  renderStats();
  bindDynamicEvents();
}

function bindDynamicEvents() {
  $$(".task-check").forEach(input => input.addEventListener("change", event => {
    const row = event.target.closest("[data-id]");
    if (row) toggleTask(row.dataset.id, event.target.checked);
  }));
  $$(".task-menu > button").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    const menu = button.closest(".task-menu");
    $$(".task-menu").filter(item => item !== menu).forEach(item => item.classList.remove("open"));
    menu.classList.toggle("open");
  }));
  $$(".task-actions button").forEach(button => button.addEventListener("click", () => {
    const id = button.closest(".task-item").dataset.id;
    const action = button.dataset.action;
    if (action === "edit") openTaskDialog(tasks.find(task => task.id === id));
    if (action === "tomorrow") moveToTomorrow(id);
    if (action === "delete") deleteTask(id);
  }));
}

function toggleTask(id, done) {
  const task = tasks.find(item => item.id === id);
  if (!task) return;
  task.done = done;
  task.completedAt = done ? new Date().toISOString() : null;
  saveTasks();
  render();
  showToast(done ? "完成一件，做得好。" : "任务已恢复为未完成");
}

function moveToTomorrow(id) {
  const task = tasks.find(item => item.id === id);
  if (!task) return;
  task.date = offsetDate(1);
  saveTasks();
  render();
  showToast("任务已安排到明天");
}

function deleteTask(id) {
  tasks = tasks.filter(item => item.id !== id);
  saveTasks();
  render();
  showToast("任务已删除");
}

function openTaskDialog(task = null) {
  $("#dialogTitle").textContent = task ? "编辑这件事" : "添加一件要做的事";
  $("#taskId").value = task?.id || "";
  $("#taskTitle").value = task?.title || "";
  $("#taskDate").value = task?.date || todayISO();
  $("#taskTime").value = task?.time || "";
  $("#taskCategory").value = task?.category || "工作";
  $("#taskPriority").value = task?.priority || "medium";
  $("#taskDuration").value = task?.duration || 30;
  $("#taskNotes").value = task?.notes || "";
  $("#taskDialog").showModal();
  setTimeout(() => $("#taskTitle").focus(), 50);
}

function saveTask(event) {
  event.preventDefault();
  if (!$("#taskForm").reportValidity()) return;
  const id = $("#taskId").value;
  const existing = tasks.find(task => task.id === id);
  const data = {
    id: id || crypto.randomUUID(),
    title: $("#taskTitle").value.trim(),
    date: $("#taskDate").value,
    time: $("#taskTime").value,
    category: $("#taskCategory").value,
    priority: $("#taskPriority").value,
    duration: Number($("#taskDuration").value) || 30,
    notes: $("#taskNotes").value.trim(),
    done: existing?.done || false,
    completedAt: existing?.completedAt || null
  };
  if (existing) Object.assign(existing, data);
  else tasks.push(data);
  saveTasks();
  $("#taskDialog").close();
  render();
  showToast(existing ? "任务已更新" : "任务已添加");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2000);
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

async function enableNotifications() {
  if (!("Notification" in window)) return showToast("当前浏览器不支持桌面提醒");
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    $("#notificationButton strong").textContent = "提醒已开启";
    $("#notificationButton small").textContent = "保持页面打开即可接收";
    new Notification("日程提醒已开启", { body: "到时间后，我会提醒你处理任务。" });
  } else showToast("没有获得通知权限");
}

function checkReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  tasks.filter(task => task.date === todayISO() && task.time === time && !task.done && !task.notified).forEach(task => {
    new Notification(`该做：${task.title}`, { body: `${task.category} · 预计 ${task.duration} 分钟` });
    task.notified = true;
    saveTasks();
  });
}

$$(".nav-item").forEach(button => button.addEventListener("click", () => {
  $$(".nav-item").forEach(item => item.classList.remove("active"));
  button.classList.add("active");
  $$(".view").forEach(view => view.classList.remove("active"));
  $(`#${button.dataset.view}View`).classList.add("active");
  const titles = { today: greeting(), tasks: "把所有事情放在一个地方", stats: "看见自己的每一点进展" };
  $("#pageTitle").textContent = titles[button.dataset.view];
}));

$$(".filter-pill").forEach(button => button.addEventListener("click", () => {
  $$(".filter-pill").forEach(item => item.classList.remove("active"));
  button.classList.add("active");
  currentFilter = button.dataset.filter;
  renderToday();
  bindDynamicEvents();
}));

$("#addTaskButton").addEventListener("click", () => openTaskDialog());
$("#taskForm").addEventListener("submit", saveTask);
$("#saveTaskButton").addEventListener("click", saveTask);
$("#taskSearch").addEventListener("input", () => { renderAllTasks(); bindDynamicEvents(); });
$("#completeFocusButton").addEventListener("click", event => event.currentTarget.dataset.id && toggleTask(event.currentTarget.dataset.id, true));
$("#notificationButton").addEventListener("click", enableNotifications);
document.addEventListener("click", () => $$(".task-menu").forEach(item => item.classList.remove("open")));

const reviews = JSON.parse(localStorage.getItem(REVIEW_KEY) || "{}");
$("#dailyNote").value = reviews[todayISO()]?.note || "";
$("#dailyNote").addEventListener("input", event => {
  reviews[todayISO()] = { ...(reviews[todayISO()] || {}), note: event.target.value };
  localStorage.setItem(REVIEW_KEY, JSON.stringify(reviews));
});
$$("[data-mood]").forEach(button => {
  if (String(reviews[todayISO()]?.mood) === button.dataset.mood) button.classList.add("active");
  button.addEventListener("click", () => {
    $$("[data-mood]").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    reviews[todayISO()] = { ...(reviews[todayISO()] || {}), mood: Number(button.dataset.mood) };
    localStorage.setItem(REVIEW_KEY, JSON.stringify(reviews));
  });
});

render();
setInterval(checkReminders, 30000);
