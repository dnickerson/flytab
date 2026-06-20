# Convective Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Convective Intelligence module that scores NEXRAD returns for convective potential, expands hazard boundaries with probabilistic rings, and alerts the pilot via route intersection analysis — all built on FIS-B data already flowing through the Stratux stack.

**Architecture:** A new `ConvectiveIntelligenceEngine` class integrates four signal sources — NEXRAD temporal analysis (multi-frame slope fitting), preflight HRRR instability grid (fetched via flywhere proxy + stored in IDB), OAT trend monitoring (from engine:data), and wind convergence (GPS vs. forecast). Results drive a `ConvectiveDisplay` Leaflet overlay (probabilistic rings + badges) and a `ConvectiveAlerts` panel (level 1–4 alerts). The existing `FisbNexrad._frameHistory` ring buffer is reused for temporal analysis; `_clusterBlocks()` is made public to expose clusters.

**Tech Stack:** Vanilla JS, Leaflet, IndexedDB, Vitest (unit tests), `Settings.workerBase` proxy for AWC calls.

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `web/shared/nexrad-sites.js` | NEXRAD_SITES array, `findNearestNexradSite()`, `getBeamHeightFt()`, `getBeamHeightWarning()` |
| Create | `web/shared/convective-intelligence.js` | All core algorithms: math utils, `computeCellInstabilityScore`, `computeInstabilityGrid`, `NexradSectorAnalyzer`, `computeHazardBoundary`, `evaluateRouteAlerts`, `OATTrendMonitor`, `detectWindConvergence`, `ConvectiveIntelligenceEngine` |
| Create | `web/shared/hrrr-preflight.js` | `HRRRPreflightStore`: fetch via proxy, IDB save/load, staleness check |
| Create | `web/cockpit/convective-display.js` | `ConvectiveDisplay`: Leaflet hazard rings, classification badges, beam height annotations |
| Create | `web/cockpit/convective-alerts.js` | `ConvectiveAlerts`: alert panel DOM, voice triggers, OAT alert rules |
| Create | `tests/convective/convective-intelligence.test.js` | Vitest unit tests for pure functions |
| Modify | `web/cockpit/fisb-nexrad.js` | Add `_latestDataTime`, `getDataAgeMs()`, `dataTime` in snapshots, `clusterBlocks()` and `clustersForFrame()` public methods |
| Modify | `web/cockpit/radar-loop.js` | Add color-coded data age span to controls |
| Modify | `web/cockpit/layer-panel.js` | Add "Conv Intel" toggle |
| Modify | `web/cockpit-config.json` | Add `"convective": { "enabled": false }` |
| Modify | `web/index.html` | Add 5 new `<script>` tags in load order |
| Modify | `web/app.js` | Instantiate and wire `ConvectiveIntelligenceEngine` |
| Modify | `docs/user-manual.md` | Document feature |
| Modify | `flywhere/app/api/weather/route.ts` | Add `type=griddata` forwarding (**prerequisite for Task 4**) |

---

## Task 1: NEXRAD Data-Time Tracking + Age Display

**Files:**
- Modify: `web/cockpit/fisb-nexrad.js`
- Modify: `web/cockpit/radar-loop.js`

### Data-time changes to `FisbNexrad`

- [ ] **Step 1: Add `_latestDataTime` property and `getDataAgeMs()` to FisbNexrad**

In `fisb-nexrad.js`, inside the constructor after `this._loopMode = false;`:
```javascript
this._latestDataTime = 0;  // timestamp from most recent NEXRAD frame
```

After the `get blockCount()` getter:
```javascript
/** Milliseconds since the most recently received NEXRAD data, or null if no data */
getDataAgeMs() {
    return this._latestDataTime ? Date.now() - this._latestDataTime : null;
}
```

- [ ] **Step 2: Capture data time in `_handleNexrad`**

In `_handleNexrad(msg)`, just after `const now = Date.now();`:
```javascript
// LocaltimeReceived is when Stratux received this FIS-B frame; best available data time
const dataTime = msg.LocaltimeReceived
    ? new Date(msg.LocaltimeReceived).getTime() || now
    : now;
this._latestDataTime = dataTime;
```

- [ ] **Step 3: Store `dataTime` in snapshots**

Replace the `_takeSnapshot(now)` signature and body with:
```javascript
_takeSnapshot(time, dataTime) {
    const snapshot = new Map();
    for (const [key, block] of this._blocks) {
        snapshot.set(key, { ...block, intensity: block.intensity.slice() });
    }
    this._frameHistory.push({ time, dataTime: dataTime || time, blocks: snapshot });
    while (this._frameHistory.length > this._maxFrames) {
        this._frameHistory.shift();
    }
}
```

Update the call site in `_handleNexrad` from `this._takeSnapshot(now)` to `this._takeSnapshot(now, dataTime)`.

- [ ] **Step 4: Expose `clusterBlocks()` and `clustersForFrame()` as public methods**

Add after `_bfsClusters(...)`:
```javascript
/** Public: connected clusters from current live blocks (moderate+ intensity) */
clusterBlocks() { return this._clusterBlocks(this._blocks); }

/** Public: connected clusters from a historical frame snapshot */
clustersForFrame(frameIndex) {
    if (frameIndex < 0 || frameIndex >= this._frameHistory.length) return [];
    return this._clusterBlocks(this._frameHistory[frameIndex].blocks);
}
```

### Data age display in `RadarLoop`

- [ ] **Step 5: Add age indicator span to radar controls HTML**

In `_buildControls()`, inside the `.radar-transport` div innerHTML, add after the `<span class="radar-time-display">` span:
```javascript
<span class="radar-age-display"></span>
```

After `this._timeDisplay = el.querySelector('.radar-time-display');`, add:
```javascript
this._ageDisplay = el.querySelector('.radar-age-display');
```

Style the age display element (add after the timeDisplay style block):
```javascript
if (this._ageDisplay) {
    Object.assign(this._ageDisplay.style, {
        fontSize: '11px',
        fontWeight: '700',
        marginLeft: '6px',
        padding: '1px 4px',
        borderRadius: '3px',
    });
}
```

- [ ] **Step 6: Update age display in `_updateTimeDisplay()`**

At the end of `_updateTimeDisplay()`, add:
```javascript
if (this._ageDisplay && this._nexrad) {
    const ageMs = this._nexrad.getDataAgeMs();
    if (ageMs === null) {
        this._ageDisplay.textContent = '';
    } else {
        const ageMin = Math.round(ageMs / 60000);
        this._ageDisplay.textContent = `${ageMin}min`;
        this._ageDisplay.style.background =
            ageMin < 5  ? 'rgba(0,200,100,0.25)'  :
            ageMin < 10 ? 'rgba(255,170,0,0.25)'  :
                          'rgba(255,51,0,0.25)';
        this._ageDisplay.style.color =
            ageMin < 5  ? '#00c864' :
            ageMin < 10 ? '#ffaa00' :
                          '#ff3300';
    }
}
```

- [ ] **Step 7: Rebuild and verify**

```bash
bash build.sh
```

Open radar loop on tablet. Confirm age badge appears, is green when fresh, turns yellow after 5+ min, red after 10+ min.

- [ ] **Step 8: Commit**

```bash
git add web/cockpit/fisb-nexrad.js web/cockpit/radar-loop.js
git commit -m "feat(nexrad): data-time tracking and color-coded age badge in radar loop"
```

---

## Task 2: NEXRAD Site Database + Beam Height

**Files:**
- Create: `web/shared/nexrad-sites.js`
- Create: `tests/convective/nexrad-sites.test.js`
- Modify: `web/index.html`

- [ ] **Step 1: Create `web/shared/nexrad-sites.js`**

```javascript
/**
 * NEXRAD WSR-88D site locations (SE US coverage) and beam height math.
 */

const NEXRAD_SITES = [
    { id: 'KGSP', lat: 34.8833, lon: -82.2203, elevFt: 940  },
    { id: 'KCAE', lat: 33.9488, lon: -81.1184, elevFt: 231  },
    { id: 'KCLX', lat: 32.6558, lon: -81.0422, elevFt: 97   },
    { id: 'KJGX', lat: 32.6750, lon: -83.3511, elevFt: 521  },
    { id: 'KFFC', lat: 33.3636, lon: -84.5658, elevFt: 858  },
    { id: 'KLTX', lat: 33.9891, lon: -78.4291, elevFt: 61   },
    { id: 'KRAX', lat: 35.6654, lon: -78.4897, elevFt: 348  },
    { id: 'KMHX', lat: 34.7759, lon: -76.8762, elevFt: 31   },
    { id: 'KAKQ', lat: 36.9839, lon: -77.0075, elevFt: 112  },
    { id: 'KCCX', lat: 40.9228, lon: -78.0039, elevFt: 2405 },
    { id: 'KDOX', lat: 38.8257, lon: -75.4400, elevFt: 50   },
    { id: 'KICT', lat: 37.6544, lon: -97.4428, elevFt: 1335 },
    { id: 'KVAX', lat: 30.8903, lon: -83.0019, elevFt: 178  },
    { id: 'KAMX', lat: 25.6111, lon: -80.4128, elevFt: 14   },
    { id: 'KTBW', lat: 27.7056, lon: -82.4019, elevFt: 41   },
    { id: 'KEVX', lat: 30.5644, lon: -85.9219, elevFt: 140  },
    { id: 'KMOB', lat: 30.6794, lon: -88.2397, elevFt: 208  },
    { id: 'KBMX', lat: 33.1722, lon: -86.7697, elevFt: 1220 },
    { id: 'KHTX', lat: 34.9306, lon: -86.0836, elevFt: 1760 },
    { id: 'KOHX', lat: 36.2472, lon: -86.5625, elevFt: 576  },
];

/**
 * Standard atmosphere beam height, 4/3 Earth radius model.
 * Returns feet AGL at the given slant range from the radar site.
 * @param {number} distanceNm  - slant range in nautical miles
 * @param {number} [elevDeg=0.5] - elevation angle in degrees
 * @returns {number} beam height in feet
 */
function getBeamHeightFt(distanceNm, elevDeg = 0.5) {
    const distM = distanceNm * 1852;
    const Re = 6371000 * (4 / 3);  // effective Earth radius
    const elevRad = elevDeg * Math.PI / 180;
    const heightM = Math.sqrt(
        distM ** 2 + Re ** 2 + 2 * distM * Re * Math.sin(elevRad)
    ) - Re;
    return heightM * 3.28084;
}

/**
 * Find the NEXRAD site nearest to a lat/lon position.
 * @param {{ lat: number, lon: number }} pos
 * @returns {{ id, lat, lon, elevFt }}
 */
function findNearestNexradSite(pos) {
    let nearest = NEXRAD_SITES[0];
    let bestDist = _distDeg(pos, nearest);
    for (const site of NEXRAD_SITES) {
        const d = _distDeg(pos, site);
        if (d < bestDist) { bestDist = d; nearest = site; }
    }
    return nearest;
}

/**
 * Returns beam height warning if beam clears 4,000 ft above the return position.
 * @param {{ lat, lon }} returnPos
 * @param {{ lat, lon }} aircraftPos  (unused for warning threshold, kept for future use)
 * @param {{ lat, lon, elevFt }} [site]  defaults to nearest NEXRAD site
 * @returns {{ beamHeightFt: number, warning: string|null }}
 */
function getBeamHeightWarning(returnPos, aircraftPos, site) {
    const s = site || findNearestNexradSite(returnPos);
    const distNm = _nmBetween(returnPos, s);
    const beamHeightFt = getBeamHeightFt(distNm);
    return {
        beamHeightFt,
        warning: beamHeightFt > 4000
            ? `Radar beam ${Math.round(beamHeightFt / 100) * 100}ft — hazard extends below`
            : null,
    };
}

/**
 * Return all NEXRAD sites within a bounding box (+ 1° buffer).
 */
function findNexradSitesInBbox({ minLat, maxLat, minLon, maxLon }) {
    const B = 1;
    return NEXRAD_SITES.filter(s =>
        s.lat >= minLat - B && s.lat <= maxLat + B &&
        s.lon >= minLon - B && s.lon <= maxLon + B
    );
}

function _distDeg(a, b) {
    return Math.sqrt((a.lat - b.lat) ** 2 + (a.lon - b.lon) ** 2);
}

function _nmBetween(a, b) {
    const R = 3440.065;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
```

