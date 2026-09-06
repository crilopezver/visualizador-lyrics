// Visualizador Lyrics — lógica de la app (sin framework).
import { parsear, renderCancion, tonoTranspuesto, expandir, nombresArreglo, tituloSeccion } from './chordpro.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const cargar = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return d; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const perfil = cargar('perfil', { nombre: '', instrumento: 'voz', rol: 'musico', pin: '', vista: 'acordes', cejilla: false, botones: true });
const prefs = cargar('prefs', { tam: 1.25, transp: {}, cejilla: {} });
let indice = [];                 // [{id,titulo,artista,tono,...}]
let estado = { vivo: { cancion: null, seccion: 0, frac: 0 }, siguiente: [], controlCantante: false, tonos: {}, conectados: [] };
let rol = 'musico';              // rol confirmado por el servidor
let ws = null, conectado = false, reintento = 1000;
const clienteId = (() => { try { let c = localStorage.getItem('clienteId'); if (!c) { c = Math.random().toString(36).slice(2, 12); localStorage.setItem('clienteId', c); } return c; } catch { return Math.random().toString(36).slice(2, 12); } })();
let ultimoGesto = 0; // último toque/rueda/tecla del usuario: solo entonces un scroll cuenta como suyo
let modo = 'siguiendo';          // 'siguiendo' | 'libre' | 'lider'
const mostrando = { id: null, cancion: null, seccion: 0, frac: 0, pintadoId: null };
let scrollProgramatico = false, tScrollProg = null;
const cacheCho = new Map();
let setlistAbierto = null;
let ultimaFirmaBib = '', ultimaFirmaCola = '';

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
  estado = e;
  $('#n-siguiente').textContent = e.siguiente.length || '';
  if (mostrando.id && transpBanda(mostrando.id) !== tonoAntes) mostrando.pintadoId = null; // cambió el tono de la banda: repintar
  if (modo !== 'libre') {
    modo = puedeMover() ? 'lider' : 'siguiendo';
    if (e.vivo.cancion) {
      // quien movió el vivo ignora su propio eco (ya está ahí); todos los demás se desplazan
      const esMiEco = e.vivo.por === clienteId && mostrando.id === e.vivo.cancion;
      mostrar(e.vivo.cancion, e.vivo.seccion, { frac: e.vivo.frac || 0, desplazar: !esMiEco });
    } else vaciarVivo();
  } else if (mostrando.id && mostrando.pintadoId === null) pintar(); // en libre, refleja el cambio de tono
  // repintar listas solo si cambió algo que las afecte (evita romper un toque en curso)
  const firmaBib = [rol, puedeMover(), puedeCola(), e.vivo.cancion].join('|');
  if (firmaBib !== ultimaFirmaBib) { ultimaFirmaBib = firmaBib; renderBiblioteca(); }
  const firmaCola = [rol, puedeMover(), puedeCola(), e.siguiente.join(',')].join('|');
  if (firmaCola !== ultimaFirmaCola) { ultimaFirmaCola = firmaCola; renderSiguiente(); }
  renderConectados(); actualizarControles();
  const chk = $('#chk-cantante'); if (chk) chk.checked = !!e.controlCantante;
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
  for (let k = 0; k < secs.length; k++) { const top = secs[k].getBoundingClientRect().top + window.scrollY; if (top <= ref) i = k; }
  const el = secs[i], top = el.getBoundingClientRect().top + window.scrollY, h = Math.max(el.offsetHeight, 1);
  return { seccion: i, frac: Math.max(0, Math.min(1, (ref - top) / h)) };
}
function scrollDePosicion(seccion, frac) {
  const el = $(`#cancion [data-sec="${seccion}"]`); if (!el) return 0;
  const top = el.getBoundingClientRect().top + window.scrollY;
  return Math.max(0, top + frac * el.offsetHeight - topBarra());
}
async function mostrar(id, seccion = 0, { desplazar = true, frac = 0 } = {}) {
  if (!id) return vaciarVivo();
  try {
    if (mostrando.id !== id || !mostrando.expandidas) {
      const cho = await obtenerCho(id);
      if (mostrando.id !== id) cerrarNota();
      mostrando.id = id; mostrando.cancion = parsear(cho);
      mostrando.expandidas = await expandirConPartes(mostrando.cancion);
    }
    mostrando.seccion = Math.max(0, Math.min(seccion, mostrando.expandidas.length - 1));
    mostrando.frac = frac;
    if (mostrando.pintadoId !== id) pintar(); else marcarSeccion(mostrando.seccion);
    if (desplazar) { void $('#cancion').offsetHeight; /* fuerza layout */ scrollA(scrollDePosicion(mostrando.seccion, mostrando.frac)); }
  } catch (e) { $('#cancion').innerHTML = `<p class="vacio">No se pudo abrir la canción (${e.message}). Sin red solo están las canciones ya guardadas en este teléfono.</p>`; }
}
function scrollA(top) {
  scrollProgramatico = true; clearTimeout(tScrollProg);
  const lejos = Math.abs(top - window.scrollY) > window.innerHeight * 0.9;
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
  mostrando.pintadoId = id;
  const art = $('#cancion');
  art.className = 'vista-' + perfil.vista;
  art.innerHTML = renderCancion(c, { transp, cejilla, vista: perfil.vista, seccionActual: mostrando.seccion, secciones: mostrando.expandidas });
  // cuál sigue
  const sig = estado.siguiente[0];
  $('#vivo-sigue').textContent = sig ? `Sigue: ${titulo(sig)}` : '';
  art.insertAdjacentHTML('beforeend', sig
    ? `<div class="sigue-card">Sigue<b>${esc(titulo(sig))}${artista(sig) ? ' · ' + esc(artista(sig)) : ''}</b>${puedeMover() ? '<button class="btn-pasar">▶▶ Pasar a esta canción</button>' : ''}</div>`
    : `<div class="sigue-card">Fin de la cola${puedeMover() ? '<b>Agrega canciones en “Canciones” o carga un setlist</b>' : ''}</div>`);
  $('#btn-editar').hidden = rol !== 'director';
  document.documentElement.style.setProperty('--tam', prefs.tam + 'rem');
}
// Navegación por páginas (estilo lector): avanza ~80 % de la pantalla. La sincronía viaja como sección + fracción.
function moverPagina(delta) {
  if (!mostrando.cancion) return;
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const y = Math.max(0, Math.min(max, window.scrollY + delta * window.innerHeight * 0.8));
  const pos = posicionDeScroll(y);
  if (modo !== 'lider') { modo = 'libre'; actualizarControles(); }
  else enviar({ tipo: 'vivo', seccion: pos.seccion, frac: pos.frac });
  mostrando.seccion = pos.seccion; mostrando.frac = pos.frac; marcarSeccion(pos.seccion);
  scrollA(y);
}
// Deslizamiento con el dedo: el líder transmite su posición en vivo (~12 veces por segundo); un seguidor que desliza pasa a libre.
let tUltimoEnvio = 0, tEnvioPendiente = null;
window.addEventListener('scroll', () => {
  if (!mostrando.cancion || !$('#vista-vivo').classList.contains('activa')) return;
  if (!scrollDelUsuario()) return; // desplazamiento automático (seguir al vivo, cambio de canción): no es un gesto
  if (modo === 'lider') {
    const enviarPos = () => { const pos = posicionDeScroll(window.scrollY); mostrando.seccion = pos.seccion; mostrando.frac = pos.frac; marcarSeccion(pos.seccion); enviar({ tipo: 'vivo', seccion: pos.seccion, frac: pos.frac }); tUltimoEnvio = Date.now(); };
    const espera = 80 - (Date.now() - tUltimoEnvio);
    clearTimeout(tEnvioPendiente);
    if (espera <= 0) enviarPos(); else tEnvioPendiente = setTimeout(enviarPos, espera);
  } else if (modo === 'siguiendo') { modo = 'libre'; actualizarControles(); }
}, { passive: true });
function irASeccion(i) {
  if (modo === 'lider') enviar({ tipo: 'vivo', seccion: i, frac: 0 }); else { modo = 'libre'; actualizarControles(); }
  mostrar(mostrando.id, i, { frac: 0 });
}
const moverSeccion = moverPagina;
function verLibre(id) { modo = 'libre'; actualizarControles(); irA('vivo'); mostrar(id, 0); }
$('#btn-volver').onclick = () => { modo = puedeMover() ? 'lider' : 'siguiendo'; actualizarControles(); if (estado.vivo.cancion) mostrar(estado.vivo.cancion, estado.vivo.seccion, { frac: estado.vivo.frac || 0 }); else vaciarVivo(); };
$('#lider-prev').onclick = () => moverSeccion(-1);
$('#lider-next').onclick = () => moverSeccion(1);
$('#lider-pasar').onclick = () => { if (!estado.siguiente.length) return aviso('cola vacía'); enviar({ tipo: 'siguiente', accion: 'pasar' }); };

