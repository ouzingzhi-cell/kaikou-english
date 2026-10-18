/* The offline panel owns only Cache Storage. Learning records remain untouched. */
const BASE = new URL('./', import.meta.url);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
const downloadIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg>';
let registration = null, cacheInfo = null, curriculum = null, audioManifest = null, ambience = [];
let activeDownload = null, refreshRequested = false, shellReady = false;
let lastMessage = '首次使用请保持联网，正在准备课文与离线界面…', lastLevel = 'normal';
const dialog = document.createElement('dialog');
dialog.id = 'offline-dialog';
dialog.setAttribute('aria-labelledby', 'offline-title');
dialog.innerHTML = `<div class="offline-dialog-heading"><h2 id="offline-title">带着课程，随时开口</h2><button class="icon-btn" data-offline-close aria-label="关闭离线课程">✕</button></div>
  <p class="offline-intro">先联网打开一次，再下载想练的课程。基础课文随界面保存；每课下载 5 段原音。离线可听音、变速、录音回听与记录完成，AI 对话需要联网。</p>
  <div class="offline-state" role="status" aria-live="polite"></div>
  <p class="offline-storage"></p>
  <div class="offline-progress" hidden><progress max="1" value="0" aria-label="课程下载进度"></progress><span aria-live="polite"></span></div>
  <div class="offline-actions"><button class="primary" data-offline-all disabled>下载全部课程</button><button class="secondary" data-offline-ambience disabled>下载 3 种环境声</button><button class="secondary" data-offline-cancel disabled>取消下载</button></div>
  <div class="offline-lessons" aria-label="按主题下载"></div>
  <div class="offline-actions"><button class="danger-button" data-offline-clear disabled>清除离线音频</button><button class="secondary offline-update" data-offline-update hidden>刷新到新版本</button></div>
  <div class="offline-confirm" hidden><p>清除本设备下载的原音和环境声？课文、学习完成记录、打卡和偏好都会保留。</p><div class="offline-actions"><button class="secondary" data-offline-keep>保留音频</button><button class="danger-button danger-solid" data-offline-confirm-clear>确认清除音频</button></div></div>
  <p class="offline-intro">在 iPad 的 Safari 中点“分享 → 添加到主屏幕”，可像应用一样打开。下载只保存在本设备；系统空间不足或清理网站数据可能移除下载。学习记录可在设置中导出备份。</p>`;
document.body.append(dialog);
const $ = selector => dialog.querySelector(selector);

function setMessage(message, level = 'normal') {
  lastMessage = message; lastLevel = level;
  const target = $('.offline-state');
  target.textContent = message; target.dataset.level = level;
}

function toolbar() {
  const tools = document.querySelector('.top-tools');
  if (!tools || tools.querySelector('[data-offline-open]')) return;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'secondary offline-tool';
  button.dataset.offlineOpen = ''; button.dataset.offline = String(!navigator.onLine);
  button.setAttribute('aria-haspopup', 'dialog');
  button.innerHTML = `${downloadIcon}<span>离线课程</span><i class="offline-indicator" aria-hidden="true"></i>`;
  button.title = navigator.onLine ? '管理本设备的离线课程' : '当前离线，查看已下载课程';
  button.onclick = openPanel;
  tools.prepend(button);
}

let toolbarQueued = false;
const observer = new MutationObserver(() => {
  if (toolbarQueued) return;
  toolbarQueued = true;
  queueMicrotask(() => { toolbarQueued = false; toolbar(); });
});
const app = document.getElementById('app');
if (app) observer.observe(app, {childList: true, subtree: true});
toolbar();

