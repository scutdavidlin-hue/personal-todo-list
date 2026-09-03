# 剩余人工验收

Google Cloud、Supabase、OAuth、Google Tasks 真实创建与 Mac 页面状态同步均已完成。剩余只需 iPhone 最终验收：

1. 将当前改动合并并部署到现有 GitHub Pages 站点后，用 iPhone 打开 Tasks 页面做一次触控验收。
2. Google OAuth 应用在 Testing 阶段适合当前验收；长期稳定运行前需要完成 Production 发布所需的应用配置。

当前仓库没有原有 Google Calendar 写入实现；本阶段 Router 已保证固定时间事项不会误建为 Task，也没有重复建设 Calendar 服务。
