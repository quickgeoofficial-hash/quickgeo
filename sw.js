const CACHE = 'qg-user-v4';
const CORE = ['./index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // NEVER intercept non-GET requests (POST/DELETE/PATCH) — Cache API only supports GET
  if (e.request.method !== 'GET') return;

  // Only handle same-origin requests. Cross-origin scripts (ads, analytics beacon)
  // must go straight to the network, otherwise the SW's fetch() is subject to connect-src.
  if (new URL(e.request.url).origin !== self.location.origin) return;

  // Never intercept API calls, ads, translate, giphy, or uploads
  if (
    url.includes('api.quickgeo.live') ||
    url.includes('googlesyndication') ||
    url.includes('doubleclick') ||
    url.includes('translate.googleapis') ||
    url.includes('giphy.com')
  ) return;

  // Network first, fall back to cache for everything else
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Only cache successful GET responses
        if (res.ok && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || Response.error()))
  );
});

/* ── PUSH NOTIFICATIONS (sent only when the admin presses "Notify" on a post) ── */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const opts = {
    body: d.body || '',
    icon: d.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || 'qg-update',
    data: { url: d.url || '/', postId: d.postId || null }
  };
  if (d.image) opts.image = d.image;
  e.waitUntil(self.registration.showNotification(d.title || 'Quickgeo', opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Quickgeo already open: bring it to the front and ask it to scroll to the post (no reload needed)
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: 'qg-open-post', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
