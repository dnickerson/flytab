# FlyTab Integration: Debrief Button + ADS-B Traffic Recording

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire FlyTab to the flytab-debrief app — record ADS-B traffic alongside every flight CSV and add a DEBRIEF button to each logbook entry that opens the debrief tool.

**Architecture:** Three files change in `~/flytab/web/`. The `FlightRecorder` grows a 5-second traffic snapshot loop that writes a companion `_traffic.ndjson` file to NanoHTTPD. `FlightUpload` uploads that companion file alongside the CSV. The `Logbook` entry template gains a DEBRIEF button that opens the debrief URL in the system browser. One new key in `cockpit-config.json`.

**Tech Stack:** Vanilla JS (no bundler). Changes follow existing FlyTab patterns — no new dependencies, no new script tags, no CSS file changes beyond adding one button class that already exists.

**Companion project:** `~/flytab-debrief` — the debrief server that consumes these files. Interface contracts documented below. Any change to the NDJSON field names or filename conventions must be mirrored in `~/flytab-debrief/js/traffic-parser.js`.

---

## Interface Contract with flytab-debrief

The `traffic-parser.js` in flytab-debrief parses each NDJSON line expecting:

```json
{"t": 0, "targets": [{"icao": "A12345", "cs": "AAL123", "lat": 35.12, "lon": -80.23, "altFt": 8500, "spdKts": 240, "hdg": 185, "squawk": "1200"}]}
```

FlyTab `stratuxClient.traffic` Map values provide:

| stratux field | NDJSON field | Notes |
|---|---|---|
| `target.hex` | `icao` | Already 6-char uppercase hex string |
| `target.callsign` | `cs` | May be empty string |
| `target.lat` | `lat` | Float degrees |
| `target.lon` | `lon` | Float degrees |
| `target.alt` | `altFt` | Integer, pressure altitude ft |
| `target.speed` | `spdKts` | Float knots |
| `target.track` | `hdg` | Float degrees true |
| `target.squawk` | `squawk` | Store as `String(t.squawk \|\| 0).padStart(4,'0')` |

Filename convention (must stay in sync):
- CSV:     `YYYYMMDD_DEP-DEST.csv`
- Traffic: `YYYYMMDD_DEP-DEST_traffic.ndjson`

Traffic filename is always CSV stem + `_traffic.ndjson`.

---

## File Map

| File | Change |
|------|--------|
| `web/cockpit-config.json` | Add `debriefServer.base` key |
| `web/cockpit/flight-recorder.js` | Add traffic snapshot interval + NDJSON flush + rename sync |
| `web/cockpit/flight-upload.js` | Upload `_traffic.ndjson` companion after CSV upload |
| `web/cockpit/logbook.js` | Add DEBRIEF button per entry, wire to open debrief URL |

No new `<script>` tags. No `style.css` changes — the DEBRIEF button uses the existing `logbook-btn` class.

---

## Task 1: cockpit-config.json — debriefServer Key

**Files:**
- Modify: `web/cockpit-config.json`

- [ ] **Step 1: Add `debriefServer` block**

Open `web/cockpit-config.json` and add after the `"flightUpload"` block:

```json
"debriefServer": {
  "base": "http://100.x.x.x:8092"
}
```

Replace `100.x.x.x` with the actual Tailscale IP of the home machine. The value is the same base URL that the systemd service binds to.

- [ ] **Step 2: Verify CockpitConfig can read it**

In the browser DevTools console on the tablet (or via CDP):

```javascript
CockpitConfig.get('debriefServer')
// Expected: { base: "http://100.x.x.x:8092" }
```

- [ ] **Step 3: Commit**

```bash
cd ~/flytab
git add web/cockpit-config.json
git commit -m "feat(config): add debriefServer.base for flytab-debrief URL"
```

---

## Task 2: flight-recorder.js — ADS-B Traffic Recording

**Files:**
- Modify: `web/cockpit/flight-recorder.js`

This task adds a 5-second traffic snapshot loop that runs in parallel with the existing 1Hz CSV loop. The traffic NDJSON file is kept in sync with the CSV filename throughout start/stop/rename.

- [ ] **Step 1: Add instance properties to the constructor**

In the `constructor(engineClient, stratuxClient, nasrDb)` method, after the existing `this._flushInterval = null;` line, add:

