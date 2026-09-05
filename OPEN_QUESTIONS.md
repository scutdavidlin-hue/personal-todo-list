# 剩余人工验收

无。V1 MCP 已注册并完成真实写入。V1.1 migration、Edge Functions、Calendar API、OAuth scope、Mac 端 `Task → Calendar → Complete → ✓`、ChatGPT App tools 刷新、Web ChatGPT `schema → Task → Calendar`、原 05:00 晨会的 Scheduler 接入，以及 iPhone Google Tasks / Google Calendar 跨设备结果均已完成真实验收。

自定义 MCP App 官方目前仅支持网页端；本次 iPhone 验收按既定范围只核对 Google Tasks / Google Calendar 跨端结果，不包含在 iPhone ChatGPT 内直接调用自定义 MCP。

`project_data`、`knowledge` 与 `gpt_job` Adapter 仍为非目标；Gateway 会明确失败，不会误建 Task。

## Task Conversational Update V1 release checkpoints

- Existing GPT/LLM service configuration location is required; no key should be sent through chat. Deterministic fallback is not full GPT interpretation.
- Existing Supabase CLI reports `Access token not provided`; resume through existing account login, then inspect remote migrations before deploying the delta.
- Run real iPhone speech/clarification/confirmation and Google Tasks + Calendar readback acceptance after deployment.