// teclado (pedal = teclado Bluetooth) y zonas de toque estilo lector
document.addEventListener('keydown', ev => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (!$('#vista-vivo').classList.contains('activa')) return;
  if (['ArrowDown', 'ArrowRight', 'PageDown', ' ', 'Enter'].includes(ev.key)) { ev.preventDefault(); moverSeccion(1); }
  else if (['ArrowUp', 'ArrowLeft', 'PageUp', 'Backspace'].includes(ev.key)) { ev.preventDefault(); moverSeccion(-1); }
});
let toque = null;
$('#cancion').addEventListener('pointerdown', e => { toque = { x: e.clientX, y: e.clientY, t: Date.now() }; });
$('#cancion').addEventListener('click', e => { if (e.target.closest('.btn-pasar')) { e.stopPropagation(); enviar({ tipo: 'siguiente', accion: 'pasar' }); } });
$('#cancion').addEventListener('pointerup', e => {
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
  if (editor.id === id && $('#vista-editor').classList.contains('activa')) await renderEditor();
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
}
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
  const lista = indice.filter(c => !q || norm(c.titulo).includes(q) || norm(c.artista).includes(q));
  $('#bib-info').textContent = `${lista.length} de ${indice.length} canciones`;
  $('#bib-director').hidden = rol !== 'director';
  const ul = $('#lista-canciones'); ul.innerHTML = '';
  for (const c of lista.slice(0, 300)) {
    const li = document.createElement('li'); if (c.id === estado.vivo.cancion) li.classList.add('en-vivo');
    li.innerHTML = `<div class="info"><div class="t">${c.tipo === 'mix' ? '🎛 ' : c.tipo === 'bloque' ? '🗒 ' : ''}${esc(c.titulo)}</div><div class="s">${esc([c.tipo === 'mix' ? 'mix' : c.tipo === 'bloque' ? 'bloque del show' : '', c.artista, c.tono ? 'Tono ' + c.tono : '', c.estado === 'importada' ? '⚠ sin corregir' : ''].filter(Boolean).join(' · '))}</div></div><div class="acc"></div>`;
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
function llenarPerfil() { const f = $('#form-perfil'); for (const k of ['nombre', 'instrumento', 'rol', 'pin', 'vista']) if (f.elements[k]) f.elements[k].value = perfil[k] ?? ''; f.elements.cejilla.checked = !!perfil.cejilla; f.elements.botones.checked = perfil.botones !== false; }
$('#form-perfil').onsubmit = ev => {
  ev.preventDefault(); const f = ev.target;
  for (const k of ['nombre', 'instrumento', 'rol', 'pin', 'vista']) perfil[k] = f.elements[k].value;
  perfil.cejilla = f.elements.cejilla.checked; perfil.botones = f.elements.botones.checked;
  guardar('perfil', perfil); mostrando.pintadoId = null; pintar(); actualizarControles();
  try { ws && ws.close(); } catch {} // reconecta con el nuevo perfil/rol
  aviso('perfil guardado'); irA('vivo');
};
$('#chk-cantante').onchange = ev => enviar({ tipo: 'control', cantante: ev.target.checked });
function renderConectados() {
  const ul = $('#conectados'); ul.innerHTML = '';
  for (const c of estado.conectados) { const li = document.createElement('li'); li.textContent = `${c.nombre}${c.instrumento ? ' · ' + c.instrumento : ''}${c.rol !== 'musico' ? ' · ' + c.rol : ''}`; ul.append(li); }
  if (!estado.conectados.length) ul.innerHTML = '<li class="vacio">nadie conectado</li>';
}
async function cargarInfo() {
  try {
    const i = await api('/api/info');
    $('#info-servidor').innerHTML = `Servidor v${esc(i.version)} · datos: ${esc(i.datos)}${i.ejemplo ? ' <b>(datos de ejemplo, no los reales)</b>' : ''}<br>Direcciones para los demás: ${i.ips.map(x => `<b>http://${x.ip}:${i.puerto}</b>`).join(' · ')}`;
  } catch { $('#info-servidor').textContent = 'Sin conexión con el servidor.'; }
}

// ---------- editor de estructura (director) ----------
const editor = { id: null, cho: '', selIni: null, selFin: null, arreglo: [] };
const NOMBRES_ESTANDAR = ['Intro', 'Estrofa 1', 'Estrofa 2', 'Estrofa 3', 'Pre-coro', 'Coro', 'Puente', 'Solo', 'Interludio', 'Final'];
const META_CAB = /^\{\s*(titulo|título|artista|tono|cejilla|estado|compositor|afinacion|afinación|fuente|arreglo|tipo)\s*:/i;
const RE_SEC = /^\{\s*secci[oó]n\s*:\s*(.*?)\s*\}\s*$/i;
const RE_PARTE = /^\{\s*parte\s*:\s*(.*?)\s*\}\s*$/i;
const RE_ARREGLO = /^\{\s*arreglo\s*:.*\}\s*$/im;
async function abrirEditor(id) {
  if (rol !== 'director') return aviso('solo el director');
  editor.id = id; editor.selIni = editor.selFin = null;
  if (mostrando.id !== id) { modo = 'libre'; actualizarControles(); await mostrar(id, 0, { desplazar: false }); }
  await renderEditor(); irA('editor'); window.scrollTo({ top: 0 });
}
async function guardarEditor(cho) {
  editor.cho = cho;
  await api(`/api/canciones/${editor.id}`, { method: 'PUT', body: JSON.stringify({ cho }) });
  cacheCho.set(editor.id, cho); // el aviso del servidor repinta el vivo en todos
}
function lineasCuerpo() { return editor.cho.replace(/\r/g, '').split('\n'); }
async function renderEditor() {
  editor.cho = await obtenerCho(editor.id);
  const c = parsear(editor.cho);
  $('#ed-titulo').textContent = c.meta.titulo || editor.id;
  // 1 · líneas
  const ol = $('#ed-lineas'); ol.innerHTML = '';
  const lineas = lineasCuerpo();
  lineas.forEach((l, i) => {
    if (META_CAB.test(l)) return;
    const li = document.createElement('li'); li.dataset.i = i;
    let m;
    if ((m = l.match(RE_SEC))) {
      li.className = 'ed-sec'; li.innerHTML = `<span class="txt">${esc(m[1] || 'sección sin nombre')}</span>`;
      li.append(boton('✎', async () => { const n = prompt('Nombre de la sección:', m[1]); if (n === null) return; lineas[i] = `{seccion: ${n.trim()}}`; await guardarEditor(lineas.join('\n')); renderEditor(); }));
      li.append(boton('✕', async () => { if (!confirm('¿Quitar la marca de sección? La letra se conserva.')) return; lineas.splice(i, 1); await guardarEditor(lineas.join('\n')); renderEditor(); }));
    } else if ((m = l.match(RE_PARTE))) {
      const [pid, sec] = m[1].split('|').map(x => x.trim());
      li.className = 'ed-parte'; li.innerHTML = `<span class="txt">↪ ${esc(sec)} · ${esc(titulo(pid))}</span>`;
      li.append(boton('✕', async () => { lineas.splice(i, 1); await guardarEditor(lineas.join('\n')); renderEditor(); }));
    } else {
      if (!l.trim()) li.classList.add('vacia');
      li.innerHTML = `<span class="txt">${l.trim() ? esc(l).replace(/\[([^\]]+)\]/g, '<span class="ac-in">[$1]</span>') : '(línea vacía)'}</span>`;
      if (editor.selIni !== null && editor.selFin !== null && i >= editor.selIni && i <= editor.selFin) li.classList.add('sel');
      if (editor.selIni === i) li.classList.add('sel', 'sel-ini');
      li.onclick = () => seleccionarLinea(i);
    }
    ol.append(li);
  });
  $('#ed-sel-barra').hidden = editor.selIni === null;
  // nombres sugeridos
  try { const usados = await api('/api/secciones'); const dl = $('#ed-nombres'); dl.innerHTML = ''; for (const n of [...new Set([...NOMBRES_ESTANDAR, ...usados])]) { const o = document.createElement('option'); o.value = n; dl.append(o); } } catch {}
  // 2 · arreglo
  const nombres = [...new Set(c.secciones.map(s => s.nombre || (s.parte && s.parte.seccion) || '').filter(Boolean))];
  const chips = $('#ed-chips'); chips.innerHTML = '';
  for (const n of nombres) chips.append(boton(n, () => { editor.arreglo.push(n); renderArreglo(); }));
  if (!nombres.length) chips.innerHTML = '<span class="ayuda">Primero marca secciones (paso 1).</span>';
  editor.arreglo = nombresArreglo(c); renderArreglo();
  // 3 · partes
  const selC = $('#ed-parte-cancion'); selC.innerHTML = '<option value="">Canción…</option>';
  for (const x of indice) if (x.id !== editor.id) { const o = document.createElement('option'); o.value = x.id; o.textContent = x.titulo + (x.artista ? ' · ' + x.artista : ''); selC.append(o); }
  $('#ed-parte-seccion').innerHTML = '<option value="">Sección…</option>';
  renderPartes(c);
}
function seleccionarLinea(i) {
  if (editor.selIni === null || editor.selFin !== null) { editor.selIni = i; editor.selFin = null; }
  else { editor.selFin = i; if (editor.selFin < editor.selIni) [editor.selIni, editor.selFin] = [editor.selFin, editor.selIni]; }
  renderEditor();
}
$('#ed-cancelar').onclick = () => { editor.selIni = editor.selFin = null; renderEditor(); };
$('#ed-definir').onclick = async () => {
  const nombre = $('#ed-nombre').value.trim(); if (!nombre) return aviso('ponle nombre');
  const lineas = lineasCuerpo();
  const ini = editor.selIni; let fin = editor.selFin ?? editor.selIni;
  // las marcas de sección dentro del tramo se funden en la nueva
  for (let i = fin; i >= ini; i--) if (RE_SEC.test(lineas[i])) { lineas.splice(i, 1); fin--; }
  // si lo que sigue al tramo no tiene marca propia, abrir una sección sin nombre para no arrastrarlo
  let j = fin + 1; while (j < lineas.length && !lineas[j].trim()) j++;
  if (j < lineas.length && !RE_SEC.test(lineas[j]) && !RE_PARTE.test(lineas[j]) && !META_CAB.test(lineas[j])) lineas.splice(fin + 1, 0, '{seccion: }');
  lineas.splice(ini, 0, `{seccion: ${nombre}}`);
  editor.selIni = editor.selFin = null; $('#ed-nombre').value = '';
  await guardarEditor(lineas.join('\n')); renderEditor();
};
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
  const ol = $('#ed-partes-lista'); ol.innerHTML = '';
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
$('#ed-volver').onclick = () => { irA('vivo'); };
$('#btn-editar').onclick = () => { if (mostrando.id) abrirEditor(mostrando.id); };
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

llenarPerfil(); actualizarConexion(); actualizarControles();
document.documentElement.style.setProperty('--tam', prefs.tam + 'rem');
cargarIndice().then(conectar);
if (!perfil.nombre) irA('ajustes');
