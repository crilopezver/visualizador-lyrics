// Parser ChordPro (dialecto Pueblerinos), transposición, cejilla y render.
// Formato: {titulo: ..} {artista: ..} {tono: G} {cejilla: 2} {seccion: Coro} {nota: ...}  y líneas con [Acorde]sílaba.

const META_RE = /^\{\s*([a-záéíóúñ_]+)\s*:\s*(.*?)\s*\}\s*$/i;
const ACORDE_RE = /\[([^\]]+)\]/g;
const REP_RE = /\s*\((x\d+)\)\s*$|\s+(x\d+)\s*$/i;

export function parsear(cho) {
  const meta = {}; const secciones = []; let actual = null;
  const nueva = nombre => { actual = { nombre, lineas: [] }; secciones.push(actual); };
  for (const cruda of cho.replace(/\r/g, '').split('\n')) {
    const m = cruda.match(META_RE);
    if (m) {
      const k = m[1].toLowerCase(), v = m[2];
      if (k === 'seccion' || k === 'sección') nueva(v);
      else if (k === 'nota' || k === 'comentario' || k === 'c') { if (!actual) nueva(''); actual.lineas.push({ tipo: 'nota', texto: v }); }
      else meta[k] = v;
      continue;
    }
    if (!actual) { if (!cruda.trim()) continue; nueva(''); }
    if (!cruda.trim()) { actual.lineas.push({ tipo: 'vacia' }); continue; }
    let linea = cruda, rep = '';
    const r = linea.match(REP_RE); if (r) { rep = r[1] || r[2]; linea = linea.slice(0, r.index); }
    const segs = []; let ultimo = 0, acorde = null, mm;
    ACORDE_RE.lastIndex = 0;
    while ((mm = ACORDE_RE.exec(linea))) {
      const texto = linea.slice(ultimo, mm.index);
      if (acorde !== null || texto) segs.push({ acorde: acorde || '', texto });
      acorde = mm[1]; ultimo = ACORDE_RE.lastIndex;
    }
    const cola = linea.slice(ultimo);
    if (acorde !== null || cola) segs.push({ acorde: acorde || '', texto: cola });
    const soloAcordes = segs.length && segs.every(s => !s.texto.trim());
    actual.lineas.push({ tipo: soloAcordes ? 'acordes' : 'letra', segs, rep });
  }
  return { meta, secciones };
}

// --- transposición ---
const NOTAS_SOST = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTAS_BEM = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const INDICE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11, 'E#': 5, Fb: 4, 'B#': 0 };
const TONOS_BEMOL = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);

