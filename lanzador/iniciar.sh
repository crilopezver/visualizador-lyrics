#!/bin/bash
# Arranca el servidor de Visualizador Lyrics en segundo plano (si no está ya corriendo)
# y abre el panel de la Mac en el navegador. Lo llama "Visualizador Lyrics.app" (ver crear_app.sh).
# También se puede correr a mano: ./lanzador/iniciar.sh
APP="$(cd "$(dirname "$0")/.." && pwd)"
PUERTO="${PUERTO:-8080}"
NODE="${NODE_BIN:-$(command -v node || echo /usr/local/bin/node)}"
LOG="/tmp/visualizador-lyrics.log"
vivo() { curl -s -m 1 "http://localhost:$PUERTO/api/info" >/dev/null 2>&1; }
if ! vivo; then
  cd "$APP" || exit 1
  # caffeinate -i: mientras el servidor corra, la Mac no entra en reposo por inactividad (pmset sleep 1: se dormía un minuto
  # después de apagar la pantalla y el servidor y la sincronización con la nube morían; pendiente 7e, 24-sep). La tapa cerrada
  # sigue durmiendo la Mac: en el toque, tapa abierta.
  nohup /usr/bin/caffeinate -i "$NODE" server/index.js >> "$LOG" 2>&1 &
  for i in $(seq 1 20); do vivo && break; sleep 0.25; done
fi
if vivo; then
  open "http://localhost:$PUERTO/mac"
else
  osascript -e 'display alert "Visualizador Lyrics" message "El servidor no arrancó. Revisa /tmp/visualizador-lyrics.log" as critical' >/dev/null 2>&1
  exit 1
fi
