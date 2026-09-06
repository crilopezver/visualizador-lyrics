// Service worker: la app y las canciones quedan guardadas en el teléfono. Sin red, todo lo ya visto sigue disponible.
const VERSION = 'v0.1.1';
const CACHE_APP = 'lyrics-app-' + VERSION;
const CACHE_DATOS = 'lyrics-datos';
const APP = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/chordpro.js', '/manifest.webmanifest', '/icono.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_APP).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('lyrics-app-') && k !== CACHE_APP).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // datos: red primero, y si falla, lo guardado
  if (url.pathname.startsWith('/api/canciones') || url.pathname.startsWith('/api/setlists') || url.pathname.startsWith('/api/notas')) {
    e.respondWith(fetch(e.request).then(r => { if (r.ok) caches.open(CACHE_DATOS).then(c => c.put(e.request, r.clone())); return r; })
      .catch(() => caches.match(e.request).then(r => r || new Response(JSON.stringify({ error: 'sin red y sin copia guardada' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  if (url.pathname.startsWith('/api/')) return; // estado, info, rol: solo en red
  // app: red primero (para que todos vean siempre la última versión), con tope de 2,5 s; si no hay red, lo guardado
  e.respondWith(new Promise(resolver => {
    let resuelto = false;
    const usarCache = () => caches.match(e.request).then(hit => { if (!resuelto) { resuelto = true; resolver(hit || new Response('sin red', { status: 503 })); } });
    const tope = setTimeout(usarCache, 2500);
    fetch(e.request).then(r => {
      clearTimeout(tope);
      if (r.ok) caches.open(CACHE_APP).then(c => c.put(e.request, r.clone()));
      if (!resuelto) { resuelto = true; resolver(r); }
    }).catch(() => { clearTimeout(tope); usarCache(); });
  }));
});
