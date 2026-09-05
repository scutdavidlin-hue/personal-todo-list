import { classifyAction, parseIntentDate, parseIntentTime } from "./action-router.js";

const TIMEZONE = "Asia/Shanghai";
const TRAVEL_PATTERN = /(?:旅行|旅游|出差|行程|酒店|旅馆|民宿|住宿|入住|退房|订房|预订|机票|航班|机场|高铁|火车|行李|景点)/;
const ACTION_PATTERN = /(?:帮我|请|记得|提醒|安排|创建|添加|记录|提交|发送|回复|联系|准备|整理|检查|查看|查询|核对|对(?:一下)?账|跟进|拿|带|预订|订|购买|买|修改|调整|改成|改到|换到|取消|删除|删掉|清空|签署|签订|转账|付款|支付|卖|出售|过户|住|参加|开会|处理|过来|到达|出发)/;
const PREFERENCE_PATTERN = /(?:尽量|优先|最好|偏好|喜欢|默认|通常|一般|不要|避免|都(?:住|选|用|提醒)|固定(?:住|选|用|提醒))/;
const FUTURE_PATTERN = /(?:以后|今后|往后|未来)/;
const DINNER_PATTERN = /(?:晚饭|晚餐|晚宴|聚餐|吃饭)/;
const INTAKE_TYPES = new Set(["task", "goal", "plan", "long_term_item", "financial_item", "calendar_event", "project_data", "contact", "client", "knowledge", "gpt_job"]);
const UNTRUSTED_POLICY_FIELDS = new Set([
  "intent", "risk_level", "riskLevel", "decision", "reason", "question", "preference_text",
  "confirmed", "confirmation", "confirmation_text", "isConfirmed", "approved", "approval",
  "success", "write_success", "writeSuccess", "verified", "partial", "update_patch", "updatePatch",
]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function chineseNumber(value) {
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, units] = value.split("十");
    return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0);
  }
  return digits[value] ?? null;
}

