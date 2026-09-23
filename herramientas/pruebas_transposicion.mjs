// Pruebas del deletreo por grados y del tono deducido (Paper 15, 23-sep-2026). Uso: node herramientas/pruebas_transposicion.mjs
import { transponerAcorde, tonoTranspuesto, deducirTono } from '../web/js/chordpro.js';
const casos = [ // [tono origen, acordes, semitonos, tono esperado, acordes esperados]
  ['C', 'C F G7 Am', 1, 'Db', 'Db Gb Ab7 Bbm'],
  ['A', 'A D E7 F#m', 1, 'Bb', 'Bb Eb F7 Gm'],
  ['Gm', 'Gm Cm D7 F#dim', 1, 'G#m', 'G#m C#m D#7 Gdim'],
  ['Am', 'Am Dm E7 G#dim', -2, 'Gm', 'Gm Cm D7 F#dim'],
  ['Am', 'Am Bb E7', 2, 'Bm', 'Bm C F#7'],
  ['C', 'C Eb F Ab Bb', 2, 'D', 'D F G Bb C'],
  ['E', 'E A B7 C#m', 1, 'F', 'F Bb C7 Dm'],
  ['D', 'D G A7 Bm', -1, 'Db', 'Db Gb Ab7 Bbm'],
  ['F', 'F Bb C7 Dm', 1, 'Gb', 'Gb Cb Db7 Ebm'],
  ['Em', 'Em Am B7 D#dim', 1, 'Fm', 'Fm Bbm C7 Edim'],
  ['C', 'C/E G/B', 1, 'Db', 'Db/F Ab/C'],
  ['G', 'G C D7 Em', 0, 'G', 'G C D7 Em'],
];
let fallos = 0;
for (const [tono, acs, n, tonoEsp, acsEsp] of casos) {
  const t = tonoTranspuesto(tono, n); const out = acs.split(' ').map(a => transponerAcorde(a, n, t)).join(' ');
  const ok = t === tonoEsp && out === acsEsp; if (!ok) fallos++;
  console.log(`${ok ? 'OK ' : 'MAL'} ${tono.padEnd(3)} ${(n > 0 ? '+' : '') + n}  → ${t.padEnd(4)} ${out}${ok ? '' : `   (esperado ${tonoEsp} ${acsEsp})`}`);
}
// tono deducido: acordes de canciones reales sin {tono} (solo acordes, sin letra)
const cancion = acs => ({ secciones: [{ lineas: [{ segs: acs.map(a => ({ acorde: a, texto: 'x' })) }] }] });
const ded = [
  ['40 y 20 (José José)', ['Em', 'Am', 'B7', 'Em', 'D7', 'Gmaj7', 'Cmaj7', 'Am', 'B7', 'Em', 'E7', 'Am', 'F#7', 'B7', 'Em'], 'Em'],
  ['relativas, cadencia mayor', ['C', 'Am', 'F', 'G7', 'C'], 'C'],
  ['relativas, sensible de la menor', ['Am', 'F', 'G', 'E7', 'Am'], 'Am'],
  ['solo tónica y subdominante', ['G', 'C', 'G', 'C', 'G'], 'G'],
];
for (const [nombre, acs, esp] of ded) { const t = deducirTono(cancion(acs)); const ok = t === esp; if (!ok) fallos++; console.log(`${ok ? 'OK ' : 'MAL'} deducido ${t.padEnd(4)} ← ${nombre}${ok ? '' : ` (esperado ${esp})`}`); }
console.log(fallos ? `\n${fallos} fallo(s)` : '\ntodo OK'); process.exit(fallos ? 1 : 0);
