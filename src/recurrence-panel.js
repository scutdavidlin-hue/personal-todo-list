const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function labelForSeries(series, taskTitles) {
  const date = String(series.current_date || "");
  const weekday = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]
    : "?";
  const cadence = series.recurrence_kind === "daily" ? "每天"
    : series.recurrence_kind === "weekly" ? `每周${weekday}`
      : series.recurrence_kind === "monthly" ? `每月${series.by_month_day || Number(date.slice(8, 10))}日`
        : `每年${series.by_month || Number(date.slice(5, 7))}月${series.by_month_day || Number(date.slice(8, 10))}日`;
  const time = String(series.local_time || "").slice(0, 5);
  const title = taskTitles.get(String(series.current_task_id))
    || taskTitles.get(String(series.anchor_task_id))
    || `任务 ${series.current_task_id || series.anchor_task_id || "未知"}`;
  return { title, detail: `${cadence} ${time} · ${series.timezone || "时区待核实"} · 当前实例 ${date || "日期待核实"}` };
}

function node(document, tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

/** Bind a Schedule-backed recurrence list inside the existing reminder dialog. */
export function bindRecurrencePanel({ client, container }) {
  if (!client?.calendarRequest || !container?.ownerDocument) throw new Error("Recurrence panel requires the existing client and a container");
  const document = container.ownerDocument;
  const heading = node(document, "h3", "重复提醒系列");
  const status = node(document, "p", "", "recurrence-status");
  status.setAttribute("role", "status");
  const list = node(document, "div", undefined, "recurrence-list");
  container.replaceChildren(heading, status, list);

  let seriesRows = [];
  let seriesVerified = false;
  let titles = new Map();
  let confirming = null;
  let busy = false;
  let disposed = false;
  let revision = 0;

  async function runAction(action, series, pendingText, successText) {
    if (busy || disposed) return;
    busy = true;
    render();
    status.textContent = pendingText;
    try {
      const result = await client.calendarRequest(action, { series_id: series.id });
      if (result?.success !== true) throw new Error(result?.error || "操作结果待核实");
      status.textContent = successText(result);
      await refresh({ preserveStatus: true });
    } catch (error) {
      status.textContent = `操作结果待核实：${error instanceof Error ? error.message : "服务暂不可用"}`;
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    if (disposed) return;
    list.replaceChildren();
    if (!seriesRows.length) {
      list.append(node(document, "p", seriesVerified ? "当前没有重复提醒系列。" : "系列状态未知，连接恢复后重新核实。"));
      return;
    }
    const ordered = [...seriesRows].sort((left, right) =>
      Number(right.status === "active") - Number(left.status === "active")
      || String(left.current_date || "").localeCompare(String(right.current_date || "")));
    for (const series of ordered) {
      const article = node(document, "article", undefined, "reminder-request");
      const label = labelForSeries(series, titles);
      article.append(node(document, "strong", label.title));
      article.append(node(document, "small", label.detail));
      article.append(node(document, "span", series.status === "active" ? "进行中" : series.status === "paused" ? "已暂停" : "已停止"));
      if (series.status === "active" || series.status === "paused") {
        if (confirming === series.id) {
          article.append(node(document, "p", "停止整个系列后，不再生成下一次提醒；当前任务仍保留在 Google Tasks。"));
          const confirm = node(document, "button", "确认停止整个系列");
          confirm.type = "button";
          confirm.disabled = busy;
          confirm.addEventListener("click", async () => {
            if (busy || disposed) return;
            busy = true;
            render();
            status.textContent = "正在停止系列并核实当前提醒…";
            try {
              const result = await client.calendarRequest("cancel_series", { series_id: series.id });
              if (result?.success !== true || result.cancelled !== true) throw new Error(result?.error || "系列停止结果待核实");
              confirming = null;
              status.textContent = result.projection?.projected === true
                ? "系列已停止，当前日历提醒已关闭。"
                : "系列已停止；当前日历提醒状态待核实。";
              await refresh({ preserveStatus: true });
            } catch (error) {
              status.textContent = `系列停止结果待核实：${error instanceof Error ? error.message : "服务暂不可用"}`;
            } finally {
              busy = false;
              render();
            }
          });
          article.append(confirm);
          const back = node(document, "button", "返回");
          back.type = "button";
          back.disabled = busy;
          back.addEventListener("click", () => { confirming = null; render(); });
          article.append(back);
        } else {
          if (series.status === "active") {
            const pause = node(document, "button", "暂停");
            pause.type = "button";
            pause.disabled = busy;
            pause.addEventListener("click", () => runAction("pause_series", series, "正在暂停未来实例…", () => "已暂停未来实例；当前任务和历史保留。"));
            article.append(pause);
            const skip = node(document, "button", "跳过下一次");
            skip.type = "button";
            skip.disabled = busy;
            skip.addEventListener("click", () => runAction("skip_series_once", series, "正在登记跳过下一次…", (result) => `已跳过 ${result.recurrence_instance_date || "下一次"}。`));
            article.append(skip);
          } else {
            const resume = node(document, "button", "恢复");
            resume.type = "button";
            resume.disabled = busy;
            resume.addEventListener("click", () => runAction("resume_series", series, "正在恢复循环系列…", () => "已恢复循环系列。"));
            article.append(resume);
          }
          const stop = node(document, "button", "停止整个系列");
          stop.type = "button";
          stop.disabled = busy;
          stop.addEventListener("click", () => { confirming = series.id; render(); });
          article.append(stop);
        }
      }
      list.append(article);
    }
  }

  async function refresh({ preserveStatus = false } = {}) {
    const currentRevision = ++revision;
    if (!preserveStatus) status.textContent = "正在读取重复提醒系列…";
    const [seriesResult, tasksResult] = await Promise.allSettled([
      client.calendarRequest("list_series"),
      typeof client.getTasks === "function" ? client.getTasks() : Promise.resolve([]),
    ]);
    if (disposed || currentRevision !== revision) return;
    if (seriesResult.status !== "fulfilled" || seriesResult.value?.success !== true || !Array.isArray(seriesResult.value.series)) {
      status.textContent = "重复提醒系列暂时无法核实，请稍后刷新。";
      seriesRows = [];
      seriesVerified = false;
      render();
      return;
    }
    seriesRows = seriesResult.value.series;
    seriesVerified = true;
    if (tasksResult.status === "fulfilled" && Array.isArray(tasksResult.value)) {
      titles = new Map(tasksResult.value.map((task) => [String(task.id), String(task.title || "")]).filter((entry) => entry[1]));
    }
    if (!preserveStatus) status.textContent = `已读取 ${seriesRows.length} 个系列；日历配置不代表设备已送达。`;
    render();
  }

  return { refresh, destroy() { disposed = true; revision += 1; container.replaceChildren(); } };
}
