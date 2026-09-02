# 部署说明

当前仓库的代码与测试已就绪。要启用真实云同步，只需完成一次 Supabase 配置和一次 GitHub 推送。

## 1. 创建并初始化 Supabase

1. 在 Supabase 创建一个项目（免费套餐即可）。
2. 在 SQL Editor 运行 [`supabase/migrations/202609030001_task_sync_v1.sql`](supabase/migrations/202609030001_task_sync_v1.sql) 的完整内容。
3. 在 **Authentication → URL Configuration** 设置：
   - Site URL：`https://scutdavidlin-hue.github.io/personal-todo-list/`
   - Redirect URLs：
     - `https://scutdavidlin-hue.github.io/personal-todo-list/`
     - `https://scutdavidlin-hue.github.io/personal-todo-list/today.html`
     - 本地测试时可另加 `http://127.0.0.1:4173/**`
4. 保持 Email provider 启用。首次登录邮件由 Supabase Auth 发送。

也可以使用 Supabase CLI：

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

## 2. 填写公开前端配置

在 Supabase **Project Settings → API** 复制 Project URL 与 anon/publishable key，填写 [`runtime-config.js`](runtime-config.js)：

```js
window.TASK_SYNC_CONFIG = Object.freeze({
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "YOUR_ANON_OR_PUBLISHABLE_KEY",
});
```

这两个值按 Supabase 设计会公开给浏览器；不要在这里填写 service role key。

重新打开 `today.html`，输入邮箱并点击邮件中的一次性链接。成功后，在 Supabase **Authentication → Users** 可以看到该账号及其 User ID。

## 3. 部署自动化接口

生成两个不同的随机 Token，并只保存在你的密码管理器/自动化平台和 Supabase Secrets 中：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

设置服务端 Secret（命令历史敏感时也可直接在 Supabase Dashboard 的 Edge Function Secrets 页面填写）：

```bash
npx supabase secrets set --project-ref YOUR_PROJECT_REF \
  OWNER_USER_ID="YOUR_AUTH_USER_UUID" \
  AUTOMATION_READ_TOKEN="YOUR_RANDOM_READ_TOKEN" \
  AUTOMATION_WRITE_TOKEN="YOUR_DIFFERENT_RANDOM_WRITE_TOKEN"

npx supabase functions deploy task-status --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

`SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase Edge Function 运行环境自动提供。不要把 service role key 手工放进仓库。

## 4. 推送并启用 GitHub Pages

本机 GitHub CLI 登录已失效。如需从本机推送：

```bash
gh auth login -h github.com
git add .
git commit -m "feat: add secure cloud task sync"
git push origin main
```

在 GitHub 仓库 **Settings → Pages** 确认部署来源为 `main` 分支根目录。正式手机入口：

`https://scutdavidlin-hue.github.io/personal-todo-list/today.html`

## 5. 部署后冒烟测试

1. iPhone Safari 打开手机入口并通过邮箱登录。
2. 新建“云同步验收 A”，勾选，刷新页面确认仍为完成。
3. 电脑登录同一邮箱，确认 A 同样是完成。
4. 使用读 Token 调用状态接口，确认 `today_done` 中出现 A。
5. 创建一条昨天的 open 任务并刷新，确认只出现一个 `↪ 昨日延续`。

自动化 API 的 curl 与返回格式见 [`AUTOMATION_API.md`](AUTOMATION_API.md)。

