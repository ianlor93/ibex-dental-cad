#!/usr/bin/env python3
# SELF-TEST PASSO B + IBEX-GEN3-28-7 (read-only, file temporanei in /tmp).
# Copre i 7 gate PASSO B (gen-1/gen-2/janitor) + i gate G8-G13 di gen-3.
#
# ⚠ GIRA SOLO COL PYTHON DI BLENDER: `cryptography` e' pip-installata SOLO li'
#   (Dockerfile:39-57), il python3 di sistema del container NON ce l'ha.
#   docker exec ibex-worker-1 /usr/local/blender/4.5/python/bin/python3.11 /app/scripts/_test_ibx2_passob.py
#   (robusto a un bump di Blender:)
#   docker exec ibex-worker-1 sh -lc 'PYBIN=$(find /usr/local/blender -name "python3*" -path "*/bin/*" | head -n1); "$PYBIN" /app/scripts/_test_ibx2_passob.py'
import sys, os, json, tempfile, shutil
sys.path.insert(0, '/app')
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from modules import ibex_crypto as C
from modules.janitor_logic import janitor_verdict

ok = True
def check(name, cond):
    global ok
    print(('  OK  ' if cond else ' FAIL ') + name)
    ok = ok and bool(cond)

ZIP   = b'PK\x03\x04' + os.urandom(500)          # zip finto (magic + payload)
THUMB = b'\x89PNG\r\n\x1a\n' + os.urandom(300)   # png finto
SESS  = {'stack': [{'id': 3, 'p': {'b': 1, 'a': 2.5}}, {'id': 4}], 'z': True, 'a': [1, 2, 3]}

print('── GATE 7: determinismo canonicalizzazione ──')
d1 = C.canonical_session_digest(SESS)
d2 = C.canonical_session_digest(SESS)
SESS_REORD = {'a': [1, 2, 3], 'z': True, 'stack': [{'id': 3, 'p': {'a': 2.5, 'b': 1}}, {'id': 4}]}
d3 = C.canonical_session_digest(SESS_REORD)
check('stesso oggetto -> stesso digest (2x)', d1 == d2)
check('ordine chiavi irrilevante -> stesso digest', d1 == d3)
_tmp = tempfile.mktemp(suffix='.json')
open(_tmp, 'w').write(json.dumps({'session': SESS}))
d_read = C.canonical_session_digest(json.load(open(_tmp)).get('session'))
os.unlink(_tmp)
check('write->read->digest identico (PHP-scrive / worker-rilegge)', d_read == d1)

print('── GATE 1: IBX1 (legacy) apre ──')
b1 = C.encrypt_bytes(ZIP)
check('decrypt_bytes round-trip', C.decrypt_bytes(b1) == ZIP)
check('read_header_meta None (nessun digest)', C.read_header_meta(b1) is None)

print('── GATE 2: IBX2 gen-1 (ver=0x01, senza digest) apre ──')
b2 = C.pack_ibx2(ZIP, THUMB)                      # session_digest=None -> gen-1
check('byte ver == 0x01', b2[4:5] == b'\x01')
check('decrypt_bytes payload', C.decrypt_bytes(b2) == ZIP)
check('read_thumb', C.read_thumb(b2) == THUMB)
check('read_header_meta None', C.read_header_meta(b2) is None)

print('── GATE 3 (cripto): IBX2 con digest — dal IBEX-GEN3-28-7 esce gen-3 (0x03) ──')
b3 = C.pack_ibx2(ZIP, THUMB, project_id=292, session_digest=d1)
check('byte ver == 0x03 (lo scrittore non emette piu gen-2)', b3[4:5] == b'\x03')
check('decrypt_bytes payload', C.decrypt_bytes(b3) == ZIP)
check('read_thumb', C.read_thumb(b3) == THUMB)
m = C.read_header_meta(b3[:41])                   # lettura PARZIALE 41 byte: offset INVARIATI
check('header project_id (partial read)', m and m['project_id'] == 292)
check('header session_digest (partial read)', m and m['session_digest'] == d1)
b3n = C.pack_ibx2(ZIP, None, project_id=7, session_digest=d1)   # con digest, senza thumb
check('no-thumb: decrypt payload', C.decrypt_bytes(b3n) == ZIP)
check('no-thumb: read_thumb None', C.read_thumb(b3n) is None)
check('no-thumb: header pid', C.read_header_meta(b3n)['project_id'] == 7)

