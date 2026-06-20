# GPS Reliability — Design Spec
**Date:** 2026-04-27  
**Status:** Approved

---

## Problem Statement

On 2026-04-27 the ownship icon was absent for an entire flight. Flight data confirmed: `ws_traffic: OPEN` for all 173,575 rows, `ws_sit: CLOSED` for every row, `own_fix: empty` throughout. The engine monitor CSV had correct GPS throughout (Pi → Stratux HTTP → engine monitor → CSV), proving the hardware was fine.

Root cause: a startup race condition in `stratux-client.js`. The situation WS and traffic WS connect simultaneously at app launch. If the situation WS closes before the traffic WS opens, the `onclose` guard (`if this._trafficWs?.readyState === WebSocket.OPEN`) evaluates false and no reconnect is ever scheduled. Traffic opens and stays open; situation stays dead for the entire flight with no recovery.

ForeFlight was unaffected because it uses GDL90 UDP broadcast — a completely separate protocol that shares no code path with FlyTab's WebSocket connections.

Secondary confirmed bug: `gps-source.js` `_startInternal()` handles watchPosition error codes 1 (PERMISSION_DENIED) and 2 (POSITION_UNAVAILABLE) but silently ignores code 3 (TIMEOUT). On a WiFi-only device with no GPS chip, watchPosition times out repeatedly, `_suppressGpsSituation` stays true, and Stratux situation data never reaches the map.

---

## Solution: Three Layers

### Layer 1 — Race Condition Fix (`stratux-client.js`)

**File:** `web/shared/stratux-client.js`  
**Method:** `_setConnected(state)`

When traffic WS connects (`state === true`), immediately check if the situation WS is CLOSED and reconnect it. This closes the gap where situation loses the startup race.

```javascript
if (state) {
    this._resetStaleTimer();
    // Rescue situation WS if it lost the startup race
    if (!this._situationWs || this._situationWs.readyState === WebSocket.CLOSED) {
        this._connectSituation();
    }
}
```

Also fix `gps-source.js` `_startInternal()`: handle error code 3 (TIMEOUT) with a consecutive-timeout counter. After 2 consecutive timeouts, call `_fallbackToStratux()`. Reset counter on successful position fix.

```javascript
// Add to constructor:
this._gpsTimeoutCount = 0;

// In error callback, add:
if (err.code === 3) {
    this._gpsTimeoutCount++;
    if (this._gpsTimeoutCount >= 2) {
        this._stopInternal();
        this._fallbackToStratux();
    }
}
// In success callback, add:
this._gpsTimeoutCount = 0;
```

---

### Layer 2 — Engine GPS Bridge (`engine-gps-bridge.js`)

**New file:** `web/shared/engine-gps-bridge.js`  
**Loaded in:** `web/index.html` after `engine-client.js` and before cockpit components

A small, self-contained class that monitors `stratuxClient.stale` and injects synthetic `stratux:situation` events from `engineClient.lastData` when the situation WS is unavailable. **Read-only access to engine client — zero changes to engine client code or state.**

#### Injection conditions (ALL must be true):
- `stratuxClient.stale === true` (situation WS not delivering)
- `engineClient.lastData` is not null
- `engineClient.stale === false` (engine data is fresh)
- `engineClient.lastData.latitude != null && engineClient.lastData.longitude != null`

#### Field mapping (explicit — no implicit assumptions):

| Situation field | Engine field | Notes |
|---|---|---|
| `lat` | `lastData.latitude` | decimal degrees |
| `lon` | `lastData.longitude` | decimal degrees |
| `alt_msl` | `lastData.gps_altitude` | feet |
| `alt_baro` | `lastData.gps_altitude` | fallback, no baro from engine |
| `ground_speed` | `lastData.ground_speed` | knots |
| `true_course` | `lastData.course` | degrees |
| `pitch` | `lastData.pitch` | degrees |
| `roll` | `lastData.bank` | **bank→roll rename** |
| `g_load` | `lastData.acc_vert` | **acc_vert→g_load rename** |
| `gps_fix_quality` | *(synthesized)* | 1 when lat/lon present, else 0 |
| `gps_sats` | *(absent)* | null |
| `vertical_speed` | *(absent)* | 0 |
| `_source` | *(synthesized)* | `'engine'` — marks synthetic origin |

#### Behavior:
- Listens to `engine:data` events. On each event, if injection conditions are met, dispatches `stratux:situation` on the stratuxClient EventTarget.
- Does NOT set `stratuxClient.situation` property — the stale flag and WS state remain accurate.
- Does NOT reset `stratuxClient._staleTimer` — stale remains true, which is correct.
- Exposes `get active()` — returns true while injecting. `app.js` reads this to drive the amber GPS pill state.
- When `stratuxClient.stale` becomes false (WS recovers), stops injecting immediately; real situation events take over.
- Logs injection start/stop to DiagLog category `gps`.

