# 剩余人工验收

V1 MCP 已注册并完成真实写入。V1.1 migration、Edge Functions、Calendar API、OAuth scope、Mac 端 `Task → Calendar → Complete → ✓`、ChatGPT App tools 刷新、Web ChatGPT `schema → Task → Calendar`，以及原 05:00 晨会的 Scheduler 接入均已完成真实验收。

需要用户完成：

1. 在 iPhone Google Tasks 与 Google Calendar 核对同一 Task/Event；自定义 MCP 官方目前不支持 iPhone ChatGPT，移动验收不包含直接 MCP 调用。

`project_data`、`knowledge` 与 `gpt_job` Adapter 仍为非目标；Gateway 会明确失败，不会误建 Task。
