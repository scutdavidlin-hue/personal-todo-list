# Personal OS PRD：Smart Reminder Policy Engine V1.0

状态：已进入实现与本地验收
日期：2026-09-05
时区：Asia/Shanghai

## 1. WHY

Personal OS 已形成 `自然语言 → GPT → Google Tasks → Schedule → Calendar Event → iPhone` 的基本链路，但“事情发生的时间”和“用户应该开始行动的时间”仍未分离。若系统只在事件开始时通知，涉及起床、饮食、准备、通勤、材料或设备的事项往往已经来不及。

V1 新增统一 Smart Reminder Policy 层，使系统从 Task Manager 继续演进为 Action Execution System。

## 2. GOAL

用户说出“什么时候做什么”后，Personal OS 除了记录唯一 Task，还应判断为了准时完成，用户需要何时开始准备或出发，并把最少必要提醒投影到同一个 Calendar Event。

## 3. 不变量

职责严格分离：

- Google Tasks：Task 正文、日期、状态、完成状态及用户真正需要完成的行动。
- Schedule：请求日期/时间、执行区间、时长、固定时间、时区、Deadline 与 Calendar 映射。
- Calendar Projection：时间轴占位、iPhone Calendar 可视化以及提醒投影。
- Reminder Policy：提醒优先级、语义推断、提前量、原因、类型、渠道与投影状态。

始终保持：

```text
1 Google Task
  → 1 task_schedule_metadata
    → 1 stable Google Calendar Event
      → 0..3 reminder overrides
```

Reminder 不是 Task，也不是额外 Calendar Event。已有对象必须 update-first；修改提醒不得改变 `task_id`、`schedule_id` 或 `calendar_event_id`。

## 4. GPT / Intake 统一行为

任一入口识别到明确时间点时，必须继续判断是否存在：

- 准备、起床、饮食、运动或换衣；
- 出门、通勤、候车、值机、安检或提前到场；
- 材料、文件、证件、行李或设备准备；
- Deadline 前的执行与最终确认。

优先级：

1. 用户指定确切提醒时间：严格采用，不能被推断覆盖。
2. 用户要求“早点提醒”：根据上下文推断。
3. 用户未说提醒，但固定时间事项明显存在前置行动：自动生成 Smart Reminder。
4. 普通 Todo：默认不增加提醒。

用户明确要求不提醒时，必须关闭该 Event 的 reminder overrides。

## 5. 提醒模型

基础模型：

```text
Preparation Reminder Offset
= Preparation Time + Travel Time + Safety Buffer

Departure Reminder Offset
= Travel Time + Safety Buffer
```

V1 支持：

- `preparation`：推动开始准备。
- `departure`：推动开始移动。
- `event`：在事项或 Deadline 临近时提醒。

策略按语义而不是统一固定提前量生成：

- 普通 Todo：0 个。
- 简单固定时间事项：通常 1 个。
- 涉及通勤：通常 1–2 个。
- 航班/重大出行：通常 2 个，最多 3 个。
- 精确 Deadline：提前执行提醒 + 临近确认提醒。

## 6. Context-aware 文案

Schedule 仅保存结构化上下文和提醒理由，不复制 Google Task title。Calendar 投影时读取最新 Google Task title，再组合：

```text
2026-09-05 15:00 祥晖到公司聊天。
起床、吃早餐、运动后，记得自己坐地铁过去，预留通勤时间。
```

Google Calendar 的多个 reminder override 共享同一个 Event title/description。为了让锁屏提示不只重复 Task title，Calendar summary 同时附加压缩后的下一步行动提示，完整理由保留在 description；V1 不声称每个 override 能拥有彼此不同的文案。

## 7. Deadline 分离

`deadline` 与 `deadline_time` 是硬截止；`requested_date / requested_time` 与 `scheduled_start / scheduled_end` 是执行时间。二者不得互相伪装。

若只有精确 Deadline、尚无执行时段，唯一 Calendar Event 可暂时以 Deadline 作为投影锚点；后续排定执行时间时仍 PATCH 同一个稳定 Event，而不是新建第二个 Event。

V1 的 Calendar reminder override 只能相对唯一 Event 的开始时间提前触发。因此，当同一 Task 同时存在更早的执行区间和更晚的 Deadline 时，V1 优先保持真实执行区间投影，不能用 Calendar override 表达“Event 开始后、Deadline 之前”的提醒。系统不得为绕过该限制创建第二个虚假 Event；Deadline-only 的精确截止提醒不受此限制。

## 8. 数据字段

在既有 `task_schedule_metadata` 上扩展：

- `deadline_time`
- `reminder_policy`: `none | smart | custom`
- `reminder_policy_source`: `user_explicit | ai_inferred | system_default`
- `reminder_reason`
- `reminder_at`
- `reminder_offset_minutes`
- `reminder_type`: `preparation | departure | event`
- `reminders`: 最多 3 个结构化 override
- `reminder_context`
- `notification_channel`
- `notification_status`

`notification_status` 只表示 Calendar 投影状态，不声称 iPhone 已实际显示通知。

## 9. Calendar 与 iPhone 边界

Calendar Event 使用 `reminders.useDefault=false` 和逐 Event overrides：

- 有策略时投影 `popup`（或明确选择的 email）提醒。
- 无策略时投影空 overrides，避免 Calendar 全局默认提醒制造噪音。
- 点击通知进入对应 Calendar Event；Event 的私有扩展属性保留 `googleTaskId`。

iOS 的排序、置顶、持续显示和 Time Sensitive 最终由 Apple、Google Calendar App 权限与用户设置决定，不作为后端可绝对保证的条件。

## 10. 验收标准

1. `15:00开会，12:00提醒` → 12:00，来源为 `user_explicit`。
2. `15:00去机场` → 自动识别准备与交通。
3. `今天整理桌面` → 0 个额外 Reminder。
4. 已有 Task 增加 Reminder → `task_id` 不变。
5. 已有 Calendar Projection 增加 Reminder → `calendar_event_id` 不变。
6. 增加 Reminder → Google Tasks 数量变化为 0。
7. Calendar payload 使用移动端支持的 popup override；真实 iPhone 到达必须在部署、权限与设备条件满足后进行真机确认。

## 11. 当前案例

输入：

```text
今天下午3点祥晖到公司聊天。
起床吃早餐，然后运动一下，再自己坐地铁去公司。
不让我老婆送。
```

期望：

- Google Task：`祥晖到公司聊天`，2026-09-05，15:00，fixed time。
- Calendar Event：15:00–16:00，稳定 Event ID。
- Preparation：12:15（165 分钟提前）。
- Departure：13:30（90 分钟提前）。
- 原因：起床、早餐、运动、地铁通勤及 30 分钟缓冲。
- Task、Schedule 与 Event 均只有一个。
