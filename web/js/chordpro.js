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
      else if (k === 'parte') { const [id, sec, t] = v.split('|').map(x => x.trim()); nueva(sec || ''); actual.parte = { id, seccion: sec || '', transp: Math.max(-11, Math.min(11, parseInt(t, 10) || 0)) }; } // {parte: id | sección | +2}: en el mix esa canción se toca 2 semitonos arriba (Cristhian, 11-sep)
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

// --- expandir: resuelve partes de otras canciones (mixes) y aplica el arreglo (orden con repeticiones) ---
// resolverParte(id, nombreSeccion) devuelve { nombre, lineas, titulo, tono } o null. Debe ser síncrono (las canciones ya cargadas).
export function nombresArreglo(cancion) {
  return String(cancion.meta.arreglo || '').split(',').map(x => x.trim()).filter(Boolean);
}
export function expandir(cancion, resolverParte = () => null) {
  const base = cancion.secciones.map(s => {
    if (!s.parte) return { ...s };
    const r = resolverParte(s.parte.id, s.parte.seccion);
    if (r) {
      const t = s.parte.transp || 0; let lineas = r.lineas, tono = r.tono || '';
      if (t) { // la parte se toca en otro tono dentro del mix: acordes transpuestos al expandir, la canción original no cambia
        tono = r.tono ? tonoTranspuesto(r.tono, t) : '';
        lineas = r.lineas.map(l => l.segs ? { ...l, segs: l.segs.map(g => ({ ...g, acorde: g.acorde ? transponerAcorde(g.acorde, t, tono) : '' })) } : l);
      }
      return { nombre: r.nombre || s.parte.seccion, lineas, origen: { id: s.parte.id, titulo: r.titulo, tono, tonoOriginal: r.tono || '', transp: t } };
    }
    return { nombre: s.parte.seccion, lineas: [{ tipo: 'nota', texto: `No encontré la sección "${s.parte.seccion}" en la canción "${s.parte.id}"` }], origen: { id: s.parte.id, titulo: s.parte.id, tono: '' } };
  });
  const arreglo = nombresArreglo(cancion);
  if (!arreglo.length) return base;
  const veces = {}; const out = [];
  for (const nombre of arreglo) {
    const s = base.find(x => (x.nombre || '').trim().toLowerCase() === nombre.toLowerCase());
    if (!s) { out.push({ nombre, lineas: [{ tipo: 'nota', texto: 'esta sección no existe en la canción' }] }); continue; }
    veces[nombre.toLowerCase()] = (veces[nombre.toLowerCase()] || 0) + 1;
    out.push({ ...s, vez: veces[nombre.toLowerCase()] });
  }
  return out;
}
const ORDINAL = n => n === 1 ? '' : `${n}ª vez`;
export function tituloSeccion(s, i) {
  const partes = [s.nombre || `Sección ${i + 1}`];
  if (s.vez > 1) partes.push(ORDINAL(s.vez));
  if (s.origen) partes.push(s.origen.titulo + (s.origen.tono ? ` · tono ${s.origen.tono}` + (s.origen.transp && s.origen.tonoOriginal ? ` (orig. ${s.origen.tonoOriginal})` : '') : (s.origen.transp ? ` · ${s.origen.transp > 0 ? '+' : ''}${s.origen.transp} st` : '')));
  return partes.join(' · ');
}

