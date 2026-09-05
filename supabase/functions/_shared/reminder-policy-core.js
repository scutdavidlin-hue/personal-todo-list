const MAX_REMINDER_OFFSET_MINUTES = 40_320;
const MAX_REMINDERS = 3;
const VALID_POLICY = new Set(["none", "smart", "custom"]);
const VALID_SOURCE = new Set(["user_explicit", "ai_inferred", "system_default"]);
const VALID_TYPE = new Set(["preparation", "departure", "event"]);
const VALID_CHANNEL = new Set(["google_calendar_popup", "google_calendar_email"]);
const VALID_TASK_KIND = new Set(["todo", "meeting", "flight", "train", "follow_up", "deadline"]);

const ACTION_PATTERNS = [
  ["起床", /起床/],
  ["吃早餐", /(?:吃(?:完)?早餐|早餐)/],
  ["运动", /(?:运动|健身|跑步)/],
  ["洗漱", /洗漱/],
  ["换衣服", /(?:换衣服|换衣)/],
  ["准备材料", /(?:准备|整理|携带|带上?).{0,8}(?:材料|文件|资料|证件)/],
  ["准备设备", /(?:准备|检查|携带|带上?).{0,8}(?:电脑|设备|充电器|相机|麦克风)/],
  ["收拾行李", /(?:收拾|整理|托运).{0,6}行李|行李/],
];

const ACTION_MINUTES = {
  起床: 15,
  吃早餐: 25,
  运动: 35,
  洗漱: 15,
  换衣服: 15,
  准备材料: 30,
  准备设备: 20,
  收拾行李: 30,
};

function first(input, ...keys) {
  for (const key of keys) {
    if (Object.hasOwn(input, key) && input[key] !== undefined && input[key] !== null && input[key] !== "") return input[key];
  }
  return null;
}

function explicitBoolean(input, ...keys) {
  for (const key of keys) {
    if (Object.hasOwn(input, key) && typeof input[key] === "boolean") return input[key];
  }
  return undefined;
}

function integerInRange(value, name, min = 0, max = MAX_REMINDER_OFFSET_MINUTES) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return number;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function localDateTime(date, time) {
  return validDate(date) && validTime(time) ? `${date}T${time}` : null;
}

function shiftWallClock(date, time, minutes) {
  const value = new Date(`${date}T${time}:00Z`);
  value.setUTCMinutes(value.getUTCMinutes() + minutes);
  return value.toISOString().slice(0, 16);
}

function wallClockMinutes(value) {
  const parsed = Date.parse(`${value}:00Z`);
  return Number.isFinite(parsed) ? Math.round(parsed / 60_000) : null;
}

function clock(period, hourValue, minuteValue = 0) {
  let hour = Number(hourValue);
  const minute = Number(minuteValue || 0);
  if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseExplicitReminderClock(text) {
  const value = String(text || "");
  const before = value.match(/(上午|早上|中午|下午|晚上)?\s*(\d{1,2})(?::(\d{2})|点(?:(\d{1,2})分)?)\s*(?:提醒(?:我)?|通知(?:我)?|叫我)/);
  if (before) return clock(before[1] || "", before[2], before[3] || before[4] || 0);
  const after = value.match(/(?:提醒(?:我)?|通知(?:我)?|叫我)\s*(?:在|到)?\s*(上午|早上|中午|下午|晚上)?\s*(\d{1,2})(?::(\d{2})|点(?:(\d{1,2})分)?)/);
  return after ? clock(after[1] || "", after[2], after[3] || after[4] || 0) : null;
}

function parseExplicitOffset(text) {
  const match = String(text || "").match(/提前\s*(\d+(?:\.\d+)?)\s*(个?小时|分钟)(?:左右)?\s*(?:提醒|通知|叫)/);
  if (!match) return null;
  const amount = Number(match[1]);
  const minutes = match[2].includes("小时") ? Math.round(amount * 60) : Math.round(amount);
  return integerInRange(minutes, "reminder_offset_minutes");
}

function normalizeAt(value, anchorDate, anchorTime) {
  if (!value) return null;
  const text = String(value).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(text)) return text.slice(0, 16);
  if (!validTime(text)) throw new Error("reminder_at must be HH:MM or YYYY-MM-DDTHH:MM");
  const sameDay = localDateTime(anchorDate, text);
  if (!sameDay) throw new Error("A timed reminder requires an event date and time");
  return text > anchorTime ? shiftWallClock(anchorDate, text, -24 * 60) : sameDay;
}