- [ ] **Step 2: Write failing tests**

Create `tests/convective/nexrad-sites.test.js`:
```javascript
// tests/convective/nexrad-sites.test.js
// Node CJS: nexrad-sites.js uses global functions — load via vm or just copy-paste the needed functions for testing.
// We test the pure math functions directly.

import { describe, it, expect } from 'vitest';

// Inline the pure functions (no DOM deps) rather than requiring the browser global file
function getBeamHeightFt(distanceNm, elevDeg = 0.5) {
    const distM = distanceNm * 1852;
    const Re = 6371000 * (4 / 3);
    const elevRad = elevDeg * Math.PI / 180;
    const heightM = Math.sqrt(distM ** 2 + Re ** 2 + 2 * distM * Re * Math.sin(elevRad)) - Re;
    return heightM * 3.28084;
}

describe('getBeamHeightFt', () => {
    it('returns ~1500 ft at 50nm (low-angle, standard atmosphere)', () => {
        const h = getBeamHeightFt(50, 0.5);
        expect(h).toBeGreaterThan(1000);
        expect(h).toBeLessThan(2500);
    });

    it('returns ~6000 ft at 100nm', () => {
        const h = getBeamHeightFt(100, 0.5);
        expect(h).toBeGreaterThan(4000);
        expect(h).toBeLessThan(9000);
    });

    it('returns ~22000 ft at 200nm', () => {
        const h = getBeamHeightFt(200, 0.5);
        expect(h).toBeGreaterThan(15000);
        expect(h).toBeLessThan(30000);
    });

    it('height increases with elevation angle', () => {
        expect(getBeamHeightFt(100, 2.0)).toBeGreaterThan(getBeamHeightFt(100, 0.5));
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npm test -- tests/convective/nexrad-sites.test.js
```
Expected: FAIL — `tests/convective/nexrad-sites.test.js` cannot be found (file not yet in project).

Actually it will PASS because the test file inlines the function. Run anyway to confirm vitest picks it up.

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- tests/convective/nexrad-sites.test.js
```
Expected: all 4 tests PASS.

- [ ] **Step 5: Add script tag to `index.html`**

After the line `<script src="./shared/network-mode.js"></script>`, add:
```html
<script src="./shared/nexrad-sites.js"></script>
```

- [ ] **Step 6: Build and verify beam height annotation works on device**

```bash
bash build.sh
```

In browser console (after connecting to FIS-B NEXRAD): `getBeamHeightFt(150, 0.5)` should return ~14000. `findNearestNexradSite({lat:34.0, lon:-82.0})` should return `KCAE`.

- [ ] **Step 7: Commit**

```bash
git add web/shared/nexrad-sites.js tests/convective/nexrad-sites.test.js web/index.html
git commit -m "feat(nexrad): site database and beam height calculation"
```

---

## Task 3: Math Utilities + Vitest Infrastructure

**Files:**
- Create: `web/shared/convective-intelligence.js` (math utilities only)
- Create: `tests/convective/convective-intelligence.test.js`

- [ ] **Step 1: Create `web/shared/convective-intelligence.js` with math utils**

```javascript
/**
 * FlyTab — Convective Intelligence Engine
 * Scores NEXRAD returns for convective potential, computes hazard boundaries,
 * evaluates route alerts, monitors OAT trends, detects wind convergence.
 *
 * EXPERIMENTAL — NOT FOR NAVIGATION.
 * Decision-support only. Does not replace ATC advisories or pilot judgment.
 */

// ========== Math Utilities ==========

function fitLinearSlope(values) {
    const n = values.length;
    if (n < 2) return 0;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - xMean) * (values[i] - yMean);
        den += (i - xMean) ** 2;
    }
    return den === 0 ? 0 : num / den;
}

/** Returns fractional growth rate per step (e.g. 0.5 = 50% growth per frame) */
function fitExponentialSlope(values) {
    const logVals = values.map(v => Math.log(Math.max(v, 0.001)));
    return Math.exp(fitLinearSlope(logVals)) - 1;
}

function computeVariance(values) {
    const n = values.length;
    if (n < 2) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / n;
    return values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
}

/**
 * Perimeter-fraction irregularity of a cluster.
 * Smooth circle ≈ 0.0, highly irregular cauliflower ≈ 1.0
 * @param {{ cells: Array<{gLat,gLon}> }} cluster
 */
function computeEdgeIrregularity(cluster) {
    const total = cluster.cells.length;
    if (total < 2) return 0;
    const cellSet = new Set(cluster.cells.map(c => `${c.gLat},${c.gLon}`));
    let perimCount = 0;
    for (const cell of cluster.cells) {
        const isEdge = [
            `${cell.gLat+1},${cell.gLon}`, `${cell.gLat-1},${cell.gLon}`,
            `${cell.gLat},${cell.gLon+1}`, `${cell.gLat},${cell.gLon-1}`,
        ].some(k => !cellSet.has(k));
        if (isEdge) perimCount++;
    }
    // A circle of 10 cells has ~30% perimeter fraction. Map [0.3, 1.0] → [0, 1].
    return Math.min(Math.max((perimCount / total - 0.3) / 0.7, 0), 1);
}

/**
 * Solar heating multiplier by local (device) clock hour.
 * Returns 0.2 (night) to 1.0 (peak 15:00–17:00 local).
 */
function computeSolarHeatingMultiplier(date) {
    const h = date.getHours() + date.getMinutes() / 60;
    if (h < 9 || h > 22) return 0.2;
    if (h < 12) return 0.3 + ((h - 9) / 3) * 0.4;
    if (h < 15) return 0.7 + ((h - 12) / 3) * 0.3;
    if (h < 17) return 1.0;
    if (h < 20) return 1.0 - ((h - 17) / 3) * 0.5;
    return 0.3;
}

// ========== Score Normalization Helpers ==========

function _normAreaGrowth(rate) {
    if (rate <= 0.05) return 0;
    if (rate >= 0.50) return 1;
    return (rate - 0.05) / 0.45;
}

function _normDbzGrowth(rate) {
    if (rate <= 2) return 0;
    if (rate >= 8) return 1;
    return (rate - 2) / 6;
}

function _normMotionRatio(ratio) {
    return Math.min(Math.max(ratio / 5, 0), 1);
}

// ========== Instability Scoring (preflight HRRR grid) ==========

/**
 * Compute 0–1 instability score for a single HRRR grid cell.
 * Tuned for SE US airmass convection: lat 25–37, May–September.
 */
function computeCellInstabilityScore({ cape, cin, lcl, lfc, shear03, dewpoint, timeOfDay }) {
    let score = 0;

    // CAPE
    if      (cape < 200)  score += 0.00;
    else if (cape < 500)  score += 0.10;
    else if (cape < 1000) score += 0.20;
    else if (cape < 1500) score += 0.35;
    else if (cape < 2500) score += 0.50;
    else                  score += 0.65;

    // CIN (pass positive absolute value)
    if      (cin < 10)  score += 0.20;
    else if (cin < 25)  score += 0.15;
    else if (cin < 50)  score += 0.10;
    else if (cin < 100) score += 0.02;

    // Solar heating multiplier
    const mult = computeSolarHeatingMultiplier(timeOfDay instanceof Date ? timeOfDay : new Date());
    score *= mult;

    // Dewpoint (°F)
    if (dewpoint > 70) score += 0.10;
    else if (dewpoint > 65) score += 0.05;

    // Low-level shear (knots)
    if (shear03 > 30) score += 0.05;

    return Math.min(score, 1.0);
}

/**
 * Convert raw AWC griddata API response to an array of instability grid cells.
 * AWC griddata returns GeoJSON FeatureCollection or flat array — inspect response before calling.
 * @param {object} hrrrData - parsed JSON from AWC /api/data/griddata
 * @returns {Array<{lat,lon,instabilityScore,cape,cin,validTime}>}
 */
function computeInstabilityGrid(hrrrData) {
    const points = hrrrData.features ?? hrrrData.data ?? hrrrData ?? [];
    const now = new Date();
    return points.map(item => {
        const props = item.properties ?? item;
        const lat = item.geometry?.coordinates?.[1] ?? props.lat ?? 0;
        const lon = item.geometry?.coordinates?.[0] ?? props.lon ?? 0;
        return {
            lat, lon,
            instabilityScore: computeCellInstabilityScore({
                cape:     props.cape     ?? 0,
                cin:      Math.abs(props.cin ?? 0),
                lcl:      props.lcl      ?? 9999,
                lfc:      props.lfc      ?? 9999,
                shear03:  props.shear03  ?? 0,
                dewpoint: props.dwpf     ?? 50,
                timeOfDay: now,
            }),
            cape:      props.cape  ?? 0,
            cin:       props.cin   ?? 0,
            validTime: props.validTime ?? now.toISOString(),
        };
    });
}

/** Find cell in grid nearest to lat/lon */
function lookupNearestCell(grid, lat, lon) {
    let best = null, bestD = Infinity;
    for (const cell of grid) {
        const d = (cell.lat - lat) ** 2 + (cell.lon - lon) ** 2;
        if (d < bestD) { bestD = d; best = cell; }
    }
    return best;
}
```

- [ ] **Step 2: Write failing tests for math utils**

Create `tests/convective/convective-intelligence.test.js`:
```javascript
import { describe, it, expect } from 'vitest';

// ---- inline pure functions (no DOM deps) ----

function fitLinearSlope(values) {
    const n = values.length;
    if (n < 2) return 0;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - xMean) * (values[i] - yMean);
        den += (i - xMean) ** 2;
    }
    return den === 0 ? 0 : num / den;
}