function setOnlineState() {
  const button = document.querySelector('[data-offline-open]');
  if (button) {
    button.dataset.offline = String(!navigator.onLine);
    button.title = navigator.onLine ? '管理本设备的离线课程' : '当前离线，查看已下载课程';
  }
  if (!navigator.onLine && !activeDownload) setMessage(shellReady
    ? '当前离线 · 已下载的原音可直接使用。AI 对话和新下载需要网络。'
    : '当前离线 · 首次使用需联网完成离线准备。', 'warning');
  else if (navigator.onLine && !activeDownload && lastLevel !== 'error') setMessage(shellReady
    ? '离线界面与全部课文已准备好。选一课下载原音吧。'
    : lastMessage);
  updateButtons();
}
window.addEventListener('online', setOnlineState);
window.addEventListener('offline', setOnlineState);

function updateViewport() {
  document.documentElement.style.setProperty('--visual-height', `${window.visualViewport?.height || innerHeight}px`);
}
updateViewport();
window.visualViewport?.addEventListener('resize', updateViewport);
window.addEventListener('resize', updateViewport);

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

async function workerStatus(worker) {
  if (!worker) throw new Error('离线服务尚未激活。');
  return withTimeout(new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
    channel.port1.onmessageerror = () => { channel.port1.close(); reject(new Error('无法读取离线状态。')); };
    worker.postMessage({type: 'OFFLINE_STATUS'}, [channel.port2]);
  }), 5000, '离线服务响应超时，请联网刷新后重试。');
}

async function jsonFile(path) {
  const url = new URL(path, BASE).href;
  try {
    const response = await fetch(url, {credentials: 'same-origin'});
    if (!response.ok) throw new Error('文件未能加载');
    return await response.json();
  } catch (error) {
    if (!cacheInfo) throw error;
    const response = await (await caches.open(cacheInfo.shellCache)).match(url);
    if (response) return response.json();
    throw error;
  }
}

function mediaUrl(path) {
  const url = new URL(path, BASE);
  if (url.origin !== BASE.origin || !url.pathname.startsWith(`${BASE.pathname}assets/`) || url.search || url.hash) throw new Error('课程音频地址不受支持。');
  return url.href;
}
function courseFiles(lesson) {
  return lesson.dialogues.map(dialogue => {
    const info = audioManifest.dialogues[dialogue.id];
    if (!info?.url || info.status !== 'ready') throw new Error(`对话 ${dialogue.id} 原音尚未准备好。`);
    return {url: mediaUrl(info.url), bytes: info.bytes || 0, title: `第 ${lesson.id} 课 · 对话 ${dialogue.id.split('.')[1]}`};
  });
}
function ambienceFiles() { return ambience.map(item => ({url: mediaUrl(item.url), bytes: item.bytes || 0, title: item.title})); }

function updateButtons() {
  const busy = Boolean(activeDownload), ready = Boolean(cacheInfo && curriculum && audioManifest);
  dialog.querySelectorAll('[data-offline-course],[data-offline-all],[data-offline-ambience]').forEach(button => { button.disabled = !ready || busy || !navigator.onLine; });
  $('[data-offline-cancel]').disabled = !busy;
  $('[data-offline-clear]').disabled = !cacheInfo || busy;
  $('[data-offline-update]').hidden = !registration?.waiting;
  $('[data-offline-update]').disabled = busy;
}

async function refreshInventory() {
  if (!curriculum || !audioManifest || !cacheInfo) return;
  const cache = await caches.open(cacheInfo.mediaCache);
  const present = new Set((await cache.keys()).map(request => request.url));
  $('.offline-lessons').innerHTML = curriculum.lessons.map(lesson => {
    const files = courseFiles(lesson), count = files.filter(item => present.has(item.url)).length;
    return `<div class="offline-lesson"><div><strong>第 ${String(lesson.id).padStart(2, '0')} 课 · ${esc(lesson.title)}</strong><small>${count === files.length ? '✓ 全课原音可离线' : `原音已下载 ${count} / ${files.length}`} · ${mb(files.reduce((n, item) => n + item.bytes, 0))}</small></div><button class="secondary" data-offline-course="${lesson.id}">${count === files.length ? '检查下载' : count ? '继续下载' : '下载本课'}</button></div>`;
  }).join('');
  $('.offline-lessons').querySelectorAll('[data-offline-course]').forEach(button => {
    button.onclick = () => {
      const lesson = curriculum.lessons.find(item => item.id === Number(button.dataset.offlineCourse));
      if (lesson) download(courseFiles(lesson), `第 ${lesson.id} 课`);
    };
  });
  const environment = ambienceFiles().filter(item => present.has(item.url)).length;
  $('[data-offline-ambience]').textContent = `环境声 ${environment} / ${ambience.length || 3} · 下载`;
  try {
    const estimate = await navigator.storage?.estimate?.();
    $('.offline-storage').textContent = estimate?.quota
      ? `本应用占用约 ${mb(estimate.usage || 0)} · 当前可用约 ${mb(Math.max(0, estimate.quota - (estimate.usage || 0)))}。容量由系统管理。`
      : '下载使用本设备的网站存储空间。';
  } catch { $('.offline-storage').textContent = '系统暂未提供存储容量信息。'; }
  updateButtons();
}

