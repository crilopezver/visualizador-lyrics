#!/usr/bin/env python3
"""CANCIONEROS.pdf (dos columnas por página, formato Ritmolatino) → cuerpo ChordPro por canción.
Envoltorio sobre app/herramientas/importador_pdf.py; no contiene letras. Sesión 5, 11-sep-2026.

Uso:
  importar_cancionero.py PDF --listar A [B]         títulos por página (A..B)
  importar_cancionero.py PDF --pagina N [--diag]    todas las canciones de la página N (una tras otra)
  importar_cancionero.py PDF --pagina N --titulo "A PURO DOLOR" --salida x.cho

Reglas del formato (verificadas en la p. 3): letra Maiandra 10 · título Maiandra 22 · acordes Comic Sans 9
(también dígitos de rasgueo e intros con trastes) · "(Artista)  C I" Comic Sans 10 · anotaciones Comic Sans 6
(se conservan las que van entre paréntesis como {nota:}) · etiquetas de diagramas Comic Sans 12/14 · tablaturas
y "ir a video" Tekton 8 · Wingdings = cuerdas de los diagramas. Una columna derecha sin título es la
continuación de la última canción de la izquierda.
"""
import sys, re, datetime, unicodedata
from collections import Counter
HERR = "/Users/cristhianlopez/Claude/Projects/Visualizador Lyrics/app/herramientas"
sys.path.insert(0, HERR)
import pdfplumber
from importador_pdf import agrupar_lineas, insertar_por_coordenadas, es_acorde
from importador_prototipo import limpiar_token

# --- transposición (misma regla que app/web/js/chordpro.js) ---------------------
NOTAS_SOST = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
NOTAS_BEM  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B']
TONOS_BEMOL = {'F','Bb','Eb','Ab','Db','Gb','Dm','Gm','Cm','Fm','Bbm','Ebm'}
def idx_nota(n): return NOTAS_SOST.index(n) if n in NOTAS_SOST else NOTAS_BEM.index(n)
def transponer_nota(n, k, bem): return (NOTAS_BEM if bem else NOTAS_SOST)[(idx_nota(n) + k) % 12]
def transponer_acorde(ac, k, bem): return re.sub(r'([A-G](?:#|b)?)', lambda m: transponer_nota(m.group(1), k, bem), ac)
def tono_transpuesto(tono, k):
    m = re.match(r'^([A-G](?:#|b)?)(.*)$', tono)
    return transponer_nota(m.group(1), k, tono in TONOS_BEMOL) + m.group(2)

# --- clasificación por fuente ----------------------------------------------------
def clase(w):
    if not w["text"].strip(): return None
    f = w["fontname"].split("+")[-1]; s = round(w["size"])
    if "Wingdings" in f or "Tekton" in f: return None
    if "Maiandra" in f: return "titulo" if s >= 16 else "letra"
    if "ComicSans" in f and s == 9: return "acorde"
    if "ComicSans" in f and s == 10: return "meta"
    if "ComicSans" in f and s == 6: return "nota"
    return None

ROMANOS = {"I":1,"II":2,"III":3,"IV":4,"V":5,"VI":6,"VII":7}
JUNK_INTRO = re.compile(r"^(intro|:|-|–|x\d*|v|\d+\)|\d+(-\d+)*|\(|\))$", re.I)
MINUSCULAS = {"de","del","la","las","los","el","y","en","a","al","con","por","para","que","mi","tu","un","una","se","me","te","lo","sin","su"}
def titulo_bonito(t):
    ps = t.lower().split()
    return " ".join(p if (i and p in MINUSCULAS) else p.capitalize() for i, p in enumerate(ps))
def slug(t):
    t = unicodedata.normalize("NFD", t.lower()); t = re.sub(r"[̀-ͯ]", "", t)
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", t)) or "cancion"

def bloques_pagina(pg):
    """Títulos con su rango vertical y su columna; palabras clasificadas; mitad de la página."""
    words = [w for w in pg.extract_words(extra_attrs=["size","fontname"]) if clase(w)]
    for w in words: w["cl"] = clase(w)
    mid = pg.width / 2
    titulos = []
    for lado in "ID":  # los títulos se agrupan por columna (si no, dos títulos a la misma altura se mezclan)
        for t, ws in agrupar_lineas([w for w in words if w["cl"] == "titulo" and ((w["x0"] < mid) if lado == "I" else (w["x0"] >= mid))]):
            txt = " ".join(w["text"] for w in ws).strip()
            if titulos and titulos[-1]["lado"] == lado and 0 < t - titulos[-1]["t0"] < 32:
                titulos[-1]["titulo"] += " " + txt; titulos[-1]["t0"] = t; continue
            titulos.append({"titulo": txt, "t0": t, "lado": lado})
    for T in titulos:
        sig = [U["t0"] for U in titulos if U["lado"] == T["lado"] and U["t0"] > T["t0"] + 5]
        T["t_fin"] = min(sig) if sig else pg.height
    return titulos, words, mid

