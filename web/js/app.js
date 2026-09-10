// Visualizador Lyrics — lógica de la app (sin framework).
import { parsear, renderCancion, tonoTranspuesto, expandir, nombresArreglo, tituloSeccion, textoAChordPro, eliminarSeccion, palabrasCrudas, eliminarTramo } from './chordpro.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const cargar = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return d; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const perfil = cargar('perfil', { nombre: '', instrumento: 'voz', rol: 'musico', pin: '', vista: 'acordes', cejilla: false, botones: true, paso: 'pagina', lineas: 4, ajustar: true }); // paso: página | sección | líneas (botones y pedal)
const prefs = cargar('prefs', { tam: 1.25, transp: {}, cejilla: {} });
// Abierto desde el panel de la Mac (?director=1): esta Mac es del director y el servidor no le pide PIN por localhost.
if (new URLSearchParams(location.search).get('director') === '1') {
  perfil.rol = 'director'; if (!perfil.nombre) perfil.nombre = 'Director (Mac)'; guardar('perfil', perfil);
  history.replaceState(null, '', location.pathname);
}
let indice = [];                 // [{id,titulo,artista,tono,...}]
let estado = { vivo: { cancion: null, seccion: 0, frac: 0 }, siguiente: [], historial: [], controlCantante: false, tonos: {}, conectados: [] };
let rol = 'musico';              // rol confirmado por el servidor
let ws = null, conectado = false, reintento = 1000;
const clienteId = (() => { try { let c = localStorage.getItem('clienteId'); if (!c) { c = Math.random().toString(36).slice(2, 12); localStorage.setItem('clienteId', c); } return c; } catch { return Math.random().toString(36).slice(2, 12); } })();
let ultimoGesto = 0; // último toque/rueda/tecla del usuario: solo entonces un scroll cuenta como suyo
let modo = 'siguiendo';          // 'siguiendo' | 'libre' | 'lider'
const mostrando = { id: null, cancion: null, seccion: 0, frac: 0, pintadoId: null };
let scrollProgramatico = false, tScrollProg = null;
const cacheCho = new Map();
let setlistAbierto = null;
let ultimaFirmaBib = '', ultimaFirmaCola = '', ultimaMarcaT = 0;

