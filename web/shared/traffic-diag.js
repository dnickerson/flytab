'use strict';
// TrafficDiag — per-flight ADS-B traffic diagnostic log.
// Mirrors the FlightRecorder pattern: buffers rows in memory, flushes to
// NanoHTTPD (localhost:9090) every 5 s via HTTP PUT + X-Append.
//
// File: flights/<flight_base>_traffic.csv  (same name as engine CSV, _traffic suffix)
// Auto-start: flightsync:started event   Auto-stop: flightsync:stopped event
//
// Console API (during or after flight):
//   TrafficDiag.status()   — is it recording, filename, buffer size
const TrafficDiag = (() => {
    const LOCAL_BASE    = 'http://localhost:9090';
    const FLIGHTS_PATH  = 'flights';
    const HEADER        = 'time,type,ws_traffic,ws_sit,connected,total,stale,no_pos,alt_filt,shown,own_alt,own_fix,own_sats,band_above,band_below,event\n';
    const WS            = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];

    let _fileName      = null;
    let _buffer        = [];
    let _flushInterval = null;

    function _row(e) {
        if (e.tp === 's') {
            return [
                e.t, 'snap',
                WS[e.ws]     ?? e.ws,
                WS[e.sit_ws] ?? e.sit_ws,
                e.conn ? 1 : 0,
                e.total, e.stale, e.no_pos, e.alt_filt, e.shown,
                e.own_alt  ?? '', e.own_fix  ?? '', e.own_sats ?? '',
                e.band_above, e.band_below,
                '',
            ].join(',');
        }
        // ws event — leave numeric columns blank
        return [e.t, 'ws', '', '', '', '', '', '', '', '', '', '', '', '', '', e.ev].join(',');
    }

    async function _flush() {
        if (!_fileName || !_buffer.length) return;
        const rows = _buffer.splice(0);          // drain atomically
        const body = rows.map(_row).join('\n') + '\n';
        try {
            const resp = await fetch(`${LOCAL_BASE}/${FLIGHTS_PATH}/${_fileName}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'text/csv', 'X-Append': 'true' },
                body,
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        } catch {
            // Re-buffer on failure so rows aren't lost
            _buffer.unshift(...rows);
        }
    }

    function _start(flightCsvName) {
        // Guard against double-start (e.g. app restart mid-flight)
        if (_flushInterval) { clearInterval(_flushInterval); _flushInterval = null; }

        // Derive traffic filename: 20260417_KLKR-KLKR.csv → 20260417_KLKR-KLKR_traffic.csv
        _fileName = flightCsvName.replace(/\.csv$/i, '_traffic.csv');
        _buffer   = [];

        // Write header as first PUT (no X-Append — creates / truncates file)
        fetch(`${LOCAL_BASE}/${FLIGHTS_PATH}/${_fileName}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'text/csv' },
            body:    HEADER,
        }).catch(() => {});

        _flushInterval = setInterval(_flush, 5000);
        if (typeof DiagLog !== 'undefined') DiagLog.log('traffic-diag', `Recording → ${_fileName}`);
    }

    // ---- tie to flight recorder lifecycle ----

    // flightsync:started carries no filename — generate one from current time,
    // same format as FlightRecorder so the two CSVs sort together.
    window.addEventListener('flightsync:started', () => {
        const now = new Date();
        const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hm  = now.toISOString().slice(11, 16).replace(':', '');
        _start(`${ymd}_${hm}Z.csv`);
    });

    // flightsync:stopped detail includes the final renamed filename (e.g. 20260417_KLKR-KLKR.csv).
    // Flush remaining rows, then rename our file to match so the pair stays together.
    window.addEventListener('flightsync:stopped', async (e) => {
        if (_flushInterval) { clearInterval(_flushInterval); _flushInterval = null; }
        await _flush();
        if (typeof DiagLog !== 'undefined') DiagLog.log('traffic-diag', `Stopped: ${_fileName}`);

        const finalFlight = e.detail?.csvFilename;
        if (finalFlight && _fileName) {
            const newName = finalFlight.replace(/\.csv$/i, '_traffic.csv');
            if (newName !== _fileName) {
                try {
                    const oldPath = `${FLIGHTS_PATH}/${_fileName}`;
                    const newPath = `${FLIGHTS_PATH}/${newName}`;
                    const r = await fetch(`${LOCAL_BASE}/${oldPath}`);
                    if (r.ok) {
                        const data = await r.text();
                        await fetch(`${LOCAL_BASE}/${newPath}`, {
                            method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: data,
                        });
                        await fetch(`${LOCAL_BASE}/${oldPath}`, { method: 'DELETE' });
                        if (typeof DiagLog !== 'undefined') DiagLog.log('traffic-diag', `Renamed → ${newName}`);
                    }
                } catch { /* rename is best-effort */ }
            }
        }
        _fileName = null;
    });

    return {
        snapshot(d) {
            if (!_fileName) return;
            _buffer.push({ tp: 's', t: new Date().toISOString(), ...d });
        },

        wsEvent(event) {
            if (!_fileName) return;
            _buffer.push({ tp: 'ws', t: new Date().toISOString(), ev: event });
        },

        status() {
            console.log({ recording: !!_fileName, file: _fileName, buffered: _buffer.length });
        },
    };
})();

window.TrafficDiag = TrafficDiag;
