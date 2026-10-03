/**
 * FlyTab — Network Mode Detection
 * Determines current operating mode: flight, home, internet, offline.
 * Uses direct network probes (Capacitor Network plugin optional).
 * Fires: mode:changed
 */

class NetworkMode extends EventTarget {
    constructor() {
        super();
        this._currentMode = 'offline';
        this._checkInterval = null;
        // Consecutive probes that failed to reach Stratux while in 'flight'.
        this._flightMisses = 0;
        this._detecting = null;   // in-flight detect() promise, shared by concurrent callers
    }

    get mode() { return this._currentMode; }

    /** Probe network and determine mode. Concurrent callers (the 15 s interval
     *  and browser online/offline events) share one in-flight probe, so a single
     *  outage is counted once toward FLIGHT_EXIT_MISSES. */
    detect() {
        if (!this._detecting) {
            this._detecting = this._detect().finally(() => { this._detecting = null; });
        }
        return this._detecting;
    }

    /** Leaving 'flight' needs FLIGHT_EXIT_MISSES consecutive failed Stratux
     *  probes — one slow /getStatus (2s timeout) must not flip the mode. */
    async _detect() {
        const mode = await this._probe();
        if (this._currentMode === 'flight' && mode !== 'flight') {
            this._flightMisses++;
            if (this._flightMisses < NetworkMode.FLIGHT_EXIT_MISSES) return this._currentMode;
        }
        this._flightMisses = 0;
        if (mode !== this._currentMode) {
            const prev = this._currentMode;
            this._currentMode = mode;
            this.dispatchEvent(new CustomEvent('mode:changed', {
                detail: { mode, previous: prev }
            }));
        }
        return mode;
    }

    /** Start periodic mode checks (every 15s) */
    startMonitoring() {
        this.detect();
        this._checkInterval = setInterval(() => this.detect(), 15000);
    }

    stopMonitoring() {
        if (this._checkInterval) {
            clearInterval(this._checkInterval);
            this._checkInterval = null;
        }
    }

    async _probe() {
        // Try Stratux FIRST, regardless of navigator.onLine — if reachable, we're
        // in the aircraft. Stratux WiFi has no internet, and Android's WebView
        // reports navigator.onLine === false on it; checking onLine first made
        // every in-flight probe return 'offline' without ever trying Stratux.
        try {
            const r = await fetch(`http://${Settings.stratuxIp}/getStatus`, {
                signal: AbortSignal.timeout(2000),
            });
            if (r.ok) return 'flight';
        } catch { /* not on Stratux network */ }

        // No Stratux — navigator.onLine is meaningful for internet reachability
        if (!navigator.onLine) return 'offline';

        // Try home server — if reachable, we're on home network
        // Uses CockpitConfig.homeBases (primary + Tailscale fallback from cockpit-config.json)
        try {
            const bases = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.homeBases : [];
            for (const base of bases) {
                const r = await fetch(`${base}/nasr/cycle_info.json`, {
                    cache: 'no-store',
                    signal: AbortSignal.timeout(2000),
                });
                if (r.ok) return 'home';
            }
        } catch { /* not on home network */ }

        // Internet available but not home/stratux
        return 'internet';
    }
}

NetworkMode.FLIGHT_EXIT_MISSES = 3;