function transponerNota(nota, n, bemoles) {
  const i = INDICE[nota]; if (i === undefined) return nota;
  const j = ((i + n) % 12 + 12) % 12;
  return (bemoles ? NOTAS_BEM : NOTAS_SOST)[j];
}
export function transponerAcorde(acorde, n, bemoles = false) {
  if (!n) return acorde;
  // conserva paréntesis, asterisco, cualidad y bajo: (D) Am7* C/E
  return acorde.replace(/([A-G](?:#|b)?)/g, (_, nota) => transponerNota(nota, n, bemoles));
}
export function tonoTranspuesto(tono, n) {
  if (!tono) return '';
  const m = tono.match(/^([A-G](?:#|b)?)(.*)$/); if (!m) return tono;
  const bem = TONOS_BEMOL.has(tono);
  return transponerNota(m[1], n, bem) + m[2];
}

// --- render ---
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderSeg(acorde, texto, transp, bemoles) {
  const ac = acorde ? transponerAcorde(acorde, transp, bemoles) : '';
  // dividir el texto en palabras para que la línea pueda cortar entre palabras; el acorde va con la primera
  const partes = texto.match(/\S+\s*|\s+/g) || [''];
  let html = '';
  partes.forEach((p, i) => {
    html += `<span class="seg"><span class="ac">${i === 0 ? esc(ac) : ''}</span><span class="tx">${esc(p) || ' '}</span></span>`;
  });
  return html;
}

export function renderCancion(cancion, opts = {}) {
  const { transp = 0, cejilla = 0, vista = 'acordes', seccionActual = 0 } = opts;
  const bemoles = TONOS_BEMOL.has(tonoTranspuesto(cancion.meta.tono || '', transp - cejilla));
  const desplazamiento = transp - cejilla; // lo que ve el guitarrista con cejilla
  if (vista === 'estructura') {
    const items = cancion.secciones.map((s, i) => {
      const acs = []; let reps = '';
      for (const l of s.lineas) { if (l.segs) for (const g of l.segs) if (g.acorde) acs.push(transponerAcorde(g.acorde, desplazamiento, bemoles)); if (l.rep) reps = l.rep; }
      const notas = s.lineas.filter(l => l.tipo === 'nota').map(l => `<div class="nota">${esc(l.texto)}</div>`).join('');
      const unicos = [...new Set(acs)].slice(0, 8).join(' ');
      return `<li class="${i === seccionActual ? 'actual' : ''}" data-sec="${i}"><div><div>${esc(s.nombre || 'Sección ' + (i + 1))}${reps ? `<span class="rep">${esc(reps)}</span>` : ''}</div>${notas}</div><div class="acs">${esc(unicos)}</div></li>`;
    });
    return `<ol class="estructura">${items.join('')}</ol>`;
  }
  return cancion.secciones.map((s, i) => {
    const lineas = s.lineas.map(l => {
      if (l.tipo === 'vacia') return '<div class="linea">&nbsp;</div>';
      if (l.tipo === 'nota') return `<div class="nota">${esc(l.texto)}</div>`;
      const html = l.segs.map(g => renderSeg(g.acorde, g.texto, desplazamiento, bemoles)).join('');
      return `<div class="linea ${l.tipo === 'acordes' ? 'solo-acordes' : ''}">${html}${l.rep ? `<span class="rep">(${esc(l.rep)})</span>` : ''}</div>`;
    }).join('');
    const nombre = s.nombre ? `<div class="nombre">${esc(s.nombre)}</div>` : '';
    return `<div class="seccion ${i === seccionActual ? 'actual' : ''}" data-sec="${i}">${nombre}${lineas}</div>`;
  }).join('');
}

// --- columnas → ChordPro (importador por pegado; puerto del prototipo Python) ---
const CHORD_TOKEN = /^\(?[A-G](?:#|b)?(?:maj|min|dim|aug|sus|add|m|M|\+|°|º)?\d*(?:\([^)]*\))?(?:sus\d|add\d|maj\d)*(?:\/[A-G](?:#|b)?)?\*?\)?$/;
const TOKENS_OK = new Set(['|', '||', 'x2', 'x3', 'x4', '(x2)', '(x3)', '(x4)', '*', '-', '–', 'N.C.']);
const limpiarTok = t => t.replace(/^[….·:]+|[….·:]+$/g, '');
function esLineaAcordes(l) { const t = l.split(/\s+/).map(limpiarTok).filter(Boolean); return t.length > 0 && t.every(x => CHORD_TOKEN.test(x) || TOKENS_OK.has(x)); }
function insertar(acordes, letra) {
  const pos = []; const re = /\S+/g; let m;
  while ((m = re.exec(acordes))) { const a = limpiarTok(m[0]); if (a && !TOKENS_OK.has(a)) pos.push([m.index, a]); }
  let out = '', cur = 0;
  for (const [col, ac] of pos) {
    if (col >= letra.length) { out += letra.slice(cur) + ' [' + ac + ']'; cur = letra.length; continue; }
    out += letra.slice(cur, col) + '[' + ac + ']'; cur = col;
  }
  return out + letra.slice(cur);
}
export function textoAChordPro(texto, { titulo = '', artista = '' } = {}) {
  const lineas = texto.replace(/\r/g, '').replace(/\t/g, '        ').split('\n');
  const meta = { titulo, artista }; const cuerpo = [];
  const noVacias = lineas.filter(l => l.trim());
  if (!titulo && noVacias[0] && !esLineaAcordes(noVacias[0])) meta.titulo = noVacias[0].trim();
  if (!artista && noVacias[1] && !esLineaAcordes(noVacias[1]) && !/^\s*(tono|afina|composi|capo)/i.test(noVacias[1])) meta.artista = noVacias[1].trim().replace(/^\(|\)$/g, '');
  let consumidas = 0;
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].replace(/\(\s*([^()\s]+)\s*\)/g, '($1)'), s = l.trim();
    if (!s) { if (cuerpo.length && cuerpo[cuerpo.length - 1] !== '') cuerpo.push(''); continue; }
    if (consumidas < 2 && (s === meta.titulo || s.replace(/^\(|\)$/g, '') === meta.artista)) { consumidas++; continue; }
    let m;
    if ((m = s.match(/^tono\s*:\s*(\S+)/i))) { meta.tono = m[1]; continue; }
    if ((m = s.match(/^(?:capo(?:traste)?|cejilla)\D*(\d+)/i))) { meta.cejilla = m[1]; continue; }
    if ((m = s.match(/^composici[oó]n(?: de)?\s*:\s*(.+)$/i))) { meta.compositor = m[1]; continue; }
    if (/^afina/i.test(s)) continue;
    if ((m = s.match(/^\[([^\]]+)\]\s*(.*)$/))) { cuerpo.push(`{seccion: ${m[1].trim()}}`); if (m[2] && esLineaAcordes(m[2])) cuerpo.push(m[2].split(/\s+/).map(t => CHORD_TOKEN.test(limpiarTok(t)) ? `[${limpiarTok(t)}]` : t).join(' ')); continue; }
    if ((m = s.match(/^(INTRO|CORO|ESTROFA|VERSO|PUENTE|FINAL|PRE-?CORO|SOLO)\b[^a-z]*$/))) { cuerpo.push(`{seccion: ${s[0] + s.slice(1).toLowerCase()}}`); continue; }
    if ((m = s.match(/^(Intro(?: y Coro)?|Coro|Puente|Final|Solo)\s*:\s*(.*)$/i))) { cuerpo.push(`{seccion: ${m[1]}}`); if (m[2] && esLineaAcordes(m[2])) cuerpo.push(m[2].split(/\s+/).map(t => CHORD_TOKEN.test(limpiarTok(t)) ? `[${limpiarTok(t)}]` : t).join(' ')); continue; }
    if (esLineaAcordes(l)) {
      const sig = lineas[i + 1] || '';
      if (sig.trim() && !esLineaAcordes(sig) && !/^\s*\[/.test(sig)) { cuerpo.push(insertar(l, sig)); i++; continue; }
      cuerpo.push(l.trim().split(/\s+/).map(t => CHORD_TOKEN.test(limpiarTok(t)) ? `[${limpiarTok(t)}]` : t).join(' ')); continue;
    }
    if ((m = s.match(/^\/\/(.*)\/\/\s*(x\d)?\s*$/))) { cuerpo.push(m[1].trim() + '  (' + (m[2] || 'x2') + ')'); continue; }
    if (s.length <= 12 && cuerpo.length && cuerpo[cuerpo.length - 1] && !cuerpo[cuerpo.length - 1].startsWith('{') && /[a-záéíóúñ]/.test(cuerpo[cuerpo.length - 1])) { cuerpo[cuerpo.length - 1] += ' ' + s; continue; }
    cuerpo.push(l.trimEnd());
  }
  const cab = [];
  for (const [k, v] of Object.entries(meta)) if (v) cab.push(`{${k}: ${v}}`);
  cab.push('{estado: importada}', '');
  while (cuerpo.length && cuerpo[cuerpo.length - 1] === '') cuerpo.pop();
  return cab.concat(cuerpo).join('\n') + '\n';
}
