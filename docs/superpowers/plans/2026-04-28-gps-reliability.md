# GPS Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the startup race condition that killed ownship for an entire flight, add an engine-GPS fallback bridge for when the Stratux situation WS is dead, and surface a diagnostic panel so the pilot knows GPS is degraded.

**Architecture:** Three independent layers — (1) 3-line bug fix in stratux-client.js + timeout handling in gps-source.js, (2) new read-only EngineGpsBridge class that injects engine GPS as synthetic stratux:situation events, (3) amber GPS pill state and tap-to-open diagnostic panel in app.js/style.css.

**Tech Stack:** Vanilla JS, no bundler. No automated tests — verification is build + tablet smoke test. `bash build.sh` runs after every change. Tablet at 192.168.1.82.

---

## File Map

| File | Change |
|---|---|
| `web/shared/stratux-client.js` | 3-line fix in `_setConnected` (line ~407) |
| `web/shared/gps-source.js` | Handle TIMEOUT error (code 3) + reset counter on success |
| `web/shared/engine-gps-bridge.js` | **New file** — EngineGpsBridge class |
| `web/index.html` | 1-line script tag for engine-gps-bridge.js |
| `web/app.js` | Bridge init, GPS pill amber state, diag panel |
| `web/style.css` | `.active-degraded` + `#gps-diag-panel` rules |

---

## Task 1: Layer 1a — stratux-client.js Race Condition Fix

**Files:**
- Modify: `web/shared/stratux-client.js` (line ~405)

The startup race: situation WS and traffic WS connect simultaneously. If situation WS closes before traffic WS opens, `_situationWs.onclose` guard (`this._trafficWs?.readyState === WebSocket.OPEN`) is false, so no reconnect is scheduled. Traffic opens and stays open; situation stays dead forever.

Fix: when traffic WS connects (`_setConnected(true)`), rescue situation WS if it is CLOSED.

- [ ] **Step 1: Find `_setConnected` and add the rescue check**

In `web/shared/stratux-client.js`, find `_setConnected(state)` at line ~385. The `if (state)` block currently ends with the staleTimer setTimeout. Add two lines immediately after that setTimeout closes (before `this.dispatchEvent(...)`):

```javascript
    _setConnected(state) {
        if (this._connected === state) return;
        this._connected = state;
        const event = state ? 'stratux:connect' : 'stratux:disconnect';
        if (state) {
            this._stale = false;
            clearTimeout(this._staleTimer);
            this._staleTimer = setTimeout(() => {
                this._stale = true;
                this.dispatchEvent(new CustomEvent('stratux:stale', { detail: { ageMs: 5000 } }));
            }, 5000);
            // Rescue situation WS if it lost the startup race
            if (!this._situationWs || this._situationWs.readyState === WebSocket.CLOSED) {
                this._connectSituation();
            }
        }
        this.dispatchEvent(new CustomEvent(event));
    }
```

The two new lines are the `// Rescue situation WS` comment and the `if` block that follows it. Everything else is unchanged.

- [ ] **Step 2: Verify no double-connect risk**

Read `_connectSituation()` (line ~177). It starts with `if (this._situationWs) { this._situationWs.close(); }` — this safely replaces any existing socket. The `readyState === WebSocket.CLOSED` guard above means we only call this when situation is already dead, so no double-open.

---

## Task 2: Layer 1b — gps-source.js GPS Timeout Handling

**Files:**
- Modify: `web/shared/gps-source.js` (lines ~156–183)

The `_startInternal` watchPosition error callback handles codes 1 (PERMISSION_DENIED) and 2 (POSITION_UNAVAILABLE) but silently ignores code 3 (TIMEOUT). On a WiFi-only device with no GPS chip, watchPosition times out repeatedly, `_suppressGpsSituation` stays true, and Stratux situation data never reaches the map. `_timeoutCount` is already in the constructor (line 26) — just needs to be wired.

- [ ] **Step 1: Add code 3 handler in the error callback**

In `_startInternal()` at line ~166, the error callback currently reads:

```javascript
            (err) => {
                const msg = `Internal GPS error: code=${err.code} ${err.message}`;
                console.warn('[GpsSource]', msg);
                if (typeof DiagLog !== 'undefined') DiagLog.log('gps', msg);
                if (err.code === 1 || err.code === 2) {
                    this._stopInternal();
                    this._fallbackToStratux();
                }
            },
```

Change it to:

