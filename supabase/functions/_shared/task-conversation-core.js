import { parseIntentDate } from "./action-router.js";

const CONFIRMATIONS = new Set(["对", "可以", "就这样", "确认", "是的"]);
const DISCARDS = new Set(["算了", "不用改了", "不改了", "撤销", "放弃"]);
const REJECTIONS = new Set(["不对", "不是"]);
const UNCERTAIN = /(?:可能|也许|大概|估计|说不定|还不确定|不一定|没确定|未确定)/;
const UPDATE_CUE = /(?:改|改成|改到|换|换成|换到|调整|挪到|推迟|延后|延期|提前到|还是)/;
const DEFER_CUE = /(?:推迟|延后|延期|往后|以后再说|下个月再说|晚点再说)/;
const DATE_WORD = /(?:今天|明天|后天|本周|这周|下周|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]?|20\d{2}[-年]\d{1,2}[-月]\d{1,2}[日号]?)/;
const TIME_WORD = /(?:(?:凌晨|上午|早上|中午|下午|晚上)?\s*(?:\d{1,2}(?::\d{2}|点)|[一二两三四五六七八九十]{1,3}点))/;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function exactText(value) {
  return cleanText(value)
    .normalize("NFKC")
    .replace(/[\s，,。.!！?？；;：:]+/g, "");
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function wallClockDate(now, timezone = "Asia/Shanghai") {
  const instant = now === undefined || now === null || now === "" ? new Date() : new Date(now);
  const safe = Number.isNaN(instant.valueOf()) ? new Date() : instant;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const parts = formatter.formatToParts(safe);
  const number = (type) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(number("year"), number("month") - 1, number("day"), 12, 0, 0, 0);
}

function isoLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseConversationDate(text, now, timezone) {
  const base = wallClockDate(now, timezone);
  const nextMonth = String(text).match(/下个月\s*(\d{1,2})[日号]?/);
  if (nextMonth) {
    const result = new Date(base.getFullYear(), base.getMonth() + 1, Number(nextMonth[1]), 12);
    const expectedMonth = (base.getMonth() + 1) % 12;
    return result.getMonth() === expectedMonth ? isoLocalDate(result) : null;
  }
  const parsed = parseIntentDate(String(text || ""), base);
  return validDate(parsed) ? parsed : null;
}

function chineseNumber(value) {
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (String(value).includes("十")) {
    const [tens, units] = String(value).split("十");
    return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0);
  }
  return digits[value] ?? null;
}

function parseConversationTime(text) {
  const value = String(text || "");
  const numeric = value.match(/(凌晨|上午|早上|中午|下午|晚上)?\s*(\d{1,2})(?::(\d{2})|点(?:(半)|(\d{1,2})分?)?)/);
  const chinese = numeric ? null : value.match(/(凌晨|上午|早上|中午|下午|晚上)?\s*([一二两三四五六七八九十]{1,3})点(?:(半)|([一二两三四五六七八九十]{1,3})分?)?/);
  const match = numeric || chinese;
  if (!match) return null;
  const period = match[1] || "";
  let hour = numeric ? Number(match[2]) : chineseNumber(match[2]);
  const minute = numeric
    ? (match[4] ? 30 : Number(match[3] || match[5] || 0))
    : (match[3] ? 30 : (match[4] ? chineseNumber(match[4]) : 0));
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour += 12;
  if (period === "凌晨" && hour === 12) hour = 0;
  return {
    value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    explicit_period: Boolean(period),
    source_hour: numeric ? Number(match[2]) : chineseNumber(match[2]),
  };
}

function currentDate(task) {
  const value = task?.requested_date || task?.schedule?.scheduled_date || task?.date || task?.due || task?.dueDate || null;
  return validDate(value) ? value : null;
}

function currentTime(task) {
  const value = String(task?.requested_time || task?.schedule?.scheduled_start || "").slice(0, 5);
  return validTime(value) ? value : null;
}

function taskId(task) {
  return String(task?.task_id || task?.google_task_id || task?.id || "").trim() || null;
}

function taskTitle(task) {
  return cleanText(task?.title) || "当前任务";
}

function taskTimezone(task) {
  return cleanText(task?.timezone || task?.schedule?.timezone) || "Asia/Shanghai";
}

function parserResult({
  intent = "unknown",
  confidence = 0,
  ambiguity = false,
  requiresConfirmation = false,
  clarificationQuestion = null,
  proposedChanges = {},
  action = "noop",
  changes = {},
  message = "",
  clarificationContext = null,
}) {
  return {
    parser_mode: "deterministic_fallback",
    intent,
    confidence,
    ambiguity,
    requires_confirmation: requiresConfirmation,
    clarification_question: clarificationQuestion,
    proposed_changes: proposedChanges,
    action,
    changes,
    message,
    clarification_context: clarificationContext,
  };
}