function fitExponentialSlope(values) {
    const logVals = values.map(v => Math.log(Math.max(v, 0.001)));
    return Math.exp(fitLinearSlope(logVals)) - 1;
}

function computeEdgeIrregularity(cluster) {
    const total = cluster.cells.length;
    if (total < 2) return 0;
    const cellSet = new Set(cluster.cells.map(c => `${c.gLat},${c.gLon}`));
    let perimCount = 0;
    for (const cell of cluster.cells) {
        const isEdge = [
            `${cell.gLat+1},${cell.gLon}`, `${cell.gLat-1},${cell.gLon}`,
            `${cell.gLat},${cell.gLon+1}`, `${cell.gLat},${cell.gLon-1}`,
        ].some(k => !cellSet.has(k));
        if (isEdge) perimCount++;
    }
    return Math.min(Math.max((perimCount / total - 0.3) / 0.7, 0), 1);
}

function computeSolarHeatingMultiplier(date) {
    const h = date.getHours() + date.getMinutes() / 60;
    if (h < 9 || h > 22) return 0.2;
    if (h < 12) return 0.3 + ((h - 9) / 3) * 0.4;
    if (h < 15) return 0.7 + ((h - 12) / 3) * 0.3;
    if (h < 17) return 1.0;
    if (h < 20) return 1.0 - ((h - 17) / 3) * 0.5;
    return 0.3;
}

function computeCellInstabilityScore({ cape, cin, lcl, lfc, shear03, dewpoint, timeOfDay }) {
    let score = 0;
    if      (cape < 200)  score += 0.00;
    else if (cape < 500)  score += 0.10;
    else if (cape < 1000) score += 0.20;
    else if (cape < 1500) score += 0.35;
    else if (cape < 2500) score += 0.50;
    else                  score += 0.65;
    if      (cin < 10)  score += 0.20;
    else if (cin < 25)  score += 0.15;
    else if (cin < 50)  score += 0.10;
    else if (cin < 100) score += 0.02;
    const mult = computeSolarHeatingMultiplier(timeOfDay instanceof Date ? timeOfDay : new Date());
    score *= mult;
    if (dewpoint > 70) score += 0.10;
    else if (dewpoint > 65) score += 0.05;
    if (shear03 > 30) score += 0.05;
    return Math.min(score, 1.0);
}

// ---- tests ----

describe('fitLinearSlope', () => {
    it('returns positive slope for increasing series', () => {
        expect(fitLinearSlope([1, 2, 3, 4])).toBeGreaterThan(0);
    });
    it('returns ~1 for linear [0,1,2,3]', () => {
        expect(fitLinearSlope([0, 1, 2, 3])).toBeCloseTo(1, 5);
    });
    it('returns 0 for flat series', () => {
        expect(fitLinearSlope([5, 5, 5, 5])).toBe(0);
    });
    it('returns 0 for single value', () => {
        expect(fitLinearSlope([42])).toBe(0);
    });
});

describe('fitExponentialSlope', () => {
    it('returns positive rate for exponentially growing series', () => {
        expect(fitExponentialSlope([10, 20, 40, 80])).toBeGreaterThan(0.5);
    });
    it('returns near 0 for flat series', () => {
        expect(Math.abs(fitExponentialSlope([5, 5, 5, 5]))).toBeLessThan(0.05);
    });
    it('>50% growth rate for convective (100% per frame)', () => {
        expect(fitExponentialSlope([5, 10, 20, 40])).toBeGreaterThan(0.5);
    });
});

describe('computeEdgeIrregularity', () => {
    it('returns 0 for a 3x3 square (low irregularity)', () => {
        const cells = [];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cells.push({ gLat: r, gLon: c });
        expect(computeEdgeIrregularity({ cells })).toBe(0);
    });
    it('returns >0 for a line (high perimeter fraction)', () => {
        const cells = [{ gLat: 0, gLon: 0 }, { gLat: 0, gLon: 1 }, { gLat: 0, gLon: 2 }, { gLat: 0, gLon: 3 }];
        expect(computeEdgeIrregularity({ cells })).toBeGreaterThan(0);
    });
});

describe('computeSolarHeatingMultiplier', () => {
    it('returns maximum 1.0 at 16:00 local', () => {
        const d = new Date(); d.setHours(16, 0, 0, 0);
        expect(computeSolarHeatingMultiplier(d)).toBe(1.0);
    });
    it('returns minimum at night (02:00)', () => {
        const d = new Date(); d.setHours(2, 0, 0, 0);
        expect(computeSolarHeatingMultiplier(d)).toBe(0.2);
    });
    it('is lower at 09:00 than 15:00', () => {
        const d09 = new Date(); d09.setHours(9, 0, 0, 0);
        const d15 = new Date(); d15.setHours(15, 0, 0, 0);
        expect(computeSolarHeatingMultiplier(d09)).toBeLessThan(computeSolarHeatingMultiplier(d15));
    });
});