```javascript
            (err) => {
                const msg = `Internal GPS error: code=${err.code} ${err.message}`;
                console.warn('[GpsSource]', msg);
                if (typeof DiagLog !== 'undefined') DiagLog.log('gps', msg);
                if (err.code === 1 || err.code === 2) {
                    this._stopInternal();
                    this._fallbackToStratux();
                } else if (err.code === 3) {
                    this._timeoutCount++;
                    if (this._timeoutCount >= 2) {
                        this._stopInternal();
                        this._fallbackToStratux();
                    }
                }
            },
```

- [ ] **Step 2: Reset the counter on a successful position fix**

In the same `_startInternal()`, the success callback at line ~157 reads:

```javascript
            (pos) => {
                if (!this._firstFixLogged) {
                    this._firstFixLogged = true;
                    const c = pos.coords;
                    if (typeof DiagLog !== 'undefined') DiagLog.log('gps', `First fix: ...`);
                }
                this._onInternalPosition(pos);
                this._resetStaleTimer();
            },
```

Add `this._timeoutCount = 0;` before `this._onInternalPosition(pos)`:

```javascript
            (pos) => {
                if (!this._firstFixLogged) {
                    this._firstFixLogged = true;
                    const c = pos.coords;
                    if (typeof DiagLog !== 'undefined') DiagLog.log('gps', `First fix: ${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)} acc=${Math.round(c.accuracy)}m alt=${c.altitude != null ? Math.round(c.altitude) + 'm' : 'null'}`);
                }
                this._timeoutCount = 0;
                this._onInternalPosition(pos);
                this._resetStaleTimer();
            },
```

- [ ] **Step 3: Build and verify Layer 1 compiles**

Increment `FLYTAB_VERSION` in `web/app.js` line 6 (e.g. `v6.19` → `v6.20`) then:

```bash
bash build.sh
```

Expected: `BUILD SUCCESSFUL`. APK version increments.

- [ ] **Step 4: Commit Layer 1**

```bash
git add web/shared/stratux-client.js web/shared/gps-source.js web/app.js android/app/build.gradle
git commit -m "fix: stratux-client startup race condition + gps-source TIMEOUT fallback (v6.20)"
```

---

## Task 3: Layer 2 — Create EngineGpsBridge

**Files:**
- Create: `web/shared/engine-gps-bridge.js`
- Modify: `web/index.html` (1 line after engine-client.js script tag)

This class monitors `stratuxClient.stale` on every `engine:data` event. When Stratux situation WS is down AND engine GPS has a valid fix, it dispatches a synthetic `stratux:situation` event on the stratuxClient EventTarget so all downstream modules (map ownship, instrument strip) get position updates transparently. It never modifies `stratuxClient.situation` or `stratuxClient._stale`, keeping the stale flag accurate.

- [ ] **Step 1: Create `web/shared/engine-gps-bridge.js`**

```javascript
class EngineGpsBridge {
    constructor(stratuxClient, engineClient) {
        this._stratux = stratuxClient;
        this._engine  = engineClient;
        this._active  = false;
        this._onEngineData = null;
    }

    get active() { return this._active; }

    start() {
        this._onEngineData = () => this._tick();
        this._engine.addEventListener('engine:data', this._onEngineData);
    }

    stop() {
        if (this._onEngineData) {
            this._engine.removeEventListener('engine:data', this._onEngineData);
            this._onEngineData = null;
        }
        this._active = false;
    }

    _tick() {
        const d = this._engine.lastData;
        const shouldInject =
            this._stratux.stale === true &&
            this._engine.stale === false &&
            d?.latitude  != null &&
            d?.longitude != null;

        if (shouldInject) {
            if (!this._active) {
                this._active = true;
                if (typeof DiagLog !== 'undefined')
                    DiagLog.log('gps', 'Engine GPS bridge active — injecting engine GPS as Stratux situation');
            }
            this._stratux.dispatchEvent(new CustomEvent('stratux:situation', {
                detail: {
                    lat:             d.latitude,
                    lon:             d.longitude,
                    alt_msl:         d.gps_altitude,
                    alt_baro:        d.gps_altitude,
                    ground_speed:    d.ground_speed,
                    true_course:     d.course,
                    pitch:           d.pitch,
                    roll:            d.bank,
                    g_load:          d.acc_vert,
                    gps_fix_quality: 1,
                    gps_sats:        null,
                    vertical_speed:  0,
                    _source:         'engine',
                }
            }));
        } else if (this._active && !this._stratux.stale) {
            this._active = false;
            if (typeof DiagLog !== 'undefined')
                DiagLog.log('gps', 'Engine GPS bridge inactive — Stratux situation WS recovered');
        }
    }
}
```

