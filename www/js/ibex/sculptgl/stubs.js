// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/stubs.js — SculptGL_S1_V1.0
// No-op stubs per dipendenze SculptGL non necessarie nel porting IBEX.
//
// - StateManager: SculptGL usa pushVertices/pushFaces pervasivamente per
//   l'undo/redo. IBEX non ha un sistema undo per sculpt in queste 4
//   sessioni (A9). No-op totale.
// - Tablet: SculptGL supporta pressione stylus via hammer.js. IBEX no →
//   pressione sempre 1.0.
// - Enums: costanti minimali referenziate dai moduli portati. Solo shader
//   MATCAP è l'unica usata (MeshDynamic.initFromMesh setShaderType al
//   ramo "if isUsingTexCoords"). Action.SCULPT_EDIT e Tools.BRUSH mai usate
//   nei nostri path ma inclusi per completezza se un porting futuro le
//   referenziasse.
// ═══════════════════════════════════════════════════════════════

export class StateManager {
    pushVertices() {}
    pushFaces() {}
    pushStateGeometry() {}
    getCurrentState() { return { undo() {} }; }
}

export const Tablet = {
    getPressureIntensity: () => 1.0,
    getPressureRadius:    () => 1.0,
};

export const Enums = {
    Shader: { MATCAP: 0, PBR: 1, UV: 2, PAINTUV: 3, WIREFRAME: 4, FLAT: 5 },
    Tools:  {
        BRUSH: 0, INFLATE: 1, TWIST: 2, SMOOTH: 3, FLATTEN: 4,
        PINCH: 5, CREASE: 6, DRAG: 7, PAINT: 8, MOVE: 9,
        MASKING: 10, LOCALSCALE: 11, TRANSFORM: 12
    },
    Action: { SCULPT_EDIT: 1, CAMERA_ZOOM: 2, CAMERA_ROTATE: 3, NOTHING: 0 },
    Events: {},
};

export default { StateManager, Tablet, Enums };
