/**
 * FlyTab — GPS Source Manager
 * Selectable GPS: 'internal' (Android device GPS), 'stratux' (Pi GPS via WebSocket),
 * or 'auto' (use Stratux when connected; fall back to device GPS if unavailable).
 *
 * When internal GPS is active, injects device GPS into the StratuxClient's situation
 * so all downstream modules (map, instrument strip, route table, etc.) work unchanged.
 *
 * Stratux still provides: traffic, ADS-B, AHRS pitch/roll/G-load, baro altitude.
 * Internal GPS provides: lat, lon, altitude MSL, ground speed, course.
 * In 'internal' mode, GPS fields come from device; AHRS fields still from Stratux if available.
 */

class GpsSource {
    constructor(stratuxClient) {
        this._stratux = stratuxClient;
        this._configuredSource = Settings.get('gps_source') || 'auto'; // 'internal', 'stratux', or 'auto'
        // Runtime source is always 'internal' or 'stratux' — 'auto' is a config state only
        this._source = (this._configuredSource === 'internal') ? 'internal' : 'stratux';
        this._inFallback = false; // true when auto-mode is using device GPS due to Stratux dropout
        this._watchId = null;
        this._lastInternal = null;
        this._firstFixLogged = false;
        this._vsSmoothed = 0; // EMA-smoothed vertical speed (fpm)
        this._staleTimer = null; // fires when internal GPS stops updating
        this._timeoutCount = 0; // consecutive watchPosition TIMEOUT errors

        // Auto-listener references (null when not attached)
        this._onStratuxDisconnect = null;
        this._onStratuxStale = null;
        this._onStratuxConnect = null;

        // If persisted source is 'internal', set suppress flag immediately
        // so no Stratux situation events leak before start() is called.
        if (this._source === 'internal') {
            this._stratux._suppressGpsSituation = true;
        }
    }

    get source() { return this._source; }

    /** Human-readable label for the current GPS state, for use in the status bar. */
    get label() {
        if (this._source === 'internal') {
            return this._inFallback ? 'INT(fb)' : 'INT';
        }
        return 'STX';
    }

    /** Switch GPS source. Persists configured source to settings. */
    setSource(source) {
        if (source !== 'internal' && source !== 'stratux' && source !== 'auto') return;
        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', `Switching GPS source: configured=${this._configuredSource} → ${source}`);
        this._configuredSource = source;
        this._inFallback = false;
        Settings.set('gps_source', source);

        if (source === 'internal') {
            this._source = 'internal';
            this._stratux._suppressGpsSituation = true;
            this._startInternal();
            this._detachAutoListeners();
        } else if (source === 'stratux') {
            this._source = 'stratux';
            this._stratux._suppressGpsSituation = false;
            this._stopInternal();
            this._detachAutoListeners();
        } else { // 'auto'
            this._source = 'stratux';
            this._stratux._suppressGpsSituation = false;
            this._stopInternal();
            this._attachAutoListeners();
        }
    }

    /** Start watching (call after StratuxClient.connect()) */
    start() {
        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', `GpsSource.start() configured=${this._configuredSource} runtime=${this._source}`);
        if (this._source === 'internal') {
            this._stratux._suppressGpsSituation = true;
            this._startInternal();
        }
        if (this._configuredSource === 'auto') {
            this._attachAutoListeners();
        }
    }

    stop() {
        this._detachAutoListeners();
        this._stratux._suppressGpsSituation = false;
        this._stopInternal();
    }

    _attachAutoListeners() {
        if (this._onStratuxDisconnect) return; // already attached — idempotent
        this._onStratuxDisconnect = () => this._activateFallback('disconnect');
        this._onStratuxStale      = () => this._activateFallback('stale');
        this._onStratuxConnect    = () => this._deactivateFallback();
        this._stratux.addEventListener('stratux:disconnect', this._onStratuxDisconnect);
        this._stratux.addEventListener('stratux:stale',      this._onStratuxStale);
        this._stratux.addEventListener('stratux:connect',    this._onStratuxConnect);
    }

