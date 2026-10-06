import test from "node:test";
import assert from "node:assert/strict";
import { bindRecurrencePanel } from "../src/recurrence-panel.js";

class FakeElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.children = [];
    this.textContent = "";
    this.listeners = new Map();
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  async click() { return this.listeners.get("click")?.({ currentTarget: this }); }
}

class FakeDocument {
  createElement(tagName) { return new FakeElement(this, tagName); }
}

function find(element, predicate) {
  if (predicate(element)) return element;
  for (const child of element.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function allText(element) {
  return [element.textContent, ...element.children.map(allText)].join(" ");
}

const initialSeries = { id: "series-1", anchor_task_id: "task-1", current_task_id: "task-1",
  recurrence_kind: "weekly", current_date: "2026-09-25", local_time: "15:00:00", timezone: "Asia/Shanghai", status: "active" };

test("lists a real series and requires an explicit second in-app click to stop it", async () => {
  const document = new FakeDocument();
  const container = document.createElement("div");
  const calls = [];
  let cancelled = false;
  const client = {
    async getTasks() { return [{ id: "task-1", title: "<img src=x onerror=alert(1)>" }]; },
    async calendarRequest(action, input) {
      calls.push({ action, input });
      if (action === "list_series") return { success: true, series: [{ ...initialSeries, status: cancelled ? "cancelled" : "active" }] };
      if (action === "cancel_series") { cancelled = true; return { success: true, cancelled: true, projection: { projected: true } }; }
      throw new Error("Unexpected action");
    },
  };
  const panel = bindRecurrencePanel({ client, container });
  await panel.refresh();
  assert.match(allText(container), /每周五 15:00/);
  assert.match(allText(container), /<img src=x onerror=alert\(1\)>/);
  const stop = find(container, (node) => node.tagName === "button" && node.textContent === "停止整个系列");
  await stop.click();
  assert.equal(calls.filter((call) => call.action === "cancel_series").length, 0);
  assert.match(allText(container), /当前任务仍保留在 Google Tasks/);
  const confirm = find(container, (node) => node.tagName === "button" && node.textContent === "确认停止整个系列");
  await confirm.click();
  assert.deepEqual(calls.find((call) => call.action === "cancel_series")?.input, { series_id: "series-1" });
  assert.match(allText(container), /已停止/);
  assert.equal(find(container, (node) => node.tagName === "button" && node.textContent === "停止整个系列"), null);
  panel.destroy();
  assert.equal(container.children.length, 0);
});

test("a failed cancellation remains visible as unverified", async () => {
  const document = new FakeDocument();
  const container = document.createElement("div");
  const client = {
    async calendarRequest(action) {
      if (action === "list_series") return { success: true, series: [initialSeries] };
      return { success: false, error: "Calendar unavailable" };
    },
  };
  const panel = bindRecurrencePanel({ client, container });
  await panel.refresh();
  await find(container, (node) => node.tagName === "button" && node.textContent === "停止整个系列").click();
  await find(container, (node) => node.tagName === "button" && node.textContent === "确认停止整个系列").click();
  assert.match(allText(container), /停止结果待核实：Calendar unavailable/);
  assert.match(allText(container), /进行中/);
});

test("failed refresh clears stale series instead of presenting it as live", async () => {
  const document = new FakeDocument();
  const container = document.createElement("div");
  let unavailable = false;
  const panel = bindRecurrencePanel({ container, client: {
    async calendarRequest() {
      if (unavailable) throw new Error("offline");
      return { success: true, series: [initialSeries] };
    },
  } });
  await panel.refresh();
  assert.match(allText(container), /进行中/);
  unavailable = true;
  await panel.refresh();
  assert.doesNotMatch(allText(container), /进行中/);
  assert.match(allText(container), /暂时无法核实/);
});

test("active series can skip and pause, and a paused series can resume", async () => {
  const document = new FakeDocument();
  const container = document.createElement("div");
  let status = "active";
  const calls = [];
  const panel = bindRecurrencePanel({ container, client: {
    async getTasks() { return [{ id: "task-1", title: "园桌拜访活动｜提前邀约阿东" }]; },
    async calendarRequest(action, input) {
      calls.push({ action, input });
      if (action === "list_series") return { success: true, series: [{ ...initialSeries, status }] };
      if (action === "skip_series_once") return { success: true, skipped: true, recurrence_instance_date: "2026-10-02" };
      if (action === "pause_series") { status = "paused"; return { success: true, series: { ...initialSeries, status } }; }
      if (action === "resume_series") { status = "active"; return { success: true, series: { ...initialSeries, status } }; }
      throw new Error("Unexpected action");
    },
  } });
  await panel.refresh();
  await find(container, (node) => node.tagName === "button" && node.textContent === "跳过下一次").click();
  assert.equal(calls.some((call) => call.action === "skip_series_once"), true);
  await find(container, (node) => node.tagName === "button" && node.textContent === "暂停").click();
  assert.match(allText(container), /已暂停/);
  await find(container, (node) => node.tagName === "button" && node.textContent === "恢复").click();
  assert.match(allText(container), /进行中/);
});
