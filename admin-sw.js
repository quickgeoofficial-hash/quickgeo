/* Quickgeo Admin — Service Worker v2 */
const CACHE = 'qg-admin-v2';

// Only cache these static assets on install
const STATIC_ASSETS = [
  './admin.html'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('SW install cache failed:', err))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // NEVER intercept these — always go straight to network
  if (
    url.includes('trycloudflare.com') ||  // your phone server
    url.includes('cloudflare.com') ||
    url.includes('giphy.com') ||
    url.includes('translate.googleapis.com') ||
    url.includes('googlesyndication') ||
    url.includes('doubleclick.net') ||
    url.includes('netlify') ||
    e.request.method !== 'GET'
  ) {
    return; // let browser handle it normally
  }

  // For everything else: network first, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Only cache successful same-origin or font responses
        if (res.ok && (url.startsWith(self.location.origin) || url.includes('fonts.g'))) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
