// Service worker: la app y las canciones quedan guardadas en el teléfono. Sin red, todo lo ya visto sigue disponible.
// La VERSION la inyecta el servidor con la huella de los archivos de la app: cada despliegue es una caché nueva y completa,
// así ningún celular mezcla un index.html nuevo con un app.js viejo (Paper 10, hallazgo 1).
const VERSION = 'v0.0.0-dev';
const CACHE_APP = 'lyrics-app-' + VERSION;
const CACHE_DATOS = 'lyrics-datos';
const APP = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/chordpro.js', '/manifest.webmanifest', '/icono.svg'];

self.addEventListener('install', e => {
  // precarga atómica: o entra el conjunto completo de esta versión, o no entra nada
  e.waitUntil(caches.open(CACHE_APP).then(c => c.addAll(APP.map(u => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('lyrics-app-') && k !== CACHE_APP).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    .then(() => self.clients.matchAll({ type: 'window' }).then(cs => cs.forEach(c => c.postMessage({ tipo: 'nueva-version', version: VERSION })))));
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
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return; // estado, info, rol y el propio sw: solo en red
  // app: desde la caché de esta versión (conjunto coherente); lo que no esté precargado, red y luego caché
  e.respondWith(caches.match(e.request, { cacheName: CACHE_APP }).then(hit => hit || fetch(e.request).then(r => { if (r.ok) caches.open(CACHE_APP).then(c => c.put(e.request, r.clone())); return r; })
    .catch(() => caches.match(e.request).then(r => r || new Response('sin red', { status: 503 })))));
});
