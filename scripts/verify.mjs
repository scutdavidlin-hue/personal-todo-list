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
  "sw.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-512-maskable.png",
  "runtime-config.js",
  "oauth/consent/index.html",
  "oauth/consent/app.js",
  "src/core.js",
  "src/goals.js",
  "src/cloud-client.js",
  "supabase/migrations/202609030001_task_sync_v1.sql",
  "supabase/migrations/202609030002_google_tasks.sql",
  "supabase/migrations/202609040001_personal_os_intake.sql",
  "supabase/migrations/202609040002_task_scheduling_v1_1.sql",
  "supabase/migrations/202609040003_goals_plans_v1_2.sql",
  "supabase/functions/google-tasks/index.ts",
  "supabase/functions/_shared/google-tasks-core.js",
  "supabase/functions/_shared/action-router.js",
  "supabase/functions/_shared/personal-os-intake.js",
  "supabase/functions/_shared/schedule-core.js",
  "supabase/functions/action-router/index.ts",
  "supabase/functions/task-status/index.ts",
  "supabase/functions/task-status/status-core.js",
  "supabase/functions/personal-os-intake/index.ts",
  "supabase/functions/personal-os-mcp/index.ts",
  "supabase/functions/task-scheduler/index.ts",
];

const contents = new Map();
for (const file of requiredFiles) contents.set(file, await readFile(new URL(file, root), "utf8"));

