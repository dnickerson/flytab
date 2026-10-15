/**
 * FlyTab — Flight Recorder
 * Records engine + GPS data at 1Hz to Savvy Aviation CSV format.
 * Stores CSV on device via NanoHTTPD filesystem.
 *
 * Auto-start: RPM > 500 for 10s (engine data) OR groundspeed > 30kt for 10s (GPS-only)
 * Auto-stop:  RPM = 0 for 60s (engine data) OR groundspeed < 10kt for 60s (GPS-only)
 *
 * Data sources:
 *   - Engine:  EngineClient WebSocket (1Hz push from Pi)
 *   - GPS:     StratuxClient WebSocket (situation messages)
 *
 * Output: Documents/FlyTab/flights/YYYYMMDD_HHMMZ.csv
 *         (renamed to YYYYMMDD_DEP-DEST.csv post-flight if NASR available)
 */

class FlightRecorder {
    static LOCAL_BASE = 'http://localhost:9090';
    static FLIGHTS_PATH = 'flights';
    static CSV_HEADER = 'Zulu_Time,MP,Oil Temp,Oil Pressure,Fuel Pressure,Volts,Amps,RPM,Fuel Flow,Gallons Remaining,Fuel Level 1,Fuel Level 2,Carb Temp,GP 2,GP 3,Thermalcouple,EGT 1,EGT 2,EGT 3,EGT 4,CHT 1,CHT 2,CHT 3,CHT 4,date,time_z,longitude,latitude,altitude_ft,speed_kts,bank,pitch,acc_vert,course,EGT Spread,CHT Spread,Max EGT,Final_Percent_Power,Operating_Condition,Percent,SFC,ml_phase,ml_score,ml_anomaly,ml_latency_ms';

    // Auto-start/stop thresholds
    static RPM_START_THRESHOLD = 500;
    static RPM_START_SECONDS = 10;
    static RPM_STOP_SECONDS = 60;
    // "Now" for _shutdownEvidenceNow: engine data is ~1 Hz, Stratux situation 10 Hz.
    static FRESH_DATA_MS = 5000;
    // Every request to TileServer. A save is a ~1 KB append and a rename reads a
    // few MB at most, all on local storage: 10 s means TileServer is stuck.
    // If a save had in fact written its rows and only answered late, the retry
    // repeats them: duplicate rows are recoverable, missing ones are not.
    static LOCAL_TIMEOUT_MS = 10000;
    // The rename's nearest-airport lookups (IndexedDB, which can hang).
    static NASR_TIMEOUT_MS = 5000;
    // While recording, a marker here names the files and when the recording was
    // last alive, so a restart (the WebView renderer dying, Android ending FlyTab)
    // doesn't split or orphan the flight; see recoverUnfinished().
    static ACTIVE_KEY = 'flytab_recording_active';
    // A relaunch within this of the last save carries on in the same files.
    static RESUME_WINDOW_MS = 10 * 60 * 1000;
    // recoverUnfinished: TileServer not answering yet -> retry this often.
    static RECOVER_RETRIES = 3;
    static RECOVER_RETRY_MS = 2000;
    // stop(): a failed final save is retried this many times, this far apart.
    static FINAL_SAVE_RETRIES = 2;
    static FINAL_SAVE_RETRY_MS = 1000;

    constructor(engineClient, stratuxClient, nasrDb) {
        this._engine = engineClient;
        this._stratux = stratuxClient;
        this._nasrDb = nasrDb;

        this._recording = false;
        this._fileName = null;
        this._csvBuffer = [];       // buffered rows before flush
        this._rowCount = 0;
        this._startTime = null;
        this._flushInterval = null;
        this._recordInterval = null;
        this._trafficFileName = null;
        this._trafficBuffer = [];
        this._trafficInterval = null;
        // One save in flight per file (see _serialFlush)
        this._csvSave = { active: null, next: null };
        this._trafficSave = { active: null, next: null };
        this._gapTimer = null;

        // Auto-start/stop counters
        this._rpmAboveCount = 0;
        this._rpmZeroCount = 0;
        this._gsAboveCount = 0;
        this._gsBelowCount = 0;
        this._autoMonitorInterval = null;

        // First/last GPS for dep/dest naming
        this._firstGps = null;
        this._lastGps = null;

        // recoverUnfinished() is deciding what to do with the previous run's recording
        this._recovering = false;
        // stop() in progress (saves, NASR lookups, rename: can take 10+ s). Nothing
        // may start or recover a recording meanwhile: stop() still works on this
        // recording's _fileName, buffers and GPS points.
        this._stopping = null;

        // Status callback
        this.onStatusChange = null;

        // Visibility-change handler — registered in init(), removed in destroy()
        this._onVisibilityHidden = null;
    }

