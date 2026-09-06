// Visualizador Lyrics — lógica de la app (sin framework).
import { parsear, renderCancion, tonoTranspuesto } from './chordpro.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const cargar = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return d; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const perfil = cargar('perfil', { nombre: '', instrumento: 'voz', rol: 'musico', pin: '', vista: 'acordes' });
const prefs = cargar('prefs', { tam: 1.25, transp: {}, cejilla: {} });
let indice = [];                 // [{id,titulo,artista,tono,...}]
let estado = { vivo: { cancion: null, seccion: 0 }, siguiente: [], controlCantante: false, conectados: [] };
let rol = 'musico';              // rol confirmado por el servidor
let ws = null, conectado = false, reintento = 1000;
let modo = 'siguiendo';          // 'siguiendo' | 'libre' | 'lider'
const mostrando = { id: null, cancion: null, seccion: 0, frac: 0 };
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
  ws.onopen = () => { reintento = 1000; enviar({ tipo: 'hola', nombre: perfil.nombre || 'anónimo', instrumento: perfil.instrumento, rol: perfil.rol, pin: perfil.pin }); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.tipo === 'bienvenida') { conectado = true; rol = m.rol; actualizarConexion(); aplicarEstado(m.estado); }
    else if (m.tipo === 'estado') aplicarEstado(m.estado);
    else if (m.tipo === 'rechazado') aviso('sin permiso');
  };
  ws.onclose = () => { conectado = false; actualizarConexion(); actualizarControles(); programarReintento(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function programarReintento() { setTimeout(conectar, reintento); reintento = Math.min(reintento * 1.6, 8000); }

// ---------- estado compartido ----------
function aplicarEstado(e) {
  estado = e;
  $('#n-siguiente').textContent = e.siguiente.length || '';
  if (modo !== 'libre') {
    modo = puedeMover() ? 'lider' : 'siguiendo';
    if (e.vivo.cancion) mostrar(e.vivo.cancion, e.vivo.seccion, { frac: e.vivo.frac || 0 }); else vaciarVivo();
  }
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
  $('#controles-lider').hidden = !lider;
  $('#btn-volver').hidden = modo !== 'libre';
  const p = $('#vivo-modo');
  p.className = 'pill ' + (modo === 'libre' ? 'modo-libre' : lider ? 'modo-lider' : 'modo-siguiendo');
  p.textContent = modo === 'libre' ? 'navegación libre' : lider ? 'tú controlas el vivo' : conectado ? 'siguiendo al vivo' : 'sin conexión · lo guardado sigue disponible';
  $('#panel-director').hidden = rol !== 'director';
  $('#siguiente-acciones').hidden = !(rol === 'director' && estado.siguiente.length);
  $('#ctl-cejilla').style.display = perfil.instrumento === 'guitarra' ? '' : 'none';
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
    if (mostrando.id !== id) {
      const cho = await obtenerCho(id);
      mostrando.id = id; mostrando.cancion = parsear(cho);
      cerrarNota();
    }
    mostrando.seccion = Math.max(0, Math.min(seccion, mostrando.cancion.secciones.length - 1));
    mostrando.frac = frac;
    pintar();
    if (desplazar) requestAnimationFrame(() => window.scrollTo({ top: scrollDePosicion(mostrando.seccion, mostrando.frac), behavior: 'smooth' }));
  } catch (e) { $('#cancion').innerHTML = `<p class="vacio">No se pudo abrir la canción (${e.message}). Sin red solo están las canciones ya guardadas en este teléfono.</p>`; }
}
function pintar() {
  const c = mostrando.cancion; if (!c) return;
  const m = c.meta, id = mostrando.id;
  const transp = prefs.transp[id] || 0, cejilla = perfil.instrumento === 'guitarra' ? (prefs.cejilla[id] ?? Number(m.cejilla || 0)) : 0;
  $('#vivo-titulo').textContent = m.titulo || titulo(id);
  const partes = [m.artista, m.tono ? 'Tono ' + tonoTranspuesto(m.tono, transp) + (transp ? ` (orig. ${m.tono})` : '') : '', m.estado === 'importada' ? '⚠ sin corregir' : ''].filter(Boolean);
  $('#vivo-sub').textContent = partes.join(' · ');
  $('#tr-valor').textContent = transp > 0 ? '+' + transp : transp; $('#cj-valor').textContent = cejilla;
  const art = $('#cancion');
  art.className = 'vista-' + perfil.vista;
  art.innerHTML = renderCancion(c, { transp, cejilla, vista: perfil.vista, seccionActual: mostrando.seccion });
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
  mostrando.seccion = pos.seccion; mostrando.frac = pos.frac; pintar();
  window.scrollTo({ top: y, behavior: 'smooth' });
}
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
$('#cancion').addEventListener('pointerup', e => {
  if (!toque) return; const dx = Math.abs(e.clientX - toque.x), dy = Math.abs(e.clientY - toque.y), dt = Date.now() - toque.t; toque = null;
  if (dx > 10 || dy > 10 || dt > 400) return; // fue un desplazamiento, no un toque
  const sec = e.target.closest('[data-sec]');
  const w = window.innerWidth;
  if (e.clientX > w * 0.66) moverSeccion(1);
  else if (e.clientX < w * 0.2) moverSeccion(-1);
  else if (sec && perfil.vista === 'estructura') irASeccion(Number(sec.dataset.sec));
});

// transposición, cejilla, tamaño
const ajustar = (obj, delta, min, max) => { const id = mostrando.id; if (!id) return; obj[id] = Math.max(min, Math.min(max, (obj[id] ?? (obj === prefs.cejilla ? Number(mostrando.cancion?.meta.cejilla || 0) : 0)) + delta)); guardar('prefs', prefs); pintar(); };
$('#tr-menos').onclick = () => ajustar(prefs.transp, -1, -11, 11);
$('#tr-mas').onclick = () => ajustar(prefs.transp, 1, -11, 11);
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
  const ul = $('#lista-canciones'); ul.innerHTML = '';
  for (const c of lista.slice(0, 300)) {
    const li = document.createElement('li'); if (c.id === estado.vivo.cancion) li.classList.add('en-vivo');
    li.innerHTML = `<div class="info"><div class="t">${esc(c.titulo)}</div><div class="s">${esc([c.artista, c.tono ? 'Tono ' + c.tono : '', c.estado === 'importada' ? '⚠ sin corregir' : ''].filter(Boolean).join(' · '))}</div></div><div class="acc"></div>`;
    const acc = li.querySelector('.acc');
    acc.append(boton('Ver', () => verLibre(c.id)));
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
function llenarPerfil() { const f = $('#form-perfil'); for (const k of ['nombre', 'instrumento', 'rol', 'pin', 'vista']) if (f.elements[k]) f.elements[k].value = perfil[k] ?? ''; }
$('#form-perfil').onsubmit = ev => {
  ev.preventDefault(); const f = ev.target;
  for (const k of ['nombre', 'instrumento', 'rol', 'pin', 'vista']) perfil[k] = f.elements[k].value;
  guardar('perfil', perfil); pintar(); actualizarControles();
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

// ---------- pantalla encendida, service worker, arranque ----------
let wakeLock = null;
async function mantenerPantalla() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {} }
document.addEventListener('pointerdown', mantenerPantalla, { once: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') mantenerPantalla(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

llenarPerfil(); actualizarConexion(); actualizarControles();
document.documentElement.style.setProperty('--tam', prefs.tam + 'rem');
cargarIndice().then(conectar);
if (!perfil.nombre) irA('ajustes');
