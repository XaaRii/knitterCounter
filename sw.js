const CACHE_NAME = 'knit-counter-pwa-v4';
const CORE_ASSETS = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];
const OPTIONAL_ASSETS = [
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      for (const url of CORE_ASSETS) {
        const response = await fetch(url, { cache: 'reload' });
        if (!response.ok) {
          throw new Error(`Nepodařilo se načíst ${url}: HTTP ${response.status}`);
        }
        await cache.put(url, response);
      }

      await Promise.allSettled(
        OPTIONAL_ASSETS.map(async (url) => {
          const response = await fetch(url, { cache: 'reload' });
          if (response.ok) await cache.put(url, response);
        })
      );
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            }
            return response;
          })
          .catch(() => caches.match('./index.html'))
      );
    })
  );
});