    _detachAutoListeners() {
        if (!this._onStratuxDisconnect) return;
        this._stratux.removeEventListener('stratux:disconnect', this._onStratuxDisconnect);
        this._stratux.removeEventListener('stratux:stale',      this._onStratuxStale);
        this._stratux.removeEventListener('stratux:connect',    this._onStratuxConnect);
        this._onStratuxDisconnect = null;
        this._onStratuxStale      = null;
        this._onStratuxConnect    = null;
    }

    _activateFallback(reason) {
        if (this._configuredSource !== 'auto') return;
        if (this._inFallback) return; // re-entrancy guard
        this._inFallback = true;
        this._source = 'internal';
        this._stratux._suppressGpsSituation = true;
        this._startInternal();
        const msg = `Auto GPS: Stratux ${reason} — activating device GPS fallback`;
        console.log('[GpsSource]', msg);
        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', msg);
        this._stratux.dispatchEvent(new CustomEvent('gpssource:changed', {
            detail: { source: 'internal', fallback: true, reason }
        }));
    }

    _deactivateFallback() {
        if (this._configuredSource !== 'auto') return;
        if (!this._inFallback) return;
        this._inFallback = false;
        this._source = 'stratux';
        this._stratux._suppressGpsSituation = false;
        this._stopInternal();
        const msg = 'Auto GPS: Stratux reconnected — reverting to Stratux GPS';
        console.log('[GpsSource]', msg);
        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', msg);
        this._stratux.dispatchEvent(new CustomEvent('gpssource:changed', {
            detail: { source: 'stratux', fallback: false }
        }));
    }

    _startInternal() {
        if (this._watchId !== null) return;
        if (!('geolocation' in navigator)) {
            const msg = 'Geolocation API not available — falling back to Stratux GPS';
            console.warn('[GpsSource]', msg);
            if (typeof DiagLog !== 'undefined') DiagLog.log('gps', msg);
            this._fallbackToStratux();
            return;
        }

        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', 'Starting internal GPS watchPosition…');

        this._watchId = navigator.geolocation.watchPosition(
            (pos) => {
                if (!this._firstFixLogged) {
                    this._firstFixLogged = true;
                    const c = pos.coords;
                    if (typeof DiagLog !== 'undefined') DiagLog.log('gps', `First fix: ${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)} acc=${Math.round(c.accuracy)}m alt=${c.altitude != null ? Math.round(c.altitude) + 'm' : 'null'}`);
                }
                this._onInternalPosition(pos);
                this._resetStaleTimer();
            },
            (err) => {
                const msg = `Internal GPS error: code=${err.code} ${err.message}`;
                console.warn('[GpsSource]', msg);
                if (typeof DiagLog !== 'undefined') DiagLog.log('gps', msg);
                // PERMISSION_DENIED (1) or POSITION_UNAVAILABLE (2) = cannot use device GPS
                if (err.code === 1 || err.code === 2) {
                    this._stopInternal();
                    this._fallbackToStratux();
                }
            },
            {
                enableHighAccuracy: true,
                maximumAge: 2000,
                timeout: 10000,
            }
        );
        this._resetStaleTimer();
        console.log('[GpsSource] Internal GPS watchPosition started');
        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', 'watchPosition registered, waiting for fix…');
    }

    /** Called when internal GPS is unavailable (no hardware or API missing) */
    _fallbackToStratux() {
        if (this._configuredSource === 'auto') {
            // In auto mode: deactivate the fallback attempt; Stratux remains the source
            const msg = 'Auto GPS: device GPS unavailable — remaining on Stratux GPS';
            console.warn('[GpsSource]', msg);
            if (typeof DiagLog !== 'undefined') DiagLog.log('gps', msg);
            this._inFallback = false;
            this._source = 'stratux';
            this._stratux._suppressGpsSituation = false;
        } else {
            // Hard 'internal' mode: permanently flip to Stratux and persist
            if (typeof DiagLog !== 'undefined') DiagLog.log('gps', 'Falling back to Stratux GPS');
            this._source = 'stratux';
            this._stratux._suppressGpsSituation = false;
            Settings.set('gps_source', 'stratux');
        }
    }