#### Initialization (in `app.js`):
```javascript
// After engine client and stratux client are initialized:
this.engineGpsBridge = new EngineGpsBridge(this.stratuxClient, this.engineClient);
this.engineGpsBridge.start();
```

#### Engine client is unaffected:
- No changes to `engine-client.js`
- No changes to `engine_monitor.py`
- Bridge only reads `engineClient.lastData` and listens to `engine:data` events
- Engine WS, HTTP fallback, stale detection, reconnect logic — all unchanged

---

### Layer 3 — GPS Unavailability Notification (`app.js`, `style.css`)

**Files:** `web/app.js`, `web/style.css`

Extend the existing red GPS pill (`.status-gps`) to show a diagnostic panel when tapped. No new DOM structure for the pill itself — it already turns red and shows `STX GPS`.

#### GPS pill states:

| Condition | Pill appearance | Panel available |
|---|---|---|
| Stratux WS live, fix quality ≥ 1 | Green `STX GPS FIX 8sv` | No |
| Engine bridge active (stale WS, engine GPS good) | Amber `ENG GPS` | Yes — degraded |
| Stratux connected, fix quality = 0 | Red `STX GPS` | Yes — no fix |
| Situation WS closed, engine also unavailable | Red `STX GPS` | Yes — full error |

#### Panel content (on tap):

The panel is a `<div id="gps-diag-panel">` inserted in the DOM immediately after the status bar and before the map container. It renders below the status bar, above the map, pushing map content down (not overlaying it). It stays open until tapped again or GPS resolves. It does NOT auto-open — the pilot taps when ready.

**Panel sections:**
1. **Status line** — one sentence: e.g. "Situation WS closed — engine GPS active" or "No GPS fix from Stratux — WS connected"
2. **GPS log** — last 10 DiagLog entries where `cat === 'gps' || cat === 'stratux'`, newest first, monospace, timestamps
3. **Fix button** — context-sensitive, single action:
   - If `gps_source === 'internal'` AND Stratux has fix: `USE STRATUX GPS` — calls `gpsSource.setSource('stratux')`
   - If `gps_source === 'auto'` AND stuck in internal fallback: `RESET GPS SOURCE` — calls `gpsSource.setSource('auto')` to restart auto-detection
   - Otherwise: `GPS SETTINGS` — opens config editor GPS section
4. **Settings link** — always present, secondary button, opens config editor

#### Amber state (engine bridge active):
When `sit._source === 'engine'` in the status monitor, the pill shows amber `ENG GPS` with `.active-degraded` CSS class (amber background). Panel shows: "Situation WS unavailable — position from engine monitor. Stratux reconnecting."

#### Panel dismissal:
- Tap pill again
- GPS resolves (situation WS recovers and delivers fix_quality > 0) — panel auto-collapses, pill goes green

#### CSS additions:
```css
.status-gps.active-degraded { background: #664400; color: #ffcc44; }

#gps-diag-panel {
    display: none;
    background: #1a0000;
    border-bottom: 2px solid #cc2200;
    padding: 10px 12px;
    font-family: monospace;
    font-size: 11px;
}
#gps-diag-panel.visible { display: block; }
```

---

## What Is Not Changed

- `engine-client.js` — untouched
- `engine_monitor.py` — untouched  
- `map.js` `_updateOwnship` — untouched (receives synthetic events transparently)
- `instrument-strip.js` — untouched (receives synthetic events transparently)
- `flight-recorder.js` — untouched (already uses engine GPS via `eng?.longitude`)
- `gps-source.js` auto-fallback logic — untouched except timeout counter addition
- All cockpit components — untouched

---

## Build & Test Requirements

Every build must verify ownship before shipping. Add to build checklist:

1. Launch app on tablet connected to Stratux WiFi
2. Ownship icon appears on map within 30 seconds
3. GPS pill is green (active)
4. Kill and restart app — ownship reappears within 30 seconds
5. Simulate situation WS failure (use ADB remote debugging → DevTools → Application → WebSockets → close the `/situation` socket; engine client stays live since engine monitor runs on same Pi): GPS pill turns amber `ENG GPS`, ownship remains visible
6. Tap GPS pill — diagnostic panel opens, shows log entries
7. Reload app — panel auto-collapses once situation WS reconnects and delivers fix

---

## Files Changed

| File | Change |
|---|---|
| `web/shared/stratux-client.js` | 3-line fix in `_setConnected` |
| `web/shared/gps-source.js` | Timeout counter + `_gpsTimeoutCount` in constructor/callbacks |
| `web/shared/engine-gps-bridge.js` | **New file** |
| `web/index.html` | Add `<script>` for `engine-gps-bridge.js` |
| `web/app.js` | Instantiate `EngineGpsBridge`, GPS pill tap handler, panel render |
| `web/style.css` | `.active-degraded`, `#gps-diag-panel` |
