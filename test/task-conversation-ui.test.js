import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { proposalHtml } from "../src/task-conversation.js";

const root = resolve(import.meta.dirname, "..");
const playwrightModule = "/Users/davidlin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js";
const browserEndpoint = process.env.TASK_CONVERSATION_TEST_BROWSER_CDP;
const taskConversationSource = (await readFile(resolve(root, "src/task-conversation.js"), "utf8"))
  .replace('import { escapeHtml } from \'./core.js\';', 'const escapeHtml = (value) => String(value ?? "").replace(/[&<>"\']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#39;" }[character]));')
  .replace("export function startSpeechDraft", "function startSpeechDraft")
  .replace("export function proposalHtml", "function proposalHtml")
  .replace("export function createTaskConversation", "window.__createTaskConversation = function createTaskConversation");

function conversationResult(id, { pending = null, message = "可以继续补充或修改这件事。", history = [] } = {}) {
  return {
    task: { id, title: id === "task-b" ? "约大盆" : "祥辉过来", requested_date: "2026-09-05", requested_time: "15:00", status: "open" },
    history,
    pending,
    message,
  };
}

async function withBrowser(t, run) {
  if (!browserEndpoint) { t.skip("No authorized isolated test browser endpoint is available; no browser is launched by tests"); return; }
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(browserEndpoint)) throw new Error("Test browser endpoint must be local");
  let playwright;
  try {
    const imported = await import(pathToFileURL(playwrightModule).href);
    playwright = imported.default || imported;
  }
  catch { t.skip("Bundled Playwright is unavailable in this runtime"); return; }
  let browser;
  try {
    browser = await playwright.chromium.connectOverCDP(browserEndpoint);
  } catch (error) {
    t.skip(`Authorized isolated test browser could not connect: ${error.message}`);
    return;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await run(page);
  } finally {
    await browser.close();
  }
}

test("proposal preview escapes task data and renders a before/after diff", () => {
  const html = proposalHtml({
    proposal: {
      proposed_changes: {
        requested_time: { from: "15:00", to: "16:00" },
        notes: { from: "", to: "<img src=x onerror=alert(1)>" },
      },
    },
  });
  assert.match(html, /时间/);
  assert.match(html, /15:00/);
  assert.match(html, /16:00/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
});

test("task conversation is mobile-safe, preserves a failed request id, and confirms the displayed proposal", async (t) => {
  await withBrowser(t, async (page) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addStyleTag({ content: await readFile(resolve(root, "task-conversation.css"), "utf8") });
    await page.evaluate(() => {
      Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true });
      Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });
    });
    await page.addScriptTag({ content: taskConversationSource });
    await page.evaluate(async () => {
      let failFirst = true;
      const pending = { id: "proposal-16", status: "awaiting_confirmation", proposal: { proposed_changes: { requested_time: { from: "15:00", to: "16:00" }, reminder: { from: "14:00", to: "15:00" } } } };
      window.__sent = [];
      window.__changed = 0;
      window.__conversation = window.__createTaskConversation({
        client: {
          getTaskConversation: async (id) => moduleResult(id, { history: [{ timestamp: "12:00", raw_input: "<img src=x>", message: "<script>bad()</script>" }] }),
          sendTaskConversation: async (payload) => {
            window.__sent.push(payload);
            if (failFirst) { failFirst = false; throw new Error("网络暂时不可用"); }
            if (payload.text === "改四点吧") return moduleResult(payload.task_id, { pending });
            return moduleResult(payload.task_id, { message: "已经修改", pending: null });
          },
        },
        onChanged: async () => { window.__changed += 1; },
      });
      function moduleResult(id, options) {
        return { task: { id, title: "祥辉过来", requested_date: "2026-09-05", requested_time: "15:00", status: "open" }, ...options };
      }
    });
    await page.evaluate(() => window.__conversation.open({ id: "task-a", title: "祥辉过来" }));
    assert.equal(await page.locator(".task-conversation script").count(), 0, "timeline content must be escaped");
    assert.match(await page.locator("[data-history]").innerHTML(), /&lt;script&gt;/);
    assert.equal(await page.locator("[data-voice]").isDisabled(), true, "unsupported speech has a text fallback");
    const width = await page.locator(".task-conversation").evaluate((dialog) => dialog.getBoundingClientRect().width);
    assert.ok(width <= 390, `dialog width ${width} fits a 390px viewport`);

    await page.locator("textarea").fill("改四点吧");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("status").waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__sent.length === 1);
    assert.match(await page.getByRole("status").textContent(), /未确认执行结果/);
    await page.getByRole("button", { name: "发送" }).click();
    await page.waitForFunction(() => window.__sent.length === 2);
    const retry = await page.evaluate(() => window.__sent.slice(0, 2));
    assert.equal(retry[0].request_id, retry[1].request_id, "same request id is retried after an uncertain failure");
    assert.equal(retry[1].proposal_id, undefined);
    await page.getByRole("button", { name: "确认修改" }).click();
    await page.waitForFunction(() => window.__sent.length === 3);
    const confirmation = await page.evaluate(() => window.__sent[2]);
    assert.equal(confirmation.proposal_id, "proposal-16");
    assert.equal(confirmation.text, "确认");
    assert.equal(await page.evaluate(() => window.__changed), 2, "refresh follows each server result that returns a task");

    await page.getByRole("button", { name: "关闭任务详情" }).click();
    assert.equal(await page.locator("dialog").evaluate((dialog) => dialog.open), false);
  });
});

test("switching tasks ignores stale reads and voice errors leave a usable text fallback", async (t) => {
  await withBrowser(t, async (page) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.evaluate(() => {
      window.SpeechRecognition = class {
        start() { queueMicrotask(() => this.onerror?.({ error: "not-allowed" })); }
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
      };
    });
    await page.addScriptTag({ content: taskConversationSource });
    await page.evaluate(async () => {
      let resolveA;
      const slowA = new Promise((resolve) => { resolveA = resolve; });
      window.__resolveA = () => resolveA({ task: { id: "task-a", title: "旧任务" }, history: [], message: "旧读取" });
      window.__conversation = window.__createTaskConversation({
        client: {
          getTaskConversation: (id) => id === "task-a" ? slowA : Promise.resolve({ task: { id, title: "约大盆", requested_date: "2026-09-11", requested_time: "16:00" }, history: [], message: "新读取" }),
          sendTaskConversation: async () => { throw new Error("不应发送"); },
        },
      });
    });
    await page.evaluate(() => { window.__conversation.open({ id: "task-a", title: "旧任务" }); });
    await page.evaluate(() => window.__conversation.open({ id: "task-b", title: "约大盆" }));
    await page.evaluate(() => window.__resolveA());
    await page.waitForTimeout(25);
    assert.equal(await page.locator("h2").textContent(), "约大盆", "a late read cannot overwrite the newly opened task");

    await page.getByRole("button", { name: "🎙 继续说" }).click();
    await page.waitForFunction(() => document.querySelector("[data-status]").textContent.includes("语音识别未成功"));
    assert.equal(await page.locator("textarea").isEditable(), true, "voice errors preserve text entry");
    await page.getByRole("button", { name: "关闭任务详情" }).click();
    assert.equal(await page.locator("dialog").evaluate((dialog) => dialog.open), false);
  });
});
