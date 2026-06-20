# Winds Aloft + Altitude Performance — Implementation Plan (Milestone 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the FlyTab route planner to produce wind-corrected, altitude-accurate time and fuel estimates per leg, with per-waypoint altitude overrides, departure time/ETA, VFR auto-altitude, power setting, and a pilot-facing warning strip.

**Architecture:** Extend `recomputeLegs` in `route-planner.js` to accept `{ departureTime, winds, cruiseAltFt, pctPower }`, computing altitude-correct TAS (via ISA model) and wind-corrected GS per leg. New `winds-interpolator.js` fetches AWC FD forecasts using a departure-time-derived cycle, falling back to FIS-B cache and then calm air. New leg fields (`eta`, `windSpd`) join the already-present `tasKt`, `gsKt`, `windDir`, `altFt`. Route-table, nav strip, and planner panel are wired to display the new values. Pre-implementation cleanup removes three duplicate math functions from `route-table.js` and consolidates haversine.

**Tech Stack:** Vanilla JS ES modules, Vitest (`npm test`) for planning-lib tests, `bash build.sh` for APK verification. No bundler. New files loaded via `<script>` in `web/index.html`.

---

## File Map

| File | Status | Change |
|---|---|---|
| `web/shared/planning/math/route-math.js` | Modify | Add `iasToTas`, `groundSpeed`, `vfrAltitude`, `windCorrectedMagHdg` |
| `web/shared/planning/math/engine-data.js` | Modify | Extend `gphAtPower(profile, frac, altFt, mixture)`, add `maxPowerAtAltitude` |
| `web/shared/planning/math/fuel-phases.js` | Modify | Extend `LegOpts` with `gsKt`, `tasKt`; use them in cruise phase |
| `web/shared/planning/types/aircraft-profile.js` | Modify | Add `cruise_ias`, `max_hp`, `alt_power_loss_pct_per_kft`, `sfc_lop/rop/full_rich` |
| `web/shared/planning/types/flight-plan.js` | Modify | Add `windSpd` and `eta` to `Leg`; note `Waypoint.altFt` is the per-fix altitude override |
| `web/shared/planning/planner/route-planner.js` | Modify | Extend `recomputeLegs` signature; add `RV9A_FALLBACK.max_hp`/`cruise_ias` |
| `web/shared/planning/planner/winds-interpolator.js` | **Create** | `fetchWinds`, `selectFdCycle`, `getWindAtAlt`, `findNearestFdStation` |
| `web/shared/planning/index.js` | Modify | Export new math functions and `WindsInterpolator` |
| `web/shared/nasr-db.js` | Modify | `haversineNm` delegates to planning lib |
| `web/cockpit/route-table.js` | Modify | Remove `_bearing`, `_crossTrackNm`; move `_computeMagHdg` to planning lib; ETA column; read plan leg fields pre-flight |
| `web/cockpit/route-planner-panel.js` | Modify | Departure time picker, altitude selector, power % selector, per-fix altitude override, stats bar update, amber warnings |
| `web/cockpit/route-nav-strip.js` | Modify | Show `destEta` as local time |
| `web/index.html` | Modify | Add `<script>` for `winds-interpolator.js` |
| `web/app.js` | Modify | Version bump |
| `tests/planning/math/route-math.test.js` | Modify | Add tests for new functions |
| `tests/planning/math/engine-data.test.js` | Modify | Add tests for extended `gphAtPower`, `maxPowerAtAltitude` |
| `tests/planning/math/fuel-phases.test.js` | Modify | Add tests for `gsKt`/`tasKt` overrides |
| `tests/planning/planner/winds-interpolator.test.js` | **Create** | Tests for wind lookup and fetch logic |

---

## Phase 0: Pre-Implementation Cleanup

### Task 1: Consolidate haversine — delete NasrDB.haversineNm

**Files:**
- Modify: `web/shared/nasr-db.js` (search for `haversineNm`)
- Modify: `web/cockpit/route-planner-panel.js` (any `NasrDB.haversineNm` call)

- [ ] **Step 1: Find all haversineNm callers**

```bash
grep -rn "haversineNm" web/ --include="*.js"
```

Note every call site and file. Expected: `nasr-db.js` definition + calls in `route-planner-panel.js` and possibly `route-table.js`.

- [ ] **Step 2: Make NasrDB.haversineNm delegate to planning lib**

In `web/shared/nasr-db.js`, find `static haversineNm(` and replace its body with a delegation. Read the file first to find the exact location. The planning lib's `haversine` is imported via the `FlyTabPlanning` global in browser context. Since `nasr-db.js` loads before the planning lib is ready, delegate via a direct implementation that matches, but leave a deprecation note:

```javascript
// Delegates to planning/math/route-math.js — prefer haversine() from FlyTabPlanning
static haversineNm(lat1, lon1, lat2, lon2) {
    if (typeof FlyTabPlanning !== 'undefined' && FlyTabPlanning.haversine) {
        return FlyTabPlanning.haversine(lat1, lon1, lat2, lon2);
    }
    // Fallback if planning lib not yet ready
    const R = 3440.065;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
}
```

- [ ] **Step 3: Update route-planner-panel.js to call NasrDB.haversineNm directly (no change needed — it already does this; note it will auto-use planning lib after Task 1)**

Run a quick grep to confirm no raw haversine reimplementations in route-planner-panel:
```bash
grep -n "haversine\|Math.asin\|Math.sin.*lat" web/cockpit/route-planner-panel.js | head -20
```

- [ ] **Step 4: Commit**

```bash
git add web/shared/nasr-db.js
git commit -m "refactor: haversineNm delegates to planning lib haversine"
```

---

### Task 2: Delete duplicate bearing and crossTrack in route-table.js

**Files:**
- Modify: `web/cockpit/route-table.js`

- [ ] **Step 1: Find the private methods**

```bash
grep -n "_bearing\|_crossTrackNm\|crossTrackNm" web/cockpit/route-table.js | head -20
```

- [ ] **Step 2: Verify the planning lib exports these**

```bash
grep -n "bearing\|crossTrackDistanceNm" web/shared/planning/index.js
```

Expected: `haversine, bearing, intermediatePoint, formatTime` exported. `crossTrackDistanceNm` is NOT currently exported — check:

```bash
grep -n "crossTrack" web/shared/planning/index.js
```

If not exported, add it to `web/shared/planning/index.js` in the route-math export line:
```javascript
export {
    haversine, bearing, intermediatePoint, crossTrackDistanceNm, formatTime,
} from './math/route-math.js';
```

Also add it to the `window.FlyTabPlanning` object in the same file (add `crossTrackDistanceNm` to the spread of `rm`).

- [ ] **Step 3: Replace _bearing() calls with FlyTabPlanning.bearing()**

In `route-table.js`, the class uses `this._bearing(lat1, lon1, lat2, lon2)`. Replace the private method body and each call site. Since `FlyTabPlanning` is a global populated on `flytab-planning:ready`, route-table.js can call `FlyTabPlanning.bearing(...)` directly.

Read `route-table.js` around the `_bearing` definition (grep showed it at line ~2993). Replace the method with a delegation stub that can be removed later, then update callers to use `FlyTabPlanning.bearing`:

```javascript
// In _computeEnroute and other callers, replace:
//   this._bearing(lat1, lon1, lat2, lon2)
// with:
//   FlyTabPlanning.bearing(lat1, lon1, lat2, lon2)
```

Do the same for `_crossTrackNm` → `FlyTabPlanning.crossTrackDistanceNm`.

- [ ] **Step 4: Run tests to confirm nothing broke**

```bash
npm test
```

Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/route-table.js web/shared/planning/index.js
git commit -m "refactor: route-table uses planning lib bearing and crossTrack"
```

---

### Task 3: Move _computeMagHdg to route-math.js

**Files:**
- Modify: `web/shared/planning/math/route-math.js`
- Modify: `web/cockpit/route-table.js`
- Modify: `tests/planning/math/route-math.test.js`

- [ ] **Step 1: Read the existing _computeMagHdg in route-table.js**

```bash
grep -n "_computeMagHdg\|magVar\|sinWca\|wca" web/cockpit/route-table.js | head -30
```

Read the full method at the line shown. It should look like:
```javascript
_computeMagHdg(brg, wind, tas, lat, lon) {
    const toRad = Math.PI / 180;
    const sinWca = (wind.spd * Math.sin((wind.dir - brg) * toRad)) / Math.max(tas, 1);
    const wcaDeg = Math.asin(Math.max(-1, Math.min(1, sinWca))) / toRad;
    const magVar = -6.0 + (lon + 90) * -0.12 + (lat - 35) * 0.05;
    return ((brg + wcaDeg - magVar) + 360) % 360;
}
```

- [ ] **Step 2: Write failing test**

In `tests/planning/math/route-math.test.js`, add:
```javascript
import { windCorrectedMagHdg } from '../../../web/shared/planning/math/route-math.js';

