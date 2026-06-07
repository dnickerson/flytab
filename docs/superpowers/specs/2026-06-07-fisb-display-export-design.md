# FIS-B Display Completeness & Flight Export Design

**Date:** 2026-06-07  
**Status:** Approved  
**Repos:** `~/flytab`, `~/flytab-debrief`

## Problem Statement

Stratux received 2228 NEXRAD blocks, 2111 METARs, 717 TAFs, 132 PIREPs, 31 SIGMETs, 1568 NOTAMs, and 2569 other FIS-B products during a flight on 2026-06-07. Post-flight inspection revealed three display gaps and no mechanism to persist FIS-B data for post-flight review or replay. This spec covers five targeted fixes:

1. PIREP coordinate loss (async race)
2. NEXRAD snapshot captures empty frames
3. CWA has no persistent map element
4. New: `FisbLogger` — persist all FIS-B data to a `_weather.ndjson` companion file
5. New: fly-debrief weather replay layer

**Hard constraint:** The tablet is on Stratux WiFi in flight and has no internet access. All data comes from Stratux (FIS-B) or the Pi (engine monitor). Features requiring external APIs must pre-fetch on the ground.

---

## Section 1 — Architecture Overview

### FlyTab changes (`web/shared/fisb-client.js`, `web/cockpit/fisb-nexrad.js`, `web/cockpit/fisb-weather.js`)

- Fix three display bugs (Sections 2–4 below)
- Add `FisbLogger` class that taps into the existing event bus and writes `_weather.ndjson` via the NanoHTTPD PUT+append endpoint already used by the logbook

### fly-debrief changes (`~/flytab-debrief`)

- `debrief-server.py` serves `_weather.ndjson` alongside existing companions
- `js/replay.js` loads the weather file and renders a time-windowed weather layer as the scrubber moves

No new IDB stores, no new server endpoints on the Pi, no internet calls in-flight.

---

## Section 2 — Fix: PIREP Coordinate Loss

**Root cause:** `_handlePirep()` in `fisb-client.js` is `async` (it awaits a NASR VOR lookup for VOR-relative position strings like `/OV BNA090025/`), but its call site in `_handleWeather()` does not `await` it. The `fisb:pirep` event fires before the coordinate lookup resolves. 64 of 101 PIREPs use VOR-relative format and emit with `lat: null, lon: null`.

**Fix:**

```js
// fisb-client.js _handleWeather()
case 'PIREP':
    await this._handlePirep(msg);   // was: this._handlePirep(msg)
    break;
```

**Fallback:** If the VOR lookup fails (station not in NASR), log the PIREP with `lat: null, lon: null` and populate `location` with the raw position string (e.g., `"BNA090025"`). The entry is still logged in `_weather.ndjson` and displayed in the text list; it just has no map pin.

**Verification:** After fix, inspect `fisbClient.pireps` via CDP — entries previously null-coord should have resolved lat/lon. Check count against Stratux's reported 132.

---

## Section 3 — Fix: NEXRAD Snapshot Captures Empty Frames

**Root cause:** `fisb-nexrad.js` snapshots the active block map every 10 minutes on a fixed timer. Blocks purge after 15 minutes. If the timer fires during a reception gap, it writes `blocks: {}` to IDB. All 3 IDB frames from today's flight were empty, even though NEXRAD was visually confirmed working.

**Fix — two sub-changes:**

1. **Skip empty snapshots:** In `_snapshot()`, return early if `Object.keys(this._blocks).length === 0`.

2. **Snapshot before purge:** In `_purgeOldBlocks()`, before removing the last block, call `_snapshot()` first so there is always at least one non-empty frame persisted.

```js
_purgeOldBlocks(now) {
    const cutoff = now - this._maxAgeMs;
    let removed = 0;
    for (const key of Object.keys(this._blocks)) {
        if (this._blocks[key].received_at < cutoff) {
            // If this is the last block, snapshot before purging
            if (Object.keys(this._blocks).length === 1) this._snapshot();
            delete this._blocks[key];
            removed++;
        }
    }
    return removed;
}
```

**Verification:** Post-flight IDB inspection should show at least one frame with non-empty `blocks`.

---

## Section 4 — Fix: CWA Has No Persistent Map Element

**Root cause:** `_showCwaAlert()` in `fisb-weather.js` fires a toast only. The `points[]` array from the CWA is parsed but never rendered on the map.

