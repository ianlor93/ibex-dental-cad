import os, base64, json, hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# ═══════════════════════════════════════════════════════════════════════════
# IBX2 (2026-07-20) — thumbnail cifrata a sé, in testa all'archivio.
#
#   IBX1 (legacy, ancora leggibile):
#     "IBX1"(4) | ver(1) | nonce(12) | GCM(zip, ARCHIVE_KEY)          AAD=_HEADER
#
#   IBX2:
#     "IBX2"(4) | ver(1) | thumb_nonce(12) | thumb_len(4, uint32 BE)
#       | GCM(thumbnail_png, THUMB_KEY)      (thumb_len byte, tag incluso)  AAD=_HEADER2
#       | payload_nonce(12) | GCM(zip, ARCHIVE_KEY)                         AAD=_HEADER2
#
#   • Prefisso a lunghezza FISSA = 21 byte (4+1+12+4) → un lettore legge 21 byte,
#     ricava thumb_len, legge SOLO quei byte, decifra la thumb. thumb_len==0 =
#     nessuna thumbnail.
#   • DUE CHIAVI (opzione B): ARCHIVE_KEY (worker-only) cifra il payload; THUMB_KEY
#     (worker + ibex-app PHP) cifra la thumbnail. La compromissione del PHP espone
#     le anteprime, MAI gli archivi. ⛔ ARCHIVE_KEY non deve MAI arrivare a PHP.
#   • decrypt_bytes restituisce SEMPRE il payload zip, sia per IBX1 sia per IBX2:
#     tutti i chiamanti esistenti restano invariati (branch sul magic).
# ═══════════════════════════════════════════════════════════════════════════

_MAGIC      = b'IBX1'
_VERSION    = b'\x01'
_HEADER     = _MAGIC + _VERSION           # 5 byte, AAD del payload IBX1
_MAGIC2     = b'IBX2'
_VERSION2   = b'\x01'
_HEADER2    = _MAGIC2 + _VERSION2          # 5 byte, AAD di ENTRAMBI i segmenti IBX2
_ZIP_MAGIC  = b'PK\x03\x04'
_PREFIX2    = 21                           # 4 + 1 + 12 + 4
_MAX_THUMB  = 2 * 1024 * 1024              # 2 MiB: ceiling difensivo (256² PNG ~30-60 KB) — allineato al PHP

# ── IBX2 gen-2 (PASSO B, 2026-07-21) ────────────────────────────────────────
#   "IBX2"(4) | ver(1)=0x02 | project_id(4, uint32 BE) | session_digest(32)
#     | thumb_nonce(12) | thumb_len(4 BE) | GCM(thumb, THUMB_KEY)
#     | payload_nonce(12) | GCM(zip, ARCHIVE_KEY)                        AAD=_HEADER2_DG
#   • project_id + session_digest a OFFSET FISSO, PRIMA della thumb a lunghezza
#     variabile → una lettura parziale di 41 byte li raggiunge senza decifrare nulla
#     (il janitor VERIFICA il digest e il pid con ~41 B; m6 escluso senza i 105 MB).
#   • Il lettore fa branch su `ver` PRIMA di calcolare qualsiasi offset (0x01 vecchio
#     layout, 0x02 nuovo). AAD distinta ("IBX2\x02") → gen-1 e gen-2 non si confondono.
_VERSION2_DG = b'\x02'
_HEADER2_DG  = _MAGIC2 + _VERSION2_DG       # 5 byte, AAD di ENTRAMBI i segmenti gen-2
_PREFIX2_DG  = 57                           # 4+1 + 4(pid) + 32(digest) + 12(tnonce) + 4(tlen)

# --- IBEX-GEN3-28-7 --- IBX2 gen-3 (2026-07-28) -----------------------------
#   "IBX2"(4) | ver(1)=0x03 | project_id(4 BE) | session_digest(32)
#     | bnonce(12) | blen(4 BE) | GCM(burn_json, THUMB_KEY)      AAD=_HEADER3
#     | tnonce(12) | tlen(4 BE) | GCM(thumb_png, THUMB_KEY)      AAD=_HEADER3
#     | pnonce(12) | GCM(zip, ARCHIVE_KEY)                       AAD=_HEADER3
#   • ADDITIVO: il magic resta "IBX2", cambia SOLO il byte di versione, e quel
#     byte sta dentro l'AAD -> un gen-3 letto da un lettore vecchio fallisce per
#     TAG GCM, mai somiglia a un gen-2 valido. Nessun campo esistente si sposta.
#   • project_id + session_digest restano ai byte 5-8 e 9-40 ESATTAMENTE come
#     gen-2 -> la lettura parziale di 41 byte del janitor (janitor_logic.py:54,
#     _janitor_decide.py:34) resta valida INVARIATA: il 41 non cresce in nessuna
#     delle sue tre sedi.
#   • Il burn sta PRIMA della thumb ma dopo il blocco a offset fisso: un lettore
#     di thumb lo SALTA senza leggerlo (fseek/slice), quindi il costo per card
#     di lobby resta ~30-60 KB, non l'intero archivio.
#   • Il burn e' cifrato sotto THUMB_KEY (deve leggerlo il tier web) -> i nomi
#     mesh non stanno in chiaro su disco. MAI ARCHIVE_KEY.
_VERSION3 = b'\x03'
_HEADER3  = _MAGIC2 + _VERSION3             # 5 byte, AAD dei TRE segmenti gen-3
_PREFIX3  = 57                              # 4+1 + 4(pid) + 32(digest) + 12(bnonce) + 4(blen)
_MAX_BURN = 65536                           # 64 KiB: ceiling difensivo sul json del burn — allineato al PHP


