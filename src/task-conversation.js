import { escapeHtml } from './core.js';

const labels = { requested_date: '日期', date: '日期', requested_time: '时间', time: '时间', deadline: '截止日期', reminder: '提醒', reminder_at: '提醒', status: '状态', notes: '补充信息', title: '事项', follow_up: '跟进', next_action: '下一步', reminders: '提醒' };
const display = (value) => {
  if (value == null || value === '') return '未设置';
  if (Array.isArray(value)) return value.map(display).join('、');
  if (typeof value === 'object') return [value.title, value.date, value.time, value.at].filter(Boolean).join(' · ') || '已设置';
  return ({open:'未完成', completed:'已完成', cancelled:'已取消'})[value] || String(value);
};
export function proposalHtml(pending) {
  const proposal = pending?.proposal || pending;
  return Object.entries(proposal?.proposed_changes || {}).map(([field, change]) => `<div class="conversation-diff"><strong>${escapeHtml(labels[field] || field)}</strong><span>${escapeHtml(display(change?.from))}</span><span aria-label="改为">→</span><b>${escapeHtml(display(change?.to ?? change))}</b></div>`).join('');
}

/** Task-bound UI. Formal state and pending proposals are always server-owned. */
export function createTaskConversation({ client, onChanged = async () => {} }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'task-conversation';
  dialog.setAttribute('aria-labelledby', 'conversation-title');
  dialog.innerHTML = `<header><div><small>任务详情</small><h2 id="conversation-title"></h2></div><button type="button" data-close aria-label="关闭任务详情">×</button></header>
    <p data-task-meta></p><p data-task-reminders></p><p data-task-notes></p><button type="button" data-older hidden>查看更早记录</button><section aria-label="任务对话记录" class="conversation-history" data-history></section>
    <section data-preview hidden><h3>准备修改</h3><div data-diff></div><div class="conversation-buttons"><button type="button" data-confirm>确认修改</button><button type="button" data-discard>算了</button></div></section>
    <p data-status role="status" aria-live="polite"></p>
    <form><label for="conversation-input">继续说 / 补充或修改</label><textarea id="conversation-input" maxlength="10000" rows="3" placeholder="例如：改周四下午四点"></textarea>
    <div class="conversation-buttons"><button type="button" data-voice>🎙 继续说</button><button type="submit">发送</button></div><small data-voice-hint></small></form>`;
  document.body.append(dialog);
  const el = (selector) => dialog.querySelector(selector);
  const input = el('textarea');
  const status = el('[data-status]');
  let taskId = null, pending = null, busy = false, generation = 0, recognition = null, listening = false;
  let source = 'text', failedRequest = null;
  let history = [], historyCursor = null;
  const Speech = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  el('[data-voice-hint]').textContent = Speech ? '识别后可修改文字；说“对”可确认当前预览。' : '此浏览器不支持直接识音，可使用 iPhone 键盘麦克风听写。';
  el('[data-voice]').disabled = !Speech;
  const setBusy = (value) => {
    busy = value;
    dialog.querySelectorAll('form button, [data-confirm], [data-discard]').forEach((button) => { button.disabled = value || pending?.status === 'committing'; });
    el('[data-voice]').disabled = value || !Speech || pending?.status === 'committing';
  };
  const render = (result) => {
    pending = result.pending || null;
    const task = result.task;
    if (task) {
      el('h2').textContent = task.title;
      el('[data-task-meta]').textContent = [task.requested_date || task.date, task.requested_time, task.status === 'completed' ? '已完成' : task.status === 'cancelled' ? '已取消' : ''].filter(Boolean).join(' · ');
      el('[data-task-notes]').textContent = task.notes || '';
      el('[data-task-reminders]').textContent = (task.schedule?.reminders || []).map((reminder) => reminder.offset_minutes != null ? `提前 ${reminder.offset_minutes} 分钟提醒` : reminder.at ? `${reminder.at} 提醒` : '').filter(Boolean).join(' · ');
    }
    history = result.history || [];
    historyCursor = result.history_cursor || history[0]?.created_at || null;
    el('[data-older]').hidden = !(result.history_has_more ?? history.length >= 200);
    el('[data-history]').innerHTML = history.map((event) => `<article><small>${escapeHtml(event.timestamp || event.created_at || '')}</small>${event.raw_input ? `<p>你：${escapeHtml(event.transcript || event.raw_input)}</p>` : ''}<p>${escapeHtml(event.message || event.executor_result?.message || event.parsed_intent?.message || event.event_type || '')}</p></article>`).join('');
    el('[data-preview]').hidden = !pending || !['awaiting_confirmation', 'failed', 'committing'].includes(pending.status);
    el('[data-diff]').innerHTML = proposalHtml(pending);
    const pendingMessage = pending?.status === 'failed' ? '上次执行未完成，请核对当前状态后重试这项修改。' : pending?.status === 'committing' ? '修改仍在处理中，请稍后重新打开查看执行结果。' : pending ? '正式任务尚未修改，请确认预览或继续说。' : '可以继续补充或修改这件事。';
    const message = result.message || pendingMessage;
    const parserMode = result.parser_mode || result.parsed_intent?.parser_mode;
    status.textContent = parserMode === 'deterministic_fallback'
      ? `${message}\n系统暂时按规则理解这句话；如有歧义会继续向你确认。`
      : message;
  };
  async function send(text, inputSource = 'text') {
    if (busy || !taskId || !text.trim()) return;
    const current = generation;
    const payload = { task_id: taskId, text: text.trim(), source: inputSource, proposal_id: pending?.id || pending?.proposal_id || undefined };
    const signature = JSON.stringify(payload);
    if (!failedRequest || failedRequest.signature !== signature) failedRequest = { signature, payload: { ...payload, request_id: crypto.randomUUID() } };
    setBusy(true); status.textContent = '正在处理…';
    try {
      const result = await client.sendTaskConversation(failedRequest.payload);
      if (current !== generation) return;
      failedRequest = null;
      render(result);
      input.value = ''; source = 'text';
      if (result.task) await onChanged();
    } catch (error) {
      if (current === generation) status.textContent = `未确认执行结果：${error.message}。请先刷新并核对任务与对话记录，再决定是否重试。`;
    } finally { if (current === generation) setBusy(false); }
  }
  el('form').addEventListener('submit', (event) => { event.preventDefault(); send(input.value, source); });
  input.addEventListener('input', () => { source = 'text'; });
  el('[data-confirm]').addEventListener('click', () => send('确认'));
  el('[data-discard]').addEventListener('click', () => send('算了'));
  el('[data-close]').addEventListener('click', () => { if (dialog.open) dialog.close(); });
  el('[data-older]').addEventListener('click', async () => {
    if (!taskId || !historyCursor || busy) return;
    const current = generation;
    el('[data-older]').disabled = true;
    setBusy(true);
    try {
      const result = await client.getTaskConversation(taskId, { historyBefore: historyCursor });
      if (current !== generation) return;
      render({ ...result, pending, history: [...(result.history || []), ...history] });
    } catch (error) { if (current === generation) status.textContent = `无法读取更早记录：${error.message}`; }
    finally { if (current === generation) { el('[data-older]').disabled = false; setBusy(false); } }
  });
  dialog.addEventListener('close', () => {
    // Some engines deliver a previous close event after the next task has opened.
    // It must not erase that task's session, proposal, or in-flight request.
    if (dialog.open) return;
    generation++; recognition?.abort(); recognition = null; listening = false; taskId = null; pending = null; failedRequest = null; input.value = '';
  });
  el('[data-voice]').addEventListener('click', () => {
    if (listening) { recognition?.stop(); return; }
    if (!Speech || busy) return;
    const current = generation;
    recognition = new Speech(); recognition.lang = 'zh-CN'; recognition.interimResults = false; recognition.continuous = false;
    recognition.onresult = (event) => {
      if (current !== generation) return;
      const text = Array.from(event.results).filter((result) => result.isFinal).map((result) => result[0].transcript).join('');
      input.value = text; source = 'voice';
      // The current proposal id travels with a spoken confirmation, never inferred from another task.
      recognition.stop(); send(text, 'voice');
    };
    recognition.onerror = () => { if (current === generation) status.textContent = '语音识别未成功，请重试或使用键盘听写。'; };
    recognition.onend = () => { if (current === generation) { listening = false; el('[data-voice]').textContent = '🎙 继续说'; } };
    try { recognition.start(); listening = true; el('[data-voice]').textContent = '停止聆听'; status.textContent = '正在聆听…'; } catch { status.textContent = '无法启动麦克风，请检查浏览器权限或使用键盘听写。'; }
  });
  return {
    close: () => { if (dialog.open) dialog.close(); },
    async open(task) {
      if (!task?.id) return;
      if (dialog.open) dialog.close();
      const current = ++generation;
      recognition?.abort(); recognition = null; listening = false;
      taskId = task.id; pending = null; input.value = ''; failedRequest = null;
      render({task,history:[],pending:null,message:'正在读取任务和对话记录…'});
      dialog.showModal(); setBusy(true);
      try { const result = await client.getTaskConversation(taskId); if (current === generation) render(result); }
      catch (error) { if (current === generation) status.textContent = `任务对话暂不可用：${error.message}`; }
      finally { if (current === generation) setBusy(false); }
    },
  };
}
