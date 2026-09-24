#!/usr/bin/env python3
"""CANCIONEROS.pdf (dos columnas por página, formato Ritmolatino) → cuerpo ChordPro por canción.
Envoltorio sobre app/herramientas/importador_pdf.py; no contiene letras. Sesión 5, 11-sep-2026; asignación por cuerpo, sesión 6, 16-sep-2026.

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
# Sesión 6: el cancionero escribe acordes que el patrón base no reconocía y se perdían filas enteras:
# "C7M"/"F7M" (maj7), "Am7M", "B7+", "C9ad"/"C9add", "Bm7-5", "Am/g" (bajo en minúscula), "D74".
_RAIZ = r"[A-G](?:#|b)?"
_CHORD6 = re.compile(rf"^\(?{_RAIZ}(?:maj|min|dim|aug|sus|add|ad|m|M|\+|°|º|ª)?\d*(?:M|\+|-5|b5|aug)?(?:\([^)]*\))?(?:sus\d?|add\d?|ad\d?|maj\d?|b\d|#\d|-\d|\d|\+|M|aug)*(?:/{_RAIZ}|/[a-g](?:#|b)?)?\*{{0,3}}\)?$")
_es_acorde_base = es_acorde
def es_acorde(t): return _es_acorde_base(t) or bool(_CHORD6.match(t))
def _bajo_mayuscula(t): return re.sub(r"/([a-g])", lambda m: "/" + m.group(1).upper(), t)

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
    if "Maiandra" in f:
        if w["text"].strip().lower() in ("x", "xx") and s < 16: return None  # P10 v7: marcas de diagrama
        if re.fullmatch(r"\d+v", w["text"].strip()) and s < 16: return None  # P24 v7: "4v" (veces) de una tablatura
        return "titulo" if s >= 16 else "letra"
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
    """Títulos de la página (texto, rango horizontal, altura) y palabras clasificadas.
    Sesión 6 (16-sep): la disposición de las hojas es libre (dos o tres columnas, títulos que cruzan la mitad,
    títulos a todo el ancho). Ya no se reparte por la mitad de la página: cada línea de título se parte donde hay
    un hueco > 18 pt entre palabras y cada trozo es un título; las líneas de un mismo título (dos renglones)
    se unen si se solapan en horizontal y están a menos de 32 pt. Etiquetas de diagramas en fuente de título
    ("A", "1", "* **") no cuentan como título."""
    words = [w for w in pg.extract_words(extra_attrs=["size","fontname"]) if clase(w)]
    for w in words: w["cl"] = clase(w)
    solas = [w for w in words if w["cl"] == "letra" and len(w["text"].strip()) == 1]  # P19c v7: rótulo vertical = cadena de ≥ 3 letras sueltas alineadas en x, a menos de 16 pt entre sí (las líneas de letra van a ≥ 21 pt)
    def cadena(w, vistos):
        vistos.add(id(w))
        for v in solas:
            if id(v) not in vistos and abs(v["x0"] - w["x0"]) < 3 and 4 < abs(v["top"] - w["top"]) < 16: cadena(v, vistos)
        return vistos
    for w in solas:
        if w["cl"] and len(cadena(w, set())) >= 3:
            for v in solas:
                if id(v) in cadena(w, set()): v["cl"] = None
    words = [w for w in words if w["cl"]]
    for w in words:  # P11 v7: acorde escrito con la fuente del artista, solo en su línea
        if w["cl"] == "meta" and es_acorde6(limpiar_token(w["text"])) and not any(v is not w and v["cl"] == "meta" and abs(v["top"] - w["top"]) < 3 for v in words): w["cl"] = "acorde"
    mid = pg.width / 2
    trozos = []
    for t, ws in agrupar_lineas([w for w in words if w["cl"] == "titulo"]):
        g = [ws[0]]
        for w in ws[1:]:
            if w["x0"] - g[-1]["x1"] > 18: trozos.append((t, g)); g = [w]
            else: g.append(w)
        trozos.append((t, g))
    titulos = []
    for t, ws in sorted(trozos, key=lambda z: (z[0], z[1][0]["x0"])):
        txt = " ".join(w["text"] for w in ws).strip()
        if not re.search(r"[A-Za-zÁ-ú]{2,}|\d{2,}", txt): continue  # "A", "1", "* **": etiquetas, no títulos (P20 v7: "40 Y 20" sí es título)
        x0, x1 = ws[0]["x0"], ws[-1]["x1"]
        prev = next((T for T in titulos if 0 < t - T["t0"] < 32 and min(x1, T["x1"]) - max(x0, T["x0"]) > 0), None)
        if prev: prev["titulo"] += " " + txt; prev["t0"] = t; prev["x0"] = min(prev["x0"], x0); prev["x1"] = max(prev["x1"], x1); continue
        titulos.append({"titulo": txt, "t0": t, "x0": x0, "x1": x1, "lado": "I" if (x0 + x1) / 2 < mid else "D"})
    return titulos, words, mid

def canales(segs, ancho):
    """Franjas verticales de la página casi sin letra (los canales entre columnas). Devuelve [(x_ini, x_fin)].
    Se miden con los trozos de letra: un x es canal si lo cubren como mucho el 10 % de las líneas de letra."""
    if not segs: return []
    cover = [0] * (int(ancho) + 1)
    for g in segs:
        for x in range(int(g[0]["x0"]), min(int(g[-1]["x1"]) + 1, len(cover))): cover[x] += 1
    n_lineas = len(set(round(g[0]["top"]) for g in segs)); umbral = max(1, n_lineas * 0.10)
    xmin = int(min(g[0]["x0"] for g in segs)); xmax = int(max(g[-1]["x1"] for g in segs))
    out = []; ini = None
    for x in range(xmin, xmax + 1):
        if cover[x] <= umbral:
            if ini is None: ini = x
        elif ini is not None:
            if x - ini >= 6: out.append((ini, x))
            ini = None
    def lados(c0, c1):  # P9 v7
        izq = sum(1 for g in segs if g[-1]["x1"] <= c0 + 2); der = sum(1 for g in segs if g[0]["x0"] >= c1 - 2)
        return izq >= max(3, n_lineas * 0.08) and der >= max(3, n_lineas * 0.08)  # P9b v7: columna estrecha entre tres (p. 196)
    return [(c0, c1) for c0, c1 in out if lados(c0, c1)]

def asignar_cuerpos(titulos, words, avisos):
    """Reparte las palabras del cuerpo entre los títulos según dónde está el CUERPO (sesión 6, 16-sep).
    1) Las palabras de letra se agrupan en trozos (misma línea, huecos < 25 pt); los trozos de una misma línea
       se vuelven a unir salvo que entre ellos pase un canal de la página (franja vertical casi sin letra):
       así una hoja de una sola columna ancha con huecos grandes no se parte, y dos columnas sí. Una línea
       larga que invade el canal (cola) sigue unida si el trozo de la derecha empieza a menos de 25 pt.
    2) Cada segmento va al título más cercano por encima que se solape con él en horizontal (±30 pt);
       si ninguno se solapa, es continuación: va al título del segmento asignado más cercano hacia arriba y
       a la izquierda (o el último título de arriba).
    3) Acordes, meta y notas van con el segmento de letra que tienen debajo o más cerca (mismo ancho ±40 pt);
       si no hay ninguno, con la regla de los títulos.
    Devuelve {id(T): [subbloques]}; cada subbloque es una columna (entre canales), de izquierda a derecha,
    para que la continuación en la otra columna quede después."""
    trozos = []
    for t, ws in agrupar_lineas([w for w in words if w["cl"] == "letra"]):
        g = [ws[0]]
        for w in ws[1:]:
            if w["x0"] - g[-1]["x1"] > 25: trozos.append(g); g = [w]
            else: g.append(w)
        trozos.append(g)
    ancho = max(w["x1"] for w in words) + 1 if words else 1
    cans = canales(trozos, ancho)
    tops_t = sorted(set(T["t0"] for T in titulos))  # P18 v7: canales por banda (entre títulos); bandas con < 8 líneas usan los de la página
    def banda(top): return sum(1 for t0 in tops_t if t0 <= top)
    cans_por_banda = {}
    for b in range(len(tops_t) + 1):
        lo = tops_t[b-1] if b > 0 else -1; hi = tops_t[b] if b < len(tops_t) else 1e9
        tr = [g for g in trozos if lo <= g[0]["top"] < hi]
        cans_por_banda[b] = canales(tr, ancho) if len(set(round(g[0]["top"]) for g in tr)) >= 8 else cans
    def cans_de(top): return cans_por_banda[banda(top)]
    def hay_canal(izq, der):
        cans = cans_de(izq[-1]["top"])
        return any(izq[-1]["x1"] < c1 and der[0]["x0"] > c0 and (der[0]["x0"] - izq[-1]["x1"] >= 25 or (izq[-1]["x1"] <= c0 + 4 and der[0]["x0"] - izq[-1]["x1"] >= 10) or (der[0]["x0"] >= c1 - 2 and der[0]["x0"] - izq[-1]["x1"] >= 8)) for c0, c1 in cans)  # P3/P3b v7
    segs = []
    for t, ws in agrupar_lineas([w for g in trozos for w in g]):
        g = [ws[0]]
        for w in ws[1:]:
            if hay_canal(g, [w]): segs.append(g); g = [w]
            else: g.append(w)
        segs.append(g)
    def columna(x, top): return sum(1 for c0, c1 in cans_de(top) if x >= (c0 + c1) / 2)  # P18
    def rango(g): return g[0]["x0"], g[-1]["x1"], g[0]["top"]
    def titulo_para(x0, x1, top):  # P4 v7
        cands = []
        for T in titulos:
            if not T["t0"] + 5 < top: continue
            gap = max(0, max(x0, T["x0"]) - min(x1, T["x1"]))
            if gap > 170: continue
            cands.append(((top - T["t0"]) + 6 * gap, T))
        return min(cands, key=lambda z: z[0])[1] if cands else None
    def titulo_seg(g, asig):  # P4b v7 (18-sep): continuidad de flujo + título más cercano con penalización horizontal y de columna
        x0, x1, top = rango(g); cans_b = cans_de(top)
        col = sum(1 for c0, c1 in cans_b if x0 >= (c0 + c1) / 2)
        def col_t(T):
            if any(T["x0"] < c0 and T["x1"] > c1 for c0, c1 in cans_b): return None  # cruza un canal: vale para ambas columnas
            return sum(1 for c0, c1 in cans_b if (T["x0"] + T["x1"]) / 2 >= (c0 + c1) / 2)
        encima = [(h, U) for h, U in asig if 0 < top - h[0]["top"] and min(x1, h[-1]["x1"]) - max(x0, h[0]["x0"]) > 0]
        if encima:
            h, U = min(encima, key=lambda z: top - z[0][0]["top"])
            corta = [T for T in titulos if h[0]["top"] < T["t0"] + 5 < top and (col_t(T) is None or col_t(T) == col)]
            if top - h[0]["top"] <= 60 and not corta: return U
        cands = []
        for T in titulos:
            if not T["t0"] + 5 < top: continue
            gap = max(0, max(x0, T["x0"]) - min(x1, T["x1"]))
            if gap > 170: continue
            ct = col_t(T)
            cands.append(((top - T["t0"]) + 6 * gap + (0 if ct is None or ct == col else 200), T))
        return min(cands, key=lambda z: z[0])[1] if cands else None
    asig = []  # (seg, T)
    for g in sorted(segs, key=lambda g: (g[0]["top"], g[0]["x0"])):
        x0, x1, top = rango(g)
        T = titulo_seg(g, asig)
        if T is None:
            # sin título encima que se solape: primero, el cuerpo fluye hacia abajo por su columna (el segmento
            # asignado más cercano por arriba en el mismo ancho es de la misma canción, aunque haya un recuadro
            # de tablatura en medio; p. 244). Un título que se solape ya lo habría atrapado titulo_para.
            encima = [(h, U) for h, U in asig if 0 < top - h[0]["top"] and min(x1, h[-1]["x1"]) - max(x0, h[0]["x0"]) > 0]
            prev = [(h, U) for h, U in asig if h[0]["top"] <= top and h[-1]["x1"] <= x0 + 5]
            if encima: T = min(encima, key=lambda z: top - z[0][0]["top"])[1]
            elif prev: T = max(prev, key=lambda z: (z[0][0]["top"], z[0][0]["x0"]))[1]
            else:
                arriba = [U for U in titulos if U["t0"] + 5 < top]
                # título al costado del cuerpo (p. 244: la letra empieza arriba a la izquierda y el título está
                # a la derecha, más abajo): el título más cercano por debajo, a menos de 120 pt
                costado = [U for U in titulos if 0 <= U["t0"] - top < 120]
                if arriba: T = max(arriba, key=lambda U: U["t0"])
                elif costado:
                    T = min(costado, key=lambda U: U["t0"] - top)
                    if not T.get("_costado"): avisos.append(f"[{T['titulo']}] letra por encima del título (título al costado del cuerpo): asignada"); T["_costado"] = True
                else: avisos.append(f"letra sin título por encima (¿viene de la página anterior?): {' '.join(w['text'] for w in g[:8])!r}"); continue
            if prev and not encima and not T.get("_cont"): avisos.append(f"[{T['titulo']}] continúa en otra columna (letra sin título encima)"); T["_cont"] = True
        asig.append((g, T))
    def seg_para(w):  # P5/P5b/P5d v7: solo segmentos de la misma columna; debajo (−6..25 pt) primero, si no a menos de 90 pt
        cx = (w["x0"] + w["x1"]) / 2; cans_b = cans_de(w["top"])
        dentro = [c0 for c0, c1 in cans_b if c0 <= w["x0"] <= c1]  # P5e/P5f/P5g v7: acorde que empieza dentro del canal
        if dentro:
            fila = [v for v in words if v is not w and v["cl"] == "acorde" and abs(v["top"] - w["top"]) < 3 and not any(c0 <= (v["x0"] + v["x1"]) / 2 <= c1 for c0, c1 in cans_b)]
            izq = [v for v in fila if v["x1"] <= w["x0"]]  # P5h v7: primero el acorde vecino a la izquierda (el texto fluye hacia la derecha)
            if izq: col = columna(max(izq, key=lambda v: v["x1"])["x0"] + 1, w["top"])
            elif fila: col = columna(min(fila, key=lambda v: v["x0"])["x0"] + 1, w["top"])
            else: col = columna(dentro[0] - 1, w["top"])
        else: col = columna(cx, w["top"])
        cands = [(h, U) for h, U in asig if h[0]["x0"] - 40 <= cx <= h[-1]["x1"] + 40 and columna(h[0]["x0"], w["top"]) == col]
        abajo = [z for z in cands if -6 <= z[0][0]["top"] - w["top"] <= 25]
        if abajo: return min(abajo, key=lambda z: (not (z[0][0]["x0"] <= cx <= z[0][-1]["x1"]), z[0][0]["top"] - w["top"] < 0, z[0][0]["top"] - w["top"]))
        cerca = [z for z in cands if abs(z[0][0]["top"] - w["top"]) <= 90]
        if cerca: return min(cerca, key=lambda z: abs(z[0][0]["top"] - w["top"]))
        return None
    por_titulo = {id(T): {} for T in titulos}  # id(T) -> {columna: [palabras]}
    def poner(T, col, w): por_titulo[id(T)].setdefault(col, []).append(w)
    for g, T in asig:
        col = columna(g[0]["x0"], g[0]["top"])
        for w in g: poner(T, col, w)
    for w in words:
        if w["cl"] in ("letra", "titulo"): continue
        if w["cl"] == "meta":
            # "(Artista) C IV" va debajo de SU título: título más cercano por encima; nunca por la letra vecina
            # (p. 95: la línea de La muralla verde se pegaba a Loco por tu forma de ser y la transponía)
            T = titulo_para(w["x0"], w["x1"], w["top"])
            if T: poner(T, columna(w["x0"], w["top"]), w); continue
        z = seg_para(w)
        if z: poner(z[1], columna(z[0][0]["x0"], z[0][0]["top"]), w); continue
        T = titulo_para(w["x0"], w["x1"], w["top"])
        if T: poner(T, columna(w["x0"], w["top"]), w)
    out = {}
    for T in titulos:
        cols = por_titulo[id(T)]
        out[id(T)] = [cols[k] for k in sorted(cols)]
        if len(cols) > 1: avisos.append(f"[{T['titulo']}] cuerpo en {len(cols)} columnas: unidas en orden de izquierda a derecha")
    return out

RELLENO = {"ir", "a", "video", "tutorial"}
def partir_guiones(ws):
    """'Em-Bm' o '(G-D-Em)' en la fuente de acordes → una palabra por acorde, repartidas en el ancho del token.
    Un token '/C#' suelto (bajo separado con espacio) se une al acorde anterior."""
    out = []
    ws = list(ws)
    for k in range(len(ws) - 1, 0, -1):
        if ws[k]["cl"] == "acorde" and re.fullmatch(r"/[A-Ga-g](?:#|b)?|[Øø],?", ws[k]["text"].strip()) and ws[k-1]["cl"] == "acorde" and ws[k]["x0"] - ws[k-1]["x1"] < 4 and re.match(r"^\(?[A-G]", ws[k-1]["text"].strip()):  # P16 v7
            ws[k-1] = {**ws[k-1], "text": ws[k-1]["text"].strip() + ws[k]["text"].strip().rstrip(","), "x1": ws[k]["x1"]}; del ws[k]
    for k in range(len(ws) - 1, 0, -1):  # P13 v7: token que termina en guion + token de acordes pegado
        if ws[k]["cl"] == "acorde" and ws[k-1]["cl"] == "acorde" and re.fullmatch(r"[A-G][#b]?[^\s]*[-–]", ws[k-1]["text"].strip()) and 0 <= ws[k]["x0"] - ws[k-1]["x1"] < 3:
            ws[k-1] = {**ws[k-1], "text": ws[k-1]["text"].strip() + ws[k]["text"].strip(), "x1": ws[k]["x1"]}; del ws[k]
    for k in range(len(ws) - 1, 0, -1):  # P12 v7
        if ws[k]["cl"] == "acorde" and ws[k-1]["cl"] == "acorde" and re.fullmatch(r"\d{1,2}(?:ad|add|sus|M|\+|-5|b5)?|7M|maj7|sus\d|add\d|m7b5", ws[k]["text"].strip()) and 0 <= ws[k]["x0"] - ws[k-1]["x1"] < 4 and es_acorde6(limpiar_token(ws[k-1]["text"]) + ws[k]["text"].strip()):
            ws[k-1] = {**ws[k-1], "text": ws[k-1]["text"].strip() + ws[k]["text"].strip(), "x1": ws[k]["x1"]}; del ws[k]
    ws2 = []
    for w in ws:
        t = w["text"].strip()
        if w["cl"] == "acorde" and not es_acorde6(limpiar_token(t)):
            mm = re.match(r"^\(?([A-G][#b]?[^)]*)\)([A-Za-z].*)$", t)  # "(G)Riff" / "G)Riff"
            if mm and es_acorde6(mm.group(1)): ws2 += [{**w, "text": mm.group(1), "x1": w["x0"] + (w["x1"] - w["x0"]) / 2}, {**w, "text": mm.group(2), "x0": w["x0"] + (w["x1"] - w["x0"]) / 2}]; continue
            for corte in range(1, len(t)):  # "E7Am7", "GEm", "G*Am": dos acordes pegados
                a, b = t[:corte], t[corte:]
                if es_acorde6(a) and es_acorde6(b) and re.match(r"^[A-G]", b) and not a.endswith(("-", "–")):  # P1 v7
                    mid = w["x0"] + (w["x1"] - w["x0"]) * corte / len(t)
                    ws2 += [{**w, "text": a, "x1": mid}, {**w, "text": b, "x0": mid}]; break
            else: ws2.append(w)
        else: ws2.append(w)
    ws = ws2
    for w in ws:
        t = limpiar_token(w["text"]).strip("()")
        if w["cl"] == "acorde":
            mm = re.match(r"^(intro|inter)\.?[:=_-]+(.+)$", t, re.I)
            if mm: out.append({**w, "text": mm.group(1), "x1": w["x0"] + 1}); t = mm.group(2)
        partes = [x for x in re.split(r"[-–]", t) if x]
        if w["cl"] == "acorde" and len(partes) > 1 and all(es_acorde6(x) for x in partes):
            paso = (w["x1"] - w["x0"]) / len(partes)
            for k, x in enumerate(partes):
                out.append({**w, "text": x, "x0": w["x0"] + k * paso, "x1": w["x0"] + (k + 1) * paso})
        else:
            out.append({**w, "text": _bajo_mayuscula(t) if w["cl"] == "acorde" else w["text"]})
    return out

ESP = {"Do": "C", "Re": "D", "Mi": "E", "Fa": "F", "Sol": "G", "La": "A", "Si": "B"}
def acorde_normal(t):
    """Notación del cancionero → la de la app: raíz en español (Do9add→C9add, Labm7→Abm7), Ø/ø → m7b5,
    7M/Maj7 → maj7, 'aug' se queda, bajo pegado con espacio se une antes (ver partir_guiones)."""
    t = t.replace("Á", "A").replace("Í", "I").replace("Ó", "O").replace("É", "E").replace("í", "i").replace("é", "e").replace("ó", "o")
    m = re.match(r"^\(?(DO|RE|MI|FA|SOL|LA|SI|Do|Re|Mi|Fa|Sol|La|Si)([#b]?)(.*)$", t)
    if m: t = ESP[m.group(1).capitalize()] + m.group(2) + m.group(3)
    t = re.sub(r"(?<=[A-G#b])(?:Ø|ø)7?(\*?)$", r"m7b5\1", t)
    t = re.sub(r"7M(\*?)$", r"maj7\1", t); t = re.sub(r"Maj7(\*?)$", r"maj7\1", t)
    t = re.sub(r"^([A-G][#b]?)9m$", r"\1m9", t)            # D9m → Dm9 (la hoja escribe así la novena menor)
    t = re.sub(r"^([A-G][#b]?)9a(dd)?$", r"\1add9", t)     # C9a / C9add → Cadd9
    t = re.sub(r"^([A-G][#b]?)ª$", r"\1º", t)             # Cª → Cº (símbolo de disminuido mal codificado)
    t = re.sub(r"^([A-G][#b]?)-$", r"\1m", t)             # E- → Em
    return t
def es_acorde6(t): return bool(t) and not re.fullmatch(r"[A-G]1", t.strip()) and (es_acorde(t) or es_acorde(acorde_normal(t)))  # P24b v7: "G1" es etiqueta de tablatura ("A2", "C2" sí son acordes)
JUNK = re.compile(r"^(intro|inter|riff\d*\*?|:|=|-|–|_|\.|x\d*|\d*v(?:ez|eces)?|\d+\)|\d+(-\d+)*|\(|\)|\d+(?:era|da|ra|ta|to)?|veces?|vez)$", re.I)
NOTA_OK = re.compile(r"^(riff\s*\d*\*?|intro|inter|solo|puente|coro|estrofa|final|arpegio|rasgueo|var|\d+(?:era|da|ra|ta|to)\s*(?:vez|frase)?)$", re.I)

def cuerpo_de(blk, nombre, avisos):
    """Palabras de un tramo de columna → lista de líneas ChordPro. (Sesión 6, 16-sep: reescrita para no perder letra.)
    Reglas: fila de acordes → se ancla a la letra de abajo; fila de letra → letra; fila MIXTA (letra + acordes en la
    misma altura) → la letra se conserva y los acordes reconocibles se anclan por posición, el resto se descarta con
    aviso; fila sin letra con acordes + relleno ("Intro: F-Dm-Gm", "x2", "2veces") → solo los acordes; fila sin
    letra con palabras (Riff1, 2da vez) → {nota:}."""
    notas = []
    for t, ws in agrupar_lineas([w for w in blk if w["cl"] == "nota"]):
        txt = " ".join(w["text"] for w in ws).strip()
        if txt.startswith("(") and txt.endswith(")"): notas.append((t, "{nota: " + txt.strip("()").strip() + "}"))
    filas = [(t, partir_guiones(ws)) for t, ws in agrupar_lineas([w for w in blk if w["cl"] in ("letra", "acorde")])]
    filas = [(t, [w for w in ws if w["text"]]) for t, ws in filas]; filas = [(t, ws) for t, ws in filas if ws]
    for t, ws in filas:  # pre-pase: frase escrita en la fuente de acordes = letra (así los acordes de arriba se anclan)
        if any(w["cl"] == "letra" for w in ws): continue
        toks = [(w, limpiar_token(w["text"])) for w in ws if w["cl"] == "acorde"]
        pal = [x for w, x in toks if re.match(r"^[A-Za-zÁ-ú]", x) and not es_acorde6(x) and x.lower() not in RELLENO]
        if len(pal) >= 3 and sum(1 for x in pal if re.fullmatch(r"[a-záéíóúñü'’,.;:!?¡¿]{3,}", x)) >= 2 and not NOTA_OK.match(pal[0]):
            for w, x in toks:
                if x in pal or (not es_acorde6(x) and not JUNK.match(x)): w["cl"] = "letra"
            avisos.append(f"[{nombre}] frase en la fuente de acordes tomada como letra: {' '.join(pal)[:50]!r}")
    cuerpo = []; i = 0; ultimo_top_letra = None; ultimo_acorde = [None]  # P14 v7
    def salto(t):
        if ultimo_top_letra is not None and t - ultimo_top_letra > 27 and cuerpo and cuerpo[-1][1] != "": cuerpo.append((t, ""))
    def solo_acordes(wac): return " ".join("[" + acorde_normal(w["text"]) + "]" for w in wac)
    def fila_letra_sin_acordes(ws):  # P6 v7
        return any(x["cl"] == "letra" for x in ws) and not any(x["cl"] == "acorde" and es_acorde6(limpiar_token(x["text"])) and not JUNK.match(limpiar_token(x["text"])) for x in ws)
    def anclar(wac, i, t):
        nonlocal ultimo_top_letra
        for w in wac: w["text"] = acorde_normal(w["text"])
        j = i + 1  # P6b v7: saltar filas de puro relleno (dígitos de patrón) entre la fila de acordes y la letra
        while j < len(filas) and not any(x["cl"] == "letra" for x in filas[j][1]) and all(JUNK.match(limpiar_token(x["text"])) or not es_acorde6(limpiar_token(x["text"])) for x in filas[j][1]) and filas[j][0] - t < 20: j += 1
        if j < len(filas) and filas[j][0] - t < 20 and any(x["cl"] == "letra" for x in filas[j][1]) and not fila_letra_sin_acordes(filas[j][1]):  # P6c v7
            t2, ws2 = filas[j]; salto(t2)
            wac2 = [x for x in ws2 if x["cl"] == "acorde" and es_acorde6(limpiar_token(x["text"])) and not JUNK.match(limpiar_token(x["text"]))]
            for x in wac2: x["text"] = acorde_normal(limpiar_token(x["text"]))
            cuerpo.append((t2, insertar_por_coordenadas(wac + wac2, [x for x in ws2 if x["cl"] == "letra"]))); ultimo_top_letra = t2; return j - i + 1
        if j < len(filas) and fila_letra_sin_acordes(filas[j][1]) and filas[j][0] - t < 20:
            t2, ws2 = filas[j]; salto(t2)
            cuerpo.append((t2, insertar_por_coordenadas(wac, [x for x in ws2 if x["cl"] == "letra"]))); ultimo_top_letra = t2; return j - i + 1
        salto(t); cuerpo.append((t, " ".join("[" + w["text"] + "]" for w in wac))); ultimo_top_letra = t; return 1
    while i < len(filas):
        t, ws = filas[i]
        letra = [w for w in ws if w["cl"] == "letra"]
        for w in ws:
            if w["cl"] == "acorde": w["text"] = limpiar_token(w["text"])
        ac = [w for w in ws if w["cl"] == "acorde" and w["text"]]
        prev_fila = None  # P14/P14b v7
        for w in sorted(ac, key=lambda x: x["x0"]):
            if re.fullmatch(r"/[A-Ga-g](?:#|b)?", w["text"]):
                base = prev_fila or ultimo_acorde[0]
                if base: w["text"] = base + "/" + w["text"][1:].upper()
            elif es_acorde6(w["text"]) and not JUNK.match(w["text"]) and re.match(r"^\(?[A-G]", w["text"]): prev_fila = acorde_normal(w["text"]).split("/")[0]
        wac = [w for w in ac if es_acorde6(w["text"]) and not JUNK.match(w["text"]) and re.match(r"^\(?[A-G]|^(?:DO|RE|MI|FA|SOL|LA|SI|Do|Re|Mi|Fa|Sol|La|Si)", w["text"])]  # P15 v7
        if wac: ultimo_acorde[0] = acorde_normal(wac[-1]["text"]).split("/")[0]
        resto = [w["text"] for w in ac if w not in wac]
        if letra:
            # fila de letra (con o sin acordes/relleno a la misma altura)
            if wac:
                for w in wac: w["text"] = acorde_normal(w["text"])
                salto(t); cuerpo.append((t, insertar_por_coordenadas(wac, letra)))
                avisos.append(f"[{nombre}] acordes en la misma fila que la letra, anclados por posición: {' '.join(w['text'] for w in wac)}")
            else:
                salto(t); cuerpo.append((t, " ".join(w["text"] for w in letra)))
            ultimo_top_letra = t
            basura = [x for x in resto if not JUNK.match(x) and x.lower() not in RELLENO]
            if basura: avisos.append(f"[{nombre}] descartado junto a la letra: {' '.join(basura)!r}")
            i += 1; continue
        if not ac: i += 1; continue
        if wac and all(JUNK.match(x) for x in resto):
            n = anclar(wac, i, t)
            if resto: avisos.append(f"[{nombre}] fila de acordes con relleno {' '.join(resto)!r}: " + ("anclados a la letra de abajo" if n == 2 else "solo los acordes"))
            i += n; continue
        if not wac and all(JUNK.match(x) for x in resto): i += 1; continue
        palabras = [x for x in resto if re.match(r"^[A-Za-zÁ-ú]", x) and x.lower() not in RELLENO]
        if palabras and set(x.lower() for x in resto) <= RELLENO | {"a"}: i += 1; continue
        if palabras and "video" in " ".join(palabras).lower(): i += 1; continue
        if len(palabras) >= 3 and sum(1 for x in palabras if re.fullmatch(r"[a-záéíóúñü'’,.;:!?¡¿]{3,}", x)) >= 2 and not NOTA_OK.match(palabras[0]):
            # frase en la fuente de los acordes: es letra (p. 122 Día de suerte escribe toda la letra así)
            for w in ac:
                if w not in wac: w["cl"] = "letra"
            letra2 = [w for w in ac if w["cl"] == "letra"]
            for w in wac: w["text"] = acorde_normal(w["text"])
            salto(t); cuerpo.append((t, insertar_por_coordenadas(wac, letra2) if wac else " ".join(w["text"] for w in letra2)))
            ultimo_top_letra = t; avisos.append(f"[{nombre}] frase en la fuente de acordes tomada como letra: {' '.join(w['text'] for w in letra2)[:50]!r}")
            i += 1; continue
        if palabras and all(len(x) <= 3 and not re.search(r"\d", x) for x in resto):  # "p i m a", "ami", "e r a f r a s e"
            if wac: i += anclar(wac, i, t); continue  # P22 v7: letras de digitación junto a acordes reales: se anclan los acordes
            i += 1; continue
        if palabras and re.fullmatch(r"(da)+|(du ?)+|vec", " ".join(palabras).lower()): i += 1; continue
        if palabras:
            txt = " ".join(x for x in resto if not JUNK.match(x) or NOTA_OK.match(x))
            if wac and i + 1 < len(filas) and fila_letra_sin_acordes(filas[i+1][1]) and filas[i+1][0] - t < 20:  # P17 v7: rótulo de recuadro en la fila de acordes: los acordes se anclan a la letra de abajo
                avisos.append(f"[{nombre}] rótulo '{txt}' junto a acordes: descartado, acordes anclados"); i += anclar(wac, i, t); continue
            salto(t); cuerpo.append((t, "{nota: " + txt + "}"))
            if wac: cuerpo.append((t + 0.1, solo_acordes(wac)))
            ultimo_top_letra = t; avisos.append(f"[{nombre}] fila '{txt}' → nota" + (" + acordes " + " ".join(acorde_normal(w['text']) for w in wac) if wac else ""))
            i += 1; continue
        if wac: i += anclar(wac, i, t); continue
        i += 1
    for tn, txt in notas:
        pos = next((k for k, (tt, _) in enumerate(cuerpo) if tt > tn), len(cuerpo))
        cuerpo.insert(pos, (tn, txt))
    def puntos(x):
        x = re.sub(r"\s?\.\s?(\[[^\]]+\])\s?\.(?:\s?\.)*", r" \1...", x)
        x = re.sub(r"(?:\s*\.){2,}", "...", x)
        x = re.sub(r"\s+\.(\s|$)", r".\1", x)
        x = re.sub(r"\s*\.\.\.\s*(\[[^\]]+\])\s*", r" \1", x); x = re.sub(r"(\[[^\]]+\])\.\.\.\s*", r"\1", x)
        x = re.sub(r"\s*\.\.\.\s*", " ", x); x = re.sub(r"(\w)\.\s+(?=[a-záéíóúñ])", r"\1 ", x)
        return re.sub(r"\s{2,}", " ", x).strip()
    lineas = [puntos(x) if not x.startswith("{") else x for _, x in cuerpo]
    while lineas and lineas[0] == "": lineas.pop(0)
    return lineas

def meta_de(blks, nombre, avisos):
    """Artista y cejilla a partir de TODAS las líneas meta del título (pueden partirse entre columnas: '(Ricardo' / 'Arjona)')."""
    ws = [w for blk in blks for w in blk if w["cl"] == "meta" and not re.fullmatch(r"\d+", w["text"].strip())]  # P21 v7: sin números sueltos (folio)
    txt = " ".join(" ".join(w["text"] for w in l) for _, l in agrupar_lineas(ws)).strip()
    meta = {"artista": None, "cejilla": 0}
    if not txt: return meta
    m = re.search(r"\(([^()]*?)\)", txt) or re.search(r"\(([^()]*)$", txt) or re.search(r"^([^()]*)\)", txt)
    if m: meta["artista"] = re.sub(r"\s+", " ", m.group(1)).strip(" -")
    else:
        libre = re.sub(r"(?i)\bcapo\s*(I{1,3}|IV|V|VI{0,3}|\d)\b|\bC\s*(I{1,3}|IV|V|VI{0,3})\b", "", txt).strip()  # P2 v7
        if re.search(r"[A-Za-z]{3,}", libre) and not re.fullmatch(r"[\d\s()-]+", libre): meta["artista"] = libre
    m = re.search(r"(?i)\bcapo\s*(I{1,3}|IV|V|VI{0,3}|\d)\b", txt) or re.search(r"\bC\s*(I{1,3}|IV|V|VI{0,3}|i{1,3})\b", txt) or re.search(r"\)\s*(I{1,3}|IV|V|VI{0,3})\b(?!\s*[a-z])", txt)  # P2/P21/P23 v7: Capo; romano tras el artista; "C i" en minúscula
    if m: meta["cejilla"] = ROMANOS.get(m.group(1).upper()) or int(m.group(1))
    if not meta["artista"]: avisos.append(f"[{nombre}] línea de artista no reconocida: {txt!r}")
    return meta

def importar_titulo(T, subbloques, pagina, avisos):
    meta = meta_de(subbloques, T["titulo"], avisos)
    lineas = []
    for k, blk in enumerate(subbloques):
        l2 = cuerpo_de([w for w in blk if w["cl"] != "meta"], T["titulo"] + (" (cont.)" if k else ""), avisos)
        if l2: lineas += ([""] if lineas else []) + l2
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
    cuerpos = asignar_cuerpos(titulos, words, avisos)
    for T in titulos:
        if quiero and T["titulo"] != quiero: continue
        res = importar_titulo(T, cuerpos[id(T)], n, avisos)
        if "--diag" in a: print(f"--- {T['titulo']} ({T['lado']}, top {T['t0']:.0f}, x {T['x0']:.0f}-{T['x1']:.0f})")
        if salida and quiero: open(salida, "w", encoding="utf-8").write(res); print(f"ok -> {salida}")
        else: print(res)
    for av in avisos: print("⚠", av, file=sys.stderr)

# P8 v7 (18-sep): dos acordes que caen en la misma posición de la letra (misma sílaba o final de línea) salían
# invertidos: insertar_por_coordenadas inserta de derecha a izquierda y, a igual posición, el último insertado
# queda más a la izquierda. Se conserva el orden de la hoja (por x) insertando en orden inverso a igual posición.
def insertar_por_coordenadas(acordes, letra_ws):
    texto = ""; offs = []
    for w in letra_ws:
        if texto: texto += " "
        offs.append((len(texto), w)); texto += w["text"]
    inserts = []
    for k, a in enumerate(sorted(acordes, key=lambda a: a["x0"])):
        cx = a["x0"] + 0.5; dest = None
        for off, w in offs:
            if w["x0"] <= cx <= w["x1"]: dest = (off, w); break
        if dest is not None:
            off, w = dest; n = len(w["text"]); ancho = max(w["x1"] - w["x0"], 0.1)
            idx = off + max(0, min(n - 1, int((cx - w["x0"]) / ancho * n)))
        else:
            despues = [(off, w) for off, w in offs if w["x0"] > cx]
            idx = despues[0][0] if despues else len(texto)
        inserts.append((idx, k, a["text"]))
    for idx, k, ac in sorted(inserts, key=lambda p: (-p[0], -p[1])):
        texto = texto[:idx] + "[" + ac + "]" + texto[idx:]
    return texto