describe('windCorrectedMagHdg', () => {
    it('with no wind returns bearing minus mag var (CONUS approx)', () => {
        // At lat=34, lon=-81 (SC): magVar ≈ -6 + (-81+90)*-0.12 + (34-35)*0.05 = -6 + 9*-0.12 + (-0.05) = -6 -1.08 -0.05 ≈ -7.13
        // bearing 90° true → mag hdg ≈ 90 - (-7.13) = 97.13°
        const hdg = windCorrectedMagHdg(90, 34, -81, 150, 0, 0);
        expect(hdg).toBeCloseTo(97.1, 0);
    });
    it('direct headwind shifts heading toward track', () => {
        // 270° track, wind from 270° (direct headwind) → no WCA
        const hdg = windCorrectedMagHdg(270, 34, -81, 150, 270, 20);
        const hdgNoWind = windCorrectedMagHdg(270, 34, -81, 150, 0, 0);
        expect(Math.abs(hdg - hdgNoWind)).toBeLessThan(1);
    });
    it('90° crosswind produces WCA', () => {
        // 360° track, wind from 090° (right crosswind at 30 kt, tas 150)
        // WCA = asin(30/150) ≈ 11.5° left
        const hdg = windCorrectedMagHdg(360, 34, -81, 150, 90, 30);
        const hdgNoWind = windCorrectedMagHdg(360, 34, -81, 150, 0, 0);
        expect(hdgNoWind - hdg).toBeCloseTo(11.5, 0);
    });
});
```

- [ ] **Step 3: Run test — confirm FAIL**

```bash
npm test -- tests/planning/math/route-math.test.js
```

Expected: FAIL — `windCorrectedMagHdg is not a function`.

- [ ] **Step 4: Add windCorrectedMagHdg to route-math.js**

Append to `web/shared/planning/math/route-math.js`:

```javascript
/**
 * Simplified CONUS magnetic variation (±2° accuracy).
 * @param {number} lat
 * @param {number} lon
 * @returns {number} degrees (positive = west variation)
 */
function _magVarConus(lat, lon) {
    return -6.0 + (lon + 90) * -0.12 + (lat - 35) * 0.05;
}

/**
 * Wind-corrected magnetic heading from a true bearing.
 * @param {number} brgTrue  true bearing to destination, degrees
 * @param {number} lat      midpoint latitude (for mag var)
 * @param {number} lon      midpoint longitude
 * @param {number} tas      true airspeed, kt
 * @param {number} windDir  wind FROM direction, degrees true
 * @param {number} windSpd  wind speed, kt
 * @returns {number} magnetic heading, degrees 0–360
 */
export function windCorrectedMagHdg(brgTrue, lat, lon, tas, windDir, windSpd) {
    const toRad = Math.PI / 180;
    let wcaDeg = 0;
    if (windSpd > 0 && tas > 0) {
        const sinWca = (windSpd * Math.sin((windDir - brgTrue) * toRad)) / tas;
        wcaDeg = Math.asin(Math.max(-1, Math.min(1, sinWca))) / toRad;
    }
    const magVar = _magVarConus(lat, lon);
    return ((brgTrue + wcaDeg - magVar) + 360) % 360;
}
```

- [ ] **Step 5: Run test — confirm PASS**

```bash
npm test -- tests/planning/math/route-math.test.js
```

- [ ] **Step 6: Update route-table.js to call FlyTabPlanning.windCorrectedMagHdg**

Find `_computeMagHdg` calls in route-table.js (grep showed it at `_computeEnroute` line ~1350). Replace:
```javascript
// Before:
wp._hdg = this._computeMagHdg(brg, wind, tas, midLat, midLon);
// After:
wp._hdg = FlyTabPlanning.windCorrectedMagHdg(brg, midLat, midLon, tas, wind?.dir ?? 0, wind?.spd ?? 0);
```

Delete the `_computeMagHdg` private method body.

- [ ] **Step 7: Export windCorrectedMagHdg from planning index**

In `web/shared/planning/index.js`, update the route-math export:
```javascript
export {
    haversine, bearing, intermediatePoint, crossTrackDistanceNm,
    formatTime, windCorrectedMagHdg,
} from './math/route-math.js';
```

Also add `windCorrectedMagHdg` to the `...rm` spread in `window.FlyTabPlanning`.

- [ ] **Step 8: Run all tests**

```bash
npm test
```

- [ ] **Step 9: Commit**

```bash
git add web/shared/planning/math/route-math.js web/shared/planning/index.js web/cockpit/route-table.js tests/planning/math/route-math.test.js
git commit -m "refactor: move windCorrectedMagHdg to planning lib, remove route-table duplicate"
```

---

## Phase 1: Math Functions

### Task 4: Add iasToTas, groundSpeed, vfrAltitude to route-math.js

**Files:**
- Modify: `web/shared/planning/math/route-math.js`
- Modify: `tests/planning/math/route-math.test.js`

- [ ] **Step 1: Write failing tests**

Append to `tests/planning/math/route-math.test.js`:

```javascript
import { iasToTas, groundSpeed, vfrAltitude } from '../../../web/shared/planning/math/route-math.js';

describe('iasToTas', () => {
    it('at sea level standard day, IAS ≈ TAS', () => {
        expect(iasToTas(100, 0, null)).toBeCloseTo(100, 0);
    });
    it('at 8000 ft standard day, TAS > IAS by ~12%', () => {
        // ISA: ~12% increase per 8000 ft
        const tas = iasToTas(148, 8000, null);
        expect(tas).toBeGreaterThan(155);
        expect(tas).toBeLessThan(165);
    });
    it('warmer OAT increases TAS', () => {
        const cold = iasToTas(148, 8000, -15);
        const warm = iasToTas(148, 8000, 15);
        expect(warm).toBeGreaterThan(cold);
    });
});

describe('groundSpeed', () => {
    it('direct headwind reduces GS by wind speed', () => {
        // tas=150, course=360, wind from 360 at 20kt
        expect(groundSpeed(150, 360, 360, 20)).toBeCloseTo(130, 0);
    });
    it('direct tailwind increases GS by wind speed', () => {
        // tas=150, course=360, wind from 180 at 20kt
        expect(groundSpeed(150, 360, 180, 20)).toBeCloseTo(170, 0);
    });
    it('crosswind reduces GS slightly', () => {
        // 90° crosswind reduces GS by crosswind²/2TAS approximately
        const gs = groundSpeed(150, 360, 90, 30);
        expect(gs).toBeLessThan(150);
        expect(gs).toBeGreaterThan(130);
    });
    it('calm wind returns TAS', () => {
        expect(groundSpeed(155, 270, 0, 0)).toBeCloseTo(155, 0);
    });
});

