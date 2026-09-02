# 需要用户介入的事项

代码、测试和部署材料已全部完成。要把当前本地可验收版本变成真实线上云同步版本，你现在只需要做 1、2、3：

## 待最终集中处理

1. **创建 Supabase 项目**
   - 免费套餐即可；在 SQL Editor 运行 `supabase/migrations/202609030001_task_sync_v1.sql`。
   - 把 GitHub Pages 两个地址加入 Auth Redirect URLs。
   - 把 Project URL 与 anon/publishable key 填入 `runtime-config.js`（它们是公开客户端配置，不是高权限 Secret）。

2. **登录一次并配置自动化 Secret**
   - 用手机页面 Magic Link 登录一次，在 Supabase Auth Users 取得 User ID。
   - 运行 `npx supabase login`，然后按 `DEPLOYMENT.md` 设置 `OWNER_USER_ID`、读 Token、写 Token并部署 Edge Function。
   - `SUPABASE_SERVICE_ROLE_KEY` 由运行环境提供，绝不提交仓库。

3. **恢复 GitHub 登录并告诉 Codex“继续”**
   - 当前 `gh auth status` 显示 `scutdavidlin-hue` 的本机 Token 已失效；执行 `gh auth login -h github.com`。
   - 完成后只需回复“继续”。Codex 即可继续 push、检查 Pages，并做真实跨设备/API 验收，无需你重新解释项目。

## 不需要用户选择的技术项

- 已直接选择 Supabase，而非要求用户在 Supabase / Cloudflare / Vercel 中投票。
- 已选择 Magic Link + RLS，避免公开匿名写入。
- 已选择原地幂等延续，避免复制任务与重复数据。