**Fix:** After the toast, add a Leaflet polygon using `cwa.points[]`. Use the existing touch-handling pattern (custom `touchstart`/`touchend` on map container, SVG CTM hit-test) consistent with SIGMET/AIRMET rendering. Expire and remove the polygon when `received_at + 7200s` passes.

**Styling:** Distinct from SIGMET (which is red/orange). Use `#ff6600` stroke, 20% fill opacity — CWAs are smaller, more immediate than SIGMETs.

**Popup content:** Raw CWA text with expiry time.

**Close button:** 44×44px per touch target standard.

---

## Section 5 — FisbLogger: Weather NDJSON Export

### Purpose

Persist all FIS-B data received in flight to a companion file that can be reviewed post-flight and replayed in fly-debrief.

### File location and naming

```
~/flights/YYYYMMDD_DEP-DEST_weather.ndjson
```

Same naming convention as `_traffic.ndjson`. The logbook already writes the 1Hz CSV; `FisbLogger` appends to the weather companion via the same NanoHTTPD PUT+append endpoint.

### Architecture

`FisbLogger` is a new class in `web/shared/fisb-logger.js`. It:
- Listens to the existing FlyTab event bus for all `fisb:*` events
- Writes a header line when the flight starts (when `logbook` fires `flight:start`)
- Appends one NDJSON line per event with `t = Math.floor((Date.now() - t0) / 1000)`
- Stops writing on `flight:end`

`FisbLogger` is instantiated in `app.js` alongside the other cockpit modules. No changes to `fisb-client.js` or `fisb-nexrad.js` event dispatch.

### NDJSON Schema

**Header line (first line):**
```json
{"version":1,"flight":"20260607_KLKR-KLKR","dep_at":"2026-06-07T14:32:00Z","t0":1780844000}
```

`t0` is Unix epoch seconds at flight start. All subsequent `t` values are seconds from `t0`.

**NEXRAD** — one entry per incoming message, one block array per message:
```json
{"t":312,"type":"nexrad","blocks":[
  {"lat":35.12,"lon":-80.23,"h":0.5,"w":0.5,
   "intensity":[3,4,2,0,5],"radarType":63,"scale":0}
],"dataTime":1780848128108}
```
`dataTime` is `msg.LocaltimeReceived` epoch ms — used in debrief to show data age at each scrub position.

**METAR:**
```json
{"t":45,"type":"metar","icao":"KLKR","raw":"KLKR 071556Z...",
 "observed_at":"2026-06-07T15:56:00Z","cat":"VFR",
 "wind_dir":270,"wind_speed":8,"wind_gust":null,"wind_variable":false,
 "visibility_sm":10,"visibility_plus":false,"ceiling_ft":null,
 "temp_c":22,"dewpoint_c":14,"altimeter":29.92,
 "cb_skies":[],"at_station_ts":false,
 "thunderstorm_activity":[],"cb_directions":[]}
```

**PIREP:**
```json
{"t":180,"type":"pirep","lat":34.5,"lon":-80.1,"altitude":8500,
 "pirepType":"turbulence","severity":3,"urgent":false,"raw":"UA /OV..."}
```
`lat`/`lon` may be null if VOR lookup failed; `raw` always present.

**SIGMET:**
```json
{"t":200,"type":"sigmet","sigmetType":"convective",
 "points":[[35.1,-80.2],[36.0,-79.5]],"location":"KKCI",
 "expires_at":"2026-06-07T18:00:00Z","raw":"SIGMET GOLF 8..."}
```

**AIRMET:**
```json
{"t":201,"type":"airmet","airmetType":"tango",
 "points":[[34.9,-81.0],[35.5,-80.0]],"location":"KMKC",
 "expires_at":"2026-06-07T17:00:00Z","raw":"AIRMET TANGO..."}
```

**NOTAM (binary FIS-B — pre NMS-API enrichment):**
```json
{"t":90,"type":"notam","pid":8,"tfr":true,
 "icao":null,"lat":null,"lon":null,
 "points":[],"radius_nm":null,
 "expires_at":null,"raw":"{\"ProductID\":8,\"APDU\":\"...base64...\"}"}
```