describe('vfrAltitude', () => {
    it('eastbound short route returns 3500 or 5500 ft', () => {
        // KLKR→KCLT bearing ~30° (eastbound), dist ~32nm → short → 3500 or 4000 base
        const alt = vfrAltitude(30, { lat: 34.73, lon: -81.21 }, { lat: 35.21, lon: -80.94 });
        expect([3500, 5500]).toContain(alt);
    });
    it('westbound medium route returns even+500', () => {
        // ~220° course, 200nm → 8000 base → 8500 westbound
        const alt = vfrAltitude(220, { lat: 35, lon: -80 }, { lat: 33, lon: -83 });
        expect(alt % 2000).toBe(500);
        expect(alt).toBeGreaterThanOrEqual(4500);
    });
    it('eastbound long route returns odd+500', () => {
        // ~090° course, 400nm → 10000 base → 9500 or 11500
        const alt = vfrAltitude(90, { lat: 35, lon: -95 }, { lat: 35, lon: -80 });
        expect(alt % 2000).toBe(500);
        const remainder = ((alt - 500) / 1000) % 2;
        expect(remainder).toBe(1); // odd thousand
    });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
npm test -- tests/planning/math/route-math.test.js
```

Expected: FAIL — functions not exported.

- [ ] **Step 3: Add iasToTas, groundSpeed, vfrAltitude to route-math.js**

Append to `web/shared/planning/math/route-math.js`:

```javascript
/**
 * Convert indicated airspeed to true airspeed using ISA atmosphere.
 * @param {number} ias   indicated airspeed, kt
 * @param {number} altFt pressure altitude, ft
 * @param {number|null} tempC  OAT in °C; null = ISA standard
 * @returns {number} TAS in kt
 */
export function iasToTas(ias, altFt, tempC) {
    const T0 = 288.15;
    const lapseRate = 0.001981; // K/ft
    const Tstd = T0 - lapseRate * altFt;
    const delta = Math.pow(Tstd / T0, 5.2561);
    const Tactual = (tempC !== null && tempC !== undefined) ? tempC + 273.15 : Tstd;
    const sigma = delta * (T0 / Tactual);
    return ias / Math.sqrt(sigma);
}

/**
 * Ground speed from TAS, course, and wind.
 * @param {number} tas       true airspeed, kt
 * @param {number} course    true course, degrees
 * @param {number} windDir   wind FROM direction, degrees true
 * @param {number} windSpd   wind speed, kt
 * @returns {number} ground speed, kt
 */
export function groundSpeed(tas, course, windDir, windSpd) {
    if (!windSpd) return tas;
    const toRad = Math.PI / 180;
    const wca = (windDir - course) * toRad;
    const headwind = windSpd * Math.cos(wca);
    const crosswind = windSpd * Math.sin(wca);
    const crossSq = crosswind * crosswind;
    const tasSq = tas * tas;
    if (crossSq >= tasSq) return tas * 0.5;
    return Math.max(Math.sqrt(tasSq - crossSq) - headwind, tas * 0.3);
}

/**
 * VFR hemispheric altitude for a given magnetic course and route.
 * @param {number} magCourse  overall magnetic course, degrees
 * @param {{lat:number,lon:number}} depCoord
 * @param {{lat:number,lon:number}} destCoord
 * @returns {number} altitude in feet
 */
export function vfrAltitude(magCourse, depCoord, destCoord) {
    const eastbound = magCourse >= 0 && magCourse < 180;
    const dist = haversine(depCoord.lat, depCoord.lon, destCoord.lat, destCoord.lon);
    let targetAlt;
    if (dist < 50)       targetAlt = 4000;
    else if (dist < 150) targetAlt = 6000;
    else if (dist < 300) targetAlt = 8000;
    else                 targetAlt = 10000;
    if (eastbound) {
        const thousands = Math.round(targetAlt / 2000) * 2 - 1;
        return Math.max(3500, Math.min(thousands * 1000 + 500, 17500));
    } else {
        const thousands = Math.round(targetAlt / 2000) * 2;
        return Math.max(4500, Math.min(thousands * 1000 + 500, 16500));
    }
}
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
npm test -- tests/planning/math/route-math.test.js
```

- [ ] **Step 5: Export new functions from planning index**

In `web/shared/planning/index.js`, update the route-math export line to include the new functions:
```javascript
export {
    haversine, bearing, intermediatePoint, crossTrackDistanceNm,
    formatTime, windCorrectedMagHdg,
    iasToTas, groundSpeed, vfrAltitude,
} from './math/route-math.js';
```

Also add them to the `window.FlyTabPlanning` spread (`...rm` already covers them).

- [ ] **Step 6: Run all tests**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add web/shared/planning/math/route-math.js web/shared/planning/index.js tests/planning/math/route-math.test.js
git commit -m "feat(math): add iasToTas, groundSpeed, vfrAltitude (ported from flywhere)"
```

---

## Phase 2: Engine and Profile Types

### Task 5: Extend AircraftProfile type and RV-9A default

**Files:**
- Modify: `web/shared/planning/types/aircraft-profile.js`
- Modify: `web/shared/planning/planner/route-planner.js`

- [ ] **Step 1: Add new fields to AircraftProfile typedef**

In `web/shared/planning/types/aircraft-profile.js`, extend the `@typedef AircraftProfile` block:

```javascript
/**
 * @typedef AircraftEquipment
 * @property {boolean} vAirways
 * @property {boolean} tAirways
 * @property {boolean} jAirways
 * @property {boolean} gpsApproach
 *
 * @typedef AircraftProfile
 * @property {string}  id
 * @property {string}  tailNumber
 * @property {string}  model
 * @property {number}  cruise_ktas
 * @property {number}  [cruise_ias]             indicated airspeed at cruise power (kt)
 * @property {number}  fuel_burn_gph
 * @property {number}  fuel_capacity_gal
 * @property {number}  reserve_gal
 * @property {number}  [best_alt_ft]
 * @property {number}  [climb_rate_fpm]
 * @property {number}  [service_ceiling_ft]
 * @property {number}  [taxi_burn_gal]
 * @property {number}  [max_hp]                 engine rated HP; enables SFC-based fuel burn
 * @property {number}  [alt_power_loss_pct_per_kft]  % power lost per 1000 ft (default 3.0)
 * @property {number}  [sfc_lop]                override LOP SFC, gal/HP/hr (default 0.067)
 * @property {number}  [sfc_rop]                override ROP SFC, gal/HP/hr (default 0.083)
 * @property {number}  [sfc_full_rich]          override full-rich SFC (default 0.093)
 * @property {AircraftEquipment} equipment
 */
```

- [ ] **Step 2: Update RV-9A fallback profile in route-planner.js**

In `web/shared/planning/planner/route-planner.js`, find `const RV9A_FALLBACK = {` and add engine fields:

```javascript
const RV9A_FALLBACK = {
    id: 'rv9a-default',
    tailNumber: '',
    model: 'RV-9A',
    cruise_ktas: 155,
    cruise_ias: 148,       // 155 KTAS at 8000 ft ISA ≈ 148 KIAS
    fuel_burn_gph: 8.0,
    fuel_capacity_gal: 36,
    reserve_gal: 10,
    climb_rate_fpm: 750,
    service_ceiling_ft: 17500,
    taxi_burn_gal: 1.5,
    max_hp: 180,           // Lycoming O-360-A1A
    alt_power_loss_pct_per_kft: 3.0,
    equipment: { vAirways: true, tAirways: false, jAirways: false, gpsApproach: true },
};
```

- [ ] **Step 3: Commit**

```bash
git add web/shared/planning/types/aircraft-profile.js web/shared/planning/planner/route-planner.js
git commit -m "feat(types): add engine performance fields to AircraftProfile; update RV-9A default"
```

---

### Task 6: Extend engine-data.js with maxPowerAtAltitude and mixture-aware gphAtPower

**Files:**
- Modify: `web/shared/planning/math/engine-data.js`
- Modify: `tests/planning/math/engine-data.test.js`

- [ ] **Step 1: Write failing tests**

Append to `tests/planning/math/engine-data.test.js`:

```javascript
import { maxPowerAtAltitude, gphAtPower } from '../../../web/shared/planning/math/engine-data.js';

const RV9A_FULL = {
    cruise_ktas: 155, cruise_ias: 148, fuel_burn_gph: 8.0,
    service_ceiling_ft: 17500, max_hp: 180, alt_power_loss_pct_per_kft: 3.0,
};

describe('maxPowerAtAltitude', () => {
    it('returns ~100% at sea level', () => {
        expect(maxPowerAtAltitude(RV9A_FULL, 0)).toBeCloseTo(100, 0);
    });
    it('returns ~70% at 10000 ft (3% per 1000 ft loss)', () => {
        expect(maxPowerAtAltitude(RV9A_FULL, 10000)).toBeCloseTo(70, 0);
    });
    it('clamps to 0 at or above ceiling', () => {
        expect(maxPowerAtAltitude(RV9A_FULL, 40000)).toBe(0);
    });
});

describe('gphAtPower (extended)', () => {
    it('LOP at 65% power, 8000 ft: ~7.8 gal/hr for 180 HP engine', () => {
        // 0.65 * 180 * 0.067 = 7.839
        const gph = gphAtPower(RV9A_FULL, 0.65, 8000, 'LOP');
        expect(gph).toBeCloseTo(7.8, 0);
    });
    it('ROP burns more than LOP at same power', () => {
        const lop = gphAtPower(RV9A_FULL, 0.65, 8000, 'LOP');
        const rop = gphAtPower(RV9A_FULL, 0.65, 8000, 'ROP');
        expect(rop).toBeGreaterThan(lop);
    });
    it('power is capped at altitude maximum', () => {
        // At 10000 ft, max is 70%; requesting 90% should give same as 70%
        const capped = gphAtPower(RV9A_FULL, 0.90, 10000, 'LOP');
        const atMax  = gphAtPower(RV9A_FULL, 0.70, 10000, 'LOP');
        expect(capped).toBeCloseTo(atMax, 1);
    });
    it('falls back to linear scaling for profiles without max_hp', () => {
        const simple = { cruise_ktas: 120, fuel_burn_gph: 8.0 };
        expect(gphAtPower(simple, 0.75)).toBeCloseTo(8.0, 1);
        expect(gphAtPower(simple, 0.65)).toBeCloseTo(8.0 * (0.65 / 0.75), 1);
    });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
npm test -- tests/planning/math/engine-data.test.js
```

Expected: FAIL — `maxPowerAtAltitude is not a function`.

- [ ] **Step 3: Extend engine-data.js**

Replace the content of `web/shared/planning/math/engine-data.js` with the extended version (keep existing functions, add new ones):

```javascript
// @ts-check
'use strict';

/**
 * @typedef {import('../types/aircraft-profile.js').AircraftProfile} AircraftProfile
 */

const DEFAULT_BEST_ALT_FT = 8000;

// SFC defaults (gal/HP/hr) — ported from flywhere engine-data.ts
const SFC = { LOP: 0.067, ROP: 0.083, FULL_RICH: 0.093 };

/**
 * Maximum available power as a percentage at a given altitude.
 * @param {AircraftProfile} profile
 * @param {number} altFt
 * @returns {number} 0–100
 */
export function maxPowerAtAltitude(profile, altFt) {
    const lossPerKft = profile.alt_power_loss_pct_per_kft ?? 3.0;
    return Math.max(0, 100 - (altFt / 1000) * lossPerKft);
}

/**
 * Fuel burn in GPH at a given power fraction.
 * When profile has max_hp, uses SFC-based model (altitude and mixture aware).
 * Otherwise falls back to linear scaling from fuel_burn_gph (assumed at 75% ROP).
 * @param {AircraftProfile} profile
 * @param {number} powerFrac   0–1 requested power fraction
 * @param {number} [altFt]     altitude for power cap (ignored if no max_hp)
 * @param {string} [mixture]   'LOP' | 'ROP' | 'FULL_RICH' (default 'ROP')
 * @returns {number} GPH
 */
export function gphAtPower(profile, powerFrac, altFt, mixture) {
    if (profile.max_hp) {
        const maxPct = (altFt !== undefined) ? maxPowerAtAltitude(profile, altFt) / 100 : 1.0;
        const effectiveFrac = Math.min(powerFrac, maxPct);
        const mix = mixture || 'ROP';
        const sfc = profile['sfc_' + mix.toLowerCase()] ?? SFC[mix] ?? SFC.ROP;
        return effectiveFrac * profile.max_hp * sfc;
    }
    return profile.fuel_burn_gph * (powerFrac / 0.75);
}

/**
 * TAS at a given altitude, knots.
 * @param {AircraftProfile} profile
 * @param {number} altFt
 * @returns {number}
 */
export function tasAtAltitude(profile, altFt) {
    const best = profile.best_alt_ft ?? DEFAULT_BEST_ALT_FT;
    const tasBest = profile.cruise_ktas;
    if (altFt <= best) {
        const f = altFt / best;
        return tasBest * (0.85 + 0.15 * f);
    }
    return tasBest - (altFt - best) / 1000;
}

/**
 * Climb rate fpm at altitude. Linear from sea-level rate to 0 at service ceiling.
 * @param {AircraftProfile} profile
 * @param {number} altFt
 * @returns {number}
 */
export function climbRateAtAltitude(profile, altFt) {
    const sl = profile.climb_rate_fpm ?? 700;
    const ceil = profile.service_ceiling_ft ?? 14000;
    if (altFt >= ceil) return 0;
    return Math.max(0, sl * (1 - altFt / ceil));
}
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
npm test -- tests/planning/math/engine-data.test.js
```

- [ ] **Step 5: Export maxPowerAtAltitude from planning index**

In `web/shared/planning/index.js`, update the engine-data export:
```javascript
export { tasAtAltitude, gphAtPower, climbRateAtAltitude, maxPowerAtAltitude } from './math/engine-data.js';
```

- [ ] **Step 6: Run all tests**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add web/shared/planning/math/engine-data.js web/shared/planning/index.js tests/planning/math/engine-data.test.js
git commit -m "feat(engine): SFC-based gphAtPower with altitude/mixture; add maxPowerAtAltitude"
```

---

## Phase 3: Plan Types and Leg Decomposition

### Task 7: Extend FlightPlan types and decomposeLeg

**Files:**
- Modify: `web/shared/planning/types/flight-plan.js`
- Modify: `web/shared/planning/math/fuel-phases.js`
- Modify: `tests/planning/math/fuel-phases.test.js`

- [ ] **Step 1: Add windSpd and eta to Leg typedef**

In `web/shared/planning/types/flight-plan.js`, extend the `Leg` typedef. Note: `Waypoint.altFt` already exists and serves as the per-fix altitude override (no new field needed there). Existing `windDir`, `windKt`, `tasKt`, `gsKt`, `percentPwr`, `altFt` are already present.

Add the two missing fields to the `@typedef Leg` block:

```javascript
 * @property {number} [windSpd]           wind speed used for this leg (kt) — complements windDir
 * @property {number} [eta]               absolute ETA at 'to' waypoint (UTC ms since epoch)
```

- [ ] **Step 2: Write failing test for decomposeLeg with gsKt override**

Read `tests/planning/math/fuel-phases.test.js` first, then append:

```javascript
describe('decomposeLeg with gsKt/tasKt overrides', () => {
    const profile = { cruise_ktas: 155, fuel_burn_gph: 8.0, max_hp: 180 };

    it('gsKt override controls cruise time', () => {
        // 155 nm cruise, no wind normally, but override GS to 130 kt (headwind)
        const slow = decomposeLeg(profile, { distNm: 155, altFt: 6500, gsKt: 130 });
        const fast = decomposeLeg(profile, { distNm: 155, altFt: 6500 });
        expect(slow.totalTimeHrs).toBeGreaterThan(fast.totalTimeHrs);
    });

    it('tasKt override controls climb/descent TAS', () => {
        const hiAlt = decomposeLeg(profile, {
            distNm: 200, altFt: 9500, departingFromGround: true, tasKt: 162,
        });
        const loAlt = decomposeLeg(profile, {
            distNm: 200, altFt: 5500, departingFromGround: true,
        });
        // Higher TAS should cover more climb distance in same time
        expect(hiAlt.phases.climb.distNm).toBeGreaterThanOrEqual(loAlt.phases.climb.distNm);
    });
});
```

- [ ] **Step 3: Run test — confirm FAIL**

```bash
npm test -- tests/planning/math/fuel-phases.test.js
```

- [ ] **Step 4: Extend decomposeLeg in fuel-phases.js**

Update `LegOpts` typedef and `decomposeLeg` to honor `gsKt` and `tasKt`:

Replace the existing `LegOpts` typedef:
```javascript
/**
 * @typedef LegOpts
 * @property {number}  distNm
 * @property {number}  altFt
 * @property {boolean} [departingFromGround]
 * @property {boolean} [endingAtGround]
 * @property {number}  [windKt]     tailwind +, headwind - (scalar component)
 * @property {number}  [gsKt]       wind-corrected GS override — when set, used for cruise time
 * @property {number}  [tasKt]      altitude-corrected TAS override — when set, used for climb/descent
 */
```

In `decomposeLeg`, use the overrides where appropriate:

```javascript
export function decomposeLeg(profile, leg) {
    const wind = leg.windKt ?? 0;
    const overrideTas = leg.tasKt;
    const overrideGs  = leg.gsKt;

    const phases = {
        taxi:    { timeHrs: 0, fuelGal: 0, distNm: 0, altFt: 0 },
        climb:   { timeHrs: 0, fuelGal: 0, distNm: 0, altFt: leg.altFt },
        cruise:  { timeHrs: 0, fuelGal: 0, distNm: leg.distNm, altFt: leg.altFt },
        descent: { timeHrs: 0, fuelGal: 0, distNm: 0, altFt: leg.altFt },
    };

    if (leg.departingFromGround) {
        phases.taxi = {
            timeHrs: 0, fuelGal: profile.taxi_burn_gal ?? 1.5, distNm: 0, altFt: 0,
        };
        const climbRate = (climbRateAtAltitude(profile, 0) + climbRateAtAltitude(profile, leg.altFt)) / 2 || 1;
        const climbHrs  = leg.altFt / climbRate / 60;
        const tasClimb  = overrideTas ? iasToTasAtMid(overrideTas, leg.altFt) : tasAtAltitude(profile, leg.altFt / 2);
        const climbDist = (tasClimb + wind) * climbHrs;
        phases.climb = {
            timeHrs: climbHrs,
            fuelGal: gphAtPower(profile, 0.75, leg.altFt / 2, 'FULL_RICH') * climbHrs * 1.10,
            distNm:  Math.min(climbDist, leg.distNm * 0.4),
            altFt:   leg.altFt,
        };
    }

    if (leg.endingAtGround) {
        const descRate  = 500;
        const descHrs   = leg.altFt / descRate / 60;
        const tasDesc   = overrideTas ? iasToTasAtMid(overrideTas, leg.altFt) : tasAtAltitude(profile, leg.altFt / 2);
        const descDist  = (tasDesc + wind) * descHrs;
        phases.descent = {
            timeHrs: descHrs,
            fuelGal: gphAtPower(profile, 0.55, leg.altFt / 2, 'FULL_RICH') * descHrs,
            distNm:  Math.min(descDist, leg.distNm * 0.3),
            altFt:   leg.altFt,
        };
    }

    const cruiseDist = Math.max(0, leg.distNm - phases.climb.distNm - phases.descent.distNm);
    const tasCruise  = overrideTas ?? tasAtAltitude(profile, leg.altFt);
    const gsCruise   = overrideGs  ?? Math.max(1, tasCruise + wind);
    const cruiseHrs  = cruiseDist / Math.max(1, gsCruise);
    phases.cruise = {
        timeHrs: cruiseHrs,
        fuelGal: gphAtPower(profile, 0.75, leg.altFt, 'LOP') * cruiseHrs,
        distNm:  cruiseDist,
        altFt:   leg.altFt,
    };

    const totalTimeHrs = phases.taxi.timeHrs + phases.climb.timeHrs + phases.cruise.timeHrs + phases.descent.timeHrs;
    const totalFuelGal = phases.taxi.fuelGal + phases.climb.fuelGal + phases.cruise.fuelGal + phases.descent.fuelGal;
    return { phases, totalTimeHrs, totalFuelGal };
}

// Scale TAS proportionally when mid-altitude TAS is needed from cruise TAS override
function iasToTasAtMid(cruiseTas, cruiseAltFt) {
    return cruiseTas * (1 - 0.075 * (cruiseAltFt / 2) / cruiseAltFt);
}
```

- [ ] **Step 5: Run tests — confirm PASS**

```bash
npm test -- tests/planning/math/fuel-phases.test.js
```

- [ ] **Step 6: Run all tests**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add web/shared/planning/types/flight-plan.js web/shared/planning/math/fuel-phases.js tests/planning/math/fuel-phases.test.js
git commit -m "feat(planning): extend Leg type with windSpd/eta; decomposeLeg honors gsKt/tasKt overrides"
```

---

## Phase 4: Winds Infrastructure

### Task 8: Create winds-interpolator.js

**Files:**
- Create: `web/shared/planning/planner/winds-interpolator.js`
- Create: `tests/planning/planner/winds-interpolator.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/planning/planner/winds-interpolator.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { getWindAtAlt, selectFdCycle, findNearestFdStation } from '../../../web/shared/planning/planner/winds-interpolator.js';

const SAMPLE_WINDS = {
    CLT: { 3000: { dir: 270, spd: 10, temp: 15 }, 6000: { dir: 280, spd: 20, temp: 5 }, 9000: { dir: 290, spd: 25, temp: -5 } },
    GSP: { 3000: { dir: 260, spd: 8 }, 6000: { dir: 275, spd: 18 }, 9000: { dir: 285, spd: 22 } },
};

// FD_STATIONS subset for testing
const FD_LOCS = { CLT: [35.21, -80.94], GSP: [34.9, -82.22] };

describe('getWindAtAlt', () => {
    it('returns exact match when available', () => {
        const w = getWindAtAlt(SAMPLE_WINDS.CLT, 6000);
        expect(w.dir).toBe(280);
        expect(w.spd).toBe(20);
    });
    it('returns nearest key when exact not available', () => {
        const w = getWindAtAlt(SAMPLE_WINDS.CLT, 7000);
        // 7000 is closer to 6000 than 9000
        expect(w.dir).toBe(280);
    });
    it('returns null for empty station', () => {
        expect(getWindAtAlt({}, 6000)).toBeNull();
    });
});

describe('selectFdCycle', () => {
    it('early morning UTC → 06 cycle', () => {
        expect(selectFdCycle(5)).toBe('06');
    });
    it('midday UTC → 12 cycle', () => {
        expect(selectFdCycle(12)).toBe('12');
    });
    it('evening UTC → 24 cycle', () => {
        expect(selectFdCycle(22)).toBe('24');
    });
});

describe('findNearestFdStation', () => {
    it('returns nearest station by lat/lon', () => {
        // KLKR is closer to GSP (34.9, -82.22) than CLT (35.21, -80.94)
        const nearest = findNearestFdStation(SAMPLE_WINDS, 34.73, -81.21, FD_LOCS);
        // Both are plausible — just confirm a string is returned
        expect(['CLT', 'GSP']).toContain(nearest);
    });
    it('returns null when no station coords known', () => {
        expect(findNearestFdStation(SAMPLE_WINDS, 34, -81, {})).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
npm test -- tests/planning/planner/winds-interpolator.test.js
```

- [ ] **Step 3: Create winds-interpolator.js**

Create `web/shared/planning/planner/winds-interpolator.js`:

```javascript
// @ts-check
'use strict';

const CACHE_KEY  = 'flypi_winds_cache';
const CACHE_MINS = 60; // re-fetch after 1 hour

/**
 * Select the AWC FD forecast cycle based on departure UTC hour.
 * @param {number} utcHour  0–23
 * @returns {'06'|'12'|'24'}
 */
export function selectFdCycle(utcHour) {
    if (utcHour < 9)  return '06';
    if (utcHour < 21) return '12';
    return '24';
}

/**
 * Get wind entry for the altitude closest to altFt.
 * @param {Record<number,{dir:number,spd:number,temp?:number,variable?:boolean}>} stationWinds
 * @param {number} altFt
 * @returns {{dir:number,spd:number,temp?:number,variable?:boolean}|null}
 */
export function getWindAtAlt(stationWinds, altFt) {
    const keys = Object.keys(stationWinds).map(Number);
    if (!keys.length) return null;
    let best = keys[0];
    for (const k of keys) {
        if (Math.abs(k - altFt) < Math.abs(best - altFt)) best = k;
    }
    return stationWinds[best] ?? null;
}

/**
 * Find the nearest FD reporting station to a lat/lon.
 * @param {Record<string,any>} allWinds
 * @param {number} lat
 * @param {number} lon
 * @param {Record<string,[number,number]>} [fdLocs]  override for testing; defaults to WeatherClient.FD_STATIONS
 * @returns {string|null} station ID
 */
export function findNearestFdStation(allWinds, lat, lon, fdLocs) {
    // In browser context, delegate to WeatherClient which has the full FD_STATIONS lookup
    if (typeof WeatherClient !== 'undefined' && WeatherClient.findNearestFdStation) {
        return WeatherClient.findNearestFdStation(allWinds, lat, lon);
    }
    // Test / non-browser fallback using provided fdLocs
    if (!fdLocs) return null;
    let best = null;
    let bestDist = Infinity;
    for (const id of Object.keys(allWinds)) {
        const coords = fdLocs[id];
        if (!coords) continue;
        const dLat = coords[0] - lat;
        const dLon = (coords[1] - lon) * Math.cos(lat * Math.PI / 180);
        const dist = dLat * dLat + dLon * dLon;
        if (dist < bestDist) { bestDist = dist; best = id; }
    }
    return best;
}

/**
 * Fetch winds aloft, trying AWC → FIS-B cache → localStorage cache → null.
 * @param {Date} departureTime  used to select FD cycle
 * @returns {Promise<Record<string,Record<number,{dir:number,spd:number,temp?:number,variable?:boolean}>>|null>}
 */
export async function fetchWinds(departureTime) {
    const cycle = selectFdCycle((departureTime ?? new Date()).getUTCHours());
    const cacheKey = `${CACHE_KEY}_${cycle}`;

    // 1. Try fresh AWC fetch
    try {
        const url = `https://aviationweather.gov/api/data/windtemp?region=all&level=low&fcst=${cycle}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (resp.ok) {
            const text = await resp.text();
            if (typeof WeatherClient !== 'undefined' && WeatherClient.parseAllWindsAloft) {
                const winds = WeatherClient.parseAllWindsAloft(text);
                if (Object.keys(winds).length > 0) {
                    try {
                        localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), winds }));
                    } catch (_) {}
                    return winds;
                }
            }
        }
    } catch (_) {}

    // 2. Try FIS-B winds from last Stratux connection
    //    (FIS-B wind format investigation required at implementation time — see spec)
    //    When fisb-client.js exposes winds in canonical shape, wire here.

    // 3. Try localStorage cache
    try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (cached && Date.now() - cached.ts < CACHE_MINS * 60_000) {
            return cached.winds;
        }
    } catch (_) {}

    return null;
}
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
npm test -- tests/planning/planner/winds-interpolator.test.js
```

- [ ] **Step 5: Add winds-interpolator to index.js exports**

In `web/shared/planning/index.js`, add a new export line (winds-interpolator is not spread into FlyTabPlanning — it's used by the panel directly):
```javascript
export { fetchWinds, getWindAtAlt, findNearestFdStation, selectFdCycle } from './planner/winds-interpolator.js';
```

- [ ] **Step 6: Run all tests**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add web/shared/planning/planner/winds-interpolator.js web/shared/planning/index.js tests/planning/planner/winds-interpolator.test.js
git commit -m "feat(winds): add winds-interpolator with fetchWinds, getWindAtAlt, findNearestFdStation"
```

