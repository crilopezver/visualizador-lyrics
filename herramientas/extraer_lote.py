#!/usr/bin/env python3
"""Extrae todas las canciones del cancionero (p. A-B) con el script v6 y les da estructura automática:
bloques separados por línea en blanco → "Intro" (primer bloque solo acordes), "Instrumental N" (otros solo
acordes), "Sección N" (con letra); un bloque cuya letra repite la de uno anterior reutiliza esa sección
(regla de Cristhian, 16-sep: estructura dudosa → Sección 1, 2…). No sube nada: escribe lote/*.cho y reporte.tsv."""
import sys, os, re, json, unicodedata, datetime, csv
sys.dont_write_bytecode = True
HERR = "/Users/cristhianlopez/Claude/Projects/Visualizador Lyrics/app/herramientas"
V6 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "v6")
sys.path.insert(0, HERR); sys.path.insert(0, V6)
import pdfplumber
import importar_cancionero as ic

PDF = "/Users/cristhianlopez/Library/CloudStorage/OneDrive-Personal/ACORDES DE CANCIONES/CANCIONEROS.pdf"
A, B = int(sys.argv[1]), int(sys.argv[2])
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cho")
sys.path.insert(0, HERR)
os.makedirs(OUT, exist_ok=True)
SALTAR = {("HOTEL CALIFORNIA", 307), ("LA PANTERA ROSA", 313), ("QUIERO SER TU SOMBRA", 332), ("ROMANCE", 336), ("88NN", 0)}

def norm(t):
    t = unicodedata.normalize("NFD", t.lower()); t = re.sub(r"[̀-ͯ]", "", t)
    return re.sub(r"[^a-z0-9]+", " ", t).strip()
def letra_de(bloque):
    return norm(" ".join(re.sub(r"\[[^\]]*\]", "", l) for l in bloque if not l.startswith("{")))

ETIQ = {"estrofa": "Estrofa", "verso": "Estrofa", "coro": "Coro", "estribillo": "Coro", "precoro": "Pre-coro", "pre-coro": "Pre-coro", "pre coro": "Pre-coro",
        "puente": "Puente", "interludio": "Interludio", "final": "Final", "solo": "Solo", "intro": "Intro", "hablado": "Hablado", "outro": "Final"}
from ortografia_letras import UNIDAD, corregir_unidad
def ortografia(l):
    if l.startswith("{") or not l.strip(): return l
    def rep(m):
        nuevo, c = corregir_unidad(m.group(1))
        return m.group(1) if (c and c[0] == "MANUAL") else nuevo
    return UNIDAD.sub(rep, l)

def estructurar(lineas):
    """Bloques por línea en blanco. Nombres: etiqueta de la hoja si el bloque empieza con {nota: coro/estrofa/...};
    si no, por repetición: el bloque de letra más repetido = Coro; otro repetido que siempre precede al Coro = Pre-coro,
    si no Coro 2; los no repetidos = Estrofa N; sin ninguna repetición → Sección N (regla de Cristhian: dudoso → Sección).
    Solo acordes: Intro (primer bloque) / Instrumental N. Devuelve (cuerpo, arreglo, n_secciones_con_letra)."""
    bloques = []; cur = []
    for l in lineas:
        if l.strip() == "":
            if cur: bloques.append(cur); cur = []
        else: cur.append(l)
    if cur: bloques.append(cur)
    info = []  # por bloque: dict(lineas, letra, etiqueta)
    for b in bloques:
        etiqueta = None
        m = re.match(r"\{nota: (.*)\}$", b[0]) if b else None
        if m:
            k = re.sub(r"[\d\s]+$", "", m.group(1).strip().lower())
            if k in ETIQ: etiqueta = ETIQ[k]; b = b[1:]
        if not b: continue
        tiene_letra = any(re.sub(r"\[[^\]]*\]", "", l).strip() for l in b if not l.startswith("{"))
        info.append({"lineas": b, "letra": letra_de(b) if tiene_letra else None, "etiqueta": etiqueta})
    # grupos de repetición
    grupos = []  # cada grupo: lista de índices
    for i, d in enumerate(info):
        if d["letra"] is None: d["grupo"] = None; continue
        ln = d["letra"]
        for g in grupos:
            r = info[g[0]]["letra"]
            if r == ln or (len(ln) > 40 and (r.startswith(ln) or ln.startswith(r)) and abs(len(r) - len(ln)) < 25): g.append(i); d["grupo"] = g; break
        else: g = [i]; grupos.append(g); d["grupo"] = g
    repetidos = [g for g in grupos if len(g) > 1]
    nombres = {}  # id(grupo) -> nombre
    if repetidos:
        coro = max(repetidos, key=lambda g: (len(g), -g[0]))
        nombres[id(coro)] = "Coro"; n_coro = 1; n_pre = 0
        for g in repetidos:
            if g is coro: continue
            if all(k + 1 < len(info) and info[k + 1].get("grupo") is coro for k in g): n_pre += 1; nombres[id(g)] = "Pre-coro" if n_pre == 1 else f"Pre-coro {n_pre}"
            else: n_coro += 1; nombres[id(g)] = f"Coro {n_coro}"
    secciones = []; arreglo = []; n_sec = 0; n_est = 0; n_inst = 0; usados = set(); definidos = set()
    def unico(nombre):
        if nombre not in usados: usados.add(nombre); return nombre
        k = 2
        while f"{nombre} {k}" in usados: k += 1
        usados.add(f"{nombre} {k}"); return f"{nombre} {k}"
    for i, d in enumerate(info):
        if d["letra"] is None:
            if d["etiqueta"]: nombre = unico(d["etiqueta"])
            elif i == 0: nombre = unico("Intro")
            else: n_inst += 1; nombre = unico("Instrumental")
            secciones.append((nombre, d["lineas"])); arreglo.append(nombre); continue
        g = d["grupo"]
        if id(g) in definidos: arreglo.append(nombres[id(g)]); continue
        if d["etiqueta"]: nombre = unico(d["etiqueta"])
        elif id(g) in nombres: nombre = unico(nombres[id(g)])
        elif repetidos: nombre = unico("Estrofa"); 
        else: n_sec += 1; nombre = unico(f"Sección {n_sec}")
        nombres[id(g)] = nombre; definidos.add(id(g))
        if d["letra"] is not None: n_sec += (0 if nombre.startswith("Sección") else 1)
        secciones.append((nombre, d["lineas"])); arreglo.append(nombre)
    # "Estrofa" sola → "Estrofa 1"? no: si solo hay una queda "Estrofa"; si hay varias ya llevan número (unico)
    # renumerar Estrofa/Estrofa 2 → Estrofa 1/Estrofa 2 cuando hay más de una
    if any(n.startswith("Estrofa ") for n, _ in secciones) and any(n == "Estrofa" for n, _ in secciones):
        secciones = [("Estrofa 1" if n == "Estrofa" else n, b) for n, b in secciones]; arreglo = ["Estrofa 1" if n == "Estrofa" else n for n in arreglo]
    if any(n.startswith("Instrumental ") for n, _ in secciones) and any(n == "Instrumental" for n, _ in secciones):
        secciones = [("Instrumental 1" if n == "Instrumental" else n, b) for n, b in secciones]; arreglo = ["Instrumental 1" if n == "Instrumental" else n for n in arreglo]
    todo = " ".join(re.sub(r"\[[^\]]*\]", "", l) for _, b in secciones for l in b if not l.startswith("{")).lower().split()
    ingles = sum(1 for w in todo if w in {"the", "you", "and", "your", "my", "love", "i'm", "i’m", "don't", "don’t", "with", "that", "this", "it's", "it’s", "baby", "never", "just"}) >= max(3, len(todo) * 0.04)
    cuerpo = []
    for nombre, b in secciones:
        cuerpo.append("{seccion: " + nombre + "}"); cuerpo += [l if ingles else ortografia(l) for l in b]; cuerpo.append("")
    return cuerpo, arreglo, len([1 for n, _ in secciones if not n.startswith(("Intro", "Instrumental"))])

