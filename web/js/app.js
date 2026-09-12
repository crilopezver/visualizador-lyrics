// Visualizador Lyrics — lógica de la app (sin framework).
import { parsear, renderCancion, tonoTranspuesto, expandir, nombresArreglo, tituloSeccion, textoAChordPro, eliminarSeccion, palabrasCrudas, eliminarTramo, lineaAHoja, hojaACuerpo, esFilaAcordes, tokensDudosos } from './chordpro.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const cargar = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return d; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const perfil = cargar('perfil', { nombre: '', instrumento: 'voz', rol: 'musico', pin: '', vista: 'acordes', cejilla: false, botones: true, paso: 'seccion', lineas: 4, ajustar: true }); // paso: página | sección | líneas (botones y pedal). Por defecto sección (Cristhian, 11-sep, fila 184)
// una sola vez: los perfiles guardados antes del 11-sep traían "página" sin haberlo elegido; pasan a sección. Desde ahora, cambiarlo en "Yo" es decisión de cada uno (pasoElegido).
if (!perfil.pasoElegido && !perfil.pasoMigrado) { perfil.paso = 'seccion'; perfil.pasoMigrado = true; guardar('perfil', perfil); }
const prefs = cargar('prefs', { tam: 1.25, transp: {}, cejilla: {}, orden: 'importada' }); // orden: importada | titulo | artista (biblioteca)
// Abierto desde el panel de la Mac (?director=1): esta Mac es del director y el servidor no le pide PIN por localhost.
if (new URLSearchParams(location.search).get('director') === '1') {
  perfil.rol = 'director'; if (!perfil.nombre) perfil.nombre = 'Director (Mac)'; guardar('perfil', perfil);
  history.replaceState(null, '', location.pathname);
}
let indice = [];                 // [{id,titulo,artista,tono,...}]
let estado = { vivo: { cancion: null, seccion: 0, frac: 0 }, siguiente: [], historial: [], controlCantante: false, tonos: {}, conectados: [] };
let rol = 'musico';              // rol confirmado por el servidor
let editorPendiente = null;      // canción cuyo editor estaba abierto al recargar: se reabre tras la bienvenida si el rol es director
async function restaurarEditor() {
  const id = editorPendiente; if (!id) return; editorPendiente = null;
  if (rol !== 'director') return;
  const sub = prefs.editorSub || 'acordes'; $$('.subtabs button').forEach(x => x.classList.toggle('activa', x.dataset.sub === sub)); $$('.sub').forEach(x => x.classList.toggle('activa', x.id === 'sub-' + sub));
  try { if (!indice.length) await cargarIndice(); await abrirEditor(id); } catch { irA('biblioteca'); }
}
let ws = null, conectado = false, reintento = 1000;
let estuvoSinRed = false; // hubo conexión y se perdió: al reconectar se vuelve a seguir al vivo aunque se haya navegado por cuenta propia
let ultimoMensaje = 0; // vigilancia: si en 45 s no llega nada del servidor (latido cada 20 s), la conexión se da por muerta y se reconecta (Paper 10, hallazgo 3)
setInterval(() => { if (conectado && ultimoMensaje && Date.now() - ultimoMensaje > 45000) { aviso('reconectando…'); try { ws.close(); } catch {} } }, 10000);
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
  // la pestaña activa se recuerda en este dispositivo para volver a ella al recargar (Cristhian, 11-sep, fila 167)
  if (vista !== 'editor' && vista !== 'importar') { prefs.vista = vista; prefs.editorId = null; guardar('prefs', prefs); }
  $$('#tabs button').forEach(b => b.classList.toggle('activa', b.dataset.vista === vista));
  $$('.vista').forEach(v => v.classList.toggle('activa', v.id === 'vista-' + vista));
  if (vista === 'setlists') cargarSetlists();
  if (vista === 'ajustes') { cargarInfo(); cargarIntegrantes(); }
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
    ultimoMensaje = Date.now();
    if (m.tipo === 'latido') return;
    if (m.tipo === 'bienvenida') { conectado = true; rol = m.rol; if (estuvoSinRed) { estuvoSinRed = false; modo = puedeMover() ? 'lider' : 'siguiendo'; } actualizarConexion(); aplicarEstado(m.estado); restaurarEditor(); } // tras una caída, vuelve a seguir al vivo
    else if (m.tipo === 'estado') aplicarEstado(m.estado);
    else if (m.tipo === 'rechazado') aviso('sin permiso');
    else if (m.tipo === 'cancion-cambiada') cancionCambiada(m.id);
  };
  ws.onclose = () => { if (conectado && ultimoMensaje) estuvoSinRed = true; conectado = false; actualizarConexion(); actualizarControles(); programarReintento(); };
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
  if (previa.id && $('#vista-previa').classList.contains('activa')) pintarPrevia();
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
  const sinRed = !conectado && ultimoMensaje > 0 && !!estado.vivo.cancion; // hubo conexión y se perdió: cada uno sigue por su cuenta con la cola que tenía (Paper 10, hallazgo 7)
  const mostrarBarra = (lider && (rol === 'director' || perfil.botones !== false)) || sinRed; // el director siempre; el cantante puede ocultarla; sin red, todos
  $('#controles-lider').hidden = !mostrarBarra;
  document.body.classList.toggle('con-barra', puedeMover() && conectado && (rol === 'director' || perfil.botones !== false)); // la barra del líder existe aunque esté en libre: el botón flotante se acomoda encima
  $('#btn-volver').hidden = modo !== 'libre';
  const p = $('#vivo-modo');
  p.className = 'pill ' + (modo === 'libre' ? 'modo-libre' : lider ? 'modo-lider' : 'modo-siguiendo');
  p.textContent = sinRed ? 'sin red · sigues por tu cuenta: ▶▶ pasa la cola en este celular' : modo === 'libre' ? 'navegación libre' : lider ? 'tú controlas el vivo' : conectado ? 'siguiendo al vivo' : 'sin conexión · lo guardado sigue disponible';
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
  } catch (e) {
    $('#cancion').innerHTML = `<p class="vacio">No se pudo abrir la canción (${e.message}). Reintentando…</p>`;
    // reintento solo (WiFi que parpadea): hasta 10 veces cada 2 s mientras siga siendo la canción pedida
    mostrando.reintentos = (mostrando.reintentoId === id ? (mostrando.reintentos || 0) : 0) + 1; mostrando.reintentoId = id;
    if (mostrando.reintentos <= 10) setTimeout(() => { if (mostrando.reintentoId === id && mostrando.id !== id) mostrar(id, seccion, { desplazar, frac, nueva }); }, 2000);
  }
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
// ---------- previa: ver una canción sin tocar el vivo (reemplaza al antiguo "Ver" en navegación libre) ----------
const previa = { id: null, cancion: null, expandidas: null };
async function verLibre(id) { // el nombre se conserva por los botones "Ver" existentes
  try {
    const cho = await obtenerCho(id); previa.id = id; previa.cancion = parsear(cho); previa.expandidas = await expandirConPartes(previa.cancion);
  } catch (e) { aviso('no se pudo abrir: ' + e.message); return; }
  prefs.previaId = id; guardar('prefs', prefs); irA('previa'); pintarPrevia(); window.scrollTo({ top: 0 });
}
function pintarPrevia() {
  const c = previa.cancion; const art = $('#cancion-previa');
  if (!c) { $('#previa-titulo').textContent = 'Nada en vista previa'; $('#previa-sub').textContent = 'Toca “Ver” en Canciones, en la cola o en un setlist.'; $('#previa-acciones').hidden = true; art.innerHTML = ''; return; }
  const m = c.meta, id = previa.id, transp = transpBanda(id), cejilla = cejillaPersonal(id);
  $('#previa-titulo').textContent = m.titulo || titulo(id);
  const tonoBanda = m.tono ? tonoTranspuesto(m.tono, transp) : '';
  $('#previa-sub').textContent = [m.artista, tonoBanda ? 'Tono ' + tonoBanda + (transp ? ` (orig. ${m.tono})` : '') : 'tono sin fijar', cejilla ? `cejilla ${cejilla}` : '', 'vista previa: no cambia el vivo'].filter(Boolean).join(' · ');
  $('#previa-acciones').hidden = false; $('#previa-editar').hidden = rol !== 'director'; $('#previa-vivo').hidden = !puedeMover(); $('#previa-cola').hidden = !puedeCola();
  art.className = 'lienzo vista-' + perfil.vista;
  art.innerHTML = renderCancion(c, { transp, cejilla, vista: perfil.vista, seccionActual: -1, secciones: previa.expandidas });
  document.documentElement.style.setProperty('--tam', prefs.tam + 'rem');
}
$('#previa-editar').onclick = () => { if (previa.id) abrirEditor(previa.id); };
$('#previa-vivo').onclick = () => { if (previa.id) { enviar({ tipo: 'vivo', cancion: previa.id }); irA('vivo'); } };
$('#previa-cola').onclick = () => { if (previa.id) { enviar({ tipo: 'siguiente', accion: 'agregar', cancion: previa.id }); aviso('agregada a Siguiente'); } };
$('#previa-tam-menos').onclick = () => { prefs.tam = Math.max(0.8, +(prefs.tam - 0.1).toFixed(2)); guardar('prefs', prefs); pintarPrevia(); };
$('#previa-tam-mas').onclick = () => { prefs.tam = Math.min(3, +(prefs.tam + 0.1).toFixed(2)); guardar('prefs', prefs); pintarPrevia(); };
$('#btn-volver').onclick = () => { modo = puedeMover() ? 'lider' : 'siguiendo'; actualizarControles(); irA('vivo'); if (estado.vivo.cancion) mostrar(estado.vivo.cancion, estado.vivo.seccion, { frac: estado.vivo.frac || 0 }); else vaciarVivo(); };
$('#lider-prev').onclick = () => moverSeccion(-1);
$('#lider-next').onclick = () => moverSeccion(1);
// sin red, ▶▶ y ◀◀ mueven la cola de este celular (copia local); al volver la red, el estado del servidor manda de nuevo
function pasarLocal() {
  if (!estado.siguiente.length) return aviso('cola vacía');
  if (estado.vivo.cancion) estado.historial = [...(estado.historial || []), estado.vivo.cancion];
  const id = estado.siguiente.shift(); estado.vivo = { ...estado.vivo, cancion: id, seccion: 0, frac: 0, carga: (estado.vivo.carga || 0) + 1 };
  $('#n-siguiente').textContent = estado.siguiente.length || ''; renderSiguiente(); mostrar(id, 0, { nueva: true });
}
function anteriorLocal() {
  if (!(estado.historial || []).length) return aviso('no hay canción anterior');
  const previa = estado.historial.pop(); if (estado.vivo.cancion) estado.siguiente.unshift(estado.vivo.cancion);
  estado.vivo = { ...estado.vivo, cancion: previa, seccion: 0, frac: 0, carga: (estado.vivo.carga || 0) + 1 };
  $('#n-siguiente').textContent = estado.siguiente.length || ''; renderSiguiente(); mostrar(previa, 0, { nueva: true });
}
$('#lider-pasar').onclick = () => { if (!conectado) return pasarLocal(); if (!estado.siguiente.length) return aviso('cola vacía'); enviar({ tipo: 'siguiente', accion: 'pasar' }); };
$('#lider-anterior').onclick = () => { if (!conectado) return anteriorLocal(); if (!(estado.historial || []).length) return aviso('no hay canción anterior'); enviar({ tipo: 'siguiente', accion: 'anterior' }); };

