class EngineGpsBridge {
    constructor(stratuxClient, engineClient) {
        this._stratux = stratuxClient;
        this._engine  = engineClient;
        this._active  = false;
        this._onEngineData = null;
        // Watchdog mirroring gps-source.js's _staleTimer — if no fresh fix is
        // injected within 15s (e.g. engine:data events stop firing entirely,
        // so _tick() never runs to notice), degrade the last-written situation
        // instead of leaving it frozen at full quality forever.
        this._staleTimer = null;
    }

    get active() { return this._active; }

    start() {
        this._onEngineData = () => this._tick();
        this._engine.addEventListener('engine:data', this._onEngineData);
    }

    stop() {
        if (this._onEngineData) {
            this._engine.removeEventListener('engine:data', this._onEngineData);
            this._onEngineData = null;
        }
        if (this._staleTimer) {
            clearTimeout(this._staleTimer);
            this._staleTimer = null;
        }
        this._active = false;
    }

    /** Degrade the last-written situation to zero fix quality and dispatch it.
     * Shared with gps-source.js via gps-staleness.js (issue #129). */
    _degradeSituation() {
        degradeGpsSituation(this._stratux);
    }

    /** Reset the 15s staleness watchdog. Timeout shared with gps-source.js via gps-staleness.js (issue #129). */
    _resetStaleTimer() {
        if (this._staleTimer) clearTimeout(this._staleTimer);
        this._staleTimer = setTimeout(() => {
            if (!this._active) return;
            if (typeof DiagLog !== 'undefined')
                DiagLog.log('gps', 'Engine GPS bridge stale — no engine data for 15s');
            this._degradeSituation();
            this._active = false;
        }, GPS_STALE_TIMEOUT_MS);
    }

    _tick() {
        // Don't inject while internal/auto-fallback GPS is active — _suppressGpsSituation
        // means GpsSource is deliberately blocking Stratux situation events.
        if (this._stratux._suppressGpsSituation) {
            if (this._active) this._active = false;
            return;
        }

        const d = this._engine.lastData;
        const shouldInject =
            this._stratux.stale === true &&
            this._engine.stale === false &&
            d?.latitude  != null &&
            d?.longitude != null;

        if (shouldInject) {
            if (!this._active) {
                this._active = true;
                if (typeof DiagLog !== 'undefined')
                    DiagLog.log('gps', 'Engine GPS bridge active — injecting engine GPS as Stratux situation');
            }
            const situation = {
                lat:             d.latitude,
                lon:             d.longitude,
                alt_msl:         d.gps_altitude,
                alt_baro:        d.gps_altitude,
                ground_speed:    d.ground_speed,
                true_course:     d.course,
                pitch:           d.pitch,
                roll:            d.bank,
                g_load:          d.acc_vert,
                gps_fix_quality: 1,
                gps_sats:        null,
                vertical_speed:  0,
                _source:         'engine',
            };
            // Mirror gps-source.js:303-304 — set the property so direct readers
            // (track-log.js, device-status.js, map.js traffic filter) see engine
            // GPS too, not just addEventListener('stratux:situation') subscribers.
            this._stratux.situation = situation;
            this._stratux.dispatchEvent(new CustomEvent('stratux:situation', { detail: situation }));
            this._resetStaleTimer();
        } else if (this._active) {
            this._active = false;
            if (typeof DiagLog !== 'undefined') {
                const reason = !this._stratux.stale
                    ? 'Stratux situation WS recovered'
                    : 'engine GPS unavailable';
                DiagLog.log('gps', `Engine GPS bridge inactive — ${reason}`);
            }
            this._degradeSituation();
        }
    }
}