function proposal(intent, changes, proposedChanges, message, confidence = 0.94) {
  return parserResult({
    intent,
    confidence,
    ambiguity: false,
    requiresConfirmation: true,
    proposedChanges,
    action: "propose",
    changes,
    message,
  });
}

function clarification(intent, question, message, confidence = 0.7, clarificationContext = null) {
  return parserResult({
    intent,
    confidence,
    ambiguity: true,
    clarificationQuestion: question,
    action: "clarify",
    message,
    clarificationContext,
  });
}

function pendingProposal(pending) {
  const value = pending?.proposal && typeof pending.proposal === "object" ? pending.proposal : pending;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.action !== "propose" && !value.proposed_changes && !value.changes) return null;
  return value;
}

function minuteValue(date, time) {
  if (!validDate(date) || !validTime(time)) return null;
  return Date.parse(`${date}T${time}:00Z`) / 60_000;
}

function atFromOffset(date, time, offset) {
  const anchor = minuteValue(date, time);
  if (!Number.isFinite(anchor) || !Number.isInteger(Number(offset))) return null;
  return new Date((anchor - Number(offset)) * 60_000).toISOString().slice(0, 16);
}

function reminderSpecs(task) {
  const schedule = task?.schedule && typeof task.schedule === "object" ? task.schedule : task || {};
  if (Array.isArray(schedule.reminders) && schedule.reminders.length) return schedule.reminders;
  if (schedule.reminder_at || Number.isInteger(schedule.reminder_offset_minutes)) {
    return [{ at: schedule.reminder_at || null, offset_minutes: schedule.reminder_offset_minutes }];
  }
  return [];
}

function normalizedReminderAt(value, fallbackDate) {
  const text = cleanText(value);
  if (!text) return null;
  if (validTime(text)) return validDate(fallbackDate) ? `${fallbackDate}T${text}` : text;
  if (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d/.test(text)) return text.slice(0, 16);
  return text;
}

function reminderDiff(task, nextDate, nextTime) {
  const oldDate = currentDate(task);
  const oldTime = currentTime(task);
  if (!oldDate || !oldTime || !nextDate || !nextTime) return {};
  const shifted = reminderSpecs(task)
    .map((item) => {
      const rawOffset = item?.offset_minutes;
      const offset = rawOffset === null || rawOffset === undefined || rawOffset === "" ? null : Number(rawOffset);
      const from = normalizedReminderAt(item?.at, oldDate);
      if (!Number.isInteger(offset)) {
        return from ? { from, to: from, absolute: true } : null;
      }
      const to = atFromOffset(nextDate, nextTime, offset);
      if (!to) return null;
      const relativeFrom = from || atFromOffset(oldDate, oldTime, offset);
      return relativeFrom && relativeFrom !== to ? { from: relativeFrom, to, absolute: false } : null;
    })
    .filter(Boolean);
  if (shifted.length === 1) {
    const item = shifted[0];
    return {
      reminder: { from: item.from, to: item.to },
      ...(item.absolute ? { reminder_policy: { from: "absolute", to: "absolute" } } : {}),
    };
  }
  if (shifted.length > 1) return {
    reminders: {
      from: shifted.map((item) => item.from),
      to: shifted.map((item) => item.to),
    },
  };
  return {};
}

function normalizedTime(time, task) {
  if (!time) return { value: null, ambiguous: false };
  if (time.explicit_period || time.source_hour >= 12) return { value: time.value, ambiguous: false };
  const oldTime = currentTime(task);
  const oldHour = Number(String(oldTime || "").slice(0, 2));
  if (oldTime && oldHour >= 12 && time.source_hour >= 1 && time.source_hour <= 11) {
    return { value: `${String(time.source_hour + 12).padStart(2, "0")}:${time.value.slice(3)}`, ambiguous: false };
  }
  return { value: time.value, ambiguous: true };
}

function latestClarificationContext(task) {
  const history = Array.isArray(task?.recent_conversation) ? task.recent_conversation : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    let parsed = event?.parsed_intent || event?.parsedIntent || null;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }
    if (!parsed || typeof parsed !== "object") continue;
    return parsed.action === "clarify" ? parsed.clarification_context || null : null;
  }
  return null;
}

