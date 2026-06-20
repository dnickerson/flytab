# Stratux Reconnect & Recording Gap Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a permanent GPS-suppression stuck state that causes flight recordings to develop a large gap after Stratux is powered off between legs (e.g., fuel stop), and auto-stop the recording cleanly when both GPS and engine data are absent for 2+ minutes so each flight leg produces a separate CSV file.

**Architecture:** Three coordinated fixes across three files. (1) `stratux-client.js` moves its stale-timer reset before the GPS-suppress guard so Stratux reconnect is detected even when `_suppressGpsSituation = true`, and dispatches a new `stratux:fresh` event. (2) `gps-source.js` listens for `stratux:fresh` to deactivate the fallback. (3) `flight-recorder.js` adds a 2-minute gap timer: if both GPS and engine data are absent for 2 consecutive minutes, the recording auto-stops cleanly — covering the fuel-stop scenario where the pilot shuts Stratux down between legs.

**Tech Stack:** Vanilla JavaScript, no bundler. All files loaded via `<script>` tags in `web/index.html`. No automated test coverage for these files (they are not in `web/shared/planning/`). Verification is via DiagLog observation and live device testing.

---

## Root Cause (context for the implementer)

When Stratux is powered off between flight legs:

1. UDP situation messages stop → 5-second stale timer fires → `stratux:stale` → `GpsSource._activateFallback()` sets `_suppressGpsSituation = true`
2. `_handleSituation` now returns early **before** the stale-timer reset code at lines 386-391, so when Stratux boots back up and UDP resumes, the stale state is never cleared
3. `stratux:connect` requires `_connected` to cycle false→true, but `_connected` never went false (the traffic WS may have reopened while situation WS was still CLOSING, hitting the early-return in `_setConnected`)
4. `_deactivateFallback()` is never called → `_suppressGpsSituation = true` permanently → all subsequent Stratux GPS events discarded for the rest of the flight → 32-minute recording gap

The two bugs are independent: the stale-timer placement is the primary recovery bug; the `_scheduleTrafficReconnect` condition is a secondary race that can leave `_connected = true` through a restart cycle.

---

## Files Changed

| File | Change |
|------|--------|
| `web/shared/stratux-client.js` | Move stale reset before suppress guard; add `stratux:fresh` event; fix `_scheduleTrafficReconnect` |
| `web/shared/gps-source.js` | Add `_onStratuxFresh` listener; deactivate fallback on `stratux:fresh` |
| `web/cockpit/flight-recorder.js` | Add `_gapTimer`; auto-stop after 2-minute data gap |
| `docs/user-manual.md` | Document per-leg recording split |
| `web/app.js` | Bump `FLYTAB_VERSION` |

---

## Task 1 — Fix `_handleSituation` stale-timer placement and `stratux:fresh` event

**Files:**
- Modify: `web/shared/stratux-client.js` — `_handleSituation` (lines 341–392) and `_scheduleTrafficReconnect` (lines 490–511)

### What to change

**`_handleSituation`** currently resets the stale timer at the **bottom** of the function, after the `if (this._suppressGpsSituation) return;` guard. This means the reset is unreachable when suppression is active. Move it to the **top** and add recovery logic.

**`_scheduleTrafficReconnect`** currently calls `_setConnected(false)` only when the situation WS is also down — a race condition. Remove that condition.

- [ ] **Step 1: Edit `_handleSituation` in `web/shared/stratux-client.js`**

Replace the entire `_handleSituation` method (lines 341–392). The new version:
- Moves the stale-timer reset to the top (runs unconditionally)
- Captures `wasStale` before resetting
- If data resumes after a stale period while `_connected = true`, dispatches `stratux:fresh`
- Removes the duplicate stale-timer reset from the bottom

