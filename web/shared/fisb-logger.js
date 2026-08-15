/**
 * FisbLogger — persists all FIS-B events to a _weather.ndjson companion file
 * via NanoHTTPD PUT+append, mirroring the FlightRecorder pattern.
 */
class FisbLogger {
    static LOCAL_BASE = 'http://localhost:9090';
    static FLIGHTS_PATH = 'flights';
    static WINDS_BATCH_MS = 3000;  // log only winds received in the last 3s (current FIS-B batch)

    constructor(fisbClient) {
        this._fisb = fisbClient;
        this._recording = false;
        this._fileName = null;
        this._t0 = null;
        this._buffer = [];
        this._flushInterval = null;

        this._onFlightStart = () => this._start();
        this._onFlightStop  = (e) => this._stop(e.detail);

        this._onNexrad = (e) => this._logNexrad(e.detail);
        this._onMetar  = (e) => this._logMetar(e.detail);
        this._onPirep  = (e) => this._logPirep(e.detail);
        this._onSigmet = (e) => this._logSigmet(e.detail);
        this._onAirmet = (e) => this._logAirmet(e.detail);
        this._onCwa    = (e) => this._logCwa(e.detail);
        this._onWinds  = ()  => this._logWindsSnapshot();
        this._onNotam  = (e) => this._logNotam(e.detail);
    }

    init() {
        window.addEventListener('flightsync:started', this._onFlightStart);
        window.addEventListener('flightsync:stopped', this._onFlightStop);
    }

    destroy() {
        window.removeEventListener('flightsync:started', this._onFlightStart);
        window.removeEventListener('flightsync:stopped', this._onFlightStop);
        this._stopListeners();
    }

    _startListeners() {
        this._fisb.addEventListener('fisb:nexrad', this._onNexrad);
        this._fisb.addEventListener('fisb:metar',  this._onMetar);
        this._fisb.addEventListener('fisb:pirep',  this._onPirep);
        this._fisb.addEventListener('fisb:sigmet', this._onSigmet);
        this._fisb.addEventListener('fisb:airmet', this._onAirmet);
        this._fisb.addEventListener('fisb:cwa',    this._onCwa);
        this._fisb.addEventListener('fisb:winds',  this._onWinds);
        this._fisb.addEventListener('fisb:notam',  this._onNotam);
    }

    _stopListeners() {
        this._fisb.removeEventListener('fisb:nexrad', this._onNexrad);
        this._fisb.removeEventListener('fisb:metar',  this._onMetar);
        this._fisb.removeEventListener('fisb:pirep',  this._onPirep);
        this._fisb.removeEventListener('fisb:sigmet', this._onSigmet);
        this._fisb.removeEventListener('fisb:airmet', this._onAirmet);
        this._fisb.removeEventListener('fisb:cwa',    this._onCwa);
        this._fisb.removeEventListener('fisb:winds',  this._onWinds);
        this._fisb.removeEventListener('fisb:notam',  this._onNotam);
    }

    async _start() {
        if (this._recording) return;
        this._recording = true;
        this._t0 = Date.now();
        const now = new Date(this._t0);
        const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hm  = now.toISOString().slice(11, 16).replace(':', '');
        this._fileName = `${ymd}_${hm}Z_weather.ndjson`;
        this._buffer = [JSON.stringify({
            version: 1,
            flight: `${ymd}_unknown`,
            dep_at: now.toISOString(),
            t0: Math.floor(this._t0 / 1000),
        })];
        this._startListeners();
        this._flushInterval = setInterval(() => this._flush(), 5000);
        if (typeof DiagLog !== 'undefined') DiagLog.log('fisb-logger', `Started: ${this._fileName}`);
    }

    async _stop(detail) {
        const csvFilename = detail?.csvFilename;

        if (!this._recording) {
            // Already stopped — but if we still have a temp file and now get the real csvFilename, rename it.
            if (csvFilename && this._fileName) {
                const newName = csvFilename.replace(/\.csv$/, '_weather.ndjson');
                if (newName !== this._fileName) await this._rename(newName);
                if (typeof DiagLog !== 'undefined') DiagLog.log('fisb-logger', `Renamed (deferred): ${newName}`);
                this._fileName = null;
                this._t0 = null;
            }
            return;
        }

        this._recording = false;
        if (this._flushInterval) { clearInterval(this._flushInterval); this._flushInterval = null; }
        this._stopListeners();
        await this._flush();

        if (csvFilename && this._fileName) {
            const newName = csvFilename.replace(/\.csv$/, '_weather.ndjson');
            if (newName !== this._fileName) await this._rename(newName);
            this._fileName = null;
            this._t0 = null;
        }
        // If no csvFilename: _fileName stays alive so the deferred rename can happen
        // when flight-recorder.js fires the second stop with the real filename.
        // _start() overwrites _fileName on the next flight start regardless.
        if (typeof DiagLog !== 'undefined') DiagLog.log('fisb-logger', `Stopped: ${this._fileName ?? 'pending rename'}`);
    }

    _t(now) { return Math.floor(((now || Date.now()) - this._t0) / 1000); }

    _append(obj) { this._buffer.push(JSON.stringify(obj)); }

