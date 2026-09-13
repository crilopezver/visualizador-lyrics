// Hoja de Cifra Club (HTML descargado) → texto plano sin tablaturas → importador de la app (textoAChordPro) → .cho
// Uso: node cifra_a_cho.mjs archivo.html [salida.cho]   (sesión 5, 12-sep-2026; no contiene letras)
import fs from 'node:fs';
import { textoAChordPro } from '/Users/cristhianlopez/Claude/Projects/Visualizador Lyrics/app/web/js/chordpro.js';

const [html, salida] = process.argv.slice(2);
const h = fs.readFileSync(html, 'utf8');
const titulo = (h.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const [t, artista] = titulo.replace(/\s*-\s*Cifra Club.*$/, '').split(/\s+-\s+/);
let pre = (h.match(/<pre[^>]*>([\s\S]*?)<\/pre>/) || [])[1] || '';
for (let k = 0; k < 6; k++) pre = pre.replace(/<span class="tab">(?:(?!<span)[\s\S])*?<\/span>\s*/g, ''); // tablaturas (spans anidados)
pre = pre.replace(/<span class="tabs">\s*<\/span>\s*/g, '').replace(/<span class="tabs">(?:(?!<span)[\s\S])*?<\/span>\s*/g, '');
pre = pre.replace(/<\/div>/g, '').replace(/<[^>]+>/g, '');                    // resto de etiquetas
pre = pre.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
pre = pre.split('\n').filter(l => !/^\s*[EADGBe]\|[-0-9hpb/~x|]+/.test(l)).join('\n'); // líneas sueltas de tab (E|---)
// --acordes-abajo: la hoja pone la fila de acordes DEBAJO de su letra (Los patos y las patas); se sube encima para el importador
if (process.argv.includes('--acordes-abajo')) {
  const esAc = l => l.trim() && l.trim().split(/\s+/).every(t => /^[A-G][#b]?(m|maj7|7M|m7|7|sus[24]|dim|aug|add9|[5690])*(\/[A-G][#b]?)?$/.test(t));
  const L = pre.split('\n'), out = [];
  for (const l of L) {
    if (esAc(l)) { let j = out.length - 1; while (j >= 0 && !out[j].trim()) j--; if (j >= 0 && !esAc(out[j])) { out.splice(j, 0, l); continue; } }
    out.push(l);
  }
  pre = out.join('\n');
}
const cho = textoAChordPro(pre, { titulo: t.trim(), artista: (artista || '').trim() });
if (salida) fs.writeFileSync(salida, cho);
process.stdout.write(cho);