def canonical_session_digest(session):
    """SHA-256 (32 byte) della SESSIONE canonicalizzata deterministicamente.
    UNA sola funzione, usata sia da create_flat_zip (che scrive il digest
    nell'header al save) sia dal janitor (che lo verifica). Applicata all'OGGETTO
    PARSATO — non ai byte grezzi del file — perché active/manifest.json lo scrive
    PHP mentre la copia archiviata la maneggia il worker: canonicalizzando l'oggetto
    (sort_keys + separatori compatti) il digest è identico a prescindere da chi ha
    serializzato. session None/{} → digest dell'oggetto vuoto (deterministico)."""
    canon = json.dumps(session if session is not None else {},
                       sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canon.encode('utf-8')).digest()


def get_key(project_id=None):
    """Chiave d'ARCHIVIO. worker-only. Oggi globale; al passo 2 deriverà per progetto."""
    raw = os.getenv('IBEX_ARCHIVE_KEY')
    if not raw:
        raise RuntimeError('IBEX_ARCHIVE_KEY non impostata')
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise RuntimeError('IBEX_ARCHIVE_KEY non e 32 byte dopo base64')
    return key


def get_thumb_key():
    """Chiave THUMBNAIL. worker + ibex-app (mai Nextcloud). Indipendente dall'archive key."""
    raw = os.getenv('IBEX_THUMB_KEY')
    if not raw:
        raise RuntimeError('IBEX_THUMB_KEY non impostata')
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise RuntimeError('IBEX_THUMB_KEY non e 32 byte dopo base64')
    return key


# ── SCRITTURA ───────────────────────────────────────────────────────────────

def encrypt_bytes(plaintext, project_id=None):
    """IBX1 (legacy write). Mantenuto per compat: un archivio senza thumbnail.
    Il nuovo percorso di scrittura usa pack_ibx2()."""
    key = get_key(project_id)
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plaintext, _HEADER)
    return _HEADER + nonce + ct


def pack_ibx2(zip_plain, thumb_png=None, project_id=None, session_digest=None, burn=None):
    """Confeziona un archivio IBX2. thumb_png=None (o b'') → thumb_len=0 (nessuna
    anteprima, il lettore cade sul placeholder). La thumb è cifrata con THUMB_KEY,
    il payload con ARCHIVE_KEY.

    IBEX-GEN3-28-7: se session_digest (32 byte) è fornito → header **gen-3**
    (ver=0x03) con project_id(uint32 BE) + session_digest agli STESSI offset di
    gen-2 (5-8 e 9-40) + il **segmento burn** cifrato con THUMB_KEY, AAD=_HEADER3.
    Altrimenti → gen-1 (ver=0x01) senza digest, AAD=_HEADER2 (retro-compat).

    ⚠️ Da questa fetta lo scrittore **non emette più gen-2**: gli unici gen-2 al
    mondo sono gli archivi già sul disco dei clienti, che restano LEGGIBILI
    (`decrypt_bytes`/`read_thumb`/`read_header_meta` ramificano ancora su 0x02).

    `burn` = il dict `manifest['burn']` (Inv. 125, TOP-LEVEL, MAI dentro `session`).
    Assente/None/non-dict → `{}`: il segmento è **sempre** cifrato, un solo percorso
    di scrittura. Serializzazione canonica (sort_keys + separatori compatti) come
    `canonical_session_digest`, così il byte-per-byte non dipende dall'ordine."""
    _dg = session_digest is not None and len(session_digest) == 32
    _hdr = _HEADER3 if _dg else _HEADER2         # l'AAD dipende dalla generazione
    tnonce = b'\x00' * 12              # riempitivo: con tlen=0 è ignorato in lettura
    tct = b''
    tlen = 0
    if thumb_png:
        try:
            _tn = os.urandom(12)
            _tc = AESGCM(get_thumb_key()).encrypt(_tn, thumb_png, _hdr)
            if len(_tc) <= _MAX_THUMB: # cap simmetrico al PHP; una 256² non lo raggiunge mai
                tnonce, tct, tlen = _tn, _tc, len(_tc)
        except Exception:
            pass                        # THUMB_KEY assente/errore → nessuna thumb (thumb_len=0),
                                        # il payload si cifra comunque: il SAVE non fallisce mai
    # --- IBEX-GEN3-28-7: segmento BURN (solo gen-3, subito dopo pid+digest) -----
    bnonce = b'\x00' * 12              # riempitivo: con blen=0 è ignorato in lettura
    bct = b''
    blen = 0
    if _dg:
        try:
            _bj = json.dumps(burn if isinstance(burn, dict) else {},
                             sort_keys=True, separators=(',', ':'),
                             ensure_ascii=False).encode('utf-8')
            _bn = os.urandom(12)
            _bc = AESGCM(get_thumb_key()).encrypt(_bn, _bj, _hdr)
            if len(_bc) <= _MAX_BURN:  # cap simmetrico al PHP
                bnonce, bct, blen = _bn, _bc, len(_bc)
        except Exception:
            pass                        # STESSA regola best-effort della thumb: THUMB_KEY
                                        # assente/errore → blen=0, il payload si cifra
                                        # comunque e il SAVE non fallisce MAI.
    pnonce = os.urandom(12)
    pct = AESGCM(get_key(project_id)).encrypt(pnonce, zip_plain, _hdr)
    _thumb_seg = tnonce + tlen.to_bytes(4, 'big') + tct
    if _dg:
        _burn_seg = bnonce + blen.to_bytes(4, 'big') + bct
        _pid_b = (int(project_id or 0) & 0xFFFFFFFF).to_bytes(4, 'big')
        return _HEADER3 + _pid_b + session_digest + _burn_seg + _thumb_seg + pnonce + pct
    return _HEADER2 + _thumb_seg + pnonce + pct


