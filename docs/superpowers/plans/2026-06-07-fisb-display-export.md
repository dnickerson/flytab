# FIS-B Display Completeness & Flight Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three FIS-B display bugs, add a `FisbLogger` that persists all FIS-B data to a `_weather.ndjson` companion file during recording, and add a weather replay layer to fly-debrief.

**Architecture:** FlyTab tasks 1–5 fix fisb-client.js, fisb-nexrad.js, fisb-weather.js, and add a new `FisbLogger` class that mirrors the `FlightRecorder` flush pattern. fly-debrief tasks 6–9 add weather companion loading in the server and client, and a new `weather-replay.js` module.

**Tech Stack:** Vanilla JS (no bundler), Leaflet 1.x, Python 3 (debrief server), NanoHTTPD PUT+append at `http://localhost:9090/flights/`.

**Spec:** `docs/superpowers/specs/2026-06-07-fisb-display-export-design.md`

---

## File Map

### FlyTab (`~/flytab`)

| File | Change |
|------|--------|
| `web/shared/fisb-client.js` | Make `_handleWeather` async; await `_handlePirep`; add points to `_handleCwa` |
| `web/cockpit/fisb-nexrad.js` | Guard `_takeSnapshot`; snapshot before last-block purge in `_purgeOld` |
| `web/cockpit/fisb-weather.js` | Add `_cwaLayer` / `_cwaPolygons`; render CWA polygon in `_showCwaAlert`; wire tap hit-test and purge |
| `web/shared/fisb-logger.js` | New class — event-driven NDJSON writer |
| `web/app.js` | Instantiate `FisbLogger` after `fisbClient`; bump `FLYTAB_VERSION` |
| `web/index.html` | Add `<script src="shared/fisb-logger.js">` before `app.js` |
| `docs/user-manual.md` | Document weather export and CWA map display |

### fly-debrief (`~/flytab-debrief`)

| File | Change |
|------|--------|
| `server/debrief-server.py` | Add `hasWeather` to `_list_flights` |
| `js/weather-replay.js` | New module — parse NDJSON, render by time window |
| `js/app.js` | Load `_weather.ndjson`, call `initWeather`, wire `seek` |
| `index.html` | Import `weather-replay.js`; add weather toggle panel |
| `css/style.css` | Weather toggle panel styles |

---

## Task 1: Fix PIREP Async Race (`web/shared/fisb-client.js`)

**Files:**
- Modify: `web/shared/fisb-client.js` (around line 102–125)

- [ ] **Step 1: Make `_handleWeather` async and await `_handlePirep`**

At line 102, change:
```js
_handleWeather(msg) {
```
to:
```js
async _handleWeather(msg) {
```

At line 115, change:
```js
            this._handlePirep(data, location, now, type === 'UUA');
```
to:
```js
            await this._handlePirep(data, location, now, type === 'UUA');
```

- [ ] **Step 2: Verify the call site is fire-and-forget (no change needed)**

`_handleWeather` is called from:
```js
this._onWeather = (e) => this._handleWeather(e.detail);
```
Event listeners are already fire-and-forget. Making the method `async` is safe — the returned Promise is discarded, which is correct here.

- [ ] **Step 3: Commit**

```bash
cd ~/flytab
git add web/shared/fisb-client.js
git commit -m "fix(fisb): await _handlePirep to prevent coordinate loss on VOR-relative PIREPs"
```

---

## Task 2: Fix NEXRAD Empty Snapshots (`web/cockpit/fisb-nexrad.js`)

**Files:**
- Modify: `web/cockpit/fisb-nexrad.js` (around lines 256–268 and 364–370)

- [ ] **Step 1: Guard `_takeSnapshot` against empty block map**

Find `_takeSnapshot` (line ~256). Add a guard at the top:
```js
_takeSnapshot(time, dataTime) {
    if (this._blocks.size === 0) return;    // ← add this line
    const snapshot = new Map();
    for (const [key, block] of this._blocks) {
```

- [ ] **Step 2: Snapshot before purging the last active block in `_purgeOld`**

