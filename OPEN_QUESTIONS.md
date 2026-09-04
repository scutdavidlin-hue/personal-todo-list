# 剩余人工验收

代码、迁移和云函数部署后，唯一必须由用户完成的是 ChatGPT 账号侧的 MCP 注册与 OAuth 同意：

1. ChatGPT Settings → Security and login → 开启 Developer mode。
2. 在 ChatGPT Plugins 新增 MCP connection，URL 使用 `https://zlezrdbloffdrkakqyiq.supabase.co/functions/v1/personal-os-mcp/mcp`。
3. 使用现有 Google/Supabase 账号登录并点击“允许写入任务”。
4. 把浏览器地址里的 `plugin_asdk_app...` 技术 ID 交给 Codex，以完成插件清单、安装和 iPhone 端到端验收。

当前仓库没有 Google Calendar、project data、knowledge 或 GPT job 写入 Adapter；Gateway 会明确返回失败，不会误建 Task 或伪造成功。
