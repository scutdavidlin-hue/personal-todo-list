import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const requiredFiles = [
  "index.html",
  "today.html",
  "app.js",
  "today.js",
  "runtime-config.js",
  "src/core.js",
  "src/cloud-client.js",
  "supabase/migrations/202609030001_task_sync_v1.sql",
  "supabase/functions/task-status/index.ts",
  "supabase/functions/task-status/status-core.js",
];

const contents = new Map();
for (const file of requiredFiles) contents.set(file, await readFile(new URL(file, root), "utf8"));

assert.match(contents.get("index.html"), /type="module" src="app\.js"/);
assert.match(contents.get("index.html"), /id="cancelTaskDialog" type="button"/);
assert.match(contents.get("index.html"), /Content-Security-Policy/);
assert.match(contents.get("today.html"), /type="module" src="today\.js"/);
assert.match(contents.get("today.html"), /Content-Security-Policy/);
assert.match(contents.get("today.js"), /type="checkbox" data-action="toggle"/);
assert.doesNotMatch(contents.get("app.js"), /richeng-tasks-v1|sampleTasks/);
assert.doesNotMatch(contents.get("today.js"), /gpt-personal-tasks-v1|function seed/);
assert.match(contents.get("src/cloud-client.js"), /rollover_open_tasks/);
assert.match(contents.get("src/cloud-client.js"), /status: "cancelled"/);
assert.match(contents.get("supabase/migrations/202609030001_task_sync_v1.sql"), /enable row level security/i);
assert.match(contents.get("supabase/migrations/202609030001_task_sync_v1.sql"), /revoke all on table public\.tasks from anon, authenticated/i);
assert.match(contents.get("supabase/migrations/202609030001_task_sync_v1.sql"), /rollover_open_tasks/);
assert.match(contents.get("supabase/functions/task-status/index.ts"), /AUTOMATION_READ_TOKEN/);
assert.match(contents.get("supabase/functions/task-status/index.ts"), /AUTOMATION_WRITE_TOKEN/);

const config = contents.get("runtime-config.js");
assert.match(config, /supabaseUrl: ""/);
assert.match(config, /supabaseAnonKey: ""/);

const ignoredDirectories = new Set([".git", "node_modules"]);
async function sourceFiles(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const childRelative = path.join(relative, entry.name);
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child, childRelative));
    else files.push(childRelative);
  }
  return files;
}

const repositoryPath = fileURLToPath(root);
const files = await sourceFiles(repositoryPath);
const secretPatterns = [
  /sb_secret_[A-Za-z0-9_-]{20,}/,
  /(?:service_role|AUTOMATION_(?:READ|WRITE)_TOKEN)\s*[=:]\s*["'](?!YOUR_|generate-)[A-Za-z0-9_-]{20,}["']/,
  /ghp_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
];
for (const file of files) {
  if (!/\.(?:js|mjs|ts|html|css|md|json|toml|sql)$/.test(file)) continue;
  const source = await readFile(path.join(repositoryPath, file), "utf8");
  for (const pattern of secretPatterns) assert.doesNotMatch(source, pattern, `Possible committed secret in ${file}`);
}

console.log(`Static verification passed (${requiredFiles.length} required files, ${files.length} repository files scanned).`);
