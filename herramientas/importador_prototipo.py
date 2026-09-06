#!/usr/bin/env python3
"""Prototipo del importador — Visualizador Lyrics (Pueblerinos). 05-sep-2026.
Convierte hojas "acordes arriba / letra abajo" (Cifra Club, Ritmolatino, Word pegado) a ChordPro
con acordes anclados a la sílaba: [A]letra. No contiene letras: solo el algoritmo.

Uso: python3 importador_prototipo.py entrada.txt salida.cho [--titulo T] [--artista A]
     o importar y llamar convertir(texto) -> str
"""
import re, sys

# --- Detección de acordes (cifrado americano) -------------------------------
RAIZ = r"[A-G](?:#|b)?"
CUAL = r"(?:maj|min|dim|aug|sus|add|m|M|\+|°|º)?"
CHORD = re.compile(rf"^\(?{RAIZ}{CUAL}\d*(?:\([^)]*\))?(?:sus\d|add\d|maj\d|b\d|#\d)*(?:/{RAIZ})?\*?\)?$")
TOKENS_OK = {"|", "||", "x2", "x3", "x4", "(x2)", "(x3)", "(x4)", "*", "-", "–", "…", "...", "N.C."}

def limpiar_token(t):
    return t.strip("….·:")   # "Am………." -> "Am"

def es_linea_acordes(linea):
    toks = [limpiar_token(t) for t in linea.split()]
    toks = [t for t in toks if t]
    if not toks: return False
    return all(CHORD.match(t) or t in TOKENS_OK for t in toks)

def normalizar_parentesis(linea):
    # "( D )" -> "(D)" conservando la columna del primer paréntesis
    return re.sub(r"\(\s*([^()\s]+)\s*\)", r"(\1)", linea)

# --- Secciones, metadatos, repeticiones -------------------------------------
SECCION_CORCHETE = re.compile(r"^\s*\[([^\]]+)\]\s*(.*)$")
SECCION_MAYUS = re.compile(r"^\s*(INTRO|CORO|ESTROFA|VERSO|PUENTE|FINAL|PRE-?CORO|SOLO|OUTRO)\b[^a-z]*$")
SECCION_DOSPUNTOS = re.compile(r"^\s*(Intro(?: y Coro)?|Coro|Puente|Final|Solo)\s*:\s*(.*)$", re.I)
META = {
    "tono": re.compile(r"^\s*Tono\s*:\s*(\S+)", re.I),
    "cejilla": re.compile(r"^\s*(?:Capo(?:traste)?|Cejilla)\s*[:\s]\s*(?:na\s*)?(\d+)", re.I),
    "compositor": re.compile(r"^\s*Composici[oó]n(?: de)?\s*:\s*(.+)$", re.I),
    "afinacion": re.compile(r"^\s*Afina[cç](?:i[oó]n|[aã]o)\s*:\s*(.+)$", re.I),
}
CEJILLA_ROMANA = re.compile(r"\bC(I{1,3}|IV|V|VI{0,3}|IX|X)\b")
ROMANOS = {"I":1,"II":2,"III":3,"IV":4,"V":5,"VI":6,"VII":7,"VIII":8,"IX":9,"X":10}
REPETICION = re.compile(r"^//(.*)//\s*(x\d)?\s*$")
BASURA = re.compile(r"^\s*(ir a (video|tutorial)|rasgueo|arpegio|intro|tema|variaci[oó]n|cd-\d+|\d{1,3}|[\dx\s\|\-]+)\s*$", re.I)

def insertar_acordes(acordes, letra):
    """Inserta [acorde] en la posición de columna de cada acorde sobre la letra."""
    letra = letra.rstrip("\n")
    posiciones = [(m.start(), limpiar_token(m.group())) for m in re.finditer(r"\S+", acordes)]
    posiciones = [(c,a) for c,a in posiciones if a]
    salida, cursor = "", 0
    for col, ac in posiciones:
        if ac in TOKENS_OK and ac not in ("*",): continue
        if col > len(letra):
            # acorde más allá del fin de la letra: se cuelga al final
            salida += letra[cursor:] + " [" + ac + "]"
            cursor = len(letra); letra = letra  # nada más que copiar
            continue
        # ajustar para no partir una palabra por la mitad: si cae en medio de palabra, retroceder al inicio de la palabra? No: cae en la sílaba. Se respeta la columna.
        salida += letra[cursor:col] + "[" + ac + "]"
        cursor = col
    salida += letra[cursor:]
    return salida

