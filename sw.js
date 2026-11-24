const CACHE_NAME = 'crewtips-v13';

const STATIC_ASSETS = [
  './',
  './index.html',
  './calculator.html',
  './links.html',
  './manifest.json'
];

// Install: cache static shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches and reload all clients
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => {
      return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => client.navigate(client.url));
      });
    })
  );
  self.clients.claim();
});

const NETWORK_TIMEOUT_MS = 4000;

function networkFirstWithTimeout(event, request) {
  const networkFetch = fetch(request).then(response => {
    if (response && response.status === 200) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
    }
    return response;
  });
  // Keep the worker alive so a slow request can still refresh the cache,
  // and make sure a failure here is never reported as an unhandled error.
  event.waitUntil(networkFetch.catch(() => {}));

  const timeout = new Promise(resolve => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
  return Promise.race([networkFetch.catch(() => null), timeout]).then(response => {
    if (response) return response;
    // Timed out or failed: saved copy if we have one, otherwise keep waiting for the network
    return caches.match(request).then(cached => cached || networkFetch);
  });
}

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)(\?|$)/i;

// Fetch strategy:
// - HTML files: network first, fall back to cache (ensures app always checks for updates)
// - Dropbox data.json: always network, never cache (it changes)
// - Dropbox images (FAQ attachments): cache first — these are immutable
//   once uploaded (each has a unique filename), so once a pilot has
//   tapped "View image" successfully once, it's cached on-device for
//   instant, fully offline reuse afterward. Nothing downloads until the
//   first tap, protecting the shared bandwidth cap.
// - Everything else: cache first, fall back to network
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.hostname.includes('dropbox')) {
    if (IMAGE_EXT_RE.test(url.pathname)) {
      event.respondWith(
        caches.match(event.request).then(cached => {
          return cached || fetch(event.request).then(response => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          });
        })
      );
      return;
    }

    // Non-image Dropbox calls (data.json) — never cache
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // HTML files and manifest.json — network first so updates (including
  // manifest changes like the orientation setting) are always picked up,
  // rather than being served from a stale cached copy indefinitely.
  // But with a time limit: on a slow or half-dead connection the request can
  // hang without ever failing, which left the app stuck on its opening screen.
  // After NETWORK_TIMEOUT_MS we show the saved copy instead, and the network
  // request carries on in the background to refresh the cache for next time.
  if (url.pathname.endsWith('.html') || url.pathname.endsWith('/') || url.pathname.endsWith('manifest.json')) {
    event.respondWith(networkFirstWithTimeout(event, event.request));
    return;
  }

  // Everything else — cache first
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