// ---------- utilidades ----------
const puedeMover = () => rol === 'director' || (rol === 'cantante' && estado.controlCantante);
const puedeCola = () => rol === 'director' || rol === 'cantante';
const titulo = id => (indice.find(c => c.id === id) || {}).titulo || id || '';
const artista = id => (indice.find(c => c.id === id) || {}).artista || '';
const cabPin = () => perfil.pin ? { 'x-pin': perfil.pin } : {};
async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, { ...opciones, headers: { 'Content-Type': 'application/json', ...cabPin(), ...(opciones.headers || {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
function enviar(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function aviso(t) { const c = $('#conexion-texto'); const antes = c.textContent; c.textContent = t; setTimeout(() => { if (c.textContent === t) actualizarConexion(); }, 2500); }

// ---------- pestañas ----------
function irA(vista) {
  $$('#tabs button').forEach(b => b.classList.toggle('activa', b.dataset.vista === vista));
  $$('.vista').forEach(v => v.classList.toggle('activa', v.id === 'vista-' + vista));
  if (vista === 'setlists') cargarSetlists();
  if (vista === 'ajustes') cargarInfo();
}
$$('#tabs button').forEach(b => b.onclick = () => irA(b.dataset.vista));

// ---------- conexión ----------
function actualizarConexion() {
  const c = $('#conexion');
  c.classList.toggle('ok', conectado); c.classList.toggle('libre', !conectado);
  $('#conexion-texto').textContent = conectado ? (rol === 'musico' ? 'conectado' : rol) : 'sin conexión';
}
function conectar() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); } catch { return programarReintento(); }
  ws.onopen = () => { reintento = 1000; enviar({ tipo: 'hola', nombre: perfil.nombre || 'anónimo', instrumento: perfil.instrumento, rol: perfil.rol, pin: perfil.pin, clienteId }); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.tipo === 'bienvenida') { conectado = true; rol = m.rol; actualizarConexion(); aplicarEstado(m.estado); }
    else if (m.tipo === 'estado') aplicarEstado(m.estado);
    else if (m.tipo === 'rechazado') aviso('sin permiso');
    else if (m.tipo === 'cancion-cambiada') cancionCambiada(m.id);
  };
  ws.onclose = () => { conectado = false; actualizarConexion(); actualizarControles(); programarReintento(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function programarReintento() { setTimeout(conectar, reintento); reintento = Math.min(reintento * 1.6, 8000); }

// ---------- estado compartido ----------
function aplicarEstado(e) {
  const tonoAntes = mostrando.id ? transpBanda(mostrando.id) : null;
  const cargaAntes = estado.vivo.carga;
  estado = e;
  if (!Array.isArray(e.historial)) e.historial = [];
  $('#n-siguiente').textContent = e.siguiente.length || '';
  if (mostrando.id && transpBanda(mostrando.id) !== tonoAntes) mostrando.pintadoId = null; // cambió el tono de la banda: repintar
  if (e.marca && e.marca.por !== clienteId && e.marca.t !== ultimaMarcaT && mostrando.id === e.vivo.cancion) { ultimaMarcaT = e.marca.t; setTimeout(() => mostrarMarca(e.marca), 50); }
  if (modo !== 'libre') {
    modo = puedeMover() ? 'lider' : 'siguiendo';
    if (e.vivo.cancion) {
      // quien movió el vivo ignora su propio eco (ya está ahí); todos los demás se desplazan
      // una carga nueva en el vivo (el contador `carga` del servidor sube) siempre lleva al inicio, aunque sea la misma canción repetida (antes se quedaba al final)
      const cargaNueva = e.vivo.carga !== cargaAntes;
      const esMiEco = !cargaNueva && e.vivo.por === clienteId && mostrando.id === e.vivo.cancion;
      mostrar(e.vivo.cancion, e.vivo.seccion, { frac: e.vivo.frac || 0, desplazar: !esMiEco, nueva: cargaNueva });
    } else vaciarVivo();
  } else if (mostrando.id && mostrando.pintadoId === null) pintar(); // en libre, refleja el cambio de tono
  // repintar listas solo si cambió algo que las afecte (evita romper un toque en curso)
  const firmaBib = [rol, puedeMover(), puedeCola(), e.vivo.cancion].join('|');
  if (firmaBib !== ultimaFirmaBib) { ultimaFirmaBib = firmaBib; renderBiblioteca(); }
  const firmaCola = [rol, puedeMover(), puedeCola(), e.siguiente.join(','), e.historial.join(',')].join('|');
  if (firmaCola !== ultimaFirmaCola) { ultimaFirmaCola = firmaCola; renderSiguiente(); if (mostrando.id && mostrando.pintadoId === mostrando.id) pintarSigue(); } // la ficha "Sigue / Fin de la cola" del vivo se actualiza con la cola, no solo al cambiar de canción
  renderConectados(); actualizarControles();
  const chk = $('#chk-cantante'); if (chk) chk.checked = !!e.controlCantante;
  const bc = $('#btn-cantante'); if (bc) { bc.classList.toggle('activo', !!e.controlCantante); bc.textContent = e.controlCantante ? '🎤 sí' : '🎤 no'; } // acceso rápido en la barra fija (director)
}
function actualizarControles() {
  const lider = puedeMover() && conectado && modo !== 'libre';
  const mostrarBarra = lider && (rol === 'director' || perfil.botones !== false); // el director siempre; el cantante puede ocultarla
  $('#controles-lider').hidden = !mostrarBarra;
  document.body.classList.toggle('con-barra', puedeMover() && conectado && (rol === 'director' || perfil.botones !== false)); // la barra del líder existe aunque esté en libre: el botón flotante se acomoda encima
  $('#btn-volver').hidden = modo !== 'libre';
  const p = $('#vivo-modo');
  p.className = 'pill ' + (modo === 'libre' ? 'modo-libre' : lider ? 'modo-lider' : 'modo-siguiendo');
  p.textContent = modo === 'libre' ? 'navegación libre' : lider ? 'tú controlas el vivo' : conectado ? 'siguiendo al vivo' : 'sin conexión · lo guardado sigue disponible';
  $('#panel-director').hidden = rol !== 'director';
  $('#siguiente-acciones').hidden = !(rol === 'director' && estado.siguiente.length);
  $('#ctl-cejilla').style.display = (perfil.cejilla || perfil.instrumento === 'guitarra') ? '' : 'none';
  $('#ctl-tono').classList.toggle('solo-lectura', rol !== 'director');
  $('#btn-tono-orig').hidden = rol !== 'director' || !mostrando.id;
  $('#btn-cantante').hidden = rol !== 'director';
}
function vaciarVivo() {
  mostrando.id = null; mostrando.cancion = null;
  $('#vivo-titulo').textContent = 'Nada en vivo todavía'; $('#vivo-sub').textContent = puedeMover() ? 'Elige una canción en “Canciones” o pasa la primera de la cola.' : 'Esperando al director…';
  $('#cancion').innerHTML = '';
}

// ---------- mostrar canción ----------
async function obtenerCho(id) {
  if (cacheCho.has(id)) return cacheCho.get(id);
  const { cho } = await api(`/api/canciones/${id}`);
  cacheCho.set(id, cho); return cho;
}
const topBarra = () => $('#barra').offsetHeight + 8;
function posicionDeScroll(y) {
  // dada una posición de scroll, ¿en qué sección y a qué fracción de ella estamos?
  const secs = $$('#cancion [data-sec]'); if (!secs.length) return { seccion: 0, frac: 0 };
  const ref = y + topBarra();
  let i = 0;
  // tolerancia de 3 px: en iPhone el borde de una sección puede quedar en una fracción de píxel por encima de la referencia
  // y "siguiente" volvía a apuntar a la misma sección (se trababa en Estrofa 1, 08-sep)
  for (let k = 0; k < secs.length; k++) { const top = secs[k].getBoundingClientRect().top + window.scrollY; if (top <= ref + 3) i = k; }
  const el = secs[i], top = el.getBoundingClientRect().top + window.scrollY, h = Math.max(el.offsetHeight, 1);
  return { seccion: i, frac: Math.max(0, Math.min(1, (ref - top) / h)) };
}
function scrollDePosicion(seccion, frac) {
  if (seccion === 0 && !frac) return 0; // inicio de la canción: arriba del todo (título y rótulo de la primera sección a la vista)
  const el = $(`#cancion [data-sec="${seccion}"]`); if (!el) return 0;
  const top = el.getBoundingClientRect().top + window.scrollY;
  return Math.max(0, top + frac * el.offsetHeight - topBarra());
}
let mostrarTurno = 0; // si llegan varias órdenes de mostrar mientras una canción se descarga, solo la última se aplica
async function mostrar(id, seccion = 0, { desplazar = true, frac = 0, nueva = false } = {}) {
  if (!id) return vaciarVivo();
  const turno = ++mostrarTurno;
  const cambioCancion = nueva || mostrando.id !== id; // `nueva`: carga nueva en el vivo aunque sea la misma canción
  try {
    if (mostrando.id !== id || !mostrando.expandidas) {
      const cho = await obtenerCho(id);
      if (turno !== mostrarTurno) return; // llegó una orden más nueva: esta se descarta
      if (mostrando.id !== id) cerrarNota();
      mostrando.id = id; mostrando.cancion = parsear(cho);
      mostrando.expandidas = await expandirConPartes(mostrando.cancion);
      if (turno !== mostrarTurno) return;
    }
    mostrando.seccion = Math.max(0, Math.min(seccion, mostrando.expandidas.length - 1));
    mostrando.frac = frac;
    if (mostrando.pintadoId !== id) pintar(); else marcarSeccion(mostrando.seccion);
    ajustarLetra();
    if (desplazar) {
      void $('#cancion').offsetHeight; /* fuerza layout */
      // canción nueva: página nueva. Salto instantáneo (sin animación desde el final de la anterior) y el toque que la trajo ya no cuenta como gesto de scroll
      if (cambioCancion) { ultimoGesto = 0; scrollA(scrollDePosicion(mostrando.seccion, mostrando.frac), { instantaneo: true }); }
      else scrollA(scrollDePosicion(mostrando.seccion, mostrando.frac));
    }
  } catch (e) { $('#cancion').innerHTML = `<p class="vacio">No se pudo abrir la canción (${e.message}). Sin red solo están las canciones ya guardadas en este teléfono.</p>`; }
}
let scrollObjetivo = 0; // destino del último desplazamiento automático (si aún no terminó, los cálculos parten de ahí)
function scrollA(top, { instantaneo = false } = {}) {
  scrollObjetivo = top;
  scrollProgramatico = true; clearTimeout(tScrollProg);
  const lejos = !instantaneo && Math.abs(top - window.scrollY) > window.innerHeight * 0.9;
  window.scrollTo({ top, behavior: lejos ? 'smooth' : 'auto' });
  tScrollProg = setTimeout(() => { scrollProgramatico = false; }, lejos ? 1200 : 250);
}
window.addEventListener('scrollend', () => { scrollProgramatico = false; }, { passive: true });
for (const ev of ['pointerdown', 'touchmove', 'wheel', 'keydown']) window.addEventListener(ev, () => { ultimoGesto = Date.now(); }, { passive: true });
const scrollDelUsuario = () => !scrollProgramatico && (Date.now() - ultimoGesto) < 1500;
// Trae las canciones referenciadas por {parte:} y devuelve las secciones expandidas (arreglo aplicado)
async function expandirConPartes(cancion) {
  const ids = [...new Set(cancion.secciones.filter(s => s.parte).map(s => s.parte.id))];
  const parseadas = new Map();
  for (const pid of ids) { try { parseadas.set(pid, parsear(await obtenerCho(pid))); } catch { parseadas.set(pid, null); } }
  return expandir(cancion, (pid, nombre) => {
    const c = parseadas.get(pid); if (!c) return null;
    const sec = c.secciones.find(x => (x.nombre || '').trim().toLowerCase() === (nombre || '').trim().toLowerCase());
    if (!sec) return null;
    return { nombre: sec.nombre, lineas: sec.lineas, titulo: c.meta.titulo || titulo(pid), tono: c.meta.tono || '' };
  });
}
function marcarSeccion(i) { $$('#cancion [data-sec]').forEach(el => el.classList.toggle('actual', Number(el.dataset.sec) === i)); }
// Ajuste automático de letra (Cristhian, 08-sep): solo cuando quien controla el vivo avanza POR SECCIÓN (el dato viaja con cada
// movimiento del vivo). Cada dispositivo con la casilla encendida reduce su letra para que quepan la sección actual, el rótulo de la
// siguiente y sus dos primeras líneas. Piso 80 %; nunca agranda. En libre, o si se avanza por página/líneas/deslizando, no ajusta.
const AJUSTE_MIN = 0.8; // piso: Cristhian probó 65 % y lo vio muy pequeño (08-sep)
let ajusteActual = 1;
function ajustarLetra() {
  const root = document.documentElement;
  const poner = k => { if (k !== ajusteActual) { ajusteActual = k; root.style.setProperty('--ajuste', k); void $('#cancion').offsetHeight; } };
  // quien controla: según cómo se movió de verdad (botón/pedal por sección o desde Estructura), nunca por la configuración ni deslizando; quien sigue: según cómo se movió quien controla
  const porSeccion = modo === 'lider' ? pasoPropio === 'seccion' : (modo === 'siguiendo' && estado.vivo && estado.vivo.paso === 'seccion');
  const activo = perfil.ajustar !== false && perfil.vista !== 'estructura' && mostrando.expandidas && porSeccion;
  if (!activo) return poner(1);
  const sec = $(`#cancion [data-sec="${mostrando.seccion}"]`); if (!sec) return poner(1);
  const ctl = $('#controles-lider'); const piso = ctl && !ctl.hidden ? Math.min(window.innerHeight, ctl.getBoundingClientRect().top) : window.innerHeight;
  const disponible = piso - topBarra() - 6;
  const necesario = () => {
    const top = sec.getBoundingClientRect().top; let fin = sec.getBoundingClientRect().bottom;
    const sig = sec.nextElementSibling && sec.nextElementSibling.matches('[data-sec]') ? sec.nextElementSibling : null;
    if (sig) { const ls = [...sig.querySelectorAll('.linea')].filter(l => l.textContent.replace(/\u00a0/g, '').trim()); const l2 = ls[Math.min(1, ls.length - 1)]; fin = l2 ? l2.getBoundingClientRect().bottom : sig.getBoundingClientRect().bottom; }
    return fin - top;
  };
  poner(1); let k = 1, n = necesario();
  for (let i = 0; i < 3 && n > disponible && k > AJUSTE_MIN; i++) { k = Math.max(AJUSTE_MIN, +(k * disponible / n * 0.98).toFixed(3)); poner(k); n = necesario(); }
}
const transpBanda = id => (estado.tonos && estado.tonos[id]) || 0;   // tono de la banda: lo fija el director, lo ven todos
const cejillaPersonal = id => (perfil.cejilla || perfil.instrumento === 'guitarra') ? (prefs.cejilla[id] ?? 0) : 0;
function pintar() {
  const c = mostrando.cancion; if (!c) return;
  const m = c.meta, id = mostrando.id;
  const transp = transpBanda(id), cejilla = cejillaPersonal(id);
  $('#vivo-titulo').textContent = m.titulo || titulo(id);
  const tonoBanda = m.tono ? tonoTranspuesto(m.tono, transp) : '';
  const partes = [m.artista, tonoBanda ? 'Tono ' + tonoBanda + (transp ? ` (orig. ${m.tono})` : '') : 'tono sin fijar', m.estado === 'importada' ? '⚠ sin corregir' : ''].filter(Boolean);
  $('#vivo-sub').textContent = partes.join(' · ');
  $('#tr-valor').textContent = transp > 0 ? '+' + transp : transp; $('#cj-valor').textContent = cejilla;
  $('#vivo-tono-info').textContent = cejilla ? `→ acordes en ${m.tono ? tonoTranspuesto(m.tono, transp - cejilla) : (transp - cejilla) + ' st'}` : '';
  $('#btn-tono-orig').hidden = rol !== 'director';
  $('#btn-cantante').hidden = rol !== 'director';
  mostrando.pintadoId = id;
  const art = $('#cancion');
  art.className = 'vista-' + perfil.vista;
  art.innerHTML = renderCancion(c, { transp, cejilla, vista: perfil.vista, seccionActual: mostrando.seccion, secciones: mostrando.expandidas });
  pintarSigue();
  document.documentElement.style.setProperty('--tam', prefs.tam + 'rem');
}
// Cuál sigue: cabecera + ficha al final de la letra. Se repinta sola cuando cambia la cola (sin repintar la canción ni mover el scroll).
function pintarSigue() {
  const art = $('#cancion'); if (!mostrando.cancion) return;
  const sig = estado.siguiente[0];
  $('#vivo-sigue').textContent = sig ? `Sigue: ${titulo(sig)}` : '';
  const html = sig
    ? `<div class="sigue-card">Sigue<b>${esc(titulo(sig))}${artista(sig) ? ' · ' + esc(artista(sig)) : ''}</b>${puedeMover() ? '<button class="btn-pasar">▶▶ Pasar a esta canción</button>' : ''}</div>`
    : `<div class="sigue-card">Fin de la cola${puedeMover() ? '<b>Agrega canciones en “Canciones” o carga un setlist</b>' : ''}</div>`;
  const vieja = art.querySelector('.sigue-card');
  if (vieja) vieja.outerHTML = html; else art.insertAdjacentHTML('beforeend', html);
}
// Navegación por páginas (estilo lector): avanza ~80 % de la pantalla. La sincronía viaja como sección + fracción.
let pasoPropio = 'deslizar'; // cómo se movió por última vez este dispositivo (seccion / pagina / lineas / deslizar): el ajuste de letra del que controla solo se activa tras un paso por sección con botón o pedal (fila 107; corregido 09-sep, fila 114)
function moverAScroll(y, paso = perfil.paso || 'pagina') {
  pasoPropio = paso;
  const pos = posicionDeScroll(y);
  if (modo !== 'lider') { modo = 'libre'; actualizarControles(); }
  else enviar({ tipo: 'vivo', seccion: pos.seccion, frac: pos.frac, paso });
  mostrando.seccion = pos.seccion; mostrando.frac = pos.frac; marcarSeccion(pos.seccion);
  scrollA(y);
}
function moverPagina(delta) {
  if (!mostrando.cancion) return;
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  moverAScroll(Math.max(0, Math.min(max, window.scrollY + delta * window.innerHeight * 0.8)), 'pagina');
}
// Por líneas: la primera línea visible bajo la barra avanza (o retrocede) n líneas
function moverLineas(n) {
  // cuenta cada línea de letra (con sus acordes) o de solo acordes como una línea; las vacías y los títulos de sección no cuentan
  const lineas = $$('#cancion .linea').filter(l => l.textContent.replace(/\u00a0/g, '').trim()); if (!lineas.length) return moverPagina(Math.sign(n));
  const yBase = scrollProgramatico ? scrollObjetivo : window.scrollY; // si un salto sigue en curso, partir de su destino
  const ref = yBase + topBarra();
  let idx = lineas.findIndex(l => l.getBoundingClientRect().top + window.scrollY >= ref - 2); if (idx < 0) idx = lineas.length - 1;
  // ancla de una línea: si es la primera de su sección, la sección entera (para que suba con su rótulo INTRO, ESTROFA 1…)
  const limpio = s => s.replace(/\u00a0/g, '').trim();
  const anclaDe = i => { const sec = lineas[i].closest('[data-sec]'); const primera = sec && [...sec.querySelectorAll('.linea')].find(l => limpio(l.textContent)) === lineas[i]; return primera ? sec : lineas[i]; };
  const topDe = el => el.getBoundingClientRect().top + window.scrollY;
  // si lo que va arriba todavía no está pegado a la barra (hay título encima), el primer toque solo lo acerca a la barra
  const holgura = topDe(anclaDe(idx)) - ref;
  const dest = Math.max(0, Math.min(lineas.length - 1, n > 0 && holgura > 8 ? idx : idx + n));
  let y = Math.max(0, topDe(anclaDe(dest)) - topBarra());
  if (n < 0 && dest === 0) y = 0; // subiendo hasta la primera línea: arriba del todo (título y rótulo a la vista)
  if (Math.abs(y - yBase) < 2) return; // sin movimiento posible (principio o final)
  moverAScroll(y, 'lineas');
}
// Por secciones. Si la sección no cabe en pantalla, "siguiente" baja de modo que la última línea completa que se veía
// pase a ser la primera bajo la barra (con sus acordes); cuando el final ya se ve, salta al inicio de la siguiente sección.
// "Atrás" hace lo simétrico; en el inicio de la sección va a la anterior. (Cristhian, 08-sep)
function moverPorSeccion(delta) {
  const n = mostrando.expandidas ? mostrando.expandidas.length : 0; if (!n) return;
  const lim = i => Math.max(0, Math.min(n - 1, i));
  if (perfil.vista === 'estructura') return irASeccion(lim(mostrando.seccion + delta));
  const docTop = el => el.getBoundingClientRect().top + window.scrollY, docBot = el => el.getBoundingClientRect().bottom + window.scrollY;
  const yBase = scrollProgramatico ? scrollObjetivo : window.scrollY; // si un salto suave sigue en curso, partir de su destino
  const barra = topBarra();
  // piso visible: si la barra de botones del líder está a la vista, tapa el final de la pantalla (Cristhian, 08-sep: se solapaba una línea)
  const ctl = $('#controles-lider'); const alto = ctl && !ctl.hidden ? Math.min(window.innerHeight, ctl.getBoundingClientRect().top) : window.innerHeight;
  const vistaIni = yBase + barra, vistaFin = yBase + alto;
  const base = posicionDeScroll(yBase).seccion;
  const sec = $(`#cancion [data-sec="${base}"]`); if (!sec) return irASeccion(lim(base + delta));
  const secTop = docTop(sec), secBot = docBot(sec);
  const lineas = [...sec.querySelectorAll('.linea')].filter(l => l.textContent.trim());
  const pagina = (alto - barra) * 0.8;
  if (delta > 0) {
    if (secBot <= vistaFin + 2) { if (base < n - 1) irASeccion(base + 1); return; } // el final ya se ve: siguiente sección (en la última, nada)
    const completas = lineas.filter(l => docTop(l) >= vistaIni - 2 && docBot(l) <= vistaFin + 2);
    const ultima = completas[completas.length - 1];
    let y = ultima ? docTop(ultima) - barra : yBase + pagina;
    if (y <= yBase + 2) y = yBase + pagina; // una sola línea más alta que la pantalla: avanzar una página
    moverAScroll(Math.max(0, y), 'seccion');
  } else {
    if (secTop >= vistaIni - 3) { if (base > 0) irASeccion(base - 1); return; } // en el inicio de la sección: sección anterior (en la primera, nada)
    const primera = lineas.find(l => docTop(l) >= vistaIni - 2 && docBot(l) <= vistaFin + 2);
    let y = primera ? docBot(primera) - alto : yBase - pagina;
    y = Math.max(y, secTop - barra); // no subir por encima del inicio de la sección
    if (y >= yBase - 2) y = Math.max(secTop - barra, yBase - pagina);
    moverAScroll(Math.max(0, y), 'seccion');
  }
}
// Botones atrás / siguiente y pedal: según la vista y el ajuste "avanzan por" de "Yo"
function moverSeccion(delta) {
  if (!mostrando.cancion) return;
  // cada dispositivo avanza como lo tiene configurado en "Yo" (Cristhian, 08-sep): nada se comparte entre dispositivos
  const paso = perfil.vista === 'estructura' ? 'seccion' : (perfil.paso || 'pagina');
  if (paso === 'seccion') return moverPorSeccion(delta);
  if (paso === 'lineas') return moverLineas(delta * Math.max(1, Math.min(10, Number(perfil.lineas) || 4)));
  moverPagina(delta);
}
// Deslizamiento con el dedo: el líder transmite su posición en vivo (~12 veces por segundo); un seguidor que desliza pasa a libre.
let tUltimoEnvio = 0, tEnvioPendiente = null;
window.addEventListener('scroll', () => {
  if (!mostrando.cancion || !$('#vista-vivo').classList.contains('activa')) return;
  if (!scrollDelUsuario()) return; // desplazamiento automático (seguir al vivo, cambio de canción): no es un gesto
  if (modo === 'lider') {
    const enviarPos = () => { pasoPropio = 'deslizar'; const pos = posicionDeScroll(window.scrollY); mostrando.seccion = pos.seccion; mostrando.frac = pos.frac; marcarSeccion(pos.seccion); enviar({ tipo: 'vivo', seccion: pos.seccion, frac: pos.frac }); tUltimoEnvio = Date.now(); };
    const espera = 80 - (Date.now() - tUltimoEnvio);
    clearTimeout(tEnvioPendiente);
    if (espera <= 0) enviarPos(); else tEnvioPendiente = setTimeout(enviarPos, espera);
  } else if (modo === 'siguiendo') { modo = 'libre'; actualizarControles(); }
}, { passive: true });
function irASeccion(i) {
  pasoPropio = 'seccion';
  if (modo === 'lider') enviar({ tipo: 'vivo', seccion: i, frac: 0, paso: 'seccion' }); else { modo = 'libre'; actualizarControles(); }
  mostrar(mostrando.id, i, { frac: 0 });
}
function verLibre(id) { modo = 'libre'; actualizarControles(); irA('vivo'); mostrar(id, 0); }
$('#btn-volver').onclick = () => { modo = puedeMover() ? 'lider' : 'siguiendo'; actualizarControles(); irA('vivo'); if (estado.vivo.cancion) mostrar(estado.vivo.cancion, estado.vivo.seccion, { frac: estado.vivo.frac || 0 }); else vaciarVivo(); };
$('#lider-prev').onclick = () => moverSeccion(-1);
$('#lider-next').onclick = () => moverSeccion(1);
$('#lider-pasar').onclick = () => { if (!estado.siguiente.length) return aviso('cola vacía'); enviar({ tipo: 'siguiente', accion: 'pasar' }); };
$('#lider-anterior').onclick = () => { if (!(estado.historial || []).length) return aviso('no hay canción anterior'); enviar({ tipo: 'siguiente', accion: 'anterior' }); };

// teclado (pedal = teclado Bluetooth) y zonas de toque estilo lector
document.addEventListener('keydown', ev => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (!$('#vista-vivo').classList.contains('activa')) return;
  if (['ArrowDown', 'ArrowRight', 'PageDown', ' ', 'Enter'].includes(ev.key)) { ev.preventDefault(); moverSeccion(1); }
  else if (['ArrowUp', 'ArrowLeft', 'PageUp', 'Backspace'].includes(ev.key)) { ev.preventDefault(); moverSeccion(-1); }
});
let toque = null, tPresion = null;
function marcarAqui(el) {
  if (!el || !mostrando.cancion) return; // cualquier integrante puede marcar "estamos aquí"
  const pal = el.closest('.pal'); const linea = el.closest('.linea'); const sec = el.closest('[data-sec]');
  if (!sec) return;
  const todo = perfil.vista === 'estructura' || !linea; // desde la vista Estructura (o sin línea bajo el dedo): la sección completa
  const marca = todo ? { seccion: Number(sec.dataset.sec), linea: -1, palabra: -1, todo: true } : { seccion: Number(sec.dataset.sec), linea: Number(linea.dataset.l), palabra: pal ? Number(pal.dataset.p) : -1 };
  enviar({ tipo: 'marca', ...marca, quien: perfil.nombre }); mostrarMarca(marca); // también en el propio dispositivo
  if (navigator.vibrate) navigator.vibrate(30);
}
let tMarca = null;
function mostrarMarca(m) {
  $$('#cancion .marcada, #cancion .marcada-sec').forEach(x => x.classList.remove('marcada', 'marcada-sec'));
  const sec = $(`#cancion [data-sec="${m.seccion}"]`); if (!sec) return;
  const todo = m.todo || m.linea < 0;
  if (todo) sec.classList.add('marcada-sec'); // sección completa, un solo color
  const linea = todo ? null : sec.querySelector(`.linea[data-l="${m.linea}"]`); if (linea) linea.classList.add('marcada');
  const pal = linea && m.palabra >= 0 ? linea.querySelector(`.pal[data-p="${m.palabra}"]`) : null; if (pal) pal.classList.add('marcada');
  const el = pal || linea || sec;
  if (m.quien) aviso(`📍 ${m.quien}`);
  if (modo !== 'lider') { const r = el.getBoundingClientRect(); if (r.top < topBarra() || r.bottom > window.innerHeight * 0.85) scrollA(r.top + window.scrollY - window.innerHeight * 0.35); }
  clearTimeout(tMarca); tMarca = setTimeout(() => $$('#cancion .marcada, #cancion .marcada-sec').forEach(x => x.classList.remove('marcada', 'marcada-sec')), 5000);
}
$('#cancion').addEventListener('pointerdown', e => {
  toque = { x: e.clientX, y: e.clientY, t: Date.now() };
  clearTimeout(tPresion);
  if (e.button === 0) tPresion = setTimeout(() => { marcarAqui(e.target); toque = null; }, 500);
});
$('#cancion').addEventListener('pointermove', e => { if (toque && (Math.abs(e.clientX - toque.x) > 10 || Math.abs(e.clientY - toque.y) > 10)) clearTimeout(tPresion); });
$('#cancion').addEventListener('pointercancel', () => clearTimeout(tPresion));
$('#cancion').addEventListener('contextmenu', e => { e.preventDefault(); clearTimeout(tPresion); marcarAqui(e.target); toque = null; });
$('#cancion').addEventListener('click', e => { if (e.target.closest('.btn-pasar')) { e.stopPropagation(); enviar({ tipo: 'siguiente', accion: 'pasar' }); } });
$('#cancion').addEventListener('pointerup', e => {
  clearTimeout(tPresion);
  if (e.target.closest('.btn-pasar')) { toque = null; return; }
  if (!toque) return; const dx = Math.abs(e.clientX - toque.x), dy = Math.abs(e.clientY - toque.y), dt = Date.now() - toque.t; toque = null;
  if (dx > 10 || dy > 10 || dt > 400) return; // fue un desplazamiento, no un toque
  const sec = e.target.closest('[data-sec]');
  const w = window.innerWidth;
  if (e.clientX > w * 0.66) moverSeccion(1);
  else if (e.clientX < w * 0.2) moverSeccion(-1);
  else if (sec && perfil.vista === 'estructura') irASeccion(Number(sec.dataset.sec));
});

// transposición, cejilla, tamaño
const ajustar = (obj, delta, min, max) => { const id = mostrando.id; if (!id) return; obj[id] = Math.max(min, Math.min(max, (obj[id] ?? 0) + delta)); guardar('prefs', prefs); pintar(); };
function cambiarTonoBanda(delta) {
  const id = mostrando.id; if (!id || rol !== 'director') return;
  const t = Math.max(-11, Math.min(11, transpBanda(id) + delta));
  estado.tonos = estado.tonos || {}; if (t === 0) delete estado.tonos[id]; else estado.tonos[id] = t;
  pintar(); enviar({ tipo: 'tono', cancion: id, transp: t });
}
$('#tr-menos').onclick = () => cambiarTonoBanda(-1);
$('#tr-mas').onclick = () => cambiarTonoBanda(1);
$('#btn-tono-orig').onclick = async () => {
  const id = mostrando.id; if (!id || rol !== 'director') return;
  const actual = mostrando.cancion.meta.tono || '';
  const nuevo = prompt('Tono original de la canción (ej. G, Am, F#m). Vacío para borrar:', actual); if (nuevo === null) return;
  let cho = await obtenerCho(id);
  const lineaTono = nuevo.trim() ? `{tono: ${nuevo.trim()}}` : '';
  if (/^\{\s*tono\s*:.*\}\s*$/mi.test(cho)) cho = cho.replace(/^\{\s*tono\s*:.*\}\s*$\n?/mi, lineaTono ? lineaTono + '\n' : '');
  else if (lineaTono) cho = cho.replace(/^(\{\s*titulo\s*:.*\}\s*\n)/i, `$1${lineaTono}\n`);
  try {
    await api(`/api/canciones/${id}`, { method: 'PUT', body: JSON.stringify({ cho }) });
    cacheCho.set(id, cho); mostrando.cancion = parsear(cho); const e = indice.find(c => c.id === id); if (e) e.tono = nuevo.trim();
    pintar(); aviso('tono guardado');
  } catch (e) { aviso('no se guardó: ' + e.message); }
};
$('#cj-menos').onclick = () => ajustar(prefs.cejilla, -1, 0, 9);
$('#cj-mas').onclick = () => ajustar(prefs.cejilla, 1, 0, 9);
$('#tam-menos').onclick = () => { prefs.tam = Math.max(0.8, +(prefs.tam - 0.1).toFixed(2)); guardar('prefs', prefs); pintar(); };
$('#tam-mas').onclick = () => { prefs.tam = Math.min(3, +(prefs.tam + 0.1).toFixed(2)); guardar('prefs', prefs); pintar(); };

// ---------- notas personales ----------
async function abrirNota() {
  if (!mostrando.id) return; if (!perfil.nombre) { aviso('pon tu nombre en “Yo”'); return irA('ajustes'); }
  $('#nota-panel').hidden = false;
  try { const { texto } = await api(`/api/notas/${encodeURIComponent(perfil.nombre)}/${mostrando.id}`); $('#nota-texto').value = texto || ''; } catch { $('#nota-texto').value = ''; }
  $('#nota-texto').focus();
}
function cerrarNota() { $('#nota-panel').hidden = true; }
$('#btn-nota').onclick = () => $('#nota-panel').hidden ? abrirNota() : cerrarNota();
$('#nota-cerrar').onclick = cerrarNota;
$('#nota-guardar').onclick = async () => { try { await api(`/api/notas/${encodeURIComponent(perfil.nombre)}/${mostrando.id}`, { method: 'PUT', body: JSON.stringify({ texto: $('#nota-texto').value }) }); aviso('nota guardada'); cerrarNota(); } catch (e) { aviso('no se guardó: ' + e.message); } };

async function cancionCambiada(id) {
  cacheCho.delete(id);
  try { indice = await api('/api/canciones'); ultimaFirmaBib = ''; renderBiblioteca(); } catch {}
  if (mostrando.id === id || (mostrando.cancion && mostrando.cancion.secciones.some(s => s.parte && s.parte.id === id))) {
    const y = window.scrollY; mostrando.expandidas = null; mostrando.pintadoId = null;
    await mostrar(mostrando.id, mostrando.seccion, { frac: mostrando.frac, desplazar: false });
    scrollA(y);
  }
  if (editor.id === id && $('#vista-editor').classList.contains('activa') && !editor.guardando) { await renderEditor(); if ($('#sub-acordes').classList.contains('activa')) renderEditorAcordes(); }
}

// ---------- siguiente (cola) ----------
function renderSiguiente() {
  const ol = $('#lista-siguiente'); ol.innerHTML = '';
  $('#siguiente-vacio').hidden = estado.siguiente.length > 0;
  estado.siguiente.forEach((id, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="info"><div class="t">${esc(titulo(id))}</div><div class="s">${esc(artista(id))}</div></div><div class="acc"></div>`;
    const acc = li.querySelector('.acc');
    acc.append(boton('Ver', () => verLibre(id)));
    if (puedeMover()) acc.append(boton('▶ Vivo', () => { enviar({ tipo: 'vivo', cancion: id }); enviar({ tipo: 'siguiente', accion: 'quitar', indice: i }); irA('vivo'); }, 'primario'));
    if (puedeCola()) { if (i > 0) acc.append(boton('↑', () => enviar({ tipo: 'siguiente', accion: 'mover', indice: i, a: i - 1 }))); acc.append(boton('✕', () => enviar({ tipo: 'siguiente', accion: 'quitar', indice: i }))); }
    ol.append(li);
  });
  renderHistorial();
}
// Ya tocadas: la más reciente primero. Ver / ▶ Vivo / + Cola; el director puede limpiarla (p. ej. al empezar otro toque).
function renderHistorial() {
  const ol = $('#lista-historial'); ol.innerHTML = '';
  const h = [...(estado.historial || [])].reverse();
  $('#historial-vacio').hidden = h.length > 0;
  $('#historial-acciones').hidden = !(rol === 'director' && h.length);
  h.forEach((id, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="info"><div class="t">${esc(titulo(id))}</div><div class="s">${esc([i === 0 ? 'última tocada' : '', artista(id)].filter(Boolean).join(' · '))}</div></div><div class="acc"></div>`;
    const acc = li.querySelector('.acc');
    acc.append(boton('Ver', () => verLibre(id)));
    if (puedeMover()) acc.append(boton('▶ Vivo', () => { enviar({ tipo: 'vivo', cancion: id }); irA('vivo'); }, 'primario'));
    if (puedeCola()) acc.append(boton('+ Cola', () => { enviar({ tipo: 'siguiente', accion: 'agregar', cancion: id }); aviso('agregada a la cola'); }));
    ol.append(li);
  });
}
$('#historial-limpiar').onclick = () => { if (confirm('¿Limpiar el historial de canciones tocadas?')) enviar({ tipo: 'siguiente', accion: 'vaciar-historial' }); };
$('#siguiente-vaciar').onclick = () => { if (confirm('¿Vaciar la cola?')) enviar({ tipo: 'siguiente', accion: 'vaciar' }); };
$('#siguiente-guardar').onclick = async () => {
  const nombre = prompt('Nombre del setlist (ej. “Sábado Pueblo Café”):'); if (!nombre) return;
  try { await api('/api/setlists', { method: 'POST', body: JSON.stringify({ nombre, fecha: new Date().toISOString().slice(0, 10), canciones: estado.siguiente }) }); aviso('setlist guardado'); } catch (e) { aviso('error: ' + e.message); }
};

// ---------- biblioteca ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function boton(txt, fn, clase = '') { const b = document.createElement('button'); b.textContent = txt; b.onclick = fn; if (clase) b.className = clase; return b; }
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function renderBiblioteca() {
  const q = norm($('#buscar').value.trim());
  const lista = indice.filter(c => !q || norm(c.titulo).includes(q) || norm(c.artista).includes(q) || norm(c.genero).includes(q));
  $('#bib-info').textContent = `${lista.length} de ${indice.length} canciones`;
  $('#bib-director').hidden = rol !== 'director';
  const ul = $('#lista-canciones'); ul.innerHTML = '';
  for (const c of lista.slice(0, 300)) {
    const li = document.createElement('li'); if (c.id === estado.vivo.cancion) li.classList.add('en-vivo');
    li.innerHTML = `<div class="info"><div class="t">${c.tipo === 'mix' ? '🎛 ' : c.tipo === 'bloque' ? '🗒 ' : ''}${esc(c.titulo)}</div><div class="s">${esc([c.tipo === 'mix' ? 'mix' : c.tipo === 'bloque' ? 'bloque del show' : '', c.artista, c.genero, c.tono ? 'Tono ' + c.tono : '', c.estado === 'importada' ? '⚠ sin corregir' : ''].filter(Boolean).join(' · '))}</div></div><div class="acc"></div>`;
    const acc = li.querySelector('.acc');
    acc.append(boton('Ver', () => verLibre(c.id)));
    if (rol === 'director') acc.append(boton('✎', () => abrirEditor(c.id)));
    if (puedeCola()) acc.append(boton('+ Cola', () => { enviar({ tipo: 'siguiente', accion: 'agregar', cancion: c.id }); aviso('agregada a Siguiente'); }));
    if (puedeMover()) acc.append(boton('▶ Vivo', () => { enviar({ tipo: 'vivo', cancion: c.id }); irA('vivo'); }, 'primario'));
    ul.append(li);
  }
}
$('#buscar').oninput = renderBiblioteca;
async function cargarIndice() {
  try { indice = await api('/api/canciones'); } catch { indice = indice.length ? indice : []; }
  renderBiblioteca(); renderSiguiente();
  // guardar todas las canciones en este teléfono, en segundo plano (el service worker las cachea)
  (async () => { for (const c of indice) { if (!cacheCho.has(c.id)) { try { await fetch(`/api/canciones/${c.id}`); } catch { break; } } } })();
}

// ---------- setlists ----------
async function cargarSetlists() {
  const ul = $('#lista-setlists'); ul.innerHTML = '';
  try {
    const lista = await api('/api/setlists');
    if (!lista.length) ul.innerHTML = '<li class="vacio">No hay setlists. El director puede guardar la cola “Siguiente” como setlist.</li>';
    for (const s of lista) {
      const li = document.createElement('li');
      li.innerHTML = `<div class="info"><div class="t">${esc(s.nombre)}</div><div class="s">${esc(s.fecha)} · ${s.n} canciones</div></div><div class="acc"></div>`;
      li.querySelector('.acc').append(boton('Abrir', () => abrirSetlist(s.id)));
      ul.append(li);
    }
  } catch (e) { ul.innerHTML = `<li class="vacio">No se pudieron cargar (${esc(e.message)})</li>`; }
}
async function abrirSetlist(id) {
  try {
    setlistAbierto = await api(`/api/setlists/${id}`);
    $('#setlist-nombre').textContent = `${setlistAbierto.nombre} · ${setlistAbierto.fecha}`;
    const ol = $('#setlist-canciones'); ol.innerHTML = '';
    setlistAbierto.canciones.forEach(cid => { const li = document.createElement('li'); li.innerHTML = `<div class="info"><div class="t">${esc(titulo(cid))}</div><div class="s">${esc(artista(cid))}</div></div><div class="acc"></div>`; li.querySelector('.acc').append(boton('Ver', () => verLibre(cid))); ol.append(li); });
    $('#setlist-cargar').hidden = !puedeCola();
    $('#setlist-detalle').hidden = false;
  } catch (e) { aviso('error: ' + e.message); }
}
$('#setlist-cerrar').onclick = () => { $('#setlist-detalle').hidden = true; };
$('#setlist-cargar').onclick = () => { if (!setlistAbierto) return; enviar({ tipo: 'siguiente', accion: 'reemplazar', canciones: setlistAbierto.canciones }); irA('siguiente'); };

// ---------- perfil / ajustes ----------
function llenarPerfil() { const f = $('#form-perfil'); for (const k of ['nombre', 'instrumento', 'rol', 'pin', 'vista', 'paso', 'lineas']) if (f.elements[k]) f.elements[k].value = perfil[k] ?? ''; f.elements.cejilla.checked = !!perfil.cejilla; f.elements.botones.checked = perfil.botones !== false; f.elements.ajustar.checked = perfil.ajustar !== false; $('#campo-lineas').hidden = f.elements.paso.value !== 'lineas'; }
$('#form-perfil').elements.paso.onchange = ev => { $('#campo-lineas').hidden = ev.target.value !== 'lineas'; };
$('#form-perfil').onsubmit = ev => {
  ev.preventDefault(); const f = ev.target;
  for (const k of ['nombre', 'instrumento', 'rol', 'pin', 'vista', 'paso']) perfil[k] = f.elements[k].value;
  perfil.lineas = Math.max(1, Math.min(10, Number(f.elements.lineas.value) || 4)); f.elements.lineas.value = perfil.lineas;
  perfil.cejilla = f.elements.cejilla.checked; perfil.botones = f.elements.botones.checked; perfil.ajustar = f.elements.ajustar.checked;
  guardar('perfil', perfil); mostrando.pintadoId = null; pintar(); actualizarControles();
  try { ws && ws.close(); } catch {} // reconecta con el nuevo perfil/rol
  aviso('perfil guardado'); irA('vivo');
};
$('#chk-cantante').onchange = ev => enviar({ tipo: 'control', cantante: ev.target.checked });
$('#btn-cantante').onclick = () => { const nuevo = !estado.controlCantante; enviar({ tipo: 'control', cantante: nuevo }); aviso(nuevo ? 'el cantante puede mover el vivo' : 'solo tú mueves el vivo'); }; // botón fijo en la barra del director; se guarda al instante en el servidor
function renderConectados() {
  const ul = $('#conectados'); ul.innerHTML = '';
  for (const c of estado.conectados) { const li = document.createElement('li'); li.textContent = `${c.nombre}${c.instrumento ? ' · ' + c.instrumento : ''}${c.rol !== 'musico' ? ' · ' + c.rol : ''}`; ul.append(li); }
  if (!estado.conectados.length) ul.innerHTML = '<li class="vacio">nadie conectado</li>';
}
async function cargarInfo() {
  try {
    const i = await api('/api/info');
    $('#panel-mac').hidden = !i.local; // solo en la propia Mac: vuelve al panel con el QR
    $('#info-servidor').innerHTML = `Servidor v${esc(i.version)} · datos: ${esc(i.datos)}${i.ejemplo ? ' <b>(datos de ejemplo, no los reales)</b>' : ''}<br>Direcciones para los demás: ${i.ips.map(x => `<b>http://${x.ip}:${i.puerto}</b>`).join(' · ')}`;
  } catch { $('#info-servidor').textContent = 'Sin conexión con el servidor.'; }
}

// ---------- edición de canción (director, desde "Canciones") ----------
const editor = { id: null, cho: '', selIni: null, selFin: null, arreglo: [], renombrar: null };
const NOMBRES_ESTANDAR = ['Intro', 'Estrofa 1', 'Estrofa 2', 'Estrofa 3', 'Pre-coro', 'Coro', 'Puente', 'Solo', 'Interludio', 'Final'];
const META_CAB = /^\{\s*(titulo|título|artista|tono|cejilla|estado|compositor|afinacion|afinación|fuente|arreglo|tipo|genero|género)\s*:/i;
const RE_SEC = /^\{\s*secci[oó]n\s*:\s*(.*?)\s*\}\s*$/i;
const RE_PARTE = /^\{\s*parte\s*:\s*(.*?)\s*\}\s*$/i;
const RE_NOTA = /^\{\s*(nota|comentario|c)\s*:\s*(.*?)\s*\}\s*$/i;
const RE_ARREGLO = /^\{\s*arreglo\s*:.*\}\s*$/im;
const NUEVA = '__nueva__';

// Palabras de una línea cruda (con acordes entre corchetes): índices en la línea para poder partirla.
// `ini` retrocede sobre los acordes pegados al inicio de la palabra para que viajen con ella.
const esSoloAcordes = l => { const sinAc = l.replace(/\[[^\]]*\]/g, '').replace(/\((x\d+)\)|x\d+|\||-/g, '').trim(); return /\[[^\]]+\]/.test(l) && !sinAc; };
const lineaDeAcordes = texto => texto.trim().split(/\s+/).filter(Boolean).map(t => /^\(?x\d+\)?$|^\|+$/.test(t) ? t : `[${t.replace(/^\[|\]$/g, '')}]`).join(' ');
async function abrirEditor(id) {
  if (rol !== 'director') return aviso('solo el director');
  editor.id = id; editor.selIni = editor.selFin = null; editor.renombrar = null; edA.sel = null; edA.destino = null; edA.historial = [];
  await renderEditor(); if ($('#sub-acordes').classList.contains('activa')) renderEditorAcordes(); irA('editor'); window.scrollTo({ top: 0 });
}
async function guardarEditor(cho) {
  editor.cho = cho;
  await api(`/api/canciones/${editor.id}`, { method: 'PUT', body: JSON.stringify({ cho }) });
  cacheCho.set(editor.id, cho); // el aviso del servidor repinta el vivo en todos
}
function lineasCuerpo() { return editor.cho.replace(/\r/g, '').split('\n'); }
const antes = (a, b) => a.i < b.i || (a.i === b.i && a.w <= b.w);
async function cargarNombres() {
  let usados = []; try { usados = await api('/api/secciones'); } catch {}
  const nombres = [...new Set([...NOMBRES_ESTANDAR, ...usados])];
  const sel = $('#ed-nombre-sel'); sel.innerHTML = '<option value="">Nombre de la sección…</option>';
  for (const n of nombres) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.append(o); }
  const o = document.createElement('option'); o.value = NUEVA; o.textContent = '＋ Agregar nueva…'; sel.append(o);
  return nombres;
}
$('#ed-nombre-sel').onchange = ev => { const nueva = ev.target.value === NUEVA; $('#ed-nombre-nuevo').hidden = !nueva; if (nueva) $('#ed-nombre-nuevo').focus(); };
function nombreElegido() {
  const v = $('#ed-nombre-sel').value;
  return v === NUEVA ? $('#ed-nombre-nuevo').value.trim() : v;
}
async function renderEditor() {
  editor.cho = await obtenerCho(editor.id);
  const c = parsear(editor.cho);
  $('#ed-titulo').textContent = c.meta.titulo || editor.id;
  await llenarGeneros($('#ed-genero'), c.meta.genero || c.meta.género || ''); $('#ed-genero-nuevo').hidden = true; $('#ed-genero-ok').hidden = true;
  await cargarNombres();
  // --- secciones: solo letra, por palabra ---
  const cont = $('#ed-texto'); cont.innerHTML = '';
  const L = lineasCuerpo();
  const a = editor.selIni, b = editor.selFin;
  const filaAnadir = (pos, texto = '＋ añadir sección aquí') => { const d = document.createElement('div'); d.className = 'ed-anadir'; d.textContent = texto; d.onclick = () => abrirNuevaSeccion(pos, d); cont.append(d); };
  let primeraDelCuerpo = true;
  L.forEach((l, i) => {
    if (META_CAB.test(l)) return;
    let m;
    if (primeraDelCuerpo && l.trim()) { primeraDelCuerpo = false; if (!RE_SEC.test(l)) filaAnadir(i, '＋ añadir sección al inicio'); }
    if ((m = l.match(RE_SEC))) {
      filaAnadir(i);
      const div = document.createElement('div'); div.className = 'ed-sec' + (m[1] ? '' : ' sin-nombre');
      div.innerHTML = `<span class="n">${esc(m[1] || 'sección sin nombre')}</span>`;
      div.append(boton('✎ nombre', () => { editor.renombrar = i; editor.selIni = editor.selFin = null; renderEditor(); mostrarBarra(); }));
      div.append(boton('✎ nota', () => abrirEditarSeccion(i, 'nota', div)));
      div.append(boton('✎ letra', () => abrirEditarSeccion(i, 'letra', div)));
      div.append(boton('✕', async () => { if (!confirm('¿Quitar la marca de sección? La letra se conserva.')) return; L.splice(i, 1); await guardarEditor(L.join('\n')); renderEditor(); }));
      div.append(boton('🗑', async () => { if (!confirm(`¿Eliminar la sección "${m[1] || 'sin nombre'}" con su letra y acordes? Si se repite en la canción, mejor repítela en el Arreglo.`)) return; await guardarEditor(eliminarSeccion(editor.cho, i)); renderEditor(); }));
      cont.append(div); return;
    }
    if ((m = l.match(RE_PARTE))) { const d = document.createElement('div'); d.className = 'ed-nota'; d.textContent = '↪ parte: ' + m[1]; cont.append(d); return; }
    if ((m = l.match(RE_NOTA))) { const d = document.createElement('div'); d.className = 'ed-nota'; d.textContent = m[2]; cont.append(d); return; }
    if (!l.trim()) { const d = document.createElement('div'); d.className = 'ed-vacia'; cont.append(d); return; }
    if (esSoloAcordes(l)) return; // las líneas solo de acordes no se muestran aquí: se trabajan en Acordes y en Arreglo
    const linea = document.createElement('div'); linea.className = 'ed-linea';
    palabrasCrudas(l).forEach((p, w) => {
      const sp = document.createElement('span'); sp.className = 'pal'; sp.textContent = p.texto; sp.dataset.i = i; sp.dataset.w = w;
      const pos = { i, w };
      if (a && b && antes(a, pos) && antes(pos, b)) sp.classList.add('sel');
      if (a && a.i === i && a.w === w) sp.classList.add('sel-ini');
      if (b && b.i === i && b.w === w) sp.classList.add('sel-fin');
      sp.onclick = () => seleccionarPalabra(pos);
      linea.append(sp, ' ');
    });
    cont.append(linea);
  });
  filaAnadir(L.length, '＋ añadir sección al final');
  $('#ed-sel-barra').hidden = editor.selIni === null && editor.renombrar === null;
  $('#ed-definir').textContent = editor.renombrar !== null ? 'Renombrar sección' : 'Definir sección';
  $('#ed-eliminar-tramo').hidden = editor.renombrar !== null || editor.selIni === null; // eliminar letra: con una palabra o un tramo elegido
  // --- arreglo original ---
  const nombres = [...new Set(c.secciones.map(s => s.nombre || '').filter(Boolean))];
  const chips = $('#ed-chips'); chips.innerHTML = '';
  for (const n of nombres) chips.append(boton(n, () => { editor.arreglo.push(n); renderArreglo(); }));
  if (!nombres.length) chips.innerHTML = '<span class="ayuda">Primero marca secciones.</span>';
  editor.arreglo = nombresArreglo(c); renderArreglo();
}
function mostrarBarra() { $('#ed-sel-barra').hidden = false; $('#ed-nombre-sel').value = ''; $('#ed-nombre-nuevo').hidden = true; $('#ed-nombre-nuevo').value = ''; }
function seleccionarPalabra(pos) {
  editor.renombrar = null;
  if (editor.selIni === null || editor.selFin !== null) { editor.selIni = pos; editor.selFin = null; }
  else { editor.selFin = pos; if (!antes(editor.selIni, editor.selFin)) [editor.selIni, editor.selFin] = [editor.selFin, editor.selIni]; }
  renderEditor().then(() => { if (editor.selFin) mostrarBarra(); });
}
$('#ed-cancelar').onclick = () => { editor.selIni = editor.selFin = null; editor.renombrar = null; renderEditor(); };
$('#ed-eliminar-tramo').onclick = async () => { // borra la letra seleccionada (y sus acordes) sin crear sección
  if (editor.selIni === null || editor.renombrar !== null) return;
  let a = { ...editor.selIni }, b = editor.selFin ? { ...editor.selFin } : { ...editor.selIni };
  if (!antes(a, b)) [a, b] = [b, a];
  const n = editor.selFin ? 'la letra seleccionada' : 'esta palabra';
  if (!confirm(`¿Eliminar ${n} con sus acordes? Se puede deshacer volviendo a importar la canción, no hay deshacer aquí.`)) return;
  editor.selIni = editor.selFin = null;
  await guardarEditor(eliminarTramo(editor.cho, a, b)); renderEditor();
};
$('#ed-definir').onclick = async () => {
  const nombre = nombreElegido(); if (!nombre) return aviso('elige o escribe un nombre');
  const L = lineasCuerpo();
  if (editor.renombrar !== null) { L[editor.renombrar] = `{seccion: ${nombre}}`; editor.renombrar = null; await guardarEditor(L.join('\n')); return renderEditor(); }
  if (editor.selIni === null) return;
  const a = { ...editor.selIni }, b = editor.selFin ? { ...editor.selFin } : { ...editor.selIni };
  // marcas de sección dentro del tramo se funden en la nueva
  for (let k = b.i; k > a.i; k--) if (RE_SEC.test(L[k])) { L.splice(k, 1); b.i--; }
  // corte al final del tramo: si la última palabra no cierra su línea, se parte la línea ahí
  { const pals = palabrasCrudas(L[b.i]);
    if (b.w < pals.length - 1) { const idx = pals[b.w].fin; L.splice(b.i, 1, L[b.i].slice(0, idx).trimEnd(), '{seccion: }', L[b.i].slice(idx).trimStart()); }
    else { // las líneas solo de acordes que siguen (acorde de cola, p. ej. el D7 final de un coro) viajan con el tramo
      let fin = b.i; { let k = b.i + 1; while (k < L.length && (!L[k].trim() || esSoloAcordes(L[k]))) { if (esSoloAcordes(L[k])) fin = k; k++; } }
      let j = fin + 1; while (j < L.length && !L[j].trim()) j++; if (j < L.length && !RE_SEC.test(L[j]) && !RE_PARTE.test(L[j]) && !META_CAB.test(L[j])) L.splice(fin + 1, 0, '{seccion: }'); } }
  // corte al inicio del tramo: si la primera palabra no abre su línea, se parte la línea ahí (los acordes viajan con su palabra)
  { const pals = palabrasCrudas(L[a.i]);
    if (a.w > 0) { const idx = pals[a.w].ini; L.splice(a.i, 1, L[a.i].slice(0, idx).trimEnd(), `{seccion: ${nombre}}`, L[a.i].slice(idx)); }
    else L.splice(a.i, 0, `{seccion: ${nombre}}`); }
  editor.selIni = editor.selFin = null;
  await guardarEditor(L.join('\n')); renderEditor();
};
// ---------- pestaña Acordes: mover, cambiar, agregar y quitar acordes sobre la letra ----------
const edA = { sel: null, destino: null, historial: [], lineaNueva: null, duplicar: false }; // duplicar: el siguiente toque en una palabra pone una copia del acorde seleccionado, sin quitar el original // lineaNueva = {l, enLaMisma} // sel = {l, ini, fin, texto} acorde seleccionado; destino = {l, ini, fin} palabra elegida
function piezasLinea(raw) {
  const out = []; let i = 0;
  while (i < raw.length) {
    if (raw[i] === '[') { const j = raw.indexOf(']', i); if (j < 0) { out.push({ tipo: 'ch', ch: raw[i], ini: i }); i++; continue; } out.push({ tipo: 'ac', texto: raw.slice(i + 1, j), ini: i, fin: j + 1 }); i = j + 1; continue; }
    out.push({ tipo: 'ch', ch: raw[i], ini: i }); i++;
  }
  return out;
}
function renderLineaEdicion(raw, l) {
  const piezas = piezasLinea(raw);
  let html = '', palabra = '', segAbierto = false, palIni = null, pendiente = null, tieneTexto = false;
  const cerrarSeg = () => { if (segAbierto) { html2 += '</span></span>'; segAbierto = false; } };
  let html2 = '';
  const cerrarPal = (finRaw) => { cerrarSeg(); if (html2) { html += `<span class="pal" data-l="${l}" data-ini="${palIni}" data-fin="${finRaw}">${html2}</span>`; html2 = ''; } palIni = null; };
  for (const p of piezas) {
    if (p.tipo === 'ac') { cerrarSeg(); if (palIni === null) palIni = p.ini; html2 += `<span class="seg"><span class="ac" data-l="${l}" data-ini="${p.ini}" data-fin="${p.fin}">${esc(p.texto)}</span><span class="tx">`; segAbierto = true; continue; }
    if (/\s/.test(p.ch)) { cerrarPal(p.ini); html += `<span class="esp">${p.ch}</span>`; continue; }
    tieneTexto = true;
    if (palIni === null) palIni = p.ini;
    if (!segAbierto) { html2 += `<span class="seg"><span class="ac"></span><span class="tx">`; segAbierto = true; }
    html2 += esc(p.ch);
  }
  cerrarPal(raw.length);
  return { html, soloAcordes: !tieneTexto && piezas.some(p => p.tipo === 'ac') };
}
function renderEditorAcordes() {
  const panelLetras = $('#edA-letras'); if (panelLetras && panelLetras.parentElement !== $('#edA-barra')) $('#edA-barra').insertBefore(panelLetras, $('#edA-barra').lastElementChild);
  const L = lineasCuerpo(); const art = $('#edA-cancion'); let html = '';
  L.forEach((raw, l) => {
    if (META_CAB.test(raw)) return;
    let m;
    if ((m = raw.match(RE_SEC))) { html += `<div class="nombre">${esc(m[1] || 'sección sin nombre')}</div>`; return; }
    if ((m = raw.match(RE_NOTA))) { html += `<div class="nota">${esc(m[2])}</div>`; return; }
    if (RE_PARTE.test(raw)) return;
    if (!raw.trim()) { html += '<div class="linea">&nbsp;</div>'; return; }
    const r = renderLineaEdicion(raw, l);
    html += `<div class="linea ${r.soloAcordes ? 'solo-acordes' : ''}" data-l="${l}">${r.html}<button class="mas-linea" data-l="${l}" title="${r.soloAcordes ? 'Agregar acordes a esta línea' : 'Agregar una línea solo de acordes debajo'}">＋</button></div>`;
  });
  art.innerHTML = html;
  if (edA.sel) { const a = art.querySelector(`.ac[data-l="${edA.sel.l}"][data-ini="${edA.sel.ini}"]`); if (a) a.classList.add('sel'); }
  if (edA.destino) { const pl = art.querySelector(`.pal[data-l="${edA.destino.l}"][data-ini="${edA.destino.ini}"]`); if (pl) pl.classList.add('destino'); }
  $('#edA-acorde-sel').hidden = !edA.sel || !!edA.destino;
  $('#edA-letras').hidden = !edA.destino && !edA.lineaNueva;
  $('#edA-ayuda').hidden = !!(edA.sel || edA.destino || edA.lineaNueva);
  $('#edA-deshacer').disabled = !edA.historial.length;
  const estado = (editor.cho.match(/^\{\s*estado\s*:\s*(.*?)\s*\}/mi) || [])[1] || '';
  $('#edA-estado').textContent = estado === 'corregida' ? '✓ Corregida (volver a "importada")' : 'Marcar como corregida';
  $('#edA-estado').className = estado === 'corregida' ? '' : 'primario';
  if (edA.sel) { $('#edA-nombre-sel').textContent = edA.sel.texto; $('#edA-sel-ayuda').textContent = edA.duplicar ? 'toca la palabra donde va la copia' : 'toca la palabra destino para moverlo'; $('#edA-duplicar').classList.toggle('primario', edA.duplicar); }
}
async function guardarAcordes(nuevoCho) {
  edA.historial.push(editor.cho); if (edA.historial.length > 50) edA.historial.shift();
  editor.guardando = true; try { await guardarEditor(nuevoCho); } finally { editor.guardando = false; }
  renderEditorAcordes();
}
function acordesUsados() { return [...new Set([...editor.cho.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]))]; }
function mostrarLetras(destino, paraAgregar) {
  const L = lineasCuerpo(); const raw = L[destino.l];
  const piezas = piezasLinea(raw).filter(p => p.ini >= destino.ini && p.ini < destino.fin);
  // el panel de letras se coloca justo debajo de la línea tocada, para verlo sin subir
  const panel = $('#edA-letras'); const lineaEl = $(`#edA-cancion .linea[data-l="${destino.l}"]`);
  if (lineaEl) lineaEl.insertAdjacentElement('afterend', panel); else $('#edA-barra').append(panel);
  const cont = $('#edA-letras-lista'); cont.innerHTML = '';
  for (const p of piezas) {
    if (p.tipo === 'ac') { const sp = document.createElement('span'); sp.className = 'ac-ya'; sp.textContent = p.texto; cont.append(sp); continue; }
    if (/\s/.test(p.ch)) continue;
    const b = boton(p.ch, () => elegirPosicion(destino.l, p.ini)); b.dataset.idx = p.ini; cont.append(b);
  }
  // "al final de la palabra": el acorde cae en el espacio entre esta palabra y la siguiente (o al final de la línea)
  const bf = boton('al final de la palabra', () => elegirPosicion(destino.l, destino.fin)); bf.className = 'fin'; bf.dataset.idx = destino.fin; cont.append(bf);
  $('#edA-letras-ayuda').textContent = paraAgregar ? '¿Antes de qué letra va el acorde nuevo?' : edA.duplicar ? `¿Antes de qué letra va la copia de ${edA.sel.texto}?` : `¿Antes de qué letra va ${edA.sel.texto}?`;
  $('#edA-agregar-fila').hidden = !paraAgregar;
  const chips = $('#edA-chips'); chips.innerHTML = '';
  if (paraAgregar) for (const a of acordesUsados()) chips.append(boton(a, () => { $('#edA-agregar-txt').value = a; }));
}
let posElegida = null;
function elegirPosicion(l, idx) {
  if (edA.sel && edA.duplicar) { // duplicar: copia del acorde en la posición elegida, el original se queda
    const L = lineasCuerpo(); L[l] = L[l].slice(0, idx) + `[${edA.sel.texto}]` + L[l].slice(idx);
    edA.sel = null; edA.destino = null; edA.duplicar = false;
    guardarAcordes(L.join('\n'));
  } else if (edA.sel) { // mover
    const L = lineasCuerpo(); const s = edA.sel; const texto = `[${s.texto}]`;
    let raw = L[s.l]; L[s.l] = raw.slice(0, s.ini) + raw.slice(s.fin);
    if (l === s.l && idx > s.ini) idx -= (s.fin - s.ini);
    L[l] = L[l].slice(0, idx) + texto + L[l].slice(idx);
    edA.sel = null; edA.destino = null;
    guardarAcordes(L.join('\n'));
  } else { // agregar: guardar posición y esperar el nombre
    posElegida = { l, idx };
    [...$('#edA-letras-lista').children].forEach(b => b.classList.toggle('primario', b.tagName === 'BUTTON' && b.dataset.idx === String(idx)));
    $('#edA-agregar-txt').focus();
  }
}
$('#edA-agregar').onclick = () => {
  if (edA.lineaNueva) {
    const acs = $('#edA-agregar-txt').value.trim(); if (!acs) return aviso('escribe los acordes');
    const L = lineasCuerpo(); const { l, enLaMisma } = edA.lineaNueva;
    if (enLaMisma) L[l] = (L[l].trimEnd() + ' ' + lineaDeAcordes(acs)).trim(); else L.splice(l + 1, 0, lineaDeAcordes(acs));
    edA.lineaNueva = null; $('#edA-agregar-txt').value = ''; $('#edA-agregar-txt').placeholder = 'Acorde a agregar (Am, G7…)';
    guardarAcordes(L.join('\n')); return;
  }
  const nombre = $('#edA-agregar-txt').value.trim().replace(/^\[|\]$/g, ''); if (!nombre) return aviso('escribe el acorde');
  if (!posElegida) return aviso('toca la letra donde va');
  const L = lineasCuerpo(); L[posElegida.l] = L[posElegida.l].slice(0, posElegida.idx) + `[${nombre}]` + L[posElegida.l].slice(posElegida.idx);
  edA.destino = null; posElegida = null; $('#edA-agregar-txt').value = '';
  guardarAcordes(L.join('\n'));
};
function mostrarAgregarLinea(l, enLaMisma) {
  edA.lineaNueva = { l, enLaMisma }; edA.sel = null; edA.destino = null; posElegida = null;
  const panel = $('#edA-letras'); const lineaEl = $(`#edA-cancion .linea[data-l="${l}"]`);
  if (lineaEl) lineaEl.insertAdjacentElement('afterend', panel);
  $('#edA-letras-lista').innerHTML = '';
  $('#edA-letras-ayuda').textContent = enLaMisma ? 'Acordes a agregar al final de esta línea (separados por espacio):' : 'Acordes de la nueva línea, sin letra, debajo de esta (separados por espacio):';
  $('#edA-agregar-fila').hidden = false; $('#edA-agregar-txt').placeholder = 'F#m  ·  o varios: Em D C';
  const chips = $('#edA-chips'); chips.innerHTML = ''; for (const a of acordesUsados()) chips.append(boton(a, () => { const t = $('#edA-agregar-txt'); t.value = (t.value + ' ' + a).trim(); }));
  panel.hidden = false; $('#edA-acorde-sel').hidden = true; $('#edA-ayuda').hidden = true;
  $('#edA-agregar-txt').focus();
}
$('#edA-cancion').addEventListener('click', e => {
  const mas = e.target.closest('.mas-linea');
  if (mas) { const l = Number(mas.dataset.l); mostrarAgregarLinea(l, mas.closest('.linea').classList.contains('solo-acordes')); return; }
  const ac = e.target.closest('.ac'); const pal = e.target.closest('.pal');
  if (ac && ac.textContent) { edA.sel = { l: Number(ac.dataset.l), ini: Number(ac.dataset.ini), fin: Number(ac.dataset.fin), texto: ac.textContent }; edA.destino = null; edA.duplicar = false; renderEditorAcordes(); return; }
  if (pal) { edA.destino = { l: Number(pal.dataset.l), ini: Number(pal.dataset.ini), fin: Number(pal.dataset.fin) }; posElegida = null; renderEditorAcordes(); mostrarLetras(edA.destino, !edA.sel); }
});
$('#edA-cambiar').onclick = () => {
  const n = $('#edA-cambiar-txt').value.trim().replace(/^\[|\]$/g, ''); if (!n || !edA.sel) return aviso('escribe el nuevo nombre');
  const L = lineasCuerpo(); const s = edA.sel; L[s.l] = L[s.l].slice(0, s.ini) + `[${n}]` + L[s.l].slice(s.fin);
  edA.sel = null; $('#edA-cambiar-txt').value = ''; guardarAcordes(L.join('\n'));
};
$('#edA-quitar').onclick = () => { if (!edA.sel) return; const L = lineasCuerpo(); const s = edA.sel; L[s.l] = L[s.l].slice(0, s.ini) + L[s.l].slice(s.fin); edA.sel = null; guardarAcordes(L.join('\n')); };
// teclado (Mac): con un acorde seleccionado en la pestaña Acordes, Supr o Retroceso lo quitan; Esc cancela la selección
document.addEventListener('keydown', ev => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (!$('#vista-editor').classList.contains('activa') || !$('#sub-acordes').classList.contains('activa')) return;
  if (edA.sel && !edA.destino && (ev.key === 'Backspace' || ev.key === 'Delete')) { ev.preventDefault(); $('#edA-quitar').click(); }
  else if (ev.key === 'Escape' && (edA.sel || edA.destino || edA.lineaNueva)) { ev.preventDefault(); $(edA.destino || edA.lineaNueva ? '#edA-letras-cancelar' : '#edA-cancelar').click(); }
});
$('#edA-cancelar').onclick = () => { edA.sel = null; edA.destino = null; edA.duplicar = false; renderEditorAcordes(); };
$('#edA-duplicar').onclick = () => { if (!edA.sel) return; edA.duplicar = !edA.duplicar; renderEditorAcordes(); if (edA.duplicar) aviso('toca la palabra donde va la copia'); };
$('#edA-letras-cancelar').onclick = () => { edA.destino = null; edA.lineaNueva = null; posElegida = null; $('#edA-agregar-txt').placeholder = 'Acorde a agregar (Am, G7…)'; renderEditorAcordes(); };
$('#edA-deshacer').onclick = async () => { const prev = edA.historial.pop(); if (prev === undefined) return; editor.guardando = true; try { await guardarEditor(prev); } finally { editor.guardando = false; } edA.sel = null; edA.destino = null; renderEditorAcordes(); };
$('#edA-estado').onclick = () => {
  const actual = (editor.cho.match(/^\{\s*estado\s*:\s*(.*?)\s*\}/mi) || [])[1] || '';
  const nuevo = actual === 'corregida' ? 'importada' : 'corregida';
  let cho = editor.cho;
  if (/^\{\s*estado\s*:.*\}\s*$/mi.test(cho)) cho = cho.replace(/^\{\s*estado\s*:.*\}\s*$/mi, `{estado: ${nuevo}}`); else cho = cho.replace(/^(\{\s*titulo\s*:.*\}\s*\n)/im, `$1{estado: ${nuevo}}\n`);
  guardarAcordes(cho);
};
// "añadir sección aquí": inserta {seccion} (+ acordes y nota opcionales) en la posición elegida del archivo
let posNuevaSec = null;
function abrirNuevaSeccion(pos, fila) {
  posNuevaSec = pos;
  const f = $('#ed-nueva-sec'); f.hidden = false; fila.insertAdjacentElement('afterend', f);
  $('#ed-ns-nombre').innerHTML = $('#ed-nombre-sel').innerHTML; $('#ed-ns-nombre').value = '';
  $('#ed-ns-nombre-nuevo').hidden = true; $('#ed-ns-nombre-nuevo').value = ''; $('#ed-ns-acordes').value = ''; $('#ed-ns-nota').value = '';
}
$('#ed-ns-nombre').onchange = ev => { $('#ed-ns-nombre-nuevo').hidden = ev.target.value !== NUEVA; if (ev.target.value === NUEVA) $('#ed-ns-nombre-nuevo').focus(); };
$('#ed-ns-cancelar').onclick = () => { $('#ed-nueva-sec').hidden = true; $('#sub-secciones').append($('#ed-nueva-sec')); posNuevaSec = null; };
$('#ed-ns-agregar').onclick = async () => {
  const v = $('#ed-ns-nombre').value; const nombre = v === NUEVA ? $('#ed-ns-nombre-nuevo').value.trim() : v;
  if (!nombre) return aviso('elige o escribe el nombre');
  const acordes = $('#ed-ns-acordes').value.trim(), nota = $('#ed-ns-nota').value.trim();
  const bloque = [`{seccion: ${nombre}}`]; if (acordes) bloque.push(lineaDeAcordes(acordes)); if (nota) bloque.push(`{nota: ${nota}}`); bloque.push('');
  const L = lineasCuerpo(); let pos = posNuevaSec;
  if (pos >= L.length) { while (L.length && !L[L.length - 1].trim()) L.pop(); L.push('', ...bloque); }
  else { if (pos > 0 && L[pos - 1].trim()) bloque.unshift(''); L.splice(pos, 0, ...bloque); }
  $('#ed-nueva-sec').hidden = true; $('#sub-secciones').append($('#ed-nueva-sec')); posNuevaSec = null;
  await guardarEditor(L.join('\n')); aviso('sección agregada'); renderEditor();
};
// editar la nota o la letra de una sección (desde su cabecera en Secciones)
let edSec = null; // { i: línea de la marca, modo: 'nota' | 'letra' }
function rangoSeccion(L, i) { // líneas de la sección tras su marca, sin las vacías del final
  let j = i + 1; while (j < L.length && !RE_SEC.test(L[j]) && !RE_PARTE.test(L[j]) && !META_CAB.test(L[j])) j++;
  let fin = j; while (fin > i + 1 && !L[fin - 1].trim()) fin--;
  return { ini: i + 1, fin, sig: j };
}
function abrirEditarSeccion(i, modo, cabecera) {
  const L = lineasCuerpo(); const r = rangoSeccion(L, i); const nombre = (L[i].match(RE_SEC) || [])[1] || 'sección sin nombre';
  edSec = { i, modo };
  const f = $('#ed-editar-sec'); f.hidden = false; cabecera.insertAdjacentElement('afterend', f);
  $('#ed-es-titulo').textContent = (modo === 'nota' ? 'Nota de ' : 'Letra de ') + nombre;
  $('#ed-es-campo-nota').hidden = modo !== 'nota'; $('#ed-es-campo-letra').hidden = modo !== 'letra';
  if (modo === 'nota') {
    const k = L.slice(r.ini, r.fin).findIndex(l => RE_NOTA.test(l));
    $('#ed-es-nota').value = k >= 0 ? (L[r.ini + k].match(RE_NOTA) || [])[2] || '' : '';
    $('#ed-es-quitar').hidden = k < 0; $('#ed-es-nota').focus();
  } else {
    $('#ed-es-letra').value = L.slice(r.ini, r.fin).join('\n'); $('#ed-es-quitar').hidden = true; $('#ed-es-letra').focus();
  }
}
function cerrarEditarSeccion() { $('#ed-editar-sec').hidden = true; $('#sub-secciones').append($('#ed-editar-sec')); edSec = null; }
$('#ed-es-cancelar').onclick = cerrarEditarSeccion;
$('#ed-es-quitar').onclick = async () => {
  if (!edSec || edSec.modo !== 'nota') return;
  const L = lineasCuerpo(); const r = rangoSeccion(L, edSec.i);
  const k = L.slice(r.ini, r.fin).findIndex(l => RE_NOTA.test(l)); if (k < 0) return cerrarEditarSeccion();
  L.splice(r.ini + k, 1); cerrarEditarSeccion(); await guardarEditor(L.join('\n')); aviso('nota quitada'); renderEditor();
};
$('#ed-es-guardar').onclick = async () => {
  if (!edSec) return;
  const L = lineasCuerpo(); const r = rangoSeccion(L, edSec.i);
  if (edSec.modo === 'nota') {
    const nota = $('#ed-es-nota').value.trim();
    const k = L.slice(r.ini, r.fin).findIndex(l => RE_NOTA.test(l));
    if (k >= 0) { if (nota) L[r.ini + k] = `{nota: ${nota}}`; else L.splice(r.ini + k, 1); }
    else if (nota) L.splice(r.ini, 0, `{nota: ${nota}}`);
  } else {
    const nuevas = $('#ed-es-letra').value.replace(/\r/g, '').split('\n'); while (nuevas.length && !nuevas[nuevas.length - 1].trim()) nuevas.pop();
    L.splice(r.ini, r.fin - r.ini, ...nuevas);
  }
  cerrarEditarSeccion(); await guardarEditor(L.join('\n')); aviso('guardado'); renderEditor();
};
// sub-pestañas de la edición
$$('.subtabs button').forEach(b => b.onclick = () => { $$('.subtabs button').forEach(x => x.classList.toggle('activa', x === b)); $$('.sub').forEach(x => x.classList.toggle('activa', x.id === 'sub-' + b.dataset.sub)); if (b.dataset.sub === 'acordes') renderEditorAcordes(); });
function renderArreglo() {
  const ol = $('#ed-arreglo-lista'); ol.innerHTML = '';
  editor.arreglo.forEach((n, i) => {
    const li = document.createElement('li'); li.innerHTML = `<div class="info"><div class="t">${esc(n)}</div></div><div class="acc"></div>`;
    const acc = li.querySelector('.acc');
    if (i > 0) acc.append(boton('↑', () => { [editor.arreglo[i - 1], editor.arreglo[i]] = [editor.arreglo[i], editor.arreglo[i - 1]]; renderArreglo(); }));
    acc.append(boton('✕', () => { editor.arreglo.splice(i, 1); renderArreglo(); }));
    ol.append(li);
  });
  if (!editor.arreglo.length) ol.innerHTML = '<li class="vacio">Sin arreglo: se muestra en orden natural.</li>';
  else {
    const disponibles = [...document.querySelectorAll('#ed-chips button')].map(b => b.textContent);
    const fuera = disponibles.filter(n => !editor.arreglo.some(x => x.toLowerCase() === n.toLowerCase()));
    if (fuera.length) { const li = document.createElement('li'); li.className = 'vacio'; li.textContent = '⚠ No están en el arreglo (no se verán en el vivo): ' + fuera.join(', '); ol.append(li); }
  }
}
function conArreglo(cho, arreglo) {
  const linea = arreglo.length ? `{arreglo: ${arreglo.join(', ')}}` : '';
  if (RE_ARREGLO.test(cho)) return cho.replace(/^\{\s*arreglo\s*:.*\}\s*$\n?/im, linea ? linea + '\n' : '');
  if (!linea) return cho;
  return /^\{\s*titulo\s*:.*\}\s*$/im.test(cho) ? cho.replace(/^(\{\s*titulo\s*:.*\}\s*\n)/im, `$1${linea}\n`) : linea + '\n' + cho;
}
$('#ed-arreglo-guardar').onclick = async () => { await guardarEditor(conArreglo(editor.cho, editor.arreglo)); aviso('arreglo guardado'); renderEditor(); };
$('#ed-arreglo-quitar').onclick = async () => { editor.arreglo = []; await guardarEditor(conArreglo(editor.cho, [])); renderEditor(); };
$('#ed-parte-cancion').onchange = async ev => {
  const sel = $('#ed-parte-seccion'); sel.innerHTML = '<option value="">Sección…</option>';
  if (!ev.target.value) return;
  try { const c = parsear(await obtenerCho(ev.target.value)); for (const s of c.secciones) if (s.nombre) { const o = document.createElement('option'); o.value = s.nombre; o.textContent = s.nombre; sel.append(o); } if (sel.options.length === 1) sel.innerHTML = '<option value="">(esa canción no tiene secciones marcadas)</option>'; } catch { aviso('no pude leer esa canción'); }
};
$('#ed-parte-agregar').onclick = async () => {
  const pid = $('#ed-parte-cancion').value, sec = $('#ed-parte-seccion').value; if (!pid || !sec) return aviso('elige canción y sección');
  await guardarEditor(editor.cho.replace(/\s*$/, '') + `\n\n{parte: ${pid} | ${sec}}\n`); renderEditor();
};
$('#ed-bloque-agregar').onclick = async () => {
  const t = $('#ed-bloque-titulo').value.trim(), tx = $('#ed-bloque-texto').value.trim(); if (!t) return aviso('ponle título al bloque');
  await guardarEditor(editor.cho.replace(/\s*$/, '') + `\n\n{seccion: ${t}}\n${tx}\n`); $('#ed-bloque-titulo').value = ''; $('#ed-bloque-texto').value = ''; renderEditor();
};
function trozos(cho) { // cabecera + trozos que empiezan en {seccion} o {parte}
  const lineas = cho.replace(/\r/g, '').split('\n'); const cab = []; const ts = []; let actual = null;
  for (const l of lineas) {
    if (RE_SEC.test(l) || RE_PARTE.test(l)) { actual = [l]; ts.push(actual); }
    else if (actual) actual.push(l); else cab.push(l);
  }
  return { cab, ts };
}
function renderPartes(c) {
  const ol = $('#ed-partes-lista'); if (!ol) return; ol.innerHTML = '';
  const { cab, ts } = trozos(editor.cho);
  ts.forEach((t, i) => {
    const m = t[0].match(RE_PARTE); const ms = t[0].match(RE_SEC);
    const etiqueta = m ? (([pid, sec]) => `↪ ${sec} · ${titulo(pid)}`)(m[1].split('|').map(x => x.trim())) : `${ms[1] || 'sección sin nombre'} · ${t.slice(1).filter(x => x.trim()).length} líneas`;
    const li = document.createElement('li'); li.innerHTML = `<div class="info"><div class="t">${esc(etiqueta)}</div></div><div class="acc"></div>`;
    const acc = li.querySelector('.acc');
    if (i > 0) acc.append(boton('↑', async () => { [ts[i - 1], ts[i]] = [ts[i], ts[i - 1]]; await guardarEditor([...cab, ...ts.flat()].join('\n')); renderEditor(); }));
    acc.append(boton('✕', async () => { if (!confirm('¿Quitar este trozo completo?')) return; ts.splice(i, 1); await guardarEditor([...cab, ...ts.flat()].join('\n')); renderEditor(); }));
    ol.append(li);
  });
}
$('#ed-volver').onclick = () => { irA('biblioteca'); };
async function nuevaCancionEspecial(tipo) {
  const t = prompt(tipo === 'mix' ? 'Título del mix:' : 'Título del bloque del show:'); if (!t || !t.trim()) return;
  try {
    const { id } = await api('/api/canciones', { method: 'POST', body: JSON.stringify({ cho: `{titulo: ${t.trim()}}\n{tipo: ${tipo}}\n{estado: corregida}\n` }) });
    indice = await api('/api/canciones'); ultimaFirmaBib = ''; renderBiblioteca();
    await abrirEditor(id);
  } catch (e) { aviso('no se pudo crear: ' + e.message); }
}
$('#btn-nuevo-mix').onclick = () => nuevaCancionEspecial('mix');
$('#btn-nuevo-bloque').onclick = () => nuevaCancionEspecial('bloque');

