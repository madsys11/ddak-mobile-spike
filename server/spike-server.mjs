// ddak 모바일 실험(M0) 서버. 127.0.0.1에서만 듣고, `tailscale serve`가 tailnet HTTPS로 내준다.
// 실제 ddak 코드가 아니다. 계획서(docs/mobile-plan.md)의 인증 순서·SSE·Web Push가 실기기에서 되는지만 본다.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import webpush from 'web-push';

const PORT = Number(process.env.SPIKE_PORT || 47811);
const ORIGIN = process.env.SPIKE_ORIGIN || 'https://madsys11.github.io';
const TS = process.env.TAILSCALE || '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const DIR = path.join(os.homedir(), '.ddak-mobile-spike');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'log.txt');
const ALLOW_HEADERS = ['authorization', 'content-type', 'last-event-id'];

// 이 맥의 tailnet 이름과 로그인. 저장소에 넣지 않으려고 시작할 때 읽는다.
const st = JSON.parse(execFileSync(TS, ['status', '--json'], { encoding: 'utf8' }));
const tsName = st.Self.DNSName.replace(/\.$/, '');
const myLogin = st.User?.[st.Self.UserID]?.LoginName;
const shortName = tsName.split('.')[0];
const allowedHosts = new Set([tsName, `127.0.0.1:${PORT}`, `localhost:${PORT}`]);

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
let state = { tokens: [], push: { current: null, old: null } };
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });

let pairCode = newCode();
let pairFails = 0;
const pushResults = [];

function newCode() {
  const c = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  console.log(`\n  페어링 코드: ${c}   (주소: https://${tsName})\n`);
  return c;
}

function log(line) {
  const s = `${new Date().toISOString()} ${line}`;
  console.log(s);
  fs.appendFileSync(LOG, s + '\n');
}

function reqLine(req, note) {
  const h = req.headers;
  const pick = ['host', 'origin', 'tailscale-user-login', 'sec-fetch-site', 'sec-fetch-mode',
    'access-control-request-method', 'access-control-request-headers',
    'access-control-request-private-network', 'access-control-request-local-network', 'last-event-id'];
  const parts = pick.filter((k) => h[k] !== undefined).map((k) => `${k}=${h[k]}`);
  if (h.authorization) parts.push('authorization=Bearer …' + h.authorization.slice(-4));
  return `${req.method} ${req.url} ${note} | ${parts.join(' ')}`;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Vary', 'Origin');
}

function send(res, code, body) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 64 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
  });
}

function tokenOk(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const got = crypto.createHash('sha256').update(m[1]).digest('hex');
  return state.tokens.some((t) => t.hash === got);
}

