const CACHE = 'qg-user-v3';
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

/* ════════════════════════════
   WEB PUSH — admin-triggered post notifications
   (only fires when the admin presses "Notify" on a post)
════════════════════════════ */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const postId = /^\d{1,20}$/.test(String(d.postId || '')) ? String(d.postId) : '';
  e.waitUntil(self.registration.showNotification(String(d.title || 'Quickgeo').slice(0, 100), {
    body: String(d.body || '').slice(0, 300),
    icon: './icon-192.png',
    tag: postId ? 'qg-post-' + postId : 'qg-update', // same post can never stack twice on screen
    data: { postId }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const postId = e.notification.data && e.notification.data.postId;
  const url = new URL(postId ? './#post-' + postId : './', self.registration.scope).href;
  const home = new URL('./', self.registration.scope).pathname;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(c => new URL(c.url).origin === self.location.origin);
    if (win) {
      try { await win.focus(); } catch {}
      const p = new URL(win.url).pathname;
      if (postId && (p === home || p === home + 'index.html')) { win.postMessage({ type: 'qg-open-post', postId }); return; }
      try { await win.navigate(url); return; } catch {}
    }
    await self.clients.openWindow(url);
  })());
});
