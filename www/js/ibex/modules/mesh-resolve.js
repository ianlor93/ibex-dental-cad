// ═══════════════════════════════════════════════════════════════
// IBEX mesh-resolve — T1Resolve_29-7
//
// `resolveTargetMesh(ibex, nodeId)` — risolve la mesh Three.js TARGET di un
// nodo destructive (sculpt / delete_topology / split_topology) risalendo
// l'edge IN_GEO_Mesh nel DAG (con from_port per i branch A/B dello split).
//
// Estratto VERBATIM dalle due copie byte-identiche di
// `SelectionMode._resolveTargetMesh` e `SculptMode._resolveTargetMesh`
// (T1 dedup, stesso profilo di `dom-escape.js`). L'unica parametrizzazione:
// `this.ibex` dei metodi → il parametro `ibex`. I due modi delegano qui.
// ═══════════════════════════════════════════════════════════════

export function resolveTargetMesh(ibex, nodeId) {
    const stackMgr = ibex.stackMgr;
    if (!stackMgr?.editor) return null;
    const graph = stackMgr.extractDAG();
    const edges = graph.edges.filter(e => String(e.to_node) === String(nodeId));
    if (!edges.length) return null;
    const geoEdge = edges.find(e => e.role === 'IN_GEO_Mesh')
                 || edges.find(e => !e.role || e.role === 'target')
                 || edges[0];
    // S3: passa from_port per risolvere branch A/B se il nodo sorgente è split.
    const baseName = stackMgr.resolveBaseMesh(geoEdge.from_mesh, geoEdge.from_port);
    const meshes = ibex.sceneMgr.group.children.filter(c => c.isMesh && c.name === baseName);
    return meshes[0] || null;
}
