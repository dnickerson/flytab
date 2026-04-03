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

        // Auto-start/stop counters
        this._rpmAboveCount = 0;
        this._rpmZeroCount = 0;
        this._gsAboveCount = 0;
        this._gsBelowCount = 0;
        this._autoMonitorInterval = null;

        // First/last GPS for dep/dest naming
        this._firstGps = null;
        this._lastGps = null;

        // Status callback
        this.onStatusChange = null;
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
    }

    destroy() {
        if (this._autoMonitorInterval) clearInterval(this._autoMonitorInterval);
        if (this._recording) this.stop();
    }

    /** Manual start */
    async start() {
        if (this._recording) return;
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

        // Record at 1Hz
        this._recordInterval = setInterval(() => this._recordRow(), 1000);
        // Flush to disk every 5 seconds (reduces worst-case data loss on crash)
        this._flushInterval = setInterval(() => this._flush(), 5000);

        this._emitStatus();
        window.dispatchEvent(new CustomEvent('flightsync:started'));
        if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Started: ${this._fileName}`);
    }

    /** Manual stop */
    async stop() {
        if (!this._recording) return;
        this._recording = false;

        if (this._recordInterval) { clearInterval(this._recordInterval); this._recordInterval = null; }
        if (this._flushInterval) { clearInterval(this._flushInterval); this._flushInterval = null; }

        const startTime = this._startTime ? new Date(this._startTime).toISOString() : null;
        const endMs = Date.now();
        const endTime = new Date(endMs).toISOString();
        const durationHours = this._startTime
            ? Math.round((endMs - this._startTime) / 36000) / 100
            : 0;

        // Final flush — track success so downstream listeners know if data was saved
        let flushOk = true;
        try {
            await this._flush();
        } catch (err) {
            flushOk = false;
            if (typeof DiagLog !== 'undefined') DiagLog.log('error', `FlightRecorder final flush failed: ${err.message}`);
        }

        // Try to rename with dep/dest from NASR — returns { depIcao, destIcao } or null
        const route = await this._renameWithRoute();

        const finalName = this._fileName;
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

        // Require at least a GPS fix or engine data to write a row
        const hasGps = sit?.lat && sit?.lon && (sit?.gps_fix_quality > 0);
        const hasEngine = !!eng;
        if (!hasGps && !hasEngine) return;

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
            rpm, d.Fuel_Flow||0, d.Fuel_Remaining||0,
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

    /** Flush buffered rows to NanoHTTPD filesystem */
    async _flush() {
        if (this._csvBuffer.length === 0) return;

        const content = this._csvBuffer.join('\n') + '\n';
        this._csvBuffer = [];

        const path = `${FlightRecorder.FLIGHTS_PATH}/${this._fileName}`;
        try {
            const resp = await fetch(`${FlightRecorder.LOCAL_BASE}/${path}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'text/csv', 'X-Append': 'true' },
                body: content,
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        } catch (err) {
            // Re-buffer on failure so data isn't lost
            this._csvBuffer.unshift(content.trim());
            if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Flush failed: ${err.message}`);
        }
    }

    /**
     * Rename file with departure/destination airports using NASR lookup.
     * Returns { depIcao, destIcao } if successful, null otherwise.
     */
    async _renameWithRoute() {
        if (!this._nasrDb || !this._firstGps || !this._lastGps) return null;

        try {
            const dep = await this._nearestAirport(this._firstGps.lat, this._firstGps.lon);
            const dest = await this._nearestAirport(this._lastGps.lat, this._lastGps.lon);
            if (!dep || !dest) return null;

            const ymd = this._fileName.split('_')[0];
            const newName = `${ymd}_${dep}-${dest}.csv`;

            // Rename by reading + writing + deleting old
            const oldPath = `${FlightRecorder.FLIGHTS_PATH}/${this._fileName}`;
            const newPath = `${FlightRecorder.FLIGHTS_PATH}/${newName}`;

            const readResp = await fetch(`${FlightRecorder.LOCAL_BASE}/${oldPath}`);
            if (!readResp.ok) return null;
            const data = await readResp.text();

            await fetch(`${FlightRecorder.LOCAL_BASE}/${newPath}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'text/csv' },
                body: data,
            });

            // Delete old file
            await fetch(`${FlightRecorder.LOCAL_BASE}/${oldPath}`, { method: 'DELETE' });

            this._fileName = newName;
            if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Renamed to ${newName}`);
            return { depIcao: dep, destIcao: dest };
        } catch (err) {
            if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Rename failed: ${err.message}`);
            return null;
        }
    }

    async _nearestAirport(lat, lon) {
        if (!this._nasrDb) return null;
        try {
            const nearby = await this._nasrDb.getAirportsNear(lat, lon, 10);
            if (!nearby || nearby.length === 0) return null;
            nearby.sort((a, b) =>
                NasrDB.haversineNm(lat, lon, a.lat, a.lon) -
                NasrDB.haversineNm(lat, lon, b.lat, b.lon)
            );
            return nearby[0].icao || nearby[0].id || null;
        } catch { /* NASR not available */ }
        return null;
    }

    /** Auto-start/stop based on RPM (engine data) or groundspeed (GPS-only) */
    _autoMonitor() {
        const eng = this._engine?.lastData;
        const sit = this._stratux?.situation;
        const rpm = eng?.data?.RPM || 0;
        const gs = sit?.ground_speed || 0;

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
                        this._rpmAboveCount = 0;
                    }
                } else {
                    this._rpmAboveCount = 0;
                }
            } else {
                // GPS-based auto-start: GS > 30kt for 10s
                if (gs > 30) {
                    this._gsAboveCount++;
                    if (this._gsAboveCount >= 10) {
                        this.start();
                        this._gsAboveCount = 0;
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
                if (gs < 10) {
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
