import { escapeHtml as esc, localDateISO } from './core.js';
export function monthDays(month) {
  const [y,m] = month.split('-').map(Number);
  const first = new Date(y,m-1,1); first.setDate(1-first.getDay());
  return Array.from({length:42},(_,i)=>{const d=new Date(first);d.setDate(d.getDate()+i);return localDateISO(d);});
}
export function shanghaiTime(value) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
  return parts.replace(' ','T');
}
export function eventOnDay(event, day) {
  const start = event.start?.date || shanghaiTime(event.start?.dateTime);
  const end = event.end?.date || shanghaiTime(event.end?.dateTime);
  return Boolean(start && end && start < day+'T23:59:59' && end > day+'T00:00');
}
export function calendarItems(events,tasks,schedules,day) {
  const projected = new Set(events.filter(e=>e.personal_os_projection).map(e=>e.id));
  const result = events.filter(e=>e.status!=='cancelled' && eventOnDay(e,day)).map(e=>({kind:'event',id:e.id,title:e.summary || '未命名日程',time:e.start?.date?'全天':shanghaiTime(e.start?.dateTime).slice(11),event:e}));
  for(const task of tasks) {
    if(task.status==='cancelled'||task.done) continue;
    const schedule=schedules.find(s=>s.google_task_id===task.id);
    if(projected.has(schedule?.calendar_event_id)) continue;
    if((schedule?.scheduled_date||task.date||task.dueDate)!==day) continue;
    result.push({kind:'task',id:task.id,title:task.title,time:schedule?.scheduled_start?.slice(0,5)||'待办'});
  }
  return result.sort((a,b)=>a.time.localeCompare(b.time));
}
export function createCalendarView({client,root,getTasks,getSchedules,openTask,onSaved}) {
  let month=localDateISO().slice(0,7),selected=localDateISO(),events=[],message='日历尚未读取',revision=0,editRevision=0;
  const dialog=document.createElement('dialog'); dialog.className='calendar-event-form'; document.body.append(dialog);
  let editing=null;
  function items(day){return calendarItems(events,getTasks(),getSchedules(),day);}
  function render(){
    const days=monthDays(month);
    root.innerHTML=`<div class="calendar-toolbar"><button data-month="-1" aria-label="上个月">‹</button><h2>${month.replace('-',' 年 ')} 月</h2><button data-month="1" aria-label="下个月">›</button><button data-today>今天</button></div><p class="calendar-status" role="status">${esc(message)} · 北京时间</p><div class="calendar-weekdays">${'日一二三四五六'.split('').map(d=>`<span>${d}</span>`).join('')}</div><div class="calendar-grid">${days.map(day=>{const list=items(day);return `<div class="calendar-cell ${day.startsWith(month)?'':'calendar-outside'} ${day===selected?'calendar-selected':''} ${day===localDateISO()?'calendar-today':''}"><button class="calendar-date" data-day="${day}" aria-label="${day}，${list.length} 项">${Number(day.slice(-2))}</button>${list.slice(0,3).map(item=>`<button class="calendar-item ${item.kind}" data-kind="${item.kind}" data-item="${esc(item.id)}" title="${esc(item.title)}">${esc(item.title)}</button>`).join('')}${list.length>3?`<button class="calendar-more" data-day="${day}">+${list.length-3} 项</button>`:''}</div>`;}).join('')}</div><section class="calendar-day-list"><h3>${selected} · ${items(selected).length} 项</h3>${items(selected).map(item=>`<button data-kind="${item.kind}" data-item="${esc(item.id)}"><span>${esc(item.time)}</span><strong>${esc(item.title)}</strong><small>${item.kind==='task'?'任务':'日程'} ›</small></button>`).join('')||'<p>这一天没有安排</p>'}</section>`;
  }
  async function refresh(){
    const ticket=++revision;message='正在读取 Google Calendar…';render();
    const days=monthDays(month);
    try{const result=await client.listCalendarEvents({dateFrom:days[0],dateTo:days.at(-1),limit:100});if(ticket!==revision)return;events=result.events||[];message=result.hasMore?'部分日期超过读取上限，当前日历不完整':'Google Calendar 已同步';}
    catch(error){if(ticket!==revision)return;events=[];message=`日历读取失败：${error.message}；任务仍可查看`;}
    render();
  }
  async function openEvent(id){
    const event=events.find(e=>e.id===id);if(!event)return;
    if(event.personal_os_projection){const schedule=getSchedules().find(s=>s.calendar_event_id===id);const task=getTasks().find(t=>t.id===schedule?.google_task_id);if(task){openTask(task);return;}message='这是任务的日历投影，请在任务页修改原任务';render();return;}
    const ticket=++editRevision;
    message='正在读取日程最新版本…';render();
    try{const latest=await client.getCalendarEvent(id,{calendarId:event.calendar_id});if(ticket!==editRevision)return;editing=latest;
      const allDay=Boolean(editing.start?.date);
      dialog.innerHTML=`<form><h2>编辑日程</h2><p>北京时间${allDay?' · 全天日程的结束日期不包含当天':''}</p><label>标题<input name="summary" required maxlength="1000" value="${esc(editing.summary)}"></label><label>开始<input name="start" type="${allDay?'date':'datetime-local'}" required value="${esc(allDay?editing.start.date:shanghaiTime(editing.start?.dateTime))}"></label><label>结束<input name="end" type="${allDay?'date':'datetime-local'}" required value="${esc(allDay?editing.end.date:shanghaiTime(editing.end?.dateTime))}"></label><label>地点<input name="location" maxlength="1000" value="${esc(editing.location)}"></label><label>说明<textarea name="description" maxlength="8000">${esc(editing.description)}</textarea></label><p role="status" class="calendar-save-status"></p><div class="dialog-actions"><button type="button" data-close>取消</button><button type="submit" class="primary-button">保存修改</button></div></form>`;
      dialog.querySelector('[data-close]').onclick=()=>dialog.close();
      dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;const data=new FormData(form);const status=form.querySelector('[role=status]');const button=form.querySelector('[type=submit]');const start=data.get('start'),end=data.get('end');if(end<=start){status.textContent='结束必须晚于开始';return;}button.disabled=true;status.textContent='正在保存并回读…';try{await client.updateCalendarEvent(editing.id,{summary:data.get('summary'),location:data.get('location'),description:data.get('description'),...(allDay?{start_date:start,end_date:end}:{start:start+':00+08:00',end:end+':00+08:00',timezone:'Asia/Shanghai'})},{calendarId:editing.calendar_id,expectedUpdated:editing.updated});dialog.close();await refresh();onSaved('日程修改已保存并回读');}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
      dialog.showModal();message='Google Calendar 已同步';render();
    }catch(error){if(ticket!==editRevision)return;message=error.message;render();}
  }
  root.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.hasAttribute('data-month')){const [y,m]=month.split('-').map(Number);month=localDateISO(new Date(y,m-1+Number(button.dataset.month),1)).slice(0,7);selected=month+'-01';events=[];void refresh();}else if(button.hasAttribute('data-today')){selected=localDateISO();month=selected.slice(0,7);void refresh();}else if(button.dataset.day){selected=button.dataset.day;render();}else if(button.dataset.kind==='task'){openTask(getTasks().find(t=>t.id===button.dataset.item));}else if(button.dataset.kind==='event'){void openEvent(button.dataset.item);}});
  return {render,refresh,clear(){revision++;editRevision++;events=[];editing=null;dialog.close();message='日历尚未读取';render();}};
}