print('── GATE 4/5/6: verdetto janitor (file sintetici, stessa funzione del janitor reale) ──')
_d = tempfile.mkdtemp(prefix='ibex_jtest_')
try:
    mpath = os.path.join(_d, 'manifest.json')
    ipath = os.path.join(_d, 'x.ibex')
    # scenario coerente: manifest(session=SESS, pid=292) + .ibex gen-2(pid=292, digest(SESS))
    open(mpath, 'w').write(json.dumps({'project_id': 292, 'session': SESS}))
    open(ipath, 'wb').write(C.pack_ibx2(ZIP, None, project_id=292, session_digest=C.canonical_session_digest(SESS)))
    # grace=0 per testare la durabilità senza aspettare l'idle
    check('GATE 4 purga corretta: sessione coincide -> purge', janitor_verdict(mpath, ipath, '292', set(), 0) == 'purge')
    check('liveness: job in coda per pid -> skip:queued', janitor_verdict(mpath, ipath, '292', {292}, 0) == 'skip:queued')
    check('idle: manifest fresco + grace alto -> skip:idle', janitor_verdict(mpath, ipath, '292', set(), 99999) == 'skip:idle')
    # GATE 5: modifico la sessione in active/manifest.json -> digest diverge
    open(mpath, 'w').write(json.dumps({'project_id': 292, 'session': dict(SESS, EDIT=True)}))
    check('GATE 5 non-purga: manifest modificato -> skip:unsaved-mismatch', janitor_verdict(mpath, ipath, '292', set(), 0) == 'skip:unsaved-mismatch')
    # GATE 6 (m6): .ibex con project_id diverso dal pid della cartella
    open(mpath, 'w').write(json.dumps({'project_id': 292, 'session': SESS}))
    open(ipath, 'wb').write(C.pack_ibx2(ZIP, None, project_id=999, session_digest=C.canonical_session_digest(SESS)))
    check('GATE 6 m6: header pid 999 != cartella 292 -> skip:m6-wrong-archive', janitor_verdict(mpath, ipath, '292', set(), 0) == 'skip:m6-wrong-archive')
    # header vecchio (gen-1) -> non verificabile
    open(ipath, 'wb').write(C.pack_ibx2(ZIP, None))   # gen-1, nessun digest
    check('header gen-1 senza digest -> skip:old-header', janitor_verdict(mpath, ipath, '292', set(), 0) == 'skip:old-header')
finally:
    shutil.rmtree(_d, ignore_errors=True)


# ═══════════════════════════════════════════════════════════════════════════
# IBEX-GEN3-28-7 — GATE G8-G13: IBX2 gen-3 (ver=0x03, burn nell'header).
#
# In ONDATA 1 lo scrittore di produzione (`pack_ibx2`) NON sa ancora scrivere
# 0x03: la fixture gen-3 la costruisce QUI, byte per byte, con una SECONDA
# implementazione indipendente del layout. E' il punto: se i lettori e questa
# fixture concordano, l'accordo non e' un tautologico "il mio writer rilegge
# se stesso". Il gate incrociato col writer vero (G14) arriva in ONDATA 2.
#
# Layout gen-3:
#   "IBX2"(4) | 0x03(1) | project_id(4 BE) | session_digest(32)
#     | bnonce(12) | blen(4 BE) | GCM(burn_json, THUMB_KEY)   AAD="IBX2\x03"
#     | tnonce(12) | tlen(4 BE) | GCM(thumb_png, THUMB_KEY)   AAD="IBX2\x03"
#     | pnonce(12) | GCM(zip, ARCHIVE_KEY)                    AAD="IBX2\x03"
# ═══════════════════════════════════════════════════════════════════════════

BURN = {'n': 2, 'meshes': ['Lower.stl', 'Upper.stl'],
        'files': {'Upper.stl': 'superiore.obj', 'Lower.stl': 'inferiore.ply'}}


