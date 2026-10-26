// ddak 모바일 실험(M0) 화면. 컴퓨터마다 tailnet 주소 + 토큰을 저장하고, CORS·LNA·SSE·Web Push를 시험한다.
const LS_COMPS = 'spike.computers';
const LS_VAPID = 'spike.vapid';
const $ = (id) => document.getElementById(id);

const comps = loadJson(LS_COMPS, []);
const live = new Map(); // url → { ctl, want, lastId, timer }

function loadJson(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function saveComps() { localStorage.setItem(LS_COMPS, JSON.stringify(comps)); }

function log(msg, cls) {
  const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const div = document.createElement('div');
  div.textContent = `${t} ${msg}`;
  if (cls) div.className = cls;
  $('log').prepend(div);
  console.log(msg);
}

function errText(e) { return `${e.name}: ${e.message}`; }

async function api(c, path, opts = {}) {
  const t0 = performance.now();
  const headers = { ...(opts.headers || {}) };
  if (c.token) headers.Authorization = `Bearer ${c.token}`;
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const r = await fetch(c.url + path, {
      method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      cache: 'no-store',
    });
    const ms = Math.round(performance.now() - t0);
    const body = await r.json().catch(() => null);
    log(`${c.name || c.url} ${path} → ${r.status} (${ms}ms) ${body ? JSON.stringify(body).slice(0, 160) : ''}`, r.ok ? 'ok' : 'bad');
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    log(`${c.name || c.url} ${path} → 실패 (${ms}ms) ${errText(e)}`, 'bad');
    return { ok: false, error: e };
  }
}

// --- 상태 ---
async function perm(name) {
  try { return (await navigator.permissions.query({ name })).state; } catch (e) { return `조회 불가 (${e.name})`; }
}

async function renderEnv() {
  const standalone = matchMedia('(display-mode: standalone)').matches;
  const rows = [
    ['출처', location.origin],
    ['실행 방식', standalone ? 'PWA (standalone)' : '브라우저 탭'],
    ['알림 권한', 'Notification' in window ? Notification.permission : '없음'],
    ['local-network-access', await perm('local-network-access')],
    ['local-network', await perm('local-network')],
    ['서비스 워커', navigator.serviceWorker?.controller ? '제어 중' : '아직 제어 안 함'],
    ['UA', navigator.userAgent],
  ];
  $('env').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

// --- 컴퓨터 ---
function renderComps() {
  const box = $('comps');
  if (!comps.length) { box.innerHTML = '<span class="muted">아직 없음</span>'; return; }
  box.replaceChildren(...comps.map((c) => {
    const div = document.createElement('div');
    div.className = 'comp';
    const l = live.get(c.url);
    const title = document.createElement('div');
    title.innerHTML = `<b></b> <span class="muted"></span>`;
    title.querySelector('b').textContent = c.name || '(이름 없음)';
    title.querySelector('span').textContent = c.url;
    const sse = document.createElement('div');
    sse.className = 'muted';
    sse.textContent = `SSE: ${l?.want ? (l.connected ? `연결됨, 마지막 id ${l.lastId ?? '-'}` : '다시 연결 중') : '꺼짐'}`;
    const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; return b; };
    div.append(title, sse,
      btn('정보', () => api(c, '/api/info')),
      btn(l?.want ? 'SSE 끄기' : 'SSE 켜기', () => toggleSse(c)),
      btn('푸시 10초 뒤', () => api(c, '/api/push/test', { json: { delay: 10, which: 'current' } })),
      btn('푸시 60초 뒤', () => api(c, '/api/push/test', { json: { delay: 60, which: 'current' } })),
      btn('예전 키로 푸시', () => api(c, '/api/push/test', { json: { delay: 0, which: 'old' } })),
      btn('푸시 결과', () => api(c, '/api/push/results')),
      btn('지우기', () => { stopSse(c); comps.splice(comps.indexOf(c), 1); saveComps(); renderComps(); }));
    return div;
  }));
}

