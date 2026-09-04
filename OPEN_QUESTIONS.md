# 剩余人工验收

V1 MCP 已注册并完成真实写入。V1.1 migration、Edge Functions、Calendar API、OAuth scope，以及 Mac 端 `Task → 15:00 Calendar → Complete → ✓` 已完成真实验收。

需要用户完成：

1. 确认后，在 ChatGPT `Personal OS` 插件详情页点击“刷新”，审阅新增 schedule 参数。刷新会更新该 App 可调用的动作/参数，因此执行前必须取得用户当次确认。
2. 用“明天下午 3 点做 A”做一次 Web ChatGPT V1.1 schema → Task → Calendar 验收。
3. 在 iPhone Google Tasks 与 Google Calendar 核对同一 Task/Event；自定义 MCP 官方目前不支持 iPhone ChatGPT，移动验收不包含直接 MCP 调用。

现有 05:00 晨会自动化还需在读取 `task-status` 前增加一次 `task-scheduler {action: run}` 调用；应修改原自动化，不新建第二条晨会链路。

`project_data`、`knowledge` 与 `gpt_job` Adapter 仍为非目标；Gateway 会明确失败，不会误建 Task。
