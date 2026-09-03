const TASK_VERBS = /(?:完成|处理|联系|购买|买|整理|检查|登录|修改|跟进|报销|收拾|准备|验收|提交|确认|回复|发送|预约|提醒)/;
const CALENDAR_NOUNS = /(?:飞机|航班|高铁|火车|会议|开会|面谈|看电影|医院预约|行程|出发|抵达|纪念日|婚礼|课程)/;
const PROJECT_DATA_PATTERNS = /(?:可以对接|客户资源|客户线索|项目资料|合作方|供应商|联系人|商机)/;
const WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateWithOffset(base, days) {
  const result = new Date(base);
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() + days);
  return localDate(result);
}

function nextWeekday(base, weekday) {
  const delta = (weekday - base.getDay() + 7) % 7;
  return dateWithOffset(base, delta);
}

export function parseIntentDate(text, baseDate = new Date()) {
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const full = text.match(/(20\d{2})年(\d{1,2})月(\d{1,2})[日号]?/);
  if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
  const short = text.match(/(?:^|\D)(\d{1,2})月(\d{1,2})[日号]?/);
  if (short) return `${baseDate.getFullYear()}-${short[1].padStart(2, "0")}-${short[2].padStart(2, "0")}`;
  if (text.includes("后天")) return dateWithOffset(baseDate, 2);
  if (text.includes("明天")) return dateWithOffset(baseDate, 1);
  if (text.includes("今天")) return dateWithOffset(baseDate, 0);
  if (text.includes("下周末")) return dateWithOffset(baseDate, ((0 - baseDate.getDay() + 7) % 7) + 7);
  const nextWeekdayMatch = text.match(/下周([一二三四五六日天])/);
  if (nextWeekdayMatch) return dateWithOffset(baseDate, ((WEEKDAYS[nextWeekdayMatch[1]] - baseDate.getDay() + 7) % 7) + 7);
  const weekday = text.match(/(?:周|星期)([一二三四五六日天])/);
  if (weekday) return nextWeekday(baseDate, WEEKDAYS[weekday[1]]);
  return null;
}

export function parseIntentTime(text) {
  const colon = text.match(/(?:上午|早上|中午|下午|晚上)?\s*(\d{1,2}):(\d{2})/);
  const point = text.match(/(上午|早上|中午|下午|晚上)?\s*(\d{1,2})点(?:(\d{1,2})分)?/);
  const match = colon || point;
  if (!match) return null;
  const period = point ? match[1] || "" : text.slice(Math.max(0, match.index - 2), match.index);
  let hour = Number(point ? match[2] : match[1]);
  const minute = Number(point ? match[3] || 0 : match[2]);
  if ((period.includes("下午") || period.includes("晚上")) && hour < 12) hour += 12;
  if (period.includes("中午") && hour < 11) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function cleanTitle(text) {
  return String(text)
    .replace(/20\d{2}[-年]\d{1,2}[-月]\d{1,2}[日号]?/g, "")
    .replace(/\d{1,2}月\d{1,2}[日号]?/g, "")
    .replace(/(?:今天|明天|后天|本周|这周|下周末|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天])/g, "")
    .replace(/(?:上午|早上|中午|下午|晚上)?\s*\d{1,2}(?::\d{2}|点(?:\d{1,2}分)?)/g, "")
    .replace(/^(?:请|麻烦)?(?:提醒我|记得)/, "")
    .replace(/[，,。.!！?？]+$/g, "")
    .trim();
}

function calendarPayload(text, dueDate, time) {
  const title = cleanTitle(text) || text.trim();
  return {
    title,
    date: dueDate,
    time,
    start: dueDate && time ? `${dueDate}T${time}:00+08:00` : null,
    originalIntent: text.trim(),
  };
}

function taskPayload(text, dueDate) {
  return {
    title: cleanTitle(text) || text.trim(),
    notes: "",
    dueDate,
    originalIntent: text.trim(),
    priority: "medium",
  };
}

export function classifyAction(input, options = {}) {
  const text = String(input || "").trim();
  if (!text) throw new Error("input is required");
  const baseDate = options.baseDate ? new Date(options.baseDate) : new Date();
  const dueDate = parseIntentDate(text, baseDate);
  const time = parseIntentTime(text);

  if (PROJECT_DATA_PATTERNS.test(text) && !time) {
    return { type: "project_data", confidence: 0.92, payload: { content: text, originalIntent: text } };
  }
  if (CALENDAR_NOUNS.test(text) && (time || dueDate)) {
    return { type: "calendar_event", confidence: time ? 0.99 : 0.9, payload: calendarPayload(text, dueDate, time) };
  }
  if (time && !TASK_VERBS.test(text)) {
    return { type: "calendar_event", confidence: 0.86, payload: calendarPayload(text, dueDate, time) };
  }
  if (TASK_VERBS.test(text)) {
    return { type: "task", confidence: dueDate ? 0.97 : 0.9, payload: taskPayload(text, dueDate) };
  }
  return { type: "note", confidence: 0.62, payload: { content: text, originalIntent: text } };
}