function parseChineseIntentTime(text) {
  const match = String(text || "").match(/(上午|早上|中午|下午|晚上)?\s*([一二两三四五六七八九十]{1,3})点(?:(半)|([一二两三四五六七八九十]{1,3})分?)?/);
  if (!match) return null;
  let hour = chineseNumber(match[2]);
  const minute = match[3] ? 30 : (match[4] ? chineseNumber(match[4]) : 0);
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  if ((match[1] === "下午" || match[1] === "晚上") && hour < 12) hour += 12;
  if (match[1] === "中午" && hour < 11) hour += 12;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function autonomyIntentTime(text) {
  return parseIntentTime(text) || parseChineseIntentTime(text);
}

function autonomyIntentDate(text, baseDate) {
  const parsed = parseIntentDate(text, baseDate);
  if (parsed || !/(?:^|[^下])下周(?![末一二三四五六日天])/.test(String(text || ""))) return parsed;
  const result = new Date(baseDate);
  const daysUntilMonday = ((1 - result.getDay() + 7) % 7) || 7;
  result.setDate(result.getDate() + daysUntilMonday);
  return `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, "0")}-${String(result.getDate()).padStart(2, "0")}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function shanghaiWallClockDate(value) {
  const instant = value === undefined || value === null || value === "" ? new Date() : new Date(value);
  const safeInstant = Number.isNaN(instant.valueOf()) ? new Date() : instant;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(safeInstant);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(get("year"), get("month") - 1, get("day"), 12, 0, 0, 0);
}

function notesWithRawWording(notes, rawText) {
  const existing = cleanString(notes);
  if (!existing) return rawText;
  if (!rawText || existing.includes(rawText)) return existing;
  return `${existing}\n\n原始请求：${rawText}`;
}

function splitPreference(text) {
  const clauses = String(text || "")
    .split(/[，,。；;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const preferenceClauses = clauses.filter((clause) => FUTURE_PATTERN.test(clause) && PREFERENCE_PATTERN.test(clause));
  if (preferenceClauses.length === 0) return { preferenceText: null, actionText: text, mixed: false };

  const actionClauses = clauses.filter((clause) => !preferenceClauses.includes(clause));
  const directive = preferenceClauses[0]
    .replace(/^(?:以后|今后|往后|未来)\s*/, "")
    .replace(/^(?:旅游|旅行)?(?:入住|住)?(?:酒店|旅馆|民宿)?\s*/, "")
    .replace(/^都/, "")
    .trim();
  const actionText = actionClauses
    .map((clause) => /(?:也这样|也照此|照这样|按这个来)/.test(clause)
      ? clause.replace(/(?:也这样|也照此|照这样|按这个来)/, directive)
      : clause)
    .join("，");
  const mixed = Boolean(actionText && (ACTION_PATTERN.test(actionText) || /(?:这次|本次|这趟|此次|今天|明天|后天)/.test(actionText)));
  return {
    preferenceText: preferenceClauses.join("，"),
    actionText: mixed ? actionText : "",
    mixed,
  };
}

function isInformationQuestion(text) {
  if (!text) return false;
  const asksForAction = /(?:帮我|请|麻烦|记得|提醒我|替我|给我).{0,50}(?:安排|创建|添加|记录|提交|发送|回复|联系|准备|整理|检查|查看|查询|预订|订|购买|修改|调整|取消|删除|处理)/.test(text);
  if (asksForAction) return false;
  return /[?？]$/.test(text)
    || /^(?:什么|怎么|如何|为什么|为何|是否|谁|哪|几|多少|何时|什么时候|能否|可不可以)/.test(text)
    || /(?:有没有|有无|是不是|会不会|能不能|可不可以|为什么|怎么|如何|多少|哪里|哪家|几点|什么时候)/.test(text)
    || /(?:吗|呢)[?？]?$/.test(text);
}

function isAction(text) {
  return ACTION_PATTERN.test(text)
    || Boolean(autonomyIntentTime(text))
    || /^(?:改成|改到|还是|换到)\s*(?:上午|早上|中午|下午|晚上)?\s*(?:\d{1,2}|[一二两三四五六七八九十]{1,3})(?::\d{2}|点)/.test(text);
}

function isOuterReminder(text) {
  return /^(?:(?:今天|明天|后天|下周[一二三四五六日天]?|周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]?)\s*)?(?:请|麻烦)?(?:记得)?提醒我/.test(text)
    || /^(?:请|麻烦)?(?:创建|加|设|设置)(?:一个|个)?提醒/.test(text);
}

function parsedAmount(text) {
  let largest = null;
  const pattern = /(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:(万|千|亿)\s*(?:元|块)?|(?:元|块))/g;
  for (const match of String(text).matchAll(pattern)) {
    let amount = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(amount)) continue;
    if (match[2] === "亿") amount *= 100_000_000;
    if (match[2] === "万") amount *= 10_000;
    if (match[2] === "千") amount *= 1_000;
    largest = largest === null ? amount : Math.max(largest, amount);
  }
  for (const match of String(text).matchAll(/([一二两三四五六七八九十百千]+)(万|亿)(?:元|块)?/g)) {
    let amount = 0;
    let digit = 0;
    for (const character of match[1]) {
      const unit = { 十: 10, 百: 100, 千: 1000 }[character];
      if (unit) { amount += (digit || 1) * unit; digit = 0; }
      else digit = chineseNumber(character) || 0;
    }
    amount = (amount + digit) * (match[2] === "亿" ? 100_000_000 : 10_000);
    largest = largest === null ? amount : Math.max(largest, amount);
  }
  return largest;
}

function l3Reason(text) {
  if (isOuterReminder(text)) return null;

  const amount = parsedAmount(text);
  if (/(?:转账|汇款|付款|支付|提现|投资|买入|卖出)/.test(text)
    && ((amount !== null && amount >= 100_000) || /(?:大额|全部资金|全部存款|全部余额|全仓)/.test(text))) {
    return "The request directly performs a major money operation.";
  }
  if (/(?:购买|买下|买(?:一|这|那)?套?|卖掉|出售|过户|抵押).{0,16}(?:房子|房产|住房|公寓|商铺|土地)/.test(text)
    || /(?:签署|签订|代签|盖章).{0,16}(?:购房|售房|房产).{0,10}(?:合同|协议)/.test(text)) {
    return "The request directly changes ownership of major property.";
  }
  if (/(?:删除|删掉|清空|销毁|抹掉).{0,24}(?:生产|正式|全部|所有|核心|客户|财务|数据库|备份|仓库|账号|账户|云盘|照片)/.test(text)) {
    return "The request directly deletes critical data.";
  }
  if (/(?:签署|签订|代签|盖章|签(?:个|一下)?).{0,16}(?:合同|协议|法律文件)/.test(text)) {
    return "The request directly executes a legally significant agreement.";
  }
  return null;
}

function materiallyAmbiguous(text, context) {
  if (/(?:预订|订).{0,12}(?:酒店|旅馆|民宿|住宿|房间)|订房/.test(text)) return null;
  if (/^(?:帮我|请|麻烦)?(?:处理|修改|改|删除|删掉|取消|发送|发|提交|转账|付)(?:一下)?[吧。！!]*$/.test(text)) {
    return "the target or requested change is missing";
  }
  if (/(?:把|将)?(?:它|这个|那个|这条|那条|这些|那些)(?:给)?(?:删除|删掉|取消|修改|改|发送|提交|处理)/.test(text)
    || /(?:删除|删掉|取消|修改|发送|发给|转给|提交给|处理(?:一下)?).{0,6}(?:它|这个|那个|他|她|对方)$/.test(text)
    || /(?:把|将)?(?:它|这个东西|那个东西).{0,10}(?:带|拿)(?:去|到)/.test(text)) {
    return "the referenced target is not identified";
  }
  return null;
}

function dateFromContextItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  for (const key of ["requested_date", "start_date", "end_date", "target_date"]) {
    if (validDate(cleanString(item[key]))) return cleanString(item[key]);
  }
  return null;
}

function isTravelContext(item) {
  return TRAVEL_PATTERN.test(cleanString(item?.title));
}

function firstContextDate(items, travelAction, travelOnly = false) {
  if (!Array.isArray(items) || (travelOnly && !travelAction)) return null;
  for (const item of items) {
    if (!travelAction && isTravelContext(item)) continue;
    const date = dateFromContextItem(item);
    if (date) return date;
  }
  return null;
}

function contextualDate(text, context = {}) {
  const travelAction = TRAVEL_PATTERN.test(text);
  return firstContextDate(context.conversation_trips, travelAction, true)
    || firstContextDate(context.calendar_events, travelAction)
    || firstContextDate(context.travel_plans, travelAction, true)
    || ((!travelAction && isTravelContext(context.current_task)) ? null : dateFromContextItem(context.current_task))
    || ((!travelAction && isTravelContext(context.current_goal)) ? null : dateFromContextItem(context.current_goal))
    || null;
}

function requestedDate(text, inputDate, context, baseDate) {
  return autonomyIntentDate(text, baseDate)
    || (validDate(cleanString(inputDate)) ? cleanString(inputDate) : null)
    || contextualDate(text, context)
    || parseIntentDate("今天", baseDate);
}

function titleFromAction(text) {
  const title = String(text || "")
    .replace(/20\d{2}[-年]\d{1,2}[-月]\d{1,2}[日号]?/g, "")
    .replace(/\d{1,2}月\d{1,2}[日号]?/g, "")
    .replace(/(?:今天|明天|后天|本周|这周|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天])/g, "")
    .replace(/(?:上午|早上|中午|下午|晚上)?\s*\d{1,2}(?::\d{2}|点(?:\d{1,2}分)?)/g, "")
    .replace(/(?:上午|早上|中午|下午|晚上)?\s*[一二两三四五六七八九十]{1,3}点(?:半|[一二两三四五六七八九十]{1,3}分?)?/g, "")
    .replace(/^(?:请|麻烦)?(?:帮我|替我|给我|记得|提醒我)\s*/, "")
    .replace(/[，,。；;！!？?]+$/g, "")
    .trim();
  return title || cleanString(text);
}

function currentTaskUpdate(text, currentTask, baseInput, baseDate) {
  if (!currentTask?.id) return null;
  const parsedTime = autonomyIntentTime(text);
  const isShortTimeChange = parsedTime && /(?:改成|改到|调整到|换到|还是)\s*(?:上午|早上|中午|下午|晚上)?\s*(?:\d{1,2}|[一二两三四五六七八九十]{1,3})(?::\d{2}|点)/.test(text);
  if (isShortTimeChange) {
    let nextTime = parsedTime;
    const currentHour = Number(cleanString(currentTask.requested_time).slice(0, 2));
    const parsedHour = Number(parsedTime.slice(0, 2));
    const hasExplicitPeriod = /(?:上午|早上|中午|下午|晚上)/.test(text);
    if (!hasExplicitPeriod && currentHour >= 12 && currentHour <= 18 && parsedHour >= 1 && parsedHour <= 11) {
      nextTime = `${String(parsedHour + 12).padStart(2, "0")}:${parsedTime.slice(3)}`;
    }
    const updatePatch = {};
    if (nextTime !== cleanString(currentTask.requested_time)) updatePatch.requested_time = nextTime;
    const explicitDate = autonomyIntentDate(text, baseDate);
    if (explicitDate && explicitDate !== cleanString(currentTask.requested_date)) updatePatch.requested_date = explicitDate;
    return {
      ...baseInput,
      type: "task",
      title: cleanString(currentTask.title) || baseInput.title,
      existing_task_id: currentTask.id,
      update_patch: updatePatch,
    };
  }

  const cancelsDinner = DINNER_PATTERN.test(text) && /(?:取消|不(?:再|一起)?吃|去掉|删掉|删除)/.test(text);
  if (cancelsDinner && DINNER_PATTERN.test(`${cleanString(currentTask.title)} ${cleanString(currentTask.notes)}`)) {
    const oldTitle = cleanString(currentTask.title);
    const removeDinner = (value) => cleanString(value)
      .replace(/(?:，|,|；|;|、)?\s*(?:然后|并且|以及|再|和)?\s*(?:晚上|今晚|明晚)?\s*(?:一起)?(?:安排|约|去|吃)?\s*(?:晚饭|晚餐|晚宴|聚餐|吃饭)[^，,；;]*/g, "")
      .replace(/(?:，|,|；|;|、)\s*$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    const nextTitle = removeDinner(oldTitle);
    const updatePatch = {};
    if (nextTitle && nextTitle !== oldTitle) updatePatch.title = nextTitle;
    const oldNotes = cleanString(currentTask.notes);
    if (oldNotes && DINNER_PATTERN.test(oldNotes)) {
      const nextNotes = removeDinner(oldNotes);
      if (nextNotes !== oldNotes) updatePatch.notes = nextNotes;
    }
    return {
      ...baseInput,
      type: "task",
      title: nextTitle || oldTitle,
      existing_task_id: currentTask.id,
      update_patch: updatePatch,
    };
  }
  return null;
}

function baseEnrichedInput(input, rawText) {
  const enriched = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!UNTRUSTED_POLICY_FIELDS.has(key) && value !== undefined) enriched[key] = value;
  }
  enriched.raw_text = rawText;
  enriched.notes = notesWithRawWording(input?.notes, rawText);
  if (cleanString(input?.title)) enriched.title = cleanString(input.title);
  if (cleanString(input?.type)) enriched.type = cleanString(input.type);
  return enriched;
}

function routeInput(route, baseInput, source, rawText) {
  const explicitType = INTAKE_TYPES.has(cleanString(source.type)) ? cleanString(source.type) : null;
  const type = explicitType || route.type;
  return {
    ...(route.payload && typeof route.payload === "object" ? route.payload : {}),
    ...baseInput,
    raw_text: rawText,
    type,
    title: cleanString(source.title) || cleanString(route.payload?.title) || rawText,
    notes: notesWithRawWording(source.notes, rawText),
  };
}

function result(intent, riskLevel, decision, reason, question, input, preferenceText = null) {
  return {
    intent,
    risk_level: riskLevel,
    decision,
    reason,
    question,
    input,
    preference_text: preferenceText,
  };
}

export function evaluateAutonomy(input, options = {}) {
  const source = typeof input === "string" ? { raw_text: input } : (input && typeof input === "object" && !Array.isArray(input) ? input : {});
  const originalRawText = typeof source.raw_text === "string" ? source.raw_text : "";
  const rawText = cleanString(originalRawText);
  const baseDate = shanghaiWallClockDate(options.baseDate);
  const context = source.context && typeof source.context === "object" && !Array.isArray(source.context) ? source.context : {};
  const baseInput = baseEnrichedInput(source, originalRawText);

  if (!rawText) {
    return result("unknown", "L2", "ask", "The request has no usable intent.", "你希望我具体做什么？", baseInput);
  }

  if (isInformationQuestion(rawText)) {
    return result("information", "L1", "information", "The request asks for information and does not request a write.", null, baseInput);
  }

  const preference = splitPreference(rawText);
  if (preference.preferenceText && !preference.mixed) {
    const planInput = {
      ...baseInput,
      type: "plan",
      title: cleanString(source.title) || preference.preferenceText,
    };
    return result("preference", "L1", "execute", "The future preference can be recorded as a plan.", null, planInput, null);
  }

  const actionText = preference.mixed ? preference.actionText : rawText;
  const actionBaseInput = {
    ...baseInput,
    raw_text: originalRawText,
    notes: notesWithRawWording(source.notes, originalRawText),
  };
  const l3 = l3Reason(actionText);
  if (l3) return result(preference.mixed ? "mixed" : "action", "L3", "ask", l3, "请确认关键对象、金额及要执行的具体操作。", actionBaseInput, preference.preferenceText);
  const update = currentTaskUpdate(actionText, context.current_task, actionBaseInput, baseDate);
  if (update) {
    return result(preference.mixed ? "mixed" : "action", "L1", "execute", "The request is an unambiguous update to the current task.", null, update, preference.preferenceText);
  }

  if (/^(?:改成|改到|还是|换到)|(?:把|将).{1,40}(?:改一下|改成|改到|调整一下)/.test(actionText)) {
    return result("action", "L2", "ask", "The task target or new value is missing.", context.current_task?.id ? "要改成什么时间或内容？" : "要修改哪个任务？", actionBaseInput);
  }
  const explicitDeadlineOnly = validDate(cleanString(source.deadline))
    || (Boolean(autonomyIntentDate(actionText, baseDate)) && /(?:之前|以前|截止|最晚|前把|前完成|前提交)/.test(actionText));
  const actionInput = {
    ...actionBaseInput,
    type: "task",
    title: cleanString(source.title) || titleFromAction(actionText),
  };
  if (!explicitDeadlineOnly || validDate(cleanString(source.requested_date))) {
    actionInput.requested_date = requestedDate(actionText, source.requested_date, context, baseDate);
    actionInput.scheduling_source = autonomyIntentDate(actionText, baseDate) || source.requested_date ? "explicit_user" : "gpt_inferred";
  }
  const time = autonomyIntentTime(actionText) || cleanString(source.requested_time) || null;
  if (time) actionInput.requested_time = time;

  const ambiguity = materiallyAmbiguous(actionText, context);
  if (ambiguity) {
    return result(preference.mixed ? "mixed" : "action", "L2", "ask", `Material ambiguity remains: ${ambiguity}.`, "请说明具体对象和要做的更改。", actionInput, preference.preferenceText);
  }

  const route = classifyAction(actionText, { baseDate });
  const explicitType = INTAKE_TYPES.has(cleanString(source.type)) ? cleanString(source.type) : null;
  const establishedNonTask = explicitType ? explicitType !== "task" : route.type !== "task" && (route.type !== "knowledge" || route.confidence >= 0.9);
  if (establishedNonTask) {
    return result(
      preference.mixed ? "mixed" : "action",
      "L1",
      "execute",
      "The request maps to an established Personal OS destination.",
      null,
      routeInput(route, actionBaseInput, source, originalRawText),
      preference.preferenceText,
    );
  }

  if (!isAction(actionText)) {
    return result("unknown", "L2", "ask", "The request does not identify an action to execute.", "你希望我具体做什么？", actionBaseInput, preference.preferenceText);
  }

  return result(
    preference.mixed ? "mixed" : "action",
    !isOuterReminder(actionText) && /正式|客户.{0,20}(?:安排|见面)|转账|付款|支付|支出/.test(actionText) ? "L2" : "L1",
    "execute",
    "The requested operation is a clear, reversible task write.",
    null,
    actionInput,
    preference.preferenceText,
  );
}

function verifiedId(value) {
  return (typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value));
}

export function confirmationForWrite(resultValue) {
  const value = resultValue && typeof resultValue === "object" && !Array.isArray(resultValue) ? resultValue : {};
  const id = value.id ?? value.task_id ?? value.write_id ?? value.data?.id ?? value.record?.id;
  if (value.write_success === true && value.verified === true && verifiedId(id)) return "已经写进去了";
  if (value.noop === true || value.no_op === true) return "没有执行写入";
  const detail = cleanString(value.error || value.message);
  return detail ? `没有写进去：${detail}` : "没有写进去";
}