// ---------- género: desplegable con básicos + usados + "agregar otro" ----------
const GENEROS_BASE = ['Rock', 'Balada', 'Tropical', 'Salsa', 'Bolero', 'Pachanga'];
async function llenarGeneros(sel, actual = '') {
  let usados = []; try { usados = await api('/api/generos'); } catch {}
  const todos = [...new Set([...GENEROS_BASE, ...usados, ...(actual ? [actual] : [])])].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">Género…</option>';
  for (const g of todos) { const o = document.createElement('option'); o.value = g; o.textContent = g; sel.append(o); }
  const o = document.createElement('option'); o.value = NUEVA; o.textContent = '＋ Agregar otro…'; sel.append(o);
  sel.value = actual || '';
}
function conGenero(cho, genero) {
  const linea = genero ? `{genero: ${genero}}` : '';
  if (/^\{\s*g[eé]nero\s*:.*\}\s*$/mi.test(cho)) return cho.replace(/^\{\s*g[eé]nero\s*:.*\}\s*$\n?/mi, linea ? linea + '\n' : '');
  if (!linea) return cho;
  return cho.replace(/^(\{\s*titulo\s*:.*\}\s*\n)/im, `$1${linea}\n`);
}
$('#imp-genero').onchange = ev => { $('#imp-genero-nuevo').hidden = ev.target.value !== NUEVA; if (ev.target.value === NUEVA) $('#imp-genero-nuevo').focus(); };
$('#ed-genero').onchange = async ev => {
  const nueva = ev.target.value === NUEVA;
  $('#ed-genero-nuevo').hidden = !nueva; $('#ed-genero-ok').hidden = !nueva;
  if (nueva) { $('#ed-genero-nuevo').focus(); return; }
  await guardarEditor(conGenero(editor.cho, ev.target.value)); aviso('género guardado');
  indice = await api('/api/canciones'); ultimaFirmaBib = ''; renderBiblioteca();
};
$('#ed-genero-ok').onclick = async () => {
  const g = $('#ed-genero-nuevo').value.trim(); if (!g) return aviso('escribe el género');
  await guardarEditor(conGenero(editor.cho, g)); $('#ed-genero-nuevo').hidden = true; $('#ed-genero-ok').hidden = true; $('#ed-genero-nuevo').value = '';
  await llenarGeneros($('#ed-genero'), g); aviso('género guardado');
  indice = await api('/api/canciones'); ultimaFirmaBib = ''; renderBiblioteca();
};

