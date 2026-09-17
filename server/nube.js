// Sincronización de datos/ con la nube (Supabase), desde la Mac. La Mac es la fuente (fila 214), pero las ediciones hechas
// desde la app en modo nube también vuelven a la Mac: la sincronización es en los dos sentidos, por versión (v = milisegundos
// de la última modificación, venga de donde venga). Usa la clave service_role de datos/nube.env (nunca sale de la Mac).
// Uso: node server/nube.js [--todo]   ·   o desde el servidor: sincronizarNube({ datos })
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const META_RE = /^\{\s*([a-záéíóúñ_]+)\s*:\s*(.*?)\s*\}\s*$/i;
const HOLGURA = 1500; // ms: diferencias menores entre reloj de archivo y de la nube no cuentan como cambio

export function leerEnv(datos) {
  const ruta = path.join(datos, 'nube.env'); if (!fs.existsSync(ruta)) return null;
  const env = {}; for (const l of fs.readFileSync(ruta, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2]; }
  return env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? env : null;
}
function metaDe(cho) { const m = {}; for (const l of cho.split('\n').slice(0, 30)) { const x = l.match(META_RE); if (x) m[x[1].toLowerCase()] = x[2]; } return m; }
function filaCancion(id, cho, st) {
  const m = metaDe(cho);
  return { id, cho, v: Math.round(st.mtimeMs), creada: Math.round(st.birthtimeMs || st.mtimeMs), titulo: m.titulo || id, artista: m.artista || '', tono: m.tono || '', cejilla: m.cejilla || '', estado: m.estado || '', tipo: m.tipo || '', genero: m.genero || m.género || '', importada: m.importada || '' };
}

