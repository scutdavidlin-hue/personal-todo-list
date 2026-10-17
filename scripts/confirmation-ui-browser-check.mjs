// Explicit optional browser check. Only loopback synthetic pages are loaded.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startSyntheticConfirmationDemo } from "../demo/confirmation-ui/server.mjs";
const browserPath = process.argv[2] || "/usr/bin/chromium";
const screenshotPath = process.argv[3] || "/tmp/personal-os-confirmation-ui.png";
const profile = await mkdtemp(join(tmpdir(), "personal-os-demo-chrome-"));
const demo = await startSyntheticConfirmationDemo();
let browser, socket, calls = 0; const pending = new Map(), exceptions = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  browser = spawn(browserPath, ["--headless", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-default-browser-check", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let port;
  for (let i = 0; i < 100; i += 1) {
    try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (i === 99) throw new Error("Chromium did not start"); await pause(50); }
  }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(x => x.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", event => {
    const value = JSON.parse(event.data);
    if (value.method === "Runtime.exceptionThrown") exceptions.push(value.params.exceptionDetails.text);
    if (value.id) { const done = pending.get(value.id); pending.delete(value.id); value.error ? done.reject(new Error(value.error.message)) : done.resolve(value.result); }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++calls; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async expression => { for (let i = 0; i < 100; i += 1) { if (await evaluate(expression)) return; await pause(30); } throw new Error(`Browser condition timed out: ${expression}; ${await evaluate("document.getElementById('result')?.textContent + ' / ' + document.getElementById('trace')?.textContent")}; exceptions=${JSON.stringify(exceptions)}`); };
  const click = async id => { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); };
  await command("Page.enable"); await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1200, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: demo.baseURL }); await until("document.readyState === 'complete' && !!document.getElementById('session')");
  await click("session"); await until("!document.getElementById('build').disabled");
  await click("build"); await until("!document.getElementById('approve').disabled");
  await evaluate("document.getElementById('title').value += '（修改）'; document.getElementById('title').dispatchEvent(new Event('input', {bubbles:true}))");
  assert.equal(await evaluate("document.getElementById('approve').disabled && !document.getElementById('dirty').hidden"), true);
  await click("revise"); await until("document.getElementById('binding').textContent.includes('版本 2') && !document.getElementById('approve').disabled");
  await click("approve"); await until("!document.getElementById('execute').disabled");
  await click("execute"); await until("document.getElementById('count').textContent === '1' && !document.getElementById('execute').disabled");
  await click("execute"); await until("document.getElementById('result').textContent.includes('幂等回读')");
  assert.equal(await evaluate("document.getElementById('count').textContent"), "1");
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  await click("build"); await until("!document.getElementById('approve').disabled");
  await click("approve"); await until("!document.getElementById('reject').disabled && !document.getElementById('execute').disabled");
  await click("reject"); await until("document.getElementById('status').textContent.includes('已拒绝')");
  await click("execute"); await until("document.getElementById('result').textContent.includes('SOURCE_APPROVAL_SUPERSEDED')");
  assert.equal(await evaluate("document.getElementById('count').textContent"), "1"); assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ mode: "synthetic-loopback-browser", browser: browserPath,
    checks: ["visible synthetic warning", "edit disables confirmation", "new version required", "explicit UI decision", "independent verifier and memory execution", "replay keeps count one", "390px layout has no horizontal overflow", "later UI rejection blocks old approval"],
    passed: true, uncaughtPageExceptions: exceptions, realAuthOrGoogleCalls: 0, realHumanProvenanceVerified: false, screenshot: screenshotPath }, null, 2));
} finally {
  socket?.close(); if (browser && browser.exitCode === null) { const closed = new Promise(resolve => browser.once("close", resolve)); browser.kill("SIGTERM"); await closed; }
  await demo.close(); await rm(profile, { recursive: true, force: true });
}