// ---------- importar por pegado (director) ----------
let impCho = '';
function previaImportar() {
  const texto = $('#imp-texto').value; if (!texto.trim()) { aviso('pega el texto primero'); return false; }
  const info = {};
  impCho = textoAChordPro(texto, { titulo: $('#imp-titulo').value.trim(), artista: $('#imp-artista').value.trim(), cejilla: $('#imp-cejilla').value.trim(), info });
  const c = parsear(impCho);
  if (!$('#imp-cejilla').value.trim() && info.cejillaDetectada) $('#imp-cejilla').value = info.cejillaDetectada;
  // completar campos detectados y aplicar los que escribió el director
  if (!$('#imp-titulo').value.trim() && c.meta.titulo) $('#imp-titulo').value = c.meta.titulo;
  if (!$('#imp-artista').value.trim() && c.meta.artista) $('#imp-artista').value = c.meta.artista;
  if (!$('#imp-tono').value.trim() && c.meta.tono) $('#imp-tono').value = c.meta.tono;
  const tono = $('#imp-tono').value.trim();
  if (tono) impCho = /^\{\s*tono\s*:.*\}\s*$/mi.test(impCho) ? impCho.replace(/^\{\s*tono\s*:.*\}\s*$/mi, `{tono: ${tono}}`) : impCho.replace(/^(\{\s*titulo\s*:.*\}\s*\n)/im, `$1{tono: ${tono}}\n`);
  const c2 = parsear(impCho);
  const nAc = (impCho.match(/\[[^\]]+\]/g) || []).length, nSec = c2.secciones.filter(s => s.nombre).length;
  $('#imp-info').textContent = `${nAc} acordes · ${nSec} secciones detectadas · ${c2.secciones.reduce((a, s) => a + s.lineas.filter(l => l.tipo === 'letra').length, 0)} líneas de letra${info.cejillaAplicada ? ` · cejilla de la hoja ${info.cejillaAplicada}: acordes subidos ${info.cejillaAplicada} semitono${info.cejillaAplicada > 1 ? 's' : ''}, tono real ${c2.meta.tono || '?'}` : ''}`;
  $('#imp-cancion').innerHTML = renderCancion(c2, { vista: 'acordes' });
  $('#imp-guardar').disabled = false;
  return true;
}
$('#imp-previa').onclick = previaImportar;
$('#imp-texto').oninput = () => { $('#imp-guardar').disabled = true; };
$('#imp-guardar').onclick = async () => {
  if (!previaImportar()) return;
  if (!$('#imp-titulo').value.trim()) return aviso('ponle título');
  impCho = impCho.replace(/^\{\s*titulo\s*:.*\}\s*$/mi, `{titulo: ${$('#imp-titulo').value.trim()}}`);
  if ($('#imp-artista').value.trim()) impCho = /^\{\s*artista\s*:.*\}\s*$/mi.test(impCho) ? impCho.replace(/^\{\s*artista\s*:.*\}\s*$/mi, `{artista: ${$('#imp-artista').value.trim()}}`) : impCho.replace(/^(\{\s*titulo\s*:.*\}\s*\n)/im, `$1{artista: ${$('#imp-artista').value.trim()}}\n`);
  const gsel = $('#imp-genero').value; const genero = gsel === NUEVA ? $('#imp-genero-nuevo').value.trim() : gsel;
  if (genero) impCho = conGenero(impCho, genero);
  try {
    const { id } = await api('/api/canciones', { method: 'POST', body: JSON.stringify({ cho: impCho }) });
    indice = await api('/api/canciones'); ultimaFirmaBib = ''; renderBiblioteca();
    $('#imp-texto').value = ''; $('#imp-titulo').value = ''; $('#imp-artista').value = ''; $('#imp-tono').value = ''; $('#imp-cejilla').value = ''; $('#imp-genero').value = ''; $('#imp-genero-nuevo').value = ''; $('#imp-genero-nuevo').hidden = true; $('#imp-cancion').innerHTML = ''; $('#imp-info').textContent = ''; $('#imp-guardar').disabled = true;
    aviso('canción guardada');
    await abrirEditor(id);
    document.querySelector('.subtabs button[data-sub="acordes"]').click();
  } catch (e) { aviso('no se guardó: ' + e.message); }
};
$('#imp-cancelar').onclick = () => { irA('biblioteca'); };
$('#btn-importar').onclick = async () => { irA('importar'); await llenarGeneros($('#imp-genero')); $('#imp-genero-nuevo').hidden = true; $('#imp-texto').focus(); };

