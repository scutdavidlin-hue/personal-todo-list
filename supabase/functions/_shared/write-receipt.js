/** Evidence-based receipt. Provider configuration never proves device delivery.
 * @param {{requestId?: string|null, taskId?: string|null, taskVerified?: boolean, schedule?: any, scheduleRequested?: boolean, projection?: any, error?: any, checkedAt?: string}} options
 */
export function writeReceipt({ requestId = null, taskId = null, taskVerified = false, schedule = null, scheduleRequested = false, projection = null, error = null, checkedAt = new Date().toISOString() } = {}) {
  const p = projection?.projection || projection;
  const failed = Boolean(error || projection?.success === false || projection?.sync_required === true || p?.sync_required === true);
  const configured = !failed && p?.projected === true && Boolean(p?.verified_at) && p?.notification_status === 'projected' && p?.reminders?.length > 0;
  const disabled = p?.notification_status === 'disabled' || p?.reminder_policy === 'none' || schedule?.reminder_policy === 'none';
  const noReminder = p?.notification_status === 'not_required';
  const scheduled = Boolean(scheduleRequested || schedule?.scheduled_start || schedule?.deadline_time || p?.calendar_event_id);
  return {
    request_id: requestId, task_id: taskId,
    task_save_status: taskVerified ? 'verified' : 'unknown',
    schedule_status: schedule ? 'saved' : scheduleRequested ? 'pending' : scheduled ? 'present' : 'not_requested',
    reminder_projection_status: failed ? 'pending' : disabled ? 'disabled' : noReminder ? 'not_requested' : configured ? 'configured' : scheduled ? 'unverified' : 'not_requested',
    device_delivery_status: 'not_verified',
    readback_at: taskVerified ? checkedAt : null,
    projection_verified_at: configured ? p.verified_at : null,
    error_category: error?.code || (failed ? projection?.code || 'CALENDAR_SYNC_PENDING' : null),
    retryable: failed && error?.retryable !== false && projection?.retryable !== false && !['GOOGLE_REAUTH_REQUIRED','GOOGLE_NOT_CONNECTED','CALENDAR_SCOPE_MISSING','CALENDAR_API_DISABLED','SCHEDULER_NOT_CONFIGURED','GOOGLE_OAUTH_CONFIGURATION_ERROR'].includes(error?.code || projection?.code),
    next_step: !taskVerified ? 'reconcile_same_request' : failed ? 'recover_projection_only' : scheduled && !configured && !disabled && !noReminder ? 'verify_projection' : null,
    message: !taskVerified ? '结果待核实，请勿重复创建' : failed ? '任务已保存，提醒待恢复' : configured && !disabled ? '任务已保存，提醒配置已核实；设备到达尚未验证' : '任务已保存',
  };
}

function sameTime(expected, actual) {
  if (expected?.date) return expected.date === actual?.date;
  if (!expected?.dateTime || !actual?.dateTime) return false;
  if (/[zZ]|[+-]\d\d:\d\d$/.test(expected.dateTime)) return Date.parse(expected.dateTime) === Date.parse(actual.dateTime);
  if (expected.dateTime === actual.dateTime && expected.timeZone === actual.timeZone) return true;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:expected.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(actual.dateTime)).map(p=>[p.type,p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` === expected.dateTime;
  } catch { return false; }
}
function reminders(value) {
  return JSON.stringify((value?.overrides || []).map(x => ({method:x.method,minutes:Number(x.minutes)})).sort((a,b)=>a.method.localeCompare(b.method)||a.minutes-b.minutes));
}
export function verifyCalendarProjection(expected, actual) {
  const fail = () => { const error = new Error('Calendar projection readback did not match requested fields'); error.code = 'CALENDAR_WRITE_UNVERIFIED'; error.status = 503; throw error; };
  if (!actual || actual.id !== expected.id || actual.status === 'cancelled') fail();
  if (expected.transparency != null && (actual.transparency || 'opaque') !== expected.transparency) fail();
  for (const field of ['summary','description']) if (expected[field] != null && actual[field] !== expected[field]) fail();
  for (const field of ['start','end']) if (!sameTime(expected[field], actual[field])) fail();
  if (actual.reminders?.useDefault !== expected.reminders?.useDefault || reminders(actual.reminders) !== reminders(expected.reminders)) fail();
  for (const [key,value] of Object.entries(expected.extendedProperties?.private || {})) if (actual.extendedProperties?.private?.[key] !== value) fail();
  return true;
}

export function verifyTaskFields(current, expected) {
  const mismatch = key => { const error = new Error(`Task readback did not match requested ${key}`); error.code = 'WRITE_UNVERIFIED'; throw error; };
  for (const key of ['title','notes']) if (Object.hasOwn(expected,key) && String(current?.[key] || '').trim() !== String(expected[key] || '').trim()) mismatch(key);
  const dateKey = ['dueDate','due','date'].find(key => Object.hasOwn(expected,key));
  if (dateKey && String(current?.dueDate || current?.due || current?.date || '').slice(0,10) !== String(expected[dateKey] || '').slice(0,10)) mismatch(dateKey);
  const status = value => ['completed','done'].includes(value) ? 'completed' : value === 'cancelled' ? 'cancelled' : 'open';
  if (Object.hasOwn(expected,'status') && status(current?.status) !== status(expected.status)) mismatch('status');
  return true;
}

export function verifyTaskScheduleDate(current, changes) {
  const key = ['requested_date', 'due', 'dueDate', 'date'].find(key => Object.hasOwn(changes, key));
  if (!key) return true;
  const expected = changes[key] || null;
  if ((current?.schedule?.scheduled_date || null) !== expected) {
    const error = new Error('Schedule date readback did not match the updated execution date');
    error.code = 'SCHEDULE_WRITE_UNVERIFIED';
    throw error;
  }
  return true;
}