RELLENO = {"ir", "a", "video", "tutorial"}
def partir_guiones(ws):
    """'Em-Bm' o '(G-D-Em)' en la fuente de acordes → una palabra por acorde, repartidas en el ancho del token."""
    out = []
    for w in ws:
        t = limpiar_token(w["text"]).strip("()")
        partes = [x for x in re.split(r"[-–]", t) if x]
        if w["cl"] == "acorde" and len(partes) > 1 and all(es_acorde(x) for x in partes):
            paso = (w["x1"] - w["x0"]) / len(partes)
            for k, x in enumerate(partes):
                out.append({**w, "text": x, "x0": w["x0"] + k * paso, "x1": w["x0"] + (k + 1) * paso})
        else:
            out.append({**w, "text": t if w["cl"] == "acorde" else w["text"]})
    return out

def cuerpo_de(blk, nombre, avisos):
    """Palabras de un tramo de columna → (lista de líneas ChordPro, meta parcial)."""
    meta = {"artista": None, "cejilla": 0}
    for t, ws in agrupar_lineas([w for w in blk if w["cl"] == "meta"]):
        txt = " ".join(w["text"] for w in ws).strip()
        m = re.match(r"^\((.*?)\)\s*(?:C\s*(I{1,3}|IV|V|VI{0,3}))?$", txt)
        if m:
            meta["artista"] = m.group(1).strip()
            if m.group(2): meta["cejilla"] = ROMANOS[m.group(2)]
            continue
        m = re.fullmatch(r"C\s*(I{1,3}|IV|V|VI{0,3})", txt)
        if m: meta["cejilla"] = ROMANOS[m.group(1)]; continue
        if not re.fullmatch(r"\d+", txt): avisos.append(f"[{nombre}] línea meta no reconocida: {txt!r}")
    notas = []
    for t, ws in agrupar_lineas([w for w in blk if w["cl"] == "nota"]):
        txt = " ".join(w["text"] for w in ws).strip()
        if txt.startswith("(") and txt.endswith(")"): notas.append((t, "{nota: " + txt.strip("()").strip() + "}"))
        else: avisos.append(f"[{nombre}] anotación descartada (etiqueta de diagrama): {txt!r}")
    filas = [(t, partir_guiones(ws)) for t, ws in agrupar_lineas([w for w in blk if w["cl"] in ("letra", "acorde")])]
    # dígitos de rasgueo ("2", "0", "x") pegados a una fila de letra: fuera, la fila sigue siendo de letra
    filas = [(t, [w for w in ws if not (any(x["cl"] == "letra" for x in ws) and w["cl"] == "acorde" and re.fullmatch(r"[\dxp]+", limpiar_token(w["text"])))]) for t, ws in filas]
    filas = [(t, [w for w in ws if w["text"]]) for t, ws in filas]; filas = [(t, ws) for t, ws in filas if ws]
    cuerpo = []; i = 0; ultimo_top_letra = None
    def es_fila_acordes(ws): return all(w["cl"] == "acorde" for w in ws) and all(es_acorde(limpiar_token(w["text"])) for w in ws)
    def es_fila_letra(ws): return all(w["cl"] == "letra" for w in ws)
    def salto(t):
        if ultimo_top_letra is not None and t - ultimo_top_letra > 27 and cuerpo and cuerpo[-1][1] != "": cuerpo.append((t, ""))
    def anclar(wac, i, t):
        nonlocal ultimo_top_letra
        if i + 1 < len(filas) and es_fila_letra(filas[i+1][1]) and filas[i+1][0] - t < 20:
            t2, ws2 = filas[i+1]; salto(t2)
            cuerpo.append((t2, insertar_por_coordenadas(wac, ws2))); ultimo_top_letra = t2; return 2
        salto(t); cuerpo.append((t, " ".join("[" + w["text"] + "]" for w in wac))); ultimo_top_letra = t; return 1
    while i < len(filas):
        t, ws = filas[i]
        if es_fila_acordes(ws):
            for w in ws: w["text"] = limpiar_token(w["text"])
            i += anclar(ws, i, t); continue
        if es_fila_letra(ws):
            salto(t); cuerpo.append((t, " ".join(w["text"] for w in ws))); ultimo_top_letra = t; i += 1; continue
        # fila mixta: acordes + relleno (dígitos de rasgueo, "Intro : 3) 1-2 …", guiones)
        for w in ws: w["text"] = limpiar_token(w["text"])
        ws = [w for w in ws if w["text"]]
        wac = [w for w in ws if w["cl"] == "acorde" and es_acorde(w["text"]) and not re.fullmatch(r"[\d\-–]+", w["text"])]
        resto = [w["text"] for w in ws if w not in wac]
        if wac and all(JUNK_INTRO.match(x) for x in resto):
            n = anclar(wac, i, t)
            avisos.append(f"[{nombre}] fila de acordes con relleno {' '.join(resto)!r} → " + ("acordes anclados a la letra de abajo" if n == 2 else "dejé solo los acordes: " + " ".join(w['text'] for w in wac)))
            i += n; continue
        palabras = [x for x in resto if re.fullmatch(r"[A-Za-zÁ-ú']+", x)]
        if palabras and set(x.lower() for x in palabras) <= RELLENO: i += 1; continue
        if palabras and all(w["cl"] == "acorde" for w in ws) and all(JUNK_INTRO.match(x) or x in palabras for x in resto):
            salto(t); cuerpo.append((t, "{nota: " + " ".join(palabras) + "}"))
            if wac: cuerpo.append((t + 0.1, " ".join("[" + w["text"] + "]" for w in wac)))
            ultimo_top_letra = t; avisos.append(f"[{nombre}] fila '{' '.join(palabras)}' → nota" + (" + acordes " + " ".join(w['text'] for w in wac) if wac else ""))
            i += 1; continue
        if not all(re.fullmatch(r"[\d\)\(\-–.]+", x) for x in resto):
            avisos.append(f"[{nombre}] fila descartada (mixta): {' '.join(w['text'] for w in ws)!r}")
        i += 1
    for tn, txt in notas:
        pos = next((k for k, (tt, _) in enumerate(cuerpo) if tt > tn), len(cuerpo))
        cuerpo.insert(pos, (tn, txt))
    def puntos(x):
        x = re.sub(r"\s?\.\s?(\[[^\]]+\])\s?\.(?:\s?\.)*", r" \1...", x)
        x = re.sub(r"(?:\s*\.){2,}", "...", x)
        x = re.sub(r"\s+\.(\s|$)", r".\1", x)
        # Cristhian (11-sep): letra limpia, sin puntos suspensivos ni puntos sueltos en medio de la línea
        x = re.sub(r"\s*\.\.\.\s*(\[[^\]]+\])\s*", r" \1", x); x = re.sub(r"(\[[^\]]+\])\.\.\.\s*", r"\1", x)
        x = re.sub(r"\s*\.\.\.\s*", " ", x); x = re.sub(r"(\w)\.\s+(?=[a-záéíóúñ])", r"\1 ", x)
        return re.sub(r"\s{2,}", " ", x).strip()
    lineas = [puntos(x) if not x.startswith("{") else x for _, x in cuerpo]
    return lineas, meta