```javascript
// ADS-B traffic recording (5s intervals, companion NDJSON file)
this._trafficFileName = null;
this._trafficBuffer = [];
this._trafficInterval = null;
```

- [ ] **Step 2: Initialize traffic recording in `start()`**

In the `start()` method, after the line `this._fileName = \`${ymd}_${hm}Z.csv\`;`, add:

```javascript
this._trafficFileName = `${ymd}_${hm}Z_traffic.ndjson`;
this._trafficBuffer = [];
```

After the existing `this._recordInterval = setInterval(...)` and `this._flushInterval = setInterval(...)` lines, add:

```javascript
// Traffic snapshot at 5s intervals
this._trafficInterval = setInterval(() => this._recordTrafficSnapshot(), 5000);
```

- [ ] **Step 3: Stop and flush traffic in `stop()`**

In the `stop()` method, after the existing `if (this._flushInterval) { clearInterval(...) }` block, add:

```javascript
if (this._trafficInterval) { clearInterval(this._trafficInterval); this._trafficInterval = null; }
```

After the existing `await this._flush()` call (inside the try block), add:

```javascript
try {
    await this._flushTraffic();
} catch (err) {
    if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Traffic flush failed: ${err.message}`);
}
```

- [ ] **Step 4: Add `_recordTrafficSnapshot()` method**

Add after the existing `_recordRow()` method:

```javascript
/** Snapshot all visible traffic targets to NDJSON buffer */
_recordTrafficSnapshot() {
    if (!this._recording || !this._trafficFileName) return;
    const traffic = this._stratux?.traffic;
    if (!traffic || traffic.size === 0) return;

    const t = this._rowCount;  // seconds from start (matches CSV time axis)
    const targets = [];
    for (const tgt of traffic.values()) {
        if (!tgt.lat || !tgt.lon) continue;
        targets.push({
            icao: tgt.hex,
            cs:   tgt.callsign || '',
            lat:  tgt.lat,
            lon:  tgt.lon,
            altFt: tgt.alt || 0,
            spdKts: tgt.speed || 0,
            hdg:  tgt.track || 0,
            squawk: String(tgt.squawk || 0).padStart(4, '0'),
        });
    }
    if (!targets.length) return;

    this._trafficBuffer.push(JSON.stringify({ t, targets }));
}
```

- [ ] **Step 5: Add `_flushTraffic()` method**

Add after `_flushTraffic`:

```javascript
/** Flush buffered NDJSON lines to NanoHTTPD */
async _flushTraffic() {
    if (!this._trafficBuffer.length || !this._trafficFileName) return;
    const content = this._trafficBuffer.join('\n') + '\n';
    this._trafficBuffer = [];
    const path = `${FlightRecorder.FLIGHTS_PATH}/${this._trafficFileName}`;
    try {
        const resp = await fetch(`${FlightRecorder.LOCAL_BASE}/${path}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/x-ndjson', 'X-Append': 'true' },
            body: content,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
        this._trafficBuffer.unshift(content.trim());
        if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Traffic flush failed: ${err.message}`);
    }
}
```

Also add traffic flushing to the existing flush interval — in `start()`, change the flush interval to also flush traffic:

The existing `this._flushInterval` already calls `this._flush()` every 5s. Rather than add a second interval, extend it. Replace:

```javascript
this._flushInterval = setInterval(() => this._flush(), 5000);
```

With:

```javascript
this._flushInterval = setInterval(() => {
    this._flush();
    this._flushTraffic();
}, 5000);
```

- [ ] **Step 6: Sync traffic filename in `_renameWithRoute()`**

In `_renameWithRoute()`, after the existing `this._fileName = newName;` line, add the traffic rename:

```javascript
// Rename companion traffic file if it exists
if (this._trafficFileName) {
    const oldTrafficPath = `${FlightRecorder.FLIGHTS_PATH}/${this._trafficFileName}`;
    const newTrafficName = newName.replace(/\.csv$/, '_traffic.ndjson');
    const newTrafficPath = `${FlightRecorder.FLIGHTS_PATH}/${newTrafficName}`;
    try {
        const tr = await fetch(`${FlightRecorder.LOCAL_BASE}/${oldTrafficPath}`);
        if (tr.ok) {
            const trafficData = await tr.text();
            await fetch(`${FlightRecorder.LOCAL_BASE}/${newTrafficPath}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/x-ndjson' },
                body: trafficData,
            });
            await fetch(`${FlightRecorder.LOCAL_BASE}/${oldTrafficPath}`, { method: 'DELETE' });
            this._trafficFileName = newTrafficName;
        }
    } catch (err) {
        if (typeof DiagLog !== 'undefined') DiagLog.log('recorder', `Traffic rename failed: ${err.message}`);
    }
}
```

This goes immediately after the existing `this._fileName = newName;` line, before the `return { depIcao: dep, destIcao: dest };`.

- [ ] **Step 7: Build and verify traffic file appears**

```bash
bash build.sh
```

Install the APK on the tablet. Start a flight (engine running + Stratux connected with traffic visible). After 30+ seconds, check via CDP or adb:

```bash
# List flights directory via CDP
curl http://localhost:9223/json  # find the FlyTab page
# In DevTools console:
fetch('http://localhost:9090/flights/list').then(r=>r.json()).then(console.log)
```

Expected: both `YYYYMMDD_HHMMZ.csv` and `YYYYMMDD_HHMMZ_traffic.ndjson` appear.

Stop the flight. Verify both files are renamed to `YYYYMMDD_DEP-DEST.csv` and `YYYYMMDD_DEP-DEST_traffic.ndjson`.

- [ ] **Step 8: Commit**

```bash
git add web/cockpit/flight-recorder.js
git commit -m "feat(recorder): ADS-B traffic snapshot at 5s intervals to companion _traffic.ndjson"
```

---

## Task 3: flight-upload.js — Companion File Upload

**Files:**
- Modify: `web/cockpit/flight-upload.js`

Upload the `_traffic.ndjson` file silently after a successful CSV upload. If the companion doesn't exist (older recordings, or no Stratux traffic), the CSV upload succeeds without error.

- [ ] **Step 1: Add `_uploadTrafficCompanion()` helper method**

Add after the existing `_uploadOne()` method:

```javascript
/**
 * Upload the _traffic.ndjson companion file for a CSV, if it exists.
 * Fails silently — traffic companion is supplementary, never blocks CSV upload.
 */
async _uploadTrafficCompanion(csvFilename, cfg, password) {
    const trafficFilename = csvFilename.replace(/\.csv$/i, '_traffic.ndjson');
    // Check if the companion exists in the flights list
    const exists = this._flights.some(f => f.name === trafficFilename);
    if (!exists) return;

    try {
        await Capacitor.Plugins.Sftp.upload({
            host: cfg.host,
            port: cfg.port || 22,
            username: cfg.username,
            filename: trafficFilename,
            remotePath: cfg.remotePath || '~/flights',
            password,
        });
        if (typeof DiagLog !== 'undefined') DiagLog.log('upload', `Traffic companion uploaded: ${trafficFilename}`);
    } catch (err) {
        // Non-fatal — log and continue
        if (typeof DiagLog !== 'undefined') DiagLog.log('upload', `Traffic companion upload failed (non-fatal): ${err.message}`);
    }
}
```

- [ ] **Step 2: Call companion upload in `_uploadOne()` after CSV success**

In `_uploadOne()`, find the `if (result.ok)` block:

```javascript
if (result.ok) {
    this._markUploaded(filename, rowEl);
}
```

Replace with:

```javascript
if (result.ok) {
    this._markUploaded(filename, rowEl);
    // Upload traffic companion file silently if present
    await this._uploadTrafficCompanion(filename, cfg, password);
}
```

- [ ] **Step 3: Call companion upload in `_uploadAllPending()` after each CSV success**

In `_uploadAllPending()`, find the loop that uploads pending flights. After each successful upload (the `if (result.ok)` block inside the loop), add:

```javascript
if (result.ok) {
    this._markUploaded(flight.name, null);
    uploaded++;
    btn.textContent = `Uploading ${uploaded} / ${pending.length}...`;
    // Upload traffic companion silently
    await this._uploadTrafficCompanion(flight.name, cfg, password);
}
```

To find the exact location, look for `this._markUploaded(flight.name` in the loop body and add the companion call immediately after.

- [ ] **Step 4: Build and verify companion upload**

```bash
bash build.sh
```

Install. With a flight that has both CSV and `_traffic.ndjson` on the device, open Flight Upload and upload the flight. Check the home machine `~/flights/` directory:

```bash
ls -la ~/flights/
```

Expected: both `YYYYMMDD_DEP-DEST.csv` and `YYYYMMDD_DEP-DEST_traffic.ndjson` present.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/flight-upload.js
git commit -m "feat(upload): silently upload _traffic.ndjson companion alongside CSV"
```

---

## Task 4: logbook.js — DEBRIEF Button

**Files:**
- Modify: `web/cockpit/logbook.js`

Add a DEBRIEF button to each logbook flight entry that has a `csvFilename`. Tapping it opens the flytab-debrief URL in the system browser. Button is hidden when `debriefServer.base` is not configured or the entry has no CSV filename.

- [ ] **Step 1: Add `_debriefUrl()` helper method**

Add a private helper method to the `Logbook` class (place it near other private helpers, e.g., after `_setMapControlsVisible`):

```javascript
/** Returns the debrief URL for a flight entry, or null if not configured. */
_debriefUrl(entry) {
    const cfg = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.get('debriefServer') : {};
    const base = cfg?.base;
    if (!base || !entry.csvFilename) return null;
    return `${base}/?file=${encodeURIComponent(entry.csvFilename)}`;
}
```

- [ ] **Step 2: Add DEBRIEF button to the entry template**

In the `_renderFlights()` method, find the entry template string (around line 175):

```javascript
return `<div class="logbook-entry ${isDraft ? 'logbook-draft' : ''}" data-id="${e.id}">
    ...
    <span class="logbook-entry-spacer"></span>
    <button class="logbook-btn logbook-edit-btn" data-id="${e.id}">${isDraft ? 'REVIEW' : 'EDIT'}</button>
    <button class="logbook-btn logbook-delete-btn" data-id="${e.id}">DEL</button>
</div>`;
```

Replace with (add DEBRIEF button before the spacer line):

```javascript
const debriefUrl = this._debriefUrl(e);
return `<div class="logbook-entry ${isDraft ? 'logbook-draft' : ''}" data-id="${e.id}">
    <span class="logbook-date">${e.date}</span>${syncDot}
    <span class="logbook-route">${dep}→${dest}</span>
    <span class="logbook-detail">${hrs}h</span>
    ${ldg > 0 ? `<span class="logbook-detail">${ldg}ldg</span>` : ''}
    ${cond ? `<span class="logbook-detail">${cond}</span>` : ''}
    ${sourceLabel ? `<span class="logbook-source ${isDraft ? 'logbook-source-draft' : ''}">${sourceLabel}</span>` : ''}
    <span class="logbook-entry-spacer"></span>
    ${debriefUrl ? `<button class="logbook-btn logbook-debrief-btn" data-id="${e.id}" data-url="${debriefUrl}">DEBRIEF</button>` : ''}
    <button class="logbook-btn logbook-edit-btn" data-id="${e.id}">${isDraft ? 'REVIEW' : 'EDIT'}</button>
    <button class="logbook-btn logbook-delete-btn" data-id="${e.id}">DEL</button>
</div>`;
```

- [ ] **Step 3: Wire DEBRIEF button tap handlers**

In `_renderFlights()`, after the existing block that wires `.logbook-edit-btn`:

```javascript
// Wire edit buttons
this._body.querySelectorAll('.logbook-edit-btn').forEach(btn => {
    wireTap(btn, () => { ... });
});
```

Add:

```javascript
// Wire debrief buttons — open in system browser
this._body.querySelectorAll('.logbook-debrief-btn').forEach(btn => {
    wireTap(btn, () => {
        const url = btn.dataset.url;
        if (url) window.open(url, '_system');
    });
});
```

`'_system'` is the Capacitor convention for opening in the external system browser rather than an in-app WebView.

- [ ] **Step 4: Verify the button only appears for AUTO entries with a CSV**

The `e.csvFilename` is set by `createEntry()` when a flight recording completes automatically. Manually created entries (`+ NEW`) have `csvFilename: null`. The `_debriefUrl()` helper returns `null` in that case, so no button is rendered for manual entries.

- [ ] **Step 5: Build**

```bash
bash build.sh
```

- [ ] **Step 6: Manual verification on tablet**

Install APK. Open Logbook → Flights tab. Verify:

- [ ] AUTO entries (from recordings) show a `DEBRIEF` button
- [ ] Manually created entries show no `DEBRIEF` button
- [ ] Tapping `DEBRIEF` on an AUTO entry opens the system browser at `http://100.x.x.x:8092/?file=YYYYMMDD_DEP-DEST.csv`
- [ ] If the debrief server is running on the home machine, the flight loads in the debrief app
- [ ] If the debrief server is not running, the browser shows a connection error (expected — no silent failure needed)

- [ ] **Step 7: Tap handler regression check (per CLAUDE.md rule)**

After any change to the logbook tap handlers, verify that tapping a flight entry to EDIT still opens the form correctly — the `wireTap` calls must not interfere with each other.

- [ ] **Step 8: Commit**

```bash
git add web/cockpit/logbook.js
git commit -m "feat(logbook): DEBRIEF button per AUTO entry opens flytab-debrief in system browser"
```

---

## Task 5: Build, Install, End-to-End Verification

- [ ] **Step 1: Increment version and build**

In `web/app.js`, increment `FLYTAB_VERSION` (e.g. `v7.x` → `v7.x+1`).

```bash
bash build.sh
```

- [ ] **Step 2: Install on tablet via ADB**

```bash
~/Android/Sdk/platform-tools/adb install -r data/flytab-latest.apk
```

If wireless ADB not connected, pair first per CLAUDE.md ADB instructions.

- [ ] **Step 3: Full end-to-end checklist**

With the home debrief server running (`sudo systemctl start flytab-debrief` or `bash ~/flytab-debrief/start-debrief.sh`):

- [ ] Start a flight with Stratux connected (traffic visible in traffic display)
- [ ] Wait 30 seconds — traffic file should be accumulating
- [ ] Stop flight — verify both CSV and `_traffic.ndjson` appear in `/flights/` via CDP console:
  ```javascript
  fetch('http://localhost:9090/flights/list').then(r=>r.json()).then(d=>d.map(f=>f.name))
  ```
- [ ] Open Flight Upload — upload the flight — verify both files arrive at `~/flights/` on home machine
- [ ] Open flytab-debrief at `http://100.x.x.x:8092` — verify flight appears in list with `+ TRAFFIC` badge
- [ ] Click flight in debrief — verify traffic markers appear on the map during replay
- [ ] Open Logbook → find the auto-entry for the flight → tap DEBRIEF → system browser opens at correct URL with flight pre-loaded

- [ ] **Step 4: Verify no regression on existing features**

- [ ] Flight recording still starts/stops automatically on RPM threshold
- [ ] Logbook EDIT button still opens the edit form
- [ ] Logbook DEL button still works
- [ ] FlightUpload list still shows correct PENDING/UPLOADED state

- [ ] **Step 5: Final commit**

```bash
git add web/app.js
git commit -m "chore: bump version for debrief integration release"
```

---

## Notes: Backward Compatibility

**Older recordings without `_traffic.ndjson`:**
- `FlightUpload`: `_uploadTrafficCompanion()` checks `this._flights.some(f => f.name === trafficFilename)` before attempting upload — no error if absent.
- `flytab-debrief`: `app.js` wraps the traffic fetch in try/catch and sets `trafficData = null` if the file is absent. All replay and scoring features work without traffic data; the map traffic markers and `TRAFFIC` badge are simply hidden.

**Flights recorded before Stratux was connected:**
- `_recordTrafficSnapshot()` guards with `if (!traffic || traffic.size === 0) return` — no NDJSON file is written when there's no traffic data at all.

**Squawk field format:**
- Stored as `String(tgt.squawk || 0).padStart(4, '0')` — a 4-digit string (e.g. `"1200"`, `"7700"`). `traffic-parser.js` in flytab-debrief reads it as-is and displays it in the popup without further conversion.

---

## Connection to flytab-debrief

If the NDJSON field names, filename convention, or data types change in this plan, these files in `~/flytab-debrief` must be updated in the same commit:

| What changed | Update in flytab-debrief |
|---|---|
| NDJSON field names (e.g. `cs` → `callsign`) | `js/traffic-parser.js` `parseTrafficNDJSON()` |
| Filename suffix (`_traffic.ndjson` → anything else) | `js/app.js` `openFlight()` traffic filename derivation |
| `t` field semantics (seconds from start) | `js/traffic-parser.js` `computeProximityEvents()` |

The two repos are independent but these interface points must stay in sync. Document any changes in both commit messages.
