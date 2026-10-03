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