async function readAudio(response, onBytes) {
  const type = response.headers.get('Content-Type') || '';
  if (response.status !== 200 || !/audio\/(?:mpeg|mp3)|application\/octet-stream/i.test(type)) throw new Error('下载没有返回完整 MP3，请保持联网后重试。');
  if (!response.body?.getReader) {
    const blob = await response.blob();
    if (!blob.size) throw new Error('下载的音频为空，请重试。');
    if (blob.size > 20 * 1024 * 1024) throw new Error('音频大小异常，本次下载已停止。');
    onBytes(blob.size);
    return new Response(blob, {headers: {'Content-Type': 'audio/mpeg', 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes'}});
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 20 * 1024 * 1024) throw new Error('音频大小异常，本次下载已停止。');
      chunks.push(value); onBytes(value.byteLength);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (!size) throw new Error('下载的音频为空，请重试。');
  return new Response(new Blob(chunks, {type: 'audio/mpeg'}), {headers: {'Content-Type': 'audio/mpeg', 'Content-Length': String(size), 'Accept-Ranges': 'bytes'}});
}

async function download(files, title) {
  if (activeDownload || !cacheInfo) return;
  if (!navigator.onLine) { setMessage('当前离线，请联网后下载。已经保存的课程可照常练习。', 'warning'); return; }
  const controller = new AbortController();
  activeDownload = controller;
  const progress = $('.offline-progress'), meter = progress.querySelector('progress'), caption = progress.querySelector('span');
  progress.hidden = false; meter.value = 0; meter.max = 1;
  $('[data-offline-confirm-clear]').disabled = true;
  $('.offline-confirm').hidden = true;
  updateButtons();
  let completed = 0, transferred = 0, expected = 0;
  const update = file => {
    meter.max = expected || files.length;
    meter.value = expected ? Math.min(transferred, expected) : completed;
    caption.textContent = `${title} · ${completed} / ${files.length} 段 · ${mb(transferred)}${expected ? ' / ' + mb(expected) : ''}${file ? ' · ' + file : ''}`;
  };
  try {
    const cache = await caches.open(cacheInfo.mediaCache), missing = [];
    for (const file of files) {
      if ((await cache.match(file.url))?.status === 200) completed++;
      else missing.push(file);
    }
    expected = missing.reduce((n, file) => n + file.bytes, 0);
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    if (estimate?.quota && expected > Math.max(0, estimate.quota - (estimate.usage || 0))) {
      throw Object.assign(new Error('容量不足'), {name: 'QuotaExceededError'});
    }
    try { await navigator.storage?.persist?.(); } catch {}
    setMessage(`正在下载${title}。可随时取消，已保存的原音会保留。`);
    update('');
    for (const file of missing) {
      if (controller.signal.aborted) throw new DOMException('下载已取消。', 'AbortError');
      const response = await fetch(file.url, {signal: controller.signal, cache: 'no-store', credentials: 'same-origin'});
      const complete = await readAudio(response, bytes => { transferred += bytes; update(file.title); });
      if (controller.signal.aborted) throw new DOMException('下载已取消。', 'AbortError');
      if (file.bytes && Number(complete.headers.get('Content-Length')) !== file.bytes) throw new Error('音频没有下载完整，请重试。');
      await cache.put(file.url, complete);
      completed++; update('');
    }
    meter.max = 1; meter.value = 1;
    setMessage(`${title}已可离线使用。首次离线前，可在“离线课程”查看每课的下载状态。`);
  } catch (error) {
    if (error.name === 'AbortError') setMessage('已取消下载。已完成的原音已保留，下次可继续下载。', 'warning');
    else if (error.name === 'QuotaExceededError') setMessage('设备空间不足，未完成的文件没有保存。可清除离线音频或释放空间后重试；学习记录仍保留。', 'error');
    else setMessage(`下载未完成。已保存的原音会保留。${navigator.onLine ? error.message || '请检查网络后重试。' : '当前已离线，联网后可继续。'}`, 'error');
  } finally {
    activeDownload = null;
    $('[data-offline-confirm-clear]').disabled = false;
    updateButtons();
    try { await refreshInventory(); } catch { setMessage('系统暂时无法读取已下载文件，请关闭面板后重试。学习记录未改变。', 'warning'); }
  }
}

async function openPanel() {
  if (!dialog.open) dialog.showModal();
  setOnlineState();
  try { await refreshInventory(); } catch { setMessage('暂时无法读取离线目录，请联网刷新后重试。', 'error'); }
}
$('[data-offline-close]').onclick = () => dialog.close();
$('[data-offline-all]').onclick = () => download(curriculum.lessons.flatMap(courseFiles), '全部课程');
$('[data-offline-ambience]').onclick = () => download(ambienceFiles(), '3 种环境声');
$('[data-offline-cancel]').onclick = () => activeDownload?.abort();
$('[data-offline-clear]').onclick = () => { $('.offline-confirm').hidden = false; $('[data-offline-keep]').focus(); };
$('[data-offline-keep]').onclick = () => { $('.offline-confirm').hidden = true; };
$('[data-offline-confirm-clear]').onclick = async () => {
  if (activeDownload || !cacheInfo) return;
  try {
    await caches.delete(cacheInfo.mediaCache);
    $('.offline-confirm').hidden = true; $('.offline-progress').hidden = true;
    setMessage('离线原音与环境声已清除。课文、学习记录、打卡和偏好均保留。');
    await refreshInventory();
  } catch { setMessage('系统未能清除音频缓存，请重试。学习记录未改变。', 'error'); }
};
$('[data-offline-update]').onclick = () => {
  if (!registration?.waiting || activeDownload) return;
  refreshRequested = true;
  registration.waiting.postMessage({type: 'ACTIVATE_UPDATE'});
};
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (refreshRequested) location.reload();
});

async function init() {
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('caches' in window)) {
    setMessage('离线课程需要通过 HTTPS 打开，并使用支持离线存储的浏览器。当前仍可联网练习。', 'warning');
    return;
  }
  try {
    registration = await navigator.serviceWorker.register(new URL('sw.js', BASE), {scope: BASE.pathname, updateViaCache: 'none'});
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', updateButtons);
    });
    await withTimeout(navigator.serviceWorker.ready, 45000, '离线准备未完成。请保持联网，刷新后重试。');
    cacheInfo = await workerStatus(registration.active);
    if (!cacheInfo.mediaCache?.startsWith('kaikou-ipad-media-') || cacheInfo.scope !== BASE.href) throw new Error('离线服务范围不匹配，请刷新重试。');
    shellReady = true;
    [curriculum, audioManifest, ambience] = await Promise.all([
      jsonFile('data/curriculum.json'), jsonFile('data/audio-manifest.json'), jsonFile('data/ambience.json'),
    ]);
    setOnlineState(); await refreshInventory();
  } catch (error) { setMessage(error.message || '离线准备未完成，请联网刷新后重试。', 'warning'); }
}
init();
