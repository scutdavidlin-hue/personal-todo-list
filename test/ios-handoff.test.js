import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const checker = join(root, "scripts/check-ios-xctest.py");

async function withLog(log, run) {
  const folder = await mkdtemp(join(tmpdir(), "personal-os-xctest-fixture-"));
  try {
    await writeFile(join(folder, "SyntheticTests.swift"), "func testOne() {}\nfunc testTwo() {}\n");
    await writeFile(join(folder, "xctest.log"), log);
    const result = spawnSync("python3", [checker, folder, join(folder, "xctest.log")], { encoding: "utf8" });
    await run(result);
  } finally { await rm(folder, { recursive: true, force: true }); }
}

test("XCTest evidence requires every source method despite an inflated green count", async () => {
  await withLog("Test Case '-[SyntheticTests testOne]' passed (0.1 seconds).\nExecuted 50 tests, with 0 failures\n", result => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing=testTwo/);
  });
});
test("XCTest evidence accepts completed methods and repeated suite summaries", async () => {
  await withLog("Test Case '-[SyntheticTests testOne]' passed (0.1 seconds).\nTest Case '-[SyntheticTests testTwo]' passed (0.1 seconds).\nExecuted 2 tests, with 0 failures\nExecuted 2 tests, with 0 failures\n", result => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).swiftMethodsPassed, 2);
  });
});
test("XCTest evidence recognizes the newer console format and rejects any failed suite", async () => {
  const methods = "Test case 'SyntheticTests.testOne()' passed (0.1 seconds).\nTest case 'SyntheticTests.testTwo()' passed (0.1 seconds).\nExecuted 2 tests, with 0 failures\n";
  await withLog(methods, result => assert.equal(result.status, 0, result.stderr));
  await withLog(methods + "Executed 1 test, with 1 failure\n", result => assert.notEqual(result.status, 0));
});

// These commands are simulated toolchain metadata, never an Apple build.
// Unknown xcodebuild/xcrun operations fail, including any signing/install call.
async function simulatedPreflight({ sdk = "26.2", simulator = true } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "personal-os-preflight-fixture-"));
  try {
    const bin = join(folder, "bin");
    const developer = join(folder, "Xcode.app/Contents/Developer");
    const output = join(folder, "output");
    await mkdir(bin);
    await mkdir(developer, { recursive: true });
    const scripts = {
      uname: '#!/bin/bash\nprintf "Darwin\\n"\n',
      xcodebuild: '#!/usr/bin/env node\nconst arg = process.argv[2]; if (arg === "-version") console.log("Xcode 26.3\\nBuild version synthetic"); else if (arg === "-showsdks") console.log("iOS 26.2 synthetic SDK"); else process.exit(99);\n',
      xcrun: `#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args[0]==="--sdk") console.log(${JSON.stringify(sdk)}); else if(args.join(" ")==="simctl list devices available --json") console.log(JSON.stringify({devices:{"com.apple.CoreSimulator.SimRuntime.iOS-26-2":${JSON.stringify(simulator ? [{ name: "iPhone Synthetic", isAvailable: true, udid: "synthetic-simulator-id" }] : [])}}})); else process.exit(99);\n`,
    };
    for (const [name, body] of Object.entries(scripts)) await writeFile(join(bin, name), body, { mode: 0o755 });
    const result = spawnSync("bash", [join(root, "ios/run-unsigned-checks.sh"), "--preflight-only", output], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEVELOPER_DIR: developer },
    });
    return { ...result, receipt: JSON.parse(await readFile(join(output, "receipt.json"), "utf8")) };
  } finally { await rm(folder, { recursive: true, force: true }); }
}

test("read-only preflight reports readiness without compiling, signing or installing", async () => {
  const result = await simulatedPreflight();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.receipt.overall, "ready_for_unsigned_build");
  for (const field of ["iphoneos_build", "iphonesimulator_build", "swift_xctest"]) assert.equal(result.receipt[field], "not_run");
  for (const field of ["signing", "physical_device_install", "phone_notification_delivery", "dynamic_island_observed"]) assert.equal(result.receipt[field], false);
});
test("preflight rejects an old SDK before a native build can masquerade as current", async () => {
  const result = await simulatedPreflight({ sdk: "18.5" });
  assert.equal(result.status, 2);
  assert.equal(result.receipt.iphoneos_build, "not_run");
  assert.match(result.stderr, /iOS 26\+ SDK is required/);
});
test("preflight refuses to download a missing simulator or report XCTest success", async () => {
  const result = await simulatedPreflight({ simulator: false });
  assert.notEqual(result.status, 0);
  assert.equal(result.receipt.swift_xctest, "not_run");
  assert.match(result.stderr, /install an iOS 26\+ iPhone simulator runtime/);
});
