export const RESOLUTION_DECISIONS = Object.freeze([
  "NEW",
  "DUPLICATE",
  "UPDATE",
  "MERGE",
  "RELATED",
  "DEPENDENCY",
  "PARENT_CHILD",
  "GOAL_LINK",
  "CONFLICT",
]);

export const TASK_RELATIONSHIP_TYPES = Object.freeze([
  "DUPLICATE_OF",
  "MERGED_INTO",
  "RELATED_TO",
  "DEPENDS_ON",
  "PARENT_OF",
  "POTENTIAL_RELATION",
  "CONFLICTS_WITH",
  "SHARES_RESOURCE",
]);

export const RESOLUTION_THRESHOLDS = Object.freeze({
  automatic: 0.9,
  safe_link: 0.7,
  potential: 0.45,
});

export const INCOMING_TASK_REF = "__incoming_task__";

const CLOSED_STATUSES = new Set(["completed", "done", "cancelled", "deleted", "archived"]);
const STOP_ENTITIES = new Set(["这个", "那个", "时候", "成本", "数据", "任务", "系统", "之后", "出来", "完成"]);
const ADDITIVE_CUE = /(?:也|还要|还得|另外|并且|以及|一起|一并|顺便|再加|加上|补充|纳入|包括|同时)/i;
const EXPLICIT_MERGE_CUE = /(?:合并|并入|归并|放进同一|同一份|作为同一|统一形成|一起形成)/i;
const EXPLICIT_UPDATE_CUE = /(?:改成|改为|改到|提前到|推迟到|调整为|更新为|补充为|扩展到)/i;
const DEPENDENCY_CUE = /(?:等.+?(?:后|以后|之后)|(?:拿到|收到|出来|提供|发来|给我|交付|准备好|完成|确认)(?:之)?后|依赖于?|前置|先.+?再|完成.+?才能)/i;
const PARENT_CHILD_CUE = /(?:包括|包含|分成|拆成|拆为|下面几项|以下(?:工作|事项|内容))/i;
const SCHEDULED_MEETING_CUE = /(?:过来|来(?:公司|办公室|家里|这边)?|到(?:公司|办公室|家里|这边|达)?|抵达|见面|会面|开会|会议|聊天|面谈|碰面|拜访|约见)/i;
const GENERIC_MEETING_PARTICIPANTS = new Set([
  "客户", "朋友", "同事", "供应商", "领导", "老板", "大家", "对方", "客人", "团队", "家人", "老婆", "老公", "我们",
]);

const ACTION_RULES = Object.freeze([
  ["refactor", /(?:重构|迁移|改造|重写|升级架构)/i],
  ["obtain", /(?:获取|拿到|收集|索取|要到|等.+?(?:发|给|提供)|(?:发|给|提供).+?(?:数据|资料|成本|结果))/i],
  ["report", /(?:形成|输出|撰写|编写|提交|交付).{0,8}(?:报告|汇报|方案|结论)|(?:经营|财务|分析)报告/i],
  ["analyze", /(?:分析|评估|诊断|对比|研究|复盘)/i],
  ["calculate", /(?:计算|测算|核算|估算|算一下|算出)/i],
  ["organize", /(?:整理|汇总|梳理|归集|清洗)/i],
  ["verify", /(?:核对|核一下|核实|核查|确认|对一下)/i],
  ["update", /(?:修改|更新|补充|增加|加入|调整)/i],
  ["build", /(?:开发|实现|搭建|建设|创建|新增|制作|做一个|做出)/i],
  ["communicate", /(?:联系|沟通|询问|跟进|问一下|同步)/i],
]);

const TOPIC_RULES = Object.freeze([
  ["personal_os", /(?:personal\s*os|个人操作系统|个人\s*os|task\s*(?:semantic|resolution|去重|解析)|任务(?:语义|关系|解析|治理)|goals?\s*&?\s*plans?)/i],
  ["task_resolution", /(?:task\s*(?:semantic|resolution|dedup)|任务(?:语义去重|关系解析|解析层|治理层)|resolve\s*before\s*create)/i],
  ["task_schema", /(?:task\s*schema|任务(?:数据)?模型|任务结构|任务字段|task\s*表|task\s*api)/i],
  ["task_ui", /(?:task\s*ui|任务(?:界面|页面|前端|列表)|待办(?:界面|页面|前端))/i],
  ["calendar", /(?:calendar|日历|排程|时间投影)/i],
  ["goal", /(?:goal|目标|长期计划|产品化|商业化)/i],
  ["finance", /(?:财务|经营|收入|营收|回款|成本|利润|毛利|人效|客户集中度|损益|p\s*&?\s*l)/i],
  ["cost", /(?:成本|费用|支出)/i],
  ["revenue", /(?:收入|营收|销售额)/i],
  ["collection", /(?:回款|收款|应收)/i],
  ["profit", /(?:利润|毛利|损益|p\s*&?\s*l)/i],
  ["team_efficiency", /(?:人效|团队效率|人员效率|产能)/i],
  ["customer_concentration", /(?:客户集中度|客户集中|客户结构)/i],
  ["client", /(?:客户|公司|企业|联系人)/i],
  ["report", /(?:报告|汇报|结论|方案)/i],
]);

const RESOURCE_RULES = Object.freeze([
  ["financial_records", /(?:财务|经营数据|收入|营收|回款|成本|利润|毛利|人效|客户集中度|损益|p\s*&?\s*l)/i],
  ["task_schema", /(?:task\s*schema|任务(?:数据)?模型|任务结构|任务字段|task\s*表|task\s*api)/i],
  ["task_ui", /(?:task\s*ui|任务(?:界面|页面|前端|列表)|待办(?:界面|页面|前端))/i],
  ["goals_plans", /(?:goals?\s*&?\s*plans?|长期目标|长期计划|目标库)/i],
  ["google_tasks", /(?:google\s*tasks?|谷歌任务|gotask)/i],
  ["calendar_projection", /(?:calendar|日历|排程|时间投影)/i],
  ["clients_contacts", /(?:客户|联系人|企业|公司资料)/i],
]);

const WRITE_CUE = /(?:写入|录入|导入|修改|更新|重构|迁移|删除|覆盖|替换|创建|新增|开发|实现|搭建|建设)/i;
const READ_CUE = /(?:读取|查看|查询|分析|计算|测算|核算|整理|汇总|对比|报告|使用|依赖)/i;

const CHINESE_MONTHS = Object.freeze({
  "一": 1,
  "二": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
  "十": 10,
  "十一": 11,
  "十二": 12,
});

function cleanString(value, maxLength = 20_000) {
  return typeof value === "string" ? value.normalize("NFKC").trim().slice(0, maxLength) : "";
}

function cleanArray(value, maxItems = 100) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanString(String(item), 200)).filter(Boolean))].slice(0, maxItems);
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))]
    .sort((left, right) => String(left).localeCompare(String(right), "zh-CN", { numeric: true }));
}

