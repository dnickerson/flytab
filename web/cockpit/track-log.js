/**
 * FlyPi — Track Log
 * Records GPS position every 10s, stores in localStorage ring buffer.
 * Renders as polyline on map. GPX export.
 */

class TrackLog {
    static MAX_POINTS = 4320; // 12 hours at 10s intervals
    static RECORD_INTERVAL = 10000;
    static STORAGE_KEY = 'flypi_track';

    constructor(stratuxClient, cockpitMap) {
        this.stratux = stratuxClient;
        this.map = cockpitMap;
        this._timer = null;
        this._points = [];
    }

    init() {
        // Load existing track
        this._load();

        // Start recording
        this._timer = setInterval(() => this._record(), TrackLog.RECORD_INTERVAL);

        // Initial render
        this._renderOnMap();
    }

    destroy() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    reset() {
        this._points = [];
        this._save();
        this._renderOnMap();
    }

    /** Re-render the track on the map (used when visibility toggle changes). */
    redraw() {
        this._renderOnMap();
    }

    get points() { return this._points; }

    _record() {
        const sit = this.stratux.situation;
        if (!sit || sit.gps_fix_quality === 0 || !sit.lat || !sit.lon) return;

        const pt = {
            ts: Date.now(),
            lat: sit.lat,
            lon: sit.lon,
            alt: sit.alt_msl || 0,
            gs: sit.ground_speed || 0,
            trk: sit.true_course || 0,
        };

        this._points.push(pt);

        // Ring buffer trim
        if (this._points.length > TrackLog.MAX_POINTS) {
            this._points = this._points.slice(-TrackLog.MAX_POINTS);
        }

        this._save();
        this._renderOnMap();
    }

    _save() {
        try {
            localStorage.setItem(TrackLog.STORAGE_KEY, JSON.stringify(this._points));
        } catch { /* storage full — trim more aggressively */
            this._points = this._points.slice(-Math.floor(TrackLog.MAX_POINTS / 2));
            try { localStorage.setItem(TrackLog.STORAGE_KEY, JSON.stringify(this._points)); } catch { /* give up */ }
        }
    }

    _load() {
        try {
            const raw = localStorage.getItem(TrackLog.STORAGE_KEY);
            if (raw) this._points = JSON.parse(raw);
        } catch { this._points = []; }
    }

    _renderOnMap() {
        if (this.map) {
            this.map.setTrackLog(this._points);
        }
    }

}