// teclado (pedal = teclado Bluetooth) y zonas de toque estilo lector
document.addEventListener('keydown', ev => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (!$('#vista-vivo').classList.contains('activa')) return;
  // Pedal M-Wave (Paper 09): ↓ canción siguiente y ↑ canción anterior (como ▶▶ y ◀◀ de la barra; solo quien controla el vivo),
  // ←→ por sección siempre (Cristhian, 09-sep, filas 125 y 128); las demás teclas siguen el modo configurado en "Yo"
  if (ev.key === 'ArrowDown') { ev.preventDefault(); if ((puedeMover() && modo === 'lider') || !conectado) $('#lider-pasar').onclick(); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); if ((puedeMover() && modo === 'lider') || !conectado) $('#lider-anterior').onclick(); }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); moverPorSeccion(1); }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); moverPorSeccion(-1); }
  else if (['PageDown', ' ', 'Enter'].includes(ev.key)) { ev.preventDefault(); moverSeccion(1); }
  else if (['PageUp', 'Backspace'].includes(ev.key)) { ev.preventDefault(); moverSeccion(-1); }
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
$('#cancion').addEventListener('click', e => { if (e.target.closest('.btn-pasar')) { e.stopPropagation(); $('#lider-pasar').onclick(); } });
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
  if (previa.id === id || (previa.cancion && previa.cancion.secciones.some(s => s.parte && s.parte.id === id))) { try { previa.cancion = parsear(await obtenerCho(previa.id)); previa.expandidas = await expandirConPartes(previa.cancion); if ($('#vista-previa').classList.contains('activa')) pintarPrevia(); } catch {} }
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
const fechaImportacion = iso => { const [a, m, d] = String(iso).split('-'); return a && m && d ? `${d}-${['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][Number(m) - 1] || m}-${a.slice(2)}` : iso; };
$('#bib-orden').onchange = ev => { prefs.orden = ev.target.value; guardar('prefs', prefs); renderBiblioteca(); };
function renderBiblioteca() {
  const q = norm($('#buscar').value.trim());
  const lista = indice.filter(c => !q || norm(c.titulo).includes(q) || norm(c.artista).includes(q) || norm(c.genero).includes(q));
  // orden: por fecha de importación (última primero; sin fecha al final), por título o por artista (Cristhian, 09-sep)
  const orden = prefs.orden || 'importada'; const sel = $('#bib-orden'); if (sel && sel.value !== orden) sel.value = orden;
  const cmpTexto = (a, b) => norm(a).localeCompare(norm(b), 'es');
  lista.sort((a, b) => orden === 'importada' ? ((b.importada || '').localeCompare(a.importada || '') || cmpTexto(a.titulo, b.titulo)) : orden === 'artista' ? ((!a.artista) - (!b.artista) || cmpTexto(a.artista, b.artista) || cmpTexto(a.titulo, b.titulo)) : cmpTexto(a.titulo, b.titulo));
  $('#bib-info').textContent = `${lista.length} de ${indice.length} canciones`;
  $('#bib-director').hidden = rol !== 'director';
  const ul = $('#lista-canciones'); ul.innerHTML = '';
  for (const c of lista.slice(0, 300)) {
    const li = document.createElement('li'); if (c.id === estado.vivo.cancion) li.classList.add('en-vivo');
    li.innerHTML = `<div class="info"><div class="t">${c.tipo === 'mix' ? '🎛 ' : c.tipo === 'bloque' ? '🗒 ' : ''}${esc(c.titulo)}</div><div class="s">${esc([c.tipo === 'mix' ? 'mix' : c.tipo === 'bloque' ? 'bloque del show' : '', c.artista, c.genero, c.tono ? 'Tono ' + c.tono : '', c.estado === 'importada' ? '⚠ sin corregir' : '', c.importada ? 'importada ' + fechaImportacion(c.importada) : ''].filter(Boolean).join(' · '))}</div></div><div class="acc"></div>`;
    const acc = li.querySelector('.acc');
    acc.append(boton('Ver', () => verLibre(c.id)));
    if (rol === 'director') acc.append(boton('✎', () => abrirEditor(c.id)));
    if (rol === 'director') acc.append(boton('🗑', async () => { // borrar canción (a la papelera del servidor); pendiente 0m
      if (!confirm(`¿Borrar “${c.titulo}”? Sale de la biblioteca, de la cola y del historial. Queda una copia en datos/papelera.`)) return;
      try { await api(`/api/canciones/${c.id}`, { method: 'DELETE' }); cacheCho.delete(c.id); await cargarIndice(); renderBiblioteca(); aviso('canción borrada'); } catch (e) { aviso('no se borró: ' + e.message); }
    }, 'peligro'));
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
// "¿Quién eres?": lista de integrantes del servidor (datos/integrantes.json). Un toque llena nombre, instrumento y rol y guarda;
// director y cantante además escriben su PIN. Sirve aunque el celular haya perdido el perfil (otra red, otro navegador; fila 126).
const fechaCorta = iso => { if (!iso) return 'nunca'; const d = new Date(iso); const hoy = new Date(); const mismoDia = d.toDateString() === hoy.toDateString(); return (mismoDia ? 'hoy' : d.toLocaleDateString('es', { day: '2-digit', month: 'short' })) + ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); };
async function cargarIntegrantes() {
  const caja = $('#quien-eres'), cont = $('#integrantes'); if (!caja) return;
  let lista = []; try { lista = await api('/api/integrantes'); } catch { lista = []; }
  caja.hidden = !lista.length; cont.innerHTML = '';
  for (const i of lista) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'integrante' + (perfil.nombre && perfil.nombre.toLowerCase() === String(i.nombre).toLowerCase() ? ' yo' : '');
    b.innerHTML = `<b>${esc(i.nombre)}</b><small>${esc([i.instrumento, i.rol !== 'musico' ? i.rol : ''].filter(Boolean).join(' · '))} · última vez: ${esc(fechaCorta(i.ultimaConexion))}</small>`;
    b.onclick = () => {
      const f = $('#form-perfil'); f.elements.nombre.value = i.nombre; f.elements.instrumento.value = i.instrumento || 'otro'; f.elements.rol.value = i.rol || 'musico';
      if (i.rol === 'director' || i.rol === 'cantante') { f.elements.pin.value = ''; f.elements.pin.focus(); aviso('escribe tu PIN y guarda'); return; }
      f.requestSubmit(); aviso(`listo, ${i.nombre}`); irA('vivo');
    };
    cont.append(b);
  }
}
function llenarPerfil() { const f = $('#form-perfil'); for (const k of ['nombre', 'instrumento', 'rol', 'pin', 'vista', 'paso', 'lineas']) if (f.elements[k]) f.elements[k].value = perfil[k] ?? ''; f.elements.cejilla.checked = !!perfil.cejilla; f.elements.botones.checked = perfil.botones !== false; f.elements.ajustar.checked = perfil.ajustar !== false; $('#campo-lineas').hidden = f.elements.paso.value !== 'lineas'; }
$('#form-perfil').elements.paso.onchange = ev => { $('#campo-lineas').hidden = ev.target.value !== 'lineas'; };
$('#form-perfil').onsubmit = ev => {
  ev.preventDefault(); const f = ev.target;
  if (f.elements.paso.value !== perfil.paso) perfil.pasoElegido = true; // lo cambió a mano: ya es su elección
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
const editor = { id: null, cho: '', selIni: null, selFin: null, arreglo: [], renombrar: null, mixAbiertos: new Set(), esMix: false, mixVacio: false };
const NOMBRES_ESTANDAR = ['Intro', 'Estrofa 1', 'Estrofa 2', 'Estrofa 3', 'Pre-coro', 'Coro', 'Puente', 'Solo', 'Interludio', 'Final'];
const META_CAB = /^\{\s*(titulo|título|artista|tono|cejilla|estado|compositor|afinacion|afinación|fuente|arreglo|tipo|genero|género|importada)\s*:/i;
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
  prefs.vista = 'editor'; prefs.editorId = id; guardar('prefs', prefs);
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
  // un mix no se edita por secciones: se edita como lista de canciones con sus partes (Cristhian, 11-sep, fila 158)
  const esMix = (c.meta.tipo || '') === 'mix'; editor.esMix = esMix;
  $('.subtabs').hidden = esMix; $$('.sub').forEach(x => { x.hidden = esMix; }); $('#ed-mix').hidden = !esMix;
  if (esMix) return renderMix(c);
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
const edA = { sel: null, destino: null, historial: [], lineaNueva: null, duplicar: false, menu: null, bloques: [], editando: null }; // editando = { j, modelo: [{t:'linea', s} | {t:'nota', texto}] } // duplicar: el siguiente toque en una palabra pone una copia del acorde seleccionado, sin quitar el original // lineaNueva = {l, enLaMisma} // sel = {l, ini, fin, texto} acorde seleccionado; destino = {l, ini, fin} palabra elegida
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
  // Estructura (Cristhian, 11-sep, filas 164-165): la canción se pinta por bloques siguiendo el arreglo (con sus repeticiones), como en el vivo;
  // cada bloque tiene su menú ⋯ y cada línea sus tijeras ✂. Las líneas conservan su índice de archivo (data-l): los acordes se editan igual.
  const secs = seccionesArchivo(L); const arr = arregloEditor();
  const bloques = [];
  if (arr.length) { const veces = {}; for (const n of arr) { const s = secs.find(x => x.nombre.toLowerCase() === n.toLowerCase()); const k = n.toLowerCase(); veces[k] = (veces[k] || 0) + 1; bloques.push({ nombre: n, sec: s || null, vez: veces[k] }); } }
  else secs.forEach(s => bloques.push({ nombre: s.nombre, sec: s, vez: 1 }));
  if (arr.length && secs[0] && secs[0].ini < 0) bloques.unshift({ nombre: '', sec: secs[0], vez: 1, suelto: true }); // texto antes de la primera sección
  // ✂ en una línea = la sección nueva empieza DESPUÉS de esa línea (Cristhian, 11-sep, fila 175); por eso no va en la última
  const lineaHtml = (l, siguiente) => {
    const raw = L[l]; let m;
    if ((m = raw.match(RE_NOTA))) return `<div class="nota" data-l="${l}" title="Clic derecho o pulsación larga: editar o borrar la nota">${esc(m[2])}</div>`;
    if (!raw.trim()) return '<div class="linea">&nbsp;</div>';
    const r = renderLineaEdicion(raw, l);
    return `<div class="linea ${r.soloAcordes ? 'solo-acordes' : ''}" data-l="${l}">${r.html}${siguiente === null ? '' : `<button class="cortar-linea" data-l="${siguiente}" title="Cortar debajo de esta línea: lo que sigue pasa a una sección nueva">✂</button>`}</div>`;
  };
  bloques.forEach((b, j) => {
    const titulo = b.suelto ? 'sin sección' : (b.nombre || 'sección sin nombre') + (b.vez > 1 ? ` · ${b.vez}ª vez` : '');
    const editando = edA.editando && edA.editando.j === j;
    html += `<div class="bloque ${editando ? 'editando' : ''}" data-j="${j}" title="${editando ? '' : 'Toca para editar esta sección como texto'}"><div class="bloque-cab">${b.suelto ? '' : `<span class="agarre agarre-bloque" title="Arrastra para mover esta sección">≡</span>`}<div class="nombre">${esc(titulo)}</div>${b.suelto ? '' : `<button class="mas-bloque" data-j="${j}" title="Opciones de esta sección">⋯</button>`}</div>`;
    if (editando) html += `<div class="edicion"><div class="ed-pre" contenteditable="true" spellcheck="false" autocapitalize="off" autocorrect="off">${htmlModelo(edA.editando.modelo)}</div><div class="edicion-acciones"><button class="ed-deshacer mini" title="Deshacer (⌘Z)">↶</button><button class="ed-rehacer mini" title="Rehacer (⇧⌘Z)">↷</button><span class="ayuda">Acordes arriba, letra abajo; muévelos con espacios o arrastrándolos.</span><button class="ed-listo primario">✓ Listo</button><button class="ed-cancelar">Cancelar</button></div></div>`;
    else if (!b.sec) html += `<div class="nota">esta sección está en el arreglo pero no existe en la canción</div>`;
    else { const contenido = b.sec.lineas.filter(l => L[l].trim() && !RE_NOTA.test(L[l])); for (const l of b.sec.lineas) { const k = contenido.indexOf(l); html += lineaHtml(l, k >= 0 && k < contenido.length - 1 ? contenido[k + 1] : null); } }
    html += '</div>';
  });
  const usados = new Set(bloques.map(b => b.nombre.toLowerCase())); const sinUsar = secs.filter(s => s.nombre && !usados.has(s.nombre.toLowerCase()));
  if (sinUsar.length) html += `<div class="sin-usar"><div class="ayuda">Secciones definidas que no están en el arreglo (toca una para agregarla al final):</div><div class="chips">${sinUsar.map(s => `<button class="usar-seccion" data-nombre="${esc(s.nombre)}">+ ${esc(s.nombre)}</button>`).join('')}</div></div>`;
  art.innerHTML = html;
  edA.bloques = bloques;
  if (edA.editando) { const pre = art.querySelector('.bloque.editando .ed-pre'); if (pre) { prepararPre(pre); if (edA.editando.caret) ponerCaret(pre, edA.editando.caret.linea, edA.editando.caret.col); else pre.focus(); } }
  // arrastrar bloques desde el asa ≡ (eventos en el documento, con desplazamiento automático cerca de los bordes); al soltar, el orden en pantalla pasa al arreglo
  art.querySelectorAll('.agarre-bloque').forEach(asa => asa.addEventListener('pointerdown', e => {
    if (e.button && e.button !== 0) return; e.preventDefault();
    const li = asa.closest('.bloque'); li.classList.add('arrastrando'); try { asa.setPointerCapture(e.pointerId); } catch {}
    // al arrastrar, todos los bloques se pliegan a su cabecera (Cristhian, 11-sep) y el bloque agarrado se mantiene bajo el dedo
    const antes = li.getBoundingClientRect().top; art.classList.add('colapsado'); window.scrollBy(0, li.getBoundingClientRect().top - antes);
    let ultimoY = e.clientY, auto = null;
    const paso = () => { const h = window.innerHeight; if (ultimoY < 90) window.scrollBy(0, -12); else if (ultimoY > h - 90) window.scrollBy(0, 12); auto = requestAnimationFrame(paso); };
    auto = requestAnimationFrame(paso);
    const mover = ev => {
      if (ev.pointerId !== e.pointerId) return; ev.preventDefault(); ultimoY = ev.clientY;
      const bajo = document.elementFromPoint(ev.clientX, ev.clientY); const otro = bajo && bajo.closest('#edA-cancion > .bloque');
      if (!otro || otro === li) return;
      const r = otro.getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) otro.before(li); else otro.after(li);
    };
    const soltar = ev => {
      if (ev && ev.pointerId !== e.pointerId) return;
      document.removeEventListener('pointermove', mover); document.removeEventListener('pointerup', soltar); document.removeEventListener('pointercancel', soltar); cancelAnimationFrame(auto);
      li.classList.remove('arrastrando'); art.classList.remove('colapsado');
      const orden = [...art.querySelectorAll(':scope > .bloque')].map(el => edA.bloques[Number(el.dataset.j)]).filter(b => b && !b.suelto).map(b => b.nombre);
      if (orden.join('|') !== ordenActual().join('|')) { edA.menu = null; guardarAcordes(conArreglo(editor.cho, orden)); } else renderEditorAcordes();
    };
    document.addEventListener('pointermove', mover, { passive: false }); document.addEventListener('pointerup', soltar); document.addEventListener('pointercancel', soltar);
  }));
  if (edA.menu !== null && edA.menu !== undefined) { const cab = art.querySelector(`.bloque[data-j="${edA.menu}"] .bloque-cab`); if (cab) cab.insertAdjacentElement('afterend', menuBloque(edA.menu)); }
  if (edA.sel) { const a = art.querySelector(`.ac[data-l="${edA.sel.l}"][data-ini="${edA.sel.ini}"]`); if (a) a.classList.add('sel'); }
  if (edA.destino) { const pl = art.querySelector(`.pal[data-l="${edA.destino.l}"][data-ini="${edA.destino.ini}"]`); if (pl) pl.classList.add('destino'); }
  $('#edA-acorde-sel').hidden = !edA.sel || !!edA.destino;
  $('#edA-letras').hidden = !edA.destino && !edA.lineaNueva;
  $('#edA-ayuda').hidden = !edA.ayudaAbierta; // la ayuda vive tras el botón ? (Cristhian, 11-sep: el cuadro estorbaba al editar en el iPhone)
  $('#edA-barra').classList.toggle('editando', !!edA.editando); // mientras se edita un bloque, la barra no va fija arriba
  $('#edA-deshacer').disabled = !edA.historial.length;
  const estado = (editor.cho.match(/^\{\s*estado\s*:\s*(.*?)\s*\}/mi) || [])[1] || '';
  $('#edA-estado').textContent = estado === 'corregida' ? '✓ Corregida (volver a "importada")' : 'Marcar como corregida';
  $('#edA-estado').className = estado === 'corregida' ? '' : 'primario';
  if (edA.sel) { $('#edA-nombre-sel').textContent = edA.sel.texto; $('#edA-sel-ayuda').textContent = edA.duplicar ? 'toca la palabra donde va la copia' : 'toca la palabra destino para moverlo'; $('#edA-duplicar').classList.toggle('primario', edA.duplicar); }
}
// --- estructura: secciones del archivo, arreglo y operaciones (todas se guardan al instante, con deshacer) ---
function seccionesArchivo(L) { // [{nombre, ini: línea del marcador (-1 si es texto suelto), lineas: [índices]}]
  const secs = []; let cur = null;
  L.forEach((raw, l) => {
    if (META_CAB.test(raw) || RE_PARTE.test(raw)) return;
    const m = raw.match(RE_SEC);
    if (m) { cur = { nombre: (m[1] || '').trim(), ini: l, lineas: [] }; secs.push(cur); return; }
    if (!cur) { if (!raw.trim()) return; cur = { nombre: '', ini: -1, lineas: [] }; secs.push(cur); }
    cur.lineas.push(l);
  });
  return secs;
}
function arregloEditor() { return nombresArreglo(parsear(editor.cho)); }
function ordenActual() { return (edA.bloques || []).filter(b => !b.suelto).map(b => b.nombre); } // orden en pantalla = arreglo (o natural si no hay)
function menuBloque(j) {
  const b = edA.bloques[j]; const n = edA.bloques.filter(x => !x.suelto).length; const idx = edA.bloques.filter((x, k) => !x.suelto && k < j).length;
  const div = document.createElement('div'); div.className = 'menu-bloque';
  const guardarOrden = arr => { edA.menu = null; guardarAcordes(conArreglo(editor.cho, arr)); };
  if (idx > 0) div.append(boton('↑ Mover arriba', () => { const a = ordenActual(); [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; guardarOrden(a); }));
  if (idx < n - 1) div.append(boton('↓ Mover abajo', () => { const a = ordenActual(); [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]]; guardarOrden(a); }));
  div.append(boton('⧉ Repetir después', () => { const a = ordenActual(); a.splice(idx + 1, 0, b.nombre); guardarOrden(a); }));
  if (n > 1) div.append(boton('✕ Quitar esta aparición', () => { const a = ordenActual(); a.splice(idx, 1); guardarOrden(a); }, 'peligro'));
  if (b.sec) {
    div.append(boton('✎ Renombrar', () => {
      const nuevo = (prompt('Nuevo nombre de la sección (cambia en todas sus repeticiones):', b.nombre) || '').trim(); if (!nuevo || nuevo === b.nombre) return;
      const L = lineasCuerpo(); if (b.sec.ini >= 0) L[b.sec.ini] = `{seccion: ${nuevo}}`;
      const a = ordenActual().map(x => x.toLowerCase() === b.nombre.toLowerCase() ? nuevo : x); edA.menu = null; guardarAcordes(conArreglo(L.join('\n'), arregloEditor().length ? a : []));
    }));
    const L = lineasCuerpo(); const secs = seccionesArchivo(L); const pos = secs.findIndex(s => s.ini === b.sec.ini);
    if (pos > 0 && b.sec.ini >= 0) div.append(boton('⤴ Unir con la sección anterior', () => {
      if (!confirm(`¿Unir “${b.nombre}” con “${secs[pos - 1].nombre || 'la sección anterior'}”? Sus líneas pasan a esa sección, en todas las repeticiones.`)) return;
      const L2 = lineasCuerpo(); L2.splice(b.sec.ini, 1); const a = ordenActual().filter(x => x.toLowerCase() !== b.nombre.toLowerCase()); edA.menu = null; guardarAcordes(conArreglo(L2.join('\n'), arregloEditor().length ? a : []));
    }));
  }
  div.append(boton('Cerrar', () => { edA.menu = null; renderEditorAcordes(); }));
  return div;
}
function cortarEn(l) { // una sección nueva empieza en la línea l (índice de archivo)
  const L = lineasCuerpo(); const secs = seccionesArchivo(L); const cont = secs.find(s => s.lineas.includes(l));
  const nombre = (prompt('Nombre de la sección nueva que empieza aquí:', '') || '').trim(); if (!nombre) return;
  L.splice(l, 0, `{seccion: ${nombre}}`);
  let arr = arregloEditor();
  if (arr.length && cont && cont.nombre) { const out = []; for (const x of arr) { out.push(x); if (x.toLowerCase() === cont.nombre.toLowerCase()) out.push(nombre); } arr = out; }
  edA.menu = null; guardarAcordes(conArreglo(L.join('\n'), arr));
}
// ---------- edición de un bloque como texto (Cristhian, 11-sep, filas 169-171): monoespaciado, acordes en naranja, sin marcas ----------
const NBSP = / /g;
function htmlModelo(modelo) {
  return modelo.map((it, k) => it.t === 'nota'
    ? `<div class="ln nota" contenteditable="false" data-k="${k}" title="Clic derecho o pulsación larga: editar o borrar">${esc(it.texto)}</div>`
    : `<div class="ln" data-k="${k}">${it.s ? resaltarFila(it.s) : '<br>'}</div>`).join('');
}
function resaltarFila(s) { // una fila de acordes se pinta token a token en naranja; el resto, tal cual
  if (!esFilaAcordes(s)) return esc(s);
  let html = ''; const re = /\S+|\s+/g; let m, i = 0;
  while ((m = re.exec(s))) { html += /\S/.test(m[0]) ? `<span class="tk" data-i="${i++}">${esc(m[0])}</span>` : esc(m[0]); }
  return html;
}
function leerModelo(pre, modeloPrevio) { // el DOM editado → modelo (las notas se conservan por su índice previo)
  const out = [];
  for (const n of pre.childNodes) {
    if (n.nodeType === 3) { for (const s of n.textContent.replace(NBSP, ' ').split('\n')) out.push({ t: 'linea', s }); continue; }
    if (n.classList && n.classList.contains('nota')) { const prev = modeloPrevio[Number(n.dataset.k)]; out.push(prev && prev.t === 'nota' ? prev : { t: 'nota', texto: n.textContent }); continue; }
    out.push({ t: 'linea', s: n.textContent.replace(NBSP, ' ').replace(/\n$/, '') });
  }
  // una nota borrada con el teclado no se pierde: vuelve donde estaba
  modeloPrevio.forEach((it, k) => { if (it.t === 'nota' && !out.includes(it)) out.splice(Math.min(k, out.length), 0, it); });
  return out.length ? out : [{ t: 'linea', s: '' }];
}
function posCaret(pre) {
  const sel = window.getSelection(); if (!sel.rangeCount) return null; const r = sel.getRangeAt(0);
  const ln = r.startContainer.nodeType === 1 && r.startContainer.classList && r.startContainer.classList.contains('ln') ? r.startContainer : (r.startContainer.parentElement && r.startContainer.parentElement.closest('.ln'));
  if (!ln || !pre.contains(ln)) return null;
  const antes = document.createRange(); antes.selectNodeContents(ln); antes.setEnd(r.startContainer, r.startOffset);
  return { linea: [...pre.children].indexOf(ln), col: antes.toString().replace(NBSP, ' ').length };
}
function ponerCaret(pre, linea, col) {
  const ln = pre.children[Math.max(0, Math.min(linea, pre.children.length - 1))]; if (!ln) return pre.focus();
  const walker = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT); let resto = col, nodo = null, off = 0;
  while ((nodo = walker.nextNode())) { if (resto <= nodo.textContent.length) { off = resto; break; } resto -= nodo.textContent.length; }
  const r = document.createRange();
  if (nodo) r.setStart(nodo, off); else r.selectNodeContents(ln), r.collapse(false);
  r.collapse(true); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); pre.focus();
}
function prepararPre(pre) {
  const ed = edA.editando; ed.pasado = ed.pasado || []; ed.futuro = ed.futuro || [];
  const foto = () => ({ modelo: ed.modelo.map(it => ({ ...it })), caret: posCaret(pre) });
  const restaurar = f => { ed.modelo = f.modelo.map(it => ({ ...it })); pre.innerHTML = htmlModelo(ed.modelo); if (f.caret) ponerCaret(pre, f.caret.linea, f.caret.col); else pre.focus(); };
  pre.addEventListener('beforeinput', () => { ed.pasado.push(foto()); if (ed.pasado.length > 200) ed.pasado.shift(); ed.futuro = []; });
  pre.addEventListener('input', () => {
    const caret = posCaret(pre); ed.modelo = leerModelo(pre, ed.modelo);
    pre.innerHTML = htmlModelo(ed.modelo); if (caret) ponerCaret(pre, caret.linea, caret.col);
  });
  // deshacer / rehacer propios (el recoloreado en cada tecla anula el del navegador): ⌘Z / Ctrl+Z, ⇧⌘Z / Ctrl+Y
  ed.deshacer = () => { const f = ed.pasado.pop(); if (f) { ed.futuro.push(foto()); restaurar(f); } };
  ed.rehacer = () => { const f = ed.futuro.pop(); if (f) { ed.pasado.push(foto()); restaurar(f); } };
  pre.addEventListener('keydown', ev => {
    const cmd = ev.metaKey || ev.ctrlKey;
    if (cmd && ev.key.toLowerCase() === 'z' && !ev.shiftKey) { ev.preventDefault(); ed.deshacer(); return; }
    if (cmd && ((ev.key.toLowerCase() === 'z' && ev.shiftKey) || ev.key.toLowerCase() === 'y')) { ev.preventDefault(); ed.rehacer(); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); cancelarBloque(); }
    if (ev.key === 'Tab') { ev.preventDefault(); document.execCommand('insertText', false, '    '); }
  });
  ed.foto = foto; // para que el arrastre de acordes también deje huella
  // arrastrar un acorde de lado dentro de su fila
  pre.addEventListener('pointerdown', e => {
    const ac = e.target.closest('.tk'); if (!ac || (e.button && e.button !== 0)) return;
    e.preventDefault(); const ln = ac.closest('.ln'); const k = Number(ln.dataset.k); const i = Number(ac.dataset.i);
    if (edA.editando.foto) { edA.editando.pasado.push(edA.editando.foto()); edA.editando.futuro = []; }
    const probe = document.createElement('span'); probe.textContent = '0000000000'; probe.style.visibility = 'hidden'; ln.append(probe); const charW = probe.getBoundingClientRect().width / 10; probe.remove();
    const x0 = ln.getBoundingClientRect().left - ln.scrollLeft; let ultimoCol = null;
    const mover = ev => {
      if (ev.pointerId !== e.pointerId) return; ev.preventDefault();
      const col = Math.max(0, Math.round((ev.clientX - x0 + pre.scrollLeft) / charW)); if (col === ultimoCol) return; ultimoCol = col;
      const it = edA.editando.modelo[k]; if (!it || it.t !== 'linea') return;
      it.s = moverToken(it.s, i, col); const lnEl = pre.children[k]; if (lnEl) lnEl.innerHTML = resaltarFila(it.s);
    };
    const soltar = ev => { if (ev && ev.pointerId !== e.pointerId) return; document.removeEventListener('pointermove', mover); document.removeEventListener('pointerup', soltar); document.removeEventListener('pointercancel', soltar); };
    document.addEventListener('pointermove', mover, { passive: false }); document.addEventListener('pointerup', soltar); document.addEventListener('pointercancel', soltar);
  });
}
function moverToken(fila, i, col) { // recoloca el token i de una fila de acordes en la columna col; los demás conservan su columna (y ceden si chocan)
  const toks = []; const re = /\S+/g; let m; while ((m = re.exec(fila))) toks.push({ col: m.index, t: m[0] });
  if (!toks[i]) return fila; toks[i].col = col;
  const orden = toks.map((t, idx) => ({ ...t, idx })).sort((a, b) => a.col - b.col || a.idx - b.idx);
  let out = ''; for (const t of orden) { const c = Math.max(t.col, out.length ? out.length + 1 : 0); out = out.padEnd(c) + t.t; }
  return out;
}
function modeloDeSeccion(sec) {
  const L = lineasCuerpo(); const modelo = [];
  for (const l of sec.lineas) { const raw = L[l]; let m; if ((m = raw.match(RE_NOTA))) modelo.push({ t: 'nota', texto: m[2] }); else for (const s of lineaAHoja(raw)) modelo.push({ t: 'linea', s }); }
  while (modelo.length && modelo[modelo.length - 1].t === 'linea' && !modelo[modelo.length - 1].s.trim()) modelo.pop();
  if (!modelo.length) modelo.push({ t: 'linea', s: '' });
  return modelo;
}
function editarBloque(j) {
  const b = edA.bloques[j]; if (!b || !b.sec) return;
  edA.editando = { j, modelo: modeloDeSeccion(b.sec), caret: null }; edA.menu = null; renderEditorAcordes();
}
function cancelarBloque() { edA.editando = null; renderEditorAcordes(); }
function guardarBloque() {
  const ed = edA.editando; if (!ed) return; const b = edA.bloques[ed.j]; if (!b || !b.sec) { edA.editando = null; return renderEditorAcordes(); }
  const pre = $('#edA-cancion .bloque.editando .ed-pre'); if (pre) ed.modelo = leerModelo(pre, ed.modelo);
  // aviso: filas que parecen de acordes pero tienen algo que no se reconoce (irían como letra)
  for (const it of ed.modelo) if (it.t === 'linea') { const d = tokensDudosos(it.s); if (d.length && !confirm(`En la fila «${it.s.trim()}» no reconozco como acorde: ${d.join(', ')}. Se guardaría como letra. ¿Seguir igual?`)) return; }
  const nuevas = []; let chunk = [];
  const vaciar = () => { if (chunk.length) { nuevas.push(...hojaACuerpo(chunk)); chunk = []; } };
  for (const it of ed.modelo) { if (it.t === 'nota') { vaciar(); nuevas.push(`{nota: ${it.texto}}`); } else chunk.push(it.s); }
  vaciar();
  while (nuevas.length && !nuevas[nuevas.length - 1].trim()) nuevas.pop(); nuevas.push('');
  const L = lineasCuerpo(); const ls = b.sec.lineas;
  if (ls.length) L.splice(ls[0], ls[ls.length - 1] - ls[0] + 1, ...nuevas); else L.splice(b.sec.ini + 1, 0, ...nuevas);
  edA.editando = null; guardarAcordes(L.join('\n'));
}
// ---------- notas: clic derecho o pulsación larga sobre una línea (o sobre una nota para editarla) ----------
function cajaNota({ tras, texto = '', rotulo = '', alGuardar, alBorrar }) {
  $$('.nota-caja').forEach(x => x.remove());
  const caja = document.createElement('div'); caja.className = 'nota-caja'; caja.setAttribute('contenteditable', 'false');
  caja.addEventListener('keydown', ev => ev.stopPropagation()); caja.addEventListener('beforeinput', ev => ev.stopPropagation()); caja.addEventListener('input', ev => ev.stopPropagation());
  caja.innerHTML = `${rotulo ? `<div class="ayuda">${esc(rotulo)}</div>` : ''}<textarea rows="2" placeholder="Nota para la banda en este punto…"></textarea><div class="fila"><button class="primario nc-guardar">Guardar</button>${alBorrar ? '<button class="peligro nc-borrar">Borrar</button>' : ''}<button class="nc-cancelar">Cancelar</button></div>`;
  caja.querySelector('textarea').value = texto;
  caja.querySelector('.nc-guardar').onclick = () => { const t = caja.querySelector('textarea').value.trim(); caja.remove(); if (t) alGuardar(t); };
  caja.querySelector('.nc-cancelar').onclick = () => caja.remove();
  if (alBorrar) caja.querySelector('.nc-borrar').onclick = () => { caja.remove(); alBorrar(); };
  tras.insertAdjacentElement('afterend', caja); caja.querySelector('textarea').focus();
}
function abrirNotaEn(el) {
  const ed = edA.editando;
  if (ed) { // en modo edición: sobre el modelo
    const ln = el.closest('.ln'); if (!ln) return; const k = Number(ln.dataset.k); const it = ed.modelo[k]; if (!it) return;
    const pre = ln.closest('.ed-pre'); ed.modelo = leerModelo(pre, ed.modelo);
    // la caja va FUERA del área editable (debajo del texto), si no lo tecleado entra al bloque (Cristhian, 11-sep)
    const fuera = pre; const rotulo = it.t === 'nota' ? it.texto : `nota tras la fila ${k + 1}: «${(it.s || '').trim().slice(0, 40)}»`;
    if (it.t === 'nota') cajaNota({ tras: fuera, texto: it.texto, rotulo, alGuardar: t => { it.texto = t; renderEditorAcordes(); }, alBorrar: () => { ed.modelo.splice(ed.modelo.indexOf(it), 1); renderEditorAcordes(); } });
    else cajaNota({ tras: fuera, rotulo, alGuardar: t => { ed.modelo.splice(k + 1, 0, { t: 'nota', texto: t }); renderEditorAcordes(); } });
    return;
  }
  const nota = el.closest('.nota[data-l]'); const linea = el.closest('.linea[data-l]');
  if (nota) { const l = Number(nota.dataset.l); const L = lineasCuerpo(); const texto = (L[l].match(RE_NOTA) || [])[2] || '';
    cajaNota({ tras: nota, texto, alGuardar: t => { const L2 = lineasCuerpo(); L2[l] = `{nota: ${t}}`; guardarAcordes(L2.join('\n')); }, alBorrar: () => { const L2 = lineasCuerpo(); L2.splice(l, 1); guardarAcordes(L2.join('\n')); } }); return; }
  if (linea) { const l = Number(linea.dataset.l); cajaNota({ tras: linea, alGuardar: t => { const L2 = lineasCuerpo(); L2.splice(l + 1, 0, `{nota: ${t}}`); guardarAcordes(L2.join('\n')); } }); }
}
let tNotaLarga = null, notaLargaAbierta = false;
$('#edA-cancion').addEventListener('contextmenu', e => { const el = e.target.closest('.linea[data-l], .nota[data-l], .ln'); if (!el) return; e.preventDefault(); abrirNotaEn(el); });
$('#edA-cancion').addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse') return; const el = e.target.closest('.linea[data-l], .nota[data-l], .ln'); if (!el || e.target.closest('.tk')) return;
  notaLargaAbierta = false; clearTimeout(tNotaLarga); const x = e.clientX, y = e.clientY;
  const cancelar = ev => { if (Math.abs(ev.clientX - x) > 10 || Math.abs(ev.clientY - y) > 10) clearTimeout(tNotaLarga); };
  tNotaLarga = setTimeout(() => { notaLargaAbierta = true; abrirNotaEn(el); }, 550);
  const fin = () => { clearTimeout(tNotaLarga); document.removeEventListener('pointermove', cancelar); document.removeEventListener('pointerup', fin); document.removeEventListener('pointercancel', fin); };
  document.addEventListener('pointermove', cancelar); document.addEventListener('pointerup', fin); document.addEventListener('pointercancel', fin);
});
// tocar fuera del bloque en edición lo guarda
document.addEventListener('pointerdown', e => { if (!edA.editando) return; if (e.target.closest('.bloque.editando') || e.target.closest('.nota-caja')) return; guardarBloque(); });
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
  if (notaLargaAbierta) { notaLargaAbierta = false; return; }
  if (e.target.closest('.ed-deshacer')) { if (edA.editando && edA.editando.deshacer) edA.editando.deshacer(); return; }
  if (e.target.closest('.ed-rehacer')) { if (edA.editando && edA.editando.rehacer) edA.editando.rehacer(); return; }
  if (e.target.closest('.ed-listo')) { guardarBloque(); return; }
  if (e.target.closest('.ed-cancelar')) { cancelarBloque(); return; }
  if (e.target.closest('.edicion') || e.target.closest('.nota-caja') || e.target.closest('.menu-bloque')) return;
  const mb = e.target.closest('.mas-bloque'); if (mb) { const j = Number(mb.dataset.j); edA.menu = edA.menu === j ? null : j; renderEditorAcordes(); return; }
  const cl = e.target.closest('.cortar-linea'); if (cl) { cortarEn(Number(cl.dataset.l)); return; }
  const us = e.target.closest('.usar-seccion'); if (us) { const a = ordenActual(); a.push(us.dataset.nombre); guardarAcordes(conArreglo(editor.cho, a)); return; }
  if (e.target.closest('.agarre-bloque') || e.target.closest('.nota[data-l]')) return;
  const bl = e.target.closest('.bloque'); if (bl && !edA.editando) editarBloque(Number(bl.dataset.j)); // tocar el bloque = editarlo como texto
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
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey && !edA.editando) { ev.preventDefault(); $('#edA-deshacer').click(); return; } // ⌘Z fuera del bloque = ↶ Deshacer
  if (edA.sel && !edA.destino && (ev.key === 'Backspace' || ev.key === 'Delete')) { ev.preventDefault(); $('#edA-quitar').click(); }
  else if (ev.key === 'Escape' && (edA.sel || edA.destino || edA.lineaNueva)) { ev.preventDefault(); $(edA.destino || edA.lineaNueva ? '#edA-letras-cancelar' : '#edA-cancelar').click(); }
});
$('#edA-cancelar').onclick = () => { edA.sel = null; edA.destino = null; edA.duplicar = false; renderEditorAcordes(); };
$('#edA-ayuda-btn').onclick = () => { edA.ayudaAbierta = !edA.ayudaAbierta; $('#edA-ayuda').hidden = !edA.ayudaAbierta; };
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
$$('.subtabs button').forEach(b => b.onclick = () => { $$('.subtabs button').forEach(x => x.classList.toggle('activa', x === b)); $$('.sub').forEach(x => x.classList.toggle('activa', x.id === 'sub-' + b.dataset.sub)); if (b.dataset.sub === 'acordes') renderEditorAcordes(); prefs.editorSub = b.dataset.sub; guardar('prefs', prefs); });
function renderArreglo() {
  const ol = $('#ed-arreglo-lista'); ol.innerHTML = '';
  editor.arreglo.forEach((n, i) => {
    const li = document.createElement('li'); li.dataset.i = i; li.innerHTML = `<span class="agarre" title="Arrastra para mover">≡</span><div class="info"><div class="t">${esc(n)}</div></div><div class="acc"></div>`;
    const acc = li.querySelector('.acc');
    if (i > 0) acc.append(boton('↑', () => { [editor.arreglo[i - 1], editor.arreglo[i]] = [editor.arreglo[i], editor.arreglo[i - 1]]; renderArreglo(); }));
    if (i < editor.arreglo.length - 1) acc.append(boton('↓', () => { [editor.arreglo[i + 1], editor.arreglo[i]] = [editor.arreglo[i], editor.arreglo[i + 1]]; renderArreglo(); }));
    acc.append(boton('✕', () => { editor.arreglo.splice(i, 1); renderArreglo(); }));
    // arrastrar con el dedo o el mouse desde el asa ≡ (Cristhian, 11-sep, fila 137): eventos pointer, funcionan en iPhone/Android/Mac
    const agarre = li.querySelector('.agarre');
    agarre.addEventListener('pointerdown', e => {
      if (e.button && e.button !== 0) return;
      e.preventDefault(); li.classList.add('arrastrando');
      try { agarre.setPointerCapture(e.pointerId); } catch {}
      // mover y soltar se escuchan en el documento: no dependen de que la captura del puntero funcione (en la Mac no llegaba, 11-sep)
      const mover = ev => {
        if (ev.pointerId !== e.pointerId) return; ev.preventDefault();
        const bajo = document.elementFromPoint(ev.clientX, ev.clientY); const otro = bajo && bajo.closest('#ed-arreglo-lista > li');
        if (!otro || otro === li) return;
        const r = otro.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) otro.before(li); else otro.after(li);
      };
      const soltar = ev => {
        if (ev && ev.pointerId !== e.pointerId) return;
        document.removeEventListener('pointermove', mover); document.removeEventListener('pointerup', soltar); document.removeEventListener('pointercancel', soltar);
        li.classList.remove('arrastrando');
        editor.arreglo = [...ol.querySelectorAll('li[data-i]')].map(x => editor.arreglo[Number(x.dataset.i)]); renderArreglo();
      };
      document.addEventListener('pointermove', mover, { passive: false });
      document.addEventListener('pointerup', soltar); document.addEventListener('pointercancel', soltar);
    });
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
// ---------- editor de mix: canciones → partes ----------
async function seccionesDe(pid) { // secciones de una canción en el orden de su arreglo (o natural), sin repetir para las fichas
  try { const c = parsear(await obtenerCho(pid)); const arr = nombresArreglo(c); const nat = c.secciones.map(s => s.nombre || '').filter(Boolean); return { arreglo: arr.length ? arr : nat, disponibles: [...new Set(nat)] }; } catch { return { arreglo: [], disponibles: [] }; }
}
async function renderMix() {
  const { cab, ts } = trozos(editor.cho);
  const items = [];
  for (const t of ts) {
    const m = t[0].match(RE_PARTE);
    if (m) { const [pid, sec, t] = m[1].split('|').map(x => x.trim()); const transp = parseInt(t, 10) || 0; const u = items[items.length - 1]; if (u && u.tipo === 'cancion' && u.id === pid) u.partes.push(sec); else items.push({ tipo: 'cancion', id: pid, partes: [sec], transp }); }
    else items.push({ tipo: 'bloque', nombre: (t[0].match(RE_SEC) || [])[1] || 'bloque', lineas: t });
  }
  const guardar = async () => {
    const out = [...cab]; while (out.length && !out[out.length - 1].trim()) out.pop(); out.push('');
    for (const it of items) { if (it.tipo === 'cancion') for (const s of it.partes) out.push(`{parte: ${it.id} | ${s}${it.transp ? ` | ${it.transp > 0 ? '+' : ''}${it.transp}` : ''}}`); else out.push(...it.lineas.filter((l, k) => k === 0 || l.trim())); out.push(''); }
    await guardarEditor(out.join('\n').replace(/\n{3,}/g, '\n\n')); renderEditor();
  };
  const ol = $('#ed-mix-lista'); ol.innerHTML = ''; editor.mixVacio = !items.length;
  if (!items.length) ol.innerHTML = '<li class="vacio">El mix está vacío: agrega canciones abajo.</li>';
  for (const [i, it] of items.entries()) {
    const li = document.createElement('li');
    const rotulo = it.tipo === 'cancion' ? `🎵 ${esc(titulo(it.id))}<span class="n">${it.partes.length} parte${it.partes.length === 1 ? '' : 's'}</span>` : `🗒 ${esc(it.nombre)}<span class="n">bloque</span>`;
    li.innerHTML = `<div class="info"><div class="t">${i + 1}. ${rotulo}</div></div><div class="acc"></div>`;
    const acc = li.querySelector('.acc');
    if (it.tipo === 'cancion') {
      // tono en que se toca esta canción dentro del mix (la original no cambia): 12 tonos a partir del suyo, o semitonos si no tiene tono
      const orig = (indice.find(x => x.id === it.id) || {}).tono || '';
      const sel = document.createElement('select'); sel.className = 'tono-mix'; sel.title = 'Tono en que se toca en el mix';
      for (let k = -6; k <= 5; k++) { const o = document.createElement('option'); o.value = k; o.textContent = orig ? (k ? `${tonoTranspuesto(orig, k)} (${k > 0 ? '+' : ''}${k})` : `${orig} · original`) : (k ? `${k > 0 ? '+' : ''}${k} st` : 'tono original'); if (k === (it.transp || 0)) o.selected = true; sel.append(o); }
      sel.onchange = ev => { it.transp = Number(ev.target.value) || 0; guardar(); };
      acc.append(sel);
      acc.append(boton(editor.mixAbiertos.has(i) ? 'Partes ▴' : 'Partes ▾', () => { editor.mixAbiertos.has(i) ? editor.mixAbiertos.delete(i) : editor.mixAbiertos.add(i); renderMix(); }));
    }
    if (i > 0) acc.append(boton('↑', () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; guardar(); }));
    if (i < items.length - 1) acc.append(boton('↓', () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; guardar(); }));
    acc.append(boton('✕', () => { if (!confirm(it.tipo === 'cancion' ? `¿Quitar ${titulo(it.id)} del mix?` : '¿Quitar este bloque?')) return; items.splice(i, 1); guardar(); }));
    if (it.tipo === 'cancion' && editor.mixAbiertos.has(i)) {
      const { arreglo, disponibles } = await seccionesDe(it.id);
      const sub = document.createElement('ol'); sub.className = 'partes';
      it.partes.forEach((s, k) => {
        const pl = document.createElement('li'); pl.innerHTML = `<div class="info"><div class="t">${esc(s)}</div></div><div class="acc"></div>`;
        const pa = pl.querySelector('.acc');
        if (k > 0) pa.append(boton('↑', () => { [it.partes[k - 1], it.partes[k]] = [it.partes[k], it.partes[k - 1]]; guardar(); }));
        if (k < it.partes.length - 1) pa.append(boton('↓', () => { [it.partes[k + 1], it.partes[k]] = [it.partes[k], it.partes[k + 1]]; guardar(); }));
        pa.append(boton('✕', () => { it.partes.splice(k, 1); if (!it.partes.length) items.splice(i, 1); guardar(); }));
        sub.append(pl);
      });
      const chips = document.createElement('div'); chips.className = 'chips';
      for (const n of disponibles) chips.append(boton('+ ' + n, () => { it.partes.push(n); guardar(); }));
      if (arreglo.length) chips.append(boton('↺ Arreglo completo', () => { it.partes = [...arreglo]; guardar(); }, 'primario'));
      if (!disponibles.length) chips.innerHTML = '<span class="ayuda">Esa canción no tiene secciones definidas.</span>';
      sub.append(chips); li.append(sub);
    }
    ol.append(li);
  }
  // agregar canción: buscador como el de Canciones (Cristhian, 11-sep: el desplegable no sirve con muchas canciones)
  const buscar = $('#ed-mix-buscar'), res = $('#ed-mix-resultados');
  const agregar = async pid => { const { arreglo } = await seccionesDe(pid); if (!arreglo.length) return aviso('esa canción no tiene secciones'); items.push({ tipo: 'cancion', id: pid, partes: [...arreglo], transp: 0 }); editor.mixAbiertos.add(items.length - 1); buscar.value = ''; guardar(); };
  const pintarRes = () => {
    const q = norm(buscar.value.trim()); res.innerHTML = '';
    if (!q) return;
    const enMix = new Set(items.filter(x => x.tipo === 'cancion').map(x => x.id));
    const lista = indice.filter(c => !c.tipo && c.id !== editor.id && (norm(c.titulo).includes(q) || norm(c.artista).includes(q))).slice(0, 12);
    if (!lista.length) { res.innerHTML = '<li class="vacio">Nada con ese nombre.</li>'; return; }
    for (const c of lista) { const li = document.createElement('li'); li.innerHTML = `<div class="info"><div class="t">${esc(c.titulo)}${enMix.has(c.id) ? '<span class="n">ya está en el mix</span>' : ''}</div><div class="s">${esc(c.artista || '')}</div></div><div class="acc"></div>`; li.querySelector('.acc').append(boton('+ Agregar', () => agregar(c.id), 'primario')); res.append(li); }
  };
  buscar.oninput = pintarRes; pintarRes();
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
// descartar un mix (a la papelera del servidor, como cualquier canción) y salir; si está vacío al volver, se ofrece borrarlo (Cristhian, 11-sep, fila 162)
async function descartarMix(preguntar = true) {
  if (preguntar && !confirm(`¿Descartar el mix “${$('#ed-titulo').textContent}”? Queda una copia en datos/papelera.`)) return false;
  try { await api(`/api/canciones/${editor.id}`, { method: 'DELETE' }); cacheCho.delete(editor.id); await cargarIndice(); renderBiblioteca(); aviso('mix descartado'); irA('biblioteca'); return true; }
  catch (e) { aviso('no se pudo descartar: ' + e.message); return false; }
}
$('#ed-mix-descartar').onclick = () => descartarMix(true);
$('#ed-mix-listo').onclick = () => { aviso('mix guardado'); irA('biblioteca'); };
$('#ed-volver').onclick = async () => {
  if (editor.esMix && editor.mixVacio && confirm('El mix está vacío. ¿Lo borro?')) { await descartarMix(false); return; }
  irA('biblioteca');
};
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
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // versión nueva instalada (el sw la precargó completa): se avisa y cada uno recarga cuando le convenga; nunca sola en medio de una canción
  navigator.serviceWorker.addEventListener('message', ev => { if (ev.data && ev.data.tipo === 'nueva-version' && navigator.serviceWorker.controller) $('#actualizar').hidden = false; });
  $('#actualizar').onclick = () => location.reload();
}
// bloquear el zoom de la interfaz (pellizco y doble toque) en Safari; la letra se agranda con A− / A+
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
let ultimoToqueFin = 0;
document.addEventListener('touchend', e => { const ahora = Date.now(); if (ahora - ultimoToqueFin < 300 && !e.target.closest('button, input, select, textarea, a')) e.preventDefault(); ultimoToqueFin = ahora; }, { passive: false });

