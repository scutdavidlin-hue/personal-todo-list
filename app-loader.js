// Load the app only after an existing offline worker has finished upgrading.
export const APP_RELEASE = '20260905-conversation-4';

export function waitForActivation(worker, timeoutMs = 20000) {
  if (!worker || worker.state === 'activated') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', changed);
      error ? reject(error) : resolve();
    };
    const changed = () => {
      if (worker.state === 'activated') finish();
      if (worker.state === 'redundant') finish(new Error('新版资源未能完成更新'));
    };
    const timer = setTimeout(() => finish(new Error('更新超时，请检查网络后重试')), timeoutMs);
    worker.addEventListener('statechange', changed);
    changed();
  });
}

async function startApp() {
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = '正在加载任务对话新版…';
  Object.assign(status.style, { position: 'fixed', top: 'env(safe-area-inset-top, 0px)', left: '0', right: '0', zIndex: '10000', margin: '0', padding: '14px', background: '#203c34', color: 'white', textAlign: 'center' });
  document.body.append(status);
  try {
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
        await registration.update();
        await waitForActivation(registration.installing || registration.waiting);
        // activate waits for clients.claim(), so fetches now use the new worker.
        await navigator.serviceWorker.ready;
      } catch (error) {
        // A controlling old worker must never silently start another stale UI.
        if (navigator.serviceWorker.controller) throw error;
        // Browsers without worker support can run the online application directly.
      }
    }
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const url = new URL(link.href);
      url.searchParams.set('release', APP_RELEASE);
      link.href = url.href;
    }
    const entry = location.pathname.endsWith('/today.html') ? './today.js' : './app.js';
    await import(`${entry}?release=${APP_RELEASE}`);
    document.documentElement.dataset.appRelease = APP_RELEASE;
    status.remove();
  } catch (error) {
    status.textContent = `界面更新未完成：${error.message}。`;
    const retry = document.createElement('button');
    retry.textContent = '重新加载';
    retry.style.cssText = 'margin-left:12px;min-height:44px;padding:8px 16px';
    retry.addEventListener('click', () => location.reload());
    status.append(retry);
  }
}

if (typeof document !== 'undefined') startApp();