- [ ] **Step 2: Add script tag to `web/index.html`**

In `web/index.html`, find line 71 (`<script src="./shared/engine-client.js"></script>`) and insert the bridge tag immediately after it:

```html
    <script src="./shared/engine-client.js"></script>
    <script src="./shared/engine-gps-bridge.js"></script>
```

The bridge must load after `engine-client.js` and before the cockpit components that consume situation events.

---

## Task 4: Layer 2 — Initialize EngineGpsBridge in app.js

**Files:**
- Modify: `web/app.js` (init section ~line 453)

- [ ] **Step 1: Add `this.engineGpsBridge = null` to the constructor**

In `web/app.js`, find the constructor property declarations (around line 53 where `this.stratuxClient = null` is declared). Add:

```javascript
        this.engineGpsBridge = null;
```

- [ ] **Step 2: Initialize bridge after engineClient.connect()**

In `web/app.js`, find the engine client init block at line ~453:

```javascript
        // Engine client (WebSocket to Pi engine monitor)
        this.engineClient = new EngineClient();
        this.engineClient.connect();
        window.engineClient = this.engineClient;
```

Add the bridge initialization immediately after `window.engineClient = this.engineClient;`:

```javascript
        // Engine GPS bridge — injects engine GPS when Stratux situation WS is unavailable
        if (typeof EngineGpsBridge !== 'undefined') {
            this.engineGpsBridge = new EngineGpsBridge(this.stratuxClient, this.engineClient);
            this.engineGpsBridge.start();
        }
```

- [ ] **Step 3: Build and verify Layer 2 compiles**

Increment `FLYTAB_VERSION` in `web/app.js` line 6 (e.g. `v6.20` → `v6.21`) then:

```bash
bash build.sh
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit Layer 2**

```bash
git add web/shared/engine-gps-bridge.js web/index.html web/app.js android/app/build.gradle
git commit -m "feat: engine GPS bridge — fallback ownship when Stratux situation WS is down (v6.21)"
```

---

## Task 5: Layer 3a — CSS for Amber Pill and Diagnostic Panel

**Files:**
- Modify: `web/style.css`

- [ ] **Step 1: Add amber GPS pill state and panel rules**

In `web/style.css`, find the `.status-gps.active` rule (line ~317):

```css
.status-gps.active { background: #116611; color: #44ff44; }
```

Add the new rules immediately after it:

```css
.status-gps.active-degraded { background: #664400; color: #ffcc44; }

#gps-diag-panel {
    display: none;
    background: #1a0000;
    border-bottom: 2px solid #cc2200;
    padding: 10px 12px;
    font-family: monospace;
    font-size: 11px;
    color: #ff9999;
    flex-shrink: 0;
}
#gps-diag-panel.visible { display: block; }
.gps-diag-status {
    font-size: 12px;
    font-weight: 600;
    color: #ffcc44;
    margin-bottom: 8px;
}
.gps-diag-log {
    max-height: 120px;
    overflow-y: auto;
    margin-bottom: 8px;
    line-height: 1.5;
}
.gps-diag-actions { display: flex; gap: 8px; }
.gps-diag-fix-btn {
    background: #cc2200; color: #fff;
    border: none; border-radius: 4px;
    padding: 8px 14px; font-size: 12px; font-weight: 700;
    cursor: pointer;
}
.gps-diag-sec-btn {
    background: #333; color: #ccc;
    border: 1px solid #555; border-radius: 4px;
    padding: 8px 14px; font-size: 12px;
    cursor: pointer;
}
```

---

## Task 6: Layer 3b — GPS Pill Amber State + Diagnostic Panel in app.js

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Insert GPS diag panel element into the DOM**

In `web/app.js`, find the `_init()` method that contains `this.dom = { statusGps: document.getElementById('statusGps'), ... }`. This is at line ~95–105. After the `this.dom = {...}` assignment block closes, add a call to `this._initGpsDiagPanel()`.

Locate the end of the dom assignment block (it ends with `};`) and add immediately after it:

```javascript
        this._initGpsDiagPanel();
