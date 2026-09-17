// Copia de los datos en este celular (Paper 13, fila 214): canciones, setlists y notas viven en IndexedDB y la app trabaja
// siempre desde ahí. Con conexión se sincroniza por versión (solo baja lo que cambió) y sube lo que se guardó sin conexión.
// Sin conexión: leer todo, y guardar cambios como "pendientes de sincronizar". Reglas de conflicto (Cristhian, 17-sep):
// lo nuevo sube tal cual; una corrección a una canción existente se aplica si la Mac no la tocó desde la última sincronización;
// si la tocó, la versión del celular se guarda como copia "Título (edición de X, fecha)" y el director la resuelve.

const DB = 'lyrics', VERSION_DB = 1;
let dbp = null;
function abrir() {
  if (dbp) return dbp;
  dbp = new Promise((ok, ko) => {
    let req; try { req = indexedDB.open(DB, VERSION_DB); } catch (e) { return ko(e); }
    req.onupgradeneeded = () => { const d = req.result; for (const s of ['canciones', 'setlists', 'kv']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    req.onsuccess = () => ok(req.result); req.onerror = () => ko(req.error); req.onblocked = () => ko(new Error('bloqueada'));
  }).catch(e => { console.warn('IndexedDB no disponible:', e && e.message); return null; });
  return dbp;
}
async function tx(store, modo, fn) {
  const d = await abrir(); if (!d) return undefined;
  return new Promise((ok, ko) => { const t = d.transaction(store, modo); const r = fn(t.objectStore(store)); t.oncomplete = () => ok(r && 'result' in r ? r.result : r); t.onerror = () => ko(t.error); t.onabort = () => ko(t.error); });
}
const get = (store, k) => tx(store, 'readonly', s => s.get(k));
const put = (store, k, v) => tx(store, 'readwrite', s => s.put(v, k));
const del = (store, k) => tx(store, 'readwrite', s => s.delete(k));
const todasClaves = store => tx(store, 'readonly', s => s.getAllKeys());
const kvGet = async (k, d) => { const v = await get('kv', k); return v === undefined ? d : v; };
const kvPut = (k, v) => put('kv', k, v);

// ---------- configuración desde la app ----------
let cfg = { cabeceras: () => ({}), quien: () => '', alCambiar: () => {} };
export function configurar(c) { cfg = { ...cfg, ...c }; }
const esFalloDeRed = e => e instanceof TypeError || (e && e.sinRed); // fetch rechaza con TypeError cuando no llega al servidor
async function api(ruta, opciones = {}) {
  let r;
  try { r = await fetch(ruta, { ...opciones, headers: { 'Content-Type': 'application/json', ...cfg.cabeceras(), ...(opciones.headers || {}) } }); }
  catch (e) { const err = new Error('sin conexión'); err.sinRed = true; throw err; }
  if (!r.ok) { const err = new Error((await r.json().catch(() => ({}))).error || r.statusText); err.http = r.status; throw err; }
  return r.json();
}
// Fuente de datos: la Mac (API local) o la nube (nube.js). Misma interfaz; la copia local no distingue (fila 214: primero la Mac, si no la nube).
const fuenteMac = {
  nombre: 'mac',
  indiceCanciones: () => api('/api/canciones'),
  cancion: async id => (await api(`/api/canciones/${id}`)).cho,
  guardarCancion: (id, cho) => api(`/api/canciones/${id}`, { method: 'PUT', body: JSON.stringify({ cho }) }),
  crearCancion: async cho => (await api('/api/canciones', { method: 'POST', body: JSON.stringify({ cho }) })).id,
  borrarCancion: id => api(`/api/canciones/${id}`, { method: 'DELETE' }),
  indiceSetlists: () => api('/api/setlists'),
  setlist: id => api(`/api/setlists/${id}`),
  guardarSetlist: async (id, obj) => ({ id: (await api(id ? `/api/setlists/${id}` : '/api/setlists', { method: id ? 'PUT' : 'POST', body: JSON.stringify(obj) })).id }),
  borrarSetlist: id => api(`/api/setlists/${id}`, { method: 'DELETE' }),
  nota: async (usuario, cancion) => (await api(`/api/notas/${encodeURIComponent(usuario)}/${cancion}`)).texto || '',
  guardarNota: (usuario, cancion, texto) => api(`/api/notas/${encodeURIComponent(usuario)}/${cancion}`, { method: 'PUT', body: JSON.stringify({ texto }) }),
  integrantes: () => api('/api/integrantes'),
};
let fuente = fuenteMac;
export function usarFuente(f) { fuente = f || fuenteMac; }
export const nombreFuente = () => fuente.nombre;
export const integrantes = () => fuente.integrantes();

// ---------- memoria ----------
const mem = new Map(); // id -> cho (lo leído en esta sesión)
let indiceMem = null;  // último índice conocido (red o copia)
let sincronizando = false, ultimaSync = null;

export function estadoCopia() { return { ultimaSync, sincronizando, nCanciones: indiceMem ? indiceMem.length : 0 }; }
export async function cargarEstadoCopia() { ultimaSync = await kvGet('sync', null); return estadoCopia(); }

// ---------- índice y canciones ----------
const idLocal = () => 'local-' + Math.random().toString(36).slice(2, 10);
const esLocal = id => /^local-/.test(id);
function metaDe(cho) { const m = {}; for (const l of cho.split('\n').slice(0, 30)) { const x = l.match(/^\{\s*([a-záéíóúñ_]+)\s*:\s*(.*?)\s*\}\s*$/i); if (x) m[x[1].toLowerCase()] = x[2]; } return m; }
function entradaDe(id, cho, extra = {}) { const m = metaDe(cho); return { id, titulo: m.titulo || id, artista: m.artista || '', tono: m.tono || '', cejilla: m.cejilla || '', estado: m.estado || '', tipo: m.tipo || '', genero: m.genero || m.género || '', importada: m.importada || '', ...extra }; }
async function conPendientesEnIndice(lista) {
  // las canciones creadas sin conexión aparecen en la biblioteca marcadas como pendientes
  const pend = await kvGet('pendientes', []);
  const nuevas = pend.filter(p => p.tipo === 'cancion-nueva').map(p => entradaDe(p.id, p.cho, { pendiente: true, v: 0, creada: p.t }));
  const editadas = new Set(pend.filter(p => p.tipo === 'cancion').map(p => p.id));
  return [...lista.map(c => editadas.has(c.id) ? { ...c, pendiente: true } : c), ...nuevas];
}
// Índice: primero la red (y se guarda); sin red, la copia. `deRed` dice de dónde salió.
export async function indice() {
  try { const lista = await fuente.indiceCanciones(); await kvPut('indice', lista); indiceMem = lista; return { lista: await conPendientesEnIndice(lista), deRed: true }; }
  catch (e) { if (!esFalloDeRed(e)) throw e; const lista = (await kvGet('indice', null)) || indiceMem || []; indiceMem = lista; return { lista: await conPendientesEnIndice(lista), deRed: false }; }
}
// Canción: memoria → copia del celular → red (y se guarda en la copia)
export async function cancion(id) {
  if (mem.has(id)) return mem.get(id);
  const local = await get('canciones', id);
  if (local && typeof local.cho === 'string') { mem.set(id, local.cho); return local.cho; }
  if (esLocal(id)) { const p = (await kvGet('pendientes', [])).find(x => x.id === id); if (p) { mem.set(id, p.cho); return p.cho; } throw new Error('no existe'); }
  const cho = await fuente.cancion(id);
  const v = ((indiceMem || []).find(c => c.id === id) || {}).v || 0;
  await put('canciones', id, { cho, v }); mem.set(id, cho); return cho;
}
// La canción cambió en el servidor (aviso por WebSocket): se vuelve a bajar
export async function refrescarCancion(id) {
  mem.delete(id);
  try { const cho = await fuente.cancion(id); const v = Date.now(); await put('canciones', id, { cho, v }); mem.set(id, cho); return cho; }
  catch (e) { if (!esFalloDeRed(e)) { await del('canciones', id); } return null; }
}
export function olvidar(id) { mem.delete(id); return del('canciones', id); }

// ---------- guardar (con o sin conexión) ----------
async function agregarPendiente(p) { const pend = await kvGet('pendientes', []); const i = pend.findIndex(x => x.tipo === p.tipo && x.id === p.id && (p.tipo !== 'nota' || x.cancion === p.cancion)); if (i >= 0) pend[i] = { ...pend[i], ...p, baseV: pend[i].baseV ?? p.baseV }; else pend.push(p); await kvPut('pendientes', pend); cfg.alCambiar(); }
export const pendientes = () => kvGet('pendientes', []);
export const conflictos = () => kvGet('conflictos', []);
export async function limpiarConflictos() { await kvPut('conflictos', []); cfg.alCambiar(); }
const fechaCorta = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}-${['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][d.getMonth()]}`; };

// Guardar una canción existente. Devuelve { pendiente: true } si quedó guardada solo en este celular.
export async function guardarCancion(id, cho) {
  const previa = await get('canciones', id);
  mem.set(id, cho);
  if (esLocal(id)) { await agregarPendiente({ tipo: 'cancion-nueva', id, cho, t: Date.now(), quien: cfg.quien() }); return { pendiente: true }; }
  try { await fuente.guardarCancion(id, cho); await put('canciones', id, { cho, v: Date.now() }); return { pendiente: false }; }
  catch (e) {
    if (!esFalloDeRed(e)) throw e;
    await put('canciones', id, { cho, v: previa ? previa.v : 0, pendiente: true });
    await agregarPendiente({ tipo: 'cancion', id, cho, baseV: previa ? previa.v : 0, t: Date.now(), quien: cfg.quien() });
    return { pendiente: true };
  }
}
// Crear una canción. Sin conexión recibe un id local ("local-…") hasta que suba.
export async function crearCancion(cho) {
  try { const id = await fuente.crearCancion(cho); mem.set(id, cho); await put('canciones', id, { cho, v: Date.now() }); return { id, pendiente: false }; }
  catch (e) {
    if (!esFalloDeRed(e)) throw e;
    const id = idLocal(); mem.set(id, cho);
    await agregarPendiente({ tipo: 'cancion-nueva', id, cho, t: Date.now(), quien: cfg.quien() });
    return { id, pendiente: true };
  }
}
export async function borrarCancion(id) {
  if (esLocal(id)) { const pend = (await kvGet('pendientes', [])).filter(p => p.id !== id); await kvPut('pendientes', pend); mem.delete(id); cfg.alCambiar(); return; }
  await fuente.borrarCancion(id); await olvidar(id); // sin conexión: falla con "sin conexión" (borrar necesita servidor)
}

// ---------- setlists ----------
export async function setlists() {
  try { const lista = await fuente.indiceSetlists(); await kvPut('indiceSetlists', lista); return { lista, deRed: true }; }
  catch (e) { if (!esFalloDeRed(e)) throw e; const lista = (await kvGet('indiceSetlists', null)) || []; const pend = (await kvGet('pendientes', [])).filter(p => p.tipo === 'setlist'); for (const p of pend) if (!lista.some(s => s.id === p.id)) lista.push({ id: p.id, nombre: p.obj.nombre, fecha: p.obj.fecha, n: (p.obj.canciones || []).length, pendiente: true }); return { lista, deRed: false }; }
}
export async function setlist(id) {
  try { const s = await fuente.setlist(id); await put('setlists', id, s); return s; }
  catch (e) { if (!esFalloDeRed(e)) throw e; const p = (await kvGet('pendientes', [])).find(x => x.tipo === 'setlist' && x.id === id); if (p) return { id, ...p.obj }; const s = await get('setlists', id); if (s) return s; throw new Error('sin conexión y sin copia de este setlist'); }
}
export async function guardarSetlist(id, obj) { // id null = nuevo
  const cuerpo = { nombre: obj.nombre, fecha: obj.fecha, canciones: obj.canciones || [] };
  try { const r = await fuente.guardarSetlist(id, cuerpo); await put('setlists', r.id, { id: r.id, ...cuerpo }); return { id: r.id, pendiente: false }; }
  catch (e) {
    if (!esFalloDeRed(e)) throw e;
    const sid = id || idLocal(); await put('setlists', sid, { id: sid, ...cuerpo, pendiente: true });
    await agregarPendiente({ tipo: 'setlist', id: sid, obj: cuerpo, t: Date.now(), quien: cfg.quien() }); return { id: sid, pendiente: true };
  }
}
export async function borrarSetlist(id) {
  if (esLocal(id)) { const pend = (await kvGet('pendientes', [])).filter(p => p.id !== id); await kvPut('pendientes', pend); await del('setlists', id); cfg.alCambiar(); return; }
  await fuente.borrarSetlist(id); await del('setlists', id);
}

// ---------- notas personales ----------
const claveNota = (u, c) => `nota:${u.toLowerCase()}:${c}`;
export async function nota(usuario, cancion) {
  try { const texto = await fuente.nota(usuario, cancion); await kvPut(claveNota(usuario, cancion), texto || ''); return texto || ''; }
  catch (e) { if (!esFalloDeRed(e)) throw e; return await kvGet(claveNota(usuario, cancion), ''); }
}
export async function guardarNota(usuario, cancion, texto) {
  await kvPut(claveNota(usuario, cancion), texto);
  try { await fuente.guardarNota(usuario, cancion, texto); return { pendiente: false }; }
  catch (e) { if (!esFalloDeRed(e)) throw e; await agregarPendiente({ tipo: 'nota', id: usuario, cancion, texto, t: Date.now(), quien: usuario }); return { pendiente: true }; }
}

// ---------- sincronización ----------
// 1) sube lo pendiente (con la regla de conflictos), 2) baja canciones y setlists cuya versión cambió, 3) anota la hora.
// Devuelve un resumen; si no hay red, { sinRed: true }.
export async function sincronizar({ todo = false } = {}) {
  if (sincronizando) return { ocupado: true };
  sincronizando = true; cfg.alCambiar();
  const resumen = { bajadas: 0, subidas: 0, conflictos: 0, borradas: 0 };
  try {
    let lista; try { lista = await fuente.indiceCanciones(); } catch (e) { if (esFalloDeRed(e)) return { sinRed: true }; throw e; }
    // --- subir pendientes ---
    const pend = await kvGet('pendientes', []); const quedan = []; const conf = await kvGet('conflictos', []);
    for (const p of pend) {
      try {
        if (p.tipo === 'cancion-nueva') { const id = await fuente.crearCancion(p.cho); mem.delete(p.id); mem.set(id, p.cho); resumen.subidas++; }
        else if (p.tipo === 'cancion') {
          const enServidor = lista.find(c => c.id === p.id);
          if (enServidor && enServidor.v !== p.baseV && p.baseV) {
            // la Mac también la cambió: no se pisa nada, la versión del celular se guarda como copia para el director
            const m = metaDe(p.cho); const titulo = `${m.titulo || p.id} (edición de ${p.quien || 'alguien'}, ${fechaCorta()})`;
            const cho = /^\{\s*titulo\s*:.*\}\s*$/mi.test(p.cho) ? p.cho.replace(/^\{\s*titulo\s*:.*\}\s*$/mi, `{titulo: ${titulo}}`) : `{titulo: ${titulo}}\n` + p.cho;
            const id = await fuente.crearCancion(cho);
            conf.push({ original: p.id, copia: id, titulo, quien: p.quien, t: Date.now() }); resumen.conflictos++; mem.delete(p.id); await del('canciones', p.id);
          } else { await fuente.guardarCancion(p.id, p.cho); mem.delete(p.id); await del('canciones', p.id); resumen.subidas++; }
        }
        else if (p.tipo === 'setlist') { const nuevo = esLocal(p.id); const r = await fuente.guardarSetlist(nuevo ? null : p.id, p.obj); if (nuevo) await del('setlists', p.id); await put('setlists', r.id, { id: r.id, ...p.obj }); resumen.subidas++; }
        else if (p.tipo === 'nota') { await fuente.guardarNota(p.id, p.cancion, p.texto); resumen.subidas++; }
      } catch (e) {
        if (esFalloDeRed(e)) { quedan.push(p); continue; }
        conf.push({ original: p.id, error: e.message, quien: p.quien, t: Date.now(), tipo: p.tipo }); resumen.conflictos++; // p. ej. sin permiso: se anota y no se reintenta
      }
    }
    await kvPut('pendientes', quedan); await kvPut('conflictos', conf.slice(-50));
    if (pend.length) { try { lista = await fuente.indiceCanciones(); } catch (e) { if (esFalloDeRed(e)) return { sinRed: true, ...resumen }; throw e; } }
    // --- bajar canciones por versión ---
    await kvPut('indice', lista); indiceMem = lista;
    const enServidor = new Set(lista.map(c => c.id));
    for (const k of (await todasClaves('canciones')) || []) if (!enServidor.has(k) && !esLocal(k)) { await del('canciones', k); mem.delete(k); resumen.borradas++; }
    const pendIds = new Set(quedan.filter(p => p.tipo === 'cancion').map(p => p.id));
    const aBajar = [];
    for (const c of lista) {
      if (pendIds.has(c.id)) continue; // no pisar una edición local que aún no subió
      const local = await get('canciones', c.id);
      if (!todo && local && local.v === c.v) continue;
      aBajar.push(c);
    }
    if (fuente.cancionesLote) { // la nube: de a 60 por petición (644 canciones en ~11 peticiones, no en 644)
      for (let i = 0; i < aBajar.length; i += 60) {
        const trozo = aBajar.slice(i, i + 60);
        try { const filas = await fuente.cancionesLote(trozo.map(c => c.id)); for (const c of trozo) { const f = filas.find(x => x.id === c.id); if (!f) continue; await put('canciones', c.id, { cho: f.cho, v: c.v }); mem.set(c.id, f.cho); resumen.bajadas++; } cfg.alCambiar(); }
        catch (e) { if (esFalloDeRed(e)) return { sinRed: true, ...resumen }; }
      }
    } else {
      for (const c of aBajar) {
        try { const cho = await fuente.cancion(c.id); await put('canciones', c.id, { cho, v: c.v }); mem.set(c.id, cho); resumen.bajadas++; }
        catch (e) { if (esFalloDeRed(e)) return { sinRed: true, ...resumen }; }
      }
    }
    // --- setlists ---
    try {
      const sl = await fuente.indiceSetlists(); await kvPut('indiceSetlists', sl);
      const ids = new Set(sl.map(s => s.id)); for (const k of (await todasClaves('setlists')) || []) if (!ids.has(k) && !esLocal(k)) await del('setlists', k);
      for (const s of sl) { const local = await get('setlists', s.id); if (!todo && local && local.v === s.v) continue; const obj = await fuente.setlist(s.id); await put('setlists', s.id, { ...obj, v: s.v }); }
    } catch (e) { if (esFalloDeRed(e)) return { sinRed: true, ...resumen }; }
    ultimaSync = { t: Date.now(), n: lista.length }; await kvPut('sync', ultimaSync);
    return resumen;
  } finally { sincronizando = false; cfg.alCambiar(); }
}

// ---------- derivados de la copia local (sirven en la Mac, en la nube y sin conexión) ----------
export async function generos() { const lista = (indiceMem || (await kvGet('indice', [])) || []); return [...new Set(lista.map(c => c.genero).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
export async function secciones() {
  const d = await abrir(); if (!d) return [];
  const todas = await new Promise((ok, ko) => { const r = d.transaction('canciones').objectStore('canciones').getAll(); r.onsuccess = () => ok(r.result || []); r.onerror = () => ko(r.error); });
  const nombres = new Set();
  for (const c of todas) for (const m of String(c.cho || '').matchAll(/^\{\s*secci[oó]n\s*:\s*(.+?)\s*\}\s*$/gim)) if (m[1]) nombres.add(m[1]);
  return [...nombres].sort((a, b) => a.localeCompare(b));
}