# ── LETTURA ───────────────────────────────────────────────────────────────────

def decrypt_bytes(blob, project_id=None):
    """Restituisce il PAYLOAD (zip in chiaro) per IBX1 e IBX2. Passthrough per zip
    legacy in chiaro. Invariante: i chiamanti che si aspettano lo zip NON cambiano."""
    if blob[:4] == _ZIP_MAGIC:
        return blob                                       # zip in chiaro legacy: passthrough
    if blob[:4] == _MAGIC:                                # IBX1
        if blob[4:5] != _VERSION:
            raise ValueError('Versione IBX non supportata')
        if len(blob) < 17 + 16:                          # nonce(12)@5 + tag GCM(16) minimo
            raise ValueError('Blob IBX1 troncato')
        nonce = blob[5:17]
        ct    = blob[17:]
        return AESGCM(get_key(project_id)).decrypt(nonce, ct, _HEADER)
    if blob[:4] == _MAGIC2:                               # IBX2 → salta la thumb, decifra il payload
        ver = blob[4:5]
        if ver == _VERSION2:                             # gen-1: nessun digest, thumb_len @17
            if len(blob) < _PREFIX2:
                raise ValueError('Blob IBX2 troncato (prefisso)')
            tlen = int.from_bytes(blob[17:21], 'big')
            off  = _PREFIX2 + tlen                        # inizio segmento payload
            aad  = _HEADER2
        elif ver == _VERSION2_DG:                        # gen-2: pid(4)+digest(32) in testa, thumb_len @53
            if len(blob) < _PREFIX2_DG:
                raise ValueError('Blob IBX2 v2 troncato (prefisso)')
            tlen = int.from_bytes(blob[53:57], 'big')
            off  = _PREFIX2_DG + tlen
            aad  = _HEADER2_DG
        elif ver == _VERSION3:                           # gen-3 (IBEX-GEN3-28-7): burn @57, poi thumb, poi payload
            if len(blob) < _PREFIX3:
                raise ValueError('Blob IBX2 v3 troncato (prefisso)')
            blen = int.from_bytes(blob[53:57], 'big')    # len del segmento burn (bnonce @41, blen @53)
            if blen > _MAX_BURN:
                raise ValueError('Blob IBX2 v3: segmento burn fuori range')
            t_off = _PREFIX3 + blen                      # inizio segmento thumb (tnonce)
            if len(blob) < t_off + 16:                   # tnonce(12) + tlen(4)
                raise ValueError('Blob IBX2 v3 troncato (meta thumb)')
            tlen = int.from_bytes(blob[t_off + 12:t_off + 16], 'big')
            off  = t_off + 16 + tlen                     # inizio segmento payload (pnonce)
            aad  = _HEADER3
        else:
            raise ValueError('Versione IBX2 non supportata')
        if len(blob) < off + 12:
            raise ValueError('Blob IBX2 troncato (payload nonce)')
        pnonce = blob[off:off + 12]
        pct    = blob[off + 12:]
        return AESGCM(get_key(project_id)).decrypt(pnonce, pct, aad)
    raise ValueError('Blob .ibex non riconosciuto (ne IBX1/IBX2 ne zip)')


