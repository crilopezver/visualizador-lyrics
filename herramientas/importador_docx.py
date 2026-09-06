#!/usr/bin/env python3
"""Importador de Word (.docx) — Visualizador Lyrics (Pueblerinos). 05-sep-2026.
Lee el XML del documento: la NEGRITA marca el acorde; los tabuladores marcan posición aproximada;
los saltos suaves separan líneas dentro de un párrafo; los títulos son párrafos en negrita y mayúsculas.
Genera un .cho por canción reutilizando convertir() del prototipo (texto "acordes arriba / letra abajo").
No contiene letras.

Uso: python3 importador_docx.py archivo.docx carpeta_salida/
"""
import re, sys, os, zipfile
import xml.etree.ElementTree as ET
from importador_prototipo import convertir, CHORD

W="{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
TAB=8  # columnas por tabulador (aprox.)

def es_negrita(run):
    rpr=run.find(W+"rPr")
    if rpr is None: return False
    b=rpr.find(W+"b")
    if b is None: return False
    v=b.get(W+"val")
    return v not in ("0","false")

def lineas_del_parrafo(p):
    """Devuelve lista de líneas; cada línea = lista de (negrita, texto)."""
    lineas=[[]]
    for run in p.iter(W+"r"):
        b=es_negrita(run)
        for el in run:
            tag=el.tag.replace(W,"")
            if tag=="t": lineas[-1].append((b, el.text or ""))
            elif tag=="tab": lineas[-1].append((b, " "*TAB))
            elif tag in ("br","cr"): lineas.append([])
    return lineas

def linea_a_texto(segs):
    """Une segmentos; junta trozos de negrita contiguos (A + m -> Am). Devuelve (texto, todo_negrita_o_espacio, hay_letra)."""
    partes=[]
    for b,t in segs:
        if partes and partes[-1][0]==b: partes[-1]=(b, partes[-1][1]+t)
        else: partes.append((b,t))
    texto="".join(t for _,t in partes)
    bold_tokens=[tok for b,t in partes if b for tok in t.split()]
    plain_tokens=[tok for b,t in partes if not b for tok in t.split()]
    return texto, partes, bold_tokens, plain_tokens

def a_texto_plano(docx_path):
    """Convierte el docx a una lista de canciones: [(titulo, texto_plano_estilo_cifra)]."""
    z=zipfile.ZipFile(docx_path); root=ET.fromstring(z.read("word/document.xml"))
    canciones=[]; actual=None
    for p in root.iter(W+"p"):
        for segs in lineas_del_parrafo(p):
            texto, partes, bold, plain = linea_a_texto(segs)
            s=texto.strip()
            if not s:
                if actual: actual[1].append("")
                continue
            # título: todo negrita, mayúsculas, sin acordes, sin ':'
            if bold and not plain and s.isupper() and ":" not in s and not all(CHORD.match(t) for t in bold) and not re.match(r"^(CORO|ESTROFA|INTRO|PUENTE|FINAL|PRE-?CORO|SOLO)\b", s):
                actual=(s.title(), []); canciones.append(actual); continue
            if actual is None: actual=("Sin Título", []); canciones.append(actual)
            # línea con acordes en negrita
            if bold and all(CHORD.match(t) or t in ("|","-","x2","x3") for t in bold):
                if plain and re.match(r"^(Intro|Coro|Puente|Final|Estrofa|Pre-?coro)", " ".join(plain), re.I):
                    # rótulo de sección sin negrita + acordes en negrita: "Intro: Em Am D"
                    rot=" ".join(t for t in plain if re.search(r"[A-Za-z]", t)).rstrip(":").strip()
                    actual[1].append(f"{rot.capitalize()}: " + " ".join(bold)); continue
                if plain:
                    # mezcla: acordes + letra en la misma línea -> separar (acordes arriba, letra abajo)
                    ac_txt="".join(t if b else " "*len(t) for b,t in partes)
                    ly_txt="".join(t if not b else " "*len(t) for b,t in partes)
                    actual[1].append(ac_txt.rstrip()); actual[1].append(re.sub(r"^\s+","",ly_txt).rstrip()); continue
                actual[1].append(texto.rstrip()); continue
            # encabezados tipo "Intro: Em - Am" o "Intro y Coro: Am G | G Am"
            actual[1].append(re.sub(r"\s*-\s*"," ",texto).rstrip() if re.match(r"^\s*(Intro|Coro|Puente|Final)[^:]*:", s, re.I) else texto.rstrip())
    return canciones

def importar(docx_path, carpeta):
    os.makedirs(carpeta, exist_ok=True); res=[]
    for titulo, lineas in a_texto_plano(docx_path):
        texto="\n".join(lineas)
        cho=convertir(texto, titulo=titulo, artista="(por definir)")
        cho=cho.replace("{artista: (por definir)}\n","")
        cho=cho.replace("{estado: importada}","{fuente: Word 'Acordes canciones 2'}\n{estado: importada}")
        nombre=re.sub(r"[^a-z0-9]+","-",titulo.lower().replace("ñ","n")).strip("-")+".cho"
        ruta=os.path.join(carpeta, "word_"+nombre)
        open(ruta,"w",encoding="utf-8").write(cho)
        n=len(re.findall(r"\[[^\]]+\]", cho)); unicos=sorted(set(re.findall(r"\[([^\]]+)\]", cho)))
        secs=[l[10:-1] for l in cho.splitlines() if l.startswith("{seccion:")]
        res.append((titulo, ruta, n, unicos, secs, len([l for l in cho.splitlines() if l and not l.startswith('{')])))
    return res

if __name__=="__main__":
    for t,r,n,u,s,nl in importar(sys.argv[1], sys.argv[2]):
        print(f"{t:22} -> {os.path.basename(r):40} {n:3} acordes {u} secciones={s} líneas={nl}")