---

## Phase 5: Upgrade recomputeLegs

### Task 9: Extend recomputeLegs with altitude, TAS, GS, wind, ETA, and fuel

**Files:**
- Modify: `web/shared/planning/planner/route-planner.js`
- Modify: `tests/planning/planner/route-planner.test.js`

- [ ] **Step 1: Read the current recomputeLegs**

```bash
grep -n "recomputeLegs\|cruiseAltFt\|tasKt\|gsKt\|fuelRem" web/shared/planning/planner/route-planner.js | head -40
```

The current signature is `recomputeLegs(plan, profileOverride)`. It sets `tasKt: profile.cruise_ktas` and `gsKt: profile.cruise_ktas` (flat, no wind/altitude).

- [ ] **Step 2: Write failing tests**

Read `tests/planning/planner/route-planner.test.js`, then append:

```javascript
// Tests for extended recomputeLegs
describe('recomputeLegs with winds and altitude', () => {
    const profile = {
        id: 'test', tailNumber: '', model: 'Test',
        cruise_ktas: 155, cruise_ias: 148, fuel_burn_gph: 8.0,
        fuel_capacity_gal: 36, reserve_gal: 10,
        climb_rate_fpm: 750, service_ceiling_ft: 17500, taxi_burn_gal: 1.5,
        max_hp: 180,
        equipment: { vAirways: true, tAirways: false, jAirways: false, gpsApproach: true },
    };
    const simplePlan = {
        departure: 'KLKR', destination: 'KCLT',
        cruiseAltFt: 6500,
        reserveGal: 10,
        waypoints: [
            { id: 'KLKR', lat: 34.7281, lon: -81.2128 },
            { id: 'KCLT', lat: 35.2140, lon: -80.9431 },
        ],
        options: { routingMode: 'v-airways', maxLegHrs: 2, selfServeOnly: false, avoidance: [] },
    };

    it('populates legAltFt from cruiseAltFt when no waypoint override', () => {
        const planner = new RoutePlanner({ aero: null, plans: null });
        const result = planner.recomputeLegs(simplePlan, profile);
        expect(result.legs[0].altFt).toBe(6500);
    });

    it('uses waypoint.altFt as per-leg altitude override', () => {
        const planWithOverride = {
            ...simplePlan,
            waypoints: [
                { id: 'KLKR', lat: 34.7281, lon: -81.2128 },
                { id: 'KCLT', lat: 35.2140, lon: -80.9431, altFt: 9500 },
            ],
        };
        const planner = new RoutePlanner({ aero: null, plans: null });
        const result = planner.recomputeLegs(planWithOverride, profile);
        expect(result.legs[0].altFt).toBe(9500);
    });

    it('headwind increases flight time', () => {
        const winds = { CLT: { 6000: { dir: 80, spd: 30 } } }; // ~headwind for KLKR→KCLT (bearing ~030)
        const planner = new RoutePlanner({ aero: null, plans: null });
        const calm   = planner.recomputeLegs(simplePlan, profile);
        const windy  = planner.recomputeLegs(simplePlan, profile, { winds });
        expect(windy.legs[0].timeHrs).toBeGreaterThan(calm.legs[0].timeHrs);
    });

    it('populates eta on each leg as UTC ms', () => {
        const dep = new Date('2026-05-06T14:00:00Z');
        const planner = new RoutePlanner({ aero: null, plans: null });
        const result = planner.recomputeLegs(simplePlan, profile, { departureTime: dep });
        expect(result.legs[0].eta).toBeGreaterThan(dep.getTime());
        expect(typeof result.legs[0].eta).toBe('number');
    });

    it('VFR altitude auto-selected when cruiseAltFt absent', () => {
        const noCruiseAlt = { ...simplePlan };
        delete noCruiseAlt.cruiseAltFt;
        const planner = new RoutePlanner({ aero: null, plans: null });
        const result = planner.recomputeLegs(noCruiseAlt, profile);
        // KLKR→KCLT bearing ~030° (eastbound, short) → should be 3500 or 5500
        expect([3500, 5500]).toContain(result.legs[0].altFt);
    });
});
```

