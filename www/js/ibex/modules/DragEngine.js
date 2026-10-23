// ═══════════════════════════════════════════════════════════════
// IBEX DragEngine Inspector_V11.3 — data-node-id fallback for Inspector
// ═══════════════════════════════════════════════════════════════

export class DragEngine {
    constructor(stackMgr) {
        this.stackMgr = stackMgr;
    }

    bindDragInputs() {
        const inputs = document.querySelectorAll('.ibex-num:not([data-bound]), input[type="checkbox"].drag-input:not([data-bound])');
        
        inputs.forEach(input => {
            if (input.tagName === 'SELECT') return;
            input.dataset.bound = 'true';

            if (input.type === 'checkbox') return;

            let startX = 0, startVal = 0, isDragging = false, hasDragged = false;

            const getKey = () => input.getAttribute('data-key');

            // 🟢 FIX CRITICO: Aggiornato per la struttura a 3 righe verticali
            const getFinalValue = () => {
                if (input.classList.contains('ibex-vector-input')) {
                    const wrap = input.closest('.ibex-vector-group');
                    if (wrap) {
                        const siblings = wrap.querySelectorAll('input.ibex-vector-input');
                        return [
                            parseFloat(siblings[0].value) || 0,
                            parseFloat(siblings[1].value) || 0,
                            parseFloat(siblings[2].value) || 0
                        ];
                    }
                }
                return parseFloat(input.value) || 0;
            };

            const startDrag = (e) => {
                isDragging = true;
                hasDragged = false;
                startX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
                startVal = parseFloat(input.value) || 0;
                window.addEventListener('mousemove', onDrag);
                window.addEventListener('touchmove', onDrag, { passive: false });
                window.addEventListener('mouseup', endDrag);
                window.addEventListener('touchend', endDrag);
            };

            const onDrag = (e) => {
                if (!isDragging) return;
                const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
                const dx = clientX - startX;
                
                if (!hasDragged && Math.abs(dx) > 3) hasDragged = true;
                
                if (hasDragged) {
                    e.preventDefault();
                    e.stopPropagation();
                    const step = parseFloat(input.getAttribute('step')) || 0.1;
                    const min = parseFloat(input.getAttribute('min')) || -1000;
                    const max = parseFloat(input.getAttribute('max')) || 1000;
                    
                    let newVal = Math.max(min, Math.min(max, startVal + dx * step));
                    const dec = (step.toString().split('.')[1] || '').length;
                    input.value = parseFloat(newVal.toFixed(dec));
                    
                    const key = getKey();
                    if (key) {
                        if (input.closest('.drawflow-node')) {
                            this.stackMgr.updateNodeDataPreviewOnly(input, key, getFinalValue());
                        } else if (input.dataset.nodeId) {
                            this.stackMgr.updateNodeDataByIdPreviewOnly(input.dataset.nodeId, key, getFinalValue());
                        }
                    }
                }
            };

            const endDrag = () => {
                if (!isDragging) return;
                isDragging = false;
                window.removeEventListener('mousemove', onDrag);
                window.removeEventListener('touchmove', onDrag);
                window.removeEventListener('mouseup', endDrag);
                window.removeEventListener('touchend', endDrag);
                
                if (hasDragged) {
                    const key = getKey();
                    if (key) {
                        if (input.closest('.drawflow-node')) {
                            this.stackMgr.updateNodeData(input, key, getFinalValue());
                        } else if (input.dataset.nodeId) {
                            this.stackMgr.updateNodeDataById(input.dataset.nodeId, key, getFinalValue());
                        }
                    }
                }
            };

            input.addEventListener('mousedown', startDrag);
            input.addEventListener('touchstart', startDrag, { passive: false });
            input.addEventListener('mousedown', (e) => e.stopPropagation());
            input.addEventListener('touchstart', (e) => e.stopPropagation());
        });
    }
}