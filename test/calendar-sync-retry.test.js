import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Calendar projection sync retries recoverable scheduler failures", async () => {
  const source = await readFile(new URL("supabase/functions/google-tasks/index.ts", root), "utf8");
  assert.match(source, /function shouldRetrySchedulerSync/);
  assert.match(source, /const maxAttempts = 3/);
  assert.match(source, /status === 408 \|\| status === 429 \|\| status >= 500/);
  assert.match(source, /await new Promise\(\(resolve\) => setTimeout\(resolve, 200 \* attempt\)\)/);
  assert.match(source, /attempts: attempt/);
});

test("Calendar projection sync still surfaces permanent failures", async () => {
  const source = await readFile(new URL("supabase/functions/google-tasks/index.ts", root), "utf8");
  assert.match(source, /if \(!shouldRetrySchedulerSync\(response\.status/);
  assert.match(source, /projection_error: projection\.success === true \? null : projection/);
});