def make_gen3(zip_plain, thumb_png, burn_obj, pid, digest):
    """Fixture gen-3 costruita a mano (implementazione INDIPENDENTE del layout)."""
    hdr = b'IBX2' + b'\x03'
    aad = hdr
    bjson = json.dumps(burn_obj if burn_obj is not None else {}, sort_keys=True,
                       separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    bn = os.urandom(12)
    bct = AESGCM(C.get_thumb_key()).encrypt(bn, bjson, aad)
    if thumb_png:
        tn = os.urandom(12)
        tct = AESGCM(C.get_thumb_key()).encrypt(tn, thumb_png, aad)
    else:
        tn, tct = b'\x00' * 12, b''          # riempitivo: con tlen=0 e' ignorato in lettura
    pn = os.urandom(12)
    pct = AESGCM(C.get_key()).encrypt(pn, zip_plain, aad)
    return (hdr + (int(pid) & 0xFFFFFFFF).to_bytes(4, 'big') + digest
            + bn + len(bct).to_bytes(4, 'big') + bct
            + tn + len(tct).to_bytes(4, 'big') + tct
            + pn + pct)


def make_gen2(zip_plain, thumb_png, pid, digest):
    """Fixture gen-2 a mano. 🔴 Serve perche' dal writer gen-3 in poi NESSUN gen-2
    viene piu creato: gli unici gen-2 al mondo sono gli ARCHIVI GIA' SUL DISCO DEI
    CLIENTI, e questa fixture e' l'unica cosa che continua a coprirne la lettura."""
    hdr = b'IBX2' + b'\x02'
    if thumb_png:
        tn = os.urandom(12)
        tct = AESGCM(C.get_thumb_key()).encrypt(tn, thumb_png, hdr)
    else:
        tn, tct = b'\x00' * 12, b''
    pn = os.urandom(12)
    pct = AESGCM(C.get_key()).encrypt(pn, zip_plain, hdr)
    return (hdr + (int(pid) & 0xFFFFFFFF).to_bytes(4, 'big') + digest
            + tn + len(tct).to_bytes(4, 'big') + tct + pn + pct)


print('── GATE 8: IBX2 gen-3 — header meta con la lettura PARZIALE di 41 byte ──')
b4 = make_gen3(ZIP, THUMB, BURN, 292, d1)
check('byte ver == 0x03', b4[4:5] == b'\x03')
check('magic invariato "IBX2" (formato ADDITIVO)', b4[:4] == b'IBX2')
m4 = C.read_header_meta(b4[:41])              # gli STESSI 41 byte di gen-2
check('G8 header project_id (partial read 41 B)', m4 and m4['project_id'] == 292)
check('G8 header session_digest (partial read 41 B)', m4 and m4['session_digest'] == d1)

print('── GATE 9: read_thumb SALTA il burn e trova la thumb ──')
check('G9 read_thumb == png campione', C.read_thumb(b4) == THUMB)

print('── GATE 10: read_burn — roundtrip canonico del record ──')
_bd = tempfile.mkdtemp(prefix='ibex_gen3_')
try:
    _bp = os.path.join(_bd, 'g3.ibex')
    with open(_bp, 'wb') as _bf:
        _bf.write(b4)
    check('G10 read_burn == record campione', C.read_burn(_bp) == BURN)
    # gen-2 non ha il segmento burn -> None (non un errore). Fixture A MANO: il
    # writer non produce piu gen-2 (vedi make_gen2).
    with open(_bp, 'wb') as _bf:
        _bf.write(make_gen2(ZIP, THUMB, 292, d1))
    check('G10 read_burn su gen-2 -> None', C.read_burn(_bp) is None)
    check('G10 read_burn su path inesistente -> None',
          C.read_burn(os.path.join(_bd, 'non-esiste.ibex')) is None)
    # burn vuoto: SEMPRE cifrato (un solo percorso di scrittura) -> dict vuoto
    with open(_bp, 'wb') as _bf:
        _bf.write(make_gen3(ZIP, THUMB, {}, 292, d1))
    check('G10 burn {} -> dict vuoto (non None)', C.read_burn(_bp) == {})
finally:
    shutil.rmtree(_bd, ignore_errors=True)

print('── GATE 11: decrypt_bytes salta burn+thumb e restituisce il payload ──')
check('G11 decrypt_bytes == zip campione', C.decrypt_bytes(b4) == ZIP)
b4nt = make_gen3(ZIP, None, BURN, 7, d1)
check('G11 gen-3 senza thumb: payload ok', C.decrypt_bytes(b4nt) == ZIP)
check('G11 gen-3 senza thumb: read_thumb None', C.read_thumb(b4nt) is None)
check('G11 gen-3 senza thumb: header pid', C.read_header_meta(b4nt)['project_id'] == 7)

print('── GATE 12: AAD versionata — 0x03→0x02 DEVE fallire per tag GCM ──')
_tampered = b4[:4] + b'\x02' + b4[5:]         # SOLO il byte di versione
_raised = False
try:
    C.decrypt_bytes(_tampered)
except Exception as _e:
    _raised = True
    print('        (sollevato come atteso: %s)' % type(_e).__name__)
check('G12 blob manomesso -> decrypt_bytes SOLLEVA', _raised)
check('G12 blob manomesso -> read_thumb None (mai la png)', C.read_thumb(_tampered) is None)

print('── GATE 13: regressione — gen-1 invariato, gen-2 ANCORA LEGGIBILE ──')
check('G13 pack_ibx2 senza digest emette ancora gen-1 (0x01)',
      C.pack_ibx2(ZIP, THUMB)[4:5] == b'\x01')
check('G13 pack_ibx2 con digest emette gen-3 (0x03)',
      C.pack_ibx2(ZIP, THUMB, project_id=292, session_digest=d1)[4:5] == b'\x03')
# 🔴 Gli archivi dei CLIENTI sul disco sono gen-2: il writer non ne produce piu,
#    quindi queste 5 righe sono l'unica copertura che resta su di loro.
_g2 = make_gen2(ZIP, THUMB, 292, d1)
check('G13 gen-2 (fixture a mano) ver == 0x02', _g2[4:5] == b'\x02')
check('G13 gen-2: payload ancora leggibile', C.decrypt_bytes(_g2) == ZIP)
check('G13 gen-2: thumb ancora leggibile', C.read_thumb(_g2) == THUMB)
check('G13 gen-2: header pid ancora leggibile', C.read_header_meta(_g2[:41])['project_id'] == 292)
check('G13 gen-2: version resta 2', C.read_header_meta(_g2[:41])['version'] == 2)
check('G13 gen-2: read_burn -> None (non ha il segmento)', True)   # gia' provato in G10
check('G13 IBX1 ancora leggibile', C.decrypt_bytes(C.encrypt_bytes(ZIP)) == ZIP)
check('G13 zip in chiaro ancora passthrough', C.decrypt_bytes(ZIP) == ZIP)
check('G13 read_header_meta su gen-1 -> None', C.read_header_meta(C.pack_ibx2(ZIP, THUMB)) is None)

print('── GATE 14: incrocio col WRITER VERO (pack_ibx2 burn=...) ──')
# G8-G13 provano i lettori contro una fixture costruita a mano. G14 chiude il
# cerchio: il writer di PRODUZIONE e i lettori devono concordare, altrimenti
# l'accordo di prima era solo fra due implementazioni entrambe sbagliate.
_w = C.pack_ibx2(ZIP, THUMB, project_id=292, session_digest=d1, burn=BURN)
check('G14 primi 5 byte del writer == IBX2\\x03', _w[:5] == b'IBX2\x03')
_mw = C.read_header_meta(_w[:41])
check('G14 pid ai byte 5-8', _mw and _mw['project_id'] == 292)
check('G14 digest ai byte 9-40', _mw and _mw['session_digest'] == d1)
check('G14 read_thumb sul writer vero', C.read_thumb(_w) == THUMB)
check('G14 decrypt_bytes sul writer vero', C.decrypt_bytes(_w) == ZIP)
check('G14 fixture a mano e writer: stesso prefisso di 5 byte',
      make_gen3(ZIP, THUMB, BURN, 292, d1)[:5] == _w[:5])
_wd = tempfile.mkdtemp(prefix='ibex_g14_')
try:
    _wp = os.path.join(_wd, 'w.ibex')
    with open(_wp, 'wb') as _wf:
        _wf.write(_w)
    check('G14 read_burn sul writer vero == record', C.read_burn(_wp) == BURN)
    # burn omesso -> {} SEMPRE cifrato (un solo percorso di scrittura)
    with open(_wp, 'wb') as _wf:
        _wf.write(C.pack_ibx2(ZIP, THUMB, project_id=292, session_digest=d1))
    check('G14 burn omesso -> {} (sempre cifrato, non None)', C.read_burn(_wp) == {})
    # burn non-dict -> {} (difensivo, nessuna eccezione al save)
    with open(_wp, 'wb') as _wf:
        _wf.write(C.pack_ibx2(ZIP, THUMB, project_id=292, session_digest=d1, burn='spazzatura'))
    check('G14 burn non-dict -> {} (difensivo)', C.read_burn(_wp) == {})
    # un burn grande ma sotto cap resta leggibile
    _big = {'n': 300, 'meshes': ['m%03d.stl' % i for i in range(300)]}
    with open(_wp, 'wb') as _wf:
        _wf.write(C.pack_ibx2(ZIP, THUMB, project_id=292, session_digest=d1, burn=_big))
    check('G14 burn grande (300 mesh) roundtrip', C.read_burn(_wp) == _big)
    check('G14 burn grande: thumb ancora leggibile',
          C.read_thumb(open(_wp, 'rb').read()) == THUMB)
finally:
    shutil.rmtree(_wd, ignore_errors=True)

print('\n' + ('✅ TUTTI I GATE (7 PASSO B + G8-G14 gen-3) OK' if ok else '🔴 CI SONO FAIL'))
sys.exit(0 if ok else 1)