    _logNexrad(msg) {
        if (!this._recording || !msg?.NEXRAD?.length) return;
        const now = Date.now();
        // FisbNexrad._parseFisbDataTime derives the real FIS-B broadcast time from
        // FISB_hours/minutes/seconds/month/day — msg.LocaltimeReceived doesn't exist
        // on Stratux's real UATFrame struct (see fisb-nexrad.js and issue #136).
        const dataTime = (typeof FisbNexrad !== 'undefined')
            ? FisbNexrad._parseFisbDataTime(msg, now) : now;
        const blocks = msg.NEXRAD
            .filter(b => b.Intensity?.length > 0)
            .map(b => ({
                lat: b.LatNorth, lon: b.LonWest,
                h: b.Height,     w: b.Width,
                intensity: b.Intensity,
                radarType: b.Radar_Type,
                scale: b.Scale,
            }));
        if (!blocks.length) return;
        this._append({ t: this._t(now), type: 'nexrad', blocks, dataTime });
    }

    _logMetar(detail) {
        if (!this._recording) return;
        const now = Date.now();
        const d = detail.decoded || {};
        this._append({
            t: this._t(now), type: 'metar',
            icao: detail.icao,
            raw: detail.raw,
            observed_at: d.observed_at || null,
            cat: d.flight_category || null,
            wind_dir: d.wind_dir ?? null,
            wind_speed: d.wind_speed ?? null,
            wind_gust: d.wind_gust ?? null,
            wind_variable: d.wind_variable ?? null,
            visibility_sm: d.visibility_sm ?? null,
            visibility_plus: d.visibility_plus ?? null,
            ceiling_ft: d.ceiling_ft ?? null,
            temp_c: d.temp_c ?? null,
            dewpoint_c: d.dewpoint_c ?? null,
            altimeter: d.altimeter ?? null,
            cb_skies: d.cb_skies ?? [],
            at_station_ts: d.at_station_ts ?? null,
            thunderstorm_activity: d.thunderstorm_activity ?? [],
            cb_directions: d.cb_directions ?? [],
        });
    }

    _logPirep(detail) {
        if (!this._recording) return;
        const now = Date.now();
        this._append({
            t: this._t(now), type: 'pirep',
            lat: detail.lat ?? null,
            lon: detail.lon ?? null,
            altitude: detail.altitude ?? null,
            pirepType: detail.type || null,
            severity: detail.severity ?? null,
            urgent: detail.is_urgent ?? false,
            raw: detail.raw || '',
        });
    }

    _logSigmet(detail) {
        if (!this._recording) return;
        const now = Date.now();
        this._append({
            t: this._t(now), type: 'sigmet',
            sigmetType: detail.type || 'sigmet',
            points: detail.points || [],
            location: detail.location || null,
            expires_at: detail.expires_at || null,
            raw: detail.raw || '',
        });
    }

    _logAirmet(detail) {
        if (!this._recording) return;
        const now = Date.now();
        this._append({
            t: this._t(now), type: 'airmet',
            airmetType: detail.hazard || detail.type || 'airmet',
            points: detail.points || [],
            location: detail.location || null,
            expires_at: detail.expires_at || null,
            raw: detail.raw || '',
        });
    }

    _logCwa(detail) {
        if (!this._recording) return;
        const now = Date.now();
        this._append({
            t: this._t(now), type: 'cwa',
            points: detail.points || [],
            raw: detail.raw || '',
        });
    }

    _logWindsSnapshot() {
        if (!this._recording) return;
        if (!this._fisb?.winds) return;
        const now = Date.now();
        const cutoff = now - FisbLogger.WINDS_BATCH_MS;
        for (const w of this._fisb.winds.values()) {
            if ((w.received_at || 0) < cutoff) continue;
            this._append({
                t: this._t(now), type: 'winds',
                station: w.station || null,
                alt: w.alt ?? null,
                dir: w.dir ?? null,
                spd: w.spd ?? null,
                temp: w.temp ?? null,
                lat: w.lat ?? null,
                lon: w.lon ?? null,
            });
        }
    }

    _logNotam(detail) {
        if (!this._recording) return;
        const now = Date.now();
        this._append({
            t: this._t(now), type: 'notam',
            pid: detail.product_id ?? null,
            tfr: detail.is_tfr ?? false,
            icao: detail.icao ?? null,
            lat: detail.lat ?? null,
            lon: detail.lon ?? null,
            points: detail.points || [],
            radius_nm: detail.radius_nm ?? null,
            expires_at: detail.expires_at || null,
            raw: detail.raw || '',
        });
    }

    async _flush() {
        if (!this._buffer.length || !this._fileName) return;
        const lines = this._buffer.splice(0);
        const content = lines.join('\n') + '\n';
        const path = `${FisbLogger.FLIGHTS_PATH}/${this._fileName}`;
        try {
            const resp = await fetch(`${FisbLogger.LOCAL_BASE}/${path}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/x-ndjson', 'X-Append': 'true' },
                body: content,
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        } catch (err) {
            this._buffer.unshift(...lines);
            if (typeof DiagLog !== 'undefined') DiagLog.log('fisb-logger', `Flush failed: ${err.message}`);
        }
    }

    async _rename(newName) {
        const oldPath = `${FisbLogger.FLIGHTS_PATH}/${this._fileName}`;
        const newPath = `${FisbLogger.FLIGHTS_PATH}/${newName}`;
        try {
            const r = await fetch(`${FisbLogger.LOCAL_BASE}/${oldPath}`);
            if (!r.ok) return;
            const data = await r.text();
            await fetch(`${FisbLogger.LOCAL_BASE}/${newPath}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/x-ndjson' },
                body: data,
            });
            await fetch(`${FisbLogger.LOCAL_BASE}/${oldPath}`, { method: 'DELETE' });
            this._fileName = newName;
            if (typeof DiagLog !== 'undefined') DiagLog.log('fisb-logger', `Renamed to ${newName}`);
        } catch (err) {
            if (typeof DiagLog !== 'undefined') DiagLog.log('fisb-logger', `Rename failed: ${err.message}`);
        }
    }
}
