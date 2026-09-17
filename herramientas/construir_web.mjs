// Construye la app publicable (Paper 13, parte 3): copia web/ a dist/ y fija en sw.js la versión de caché con la huella de los
// archivos, que en la Mac inyecta el servidor al vuelo. Vercel corre esto en cada despliegue (vercel.json).
// Uso: node herramientas/construir_web.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(RAIZ, 'web'), DIST = path.join(RAIZ, 'dist');
const VERSION = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).version;
const ARCHIVOS_APP = ['index.html', 'css/app.css', 'js/app.js', 'js/chordpro.js', 'js/datos.js', 'js/estado-comun.js', 'js/nube.js', 'js/nube.config.js', 'js/vendor/supabase.js', 'manifest.webmanifest', 'icono.svg', 'sw.js'];

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(WEB, DIST, { recursive: true, filter: p => !/mac\.html$/.test(p) }); // el panel de la Mac no se publica
const h = crypto.createHash('sha1'); for (const f of ARCHIVOS_APP) h.update(fs.readFileSync(path.join(WEB, f)));
const huella = h.digest('hex').slice(0, 10);
const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = 'v${VERSION}-${huella}';`);
fs.writeFileSync(path.join(DIST, 'sw.js'), sw);
console.log(`dist/ construido · versión de caché v${VERSION}-${huella}`);