    get recording() { return this._recording; }
    get rowCount() { return this._rowCount; }
    get fileName() { return this._fileName; }
    get duration() {
        if (!this._startTime) return '';
        const elapsed = Math.floor((Date.now() - this._startTime) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }

    init() {
        // Start auto-monitoring engine RPM
        this._autoMonitorInterval = setInterval(() => this._autoMonitor(), 1000);

        // When the screen turns off or the app is backgrounded, Android throttles
        // (then freezes) JS -- the 60-second auto-stop countdown never completes and
        // the flight never gets its logbook entry (4ef751b). So on hide: always flush,
        // and end the recording only on FRESH evidence that the flight is over
        // (_shutdownEvidenceNow). Never on a data gap or stale readings: on 10-13 a
        // pilot switching apps 27 s into a Wi-Fi dropout ended the recording 10 min
        // before landing. Anything else is decided by _autoMonitor after resume.
        this._onVisibilityHidden = () => {
            if (document.visibilityState !== 'hidden' || !this._recording) return;
            this._flush().catch(() => {});
            if (this._shutdownEvidenceNow()) this.stop();
        };
        document.addEventListener('visibilitychange', this._onVisibilityHidden);
    }

    destroy() {
        if (this._autoMonitorInterval) clearInterval(this._autoMonitorInterval);
        if (this._trafficInterval) { clearInterval(this._trafficInterval); this._trafficInterval = null; }
        if (this._onVisibilityHidden) {
            document.removeEventListener('visibilitychange', this._onVisibilityHidden);
            this._onVisibilityHidden = null;
        }
        if (this._recording) this.stop();
    }

    /** Manual start */
    async start() {
        if (this._recording || this._recovering || this._stopping) return;
        this._recording = true;
        this._rowCount = 0;
        this._startTime = Date.now();
        this._firstGps = null;
        this._lastGps = null;
        this._csvBuffer = [FlightRecorder.CSV_HEADER];

        // Generate filename: YYYYMMDD_HHMMZ.csv
        const now = new Date();
        const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hm = now.toISOString().slice(11, 16).replace(':', '');
        this._fileName = `${ymd}_${hm}Z.csv`;
        this._trafficFileName = `${ymd}_${hm}Z_traffic.ndjson`;
        this._trafficBuffer = [];

        this._startIntervals();
        this._saveMarker();

        this._emitStatus();
        window.dispatchEvent(new CustomEvent('flightsync:started'));
        if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Started: ${this._fileName}`);
    }

    _startIntervals() {
        // Record at 1Hz
        this._recordInterval = setInterval(() => this._recordRow(), 1000);
        // Flush to disk every 5 seconds (reduces worst-case data loss on crash)
        this._flushInterval = setInterval(() => {
            this._flush();
            this._flushTraffic();
            this._saveMarker();
        }, 5000);
        this._trafficInterval = setInterval(() => this._recordTrafficSnapshot(), 5000);
    }

    /**
     * After a restart: the previous run's recording, if it never reached stop().
     *  - Last alive within RESUME_WINDOW_MS: carry on in the same files, so the
     *    flight stays one recording with one logbook entry (10-14: a relaunch
     *    10 s after the crash started a second file and orphaned the first).
     *  - Older: close it out (rename + flightsync:stopped -> logbook entry),
     *    ending at its last save.
     *  - Its file is gone: forget it. File server can't tell: keep the marker
     *    for the next launch.
     * Call once the logbook is listening. Resolves 'resumed' | 'closed' | null.
     */
    async recoverUnfinished() {
        if (this._recording || this._recovering || this._stopping) return null;
        const raw = FlightRecorder._readStorage();
        if (raw == null) return null;
        const m = FlightRecorder.parseMarker(raw);
        if (!m) {
            this._clearMarker();
            if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', 'Ignored a damaged unfinished-recording marker');
            return null;
        }

        this._recovering = true;            // auto-start must not open a second file meanwhile
        try {
            // TileServer may not answer yet at startup: retry briefly. Auto-start
            // needs 10 s of engine/GPS data, so this stays inside that.
            let status = await this._fileStatus(m.fileName);
            for (let i = 0; status === 'error' && i < FlightRecorder.RECOVER_RETRIES; i++) {
                await new Promise((r) => setTimeout(r, FlightRecorder.RECOVER_RETRY_MS));
                status = await this._fileStatus(m.fileName);
            }
            if (status !== 'exists') {
                if (status === 'missing') this._clearMarker();
                if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Unfinished recording ${m.fileName}: file ${status === 'missing' ? 'gone — forgotten' : 'not readable — will retry next launch'}`);
                return null;
            }

