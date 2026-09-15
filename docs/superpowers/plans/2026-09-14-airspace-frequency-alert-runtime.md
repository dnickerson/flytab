# Airspace Frequency Alert Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the FlyTab-side half of the airspace frequency alert feature — a new module that watches aircraft position, detects predictive approach into Class B/C/D/E airspace or SUA, and shows a non-blocking popup with the controlling frequency (or advisory text), matching ForeFlight's airspace-alert behavior.

**Architecture:** One new module (`web/cockpit/airspace-alert.js`) owns position-tracking, candidate caching, geometry/altitude testing, and the per-airspace state machine; it reads from `NasrDB` (already extended by the companion `flytab-pipeline` plan with `controlling_freq`/`active_times` fields) and from the shared Stratux situation object. A small new shared utility (`web/shared/geo-utils.js`) de-duplicates point-in-polygon logic already triplicated across three classic-script files, extended with a segment-intersection test this feature needs. UI is a `ConvectiveAlerts`-style non-blocking banner, but using design tokens instead of inline styles. Six new config toggles live in the layer panel, backed by `CockpitConfig`.

**Tech Stack:** Vanilla JS, classic `<script>` tags (no bundler, no ES modules outside `web/shared/planning/`), IndexedDB via the existing `NasrDB` wrapper.

**Spec:** `docs/superpowers/specs/2026-09-14-airspace-frequency-alert-design.md`

**Companion plan:** `flytab-pipeline` repo's `docs/superpowers/plans/2026-09-14-airspace-controlling-frequency.md` must ship first (or in parallel) — this plan's `airspace-alert.js` reads the `controlling_freq`/`active_times` fields that plan adds to the NASR bundle. This plan degrades gracefully without them (shows advisory-only content), so it is not strictly blocked, but full behavior needs both.

## Global Constraints