function offsetFromAt(anchorAt, reminderAt) {
  const anchor = wallClockMinutes(anchorAt);
  const reminder = wallClockMinutes(reminderAt);
  if (anchor === null || reminder === null) throw new Error("Invalid reminder date-time");
  return integerInRange(anchor - reminder, "reminder_offset_minutes");
}

function reminderAt(anchorAt, offsetMinutes) {
  const [date, time] = anchorAt.split("T");
  return shiftWallClock(date, time, -offsetMinutes);
}

function reminderAnchor(input) {
  const scheduledDate = first(input, "scheduled_date", "scheduledDate", "requested_date", "requestedDate");
  const scheduledStart = String(first(input, "scheduled_start", "scheduledStart", "requested_time", "requestedTime") || "").slice(0, 5);
  if (validDate(scheduledDate) && validTime(scheduledStart)) {
    return { kind: "execution", date: scheduledDate, time: scheduledStart, at: localDateTime(scheduledDate, scheduledStart) };
  }
  const deadline = first(input, "deadline");
  const deadlineTime = String(first(input, "deadline_time", "deadlineTime") || "").slice(0, 5);
  if (validDate(deadline) && validTime(deadlineTime)) {
    return { kind: "deadline", date: deadline, time: deadlineTime, at: localDateTime(deadline, deadlineTime) };
  }
  return null;
}

