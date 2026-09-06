// Estado en vivo compartido por toda la banda. Un solo control del vivo a la vez.
export class Estado {
  constructor(almacen) {
    this.almacen = almacen;
    const guardado = almacen.leerEstado();
    this.vivo = guardado?.vivo || { cancion: null, seccion: 0, frac: 0 };
    this.siguiente = guardado?.siguiente || [];
    this.controlCantante = guardado?.controlCantante ?? false;
    this.conectados = new Map(); // ws -> {nombre, rol, instrumento}
  }
  persistir() {
    this.almacen.guardarEstado({ vivo: this.vivo, siguiente: this.siguiente, controlCantante: this.controlCantante });
  }
  snapshot() {
    return {
      vivo: this.vivo,
      siguiente: this.siguiente,
      controlCantante: this.controlCantante,
      conectados: [...this.conectados.values()].map(c => ({ nombre: c.nombre, rol: c.rol, instrumento: c.instrumento })),
    };
  }
  puedeMoverVivo(rol) { return rol === 'director' || (rol === 'cantante' && this.controlCantante); }
  puedeCola(rol) { return rol === 'director' || rol === 'cantante'; }

  // Devuelve true si el estado cambió.
  aplicar(msg, rol) {
    switch (msg.tipo) {
      case 'vivo': {
        if (!this.puedeMoverVivo(rol)) return false;
        if (msg.cancion !== undefined) { this.vivo.cancion = msg.cancion; this.vivo.seccion = 0; this.vivo.frac = 0; }
        if (typeof msg.seccion === 'number' && msg.seccion >= 0) { this.vivo.seccion = Math.floor(msg.seccion); this.vivo.frac = 0; }
        if (typeof msg.frac === 'number') this.vivo.frac = Math.max(0, Math.min(1, msg.frac));
        this.persistir(); return true;
      }
      case 'siguiente': {
        if (!this.puedeCola(rol)) return false;
        const { accion, cancion, indice, a } = msg;
        if (accion === 'agregar' && cancion) this.siguiente.push(cancion);
        else if (accion === 'quitar' && typeof indice === 'number') this.siguiente.splice(indice, 1);
        else if (accion === 'vaciar') this.siguiente = [];
        else if (accion === 'reemplazar' && Array.isArray(msg.canciones)) this.siguiente = msg.canciones.filter(Boolean);
        else if (accion === 'mover' && typeof indice === 'number' && typeof a === 'number') {
          const [x] = this.siguiente.splice(indice, 1); if (x) this.siguiente.splice(a, 0, x);
        } else if (accion === 'pasar') {
          // la primera de la cola pasa al vivo (solo quien puede mover el vivo)
          if (!this.puedeMoverVivo(rol) || !this.siguiente.length) return false;
          this.vivo = { cancion: this.siguiente.shift(), seccion: 0, frac: 0 };
        } else return false;
        this.persistir(); return true;
      }
      case 'control': {
        if (rol !== 'director') return false;
        this.controlCantante = !!msg.cantante; this.persistir(); return true;
      }
      default: return false;
    }
  }
}