    _stopInternal() {
        if (this._watchId !== null) {
            navigator.geolocation.clearWatch(this._watchId);
            this._watchId = null;
            this._firstFixLogged = false;
            this._vsSmoothed = 0;
            console.log('[GpsSource] Internal GPS stopped');
        }
        if (this._staleTimer) {
            clearTimeout(this._staleTimer);
            this._staleTimer = null;
        }
    }

    /** Reset the staleness watchdog — if no fix arrives within 15s, dim the marker */
    _resetStaleTimer() {
        if (this._staleTimer) clearTimeout(this._staleTimer);
        this._staleTimer = setTimeout(() => {
            if (this._source !== 'internal') return;
            if (typeof DiagLog !== 'undefined') DiagLog.log('gps', 'Internal GPS stale — no fix for 15s');
            // Dispatch a zero-quality situation so the map dims the ownship marker
            const lastSit = this._stratux.situation;
            if (lastSit) {
                const staleSit = { ...lastSit, gps_fix_quality: 0 };
                this._stratux.situation = staleSit;
                this._stratux.dispatchEvent(new CustomEvent('stratux:situation', { detail: staleSit }));
            }
        }, 15000);
    }

    _onInternalPosition(pos) {
        const c = pos.coords;
        const M_TO_FT = 3.28084;

        // Calculate ground speed in knots (coords.speed is m/s, may be null)
        const speedKt = (c.speed != null && c.speed >= 0) ? c.speed * 1.94384 : 0;

        // Calculate course (coords.heading is degrees, may be null)
        const course = (c.heading != null && !isNaN(c.heading)) ? c.heading : 0;

        // Altitude in feet (coords.altitude is meters MSL, may be null).
        // Use null — not 0 — when altitude is unavailable so consumers that guard
        // with `!= null` bypass altitude-dependent logic (e.g. traffic filtering)
        // rather than treating ownship as at sea level.
        const altMsl = (c.altitude != null) ? c.altitude * M_TO_FT : null;

        // Vertical speed — EMA-smoothed to reduce consumer GPS altitude jitter.
        // Raw delta can swing ±2000 fpm from 10-30m jitter at 1Hz.
        // Alpha=0.3 gives ~3-fix settling time, damping noise while tracking real climbs.
        const now = Date.now();
        if (this._lastInternal && this._lastInternal._rawAltM != null && c.altitude != null) {
            const dt = (now - this._lastInternal.timestamp) / 1000;
            if (dt > 0 && dt < 10) {
                const rawVs = ((c.altitude - this._lastInternal._rawAltM) * M_TO_FT / dt) * 60;
                this._vsSmoothed = 0.3 * rawVs + 0.7 * this._vsSmoothed;
            }
        }

        // Merge: GPS fields from device, AHRS from Stratux if available
        const ahrs = this._stratux._lastStratuxAhrs || {};
        const situation = {
            lat: c.latitude,
            lon: c.longitude,
            alt_msl: altMsl,
            alt_baro: ahrs.alt_baro ?? altMsl, // fall back to GPS alt if no baro
            ground_speed: speedKt,
            true_course: course,
            vertical_speed: this._vsSmoothed,
            gps_fix_quality: c.accuracy < 10 ? 2 : 1, // DGPS if <10m accuracy
            gps_sats: null, // not available from Web Geolocation API
            gps_sats_seen: null,
            pitch: ahrs.pitch ?? 0,
            roll: ahrs.roll ?? 0,
            g_load: ahrs.g_load ?? 1.0,
            g_load_min: ahrs.g_load_min ?? 1.0,
            g_load_max: ahrs.g_load_max ?? 1.0,
            timestamp: now,
            _source: 'internal',
            _accuracy: c.accuracy,
        };

        this._lastInternal = { ...situation, _rawAltM: c.altitude };

        // Inject into StratuxClient so all consumers get it
        this._stratux.situation = situation;
        this._stratux.dispatchEvent(new CustomEvent('stratux:situation', { detail: situation }));
    }
}