```javascript
    _handleSituation(msg) {
        // Always reset stale timer first — even during GPS suppression — so a Stratux
        // power-off/restart recovers without requiring a full WebSocket connect cycle.
        const wasStale = this._stale;
        this._stale = false;
        clearTimeout(this._staleTimer);
        this._staleTimer = setTimeout(() => {
            this._stale = true;
            this.dispatchEvent(new CustomEvent('stratux:stale', { detail: { ageMs: 5000 } }));
        }, 5000);

        // When internal GPS is active, only extract AHRS data from Stratux —
        // do NOT overwrite situation or dispatch event (GpsSource handles that).
        if (this._suppressGpsSituation) {
            this._lastStratuxAhrs = {
                alt_baro: msg.BaroPressureAltitude,
                pitch: msg.AHRSPitch,
                roll: msg.AHRSRoll,
                g_load: msg.AHRSGLoad,
                g_load_min: msg.AHRSGLoadMin,
                g_load_max: msg.AHRSGLoadMax,
            };
            // Stratux data resumed after a stale period while still connected —
            // fire stratux:fresh so GpsSource can deactivate the GPS fallback.
            if (wasStale && this._connected) {
                if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', 'stratux:fresh — data resumed after stale while connected');
                this.dispatchEvent(new CustomEvent('stratux:fresh'));
            }
            return;
        }

        const prevQuality = this.situation?.gps_fix_quality;
        this.situation = {
            lat: msg.GPSLatitude,
            lon: msg.GPSLongitude,
            alt_msl: msg.GPSAltitudeMSL,
            alt_baro: msg.BaroPressureAltitude,
            ground_speed: msg.GPSGroundSpeed,
            true_course: msg.GPSTrueCourse,
            vertical_speed: msg.GPSVerticalSpeed,
            gps_fix_quality: msg.GPSFixQuality,
            gps_sats: msg.GPSSatellites,
            gps_sats_seen: msg.GPSSatellitesSeen,
            pitch: msg.AHRSPitch,
            roll: msg.AHRSRoll,
            g_load: msg.AHRSGLoad,
            g_load_min: msg.AHRSGLoadMin,
            g_load_max: msg.AHRSGLoadMax,
            timestamp: Date.now(),
        };
        if (typeof DiagLog !== 'undefined') {
            if (prevQuality === undefined) {
                DiagLog.log('stratux', `First situation: fix=${msg.GPSFixQuality} lat=${msg.GPSLatitude} lon=${msg.GPSLongitude} sats=${msg.GPSSatellites}/${msg.GPSSatellitesSeen}`);
            } else if (prevQuality !== msg.GPSFixQuality) {
                DiagLog.log('stratux', `GPS fix changed: ${prevQuality} → ${msg.GPSFixQuality} sats=${msg.GPSSatellites}`);
            }
        }
        this.dispatchEvent(new CustomEvent('stratux:situation', { detail: this.situation }));
        // stale timer already reset at top of this function
    }
```

- [ ] **Step 2: Edit `_scheduleTrafficReconnect` in `web/shared/stratux-client.js`**

Remove the condition that skips `_setConnected(false)` when the situation WS is open. Replace:

```javascript
    _scheduleTrafficReconnect() {
        // Only mark disconnected if situation WS is also down
        if (!this._situationWs || this._situationWs.readyState !== WebSocket.OPEN) {
            this._setConnected(false);
        }
```

With:

```javascript
    _scheduleTrafficReconnect() {
        this._setConnected(false);
```

Leave the rest of `_scheduleTrafficReconnect` (the `_reconnectTimer` block) unchanged.

- [ ] **Step 3: Verify the edit looks correct**

```bash
grep -n "wasStale\|stratux:fresh\|_scheduleTrafficReconnect" /home/dananickerson/flytab/web/shared/stratux-client.js
```

Expected output includes:
- Line with `const wasStale = this._stale;`
- Line with `stratux:fresh`
- `_scheduleTrafficReconnect` followed immediately by `this._setConnected(false);` (no condition)

- [ ] **Step 4: Commit**

```bash
cd /home/dananickerson/flytab
git add web/shared/stratux-client.js
git commit -m "fix(stratux): move stale-timer reset before suppress guard; add stratux:fresh event

When Stratux is powered off and back on, _handleSituation resumed after
the stale event but hit the _suppressGpsSituation early-return before
the stale-timer reset at the bottom of the function. The stale state
was never cleared, stratux:connect never fired, and _deactivateFallback()
was never called — leaving _suppressGpsSituation = true permanently.

Fixes: stale timer now resets unconditionally at the top. A new
stratux:fresh event fires when data resumes after a stale period while
still connected, giving GpsSource a recovery signal independent of the
WebSocket connect/disconnect cycle.

Also removes the situation-WS guard in _scheduleTrafficReconnect that
could leave _connected = true through a power-off/restart race."
```

---

## Task 2 — Add `stratux:fresh` listener in `gps-source.js`

**Files:**
- Modify: `web/shared/gps-source.js` — constructor (line 28–31), `_attachAutoListeners` (lines 94–102), `_detachAutoListeners` (lines 104–112)

- [ ] **Step 1: Add `_onStratuxFresh = null` to the constructor**

In the constructor block that reads:
```javascript
        // Auto-listener references (null when not attached)
        this._onStratuxDisconnect = null;
        this._onStratuxStale = null;
        this._onStratuxConnect = null;
```

Add `this._onStratuxFresh = null;` as the fourth line:
```javascript
        // Auto-listener references (null when not attached)
        this._onStratuxDisconnect = null;
        this._onStratuxStale = null;
        this._onStratuxConnect = null;
        this._onStratuxFresh = null;
```