            this._fileName = m.fileName;
            this._trafficFileName = m.trafficFileName;
            this._startTime = m.startTime;
            this._firstGps = m.firstGps;
            this._lastGps = m.lastGps;
            this._rowCount = m.rowCount;
            this._csvBuffer = [];           // the file already has its header
            this._trafficBuffer = [];
            this._recording = true;

            // Resume only a flight that was still going at its last save. If that save
            // already had fresh evidence the engine was stopped (the 60 s countdown
            // was running), carrying on would add the downtime to flight time and
            // Hobbs, or merge the next leg in: close it out at that save instead.
            const age = Date.now() - m.savedAt;
            if (!m.shutdown && age >= 0 && age < FlightRecorder.RESUME_WINDOW_MS) {
                this._startIntervals();
                this._saveMarker();
                this._emitStatus();
                window.dispatchEvent(new CustomEvent('flightsync:started', { detail: { resumed: true, fileName: this._fileName } }));
                if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Resumed after restart: ${this._fileName} (last saved ${Math.round(age / 1000)} s earlier)`);
                return 'resumed';
            }
            if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Closing out unfinished recording ${this._fileName} (last saved ${new Date(m.savedAt).toISOString()}${m.shutdown ? ', engine already stopped' : ''})`);
        } finally {
            this._recovering = false;
        }
        await this.stop({ endMs: m.savedAt });
        return 'closed';
    }

    /** The marker as validated data, or null. Names must be bare flights/ file names: they go into a URL. */
    static parseMarker(raw) {
        let m;
        try { m = JSON.parse(raw); } catch { return null; }
        if (!m || typeof m !== 'object') return null;
        const csvOk = typeof m.fileName === 'string' && /^[A-Za-z0-9_-]+\.csv$/.test(m.fileName);
        const trfOk = m.trafficFileName == null
            || (typeof m.trafficFileName === 'string' && /^[A-Za-z0-9_-]+\.ndjson$/.test(m.trafficFileName));
        if (!csvOk || !trfOk || !Number.isFinite(m.startTime) || !Number.isFinite(m.savedAt)) return null;
        const gps = (g) => (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) ? { lat: g.lat, lon: g.lon, alt: Number.isFinite(g.alt) ? g.alt : 0 } : null;
        return {
            fileName: m.fileName,
            trafficFileName: m.trafficFileName ?? null,
            startTime: m.startTime,
            firstGps: gps(m.firstGps),
            lastGps: gps(m.lastGps),
            rowCount: Number.isFinite(m.rowCount) ? m.rowCount : 0,
            savedAt: m.savedAt,
            shutdown: m.shutdown === true,
        };
    }

    static _readStorage() {
        try { return localStorage.getItem(FlightRecorder.ACTIVE_KEY); } catch { return null; }
    }

    _saveMarker() {
        if (!this._recording || !this._fileName) return;
        try {
            localStorage.setItem(FlightRecorder.ACTIVE_KEY, JSON.stringify({
                fileName: this._fileName,
                trafficFileName: this._trafficFileName,
                startTime: this._startTime,
                firstGps: this._firstGps,
                lastGps: this._lastGps,
                rowCount: this._rowCount,
                savedAt: Date.now(),
                // Fresh evidence the flight is over (engine stopped / aircraft
                // stopped): after a restart this recording is closed out, not resumed.
                shutdown: this._shutdownEvidenceNow(),
            }));
        } catch { /* storage full: the recording itself is unaffected */ }
    }

    _clearMarker() {
        try { localStorage.removeItem(FlightRecorder.ACTIVE_KEY); } catch { /* ignore */ }
    }

    /**
     * Manual stop. `endMs` (closing out a previous run's recording) is when it
     * was last alive; default now.
     */
    async stop(opts = {}) {
        if (!this._recording) return;
        this._recording = false;
        let done;
        this._stopping = new Promise((r) => { done = r; });
        try {
            return await this._finishStop(opts);
        } finally {
            this._stopping = null;
            done();
        }
    }

    async _finishStop({ endMs: endOverride } = {}) {

        if (this._recordInterval) { clearInterval(this._recordInterval); this._recordInterval = null; }
        if (this._flushInterval) { clearInterval(this._flushInterval); this._flushInterval = null; }
        if (this._trafficInterval) { clearInterval(this._trafficInterval); this._trafficInterval = null; }
        if (this._gapTimer) { clearTimeout(this._gapTimer); this._gapTimer = null; }

        const startTime = this._startTime ? new Date(this._startTime).toISOString() : null;
        const endMs = Number.isFinite(endOverride) ? endOverride : Date.now();
        const endTime = new Date(endMs).toISOString();
        const durationHours = this._startTime
            ? Math.round((endMs - this._startTime) / 36000) / 100
            : 0;

        // Final save. Each waits for a save already in flight, so everything is
        // written (or reported failed) before the rename reads the files. flushOk
        // tells downstream listeners whether the CSV's last rows were saved.
        let [flushOk] = await Promise.all([this._flush(), this._flushTraffic()]);
        for (let i = 0; !flushOk && i < FlightRecorder.FINAL_SAVE_RETRIES; i++) {
            await new Promise((r) => setTimeout(r, FlightRecorder.FINAL_SAVE_RETRY_MS));
            flushOk = await this._flush();
        }

        // Try to rename with dep/dest from NASR — returns { depIcao, destIcao } or null.
        // Not if the last rows couldn't be saved: the file keeps its start-time name.
        let route = null;
        if (flushOk) {
            route = await this._renameWithRoute();
        } else if (typeof DiagLog !== 'undefined') {
            DiagLog.log('recorder', `Final save failed: ${this._csvBuffer.length} rows could not be saved to ${this._fileName}; not renamed`);
        }

        const finalName = this._fileName;
        this._clearMarker();
        this._emitStatus();
        window.dispatchEvent(new CustomEvent('flightsync:stopped', {
            detail: {
                csvFilename: finalName,
                rowCount: this._rowCount,
                flushOk,
                depIcao: route?.depIcao || null,
                destIcao: route?.destIcao || null,
                startTime,
                endTime,
                durationHours,
            }
        }));
        if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Stopped: ${finalName} (${this._rowCount} rows, flushOk=${flushOk})`);
        return finalName;
    }

    /** Build one CSV row from current engine + GPS state */
    _recordRow() {
        const eng = this._engine?.lastData;
        const sit = this._stratux?.situation;
        const d = eng?.data || {};

        // Require at least a GPS fix or engine data to write a row.
        // Use freshness checks — lastData and situation are never nulled on disconnect
        // (by design, to keep gauges showing last-known values). Stale cached data
        // must not prevent the gap timer from firing during a fuel stop.
        const sitAge = sit?.timestamp ? (Date.now() - sit.timestamp) : Infinity;
        const hasGps = sit?.lat && sit?.lon && (sit?.gps_fix_quality > 0) && sitAge < 10000;
        const hasEngine = !!eng && (this._engine?.dataAge < 10000);
        if (!hasGps && !hasEngine) {
            // Both data sources absent — start gap timer if not already running.
            // If gap exceeds 2 minutes, auto-stop: the Stratux was likely powered off
            // for a fuel stop. Each flight leg gets its own clean recording.
            if (!this._gapTimer) {
                this._gapTimer = setTimeout(() => {
                    this._gapTimer = null;
                    if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', 'Extended data gap (2 min) — auto-stopping recording');
                    this.stop();
                }, 120000);
            }
            return;
        }
        // Data is flowing — cancel any pending gap auto-stop
        if (this._gapTimer) { clearTimeout(this._gapTimer); this._gapTimer = null; }

        // GPS position for dep/dest naming — always update from Stratux if available
        if (hasGps) {
            const gps = { lat: sit.lat, lon: sit.lon, alt: sit.alt_msl || 0 };
            if (!this._firstGps) this._firstGps = gps;
            this._lastGps = gps;
        }

        // Time in 12-hour format
        const timeStr = d.time || '';
        let time12 = '';
        if (timeStr) {
            const parts = timeStr.split(':');
            if (parts.length === 3) {
                const h = parseInt(parts[0]);
                const ampm = h >= 12 ? 'PM' : 'AM';
                const h12 = h % 12 || 12;
                time12 = `${h12}:${parts[1]}:${parts[2]} ${ampm}`;
            }
        }

        // EGT/CHT spreads
        const egts = [d.EGT1||0, d.EGT2||0, d.EGT3||0, d.EGT4||0];
        const chts = [d.CHT1||0, d.CHT2||0, d.CHT3||0, d.CHT4||0];
        const egtsPos = egts.filter(v => v > 0);
        const chtsPos = chts.filter(v => v > 0);
        const egtSpread = egtsPos.length ? Math.max(...egtsPos) - Math.min(...egtsPos) : 0;
        const chtSpread = chtsPos.length ? Math.max(...chtsPos) - Math.min(...chtsPos) : 0;
        const maxEgt = egtsPos.length ? Math.max(...egtsPos) : 0;

        // Date
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);

        // GPS/attitude from Stratux or engine status
        const lon = eng?.longitude || (sit?.lon) || '';
        const lat = eng?.latitude || (sit?.lat) || '';
        const alt = eng?.gps_altitude || (sit?.alt_msl) || 0;
        const gs = eng?.ground_speed || (sit?.ground_speed) || 0;
        const bank = eng?.bank != null ? eng.bank.toFixed(2) : (sit?.bank != null ? sit.bank.toFixed(2) : '');
        const pitch = eng?.pitch != null ? eng.pitch.toFixed(2) : (sit?.pitch != null ? sit.pitch.toFixed(2) : '');
        const accVert = eng?.acc_vert || (sit?.acc_vert) || '';
        const course = eng?.course != null ? Math.round(eng.course) : (sit?.true_course != null ? Math.round(sit.true_course) : '');

        const rpm = d.RPM || 0;
        const pctPower = rpm > 0 ? (eng?.percent_power || '') : '';
        const opCond = rpm > 0 ? (eng?.rop_lop_mode || '') : '';
        const pct = rpm > 0 ? (eng?.rop_lop_percent || '') : '';
        const sfc = rpm > 0 ? (eng?.sfc || '') : '';

        // Engine ML — grab latest result if inference is running
        const ml = window.engineML?.lastResult;
        const mlPhase = ml?.phase || '';
        const mlScore = ml?.score != null ? ml.score.toFixed(4) : '';
        const mlAnomaly = ml?.anomaly != null ? (ml.anomaly ? 1 : 0) : '';
        const mlLatency = ml?.latencyMs != null ? Math.round(ml.latencyMs) : '';

        const row = [
            time12, d.MP||0, d.Oil_Temp||0, d.Oil_Press||0,
            d.Fuel_Press||0, d.Volts||0, d.Amps||0,
            rpm, d.Fuel_Flow||0, (eng?.fuel?.fuel_remaining ?? d.Fuel_Remaining ?? 0),
            d.Fuel_Left||0, d.Fuel_Right||0, d.Carb_Temp||0,
            d.GP2||'', d.GP3||'', d.Thermo||0,
            d.EGT1||0, d.EGT2||0, d.EGT3||0, d.EGT4||0,
            d.CHT1||0, d.CHT2||0, d.CHT3||0, d.CHT4||0,
            dateStr, time12,
            lon, lat, alt, gs,
            bank, pitch, accVert, course,
            egtSpread, chtSpread, maxEgt,
            pctPower, opCond, pct, sfc,
            mlPhase, mlScore, mlAnomaly, mlLatency
        ].join(',');

        this._csvBuffer.push(row);
        this._rowCount++;
    }

    _recordTrafficSnapshot() {
        if (!this._recording || !this._trafficFileName) return;
        const traffic = this._stratux?.traffic;
        if (!traffic || traffic.size === 0) return;

        const t = this._rowCount;
        const MAX_TRAFFIC_AGE_MS = 30000;
        const now = Date.now();
        const targets = [];
        for (const tgt of traffic.values()) {
            if (!tgt.lat || !tgt.lon) continue;
            if (now - (tgt.last_seen || 0) > MAX_TRAFFIC_AGE_MS) continue;
            targets.push({
                icao: tgt.hex,
                cs:   tgt.callsign || '',
                lat:  tgt.lat,
                lon:  tgt.lon,
                altFt: tgt.alt || 0,
                spdKts: tgt.speed || 0,
                hdg:  tgt.track || 0,
                squawk: tgt.squawk ? String(tgt.squawk).padStart(4, '0') : '',
            });
        }
        if (!targets.length) return;

        this._trafficBuffer.push(JSON.stringify({ t, ts: now, targets }));
    }

    /** Save buffered CSV rows (append). Resolves true if they were written. */
    _flush() {
        return this._serialFlush(this._csvSave, () => this._appendBuffer(this._csvBuffer, this._fileName, 'text/csv', 'Flush'));
    }

    /** Save buffered traffic snapshots (append). Resolves true if they were written. */
    _flushTraffic() {
        return this._serialFlush(this._trafficSave, () => this._appendBuffer(this._trafficBuffer, this._trafficFileName, 'application/x-ndjson', 'Traffic flush'));
    }

    /**
     * Run one save at a time per file. TileServer (NanoHTTPD) handles each request
     * on its own thread, so two appends to one file could land interleaved or out
     * of order, and a failed save would put its rows back behind rows a later
     * save had already written. A save requested while one is in flight gets one
     * shared follow-up that starts when it ends and takes whatever is buffered by
     * then, so saves requested during a stall don't pile up.
     */
    _serialFlush(slot, run) {
        if (slot.active) {
            if (!slot.next) slot.next = slot.active.then(() => { slot.next = null; return this._serialFlush(slot, run); });
            return slot.next;
        }
        slot.active = run().catch(() => false).finally(() => { slot.active = null; });
        return slot.active;
    }

    /**
     * Append everything in `buf` to flights/`name`. On failure the lines go back
     * to the front of `buf` (ahead of anything recorded meanwhile) for the next save.
     */
    async _appendBuffer(buf, name, contentType, label) {
        if (!buf.length || !name) return true;
        const lines = buf.splice(0);
        try {
            const resp = await this._local(name, {
                method: 'PUT',
                headers: { 'Content-Type': contentType, 'X-Append': 'true' },
                body: lines.join('\n') + '\n',
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return true;
        } catch (err) {
            buf.unshift(...lines);
            if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `${label} failed: ${err.message}`);
            return false;
        }
    }

    /**
     * Request flights/`name` from TileServer; for a GET, read the whole body too.
     * All of it within LOCAL_TIMEOUT_MS, so nothing in a save or the rename can
     * hang stop(). Resolves { ok, status, text }; rejects on a network error or
     * on timeout ("timed out after 10 s").
     */
    async _local(name, opts = {}) {
        const ctrl = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, FlightRecorder.LOCAL_TIMEOUT_MS);
        try {
            const r = await fetch(`${FlightRecorder.LOCAL_BASE}/${FlightRecorder.FLIGHTS_PATH}/${name}`, { ...opts, signal: ctrl.signal });
            const text = (opts.method || 'GET') === 'GET' ? await r.text() : '';
            return { ok: r.ok, status: r.status, text };
        } catch (err) {
            throw timedOut ? new Error(`timed out after ${FlightRecorder.LOCAL_TIMEOUT_MS / 1000} s`) : err;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Rename the finished recording to YYYYMMDD_DEP-DEST.csv (and its traffic
     * companion to match). The server has no rename, so it's copy -> verify ->
     * delete, and it must never lose a flight:
     *  - the original is deleted only after the copy reads back IDENTICAL --
     *    TileServer.handlePut answers 201 even when it wrote nothing;
     *  - an existing file is never overwritten (a non-append PUT truncates):
     *    a second same-route flight that day becomes _2, _3, ...;
     *  - anything uncertain leaves the original name in place;
     *  - nothing can hang: it runs inside stop(), before the stopped event that
     *    closes the flight out (TileServer requests and NASR lookups time out).
     * Returns { depIcao, destIcao } when the CSV was renamed, else null.
     */
    async _renameWithRoute() {
        if (!this._nasrDb || !this._firstGps || !this._lastGps) return null;

        try {
            const dep = await this._nearestAirport(this._firstGps.lat, this._firstGps.lon);
            const dest = await this._nearestAirport(this._lastGps.lat, this._lastGps.lon);
            if (!dep || !dest) return null;

            const ymd = this._fileName.split('_')[0];
            const stem = await this._freeStem(`${ymd}_${dep}-${dest}`);
            if (!stem) {
                if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Rename skipped — no free name for ${ymd}_${dep}-${dest}; kept ${this._fileName}`);
                return null;
            }
            const newName = `${stem}.csv`;
            if (!(await this._moveFile(this._fileName, newName, 'text/csv'))) {
                if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Rename to ${newName} not verified — kept ${this._fileName}`);
                return null;
            }
            this._fileName = newName;

            if (this._trafficFileName) {
                const newTrafficName = `${stem}_traffic.ndjson`;
                if (await this._moveFile(this._trafficFileName, newTrafficName, 'application/x-ndjson')) {
                    this._trafficFileName = newTrafficName;
                } else if (typeof DiagLog !== 'undefined') {
                    DiagLog.log('recorder', `Traffic rename not verified — kept ${this._trafficFileName}`);
                }
            }

            if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Renamed to ${newName}`);
            return { depIcao: dep, destIcao: dest };
        } catch (err) {
            if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Rename failed: ${err.message}`);
            return null;
        }
    }

    /**
     * First of stem, stem_2 .. stem_9 for which neither the CSV nor its traffic
     * companion exists (a definite 404). null if none is free or existence can't
     * be confirmed (server error) -- then we don't rename at all.
     */
    async _freeStem(stem) {
        for (let n = 1; n <= 9; n++) {
            const candidate = n === 1 ? stem : `${stem}_${n}`;
            const csv = await this._fileStatus(`${candidate}.csv`);
            const trf = await this._fileStatus(`${candidate}_traffic.ndjson`);
            if (csv === 'error' || trf === 'error') return null;
            if (csv === 'missing' && trf === 'missing') return candidate;
        }
        return null;
    }

    /** 'exists' | 'missing' | 'error' for a file in flights/. */
    async _fileStatus(name) {
        try {
            const r = await this._local(name);
            if (r.ok) return 'exists';
            return r.status === 404 ? 'missing' : 'error';
        } catch { return 'error'; }
    }

    /**
     * Copy flights/from -> flights/to, read the copy back, and delete the original
     * only if it matches exactly. A wrong copy is removed; the original is kept.
     * Returns true only when `to` holds the data and `from` is no longer needed.
     * Never throws: a failure after the copy is verified still counts as moved.
     */
    async _moveFile(from, to, contentType) {
        const log = (msg) => { if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', msg); };
        try {
            const src = await this._local(from);
            if (!src.ok) return false;
            const data = src.text;

            const put = await this._local(to, { method: 'PUT', headers: { 'Content-Type': contentType }, body: data });
            if (!put.ok) return false;

            const check = await this._local(to);
            if (!check.ok || check.text !== data) {
                // The copy is wrong (or unreadable). Remove it only if we could read it,
                // i.e. we know it's ours and bad; the original stays either way.
                if (check.ok) await this._local(to, { method: 'DELETE' }).catch(() => {});
                return false;
            }
        } catch (err) {
            log(`Copying ${from} to ${to} failed: ${err.message} — kept ${from}`);
            return false;
        }

        // `to` holds the data: the move has happened whatever becomes of `from`.
        try {
            const del = await this._local(from, { method: 'DELETE' });
            if (!del.ok) log(`Renamed copy verified, but deleting ${from} failed (HTTP ${del.status}) — both kept`);
        } catch (err) {
            log(`Renamed copy verified, but deleting ${from} failed: ${err.message} — ${from} may remain`);
        }
        return true;
    }

    async _nearestAirport(lat, lon) {
        if (!this._nasrDb) return null;
        let timer;
        try {
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${FlightRecorder.NASR_TIMEOUT_MS / 1000} s`)), FlightRecorder.NASR_TIMEOUT_MS);
            });
            const nearby = await Promise.race([this._nasrDb.getAirportsNear(lat, lon, 10), timeout]);
            if (!nearby || nearby.length === 0) return null;
            nearby.sort((a, b) =>
                NasrDB.haversineNm(lat, lon, a.lat, a.lon) -
                NasrDB.haversineNm(lat, lon, b.lat, b.lon)
            );
            return nearby[0].icao || nearby[0].id || null;
        } catch (err) {
            // NASR not available, or the lookup hung
            if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Airport lookup for rename failed: ${err?.message}`);
        } finally {
            clearTimeout(timer);
        }
        return null;
    }

    /** Auto-start/stop based on RPM (engine data) or groundspeed (GPS-only) */
    /**
     * Is the flight over, judging ONLY by data received in the last
     * FRESH_DATA_MS? Used when the app is being backgrounded and the normal
     * 60 s countdown can't be trusted to run.
     *  - engine monitor reporting: RPM at/below the stop threshold right now;
     *  - no engine monitor this session (GPS-only recording): ground speed < 10 kt.
     * A data gap, a stale engine reading (link lost) or a stale situation is not
     * evidence -- the countdown counters may have been fed by stale values.
     */
    _shutdownEvidenceNow() {
        const cfg = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.get('flightRecording') : {};
        const stopThreshold = cfg?.rpmStopThreshold ?? 0;
        const eng = this._engine?.lastData;
        if (eng) {
            const fresh = (this._engine?.dataAge ?? Infinity) < FlightRecorder.FRESH_DATA_MS;
            const rpm = eng.data?.RPM;
            return fresh && typeof rpm === 'number' && rpm <= stopThreshold;
        }
        const sit = this._stratux?.situation;
        const sitAge = typeof sit?.timestamp === 'number' ? Date.now() - sit.timestamp : Infinity;
        return sitAge < FlightRecorder.FRESH_DATA_MS && typeof sit?.ground_speed === 'number' && sit.ground_speed < 10;
    }

    _autoMonitor() {
        const eng = this._engine?.lastData;
        const sit = this._stratux?.situation;
        const rpm = eng?.data?.RPM || 0;
        const gs = sit?.ground_speed || 0;
        // Ground speed counts only from a fresh situation. After a restart the
        // situation is null until Stratux reconnects; "no data" is not "0 kt" and
        // must not auto-stop a resumed recording (the 2-min gap timer handles it).
        const sitFresh = typeof sit?.timestamp === 'number' && (Date.now() - sit.timestamp) < FlightRecorder.FRESH_DATA_MS;

        // Prefer RPM-based trigger when engine data is available.
        // If engine data is unavailable (WebSocket disconnected / app backgrounded),
        // fall back to GPS groundspeed so GPS-only flights auto-start/stop correctly.
        const hasEngine = !!eng;

        if (!this._recording) {
            if (hasEngine) {
                // RPM-based auto-start
                if (rpm >= FlightRecorder.RPM_START_THRESHOLD) {
                    this._rpmAboveCount++;
                    if (this._rpmAboveCount >= FlightRecorder.RPM_START_SECONDS) {
                        this.start();
                        // Refused while a stop/recovery is in progress: try again next second.
                        if (this._recording) this._rpmAboveCount = 0;
                    }
                } else {
                    this._rpmAboveCount = 0;
                }
            } else {
                // GPS-based auto-start: GS > 30kt for 10s
                if (sitFresh && gs > 30) {
                    this._gsAboveCount++;
                    if (this._gsAboveCount >= 10) {
                        this.start();
                        if (this._recording) this._gsAboveCount = 0;
                    }
                } else {
                    this._gsAboveCount = 0;
                }
            }
        } else {
            if (hasEngine) {
                // RPM-based auto-stop — use configurable threshold (default 0 = exact zero)
                const cfg = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.get('flightRecording') : {};
                const stopThreshold = cfg.rpmStopThreshold ?? 0;
                if (rpm <= stopThreshold) {
                    this._rpmZeroCount++;
                    if (this._rpmZeroCount >= FlightRecorder.RPM_STOP_SECONDS) {
                        this.stop();
                        this._rpmZeroCount = 0;
                    }
                } else {
                    this._rpmZeroCount = 0;
                }
            } else {
                // GPS-based auto-stop: GS < 10kt for stopDelaySeconds
                const cfg = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.get('flightRecording') : {};
                const stopDelay = cfg.stopDelaySeconds ?? 60;
                if (!sitFresh) {
                    // no data: neither counts nor resets
                } else if (gs < 10) {
                    this._gsBelowCount++;
                    if (this._gsBelowCount >= stopDelay) {
                        this.stop();
                        this._gsBelowCount = 0;
                    }
                } else {
                    this._gsBelowCount = 0;
                }
            }
        }
    }

    _emitStatus() {
        if (this.onStatusChange) {
            this.onStatusChange({
                recording: this._recording,
                fileName: this._fileName,
                rowCount: this._rowCount,
                duration: this.duration,
            });
        }
    }
}