// --- transposición ---
const NOTAS_SOST = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTAS_BEM = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const INDICE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11, 'E#': 5, Fb: 4, 'B#': 0 };
// Deletreo por grados (Paper 15, 23-sep-2026): cada fundamental se escribe con la LETRA del grado que le corresponde en el
// tono destino más la alteración necesaria (nunca dobles). Mayor y menor comparten letras; en la menor, la sensible (11 st)
// y el 6.º elevado salen sostenidos aunque el tono sea de bemoles (Gm → F#dim), que es la única mezcla legítima.
const LETRAS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETRA_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const OFFSET_GRADO = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6]; // semitonos desde la tónica → letra del grado (I bII II bIII III IV #IV V bVI VI bVII VII)
const TONOS_MAYOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];      // nombres canónicos (Cristhian: Gb, no F#)
const TONOS_MENOR = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];      // por clase de nota desde C; + 'm' (Cristhian: Ebm, no D#m)
export function partirTono(tono) { // "Gm" → { pc: 7, letra: 'G', menor: true, sufijo: '' }; "Am7" → sufijo '7'
  const m = String(tono || '').trim().match(/^([A-G])(#|b)?\s*(m(?!aj))?(.*)$/i); if (!m) return null;
  const letra = m[1].toUpperCase(), pc = INDICE[letra + (m[2] || '')]; if (pc === undefined) return null;
  return { pc, letra, menor: !!m[3], sufijo: m[4] || '' };
}
export const nombreCanonico = (pc, menor) => menor ? TONOS_MENOR[pc] + 'm' : TONOS_MAYOR[pc];
const esTonoBemol = tono => { const k = partirTono(tono); return !!k && nombreCanonico(k.pc, k.menor).includes('b'); };
function deletrearEnTono(pc, tono) {
  const k = partirTono(tono); if (!k) return NOTAS_SOST[pc];
  const dist = ((pc - k.pc) % 12 + 12) % 12;
  const letra = LETRAS[(LETRAS.indexOf(k.letra) + OFFSET_GRADO[dist]) % 7];
  let alt = ((pc - LETRA_PC[letra]) % 12 + 12) % 12; if (alt > 6) alt -= 12;
  if (Math.abs(alt) <= 1) return letra + (alt === 1 ? '#' : alt === -1 ? 'b' : '');
  return (esTonoBemol(tono) ? NOTAS_BEM : NOTAS_SOST)[pc]; // saldría doble alteración: nombre enarmónico de la familia del tono
}
// `contexto`: el tono destino ("Gm") para deletrear por grados; o un booleano (bemoles sí/no) como antes, si no hay tono.
function transponerNota(nota, n, contexto) {
  const i = INDICE[nota]; if (i === undefined) return nota;
  const j = ((i + n) % 12 + 12) % 12;
  if (typeof contexto === 'string' && contexto) return deletrearEnTono(j, contexto);
  return (contexto === true ? NOTAS_BEM : NOTAS_SOST)[j];
}
export function transponerAcorde(acorde, n, contexto = '') {
  if (!n) return acorde; // a transposición 0 no se reescribe nada: la hoja original se respeta tal cual
  // conserva paréntesis, asterisco, cualidad y bajo: (D) Am7* C/E
  return acorde.replace(/([A-G](?:#|b)?)/g, (_, nota) => transponerNota(nota, n, contexto));
}
export function tonoTranspuesto(tono, n) {
  if (!tono) return '';
  const k = partirTono(tono); if (!k) return tono;
  if (!n) return tono; // a 0 se muestra como lo escribió la hoja
  return nombreCanonico(((k.pc + n) % 12 + 12) % 12, k.menor) + k.sufijo;
}
// Tono deducido (Paper 15; 472 de 655 hojas no traen {tono}): coincidencia de los acordes con los diatónicos de cada uno de los
// 24 tonos (mayor: I ii iii IV V vi vii°; menor: natural + V mayor y vii° de la armónica), ponderada por frecuencia. Desempate
// entre relativas (regla de Cristhian): si aparece la sensible de la menor —su V mayor— es menor, porque una mayor no altera su
// propio V; si aparece el V de la mayor y ningún V de la menor, es mayor; si no, deciden el primer y el último acorde.
const DIAT_MAYOR = [[0, 'M'], [2, 'm'], [4, 'm'], [5, 'M'], [7, 'M'], [9, 'm'], [11, 'dim']];
const DIAT_MENOR = [[0, 'm'], [2, 'dim'], [3, 'M'], [5, 'm'], [7, 'm'], [7, 'M'], [8, 'M'], [10, 'M'], [11, 'dim']];
export function calidadAcorde(acorde) { // 'M' | 'm' | 'dim' | null, de la fundamental sin bajo ni paréntesis
  const m = String(acorde || '').replace(/^\(|\)$/g, '').match(/^([A-G](?:#|b)?)(.*)$/); if (!m) return null;
  const pc = INDICE[m[1]]; if (pc === undefined) return null;
  const q = m[2].replace(/\/.*$/, '').replace(/\*/g, '');
  const cal = /^(dim|°|º|m7b5|ø)/.test(q) ? 'dim' : /^m(?!aj)/.test(q) ? 'm' : 'M';
  return { pc, cal };
}
export function deducirTono(cancion) {
  const acs = []; for (const s of cancion.secciones || []) for (const l of s.lineas || []) if (l.segs) for (const g of l.segs) if (g.acorde) acs.push(g.acorde);
  const L = acs.map(calidadAcorde).filter(Boolean); if (!L.length) return '';
  let mejor = null;
  for (let pc = 0; pc < 12; pc++) for (const menor of [false, true]) {
    const tabla = menor ? DIAT_MENOR : DIAT_MAYOR;
    const d = c => ((c.pc - pc) % 12 + 12) % 12;
    let p = 0; for (const c of L) if (tabla.some(([s, cal]) => s === d(c) && cal === c.cal)) p += 1;
    const vMenor = L.some(c => d(c) === (menor ? 7 : 4) && c.cal === 'M'); // V mayor de la menor (= III mayor de su relativa)
    const vMayor = L.some(c => d(c) === (menor ? 10 : 7) && c.cal === 'M'); // V de la mayor (= VII de su relativa menor)
    if (menor && vMenor) p += 2; else if (!menor && vMayor && !vMenor) p += 2;
    const tonica = c => d(c) === 0 && c.cal === (menor ? 'm' : 'M');
    if (tonica(L[0])) p += 1.5; if (tonica(L[L.length - 1])) p += 1.5;
    if (!mejor || p > mejor.p) mejor = { p, pc, menor };
  }
  return nombreCanonico(mejor.pc, mejor.menor);
}

// --- render ---
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Render de una línea: los trozos de una misma palabra viajan juntos (nunca se parte una palabra),
// aunque un acorde caiga a mitad de palabra o esté oculto en la vista de solo letra.
function renderLinea(segs, desplazamiento, bemoles, idxLinea = 0) {
  const piezas = [];
  for (const g of segs) {
    const ac = g.acorde ? transponerAcorde(g.acorde, desplazamiento, bemoles) : '';
    const partes = g.texto.split(/(\s+)/).filter((p, i) => p !== '' || i === 0);
    if (!partes.length) partes.push('');
    partes.forEach((p, i) => piezas.push({ ac: i === 0 ? ac : '', tx: p }));
  }
  let html = '', palabra = '', nPal = 0;
  const cerrar = () => { if (palabra) { html += `<span class="pal" data-l="${idxLinea}" data-p="${nPal++}">${palabra}</span>`; palabra = ''; } };
  piezas.forEach((p, i) => {
    if (/^\s+$/.test(p.tx)) { cerrar(); html += `<span class="esp">${p.tx}</span>`; return; }
    // "cola": acorde sin letra debajo (al final de la palabra o de la línea).
    // "antes-ac": el siguiente trozo de la misma palabra también trae acorde (vo[Gm]z[G7]): el acorde lleva aire a la derecha para no pegarse al siguiente.
    const sig = piezas[i + 1]; const antesAc = p.ac && sig && sig.ac && !/^\s+$/.test(sig.tx);
    palabra += `<span class="seg${p.ac && !p.tx ? ' cola' : ''}${antesAc ? ' antes-ac' : ''}"><span class="ac">${esc(p.ac)}</span><span class="tx">${esc(p.tx) || ' '}</span></span>`;
  });
  cerrar();
  return html;
}

export function renderCancion(cancion, opts = {}) {
  const { transp = 0, cejilla = 0, vista = 'acordes', seccionActual = 0 } = opts;
  const secciones = opts.secciones || cancion.secciones;
  const desplazamiento = transp - cejilla; // lo que ve el guitarrista con cejilla
  const bemoles = tonoTranspuesto(cancion.meta.tono || deducirTono(cancion), desplazamiento); // tono destino: contexto para deletrear por grados
  if (vista === 'estructura') {
    const items = secciones.map((s, i) => {
      const acs = []; let reps = '';
      for (const l of s.lineas) { if (l.segs) for (const g of l.segs) if (g.acorde) acs.push(transponerAcorde(g.acorde, desplazamiento, bemoles)); if (l.rep) reps = l.rep; }
      const notas = s.lineas.filter(l => l.tipo === 'nota').map(l => `<div class="nota">${esc(l.texto)}</div>`).join('');
      const unicos = [...new Set(acs)].slice(0, 8).join(' ');
      return `<li class="${i === seccionActual ? 'actual' : ''}" data-sec="${i}"><div><div>${esc(tituloSeccion(s, i))}${reps ? `<span class="rep">${esc(reps)}</span>` : ''}</div>${notas}</div><div class="acs">${esc(unicos)}</div></li>`;
    });
    return `<ol class="estructura">${items.join('')}</ol>`;
  }
  return secciones.map((s, i) => {
    const lineas = s.lineas.map((l, k) => {
      if (l.tipo === 'vacia') return '<div class="linea">&nbsp;</div>';
      if (l.tipo === 'nota') return `<div class="nota">${esc(l.texto)}</div>`;
      const html = renderLinea(l.segs, desplazamiento, bemoles, k);
      return `<div class="linea ${l.tipo === 'acordes' ? 'solo-acordes' : ''}" data-l="${k}">${html}${l.rep ? `<span class="rep">(${esc(l.rep)})</span>` : ''}</div>`;
    }).join('');
    const nombre = (s.nombre || s.vez > 1 || s.origen) ? `<div class="nombre">${esc(tituloSeccion(s, i)).replace(/ · tono (.+)$/, (_, t) => ` · tono <span class="tono">${t}</span>`)}</div>` : ''; // el tono conserva su minúscula (Am, no AM)
    return `<div class="seccion ${i === seccionActual ? 'actual' : ''}" data-sec="${i}">${nombre}${lineas}</div>`;
  }).join('');
}

// --- columnas → ChordPro (importador por pegado; puerto del prototipo Python) ---
// ø / Ø = semidisminuido (Bø, Bø7; Cristhian, 09-sep, fila 116); ° / º = disminuido; colas b5 / #5 / #11… (Bm7b5) como en el prototipo Python
const CHORD_TOKEN = /^\(?[A-G](?:#|b)?(?:maj|min|dim|aug|sus|add|m|M|\+|°|º|ø|Ø)?\d*(?:\([^)]*\))?(?:sus\d|add\d|maj\d|b\d+|#\d+)*(?:\/[A-G](?:#|b)?)?\*?\)?$/;
const TOKENS_OK = new Set(['|', '||', 'x2', 'x3', 'x4', '(x2)', '(x3)', '(x4)', '*', '-', '–', 'N.C.', 'Riff', 'riff', '(Riff)', '(riff)', 'bis', 'Bis', '(bis)', '(Bis)']); // anotaciones que pueden acompañar a una línea de acordes sin convertirla en letra (Riff/bis: Cristhian, fila 117)
const limpiarTok = t => t.replace(/^[….·:]+|[….·:\-–]+$/g, ''); // 'Eb-' → 'Eb': el guion pegado no indica menor en las hojas vistas (08-sep)
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
const ROMANOS = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
// opts.cejilla: cejilla de la hoja escrita por el director ('' = detectar; 0 = ninguna). opts.info recibe lo detectado.
export function textoAChordPro(texto, { titulo = '', artista = '', cejilla = '', info = {} } = {}) {
  // limpieza: caracteres invisibles o de relleno que llegan al pegar desde PDF/web; líneas sin letras ni números se descartan
  texto = texto.replace(/\r/g, '').replace(/[\uFFFC\uFFFD\u200B-\u200F\uFEFF]/g, '').replace(/\u00A0/g, ' ').replace(/\t/g, '        ');
  const lineas = texto.split('\n').map(l => /[A-Za-zÀ-ÿ0-9]/.test(l) ? l : '');
  const cuerpo = [];
  const noVacias = lineas.filter(l => l.trim());
  // título y artista tal como vienen en el texto (para no dejarlos como letra), aunque el director los cambie
  const tituloTexto = noVacias[0] && !esLineaAcordes(noVacias[0]) && !/^\s*\[/.test(noVacias[0]) ? noVacias[0].trim() : '';
  const artistaLinea = tituloTexto && noVacias[1] && !esLineaAcordes(noVacias[1]) && !/^\s*(tono|afina|composi|capo|\[)/i.test(noVacias[1]) ? noVacias[1].trim() : '';
  // "(Jose Jose) III": artista entre paréntesis y cejilla en romanos (convención Ritmolatino, Paper 03)
  let artistaTexto = '', cejillaRomana = 0;
  if (artistaLinea) {
    let a = artistaLinea;
    const r = a.match(/^(.*?)[\s(]*\b(I{1,3}|IV|V|VI{1,3}|IX|X|XI|XII)\)?\s*$/);
    if (r && r[1].trim()) { a = r[1]; cejillaRomana = ROMANOS[r[2]] || 0; }
    artistaTexto = a.trim().replace(/^\((.*)\)$/, '$1').replace(/^\(|\)$/g, '').trim();
  }
  const meta = { titulo: titulo || tituloTexto, artista: artista || artistaTexto };
  let consumidas = 0;
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].replace(/\(\s*([^()\s]+)\s*\)/g, '($1)'), s = l.trim();
    if (!s) { if (cuerpo.length && cuerpo[cuerpo.length - 1] !== '') cuerpo.push(''); continue; }
    if (consumidas < 2 && ((tituloTexto && s === tituloTexto) || (artistaLinea && s === artistaLinea))) { consumidas++; continue; }
    let m;
    if ((m = s.match(/^tono\s*:\s*(\S+)/i))) { meta.tono = m[1]; continue; }
    if ((m = s.match(/^(?:capo(?:traste)?|cejilla)\D*(\d+)/i))) { meta.cejilla = m[1]; continue; }
    if ((m = s.match(/^composici[oó]n(?: de)?\s*:\s*(.+)$/i))) { meta.compositor = m[1]; continue; }
    if (/^afina/i.test(s)) continue;
    if ((m = s.match(/^\[([^\]]+)\]\s*(.*)$/))) { cuerpo.push(`{seccion: ${m[1].trim()}}`); if (m[2] && esLineaAcordes(m[2])) cuerpo.push(m[2].split(/\s+/).map(t => CHORD_TOKEN.test(limpiarTok(t)) ? `[${limpiarTok(t)}]` : t).join(' ')); continue; }
    if ((m = s.match(/^(INTRO|CORO|ESTROFA|VERSO|PUENTE|FINAL|PRE-?CORO|SOLO)\b[^a-z]*$/))) { cuerpo.push(`{seccion: ${s[0] + s.slice(1).toLowerCase()}}`); continue; }
    if ((m = s.match(/^(Intro(?: y Coro)?|Coro|Puente|Final|Solo)\s*:\s*(.*)$/i))) { cuerpo.push(`{seccion: ${m[1]}}`); if (m[2] && esLineaAcordes(m[2])) cuerpo.push(m[2].split(/\s+/).map(t => CHORD_TOKEN.test(limpiarTok(t)) ? `[${limpiarTok(t)}]` : t).join(' ')); continue; }
    if ((m = s.match(/^(Intro|Coro|Puente|Final|Solo|Pre-?coro|Estrofa(?: \d+)?|Verso(?: \d+)?)\s+(.+)$/i)) && esLineaAcordes(m[2])) { // rótulo sin dos puntos + acordes
      cuerpo.push(`{seccion: ${m[1][0].toUpperCase() + m[1].slice(1)}}`); cuerpo.push(m[2].split(/\s+/).map(t => CHORD_TOKEN.test(limpiarTok(t)) ? `[${limpiarTok(t)}]` : t).join(' ')); continue;
    }
    if (esLineaAcordes(l)) {
      const sig = lineas[i + 1] || '';
      if (sig.trim() && !esLineaAcordes(sig) && !/^\s*\[/.test(sig)) { cuerpo.push(insertar(l, sig)); i++; continue; }
      cuerpo.push(l.trim().split(/\s+/).map(t => CHORD_TOKEN.test(limpiarTok(t)) ? `[${limpiarTok(t)}]` : t).join(' ')); continue;
    }
    if ((m = s.match(/^\/\/(.*)\/\/\s*(x\d)?\s*$/))) { cuerpo.push(m[1].trim() + '  (' + (m[2] || 'x2') + ')'); continue; }
    if (s.length <= 12 && cuerpo.length && cuerpo[cuerpo.length - 1] && !cuerpo[cuerpo.length - 1].startsWith('{') && /[a-záéíóúñ]/.test(cuerpo[cuerpo.length - 1])) { cuerpo[cuerpo.length - 1] += ' ' + s; continue; }
    cuerpo.push(l.trimEnd());
  }
  // cejilla de la hoja: los acordes vienen como posiciones con cejilla; el archivo guarda los acordes reales (subidos N semitonos)
  const cej = cejilla !== '' && cejilla !== null && cejilla !== undefined ? Number(cejilla) || 0 : (cejillaRomana || Number(meta.cejilla) || 0);
  info.cejillaDetectada = cejillaRomana || Number(meta.cejilla) || 0; info.cejillaAplicada = cej;
  delete meta.cejilla;
  if (cej > 0) {
    const primero = (cuerpo.join('\n').match(/\[([A-G](?:#|b)?)(m(?!aj))?/) || []);
    if (!meta.tono && primero[1]) meta.tono = primero[1] + (primero[2] || '');
    if (meta.tono) meta.tono = tonoTranspuesto(meta.tono, cej);
    for (let i = 0; i < cuerpo.length; i++) if (!/^\{/.test(cuerpo[i])) cuerpo[i] = cuerpo[i].replace(/\[([^\]]+)\]/g, (_, a) => `[${transponerAcorde(a, cej, meta.tono || '')}]`);
    meta.fuente = `hoja con cejilla en el traste ${cej}; acordes subidos ${cej} semitono${cej > 1 ? 's' : ''}`;
  }
  const cab = [];
  for (const [k, v] of Object.entries(meta)) if (v) cab.push(`{${k}: ${v}}`);
  const hoy = new Date(); const fechaLocal = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`; // fecha local, no UTC (a las 21:00 de Lima ya es mañana en UTC)
  cab.push(`{importada: ${fechaLocal}}`); // fecha de importación (Cristhian, 09-sep, pendiente 0k)
  cab.push('{estado: importada}', '');
  while (cuerpo.length && cuerpo[cuerpo.length - 1] === '') cuerpo.pop();
  return cab.concat(cuerpo).join('\n') + '\n';
}

// --- hoja ⇄ cuerpo: para editar un bloque como texto (acordes sobre la letra, alineados por columnas; Cristhian, 11-sep) ---
// Una línea del archivo ("nues[Dm]tro amor") → filas de hoja: "     Dm" sobre "nuestro amor". Y al revés con la regla del importador.
export function lineaAHoja(raw) {
  const acordes = []; let letra = ''; const re = /\[([^\]]*)\]/g; let ultimo = 0, m;
  while ((m = re.exec(raw))) { letra += raw.slice(ultimo, m.index); acordes.push({ col: letra.length, texto: m[1] }); ultimo = re.lastIndex; }
  letra += raw.slice(ultimo);
  if (!acordes.length) return [letra];
  const fin = letra.trimEnd().length; letra = letra.trimEnd();
  let fila = '';
  for (const a of acordes) { let col = Math.min(a.col, fin); if (fila.length && col < fila.length + 1) col = fila.length + 1; fila = fila.padEnd(col) + a.texto; }
  // si lo que queda de texto son solo marcas (x2, bis, |…), van en la misma fila de acordes
  const resto = letra.trim();
  if (resto && resto.split(/\s+/).every(t => TOKENS_OK.has(t))) return [fila + ' ' + resto];
  return resto ? [fila, letra] : [fila];
}
export function esFilaAcordes(l) { return esLineaAcordes(l); }
export function hojaACuerpo(filas) { // filas de texto (sin marcas) → líneas del archivo
  const out = [];
  for (let i = 0; i < filas.length; i++) {
    const l = filas[i];
    if (!l.trim()) { out.push(''); continue; }
    if (esLineaAcordes(l)) {
      const sig = filas[i + 1] || '';
      if (sig.trim() && !esLineaAcordes(sig)) { out.push(insertar(l, sig)); i++; continue; }
      out.push(l.trim().split(/\s+/).map(t => CHORD_TOKEN.test(limpiarTok(t)) ? `[${limpiarTok(t)}]` : t).join(' ')); continue;
    }
    out.push(l);
  }
  return out;
}
// tokens de una fila que parecen acorde pero no lo son (para avisar antes de guardar): p. ej. "Sim", "Am77"
export function tokensDudosos(fila) {
  if (esLineaAcordes(fila)) return [];
  const toks = fila.trim().split(/\s+/); const ok = toks.filter(t => CHORD_TOKEN.test(limpiarTok(t)));
  if (toks.length >= 2 && ok.length >= Math.ceil(toks.length / 2)) return toks.filter(t => !CHORD_TOKEN.test(limpiarTok(t)) && !TOKENS_OK.has(t));
  return [];
}

// --- eliminar una sección completa (marca + letra + acordes) desde el editor de Secciones ---
// indiceLinea: línea del archivo con la marca {seccion: X}. Borra hasta la siguiente marca de sección o parte.
// Si ese nombre ya no existe en ninguna otra sección, también sale del {arreglo}.
export function eliminarSeccion(cho, indiceLinea) {
  const L = cho.replace(/\r/g, '').split('\n');
  const RE_S = /^\{\s*secci[oó]n\s*:\s*(.*?)\s*\}\s*$/i, RE_P = /^\{\s*parte\s*:/i;
  const m = (L[indiceLinea] || '').match(RE_S); if (!m) return cho;
  const nombre = m[1];
  let j = indiceLinea + 1; while (j < L.length && !RE_S.test(L[j]) && !RE_P.test(L[j])) j++;
  L.splice(indiceLinea, j - indiceLinea);
  for (let k = L.length - 1; k > 0; k--) if (!L[k].trim() && !L[k - 1].trim()) L.splice(k, 1); // sin dobles vacías
  const quedan = new Set(L.map(l => (l.match(RE_S) || [])[1]).filter(Boolean));
  let out = L.join('\n');
  const a = out.match(/^\{\s*arreglo\s*:\s*(.*?)\s*\}\s*$/im);
  if (a && nombre && !quedan.has(nombre)) {
    const arr = a[1].split(',').map(x => x.trim()).filter(x => x && x !== nombre);
    out = out.replace(/^\{\s*arreglo\s*:.*\}\s*$\n?/im, arr.length ? `{arreglo: ${arr.join(', ')}}\n` : '');
  }
  return out;
}

// --- palabras de una línea cruda del archivo: {ini, fin, texto}; ini incluye los acordes pegados delante de la palabra ---
export function palabrasCrudas(raw) {
  const out = []; let i = 0; const n = raw.length; let enPalabra = false, iniPal = 0, texto = '', bracketPrevio = null;
  while (i < n) {
    const ch = raw[i];
    if (ch === '[') { const j = raw.indexOf(']', i); const cierre = j < 0 ? n - 1 : j; if (!enPalabra && bracketPrevio === null) bracketPrevio = i; i = cierre + 1; continue; }
    if (/\s/.test(ch)) { if (enPalabra) { out.push({ ini: iniPal, fin: i, texto }); enPalabra = false; texto = ''; } bracketPrevio = null; i++; continue; }
    if (!enPalabra) { enPalabra = true; iniPal = bracketPrevio !== null ? bracketPrevio : i; texto = ''; }
    texto += ch; i++;
  }
  if (enPalabra) out.push({ ini: iniPal, fin: n, texto });
  return out;
}

// --- eliminar un tramo de letra (con sus acordes) entre dos palabras: a = {i, w} primera, b = {i, w} última (i = línea del archivo, w = palabra) ---
// Las marcas {seccion}, {nota}, etc. dentro del tramo se conservan; las líneas de letra que quedan vacías se quitan.
export function eliminarTramo(cho, a, b) {
  const L = cho.replace(/\r/g, '').split('\n');
  if (!L[a.i] || !L[b.i]) return cho;
  const pa = palabrasCrudas(L[a.i]), pb = palabrasCrudas(L[b.i]);
  if (!pa[a.w] || !pb[b.w]) return cho;
  const tocadas = new Set();
  if (a.i === b.i) { L[a.i] = (L[a.i].slice(0, pa[a.w].ini) + ' ' + L[a.i].slice(pb[b.w].fin)).replace(/\s{2,}/g, ' ').trim(); tocadas.add(a.i); }
  else {
    L[a.i] = L[a.i].slice(0, pa[a.w].ini).trimEnd(); tocadas.add(a.i);
    L[b.i] = L[b.i].slice(pb[b.w].fin).trimStart(); tocadas.add(b.i);
    for (let k = a.i + 1; k < b.i; k++) if (!/^\s*\{/.test(L[k])) { L[k] = ''; tocadas.add(k); }
  }
  const out = [];
  for (let k = 0; k < L.length; k++) {
    if (tocadas.has(k) && !L[k].trim()) continue; // línea de letra que quedó vacía
    if (!L[k].trim() && out.length && !out[out.length - 1].trim()) continue; // sin dobles vacías
    out.push(L[k]);
  }
  return out.join('\n');
}