function replaceFirstTime(text, replacement) {
  const numeric = /(凌晨|上午|早上|中午|下午|晚上)?\s*\d{1,2}(?::\d{2}|点(?:(?:半)|\d{1,2}分?)?)/;
  const chinese = /(凌晨|上午|早上|中午|下午|晚上)?\s*[一二两三四五六七八九十]{1,3}点(?:(?:半)|[一二两三四五六七八九十]{1,3}分?)?/;
  return String(text || "").replace(numeric.test(String(text || "")) ? numeric : chinese, replacement);
}

function continueClarification(text, task, now) {
  const context = latestClarificationContext(task);
  if (!context) return null;
  const exact = exactText(text);
  if (context.kind === "time_period" && /^(?:凌晨|上午|早上|中午|下午|晚上)$/.test(exact)) {
    const candidate = String(context.candidate_time || "");
    if (!validTime(candidate)) return null;
    const [hour, minute] = candidate.split(":");
    const rewritten = replaceFirstTime(context.original_text, `${exact}${Number(hour)}:${minute}`);
    if (context.intent === "create_follow_up") return createFollowUp(rewritten, task, now);
    if (context.intent === "create_next_action") return createNextAction(rewritten, task, now);
    return timingProposal(rewritten, task, now, null);
  }
  return null;
}

function timingProposal(text, task, now, pending) {
  const parsedDate = parseConversationDate(text, now, taskTimezone(task));
  const parsedTime = parseConversationTime(text);
  const mentionsDate = DATE_WORD.test(text);
  const mentionsTime = TIME_WORD.test(text);
  const correction = Boolean(pending && (parsedDate || parsedTime));
  if (!UPDATE_CUE.test(text) && !correction) return null;
  if (!parsedDate && !parsedTime) {
    if (DEFER_CUE.test(text)) {
      return clarification("defer_task", "你想延期到哪一天？", "我知道你想延期，但还缺少具体日期。");
    }
    return clarification("unknown", "你想把这个任务改成什么日期或时间？", "我还没有识别出要修改的日期或时间。", 0.45);
  }

  const oldDate = currentDate(task);
  const oldTime = currentTime(task);
  const pendingDate = validDate(pending?.changes?.requested_date) ? pending.changes.requested_date : oldDate;
  const pendingTime = validTime(pending?.changes?.requested_time) ? pending.changes.requested_time : oldTime;
  const nextTimeResult = normalizedTime(parsedTime, task);
  const nextDate = parsedDate || pendingDate;
  const nextTime = parsedTime ? nextTimeResult.value : pendingTime;
  const tentativeIntent = DEFER_CUE.test(text)
    ? "defer_task"
    : parsedDate && parsedTime ? "update_datetime" : parsedDate ? "update_date" : "update_time";

  if (UNCERTAIN.test(text)) {
    const target = [parsedDate, nextTimeResult.value].filter(Boolean).join(" ");
    return clarification(
      tentativeIntent,
      target ? `时间确定后，是要改为 ${target} 吗？` : "时间确定后再告诉我具体日期或时间，可以吗？",
      "我听出时间可能发生变化，暂未修改正式任务。",
      0.78,
    );
  }
  if (mentionsTime && nextTimeResult.ambiguous) {
    return clarification(
      tentativeIntent,
      `你说的“${cleanText(text)}”是上午还是下午？`,
      "这个时间缺少上午或下午信息。",
      0.7,
      { kind: "time_period", intent: tentativeIntent, candidate_time: nextTimeResult.value, original_text: text },
    );
  }
  if (parsedTime && !nextDate) {
    return clarification(tentativeIntent, "这个时间是安排在哪一天？", "当前任务没有可沿用的日期。", 0.64);
  }
  if (mentionsDate && !parsedDate) {
    return clarification(tentativeIntent, "你想改到哪一个具体日期？", "日期表达还不能安全地落到某一天。", 0.62);
  }

  const changes = {};
  const proposedChanges = {};
  if (nextDate && nextDate !== oldDate) {
    changes.due = nextDate;
    changes.requested_date = nextDate;
    proposedChanges.date = { from: oldDate, to: nextDate };
  }
  if (nextTime && nextTime !== oldTime) {
    changes.requested_time = nextTime;
    proposedChanges.time = { from: oldTime, to: nextTime };
  }
  if (!Object.keys(changes).length) {
    return parserResult({
      intent: tentativeIntent,
      confidence: 0.96,
      action: "noop",
      message: `「${taskTitle(task)}」已经是这个日期和时间。`,
    });
  }
  const intent = DEFER_CUE.test(text)
    ? "defer_task"
    : Object.hasOwn(proposedChanges, "date") && Object.hasOwn(proposedChanges, "time")
      ? "update_datetime"
      : Object.hasOwn(proposedChanges, "date") ? "update_date" : "update_time";
  Object.assign(proposedChanges, reminderDiff(task, nextDate, nextTime));
  const summary = Object.entries(proposedChanges)
    .filter(([key]) => key === "date" || key === "time")
    .map(([key, diff]) => `${key === "date" ? "日期" : "时间"} ${diff.from || "未设置"} → ${diff.to}`)
    .join("，");
  return proposal(intent, changes, proposedChanges, `准备修改「${taskTitle(task)}」：${summary}。`);
}