- [ ] **Step 2: Add `stratux:fresh` subscription in `_attachAutoListeners`**

Replace the entire `_attachAutoListeners` method:

```javascript
    _attachAutoListeners() {
        if (this._onStratuxDisconnect) return; // already attached — idempotent
        this._onStratuxDisconnect = () => this._activateFallback('disconnect');
        this._onStratuxStale      = () => this._activateFallback('stale');
        this._onStratuxConnect    = () => this._deactivateFallback();
        this._onStratuxFresh      = () => { if (this._inFallback) this._deactivateFallback(); };
        this._stratux.addEventListener('stratux:disconnect', this._onStratuxDisconnect);
        this._stratux.addEventListener('stratux:stale',      this._onStratuxStale);
        this._stratux.addEventListener('stratux:connect',    this._onStratuxConnect);
        this._stratux.addEventListener('stratux:fresh',      this._onStratuxFresh);
    }
```

- [ ] **Step 3: Add `stratux:fresh` teardown in `_detachAutoListeners`**

Replace the entire `_detachAutoListeners` method:

```javascript
    _detachAutoListeners() {
        if (!this._onStratuxDisconnect) return;
        this._stratux.removeEventListener('stratux:disconnect', this._onStratuxDisconnect);
        this._stratux.removeEventListener('stratux:stale',      this._onStratuxStale);
        this._stratux.removeEventListener('stratux:connect',    this._onStratuxConnect);
        this._stratux.removeEventListener('stratux:fresh',      this._onStratuxFresh);
        this._onStratuxDisconnect = null;
        this._onStratuxStale      = null;
        this._onStratuxConnect    = null;
        this._onStratuxFresh      = null;
    }
```

- [ ] **Step 4: Verify**

```bash
grep -n "stratux:fresh\|_onStratuxFresh" /home/dananickerson/flytab/web/shared/gps-source.js
```

Expected: four lines — constructor init, `_attachAutoListeners` assignment, `addEventListener`, `removeEventListener`, and null-clear in `_detachAutoListeners` (some will be on same lines).

- [ ] **Step 5: Commit**

```bash
git add web/shared/gps-source.js
git commit -m "fix(gps-source): deactivate fallback on stratux:fresh

When Stratux restarts after a power-off, the new stratux:fresh event
fires as soon as UDP situation data resumes. _deactivateFallback() clears
_suppressGpsSituation so Stratux GPS is restored without requiring a
full WebSocket reconnect cycle."
```

---

## Task 3 — Add 2-minute gap auto-stop to `flight-recorder.js`

**Files:**
- Modify: `web/cockpit/flight-recorder.js` — constructor (line 27), `stop()` (line 144), `_recordRow()` (lines 200–208)

**Background for the implementer:** The flight recorder writes one CSV row per second. If both `hasGps` and `hasEngine` are false simultaneously, `_recordRow` returns early and no row is written — producing a silent gap in the file. When the pilot powers off Stratux for a fuel stop and the Pi engine monitor is also not connected, this condition persists for the entire ground time, creating a multi-minute hole in the recording. The fix: start a 2-minute countdown when both are absent; if data doesn't return, stop the recording cleanly so the first leg has a complete file and the second leg starts fresh.

- [ ] **Step 1: Add `_gapTimer` to the constructor**

Find the block at lines 32–43:
```javascript
        this._recording = false;
        this._fileName = null;
        this._csvBuffer = [];
        this._rowCount = 0;
        this._startTime = null;
        this._flushInterval = null;
        this._recordInterval = null;
        this._trafficFileName = null;
        this._trafficBuffer = [];
        this._trafficInterval = null;
        this._activeTrafficFlush = null;
```

Add `this._gapTimer = null;` after `this._activeTrafficFlush = null;`:

```javascript
        this._recording = false;
        this._fileName = null;
        this._csvBuffer = [];
        this._rowCount = 0;
        this._startTime = null;
        this._flushInterval = null;
        this._recordInterval = null;
        this._trafficFileName = null;
        this._trafficBuffer = [];
        this._trafficInterval = null;
        this._activeTrafficFlush = null;
        this._gapTimer = null;
```

- [ ] **Step 2: Clear `_gapTimer` in `stop()`**

In `stop()`, find the three interval clears at lines 148–150:
```javascript
        if (this._recordInterval) { clearInterval(this._recordInterval); this._recordInterval = null; }
        if (this._flushInterval) { clearInterval(this._flushInterval); this._flushInterval = null; }
        if (this._trafficInterval) { clearInterval(this._trafficInterval); this._trafficInterval = null; }
```

