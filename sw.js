const CACHE = 'qg-user-v3';
const CORE = ['./index.html', './manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

 
  if (request.method !== 'GET') return;


  const requestURL = new URL(request.url);

  if (requestURL.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok && response.status === 200) {
          const clone = response.clone();

          caches.open(CACHE)
            .then(cache => cache.put(request, clone))
            .catch(() => {});
        }

        return response;
      })
      .catch(() => {
        return caches.match(request);
      })
  );
});
