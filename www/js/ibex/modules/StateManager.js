export class StateManager {
    constructor(projectId) {
        this.projectId = projectId;
        this.isPolling = false;
    }

    /**
     * Avvia il polling dello stato
     * @param {Function} onReady - Callback quando lo stato è pronto
     * @param {Function} onError - Callback in caso di errore fatale
     */
    startPolling(onReady, onError) {
        if (this.isPolling) return;
        this.isPolling = true;

        console.log("📡 Starting Status Polling...");

        const poll = async () => {
            if (!this.isPolling) return;

            try {
                // Timestamp (t) per evitare caching del browser
                const response = await fetch(`/?action=check_status&id=${this.projectId}&t=${Date.now()}`);
                
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const data = await response.json();
                
                // Logging discreto solo se cambia stato o ogni tot
                // console.log(`[IBEX STATE] ${data.status}`);

                if (data.status === 'error') {
                    this.isPolling = false;
                    onError(data.error || "Errore sconosciuto nel progetto");
                    return;
                }

                // Stati di successo (incluso 'active' dal self-healing)
                // 'ready' = file copiati e pronti
                // 'active' = sessione già aperta
                if (data.status === 'ready' || data.status === 'active') {
                    console.log("✅ Progetto pronto!");
                    this.isPolling = false;
                    onReady(); 
                    return;
                }

                // Se è ancora in elaborazione (queued, initializing, baking), riprova
                if (this.isPolling) setTimeout(poll, 1500); 

            } catch (err) {
                console.warn("[IBEX] Polling error (retrying...)", err);
                // Backoff in caso di errore di rete
                if (this.isPolling) setTimeout(poll, 3000); 
            }
        };

        poll();
    }

    // S8 (2026-07-10): stopPolling() RIMOSSO — zero caller; la terminazione
    // avviene internamente via this.isPolling = false nel poll().
}