- [ ] **Step 3: Run tests — confirm FAIL**

```bash
npm test -- tests/planning/planner/route-planner.test.js
```

- [ ] **Step 4: Rewrite recomputeLegs in route-planner.js**

Find `recomputeLegs(plan, profileOverride)` in `route-planner.js` and replace with:

```javascript
/**
 * Recompute leg-level data without re-running A*.
 * @param {import('../types/flight-plan.js').FlightPlan} plan
 * @param {import('../types/aircraft-profile.js').AircraftProfile} [profileOverride]
 * @param {object} [opts]
 * @param {Date}   [opts.departureTime]    defaults to now
 * @param {number} [opts.pctPower]         cruise power percentage (default 65)
 * @param {number} [opts.cruiseAltFt]      override plan.cruiseAltFt (for panel altitude selector)
 * @param {Record<string,Record<number,{dir:number,spd:number,temp?:number,variable?:boolean}>>} [opts.winds]
 * @returns {import('../types/flight-plan.js').FlightPlan}
 */
recomputeLegs(plan, profileOverride, opts = {}) {
    const profile = profileOverride || RV9A_FALLBACK;
    const wps = plan.waypoints;
    const legs = [];
    let fuelRem = profile.fuel_capacity_gal;
    const pctPower = (opts.pctPower ?? 65) / 100;
    let etaMs = (opts.departureTime instanceof Date ? opts.departureTime.getTime() : Date.now());

    // Resolve cruise altitude: opts override → plan field → VFR auto-select
    const dep  = wps[0];
    const dest = wps[wps.length - 1];
    let globalCruiseAltFt = opts.cruiseAltFt ?? plan.cruiseAltFt;
    if (!globalCruiseAltFt && dep && dest) {
        const magCourse = bearing(dep.lat, dep.lon, dest.lat, dest.lon); // true ≈ mag for CONUS
        globalCruiseAltFt = vfrAltitude(magCourse, dep, dest);
    }
    globalCruiseAltFt = globalCruiseAltFt ?? 6000;

    for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i];
        const b = wps[i + 1];

        // Per-leg altitude: use destination waypoint altFt override, else global cruise
        const legAltFt = b.altFt ?? globalCruiseAltFt;

        const distNm = haversine(a.lat, a.lon, b.lat, b.lon);
        const brgTrue = bearing(a.lat, a.lon, b.lat, b.lon);

        // Wind at leg midpoint
        let windDir = null, windSpd = null, oatC = null;
        if (opts.winds) {
            const midLat = (a.lat + b.lat) / 2;
            const midLon = (a.lon + b.lon) / 2;
            const station = findNearestFdStation(opts.winds, midLat, midLon);
            const windEntry = station ? getWindAtAlt(opts.winds[station], legAltFt) : null;
            if (windEntry && !windEntry.variable) {
                windDir = windEntry.dir;
                windSpd = windEntry.spd;
                oatC    = windEntry.temp ?? null;
            }
        }

        // TAS: use ISA model if cruise_ias available, else empirical tasAtAltitude
        const tas = profile.cruise_ias
            ? iasToTas(profile.cruise_ias, legAltFt, oatC)
            : tasAtAltitude(profile, legAltFt);

        // GS: wind-corrected or flat TAS
        const gs = (windDir !== null && windSpd !== null)
            ? groundSpeed(tas, brgTrue, windDir, windSpd)
            : tas;

        const decomp = decomposeLeg(profile, {
            distNm,
            altFt: legAltFt,
            departingFromGround: i === 0,
            endingAtGround: i === wps.length - 2,
            gsKt: gs,
            tasKt: tas,
        });

        fuelRem -= decomp.totalFuelGal;
        etaMs   += decomp.totalTimeHrs * 3_600_000;

        legs.push({
            from: a.id,
            to:   b.id,
            distNm,
            bearingTrue: brgTrue,
            altFt:       legAltFt,
            tasKt:       Math.round(tas),
            gsKt:        Math.round(gs),
            windDir:     windDir ?? undefined,
            windSpd:     windSpd ?? undefined,
            windKt:      (windDir !== null && windSpd !== null && brgTrue !== null)
                         ? Math.round(gs - tas)  // negative = headwind
                         : undefined,
            percentPwr:  Math.round(pctPower * 100),
            timeHrs:     decomp.totalTimeHrs,
            fuelGal:     decomp.totalFuelGal,
            fuelRemGal:  fuelRem,
            eta:         etaMs,
            airway:      b.airway || 'DIRECT',
        });
    }

    const summary = {
        totalDistNm:  legs.reduce((s, l) => s + l.distNm, 0),
        totalEteHrs:  legs.reduce((s, l) => s + l.timeHrs, 0),
        totalFuelGal: legs.reduce((s, l) => s + l.fuelGal, 0),
        fuelRemGal:   fuelRem,
        fixCount:     wps.length,
    };
    return { ...plan, legs, summary };
}
```

