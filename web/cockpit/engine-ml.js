/**
 * FlyTab — Engine ML Bridge
 * Feeds engine data from EngineClient into the EngineML Capacitor plugin
 * at 1Hz, displays anomaly status and advisories on the engine panel/page.
 */

class EngineMLBridge {
    constructor() {
        this._plugin = window.Capacitor?.Plugins?.EngineML;
        this._initialized = false;
        this._delegate = null;
        this._lastResult = null;
        this._advisoryEl = null;
        this._badgeEl = null;

        // Post-flight logging
        this._log = [];           // 1Hz ring buffer, max 10800 entries (3 hours)
        this._logMaxLen = 10800;
        this._logStartTime = null;
        this._logActive = false;

        window.engineML = this;   // expose globally for logbook.js
    }

    /** Initialize the ML engine. Call once after app init. */
    async init() {
        if (!this._plugin) {
            console.log('[EngineML] Plugin not available (browser mode)');
            return;
        }

        try {
            const result = await this._plugin.initialize({});
            this._initialized = result.status === 'ok' || result.status === 'already_initialized';
            this._delegate = result.delegate;
            console.log(`[EngineML] Initialized — delegate: ${this._delegate}`);
        } catch (err) {
            console.error('[EngineML] Init failed:', err);
        }
    }

    /**
     * Start listening to engine data events.
     * @param {EngineClient} engineClient
     * @param {StratuxClient} stratuxClient — for altitude/speed
     */
    start(engineClient, stratuxClient) {
        if (!this._initialized) return;

        this._engineClient = engineClient;
        this._stratuxClient = stratuxClient;

        engineClient.addEventListener('engine:data', (e) => {
            this._onEngineData(e.detail);
        });
    }

    get lastResult() { return this._lastResult; }
    get delegate() { return this._delegate; }

    /** Set DOM elements for advisory display */
    setDisplayElements(badgeEl) {
        this._badgeEl = badgeEl;
    }

    async _onEngineData(raw) {
        if (!this._initialized || !this._plugin) return;

        // Flatten nested data
        const d = raw.data ? { ...raw, ...raw.data } : raw;
        const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

        // Get altitude and speed from Stratux situation
        const sit = this._stratuxClient?.situation;

        try {
            const result = await this._plugin.processSample({
                rpm: num(d.rpm ?? d.RPM),
                egt1: num(d.egt1 ?? d.EGT1 ?? d['EGT 1']),
                egt2: num(d.egt2 ?? d.EGT2 ?? d['EGT 2']),
                egt3: num(d.egt3 ?? d.EGT3 ?? d['EGT 3']),
                egt4: num(d.egt4 ?? d.EGT4 ?? d['EGT 4']),
                cht1: num(d.cht1 ?? d.CHT1 ?? d['CHT 1']),
                cht2: num(d.cht2 ?? d.CHT2 ?? d['CHT 2']),
                cht3: num(d.cht3 ?? d.CHT3 ?? d['CHT 3']),
                cht4: num(d.cht4 ?? d.CHT4 ?? d['CHT 4']),
                oil_temp: num(d.oil_temp ?? d.oil_temp_f ?? d.Oil_Temp),
                oil_press: num(d.oil_pressure ?? d.oil_press_psi ?? d.Oil_Press),
                fuel_flow: num(d.fuel_flow_gph ?? d.gph ?? d.Fuel_Flow),
                altitude: num(sit?.alt_msl ?? d.altitude_ft ?? 0),
                mp: num(d.manifold_pressure ?? d.mp ?? d.MAP ?? 0),
                carb_temp: num(d.carb_temp ?? d.Carb_Temp ?? 0),
                fuel_remaining: num(d.fuel_remaining_gal ?? d.fuel_gal ?? d.Gallons_Rem ?? 0),
                ground_speed: num(sit?.ground_speed ?? 0),
                distance_nm: 0, // TODO: compute from route
            });

            this._lastResult = result;
            this._updateDisplay(result);

            // Append to ring buffer
            if (this._logActive && result) {
                this._log.push({
                    t: Math.round((Date.now() - this._logStartTime) / 1000),
                    ph: result.phase,
                    sc: result.score != null ? Math.round(result.score * 1000) / 1000 : null,
                    an: result.anomaly ? 1 : 0,
                    lt: result.latencyMs,
                });
                if (this._log.length > this._logMaxLen) this._log.shift();
            }
        } catch (err) {
            // Don't spam console — plugin may not be ready
        }
    }

    // ========== Flight Logging ==========

    startLogging() {
        this._log = [];
        this._logStartTime = Date.now();
        this._logActive = true;
        console.log('[EngineML] Logging started');
    }

    stopLogging() {
        this._logActive = false;
        console.log(`[EngineML] Logging stopped — ${this._log.length} samples`);
    }

    /** Returns compact summary for logbook custom_fields. Returns null if no data. */
    getFlightSummary() {
        if (!this._log.length) return null;
        const phases = {};
        let anomalyCount = 0;
        let latSum = 0;
        let latCount = 0;
        for (const s of this._log) {
            phases[s.ph] = (phases[s.ph] || 0) + 1;
            if (s.an) anomalyCount++;
            if (s.lt != null) { latSum += s.lt; latCount++; }
        }
        const total = this._log.length;
        return {
            samples: total,
            duration_s: this._log[this._log.length - 1].t,
            anomaly_count: anomalyCount,
            anomaly_pct: Math.round(anomalyCount / total * 100),
            avg_latency_ms: latCount ? Math.round(latSum / latCount) : null,
            phase_dist: Object.fromEntries(
                Object.entries(phases).map(([k, v]) => [k, Math.round(v / total * 100)])
            ),
        };
    }

    /** Returns a shallow copy of the ring buffer for IDB storage. */
    getFullLog() {
        return [...this._log];
    }

    /** Reset all adapted thresholds (call after maintenance or phase bug fix). */
    async resetThresholds() {
        if (!this._plugin) return;
        try {
            await this._plugin.resetThresholds({});
            console.log('[EngineML] Adapted thresholds reset');
        } catch (err) {
            console.error('[EngineML] resetThresholds failed:', err);
        }
    }

    /** Triggers a CSV download of the current ring buffer. */
    exportLogCSV(filename = 'engineml_log.csv') {
        if (!this._log.length) return;
        const rows = ['t_s,phase,score,anomaly,latency_ms'];
        for (const s of this._log) {
            rows.push(`${s.t},${s.ph ?? ''},${s.sc ?? ''},${s.an},${s.lt ?? ''}`);
        }
        const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    _updateDisplay(result) {
        if (!result) return;

        // Update badge (on engine panel or status bar)
        if (this._badgeEl) {
            if (!result.windowReady) {
                this._badgeEl.textContent = `ML:${result.phase || '...'}`;
                this._badgeEl.style.color = 'var(--text-muted)';
            } else if (result.anomaly) {
                this._badgeEl.textContent = `ML:ALERT`;
                this._badgeEl.style.color = 'var(--status-danger)';
                this._badgeEl.style.animation = 'thermal-flash 1s infinite';
            } else {
                this._badgeEl.textContent = `ML:${result.phase || 'OK'}`;
                this._badgeEl.style.color = 'var(--status-ok)';
                this._badgeEl.style.animation = '';
            }
        }

        document.dispatchEvent(new CustomEvent('engineml:result', { detail: result }));
    }
}