Add a fourth line immediately after:
```javascript
        if (this._recordInterval) { clearInterval(this._recordInterval); this._recordInterval = null; }
        if (this._flushInterval) { clearInterval(this._flushInterval); this._flushInterval = null; }
        if (this._trafficInterval) { clearInterval(this._trafficInterval); this._trafficInterval = null; }
        if (this._gapTimer) { clearTimeout(this._gapTimer); this._gapTimer = null; }
```

- [ ] **Step 3: Add gap timer logic to `_recordRow()`**

Find lines 206–208 in `_recordRow()`:
```javascript
        const hasGps = sit?.lat && sit?.lon && (sit?.gps_fix_quality > 0);
        const hasEngine = !!eng;
        if (!hasGps && !hasEngine) return;
```

Replace with:
```javascript
        const hasGps = sit?.lat && sit?.lon && (sit?.gps_fix_quality > 0);
        const hasEngine = !!eng;
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
```

- [ ] **Step 4: Verify the edit**

```bash
grep -n "_gapTimer" /home/dananickerson/flytab/web/cockpit/flight-recorder.js
```

Expected: five lines — constructor init, `stop()` clear, gap timer start in `_recordRow`, gap timer cancel in `_recordRow`, and the `return` inside the no-data branch.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/flight-recorder.js
git commit -m "fix(recorder): auto-stop after 2-min data gap (fuel stop / Stratux power-off)

When both GPS and engine data are absent for 2 consecutive minutes, the
recording auto-stops and flushes cleanly. This covers the multi-leg
scenario where the pilot powers off Stratux during a fuel stop: the
first leg produces a complete recording and the second leg starts a
fresh one on the next engine start.

A sub-2-minute gap (brief WiFi glitch) cancels the timer and continues
normally."
```

---

## Task 4 — Update user manual and build

**Files:**
- Modify: `docs/user-manual.md`
- Modify: `web/app.js` (version bump)

- [ ] **Step 1: Update `docs/user-manual.md`**

Find the Flight Recording section (search for "Flight Recording" or "FlightRecorder"). Add the following under recording behaviour:

```markdown
**Multi-leg flights with a fuel stop:** If you power off the Stratux between
legs, FlyTab will auto-stop the active recording after 2 minutes with no GPS or
engine data. Each flight leg produces its own CSV file. The second leg's
recording starts automatically on the next engine start after Stratux is back up.

If the recording stops, resume is automatic — no pilot action required.
```

- [ ] **Step 2: Bump `FLYTAB_VERSION` in `web/app.js`**

Find the version constant at the top of `web/app.js`:
```javascript
const FLYTAB_VERSION = 'v9.61';
```

Increment to:
```javascript
const FLYTAB_VERSION = 'v9.62';
```

- [ ] **Step 3: Build**

```bash
cd /home/dananickerson/flytab
bash build.sh
```

Expected: build completes, `data/` contains an updated APK. Version name in the build output should read `9.62`.

- [ ] **Step 4: Commit**

```bash
git add docs/user-manual.md web/app.js
git commit -m "docs: document per-leg recording split on fuel stop; bump to v9.62"
```

---

## Verification

After building and installing on the tablet:

**Test A — Fuel stop simulation (primary scenario):**
1. Start FlyTab. Confirm Stratux is connected (GPS badge shows `STX`).
2. Start a recording manually (or let auto-start trigger on engine data).
3. Power off the Stratux (remove power).
4. Wait 3 minutes (past the 2-minute threshold).
5. **Expected**: Recording auto-stops. DiagLog shows `Extended data gap (2 min) — auto-stopping recording`.
6. Power Stratux back on.
7. Wait for Stratux reconnect. DiagLog should show `stratux:fresh — data resumed after stale while connected` and `Auto GPS: Stratux reconnected — reverting to Stratux GPS`.
8. Start a new recording. Confirm GPS badge shows `STX` (not `INT(fb)`).
9. **Expected**: New recording writes rows with valid GPS data, no gap.

**Test B — Brief WiFi glitch (must NOT trigger auto-stop):**
1. Start a recording.
2. Power off Stratux, wait 30 seconds, power back on.
3. **Expected**: Recording continues. No auto-stop. After Stratux reconnects, rows resume normally. The 30-second window appears in the CSV as rows with stale lat/lon (quality 0) or no rows, then normal rows once GPS fix returns.

**Test C — DiagLog event sequence check (both tests):**

Open DiagLog during or after the test. Verify the event sequence for a power-off + restart:
```
stratux: GPS fix changed: 2 → 0  (or stratux:stale fires)
gps: Auto GPS: Stratux stale — activating device GPS fallback
gps: watchPosition registered, waiting for fix...
recorder: Extended data gap (2 min) — auto-stopping recording   ← Test A only
stratux: stratux:fresh — data resumed after stale while connected   ← after Stratux back up
gps: Auto GPS: Stratux reconnected — reverting to Stratux GPS
```