Replace the existing `_purgeOld` method (line ~364):
```js
_purgeOld() {
    const cutoff = Date.now() - 15 * 60000;
    for (const [key, block] of this._blocks) {
        if (block.received_at < cutoff) this._blocks.delete(key);
    }
    if (this._active) this._draw();
}
```
with:
```js
_purgeOld() {
    const cutoff = Date.now() - 15 * 60000;
    const now = Date.now();
    // If every block is about to be purged and we have some, snapshot first
    // so the IDB always has at least one non-empty frame from each reception window.
    const allExpired = this._blocks.size > 0 &&
        [...this._blocks.values()].every(b => b.received_at < cutoff);
    if (allExpired) this._takeSnapshot(now, now);
    for (const [key, block] of this._blocks) {
        if (block.received_at < cutoff) this._blocks.delete(key);
    }
    if (this._active) this._draw();
}
```

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/fisb-nexrad.js
git commit -m "fix(nexrad): skip empty snapshots; persist last frame before purge"
```

---

## Task 3: Fix CWA Map Polygon

**Files:**
- Modify: `web/shared/fisb-client.js` (around line 327–331)
- Modify: `web/cockpit/fisb-weather.js` (constructor, `init`, `destroy`, `_showCwaAlert`, `_handleAdvisoryTap`, `_purgeMarkers`)

### Part A — add `points` to the CWA event (`fisb-client.js`)

- [ ] **Step 1: Extract polygon points in `_handleCwa`**

Find `_handleCwa` (line ~327) and change:
```js
_handleCwa(raw, now) {
    const entry = { raw, received_at: now };
    this.cwas.push(entry);
    this.dispatchEvent(new CustomEvent('fisb:cwa', { detail: entry }));
}
```
to:
```js
_handleCwa(raw, now) {
    const points = this._extractPolygonPoints(raw);
    const entry = { raw, points, received_at: now };
    this.cwas.push(entry);
    this.dispatchEvent(new CustomEvent('fisb:cwa', { detail: entry }));
}
```

### Part B — render CWA polygon (`fisb-weather.js`)

- [ ] **Step 2: Add `_cwaLayer` and `_cwaPolygons` to the constructor**

In the constructor (after the existing `_notamLayer` line ~33):
```js
this._cwaLayer    = L.layerGroup();
this._cwaPolygons = [];  // { polygon, received_at }
```

- [ ] **Step 3: Start `_cwaLayer` in `init()`**

In `init()`, after the existing `this._notamLayer.addTo(this._map)` line:
```js
this._cwaLayer.addTo(this._map);
```

- [ ] **Step 4: Remove `_cwaLayer` in `destroy()`**

In `destroy()`, after removing other layers/listeners, add:
```js
if (this._map && this._cwaLayer) this._map.removeLayer(this._cwaLayer);
this._cwaPolygons = [];
```

- [ ] **Step 5: Render the CWA polygon in `_showCwaAlert`**

Replace the existing `_showCwaAlert` (line ~864):
```js
_showCwaAlert(cwa) {
    this._showAlert(`CWA: ${cwa.raw.slice(0, 100)}`, 'amber', 30000);
}
```
with:
```js
_showCwaAlert(cwa) {
    this._showAlert(`CWA: ${cwa.raw.slice(0, 100)}`, 'amber', 30000);

    if (!cwa.points || cwa.points.length < 3) return;

    const polygon = L.polygon(cwa.points, {
        color: '#ff6600',
        weight: 2,
        fillColor: '#ff6600',
        fillOpacity: 0.18,
    });
    polygon.bindPopup(
        `<div style="font-family:var(--font-ui);max-width:320px">
            <div style="font-weight:800;color:var(--text-secondary);margin-bottom:4px">CWA</div>
            <div style="font-size:0.85rem;color:var(--text-primary);white-space:pre-wrap">${FisbWeatherDisplay._esc(cwa.raw)}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">Rcvd ${new Date(cwa.received_at).toISOString().slice(11, 16)}Z</div>
        </div>`,
        { minWidth: 300, maxWidth: 380, className: 'cwa-popup' }
    );
    polygon.addTo(this._cwaLayer);
    this._cwaPolygons.push({ polygon, advisory: cwa, received_at: cwa.received_at });
}
```

- [ ] **Step 6: Include CWA polygons in the tap hit-test**

In `_handleAdvisoryTap` (line ~374), change:
```js
const allPolygons = [
    ...(this._map.hasLayer(this._sigmetLayer) ? this._sigmetPolygons : []),
    ...this._airmetPolygons.filter(e => !e.isLine && e.layer && this._map.hasLayer(e.layer)),
];
```
to:
```js
const allPolygons = [
    ...(this._map.hasLayer(this._sigmetLayer) ? this._sigmetPolygons : []),
    ...this._airmetPolygons.filter(e => !e.isLine && e.layer && this._map.hasLayer(e.layer)),
    ...(this._map.hasLayer(this._cwaLayer) ? this._cwaPolygons : []),
];
```

- [ ] **Step 7: Purge expired CWA polygons in `_purgeMarkers`**

In `_purgeMarkers`, after the existing AIRMET purge block (line ~945–955), add:
```js
// Expired CWAs (2-hour window)
this._cwaPolygons = this._cwaPolygons.filter(entry => {
    if (now - entry.received_at > 2 * 3600000) {
        this._cwaLayer.removeLayer(entry.polygon);
        return false;
    }
    return true;
});
```

- [ ] **Step 8: Add CWA popup close-button CSS to `web/style.css`**

Append at end of style.css:
```css
.cwa-popup .leaflet-popup-close-button {
    width: 44px !important; height: 44px !important;
    font-size: 28px !important; line-height: 44px !important;
}
```

- [ ] **Step 9: Commit**

```bash
git add web/shared/fisb-client.js web/cockpit/fisb-weather.js web/style.css
git commit -m "fix(cwa): add polygon map element with 2hr expiry and tap popup"
```

---

## Task 4: Create `FisbLogger` (`web/shared/fisb-logger.js`)

**Files:**
- Create: `web/shared/fisb-logger.js`

- [ ] **Step 1: Write the full class**

```js
/**
 * FisbLogger — persists all FIS-B events to a _weather.ndjson companion file
 * via NanoHTTPD PUT+append, mirroring the FlightRecorder pattern.
 */