def convertir(texto, titulo=None, artista=None):
    lineas = [l.rstrip("\n") for l in texto.splitlines()]
    meta = {"title": titulo, "artist": artista}
    cuerpo = []
    i = 0
    # metadatos al inicio (Cifra Club): título, artista en las 2 primeras líneas no vacías si no se dieron
    no_vacias = [l for l in lineas if l.strip()]
    if not titulo and no_vacias: meta["title"] = no_vacias[0].strip()
    if not artista and len(no_vacias) > 1 and not es_linea_acordes(no_vacias[1]) and not any(r.match(no_vacias[1]) for r in META.values()):
        a = no_vacias[1].strip()
        meta["artist"] = a.strip("()")
    consumidas_meta = 2
    idx_meta = 0
    while i < len(lineas):
        l = lineas[i]; s = l.strip()
        if not s: 
            if cuerpo and cuerpo[-1] != "": cuerpo.append("")
            i += 1; continue
        if idx_meta < consumidas_meta and (s.lower() == (meta["title"] or "").lower() or s.strip("()").lower() == (meta["artist"] or "").lower()):
            idx_meta += 1; i += 1; continue
        hit = False
        for k, rx in META.items():
            m = rx.match(s)
            if m:
                meta[k] = m.group(1).strip(); hit = True; break
        if hit: i += 1; continue
        m = CEJILLA_ROMANA.search(s)
        if m and len(s) <= 6:
            meta["cejilla"] = str(ROMANOS[m.group(1)]); i += 1; continue
        m = SECCION_CORCHETE.match(s)
        if m:
            cuerpo.append("{seccion: " + m.group(1).strip().capitalize() + "}")
            resto = m.group(2).strip()
            if resto and es_linea_acordes(resto):
                cuerpo.append(" ".join("[" + t + "]" if CHORD.match(t) else t for t in resto.split()))
            i += 1; continue
        m = SECCION_MAYUS.match(s)
        if m:
            cuerpo.append("{seccion: " + s.strip().capitalize() + "}"); i += 1; continue
        m = SECCION_DOSPUNTOS.match(s)
        if m:
            cuerpo.append("{seccion: " + m.group(1).capitalize() + "}")
            resto = m.group(2).strip()
            if resto and es_linea_acordes(resto):
                cuerpo.append(" ".join("[" + t + "]" if CHORD.match(t) else t for t in resto.split()))
            i += 1; continue
        if BASURA.match(s): i += 1; continue
        l = normalizar_parentesis(l)
        if es_linea_acordes(l):
            # ¿la siguiente línea es letra?
            j = i + 1
            if j < len(lineas) and lineas[j].strip() and not es_linea_acordes(lineas[j]) and not SECCION_CORCHETE.match(lineas[j]) and not SECCION_MAYUS.match(lineas[j].strip()):
                cuerpo.append(insertar_acordes(l, lineas[j])); i += 2; continue
            # instrumental
            cuerpo.append(" ".join("[" + limpiar_token(t) + "]" if CHORD.match(limpiar_token(t)) else t for t in l.split())); i += 1; continue
        # letra sin acordes arriba
        m = REPETICION.match(s)
        if m:
            cuerpo.append(m.group(1).strip() + "  (" + (m.group(2) or "x2") + ")"); i += 1; continue
        # línea huérfana corta: unir a la anterior si la anterior es letra
        if len(s) <= 12 and cuerpo and cuerpo[-1] and not cuerpo[-1].startswith("{") and re.search(r"[a-záéíóúñ]", cuerpo[-1]):
            cuerpo[-1] = cuerpo[-1].rstrip() + " " + s; i += 1; continue
        cuerpo.append(l.rstrip()); i += 1
    # ensamblar
    out = []
    for k, tag in (("title","titulo"),("artist","artista"),("compositor","compositor"),("tono","tono"),("cejilla","cejilla"),("afinacion","afinacion")):
        if meta.get(k): out.append("{" + tag + ": " + str(meta[k]) + "}")
    out.append("{estado: importada}")
    out.append("")
    # quitar blancos repetidos al final
    while cuerpo and cuerpo[-1] == "": cuerpo.pop()
    out.extend(cuerpo)
    return "\n".join(out) + "\n"

if __name__ == "__main__":
    args = sys.argv[1:]
    titulo = artista = None
    if "--titulo" in args: titulo = args[args.index("--titulo")+1]
    if "--artista" in args: artista = args[args.index("--artista")+1]
    pos = [a for i,a in enumerate(args) if not a.startswith("--") and (i==0 or not args[i-1].startswith("--"))]
    texto = open(pos[0], encoding="utf-8").read()
    res = convertir(texto, titulo, artista)
    open(pos[1], "w", encoding="utf-8").write(res)
    print(f"ok -> {pos[1]} ({res.count(chr(10))} líneas, {len(re.findall(r'\[[^\]]+\]', res))} acordes)")
