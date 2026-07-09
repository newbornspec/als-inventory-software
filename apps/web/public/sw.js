const CACHE_NAME = 'als-inventory-shell-v1';
const SHELL_URLS = ['/scan', '/login'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first, falling back to cache, falling back to the /scan shell.
// This is purely so the installed app can still *open* with zero
// connectivity — the actual offline data (assets, scan writes) is handled
// entirely by PowerSync's local SQLite, not by this cache.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.url.includes('/api/')) return; // never cache auth/data endpoints

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/scan'))),
  );
});
