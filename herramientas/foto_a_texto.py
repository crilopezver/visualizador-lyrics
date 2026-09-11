#!/usr/bin/env python3
"""Foto de hoja impresa → texto para el importador de la app.
Uso: ocr_foto <foto> | python3 foto_a_texto.py [--acordes-debajo|--acordes-arriba] > hoja.txt
- Se queda con la columna principal de la página (la que más texto tiene) e ignora las vecinas.
- Agrupa los fragmentos en líneas por altura; detecta líneas de acordes (notación latina o americana).
- Notación latina (DO RE MI FA SOL LA SI, Dom, Sim, Sol7…) → americana (C D E F G A B, Cm, Bm, G7…).
- Con --acordes-debajo (por defecto: se detecta), cada línea de acordes se sube encima de la letra anterior,
  colocando cada acorde en la columna que le corresponde para que el importador lo ancle a la sílaba.
"""
import sys, json, re
LAT = {'do':'C','re':'D','mi':'E','fa':'F','sol':'G','la':'A','si':'B'}
AM = re.compile(r"^\(?[A-G](?:#|b)?(?:maj|min|dim|aug|sus|add|m|M|\+|°|º|ø|Ø)?\d*(?:\([^)]*\))?(?:sus\d|add\d|maj\d|b\d+|#\d+)*(?:/[A-G](?:#|b)?)?\)?$")
LATRE = re.compile(r"^(do|re|mi|fa|sol|la|si)(#|b)?(m)?(maj7|7|9|6|dim|aug|sus4|sus2|\+)?$", re.I)
# confusiones típicas del OCR en fotocopias: 7 leído como T, Z o /; l/i; m final
OCR_FIX = [(re.compile(r'^(do|re|mi|fa|sol|la|si)(m?)([TZ/?])$', re.I), r'\1\g<2>7'), (re.compile(r'^(so)i(m)$', re.I), r'\1l\2'), (re.compile(r'^S(FA|SOL|DO|RE|MI|LA)$'), r'\1')]
def a_americano(tok):
    t = tok.strip('.,;:()')
    for rx, rep in OCR_FIX: t = rx.sub(rep, t)
    if AM.match(t): return t
    m = LATRE.match(t)
    if not m: return None
    nota, alt, menor, suf = m.groups()
    return LAT[nota.lower()] + (alt or '') + ('m' if menor else '') + (suf or '')
def es_linea_acordes(toks):
    toks = [t for t in toks if t.strip('.,;:()')]
    return bool(toks) and all(a_americano(t) is not None or t in ('|','x2','x3','(bis)','bis') for t in toks)