assert.match(contents.get("index.html"), /type="module" src="app\.js"/);
assert.match(contents.get("index.html"), /id="cancelTaskDialog" type="button"/);
assert.match(contents.get("index.html"), /id="goalsView"/);
assert.match(contents.get("index.html"), /rel="manifest" href="manifest\.webmanifest"/);
assert.match(contents.get("index.html"), /rel="apple-touch-icon"/);
assert.match(contents.get("index.html"), /Content-Security-Policy/);
assert.match(contents.get("today.html"), /type="module" src="today\.js(?:\?[^\"]+)?"/);
assert.match(contents.get("today.html"), /Content-Security-Policy/);
assert.match(contents.get("today.html"), /rel="manifest" href="manifest\.webmanifest"/);
assert.match(contents.get("today.js"), /type="checkbox" data-action="toggle"/);
assert.doesNotMatch(contents.get("app.js"), /richeng-tasks-v1|sampleTasks/);
assert.doesNotMatch(contents.get("today.js"), /gpt-personal-tasks-v1|function seed/);
assert.match(contents.get("src/cloud-client.js"), /https:\/\/www\.googleapis\.com\/auth\/tasks/);
assert.match(contents.get("src/cloud-client.js"), /async createTask\(/);
assert.match(contents.get("src/cloud-client.js"), /async listTasks\(/);
assert.match(contents.get("src/cloud-client.js"), /async listTaskLists\(/);
assert.match(contents.get("src/cloud-client.js"), /async listOpenTasks\(/);
assert.match(contents.get("src/cloud-client.js"), /async completeTask\(/);
assert.match(contents.get("src/cloud-client.js"), /async reopenTask\(/);
assert.match(contents.get("src/cloud-client.js"), /async updateTask\(/);
assert.match(contents.get("src/cloud-client.js"), /async deleteTask\(/);
assert.match(contents.get("src/cloud-client.js"), /async createGoal\(/);
assert.match(contents.get("src/cloud-client.js"), /async createProject\(/);
assert.match(contents.get("src/cloud-client.js"), /async linkTaskContext\(/);
assert.match(contents.get("supabase/migrations/202609030001_task_sync_v1.sql"), /enable row level security/i);
assert.match(contents.get("supabase/migrations/202609030001_task_sync_v1.sql"), /revoke all on table public\.daily_reviews from anon, authenticated/i);
assert.match(contents.get("supabase/migrations/202609030002_google_tasks.sql"), /pgp_sym_encrypt/i);
assert.match(contents.get("supabase/migrations/202609030002_google_tasks.sql"), /revoke all on table public\.google_tasks_credentials from public, anon, authenticated/i);
assert.match(contents.get("supabase/functions/google-tasks/index.ts"), /tasks\.googleapis\.com\/tasks\/v1/);
assert.match(contents.get("supabase/functions/google-tasks/index.ts"), /oauth2\.googleapis\.com\/token/);
assert.match(contents.get("supabase/functions/google-tasks/index.ts"), /DEFAULT_TASK_LIST_TITLE/);
assert.match(contents.get("supabase/functions/action-router/index.ts"), /classifyAction/);
assert.match(contents.get("supabase/functions/_shared/action-router.js"), /gpt_job/);
assert.match(contents.get("supabase/functions/_shared/action-router.js"), /knowledge/);
assert.match(contents.get("supabase/functions/personal-os-intake/index.ts"), /idempotency-key/i);
assert.match(contents.get("supabase/functions/personal-os-intake/index.ts"), /personal_os_intake_audit/);
assert.match(contents.get("supabase/functions/personal-os-mcp/index.ts"), /tools\/list/);
assert.match(contents.get("supabase/functions/personal-os-mcp/index.ts"), /tools\/call/);
assert.match(contents.get("supabase/functions/personal-os-mcp/index.ts"), /create_task/);
assert.match(contents.get("supabase/functions/personal-os-mcp/index.ts"), /capture_personal_os_item/);
assert.match(contents.get("supabase/functions/_shared/personal-os-intake.js"), /goalPlanDispatchPayload/);
assert.match(contents.get("supabase/migrations/202609040001_personal_os_intake.sql"), /unique \(owner_id, idempotency_key\)/i);
assert.match(contents.get("supabase/migrations/202609040002_task_scheduling_v1_1.sql"), /unique \(owner_id, google_task_id\)/i);
assert.doesNotMatch(contents.get("supabase/migrations/202609040002_task_scheduling_v1_1.sql"), /\n\s+(?:title|completed_at|task_status)\s/i);
assert.match(contents.get("supabase/migrations/202609040003_goals_plans_v1_2.sql"), /create table if not exists public\.goals_plans/i);
assert.match(contents.get("supabase/migrations/202609040003_goals_plans_v1_2.sql"), /amount_remaining numeric\(18, 2\) generated always/i);
assert.match(contents.get("supabase/migrations/202609040003_goals_plans_v1_2.sql"), /create table if not exists public\.task_context_links/i);
assert.match(contents.get("supabase/migrations/202609040003_goals_plans_v1_2.sql"), /enable row level security/i);
assert.match(contents.get("supabase/functions/task-scheduler/index.ts"), /stableCalendarEventId/);
assert.match(contents.get("supabase/functions/_shared/schedule-core.js"), /personalOsProjection/);
assert.match(contents.get("oauth/consent/app.js"), /approveAuthorization/);
assert.match(contents.get("supabase/functions/task-status/index.ts"), /AUTOMATION_READ_TOKEN/);
assert.match(contents.get("supabase/functions/task-status/index.ts"), /AUTOMATION_WRITE_TOKEN/);
assert.match(contents.get("supabase/functions/task-status/index.ts"), /tasks\.googleapis\.com\/tasks\/v1/);

const manifest = JSON.parse(contents.get("manifest.webmanifest"));
assert.equal(manifest.display, "standalone");
assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
assert.match(contents.get("sw.js"), /personal-os-shell-v1\.2\.0/);
assert.match(contents.get("sw.js"), /request\.method !== "GET"/);

const config = contents.get("runtime-config.js");
assert.match(config, /supabaseUrl:\s*"https:\/\/[a-z0-9-]+\.supabase\.co"/i);
assert.match(config, /supabaseAnonKey:\s*"[A-Za-z0-9._-]{20,}"/);
assert.doesNotMatch(config, /YOUR_|PLACEHOLDER/i);

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
  /GOOGLE_(?:OAUTH_CLIENT_SECRET|TOKEN_ENCRYPTION_KEY)\s*[=:]\s*["'](?!YOUR_|generate-)[A-Za-z0-9_-]{20,}["']/,
];
for (const file of files) {
  if (!/\.(?:js|mjs|ts|html|css|md|json|toml|sql)$/.test(file)) continue;
  const source = await readFile(path.join(repositoryPath, file), "utf8");
  for (const pattern of secretPatterns) assert.doesNotMatch(source, pattern, `Possible committed secret in ${file}`);
}

console.log(`Static verification passed (${requiredFiles.length} required files, ${files.length} repository files scanned).`);
