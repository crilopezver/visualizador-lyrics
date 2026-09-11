import re, sys, glob, pathlib, json
# palabras sin ambigüedad que en las hojas suelen venir sin tilde o mal escritas
DIC = {
 'corazon':'corazón','razon':'razón','cancion':'canción','pasion':'pasión','ilusion':'ilusión','emocion':'emoción','atencion':'atención','condicion':'condición','tradicion':'tradición','decision':'decisión',
 'asi':'así','aqui':'aquí','alli':'allí','alla':'allá','ahi':'ahí','despues':'después','tambien':'también','jamas':'jamás','quizas':'quizás','ademas':'además','detras':'detrás','atras':'atrás',
 'facil':'fácil','dificil':'difícil','unico':'único','unica':'única','ultimo':'último','ultima':'última','musica':'música','rapido':'rápido','lagrimas':'lágrimas','lagrima':'lágrima','arbol':'árbol','angel':'ángel','jovenes':'jóvenes','cuantas':'cuántas','moririan':'morirían','ningun':'ningún','tambien':'también','ademas':'además','corazones':'corazones',
 'dia':'día','dias':'días','mia':'mía','mio':'mío','mias':'mías','mios':'míos','todavia':'todavía','alegria':'alegría','fantasia':'fantasía','fantasias':'fantasías','melodia':'melodía','compañia':'compañía','energia':'energía','policia':'policía','poesia':'poesía',
 'tenia':'tenía','ponia':'ponía','habia':'había','queria':'quería','sabia':'sabía','vivia':'vivía','podia':'podía','decia':'decía','sentia':'sentía','moria':'moría','dormia':'dormía','existia':'existía','ponian':'ponían','tenian':'tenían','hacian':'hacían',
 'senti':'sentí','vivi':'viví','perdi':'perdí','sufri':'sufrí','sali':'salí','mori':'morí','segui':'seguí','oi':'oí','fui':'fui',
 'sere':'seré','ire':'iré','dare':'daré','estare':'estaré','tendre':'tendré','podre':'podré','vendre':'vendré','volvere':'volveré','amare':'amaré','sabre':'sabré','hare':'haré','dire':'diré','vere':'veré','cantare':'cantaré','esperare':'esperaré','buscare':'buscaré','llegare':'llegaré','olvidare':'olvidaré',
 'estan':'están','seran':'serán','diran':'dirán','iran':'irán','tendran':'tendrán','volveran':'volverán','podran':'podrán','haran':'harán','estaran':'estarán',
 'oido':'oído','caido':'caído','reir':'reír','oir':'oír','pais':'país','raiz':'raíz','sonreir':'sonreír','baul':'baúl','ataud':'ataúd',
 'incetidumbre':'incertidumbre','enfria':'enfría','vacio':'vacío','rincon':'rincón','pasion':'pasión','tonteria':'tontería','quedate':'quédate','dejame':'déjame','dime':'dime','mirame':'mírame','cuentame':'cuéntame','llamame':'llámame','besame':'bésame','abrazame':'abrázame','perdoname':'perdóname','olvidame':'olvídame','escuchame':'escúchame','susurrame':'susúrrame',
 'aca':'acá','mas':'más','esta':None,'estas':None,'el':None,'tu':None,'si':None,'mi':None,'se':None,'solo':None,'que':None,'como':None,'cuando':None,'donde':None,
}
# 'None' = ambiguas: no se tocan; 'mas' sí se corrige (en letras casi siempre es "más")
UNIDAD = re.compile(r"((?:\[[^\]]*\]|[A-Za-zÁ-ÿñÑ])+)")
def corregir_unidad(u):
    plano = re.sub(r'\[[^\]]*\]', '', u)
    if not plano: return u, None
    low = plano.lower()
    if low not in DIC or DIC[low] is None: return u, None
    nuevo = DIC[low]
    if plano[0].isupper(): nuevo = nuevo[0].upper() + nuevo[1:]
    if plano.isupper(): nuevo = nuevo.upper()
    if len(nuevo) != len(plano):
        if '[' in u: return u, ('MANUAL', plano, nuevo)
        return nuevo, (plano, nuevo)
    # misma longitud: sustituir letra a letra conservando los acordes en su sitio
    out=''; i=0
    for tag_or_ch in re.findall(r'\[[^\]]*\]|.', u):
        if tag_or_ch.startswith('['): out += tag_or_ch
        else: out += nuevo[i]; i += 1
    return out, (plano, nuevo)
def procesar(ruta, aplicar=False):
    lineas = pathlib.Path(ruta).read_text().split('\n'); cambios=[]; manual=[]
    for n,l in enumerate(lineas):
        if l.startswith('{') or not l.strip(): continue
        def rep(m):
            nuevo, c = corregir_unidad(m.group(1))
            if c and c[0]=='MANUAL': manual.append((n+1, c[1], c[2])); return m.group(1)
            if c: cambios.append((n+1, c[0], c[1]))
            return nuevo
        lineas[n] = UNIDAD.sub(rep, l)
    if aplicar and cambios: pathlib.Path(ruta).write_text('\n'.join(lineas))
    return cambios, manual
if __name__ == '__main__':
    aplicar = '--aplicar' in sys.argv; total=0
    for f in sorted(glob.glob('datos/canciones/*.cho')):
        c, m = procesar(f, aplicar)
        if c or m:
            print(f"{pathlib.Path(f).stem} ({len(c)} cambios)"); total += len(c)
            for n,a,b in c: print(f"   l{n}: {a} → {b}")
            for n,a,b in m: print(f"   l{n}: {a} → {b}  (a mano: cambia de largo y tiene acorde dentro)")
    print(f"\nTOTAL {total} cambios" + (" APLICADOS" if aplicar else " propuestos (no aplicados)"))
