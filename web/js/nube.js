// Nube (Supabase) desde el celular (Paper 13, fila 214): datos por REST con la clave de banda en la cabecera x-banda,
// y el vivo por tiempo real (canal "banda": difusión del estado, presencia de conectados, marca "estamos aquí").
// El estado compartido vive en la tabla `estado` con versión: cada cambio se escribe con guardar_estado(nuevo, base);
// si otro cambió antes, se relee y se vuelve a aplicar (mismas reglas que el servidor: estado-comun.js).
import { aplicarMensaje } from './estado-comun.js';

const cfg = () => window.NUBE || null;
let diag = () => {}; export function usarDiag(fn) { diag = fn; } // registro de diagnóstico de app.js (fila 229)
export const disponible = () => !!(cfg() && window.supabase);
let clave = '', cliente = null;
export function iniciar(claveBanda) {
  clave = claveBanda || '';
  if (cliente) { try { cliente.removeAllChannels(); } catch {} }
  cliente = window.supabase.createClient(cfg().url, cfg().anon, { global: { headers: { 'x-banda': clave } }, auth: { persistSession: false, autoRefreshToken: false } });
  return cliente;
}
async function rest(ruta, opciones = {}) {
  let r;
  try { r = await fetch(`${cfg().url}/rest/v1/${ruta}`, { ...opciones, headers: { apikey: cfg().anon, Authorization: `Bearer ${cfg().anon}`, 'x-banda': clave, 'Content-Type': 'application/json', ...(opciones.headers || {}) } }); }
  catch { const e = new Error('sin conexión'); e.sinRed = true; throw e; }
  if (!r.ok) { const e = new Error(`nube ${r.status}: ${(await r.text()).slice(0, 160)}`); e.http = r.status; throw e; }
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const q = encodeURIComponent;
const META_RE = /^\{\s*([a-záéíóúñ_]+)\s*:\s*(.*?)\s*\}\s*$/i;
function metaFila(cho) { const m = {}; for (const l of cho.split('\n').slice(0, 30)) { const x = l.match(META_RE); if (x) m[x[1].toLowerCase()] = x[2]; } return { titulo: m.titulo || '', artista: m.artista || '', tono: m.tono || '', cejilla: m.cejilla || '', estado: m.estado || '', tipo: m.tipo || '', genero: m.genero || m.género || '', importada: m.importada || '' }; }
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function idLibre(tabla, base) {
  base = base || 'cancion'; let id = base, n = 2;
  const usados = new Set((await rest(`${tabla}?id=like.${q(base)}*&select=id`)).map(x => x.id));
  while (usados.has(id)) id = `${base}-${n++}`;
  return id;
}
const SIN = { Prefer: 'return=minimal' };

// Misma interfaz que la fuente de la Mac (datos.js): así la copia local no distingue de dónde vienen los datos.
export const fuenteNube = {
  nombre: 'nube',
  indiceCanciones: () => rest('canciones?select=id,titulo,artista,tono,cejilla,estado,tipo,genero,importada,v,creada&order=titulo'),
  async cancion(id) { const [f] = await rest(`canciones?id=eq.${q(id)}&select=cho`); if (!f) throw new Error('no existe'); return f.cho; },
  cancionesLote: ids => ids.length ? rest(`canciones?id=in.(${ids.map(i => `"${i}"`).join(',')})&select=id,cho`) : Promise.resolve([]),
  async guardarCancion(id, cho) { await rest(`canciones?id=eq.${q(id)}`, { method: 'PATCH', headers: SIN, body: JSON.stringify({ cho, ...metaFila(cho), v: Date.now() }) }); },
  async crearCancion(cho) { const m = metaFila(cho); const id = await idLibre('canciones', slug(m.titulo) || 'sin-titulo'); await rest('canciones', { method: 'POST', headers: SIN, body: JSON.stringify({ id, cho, ...m, v: Date.now(), creada: Date.now() }) }); return id; },
  async borrarCancion(id) { await rest(`canciones?id=eq.${q(id)}`, { method: 'DELETE', headers: SIN }); },
  indiceSetlists: async () => (await rest('setlists?select=id,nombre,fecha,canciones,v&order=fecha.desc')).map(s => ({ id: s.id, nombre: s.nombre, fecha: s.fecha, n: (s.canciones || []).length, v: s.v })),
  async setlist(id) { const [s] = await rest(`setlists?id=eq.${q(id)}&select=id,nombre,fecha,canciones`); if (!s) throw new Error('no existe'); return s; },
  async guardarSetlist(id, obj) {
    const fila = { nombre: obj.nombre || 'setlist', fecha: obj.fecha || '', canciones: obj.canciones || [], v: Date.now() };
    if (id) await rest(`setlists?id=eq.${q(id)}`, { method: 'PATCH', headers: SIN, body: JSON.stringify(fila) });
    else { id = await idLibre('setlists', `${fila.fecha || new Date().toISOString().slice(0, 10)}-${slug(fila.nombre)}`); await rest('setlists', { method: 'POST', headers: SIN, body: JSON.stringify({ id, ...fila }) }); }
    return { id };
  },
  async borrarSetlist(id) { await rest(`setlists?id=eq.${q(id)}`, { method: 'DELETE', headers: SIN }); },
  async nota(usuario, cancion) { const [n] = await rest(`notas?usuario=eq.${q(usuario)}&cancion=eq.${q(cancion)}&select=texto`); return n ? n.texto : ''; },
  async guardarNota(usuario, cancion, texto) {
    if (texto && texto.trim()) await rest('notas', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ usuario, cancion, texto, actualizada: new Date().toISOString() }) });
    else await rest(`notas?usuario=eq.${q(usuario)}&cancion=eq.${q(cancion)}`, { method: 'DELETE', headers: SIN });
  },
  integrantes: async () => (await rest('integrantes?select=nombre,instrumento,rol,ultima_conexion&order=nombre')).map(i => ({ nombre: i.nombre, instrumento: i.instrumento || '', rol: i.rol || 'musico', ultimaConexion: i.ultima_conexion })),
  rolPorPin: async pin => (await rest('rpc/rol_por_pin', { method: 'POST', body: JSON.stringify({ pin: String(pin || '') }) })) || 'musico',
  async bandaOk() { try { const r = await rest('banda?select=id'); return Array.isArray(r) && r.length > 0; } catch (e) { if (e.sinRed) throw e; return false; } },
};