def read_thumb(blob):
    """Estrae la thumbnail PNG (bytes) da un blob IBX2 (gen-1 o gen-2), o None se
    assente/legacy. Usa SOLO THUMB_KEY (mai l'archive key) — parità col PHP ibex-app.
    Branch su `ver` PRIMA di calcolare gli offset."""
    if blob[:4] != _MAGIC2:
        return None
    ver = blob[4:5]
    if ver == _VERSION2:                      # gen-1: tnonce@5, tlen@17, thumb@21
        tn_off, tlen_off, prefix, aad = 5, 17, _PREFIX2, _HEADER2
    elif ver == _VERSION2_DG:                 # gen-2: tnonce@41, tlen@53, thumb@57
        tn_off, tlen_off, prefix, aad = 41, 53, _PREFIX2_DG, _HEADER2_DG
    elif ver == _VERSION3:                    # gen-3 (IBEX-GEN3-28-7): la thumb segue il burn a lunghezza VARIABILE
        if len(blob) < _PREFIX3:
            return None
        _blen = int.from_bytes(blob[53:57], 'big')
        if _blen > _MAX_BURN:                 # burn corrotto -> placeholder (mai leggere oltre)
            return None
        tn_off   = _PREFIX3 + _blen           # il burn si SALTA, non si legge
        tlen_off = tn_off + 12
        prefix   = tn_off + 16                # inizio del ciphertext thumb
        aad      = _HEADER3
    else:
        return None
    if len(blob) < prefix:
        return None
    tlen = int.from_bytes(blob[tlen_off:tlen_off + 4], 'big')
    if tlen <= 16 or tlen > _MAX_THUMB:      # 0=assente, ≤16=solo-tag/vuoto, >cap=corrotto → placeholder
        return None
    if len(blob) < prefix + tlen:
        return None
    tnonce = blob[tn_off:tn_off + 12]
    tct    = blob[prefix:prefix + tlen]
    try:
        return AESGCM(get_thumb_key()).decrypt(tnonce, tct, aad)
    except Exception:
        return None                          # tag/corrotto → placeholder (parità byte-per-byte col PHP)


def read_burn(path):
    """IBEX-GEN3-28-7 — record di burn dall'header gen-3, o None. Lettura PARZIALE
    per path: legge il prefisso fisso (57 B) + i soli `blen` byte del ciphertext,
    MAI il payload. Usa SOLO THUMB_KEY (mai l'archive key) — parita' col PHP
    `IbexThumb::readBurn`. SOFT-FAIL TOTALE: qualunque problema (versione diversa,
    troncamento, chiave assente, tag GCM, json non-oggetto) -> None, mai eccezioni.
    Il chiamante di questa fetta e' il self-test; il consumatore di prodotto
    (fallback di `projectsStatus` quando `ibex:burn:{pid}` manca) arriva nella
    sessione B."""
    try:
        with open(path, 'rb') as _f:
            head = _f.read(_PREFIX3)
            if len(head) < _PREFIX3:
                return None
            if head[:4] != _MAGIC2 or head[4:5] != _VERSION3:
                return None                  # il burn nell'header esiste SOLO in gen-3
            blen = int.from_bytes(head[53:57], 'big')
            if blen <= 16 or blen > _MAX_BURN:   # 0=assente, <=16=solo-tag/vuoto, >cap=corrotto
                return None
            bnonce = head[41:53]
            bct = _f.read(blen)
        if len(bct) != blen:
            return None
        obj = json.loads(AESGCM(get_thumb_key()).decrypt(bnonce, bct, _HEADER3).decode('utf-8'))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def read_header_meta(head):
    """Lettura PARZIALE dei metadati d'header IBX2 **gen-2 e gen-3** (project_id +
    session_digest) SENZA decifrare il payload. `head` = i primi >=41 byte del blob
    (o l'intero blob). Ritorna {'version':2|3, 'project_id':int, 'session_digest':bytes(32)}
    per gen-2/gen-3; None per IBX1 / IBX2 gen-1 / zip (nessun digest → il janitor NON purga).
    IBEX-GEN3-28-7: gen-3 tiene pid+digest agli STESSI offset -> 41 byte bastano ancora."""
    if len(head) < 41 or head[:4] != _MAGIC2 or head[4:5] not in (_VERSION2_DG, _VERSION3):
        return None                          # IBEX-GEN3-28-7: gen-3 ha pid+digest agli STESSI offset di gen-2
    return {
        'version': head[4],                  # 2 o 3 (nessun consumatore legge questa chiave: verificato)
        'project_id': int.from_bytes(head[5:9], 'big'),
        'session_digest': head[9:41],
    }
