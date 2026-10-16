// Offline cache for the installed app. CACHE changes with every build,
// so a new build replaces the cached files.
const VERSION = '7763510ec558';
const CACHE = 'plutonano-' + VERSION;
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

// Fetch past both the browser's HTTP cache and the Pages CDN (keyed on the
// query), otherwise a stale index.html can be cached as the new version.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(FILES.map((f) =>
    fetch(`${f}?v=${VERSION}`, { cache: 'reload' }).then((r) => {
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      return c.put(f, r);
    }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
