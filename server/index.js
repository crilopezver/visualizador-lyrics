// Visualizador Lyrics — servidor local. Node 20+. Una sola dependencia: ws.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Almacen } from './almacen.js';
import { Estado } from './estado.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ_APP = path.join(AQUI, '..');
const WEB = path.join(RAIZ_APP, 'web');
const PUERTO = Number(process.env.PUERTO || 8080);
const VERSION = JSON.parse(fs.readFileSync(path.join(RAIZ_APP, 'package.json'), 'utf8')).version;
const ARRANQUE = Date.now();
// Huella de la app: cambia con cualquier cambio en los archivos del cliente. Se inyecta en sw.js para que cada despliegue
// sea una caché nueva y completa (los celulares no mezclan versiones; Paper 10, hallazgo 1).
const ARCHIVOS_APP = ['index.html', 'css/app.css', 'js/app.js', 'js/chordpro.js', 'manifest.webmanifest', 'icono.svg'];
let huellaCache = { firma: '', valor: '' };
function huellaApp() { // se recalcula sola cuando cambia algún archivo (por fecha y tamaño), sin relanzar el servidor
  const firma = ARCHIVOS_APP.map(f => { try { const st = fs.statSync(path.join(AQUI, '..', 'web', f)); return f + st.mtimeMs + st.size; } catch { return f; } }).join('|');
  if (firma === huellaCache.firma) return huellaCache.valor;
  const h = crypto.createHash('sha1');
  for (const f of ARCHIVOS_APP) { try { h.update(fs.readFileSync(path.join(AQUI, '..', 'web', f))); } catch {} }
  huellaCache = { firma, valor: h.digest('hex').slice(0, 10) }; return huellaCache.valor;
}

// Carpeta de datos: variable DATOS, o ../datos (fuera del repo); si no existe, datos.ejemplo.
let DATOS = process.env.DATOS ? path.resolve(process.env.DATOS) : path.join(RAIZ_APP, '..', 'datos');
if (!fs.existsSync(path.join(DATOS, 'canciones'))) {
  DATOS = path.join(RAIZ_APP, 'datos.ejemplo');
  console.log('⚠️  No hay carpeta de datos real; usando datos.ejemplo (una canción inventada).');
}
const almacen = new Almacen(DATOS);
const estado = new Estado(almacen);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4' };

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
}
function leerCuerpo(req) {
  return new Promise((ok, ko) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 2e6) ko(new Error('demasiado grande')); });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { ko(e); } });
  });
}
function rolPorPin(pin) {
  const u = almacen.usuarios();
  if (pin && pin === u.director?.pin) return 'director';
  if (pin && pin === u.cantante?.pin) return 'cantante';
  return 'musico';
}
// La propia Mac (conexión por localhost) es del director: no necesita PIN. Los celulares entran por la IP de red y sí lo necesitan.
const LOCALES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const esLocal = req => LOCALES.has(req.socket?.remoteAddress);
function ipsLocales() {
  const out = [];
  for (const [nombre, lista] of Object.entries(os.networkInterfaces()))
    for (const i of lista) if (i.family === 'IPv4' && !i.internal) out.push({ nombre, ip: i.address });
  return out;
}