Also add the missing imports at the top of `route-planner.js` (these are already imported from the planning lib files — add if not present):
```javascript
import { iasToTas, groundSpeed, vfrAltitude } from '../math/route-math.js';
import { findNearestFdStation, getWindAtAlt } from './winds-interpolator.js';
```

- [ ] **Step 5: Run tests — confirm PASS**

```bash
npm test -- tests/planning/planner/route-planner.test.js
```

- [ ] **Step 6: Run all tests**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add web/shared/planning/planner/route-planner.js tests/planning/planner/route-planner.test.js
git commit -m "feat(planner): recomputeLegs with wind-corrected GS, altitude TAS, VFR auto-alt, ETA, LOP fuel"
```

---

## Phase 6: Panel UI

### Task 10: Add departure time, altitude, and power % selectors to route-planner-panel.js

**Files:**
- Modify: `web/cockpit/route-planner-panel.js`
- Modify: `web/style.css`

- [ ] **Step 1: Read current _buildOptsRow in route-planner-panel.js**

```bash
grep -n "_buildOptsRow\|opts-row\|rpp-opts\|maxLegHrs\|_routingMode\|_modeSel" web/cockpit/route-planner-panel.js | head -20
```

Read the method to understand the current structure of the opts row.

- [ ] **Step 2: Add state fields to the constructor**

In the constructor, after existing state initialization (find `this._avoidList`, `this._routingMode`, etc.), add:

```javascript
this._departureTime = null;     // Date | null; null = now
this._cruiseAltFt   = null;     // number | null; null = VFR auto
this._pctPower      = 65;       // percent, LOP
this._altSel        = null;     // <select> element ref
this._depTimeSel    = null;     // <input type=datetime-local> ref
this._pwrSel        = null;     // <select> element ref
```

- [ ] **Step 3: Add controls to _buildOptsRow**

Find `_buildOptsRow()` and append three new rows after the existing routing-mode select. Each control must be in a `.rpp-opts-row` div matching the existing pattern:

```javascript
// Departure time
const depRow = document.createElement('div');
depRow.className = 'rpp-opts-row';
depRow.innerHTML = `<label class="rpp-opts-label">Depart</label>
    <input type="datetime-local" class="rpp-dep-time" />`;
this._depTimeSel = depRow.querySelector('.rpp-dep-time');
this._depTimeSel.addEventListener('change', () => {
    this._departureTime = this._depTimeSel.value ? new Date(this._depTimeSel.value) : null;
    this._saveOpts();
    if (this._lastPlan) this._applyWindsToLastPlan();
});

