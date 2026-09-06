// Almacén de datos: carpeta con archivos .cho (canciones) y .json (setlists, notas, usuarios, estado).
// La carpeta vive FUERA del repo. Nunca contiene código; nunca se versiona.
import fs from 'node:fs';
import path from 'node:path';

const META_RE = /^\{\s*([a-záéíóúñ_]+)\s*:\s*(.*?)\s*\}\s*$/i;

export class Almacen {
  constructor(raiz) {
    this.raiz = raiz;
    for (const sub of ['canciones', 'setlists', 'notas']) fs.mkdirSync(path.join(raiz, sub), { recursive: true });
    const usuarios = path.join(raiz, 'usuarios.json');
    if (!fs.existsSync(usuarios)) {
      fs.writeFileSync(usuarios, JSON.stringify({ director: { pin: '1234' }, cantante: { pin: '0000' } }, null, 2));
      console.log('Creado usuarios.json con PINs por defecto (director 1234, cantante 0000). Cámbialos.');
    }
  }
  // --- canciones ---
  dirCanciones() { return path.join(this.raiz, 'canciones'); }
  idValido(id) { return /^[a-z0-9][a-z0-9_-]{0,120}$/.test(id); }
  leerMeta(cho) {
    const meta = {};
    for (const linea of cho.split('\n').slice(0, 30)) {
      const m = linea.match(META_RE);
      if (m) meta[m[1].toLowerCase()] = m[2];
    }
    return meta;
  }
  indiceCanciones() {
    const dir = this.dirCanciones();
    return fs.readdirSync(dir).filter(f => f.endsWith('.cho')).sort().map(f => {
      const id = f.slice(0, -4);
      const cho = fs.readFileSync(path.join(dir, f), 'utf8');
      const meta = this.leerMeta(cho);
      return { id, titulo: meta.titulo || id, artista: meta.artista || '', tono: meta.tono || '', cejilla: meta.cejilla || '', estado: meta.estado || '' };
    });
  }
  leerCancion(id) {
    if (!this.idValido(id)) return null;
    const ruta = path.join(this.dirCanciones(), id + '.cho');
    return fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : null;
  }
  guardarCancion(id, cho) {
    if (!this.idValido(id)) throw new Error('id inválido');
    fs.writeFileSync(path.join(this.dirCanciones(), id + '.cho'), cho, 'utf8');
  }
  crearCancion(cho) {
    const meta = this.leerMeta(cho);
    const base = (meta.titulo || 'sin-titulo').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cancion';
    let id = base, n = 2;
    while (fs.existsSync(path.join(this.dirCanciones(), id + '.cho'))) id = `${base}-${n++}`;
    this.guardarCancion(id, cho);
    return id;
  }
  // --- json genérico ---
  leerJson(rel, porDefecto) {
    const ruta = path.join(this.raiz, rel);
    try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return porDefecto; }
  }
  guardarJson(rel, obj) {
    const ruta = path.join(this.raiz, rel);
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, JSON.stringify(obj, null, 2), 'utf8');
  }
  // --- setlists ---
  indiceSetlists() {
    const dir = path.join(this.raiz, 'setlists');
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
      const s = this.leerJson(path.join('setlists', f), {});
      return { id: f.slice(0, -5), nombre: s.nombre || f.slice(0, -5), fecha: s.fecha || '', n: (s.canciones || []).length };
    }).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  }
  leerSetlist(id) { return this.idValido(id) ? this.leerJson(path.join('setlists', id + '.json'), null) : null; }
  guardarSetlist(id, setlist) {
    if (!this.idValido(id)) throw new Error('id inválido');
    this.guardarJson(path.join('setlists', id + '.json'), { nombre: setlist.nombre || id, fecha: setlist.fecha || '', canciones: setlist.canciones || [] });
  }
  // --- notas personales: notas/<usuario>.json = { cancionId: texto } ---
  usuarioValido(u) { return /^[\p{L}\p{N} _.-]{1,40}$/u.test(u); }
  leerNota(usuario, cancion) {
    if (!this.usuarioValido(usuario)) return '';
    const todas = this.leerJson(path.join('notas', usuario.toLowerCase() + '.json'), {});
    return todas[cancion] || '';
  }
  guardarNota(usuario, cancion, texto) {
    if (!this.usuarioValido(usuario) || !this.idValido(cancion)) throw new Error('inválido');
    const rel = path.join('notas', usuario.toLowerCase() + '.json');
    const todas = this.leerJson(rel, {});
    if (texto && texto.trim()) todas[cancion] = texto; else delete todas[cancion];
    this.guardarJson(rel, todas);
  }
  // --- usuarios y estado ---
  usuarios() { return this.leerJson('usuarios.json', { director: { pin: '1234' }, cantante: { pin: '0000' } }); }
  leerEstado() { return this.leerJson('estado.json', null); }
  guardarEstado(e) { this.guardarJson('estado.json', e); }
}