function followUpTitle(text) {
  const afterReminder = String(text).match(/(?:提醒我|记得|到时候)\s*(.+?)(?:[。.!！]|$)/)?.[1];
  return cleanText(afterReminder)
    .replace(/^(?:去|再)/, "")
    .replace(/[，,。.!！]+$/g, "") || "跟进当前任务";
}

function contactFromTask(task) {
  return taskTitle(task).match(/^([\p{Script=Han}]{2,4}?)(?:过来|来|到|约|见面|聊天|开会)/u)?.[1] || null;
}

function nextActionTitle(text, task) {
  let value = cleanText(String(text).replace(/^.*?(?:聊完|完成|结束)(?:之后|以后|后)?\s*/, ""))
    .replace(/^(?:记得|要|需要|再|然后)\s*/, "")
    .replace(/[，,。.!！]+$/g, "");
  const send = value.match(/^把(.{1,40}?)发给(?:他|她|对方)$/);
  const contact = contactFromTask(task);
  if (send && contact) value = `给${contact}发送${send[1]}`;
  return value || "处理下一步";
}

function createFollowUp(text, task, now) {
  if (!/(?:提醒我|到时候).{0,40}(?:问|联系|确认|跟进|看看|查看|核实)/.test(text)) return null;
  const parsedTime = parseConversationTime(text);
  const parsedDate = parseConversationDate(text, now, taskTimezone(task)) || currentDate(task);
  const time = normalizedTime(parsedTime, task);
  if (parsedTime && time.ambiguous) {
    return clarification(
      "create_follow_up",
      "这个 Follow-up 是上午还是下午？",
      "Follow-up 的时间缺少上午或下午信息。",
      0.7,
      { kind: "time_period", intent: "create_follow_up", candidate_time: time.value, original_text: text },
    );
  }
  if (parsedTime && !parsedDate) {
    return clarification("create_follow_up", "这个 Follow-up 安排在哪一天？", "有具体时间，但没有可用日期。");
  }
  const title = followUpTitle(text);
  const id = taskId(task);
  const changes = {
    operation: "create",
    task_type: "follow_up",
    title,
    requested_date: parsedDate,
    requested_time: time.value,
    parent_task_id: id,
    follow_up_of: id,
  };
  const item = { title, date: parsedDate, time: time.value, parent_task_id: id };
  return proposal("create_follow_up", changes, { follow_up: { from: null, to: item } }, `准备创建 Follow-up「${title}」。`, 0.92);
}

function createNextAction(text, task, now) {
  if (!/(?:聊完|完成|结束)(?:之后|以后|后).{0,12}(?:记得|要|需要|再|然后)/.test(text)) return null;
  const title = nextActionTitle(text, task);
  const id = taskId(task);
  const date = parseConversationDate(text, now, taskTimezone(task));
  const parsedTime = parseConversationTime(text);
  const time = normalizedTime(parsedTime, task);
  if (parsedTime && time.ambiguous) {
    return clarification(
      "create_next_action",
      "下一步任务是上午还是下午？",
      "下一步任务的时间缺少上午或下午信息。",
      0.7,
      { kind: "time_period", intent: "create_next_action", candidate_time: time.value, original_text: text },
    );
  }
  const changes = {
    operation: "create",
    task_type: "task",
    title,
    requested_date: date,
    requested_time: time.value,
    parent_task_id: id,
    source_task_id: id,
  };
  return proposal("create_next_action", changes, {
    next_action: { from: null, to: { title, date, time: time.value, parent_task_id: id } },
  }, `准备创建下一步任务「${title}」。`, 0.91);
}

/**
 * Build the bounded context sent with a Task conversation turn. This function
 * only selects canonical fields; it does not fetch or mutate any data.
 */
