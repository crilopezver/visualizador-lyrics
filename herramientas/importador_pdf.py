#!/usr/bin/env python3
"""Importador de PDF por coordenadas — Visualizador Lyrics (Pueblerinos). 05-sep-2026.
Para hojas en PDF con fuente proporcional (Ritmolatino, Cifra Club): usa la posición real
de cada palabra y cada acorde en la página, no las columnas de texto.
Requiere pdfplumber. No contiene letras.

Uso: python3 importador_pdf.py archivo.pdf "TÍTULO EN MAYÚSCULAS" salida.cho [--pagina N] [--artista A]
"""
import re, sys
import pdfplumber
from collections import defaultdict
from importador_prototipo import CHORD, TOKENS_OK

BASURA_TOK = {"ir","a","video","tutorial","x","X","i","intro","tema","rasgueo","arpegio","variacion","variación","cha"}

def es_acorde(t): return bool(CHORD.match(t)) or t in TOKENS_OK
def es_linea_acordes(ws): return bool(ws) and all(es_acorde(w["text"]) for w in ws)
def es_basura(ws):
    if es_linea_acordes(ws): return False          # un acorde nunca es basura (p. ej. "A")
    toks=[w["text"] for w in ws]
    if all(re.fullmatch(r"[\d\|\-–.·‘’'…]+", t) for t in toks): return True
    if all(len(t)<=1 for t in toks): return True     # patrones de rasgueo/arpegio: "x p i m a", "1 2 3 0"
    if all(t.lower() in BASURA_TOK or re.fullmatch(r"\d+", t) for t in toks): return True
    return False

def agrupar_lineas(words, tol=3):
    words=sorted(words, key=lambda w:(w["top"], w["x0"]))
    lineas=[]
    for w in words:
        if lineas and abs(lineas[-1][0]-w["top"])<=tol: lineas[-1][1].append(w)
        else: lineas.append([w["top"],[w]])
    return [(t, sorted(ws, key=lambda w:w["x0"])) for t,ws in lineas]

def insertar_por_coordenadas(acordes, letra_ws):
    """acordes: lista de words (acorde). letra_ws: words de la línea de letra. Devuelve string ChordPro."""
    # construir texto de la línea y offsets de cada palabra
    texto=""; offs=[]
    for w in letra_ws:
        if texto: texto+=" "
        offs.append((len(texto), w))
        texto+=w["text"]
    inserts=[]
    for a in acordes:
        cx=a["x0"]+0.5  # borde izquierdo del acorde
        # palabra que contiene cx, o la primera que empieza después
        dest=None
        for off,w in offs:
            if w["x0"]<=cx<=w["x1"]: dest=(off,w); break
        if dest is None:
            despues=[(off,w) for off,w in offs if w["x0"]>cx]
            if despues: dest=despues[0]; idx=dest[0]
            else: idx=len(texto)
        if dest is not None and 'idx' not in dir() or dest is not None and dest[1]["x0"]<=cx<=dest[1]["x1"]:
            off,w=dest; n=len(w["text"]); ancho=max(w["x1"]-w["x0"],0.1)
            k=int((cx-w["x0"])/ancho*n); k=max(0,min(n-1,k))   # piso: el acorde entra al inicio de la sílaba bajo su borde izquierdo
            idx=off+k
        inserts.append((idx, a["text"]))
        if 'idx' in dir(): del idx
    # insertar de derecha a izquierda
    for idx,ac in sorted(inserts, key=lambda p:-p[0]):
        texto=texto[:idx]+"["+ac+"]"+texto[idx:]
    return texto

def importar(pdf_path, titulo, salida=None, pagina=None, artista=None):
    with pdfplumber.open(pdf_path) as pdf:
        paginas=[pdf.pages[pagina-1]] if pagina else pdf.pages
        for pg in paginas:
            words=pg.extract_words(extra_attrs=["size"])
            titulos=[w for w in words if w["size"]>=16 and w["text"].isupper()]
            lin_t=agrupar_lineas(titulos)
            # localizar la línea de título que contiene el título buscado
            objetivo=None
            for t,ws in lin_t:
                if " ".join(w["text"] for w in ws).strip()==titulo.upper(): objetivo=(t,ws); break
            if not objetivo: continue
            t0,tws=objetivo
            x_min=min(w["x0"] for w in tws)-40; x_max=max(w["x1"] for w in tws)+40
            # fin: siguiente título más abajo en la misma columna
            siguientes=[t for t,ws in lin_t if t>t0+5 and any(x_min<=w["x0"]<=x_max for w in ws)]
            t_fin=min(siguientes) if siguientes else pg.height
            bloque=[w for w in words if t0+5<w["top"]<t_fin and x_min<=w["x0"]<=x_max and w["size"]<16]
            lineas=agrupar_lineas(bloque)
            # artista: primera línea entre paréntesis
            meta={"titulo": titulo.title(), "artista": artista}
            cuerpo=[]; i=0; ultimo_top_letra=None
            while i<len(lineas):
                t,ws=lineas[i]; txt=" ".join(w["text"] for w in ws)
                if not meta["artista"] and txt.startswith("(") and txt.endswith(")") and not es_linea_acordes(ws):
                    meta["artista"]=txt.strip("()"); i+=1; continue
                m=re.fullmatch(r"C(I{1,3}|IV|V|VI{0,3})", txt.strip())
                if m:
                    meta["cejilla"]={"I":1,"II":2,"III":3,"IV":4,"V":5,"VI":6,"VII":7}[m.group(1)]; i+=1; continue
                if es_basura(ws): i+=1; continue
                if es_linea_acordes(ws):
                    if i+1<len(lineas) and not es_linea_acordes(lineas[i+1][1]) and not es_basura(lineas[i+1][1]) and lineas[i+1][0]-t<20:
                        t_letra=lineas[i+1][0]
                        if ultimo_top_letra is not None and t_letra-ultimo_top_letra>27 and cuerpo and cuerpo[-1]!="": cuerpo.append("")
                        cuerpo.append(insertar_por_coordenadas(ws, lineas[i+1][1])); ultimo_top_letra=t_letra; i+=2; continue
                    cuerpo.append(" ".join("["+w["text"]+"]" for w in ws)); i+=1; continue
                # salto de estrofa si hay hueco vertical grande respecto a la última línea de letra
                if ultimo_top_letra is not None and t-ultimo_top_letra>27 and cuerpo and cuerpo[-1]!="": cuerpo.append("")
                cuerpo.append(txt); ultimo_top_letra=t; i+=1
            out=["{titulo: "+meta["titulo"]+"}"]
            if meta.get("artista"): out.append("{artista: "+meta["artista"]+"}")
            if meta.get("cejilla"): out.append("{cejilla: "+str(meta["cejilla"])+"}")
            out.append("{estado: importada}"); out.append("")
            out+=cuerpo
            res="\n".join(out).rstrip()+"\n"
            if salida: open(salida,"w",encoding="utf-8").write(res)
            return res
    raise SystemExit(f"No encontré el título '{titulo}'")

if __name__=="__main__":
    a=sys.argv[1:]; pagina=int(a[a.index("--pagina")+1]) if "--pagina" in a else None
    artista=a[a.index("--artista")+1] if "--artista" in a else None
    pos=[x for i,x in enumerate(a) if not x.startswith("--") and (i==0 or not a[i-1].startswith("--"))]
    r=importar(pos[0], pos[1], pos[2], pagina, artista)
    print(f"ok -> {pos[2]} ({len(re.findall(r'\[[^\]]+\]', r))} acordes)")