async function addComputer() {
  const url = $('addUrl').value.trim().replace(/\/+$/, '');
  const code = $('addCode').value.trim();
  if (!/^https:\/\//.test(url) || !/^\d{6}$/.test(code)) { log('주소(https://…)와 6자리 코드를 넣으세요', 'bad'); return; }
  const c = { url };
  const r = await api(c, '/api/pair', { json: { code } });
  if (!r.ok) return;
  c.token = r.body.token;
  c.name = r.body.name;
  const old = comps.findIndex((x) => x.url === url);
  if (old >= 0) comps.splice(old, 1, c); else comps.push(c);
  saveComps();
  $('addCode').value = '';
  renderComps();
  const v = loadJson(LS_VAPID, null);
  if (v && navigator.serviceWorker) {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await api(c, '/api/push/subscribe', { json: { subscription: sub.toJSON(), vapid: v } });
  }
}

// --- SSE (fetch 스트림, Authorization 헤더를 쓰려고 EventSource 대신) ---
function toggleSse(c) { if (live.get(c.url)?.want) stopSse(c); else startSse(c); }

function stopSse(c) {
  const l = live.get(c.url);
  if (!l) return;
  l.want = false;
  clearTimeout(l.timer);
  l.ctl?.abort();
  renderComps();
}

function startSse(c) {
  let l = live.get(c.url);
  if (!l) { l = {}; live.set(c.url, l); }
  l.want = true;
  if (l.connected || l.connecting) return;
  runSse(c, l);
  renderComps();
}

async function runSse(c, l) {
  l.connecting = true;
  l.ctl = new AbortController();
  const headers = { Authorization: `Bearer ${c.token}` };
  if (l.lastId != null) headers['Last-Event-ID'] = String(l.lastId);
  const t0 = performance.now();
  try {
    const r = await fetch(c.url + '/api/events', { headers, signal: l.ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    l.connected = true;
    log(`${c.name} SSE 연결 (${Math.round(performance.now() - t0)}ms)`, 'ok');
    renderComps();
    const rd = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const id = /^id: (.*)$/m.exec(ev)?.[1];
        const data = /^data: (.*)$/m.exec(ev)?.[1];
        const name = /^event: (.*)$/m.exec(ev)?.[1];
        if (id != null) l.lastId = Number(id);
        if (name === 'hello') log(`${c.name} SSE hello ${data}`);
        renderComps();
      }
    }
    log(`${c.name} SSE 끝남 (서버가 닫음)`, 'bad');
  } catch (e) {
    if (e.name !== 'AbortError') log(`${c.name} SSE 오류 ${errText(e)}`, 'bad');
  } finally {
    l.connected = false;
    l.connecting = false;
    if (l.want) { l.timer = setTimeout(() => runSse(c, l), 3000); }
    renderComps();
  }
}

// 백그라운드에서 돌아오면 끊긴 스트림을 바로 다시 연다.
document.addEventListener('visibilitychange', () => {
  log(`화면 ${document.visibilityState}`);
  if (document.visibilityState !== 'visible') return;
  for (const c of comps) {
    const l = live.get(c.url);
    if (l?.want && !l.connected) { clearTimeout(l.timer); if (!l.connecting) runSse(c, l); }
  }
  renderEnv();
});
addEventListener('online', () => log('online'));
addEventListener('offline', () => log('offline', 'bad'));

// --- 푸시 ---
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

async function renderPush() {
  const v = loadJson(LS_VAPID, null);
  let sub = null;
  try { sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch {}
  const rows = [
    ['알림 키', v ? `${v.publicKey.slice(0, 16)}… (${v.at})` : '없음'],
    ['구독', sub ? new URL(sub.endpoint).host + ' …' + sub.endpoint.slice(-8) : '없음'],
  ];
  $('pushInfo').replaceChildren(...rows.flatMap(([k, val]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = val;
    return [dt, dd];
  }));
}

async function newKeyAndSubscribe() {
  if (Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    log(`알림 권한: ${p}`, p === 'granted' ? 'ok' : 'bad');
    if (p !== 'granted') return;
  }
  const reg = await navigator.serviceWorker.ready;
  const prev = await reg.pushManager.getSubscription();
  if (prev) { const ok = await prev.unsubscribe(); log(`예전 구독 해지: ${ok}`); }
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const v = { publicKey: b64u(raw), privateKey: jwk.d, at: new Date().toLocaleString('ko-KR') };
  let sub;
  try {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(v.publicKey) });
  } catch (e) { log(`구독 실패 ${errText(e)}`, 'bad'); return; }
  localStorage.setItem(LS_VAPID, JSON.stringify(v));
  log(`새 구독 ${new URL(sub.endpoint).host}`, 'ok');
  renderPush();
  for (const c of comps) await api(c, '/api/push/subscribe', { json: { subscription: sub.toJSON(), vapid: v } });
}

// --- 시작 ---
$('refreshEnv').onclick = renderEnv;
$('addBtn').onclick = addComputer;
$('notifBtn').onclick = async () => { const p = await Notification.requestPermission(); log(`알림 권한: ${p}`); renderEnv(); };
$('subBtn').onclick = newKeyAndSubscribe;
$('rotateBtn').onclick = () => { log('알림 키 바꾸기'); newKeyAndSubscribe(); };
$('copyLog').onclick = async () => {
  const text = [...$('log').children].map((d) => d.textContent).reverse().join('\n');
  try { await navigator.clipboard.writeText(text); log('기록 복사됨'); } catch (e) { log(`복사 실패 ${errText(e)}`, 'bad'); }
};
$('clearLog').onclick = () => $('log').replaceChildren();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => { renderEnv(); renderPush(); }, (e) => log(`서비스 워커 등록 실패 ${errText(e)}`, 'bad'));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'push') log(`푸시 받음: ${e.data.d.title} ${e.data.d.body}${e.data.took}`, 'ok');
  });
}
renderEnv();
renderComps();
renderPush();