// ---------- pantalla encendida, service worker, arranque ----------
let wakeLock = null;
async function mantenerPantalla() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); return; } } catch {}
  // respaldo (http, o navegador sin Wake Lock): un video mudo en bucle mantiene la pantalla encendida
  const v = $('#despierto'); if (v && v.paused) v.play().catch(() => {});
}
document.addEventListener('pointerdown', mantenerPantalla);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  mantenerPantalla();
  // al volver del segundo plano, reubicarse en el vivo (las animaciones no corren con la pantalla apagada)
  if (modo !== 'libre' && estado.vivo.cancion) mostrar(estado.vivo.cancion, estado.vivo.seccion, { frac: estado.vivo.frac || 0 });
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// bloquear el zoom de la interfaz (pellizco y doble toque) en Safari; la letra se agranda con A− / A+
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
let ultimoToqueFin = 0;
document.addEventListener('touchend', e => { const ahora = Date.now(); if (ahora - ultimoToqueFin < 300 && !e.target.closest('button, input, select, textarea, a')) e.preventDefault(); ultimoToqueFin = ahora; }, { passive: false });

llenarPerfil(); actualizarConexion(); actualizarControles();
document.documentElement.style.setProperty('--tam', prefs.tam + 'rem');
cargarIndice().then(conectar);
if (!perfil.nombre) irA('ajustes');