// Altitude
const altRow = document.createElement('div');
altRow.className = 'rpp-opts-row';
altRow.innerHTML = `<label class="rpp-opts-label">Altitude</label>
    <select class="rpp-alt-sel">
        <option value="">Auto (VFR)</option>
        <option value="3500">3,500 ft</option>
        <option value="5500">5,500 ft</option>
        <option value="7500">7,500 ft</option>
        <option value="9500">9,500 ft</option>
        <option value="11500">11,500 ft</option>
        <option value="4500">4,500 ft</option>
        <option value="6500">6,500 ft</option>
        <option value="8500">8,500 ft</option>
        <option value="10500">10,500 ft</option>
    </select>`;
this._altSel = altRow.querySelector('.rpp-alt-sel');
this._altSel.addEventListener('change', () => {
    this._cruiseAltFt = this._altSel.value ? parseInt(this._altSel.value) : null;
    this._saveOpts();
    if (this._lastPlan) this._applyWindsToLastPlan();
});

// Power %
const pwrRow = document.createElement('div');
pwrRow.className = 'rpp-opts-row';
pwrRow.innerHTML = `<label class="rpp-opts-label">Power</label>
    <select class="rpp-pwr-sel">
        <option value="55">55% LOP</option>
        <option value="60">60% LOP</option>
        <option value="65" selected>65% LOP</option>
        <option value="70">70% LOP</option>
        <option value="75">75% LOP</option>
    </select>`;
this._pwrSel = pwrRow.querySelector('.rpp-pwr-sel');
this._pwrSel.addEventListener('change', () => {
    this._pctPower = parseInt(this._pwrSel.value);
    this._saveOpts();
    if (this._lastPlan) this._applyWindsToLastPlan();
});

container.append(depRow, altRow, pwrRow);
```

- [ ] **Step 4: Add _applyWindsToLastPlan helper**

This re-runs `recomputeLegs` with current opts on the last A* result without re-running A*:

```javascript
async _applyWindsToLastPlan() {
    if (!this._lastPlan || !this._planner) return;
    const opts = {
        departureTime: this._departureTime ?? new Date(),
        pctPower:      this._pctPower,
        cruiseAltFt:   this._cruiseAltFt ?? undefined,
    };
    try {
        opts.winds = await fetchWinds(opts.departureTime);
    } catch (_) {}
    const updated = this._planner.recomputeLegs(this._lastPlan, null, opts);
    this._currentPlan = updated;
    this._updateStats(updated);
}
```

Also add `this._lastPlan = null` and `this._currentPlan = null` to the constructor, and set `this._lastPlan = result` after a successful `plan()` call.

- [ ] **Step 5: Persist and restore opts**

In `_saveOpts()`, add:
```javascript
opts.departureTime = this._departureTime ? this._departureTime.toISOString() : null;
opts.cruiseAltFt   = this._cruiseAltFt;
opts.pctPower      = this._pctPower;
```

In `_loadOpts()`, add:
```javascript
if (opts.departureTime) this._departureTime = new Date(opts.departureTime);
if (opts.cruiseAltFt)   { this._cruiseAltFt = opts.cruiseAltFt; if (this._altSel) this._altSel.value = String(opts.cruiseAltFt); }
if (opts.pctPower)      { this._pctPower = opts.pctPower; if (this._pwrSel) this._pwrSel.value = String(opts.pctPower); }
```

- [ ] **Step 6: Add CSS**

In `web/style.css`, add after existing `.rpp-*` rules:

```css
.rpp-dep-time {
    font-size: 13px;
    padding: 4px 6px;
    border: 1px solid #bbb;
    border-radius: 4px;
    background: #fff;
    color: #222;
    flex: 1;
}
.rpp-alt-sel,
.rpp-pwr-sel {
    font-size: 13px;
    padding: 4px 6px;
    border: 1px solid #bbb;
    border-radius: 4px;
    background: #fff;
    color: #222;
    flex: 1;
}
```

- [ ] **Step 7: Commit**

```bash
git add web/cockpit/route-planner-panel.js web/style.css
git commit -m "feat(panel): add departure time, altitude, and power % selectors"
```

---

### Task 11: Per-fix altitude override and stats bar update

**Files:**
- Modify: `web/cockpit/route-planner-panel.js`
- Modify: `web/style.css`

- [ ] **Step 1: Per-fix altitude override via long-press on fix pills**

In the context menu setup (find `#rppMAvoid` section), add a new menu item `#rppMAlt`:

```javascript
// In context menu HTML template, after #rppMAvoid:
<li id="rppMAlt" class="rpp-menu-alt">Set altitude…</li>
```

Wire the click handler:
```javascript
this._ctxMenu.querySelector('#rppMAlt').addEventListener('click', () => {
    const i = this._ctxMenuIdx; this._closeMenu();
    if (i === null) return;
    const item = this._route[i];
    if (item.type !== 'fix') return;
    const current = item.altFt ? String(item.altFt) : '';
    const input = prompt(`Altitude for ${item.id} (ft, blank = route default):`, current);
    if (input === null) return;  // cancelled
    item.altFt = input.trim() ? parseInt(input) : undefined;
    this._saveOpts();
    this._render();
    if (this._lastPlan) {
        // update waypoint.altFt in lastPlan and recompute
        const wp = this._lastPlan.waypoints.find(w => w.id === item.id);
        if (wp) wp.altFt = item.altFt;
        this._applyWindsToLastPlan();
    }
});
```

Show the altitude override badge on fix pills that have `altFt` set. Find `_renderPill` or equivalent and add:
```javascript
if (pill.type === 'fix' && pill.altFt) {
    const badge = document.createElement('span');
    badge.className = 'rpp-alt-badge';
    badge.textContent = `${Math.round(pill.altFt / 100) * 100}`;
    pillEl.appendChild(badge);
}
```

- [ ] **Step 2: Update stats bar to show wind summary, ETE, and fuel**

Find `_updateStats(result)` in route-planner-panel.js. Replace its content to include wind summary, ETE, and fuel total alongside the existing distance delta:

```javascript
_updateStats(result) {
    if (!this._statsEl) return;
    const legs = result?.legs || [];
    const summary = result?.summary;
    if (!legs.length || !summary) { this._statsEl.innerHTML = ''; return; }

    const dep  = result.waypoints?.[0];
    const dest = result.waypoints?.[result.waypoints.length - 1];
    const directNm = (dep && dest)
        ? NasrDB.haversineNm(dep.lat, dep.lon, dest.lat, dest.lon)
        : 0;
    const routeNm  = summary.totalDistNm;
    const deltaNm  = routeNm - directNm;
    const deltaPct = directNm > 0 ? (deltaNm / directNm * 100) : 0;

    // Wind summary: average headwind component across legs
    const windLegs = legs.filter(l => l.windDir !== undefined && l.windSpd !== undefined);
    let windLabel = '';
    if (windLegs.length) {
        const avgWind = windLegs.reduce((s, l) => s + (l.gsKt - l.tasKt), 0) / windLegs.length;
        const label = avgWind >= 0 ? `TW ${Math.round(avgWind)}kt` : `HW ${Math.round(-avgWind)}kt`;
        windLabel = `<span class="rpp-stat-wind">${label}</span>`;
    } else if (this._fetchingWinds) {
        windLabel = `<span class="rpp-stat-wind rpp-stat-fetching">Fetching winds…</span>`;
    }

    // Alt label
    const altFt = legs[0]?.altFt ?? this._cruiseAltFt ?? '—';
    const altLabel = `<span class="rpp-stat-alt">${altFt.toLocaleString()} ft</span>`;

    // ETE
    const eteHrs = summary.totalEteHrs;
    const h = Math.floor(eteHrs);
    const m = Math.round((eteHrs - h) * 60);
    const eteLabel = `${h}h ${String(m).padStart(2, '0')}m`;

    // ETA
    const lastEta = legs[legs.length - 1]?.eta;
    const etaLabel = lastEta
        ? new Date(lastEta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    this._statsEl.innerHTML = `
        <div class="rpp-stat-row">
            ${altLabel}${windLabel}
            <span class="rpp-stat-sep">|</span>
            <span class="rpp-stat-dist">Route ${Math.round(routeNm)}nm</span>
            <span class="rpp-stat-delta ${deltaNm >= 0 ? '' : 'rpp-stat-delta-neg'}">
                ${deltaNm >= 0 ? '+' : ''}${Math.round(deltaNm)}nm (${deltaPct >= 0 ? '+' : ''}${Math.round(deltaPct)}%)
            </span>
            <span class="rpp-stat-sep">|</span>
            <span class="rpp-stat-ete">${eteLabel}${etaLabel ? ` · ETA ${etaLabel}` : ''}</span>
            <span class="rpp-stat-fuel">${summary.totalFuelGal.toFixed(1)} gal</span>
        </div>`;
}
```

- [ ] **Step 3: Add amber warning strip for wind data issues**

Add `this._windWarnings = []` to the constructor. Add `_renderWindWarnings()`:

```javascript
_renderWindWarnings() {
    if (!this._warnStripEl) return;
    if (!this._windWarnings.length) { this._warnStripEl.style.display = 'none'; return; }
    this._warnStripEl.style.display = '';
    this._warnStripEl.innerHTML = this._windWarnings.map((w, i) =>
        `<span class="rpp-warn-chip">${w}<button class="rpp-warn-x" data-i="${i}">×</button></span>`
    ).join('');
    this._warnStripEl.querySelectorAll('.rpp-warn-x').forEach(btn => {
        btn.addEventListener('click', () => {
            this._windWarnings.splice(parseInt(btn.dataset.i), 1);
            this._renderWindWarnings();
        });
    });
}
```

