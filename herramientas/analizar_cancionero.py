#!/usr/bin/env python3
"""Barrido de CANCIONEROS.pdf: por página y por canción, cuántas palabras hay de cada clase
(letra / acorde / tab / diagrama / meta / nota / rara) para clasificar qué es importable.
Solo lee. Escribe un TSV en el scratchpad."""
import sys, os, csv
sys.dont_write_bytecode = True
HERR = "/Users/cristhianlopez/Claude/Projects/Visualizador Lyrics/app/herramientas"
sys.path.insert(0, HERR); sys.path.insert(0, os.environ.get("COPIA", HERR))
import pdfplumber
from importar_cancionero import bloques_pagina
from collections import Counter

PDF = "/Users/cristhianlopez/Library/CloudStorage/OneDrive-Personal/ACORDES DE CANCIONES/CANCIONEROS.pdf"
A, B = int(sys.argv[1]), int(sys.argv[2])
OUT = sys.argv[3]

def clase_amplia(w):
    f = w["fontname"].split("+")[-1]; s = round(w["size"])
    if not w["text"].strip(): return None
    if "Wingdings" in f: return "diagrama"
    if "Tekton" in f: return "tab"
    if "Maiandra" in f: return "titulo" if s >= 16 else "letra"
    if "ComicSans" in f:
        return {9: "acorde", 10: "meta", 6: "nota"}.get(s, "etiqueta")
    if "Arial" in f: return "arial"
    return "rara:" + f + str(s)

pdf = pdfplumber.open(PDF)
rows = []
for n in range(A, B + 1):
    pg = pdf.pages[n - 1]
    todas = [w for w in pg.extract_words(extra_attrs=["size", "fontname"]) if w["text"].strip()]
    for w in todas: w["ca"] = clase_amplia(w)
    titulos, words, mid = bloques_pagina(pg)
    mid = pg.width / 2
    if not titulos:
        c = Counter(w["ca"] for w in todas)
        rows.append([n, "", "(sin título)", c["letra"], c["acorde"], c["tab"], c["diagrama"], c["meta"], c["nota"],
                     sum(v for k, v in c.items() if k and k.startswith("rara")), ""])
        continue
    for T in titulos:
        lado = T["lado"]
        blk = [w for w in todas if ((w["x0"] < mid) if lado == "I" else (w["x0"] >= mid)) and T["t0"] + 5 < w["top"] < T["t_fin"] and w["ca"] != "titulo"]
        c = Counter(w["ca"] for w in blk)
        meta = " ".join(w["text"] for w in blk if w["ca"] == "meta")[:60]
        raras = sum(v for k, v in c.items() if k and k.startswith("rara"))
        rows.append([n, lado, T["titulo"], c["letra"], c["acorde"], c["tab"], c["diagrama"], c["meta"], c["nota"], raras, meta])
    # columna sin título con contenido → continuación
    for lado in "ID":
        if not any(T["lado"] == lado for T in titulos):
            en = [w for w in todas if ((w["x0"] < mid) if lado == "I" else (w["x0"] >= mid)) and w["ca"] != "titulo"]
            if en:
                c = Counter(w["ca"] for w in en)
                rows.append([n, lado, "(columna sin título)", c["letra"], c["acorde"], c["tab"], c["diagrama"], c["meta"], c["nota"],
                             sum(v for k, v in c.items() if k and k.startswith("rara")), ""])
with open(OUT, "w", newline="") as f:
    wr = csv.writer(f, delimiter="\t")
    wr.writerow(["pag", "col", "titulo", "letra", "acorde", "tab", "diagrama", "meta", "nota", "raras", "meta_txt"])
    wr.writerows(rows)
print(f"{len(rows)} filas → {OUT}")