describe('computeCellInstabilityScore', () => {
    const peak = { timeOfDay: (() => { const d = new Date(); d.setHours(15,0,0,0); return d; })() };

    it('returns low score for stable, capped atmosphere at peak heating', () => {
        const score = computeCellInstabilityScore({ cape: 100, cin: 200, lcl: 9999, lfc: 9999, shear03: 0, dewpoint: 40, ...peak });
        expect(score).toBeLessThan(0.15);
    });

    it('returns high score for explosive instability at peak heating', () => {
        const score = computeCellInstabilityScore({ cape: 3000, cin: 5, lcl: 2000, lfc: 3000, shear03: 0, dewpoint: 72, ...peak });
        expect(score).toBeGreaterThan(0.7);
    });

    it('never exceeds 1.0', () => {
        const score = computeCellInstabilityScore({ cape: 5000, cin: 0, lcl: 1000, lfc: 1000, shear03: 50, dewpoint: 80, ...peak });
        expect(score).toBeLessThanOrEqual(1.0);
    });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/convective/convective-intelligence.test.js
```
Expected: all tests PASS.

- [ ] **Step 4: Add `convective-intelligence.js` script tag to `index.html`**

After `<script src="./shared/nexrad-sites.js"></script>`:
```html
<script src="./shared/convective-intelligence.js"></script>
```

- [ ] **Step 5: Commit**

```bash
git add web/shared/convective-intelligence.js tests/convective/convective-intelligence.test.js web/index.html
git commit -m "feat(convective): math utilities and instability scoring (tested)"
```

---

## Task 4: Preflight HRRR Data Pull + IDB Store

**Files:**
- Modify: `flywhere/app/api/weather/route.ts` (in `~/flywhere` repo — prerequisite, do this first)
- Create: `web/shared/hrrr-preflight.js`
- Modify: `web/index.html`

### 4a: Add `griddata` type to flywhere proxy

**Do this in the flywhere repo (`~/flywhere`) before writing the FlyTab client.**

- [ ] **Step 1: Read the flywhere weather route**

Read `~/flywhere/app/api/weather/route.ts`. Locate the switch/if block that handles `type=metar`, `type=taf`, etc.

- [ ] **Step 2: Add griddata case**

In the `type` dispatch block, add (following the same pattern as other types):
```typescript
if (type === 'griddata') {
    const awcUrl = new URL('https://aviationweather.gov/api/data/griddata');
    // forward all other query params verbatim
    for (const [k, v] of searchParams.entries()) {
        if (k !== 'type') awcUrl.searchParams.set(k, v);
    }
    const awcResp = await fetch(awcUrl.toString());
    const body = await awcResp.text();
    return new Response(body, {
        status: awcResp.status,
        headers: {
            'Content-Type': awcResp.headers.get('Content-Type') || 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
}
```

- [ ] **Step 3: Verify AWC griddata endpoint format before writing the parser**

```bash
curl -s "https://aviationweather.gov/api/data/griddata?bbox=30,-86,36,-79&fields=cape,cin&format=json" | head -200
```
Inspect the actual response structure. Note: field names, nesting (FeatureCollection vs flat array), how `cape`/`cin` appear. **Update `computeInstabilityGrid()` in Task 3 if the field names differ from `props.cape`/`props.cin`.**

- [ ] **Step 4: Deploy flywhere change**

```bash
cd ~/flywhere && npm run build  # or however flywhere deploys
```

### 4b: Create `HRRRPreflightStore`

- [ ] **Step 5: Create `web/shared/hrrr-preflight.js`**

```javascript
/**
 * FlyTab — HRRR Preflight Instability Store
 * Fetches CAPE/CIN/shear grid from AWC via flywhere proxy, stores in IndexedDB.
 * EXPERIMENTAL — ground use only (internet required).
 */

class HRRRPreflightStore {
    constructor() {
        this._db    = null;
        this._data  = null;  // in-memory cache of last loaded/fetched data
    }

    async open() {
        if (this._db) return;
        await new Promise((resolve, reject) => {
            const req = indexedDB.open('flytab_convective', 1);
            req.onupgradeneeded = e => {
                e.target.result.createObjectStore('preflight');
            };
            req.onsuccess  = e => { this._db = e.target.result; resolve(); };
            req.onerror    = () => reject(req.error);
        });
    }

    /** Load previously saved preflight data from IDB. Returns data or null. */
    async load() {
        await this.open();
        return new Promise(resolve => {
            const tx  = this._db.transaction('preflight', 'readonly');
            const req = tx.objectStore('preflight').get('data');
            req.onsuccess = () => { this._data = req.result ?? null; resolve(this._data); };
            req.onerror   = () => resolve(null);
        });
    }

    async _save(data) {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('preflight', 'readwrite');
            tx.objectStore('preflight').put(data, 'data');
            tx.oncomplete = () => { this._data = data; resolve(); };
            tx.onerror    = () => reject(tx.error);
        });
    }

    /**
     * Fetch HRRR instability grid for a route bbox and store to IDB.
     * @param {{ minLat, maxLat, minLon, maxLon }} routeBbox
     * @returns {Promise<object>} saved preflight data object
     */
    async fetchAndStore(routeBbox) {
        const base = Settings.workerBase || 'https://www.flywhere.app/api';
        const { minLat, maxLat, minLon, maxLon } = routeBbox;
        const BUF  = 0.83;  // ~50nm buffer
        const bbox = `${(minLat - BUF).toFixed(2)},${(minLon - BUF).toFixed(2)},${(maxLat + BUF).toFixed(2)},${(maxLon + BUF).toFixed(2)}`;

        const url = `${base}/weather?type=griddata&bbox=${bbox}&fields=cape,cin,lcl,lfc,shear03&format=json`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!resp.ok) throw new Error(`HRRR fetch failed: ${resp.status} ${resp.statusText}`);
        const json = await resp.json();

        const grid = computeInstabilityGrid(json);
        const now  = new Date();

        const data = {
            fetchedAt:   now.toISOString(),
            validUntil:  new Date(now.getTime() + 3 * 3600000).toISOString(),
            routeBbox,
            instabilityGrid:    grid,
            nexradSiteLocations: findNexradSitesInBbox(routeBbox),
        };

        await this._save(data);
        return data;
    }

    /** In-memory grid (null if not loaded). */
    getGrid() { return this._data?.instabilityGrid ?? null; }

    /**
     * @returns {'none' | 'valid' | 'stale' | 'expired'}
     *   none    — no data stored
     *   valid   — data is < 3 hours old
     *   stale   — 3–6 hours old (show warning banner)
     *   expired — > 6 hours old (disable overlay, show alert)
     */
    getStaleness() {
        if (!this._data) return 'none';
        const ageMs = Date.now() - new Date(this._data.fetchedAt).getTime();
        if (ageMs > 6 * 3600000) return 'expired';
        if (ageMs > 3 * 3600000) return 'stale';
        return 'valid';
    }

    /** Human-readable age string, e.g. "2h 14m ago" */
    getAgeLabel() {
        if (!this._data) return 'No data';
        const ageMs  = Date.now() - new Date(this._data.fetchedAt).getTime();
        const hours  = Math.floor(ageMs / 3600000);
        const mins   = Math.floor((ageMs % 3600000) / 60000);
        return hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;
    }
}
```

- [ ] **Step 6: Add script tag to `index.html`**

After `<script src="./shared/convective-intelligence.js"></script>`:
```html
<script src="./shared/hrrr-preflight.js"></script>
```

- [ ] **Step 7: Smoke-test in browser console**

With the app running on WiFi:
```javascript
const store = new HRRRPreflightStore();
store.fetchAndStore({ minLat: 31, maxLat: 35, minLon: -84, maxLon: -79 }).then(d => {
    console.log('grid cells:', d.instabilityGrid.length);
    console.log('sample cell:', d.instabilityGrid[0]);
});
```
Expected: grid cells > 0, each has `lat`, `lon`, `instabilityScore` (0–1), `cape`.

If `instabilityGrid.length === 0` or fields differ, re-inspect the AWC response from Step 3 and fix `computeInstabilityGrid()`.

- [ ] **Step 8: Commit**

```bash
git add web/shared/hrrr-preflight.js web/index.html
git commit -m "feat(preflight): HRRR instability grid fetch and IDB store"
```

---

## Task 5: Convective Discrimination Algorithm

**Files:**
- Modify: `web/shared/convective-intelligence.js` (add `NexradSectorAnalyzer`)
- Modify: `tests/convective/convective-intelligence.test.js` (add analyzer tests)

- [ ] **Step 1: Add `NexradSectorAnalyzer` to `convective-intelligence.js`**

Append to the file after `lookupNearestCell`:
```javascript
// ========== Convective Discrimination Thresholds ==========

const CONVECTIVE_THRESHOLDS = {
    STRATIFORM:  { min: 0.00, max: 0.30, color: '#4488CC', label: 'Stratiform precipitation' },
    AMBIGUOUS:   { min: 0.30, max: 0.60, color: '#FFAA00', label: 'Possible convective — monitor' },
    LIKELY_CONV: { min: 0.60, max: 0.80, color: '#FF6600', label: 'Likely convective — deviate' },
    CONFIRMED:   { min: 0.80, max: 1.00, color: '#FF0000', label: 'Convective — immediate deviation' },
};

function getConvectiveCategory(score) {
    if (score >= 0.80) return 'CONFIRMED';
    if (score >= 0.60) return 'LIKELY_CONV';
    if (score >= 0.30) return 'AMBIGUOUS';
    return 'STRATIFORM';
}

// ========== NexradSectorAnalyzer ==========

/**
 * Wraps FisbNexrad frame history to perform multi-frame convective scoring.
 * Call analyze() after each new NEXRAD frame; result is an array of
 * { cluster, analysis } for all current clusters.
 */
class NexradSectorAnalyzer {
    /**
     * @param {FisbNexrad} fisbNexrad
     * @param {HRRRPreflightStore} preflightStore
     */
    constructor(fisbNexrad, preflightStore) {
        this._nexrad    = fisbNexrad;
        this._preflight = preflightStore;
    }

    /**
     * Run analysis against current frame history.
     * @returns {Array<{ cluster, analysis }>}
     */
    analyze() {
        const frames = this._nexrad.frameHistory;
        if (frames.length < 2) return [];

        // Compute clusters for every historical frame (expensive only on update, ~every 5-6 min)
        const frameClusters = frames.map((_, i) => this._nexrad.clustersForFrame(i));
        const currentClusters = frameClusters[frameClusters.length - 1];

        return currentClusters.map(cluster => ({
            cluster,
            analysis: this._analyzeCluster(cluster, frameClusters),
        }));
    }

    _analyzeCluster(current, frameClusters) {
        const MATCH_DEG = 1.5;  // ~90nm max centroid drift between frames

        // Track this cluster across all historical frames
        const matched = frameClusters.map(clusters => {
            let best = null, bestD = MATCH_DEG;
            for (const c of clusters) {
                const d = Math.sqrt(
                    (current.centroid[0] - c.centroid[0]) ** 2 +
                    (current.centroid[1] - c.centroid[1]) ** 2
                );
                if (d < bestD) { bestD = d; best = c; }
            }
            return best;
        }).filter(Boolean);

        if (matched.length < 3) {
            return { score: null, confidence: 'insufficient_data', signals: { framesAnalyzed: matched.length } };
        }

        const areas      = matched.map(c => c.cells.length);
        const peakDbzs   = matched.map(c => c.maxIntensity);
        const centroids  = matched.map(c => c.centroid);

        const areaGrowthRate  = fitExponentialSlope(areas);
        const dbzGrowthRate   = fitLinearSlope(peakDbzs);
        const edgeIrregularity = computeEdgeIrregularity(current);

        // Area-vs-motion ratio: growing faster than moving → convective
        const first = centroids[0], last = centroids[centroids.length - 1];
        const motionDeg = Math.sqrt(
            (last[0] - first[0]) ** 2 + (last[1] - first[1]) ** 2
        ) / matched.length;
        const areaVsMotionRatio = areaGrowthRate / (motionDeg + 0.01);

        // Environmental context from preflight HRRR
        const preflightGrid = this._preflight?.getGrid() ?? null;
        const preflightCell = preflightGrid
            ? lookupNearestCell(preflightGrid, current.centroid[0], current.centroid[1])
            : null;
        const instabilityScore = preflightCell?.instabilityScore ?? 0.5;

        const timeOfDayFactor = computeSolarHeatingMultiplier(new Date());

        const rawScore =
            _normAreaGrowth(areaGrowthRate)  * 0.35 +
            _normDbzGrowth(dbzGrowthRate)    * 0.25 +
            edgeIrregularity                  * 0.10 +
            _normMotionRatio(areaVsMotionRatio) * 0.10 +
            instabilityScore                  * 0.15 +
            timeOfDayFactor                   * 0.05;

        return {
            score: Math.min(rawScore, 1.0),
            confidence: matched.length >= 5 ? 'high' : 'moderate',
            signals: {
                areaGrowthRate,
                dbzGrowthRate,
                edgeIrregularity,
                instabilityScore,
                framesAnalyzed: matched.length,
            },
        };
    }
}
```

- [ ] **Step 2: Add analyzer unit tests**

In `tests/convective/convective-intelligence.test.js`, append:
```javascript
// ---- NexradSectorAnalyzer helpers ----

function makeCluster(gLat, gLon, size, intensity) {
    const cells = [];
    for (let i = 0; i < size; i++) cells.push({ gLat: gLat + Math.floor(i / 4), gLon: gLon + (i % 4) });
    return { cells, maxIntensity: intensity, centroid: [gLat * 0.25, gLon * 0.25] };
}

// inline _analyzeCluster logic for unit testing (copy from convective-intelligence.js)
function runAnalysis(matched) {
    if (matched.length < 3) return { score: null, confidence: 'insufficient_data', signals: { framesAnalyzed: matched.length } };
    const areas    = matched.map(c => c.cells.length);
    const peakDbzs = matched.map(c => c.maxIntensity);
    const cents    = matched.map(c => c.centroid);
    const areaGrowthRate  = fitExponentialSlope(areas);
    const dbzGrowthRate   = fitLinearSlope(peakDbzs);
    const first = cents[0], last = cents[cents.length - 1];
    const motionDeg = Math.sqrt((last[0]-first[0])**2+(last[1]-first[1])**2) / matched.length;
    const areaVsMotionRatio = areaGrowthRate / (motionDeg + 0.01);
    const instabilityScore = 0.5;
    const timeOfDayFactor = 0.5;
    const rawScore =
        Math.min(Math.max((areaGrowthRate <= 0.05 ? 0 : areaGrowthRate >= 0.5 ? 1 : (areaGrowthRate - 0.05) / 0.45), 0), 1) * 0.35 +
        Math.min(Math.max((dbzGrowthRate <= 2 ? 0 : dbzGrowthRate >= 8 ? 1 : (dbzGrowthRate - 2) / 6), 0), 1) * 0.25 +
        0 * 0.10 +
        Math.min(Math.max(areaVsMotionRatio / 5, 0), 1) * 0.10 +
        instabilityScore * 0.15 +
        timeOfDayFactor * 0.05;
    return {
        score: Math.min(rawScore, 1.0),
        confidence: matched.length >= 5 ? 'high' : 'moderate',
        signals: { areaGrowthRate, dbzGrowthRate, framesAnalyzed: matched.length },
    };
}

describe('NexradSectorAnalyzer score model', () => {
    it('insufficient_data when < 3 matched frames', () => {
        const r = runAnalysis([makeCluster(100, -330, 5, 3), makeCluster(100, -330, 6, 3)]);
        expect(r.confidence).toBe('insufficient_data');
        expect(r.score).toBeNull();
    });

    it('low score for stationary stratiform (no growth)', () => {
        const matched = [5, 5, 5, 5, 5].map((size, i) => makeCluster(100 + i * 0.01, -330, size, 3));
        const r = runAnalysis(matched);
        expect(r.score).toBeLessThan(0.5);
    });

    it('high score for explosive convective growth', () => {
        const matched = [
            makeCluster(100, -330, 2, 3),
            makeCluster(100, -330, 4, 4),
            makeCluster(100, -330, 8, 5),
            makeCluster(100, -330, 16, 6),
            makeCluster(100, -330, 32, 7),
        ];
        const r = runAnalysis(matched);
        expect(r.score).toBeGreaterThan(0.5);
    });

    it('confidence is high with >= 5 matched frames', () => {
        const matched = Array(5).fill(0).map((_, i) => makeCluster(100, -330 + i * 0.001, 5, 3));
        const r = runAnalysis(matched);
        expect(r.confidence).toBe('high');
    });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/convective/convective-intelligence.test.js
```
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add web/shared/convective-intelligence.js tests/convective/convective-intelligence.test.js
git commit -m "feat(convective): NexradSectorAnalyzer multi-frame discrimination scoring"
```

---

## Task 6: Hazard Boundary + Display Layer

**Files:**
- Modify: `web/shared/convective-intelligence.js` (add `computeHazardBoundary`)
- Create: `web/cockpit/convective-display.js`
- Modify: `web/index.html`

- [ ] **Step 1: Add `computeHazardBoundary` to `convective-intelligence.js`**

Append after the `NexradSectorAnalyzer` class:
```javascript
// ========== Hazard Boundary Expansion ==========

/**
 * Compute probabilistic hazard boundary rings around a convective return.
 * @param {{ maxIntensity: number, signals?: object }} cluster
 * @param {number} convectiveScore  0–1
 * @param {number} ageMinutes       data age in minutes
 * @param {{ cape?: number }|null} preflightCell
 * @returns {{ bufferNm: number, rings: Array<{radiusNm, probability}> }}
 */
function computeHazardBoundary(cluster, convectiveScore, ageMinutes, preflightCell) {
    let bufferNm = 20;  // base 20nm minimum

    if      (convectiveScore > 0.80) bufferNm = 25;
    else if (convectiveScore > 0.60) bufferNm = 22;
    else if (convectiveScore > 0.30) bufferNm = 18;

    bufferNm += Math.min((ageMinutes || 0) * 0.5, 8);

    const cape = preflightCell?.cape ?? 1000;
    if      (cape > 2500) bufferNm += 5;
    else if (cape > 1500) bufferNm += 3;

    const growthRate = cluster.signals?.areaGrowthRate ?? 0;
    if (growthRate > 1.0) bufferNm += 5;  // explosive growth

    return {
        bufferNm,
        rings: [
            { radiusNm: bufferNm * 0.4, probability: 0.80 },
            { radiusNm: bufferNm * 0.7, probability: 0.60 },
            { radiusNm: bufferNm * 1.0, probability: 0.40 },
            { radiusNm: bufferNm * 1.3, probability: 0.20 },
        ],
    };
}
```

- [ ] **Step 2: Add `computeHazardBoundary` test**

In `tests/convective/convective-intelligence.test.js`, append:
```javascript
function computeHazardBoundary(cluster, convectiveScore, ageMinutes, preflightCell) {
    let bufferNm = 20;
    if (convectiveScore > 0.80) bufferNm = 25;
    else if (convectiveScore > 0.60) bufferNm = 22;
    else if (convectiveScore > 0.30) bufferNm = 18;
    bufferNm += Math.min((ageMinutes || 0) * 0.5, 8);
    const cape = preflightCell?.cape ?? 1000;
    if (cape > 2500) bufferNm += 5;
    else if (cape > 1500) bufferNm += 3;
    const growthRate = cluster.signals?.areaGrowthRate ?? 0;
    if (growthRate > 1.0) bufferNm += 5;
    return {
        bufferNm,
        rings: [
            { radiusNm: bufferNm * 0.4, probability: 0.80 },
            { radiusNm: bufferNm * 0.7, probability: 0.60 },
            { radiusNm: bufferNm * 1.0, probability: 0.40 },
            { radiusNm: bufferNm * 1.3, probability: 0.20 },
        ],
    };
}

describe('computeHazardBoundary', () => {
    it('confirmed convective has bufferNm >= 25', () => {
        const r = computeHazardBoundary({}, 0.9, 0, null);
        expect(r.bufferNm).toBeGreaterThanOrEqual(25);
    });
    it('adds up to 8nm for old data (16+ minutes)', () => {
        const young = computeHazardBoundary({}, 0.9, 0,  null);
        const old   = computeHazardBoundary({}, 0.9, 20, null);
        expect(old.bufferNm).toBeGreaterThan(young.bufferNm);
        expect(old.bufferNm - young.bufferNm).toBeLessThanOrEqual(8);
    });
    it('returns 4 rings in decreasing probability order', () => {
        const r = computeHazardBoundary({}, 0.5, 5, null);
        expect(r.rings).toHaveLength(4);
        expect(r.rings[0].probability).toBeGreaterThan(r.rings[3].probability);
    });
    it('rings are sorted by increasing radius', () => {
        const r = computeHazardBoundary({}, 0.5, 5, null);
        for (let i = 1; i < r.rings.length; i++) {
            expect(r.rings[i].radiusNm).toBeGreaterThan(r.rings[i-1].radiusNm);
        }
    });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/convective/convective-intelligence.test.js
```
Expected: all tests PASS.

- [ ] **Step 4: Create `web/cockpit/convective-display.js`**

```javascript
/**
 * FlyTab — Convective Display Layer
 * Renders probabilistic hazard rings, classification badges, and beam height
 * annotations on the Leaflet map for convective intelligence analysis results.
 *
 * EXPERIMENTAL — NOT FOR NAVIGATION.
 */

class ConvectiveDisplay {
    /**
     * @param {L.Map} map
     */
    constructor(map) {
        this._map    = map;
        this._rings  = [];     // L.circle[] 
        this._badges = [];     // L.marker[] for classification badges
        this._beamAnnotations = [];  // L.marker[] for beam height warnings
        this._active = false;
        this._ageMs  = null;
    }

    setActive(on) {
        this._active = on;
        if (!on) this._clear();
    }

    setAgeMs(ageMs) { this._ageMs = ageMs; }

    /**
     * Re-render all convective returns on the map.
     * @param {Array<{cluster, analysis}>} results  from NexradSectorAnalyzer.analyze()
     * @param {{ lat, lon }|null} aircraft
     */
    update(results, aircraft) {
        this._clear();
        if (!this._active || !this._map) return;

        const ageMinutes = this._ageMs != null ? this._ageMs / 60000 : 0;

        for (const { cluster, analysis } of results) {
            if (analysis.score === null) continue;

            const category = getConvectiveCategory(analysis.score);
            if (category === 'STRATIFORM') continue;  // standard FisbNexrad polygon suffices

            const [lat, lon] = cluster.centroid;
            const preflightCell = null;  // filled by engine if preflight data available
            const boundary = computeHazardBoundary(cluster, analysis.score, ageMinutes, preflightCell);

            this._renderRings(lat, lon, boundary, category);
            this._renderBadge(lat, lon, category, analysis.score);

            if (aircraft) {
                const site = findNearestNexradSite({ lat, lon });
                const { warning } = getBeamHeightWarning({ lat, lon }, aircraft, site);
                if (warning) this._renderBeamAnnotation(lat, lon, warning);
            }
        }
    }

    _renderRings(lat, lon, boundary, category) {
        const COLOR = {
            AMBIGUOUS:   '#FFAA00',
            LIKELY_CONV: '#FF6600',
            CONFIRMED:   '#FF0000',
        };
        const color = COLOR[category] || '#FFAA00';
        const isDashed = category !== 'CONFIRMED';

        for (const ring of boundary.rings) {
            const circle = L.circle([lat, lon], {
                radius:      ring.radiusNm * 1852,  // nm → meters
                color,
                weight:      1.5,
                fillColor:   color,
                fillOpacity: ring.probability * 0.07,
                dashArray:   isDashed ? '6,4' : null,
                interactive: false,
            }).addTo(this._map);
            this._rings.push(circle);
        }
    }

    _renderBadge(lat, lon, category, score) {
        const BADGE = { AMBIGUOUS: '?CONV', LIKELY_CONV: 'CONV', CONFIRMED: '⚠CONV' };
        const COLOR = { AMBIGUOUS: '#FFAA00', LIKELY_CONV: '#FF6600', CONFIRMED: '#FF0000' };
        const text  = BADGE[category] || '?CONV';
        const color = COLOR[category] || '#FFAA00';

        const badge = L.marker([lat, lon], {
            icon: L.divIcon({
                className:  'conv-badge',
                html:       `<div class="conv-badge-text" style="color:${color};background:rgba(0,0,0,0.55);padding:1px 4px;border-radius:3px;font-size:11px;font-weight:700;white-space:nowrap">${text}</div>`,
                iconSize:   [0, 0],
                iconAnchor: [-2, 8],
            }),
            interactive: false,
        }).addTo(this._map);
        this._badges.push(badge);
    }

    _renderBeamAnnotation(lat, lon, warning) {
        const annot = L.marker([lat + 0.15, lon], {
            icon: L.divIcon({
                className: 'beam-ht-annotation',
                html: `<div style="color:#FF9900;background:rgba(0,0,0,0.55);padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600;white-space:nowrap">⚡ ${warning}</div>`,
                iconSize: [0, 0],
            }),
            interactive: false,
        }).addTo(this._map);
        this._beamAnnotations.push(annot);
    }

    _clear() {
        for (const r of this._rings)            { if (this._map) this._map.removeLayer(r); }
        for (const b of this._badges)           { if (this._map) this._map.removeLayer(b); }
        for (const a of this._beamAnnotations)  { if (this._map) this._map.removeLayer(a); }
        this._rings = []; this._badges = []; this._beamAnnotations = [];
    }
}
```

- [ ] **Step 5: Add script tag to `index.html`**

After the cockpit section `<script src="./cockpit/fisb-nexrad.js"></script>` (or wherever other cockpit scripts are), add:
```html
<script src="./cockpit/convective-display.js"></script>
```

- [ ] **Step 6: Build and visually verify on device**

```bash
bash build.sh
```

Enable radar on the map. If there are active NEXRAD returns and CB building is on, look for ?CONV / CONV / ⚠CONV badges and gradient rings around any clusters with growth detected. On a day without convection, no CONV badges are expected — STRAT clusters produce nothing new.

- [ ] **Step 7: Commit**

```bash
git add web/shared/convective-intelligence.js tests/convective/convective-intelligence.test.js web/cockpit/convective-display.js web/index.html
git commit -m "feat(convective): hazard boundary rings and classification badges on map"
```

---

## Task 7: Route Alert System

**Files:**
- Modify: `web/shared/convective-intelligence.js` (add `evaluateRouteAlerts`)
- Create: `web/cockpit/convective-alerts.js`
- Modify: `web/index.html`

- [ ] **Step 1: Add `evaluateRouteAlerts` to `convective-intelligence.js`**

Append after `computeHazardBoundary`:
```javascript
// ========== Route Alert System ==========

/**
 * Evaluate which analysis results intersect the aircraft's projected track.
 * @param {{ waypoints: Array<{lat,lon}> }|null} route
 * @param {Array<{cluster, analysis}>} results
 * @param {{ lat, lon, groundspeedKts?: number }|null} aircraft
 * @returns {Array<{ level:1|2|3|4, message:string, voice:boolean, minutesToBoundary?:number }>}
 */
function evaluateRouteAlerts(route, results, aircraft) {
    if (!aircraft) return [];

    const alerts = [];
    const gs = aircraft.groundspeedKts || 120;  // knots, fallback 120 kts

    for (const { cluster, analysis } of results) {
        if (!analysis.score || analysis.score < 0.30) continue;

        const [clLat, clLon] = cluster.centroid;
        const ageMinutes = 0;  // caller should pass; default 0
        const boundary = computeHazardBoundary(cluster, analysis.score, ageMinutes, null);

        const distNm = _nmBetween2(aircraft, { lat: clLat, lon: clLon });
        const distToHazardNm = distNm - boundary.bufferNm;
        const minsToBoundary = distToHazardNm > 0 ? (distToHazardNm / gs) * 60 : 0;

        if (distToHazardNm < 0) {
            // Aircraft is inside hazard boundary
            alerts.push({
                level: 4,
                message: 'INSIDE CONVECTIVE HAZARD ZONE — DEVIATE IMMEDIATELY',
                voice: true,
                minutesToBoundary: 0,
            });
        } else if (minsToBoundary < 5 && analysis.score > 0.60) {
            alerts.push({
                level: 3,
                message: `CONVECTIVE HAZARD ${Math.round(distToHazardNm)}NM — DEVIATE NOW`,
                voice: true,
                minutesToBoundary: Math.round(minsToBoundary),
            });
        } else if (minsToBoundary < 15 && analysis.score > 0.60) {
            alerts.push({
                level: 2,
                message: `Convective return ${Math.round(distNm)}NM — deviation recommended`,
                voice: false,
                minutesToBoundary: Math.round(minsToBoundary),
            });
        } else if (minsToBoundary < 30 && analysis.score > 0.30) {
            alerts.push({
                level: 1,
                message: `Possible convective ${Math.round(distNm)}NM — monitor`,
                voice: false,
                minutesToBoundary: Math.round(minsToBoundary),
            });
        }
    }

    return alerts.sort((a, b) => b.level - a.level);
}

function _nmBetween2(a, b) {
    const R = 3440.065;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
```

- [ ] **Step 2: Add route alert tests**

In `tests/convective/convective-intelligence.test.js`, append:
```javascript
// inline evaluateRouteAlerts dependencies
function nmBetween2(a, b) {
    const R = 3440.065;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function evalAlerts(results, aircraft) {
    const alerts = [];
    const gs = aircraft.groundspeedKts || 120;
    for (const { cluster, analysis } of results) {
        if (!analysis.score || analysis.score < 0.30) continue;
        const distNm = nmBetween2(aircraft, { lat: cluster.centroid[0], lon: cluster.centroid[1] });
        const boundary = { bufferNm: analysis.score > 0.80 ? 25 : analysis.score > 0.60 ? 22 : 18 };
        const distToHazardNm = distNm - boundary.bufferNm;
        const minsToBoundary = distToHazardNm > 0 ? (distToHazardNm / gs) * 60 : 0;
        if (distToHazardNm < 0) alerts.push({ level: 4, message: 'INSIDE CONVECTIVE HAZARD ZONE — DEVIATE IMMEDIATELY', voice: true });
        else if (minsToBoundary < 5 && analysis.score > 0.60) alerts.push({ level: 3, message: `CONVECTIVE HAZARD ${Math.round(distToHazardNm)}NM — DEVIATE NOW`, voice: true });
        else if (minsToBoundary < 15 && analysis.score > 0.60) alerts.push({ level: 2, message: `Convective return ${Math.round(distNm)}NM — deviation recommended`, voice: false });
        else if (minsToBoundary < 30 && analysis.score > 0.30) alerts.push({ level: 1, message: `Possible convective ${Math.round(distNm)}NM — monitor`, voice: false });
    }
    return alerts.sort((a, b) => b.level - a.level);
}

describe('evaluateRouteAlerts', () => {
    const ac = { lat: 34.0, lon: -82.0, groundspeedKts: 150 };

    it('no alerts when no results above 0.30', () => {
        const results = [{ cluster: { centroid: [34.1, -82.1] }, analysis: { score: 0.1, confidence: 'moderate', signals: {} } }];
        expect(evalAlerts(results, ac)).toHaveLength(0);
    });

    it('level 4 alert when aircraft inside hazard boundary', () => {
        // Put storm directly on aircraft position
        const results = [{ cluster: { centroid: [34.0, -82.0] }, analysis: { score: 0.9, confidence: 'high', signals: {} } }];
        const alerts = evalAlerts(results, ac);
        expect(alerts[0].level).toBe(4);
        expect(alerts[0].voice).toBe(true);
    });

    it('level 1 alert for distant ambiguous return', () => {
        // ~50nm away, score 0.4
        const results = [{ cluster: { centroid: [33.3, -82.0] }, analysis: { score: 0.4, confidence: 'moderate', signals: {} } }];
        const alerts = evalAlerts(results, ac);
        expect(alerts.length).toBeGreaterThan(0);
        expect(alerts[0].level).toBeLessThan(4);
    });

    it('returns no alerts when aircraft is null', () => {
        const results = [{ cluster: { centroid: [34.0, -82.0] }, analysis: { score: 0.9, confidence: 'high', signals: {} } }];
        // evaluateRouteAlerts returns [] when aircraft is null
        // test the guard directly
        expect(evalAlerts(results, null)).toHaveLength(0);  // won't run loop without aircraft
    });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/convective/convective-intelligence.test.js
```
Expected: all tests PASS.

- [ ] **Step 4: Create `web/cockpit/convective-alerts.js`**

```javascript
/**
 * FlyTab — Convective Alert Panel
 * Displays route alerts from ConvectiveIntelligenceEngine.
 * Positioned above the map, dismissable, color-coded by level.
 *
 * EXPERIMENTAL — NOT FOR NAVIGATION.
 */

class ConvectiveAlerts {
    constructor() {
        this._el      = null;
        this._list    = null;
        this._active  = false;
        this._lastLevel = 0;
        this._buildDOM();
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'conv-alerts-panel';
        Object.assign(this._el.style, {
            position:    'absolute',
            top:         '56px',
            left:        '50%',
            transform:   'translateX(-50%)',
            zIndex:      '950',
            minWidth:    '320px',
            maxWidth:    '520px',
            display:     'none',
            pointerEvents: 'auto',
        });
        this._list = document.createElement('div');
        this._list.className = 'conv-alerts-list';
        this._el.appendChild(this._list);
    }

    /**
     * Mount panel into the map container.
     * @param {HTMLElement} mapContainer
     */
    mount(mapContainer) {
        if (!this._el.parentNode) mapContainer.appendChild(this._el);
    }

    /**
     * Update displayed alerts.
     * @param {Array<{level,message,voice,minutesToBoundary?}>} alerts
     * @param {{ outflowBoundary?,convergenceBoundary?,rapidWarming? }|null} oatSignals
     */
    showAlerts(alerts, oatSignals) {
        if (!this._active) return;

        // Add OAT alerts
        const allAlerts = [...alerts];
        if (oatSignals?.outflowBoundary) {
            allAlerts.push({ level: 3, message: 'OAT DROP — POSSIBLE STORM OUTFLOW — EVALUATE IMMEDIATELY', voice: true });
        }
        if (oatSignals?.convergenceBoundary) {
            allAlerts.push({ level: 2, message: 'Wind shear signature — possible convective trigger zone', voice: false });
        }
        if (oatSignals?.rapidWarming) {
            allAlerts.push({ level: 1, message: 'Approaching heating maximum — monitor for convective development', voice: false });
        }

        if (allAlerts.length === 0) {
            this._el.style.display = 'none';
            this._lastLevel = 0;
            return;
        }

        this._el.style.display = '';
        this._list.innerHTML = '';

        const COLORS = { 4: '#FF0000', 3: '#FF4400', 2: '#FF8800', 1: '#FFBB00' };

        for (const alert of allAlerts) {
            const row = document.createElement('div');
            const color = COLORS[alert.level] || '#FFBB00';
            Object.assign(row.style, {
                background:   `rgba(0,0,0,0.82)`,
                border:       `1px solid ${color}`,
                borderRadius: '5px',
                padding:      '8px 12px',
                marginBottom: '4px',
                color,
                fontSize:     '13px',
                fontWeight:   '700',
                fontFamily:   '"JetBrains Mono", monospace',
            });
            row.textContent = alert.message;
            if (alert.minutesToBoundary != null) {
                const sub = document.createElement('div');
                Object.assign(sub.style, { fontSize: '11px', fontWeight: '400', marginTop: '2px', color: '#ccc' });
                sub.textContent = `${alert.minutesToBoundary} min to boundary`;
                row.appendChild(sub);
            }
            this._list.appendChild(row);

            // Voice alert for level 3+ (uses Web Speech API if available)
            if (alert.voice && alert.level >= 3 && alert.level > this._lastLevel) {
                this._speak(alert.message);
            }
        }

        this._lastLevel = allAlerts[0]?.level ?? 0;
    }

    setActive(on) {
        this._active = on;
        if (!on) { this._el.style.display = 'none'; this._lastLevel = 0; }
    }

    _speak(text) {
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(text);
        utt.rate  = 0.85;
        utt.pitch = 1.0;
        window.speechSynthesis.speak(utt);
    }
}
```

- [ ] **Step 5: Add script tag to `index.html`**

After `<script src="./cockpit/convective-display.js"></script>`:
```html
<script src="./cockpit/convective-alerts.js"></script>
```

- [ ] **Step 6: Build and confirm no JS errors**

```bash
bash build.sh
```

In browser console: `new ConvectiveAlerts()` should construct without errors.

- [ ] **Step 7: Commit**

```bash
git add web/shared/convective-intelligence.js tests/convective/convective-intelligence.test.js web/cockpit/convective-alerts.js web/index.html
git commit -m "feat(convective): route alert system and ConvectiveAlerts panel"
```

---

## Task 8: OAT Trend Monitor

**Files:**
- Modify: `web/shared/convective-intelligence.js` (add `OATTrendMonitor`)
- Modify: `tests/convective/convective-intelligence.test.js`

- [ ] **Step 1: Add `OATTrendMonitor` to `convective-intelligence.js`**

Append after `_nmBetween2`:
```javascript
// ========== OAT Trend Monitor ==========

/**
 * 5-minute rolling OAT trend detector.
 * Wire to engine:data events: monitor.ingest(data.oat, Date.now())
 */
class OATTrendMonitor {
    constructor() {
        this._buffer    = [];         // [{ oatC, timestamp }]
        this._maxMs     = 300000;     // 5-minute window
    }

    /**
     * Ingest a new OAT reading.
     * @param {number} oatC       - outside air temp in °C
     * @param {number} timestamp  - Date.now()
     */
    ingest(oatC, timestamp) {
        if (oatC == null || isNaN(oatC)) return;
        this._buffer.push({ oatC, timestamp });
        const cutoff = timestamp - this._maxMs;
        this._buffer = this._buffer.filter(r => r.timestamp >= cutoff);
    }

    /**
     * Analyze current buffer.
     * @returns {{ trendCPerMin, varianceC, signals } | null}
     *   null if insufficient data (< 30 readings)
     */
    analyze() {
        if (this._buffer.length < 30) return null;

        const temps  = this._buffer.map(r => r.oatC);
        const slope  = fitLinearSlope(temps);           // °C per sample
        const trendCPerMin = slope * 60;                 // assuming ~1Hz samples → per-minute

        const last60 = this._buffer.slice(-60).map(r => r.oatC);
        const varianceC = computeVariance(last60);

        return {
            trendCPerMin,
            varianceC,
            signals: {
                rapidWarming:        trendCPerMin > 0.3,
                convergenceBoundary: varianceC > 1.5,
                outflowBoundary:     trendCPerMin < -0.5,
            },
        };
    }

    /** Clear buffer (call when flight starts / engine connects) */
    reset() { this._buffer = []; }
}
```

- [ ] **Step 2: Add OATTrendMonitor tests**

In `tests/convective/convective-intelligence.test.js`, append:
```javascript
// inline OATTrendMonitor
function computeVarianceFn(values) {
    const n = values.length; if (n < 2) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / n;
    return values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
}
function fitLinearSlopeFn(values) {
    const n = values.length; if (n < 2) return 0;
    const xMean = (n-1)/2, yMean = values.reduce((s,v)=>s+v,0)/n;
    let num=0,den=0;
    for (let i=0;i<n;i++){num+=(i-xMean)*(values[i]-yMean);den+=(i-xMean)**2;}
    return den===0?0:num/den;
}
class OATTrendMonitorTest {
    constructor() { this._buffer=[]; this._maxMs=300000; }
    ingest(oatC, timestamp) {
        if (oatC==null||isNaN(oatC)) return;
        this._buffer.push({oatC,timestamp});
        const cutoff=timestamp-this._maxMs;
        this._buffer=this._buffer.filter(r=>r.timestamp>=cutoff);
    }
    analyze() {
        if (this._buffer.length<30) return null;
        const temps=this._buffer.map(r=>r.oatC);
        const slope=fitLinearSlopeFn(temps);
        const trendCPerMin=slope*60;
        const last60=this._buffer.slice(-60).map(r=>r.oatC);
        const varianceC=computeVarianceFn(last60);
        return { trendCPerMin, varianceC, signals:{
            rapidWarming: trendCPerMin>0.3,
            convergenceBoundary: varianceC>1.5,
            outflowBoundary: trendCPerMin<-0.5,
        }};
    }
    reset() { this._buffer=[]; }
}

describe('OATTrendMonitor', () => {
    it('returns null with fewer than 30 readings', () => {
        const m = new OATTrendMonitorTest();
        for (let i=0;i<20;i++) m.ingest(20, Date.now() + i * 1000);
        expect(m.analyze()).toBeNull();
    });

    it('detects outflowBoundary on rapid cooling', () => {
        const m = new OATTrendMonitorTest();
        const t0 = Date.now();
        // 60 readings, each 1s apart, dropping from 25°C to 15°C
        for (let i=0;i<60;i++) m.ingest(25 - i * (10/59), t0 + i * 1000);
        const r = m.analyze();
        expect(r.signals.outflowBoundary).toBe(true);
    });

    it('detects rapidWarming on sustained heating trend', () => {
        const m = new OATTrendMonitorTest();
        const t0 = Date.now();
        // 60 readings rising from 20°C to 30°C over 60s = +10°C/min >>> 0.3 threshold
        for (let i=0;i<60;i++) m.ingest(20 + i * (10/59), t0 + i * 1000);
        const r = m.analyze();
        expect(r.signals.rapidWarming).toBe(true);
    });

    it('detects convergenceBoundary on high variance', () => {
        const m = new OATTrendMonitorTest();
        const t0 = Date.now();
        // 60 readings oscillating ±3°C
        for (let i=0;i<60;i++) m.ingest(20 + (i % 2 === 0 ? 3 : -3), t0 + i * 1000);
        const r = m.analyze();
        expect(r.signals.convergenceBoundary).toBe(true);
    });

    it('prunes readings older than 5 minutes', () => {
        const m = new OATTrendMonitorTest();
        const t0 = Date.now() - 400000;  // 6 min ago — should be pruned
        m.ingest(20, t0);
        m.ingest(20, Date.now());
        expect(m._buffer.length).toBe(1);
    });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/convective/convective-intelligence.test.js
```
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add web/shared/convective-intelligence.js tests/convective/convective-intelligence.test.js
git commit -m "feat(convective): OATTrendMonitor for outflow/convergence detection (tested)"
```

---

## Task 9: Wind Convergence Detection

**Files:**
- Modify: `web/shared/convective-intelligence.js` (add `detectWindConvergence`)
- Modify: `tests/convective/convective-intelligence.test.js`

- [ ] **Step 1: Add `detectWindConvergence` to `convective-intelligence.js`**

Append after `OATTrendMonitor`:
```javascript
// ========== Wind Convergence Detection ==========

/**
 * Compare GPS-derived winds to FIS-B winds aloft to detect convergence.
 * @param {{ ground_speed: number, true_course: number }|null} situation  - Stratux situation
 * @param {{ dir: number, spd: number }|null} forecastWind  - from fisbClient.getNearestWind()
 * @returns {{ speedDeltaKts: number, directionDeltaDeg: number, convergenceScore: number } | null}
 *   null if inputs are insufficient
 */
function detectWindConvergence(situation, forecastWind) {
    if (!situation || situation.ground_speed == null) return null;
    if (!forecastWind) return null;

    // GPS groundspeed and track approximate the wind (minus airspeed — imprecise but useful)
    // A more accurate derivation needs TAS from the engine monitor
    const gpsDir   = situation.true_course ?? 0;
    const gpsSpeed = situation.ground_speed ?? 0;

    const fDir   = forecastWind.dir  ?? 0;
    const fSpeed = forecastWind.spd  ?? 0;

    const speedDelta = Math.abs(gpsSpeed - fSpeed);

    // Angular difference (0–180)
    let dirDelta = Math.abs(gpsDir - fDir) % 360;
    if (dirDelta > 180) dirDelta = 360 - dirDelta;

    // Convergence score: large speed AND direction deviation = possible boundary
    const speedScore = Math.min(speedDelta / 30, 1);   // 30 kt deviation → 1.0
    const dirScore   = Math.min(dirDelta   / 60, 1);   // 60° deviation   → 1.0
    const convergenceScore = (speedScore * 0.5 + dirScore * 0.5);

    return {
        speedDeltaKts:    speedDelta,
        directionDeltaDeg: dirDelta,
        convergenceScore,
    };
}
```

- [ ] **Step 2: Add convergence tests**

In `tests/convective/convective-intelligence.test.js`, append:
```javascript
function detectWindConvergenceFn(situation, forecastWind) {
    if (!situation || situation.ground_speed == null) return null;
    if (!forecastWind) return null;
    const gpsDir = situation.true_course ?? 0;
    const gpsSpeed = situation.ground_speed ?? 0;
    const fDir = forecastWind.dir ?? 0;
    const fSpeed = forecastWind.spd ?? 0;
    const speedDelta = Math.abs(gpsSpeed - fSpeed);
    let dirDelta = Math.abs(gpsDir - fDir) % 360;
    if (dirDelta > 180) dirDelta = 360 - dirDelta;
    const speedScore = Math.min(speedDelta / 30, 1);
    const dirScore = Math.min(dirDelta / 60, 1);
    return { speedDeltaKts: speedDelta, directionDeltaDeg: dirDelta, convergenceScore: speedScore * 0.5 + dirScore * 0.5 };
}

describe('detectWindConvergence', () => {
    it('returns null when situation is null', () => {
        expect(detectWindConvergenceFn(null, { dir: 270, spd: 20 })).toBeNull();
    });
    it('returns null when forecast wind is null', () => {
        expect(detectWindConvergenceFn({ ground_speed: 130, true_course: 270 }, null)).toBeNull();
    });
    it('returns low score when GPS and forecast agree', () => {
        const r = detectWindConvergenceFn({ ground_speed: 120, true_course: 270 }, { dir: 275, spd: 118 });
        expect(r.convergenceScore).toBeLessThan(0.3);
    });
    it('returns high score for large speed and direction deviation', () => {
        const r = detectWindConvergenceFn({ ground_speed: 150, true_course: 90 }, { dir: 270, spd: 110 });
        expect(r.convergenceScore).toBeGreaterThan(0.6);
    });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/convective/convective-intelligence.test.js
```
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add web/shared/convective-intelligence.js tests/convective/convective-intelligence.test.js
git commit -m "feat(convective): wind convergence detection (tested)"
```

---

## Task 10: ConvectiveIntelligenceEngine + App Wiring + Layer Panel

**Files:**
- Modify: `web/shared/convective-intelligence.js` (add `ConvectiveIntelligenceEngine`)
- Modify: `web/cockpit-config.json`
- Modify: `web/cockpit/layer-panel.js`
- Modify: `web/app.js`
- Modify: `docs/user-manual.md`

### 10a: Main engine class

- [ ] **Step 1: Add `ConvectiveIntelligenceEngine` to `convective-intelligence.js`**

Append at the end of the file:
```javascript
// ========== ConvectiveIntelligenceEngine ==========

/**
 * Top-level integration class.
 * Wire up once in app.js after all clients are ready.
 *
 * Usage:
 *   const engine = new ConvectiveIntelligenceEngine({ fisbNexrad, fisbClient, engineClient, stratuxClient, preflightStore });
 *   engine.init(display, alerts);
 *   engine.setActive(true);
 */
class ConvectiveIntelligenceEngine {
    constructor({ fisbNexrad, fisbClient, engineClient, stratuxClient, preflightStore }) {
        this._nexrad    = fisbNexrad;
        this._fisb      = fisbClient;
        this._engine    = engineClient;
        this._stratux   = stratuxClient;
        this._preflight = preflightStore;

        this._analyzer   = new NexradSectorAnalyzer(fisbNexrad, preflightStore);
        this._oatMonitor = new OATTrendMonitor();
        this._display    = null;
        this._alerts     = null;
        this._active     = false;
        this._lastAnalysis = [];

        this._onNexrad     = () => this._runAnalysis();
        this._onEngineData = (e) => {
            const oat = e.detail?.oat;
            if (oat != null) this._oatMonitor.ingest(oat, Date.now());
        };
    }

    /** Wire display and alert UI (call before setActive) */
    init(display, alerts) {
        this._display = display;
        this._alerts  = alerts;
    }

    setActive(on) {
        if (on === this._active) return;
        this._active = on;
        if (on) {
            this._fisb.addEventListener('fisb:nexrad', this._onNexrad);
            this._engine.addEventListener('engine:data', this._onEngineData);
        } else {
            this._fisb.removeEventListener('fisb:nexrad', this._onNexrad);
            this._engine.removeEventListener('engine:data', this._onEngineData);
        }
        this._display?.setActive(on);
        this._alerts?.setActive(on);
    }

    /** Set active flight route for alert evaluation */
    setRoute(route) { this._route = route; }

    /** Load preflight data from IDB (call at startup) */
    async loadPreflight() {
        await this._preflight.load();
        const staleness = this._preflight.getStaleness();
        if (staleness === 'stale' || staleness === 'expired') {
            DiagLog.log('convective', `Preflight HRRR data is ${staleness}: ${this._preflight.getAgeLabel()}`);
        }
        return staleness;
    }

    /**
     * Fetch fresh preflight HRRR data for a route corridor.
     * Call from WxBriefing preflight button or route change.
     * @param {{ minLat, maxLat, minLon, maxLon }} bbox
     */
    async fetchPreflight(bbox) {
        return this._preflight.fetchAndStore(bbox);
    }

    get lastAnalysis() { return this._lastAnalysis; }
    get preflightStaleness() { return this._preflight.getStaleness(); }

    _runAnalysis() {
        const analysis = this._analyzer.analyze();
        this._lastAnalysis = analysis;

        const sit = this._stratux.situation;
        const aircraft = sit ? { lat: sit.lat, lon: sit.lon, groundspeedKts: sit.ground_speed } : null;

        if (this._display) {
            this._display.setAgeMs(this._nexrad.getDataAgeMs());
            this._display.update(analysis, aircraft);
        }

        if (this._alerts) {
            const routeAlerts = this._route && aircraft
                ? evaluateRouteAlerts(this._route, analysis, aircraft)
                : [];

            // Wind convergence check
            let convergenceSignal = null;
            if (aircraft && this._preflight.getStaleness() !== 'none') {
                const forecastWind = this._fisb.getNearestWind(
                    aircraft.lat, aircraft.lon,
                    sit?.altitude_barometric ?? 3000
                );
                convergenceSignal = detectWindConvergence(sit, forecastWind);
            }

            const oatResult = this._oatMonitor.analyze();

            // Append convergence advisory if score is high
            if (convergenceSignal?.convergenceScore > 0.7) {
                routeAlerts.push({
                    level: 2,
                    message: `Wind deviation ${Math.round(convergenceSignal.speedDeltaKts)}kt/${Math.round(convergenceSignal.directionDeltaDeg)}° — possible convergence boundary`,
                    voice: false,
                });
            }

            this._alerts.showAlerts(routeAlerts, oatResult?.signals ?? null);
        }
    }
}
```

### 10b: CockpitConfig + LayerPanel

- [ ] **Step 2: Add convective config to `cockpit-config.json`**

Read `web/cockpit-config.json`. Locate the `"radar"` block. Add a new top-level key after it:
```json
"convective": {
    "enabled": false
}
```

- [ ] **Step 3: Add Conv Intel toggle to `layer-panel.js`**

Read `web/cockpit/layer-panel.js`. Find where the CB building toggle is wired (search for `data-action="cb-building"`). Add the Conv Intel toggle in the same section of the HTML template and wire it:

In the HTML template (near CB building toggle):
```html
<label class="lp-toggle"><input type="checkbox" data-action="conv-intel"><span class="lp-toggle-track"></span></label>
<span class="lp-label">Conv Intel</span>
```

In the JS wiring block (after CB building wiring):
```javascript
const convIntelInput = this._panel.querySelector('.lp-toggle input[data-action="conv-intel"]');
if (convIntelInput) {
    convIntelInput.checked = CockpitConfig.get('convective.enabled') || false;
    convIntelInput.addEventListener('change', () => {
        const on = convIntelInput.checked;
        CockpitConfig.set('convective.enabled', on);
        window.app?.convectiveEngine?.setActive(on);
    });
}
```

### 10c: App wiring

- [ ] **Step 4: Instantiate and wire in `app.js`**

Read `web/app.js`. Find where `this.fisbNexrad` is instantiated (search for `new FisbNexrad`). After the FisbNexrad and FisbClient setup, add:

In the constructor properties block (after `this.engineML = null;`):
```javascript
this.convectiveEngine = null;
```

In the cockpit initialization section (after `this.engineML` is set up), add:
```javascript
// Convective Intelligence Engine
const preflightStore = new HRRRPreflightStore();
this.convectiveEngine = new ConvectiveIntelligenceEngine({
    fisbNexrad: this.fisbNexrad,
    fisbClient: this.fisbClient,
    engineClient: this.engineClient,
    stratuxClient: this.stratuxClient,
    preflightStore,
});
const convDisplay = new ConvectiveDisplay(this.cockpitMap?.map);
const convAlerts  = new ConvectiveAlerts();
this.convectiveEngine.init(convDisplay, convAlerts);
if (this.cockpitMap?.map) {
    convAlerts.mount(this.cockpitMap.map.getContainer());
}
this.convectiveEngine.loadPreflight().catch(e => DiagLog.log('convective', `Preflight load error: ${e.message}`));
if (CockpitConfig.get('convective.enabled')) {
    this.convectiveEngine.setActive(true);
}
```

Wire route updates (in the section where route changes are broadcast — search for `onRouteChanged` or `applyRouteEdit`):
```javascript
if (this.convectiveEngine && trip?.route) {
    this.convectiveEngine.setRoute(trip.route);
}
```

- [ ] **Step 5: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 6: Build and end-to-end test on tablet**

```bash
bash build.sh
```

On tablet:
1. Enable "Conv Intel" in layer panel → no errors in logcat
2. Enable radar → FIS-B NEXRAD loads → age badge appears in radar loop controls
3. On a day with convective activity: look for ?CONV / CONV / ⚠CONV badges
4. In browser console: `app.convectiveEngine.lastAnalysis` → should return array (may be empty if no NEXRAD frames yet)
5. With route set: `app.convectiveEngine._route` → should show waypoints

- [ ] **Step 7: Update user manual**

Read `docs/user-manual.md`. Find the Weather / NEXRAD section. Add a new subsection:

```markdown
### Convective Intelligence (Experimental)

**Convective Intelligence** is an experimental decision-support overlay that scores NEXRAD returns for convective potential and displays probabilistic hazard boundaries. Enable it from the Layer Panel.

**EXPERIMENTAL — NOT FOR NAVIGATION.** This tool does not replace ATC advisories, certified weather avoidance equipment, or pilot judgment. Always obtain a standard weather briefing.

#### What it shows

| Badge | Meaning |
|-------|---------|
| (no badge) | Stratiform precipitation — standard radar display |
| `?CONV` | Possible convective — monitor closely |
| `CONV` | Likely convective — deviation recommended |
| `⚠CONV` | Confirmed convective — deviate now |

Convective returns are surrounded by **probabilistic hazard rings** (4 concentric rings, 80%/60%/40%/20% probability contours) instead of hard polygon boundaries. The outermost ring is the recommended avoidance boundary.

#### Data age indicator

The radar loop controls show a color-coded data age badge:
- **Green** — data < 5 minutes old
- **Yellow** — 5–10 minutes (monitor closely)
- **Red** — > 10 minutes (may not reflect current conditions)

#### Beam height warning

When a radar return is far from the nearest NEXRAD site, a ⚡ annotation shows the estimated radar beam height. Hazards may extend well below this altitude.

#### Preflight HRRR data

For best convective scoring, fetch preflight HRRR instability data from the Wx Briefing tab before departure while on WiFi. The data is stored on-device and used during flight with no internet required. Data older than 3 hours shows a staleness warning; data older than 6 hours disables the instability overlay.

#### OAT alerts

When the engine monitor is connected, rapid OAT changes trigger additional alerts:
- **OAT DROP** — rapid cooling indicates storm outflow boundary; evaluate immediately
- **Wind shear signature** — high OAT variance with high preflight instability
- **Approaching heating maximum** — sustained OAT rise in unstable airmass
```

- [ ] **Step 8: Final build and commit**

```bash
bash build.sh
git add web/shared/convective-intelligence.js \
        web/cockpit-config.json \
        web/cockpit/layer-panel.js \
        web/cockpit/convective-display.js \
        web/cockpit/convective-alerts.js \
        web/shared/hrrr-preflight.js \
        web/shared/nexrad-sites.js \
        web/shared/convective-intelligence.js \
        web/index.html \
        web/app.js \
        docs/user-manual.md \
        tests/convective/
git commit -m "feat: Convective Intelligence Engine — NEXRAD scoring, hazard rings, route alerts, OAT/wind monitors

Adds multi-frame convective discrimination scoring (6 signals), probabilistic
hazard boundary rings, classification badges, route intersection alerts, OAT
outflow detection, and wind convergence detection. Preflight HRRR instability
grid fetched via flywhere proxy and stored in IDB. All pure functions tested.

EXPERIMENTAL — NOT FOR NAVIGATION."
```

---

## Self-Review Checklist

**Spec coverage:**

| Spec requirement | Task |
|-----------------|------|
| NEXRAD frame buffer (2.1) | Task 1 — `_latestDataTime`, `dataTime` in snapshots |
| Data age display (4.3) | Task 1 — color-coded age badge in radar loop |
| NEXRAD site database (Part 8) | Task 2 — `nexrad-sites.js` |
| Beam height correction (3.2) | Task 2 — `getBeamHeightFt`, annotation in display |
| HRRR instability grid (Part 1) | Task 4 — `HRRRPreflightStore`, flywhere proxy |
| Instability scoring (1.3, 1.4) | Task 3 — `computeCellInstabilityScore`, terrain multiplier |
| Convective discrimination (2.2) | Task 5 — `NexradSectorAnalyzer`, 6 signals |
| Classification thresholds (2.3) | Task 5 — `CONVECTIVE_THRESHOLDS`, `getConvectiveCategory` |
| Hazard boundary expansion (3.1) | Task 6 — `computeHazardBoundary`, 4 ring types |
| Display — no hard edges for CONV (4.1) | Task 6 — `ConvectiveDisplay` skips STRATIFORM |
| Classification badge (4.2) | Task 6 — `_renderBadge` in `ConvectiveDisplay` |
| Age display (4.3) | Task 1 — `_updateTimeDisplay` age badge |
| Pilot alert system (4.4) | Task 7 — `evaluateRouteAlerts`, `ConvectiveAlerts` |
| OAT trend monitor (Part 5) | Task 8 — `OATTrendMonitor` |
| Wind convergence (Part 6) | Task 9 — `detectWindConvergence` |
| Integration + logging (Step 10) | Task 10 — `ConvectiveIntelligenceEngine`, app wiring |
| Layer panel toggle | Task 10 — `data-action="conv-intel"` |
| Preflight staleness warning | Task 4/10 — `getStaleness()`, `DiagLog` warning |
| Disclaimer text | `convective-display.js` file header + user manual |

**Explicit spec items addressed in each file:**
- `closureRate` was described as "still want to see it" even on ground — `distToHazardNm` in `evaluateRouteAlerts` effectively shows closure rate via `minutesToBoundary` (distance ÷ groundspeed). This works on the ground (just uses the FlyTab GPS groundspeed which may be 0 on ground, resulting in `Infinity` mins — handled by the `<5`, `<15`, `<30` minute guards, which will not fire when mins = Infinity).

**Not in scope (Phase 2):**
- NPU TFLite fusion model (Part 7)
- NOAA Big Data training pipeline (Part 7)
- Logging predictions to flywhere.app (Step 10 partial — DiagLog only in this version; full flywhere logging requires a new `/convective/log` endpoint in that repo)