export async function sincronizarNube({ datos, todo = false, log = () => {} } = {}) {
  const env = leerEnv(datos); if (!env) return { sinNube: true };
  const cab = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const rest = async (ruta, opciones = {}) => {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${ruta}`, { ...opciones, headers: { ...cab, ...(opciones.headers || {}) } });
    if (!r.ok) throw new Error(`${ruta}: ${r.status} ${await r.text()}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  };
  const upsert = (tabla, filas) => filas.length ? rest(tabla, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(filas) }) : null;
  const borrar = (tabla, campo, valores) => valores.length ? rest(`${tabla}?${campo}=in.(${valores.map(v => `"${v}"`).join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }) : null;
  const marcaRuta = path.join(datos, 'nube.sync.json');
  const marca = (() => { try { return JSON.parse(fs.readFileSync(marcaRuta, 'utf8')); } catch { return { ultima: 0 }; } })();
  const ultima = todo ? 0 : (marca.ultima || 0);
  const papelera = path.join(datos, 'papelera'); fs.mkdirSync(papelera, { recursive: true });
  const sello = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const res = { subidas: 0, bajadas: 0, borradasNube: 0, borradasMac: 0, setlists: 0, notas: 0, integrantes: 0 };

  // ---------- canciones ----------
  const dirC = path.join(datos, 'canciones');
  const locales = new Map();
  for (const f of fs.readdirSync(dirC).filter(f => f.endsWith('.cho'))) { const ruta = path.join(dirC, f); locales.set(f.slice(0, -4), { ruta, st: fs.statSync(ruta) }); }
  const nube = new Map((await rest('canciones?select=id,v')).map(c => [c.id, c.v]));
  const aSubir = [];
  for (const [id, { ruta, st }] of locales) {
    const vLocal = Math.round(st.mtimeMs), vNube = nube.get(id);
    if (vNube === undefined) {
      if (vLocal > ultima - HOLGURA || todo) aSubir.push(filaCancion(id, fs.readFileSync(ruta, 'utf8'), st)); // nueva en la Mac
      else { fs.renameSync(ruta, path.join(papelera, `${id}_${sello()}_borrada-en-nube.cho`)); res.borradasMac++; log(`borrada en la nube → papelera: ${id}`); } // la borraron desde la app
    } else if (vLocal > vNube + HOLGURA) aSubir.push(filaCancion(id, fs.readFileSync(ruta, 'utf8'), st)); // la Mac la cambió después
    else if (vNube > vLocal + HOLGURA) { // la app la cambió después: baja a la Mac con la misma fecha
      const [fila] = await rest(`canciones?id=eq.${encodeURIComponent(id)}&select=cho,v`);
      if (fila) { fs.writeFileSync(ruta, fila.cho, 'utf8'); fs.utimesSync(ruta, new Date(fila.v), new Date(fila.v)); res.bajadas++; log(`bajada: ${id}`); }
    }
  }
  for (let i = 0; i < aSubir.length; i += 40) { await upsert('canciones', aSubir.slice(i, i + 40)); }
  res.subidas += aSubir.length; if (aSubir.length) log(`subidas: ${aSubir.length}`);
  const soloNube = [...nube.keys()].filter(id => !locales.has(id));
  const aBorrarNube = [], aBajar = [];
  for (const id of soloNube) { if (nube.get(id) > ultima - HOLGURA) aBajar.push(id); else aBorrarNube.push(id); } // nueva desde la app → baja; si no, la borró la Mac → se borra en la nube
  for (const id of aBajar) {
    if (!/^[a-z0-9][a-z0-9_-]{0,120}$/.test(id)) continue;
    const [fila] = await rest(`canciones?id=eq.${encodeURIComponent(id)}&select=cho,v`);
    if (fila) { const ruta = path.join(dirC, id + '.cho'); fs.writeFileSync(ruta, fila.cho, 'utf8'); fs.utimesSync(ruta, new Date(fila.v), new Date(fila.v)); res.bajadas++; log(`nueva desde la app: ${id}`); }
  }
  await borrar('canciones', 'id', aBorrarNube); res.borradasNube += aBorrarNube.length; if (aBorrarNube.length) log(`borradas en la nube: ${aBorrarNube.join(', ')}`);

  // ---------- setlists (misma regla) ----------
  const dirS = path.join(datos, 'setlists');
  const localesS = new Map(); for (const f of fs.readdirSync(dirS).filter(f => f.endsWith('.json'))) { const ruta = path.join(dirS, f); localesS.set(f.slice(0, -5), { ruta, st: fs.statSync(ruta) }); }
  const nubeS = new Map((await rest('setlists?select=id,v')).map(s => [s.id, s.v]));
  const subirS = [];
  const filaSetlist = (id, ruta, st) => { const s = JSON.parse(fs.readFileSync(ruta, 'utf8')); return { id, nombre: s.nombre || id, fecha: s.fecha || '', canciones: s.canciones || [], v: Math.round(st.mtimeMs) }; };
  const escribirSetlist = (id, s) => { const ruta = path.join(dirS, id + '.json'); fs.writeFileSync(ruta, JSON.stringify({ nombre: s.nombre, fecha: s.fecha, canciones: s.canciones }, null, 2), 'utf8'); fs.utimesSync(ruta, new Date(s.v), new Date(s.v)); };
  for (const [id, { ruta, st }] of localesS) {
    const vL = Math.round(st.mtimeMs), vN = nubeS.get(id);
    if (vN === undefined) { if (vL > ultima - HOLGURA || todo) subirS.push(filaSetlist(id, ruta, st)); else { fs.renameSync(ruta, path.join(papelera, `setlist_${id}_${sello()}_borrado-en-nube.json`)); res.borradasMac++; } }
    else if (vL > vN + HOLGURA) subirS.push(filaSetlist(id, ruta, st));
    else if (vN > vL + HOLGURA) { const [s] = await rest(`setlists?id=eq.${encodeURIComponent(id)}&select=*`); if (s) { escribirSetlist(id, s); res.setlists++; } }
  }
  await upsert('setlists', subirS); res.setlists += subirS.length;
  const soloNubeS = [...nubeS.keys()].filter(id => !localesS.has(id)); const borrarS = [];
  for (const id of soloNubeS) { if (nubeS.get(id) > ultima - HOLGURA) { const [s] = await rest(`setlists?id=eq.${encodeURIComponent(id)}&select=*`); if (s && /^[a-z0-9][a-z0-9_-]{0,120}$/.test(id)) { escribirSetlist(id, s); res.setlists++; } } else borrarS.push(id); }
  await borrar('setlists', 'id', borrarS);

  // ---------- notas personales: la nube manda (vienen de los celulares); lo que solo tenga la Mac sube ----------
  const dirN = path.join(datos, 'notas'); fs.mkdirSync(dirN, { recursive: true });
  const enNube = await rest('notas?select=usuario,cancion,texto');
  const porUsuario = new Map(); for (const n of enNube) { if (!porUsuario.has(n.usuario)) porUsuario.set(n.usuario, {}); porUsuario.get(n.usuario)[n.cancion] = n.texto; }
  const subirN = [];
  for (const f of fs.readdirSync(dirN).filter(f => f.endsWith('.json'))) {
    const usuario = f.slice(0, -5); let local = {}; try { local = JSON.parse(fs.readFileSync(path.join(dirN, f), 'utf8')); } catch {}
    const nubeU = porUsuario.get(usuario) || {};
    for (const [cancion, texto] of Object.entries(local)) if (!(cancion in nubeU)) subirN.push({ usuario, cancion, texto });
  }
  await upsert('notas', subirN); res.notas += subirN.length;
  for (const [usuario, notas] of porUsuario) { if (!/^[\p{L}\p{N} _.-]{1,40}$/u.test(usuario)) continue; const ruta = path.join(dirN, usuario.toLowerCase() + '.json'); let local = {}; try { local = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch {} const unido = { ...local, ...notas }; if (JSON.stringify(unido) !== JSON.stringify(local)) { fs.writeFileSync(ruta, JSON.stringify(unido, null, 2), 'utf8'); res.notas++; } }

  // ---------- integrantes y PIN: de la Mac a la nube ----------
  try { const lista = JSON.parse(fs.readFileSync(path.join(datos, 'integrantes.json'), 'utf8')); if (Array.isArray(lista)) { await upsert('integrantes', lista.filter(i => i.nombre).map(i => ({ nombre: String(i.nombre), instrumento: i.instrumento || '', rol: i.rol || 'musico', ultima_conexion: i.ultimaConexion || null }))); res.integrantes = lista.length; } } catch {}
  try { const u = JSON.parse(fs.readFileSync(path.join(datos, 'usuarios.json'), 'utf8')); const filas = ['director', 'cantante'].filter(r => u[r] && u[r].pin).map(r => ({ rol: r, pin: String(u[r].pin) })); await upsert('usuarios', filas); } catch {}

  fs.writeFileSync(marcaRuta, JSON.stringify({ ultima: Date.now(), resumen: res }, null, 2));
  return res;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const datos = process.env.DATOS ? path.resolve(process.env.DATOS) : path.join(raiz, '..', 'datos');
  sincronizarNube({ datos, todo: process.argv.includes('--todo'), log: console.log }).then(r => { console.log('nube:', JSON.stringify(r)); }).catch(e => { console.error('error:', e.message); process.exit(1); });
}
