# 剩余人工验收

V1.2 Goals & Plans migration 与三个相关 Edge Functions 已部署；MCP 健康端点已确认版本 `1.2.0`。本地桌面/手机 UI、自动分类、Goal / Project / Task 关系和 PWA 资源已通过自动及视觉检查。

需要用户完成：

1. 在现有 ChatGPT Personal OS App 详情页点击一次“刷新”，确认出现 `capture_personal_os_item`；OAuth 连接与 App ID 保持不变，不新建第二个 App。
2. 正式前端发布后，在 iPhone Safari 打开地址，选择“分享 → 添加到主屏幕”，确认全屏启动、Goals 页面和底部导航。

V1.1 的原 05:00 晨会 Scheduler 接入、ChatGPT Task/Calendar 链路及 iPhone Google Tasks / Google Calendar 跨设备结果已经验收，不需要重复操作。自定义 MCP App 的直接调用仍按现有产品能力留在 ChatGPT 网页端；iPhone 重点验收 Personal OS PWA。

`calendar_event`、`project_data`、`contact`、`client`、`knowledge` 与 `gpt_job` Adapter 仍为非目标；Gateway 会明确失败，不会误建 Task。Goal 与 Contact / Client / Company 的 UUID 扩展位已预留，等现有 People/CRM 数据层提供稳定主键后再加外键，不新建第二套联系人库。