export function buildTaskContext(task = {}, history = []) {
  const safeHistory = Array.isArray(history) ? history.slice(-20) : [];
  const schedule = task?.schedule && typeof task.schedule === "object" ? task.schedule : {};
  return {
    task_id: taskId(task),
    title: taskTitle(task),
    date: currentDate(task),
    time: currentTime(task),
    deadline: task?.deadline || schedule.deadline || null,
    reminder: schedule.reminders || schedule.reminder_at || task?.reminder || null,
    status: task?.status || null,
    notes: task?.notes || null,
    follow_up: {
      task_type: task?.task_type || schedule.task_type || "task",
      parent_task_id: task?.parent_task_id || schedule.parent_task_id || null,
      follow_up_of: task?.follow_up_of || schedule.follow_up_of || null,
    },
    recent_conversation: safeHistory,
    recent_task_history: safeHistory,
  };
}

/**
 * Deterministic, conservative fallback parser for Task-bound conversation.
 * It produces proposals only. External LLM interpretation and all execution,
 * persistence, semantic dedup, confirmation matching, and sync remain outside.
 */
export function parseConversationInput({ text, task = {}, pending = null, now } = {}) {
  const raw = cleanText(text);
  const exact = exactText(raw);
  const pendingValue = pendingProposal(pending);

  if (!raw) return clarification("unknown", "你想补充或修改什么？", "没有收到可处理的内容。", 0);

  if (CONFIRMATIONS.has(exact)) {
    if (!pendingValue) return clarification("confirm", "你想确认哪一项修改？", "当前没有待确认的修改。", 0.99);
    return parserResult({
      intent: "confirm",
      confidence: 0.99,
      proposedChanges: pendingValue.proposed_changes || {},
      action: "confirm",
      changes: pendingValue.changes || {},
      message: `已确认对「${taskTitle(task)}」的待执行修改。`,
    });
  }
  if (DISCARDS.has(exact)) {
    return parserResult({
      intent: "discard",
      confidence: 0.99,
      action: pendingValue ? "discard" : "noop",
      message: pendingValue ? "已放弃这次待确认修改。" : "当前没有待确认的修改。",
    });
  }
  if (pendingValue && REJECTIONS.has(exact)) {
    return clarification("correction", "那应该改成什么日期或时间？", "旧的修改方案不会执行。", 0.99);
  }

  const clarificationContinuation = continueClarification(raw, task, now);
  if (clarificationContinuation) return clarificationContinuation;

  const nextAction = createNextAction(raw, task, now);
  if (nextAction) return nextAction;
  const followUp = createFollowUp(raw, task, now);
  if (followUp) return followUp;

  if (/^(?:已经)?(?:聊完|做完|完成|办完|处理完)(?:了)?[。.!！]*$/.test(raw)) {
    const from = task?.status || "open";
    if (["completed", "done"].includes(from)) {
      return parserResult({ intent: "complete_task", confidence: 0.98, action: "noop", message: `「${taskTitle(task)}」已经完成。` });
    }
    return proposal("complete_task", { status: "completed" }, { status: { from, to: "completed" } }, `是否完成「${taskTitle(task)}」？`, 0.97);
  }
  if (/(?:^|[，,])(?:不约了|不用约了|取消(?:这个|该)?任务|删掉(?:这个|该)?任务|删除(?:这个|该)?任务)[。.!！]*$/.test(raw)) {
    const from = task?.status || "open";
    return proposal("cancel_task", { status: "cancelled" }, { status: { from, to: "cancelled" } }, `是否取消「${taskTitle(task)}」？取消后仍保留历史。`, 0.96);
  }

  const timing = timingProposal(raw, task, now, pendingValue);
  if (timing) return timing;
  if (DEFER_CUE.test(raw)) {
    return clarification("defer_task", "你想延期到哪一个具体日期？", "我知道你想延期，但不会猜具体日期。", 0.76);
  }

  if (/[?？]$/.test(raw)) {
    return parserResult({
      intent: "unknown",
      confidence: 0.55,
      ambiguity: true,
      clarificationQuestion: "你希望我修改任务，还是只回答这个问题？",
      action: "clarify",
      message: "这句话看起来像问题，没有生成任务修改。",
    });
  }

  const explicitContext = /^(?:补充(?:一下)?|备注|记录(?:一下)?|记一下)[：:，,\s]/.test(raw);
  const factualContext = /^(?:他|她|他们|她们)(?:会带|将带|这次主要|会在|可能[零〇一二两三四五六七八九十\d]+点才到)/.test(raw);
  if (!explicitContext && !factualContext) {
    return clarification("unknown", "请明确说要修改什么；补充信息可以说“补充一下，……”", "预览版暂未理解这句话，任务没有修改。", 0.3);
  }

  return parserResult({
    intent: "append_context",
    confidence: 0.84,
    proposedChanges: { context: { from: null, to: raw } },
    action: "append_context",
    changes: { notes_append: raw },
    message: `已识别为对「${taskTitle(task)}」的补充信息。`,
  });
}
