# 自然语言自主落库 V1.0 验收

## WHY / GOAL

让明确、低风险的行动直接进入现有 Google Tasks 链路，减少字段补全追问。保留高风险确认、语义去重、原位修改和真实写入反馈。

## IMPLEMENTATION

- 策略与真实 Intake handler 接通；低风险缺少酒店名称或时刻不阻塞。
- 日期使用对话、Calendar 和现有 Travel Goals 上下文；重新读取当前 Task 后处理短句改期及部分取消。
- Google Task 正文与 Date 回读一致才确认。时间修改同时核对 Schedule；Calendar 失败单独标记。
- 信息查询零写入；长期规则进入现有 Goals & Plans；混合意图分别保存并报告部分结果。
- 同人、同日、同时的见面表达复用一个任务；多个相同匹配返回澄清；后续跟进保留与原任务的关联。
- 恢复本地快照遗漏的既有 CRUD/Follow-up 能力，与自主规则和 Smart Reminder 共存。

## TEST

最终计数记录于本文件 RESULT。测试包括策略、真实 Intake HTTP handler 模拟、Google Task/Schedule 回读、稳定 Calendar Event ID，以及原有任务/Goal/排程/语义解析回归。

本机缓存 Deno 对 `personal-os-mcp`、`personal-os-intake`、`google-tasks`、`task-status`、`task-scheduler`、`action-router` 六个实际入口进行类型检查，无需下载或安装依赖。

## 发布检查点

本地完整回归不代表生产部署。没有向 Google Tasks 创建 PRD 中的示例事项，没有执行示例房产/付款操作，也没有修改线上 Functions 或应用生产 migration。

2026-09-05，现有 Supabase CLI 完成当前工作副本与既有 Personal OS 项目的关联。`db push --dry-run --linked` 在认证阶段返回 `LegacyPlatformAuthRequiredError`：当前 CLI 缺少 access token，须在本机执行 `supabase login`。生产 migration 状态尚未核验。

登录后续跑顺序：

1. 在当前目录重新运行现有 CLI 的 `db push --dry-run --linked`；检查既有生命周期、解析层和提醒层 migration，不重复应用已部署版本。
2. 获得此发布包的明确生产发布授权。
3. 应用必要 migration，统一发布六个受影响 Functions。不得覆盖为旧 MCP 工具子集。
4. 刷新 ChatGPT Personal OS MCP，检查 15 个工具仍存在；用一个明确标注的测试任务验证新增、改期、部分取消、完成/恢复和同一 Calendar ID，再清理该测试项。

## 残余边界

- 策略是有界的词语规则，未知表达可能需要澄清；MCP 调用者仍须传入已知的当前任务 ID 和对话行程。
- 已完成的内部写入审计可在外层超时后回读复用。若进程在 provider 写入与审计记录之间中断，且没有可核实结果 ID，系统停止再次插入并要求先对账；Google Tasks 不提供跨数据库事务。
- Calendar 成功仅代表时间投影成功，不代表 iPhone 通知实际送达。
- 当前目录是既有代码的集成工作副本；没有新建 Git 仓库、分支、提交、数据库或并行任务源。
- 先前快照文档关于“CRUD 基线已包含”的结论与实际文件不符，本轮以代码能力和原有测试为准，不依赖该历史说法。

## RESULT

本地实现完成：`npm run verify` 共 256/256 通过，静态检查通过（67 个必需文件、117 个扫描文件）。六个服务入口 Deno 类型检查全部通过，差异空白检查通过。原版生命周期测试文件逐字节一致，8/8 通过。

生产尚未发布，发布等待 CLI 登录与明确发布授权。可在本机使用现有缓存 CLI 登录：

```sh
/Users/davidlin/.npm/_npx/aa8e5c70f9d8d161/node_modules/@supabase/cli-darwin-arm64/bin/supabase login
```

本轮无生产数据写入、无新服务/依赖/自动化、无 Git 提交。用户未被要求选择实现方案；共发起 4 次沙箱权限申请（运行状态写入、项目关联、关联后的 dry-run、登记现有能力注册表）。能力登记和复用验收门均通过，登记记录明确标注仅本地验证、生产待发布。
