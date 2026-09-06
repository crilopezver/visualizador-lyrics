# Visualizador Lyrics

Letra con acordes **sincronizada en tiempo real** para una banda en vivo. Un servidor corre en la laptop del director dentro de la red local del toque (el hotspot de un celular basta); cada músico abre la app web en su teléfono o tablet y ve exactamente la canción y la sección que se está tocando. Sin internet, sin instalar nada.

## Qué hace (MVP)
- **En vivo:** el director (o el cantante, si el director lo habilita) elige la canción y avanza por secciones; todos los demás la siguen al instante.
- **Siguiente:** cola de canciones que director y cantante arman sin alterar lo que se está tocando.
- **Biblioteca y setlists:** canciones en formato ChordPro (`.cho`), setlists por fecha.
- **Vistas por instrumento:** letra grande (voz), letra + acordes (guitarra, bajo), estructura de secciones (percusión). Transposición y cejilla.
- **Sin red:** la app guarda las canciones en el teléfono; si la sincronía se cae, cada uno sigue por su cuenta y vuelve al vivo con un toque.
- **Modo escenario:** fondo negro, alto contraste, pantalla siempre encendida.

## Requisitos
Node 20 o superior en la laptop. Los celulares solo necesitan un navegador (Safari o Chrome).

## Arranque
```bash
npm install
npm start
```
El servidor imprime la dirección para abrir en los celulares (por ejemplo `http://172.20.10.2:8080`).

## Datos
La app lee las canciones de una carpeta **fuera del repositorio** (por defecto `../datos/`, o la ruta que indique la variable `DATOS`). Este repo solo trae `datos.ejemplo/` con una canción inventada para poder arrancar. **Las letras y acordes de canciones de terceros nunca se suben al repositorio.**

Estructura de la carpeta de datos:
```
datos/
├── canciones/    *.cho  (ChordPro: [Acorde]sílaba, {seccion: Coro}, {nota: ...})
├── setlists/     *.json
├── notas/        *.json (notas personales por usuario y canción)
├── usuarios.json (PINs de director y cantante)
└── estado.json   (estado en vivo, para recuperarse si el servidor se reinicia)
```

## Importadores
En `herramientas/` hay tres importadores en Python que convierten hojas reales a ChordPro: texto pegado (Cifra Club web, Word pegado), PDF por coordenadas (cancioneros con fuente proporcional) y Word `.docx` (acorde = negrita). Requieren `pdfplumber` para el de PDF.

## Licencia
MIT. El código es libre; las canciones son de sus autores.
