# IBEX Worker — Dockerfile custom con pip install in BUILD-TIME.
#
# V1.0 (2026-05-05): sposta apt-get install + pip install dall'entrypoint
# del docker-compose alla fase di BUILD dell'image. Motivazione:
#
#   - Pre-V1.0 (image: blendergrid/blender:4.5 + entrypoint sh -c 'apt + pip + run'):
#     ogni container partiva fresh dall'image upstream e installava pacchetti
#     nel proprio layer writable (overlayfs CoW). Risultato: 6 worker × ~750MB
#     di librerie native (Open3D, PyMeshLab, scipy, ecc.) = ~4.5GB di RAM
#     duplicata che il kernel non riesce a deduplica perché i file path host
#     sono distinti (ogni container ha il suo /var/lib/docker/overlay2/<id>/).
#     Sintomo confermato in diagnostica 2026-05-05: Shared_Clean=2MB per worker
#     (atteso ~700-800MB), PSS == RSS (zero condivisione fra worker).
#
#   - Post-V1.0 (build: . con questo Dockerfile): tutti i 6 worker montano la
#     STESSA image-layer. apt-get install libgomp1 + pip install di tutti i
#     pacchetti finiscono in un layer immagine read-only condiviso. Quando i 6
#     container vengono creati dalla stessa image, le librerie native sono
#     mappate via overlayfs read-only → kernel page cache deduplica → 1 sola
#     copia fisica delle pagine code, 6 mapping virtuali. Risparmio atteso:
#     ~3-4 GB di RAM totale, baseline idle scende da ~1.6 GB/worker a ~1 GB.
#
# Build (dalla radice del repository, che è il contesto di build):
#          docker compose build ibex-worker-1
#   oppure docker build -t ibex-worker:v1.0 .
# Deploy:  docker compose up -d --force-recreate \
#                ibex-worker-1 ibex-worker-2 ibex-worker-3 ibex-worker-4 ibex-worker-5 ibex-worker-6

FROM blendergrid/blender:4.5

# libgomp1 è dipendenza runtime di Open3D Embree (RaycastingScene multi-thread,
# usato da modelgenerator V4.0 OpenSDF).
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Pip install nel Python embedded di Blender 4.5. Il path Python è dinamico
# (Blender 4.5 → /usr/local/blender/4.5/python/bin/python3.11) ma usiamo il
# medesimo find pattern dell'entrypoint legacy per robustezza tra release
# minor di Blender. Le versioni sono fissate in worker/requirements.txt.
COPY worker/requirements.txt /tmp/requirements.txt
RUN PYBIN=$(find /usr/local/blender -name 'python3*' -path '*/bin/*' | head -n 1) \
 && echo "Using Python: $PYBIN" \
 && $PYBIN -m pip install --no-cache-dir -r /tmp/requirements.txt

# L'entrypoint del container è il puro lancio di Blender headless con
# worker.py. Nessun apt/pip a runtime → boot quasi istantaneo (~1-2s vs
# ~5-10 min pre-V1.0 sul primo run di un container fresh).
ENTRYPOINT ["/usr/local/blender/blender", "-b", "-noaudio", "-P", "/app/worker.py"]