def importar_bloque(T, words, mid, pagina, avisos, continuacion=None):
    lado = T["lado"]
    enc = lambda w: (w["x0"] < mid) if lado == "I" else (w["x0"] >= mid)
    blk = [w for w in words if enc(w) and T["t0"] + 5 < w["top"] < T["t_fin"] and w["cl"] != "titulo"]
    if continuacion:
        tops = sorted(set(round(w["top"]) for w in blk if w["cl"] in ("letra", "acorde")))
        colas = [w for w in continuacion if any(abs(w["top"] - tt) <= 3 for tt in tops)]
        if colas:
            blk += colas; continuacion = [w for w in continuacion if w not in colas]
            avisos.append(f"[{T['titulo']}] {len(colas)} palabras de la derecha eran colas de líneas largas: fundidas en su línea")
        if not any(w["cl"] == "letra" for w in continuacion): continuacion = None
    lineas, meta = cuerpo_de(blk, T["titulo"], avisos)
    if continuacion:
        l2, m2 = cuerpo_de(continuacion, T["titulo"] + " (cont.)", avisos)
        if l2: lineas += [""] + l2
        if not meta["artista"]: meta["artista"] = m2["artista"]
        if not meta["cejilla"]: meta["cejilla"] = m2["cejilla"]
        avisos.append(f"[{T['titulo']}] continúa en la columna derecha: {len(l2)} líneas añadidas")
    tono = None
    if meta["cejilla"]:
        m = re.search(r"\[([A-G](?:#|b)?)(m(?!aj))?", "\n".join(lineas))
        if m:
            tono = tono_transpuesto(m.group(1) + (m.group(2) or ""), meta["cejilla"]); bem = tono in TONOS_BEMOL
            lineas = [l if l.startswith("{") else re.sub(r"\[([^\]]+)\]", lambda mm: "[" + transponer_acorde(mm.group(1), meta["cejilla"], bem) + "]", l) for l in lineas]
    cab = ["{titulo: " + titulo_bonito(T["titulo"]) + "}"]
    if meta["artista"]: cab.append("{artista: " + meta["artista"] + "}")
    if tono: cab.append("{tono: " + tono + "}")
    fuente = f"CANCIONEROS.pdf, p. {pagina}"
    if meta["cejilla"]: fuente += f"; hoja con cejilla en el traste {meta['cejilla']}; acordes subidos {meta['cejilla']} semitono{'s' if meta['cejilla']>1 else ''}"
    cab += ["{fuente: " + fuente + "}", "{importada: " + datetime.date.today().isoformat() + "}", "{estado: importada}"]
    while lineas and lineas[-1] == "": lineas.pop()
    return "\n".join(cab + [""] + lineas).rstrip() + "\n"

