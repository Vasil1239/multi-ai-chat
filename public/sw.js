// AskHub service worker - минимальный оффлайн-кэш для оболочки
const CACHE = 'askhub-v1';
const SHELL = ['/', '/index.html', '/manifest.json', '/img/hero.jpg', '/img/chat.jpg', '/img/icon-192.png', '/img/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Никогда не кэшируем API
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok && url.origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      }
      return res;
    }).catch(() => caches.match('/')))
  );
});
