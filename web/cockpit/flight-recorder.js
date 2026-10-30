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
    static CSV_HEADER = 'Zulu_Time,MP,Oil Temp,Oil Pressure,Fuel Pressure,Volts,Amps,RPM,Fuel Flow,Gallons Remaining,Fuel Level 1,Fuel Level 2,Carb Temp,GP 2,GP 3,Thermalcouple,EGT 1,EGT 2,EGT 3,EGT 4,CHT 1,CHT 2,CHT 3,CHT 4,date,time_z,longitude,latitude,altitude_ft,speed_kts,bank,pitch,acc_vert,course,EGT Spread,CHT Spread,Max EGT,Final_Percent_Power,Operating_Condition,Percent,SFC,ml_phase,ml_score,ml_anomaly,ml_latency_ms,event';

    // Marks the checklist can put in the recording (markEvent), written to the
    // `event` column of the next row. Fixed list: they go into a CSV unquoted.
    static EVENT_CODES = ['runup_start', 'runup_end', 'mag_L', 'mag_R', 'mag_BOTH'];
    static MAG_CODES = ['mag_L', 'mag_R', 'mag_BOTH'];
    // The engine data refreshes every 2 s but rows are written at 1 Hz, so each sample
    // is written twice with the same Zulu_Time, and the analysis scripts keep only the
    // FIRST row per Zulu_Time. A mark is therefore held for the first row of a NEW
    // sample time. If the sample time is empty, or has stayed the same for this many
    // rows in a row (engine data frozen), it goes on the next row anyway.
    static MARK_FROZEN_ROWS = 3;

    // Auto-start/stop thresholds
    static RPM_START_THRESHOLD = 500;
    static RPM_START_SECONDS = 10;
    static RPM_STOP_SECONDS = 60;
    // Screen off / app hidden ends a recording at once only after RPM has read 0
    // this long. The engine data on this airframe shows 0 RPM for 1-13 s with the
    // engine running, mostly at the mag check (see the sticky-valve stopSec in
    // CLAUDE.md): ending the recording there splits the flight in two. Before
    // this, the 60 s countdown (or a close-out with the marker's ML counts) decides.
    static HIDE_STOP_RPM_ZERO_SECONDS = 30;
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
    // EngineMLBridge.getFlightCounts() fields kept in the marker (besides phases)
    static ML_COUNT_FIELDS = ['samples', 'duration_s', 'anomaly_count', 'latency_sum_ms', 'latency_n', 'advisory_count'];
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
        // "Not recording: home Stratux" logged for this connection (_onHomeStratux)
        this._homeLogged = false;

        // First/last GPS for dep/dest naming
        this._firstGps = null;
        this._lastGps = null;

        // recoverUnfinished() is deciding what to do with the previous run's recording
        this._recovering = false;
        // stop() in progress (saves, NASR lookups, rename: can take 10+ s). Nothing
        // may start or recover a recording meanwhile: stop() still works on this
        // recording's _fileName, buffers and GPS points.
        this._stopping = null;

        // Marks (markEvent) waiting for the next row, and the last mag marked.
        this._pendingEvents = [];
        this._currentMag = null;
        this._lastSampleTime = null;        // Zulu_Time of the last row written
        this._sameTimeRows = 0;             // rows in a row with that same Zulu_Time (after the first)
        // Does THIS recording's file have the `event` column? Always for a new one;
        // false for one resumed from before marks existed (its header is the old one,
        // and a row must never have more fields than its file's header).
        // undefined (never set up) counts as true: see _hasEventColumn().
        this._eventColumn = true;

        // Status callback
        this.onStatusChange = null;

        // () => Engine ML counts for the flight so far (EngineMLBridge.getFlightCounts),
        // set by app.js. Saved in the marker and sent with flightsync:stopped (#188).
        this.mlCounts = null;
        // ML counts of this recording from before a restart (marker), or null
        this._mlCarry = null;

        // Hide handlers — registered in init(), removed in destroy()
        this._onVisibilityHidden = null;
        this._onScreenOff = null;
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
        //
        // Since KeepAliveWebView (v11.19) the page always reports itself visible,
        // so visibilitychange no longer fires; MainActivity sends the real state as
        // 'flytab:screen' { onScreen }. Without it, a pilot who turned the screen
        // off (or rebooted) inside the 60 s left the recording to be closed out at
        // the next launch, with no Engine ML summary (#188).
        this._onVisibilityHidden = () => {
            if (document.visibilityState === 'hidden') this._onHidden();
        };
        this._onScreenOff = (e) => {
            if (e && e.onScreen === false) this._onHidden();
        };
        document.addEventListener('visibilitychange', this._onVisibilityHidden);
        window.addEventListener('flytab:screen', this._onScreenOff);
    }

    _onHidden() {
        if (!this._recording) return;
        this._flush().catch(() => {});
        // With an engine monitor, also: RPM 0 for a while, not one run-up reading.
        // Readings not moving (EMS serial dead, Pi up): ground speed decides, as
        // without an engine monitor (re-review 2026-10-29).
        const settled = !this._engineReadingsLive() || this._rpmZeroCount >= FlightRecorder.HIDE_STOP_RPM_ZERO_SECONDS;
        if (settled && this._shutdownEvidenceNow()) this.stop();
    }

    destroy() {
        if (this._autoMonitorInterval) clearInterval(this._autoMonitorInterval);
        if (this._trafficInterval) { clearInterval(this._trafficInterval); this._trafficInterval = null; }
        if (this._onVisibilityHidden) {
            document.removeEventListener('visibilitychange', this._onVisibilityHidden);
            this._onVisibilityHidden = null;
        }
        if (this._onScreenOff) {
            window.removeEventListener('flytab:screen', this._onScreenOff);
            this._onScreenOff = null;
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
        this._mlCarry = null;
        this._rpmZeroCount = 0;             // a manual start with the engine off counts from now
        this._eventColumn = true;           // CSV_HEADER below has it
        this._resetMarks(null);
        this._csvBuffer = [FlightRecorder.CSV_HEADER];

        // Generate filename: YYYYMMDD_HHMMZ.csv
        const now = new Date();
        const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hm = now.toISOString().slice(11, 16).replace(':', '');
        this._fileName = `${ymd}_${hm}Z.csv`;
        this._trafficFileName = `${ymd}_${hm}Z_traffic.ndjson`;
        this._trafficBuffer = [];

        this._startIntervals();

        this._emitStatus();
        window.dispatchEvent(new CustomEvent('flightsync:started'));
        // After flightsync:started: engineML has started this flight's log, so the
        // marker's ML counts are this flight's, not the previous one's.
        this._saveMarker();
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
            this._mlCarry = m.ml;
            // The file has the header it was started with: no event column unless the
            // marker says it was written with one.
            this._eventColumn = m.eventColumn;
            this._resetMarks(m.eventColumn ? m.mag : null);
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
            eventColumn: m.eventColumn === true,
            mag: FlightRecorder.MAG_CODES.includes(m.mag) ? m.mag : null,
            ml: FlightRecorder.parseMlCounts(m.ml),
        };
    }

    /**
     * Engine ML counts from the marker, or null. They end up in the logbook
     * entry (and the server), so only known fields, finite counts and plain
     * phase names are kept.
     */
    static parseMlCounts(c) {
        if (!c || typeof c !== 'object') return null;
        const num = (v) => (Number.isFinite(v) && v >= 0) ? v : null;
        const out = {};
        for (const k of FlightRecorder.ML_COUNT_FIELDS) {
            const v = num(c[k]);
            if (v == null) return null;
            out[k] = v;
        }
        if (!(out.samples > 0)) return null;
        out.phases = {};
        if (c.phases && typeof c.phases === 'object') {
            for (const [k, v] of Object.entries(c.phases)) {
                if (/^[A-Za-z_]{1,32}$/.test(k) && num(v) != null) out.phases[k] = v;
            }
        }
        return out;
    }

    /** a + b, either may be null (counts of two parts of one recording). */
    static mergeMlCounts(a, b) {
        if (!a) return b || null;
        if (!b) return a;
        const out = {};
        for (const k of FlightRecorder.ML_COUNT_FIELDS) out[k] = (a[k] || 0) + (b[k] || 0);
        out.phases = { ...a.phases };
        for (const [k, v] of Object.entries(b.phases || {})) out.phases[k] = (out.phases[k] || 0) + v;
        return out;
    }

    /** This recording's ML counts so far: from before a restart + this session's. */
    _mlCountsNow() {
        let now = null;
        try { now = FlightRecorder.parseMlCounts(this.mlCounts?.()); } catch { /* ML not available */ }
        return FlightRecorder.mergeMlCounts(this._mlCarry, now);
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
                // This file's header has the `event` column (markEvent). A marker
                // without it is a recording started by an older FlyTab.
                eventColumn: this._hasEventColumn(),
                // The last mag marked, so the checklist's highlight survives a restart.
                mag: this._currentMag,
                // Fresh evidence the flight is over (engine stopped / aircraft
                // stopped): after a restart this recording is closed out, not resumed.
                shutdown: this._shutdownEvidenceNow(),
                ml: this._mlCountsNow(),
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
        // Marks still held are written by _finishStop (final row); then cleared.
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

        // Marks tapped after the last row: one final row carries them (same width
        // rule as every row). No data to build a row from: they can't be saved.
        if (this._pendingEvents?.length) {
            const n = this._pendingEvents.length;
            if (!(this._hasEventColumn() && this._recordRow({ final: true }))) {
                if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `${n} mark(s) not saved: no data at stop`);
            }
        }
        this._resetMarks(null);

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

        // Closing out a previous run's recording: only what that run saved. This
        // session's ML log belongs to no recording yet.
        const mlCounts = Number.isFinite(endOverride) ? this._mlCarry : this._mlCountsNow();
        this._mlCarry = null;

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
                mlCounts,
                // A previous run's recording closed out at this launch: engineML's
                // log is this session's (it may already be the next flight's), so
                // the logbook must neither save nor clear it for this entry.
                closedOut: Number.isFinite(endOverride),
            }
        }));
        if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Stopped: ${finalName} (${this._rowCount} rows, flushOk=${flushOk})`);
        return finalName;
    }

    /**
     * Mark a moment in the recording (checklist run-up / magneto buttons). The
     * code goes into the `event` column of the NEXT row written -- exactly one
     * row, though the engine data repeats every 2 s; taps before that row are
     * joined with '|' in tap order.
     * Returns { saved, at } (at = when it was tapped, ISO). When saved is false,
     * `reason` says why: 'bad_code' | 'not_recording' | 'old_recording' (a
     * recording resumed from before marks existed has no event column; adding
     * fields to its rows would break the file) | 'no_data' (no fresh engine or
     * GPS data: no row is being written).
     * The row that carries it is the first copy of the next sample, see
     * MARK_FROZEN_ROWS.
     */
    markEvent(code) {
        const at = new Date().toISOString();
        if (typeof code !== 'string' || !FlightRecorder.EVENT_CODES.includes(code)) {
            return { saved: false, at, reason: 'bad_code' };
        }
        if (!this._recording) return { saved: false, at, reason: 'not_recording' };
        if (!this._hasEventColumn()) return { saved: false, at, reason: 'old_recording' };
        // Same test _recordRow uses: with no fresh data no row is written, and the
        // mark would land on the first row after the data returns (or be lost).
        const fresh = this._freshSources();
        if (!fresh.hasGps && !fresh.hasEngine) return { saved: false, at, reason: 'no_data' };
        this._pendingEvents.push(code);
        if (FlightRecorder.MAG_CODES.includes(code)) {
            this._currentMag = code;
            this._saveMarker();             // the highlight survives a restart
        }
        if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Mark ${code} at ${at.slice(11, 19)}Z`);
        return { saved: true, at };
    }

    /** The last magneto mark of this recording ('mag_L' | 'mag_R' | 'mag_BOTH'), or null. */
    currentMag() {
        return this._recording ? this._currentMag : null;
    }

    /** Start a recording's marks: nothing held, `mag` the last mag already marked in it. */
    _resetMarks(mag) {
        this._pendingEvents = [];
        this._currentMag = mag ?? null;
        this._lastSampleTime = null;
        this._sameTimeRows = 0;
    }

    /**
     * Which data sources are fresh enough for _recordRow to write a row. lastData
     * and situation are never nulled on disconnect (to keep gauges showing the
     * last values), so freshness is judged by age.
     */
    _freshSources() {
        const eng = this._engine?.lastData;
        const sit = this._stratux?.situation;
        const sitAge = sit?.timestamp ? (Date.now() - sit.timestamp) : Infinity;
        return {
            hasGps: !!(sit?.lat && sit?.lon && (sit?.gps_fix_quality > 0) && sitAge < 10000),
            hasEngine: !!eng && (this._engine?.dataAge < 10000),
        };
    }

    /** False only for a recording resumed from a file that has no `event` column. */
    _hasEventColumn() {
        return this._eventColumn !== false;
    }

    /**
     * Build one CSV row from current engine + GPS state. Returns true if a row
     * was written. `final` (from _finishStop): to carry held marks, so no gap
     * timer, and the marks are written whatever the sample time.
     */
    _recordRow({ final = false } = {}) {
        const eng = this._engine?.lastData;
        const sit = this._stratux?.situation;
        const d = eng?.data || {};

        // Require at least a GPS fix or engine data to write a row.
        // Use freshness checks — lastData and situation are never nulled on disconnect
        // (by design, to keep gauges showing last-known values). Stale cached data
        // must not prevent the gap timer from firing during a fuel stop.
        const { hasGps, hasEngine } = this._freshSources();
        if (!hasGps && !hasEngine) {
            if (final) return false;
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
            return false;
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
        ];
        // Same field count as this file's header, always. The marks are known codes
        // (no commas), so they go in unquoted like every other field.
        // Marks wait for the first row of a new sample time (see MARK_FROZEN_ROWS).
        const sameTime = time12 === this._lastSampleTime;
        this._sameTimeRows = sameTime ? (this._sameTimeRows || 0) + 1 : 0;
        this._lastSampleTime = time12;
        if (this._hasEventColumn()) {
            const due = final || time12 === '' || !sameTime || this._sameTimeRows >= FlightRecorder.MARK_FROZEN_ROWS;
            if (this._pendingEvents?.length && due) {
                row.push(this._pendingEvents.join('|'));
                this._pendingEvents = [];
            } else {
                row.push('');
            }
        }

        this._csvBuffer.push(row.join(','));
        this._rowCount++;
        return true;
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
        if (eng && this._engineReadingsLive()) {
            const rpm = eng.data?.RPM;
            return typeof rpm === 'number' && rpm <= stopThreshold;
        }
        const sit = this._stratux?.situation;
        const sitAge = typeof sit?.timestamp === 'number' ? Date.now() - sit.timestamp : Infinity;
        return sitAge < FlightRecorder.FRESH_DATA_MS && typeof sit?.ground_speed === 'number' && sit.ground_speed < 10;
    }

    /** An engine monitor whose readings are moving (fresh within FRESH_DATA_MS). */
    _engineReadingsLive() {
        return !!this._engine?.lastData && this._engineReadingAge() < FlightRecorder.FRESH_DATA_MS;
    }

    /** Age of the newest engine reading, ms (EngineClient.readingAge; dataAge from older clients). */
    _engineReadingAge() {
        const e = this._engine;
        return e?.readingAge ?? e?.dataAge ?? Infinity;
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
            // Auto-start goes by FRESH engine readings only. lastData keeps the last
            // reading when the engine monitor goes quiet: 10-27 the Pi lost power with
            // its last sample at 890 RPM, and every 130 s (10 s start + the 2-min
            // data-gap stop) a new, empty recording and logbook entry began. With no
            // fresh engine data, ground speed decides, as in a session without one.
            // "Fresh" = the readings are moving, not just the Pi answering: with the
            // EMS serial line dead the Pi still sends its last reading every second,
            // so a flight read RPM 0 and was never recorded (review 2026-10-29).
            const engFresh = hasEngine && this._engineReadingAge() < FlightRecorder.FRESH_DATA_MS;
            if (engFresh) {
                this._gsAboveCount = 0;
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
                this._rpmAboveCount = 0;
                // GPS-based auto-start: GS > 30kt for 10s. Not on the home Stratux:
                // brought home to diagnose a problem, its GPS can report 80-300 kt
                // standing still (10-18: five bench "flights" in the logbook).
                if (this._onHomeStratux()) {
                    this._gsAboveCount = 0;
                    if (!this._homeLogged && typeof DiagLog !== 'undefined') {
                        DiagLog.log('recorder', `Not recording: connected to the home Stratux (${this._stratux?.ip}) — MORE → Configuration`);
                    }
                    this._homeLogged = true;
                } else if (sitFresh && gs > 30) {
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
            // RPM decides only while the readings are moving: frozen at cruise RPM
            // (EMS serial line lost, Pi up) the recording never stopped after
            // landing. Otherwise ground speed decides, as without an engine monitor.
            if (hasEngine && this._engineReadingAge() < FlightRecorder.FRESH_DATA_MS) {
                this._gsBelowCount = 0;
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
                this._rpmZeroCount = 0;
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

    /**
     * Connected to the home Stratux (Settings.homeStratuxIp) with "Don't record
     * on the home Stratux" on: the configured Stratux is that address and its
     * data is arriving. Only the GPS start asks: fresh RPM >= 500 always starts a
     * recording, and on a forgotten home address in flight nothing arrives from
     * it, so the engine (or nothing) decides as usual.
     */
    _onHomeStratux() {
        if (typeof Settings === 'undefined' || !Settings.homeStratuxNoRecord) { this._homeLogged = false; return false; }
        const home = String(Settings.homeStratuxIp ?? '').trim();
        const sit = this._stratux?.situation;
        const fresh = typeof sit?.timestamp === 'number' && (Date.now() - sit.timestamp) < FlightRecorder.FRESH_DATA_MS;
        // Only with "Use the home Stratux" on: a Home Stratux IP equal to the
        // Stratux IP (192.168.10.1) blocked every GPS-started flight (review 10-29).
        const on = !!home && this._stratux?.homeMode === 'home' && String(this._stratux?.ip ?? '').trim() === home && fresh;
        if (!on) this._homeLogged = false;
        return on;
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