- No new runtime dependencies. No bundler. New files load via `<script>` tags in `web/index.html`, in the existing `web/shared/` → `web/cockpit/` load order.
- All colors via `var(--…)` design tokens (no hardcoded hex), numeric displays use `var(--font-instrument)` weight 900, section labels weight 800, touch targets `var(--touch-min, 56px)` minimum — per this repo's Design Token Standards.
- Config writes go through `CockpitConfig.patch(path, value)`, never `CockpitConfig.set()` (that method doesn't exist on the class — an existing call site at `web/cockpit/layer-panel.js:173` is a latent dead-call bug; do not copy that pattern, and do not fix that pre-existing bug either — out of scope for this plan).
- TRSA is out of scope for this plan (no `trsa` NasrDB store exists yet — blocked on the pipeline-side spike per the spec). This plan implements Class B/C/D/E and SUA only.
- Any change touching `onAirportClick`/`onNavaidClick`/`onFixClick` (`web/app.js`) requires manually re-verifying the airport-tap popup still opens (this repo's Tap Handler Regression Rule) — this plan's new popup is programmatic (GPS-triggered), not tap-triggered, so it must not register any competing tap/click listener on the map; Task 6 includes the required manual check regardless, since the new module still adds a DOM overlay onto the map container.

---

## Task 1: `web/shared/geo-utils.js` — shared point-in-polygon + segment intersection

Three classic-script files each have a near-identical ray-casting point-in-polygon function: `web/cockpit/route-table.js:11-25` (handles both `[lat,lon]` and `{lat,lon}` formats — the best extraction target), `web/cockpit/fisb-weather.js` (~line 420), `web/cockpit/wx-briefing.js` (~line 1887). A fourth implementation exists in `web/shared/planning/planner/avoidance.js:25-35`, but that file is part of the ES-module planning library (loaded via `<script type="module">`, has its own vitest coverage) — consolidating across that module boundary is unrelated-scope risk for this feature, so it is deliberately left as-is. This task consolidates the three classic-script copies only.

**Files:**
- Create: `web/shared/geo-utils.js`
- Modify: `web/cockpit/route-table.js:11-25` (remove local function, delegate to `GeoUtils`)
- Modify: `web/cockpit/fisb-weather.js` (remove local function at ~line 420, delegate to `GeoUtils`)
- Modify: `web/cockpit/wx-briefing.js` (remove local function at ~line 1887, delegate to `GeoUtils`)
- Modify: `web/index.html` (add script tag before `route-table.js`)
- Test: manual (no test framework for `web/cockpit/`/`web/shared/` outside `web/shared/planning/`, per this repo's Build Policy — verified below in Step 5)

**Interfaces:**
- Produces: `GeoUtils.pointInPolygon(lat, lon, boundary)` — same signature/behavior as the existing `_pointInPolygon` functions (accepts `[lat,lon]` or `{lat,lon}` boundary points).
- Produces: `GeoUtils.segmentIntersectsPolygon(lat1, lon1, lat2, lon2, boundary, nSamples = 8)` — new, used by Task 3.

- [ ] **Step 1: Create the shared utility**

```javascript
/**
 * FlyTab — Geometry utilities shared across map/planning features.
 * Classic script (not an ES module) — attaches to window.GeoUtils.
 */
const GeoUtils = {
    /**
     * Ray-casting point-in-polygon test.
     * boundary is [[lat, lon], ...] or [{lat, lon}, ...]
     */
    pointInPolygon(lat, lon, boundary) {
        let inside = false;
        const n = boundary.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const pi = boundary[i], pj = boundary[j];
            const yi = Array.isArray(pi) ? pi[0] : pi.lat;
            const xi = Array.isArray(pi) ? pi[1] : pi.lon;
            const yj = Array.isArray(pj) ? pj[0] : pj.lat;
            const xj = Array.isArray(pj) ? pj[1] : pj.lon;
            if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    },

    /**
     * Does the line segment from (lat1,lon1) to (lat2,lon2) pass through
     * boundary at any point? Samples nSamples interior points plus both
     * endpoints, since a straight-line polygon-edge intersection test is
     * unnecessary complexity for airspace-shelf-sized polygons at typical
     * aircraft speeds — sampling is sufficient and much simpler.
     */
    segmentIntersectsPolygon(lat1, lon1, lat2, lon2, boundary, nSamples = 8) {
        for (let k = 0; k <= nSamples; k++) {
            const t = k / nSamples;
            const lat = lat1 + t * (lat2 - lat1);
            const lon = lon1 + t * (lon2 - lon1);
            if (GeoUtils.pointInPolygon(lat, lon, boundary)) return true;
        }
        return false;
    },
};
```

Save as `web/shared/geo-utils.js`.

- [ ] **Step 2: Wire into `web/index.html`**

Find the line `<script src="./shared/nasr-db.js"></script>` (currently line 79) and add immediately after it:

```html
    <script src="./shared/geo-utils.js"></script>
```

(Placed in the `web/shared/` block, before `web/cockpit/route-table.js` at line 113, so it's available to all three consumers.)

- [ ] **Step 3: Update `route-table.js` to delegate**

In `web/cockpit/route-table.js`, remove the local `_pointInPolygon` function (lines 7-25) and replace every call site in that file (`grep -n "_pointInPolygon(" web/cockpit/route-table.js` to find them) with `GeoUtils.pointInPolygon(...)` using the same arguments.

- [ ] **Step 4: Update `fisb-weather.js` and `wx-briefing.js` to delegate**

For each file: run `grep -n "function _pointInPolygon\|_pointInPolygon(" web/cockpit/fisb-weather.js web/cockpit/wx-briefing.js` to find the exact local function definition and its call sites (line numbers may have shifted since this plan was written). Confirm each local implementation is behaviorally equivalent to the one extracted in Step 1 (same ray-casting algorithm, same boundary format handling) before removing it — if either has diverged in some way (e.g. a bug fix that never made it back to the other copies), preserve that behavior in `GeoUtils.pointInPolygon` instead of silently discarding it. Remove the local function, replace call sites with `GeoUtils.pointInPolygon(...)`.

- [ ] **Step 5: Manual verification**

There's no automated test coverage for `web/cockpit/`. Run `bash build.sh` per this repo's Build Policy (after bumping `FLYTAB_VERSION` in `web/app.js` — see Task 6's final step, or bump it now if running this task standalone), install on the tablet or use the on-device CDP inspector, and exercise one existing feature per modified file: open the route table with a route that crosses known airspace (verifies `route-table.js`'s delegated call), and confirm the FIS-B weather / WX briefing panels that used `_pointInPolygon` still render without console errors (`fisb-weather.js`, `wx-briefing.js`).

- [ ] **Step 6: Commit**

```bash
git add web/shared/geo-utils.js web/index.html web/cockpit/route-table.js web/cockpit/fisb-weather.js web/cockpit/wx-briefing.js
git commit -m "refactor: consolidate point-in-polygon into shared geo-utils.js"
```

---

## Task 2: Fix large-polygon blind spot in `NasrDB.getAirspaceInBounds`/`getSuaInBounds`

**Why this is in scope**: `getAirspaceInBounds`/`getSuaInBounds` (`web/shared/nasr-db.js:406-454`) only return a record if **at least one boundary vertex** falls inside the query box. For a large-radius polygon (e.g. some Class B outer shelves exceed 30nm radius), a query box sized around the aircraft's position (per Task 3's caching design, ~10-20nm margin) can be entirely *inside* the polygon without containing any of its vertices — the query would silently return nothing for airspace the aircraft is actually deep inside. This isn't a new bug introduced by this feature, but this feature is the first caller for whom it's a correctness-breaking gap rather than a rendering nicety (a map layer merely rendering a large shelf slightly late as you pan toward it is cosmetic; an alert silently never firing for a large shelf is the whole feature failing). The fix is purely additive (an extra `||` condition that can only return more matches, never fewer), so it cannot regress the existing map-rendering caller.

**Files:**
- Modify: `web/shared/nasr-db.js:406-454` (`getAirspaceInBounds`, `getSuaInBounds`)

**Interfaces:**
- No signature change — same `(south, west, north, east, limit=500)` params and return shape.

- [ ] **Step 1: Modify `getAirspaceInBounds`**

Change (currently lines 406-428):

```javascript
    async getAirspaceInBounds(south, west, north, east, limit = 500) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('airspace', 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const results = [];
            const req = tx.objectStore('airspace').openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || results.length >= limit) { resolve(results); return; }
                const v = cursor.value;
                const boundary = v.boundary || v.points || [];
                const inBounds = boundary.some(pt => {
                    const lat = pt[0] || pt.lat;
                    const lon = pt[1] || pt.lon;
                    return lat >= south && lat <= north && lon >= west && lon <= east;
                });
                if (inBounds) results.push(v);
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }
```

to:

```javascript
    async getAirspaceInBounds(south, west, north, east, limit = 500) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('airspace', 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const results = [];
            const req = tx.objectStore('airspace').openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || results.length >= limit) { resolve(results); return; }
                const v = cursor.value;
                const boundary = v.boundary || v.points || [];
                const vertexInBounds = boundary.some(pt => {
                    const lat = pt[0] || pt.lat;
                    const lon = pt[1] || pt.lon;
                    return lat >= south && lat <= north && lon >= west && lon <= east;
                });
                // A vertex inside the query box catches most overlaps, but a
                // polygon much larger than the box (e.g. a wide Class B
                // shelf) can fully contain the box without any vertex
                // falling inside it — check the box's center against the
                // polygon too, so large airspace isn't silently missed.
                const centerInPolygon = !vertexInBounds && boundary.length >= 3
                    && typeof GeoUtils !== 'undefined'
                    && GeoUtils.pointInPolygon((south + north) / 2, (west + east) / 2, boundary);
                if (vertexInBounds || centerInPolygon) results.push(v);
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }
```

- [ ] **Step 2: Modify `getSuaInBounds`** the same way

Apply the equivalent change to `getSuaInBounds` (currently lines 433-454), using its existing `boundary = v.boundary || []` and `lat = pt[0], lon = pt[1]` shape (no `.lat`/`.lon` object fallback needed there, per the existing code).

- [ ] **Step 3: Update `web/index.html` load order if needed**

`nasr-db.js` (line 79) now references `GeoUtils` (guarded with `typeof GeoUtils !== 'undefined'` so it doesn't hard-crash if load order is ever wrong, but it should be correct) — confirm `web/shared/geo-utils.js` (added in Task 1, Step 2) loads *before* `web/shared/nasr-db.js` in `web/index.html`, not after. If Task 1 placed it after `nasr-db.js`, move the `<script src="./shared/geo-utils.js"></script>` tag to immediately *before* the `nasr-db.js` line instead.

- [ ] **Step 4: Manual verification**

Run `bash build.sh`, install, and confirm the existing Class B/C/D airspace map layer (`vector-map-layers.js`) still renders correctly panning around a known large Class B area — this change is additive so existing rendering should be unaffected or slightly improved (catching a shelf at the box edge it might have previously missed).

- [ ] **Step 5: Commit**

```bash
git add web/shared/nasr-db.js web/index.html
git commit -m "fix: catch large airspace polygons that fully contain the query box"
```

---

## Task 3: `web/cockpit/airspace-alert.js` — core detection module

This is the largest task. It implements the full runtime detection logic from the spec: position source, candidate caching, segment-intersection trigger, vertical bound check, and the state machine (including the `alerted → not-alerted` abort transition and per-tick evaluation order fixed during spec review).

**Altitude source — resolved, not left as an open risk.** Verified directly against Stratux's own source (`b3nn0/stratux` at the commit this repo's `reference_stratux_source` memory pins, `common/equations.go`, `CalcAltitude()`): `alt_baro` (`BaroPressureAltitude`) is computed as `145366.45 * (1.0 - (press/1013.25)^0.190284) + altOffset` — i.e. **pressure altitude referenced to the fixed standard setting of 1013.25 hPa / 29.92" Hg**, not the current local altimeter setting, plus a static device calibration offset. This means `alt_baro` carries a systematic bias from real airspace floors/ceilings (which pilots fly using the *local* altimeter setting) equal to the difference between standard and local pressure — often 100-300ft on an ordinary day, not a rare edge case. `alt_msl` (`GPSAltitudeMSL`) is GPS-derived geometric MSL, with no such systematic bias (only ordinary GPS vertical error, typically much smaller). **Decision: use `alt_msl` as the primary altitude source, falling back to `alt_baro` only when GPS altitude is unavailable** (better than nothing, but flagged in code as a known-biased fallback).

**Files:**
- Create: `web/cockpit/airspace-alert.js`
- Test: manual (no test framework for `web/cockpit/`)

**Interfaces:**
- Consumes: `GeoUtils.pointInPolygon`, `GeoUtils.segmentIntersectsPolygon` (Task 1).
- Consumes: `NasrDB.getAirspaceInBounds(south, west, north, east, limit)`, `NasrDB.getSuaInBounds(south, west, north, east, limit)` (existing, extended by Task 2).
- Consumes: `stratuxClient.situation` — `{ lat, lon, alt_msl, alt_baro, ground_speed, true_course }` (`web/shared/stratux-client.js:402-419`).
- Consumes: `CockpitConfig.get('airspace_alerts...')` (Task 5).
- Produces: `class AirspaceAlert` with `init(stratuxClient, nasrDb)`, `tick()` (called on a position-update cadence), `destroy()`, and an `onAlert` callback hook consumed by Task 4's UI.

- [ ] **Step 1: Write the module skeleton, position handling, and candidate caching**

```javascript
/**
 * FlyTab — Airspace Frequency Alert
 * Watches aircraft position and predicts approach into Class B/C/D/E
 * airspace or SUA, firing onAlert(airspaceRecord) once per entry.
 * See docs/superpowers/specs/2026-09-14-airspace-frequency-alert-design.md
 */
class AirspaceAlert {
    // Frequency-type priority is decided pipeline-side (flytab-pipeline);
    // this module only consumes the resulting controlling_freq field.
    static LEAD_TIME_MARGIN_NM = 10; // fixed margin added to the query box

    constructor() {
        this._stratux = null;
        this._nasrDb = null;
        this._states = new Map(); // airspace id -> 'alerted' | 'inside'
        this._cachedCandidates = null; // { box: {south,west,north,east}, airspace: [...], sua: [...] }
        this._tickInFlight = false; // re-entrancy guard, see tick()
        this.onAlert = null; // (record, kind: 'airspace'|'sua') => void, set by caller
    }

    init(stratuxClient, nasrDb) {
        this._stratux = stratuxClient;
        this._nasrDb = nasrDb;
    }

    destroy() {
        this._stratux = null;
        this._nasrDb = null;
        this._states.clear();
        this._cachedCandidates = null;
    }

    _altitudeMsl(sit) {
        // alt_msl (GPS geometric MSL) is preferred -- alt_baro is pressure
        // altitude referenced to standard 29.92", which disagrees with the
        // local-altimeter-setting altitudes airspace floors/ceilings are
        // published against by 100-300ft on an ordinary non-standard-
        // pressure day. See Task 3 header for the verified source.
        if (typeof sit.alt_msl === 'number' && !Number.isNaN(sit.alt_msl)) return sit.alt_msl;
        if (typeof sit.alt_baro === 'number' && !Number.isNaN(sit.alt_baro)) return sit.alt_baro;
        return null;
    }

    _nmToDegLat(nm) { return nm / 60; }
    _nmToDegLon(nm, lat) { return nm / (60 * Math.cos(lat * Math.PI / 180) || 1); }

    _boxFor(lat, lon, projLat, projLon, marginNm) {
        const south = Math.min(lat, projLat) - this._nmToDegLat(marginNm);
        const north = Math.max(lat, projLat) + this._nmToDegLat(marginNm);
        const west = Math.min(lon, projLon) - this._nmToDegLon(marginNm, lat);
        const east = Math.max(lon, projLon) + this._nmToDegLon(marginNm, lat);
        return { south, west, north, east };
    }

    _boxContains(box, lat, lon) {
        return lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east;
    }

    async _getCandidates(lat, lon, projLat, projLon) {
        const box = this._boxFor(lat, lon, projLat, projLon, AirspaceAlert.LEAD_TIME_MARGIN_NM);
        const cached = this._cachedCandidates;
        // Re-query if either the current position or the projected position
        // has moved outside the box used for the previous query -- checking
        // current position alone misses a sharp turn that moves the
        // projected point outside stale coverage before current position does.
        if (cached && this._boxContains(cached.box, lat, lon) && this._boxContains(cached.box, projLat, projLon)) {
            return cached;
        }
        const [airspace, sua] = await Promise.all([
            this._nasrDb.getAirspaceInBounds(box.south, box.west, box.north, box.east),
            this._nasrDb.getSuaInBounds(box.south, box.west, box.north, box.east),
        ]);
        this._cachedCandidates = { box, airspace, sua };
        return this._cachedCandidates;
    }
}
```

- [ ] **Step 2: Manual verification of position/caching logic**

Since there's no test framework for `web/cockpit/`, verify this step manually via the browser console (CDP, per this repo's ADB/CDP debug conventions): instantiate `new AirspaceAlert()`, call `_boxFor(40, -75, 40.05, -75.05, 10)` and confirm the returned box's `south`/`north`/`west`/`east` bracket both points with a visible margin (e.g. `south < 40`, `north > 40.05`). Log-check that a second `_getCandidates()` call with the same lat/lon returns the cached object (`===` reference equality) rather than re-querying — add a temporary `console.log` inside the `if (cached && ...)` branch, exercise it, then remove the log before committing.

- [ ] **Step 3: Commit the skeleton**

```bash
git add web/cockpit/airspace-alert.js
git commit -m "feat: add AirspaceAlert module skeleton with position caching"
```

- [ ] **Step 4: Add the trigger logic (segment test + vertical bound check)**

Append to the `AirspaceAlert` class (before the closing brace):

```javascript
    _altitudeInBounds(altMsl, rec) {
        const lower = rec.lower_ft ?? rec.lower ?? 0;
        const upper = rec.upper_ft ?? rec.upper;
        // Fail-open: missing/malformed bounds must not suppress an
        // otherwise-valid lateral match -- an extra popup is a minor
        // nuisance, silently missing a required call is not acceptable.
        if (typeof lower !== 'number' || Number.isNaN(lower)) return true;
        // upper < 0 is not a malformed value -- it's the pipeline's
        // _parse_altitude() sentinel for an AIXM UNLIMITED/UNL ceiling
        // (SUA records only; Class B/C/D/E never emit it). Do not "simplify"
        // this away as redundant with the NaN check above -- doing so would
        // silently suppress alerts for any unlimited-ceiling restricted area.
        if (typeof upper !== 'number' || Number.isNaN(upper) || upper < 0) return altMsl >= lower;
        return altMsl >= lower && altMsl <= upper;
    }

    _evaluateOne(rec, lat, lon, projLat, projLon, altMsl) {
        const boundary = rec.boundary || rec.points || [];
        if (boundary.length < 3) return null;

        const state = this._states.get(rec.id);
        const actuallyInside = GeoUtils.pointInPolygon(lat, lon, boundary)
            && this._altitudeInBounds(altMsl, rec);

        if (state === 'alerted') {
            // Check entry before abort -- both could be true in the same
            // tick (e.g. actual position just entered while the forward
            // projection exits the far side of a narrow shelf); entry wins.
            if (actuallyInside) {
                this._states.set(rec.id, 'inside');
                return null;
            }
            const stillApproaching = GeoUtils.segmentIntersectsPolygon(lat, lon, projLat, projLon, boundary)
                && this._altitudeInBounds(altMsl, rec);
            if (!stillApproaching) {
                this._states.set(rec.id, 'not-alerted');
            }
            return null;
        }

        if (state === 'inside') {
            if (!actuallyInside) this._states.set(rec.id, 'not-alerted'); // exited -> re-armed
            return null;
        }

        // state is 'not-alerted' or unset (first time seeing this airspace)
        if (actuallyInside) {
            // Already inside on first classification (e.g. module just
            // initialized while on the ground at a towered field, or app
            // restarted mid-flight) -- seed straight to 'inside', never fire.
            this._states.set(rec.id, 'inside');
            return null;
        }
        const approaching = GeoUtils.segmentIntersectsPolygon(lat, lon, projLat, projLon, boundary)
            && this._altitudeInBounds(altMsl, rec);
        if (approaching) {
            this._states.set(rec.id, 'alerted');
            return rec;
        }
        return null;
    }
```

- [ ] **Step 5: Manual verification of the state machine**

Via CDP console, exercise `_evaluateOne` directly with a synthetic record (a small square `boundary`, `lower_ft: 0`, `upper_ft: 5000`) and manually stepped `lat`/`lon`/`projLat`/`projLon` values simulating: approach (should return the record once), continued approach without entry (should return `null`, state stays `alerted`), turn-away (segment no longer intersects — confirm a subsequent call after simulating "outside" positions returns to `not-alerted`, verified by checking `this._states.get(rec.id)`), then a fresh approach (should alert again). This exercises the abort-transition bug fix from spec review without needing live GPS.

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/airspace-alert.js
git commit -m "feat: add segment-intersection trigger and state machine to AirspaceAlert"
```

- [ ] **Step 7: Add the `tick()` driver that ties position + candidates + evaluation together**

```javascript
    tick() {
        if (!this._stratux || !this._nasrDb) return;
        if (this._tickInFlight) return; // guard against overlapping async ticks (see below)
        if (!CockpitConfig.get('airspace_alerts.enabled')) return; // live master kill switch, not just a startup gate
        const sit = this._stratux.situation;
        if (!sit || typeof sit.lat !== 'number' || typeof sit.lon !== 'number') return;

        const altMsl = this._altitudeMsl(sit);
        if (altMsl === null) return;

        const leadTimeMin = CockpitConfig.get('airspace_alerts.lead_time_min') ?? 2;
        const groundSpeedKt = sit.ground_speed || 0;
        const trueCourseDeg = sit.true_course || 0;
        const distNm = groundSpeedKt * (leadTimeMin / 60);
        const rad = trueCourseDeg * Math.PI / 180;
        const projLat = sit.lat + this._nmToDegLat(distNm) * Math.cos(rad);
        const projLon = sit.lon + this._nmToDegLon(distNm, sit.lat) * Math.sin(rad);

        // IDB queries inside _getCandidates could in principle take longer
        // than the 1000ms tick interval under device contention -- without
        // this guard, a second tick() could start a second query before the
        // first's .then() resolves, letting two callbacks interleave state
        // machine updates with inconsistent position snapshots.
        this._tickInFlight = true;
        this._getCandidates(sit.lat, sit.lon, projLat, projLon).then(({ airspace, sua }) => {
            const types = CockpitConfig.get('airspace_alerts.types') || {};
            const classEnabled = { B: types.class_b, C: types.class_c, D: types.class_d, E: types.class_e_surface };
            for (const rec of airspace) {
                if (!classEnabled[rec.class]) continue;
                const fired = this._evaluateOne(rec, sit.lat, sit.lon, projLat, projLon, altMsl);
                if (fired && this.onAlert) this.onAlert(fired, 'airspace');
            }
            if (types.sua) {
                for (const rec of sua) {
                    const fired = this._evaluateOne(rec, sit.lat, sit.lon, projLat, projLon, altMsl);
                    if (fired && this.onAlert) this.onAlert(fired, 'sua');
                }
            }
        }).finally(() => { this._tickInFlight = false; });
    }
```

- [ ] **Step 8: Manual verification with `tools/mock-stratux.py`**

Per this repo's mock-Stratux setup (`reference_mock_stratux` convention), run a simulated flight track toward a known Class D airport, with `AirspaceAlert` wired to a temporary `console.log` in place of the real UI (Task 4 not built yet). Confirm `onAlert` fires once as the track approaches, and does not fire again if the track is replayed without a full exit in between (exercises caching + state machine end-to-end with real position updates, not synthetic single-call tests).

- [ ] **Step 9: Commit**

```bash
git add web/cockpit/airspace-alert.js
git commit -m "feat: add tick() driver wiring position, candidates, and config to AirspaceAlert"
```

---

## Task 4: UI popup

**Files:**
- Create: `web/cockpit/airspace-alert-popup.js`
- Modify: `web/style.css` (new `.airspace-alert-popup` rules, tokens only)

**Interfaces:**
- Consumes: nothing new — takes plain data via `show(record, kind)`.
- Produces: `class AirspaceAlertPopup` with `mount(container)`, `show(record, kind)`, `dismiss()`.

- [ ] **Step 1: Build the popup component**

Model structurally on `ConvectiveAlerts` (`web/cockpit/convective-alerts.js:9-41`, absolutely-positioned banner mounted into the map container, `display:none` when empty), but styled with CSS classes and design tokens instead of inline styles, and with a queue (per spec: multiple simultaneous candidates queue rather than stack):

```javascript
/**
 * FlyTab — Airspace Alert Popup
 * Non-blocking banner shown as the aircraft approaches Class B/C/D/E
 * airspace or SUA. Queues multiple simultaneous alerts rather than
 * stacking them on screen.
 */
class AirspaceAlertPopup {
    constructor() {
        this._el = null;
        this._queue = [];
        this._buildDOM();
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'airspace-alert-popup';
        this._el.style.display = 'none';
        this._el.innerHTML = `
            <div class="aap-header">
                <span class="aap-title"></span>
                <button class="aap-dismiss" aria-label="Dismiss">&times;</button>
            </div>
            <div class="aap-freq"></div>
            <div class="aap-advisory"></div>
        `;
        this._el.querySelector('.aap-dismiss').addEventListener('click', () => this._advance());
    }

    mount(container) {
        container.appendChild(this._el);
    }

    show(record, kind) {
        this._queue.push({ record, kind });
        if (this._queue.length === 1) this._render();
    }

    _advance() {
        this._queue.shift();
        if (this._queue.length > 0) this._render();
        else this._el.style.display = 'none';
    }

    _render() {
        const { record, kind } = this._queue[0];
        const titleEl = this._el.querySelector('.aap-title');
        const freqEl = this._el.querySelector('.aap-freq');
        const advisoryEl = this._el.querySelector('.aap-advisory');
        const mandatoryCall = kind === 'airspace' && ['B', 'C', 'D'].includes(record.class);

        titleEl.textContent = mandatoryCall
            ? `Entering Class ${record.class} — ${record.name}`
            : `Approaching ${record.name}`;

        if (record.controlling_freq) {
            freqEl.textContent = `${record.controlling_freq.facility_name} ${record.controlling_freq.freq}`;
            freqEl.style.display = '';
        } else {
            freqEl.style.display = 'none';
        }

        if (kind === 'sua') {
            advisoryEl.textContent = record.active_times
                ? `Active: ${record.active_times}`
                : 'Schedule unknown — verify NOTAMs before entry';
            advisoryEl.style.display = '';
        } else if (!record.controlling_freq) {
            // Class E surface areas frequently sit around non-towered
            // fields -- no controlling_freq there is a permanent, correct
            // absence (find_controlling_airport requires a towered field
            // inside the boundary), not a data-staleness problem. Only
            // B/C/D are essentially guaranteed to have a match when the
            // bundle is current, so "update the bundle" is only honest
            // advice for those classes.
            advisoryEl.textContent = record.class === 'E'
                ? 'No published frequency for this area'
                : 'No frequency data — update NASR bundle';
            advisoryEl.style.display = '';
        } else {
            advisoryEl.style.display = 'none';
        }

        this._el.style.display = '';
    }

    dismiss() {
        this._queue = [];
        this._el.style.display = 'none';
    }
}
```

- [ ] **Step 2: Add design-token CSS**

Append to `web/style.css`:

```css
.airspace-alert-popup {
    position: absolute;
    top: 56px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 950;
    min-width: 320px;
    max-width: 480px;
    background: var(--bg-surface);
    border: 2px solid var(--border-strong);
    border-radius: 8px;
    padding: 12px 16px;
    pointer-events: auto;
}
.airspace-alert-popup .aap-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.airspace-alert-popup .aap-title {
    font-family: var(--font-ui);
    font-weight: 800;
    color: var(--text-secondary);
}
.airspace-alert-popup .aap-dismiss {
    min-width: var(--touch-min, 56px);
    min-height: var(--touch-min, 56px);
    font-size: 24px;
    font-weight: 700;
    background: transparent;
    border: none;
    color: var(--text-secondary);
}
.airspace-alert-popup .aap-freq {
    font-family: var(--font-instrument);
    font-weight: 900;
    font-size: 1.4em;
    color: var(--text-primary);
    margin-top: 4px;
}
.airspace-alert-popup .aap-advisory {
    font-family: var(--font-ui);
    font-weight: 700;
    color: var(--color-caution-on-light);
    margin-top: 4px;
}
```

- [ ] **Step 3: Manual verification**

Via CDP console: `const p = new AirspaceAlertPopup(); p.mount(document.body); p.show({name:'Test Class D', class:'D', controlling_freq:{facility_name:'TEST TWR', freq:'118.3'}}, 'airspace');` — confirm the banner appears styled (not default browser button/div styling), dismiss button is at least 56px, dismissing hides it. Then `p.show(...)` twice before dismissing once — confirm the second queued alert renders after the first is dismissed, not simultaneously.

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/airspace-alert-popup.js web/style.css
git commit -m "feat: add AirspaceAlertPopup UI component"
```

---

## Task 5: Configuration — `cockpit-config.json`, `CockpitConfig` defaults, layer panel toggles

**Files:**
- Modify: `web/shared/cockpit-config.js` (add `airspace_alerts` to `DEFAULTS`, near line 22's `overlays` block)
- Modify: `web/cockpit-config.json` (add explicit `airspace_alerts` section — this repo's deployed config and the JS `DEFAULTS` fallback have drifted apart before, e.g. `map.overlays.sua` exists only in `DEFAULTS` currently and not in the deployed file; be explicit in both to avoid repeating that drift)
- Modify: `web/cockpit/layer-panel.js` (`_buildHtml()` near line 522's Airspace row; wiring block near line 168's `conv-intel` pattern)

**Interfaces:**
- Produces: `CockpitConfig.get('airspace_alerts.enabled')`, `.get('airspace_alerts.lead_time_min')`, `.get('airspace_alerts.types.<class_b|class_c|class_d|class_e_surface|sua>')` — all consumed by Task 3's `tick()`.
- **No `types.trsa` key.** TRSA is out of scope for this plan (Global Constraints) — there is no detection code path for it anywhere in Task 3, so a `trsa` toggle would control nothing. Do not add one; add it in a future plan alongside the actual TRSA detection support, once the companion pipeline plan's TRSA spike resolves.

- [ ] **Step 1: Add defaults to `CockpitConfig.DEFAULTS`**

In `web/shared/cockpit-config.js`, inside `static DEFAULTS = { ... }`, add a new top-level key (alongside `map`, `airportFilter`, etc.):

```javascript
        airspace_alerts: {
            enabled: true,
            lead_time_min: 2,
            types: {
                class_b: true,
                class_c: true,
                class_d: true,
                class_e_surface: false,
                sua: false,
            },
        },
```

- [ ] **Step 2: Add the same section to `web/cockpit-config.json`**

```json
  "airspace_alerts": {
    "enabled": true,
    "lead_time_min": 2,
    "types": {
      "class_b": true,
      "class_c": true,
      "class_d": true,
      "class_e_surface": false,
      "sua": false
    }
  }
```

(Insert as a top-level sibling of the existing `map` key — confirm exact JSON comma placement against the current file content before editing, since this plan doesn't reproduce the entire file.)

- [ ] **Step 3: Add layer panel toggle rows**

In `web/cockpit/layer-panel.js`, inside `_buildHtml()`, after the existing Airspace row (currently around line 525) and before the Restricted/MOA row, add a new accordion section (following the existing `.lp-accordion`/`.lp-accordion-body` structure used elsewhere in the file — confirm the exact section-wrapper markup by viewing a full existing section, since this plan only shows row-level markup). The first row is the master kill switch (`enabled`); the rest are per-type (no `trsa` row — see this task's Interfaces note):

```html
<div class="lp-row">
    <span class="lp-row-label">Airspace Alerts</span>
    <label class="lp-toggle"><input type="checkbox" data-action="airspace-alert-enabled"><span class="lp-toggle-track"></span></label>
</div>
<div class="lp-row lp-row-sub">
    <span class="lp-row-label lp-sub-label">Alert: Class B</span>
    <label class="lp-toggle"><input type="checkbox" data-action="airspace-alert-class_b"><span class="lp-toggle-track"></span></label>
</div>
<div class="lp-row lp-row-sub">
    <span class="lp-row-label lp-sub-label">Alert: Class C</span>
    <label class="lp-toggle"><input type="checkbox" data-action="airspace-alert-class_c"><span class="lp-toggle-track"></span></label>
</div>
<div class="lp-row lp-row-sub">
    <span class="lp-row-label lp-sub-label">Alert: Class D</span>
    <label class="lp-toggle"><input type="checkbox" data-action="airspace-alert-class_d"><span class="lp-toggle-track"></span></label>
</div>
<div class="lp-row lp-row-sub">
    <span class="lp-row-label lp-sub-label">Alert: Class E surface</span>
    <label class="lp-toggle"><input type="checkbox" data-action="airspace-alert-class_e_surface"><span class="lp-toggle-track"></span></label>
</div>
<div class="lp-row lp-row-sub">
    <span class="lp-row-label lp-sub-label">Alert: Restricted/MOA</span>
    <label class="lp-toggle"><input type="checkbox" data-action="airspace-alert-sua"><span class="lp-toggle-track"></span></label>
</div>
```

(`lp-row-sub` matches the existing sub-row convention already used for the Airports section's "Min runway (ft)" row, `web/cockpit/layer-panel.js:499`.)

- [ ] **Step 4: Wire the toggles**

In the wiring section of `layer-panel.js` (following the `conv-intel` pattern at lines 168-176 — same file, later in the method), add:

```javascript
// Wire Airspace Alert master switch
const airspaceAlertEnabledInput = this._panel.querySelector('.lp-toggle input[data-action="airspace-alert-enabled"]');
if (airspaceAlertEnabledInput) {
    airspaceAlertEnabledInput.checked = CockpitConfig.get('airspace_alerts.enabled') ?? false;
    airspaceAlertEnabledInput.addEventListener('change', () => {
        CockpitConfig.patch('airspace_alerts.enabled', airspaceAlertEnabledInput.checked);
    });
}

// Wire Airspace Alert per-type toggles
for (const key of ['class_b', 'class_c', 'class_d', 'class_e_surface', 'sua']) {
    const input = this._panel.querySelector(`.lp-toggle input[data-action="airspace-alert-${key}"]`);
    if (input) {
        input.checked = CockpitConfig.get(`airspace_alerts.types.${key}`) ?? false;
        input.addEventListener('change', () => {
            CockpitConfig.patch(`airspace_alerts.types.${key}`, input.checked);
        });
    }
}
```

(Uses `.patch()`, not `.set()` — see Global Constraints. `tick()`, per Task 3, reads `airspace_alerts.enabled` live on every call, so toggling this master switch takes effect immediately without needing an app restart.)

- [ ] **Step 5: Manual verification**

Run `bash build.sh`, install, open the layer panel, confirm the master "Airspace Alerts" row plus five "Alert: ..." sub-rows appear with correct default states (master on; Class B/C/D on, Class E surface/SUA off), toggle each and confirm `localStorage['flypi_user_cockpit']` (via CDP) reflects the change under `airspace_alerts.enabled`/`airspace_alerts.types.*`, reload the app to confirm the toggle state persists, and confirm toggling the master switch off mid-session (no restart) stops alerts from firing on the next tick.

- [ ] **Step 6: Commit**

```bash
git add web/shared/cockpit-config.js web/cockpit-config.json web/cockpit/layer-panel.js
git commit -m "feat: add airspace_alerts config schema and layer panel toggles"
```

---

## Task 6: Wire everything together in `app.js`, final verification

**Files:**
- Modify: `web/app.js` (instantiate `AirspaceAlert` + `AirspaceAlertPopup`, near the `ConvectiveAlerts` setup at lines 713-737; bump `FLYTAB_VERSION` per Build Policy)

**Interfaces:**
- Consumes: `AirspaceAlert` (Task 3), `AirspaceAlertPopup` (Task 4), `this.stratuxClient`, and the local `nasrDb` variable already in scope throughout `init()` (verified directly: `web/app.js:427-428` creates `const nasrDb = new NasrDB(); this._nasrDb = nasrDb;`, and every subsequent constructor call in `init()` — e.g. `new FisbClient(this.stratuxClient, nasrDb)` at line 673 — passes the local `nasrDb`, not `this._nasrDb`. This plan's new block follows that same established pattern.).

- [ ] **Step 1: Instantiate and wire the module**

In `web/app.js`, near the `ConvectiveAlerts` block (currently lines 713-737), add a new block:

```javascript
// Airspace Frequency Alert
if (typeof AirspaceAlert !== 'undefined' && typeof AirspaceAlertPopup !== 'undefined' && this.stratuxClient) {
    this.airspaceAlert = new AirspaceAlert();
    this.airspaceAlert.init(this.stratuxClient, nasrDb);
    const airspaceAlertPopup = new AirspaceAlertPopup();
    if (this.cockpitMap?.map) {
        airspaceAlertPopup.mount(this.cockpitMap.map.getContainer());
    }
    this.airspaceAlert.onAlert = (record, kind) => airspaceAlertPopup.show(record, kind);
    setInterval(() => this.airspaceAlert.tick(), 1000);
}
```

(The interval always runs — `tick()` itself checks `CockpitConfig.get('airspace_alerts.enabled')` on every call and returns early when disabled, per Task 3. This is deliberately different from the `ConvectiveAlerts` pattern this block is modeled on, which gates `setInterval` on a one-time startup check: that pattern would make the new master kill-switch toggle from Task 5 inert after the first tick, since flipping the config later would never be re-read. Gating inside `tick()` instead makes the toggle live.)

(`setInterval` at 1000ms polls the cached `situation` object rather than subscribing to WebSocket messages directly — verified in `stratux-client.js` that `situation` is a plain object overwritten asynchronously by the WS `onmessage` handler, not a rate the client controls. Polling decouples `tick()`'s cadence from whatever rate Stratux actually broadcasts at, which is the right design here: reading a 1-second-old snapshot on a slightly faster or slower feed doesn't change correctness the way it would for something requiring tight synchronization, so 1000ms doesn't need to match the exact broadcast rate.)

- [ ] **Step 2: Add the script tags to `web/index.html`**

Add, in the `web/cockpit/` block, after `convective-alerts.js` (line 122) and before anything that might reasonably depend on load order (none currently do, but keep alphabetically/logically grouped with other alert-style modules):

```html
    <script src="./cockpit/airspace-alert.js"></script>
    <script src="./cockpit/airspace-alert-popup.js"></script>
```

- [ ] **Step 3: Bump `FLYTAB_VERSION`**

Per this repo's Build Policy, increment `FLYTAB_VERSION` at the top of `web/app.js` before building — use the next available version per this repo's Android version format convention (no three digits after the decimal; confirm the current value first with `grep -n "FLYTAB_VERSION" web/app.js` since this plan doesn't know the live value at execution time).

- [ ] **Step 4: Full manual verification**

Run `bash build.sh`, install on the tablet. Using `tools/mock-stratux.py`, replay a track that:
- Approaches a known Class D airport — confirm the popup fires with a plausible frequency, at roughly the configured lead time.
- Continues past without landing, then departs the area entirely and re-approaches later — confirm no re-fire while still in the original approach, and a fresh fire on the later approach.
- Flies below a shelf's published floor near a Class B/C area, then climbs through it — confirm no alert below the floor, alert on climbing through it (exercises Task 3's vertical bound check with real data).
- **Required regression check per this repo's Tap Handler Regression Rule**: tap a known airport on the map and confirm the existing airport-info popup still opens normally — this plan's new `AirspaceAlertPopup` is mounted into the same map container as `ConvectiveAlerts already is, so this check confirms the new DOM overlay doesn't intercept touch events meant for the map's tap handlers.
- Toggle each of the five per-type layer-panel switches from Task 5 off/on and confirm the corresponding airspace type stops/resumes alerting.
- Toggle the master "Airspace Alerts" switch off mid-approach (while a real or simulated approach is in progress) and confirm no popup fires, then back on and confirm alerting resumes on the next approach — this exercises the live per-tick `enabled` check (Task 3), not just the one-time startup path the earlier `ConvectiveAlerts`-style design would have had.

- [ ] **Step 5: Commit**

```bash
git add web/app.js web/index.html
git commit -m "feat: wire AirspaceAlert and AirspaceAlertPopup into app startup"
```
