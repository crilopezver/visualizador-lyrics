// Reglas del estado en vivo (vivo, cola, historial, tono, control, propuestas), compartidas por el servidor y por cada celular.
// El servidor las aplica sobre el estado de la banda; el celular las aplica sobre su copia local cuando no hay conexión
// (Paper 13, fila 214: cada uno arma su cola sin conexión; al reconectar, la del cantante o del director pasa por aprobación).
// `st` es un objeto con: vivo, siguiente, historial, controlCantante, tonos, marca, propuestas. Devuelve true si cambió.

export const puedeMoverVivo = (st, rol) => rol === 'director' || (rol === 'cantante' && !!st.controlCantante);
export const puedeCola = rol => rol === 'director' || rol === 'cantante';
export const MAX_HISTORIAL = 50;

// La canción que sale del vivo entra al historial. Se llama ANTES de cambiar st.vivo.cancion.
export function recordarVivo(st) { if (st.vivo.cancion) { st.historial.push(st.vivo.cancion); if (st.historial.length > MAX_HISTORIAL) st.historial.shift(); } }
// Cada entrada al vivo (aunque sea la misma canción) sube `carga`: los clientes lo usan para volver al inicio.
export function ponerEnVivo(st, cancion, clienteId) { st.vivo = { cancion, seccion: 0, frac: 0, por: clienteId, carga: (st.vivo.carga || 0) + 1 }; }

export function aplicarMensaje(st, msg, rol, clienteId = null) {
  if (!Array.isArray(st.historial)) st.historial = [];
  if (!Array.isArray(st.siguiente)) st.siguiente = [];
  switch (msg.tipo) {
    case 'vivo': {
      if (!puedeMoverVivo(st, rol)) return false;
      st.vivo.por = clienteId; // quién movió: ese cliente ignora su propio eco
      if (msg.cancion !== undefined) { recordarVivo(st); ponerEnVivo(st, msg.cancion, clienteId); }
      if (typeof msg.seccion === 'number' && msg.seccion >= 0) { st.vivo.seccion = Math.floor(msg.seccion); st.vivo.frac = 0; }
      if (typeof msg.frac === 'number') st.vivo.frac = Math.max(0, Math.min(1, msg.frac));
      st.vivo.paso = ['seccion', 'pagina', 'lineas'].includes(msg.paso) ? msg.paso : 'deslizar';
      return true;
    }
    case 'siguiente': {
      if (!puedeCola(rol)) return false;
      const { accion, cancion, indice, a } = msg;
      if (accion === 'agregar' && cancion) { if (msg.donde === 'inicio') st.siguiente.unshift(cancion); else st.siguiente.push(cancion); }
      else if (accion === 'quitar' && typeof indice === 'number') st.siguiente.splice(indice, 1);
      else if (accion === 'vaciar') st.siguiente = [];
      else if (accion === 'reemplazar' && Array.isArray(msg.canciones)) st.siguiente = msg.canciones.filter(Boolean);
      else if (accion === 'mover' && typeof indice === 'number' && typeof a === 'number') {
        const [x] = st.siguiente.splice(indice, 1); if (x) st.siguiente.splice(a, 0, x);
      } else if (accion === 'pasar') {
        if (!puedeMoverVivo(st, rol) || !st.siguiente.length) return false;
        recordarVivo(st); ponerEnVivo(st, st.siguiente.shift(), clienteId);
      } else if (accion === 'anterior') {
        if (!puedeMoverVivo(st, rol) || !st.historial.length) return false;
        const previa = st.historial.pop();
        if (st.vivo.cancion) st.siguiente.unshift(st.vivo.cancion);
        ponerEnVivo(st, previa, clienteId);
      } else if (accion === 'vaciar-historial') {
        if (rol !== 'director') return false;
        st.historial = [];
      } else if (accion === 'historial') {
        // el historial del director manda al sincronizar (Cristhian, 17-sep): reemplaza el de la banda
        if (rol !== 'director' || !Array.isArray(msg.canciones)) return false;
        st.historial = msg.canciones.filter(Boolean).slice(-MAX_HISTORIAL);
      } else if (accion === 'proponer') {
        // cola armada sin conexión por el cantante o el director: queda como propuesta hasta que el director la apruebe
        if (!Array.isArray(msg.canciones)) return false;
        st.propuestas = st.propuestas || {};
        st.propuestas[rol] = { canciones: msg.canciones.filter(Boolean), quien: String(msg.quien || rol).slice(0, 40), por: clienteId, t: Date.now() };
      } else if (accion === 'resolver') {
        // solo el director: 'cantante' | 'director' → esa cola pasa a ser la compartida; 'ninguna' → se descartan las propuestas
        if (rol !== 'director') return false;
        const p = st.propuestas && st.propuestas[msg.elegir];
        if (p) st.siguiente = [...p.canciones];
        else if (msg.elegir !== 'ninguna') return false;
        st.propuestas = {};
      } else return false;
      return true;
    }
    case 'tono': {
      if (rol !== 'director' || typeof msg.cancion !== 'string') return false;
      const t = Math.max(-11, Math.min(11, Math.round(Number(msg.transp) || 0)));
      st.tonos = st.tonos || {};
      if (t === 0) delete st.tonos[msg.cancion]; else st.tonos[msg.cancion] = t;
      return true;
    }
    case 'marca': {
      if (typeof msg.seccion !== 'number') return false;
      st.marca = { seccion: Number(msg.seccion) || 0, linea: Number(msg.linea) || 0, palabra: Number(msg.palabra) || 0, todo: !!msg.todo, por: clienteId, quien: String(msg.quien || '').slice(0, 40), t: Date.now() };
      return true;
    }
    case 'control': {
      if (rol !== 'director') return false;
      st.controlCantante = !!msg.cantante; return true;
    }
    default: return false;
  }
}
