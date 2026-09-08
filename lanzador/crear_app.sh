#!/bin/bash
# Genera "Visualizador Lyrics.app" en la carpeta del proyecto (junto a datos/, fuera del repo):
# un ícono de doble clic que arranca el servidor sin Terminal y abre el panel de la Mac.
# Correr una sola vez (o de nuevo si se mueve la carpeta o cambia la ruta de node).
set -e
APP="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || echo /usr/local/bin/node)"
DESTINO="$APP/../Visualizador Lyrics.app"
chmod +x "$APP/lanzador/iniciar.sh"
osacompile -o "$DESTINO" -e "do shell script \"NODE_BIN='$NODE' '$APP/lanzador/iniciar.sh'\""
echo "Listo: $DESTINO"