**NOTAM (after NMS-API enrichment — future state):**
```json
{"t":90,"type":"notam","pid":8,"tfr":true,
 "icao":"KCLT","lat":35.21,"lon":-80.95,
 "points":[],"radius_nm":5,
 "expires_at":"2026-06-07T20:00:00Z","raw":"!CLT 06/047 CLT..."}
```

**Winds aloft:**
```json
{"t":60,"type":"winds","station":"GSP","alt":6000,
 "dir":270,"spd":15,"temp":5,
 "lat":34.9,"lon":-82.2}
```
`lat`/`lon` added after async NASR lookup; omitted if not resolved.

**CWA:**
```json
{"t":400,"type":"cwa","points":[[35.0,-81.0],[35.5,-80.5]],
 "raw":"MKC5 CWA 071610-071810..."}
```

---

## Section 6 — fly-debrief Weather Replay

### Server change (`debrief-server.py`)

`GET /api/flights/{name}` response already includes `traffic` companion path. Add `weather` key pointing to the `_weather.ndjson` companion if it exists; omit the key if absent (backward-compatible with pre-export flights).

### Client change (`js/replay.js`)

**Data loading:** Load `_weather.ndjson` once at flight load alongside the traffic file. Parse header line for `t0`. Build per-type arrays sorted by `t`.

**Time-windowed display:** On every scrubber tick to time T, recompute visible weather:

| Type | Condition to show |
|------|-------------------|
| NEXRAD | `t ≤ T` AND `T - t < 900` (15-min window, matches FlyTab purge) |
| METAR | `t ≤ T` — latest entry per ICAO |
| PIREP | `t ≤ T` AND `T - t < 3600` (1-hr window) |
| SIGMET/AIRMET | `t ≤ T` AND before `expires_at` (or `T - t < 10800` if no expiry) |
| CWA | `t ≤ T` AND `T - t < 7200` (2-hr window) |
| Winds | `t ≤ T` — latest per station+altitude combination |
| NOTAM | `t ≤ T` AND before `expires_at` (or `T - t < 86400` if no expiry) |

**Rendering:**

- **NEXRAD:** Canvas overlay using same intensity→color mapping as `fisb-nexrad.js`. Each block is a colored rectangle. At 18 frames × 700 blocks, renders as a single canvas pass — not individual Leaflet layers.
- **METAR:** Small circle marker at station position, colored by `cat`: VFR=green, MVFR=blue, IFR=red, LIFR=magenta.
- **PIREP:** Diamond marker at `lat`/`lon`, colored by severity 1–5 (green→yellow→red). Skip if `lat` null.
- **SIGMET/CWA:** Filled Leaflet polygon, SIGMET=`#cc2200` / CWA=`#ff6600`, 30% fill opacity.
- **AIRMET:** Filled Leaflet polygon, `#ccaa00`, 25% fill opacity.
- **Winds:** Arrow at station position, rotated to wind direction, labeled `{spd}kt / {alt}ft`.
- **NOTAM TFR:** Dashed red circle at `lat`/`lon` with `radius_nm`. Skip if `lat` null.

**Layer toggle panel:** Sidebar checkboxes, one per weather type. All default ON except winds. State persisted to `localStorage`.

**Performance:** For NEXRAD, a canvas overlay redraws on every scrubber tick. Throttle redraws to 100ms minimum interval to avoid jank during fast scrubbing.

---

## Files Changed

### FlyTab (`~/flytab`)

| File | Change |
|------|--------|
| `web/shared/fisb-client.js` | `await _handlePirep()` at call site |
| `web/cockpit/fisb-nexrad.js` | Skip empty snapshots; snapshot before last-block purge |
| `web/cockpit/fisb-weather.js` | CWA polygon rendering with expiry |
| `web/shared/fisb-logger.js` | New — `FisbLogger` class |
| `web/app.js` | Instantiate `FisbLogger`; increment `FLYTAB_VERSION` |
| `web/index.html` | Add `<script src="shared/fisb-logger.js">` |
| `docs/user-manual.md` | Document weather export and CWA map display |

### fly-debrief (`~/flytab-debrief`)

| File | Change |
|------|--------|
| `debrief-server.py` | Add `weather` companion to flight response |
| `js/replay.js` | Load `_weather.ndjson`; time-windowed weather rendering |
| `index.html` | Weather layer toggle panel in sidebar |
| `css/style.css` | Styles for weather toggle panel and map markers |
