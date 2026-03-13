/**
 * FlyTab — GPS Source Manager
 * Selectable GPS: 'internal' (Android device GPS) or 'stratux' (Pi GPS via WebSocket).
 * When 'internal' is selected, injects device GPS into the StratuxClient's situation
 * so all downstream modules (map, instrument strip, route table, etc.) work unchanged.
 *
 * Stratux still provides: traffic, ADS-B, AHRS pitch/roll/G-load, baro altitude.
 * Internal GPS provides: lat, lon, altitude MSL, ground speed, course.
 * In 'internal' mode, GPS fields come from device; AHRS fields still from Stratux if available.
 */

class GpsSource {
    constructor(stratuxClient) {
        this._stratux = stratuxClient;
        this._source = Settings.get('gps_source') || 'stratux'; // 'internal' or 'stratux'
        this._watchId = null;
        this._lastInternal = null;
        this._firstFixLogged = false;
        this._vsSmoothed = 0; // EMA-smoothed vertical speed (fpm)
        this._staleTimer = null; // fires when internal GPS stops updating

        // If persisted source is 'internal', set suppress flag immediately
        // so no Stratux situation events leak before start() is called.
        if (this._source === 'internal') {
            this._stratux._suppressGpsSituation = true;
        }
    }

    get source() { return this._source; }

    /** Switch GPS source. Persists to settings. */
    setSource(source) {
        if (source !== 'internal' && source !== 'stratux') return;
        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', `Switching GPS source: ${this._source} → ${source}`);
        this._source = source;
        Settings.set('gps_source', source);

        if (source === 'internal') {
            this._stratux._suppressGpsSituation = true;
            this._startInternal();
        } else {
            this._stratux._suppressGpsSituation = false;
            this._stopInternal();
        }
    }

    /** Start watching (call after StratuxClient.connect()) */
    start() {
        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', `GpsSource.start() source=${this._source}`);
        if (this._source === 'internal') {
            this._stratux._suppressGpsSituation = true;
            this._startInternal();
        }
    }

    stop() {
        this._stratux._suppressGpsSituation = false;
        this._stopInternal();
    }

    _startInternal() {
        if (this._watchId !== null) return;
        if (!('geolocation' in navigator)) {
            const msg = 'Geolocation API not available in this WebView';
            console.warn('[GpsSource]', msg);
            if (typeof DiagLog !== 'undefined') DiagLog.log('gps', msg);
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
            },
            {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 10000,
            }
        );
        this._resetStaleTimer();
        console.log('[GpsSource] Internal GPS watchPosition started');
        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', 'watchPosition registered, waiting for fix…');
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

        // Calculate ground speed in knots (coords.speed is m/s, may be null)
        const speedKt = (c.speed != null && c.speed >= 0) ? c.speed * 1.94384 : 0;

        // Calculate course (coords.heading is degrees, may be null)
        const course = (c.heading != null && !isNaN(c.heading)) ? c.heading : 0;

        // Altitude in feet (coords.altitude is meters MSL, may be null)
        const altMsl = (c.altitude != null) ? c.altitude * 3.28084 : 0;

        // Vertical speed — EMA-smoothed to reduce consumer GPS altitude jitter.
        // Raw delta can swing ±2000 fpm from 10-30m jitter at 1Hz.
        // Alpha=0.3 gives ~3-fix settling time, damping noise while tracking real climbs.
        const now = Date.now();
        if (this._lastInternal && this._lastInternal._rawAltM != null && c.altitude != null) {
            const dt = (now - this._lastInternal.timestamp) / 1000;
            if (dt > 0 && dt < 10) {
                const rawVs = ((c.altitude - this._lastInternal._rawAltM) * 3.28084 / dt) * 60;
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
