# 铁路提醒模板与日期对账：合成复现及最小修复

基线：`bb240517727a81ca89059985295b7c9da144403b`，独立分支
`fix/rail-security-reminder-20261017`。不以旧 main 或 PR12 为补丁基线；
不声称此源 SHA 已映射到当前生产的 opaque Edge bundle。

本次只读检查代码并使用完全虚构数据。没有读取/修改真实任务、日历、身份或凭据，
没有部署、迁移、权限变更或 Calendar cancelled 清理。本文件不记录实际行程或个人信息。

## 已证的软件路径

输入：`乘坐某列车，从某高铁车站出发，提前安检进站`，配合虚构日期和时刻。

`resolveReminderPolicy` 合并 raw_text/title/notes，原 `taskKind` 在检查铁路词前，
将“安检”归为 flight；另一条 `inferTransportation` 却得出 train。
之后 `reminderNotificationCue` 和 `reminderActionGuidance` 按 task_kind 生成航空提示，
`buildCalendarEvent` 将它们放进实际 summary/description。

| 同一合成输入 | 基线 | 补丁 |
| --- | --- | --- |
| task_kind / transportation | flight / train | train / train |
| 投影提示 | 机场值机、安检和行李 | 前往车站、进站 |

这证明仅靠正常铁路“安检”文字就能走到错误模板，**不需要调用方先填错 flight 字段**。
但它不证明任何现有真实事件必然由这一输入路径产生：未取证其创建参数、保存的 context、
后续更新或生产代码版本。若调用方 notes 本身明确写有“机场值机”，现有航空专属词仍优先；
本补丁不会将这种混合/错误输入悄悄改成纯铁路意图。

最小改动：航空专属词仍优先，明确铁路词优先于共用的“安检”；补齐“列车”这一铁路词，
让类型和交通方式一致。单独“安检”的旧 fallback 未扩展修改。新推断会使用既有 train
准备/缓冲规则；已明确配置的提醒时刻与策略保留，不借分类修复重排显式提醒。
尚无生产部署或旧事件重建，不能宣称已有错误投影被修正。

## 日期差异：保留事实，不自动统一

Google 官方将 Tasks `due` 定义为任务安排/显示的日期，并明确它不是 deadline；
API 只保留日期部分。`updated` 只说明整个任务最后修改时间，不能识别修改字段、操作者或意图。
参见 [Tasks REST resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks)。
Personal OS 的 deadline 字段仍只代表明确硬截止，不从 provider 字段名或更新时间推断。

源码已有 `taskScheduleSyncDecision`：对无法解释的 Task 日期 / scheduled_date 差异返回
`TASK_SCHEDULE_RECONCILIATION_REQUIRED`；明确的 morning_plan 或已有 deadline 语义可保留
独立计划日期。调度对账入口能据此停止投影并记录待对账，但普通 `taskView` / GET / search
原先只返回两个日期及存储的 sync_required，并不调用这个派生判定。
因此旧 `sync_required:false` 与空 last_sync_error 不能证明读取时已经对齐。

补丁在读取时复用该判定，**仅当两种日期都存在、不同且缺少现有认可的分离依据**，附加：

```json
{
  "date_reconciliation": {
    "required": true,
    "reason": "TASK_SCHEDULE_RECONCILIATION_REQUIRED",
    "task_date": "2099-01-09",
    "scheduled_date": "2099-01-08",
    "automatic_repair_allowed": false
  }
}
```

这是“需核对原意”的只读信号，不是判定某个日期错误，也不是新的持久状态或权限机制。
Task 日期、planned/requested_date、deadline、原 sync_required、last_synced_at 都保持原样。
它不调用 scheduler，不写回、不建事件、不排自动修复。GET 与 search 同样携带该提示。
日期相同、缺一日期、已有可解释分离、独立 deadline 不因此被强制统一或推断为错误。

现有 PR9 另含 dueDate 更新别名和写后回读检查；本分支未重复引入那些写路径修复，
也未把日期差异追溯成某一次用户操作。若要决定具体真实事项的日期，需要另行核实原意与
可信变更记录；单凭 Google 更新时间较新或 conversation 无历史，不足以选择覆盖方向。

## 可重现证据与验证

```sh
node scripts/reproduce-rail-reminder.mjs
node --test test/rail-reminder-regression.test.js test/task-date-reconciliation.test.js
npm run verify
```

第一条命令只从固定 Git 基线读取纯函数源码，和当前源码运行同一组虚构输入，
输出 [前后对照 JSON](rail-reminder-reproduction.json)，无网络、凭据或 provider 写入。

先添加的 15 项新回归在旧源码上为 7 通过 / 8 失败；补丁后全通过。
另加一项实际 Google Tasks GET handler 的完全合成集成检查：返回只读提示，
不请求 Task/Calendar/metadata 写入或 scheduler，所有 Auth/provider 边界均是假数据、无真实网络。

最终本地结果：**16 项新回归全过；完整 npm run verify 529 项，527 通过，2 项既有跳过，0 失败**。
这是源代码/合成验证，不是远端 CI、生产修复、设备提醒或实际行程验收。
