// Estado en vivo compartido por toda la banda. Un solo control del vivo a la vez.
// Las reglas viven en web/js/estado-comun.js, compartidas con el celular (que las aplica sobre su copia sin conexión).
import { aplicarMensaje, puedeMoverVivo, puedeCola } from '../web/js/estado-comun.js';

export class Estado {
  constructor(almacen) {
    this.almacen = almacen;
    const guardado = almacen.leerEstado();
    this.vivo = guardado?.vivo || { cancion: null, seccion: 0, frac: 0 };
    this.siguiente = guardado?.siguiente || [];
    this.historial = guardado?.historial || []; // canciones ya tocadas en el vivo (la más reciente al final)
    this.controlCantante = guardado?.controlCantante ?? false;
    this.tonos = guardado?.tonos || {}; // tono de la banda por canción: semitonos respecto al original (decide el director)
    this.propuestas = guardado?.propuestas || {}; // colas armadas sin conexión (cantante / director) pendientes de aprobación del director
    this.conectados = new Map(); // ws -> {nombre, rol, instrumento}
  }
  persistir() {
    this.almacen.guardarEstado({ vivo: this.vivo, siguiente: this.siguiente, historial: this.historial, controlCantante: this.controlCantante, tonos: this.tonos, propuestas: this.propuestas });
  }
  snapshot() {
    return {
      vivo: this.vivo,
      siguiente: this.siguiente,
      historial: this.historial,
      controlCantante: this.controlCantante,
      tonos: this.tonos,
      propuestas: this.propuestas,
      marca: this.marca && Date.now() - this.marca.t < 6000 ? this.marca : null,
      conectados: [...this.conectados.values()].map(c => ({ nombre: c.nombre, rol: c.rol, instrumento: c.instrumento })),
    };
  }
  // una canción borrada sale del vivo, de la cola y del historial
  quitarCancion(id) {
    let cambio = false;
    if (this.vivo.cancion === id) { this.vivo = { cancion: null, seccion: 0, frac: 0, carga: (this.vivo.carga || 0) + 1 }; cambio = true; }
    const n1 = this.siguiente.length; this.siguiente = this.siguiente.filter(c => c !== id); if (this.siguiente.length !== n1) cambio = true;
    const n2 = this.historial.length; this.historial = this.historial.filter(c => c !== id); if (this.historial.length !== n2) cambio = true;
    if (cambio) this.persistir(); return cambio;
  }
  puedeMoverVivo(rol) { return puedeMoverVivo(this, rol); }
  puedeCola(rol) { return puedeCola(rol); }
  // Devuelve true si el estado cambió.
  aplicar(msg, rol, clienteId = null) {
    const ok = aplicarMensaje(this, msg, rol, clienteId);
    if (ok && msg.tipo !== 'marca') this.persistir(); // la marca "estamos aquí" no se persiste, solo se difunde
    return ok;
  }
}