async function sendPush(which) {
  const p = state.push[which];
  if (!p) return { which, error: 'no subscription' };
  const sentAt = Date.now();
  const payload = JSON.stringify({ title: `ddak 실험 · ${shortName}`, body: `${which} 키로 보냄`, sentAt, from: shortName, tag: `spike-${which}` });
  try {
    const r = await webpush.sendNotification(p.subscription, payload, {
      vapidDetails: { subject: 'https://madsys11.github.io/ddak-mobile-spike/', publicKey: p.vapid.publicKey, privateKey: p.vapid.privateKey },
      TTL: 600,
      urgency: 'high',
    });
    return { which, status: r.statusCode, sentAt };
  } catch (e) {
    return { which, status: e.statusCode, error: String(e.body || e.message).slice(0, 300), sentAt };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const h = req.headers;

  // 1. 모든 요청: Host
  if (!allowedHosts.has(h.host)) { log(reqLine(req, '421 host')); res.writeHead(421).end(); return; }

  // 2. OPTIONS: Origin·메서드·헤더만 보고 데이터 없이 답한다
  if (req.method === 'OPTIONS') {
    const asked = (h['access-control-request-headers'] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const ok = h.origin === ORIGIN && ['GET', 'POST'].includes(h['access-control-request-method'])
      && asked.every((x) => ALLOW_HEADERS.includes(x));
    log(reqLine(req, ok ? '204 preflight' : '403 preflight'));
    if (!ok) { res.writeHead(403).end(); return; }
    cors(res);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS.join(', '));
    res.setHeader('Access-Control-Max-Age', '600');
    // 예전 PNA 미리 보내기를 쓰는 브라우저용. 권한 방식(LNA)에서는 쓰이지 않는다.
    if (h['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (h['access-control-request-local-network'] === 'true') res.setHeader('Access-Control-Allow-Local-Network', 'true');
    res.writeHead(204).end();
    return;
  }

  // 3. 나머지: Origin + Tailscale 신원 (+ 페어링이 아니면 Bearer)
  if (h.origin !== ORIGIN) { log(reqLine(req, '403 origin')); send(res, 403, { error: 'origin' }); return; }
  const login = h['tailscale-user-login'];
  if (!login || (myLogin && login !== myLogin)) {
    log(reqLine(req, '403 tailscale-user-login'));
    send(res, 403, { error: login ? 'tailscale user mismatch' : 'no Tailscale-User-Login' });
    return;
  }

  try {
    if (req.method === 'POST' && url.pathname === '/api/pair') {
      const body = await readJson(req);
      if (body.code !== pairCode) {
        pairFails++;
        log(reqLine(req, `401 pair (실패 ${pairFails})`));
        if (pairFails >= 5) { pairFails = 0; pairCode = newCode(); }
        send(res, 401, { error: 'code' });
        return;
      }
      const token = crypto.randomBytes(32).toString('base64url');
      state.tokens.push({ hash: crypto.createHash('sha256').update(token).digest('hex'), at: new Date().toISOString(), ua: h['user-agent'] });
      save();
      pairFails = 0;
      pairCode = newCode();
      log(reqLine(req, '200 pair'));
      send(res, 200, { token, name: shortName });
      return;
    }

    if (!tokenOk(req)) { log(reqLine(req, '401 token')); send(res, 401, { error: 'token' }); return; }

    if (req.method === 'GET' && url.pathname === '/api/info') {
      log(reqLine(req, '200 info'));
      send(res, 200, { name: shortName, login, time: Date.now(), hasPush: !!state.push.current });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      log(reqLine(req, '200 events open'));
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      let id = Number(h['last-event-id'] || 0);
      res.write(`id: ${id}\nevent: hello\ndata: ${JSON.stringify({ name: shortName, resumedFrom: id })}\n\n`);
      const t = setInterval(() => {
        id++;
        res.write(`id: ${id}\ndata: ${JSON.stringify({ n: id, time: Date.now() })}\n\n`);
      }, 5000);
      req.on('close', () => { clearInterval(t); log(`events closed (${req.url}, 마지막 id ${id})`); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
      const body = await readJson(req);
      if (!body.subscription?.endpoint || !body.vapid?.publicKey || !body.vapid?.privateKey) { send(res, 400, { error: 'body' }); return; }
      if (state.push.current && state.push.current.vapid.publicKey !== body.vapid.publicKey) state.push.old = state.push.current;
      state.push.current = { subscription: body.subscription, vapid: body.vapid, at: new Date().toISOString() };
      save();
      log(reqLine(req, `200 subscribe ${new URL(body.subscription.endpoint).host}`));
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/push/test') {
      const body = await readJson(req);
      const which = body.which === 'old' ? 'old' : 'current';
      const delay = Math.min(Math.max(Number(body.delay) || 0, 0), 600);
      log(reqLine(req, `202 push test ${which} in ${delay}s`));
      send(res, 202, { which, delay });
      setTimeout(async () => {
        const r = await sendPush(which);
        pushResults.unshift(r);
        pushResults.length = Math.min(pushResults.length, 20);
        log(`push ${which}: ${JSON.stringify(r)}`);
      }, delay * 1000);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/push/results') {
      send(res, 200, { results: pushResults });
      return;
    }

    log(reqLine(req, '404'));
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log(reqLine(req, `400 ${e.message}`));
    send(res, 400, { error: String(e.message) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening 127.0.0.1:${PORT}, origin ${ORIGIN}, tokens ${state.tokens.length}`);
});