function setOverlap(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (!a.size || !b.size) return 0;
  let count = 0;
  for (const value of a) if (b.has(value)) count += 1;
  return count;
}

function jaccard(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (!a.size || !b.size) return 0;
  return setOverlap(a, b) / new Set([...a, ...b]).size;
}

function overlapCoefficient(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (!a.size || !b.size) return 0;
  return setOverlap(a, b) / Math.min(a.size, b.size);
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Number(clamp(value).toFixed(4));
}

function canonicalizeMonthWords(value) {
  return cleanString(value)
    .replace(/(十二|十一|十|[一二三四五六七八九])月份?/g, (match, month) => `${CHINESE_MONTHS[month]}月`)
    .replace(/(1[0-2]|0?[1-9])月份/g, (_, month) => `${Number(month)}月`);
}

export function extractMonths(value) {
  const text = canonicalizeMonthWords(value);
  const months = [];
  for (const match of text.matchAll(/(1[0-2]|0?[1-9])\s*月/g)) months.push(Number(match[1]));
  for (const match of text.matchAll(/((?:1[0-2]|[1-9])(?:\s*[、,，和及与到至\-~]\s*(?:1[0-2]|[1-9]))+)\s*月/g)) {
    for (const number of match[1].match(/1[0-2]|[1-9]/g) || []) months.push(Number(number));
  }
  return sortedUnique(months).map(Number);
}

export function normalizeResolutionText(value) {
  return canonicalizeMonthWords(value)
    .toLowerCase()
    .replace(/【[^】]{1,20}】/g, "")
    .replace(/(?:提醒我|记得|麻烦|请帮我|请|对了|到时候|回头|届时|别忘了)/g, "")
    .replace(/核(?:一?下|一核)/g, "核对")
    .replace(/对(?:一?下)/g, "核对")
    .replace(/算(?:一?下)/g, "计算")
    .replace(/测算|核算|估算/g, "计算")
    .replace(/梳理|汇总|归集/g, "整理")
    .replace(/营收/g, "收入")
    .replace(/(?:之后|以后)/g, "后")
    .replace(/(?:一下|一并|顺便|这个|那个|该项|这件事|这项工作)/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .trim();
}

function characterBigrams(value) {
  const text = normalizeResolutionText(value);
  if (!text) return [];
  if (text.length < 2) return [text];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
}

function dice(left, right) {
  const a = new Set(characterBigrams(left));
  const b = new Set(characterBigrams(right));
  if (!a.size || !b.size) return 0;
  return (2 * setOverlap(a, b)) / (a.size + b.size);
}

function actionFor(text) {
  for (const [name, pattern] of ACTION_RULES) if (pattern.test(text)) return name;
  return "act";
}

function topicsFor(text) {
  return TOPIC_RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function resourcesFor(text, input = {}) {
  const explicit = cleanArray(input.shared_resources || input.resources || input.resource_keys);
  const inferred = RESOURCE_RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const all = sortedUnique([...explicit, ...inferred]);
  const reads = sortedUnique([
    ...cleanArray(input.read_resources || input.reads),
    ...(READ_CUE.test(text) || (!WRITE_CUE.test(text) && inferred.length) ? inferred : []),
  ]);
  const writes = sortedUnique([
    ...cleanArray(input.write_resources || input.writes),
    ...(WRITE_CUE.test(text) ? inferred : []),
  ]);
  return { all: sortedUnique([...all, ...reads, ...writes]), reads, writes };
}

function entitiesFor(text, input = {}) {
  const values = [
    ...cleanArray(input.entities),
    ...cleanArray(input.people),
    ...cleanArray(input.companies),
    ...cleanArray(input.projects),
  ];
  const latin = text.match(/\b(?:[A-Z]{2,}(?:\s*&\s*[A-Z]{2,})?|Personal\s*OS|[A-Za-z][A-Za-z0-9_-]{2,})\b/g) || [];
  values.push(...latin.map((value) => value.toLowerCase().replace(/\s+/g, "")));
  const personPatterns = [
    /(?:跟|和|等|让|请)([\p{Script=Han}]{2,4}?)(?=发|给|提供|拿|要|对|核|确认|沟通|了解)/gu,
    /([\p{Script=Han}]{2,4}?)(?=把|发给|提供给|给我|发我)/gu,
  ];
  for (const pattern of personPatterns) {
    for (const match of text.matchAll(pattern)) if (!STOP_ENTITIES.has(match[1])) values.push(match[1]);
  }
  if (/自营团队/.test(text)) values.push("自营团队");
  if (/非自营/.test(text)) values.push("非自营");
  return sortedUnique(values.map((value) => normalizeResolutionText(value)).filter(Boolean));
}

function fieldsFor(input = {}) {
  return sortedUnique(cleanArray(input.fields || input.resource_fields || input.write_fields));
}

function semanticCorpus(input = {}) {
  return [input.title, input.raw_text, input.input, input.notes, input.originalIntent, input.original_intent]
    .map((value) => cleanString(value))
    .filter(Boolean)
    .join(" ");
}

function taskId(task) {
  return cleanString(task?.task_id || task?.google_task_id || task?.id || task?.externalId, 1024) || null;
}

function dueDate(task) {
  return cleanString(
    task?.schedule?.scheduled_date
      || task?.schedule?.scheduledDate
      || task?.requested_date
      || task?.requestedDate
      || task?.due
      || task?.dueDate
      || task?.date,
    10,
  ) || null;
}

function chineseNumber(value) {
  const digits = { "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  if (/^\d{1,2}$/.test(value)) return Number(value);
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, units] = value.split("十");
    return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0);
  }
  return digits[value] ?? null;
}