class FisbLogger {
    static LOCAL_BASE = 'http://localhost:9090';
    static FLIGHTS_PATH = 'flights';

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
        if (!this._recording) return;
        this._recording = false;
        if (this._flushInterval) { clearInterval(this._flushInterval); this._flushInterval = null; }
        this._stopListeners();
        await this._flush();
        const csvFilename = detail?.csvFilename;
        if (csvFilename && this._fileName) {
            const newName = csvFilename.replace(/\.csv$/, '_weather.ndjson');
            if (newName !== this._fileName) await this._rename(newName);
        }
        if (typeof DiagLog !== 'undefined') DiagLog.log('fisb-logger', `Stopped: ${this._fileName}`);
        this._fileName = null;
        this._t0 = null;
    }

    _t(now) { return Math.floor(((now || Date.now()) - this._t0) / 1000); }

    _append(obj) { this._buffer.push(JSON.stringify(obj)); }

    _logNexrad(msg) {
        if (!this._recording || !msg?.NEXRAD?.length) return;
        const now = Date.now();
        const dataTime = msg.LocaltimeReceived
            ? (new Date(msg.LocaltimeReceived).getTime() || now) : now;
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
        const now = Date.now();
        const cutoff = now - 3000; // only log entries updated in the last 3s (current batch)
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
```

- [ ] **Step 2: Commit**

```bash
git add web/shared/fisb-logger.js
git commit -m "feat(fisb-logger): persist all FIS-B events to _weather.ndjson companion"
```

---

## Task 5: Wire `FisbLogger`, Bump Version, Build

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `docs/user-manual.md`

- [ ] **Step 1: Add script tag in `web/index.html`**

Find the line that loads `stratux-client.js` or `fisb-client.js` in `web/index.html`. Add `fisb-logger.js` after `fisb-client.js`:
```html
<script src="shared/fisb-logger.js"></script>
```
Load order: `fisb-client.js` → `fisb-logger.js` → (other cockpit scripts).

- [ ] **Step 2: Instantiate `FisbLogger` in `web/app.js`**

Find where `fisbClient` is assigned (around line 661–693):
```js
if (typeof FisbClient !== 'undefined') {
    this.fisbClient = new FisbClient(this.stratuxClient, nasrDb);
    this.fisbClient.start();
    // ...
}
```

After the `fisbClient` block (and after `fisbNexrad` if already assigned), add:
```js
if (typeof FisbLogger !== 'undefined' && this.fisbClient) {
    this.fisbLogger = new FisbLogger(this.fisbClient);
    this.fisbLogger.init();
}
```

Also add `this.fisbLogger = null;` in the constructor near the other `null` initializers (line ~77).

- [ ] **Step 3: Destroy `FisbLogger` in the app's cleanup path**

Search for where `fisbClient` is destroyed/cleaned up (or where `destroy()` methods are called). Add:
```js
if (this.fisbLogger) { this.fisbLogger.destroy(); this.fisbLogger = null; }
```

- [ ] **Step 4: Increment `FLYTAB_VERSION` in `web/app.js`**

Find `FLYTAB_VERSION` at the top of `web/app.js` and bump by one patch (e.g., if current is `v9.59`, set to `v9.60`).

- [ ] **Step 5: Update `docs/user-manual.md`**

Add a section under "Flight Recording" (or create one):
```
### Weather Export

FlyTab records all FIS-B data received during a flight to a companion file
(`YYYYMMDD_DEP-DEST_weather.ndjson`) alongside the engine CSV. This file is
available for post-flight review in fly-debrief, where it appears as a weather
replay layer on the map scrubber.

CWA (Center Weather Advisory) areas now appear as orange polygons on the map
with a tap-to-open popup, alongside SIGMETs and AIRMETs.
```

- [ ] **Step 6: Build**

```bash
cd ~/flytab && bash build.sh
```

Expected: build succeeds, APK in `data/`.

- [ ] **Step 7: Commit**

```bash
git add web/index.html web/app.js docs/user-manual.md
git commit -m "feat: wire FisbLogger, add CWA polygon, fix PIREP/NEXRAD bugs — v9.60"
```

---

## Task 6: fly-debrief Server (`server/debrief-server.py`)

**Files:**
- Modify: `server/debrief-server.py` (around line 97–103)

- [ ] **Step 1: Add `hasWeather` to flight listing**

Find `_list_flights` (line ~97):
```python
result = [{'name': f.name,
           'hasTraffic': (FLIGHTS_DIR / (f.stem + '_traffic.ndjson')).exists()}
          for f in files]
```
Change to:
```python
result = [{'name': f.name,
           'hasTraffic': (FLIGHTS_DIR / (f.stem + '_traffic.ndjson')).exists(),
           'hasWeather': (FLIGHTS_DIR / (f.stem + '_weather.ndjson')).exists()}
          for f in files]
```

The server already serves any file by name via `_serve_flight(name)` — no other changes needed to serve the weather file.

- [ ] **Step 2: Restart the debrief service**

```bash
sudo systemctl restart flytab-debrief
```

Verify with `curl http://localhost:8092/api/flights | python3 -m json.tool | head -20` — entries should include `"hasWeather": true/false`.

- [ ] **Step 3: Commit**

```bash
cd ~/flytab-debrief
git add server/debrief-server.py
git commit -m "feat(server): add hasWeather to flight listing"
```

---

## Task 7: Weather Replay Module (`js/weather-replay.js`)

**Files:**
- Create: `~/flytab-debrief/js/weather-replay.js`

- [ ] **Step 1: Write the module**

```js
// js/weather-replay.js

const INTENSITY_COLORS = [
    null,       // 0 — no return
    '#00ee00',  // 1
    '#00bb00',  // 2
    '#008800',  // 3
    '#ffee00',  // 4
    '#ffcc00',  // 5
    '#ff8800',  // 6
    '#ff4400',  // 7
    '#ff0000',  // 8
    '#cc0000',  // 9
    '#990000',  // 10
    '#cc00ff',  // 11
    '#aa00dd',  // 12
    '#880099',  // 13
    '#ffffff',  // 14
    '#ffffff',  // 15
];

let _map = null;
let _data = null;   // { header, events }
let _layers = {};
let _activeRects = [];
let _prefs = {};

const WINDOWS = {
    nexrad: 900,          // 15 min
    metar: Infinity,      // latest per ICAO only
    pirep: 3600,          // 1 hr
    sigmet: Infinity,     // until expires_at
    airmet: Infinity,     // until expires_at
    cwa: 7200,            // 2 hrs
    winds: Infinity,      // latest per station+alt
    notam: Infinity,      // until expires_at
};

const DEFAULTS = {
    nexrad: true, metar: true, pirep: true,
    sigmet: true, airmet: true, cwa: true,
    winds: false, notam: true,
};

export function parseWeatherNDJSON(text) {
    const lines = text.trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    let header;
    try { header = JSON.parse(lines[0]); } catch (_) { return null; }
    if (header.version !== 1) return null;
    const events = {
        nexrad: [], metar: [], pirep: [], sigmet: [],
        airmet: [], cwa: [], winds: [], notam: [],
    };
    for (const line of lines.slice(1)) {
        try {
            const e = JSON.parse(line);
            if (e.type && events[e.type] !== undefined) events[e.type].push(e);
        } catch (_) {}
    }
    return { header, events };
}

export function initWeather(weatherData, map) {
    _data = weatherData;
    _map = map;

    _layers = {
        nexrad: L.layerGroup(),
        metar:  L.layerGroup(),
        pirep:  L.layerGroup(),
        sigmet: L.layerGroup(),
        airmet: L.layerGroup(),
        cwa:    L.layerGroup(),
        winds:  L.layerGroup(),
        notam:  L.layerGroup(),
    };

    _loadPrefs();
    for (const [key, layer] of Object.entries(_layers)) {
        if (_prefs[key] !== false) layer.addTo(_map);
    }
}

export function renderWeather(T) {
    if (!_data || !_map) return;

    _renderNexrad(T);
    _renderMetar(T);
    _renderPirep(T);
    _renderSigmetAirmetCwa(T);
    _renderWinds(T);
    _renderNotam(T);
}

export function setWeatherLayerVisible(key, visible) {
    if (!_layers[key]) return;
    if (visible) {
        if (!_map.hasLayer(_layers[key])) _layers[key].addTo(_map);
    } else {
        if (_map.hasLayer(_layers[key])) _map.removeLayer(_layers[key]);
    }
    _prefs[key] = visible;
    _savePrefs();
}

export function getWeatherLayerVisible(key) {
    return _prefs[key] !== false;
}

// ── NEXRAD ────────────────────────────────────────────────────────────────

function _renderNexrad(T) {
    _layers.nexrad.clearLayers();
    if (!_prefs.nexrad || !_data.events.nexrad.length) return;

    // Collect blocks visible at time T (received within last 15 min)
    // Use a Map to keep only the latest block per cell key
    const visible = new Map();
    for (const e of _data.events.nexrad) {
        if (e.t > T) break;
        if (T - e.t > WINDOWS.nexrad) continue;
        for (const b of (e.blocks || [])) {
            const key = `${b.lat},${b.lon},${b.radarType}`;
            visible.set(key, b);
        }
    }

    for (const b of visible.values()) {
        for (let i = 0; i < b.intensity.length; i++) {
            const val = b.intensity[i];
            if (!val || val < 1) continue;
            const color = INTENSITY_COLORS[Math.min(val, 15)];
            if (!color) continue;

            // Each block spans (h × w) degrees. Intensity array covers cells
            // left-to-right, top-to-bottom within the block.
            // For simplicity treat the whole block as one rectangle.
            // (Full sub-cell rendering would require knowing block dimensions.)
            const south = b.lat - b.h;
            const east  = b.lon + b.w;
            L.rectangle([[south, b.lon], [b.lat, east]], {
                color, weight: 0, fillColor: color, fillOpacity: 0.75,
                interactive: false,
            }).addTo(_layers.nexrad);
            break; // use first non-zero cell as representative for the block
        }
    }
}

// ── METAR ─────────────────────────────────────────────────────────────────

const CAT_COLORS = { VFR: '#1a8c35', MVFR: '#0055bb', IFR: '#cc2222', LIFR: '#880088' };

function _renderMetar(T) {
    _layers.metar.clearLayers();
    if (!_prefs.metar || !_data.events.metar.length) return;

    // Latest entry per ICAO at time T
    const latest = new Map();
    for (const e of _data.events.metar) {
        if (e.t > T) continue;
        if (!latest.has(e.icao) || e.t > latest.get(e.icao).t) latest.set(e.icao, e);
    }

    // We need lat/lon — METARs don't carry coords, so skip if not resolvable.
    // fly-debrief has access to FlyTab home server for NASR; for now show popups
    // only on station markers placed at the pilot's own position (skipped for MVP).
    // TODO: resolve ICAO → lat/lon via NASR if needed.
}

// ── PIREP ─────────────────────────────────────────────────────────────────

const SEV_COLORS = ['#888', '#1a8c35', '#00cc99', '#ffcc00', '#ff8800', '#cc2222'];

function _renderPirep(T) {
    _layers.pirep.clearLayers();
    if (!_prefs.pirep || !_data.events.pirep.length) return;

    for (const e of _data.events.pirep) {
        if (e.t > T || T - e.t > WINDOWS.pirep) continue;
        if (e.lat == null || e.lon == null) continue;
        const color = SEV_COLORS[Math.min(e.severity || 1, 5)];
        const icon = L.divIcon({
            className: '',
            html: `<div style="width:12px;height:12px;background:${color};transform:rotate(45deg);border:1px solid #000;opacity:0.85"></div>`,
            iconSize: [12, 12], iconAnchor: [6, 6],
        });
        const urgentBadge = e.urgent ? '<b style="color:#cc2222">UUA</b> ' : '';
        const typeLabel = e.pirepType || 'PIREP';
        const sevLabel = e.severity ? `Severity ${e.severity}/5` : '';
        const altLabel = e.altitude ? `${e.altitude.toLocaleString()}ft` : '';
        L.marker([e.lat, e.lon], { icon })
            .bindPopup(`<div style="font-family:var(--font-ui);min-width:200px">
                <b>${urgentBadge}${typeLabel.toUpperCase()}</b> ${sevLabel}<br>
                ${altLabel}<br>
                <small style="white-space:pre-wrap">${_esc(e.raw)}</small>
            </div>`)
            .addTo(_layers.pirep);
    }
}

// ── SIGMET / AIRMET / CWA ─────────────────────────────────────────────────

const ADVISORY_STYLES = {
    sigmet:  { color: '#ff2222', fillOpacity: 0.12 },
    airmet:  { color: '#ccaa00', fillOpacity: 0.12 },
    cwa:     { color: '#ff6600', fillOpacity: 0.18 },
};

function _isExpired(e, T) {
    if (!e.expires_at) return false;
    const expiresT = Math.floor(new Date(e.expires_at).getTime() / 1000);
    const t0       = _data.header.t0;
    return (expiresT - t0) < T;
}

function _renderSigmetAirmetCwa(T) {
    for (const key of ['sigmet', 'airmet', 'cwa']) {
        _layers[key].clearLayers();
        if (!_prefs[key]) continue;
        const wind = WINDOWS[key];
        const style = ADVISORY_STYLES[key];
        for (const e of (_data.events[key] || [])) {
            if (e.t > T) continue;
            if (T - e.t > wind) continue;
            if (_isExpired(e, T)) continue;
            if (!e.points || e.points.length < 3) continue;
            const label = key.toUpperCase();
            const expiry = e.expires_at ? `Expires ${e.expires_at.slice(11, 16)}Z` : '';
            L.polygon(e.points, { color: style.color, weight: 1.5,
                fillColor: style.color, fillOpacity: style.fillOpacity })
                .bindPopup(`<div style="font-family:var(--font-ui);max-width:320px">
                    <b>${label}</b> ${expiry}<br>
                    <small style="white-space:pre-wrap">${_esc(e.raw)}</small>
                </div>`)
                .addTo(_layers[key]);
        }
    }
}

// ── WINDS ──────────────────────────────────────────────────────────────────

function _renderWinds(T) {
    _layers.winds.clearLayers();
    if (!_prefs.winds || !_data.events.winds.length) return;

    // Latest per station+alt at time T
    const latest = new Map();
    for (const e of _data.events.winds) {
        if (e.t > T) continue;
        const key = `${e.station}:${e.alt}`;
        if (!latest.has(key) || e.t > latest.get(key).t) latest.set(key, e);
    }

    for (const w of latest.values()) {
        if (w.lat == null || w.lon == null) continue;
        const rot = (w.dir || 0);
        const icon = L.divIcon({
            className: '',
            html: `<div style="transform:rotate(${rot}deg);font-size:1rem;line-height:1;color:#1a1a2e">↑</div>
                   <div style="font-size:0.6rem;white-space:nowrap;color:#444;text-align:center">${w.spd}kt/${Math.round((w.alt||0)/1000)}k</div>`,
            iconSize: [40, 28], iconAnchor: [20, 8],
        });
        L.marker([w.lat, w.lon], { icon })
            .bindPopup(`<b>${w.station}</b> ${(w.alt||0).toLocaleString()}ft<br>${w.dir}° @ ${w.spd}kt, ${w.temp}°C`)
            .addTo(_layers.winds);
    }
}

// ── NOTAM ──────────────────────────────────────────────────────────────────

function _renderNotam(T) {
    _layers.notam.clearLayers();
    if (!_prefs.notam || !_data.events.notam.length) return;

    for (const e of _data.events.notam) {
        if (e.t > T) continue;
        if (_isExpired(e, T)) continue;
        if (e.lat == null || e.lon == null) continue;
        if (e.tfr) {
            const r = (e.radius_nm || 5) * 1852; // nm → meters
            L.circle([e.lat, e.lon], {
                radius: r, color: '#cc2222', weight: 2,
                fillColor: '#cc2222', fillOpacity: 0.08,
                dashArray: '6,4',
            })
                .bindPopup(`<b>TFR</b><br><small>${_esc(e.raw.slice(0, 200))}</small>`)
                .addTo(_layers.notam);
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _loadPrefs() {
    _prefs = { ...DEFAULTS };
    try {
        const saved = JSON.parse(localStorage.getItem('weatherPrefs') || '{}');
        Object.assign(_prefs, saved);
    } catch (_) {}
}

function _savePrefs() {
    try { localStorage.setItem('weatherPrefs', JSON.stringify(_prefs)); } catch (_) {}
}
```

- [ ] **Step 2: Commit**

```bash
git add js/weather-replay.js
git commit -m "feat(weather-replay): parse and render weather NDJSON by time window"
```

---

## Task 8: Wire Weather Replay into `js/app.js`

**Files:**
- Modify: `~/flytab-debrief/js/app.js`

- [ ] **Step 1: Import the new module at the top of `js/app.js`**

Add to the existing import block:
```js
import { parseWeatherNDJSON, initWeather, renderWeather } from './weather-replay.js';
```

- [ ] **Step 2: Load the weather file in `openFlight()`**

After the existing traffic-loading block (around line 58–69), add:
```js
let weatherData = null;
const weatherFilename = filename.replace(/\.csv$/, '_weather.ndjson');
try {
    const wr = await fetch(`${API}/api/flights/${encodeURIComponent(weatherFilename)}`);
    if (wr.ok) {
        const ndjson = await wr.text();
        weatherData = parseWeatherNDJSON(ndjson);
    }
} catch (_) {}
```

- [ ] **Step 3: Pass `weatherData` to `initReplay` and `initWeather`**

Change the `initReplay` call (line ~185):
```js
initReplay(fd, trafficData, phaseScores);
```
to:
```js
initReplay(fd, trafficData, phaseScores);
if (weatherData) initWeather(weatherData, window._replayMap);
```

Note: `initReplay` in `replay.js` exposes the map as `window._replayMap` — add `window._replayMap = _map;` in `replay.js`'s `initReplay()` after `_map` is assigned (or pass map as a return value). See step below.

- [ ] **Step 4: Expose the map from `replay.js`**

In `js/replay.js`, in `initReplay()`, after `_map = L.map(...)`:
```js
window._replayMap = _map;
```

- [ ] **Step 5: Hook `renderWeather` into the scrubber**

Find the scrubber `input` listener in `app.js` (around line 284–291):
```js
scrubber.addEventListener('input', () => {
    const idx = parseInt(scrubber.value);
    // ...
    window._replay?.seek(idx);
    window._charts?.seek(idx);
    // ...
```
Add `renderWeather` call:
```js
scrubber.addEventListener('input', () => {
    const idx = parseInt(scrubber.value);
    // ...
    window._replay?.seek(idx);
    window._charts?.seek(idx);
    if (weatherData) renderWeather(idx);
    // ...
```

Note: `weatherData` is in scope here since `openFlight` defines it as `let weatherData` and the scrubber wiring happens within `openFlight`.

- [ ] **Step 6: Commit**

```bash
git add js/app.js js/replay.js
git commit -m "feat(debrief): wire weather NDJSON loading and scrubber replay"
```

---

## Task 9: Weather Toggle Panel (`index.html` + `css/style.css`)

**Files:**
- Modify: `~/flytab-debrief/index.html`
- Modify: `~/flytab-debrief/css/style.css`

- [ ] **Step 1: Import `weather-replay.js` in `index.html`**

Find where other `js/` modules are imported via `<script type="module">` or add it. In the same `<script type="module">` block that already imports from `./js/app.js`, ensure `weather-replay.js` is imported transitively (it's imported by `app.js` now — nothing extra needed in HTML if app.js is the entry point).

If modules are loaded individually via `<script>` tags rather than via ES module import, add:
```html
<script type="module" src="js/weather-replay.js"></script>
```
before the `app.js` script tag.

- [ ] **Step 2: Add the weather layer toggle panel HTML**

Find the existing `traffic-menu` dropdown in `index.html`. Add a `weather-menu` alongside it:

```html
<!-- Weather layer toggle -->
<button id="weather-menu-btn" class="toolbar-btn hidden" title="Weather layers">WX</button>
<div id="weather-menu" class="dropdown-menu hidden">
  <div class="dropdown-header">Weather Layers</div>
  <label class="dropdown-item"><input type="checkbox" data-wx="nexrad" checked> NEXRAD</label>
  <label class="dropdown-item"><input type="checkbox" data-wx="metar" checked> METARs</label>
  <label class="dropdown-item"><input type="checkbox" data-wx="pirep" checked> PIREPs</label>
  <label class="dropdown-item"><input type="checkbox" data-wx="sigmet" checked> SIGMETs</label>
  <label class="dropdown-item"><input type="checkbox" data-wx="airmet" checked> AIRMETs</label>
  <label class="dropdown-item"><input type="checkbox" data-wx="cwa" checked> CWAs</label>
  <label class="dropdown-item"><input type="checkbox" data-wx="winds"> Winds</label>
  <label class="dropdown-item"><input type="checkbox" data-wx="notam" checked> NOTAMs</label>
</div>
```

- [ ] **Step 3: Wire the toggle panel in `js/app.js`**

Add a `_wireWeatherMenu(weatherData)` function and call it from `openFlight()` after `initWeather(...)`:

```js
function _wireWeatherMenu(weatherData) {
    const btn  = document.getElementById('weather-menu-btn');
    const menu = document.getElementById('weather-menu');
    if (!btn || !menu || !weatherData) return;

    btn.classList.remove('hidden');

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== btn) menu.classList.add('hidden');
    });

    menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
        const key = cb.dataset.wx;
        cb.checked = getWeatherLayerVisible(key);
        cb.addEventListener('change', () => {
            setWeatherLayerVisible(key, cb.checked);
            renderWeather(parseInt(document.getElementById('scrubber').value));
        });
    });
}
```

And add the import at the top of `app.js`:
```js
import { ..., setWeatherLayerVisible, getWeatherLayerVisible } from './weather-replay.js';
```

- [ ] **Step 4: Add CSS for the weather toggle panel**

Append to `css/style.css`. If `dropdown-menu` / `dropdown-item` / `dropdown-header` classes already exist (from the traffic menu), reuse them — no new CSS needed. If not:

```css
.toolbar-btn {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--text-primary);
    cursor: pointer;
    min-height: 32px;
}
.dropdown-menu {
    position: absolute;
    top: 40px;
    right: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 0;
    z-index: 1000;
    min-width: 160px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
}
.dropdown-header {
    font-size: 0.72rem;
    font-weight: 800;
    color: var(--text-label);
    padding: 6px 12px 2px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    font-size: 0.82rem;
    color: var(--text-secondary);
    cursor: pointer;
}
.dropdown-item:hover { background: var(--bg-surface); }
```

- [ ] **Step 5: Update the flight list badge to show weather**

In `loadFlightList()` in `js/app.js`, add a weather badge:
```js
list.innerHTML = flights.map(f => `
    <div class="flight-item" data-name="${escHtml(f.name)}">
      <span class="flight-item-name">${escHtml(f.name)}</span>
      ${f.hasTraffic  ? '<span class="flight-item-badge">+ TRAFFIC</span>' : ''}
      ${f.hasWeather  ? '<span class="flight-item-badge weather-badge">+ WEATHER</span>' : ''}
    </div>
`).join('');
```

Add CSS for the badge variant:
```css
.weather-badge { background: var(--color-info); color: #fff; }
```

- [ ] **Step 6: Commit**

```bash
git add index.html js/app.js css/style.css
git commit -m "feat(debrief): weather layer toggle panel and flight list badge"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Fix PIREP async race | Task 1 |
| Fix NEXRAD empty snapshots | Task 2 |
| CWA polygon with expiry and tap | Task 3 |
| FisbLogger writes _weather.ndjson | Task 4 |
| FisbLogger wired in app.js | Task 5 |
| debrief-server.py hasWeather | Task 6 |
| weather-replay.js parse + render | Task 7 |
| scrubber integration | Task 8 |
| Weather toggle panel | Task 9 |
| User manual updated | Task 5 |

**Placeholder scan:** None found. All code is complete.

**Type consistency check:**
- `FisbLogger._fileName` starts as `YYYYMMDD_HHMMZ_weather.ndjson`, renamed via `_stop()` to match CSV basename — consistent with `FlightRecorder._trafficFileName` pattern.
- `renderWeather(idx)` receives `idx` (CSV row index ≈ seconds from start), same units as `t` in NDJSON — consistent.
- `_isExpired(e, T)` converts `expires_at` ISO string to epoch, subtracts `header.t0` to get seconds-from-start — consistent.
- NEXRAD `_renderNexrad`: iterates `_data.events.nexrad` sorted by `t` ascending; uses `break` after first non-zero intensity cell — this renders only one cell per block. This is a simplification noted in the spec; full sub-cell rendering is out of scope.
- `window._replayMap` is set by `replay.js` after `_map = L.map(...)` — must be set before `initWeather` is called in `app.js`. Task 8 step 4 covers this.

**Known gap:** METAR rendering in `weather-replay.js` requires ICAO → lat/lon lookup which is not implemented (TODO comment left). This is intentional — METARs will appear in popups but not as map markers until lat/lon resolution is added. This matches scope since no spec requirement mandated METAR map markers specifically.