Create `this._warnStripEl` as a div inserted above the pills section, styled like the avoid strip but amber:

```css
/* In style.css */
.rpp-warn-strip {
    background: #fff3cd;
    border: 1px solid #f0ad4e;
    border-radius: 4px;
    padding: 4px 8px;
    margin: 4px 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    font-size: 12px;
    color: #7a5200;
    font-weight: 500;
}
.rpp-warn-chip { display: flex; align-items: center; gap: 4px; }
.rpp-warn-x { background: none; border: none; cursor: pointer; color: #7a5200; font-size: 14px; padding: 0 2px; }
.rpp-alt-badge { font-size: 10px; background: #0066cc; color: #fff; border-radius: 3px; padding: 1px 4px; margin-left: 3px; }
```

In `_applyWindsToLastPlan`, set warnings based on whether winds were fetched:
```javascript
this._windWarnings = [];
if (!opts.winds) {
    this._windWarnings.push('Wind data unavailable — time and fuel use calm-air estimates');
}
this._renderWindWarnings();
```

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/route-planner-panel.js web/style.css
git commit -m "feat(panel): per-fix altitude override, wind stats bar, ETA display, amber warnings"
```

---

## Phase 7: Display Integration

### Task 12: route-table.js — ETA column and read plan leg fields pre-flight

**Files:**
- Modify: `web/cockpit/route-table.js`

- [ ] **Step 1: Find where leg fields are set for pre-flight display**

```bash
grep -n "_tas\|_gs\|_wind\|_pwr\|_computeEnroute\|tasKt\|gsKt\|windDir\|percentPwr" web/cockpit/route-table.js | head -40
```

Find `_computeEnroute()` — this is where `wp._tas`, `wp._gs`, `wp._wind`, `wp._pwr` are set. Locate where it reads from the plan (as opposed to live engine data).

- [ ] **Step 2: Read plan leg fields into wp._ fields**

In `_computeEnroute()`, when the leg comes from a loaded plan (not live GPS), read the plan leg's pre-computed values:

```javascript
// After resolving the leg object from the plan, add:
if (leg.tasKt)    wp._tas  = leg.tasKt;
if (leg.gsKt)     wp._gs   = leg.gsKt;
if (leg.windDir !== undefined && leg.windSpd !== undefined) {
    wp._wind = { dir: leg.windDir, spd: leg.windSpd };
}
if (leg.percentPwr) wp._pwr = leg.percentPwr;
if (leg.altFt)    wp.altitude = leg.altFt;
```

This ensures pre-flight display uses wind-corrected values from `recomputeLegs`.

- [ ] **Step 3: Add ETA to display**

Find `_getCellValue()` at line ~2843. Add a case for `'eta'`:

```javascript
case 'eta': {
    const etaMs = wp._eta ?? leg?.eta;
    if (!etaMs) return '—';
    return new Date(etaMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
```

In `_computeEnroute()`, set `wp._eta` from the leg:
```javascript
if (leg.eta) wp._eta = leg.eta;
```

Add `'eta'` to the column configuration where ETE is defined (read the config around line 2693 to find the right place).

- [ ] **Step 4: Add eta and destEta to activeroute:legupdate event**

Find `_emitLegUpdate()`. Add to the dispatched event detail:
```javascript
eta:     activeLeg?.eta ?? null,       // ETA at active waypoint (UTC ms)
destEta: lastLeg?.eta ?? null,         // ETA at destination (UTC ms)
legAltFt: activeLeg?.altFt ?? null,
```

- [ ] **Step 5: Run all tests**

```bash
npm test
```

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/route-table.js
git commit -m "feat(display): ETA column in route table; read plan leg fields pre-flight; emit eta in legupdate"
```

---

### Task 13: route-nav-strip.js — show destEta

**Files:**
- Modify: `web/cockpit/route-nav-strip.js`

- [ ] **Step 1: Find where destEteMin is displayed**

```bash
grep -n "destEte\|destEta\|KMIA\|destDist" web/cockpit/route-nav-strip.js | head -20
```

- [ ] **Step 2: Add destEta display alongside ETE**

Find the template line that renders destination ETE. After it, add ETA:

```javascript
// In the update handler that consumes 'activeroute:legupdate':
if (d.destEta) {
    const etaStr = new Date(d.destEta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // Find the dest ETE element and append or replace
    destEteEl.textContent = `ETE ${d.destEteMin}m · ETA ${etaStr}`;
} else {
    destEteEl.textContent = `ETE ${d.destEteMin}m`;
}
```

Read the file to find exact element references before editing.

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/route-nav-strip.js
git commit -m "feat(nav): show destination ETA alongside ETE in nav strip"
```

---

## Phase 8: Wire and Build

### Task 14: Add winds-interpolator script tag and wire into panel plan() call

**Files:**
- Modify: `web/index.html`
- Modify: `web/cockpit/route-planner-panel.js`

- [ ] **Step 1: Add script tag to index.html**

Find the section where other planning modules are loaded (e.g., near `route-planner.js` script tag). Add:

```html
<script type="module" src="shared/planning/planner/winds-interpolator.js"></script>
```

Confirm it loads after `weather-client.js` (winds-interpolator delegates to `WeatherClient` in browser).

- [ ] **Step 2: Wire winds fetch into the plan() flow in route-planner-panel.js**

Find the `_onPlanTap()` method (or the method that calls `this._planner.plan(...)`). After getting the A* result, call `_applyWindsToLastPlan()`:

```javascript
const result = await this._planner.plan({ ... });
this._lastPlan = result;
this._fetchingWinds = true;
this._updateStats(result);   // show result immediately with "Fetching winds…"
this._fetchingWinds = false;
await this._applyWindsToLastPlan();  // re-run recomputeLegs with winds
```

Import `fetchWinds` at the top of route-planner-panel.js (it is available via the module system or via `FlyTabPlanning.fetchWinds` global):

```javascript
// At top of _applyWindsToLastPlan:
const fetchWindsFn = (typeof fetchWinds !== 'undefined') ? fetchWinds
    : (FlyTabPlanning?.fetchWinds ?? null);
if (fetchWindsFn) opts.winds = await fetchWindsFn(opts.departureTime).catch(() => null);
```

- [ ] **Step 3: Commit**

```bash
git add web/index.html web/cockpit/route-planner-panel.js
git commit -m "feat: wire winds-interpolator into panel plan flow; add script tag"
```

---

### Task 15: Version bump and build

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Increment FLYTAB_VERSION in web/app.js**

```bash
grep -n "FLYTAB_VERSION" web/app.js | head -3
```

Read the current version (e.g., `v7.40`) and increment to next minor (e.g., `v7.41`).

- [ ] **Step 2: Build**

```bash
bash build.sh
```

Expected: BUILD SUCCESSFUL, APK written to `data/`.

- [ ] **Step 3: Run all tests one final time**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add web/app.js
git commit -m "chore: bump to v7.41"
```

---

## Self-Review Checklist

- [x] **iasToTas / groundSpeed / vfrAltitude** — Task 4
- [x] **windCorrectedMagHdg moved to planning lib** — Task 3
- [x] **gphAtPower LOP + maxPowerAtAltitude** — Task 6
- [x] **cruise_ias / max_hp in AircraftProfile** — Task 5
- [x] **windSpd / eta added to Leg type** — Task 7
- [x] **decomposeLeg gsKt / tasKt overrides** — Task 7
- [x] **winds-interpolator: fetchWinds / getWindAtAlt / findNearestFdStation / selectFdCycle** — Task 8
- [x] **recomputeLegs: VFR altitude, per-leg altFt from waypoint.altFt, TAS/GS/wind/ETA/LOP fuel** — Task 9
- [x] **Departure time picker** — Task 10
- [x] **Altitude selector (Auto VFR + manual)** — Task 10
- [x] **Power % selector (65% LOP default)** — Task 10
- [x] **Per-fix altitude override (long-press pill → altFt)** — Task 11
- [x] **Stats bar: altitude, wind summary, ETE, ETA, fuel** — Task 11
- [x] **Amber warning strip for wind data issues** — Task 11
- [x] **route-table reads plan leg fields pre-flight** — Task 12
- [x] **ETA column in route table** — Task 12
- [x] **activeroute:legupdate emits eta / destEta / legAltFt** — Task 12
- [x] **route-nav-strip shows destEta** — Task 13
- [x] **winds-interpolator wired into plan() flow** — Task 14
- [x] **Live fuel-flow update path preserved** — Not touched (route-table live path untouched)
- [x] **FIS-B winds format** — Noted as stub in winds-interpolator.js with investigation note
- [x] **haversine consolidated** — Task 1
- [x] **bearing / crossTrack duplicates removed** — Task 2

**Not in this plan (Milestone 2 — separate plan):**
- findSplitPoints, fuel stop candidate search, dual plan view, fuel price API

---

> **Note:** `_buildMissingSegments` extraction from route-table.js was identified in the spec's cleanup section but omitted here because it is a risky refactor (180 lines of phase logic, tight coupling to live engine data path). It should be a dedicated plan of its own once Milestone 1 is stable and tested on device.