if __name__ == "__main__":
    a = sys.argv[1:]; pdf = pdfplumber.open(a[0])
    if "--listar" in a:
        i = a.index("--listar"); A = int(a[i+1]); B = int(a[i+2]) if i+2 < len(a) and a[i+2].isdigit() else A
        for n in range(A, B+1):
            titulos, words, mid = bloques_pagina(pdf.pages[n-1])
            fuentes = Counter(w["fontname"].split("+")[-1] + " " + str(round(w["size"])) for w in pdf.pages[n-1].extract_words(extra_attrs=["size","fontname"]))
            raras = [f"{k}×{v}" for k, v in fuentes.items() if not any(x in k for x in ("Maiandra", "ComicSans", "Tekton", "Wingdings", "Arial"))]
            print(f"p.{n}: " + " | ".join(f"{T['lado']} {T['titulo']}" for T in titulos) + (f"   ⚠ fuentes raras: {', '.join(raras)}" if raras else ""))
        sys.exit()
    n = int(a[a.index("--pagina")+1]); pg = pdf.pages[n-1]
    titulos, words, mid = bloques_pagina(pg)
    quiero = a[a.index("--titulo")+1].upper() if "--titulo" in a else None
    salida = a[a.index("--salida")+1] if "--salida" in a else None
    avisos = []
    # columna sin título → continuación de la última canción de la otra columna; letra por encima del primer título → aviso
    cont = {}
    for lado, otro in (("D", "I"), ("I", "D")):
        en_lado = [w for w in words if ((w["x0"] < mid) if lado == "I" else (w["x0"] >= mid)) and w["cl"] != "titulo"]
        mios = [T for T in titulos if T["lado"] == lado]
        if not mios and any(w["cl"] == "letra" for w in en_lado):
            ult = [T for T in titulos if T["lado"] == otro]
            if ult: cont[id(ult[-1])] = en_lado
            else: avisos.append(f"columna {lado}: letra sin título en toda la página (viene de la página anterior)")
        elif mios:
            prim = min(T["t0"] for T in mios)
            huer = [w for w in en_lado if w["cl"] == "letra" and w["top"] < prim]
            if huer: avisos.append(f"columna {lado}: {len(huer)} palabras de letra ANTES del primer título (¿viene de la página anterior?): " + " ".join(w["text"] for w in huer[:12]))
    for T in titulos:
        if quiero and T["titulo"] != quiero: continue
        res = importar_bloque(T, words, mid, n, avisos, cont.get(id(T)))
        if "--diag" in a: print(f"--- {T['titulo']} ({T['lado']}, top {T['t0']:.0f}-{T['t_fin']:.0f})")
        if salida and quiero: open(salida, "w", encoding="utf-8").write(res); print(f"ok -> {salida}")
        else: print(res)
    for av in avisos: print("⚠", av, file=sys.stderr)