llenarPerfil(); actualizarConexion(); actualizarControles();
document.documentElement.style.setProperty('--tam', prefs.tam + 'rem');
cargarIndice().then(conectar).then(() => setTimeout(precargarTodo, 1500));
// Precarga total (Paper 10, hallazgos 2 y 7): con conexión, cada celular guarda en silencio todo el repertorio y los setlists,
// así sin red cualquier canción abre (el service worker las conserva) y los cambios de canción no dependen del WiFi en ese instante.
let precargando = false;
async function precargarTodo() {
  if (precargando) return; precargando = true;
  try {
    for (const c of indice) { if (!cacheCho.has(c.id)) { try { await obtenerCho(c.id); } catch { break; } } }
    try { const ls = await api('/api/setlists'); for (const s of ls) { try { await api(`/api/setlists/${s.id}`); } catch {} } } catch {}
  } finally { precargando = false; }
}
// al cargar: sin perfil → "Yo"; si no, la pestaña (y la canción del editor) donde estaba este dispositivo
if (!perfil.nombre) irA('ajustes');
else if (prefs.vista === 'editor' && prefs.editorId) { editorPendiente = prefs.editorId; irA('biblioteca'); } // el editor se abre cuando el servidor confirme el rol (bienvenida)
else if (prefs.vista === 'previa' && prefs.previaId) { cargarIndice().then(() => verLibre(prefs.previaId)); }
else if (prefs.vista && prefs.vista !== 'editor' && $(`#tabs button[data-vista="${prefs.vista}"]`)) irA(prefs.vista);