function scheduledTime(input = {}) {
  const explicit = [
    input.requested_time,
    input.requestedTime,
    input.scheduled_start,
    input.scheduledStart,
    input.time,
    input.schedule?.scheduled_start,
    input.schedule?.scheduledStart,
  ].map((value) => cleanString(value, 8)).find((value) => /^(?:[01]\d|2[0-3]):[0-5]\d/.test(value));
  if (explicit) return explicit.slice(0, 5);

  const text = [input.title, input.raw_text, input.input, input.originalIntent, input.original_intent]
    .map((value) => cleanString(value, 2_000))
    .filter(Boolean)
    .join(" ");
  const numeric = text.match(/(?:^|\D)((?:[01]?\d|2[0-3]))[:：]([0-5]\d)(?!\d)/);
  if (numeric) return `${String(Number(numeric[1])).padStart(2, "0")}:${numeric[2]}`;
  const chinese = text.match(/(上午|早上|中午|下午|晚上|凌晨)?\s*([\d一二两三四五六七八九十]{1,3})点(?:(半)|([\d一二两三四五六七八九十]{1,3})分?)?/);
  if (!chinese) return null;
  let hour = chineseNumber(chinese[2]);
  const minute = chinese[3] ? 30 : (chinese[4] ? chineseNumber(chinese[4]) : 0);
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  if (["下午", "晚上"].includes(chinese[1]) && hour < 12) hour += 12;
  if (chinese[1] === "中午" && hour < 11) hour += 12;
  if (chinese[1] === "凌晨" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function meetingParticipants(input = {}) {
  const explicit = cleanArray(input.people).map((value) => normalizeResolutionText(value));
  const texts = [input.title, input.raw_text, input.input, input.originalIntent, input.original_intent]
    .map((value) => cleanString(value, 2_000))
    .filter(Boolean);
  const inferred = [];
  for (const value of texts) {
    const text = value
      .replace(/\d{4}-\d{2}-\d{2}/g, "")
      .replace(/(?:^|\D)(?:[01]?\d|2[0-3])[:：][0-5]\d(?!\d)/g, " ")
      .replace(/(?:上午|早上|中午|下午|晚上|凌晨)?\s*[\d一二两三四五六七八九十]{1,3}点(?:(?:半)|(?:[\d一二两三四五六七八九十]{1,3})分?)?/g, "")
      .replace(/(?:今天|今日|明天|后天|本周|这周|下周末|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天])/g, "")
      .replace(/[\s\p{P}\p{S}]/gu, "");
    const pattern = /(?:^|[跟和与请让约])([\p{Script=Han}]{2,4}?)(?=(?:会)?(?:过来|来(?:公司|办公室|家里|这边)?|到(?:公司|办公室|家里|这边|达)?|抵达|见面|会面|开会|聊天|面谈|碰面|拜访|约见))/gu;
    for (const match of text.matchAll(pattern)) inferred.push(match[1]);
  }
  return sortedUnique([...explicit, ...inferred]
    .map((value) => normalizeResolutionText(value))
    .filter((value) => value && !GENERIC_MEETING_PARTICIPANTS.has(value)));
}

function isSameScheduledNamedMeeting(incoming, candidate) {
  const incomingDate = dueDate(incoming);
  const candidateDate = dueDate(candidate);
  const incomingTime = scheduledTime(incoming);
  const candidateTime = scheduledTime(candidate);
  if (!incomingDate || incomingDate !== candidateDate || !incomingTime || incomingTime !== candidateTime) return false;
  const incomingText = [incoming?.title, incoming?.raw_text, incoming?.input].filter(Boolean).join(" ");
  const candidateText = [candidate?.title, candidate?.raw_text, candidate?.originalIntent, candidate?.original_intent].filter(Boolean).join(" ");
  if (!SCHEDULED_MEETING_CUE.test(incomingText) || !SCHEDULED_MEETING_CUE.test(candidateText)) return false;
  const incomingParticipants = meetingParticipants(incoming);
  const candidateParticipants = meetingParticipants(candidate);
  return incomingParticipants.length > 0
    && incomingParticipants.length === candidateParticipants.length
    && incomingParticipants.every((value, index) => value === candidateParticipants[index]);
}

function materialIncomingNotes(incoming = {}) {
  const notes = cleanString(incoming.notes, 8_000);
  if (!notes) return "";
  const originals = new Set([incoming.raw_text, incoming.input, incoming.originalIntent, incoming.original_intent]
    .map((value) => normalizeResolutionText(value))
    .filter(Boolean));
  if (!originals.size) return notes;
  const notesWithoutLabel = notes.replace(/^原始(?:请求|意图|措辞)\s*[:：]\s*/, "");
  if (originals.has(normalizeResolutionText(notes))
    || originals.has(normalizeResolutionText(notesWithoutLabel))) return "";
  return notes.split(/\n+/).map((line) => line.trim()).filter((line) => {
    if (!line) return false;
    const withoutLabel = line.replace(/^原始(?:请求|意图|措辞)\s*[:：]\s*/, "");
    return !originals.has(normalizeResolutionText(line))
      && !originals.has(normalizeResolutionText(withoutLabel));
  }).join("\n");
}

function semanticStatus(task) {
  return cleanString(task?.status, 40).toLowerCase() || (task?.done ? "completed" : "open");
}

function contextId(input, snake, camel) {
  return cleanString(input?.[snake] || input?.[camel], 1024) || null;
}

export function extractIntentProfile(input = {}) {
  const text = semanticCorpus(input);
  const resources = resourcesFor(text, input);
  const topics = topicsFor(text);
  const normalizedText = normalizeResolutionText(text);
  const goalPlanId = contextId(input, "goal_plan_id", "goalPlanId") || contextId(input, "goal_id", "goalId");
  const projectId = contextId(input, "project_id", "projectId");
  return {
    text,
    normalized_text: normalizedText,
    semantic_key: [actionFor(text), ...topics, ...entitiesFor(text, input), ...extractMonths(text)].join(":"),
    action: actionFor(text),
    topics,
    entities: entitiesFor(text, input),
    months: extractMonths(text),
    due: dueDate(input),
    goal_plan_id: goalPlanId,
    project_id: projectId,
    resources: resources.all,
    read_resources: resources.reads,
    write_resources: resources.writes,
    resource_fields: fieldsFor(input),
    additive: ADDITIVE_CUE.test(text),
    explicit_merge: EXPLICIT_MERGE_CUE.test(text),
    explicit_update: EXPLICIT_UPDATE_CUE.test(text),
    dependency_cue: DEPENDENCY_CUE.test(text),
    parent_child_cue: PARENT_CHILD_CUE.test(text),
  };
}

function actionSimilarity(left, right) {
  if (left === right) return 1;
  const analytical = new Set(["analyze", "calculate", "organize", "verify", "report"]);
  const mutating = new Set(["build", "update", "refactor"]);
  if (analytical.has(left) && analytical.has(right)) return 0.62;
  if (mutating.has(left) && mutating.has(right)) return 0.68;
  if ((left === "obtain" && analytical.has(right)) || (right === "obtain" && analytical.has(left))) return 0.18;
  if (left === "act" || right === "act") return 0.25;
  return 0.1;
}

function scopeSimilarity(left, right) {
  if (left.due && right.due) return left.due === right.due ? 1 : 0;
  if (left.months.length && right.months.length) return overlapCoefficient(left.months, right.months);
  if (!left.due && !right.due && !left.months.length && !right.months.length) return 0.45;
  return 0.15;
}

function contextSimilarity(left, right) {
  if (left.goal_plan_id && right.goal_plan_id && left.goal_plan_id === right.goal_plan_id) return 1;
  if (left.project_id && right.project_id && left.project_id === right.project_id) return 1;
  return 0;
}

export function taskCandidateScore(incoming, candidate) {
  const left = incoming?.normalized_text ? incoming : extractIntentProfile(incoming);
  const right = candidate?.normalized_text && candidate?.topics ? candidate : extractIntentProfile(candidate);
  const breakdown = {
    text: dice(left.normalized_text, right.normalized_text),
    action: actionSimilarity(left.action, right.action),
    topics: jaccard(left.topics, right.topics),
    entities: overlapCoefficient(left.entities, right.entities),
    scope: scopeSimilarity(left, right),
    context: contextSimilarity(left, right),
    resources: overlapCoefficient(left.resources, right.resources),
  };
  let score = breakdown.text * 0.32
    + breakdown.action * 0.18
    + breakdown.topics * 0.22
    + breakdown.entities * 0.12
    + breakdown.scope * 0.06
    + breakdown.context * 0.06
    + breakdown.resources * 0.04;
  if (left.normalized_text && left.normalized_text === right.normalized_text) score = 1;
  if (left.action === right.action && overlapCoefficient(left.topics, right.topics) >= 0.75) score += 0.05;
  if (left.goal_plan_id && right.goal_plan_id && left.goal_plan_id !== right.goal_plan_id) score -= 0.18;
  return { score: round(score), breakdown, profile: right };
}

export function rankTaskCandidates(incoming, candidates = [], { limit = 20 } = {}) {
  const profile = incoming?.normalized_text ? incoming : extractIntentProfile(incoming);
  return candidates
    .filter((candidate) => taskId(candidate))
    .map((candidate) => {
      const scored = taskCandidateScore(profile, candidate);
      return {
        task: candidate,
        task_id: taskId(candidate),
        status: semanticStatus(candidate),
        updated_at: candidate.updated_at || candidate.updatedAt || "",
        ...scored,
      };
    })
    .sort((left, right) => right.score - left.score
      || String(right.updated_at).localeCompare(String(left.updated_at)))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
}

function monthScopeTitle(existingTitle, months) {
  const title = canonicalizeMonthWords(existingTitle);
  if (!months.length) return title;
  const scope = `${months.join("、")}月`;
  const actionMatch = title.match(/^(分析|计算|整理|核对|完成|制作|输出|形成|对比|评估)/);
  const action = actionMatch?.[0] || "";
  let remainder = action ? title.slice(action.length) : title;
  remainder = remainder
    .replace(/(?:1[0-2]|0?[1-9])\s*月?(?:\s*[、,，和及与到至\-~]\s*(?:1[0-2]|0?[1-9])\s*月?)*\s*月份?/g, "")
    .replace(/^[、,，和及与\s]+|[、,，和及与\s]+$/g, "");
  return `${action}${scope}${remainder}`.trim();
}

function conciseAddition(incomingTitle) {
  return canonicalizeMonthWords(incomingTitle)
    .replace(/^(?:对了|到时候|另外|并且|还要|也要|再|顺便|同时)+/g, "")
    .replace(/(?:也|还要|一起|一并|顺便|同时|纳入|加上)/g, "")
    .replace(/^(?:把)?/, "")
    .replace(/[。；;]+$/g, "")
    .trim();
}

export function mergeTaskTitle(existingTask, incoming) {
  const existingTitle = cleanString(existingTask?.title, 200);
  const incomingTitle = cleanString(incoming?.title || incoming?.raw_text || incoming?.input, 200);
  if (!existingTitle) return incomingTitle;
  const existingProfile = extractIntentProfile(existingTask);
  const incomingProfile = extractIntentProfile(incoming);
  const months = sortedUnique([...existingProfile.months, ...incomingProfile.months]).map(Number);
  let merged = months.length > existingProfile.months.length ? monthScopeTitle(existingTitle, months) : canonicalizeMonthWords(existingTitle);
  const newTopics = incomingProfile.topics.filter((topic) => !existingProfile.topics.includes(topic) && topic !== "finance");
  if (newTopics.length) {
    const addition = conciseAddition(incomingTitle);
    if (addition && !normalizeResolutionText(merged).includes(normalizeResolutionText(addition))) {
      merged = `${merged}；${addition}`;
    }
  }
  return merged.slice(0, 200);
}

function mergeNotes(existingTask, incoming) {
  const previous = cleanString(existingTask?.notes, 8_000);
  const addition = cleanString(incoming?.notes || incoming?.raw_text || incoming?.input, 8_000);
  if (!addition || normalizeResolutionText(previous).includes(normalizeResolutionText(addition))) return previous;
  if (!previous) return addition;
  return `${previous}\n\n补充意图：${addition}`.slice(0, 8_000);
}

function relation(type, fromTaskId, toTaskId, confidence, reason, metadata = {}) {
  return {
    relationship_type: type,
    from_task_id: fromTaskId,
    to_task_id: toTaskId,
    confidence: round(confidence),
    reason,
    metadata,
  };
}

function candidateSummary(ranked) {
  return ranked.slice(0, 10).map((item) => ({
    task_id: item.task_id,
    title: item.task.title || "",
    status: item.status,
    score: item.score,
    breakdown: item.breakdown,
  }));
}

function inferredDependencyCandidate(profile, ranked) {
  const matches = [];
  for (const item of ranked) {
    const candidateProfile = item.profile;
    const sharedTopics = overlapCoefficient(profile.topics, candidateProfile.topics);
    const sharedEntities = overlapCoefficient(profile.entities, candidateProfile.entities);
    const sharedResources = overlapCoefficient(profile.resources, candidateProfile.resources);
    let score = sharedTopics * 0.45 + sharedEntities * 0.25 + sharedResources * 0.3;
    if (candidateProfile.action === "obtain" && ["analyze", "calculate", "organize", "report"].includes(profile.action)) score += 0.28;
    const existingProducesForIncoming = setOverlap(candidateProfile.write_resources, profile.read_resources) > 0;
    const incomingProducesForExisting = setOverlap(profile.write_resources, candidateProfile.read_resources) > 0;
    let direction = "incoming_depends_on_existing";
    let producerEvidence = false;
    if (existingProducesForIncoming) {
      score += 0.3;
      producerEvidence = true;
    }
    if (incomingProducesForExisting) {
      score += 0.22;
      direction = "existing_depends_on_incoming";
      producerEvidence = true;
    }
    if (candidateProfile.resources.includes("task_schema") && profile.topics.includes("task_ui")) {
      score = Math.max(score, 0.91);
      direction = "incoming_depends_on_existing";
      producerEvidence = true;
    }
    score = clamp(score);
    const semanticProducer = candidateProfile.action === "obtain"
      && ["analyze", "calculate", "organize", "report"].includes(profile.action)
      && sharedTopics >= 0.5;
    const stronglyBound = sharedEntities > 0 && (sharedTopics > 0 || sharedResources > 0);
    matches.push({ item, score, direction, producerEvidence, semanticProducer, stronglyBound });
  }
  matches.sort((left, right) => right.score - left.score);
  const best = matches[0] || null;
  const second = matches[1] || null;
  const eligible = best && (
    (best.producerEvidence && best.score >= 0.55)
    || (profile.dependency_cue && best.semanticProducer && best.score >= 0.7)
    || (profile.dependency_cue && best.stronglyBound && best.score >= 0.65)
  );
  if (!eligible) return null;
  // A high score is not enough to choose between two near-identical producers.
  // Only an explicit prerequisite id may break that tie safely.
  if (second && best.score - second.score < 0.1) return null;
  return best;
}

function attachExplicitDependencies(result, profile, candidates, explicitIds) {
  if (!explicitIds.length) return result;
  const reason = explicitIds.length === 1
    ? "The incoming intent explicitly names its prerequisite Task."
    : "The incoming intent explicitly names all prerequisite Tasks.";
  const relationships = [...(result.relationships || [])];
  const sharedResources = new Set(result.shared_resources || []);
  for (const id of explicitIds) {
    relationships.push(relation("DEPENDS_ON", INCOMING_TASK_REF, id, 1, reason, { explicit: true }));
    const match = candidates.find((item) => item.task_id === id);
    if (!match) continue;
    for (const resource of profile.resources.filter((value) => match.profile.resources.includes(value))) {
      sharedResources.add(resource);
    }
    relationships.push(...sharedResourceRelations(profile, match, 1));
  }
  const seen = new Set();
  return {
    ...result,
    relationships: relationships.filter((item) => {
      const key = `${item.relationship_type}:${item.from_task_id}:${item.to_task_id}:${item.metadata?.resource || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    shared_resources: sortedUnique([...sharedResources]),
  };
}

function conflictCandidate(profile, ranked) {
  let best = null;
  for (const item of ranked) {
    if (CLOSED_STATUSES.has(item.status)) continue;
    const candidateProfile = item.profile;
    const sharedWrites = candidateProfile.write_resources.filter((resource) => profile.write_resources.includes(resource));
    if (!sharedWrites.length) continue;
    const fieldsOverlap = !profile.resource_fields.length || !candidateProfile.resource_fields.length
      || setOverlap(profile.resource_fields, candidateProfile.resource_fields) > 0;
    if (!fieldsOverlap) continue;
    const score = profile.resource_fields.length && candidateProfile.resource_fields.length ? 0.97 : 0.91;
    if (!best || score > best.score) best = { item, score, sharedWrites };
  }
  return best;
}

function goalDomainProfile(goal) {
  return extractIntentProfile({
    title: goal?.title,
    notes: [goal?.description, goal?.summary, goal?.why, goal?.notes].filter(Boolean).join(" "),
    goal_plan_id: goal?.id,
  });
}

export function findGoalAssociation(incoming, goals = [], { ambiguity_margin = 0.08 } = {}) {
  const profile = incoming?.normalized_text ? incoming : extractIntentProfile(incoming);
  const ranked = goals
    .filter((goal) => goal?.id && !CLOSED_STATUSES.has(cleanString(goal.status, 40).toLowerCase()))
    .map((goal) => {
      const goalProfile = goalDomainProfile(goal);
      const topics = overlapCoefficient(profile.topics, goalProfile.topics);
      const resources = overlapCoefficient(profile.resources, goalProfile.resources);
      const text = dice(profile.normalized_text, goalProfile.normalized_text);
      const explicit = profile.goal_plan_id === String(goal.id);
      let score = explicit ? 1 : text * 0.38 + topics * 0.47 + resources * 0.15;
      if (profile.topics.includes("task_resolution") && goalProfile.topics.includes("personal_os")) score = Math.max(score, 0.88);
      return { goal, score: round(score), profile: goalProfile, explicit };
    })
    .filter((item) => item.score >= 0.7)
    .sort((left, right) => right.score - left.score || String(right.goal.updated_at || "").localeCompare(String(left.goal.updated_at || "")));
  if (!ranked.length) return null;
  if (ranked[0].explicit) return ranked[0];
  if (ranked[1] && ranked[0].score - ranked[1].score < ambiguity_margin) return null;
  return ranked[0];
}

function splitParentChildren(incoming) {
  const text = cleanString(incoming?.title || incoming?.raw_text || incoming?.input, 1_000);
  const marker = text.match(/(?:包括|包含|分成|拆成|拆为|以下(?:工作|事项|内容)?)[：:，,]?/);
  if (!marker) return null;
  const markerIndex = marker.index ?? -1;
  if (markerIndex < 0) return null;
  const parentText = text.slice(0, markerIndex).replace(/[，,:：\s]+$/g, "").trim();
  const remainder = text.slice(markerIndex + marker[0].length).replace(/[。；;]+$/g, "").trim();
  const parts = remainder.split(/[、,，；;]|以及|和|及|与/).map((part) => part.trim()).filter((part) => part.length >= 2);
  if (!parentText || parts.length < 2 || parts.length > 12) return null;
  const childTitle = (part) => {
    if (ACTION_RULES.some(([, pattern]) => pattern.test(part))) return part;
    if (/(?:人效|效率|利润|毛利)/.test(part)) return `计算${part}`;
    if (/(?:报告|汇报|方案)/.test(part)) return `输出${part}`;
    return `分析${part}`;
  };
  return {
    parent: {
      title: parentText,
      notes: cleanString(incoming?.notes),
      original_intent: cleanString(incoming?.raw_text || incoming?.input || text),
    },
    children: parts.map((part, index) => ({
      temp_id: `__child_${index + 1}__`,
      title: childTitle(part),
      notes: `父任务：${parentText}`,
      original_intent: cleanString(incoming?.raw_text || incoming?.input || text),
    })),
  };
}

function duplicateConfidence(profile, top) {
  if (!top) return 0;
  const exact = profile.normalized_text && profile.normalized_text === top.profile.normalized_text;
  const sameAction = profile.action === top.profile.action;
  const topicOverlap = overlapCoefficient(profile.topics, top.profile.topics);
  const entityCompatible = !profile.entities.length || !top.profile.entities.length || setOverlap(profile.entities, top.profile.entities) > 0;
  const dateCompatible = !profile.due || !top.profile.due || profile.due === top.profile.due;
  if (exact && dateCompatible) return 1;
  if (sameAction && topicOverlap >= 0.75 && entityCompatible && dateCompatible && top.score >= 0.78) {
    return Math.max(0.9, top.score);
  }
  if (top.score >= 0.92 && dateCompatible) return top.score;
  return 0;
}

function additiveUpdateCandidate(profile, ranked) {
  if (!profile.additive && !profile.explicit_update) return null;
  const compatible = ranked.filter((item) => {
    if (CLOSED_STATUSES.has(item.status)) return false;
    const sameAction = item.profile.action === profile.action || profile.action === "update" || profile.action === "act";
    const sharedContext = contextSimilarity(profile, item.profile) > 0;
    const sharedTopic = setOverlap(profile.topics, item.profile.topics) > 0;
    const sharedEntity = setOverlap(profile.entities, item.profile.entities) > 0;
    const sharedResource = setOverlap(profile.resources, item.profile.resources) > 0;
    const incomingNamesDomain = profile.topics.length > 0 || profile.entities.length > 0 || profile.resources.length > 0;
    const monthExtension = profile.months.length > 0 && item.profile.months.length > 0
      && (!incomingNamesDomain || sharedContext || sharedTopic || sharedEntity || sharedResource);
    const explicitUpdate = profile.explicit_update && item.score >= 0.38;
    const strongSemanticMatch = item.score >= 0.58;
    const entityBackedMatch = sharedEntity && sharedTopic && item.score >= 0.45;
    return sameAction && (monthExtension || sharedContext || explicitUpdate || strongSemanticMatch || entityBackedMatch);
  });
  if (!compatible.length) return null;
  if (compatible[1] && compatible[0].score - compatible[1].score < 0.12) return null;
  return compatible[0];
}

function sharedResourceRelations(profile, top, confidence = 0.7) {
  if (!top) return [];
  const shared = profile.resources.filter((resource) => top.profile.resources.includes(resource));
  return shared.map((resource) => relation(
    "SHARES_RESOURCE",
    INCOMING_TASK_REF,
    top.task_id,
    confidence,
    `Both tasks use ${resource}; shared data is a relation signal, not a merge reason.`,
    { resource },
  ));
}

function baseResult(profile, ranked, decision, confidence, reason, extra = {}) {
  return {
    decision,
    confidence: round(confidence),
    reason,
    automatic_action: "CREATE",
    should_create: true,
    existing_task_id: null,
    canonical_task_id: null,
    normalized_intent: profile,
    candidates: candidateSummary(ranked),
    relationships: [],
    shared_resources: [],
    update: null,
    goal_link: null,
    parent_child: null,
    non_destructive: true,
    thresholds: RESOLUTION_THRESHOLDS,
    ...extra,
  };
}

function dependencyResult(profile, ranked, goal, dependency) {
  const dependent = dependency.direction === "incoming_depends_on_existing" ? INCOMING_TASK_REF : dependency.item.task_id;
  const prerequisite = dependency.direction === "incoming_depends_on_existing" ? dependency.item.task_id : INCOMING_TASK_REF;
  const confidence = Math.max(profile.dependency_cue ? 0.92 : 0.9, dependency.score);
  const reason = dependency.direction === "incoming_depends_on_existing"
    ? "The incoming action consumes the existing task's result or explicitly waits for it."
    : "The existing action consumes the incoming task's output, so the new task must run first.";
  return baseResult(profile, ranked, "DEPENDENCY", confidence, reason, {
    automatic_action: "CREATE_AND_LINK",
    existing_task_id: dependency.item.task_id,
    relationships: [
      relation("DEPENDS_ON", dependent, prerequisite, confidence, reason),
      ...sharedResourceRelations(profile, dependency.item, confidence),
    ],
    shared_resources: profile.resources.filter((resource) => dependency.item.profile.resources.includes(resource)),
    goal_link: goal ? { goal_id: goal.goal.id, confidence: goal.score, reason: "The dependent task matches one existing Goal." } : null,
  });
}

export function resolveTaskIntent(incoming, context = {}) {
  const extractedProfile = extractIntentProfile(incoming);
  const profile = context.project_goal_id && !extractedProfile.goal_plan_id
    ? { ...extractedProfile, goal_plan_id: cleanString(context.project_goal_id, 1024) }
    : extractedProfile;
  const candidatePool = context.tasks || context.candidates || [];
  const ranked = rankTaskCandidates(profile, candidatePool, { limit: context.candidate_limit || 20 });
  const explicitDependencyIds = cleanArray(incoming?.depends_on_task_ids || incoming?.dependsOnTaskIds);
  const dependencyCandidates = [...ranked];
  for (const candidate of candidatePool) {
    const id = taskId(candidate);
    if (!explicitDependencyIds.includes(id) || dependencyCandidates.some((item) => item.task_id === id)) continue;
    const scored = taskCandidateScore(profile, candidate);
    dependencyCandidates.push({
      task: candidate,
      task_id: id,
      status: semanticStatus(candidate),
      updated_at: candidate.updated_at || candidate.updatedAt || "",
      ...scored,
    });
  }
  const top = ranked[0] || null;
  const goal = findGoalAssociation(profile, context.goals || []);
  const parentChild = profile.parent_child_cue ? splitParentChildren(incoming) : null;
  const dependency = inferredDependencyCandidate(profile, dependencyCandidates);

  const taskType = cleanString(incoming?.task_type || incoming?.taskType, 40).toLowerCase();
  if (taskType === "follow_up") {
    const parentId = cleanString(
      incoming?.follow_up_of || incoming?.followUpOf || incoming?.parent_task_id || incoming?.parentTaskId,
      1_024,
    ) || null;
    const repeatedFollowUps = candidatePool.filter((candidate) => (
      !CLOSED_STATUSES.has(semanticStatus(candidate))
      && (candidate.task_type || candidate.schedule?.task_type) === "follow_up"
      && (candidate.follow_up_of || candidate.schedule?.follow_up_of || candidate.parent_task_id || null) === parentId
      && Number(candidate.follow_up_sequence || candidate.schedule?.follow_up_sequence || 2) === Number(incoming.follow_up_sequence || 2)
      && normalizeResolutionText(candidate.title) === normalizeResolutionText(incoming.title)
    ));
    if (repeatedFollowUps.length) {
      return resolveTaskIntent({ ...incoming, task_type: "task", taskType: "task" }, { ...context, tasks: repeatedFollowUps });
    }
    const reason = "An explicitly classified follow-up is a new atomic Task and must retain its parent linkage.";
    return attachExplicitDependencies(baseResult(profile, ranked, "NEW", 1, reason, {
      automatic_action: "CREATE",
      relationships: parentId
        ? [relation("PARENT_OF", parentId, INCOMING_TASK_REF, 1, reason, { follow_up: true })]
        : [],
    }), profile, dependencyCandidates, explicitDependencyIds);
  }

  const scheduledMeetingMatches = candidatePool.filter((candidate) => (
    taskId(candidate)
      && !CLOSED_STATUSES.has(semanticStatus(candidate))
      && isSameScheduledNamedMeeting(incoming, candidate)
  ));
  if (scheduledMeetingMatches.length > 1) {
    const reason = "Multiple open tasks have the same named attendee, date, and time; choosing a canonical task would be ambiguous.";
    return baseResult(profile, ranked, "CONFLICT", 1, reason, {
      automatic_action: "ASK",
      should_create: false,
      requires_clarification: true,
    });
  }
  if (scheduledMeetingMatches.length === 1 && !materialIncomingNotes(incoming)) {
    const match = scheduledMeetingMatches[0];
    const id = taskId(match);
    const confidence = 0.99;
    const reason = "The incoming arrival or meeting has the same named attendee, date, and time as one existing open task.";
    return attachExplicitDependencies(baseResult(profile, ranked, "DUPLICATE", confidence, reason, {
      automatic_action: "REUSE_CANONICAL",
      should_create: false,
      existing_task_id: id,
      canonical_task_id: match.canonical_task_id || id,
      relationships: [relation("DUPLICATE_OF", INCOMING_TASK_REF, id, confidence, reason)],
    }), profile, dependencyCandidates, explicitDependencyIds);
  }

  const duplicate = duplicateConfidence(profile, top);
  const addsOrChangesDue = Boolean(top && profile.due && profile.due !== top.profile.due);
  const incomingNotes = materialIncomingNotes(incoming);
  const addsExplicitNotes = Boolean(top && incomingNotes
    && !normalizeResolutionText(top.task?.notes).includes(normalizeResolutionText(incomingNotes)));
  if (top && duplicate >= RESOLUTION_THRESHOLDS.automatic
    && !addsOrChangesDue && !addsExplicitNotes && !CLOSED_STATUSES.has(top.status)) {
    const reason = "The incoming intent has the same atomic action, subject, scope, and compatible date as the existing open task.";
    return attachExplicitDependencies(baseResult(profile, ranked, "DUPLICATE", duplicate, reason, {
      automatic_action: "REUSE_CANONICAL",
      should_create: false,
      existing_task_id: top.task_id,
      canonical_task_id: top.task.canonical_task_id || top.task_id,
      relationships: [relation("DUPLICATE_OF", INCOMING_TASK_REF, top.task_id, duplicate, reason)],
      shared_resources: profile.resources.filter((resource) => top.profile.resources.includes(resource)),
      goal_link: goal ? { goal_id: goal.goal.id, confidence: goal.score, reason: "The canonical task matches one existing Goal." } : null,
    }), profile, dependencyCandidates, explicitDependencyIds);
  }

  const additive = additiveUpdateCandidate(profile, ranked);
  const identityMatches = ranked.filter((item) => (
    !CLOSED_STATUSES.has(item.status)
      && duplicateConfidence({ ...profile, due: item.profile.due }, item) >= RESOLUTION_THRESHOLDS.automatic
  ));
  const uniqueIdentity = identityMatches.length === 1 ? identityMatches[0] : null;
  const sameIdentityNewDate = uniqueIdentity && profile.due && profile.due !== uniqueIdentity.profile.due;
  const sameIdentityNewNotes = uniqueIdentity && duplicate >= 0.9 && addsExplicitNotes;
  if (additive || sameIdentityNewDate || sameIdentityNewNotes) {
    const match = additive || uniqueIdentity;
    const update = {
      title: mergeTaskTitle(match.task, incoming),
      notes: mergeNotes(match.task, incoming),
      ...(profile.due && profile.due !== match.profile.due ? { due: profile.due } : {}),
    };
    const confidence = profile.explicit_update || sameIdentityNewDate ? 0.97 : 0.94;
    const reason = sameIdentityNewDate || sameIdentityNewNotes
      ? "The same canonical action received additional date or note information, so the existing task is patched."
      : "The new wording is an additive scope change to one unambiguous existing atomic task.";
    return attachExplicitDependencies(baseResult(profile, ranked, "UPDATE", confidence, reason, {
      automatic_action: "UPDATE_CANONICAL",
      should_create: false,
      existing_task_id: match.task_id,
      canonical_task_id: match.task.canonical_task_id || match.task_id,
      update,
      relationships: [],
      shared_resources: profile.resources.filter((resource) => match.profile.resources.includes(resource)),
      goal_link: goal ? { goal_id: goal.goal.id, confidence: goal.score, reason: "The updated canonical task matches one existing Goal." } : null,
    }), profile, dependencyCandidates, explicitDependencyIds);
  }

  if (parentChild) {
    const relationships = parentChild.children.map((child) => relation(
      "PARENT_OF",
      INCOMING_TASK_REF,
      child.temp_id,
      0.96,
      "The user explicitly described one work package with independently completable components.",
    ));
    return attachExplicitDependencies(baseResult(profile, ranked, "PARENT_CHILD", 0.96, "Explicit work-package enumeration creates one parent and atomic child tasks.", {
      automatic_action: "CREATE_PARENT_CHILD",
      relationships,
      shared_resources: profile.resources,
      goal_link: goal ? { goal_id: goal.goal.id, confidence: goal.score, reason: "The work package matches one existing Goal." } : null,
      parent_child: parentChild,
    }), profile, dependencyCandidates, explicitDependencyIds);
  }

  if (explicitDependencyIds.length) {
    return attachExplicitDependencies(baseResult(
      profile,
      ranked,
      "DEPENDENCY",
      1,
      explicitDependencyIds.length === 1
        ? "The incoming action explicitly depends on one existing Task."
        : "The incoming action explicitly depends on multiple existing Tasks.",
      {
        automatic_action: "CREATE_AND_LINK",
        existing_task_id: explicitDependencyIds[0],
        goal_link: goal ? { goal_id: goal.goal.id, confidence: goal.score, reason: "The dependent task matches one existing Goal." } : null,
      },
    ), profile, dependencyCandidates, explicitDependencyIds);
  }

  // A proven producer/consumer order is stronger than a generic write conflict:
  // the dependency already prevents unsafe parallel execution and preserves the
  // direction needed by the scheduler.
  if (dependency) return dependencyResult(profile, ranked, goal, dependency);

  const conflict = conflictCandidate(profile, ranked);
  if (conflict) {
    const reason = `Both tasks can write ${conflict.sharedWrites.join(", ")} with overlapping or unspecified fields; parallel execution could overwrite state.`;
    return baseResult(profile, ranked, "CONFLICT", conflict.score, reason, {
      automatic_action: "CREATE_AND_LINK",
      relationships: [
        relation("CONFLICTS_WITH", INCOMING_TASK_REF, conflict.item.task_id, conflict.score, reason, { resources: conflict.sharedWrites }),
        ...sharedResourceRelations(profile, conflict.item, conflict.score),
      ],
      shared_resources: conflict.sharedWrites,
      goal_link: goal ? { goal_id: goal.goal.id, confidence: goal.score, reason: "The task matches one existing Goal." } : null,
    });
  }

  if (profile.explicit_merge && top) {
    const sameContext = top.score >= 0.58 || contextSimilarity(profile, top.profile) > 0;
    const ambiguous = ranked[1] && top.score - ranked[1].score < 0.12;
    if (sameContext && !ambiguous && !CLOSED_STATUSES.has(top.status)) {
      const confidence = Math.max(0.9, top.score);
      const reason = "The user explicitly requested one deliverable and the candidate shares its context; the canonical task is extended without deleting source history.";
      return baseResult(profile, ranked, "MERGE", confidence, reason, {
        automatic_action: "MERGE_INTO_CANONICAL",
        should_create: false,
        existing_task_id: top.task_id,
        canonical_task_id: top.task.canonical_task_id || top.task_id,
        update: { title: mergeTaskTitle(top.task, incoming), notes: mergeNotes(top.task, incoming) },
        relationships: [relation("MERGED_INTO", INCOMING_TASK_REF, top.task_id, confidence, reason)],
        shared_resources: profile.resources.filter((resource) => top.profile.resources.includes(resource)),
        goal_link: goal ? { goal_id: goal.goal.id, confidence: goal.score, reason: "The merged canonical task matches one existing Goal." } : null,
      });
    }
  }

  if (top && top.score >= RESOLUTION_THRESHOLDS.safe_link) {
    const reason = "The tasks share meaningful context but retain independent completion value; they are linked rather than merged.";
    return baseResult(profile, ranked, "RELATED", top.score, reason, {
      automatic_action: "CREATE_AND_LINK",
      existing_task_id: top.task_id,
      relationships: [
        relation("RELATED_TO", INCOMING_TASK_REF, top.task_id, top.score, reason),
        ...sharedResourceRelations(profile, top, top.score),
      ],
      shared_resources: profile.resources.filter((resource) => top.profile.resources.includes(resource)),
      goal_link: goal ? { goal_id: goal.goal.id, confidence: goal.score, reason: "Both tasks align to one existing Goal." } : null,
    });
  }

  if (goal) {
    return baseResult(profile, ranked, "GOAL_LINK", goal.score, "The task is new, but it unambiguously belongs to one existing Goal.", {
      automatic_action: "CREATE_AND_LINK_GOAL",
      goal_link: { goal_id: goal.goal.id, confidence: goal.score, reason: "Unique semantic Goal association." },
      relationships: top ? sharedResourceRelations(profile, top, Math.max(0.5, top.score)) : [],
      shared_resources: top ? profile.resources.filter((resource) => top.profile.resources.includes(resource)) : [],
    });
  }

  if (top && top.score >= RESOLUTION_THRESHOLDS.potential) {
    const reason = "Similarity is below the safe-link threshold, so a separate task is preserved with a potential relation for later review.";
    return baseResult(profile, ranked, "NEW", Math.max(0.5, 1 - top.score / 2), reason, {
      relationships: [
        relation("POTENTIAL_RELATION", INCOMING_TASK_REF, top.task_id, top.score, reason),
        ...sharedResourceRelations(profile, top, top.score),
      ],
      shared_resources: profile.resources.filter((resource) => top.profile.resources.includes(resource)),
    });
  }

  const sharedResources = top ? profile.resources.filter((resource) => top.profile.resources.includes(resource)) : [];
  return baseResult(profile, ranked, "NEW", top ? Math.max(0.7, 1 - top.score) : 1, "No existing task or Goal is similar enough to reuse, update, merge, or link.", {
    relationships: top ? sharedResourceRelations(profile, top, Math.max(0.5, top.score)) : [],
    shared_resources: sharedResources,
  });
}

export function resolutionProfileRecord(task, resolution = null) {
  const profile = extractIntentProfile(task);
  const id = taskId(task);
  return {
    google_task_id: id,
    canonical_task_id: cleanString(task?.canonical_task_id, 1024) || id,
    normalized_title: profile.normalized_text.slice(0, 2_000),
    semantic_key: profile.semantic_key.slice(0, 2_000),
    action: profile.action,
    entities: profile.entities,
    topics: profile.topics,
    resources: profile.resources,
    read_resources: profile.read_resources,
    write_resources: profile.write_resources,
    resource_fields: profile.resource_fields,
    goal_plan_id: profile.goal_plan_id,
    project_id: profile.project_id,
    resolution_confidence: resolution?.confidence ?? null,
    resolution_reason: resolution?.reason || null,
    last_semantic_resolution_at: new Date().toISOString(),
  };
}

export function replaceIncomingTaskRefs(relationships = [], createdTaskId, childIds = {}) {
  return relationships.map((item) => ({
    ...item,
    from_task_id: item.from_task_id === INCOMING_TASK_REF
      ? createdTaskId
      : childIds[item.from_task_id] || item.from_task_id,
    to_task_id: item.to_task_id === INCOMING_TASK_REF
      ? createdTaskId
      : childIds[item.to_task_id] || item.to_task_id,
  }));
}

export function buildResolutionMutationPlan(incoming, resolution) {
  if (!resolution || !RESOLUTION_DECISIONS.includes(resolution.decision)) throw new Error("A valid resolution is required");
  const baseTask = {
    ...incoming,
    goal_plan_id: resolution.goal_link?.goal_id || incoming.goal_plan_id || incoming.goal_id || null,
  };
  const operations = [];
  if (resolution.decision === "DUPLICATE") {
    operations.push({ type: "reuse", task_id: resolution.existing_task_id });
  } else if (["UPDATE", "MERGE"].includes(resolution.decision)) {
    operations.push({ type: "update", task_id: resolution.existing_task_id, changes: resolution.update || {} });
  } else if (resolution.decision === "PARENT_CHILD") {
    operations.push({ type: "create", temp_id: INCOMING_TASK_REF, task: { ...baseTask, ...resolution.parent_child.parent } });
    for (const child of resolution.parent_child.children) {
      operations.push({ type: "create", temp_id: child.temp_id, parent_temp_id: INCOMING_TASK_REF, task: { ...baseTask, ...child } });
    }
  } else {
    operations.push({ type: "create", temp_id: INCOMING_TASK_REF, task: baseTask });
  }
  return {
    decision: resolution.decision,
    confidence: resolution.confidence,
    reason: resolution.reason,
    automatic_action: resolution.automatic_action,
    non_destructive: true,
    operations,
    relationships: resolution.relationships || [],
    goal_link: resolution.goal_link,
    audit: {
      original_intent: cleanString(incoming.raw_text || incoming.input || incoming.title),
      normalized_intent: resolution.normalized_intent,
      decision: resolution.decision,
      confidence: resolution.confidence,
      reason: resolution.reason,
      existing_task_id: resolution.existing_task_id,
      candidate_snapshot: resolution.candidates,
      related_object_ids: {
        task_ids: sortedUnique((resolution.relationships || []).flatMap((item) => [item.from_task_id, item.to_task_id]).filter((id) => id !== INCOMING_TASK_REF && !id.startsWith("__child_"))),
        goal_ids: resolution.goal_link?.goal_id ? [resolution.goal_link.goal_id] : [],
        resources: resolution.shared_resources || [],
      },
    },
  };
}
