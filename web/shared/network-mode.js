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
    }

    get mode() { return this._currentMode; }

    /** Probe network and determine mode */
    async detect() {
        const mode = await this._probe();
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
        // Check basic connectivity
        if (!navigator.onLine) return 'offline';

        // Try Stratux — if reachable, we're in the aircraft
        try {
            const r = await fetch(`http://${Settings.stratuxIp || '192.168.10.1'}/getStatus`, {
                signal: AbortSignal.timeout(2000),
            });
            if (r.ok) return 'flight';
        } catch { /* not on Stratux network */ }

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
