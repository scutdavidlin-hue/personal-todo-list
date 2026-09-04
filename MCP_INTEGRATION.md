# ChatGPT MCP 接入

## 已实现

- 稳定 HTTPS MCP 地址：`https://zlezrdbloffdrkakqyiq.supabase.co/functions/v1/personal-os-mcp/mcp`
- MCP Streamable HTTP；服务名 `personal-os`，工具名 `create_task`。
- Supabase Auth OAuth 2.1、PKCE、动态客户端注册和授权同意页。
- 每次 MCP 请求校验 Supabase access token，并限制为 `OWNER_USER_ID`。
- MCP 只把经过验证的结构化字段送入 `personal-os-intake`；Google refresh token、service role key、自动化 Token 均不返回 ChatGPT。
- 工具元数据明确排除 Calendar、项目事实、长期知识和 GPT 周期研究任务，避免误写普通 Task。

## 首次连接

1. 在 ChatGPT 打开 Settings → Security and login，开启 Developer mode。
2. 打开 ChatGPT Plugins，新增 MCP connection。
3. 名称填写 `Personal OS`，URL 填写上面的 MCP 地址。
4. 按 OAuth 页面提示使用现有 Google/Supabase 账号登录，并选择“允许写入任务”。
5. 查看发现的 `create_task` 工具，创建连接并复制浏览器地址中的 `plugin_asdk_app...` 技术 ID。
6. 用该 ID 生成本仓库的 `.app.json` 与插件清单，安装后在新聊天中启用。

OpenAI 官方当前流程要求先在 Developer mode 注册远程 MCP，取得 `plugin_asdk_app...` ID 后再打包插件。Web、桌面和移动版 ChatGPT 均可使用账号中已安装且可用的插件。

## 验收提示

- `明天提醒我安排小青蛙寄养。` → 调用 `create_task`，Google Tasks/GoTask 出现任务。
- `下周跟袁老师确认三一重工的对接。` → 调用 `create_task`。
- `9月8日上午11点广州飞哈尔滨。` → 不调用 `create_task`，应进入 Calendar 路径。
- `每天晚上帮我搜索比亚迪和招商南油最新情况并分析。` → 不调用 `create_task`，应进入 GPT 智能执行路径。
