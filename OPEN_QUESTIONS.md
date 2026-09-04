# 剩余人工验收

V1 MCP 已注册并完成真实写入。V1.1 migration、Edge Functions、Calendar API、OAuth scope、Mac 端 `Task → 15:00 Calendar → Complete → ✓`、ChatGPT App tools 刷新，以及 Web ChatGPT `schema → Task → Calendar` 均已完成真实验收。

需要用户完成：

1. 在 iPhone Google Tasks 与 Google Calendar 核对同一 Task/Event；自定义 MCP 官方目前不支持 iPhone ChatGPT，移动验收不包含直接 MCP 调用。

现有 05:00 晨会自动化还需在读取 `task-status` 前增加一次 `task-scheduler {action: run}` 调用；应修改原自动化，不新建第二条晨会链路。

本机 `~/.codex/automations` 没有该任务配置；它属于 ChatGPT Scheduled Tasks。下一步应在 `chatgpt.com/schedules` 中按 05:00 与 Gmail/晨会内容定位原条目，确认目标后再编辑，不能猜 ID。

`project_data`、`knowledge` 与 `gpt_job` Adapter 仍为非目标；Gateway 会明确失败，不会误建 Task。