def main():
    frag = json.load(sys.stdin)
    frag = [f for f in frag if f['t'].strip() and f.get('conf', 1) >= 0.3]
    # ruido: fragmentos solo de dígitos, guiones o puntos (tablaturas, digitaciones, numeración)
    frag = [f for f in frag if re.search(r'[A-Za-zÁ-ÿ]', f['t'])]
    # columnas: se definen por las líneas de LETRA (3+ palabras), agrupando su x de inicio (saltos > 0.08);
    # cada columna abarca desde su x mínimo hasta el borde derecho de sus líneas; la principal es la de más texto.
    letra = sorted([f for f in frag if len(f['t'].split()) >= 3], key=lambda f: f['x'])
    if not letra: letra = sorted(frag, key=lambda f: f['x'])
    grupos, cur = [], [letra[0]]
    for f in letra[1:]:
        if f['x'] - cur[-1]['x'] > 0.08: grupos.append(cur); cur = [f]
        else: cur.append(f)
    grupos.append(cur)
    rangos = [(min(f['x'] for f in g), max(f['x'] + f['w'] for f in g), g) for g in grupos]
    x0, x1, g = max(rangos, key=lambda r: sum(len(f['t']) for f in r[2]))
    # un fragmento pertenece a la columna si empieza dentro de su rango (con holgura) y no invade la columna siguiente
    sig = min([r[0] for r in rangos if r[0] > x1 - 0.02] + [1.0])
    col = [f for f in frag if x0 - 0.06 <= f['x'] <= min(x1 + 0.02, sig - 0.01)]
    # líneas por altura
    col.sort(key=lambda f: f['y'])
    lineas, cur = [], [col[0]]
    for f in col[1:]:
        if abs(f['y'] - cur[0]['y']) < max(0.005, min(f['h'], cur[0]['h']) * 0.45): cur.append(f)  # misma línea solo si está casi a la misma altura
        else: lineas.append(cur); cur = [f]
    lineas.append(cur)
    for l in lineas: l.sort(key=lambda f: f['x'])
    # título = primeras líneas grandes; artista = "(…)"
    alto_medio = sorted(f['h'] for f in col)[len(col) // 2]
    salida, titulo, artista, cuerpo = [], [], '', []
    for l in lineas:
        texto = ' '.join(f['t'] for f in l)
        if not cuerpo and (texto.strip().isupper() and all(f['h'] > alto_medio * 1.3 for f in l) or all(f['h'] > alto_medio * 2.2 for f in l)): titulo.append(texto); continue  # título: mayúsculas y grande
        if not cuerpo and re.match(r'^\(.*\)$', texto.strip()): artista = texto.strip('() '); continue
        cuerpo.append(l)
    tit = ' '.join(titulo)
    m = re.match(r'^(.*?)\s*\((.+)\)\s*$', tit)
    if m and not artista: tit, artista = m.group(1), m.group(2)
    if tit: salida.append(tit.title())
    if artista: salida.append(artista.title())
    salida.append('')
    # detectar si los acordes van debajo: la primera línea de acordes viene después de una de letra
    # separar, en cada línea, la letra de los acordes que quedaron pegados a su derecha (foto inclinada)
    partes = []
    for l in cuerpo:
        k = len(l)
        while k > 0 and es_linea_acordes(l[k-1]['t'].split()): k -= 1
        partes.append((l[:k], l[k:]))
    tipos = [not lt and bool(ac) for lt, ac in partes]
    debajo = '--acordes-arriba' not in sys.argv and ('--acordes-debajo' in sys.argv or (True in tipos and False in tipos and tipos.index(False) < tipos.index(True)))
    def fila_con(fila, l, ancla):
        lx, lw, ltxt = ancla['x'], ancla['w'], ancla['t']
        for f in l:
            for tok in f['t'].split():
                ac = a_americano(tok) or tok
                pos = max(0, round((f['x'] - lx) / lw * len(ltxt))) if lw else 0
                if len(fila) < pos: fila += ' ' * (pos - len(fila))
                elif fila and not fila.endswith(' '): fila += ' '
                if len(fila) > pos and fila[pos:pos+len(ac)].strip(): fila += ac  # ya hay algo: pegar al final
                else: fila = fila[:pos] + ac + fila[pos+len(ac):] if pos < len(fila) else fila + ac
        return fila
    prev_y = None; pend = None  # pend = {'txt','x','w','fila'}: letra esperando sus acordes (cuando van debajo)
    def cerrar():
        nonlocal pend
        if pend:
            if pend['fila'].strip(): salida.append(pend['fila'].rstrip())
            salida.append(pend['txt']); pend = None
    for (lt, ac), l in zip(partes, cuerpo):
        y = l[0]['y']
        if prev_y is not None and y - prev_y > l[0]['h'] * 2.2: cerrar(); salida.append('')
        prev_y = y
        if lt:
            cerrar()
            txt = ' '.join(f['t'] for f in lt)
            ancla = {'x': lt[0]['x'], 'w': (lt[-1]['x'] + lt[-1]['w']) - lt[0]['x'], 't': txt}
            if debajo: pend = {'txt': txt, 'fila': fila_con('', ac, ancla) if ac else '', **ancla}
            else:
                if ac: salida.append(fila_con('', ac, ancla).rstrip())
                salida.append(txt)
        elif ac:
            if debajo and pend: pend['fila'] = fila_con(pend['fila'], ac, {'x': pend['x'], 'w': pend['w'], 't': pend['txt']})
            else: salida.append(' '.join(a_americano(t) or t for f in ac for t in f['t'].split()))
    cerrar()
    print('\n'.join(salida))
if __name__ == '__main__': main()
