// AskHub service worker - network-first для HTML, чтобы UI-апдейты появлялись сразу
const CACHE = 'askhub-v4';
const STATIC = ['/manifest.json', '/img/hero.jpg', '/img/chat.jpg', '/img/icon-192.png', '/img/icon-512.png', '/img/apple-touch-icon.png', '/img/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Никогда не трогаем API
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return;
  if (e.request.method !== 'GET') return;

  const isHTML =
    e.request.mode === 'navigate' ||
    (e.request.headers.get('accept') || '').includes('text/html') ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/' ;

  if (isHTML) {
    // network-first: всегда пытаемся взять свежий HTML, иначе fallback на кэш
    e.respondWith((async () => {
      try {
        const res = await fetch(e.request, { cache: 'no-store' });
        if (res && res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        }
        return res;
      } catch (_) {
        const hit = await caches.match(e.request);
        return hit || caches.match('/');
      }
    })());
    return;
  }

  // Статику отдаём cache-first
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res && res.ok && url.origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      }
      return res;
    }).catch(() => caches.match('/')))
  );
});