pdf = pdfplumber.open(PDF)
filas = []
for n in range(A, B + 1):
    pg = pdf.pages[n - 1]
    titulos, words, mid = ic.bloques_pagina(pg)
    avisos = []
    cuerpos = ic.asignar_cuerpos(titulos, words, avisos)
    for T in titulos:
        if (T["titulo"], n) in SALTAR or T["titulo"] == "88NN": continue
        cho = ic.importar_titulo(T, cuerpos[id(T)], n, avisos)
        cab, cuerpo = cho.split("\n\n", 1) if "\n\n" in cho else (cho, "")
        lineas = cuerpo.rstrip("\n").split("\n")
        letra = " ".join(re.sub(r"\[[^\]]*\]", "", l) for l in lineas if not l.startswith("{")).split()
        acordes = re.findall(r"\[([^\]]+)\]", cuerpo)
        est, arreglo, n_sec = estructurar(lineas)
        cabl = cab.split("\n")
        cabl.insert(len(cabl) - 1, "{arreglo: " + ", ".join(arreglo) + "}")  # antes de {estado}
        final = "\n".join(cabl) + "\n\n" + "\n".join(est).rstrip("\n") + "\n"
        mios = [a for a in avisos if a.startswith(f"[{T['titulo']}")]
        graves = [a for a in mios if "fila descartada (mixta)" in a and re.search(r"[a-záéíóúñ]{3,}", a.split(": ", 1)[-1].lower())]
        meta = [a for a in mios if "meta no reconocida" in a]
        slug = f"p{n:03d}_" + ic.slug(T["titulo"])
        open(os.path.join(OUT, slug + ".cho"), "w", encoding="utf-8").write(final)
        artista = re.search(r"\{artista: (.*)\}", cab); tono = re.search(r"\{tono: (.*)\}", cab)
        filas.append([n, T["titulo"], slug, len(letra), len(acordes), n_sec, len(arreglo), artista.group(1) if artista else "", tono.group(1) if tono else "",
                      len(graves), len(meta), " | ".join(x.split("] ", 1)[-1] for x in graves)[:200], " | ".join(x.split("] ", 1)[-1] for x in meta)[:120]])
    open(os.path.join(os.path.dirname(OUT), "avisos.txt"), "a", encoding="utf-8").write("".join(f"p.{n} {a}\n" for a in avisos))
    for a in avisos:
        if a.startswith("letra sin título"): filas.append([n, "(sin título)", "", 0, 0, 0, 0, "", "", 0, 0, a[:200], ""])
with open(os.path.join(os.path.dirname(OUT), f"reporte_{A}_{B}.tsv"), "w", newline="") as f:
    w = csv.writer(f, delimiter="\t"); w.writerow(["pag", "titulo", "archivo", "letra", "acordes", "secciones", "arreglo", "artista", "tono", "descartes_con_letra", "meta_raras", "descartes", "metas"]); w.writerows(filas)
print(len(filas), "canciones →", OUT)
