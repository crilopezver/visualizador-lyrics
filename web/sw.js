// Service worker: la app entera queda guardada en el teléfono (solo se instala por HTTPS o localhost: regla de los navegadores, Paper 13).
// Las canciones, setlists y notas NO pasan por aquí: viven en IndexedDB (web/js/datos.js) y se sincronizan por versión.
// La VERSION la inyecta el servidor con la huella de los archivos de la app: cada despliegue es una caché nueva y completa,
// así ningún celular mezcla un index.html nuevo con un app.js viejo (Paper 10, hallazgo 1).
const VERSION = 'v0.0.0-dev';
const CACHE_APP = 'lyrics-app-' + VERSION;
const APP = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/chordpro.js', '/js/datos.js', '/js/estado-comun.js', '/js/nube.js', '/js/nube.config.js', '/js/vendor/supabase.js', '/manifest.webmanifest', '/icono.svg', '/wake.mp4'];

self.addEventListener('install', e => {
  // precarga atómica: o entra el conjunto completo de esta versión, o no entra nada
  e.waitUntil(caches.open(CACHE_APP).then(c => c.addAll(APP.map(u => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => (k.startsWith('lyrics-app-') && k !== CACHE_APP) || k === 'lyrics-datos').map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    .then(() => self.clients.matchAll({ type: 'window' }).then(cs => cs.forEach(c => c.postMessage({ tipo: 'nueva-version', version: VERSION })))));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js' || url.pathname === '/mac' || url.pathname === '/mac.html') return; // datos y panel: solo en red
  // app: desde la caché de esta versión (conjunto coherente); lo que no esté precargado, red y luego caché.
  // ignoreSearch: "/?banda=…" (enlace de instalación) es la misma página que "/"; si no, se mezclaría un index.html de la red con un app.js de la caché.
  const clave = e.request.mode === 'navigate' ? new Request(url.origin + '/', { cache: 'no-cache' }) : e.request;
  e.respondWith(caches.match(clave, { cacheName: CACHE_APP, ignoreSearch: true }).then(hit => hit || fetch(e.request).then(r => { if (r.ok) caches.open(CACHE_APP).then(c => c.put(clave, r.clone())); return r; })
    .catch(() => caches.match(clave, { ignoreSearch: true }).then(r => r || new Response('sin red', { status: 503 })))));
});
