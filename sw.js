// Service worker : rend l'appli utilisable hors connexion.
// Après une modification des fichiers de l'appli, incrémente VERSION.
const VERSION = 'v7';
const CORE = `core-${VERSION}`;
const IMAGES = 'images-v1';
const ASSETS = [
  './', './index.html', './styles.css', './cloud.js', './app.js', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CORE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CORE && k !== IMAGES).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // Fichiers de l'appli : réponse immédiate depuis le cache, mise à jour en arrière-plan
    const fresh = fetch(req).then(async res => {
      if (res.ok) await (await caches.open(CORE)).put(req, res.clone());
      return res;
    });
    e.waitUntil(fresh.catch(() => {}));
    e.respondWith((async () => {
      const cache = await caches.open(CORE);
      const cached = await cache.match(req, { ignoreSearch: true })
        || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      return cached || fresh.catch(() => Response.error());
    })());
  } else if (req.destination === 'image') {
    // Images externes (liens https dans les cartes) : gardées en cache une fois vues
    e.respondWith((async () => {
      const cache = await caches.open(IMAGES);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      } catch {
        return Response.error();
      }
    })());
  }
});
