# ChatGPT MCP 接入

## 已实现

- 稳定 HTTPS MCP 地址：`https://zlezrdbloffdrkakqyiq.supabase.co/functions/v1/personal-os-mcp/mcp`
- MCP Streamable HTTP；服务名 `personal-os`，工具名 `create_task`。
- Supabase Auth OAuth 2.1、PKCE、动态客户端注册和授权同意页。
- 每次 MCP 请求校验 Supabase access token，并限制为 `OWNER_USER_ID`。
- MCP 只把经过验证的结构化字段送入 `personal-os-intake`；Google refresh token、service role key、自动化 Token 均不返回 ChatGPT。
- 工具元数据明确排除 Calendar、项目事实、长期知识和 GPT 周期研究任务，避免误写普通 Task。
- `create_task` V1.1 可接收明确的执行日期、时间、duration、priority 与 fixed_time，并在写 Task 后建立唯一 Calendar 投影。

## 首次连接

1. 在 ChatGPT 打开 Settings → Security and login，开启 Developer mode。
2. 打开 ChatGPT Plugins，新增 MCP connection。
3. 名称填写 `Personal OS`，URL 填写上面的 MCP 地址。
4. 按 OAuth 页面提示使用现有 Google/Supabase 账号登录，并选择“允许写入任务”。
5. 查看发现的 `create_task` 工具并创建连接。
6. 已连接 App ID：`asdk_app_6a9ab767459c8191934b1ec76be1378e`。服务端 schema 变更后在插件详情页点击“刷新”。

OpenAI 官方当前流程通过 Developer mode 注册远程 MCP。当前自定义 MCP App 仅支持 ChatGPT 网页端；iPhone 只能验收 Google Tasks / Calendar 的跨端结果，不能在 iPhone ChatGPT 内直接调用此 App。

## 验收提示

- `明天提醒我安排小青蛙寄养。` → 调用 `create_task`，Google Tasks/GoTask 出现任务。
- `明天下午3点导出 ChatGPT 历史数据。` → 同一 Task 写入 Google Tasks，并在 Calendar 15:00 形成唯一投影。
- `下周跟袁老师确认三一重工的对接。` → 调用 `create_task`。
- `9月8日上午11点广州飞哈尔滨。` → 不调用 `create_task`，应进入 Calendar 路径。
- `每天晚上帮我搜索比亚迪和招商南油最新情况并分析。` → 不调用 `create_task`，应进入 GPT 智能执行路径。
