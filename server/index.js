// Visualizador Lyrics — servidor local. Node 20+. Una sola dependencia: ws.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Almacen } from './almacen.js';
import { Estado } from './estado.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ_APP = path.join(AQUI, '..');
const WEB = path.join(RAIZ_APP, 'web');
const PUERTO = Number(process.env.PUERTO || 8080);
const VERSION = JSON.parse(fs.readFileSync(path.join(RAIZ_APP, 'package.json'), 'utf8')).version;

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
      const rol = rolPorPin(req.headers['x-pin']);
      if (rec === 'info') return json(res, 200, { version: VERSION, puerto: PUERTO, ips: ipsLocales(), datos: path.basename(DATOS), ejemplo: DATOS.endsWith('datos.ejemplo') });
      if (rec === 'estado') return json(res, 200, estado.snapshot());
      if (rec === 'rol') return json(res, 200, { rol });
      if (rec === 'canciones') {
        if (req.method === 'GET' && !id) return json(res, 200, almacen.indiceCanciones());
        if (req.method === 'GET') { const cho = almacen.leerCancion(id); return cho === null ? json(res, 404, { error: 'no existe' }) : json(res, 200, { id, cho }); }
        if (rol !== 'director') return json(res, 403, { error: 'solo el director edita canciones' });
        const cuerpo = await leerCuerpo(req);
        if (typeof cuerpo.cho !== 'string') return json(res, 400, { error: 'falta cho' });
        if (req.method === 'POST') return json(res, 201, { id: almacen.crearCancion(cuerpo.cho) });
        if (req.method === 'PUT' && id) { almacen.guardarCancion(id, cuerpo.cho); return json(res, 200, { id }); }
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
    let rel = p === '/' ? '/index.html' : p;
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
function difundir() {
  const m = JSON.stringify({ tipo: 'estado', estado: estado.snapshot() });
  for (const c of wss.clients) if (c.readyState === 1) c.send(m);
}
wss.on('connection', ws => {
  let perfil = { nombre: 'anónimo', rol: 'musico', instrumento: '' };
  ws.on('message', datos => {
    let msg; try { msg = JSON.parse(datos); } catch { return; }
    if (msg.tipo === 'hola') {
      perfil = { nombre: String(msg.nombre || 'anónimo').slice(0, 40), instrumento: String(msg.instrumento || '').slice(0, 30), rol: 'musico', clienteId: String(msg.clienteId || '').slice(0, 40) || null };
      const deseado = msg.rol;
      const porPin = rolPorPin(msg.pin);
      if ((deseado === 'director' || deseado === 'cantante') && porPin === deseado) perfil.rol = deseado;
      estado.conectados.set(ws, perfil);
      ws.send(JSON.stringify({ tipo: 'bienvenida', rol: perfil.rol, estado: estado.snapshot() }));
      difundir(); return;
    }
    if (estado.aplicar(msg, perfil.rol, perfil.clienteId)) difundir();
    else ws.send(JSON.stringify({ tipo: 'rechazado', motivo: 'sin permiso o mensaje inválido', original: msg.tipo }));
  });
  ws.on('close', () => { estado.conectados.delete(ws); difundir(); });
});
setInterval(() => { for (const c of wss.clients) if (c.readyState === 1) c.ping(); }, 25000);

servidor.listen(PUERTO, '0.0.0.0', () => {
  console.log(`\nVisualizador Lyrics v${VERSION} · datos: ${DATOS}`);
  console.log('Abrir en los celulares (misma red):');
  for (const { nombre, ip } of ipsLocales()) console.log(`   http://${ip}:${PUERTO}   (${nombre})`);
  console.log(`   http://localhost:${PUERTO}   (esta Mac)\n`);
});