```

- [ ] **Step 2: Add `_initGpsDiagPanel()` method**

Add this method to the `FlyTabApp` class body (near other init helpers):

```javascript
    _initGpsDiagPanel() {
        const panel = document.createElement('div');
        panel.id = 'gps-diag-panel';
        const statusBar = document.getElementById('statusBar');
        if (statusBar) statusBar.insertAdjacentElement('afterend', panel);
        this._gpsDiagPanel = panel;

        this.dom.statusGps?.addEventListener('click', () => this._toggleGpsDiagPanel());
    }

    _toggleGpsDiagPanel() {
        if (!this._gpsDiagPanel) return;
        const nowVisible = this._gpsDiagPanel.classList.toggle('visible');
        if (nowVisible) this._renderGpsDiagPanel();
    }

    _renderGpsDiagPanel() {
        const panel = this._gpsDiagPanel;
        if (!panel) return;

        const bridgeActive = this.engineGpsBridge?.active === true;
        const stale = this.stratuxClient?.stale;
        const sit = this.stratuxClient?.situation;
        const q = sit?.gps_fix_quality ?? 0;

        let statusLine;
        if (bridgeActive) {
            statusLine = 'Situation WS unavailable — position from engine monitor. Stratux reconnecting.';
        } else if (!stale && q === 0) {
            statusLine = 'Stratux connected — no GPS fix';
        } else if (stale) {
            statusLine = 'Situation WS closed — engine GPS also unavailable';
        } else {
            statusLine = 'GPS nominal';
        }

        const entries = DiagLog.entries
            .filter(e => e.cat === 'gps' || e.cat === 'stratux')
            .slice(-10)
            .reverse();
        const logHtml = entries.length
            ? entries.map(e =>
                `<div>${e.t.slice(11, 19)} [${e.cat}] ${e.msg}</div>`
              ).join('')
            : '<div>No GPS log entries yet</div>';

        const cfgSrc = this.gpsSource?._configuredSource;
        const inFallback = this.gpsSource?._inFallback;
        let fixLabel, fixAction;
        if (cfgSrc === 'internal' && q >= 1) {
            fixLabel = 'USE STRATUX GPS';
            fixAction = () => this.gpsSource.setSource('stratux');
        } else if (cfgSrc === 'auto' && inFallback) {
            fixLabel = 'RESET GPS SOURCE';
            fixAction = () => this.gpsSource.setSource('auto');
        } else {
            fixLabel = 'GPS SETTINGS';
            fixAction = () => this.configEditor?.show();
        }

        panel.innerHTML = `
            <div class="gps-diag-status">${statusLine}</div>
            <div class="gps-diag-log">${logHtml}</div>
            <div class="gps-diag-actions">
                <button class="gps-diag-fix-btn" id="gpsDiagFixBtn">${fixLabel}</button>
                <button class="gps-diag-sec-btn" id="gpsDiagSettingsBtn">GPS SETTINGS</button>
            </div>
        `;

        document.getElementById('gpsDiagFixBtn')?.addEventListener('click', fixAction);
        document.getElementById('gpsDiagSettingsBtn')?.addEventListener('click', () => this.configEditor?.show());
    }
```

- [ ] **Step 3: Update GPS pill to show amber state when bridge is active**

In `_startDeviceStatusMonitor()` at line ~1471, find the GPS pill block:

```javascript
            if (this.dom.statusGps) {
                const src = this.gpsSource?.label ?? (this.gpsSource?.source === 'internal' ? 'INT' : 'STX');
                const q = sit?.gps_fix_quality ?? 0;
                const gpsOk = q >= 1;
                this.dom.statusGps.classList.toggle('active', gpsOk);
                if (gpsOk) {
                    const sats = sit.gps_sats != null ? `${sit.gps_sats}sv` : '';
                    const sol = GPS_SOLUTION_LABELS[q] || 'FIX';
                    const acc = sit._accuracy != null ? `±${Math.round(sit._accuracy)}m` : '';
                    this.dom.statusGps.textContent = `${src} ${sol} ${sats || acc}`.trim();
                } else {
                    this.dom.statusGps.textContent = `${src} GPS`;
                }
            }
