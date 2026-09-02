# PRD V1.0 验收记录

日期：2026-09-03

状态说明：`PASS (local)` 表示代码、自动化测试或本地浏览器已验证；`PENDING (cloud)` 表示必须在用户 Supabase 项目部署后做真实外部验证，当前不虚报为通过。

| # | 验收项 | 当前结果 | 证据 / 部署后动作 |
|---|---|---|---|
| 1 | iPhone 打开 today 页面看到真实今日任务 | PASS (local) / PENDING (cloud) | 390×844 浏览器无溢出、无控制台错误；部署后登录读取真实库。 |
| 2 | 勾选 A，刷新仍完成 | PASS (code) / PENDING (cloud) | checkbox 等待 PATCH 成功后才更新真值；需在真实项目刷新复验。 |
| 3 | 换设备登录仍看到 A 完成 | PASS (architecture) / PENDING (cloud) | Auth + RLS + 同一 Postgres 数据源；需两台设备实测。 |
| 4 | 自动化接口返回 A=done | PASS (code) / PENDING (cloud) | Edge Function GET 输出 `today_done`；需部署 Token 后 curl。 |
| 5 | 未完成 B 次日只延续一次 | PASS (automated) / PENDING (cloud) | RPC 原地更新同一 UUID，不 insert；重复调用更新 0 行。 |
| 6 | 完成 B 后下一天不进入 open | PASS (code) / PENDING (cloud) | rollover 条件严格为 `status='open'`。 |
| 7 | 取消任务后不再延续 | PASS (automated) / PENDING (cloud) | UI 写 `status=cancelled`；rollover 排除 cancelled。 |
| 8 | 网络写入失败可见、无假完成 | PASS (automated) | 客户端抛错且不修改任务数组；两页均恢复 UI 并显示错误。 |
| 9 | repo 不存在 Secret | PASS (automated) | `scripts/verify.mjs` 全仓扫描；运行配置当前为空。 |
| 10 | 旧 localStorage 可一次性迁移 | PASS (automated) / PENDING (cloud) | 双 key、样例过滤、UUID upsert、成功后 flag；失败不写 flag。 |

## 已运行的验证

- `npm run verify`：语法、结构、安全扫描通过。
- Node 内置测试：16 tests，16 pass，0 fail。
- 本地浏览器桌面 1440×900：配置缺失引导正常，无横向溢出，无 console error/warn。
- 本地浏览器 iPhone 390×844：配置缺失引导正常，`scrollWidth=innerWidth=390`，无 console error/warn。

## 云端最终验收入口

完成 [`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md) 的一次性配置后，严格按 [`DEPLOYMENT.md`](DEPLOYMENT.md) 第 5 节执行；结果再回填本表为 `PASS (cloud)`。
