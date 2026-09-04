# ChatGPT MCP 接入

## 已实现

- 稳定 HTTPS MCP 地址：`https://zlezrdbloffdrkakqyiq.supabase.co/functions/v1/personal-os-mcp/mcp`
- MCP Streamable HTTP；服务名 `personal-os`，版本 `1.2.0`，工具为 `create_task` 与 `capture_personal_os_item`。
- Supabase Auth OAuth 2.1、PKCE、动态客户端注册和授权同意页。
- 每次 MCP 请求校验 Supabase access token，并限制为 `OWNER_USER_ID`。
- MCP 只把经过验证的结构化字段送入 `personal-os-intake`；Google refresh token、service role key、自动化 Token 均不返回 ChatGPT。
- `create_task` 继续只处理明确可执行动作；`capture_personal_os_item` 处理 Task、Goal、Plan、LongTermItem 与 FinancialItem 的自动分类和持久化。
- 工具元数据明确排除直接 Calendar 事件、项目事实、联系人资料、长期知识和 GPT 周期研究任务，避免误写普通 Task。
- `create_task` V1.1 可接收明确的执行日期、时间、duration、priority 与 fixed_time，并在写 Task 后建立唯一 Calendar 投影。
- `capture_personal_os_item` 保留 `raw_text` 与用户明确给出的 `why`，支持年份、月份、日期三种目标精度和财务余额字段；不会自行编造 Deadline 或下一步 Task。

## 首次连接

1. 在 ChatGPT 打开 Settings → Security and login，开启 Developer mode。
2. 打开 ChatGPT Plugins，新增 MCP connection。
3. 名称填写 `Personal OS`，URL 填写上面的 MCP 地址。
4. 按 OAuth 页面提示使用现有 Google/Supabase 账号登录，并选择“允许写入任务”。
5. 查看发现的 `create_task` 与 `capture_personal_os_item` 工具并创建连接。
6. 已连接 App ID：`asdk_app_6a9ab767459c8191934b1ec76be1378e`。服务端 schema 变更后在插件详情页点击“刷新”；V1.2 上线后必须刷新一次，ChatGPT 才会发现新工具。

OpenAI 官方当前流程通过 Developer mode 注册远程 MCP。当前自定义 MCP App 仅支持 ChatGPT 网页端；iPhone 只能验收 Google Tasks / Calendar 的跨端结果，不能在 iPhone ChatGPT 内直接调用此 App。

## 验收提示

- `明天提醒我安排小青蛙寄养。` → 调用 `create_task`，Google Tasks/GoTask 出现任务。
- `明天下午3点导出 ChatGPT 历史数据。` → 同一 Task 写入 Google Tasks，并在 Calendar 15:00 形成唯一投影。
- `下周跟袁老师确认三一重工的对接。` → 调用 `create_task`。
- `我明年想买房。` → 调用 `capture_personal_os_item`，写入 Goal，不创建 Task。
- `10–11 月开始做 To C 产品。` → 写入 Plan，保留月份精度，不伪造某一天。
- `小斌还欠我 3 万元。` → 写入 FinancialItem / Receivable；以后催款是另一个 Task。
- `这个月先看看番禺有哪些楼盘。` → 在已有买房 Goal 下创建阶段 Project 与明确下一步 Task；不能仅凭 Goal 自动生成行动。
- `9月8日上午11点广州飞哈尔滨。` → 不调用 `create_task`，应进入 Calendar 路径。
- `每天晚上帮我搜索比亚迪和招商南油最新情况并分析。` → 不调用 `create_task`，应进入 GPT 智能执行路径。