```

Replace it with:

```javascript
            if (this.dom.statusGps) {
                const bridgeActive = this.engineGpsBridge?.active === true;
                const src = bridgeActive ? 'ENG'
                    : (this.gpsSource?.label ?? (this.gpsSource?.source === 'internal' ? 'INT' : 'STX'));
                const q = sit?.gps_fix_quality ?? 0;
                const gpsOk = !bridgeActive && q >= 1;
                this.dom.statusGps.classList.toggle('active', gpsOk);
                this.dom.statusGps.classList.toggle('active-degraded', bridgeActive);
                if (gpsOk) {
                    const sats = sit.gps_sats != null ? `${sit.gps_sats}sv` : '';
                    const sol = GPS_SOLUTION_LABELS[q] || 'FIX';
                    const acc = sit._accuracy != null ? `±${Math.round(sit._accuracy)}m` : '';
                    this.dom.statusGps.textContent = `${src} ${sol} ${sats || acc}`.trim();
                } else if (bridgeActive) {
                    this.dom.statusGps.textContent = 'ENG GPS';
                } else {
                    this.dom.statusGps.textContent = `${src} GPS`;
                }
                // Auto-dismiss diag panel when GPS resolves
                if (gpsOk && this._gpsDiagPanel?.classList.contains('visible')) {
                    this._gpsDiagPanel.classList.remove('visible');
                }
            }
```

- [ ] **Step 4: Initialize `_gpsDiagPanel` in constructor**

In the constructor at line ~53 (near `this.engineGpsBridge = null`), add:

```javascript
        this._gpsDiagPanel = null;
```

- [ ] **Step 5: Build**

Increment `FLYTAB_VERSION` in `web/app.js` line 6 (e.g. `v6.21` → `v6.22`) then:

```bash
bash build.sh
```

Expected: `BUILD SUCCESSFUL`.

---

## Task 7: Smoke Test + Commit

**Files:** none new

- [ ] **Step 1: Install on tablet**

```bash
adb connect 192.168.1.82
adb install -r data/flytab-v6.22.apk
```

- [ ] **Step 2: Smoke test — normal GPS (green pill)**

1. Launch FlyTab on tablet connected to Stratux WiFi
2. Ownship icon appears on map within 30 seconds
3. GPS pill is green (shows `STX FIX Nsv`)
4. Tap GPS pill — panel opens, shows "GPS nominal"
5. Tap pill again — panel closes

- [ ] **Step 3: Smoke test — engine GPS bridge (amber pill)**

Simulate situation WS failure while keeping engine data flowing:

```bash
# Open Chrome DevTools via ADB remote debugging
# Navigate to chrome://inspect → inspect FlyTab WebView → Application → WebSockets
# Close the /situation socket manually — traffic and engine WS stay live
```

Expected:
- Ownship remains visible on map (engine GPS bridge active)
- GPS pill turns amber showing `ENG GPS`
- Tap pill → panel shows "Situation WS unavailable — position from engine monitor"

- [ ] **Step 4: Smoke test — diag panel auto-dismiss**

Re-enable situation WS (reload app or let Stratux reconnect). Panel auto-collapses and pill returns to green.

- [ ] **Step 5: Commit Layer 3**

```bash
git add web/app.js web/style.css android/app/build.gradle
git commit -m "feat: GPS diag panel + amber bridge state + Layer 3 notification (v6.22)"
```

---

## Spec Coverage Self-Review

| Spec requirement | Task |
|---|---|
| Race condition fix — situation WS rescued on traffic connect | Task 1 |
| TIMEOUT (code 3) fallback after 2 consecutive timeouts | Task 2 |
| `_timeoutCount` reset on successful fix | Task 2 |
| EngineGpsBridge: injection conditions (all 4 checks) | Task 3 |
| Field mapping — lat/lon/alt/gs/course/pitch/roll/g_load | Task 3 |
| `_source: 'engine'` on synthetic events | Task 3 |
| Does NOT set `stratuxClient.situation` property | Task 3 |
| Does NOT reset `stratuxClient._staleTimer` | Task 3 |
| Stops injecting when `stratuxClient.stale` becomes false | Task 3 |
| DiagLog at bridge start/stop | Task 3 |
| EngineGpsBridge initialized in app.js after engineClient | Task 4 |
| `get active()` drives pill state | Task 4, 6 |
| CSS `.active-degraded` amber rule | Task 5 |
| CSS `#gps-diag-panel` + `.visible` | Task 5 |
| Amber pill `ENG GPS` when bridge active | Task 6 |
| Green pill state unchanged | Task 6 |
| Auto-dismiss panel when GPS resolves | Task 6 |
| Panel: status line, last-10 gps/stratux log, fix button, settings button | Task 6 |
| Fix button: USE STRATUX / RESET / GPS SETTINGS context logic | Task 6 |
| Tap pill to toggle panel | Task 6 |
| Build checklist: ownship within 30s, amber test, auto-dismiss | Task 7 |