const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    // ---------- API ----------
    if (p.startsWith('/api/')) {
      const partes = p.split('/').filter(Boolean); // ['api', recurso, id, ...]
      const rec = partes[1], id = partes[2];
      const local = esLocal(req);
      let rol = rolPorPin(req.headers['x-pin']); if (rol === 'musico' && local) rol = 'director';
      if (rec === 'info') return json(res, 200, { version: VERSION, huella: huellaApp(), puerto: PUERTO, ips: ipsLocales(), datos: path.basename(DATOS), ejemplo: DATOS.endsWith('datos.ejemplo'), local, arranque: ARRANQUE });
      if (rec === 'apagar') { // solo desde la propia Mac (panel de control)
        if (!local || req.method !== 'POST') return json(res, 403, { error: 'solo desde la Mac' });
        json(res, 200, { ok: true }); console.log('Apagado desde el panel de la Mac.'); setTimeout(() => process.exit(0), 300); return;
      }
      if (rec === 'estado') return json(res, 200, estado.snapshot());
      if (rec === 'rol') return json(res, 200, { rol });
      if (rec === 'integrantes') return json(res, 200, almacen.leerIntegrantes().map(i => ({ nombre: i.nombre, instrumento: i.instrumento || '', rol: i.rol || 'musico', ultimaConexion: i.ultimaConexion || null })));
      if (rec === 'canciones') {
        if (req.method === 'GET' && !id) return json(res, 200, almacen.indiceCanciones());
        if (req.method === 'GET') { const cho = almacen.leerCancion(id); return cho === null ? json(res, 404, { error: 'no existe' }) : json(res, 200, { id, cho }); }
        if (rol !== 'director') return json(res, 403, { error: 'solo el director edita canciones' });
        if (req.method === 'DELETE' && id) { // borrar (a la papelera); sale del vivo, la cola y el historial
          if (!almacen.eliminarCancion(id)) return json(res, 404, { error: 'no existe' });
          estado.quitarCancion(id); difundir(); avisarCancion(id); return json(res, 200, { id, borrada: true });
        }
        const cuerpo = await leerCuerpo(req);
        if (typeof cuerpo.cho !== 'string') return json(res, 400, { error: 'falta cho' });
        if (req.method === 'POST') { const nuevo = almacen.crearCancion(cuerpo.cho); avisarCancion(nuevo); return json(res, 201, { id: nuevo }); }
        if (req.method === 'PUT' && id) { almacen.guardarCancion(id, cuerpo.cho); avisarCancion(id); return json(res, 200, { id }); }
      }
      if (rec === 'generos') {
        const g = new Set(); for (const c of almacen.indiceCanciones()) if (c.genero) g.add(c.genero);
        return json(res, 200, [...g].sort((a, b) => a.localeCompare(b)));
      }
      if (rec === 'secciones') {
        // nombres de sección en uso en todo el repertorio (para reutilizarlos al marcar secciones)
        const nombres = new Set();
        for (const c of almacen.indiceCanciones()) { const cho = almacen.leerCancion(c.id) || ''; for (const m of cho.matchAll(/^\{\s*secci[oó]n\s*:\s*(.+?)\s*\}\s*$/gim)) if (m[1]) nombres.add(m[1]); }
        return json(res, 200, [...nombres].sort((a, b) => a.localeCompare(b)));
      }
      if (rec === 'setlists') {
        if (req.method === 'GET' && !id) return json(res, 200, almacen.indiceSetlists());
        if (req.method === 'GET') { const s = almacen.leerSetlist(id); return s ? json(res, 200, { id, ...s }) : json(res, 404, { error: 'no existe' }); }
        if (rol !== 'director') return json(res, 403, { error: 'solo el director edita setlists' });
        const cuerpo = await leerCuerpo(req);
        const nuevoId = id || ((cuerpo.fecha || new Date().toISOString().slice(0, 10)) + '-' + String(cuerpo.nombre || 'setlist').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
        almacen.guardarSetlist(nuevoId, cuerpo); return json(res, 200, { id: nuevoId });
      }
      if (rec === 'notas') {
        const usuario = decodeURIComponent(id || ''), cancion = partes[3];
        if (!usuario || !cancion) return json(res, 400, { error: 'ruta: /api/notas/<usuario>/<cancion>' });
        if (req.method === 'GET') return json(res, 200, { texto: almacen.leerNota(usuario, cancion) });
        if (req.method === 'PUT') { const c = await leerCuerpo(req); almacen.guardarNota(usuario, cancion, String(c.texto || '')); return json(res, 200, { ok: true }); }
      }
      return json(res, 404, { error: 'ruta desconocida' });
    }
    // ---------- estáticos ----------
    let rel = p === '/' ? '/index.html' : p === '/mac' ? '/mac.html' : p;
    if (rel === '/sw.js') { // versión de caché = huella de la app de este arranque
      const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = 'v${VERSION}-${huellaApp()}';`);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(sw);
    }
    const ruta = path.normalize(path.join(WEB, rel));
    if (!ruta.startsWith(WEB) || !fs.existsSync(ruta) || fs.statSync(ruta).isDirectory()) { res.writeHead(404); return res.end('no encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(ruta)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(ruta).pipe(res);
  } catch (e) {
    console.error(e); json(res, 500, { error: String(e.message || e) });
  }
});

// ---------- WebSocket: sincronía en vivo ----------
const wss = new WebSocketServer({ server: servidor, path: '/ws' });
function avisarCancion(id) { // una canción cambió en disco: los clientes descartan su copia
  const m = JSON.stringify({ tipo: 'cancion-cambiada', id });
  for (const c of wss.clients) if (c.readyState === 1) c.send(m);
}
function difundir() {
  const m = JSON.stringify({ tipo: 'estado', estado: estado.snapshot() });
  for (const c of wss.clients) if (c.readyState === 1) c.send(m);
}
wss.on('connection', (ws, req) => {
  const local = esLocal(req);
  let perfil = { nombre: 'anónimo', rol: 'musico', instrumento: '' };
  ws.on('message', datos => {
    let msg; try { msg = JSON.parse(datos); } catch { return; }
    if (msg.tipo === 'hola') {
      perfil = { nombre: String(msg.nombre || 'anónimo').slice(0, 40), instrumento: String(msg.instrumento || '').slice(0, 30), rol: 'musico', clienteId: String(msg.clienteId || '').slice(0, 40) || null };
      const deseado = msg.rol;
      const porPin = rolPorPin(msg.pin);
      if ((deseado === 'director' || deseado === 'cantante') && porPin === deseado) perfil.rol = deseado;
      else if (deseado === 'director' && local) perfil.rol = 'director'; // la propia Mac
      estado.conectados.set(ws, perfil);
      // registro de quién entró: si el nombre coincide con un integrante, se anota su última conexión (fila 126)
      try { const lista = almacen.leerIntegrantes(); const yo = lista.find(i => String(i.nombre).trim().toLowerCase() === perfil.nombre.trim().toLowerCase()); if (yo) { yo.ultimaConexion = new Date().toISOString(); almacen.guardarIntegrantes(lista); } } catch (e) { console.error('integrantes:', e.message); }
      ws.send(JSON.stringify({ tipo: 'bienvenida', rol: perfil.rol, estado: estado.snapshot() }));
      difundir(); return;
    }
    if (estado.aplicar(msg, perfil.rol, perfil.clienteId)) difundir();
    else ws.send(JSON.stringify({ tipo: 'rechazado', motivo: 'sin permiso o mensaje inválido', original: msg.tipo }));
  });
  ws.on('close', () => { estado.conectados.delete(ws); difundir(); });
});
setInterval(() => { for (const c of wss.clients) if (c.readyState === 1) c.ping(); }, 25000);
// latido visible para el cliente (los pings del protocolo no llegan al JavaScript del celular): si un celular deja de recibirlo, reconecta solo (Paper 10, hallazgo 3)
setInterval(() => { const m = JSON.stringify({ tipo: 'latido' }); for (const c of wss.clients) if (c.readyState === 1) c.send(m); }, 20000);

servidor.listen(PUERTO, '0.0.0.0', () => {
  console.log(`\nVisualizador Lyrics v${VERSION} · datos: ${DATOS}`);
  console.log('Abrir en los celulares (misma red):');
  for (const { nombre, ip } of ipsLocales()) console.log(`   http://${ip}:${PUERTO}   (${nombre})`);
  console.log(`   http://localhost:${PUERTO}   (esta Mac)\n`);
});