function extractActions(text) {
  return ACTION_PATTERNS
    .map(([action, pattern]) => ({ action, index: String(text).search(pattern) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index)
    .map(({ action }) => action);
}

function normalizedActions(input, text) {
  const supplied = first(input, "pre_event_actions", "preEventActions");
  if (Array.isArray(supplied)) {
    return [...new Set(supplied.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 20);
  }
  return extractActions(text);
}

function inferTransportation(input, text) {
  const supplied = String(first(input, "transportation", "transport_mode", "transportMode") || "").trim().toLowerCase();
  if (supplied) return ({ subway: "metro", car: "drive", driving: "drive", walking: "walk", bicycle: "bike", cycling: "bike" })[supplied] || supplied;
  if (/(?:地铁|轨道交通)/.test(text)) return "metro";
  if (/(?:公交|巴士)/.test(text)) return "bus";
  if (/(?:打车|出租车|网约车)/.test(text)) return "taxi";
  if (/(?:开车|驾车|自驾)/.test(text)) return "drive";
  if (/(?:骑车|骑行|自行车)/.test(text)) return "bike";
  if (/(?:步行|走路)/.test(text)) return "walk";
  if (/(?:高铁|动车|火车)/.test(text)) return "train";
  if (/(?:飞机|航班|机场|起飞|登机)/.test(text)) return "airport";
  if (/(?:出门|出发|前往|过去|去(?:公司|机场|车站|医院|学校|现场)|到(?:公司|机场|车站|现场))/.test(text)) return "transit";
  return "none";
}

function inferredTravelMinutes(transportation) {
  const known = { metro: 60, bus: 60, taxi: 45, drive: 45, bike: 30, walk: 20, train: 45, airport: 60, transit: 45 };
  return known[transportation] ?? (transportation === "none" ? 0 : 45);
}

function inferredPreparationMinutes(actions, kind) {
  const actionTotal = actions.reduce((total, action) => total + (ACTION_MINUTES[action] || 15), 0);
  if (actionTotal) return Math.min(180, actionTotal);
  if (kind === "flight") return 45;
  if (kind === "train") return 30;
  if (kind === "meeting") return 30;
  return 20;
}

function inferredSafetyBuffer(kind, needTravel) {
  if (kind === "flight") return 120;
  if (kind === "train") return 45;
  if (needTravel) return 30;
  if (kind === "meeting") return 15;
  return 10;
}

function roundUp(value, step = 5) {
  return Math.ceil(Math.max(0, value) / step) * step;
}

function taskKind(text, anchorKind) {
  if (anchorKind === "deadline") return "deadline";
  if (/(?:飞机|航班|机场|起飞|登机|值机|安检)/.test(text)) return "flight";
  if (/(?:高铁|动车|火车|火车站|高铁站)/.test(text)) return "train";
  if (/(?:会议|开会|见面|会面|面谈|拜访|聊天|约见|到公司)/.test(text)) return "meeting";
  if (/(?:跟进|回访|回复|联系)/.test(text)) return "follow_up";
  return "todo";
}

function normalizeSpec(item, anchor, fallbackType = "preparation") {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each reminder must be an object");
  const at = normalizeAt(first(item, "at", "reminder_at", "reminderAt"), anchor.date, anchor.time);
  const suppliedOffset = integerInRange(first(item, "offset_minutes", "offsetMinutes", "reminder_offset_minutes", "reminderOffsetMinutes"), "reminder_offset_minutes");
  const offset = suppliedOffset ?? (at ? offsetFromAt(anchor.at, at) : null);
  if (offset === null) throw new Error("Each reminder requires at or offset_minutes");
  const type = String(first(item, "type", "reminder_type", "reminderType") || fallbackType);
  if (!VALID_TYPE.has(type)) throw new Error("reminder_type must be preparation, departure, or event");
  return { type, offset_minutes: offset, at: reminderAt(anchor.at, offset) };
}

function uniqueSpecs(specs) {
  const seen = new Set();
  const result = [];
  for (const spec of [...specs].sort((left, right) => right.offset_minutes - left.offset_minutes)) {
    if (seen.has(spec.offset_minutes)) continue;
    seen.add(spec.offset_minutes);
    result.push(spec);
  }
  return result.slice(0, MAX_REMINDERS);
}

function reasonFor(context) {
  if (context.task_kind === "deadline") return "需要在截止时间前启动执行并进行临近截止确认";
  const parts = [];
  if (context.pre_event_actions.length) parts.push(context.pre_event_actions.join("、"));
  else if (context.need_preparation) parts.push("提前准备");
  if (context.need_travel) {
    const label = ({ metro: "地铁通勤", bus: "公交通勤", taxi: "打车通勤", drive: "驾车通勤", bike: "骑行", walk: "步行", train: "前往车站", airport: "前往机场", transit: "通勤" })[context.transportation] || "通勤";
    parts.push(label);
  }
  if (context.safety_buffer_minutes) parts.push(`${context.safety_buffer_minutes}分钟缓冲`);
  return parts.length ? `需要${parts.join("、")}` : "固定时间事项需要在开始前推动下一步行动";
}

function policyResult({ policy, source, reason, specs, context, channel, disabled = false }) {
  const reminders = uniqueSpecs(specs);
  const primary = reminders[0] || null;
  return {
    reminder_policy: policy,
    reminder_policy_source: source,
    reminder_reason: reason || null,
    reminder_at: primary?.at || null,
    reminder_offset_minutes: primary?.offset_minutes ?? null,
    reminder_type: primary?.type || null,
    reminders,
    reminder_context: context,
    notification_channel: channel,
    notification_status: disabled ? "disabled" : reminders.length ? "pending_projection" : "not_required",
  };
}

export function mergeReminderPolicyUpdate(current = {}, update = {}) {
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("current reminder state must be an object");
  if (!update || typeof update !== "object" || Array.isArray(update)) throw new Error("reminder update must be an object");
  const directReminderKeys = [
    "reminder_at",
    "reminderAt",
    "reminder_offset_minutes",
    "reminderOffsetMinutes",
    "explicit_reminder_at",
    "explicitReminderAt",
    "explicit_reminder_offset_minutes",
    "explicitReminderOffsetMinutes",
    "reminder_policy",
    "reminderPolicy",
    "reminders",
  ];
  const contextKeys = [
    "raw_text",
    "need_preparation",
    "needPreparation",
    "need_travel",
    "needTravel",
    "preparation_minutes",
    "preparationMinutes",
    "travel_minutes",
    "travelMinutes",
    "safety_buffer_minutes",
    "safetyBufferMinutes",
    "transportation",
    "pre_event_actions",
    "preEventActions",
  ];
  const directReminderUpdate = directReminderKeys.some((key) => Object.hasOwn(update, key));
  const contextualSmartUpdate = contextKeys.some((key) => Object.hasOwn(update, key))
    && (update.reminder_policy === "smart" || (!update.reminder_policy && current.reminder_policy === "smart"));
  const replacesReminderSpecs = directReminderUpdate || contextualSmartUpdate;
  const sourceOverride = update.reminder_policy_source
    || (update.reminder_policy === "smart" ? "ai_inferred" : directReminderUpdate ? "user_explicit" : current.reminder_policy_source);
  return {
    ...current,
    ...(replacesReminderSpecs ? {
      reminder_at: null,
      reminder_offset_minutes: null,
      reminder_type: null,
      reminders: [],
    } : {}),
    ...update,
    ...(sourceOverride ? { reminder_policy_source: sourceOverride } : {}),
  };
}

export function resolveReminderPolicy(input = {}, { preserveReminderPolicy = false } = {}) {
  const text = [first(input, "raw_text", "rawText", "originalIntent"), first(input, "title"), first(input, "notes")]
    .filter(Boolean)
    .join("。 ");
  const anchor = reminderAnchor(input);
  const existingContext = input.reminder_context && typeof input.reminder_context === "object" && !Array.isArray(input.reminder_context)
    ? input.reminder_context
    : input.reminderContext && typeof input.reminderContext === "object" && !Array.isArray(input.reminderContext)
      ? input.reminderContext
      : {};
  const storedKind = String(existingContext.task_kind || "");
  const inferredKind = taskKind(text, anchor?.kind);
  const kind = anchor?.kind === "deadline"
    ? "deadline"
    : inferredKind !== "todo" ? inferredKind : VALID_TASK_KIND.has(storedKind) ? storedKind : inferredKind;
  const directActions = first(input, "pre_event_actions", "preEventActions");
  const storedActions = Array.isArray(existingContext.pre_event_actions) ? existingContext.pre_event_actions : [];
  const textActions = extractActions(text);
  const actions = Array.isArray(directActions)
    ? normalizedActions(input, text)
    : [...new Set([...storedActions, ...textActions].map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 20);
  const suppliedTransportation = String(first(input, "transportation", "transport_mode", "transportMode") || "").trim();
  const storedTransportation = String(existingContext.transportation || "").trim();
  const textTransportation = inferTransportation({}, text);
  const suppliedMode = suppliedTransportation ? inferTransportation({ transportation: suppliedTransportation }, "") : "";
  const effectiveTransportation = suppliedMode
    || (textTransportation !== "none" && textTransportation !== "transit" ? textTransportation : "")
    || (storedTransportation && storedTransportation !== "none" ? storedTransportation : "")
    || textTransportation;
  const inferredTravel = effectiveTransportation !== "none";
  const requestedNeedTravel = explicitBoolean(input, "need_travel", "needTravel");
  const requestedNeedPreparation = explicitBoolean(input, "need_preparation", "needPreparation");
  const storedNeedTravel = typeof existingContext.need_travel === "boolean" ? existingContext.need_travel : undefined;
  const storedNeedPreparation = typeof existingContext.need_preparation === "boolean" ? existingContext.need_preparation : undefined;
  const hasExplicitTravelText = textTransportation !== "none" && textTransportation !== "transit";
  const needTravel = requestedNeedTravel ?? (hasExplicitTravelText ? true : storedNeedTravel ?? inferredTravel);
  const immediateAction = /(?:吃药|服药|喝水|签到|打卡|闹钟)/.test(text);
  const looksLikePreparation = actions.length > 0 || /(?:准备|携带|材料|设备|行李|提前到)/.test(text);
  const hasExplicitPreparationText = textActions.length > 0 || /(?:准备|携带|材料|设备|行李|提前到)/.test(text);
  const fixedTime = input.fixed_time === true || input.fixedTime === true || first(input, "scheduling_source", "schedulingSource") === "explicit_user";
  const inferredNeedPreparation = kind === "flight" || kind === "train" || kind === "meeting" || looksLikePreparation || (fixedTime && !immediateAction);
  const needPreparation = requestedNeedPreparation ?? (hasExplicitPreparationText ? true : storedNeedPreparation ?? inferredNeedPreparation);
  const travelMinutes = integerInRange(first(input, "travel_minutes", "travelMinutes") ?? existingContext.travel_minutes, "travel_minutes", 0, 1_440) ?? inferredTravelMinutes(effectiveTransportation);
  const preparationMinutes = integerInRange(first(input, "preparation_minutes", "preparationMinutes") ?? existingContext.preparation_minutes, "preparation_minutes", 0, 1_440) ?? inferredPreparationMinutes(actions, kind);
  const safetyBufferMinutes = integerInRange(first(input, "safety_buffer_minutes", "safetyBufferMinutes") ?? existingContext.safety_buffer_minutes, "safety_buffer_minutes", 0, 1_440) ?? inferredSafetyBuffer(kind, needTravel);
  const context = {
    task_kind: kind,
    anchor_kind: anchor?.kind || "none",
    need_preparation: needPreparation,
    need_travel: needTravel,
    transportation: effectiveTransportation,
    preparation_minutes: needPreparation ? preparationMinutes : 0,
    travel_minutes: needTravel ? travelMinutes : 0,
    safety_buffer_minutes: safetyBufferMinutes,
    pre_event_actions: actions,
  };
  const channel = String(first(input, "notification_channel", "notificationChannel") || "google_calendar_popup");
  if (!VALID_CHANNEL.has(channel)) throw new Error("notification_channel is invalid");
  const suppliedSource = String(first(input, "reminder_policy_source", "reminderPolicySource") || "");
  if (suppliedSource && !VALID_SOURCE.has(suppliedSource)) throw new Error("reminder_policy_source is invalid");
  const suppliedPolicy = String(first(input, "reminder_policy", "reminderPolicy") || "");
  if (suppliedPolicy && !VALID_POLICY.has(suppliedPolicy)) throw new Error("reminder_policy is invalid");
  const suppliedReason = String(first(input, "reminder_reason", "reminderReason") || "").trim() || null;
  const suppliedReminders = first(input, "reminders");

  // A task-bound preview authorizes a timing change, not a new reminder policy.
  // Projection also uses this path so repeated normalization cannot add alerts.
  if (preserveReminderPolicy) {
    const storedAt = first(input, "reminder_at", "reminderAt");
    const storedOffset = first(input, "reminder_offset_minutes", "reminderOffsetMinutes");
    const existing = suppliedPolicy === "none" ? []
      : Array.isArray(suppliedReminders) && suppliedReminders.length ? suppliedReminders
      : storedAt !== null || storedOffset !== null
        ? [{ at: storedAt, offset_minutes: storedOffset, type: first(input, "reminder_type", "reminderType") || "preparation" }]
        : [];
    const specs = anchor ? existing.map((item) => normalizeSpec(item, anchor)) : [];
    return policyResult({
      policy: suppliedPolicy || "none",
      source: suppliedSource || "system_default",
      reason: suppliedReason,
      specs,
      context,
      channel,
      disabled: suppliedPolicy === "none" && input.notification_status === "disabled",
    });
  }

  const disabledByText = /(?:不用|不要|无需|取消)(?:再)?提醒|别提醒/.test(text);
  const disabledByInput = suppliedPolicy === "none" && suppliedSource !== "system_default";
  if (disabledByText || disabledByInput) {
    return policyResult({ policy: "none", source: "user_explicit", reason: suppliedReason || "用户明确要求不提醒", specs: [], context, channel, disabled: true });
  }

  const explicitAt = first(input, "explicit_reminder_at", "explicitReminderAt")
    || ((!Array.isArray(suppliedReminders) || !suppliedReminders.length) ? first(input, "reminder_at", "reminderAt") : null);
  const explicitOffset = first(input, "explicit_reminder_offset_minutes", "explicitReminderOffsetMinutes")
    ?? ((!Array.isArray(suppliedReminders) || !suppliedReminders.length) ? first(input, "reminder_offset_minutes", "reminderOffsetMinutes") : null);
  const reminderClock = parseExplicitReminderClock(text);
  const textOffset = parseExplicitOffset(text);
  const explicitType = String(first(input, "reminder_type", "reminderType") || "preparation");
  if (!VALID_TYPE.has(explicitType)) throw new Error("reminder_type must be preparation, departure, or event");

  if (explicitAt !== null || explicitOffset !== null || reminderClock || textOffset !== null) {
    if (!anchor) throw new Error("An explicit reminder requires a scheduled or deadline time");
    const spec = normalizeSpec({
      type: explicitType,
      at: explicitAt || reminderClock,
      offset_minutes: explicitOffset ?? textOffset,
    }, anchor, explicitType);
    return policyResult({ policy: "custom", source: "user_explicit", reason: suppliedReason || "用户明确指定提醒时间", specs: [spec], context, channel });
  }

  if (Array.isArray(suppliedReminders) && suppliedReminders.length) {
    if (!anchor) throw new Error("Reminder overrides require a scheduled or deadline time");
    if (suppliedReminders.length > MAX_REMINDERS) throw new Error(`reminders supports at most ${MAX_REMINDERS} entries`);
    const specs = suppliedReminders.map((item) => normalizeSpec(item, anchor));
    const source = suppliedSource || (suppliedPolicy === "custom" ? "user_explicit" : "ai_inferred");
    const policy = source === "user_explicit"
      ? "custom"
      : suppliedPolicy && suppliedPolicy !== "none" ? suppliedPolicy : "smart";
    return policyResult({ policy, source, reason: suppliedReason || reasonFor(context), specs, context, channel });
  }

  if (suppliedPolicy === "custom") {
    throw new Error("A custom reminder policy requires reminder_at, reminder_offset_minutes, or reminders");
  }

  if (!anchor) {
    return policyResult({ policy: "none", source: suppliedSource || "system_default", reason: suppliedReason, specs: [], context, channel });
  }

  const wantsEarlyReminder = /(?:早点|提前|预留时间|别让我迟到)/.test(text);
  const shouldInfer = anchor.kind === "deadline" || fixedTime || wantsEarlyReminder || kind === "follow_up";
  if (!shouldInfer) {
    return policyResult({ policy: "none", source: "system_default", reason: null, specs: [], context, channel });
  }

  const specs = [];
  if (anchor.kind === "deadline") {
    const duration = integerInRange(first(input, "duration_minutes", "durationMinutes", "estimated_duration", "estimatedDuration"), "duration_minutes", 5, 720) || 30;
    specs.push(normalizeSpec({ type: "preparation", offset_minutes: roundUp(Math.max(60, duration + 30)) }, anchor));
    specs.push(normalizeSpec({ type: "event", offset_minutes: 15 }, anchor, "event"));
  } else if (immediateAction && !needTravel && !actions.length) {
    specs.push(normalizeSpec({ type: "event", offset_minutes: 0 }, anchor, "event"));
  } else {
    const departureOffset = roundUp((needTravel ? travelMinutes : 0) + safetyBufferMinutes);
    const preparationOffset = roundUp((needPreparation ? preparationMinutes : 0) + departureOffset);
    if (needPreparation) specs.push(normalizeSpec({ type: "preparation", offset_minutes: Math.max(5, preparationOffset) }, anchor));
    if (needTravel && (!needPreparation || preparationOffset - departureOffset >= 15)) {
      specs.push(normalizeSpec({ type: "departure", offset_minutes: Math.max(5, departureOffset) }, anchor, "departure"));
    }
    if (!specs.length) specs.push(normalizeSpec({ type: "event", offset_minutes: 0 }, anchor, "event"));
  }

  return policyResult({ policy: "smart", source: "ai_inferred", reason: suppliedReason || reasonFor(context), specs, context, channel });
}

export function calendarReminderOverrides(schedule = {}) {
  const reminders = Array.isArray(schedule.reminders) ? schedule.reminders : [];
  const method = schedule.notification_channel === "google_calendar_email" ? "email" : "popup";
  return uniqueSpecs(reminders
    .map((item) => ({
      type: VALID_TYPE.has(item?.type) ? item.type : "event",
      offset_minutes: integerInRange(item?.offset_minutes, "reminder_offset_minutes"),
      at: item?.at || null,
    }))
    .filter((item) => item.offset_minutes !== null))
    .map((item) => ({ method, minutes: item.offset_minutes }));
}

export function reminderActionGuidance(task, schedule = {}) {
  const reminders = Array.isArray(schedule.reminders) ? schedule.reminders : [];
  if (!reminders.length) return "";
  const context = schedule.reminder_context && typeof schedule.reminder_context === "object" ? schedule.reminder_context : {};
  const title = String(task?.title || "该事项").trim();
  const anchor = reminderAnchor(schedule);
  const when = anchor ? `${anchor.date} ${anchor.time}` : "约定时间";
  const actions = Array.isArray(context.pre_event_actions) ? context.pre_event_actions.filter(Boolean) : [];
  let instruction = actions.length ? `${actions.join("、")}后，` : "";
  if (context.task_kind === "flight") instruction += "预留前往机场、值机、安检和行李时间。";
  else if (context.task_kind === "train") instruction += "预留前往车站、取票和进站时间。";
  else if (context.need_travel) {
    const transport = ({ metro: "自己坐地铁过去", bus: "乘公交过去", taxi: "打车过去", drive: "驾车过去", bike: "骑车过去", walk: "步行过去", transit: "提前出发" })[context.transportation] || "提前出发";
    instruction += `记得${transport}，预留通勤时间。`;
  } else if (context.task_kind === "deadline") instruction += "提前开始执行，并在截止前确认完成。";
  else instruction += "按提醒开始准备。";
  return `${when} ${title}。${instruction}`;
}

export function reminderNotificationCue(schedule = {}) {
  const reminders = Array.isArray(schedule.reminders) ? schedule.reminders : [];
  if (!reminders.length) return "";
  const context = schedule.reminder_context && typeof schedule.reminder_context === "object" ? schedule.reminder_context : {};
  const actions = Array.isArray(context.pre_event_actions)
    ? context.pre_event_actions.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4)
    : [];
  const parts = actions.length ? [`${actions.join("、")}后`] : [];
  if (context.task_kind === "flight") parts.push("预留机场值机、安检和行李时间");
  else if (context.task_kind === "train") parts.push("预留前往车站和进站时间");
  else if (context.need_travel) {
    const travel = ({
      metro: "自己坐地铁过去并预留通勤时间",
      bus: "乘公交过去并预留通勤时间",
      taxi: "打车过去并预留通勤时间",
      drive: "驾车过去并预留通勤时间",
      bike: "骑车过去并预留通勤时间",
      walk: "步行过去并预留通勤时间",
      transit: "提前出发并预留通勤时间",
    })[context.transportation] || "提前出发并预留通勤时间";
    parts.push(travel);
  } else if (context.task_kind === "deadline") parts.push("提前执行并在截止前确认");
  else if (context.need_preparation) parts.push("提前开始准备");
  else parts.push("按时执行");
  return parts.join("，").slice(0, 100);
}

export function reminderProjectionFields(policy) {
  return {
    reminder_policy: policy.reminder_policy,
    reminder_policy_source: policy.reminder_policy_source,
    reminder_reason: policy.reminder_reason,
    reminder_at: policy.reminder_at,
    reminder_offset_minutes: policy.reminder_offset_minutes,
    reminder_type: policy.reminder_type,
    reminders: policy.reminders,
    reminder_context: policy.reminder_context,
    notification_channel: policy.notification_channel,
    notification_status: policy.notification_status,
  };
}
