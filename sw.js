// 푸시를 받아 알림으로 보여 준다. 도착까지 걸린 시간을 본문에 붙인다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'ddak 실험', body: e.data ? e.data.text() : '' }; }
  const took = d.sentAt ? ` · 도착까지 ${((Date.now() - d.sentAt) / 1000).toFixed(1)}초` : '';
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'ddak 실험', { body: (d.body || '') + took, tag: d.tag, data: d }),
    self.clients.matchAll({ type: 'window' }).then((ws) => ws.forEach((w) => w.postMessage({ type: 'push', d, took }))),
  ]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    for (const w of ws) if ('focus' in w) return w.focus();
    return self.clients.openWindow('./');
  }));
});