// ---------- vivo por tiempo real ----------
// alEstado(snapshot) recibe el mismo formato que la "bienvenida"/"estado" del servidor de la Mac.
export function conectarVivo({ perfil, clienteId, alEstado, alConectado, alCaida }) {
  if (!cliente) throw new Error('nube sin iniciar');
  const canal = cliente.channel('banda', { config: { presence: { key: clienteId }, broadcast: { self: false, ack: false } } });
  let ultimo = { datos: null, version: -1 }, cerrado = false, listo = false;
  const conectados = () => { try { return Object.values(canal.presenceState()).flat().map(p => ({ nombre: p.nombre, rol: p.rol, instrumento: p.instrumento })); } catch { return []; } };
  const entregar = (marca = null) => { if (ultimo.datos) alEstado({ ...ultimo.datos, marca, conectados: conectados() }); };
  async function leerEstado() {
    const [f] = await rest('estado?id=eq.1&select=datos,version');
    if (f && f.version > ultimo.version) { diag('sondeo', `v${ultimo.version} → v${f.version}`); ultimo = { datos: f.datos, version: f.version }; entregar(); }
    return ultimo;
  }
  canal
    .on('broadcast', { event: 'estado' }, ({ payload }) => { if (payload && payload.version >= ultimo.version) { ultimo = { datos: payload.datos, version: payload.version }; entregar(); } })
    .on('broadcast', { event: 'marca' }, ({ payload }) => entregar(payload))
    .on('presence', { event: 'sync' }, () => entregar())
    .on('presence', { event: 'join' }, () => entregar())
    .on('presence', { event: 'leave' }, () => entregar())
    .subscribe(async status => {
      diag('canal', status);
      if (status === 'SUBSCRIBED') {
        try { await canal.track({ nombre: perfil.nombre || 'anónimo', rol: perfil.rol, instrumento: perfil.instrumento, clienteId }); await leerEstado(); if (!listo) { listo = true; alConectado(ultimo); } setTimeout(() => entregar(), 1200); }
        catch (e) { if (!cerrado) alCaida(e); }
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status) && !cerrado) alCaida(new Error(status));
    });
  const sondeo = setInterval(() => { if (!cerrado) leerEstado().catch(e => { if (!cerrado) alCaida(e); }); }, 20000); // respaldo: si un mensaje se perdió, en 20 s se nota
  // Guardar con control de versión; las posiciones del vivo (deslizar) se agrupan: solo la última en espera se escribe
  let enVuelo = null, posPendiente = null;
  async function guardar(msg, rol) {
    for (let intento = 0; intento < 4; intento++) {
      if (!ultimo.datos) await leerEstado();
      const copia = structuredClone(ultimo.datos);
      if (!aplicarMensaje(copia, msg, rol, clienteId)) return false;
      const v = await rest('rpc/guardar_estado', { method: 'POST', body: JSON.stringify({ nuevo: copia, base: ultimo.version }) });
      if (typeof v === 'number') { ultimo = { datos: copia, version: v }; entregar(); canal.send({ type: 'broadcast', event: 'estado', payload: { datos: copia, version: v } }); return true; }
      diag('conflicto', `${msg.tipo} base v${ultimo.version} intento ${intento + 1}`);
      await leerEstado(); // otro cambió antes: se vuelve a aplicar sobre lo nuevo
    }
    diag('guardar-fallo', `${msg.tipo} tras 4 intentos`);
    return false;
  }
  return {
    async enviar(msg, rol) {
      if (msg.tipo === 'marca') { await canal.send({ type: 'broadcast', event: 'marca', payload: { ...msg, por: clienteId, t: Date.now() } }); return true; }
      const esPosicion = msg.tipo === 'vivo' && msg.cancion === undefined;
      if (esPosicion) {
        // rápido para los demás: difusión inmediata con la misma versión; y se persiste agrupado
        if (ultimo.datos) { const copia = structuredClone(ultimo.datos); if (aplicarMensaje(copia, msg, rol, clienteId)) { ultimo = { datos: copia, version: ultimo.version }; canal.send({ type: 'broadcast', event: 'estado', payload: { datos: copia, version: ultimo.version } }); } }
        posPendiente = msg;
        if (!enVuelo) enVuelo = (async () => { try { while (posPendiente) { const m = posPendiente; posPendiente = null; await guardar(m, rol); } } catch {} finally { enVuelo = null; } })();
        return true;
      }
      if (enVuelo) { try { await enVuelo; } catch {} }
      return guardar(msg, rol);
    },
    version: () => ultimo.version,
    cerrar() { cerrado = true; clearInterval(sondeo); try { cliente.removeChannel(canal); } catch {} },
  };
}
