# Personal Todo List · 云同步 V1

一个保留原有界面、以手机为主要入口的个人任务系统。任务不再以 localStorage 为主数据源，而是通过 Supabase Auth + Postgres + RLS 安全同步；`today.html` 与桌面页读取同一份云端状态。

## 已实现

- 邮箱 Magic Link 登录，跨浏览器/跨设备共享任务。
- checkbox 真正写入云端；失败时恢复原状态并提示，杜绝“假完成”。
- 新增、编辑、取消、恢复未完成、移到明天。
- open 过期任务原地幂等延续，显示 `↪ 日期 延续`，不复制 UUID。
- 已完成与取消任务不会继续延续。
- 两套旧 localStorage 的一次性、可重试、去重迁移；已知 sampleTasks 自动排除。
- 最近云端快照只作离线只读缓存。
- 每日小结同步到云端。
- GPT/自动化 GET 状态接口与 POST 新任务接口，读写 Token 分离。
- RLS 用户隔离、服务端 Secret 边界、基础限流与全仓 Secret 扫描。

## 页面

- `index.html`：完整桌面/响应式管理页。
- `today.html`：Gmail 中“☑️ 打开今日任务”应指向的手机页。

## 本地检查

```bash
npm run verify
python3 -m http.server 4173 --bind 127.0.0.1
```

打开 `http://127.0.0.1:4173/` 或 `http://127.0.0.1:4173/today.html`。

## 文档

- [正式需求](PRD_TASK_SYNC_V1.md)
- [实施计划](IMPLEMENTATION_PLAN.md)
- [部署说明](DEPLOYMENT.md)
- [自动化 API](AUTOMATION_API.md)
- [验收记录](ACCEPTANCE.md)
- [开发进度](PROGRESS.md)
- [需用户介入事项](OPEN_QUESTIONS.md)

## 安全说明

`runtime-config.js` 中的 Supabase Project URL 与 anon/publishable key 是公开客户端配置，不是管理员密钥。数据安全依靠登录用户 JWT 和数据库 RLS。绝不能把 service role key、自动化 Token、GitHub PAT 或邮箱凭据写入该文件、前端源码或 Git。

