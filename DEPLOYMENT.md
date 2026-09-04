# Google Tasks 集成部署与真实验收

代码与目标 Supabase Functions 已部署，现有 Google Cloud 项目也已启用 Tasks / Calendar API 并完成新增 Calendar scope 授权。以下保留为可重复部署说明；仓库不包含任何真实凭证。

## 1. Google Cloud

1. 在现有 Google Cloud 项目启用 **Google Tasks API** 与 **Google Calendar API**。
2. 在 Google Auth Platform 的 Data Access 中加入：
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/calendar.events`
3. 复用现有 Web OAuth Client；不要为 Tasks 再建一套登录体系。
4. Authorized redirect URI 加入 Supabase Dashboard 的 Google provider callback：
   `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
5. 若 OAuth 应用仍是 Testing，确认你的 Google 账号在 Test users 中。

Google Tasks scope 可能需要 Google OAuth consent screen 验证；个人 Testing 应用可先使用测试用户。

## 2. Supabase Auth 与数据库

1. 在 **Authentication → Providers → Google** 启用 Google，填入同一个 OAuth Client ID / Client Secret。
2. 在 **Authentication → URL Configuration** 保留现有 Site URL，并加入：
   - `https://scutdavidlin-hue.github.io/personal-todo-list/`
   - `https://scutdavidlin-hue.github.io/personal-todo-list/today.html`
   - 本地需要时：`http://127.0.0.1:4173/**`
3. 按顺序应用 migration：

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

`202609030002_google_tasks.sql` 会创建仅 service role 可访问的加密凭证表，并撤销客户端对旧 `tasks` 表的权限。每日小结表仍保留。

`202609040002_task_scheduling_v1_1.sql` 新增一对一 Schedule Metadata；不保存 Task title、notes 或完成状态。

## 3. 服务端 Secrets 与 Edge Functions

生成独立的 32 字节以上随机加密密钥和自动化 Token：

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

把真实值直接输入 Supabase Dashboard 的 Edge Function Secrets，或通过不会提交到 Git 的本机环境注入。需要这些名称：

```text
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_TOKEN_ENCRYPTION_KEY
GOOGLE_TASKS_LIST_TITLE
OWNER_USER_ID
AUTOMATION_READ_TOKEN
AUTOMATION_WRITE_TOKEN
```

其中 Google Client ID/Secret 必须与 Supabase Google provider 使用的 Web OAuth Client 相同，刷新令牌才能由该 client 正常换取 access token。

部署函数：

```bash
npx supabase functions deploy google-tasks --project-ref YOUR_PROJECT_REF --no-verify-jwt
npx supabase functions deploy task-status --project-ref YOUR_PROJECT_REF --no-verify-jwt
npx supabase functions deploy action-router --project-ref YOUR_PROJECT_REF --no-verify-jwt
npx supabase functions deploy task-scheduler --project-ref YOUR_PROJECT_REF --no-verify-jwt
npx supabase functions deploy personal-os-intake --project-ref YOUR_PROJECT_REF --no-verify-jwt
npx supabase functions deploy personal-os-mcp --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

函数在代码中自行验证调用方：浏览器请求验证 Supabase 用户 JWT；自动化请求使用独立的恒定时间 Token 比较。

## 4. 公开前端配置

只把公开配置写入 `runtime-config.js`：

```js
window.TASK_SYNC_CONFIG = Object.freeze({
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "YOUR_ANON_OR_PUBLISHABLE_KEY",
  googleOAuthScopes: "https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar.events",
});
```

不要把 Google Client Secret、Google refresh token、service role key 或加密密钥放进此文件。

## 5. 真实验收

1. 打开正式页面，点击“使用 Google 继续”，选择现有 Google 账号并同意 Tasks 权限。
2. 页面显示已连接 `Personal OS` Google Tasks 清单；不存在时系统会创建。
3. 创建 PRD 的两条东北旅行行李任务，以及 `查看域名审核结果`（Due `2026-09-13`）。
4. 在手机 Google Tasks 刷新，确认任务和日期可见。
5. 创建带明确时刻的 Task，确认 Google Calendar 在该时刻只出现一个 `☐` 投影。
6. 回到 Personal OS 页面勾选完成，确认原 Calendar Event 立即保留并变为 `✓`；如果从 Google Tasks 原生界面外部修改状态，则由下一次 Scheduler reconciliation 校正投影。
7. 调用 `action-router` 输入航班和行李两种语句，确认航班不创建 Task，行李重复输入返回 `deduplicated: true`。
8. 运行 `npm run verify`，再使用 `AUTOMATION_API.md` 的 GET 验证自动化读取的也是同一个 Google Tasks 真源。

## 6. 回滚与吊销

- 在 Google Account → Third-party access 中可随时吊销授权。
- 吊销后页面会返回 `GOOGLE_REAUTH_REQUIRED`，重新点击“连接 Tasks”即可。
- 若要彻底移除服务端刷新凭证，应在 Supabase 中删除对应 `google_tasks_credentials` 行；不要在日志或工单中复制该行内容。
