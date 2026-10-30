// Service worker: fa funzionare l'app anche offline.
// I file dell'app vengono presi prima dalla rete (così gli aggiornamenti arrivano subito) e,
// se non c'è connessione, dalla cache. Le librerie esterne restano in cache.
// Le chiamate al database (supabase.co) non passano mai dalla cache.
const CACHE = 'productive-life-v1';
const APP_FILES = ['./', './index.html', './config.js', './sync.js', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];
const LIBS = [
  'https://cdn.tailwindcss.com/3.4.17',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_FILES);
    await Promise.all(LIBS.map(url => fetch(url, { mode: 'no-cors' }).then(res => cache.put(url, res)).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return;

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch (e) {
        return (await caches.match(req, { ignoreSearch: true })) || (await caches.match('./index.html'));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});
