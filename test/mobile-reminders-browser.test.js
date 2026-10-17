import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import { createRequire } from "node:module";

test("mobile export UI re-reads canonical schedules, cancels projections and never mutates providers", async t => {
  let chromium;
  try { ({ chromium } = createRequire(import.meta.url)("playwright")); }
  catch { t.skip("Playwright unavailable"); return; }
  let executablePath = process.env.PERSONAL_OS_CHROMIUM_PATH;
  if (!executablePath) { try { await access("/usr/bin/chromium"); executablePath = "/usr/bin/chromium"; } catch {} }
  let browser;
  try { browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); }
  catch { t.skip("Chromium unavailable"); return; }
  const root = new URL("../", import.meta.url);
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      assert.doesNotMatch(path, /\.\./);
      const content = await readFile(new URL(`.${path}`, root));
      res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
      res.end(content);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await context.addInitScript(() => {
    localStorage.setItem("task-sync-auth-session-v1", JSON.stringify({ access_token: "synthetic-access", expires_at: 9999999999, user: { id: "synthetic-owner" } }));
    Object.defineProperty(navigator, "canShare", { value: () => false });
  });
  const calls = [];
  let date = "2026-10-16", policy = "custom", owner = "synthetic-owner";
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === base) { await route.continue(); return; }
    // Every external request is intercepted. Synthetic providers only.
    calls.push({ method: request.method(), path: url.pathname });
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Content-Type": "application/json" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    assert.equal(request.method(), "GET", "No task, schedule or credential mutations");
    let body;
    if (url.pathname === "/auth/v1/user") body = { id: owner };
    else if (url.pathname === "/functions/v1/google-tasks") body = { tasks: [{ id: "synthetic-kpl-only", title: "模拟 KPL 抢票", dueDate: date, status: "open" }] };
    else if (url.pathname === "/functions/v1/task-scheduler") body = { schedules: [{ google_task_id: "synthetic-kpl-only", scheduled_date: date, scheduled_start: "12:00", timezone: "Asia/Shanghai", reminder_policy: policy, reminders: [{ at: `${date}T11:00` }] }] };
    else throw new Error(`Unexpected external path: ${url.pathname}`);
    await route.fulfill({ status: 200, headers, body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.clock.install({ time: new Date("2026-10-13T06:09:00Z") });
  await page.goto(`${base}/mobile-reminders.html`);
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("已读取 1"));
  assert.match(await page.locator("#tasks").innerText(), /11:00/);
  await page.locator("input[data-select]").check();
  // Move the canonical task after loading. Export must use the new date.
  date = "2026-10-17";
  const downloadWait = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadWait;
  const stream = await download.createReadStream(), buffers = [];
  for await (const chunk of stream) buffers.push(chunk);
  const exported = JSON.parse(Buffer.concat(buffers).toString());
  assert.equal(exported.plans[0].eventAt, Date.parse("2026-10-17T12:00+08:00") / 1000);
  assert.deepEqual(exported.plans[0].reminderAt, [Date.parse("2026-10-17T11:00+08:00") / 1000]);
  // Clearing reminders after loading exports removal, even with stale specs.
  policy = "none";
  const removedWait = page.waitForEvent("download");
  await page.locator("#export").click();
  const removed = await (await removedWait).createReadStream(), pieces = [];
  for await (const chunk of removed) pieces.push(chunk);
  const disabled = JSON.parse(Buffer.concat(pieces).toString()).plans[0];
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.reminderAt, []);
  owner = "different-synthetic-owner";
  await page.locator("#export").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("登录状态已改变"));
  await page.locator("#demo").click();
  assert.match(await page.locator("#status").innerText(), /模拟数据/);
  assert.equal(await page.locator("#export").isDisabled(), true);
  assert.match(await page.locator(".countdown").innerText(), /网页倒计时/);
  await page.locator("[data-close]").click();
  assert.equal(await page.locator(".countdown").innerText(), "网页倒计时已关闭");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: "/tmp/personal-os-mobile-preview.png", fullPage: true });
  assert.deepEqual(errors, []);
  assert.ok(calls.length >= 8);
});
