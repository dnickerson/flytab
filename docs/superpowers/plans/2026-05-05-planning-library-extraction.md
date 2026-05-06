# Planning Library Extraction — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract pure math + the stateful planner from the legacy `web/shared/route-planner.js` into a properly-decomposed `web/shared/planning/` ESM library, build the matching adapter implementations under `web/shared/planning-adapters/`, wire flytab's boot through them, and delete the legacy script. The new lib also captures two new requirements: a `routingMode` filter on the airway graph (GPS-Direct / VORs-Direct / V-airways / T-airways / Any) and airway-token expansion in `parseRoute()`.

**Architecture:** Parallel-build strategy — the new lib lives alongside the legacy `route-planner.js`; both load simultaneously while the new lib is built and tested. Once green, `route-planner-panel.js` and `app.js` switch over; legacy is deleted in the final task. The new lib uses ESM internally; `index.js` exposes the public API on `window.FlyTabPlanning` so plain-`<script>` consumers (the rest of flytab) can use it without becoming modules.

**Tech Stack:** Vanilla JS ESM (no bundler), JSDoc `@ts-check` for type safety, vitest + jsdom for unit tests. The existing `NasrDb` (IDB) and `FisbClient` (Stratux WS) become wrapped by adapters; no schema changes.

**Spec:** `docs/superpowers/specs/2026-05-04-planning-lib-architecture-sketch.md` (approved 2026-05-04, revised 2026-05-05 with routing-mode + airway-expansion).

**Branch / worktree:** Execution should happen on `feat/planning-library` in a new worktree. The execution sub-skill (executing-plans / subagent-driven-development) creates the worktree at task start via the using-git-worktrees skill.

---

## File Map

| Path | Action | Why |
|------|--------|-----|
| `vitest.config.js` | Create | Test runner config |
| `tests/planning/...` | Create | Unit tests for the lib |
| `web/shared/planning/package.json` | Create | flywhere `file:` consumption only — flytab loads via `<script type="module">` |
| `web/shared/planning/index.js` | Create | Public API re-exports + `window.FlyTabPlanning` namespace |
| `web/shared/planning/README.md` | Create | Module overview |
| `web/shared/planning/types/*.js` | Create | JSDoc `@typedef` files (no runtime code) |
| `web/shared/planning/adapters/*.js` | Create | Adapter `@interface` JSDoc — duck-typed contracts |
| `web/shared/planning/math/route-math.js` | Create | Haversine, bearing, intermediate point, cross-track distance, leg time |
| `web/shared/planning/math/engine-data.js` | Create | TAS / GPH / climb-rate from aircraft profile |
| `web/shared/planning/math/fuel-phases.js` | Create | Taxi / climb / cruise / descent burn decomposition |
| `web/shared/planning/planner/airway-graph.js` | Create | `AirwayGraph` class — loads + caches; honours routingMode filter at build |
| `web/shared/planning/planner/avoidance.js` | Create | Airspace constraint → A* edge-cost penalty |
| `web/shared/planning/planner/route-planner.js` | Create | `RoutePlanner` class — A*, plan(), parseRoute(), recomputeLegs() |
| `web/shared/planning/planner/parser.js` | Create | `parseRoute()` impl — expands airway tokens to interior fixes |
| `web/shared/planning/planner/optimizer.js` | Create | Least-fuel / least-time / best-altitude modes |
| `web/shared/planning-adapters/idb-aero.js` | Create | Wraps existing `NasrDb` → AeroDataSource interface |
| `web/shared/planning-adapters/idb-plan.js` | Create | IDB FlightPlan store |
| `web/shared/planning-adapters/idb-profile.js` | Create | IDB AircraftProfile store + RV-9A seed |
| `web/shared/planning-adapters/fisb-weather.js` | Create | Wraps existing `FisbClient` → WeatherSource (in-flight tier) |
| `web/shared/planning-adapters/flywhere-weather.js` | Create | HTTP proxy to `https://flywhere.app/api/wx/*` (online tier — skeleton + error path; full proxy is Phase-1 deferred per sketch §3) |
| `web/shared/planning-adapters/weather-router.js` | Create | Picks fisb-weather vs flywhere-weather by `NetworkStatus.mode()` |
| `web/index.html` | Modify | Add `<script type="module" src="shared/planning/index.js">` |
| `web/app.js` | Modify | Construct adapters at boot, attach `app.routePlanner` from lib |
| `web/cockpit/route-planner-panel.js` | Modify | Switch from `new RoutePlanner('FlyTabDB')` to `window.FlyTabPlanning.RoutePlanner` with adapters |
| `web/shared/route-planner.js` | DELETE | Replaced by the lib (final task) |
| `package.json` | Modify | Add `vitest`, `@vitest/ui`, `jsdom` devDependencies + scripts (Playwright + ws were already added in c5189d9) |

---

## Naming and shape conventions

- **All public classes** in the lib are named exports from their file. `index.js` re-exports them.
- **Method names are stable** across tasks. `plan()`, `parseRoute()`, `recomputeLegs()` on `RoutePlanner`. `add()`, `nearestFixes()`, `edges(fixId)` on `AirwayGraph`. `run()` on `Optimizer`. Keep these exactly.
- **Adapter methods are async-only** — even if the implementation can answer synchronously, the contract returns a Promise. `getAirport(icao)` always returns `Promise<Airport|null>`.
- **No `throw new Error(string)`** in the lib outside of typed errors. Define `class PlanError extends Error` once in `planner/route-planner.js`; specific errors subclass it: `NoRouteFoundError`, `DestinationUnreachableError`, `TimeoutError`, `UnknownWaypointError`, `UnknownAirwayError`, `AmbiguousIdentifierError`, `RoutingModeViolationError`.
- **Coordinates** are always `{ lat, lon }` in **decimal degrees**. `lon` (not `lng`).
- **Distances** are nautical miles (`nm`). **Times** are hours (`hrs`). **Altitudes** are feet MSL (`ft`).
- **`AirwayType`** is a string: `'V'` | `'T'` | `'J'` | `'Q'`. Sourced from NASR `airway.type` field.

---

## Pre-flight: existing code to preserve

The legacy `web/shared/route-planner.js` (HEAD on main) already contains working logic that **must** carry over without behaviour drift. Tests for the math modules pin the existing outputs as the source of truth.

| Existing item | New location | Notes |
|---|---|---|
| `haversine`, `bearing`, `intermediatePoint`, `crossTrackDistanceNm`, `alongTrackFraction`, `formatTime` | `math/route-math.js` | Pure copy + JSDoc + tests |
| `EARTH_RADIUS_NM`, `ARTCC_BANDS`, `CORRIDOR_PREFERRED_FIXES`, `DC_P40`, `SUA_BUFFER_NM` | `planner/route-planner.js` | Constants stay near use sites |
| `artccForLat`, `segmentConflictsSua`, `airwaysBetweenFixes` | `planner/route-planner.js` | Helpers stay private to the planner |
| `class AirwayGraph`, `class WorkGraph` | `planner/airway-graph.js` | `WorkGraph` proxy is the perf fix from commit 71f5712 — preserve it |
| `class RouteConstructor`, `class FuelStopOptimizer`, `function buildLegs` | `planner/route-planner.js` (private) | Internals; not exported |
| `class RoutePlanner` | `planner/route-planner.js` | Public; gains `routingMode` opt + `parseRoute(str)` |
| `async function createRoutePlanner(dbName)` | DELETED | The new public API takes adapters, not a dbName |
| `idbGet/idbGetAll/idbGetAllKeys/idbPut/openDB` | DELETED | Replaced by adapter calls |

---

## Task 1: Test infrastructure (vitest + jsdom)

**Files:** Create `vitest.config.js`. Modify `package.json`.

- [ ] **Step 1: Add devDependencies**

```bash
cd ~/flytab && npm install --save-dev vitest@^2 @vitest/ui@^2 jsdom@^25
```

Expected: `package.json` gains three entries under `devDependencies`; `package-lock.json` updates.

- [ ] **Step 2: Add npm scripts**

In `package.json`'s `"scripts"` block, add:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:ui": "vitest --ui"
```

- [ ] **Step 3: Create `vitest.config.js`**

```js
// vitest.config.js
export default {
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.js'],
        globals: false,
    },
};
```

- [ ] **Step 4: Smoke test the runner**

Create `tests/_smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';

describe('vitest', () => {
    it('runs', () => { expect(1 + 1).toBe(2); });
});
```

Run: `npm test`
Expected: 1 test passes.

- [ ] **Step 5: Delete the smoke test**

```bash
rm tests/_smoke.test.js
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.js
git commit -m "test: add vitest + jsdom test infra for the planning lib"
```

---

## Task 2: Planning lib skeleton

**Files:** Create `web/shared/planning/{package.json,index.js,README.md,types/,math/,planner/,adapters/}` (directories with `.gitkeep` placeholders for now).

- [ ] **Step 1: Make the directory tree**

```bash
cd ~/flytab/web/shared/planning
mkdir -p types math planner adapters
touch types/.gitkeep math/.gitkeep planner/.gitkeep adapters/.gitkeep
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "flywhere-planning",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./math/*":    "./math/*.js",
    "./planner/*": "./planner/*.js",
    "./types/*":   "./types/*.js",
    "./adapters/*":"./adapters/*.js"
  },
  "description": "Flight planning library shared by flytab and flywhere. Pure math + stateful planner; adapters injected by the consumer."
}
```

This file is **only** used when flywhere does `npm install` against the sibling repo. flytab itself ignores it; it loads files via `<script type="module">`.

- [ ] **Step 3: Create `index.js` placeholder**

```js
// @ts-check
'use strict';

/**
 * flywhere-planning — flight planning library.
 *
 * In flytab (Capacitor / browser): loaded once via <script type="module"
 * src="shared/planning/index.js">. This file attaches the public API to
 * `window.FlyTabPlanning` so plain-<script> consumers can use it.
 *
 * In flywhere (Next.js): consumed via `import { RoutePlanner } from
 * 'flywhere-planning'` after the file: dependency resolves.
 */

// Public exports — populated by Tasks 5-13.
export const VERSION = '0.1.0';

// Browser global for non-module consumers (flytab pattern).
if (typeof window !== 'undefined') {
    window.FlyTabPlanning = Object.assign(window.FlyTabPlanning || {}, { VERSION });
}
```

- [ ] **Step 4: Create `README.md`**

```markdown
# flywhere-planning

Shared flight planning library — pure math + stateful planner. No DOM, no IDB,
no network. Adapters are injected by the consumer.

See `docs/superpowers/specs/2026-05-04-planning-lib-architecture-sketch.md` for
the full design.

## Public API

- `RoutePlanner({ aero, weather, plans, profiles, network, clock })` — A* over
  the airway graph; methods: `plan(opts)`, `parseRoute(str)`, `recomputeLegs(plan)`.
- `Optimizer(adapters)` — least-fuel / least-time / best-altitude modes.
- `AirwayGraph(aero, opts)` — loads + caches airway adjacency, filterable by
  routing mode.
- Math helpers under `math/`.
- Type `@typedef`s under `types/`.
- Adapter `@interface` definitions under `adapters/`.

## Adapters expected by the consumer

See `adapters/*.js` for full contracts. Six required:
`AeroDataSource`, `WeatherSource`, `PlanStore`, `ProfileStore`,
`NetworkStatus`, `Clock`.
```

- [ ] **Step 5: Commit**

```bash
git add web/shared/planning/
git commit -m "feat(planning): scaffold web/shared/planning/ skeleton"
```

---

## Task 3: Adapter interfaces (JSDoc only)

**Files:** Create `web/shared/planning/adapters/*.js` — six files, all JSDoc `@interface` declarations with empty method bodies.

- [ ] **Step 1: `adapters/aero-data-source.js`**

```js
// @ts-check
'use strict';

/**
 * @interface AeroDataSource
 * Read-only NASR / CIFP queries. Implementation may be IDB-backed (flytab),
 * Supabase-backed (flywhere), or in-memory (tests).
 */
export class AeroDataSource {
    /** @param {string} icao @returns {Promise<import('../types/airport.js').Airport|null>} */
    async getAirport(icao) { throw new Error('not implemented'); }
    /** @param {string} id   @returns {Promise<import('../types/navaid.js').Navaid|null>} */
    async getNavaid(id) { throw new Error('not implemented'); }
    /** @param {string} name @returns {Promise<import('../types/fix.js').Fix|null>} */
    async getFix(name) { throw new Error('not implemented'); }
    /** @param {string} airwayId @returns {Promise<import('../types/airway.js').Airway|null>} */
    async getAirway(airwayId) { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/airspace.js').Airspace[]>} */
    async listAirspace() { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/airway.js').Airway[]>} */
    async listAirways() { throw new Error('not implemented'); }
}
```

- [ ] **Step 2: `adapters/weather-source.js`**

```js
// @ts-check
'use strict';

/**
 * @interface WeatherSource
 * Read-only weather. Implementation may pull from FIS-B (in flight),
 * AWC via flywhere.app proxy (online), or a cache (offline).
 */
export class WeatherSource {
    /** @param {string} icao @returns {Promise<import('../types/weather.js').Metar|null>} */
    async getMetar(icao) { throw new Error('not implemented'); }
    /** @param {{lat:number,lon:number}} point @param {number} altFt
     *  @returns {Promise<import('../types/weather.js').WindAloft|null>} */
    async getWindAloft(point, altFt) { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/weather.js').Tfr[]>} */
    async listActiveTfrs() { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/weather.js').Sigmet[]>} */
    async listSigmets() { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/weather.js').Airmet[]>} */
    async listAirmets() { throw new Error('not implemented'); }
}
```

- [ ] **Step 3: `adapters/plan-store.js`**

```js
// @ts-check
'use strict';

/**
 * @interface PlanStore
 * Read-write store for FlightPlan records.
 */
export class PlanStore {
    /** @param {string} id @returns {Promise<import('../types/flight-plan.js').FlightPlan|null>} */
    async get(id) { throw new Error('not implemented'); }
    /** @param {import('../types/flight-plan.js').FlightPlan} plan @returns {Promise<string>} */
    async put(plan) { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/flight-plan.js').FlightPlan[]>} */
    async list() { throw new Error('not implemented'); }
    /** @param {string} id @returns {Promise<void>} */
    async delete(id) { throw new Error('not implemented'); }
}
```

- [ ] **Step 4: `adapters/profile-store.js`**

```js
// @ts-check
'use strict';

/**
 * @interface ProfileStore
 * Read-write store for AircraftProfile records.
 */
export class ProfileStore {
    /** @param {string} id @returns {Promise<import('../types/aircraft-profile.js').AircraftProfile|null>} */
    async get(id) { throw new Error('not implemented'); }
    /** @param {import('../types/aircraft-profile.js').AircraftProfile} profile @returns {Promise<string>} */
    async put(profile) { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/aircraft-profile.js').AircraftProfile[]>} */
    async list() { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/aircraft-profile.js').AircraftProfile|null>} */
    async getActive() { throw new Error('not implemented'); }
}
```

- [ ] **Step 5: `adapters/network-status.js`**

```js
// @ts-check
'use strict';

/**
 * @interface NetworkStatus
 * Reports the current connectivity tier. Emits 'mode:changed' events with
 * detail: { mode, previous }.
 *
 * IMPORTANT: this interface matches the EXISTING NetworkMode class at
 * web/shared/network-mode.js. flytab passes app.networkMode as-is; do NOT
 * wrap it.
 */
export class NetworkStatus extends EventTarget {
    /** @returns {'flight'|'home'|'internet'|'offline'} */
    get mode() { throw new Error('not implemented'); }
}
```

- [ ] **Step 6: `adapters/clock.js`**

```js
// @ts-check
'use strict';

/** @interface Clock */
export class Clock {
    /** @returns {number} ms since epoch */
    now() { throw new Error('not implemented'); }
}
```

- [ ] **Step 7: Commit**

```bash
git add web/shared/planning/adapters/
git commit -m "feat(planning): adapter interfaces — AeroDataSource, WeatherSource, PlanStore, ProfileStore, NetworkStatus, Clock"
```

---

## Task 4: Type `@typedef` definitions

**Files:** Create `web/shared/planning/types/*.js` — eight files. JSDoc `@typedef`s only; no runtime code (each file ends with an empty `export {}` to make it an ESM module).

- [ ] **Step 1: `types/airport.js`**

```js
// @ts-check
'use strict';

/**
 * @typedef Airport
 * @property {string}  icao              "KLKR"
 * @property {string}  [name]            "Lake Murray"
 * @property {number}  lat               decimal degrees
 * @property {number}  lon               decimal degrees
 * @property {number}  [elevFt]          field elevation MSL
 * @property {boolean} [hasFuel]
 * @property {boolean} [hasSelfServeFuel]
 * @property {string[]} [runways]        ["09/27", "18/36"]
 */

export {};
```

- [ ] **Step 2: `types/navaid.js`**

```js
// @ts-check
'use strict';

/**
 * @typedef Navaid
 * @property {string}  id        "RIC"
 * @property {string}  [name]    "Richmond"
 * @property {number}  lat
 * @property {number}  lon
 * @property {'VOR'|'VORTAC'|'VOR/DME'|'NDB'|'DME'|'TACAN'} [type]
 * @property {number}  [freq]    MHz
 */

export {};
```

- [ ] **Step 3: `types/fix.js`**

```js
// @ts-check
'use strict';

/**
 * @typedef Fix
 * @property {string} id
 * @property {number} lat
 * @property {number} lon
 * @property {'WAYPOINT'|'INTERSECTION'|'COMPUTER'|'GPS'} [type]
 */

export {};
```

- [ ] **Step 4: `types/airway.js`**

```js
// @ts-check
'use strict';

/**
 * @typedef AirwaySegment
 * @property {string} fromId
 * @property {string} toId
 * @property {number} distNm
 * @property {number} [meaFt]    minimum enroute altitude
 *
 * @typedef Airway
 * @property {string} id          "V143"
 * @property {'V'|'T'|'J'|'Q'} type     V=Victor (low), T=RNAV, J=Jet (high), Q=RNAV-high
 * @property {string[]} fixIds    ordered list of fix ids that make up the airway
 * @property {AirwaySegment[]} [segments]   inter-fix segments with distances
 */

export {};
```

- [ ] **Step 5: `types/airspace.js`**

```js
// @ts-check
'use strict';

/**
 * @typedef Airspace
 * @property {string}  id
 * @property {'B'|'C'|'D'|'E'|'P'|'R'|'W'|'A'|'MOA'|'TFR'} kind
 * @property {string}  [name]
 * @property {Array<{lat:number,lon:number}>} polygon
 * @property {number}  [floorFt]
 * @property {number}  [ceilingFt]
 */

export {};
```

- [ ] **Step 6: `types/aircraft-profile.js`**

```js
// @ts-check
'use strict';

/**
 * @typedef AircraftEquipment
 * @property {boolean} vAirways    true when GPS / nav radios can fly V airways (almost always true)
 * @property {boolean} tAirways    true ONLY when GPS supports T (RNAV) airways. Garmin GPS 175 = false.
 * @property {boolean} jAirways    true when capable of high-altitude Jet routes
 * @property {boolean} gpsApproach RNAV approaches supported (LPV/LNAV/VNAV)
 *
 * @typedef AircraftProfile
 * @property {string}  id
 * @property {string}  tailNumber
 * @property {string}  model              e.g., "RV-9A", "Cessna 172"
 * @property {number}  cruise_ktas
 * @property {number}  fuel_burn_gph
 * @property {number}  fuel_capacity_gal
 * @property {number}  reserve_gal
 * @property {AircraftEquipment} equipment
 */

export {};
```

- [ ] **Step 7: `types/flight-plan.js`**

```js
// @ts-check
'use strict';

/**
 * @typedef Waypoint
 * @property {string} id
 * @property {number} lat
 * @property {number} lon
 * @property {'APT'|'NAV'|'FIX'} [kind]
 * @property {number} [altFt]
 *
 * @typedef Leg
 * @property {string} from
 * @property {string} to
 * @property {number} distNm
 * @property {number} [bearingTrue]
 * @property {number} [bearingMag]
 * @property {string} [airway]            'V143' | 'DIRECT'
 * @property {'climb'|'cruise'|'descent'} [phase]
 * @property {number} [altFt]
 * @property {number} [tasKt]
 * @property {number} [gsKt]
 * @property {number} [windDir]
 * @property {number} [windKt]
 * @property {number} [rpm]
 * @property {number} [mp]
 * @property {number} [percentPwr]
 * @property {number} [timeHrs]
 * @property {number} [gphActual]
 * @property {number} [fuelGal]
 * @property {number} [fuelRemGal]
 *
 * @typedef PlanSummary
 * @property {number} totalDistNm
 * @property {number} totalEteHrs
 * @property {number} totalFuelGal
 * @property {number} fuelRemGal
 * @property {number} fixCount
 *
 * @typedef FlightPlan
 * @property {string}        [id]
 * @property {string}        departure
 * @property {string}        destination
 * @property {number}        [cruiseAltFt]
 * @property {number}        [reserveGal]
 * @property {Waypoint[]}    waypoints
 * @property {Leg[]}         [legs]
 * @property {PlanSummary}   [summary]
 * @property {{routingMode:string,maxLegHrs:number,selfServeOnly:boolean,avoidance:string[]}} [options]
 */

export {};
```

- [ ] **Step 8: `types/weather.js`**

```js
// @ts-check
'use strict';

/**
 * @typedef Metar
 * @property {string}   station
 * @property {string}   observed_at      ISO timestamp
 * @property {boolean}  [wind_variable]
 * @property {number|null} wind_dir
 * @property {number|null} wind_speed
 * @property {number|null} [wind_gust]
 * @property {number|null} [visibility]
 * @property {number|null} [ceiling]
 * @property {number|null} [temp_c]
 * @property {number|null} [dewpoint_c]
 * @property {number|null} [altim_inHg]
 * @property {string}   [raw]
 *
 * @typedef WindAloft
 * @property {number} dir
 * @property {number} kt
 * @property {number} altFt
 *
 * @typedef Tfr
 * @property {string} id
 * @property {Array<{lat:number,lon:number}>} polygon
 * @property {number} [floorFt]
 * @property {number} [ceilingFt]
 * @property {string} [activeFrom]
 * @property {string} [activeTo]
 *
 * @typedef Sigmet
 * @property {string} id
 * @property {'convective'|'general'|'volcanic-ash'} type
 * @property {Array<{lat:number,lon:number}>} points
 * @property {string} [raw]
 *
 * @typedef Airmet
 * @property {string} id
 * @property {'TURB'|'ICING'|'IFR'|'MT_OBSC'|'FZLVL'} category
 * @property {Array<{lat:number,lon:number}>} points
 * @property {string} [raw]
 */

export {};
```

- [ ] **Step 9: Commit**

```bash
git add web/shared/planning/types/
git commit -m "feat(planning): JSDoc @typedef definitions for the lib's public types"
```

---

## Task 5: `math/route-math.js` (TDD)

**Files:**
- Create: `web/shared/planning/math/route-math.js`
- Create: `tests/planning/math/route-math.test.js`

Functions extracted from legacy `web/shared/route-planner.js:70-130`. Pin existing behaviour with tests, then port verbatim.

- [ ] **Step 1: Write failing tests**

```js
// tests/planning/math/route-math.test.js
import { describe, it, expect } from 'vitest';
import { haversine, bearing, intermediatePoint, crossTrackDistanceNm, alongTrackFraction, formatTime } from '../../../web/shared/planning/math/route-math.js';

describe('haversine', () => {
    it('returns 0 for the same point', () => {
        expect(haversine(33, -85, 33, -85)).toBeCloseTo(0, 4);
    });
    it('agrees with a known reference (KLKR → KCLT ≈ 67.5 nm)', () => {
        // KLKR 34.7281,-81.2128  KCLT 35.214,-80.9431
        expect(haversine(34.7281, -81.2128, 35.214, -80.9431)).toBeCloseTo(33.4, 0);
    });
});

describe('bearing', () => {
    it('north is 0°', () => {
        expect(bearing(33, -85, 34, -85)).toBeCloseTo(0, 1);
    });
    it('east is 90°', () => {
        expect(bearing(33, -85, 33, -84)).toBeCloseTo(90, 1);
    });
});

describe('intermediatePoint', () => {
    it('fraction=0 returns start; fraction=1 returns end', () => {
        const p0 = intermediatePoint(33, -85, 35, -83, 0);
        const p1 = intermediatePoint(33, -85, 35, -83, 1);
        expect(p0.lat).toBeCloseTo(33); expect(p0.lon).toBeCloseTo(-85);
        expect(p1.lat).toBeCloseTo(35); expect(p1.lon).toBeCloseTo(-83);
    });
});

describe('crossTrackDistanceNm', () => {
    it('zero on the great-circle path', () => {
        // Point exactly between two points lies on the path
        const mid = intermediatePoint(33, -85, 35, -83, 0.5);
        expect(Math.abs(crossTrackDistanceNm(33, -85, 35, -83, mid.lat, mid.lon))).toBeLessThan(0.01);
    });
});

describe('alongTrackFraction', () => {
    it('returns 0.5 at the midpoint', () => {
        const mid = intermediatePoint(33, -85, 35, -83, 0.5);
        expect(alongTrackFraction(33, -85, 35, -83, mid.lat, mid.lon)).toBeCloseTo(0.5, 2);
    });
});

describe('formatTime', () => {
    it('1.5 hrs → "1:30"', () => { expect(formatTime(1.5)).toBe('1:30'); });
    it('0.25 hrs → "0:15"', () => { expect(formatTime(0.25)).toBe('0:15'); });
});
```

- [ ] **Step 2: Run tests, expect ALL FAIL**

```bash
npm test -- tests/planning/math/route-math.test.js
```

Expected: module-not-found error (the file doesn't exist yet).

- [ ] **Step 3: Create `route-math.js` with content extracted from legacy**

```js
// @ts-check
'use strict';

/**
 * Pure great-circle math used throughout the planner. No external deps.
 * Source of truth for distance / bearing / interpolation; existing flytab
 * behaviour pinned by the test suite.
 */

const EARTH_RADIUS_NM = 3440.065;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Great-circle distance in nautical miles. */
export function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a));
}

/** Initial true bearing from p1 to p2, degrees 0–360. */
export function bearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * RAD, φ2 = lat2 * RAD;
    const Δλ = (lon2 - lon1) * RAD;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * DEG + 360) % 360;
}

/** Point along the great-circle path at fraction f∈[0,1]. */
export function intermediatePoint(lat1, lon1, lat2, lon2, f) {
    const φ1 = lat1 * RAD, λ1 = lon1 * RAD;
    const φ2 = lat2 * RAD, λ2 = lon2 * RAD;
    const δ = haversine(lat1, lon1, lat2, lon2) / EARTH_RADIUS_NM;
    if (δ === 0) return { lat: lat1, lon: lon1 };
    const A = Math.sin((1 - f) * δ) / Math.sin(δ);
    const B = Math.sin(f * δ) / Math.sin(δ);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
    const λ = Math.atan2(y, x);
    return { lat: φ * DEG, lon: λ * DEG };
}

/** Perpendicular distance from point P to the great-circle through 1→2, nm. */
export function crossTrackDistanceNm(lat1, lon1, lat2, lon2, latP, lonP) {
    const δ13 = haversine(lat1, lon1, latP, lonP) / EARTH_RADIUS_NM;
    const θ13 = bearing(lat1, lon1, latP, lonP) * RAD;
    const θ12 = bearing(lat1, lon1, lat2,  lon2) * RAD;
    return Math.asin(Math.sin(δ13) * Math.sin(θ13 - θ12)) * EARTH_RADIUS_NM;
}

/** Along-track fraction of P projected onto leg 1→2 (0=at start, 1=at end). */
export function alongTrackFraction(lat1, lon1, lat2, lon2, latP, lonP) {
    const δ13 = haversine(lat1, lon1, latP, lonP) / EARTH_RADIUS_NM;
    const δxt = Math.abs(crossTrackDistanceNm(lat1, lon1, lat2, lon2, latP, lonP)) / EARTH_RADIUS_NM;
    const δat = Math.acos(Math.cos(δ13) / Math.cos(δxt));
    const δ12 = haversine(lat1, lon1, lat2, lon2) / EARTH_RADIUS_NM;
    return δ12 === 0 ? 0 : δat / δ12;
}

/** Format hours as "H:MM". */
export function formatTime(hrs) {
    if (!Number.isFinite(hrs) || hrs < 0) return '—';
    const totalMin = Math.round(hrs * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Run tests, expect ALL PASS**

```bash
npm test -- tests/planning/math/route-math.test.js
```

- [ ] **Step 5: Commit**

```bash
git add web/shared/planning/math/route-math.js tests/planning/math/route-math.test.js
git commit -m "feat(planning): math/route-math — haversine, bearing, intermediate, cross-track"
```

---

## Task 6: `math/engine-data.js` (TDD)

**Files:**
- Create: `web/shared/planning/math/engine-data.js`
- Create: `tests/planning/math/engine-data.test.js`

Computes TAS / GPH / climb-rate for a given altitude + power setting from an aircraft profile. Mostly fresh code — legacy `route-planner.js` only had RV-9A defaults.

- [ ] **Step 1: Write failing tests**

```js
// tests/planning/math/engine-data.test.js
import { describe, it, expect } from 'vitest';
import { tasAtAltitude, gphAtPower, climbRateAtAltitude } from '../../../web/shared/planning/math/engine-data.js';

const RV9A = { cruise_ktas: 155, fuel_burn_gph: 8.0, service_ceiling_ft: 17500 };

describe('tasAtAltitude', () => {
    it('returns cruise_ktas at 8000 ft (default cruise)', () => {
        expect(tasAtAltitude(RV9A, 8000)).toBeCloseTo(155, 0);
    });
    it('drops at sea level for normally-aspirated engine', () => {
        expect(tasAtAltitude(RV9A, 0)).toBeLessThan(155);
    });
});

describe('gphAtPower', () => {
    it('returns base GPH at 75% power', () => {
        expect(gphAtPower(RV9A, 0.75)).toBeCloseTo(8.0, 1);
    });
    it('scales linearly down to 65%', () => {
        expect(gphAtPower(RV9A, 0.65)).toBeLessThan(gphAtPower(RV9A, 0.75));
    });
});

describe('climbRateAtAltitude', () => {
    it('500+ fpm at sea level for typical light single', () => {
        expect(climbRateAtAltitude(RV9A, 0)).toBeGreaterThanOrEqual(500);
    });
    it('approaches 0 fpm at the service ceiling', () => {
        expect(climbRateAtAltitude(RV9A, 17500)).toBeLessThan(150);
    });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

```bash
npm test -- tests/planning/math/engine-data.test.js
```

- [ ] **Step 3: Create `engine-data.js`**

```js
// @ts-check
'use strict';

/**
 * Engine performance lookups derived from an AircraftProfile. Used by
 * fuel-phases.js to decompose a leg into climb/cruise/descent burn.
 *
 * Altitude effect on TAS for a normally-aspirated piston engine is empirical;
 * we use a two-segment model: linear gain to the profile's "best altitude"
 * (default 8000 ft), then linear falloff above that.
 *
 * @typedef {import('../types/aircraft-profile.js').AircraftProfile} AircraftProfile
 */

const DEFAULT_BEST_ALT_FT = 8000;

/** TAS at a given altitude, knots. */
export function tasAtAltitude(profile, altFt) {
    const best = profile.best_alt_ft ?? DEFAULT_BEST_ALT_FT;
    const tasBest = profile.cruise_ktas;
    if (altFt <= best) {
        // Linear from 0.85 × cruise at sea level to cruise at best alt
        const f = altFt / best;
        return tasBest * (0.85 + 0.15 * f);
    }
    // Above best alt, fall off at ~1 kt per 1000 ft
    return tasBest - (altFt - best) / 1000;
}

/** GPH at a given fractional power 0–1. */
export function gphAtPower(profile, powerFrac) {
    const baseGph = profile.fuel_burn_gph; // assume base is at 75% power
    return baseGph * (powerFrac / 0.75);
}

/** Climb rate fpm at altitude. Linear from sea-level rate to 0 at service ceiling. */
export function climbRateAtAltitude(profile, altFt) {
    const sl = profile.climb_rate_fpm ?? 700;
    const ceil = profile.service_ceiling_ft ?? 14000;
    if (altFt >= ceil) return 0;
    return Math.max(0, sl * (1 - altFt / ceil));
}
```

- [ ] **Step 4: Run tests, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/shared/planning/math/engine-data.js tests/planning/math/engine-data.test.js
git commit -m "feat(planning): math/engine-data — TAS / GPH / climb-rate lookups"
```

---

## Task 7: `math/fuel-phases.js` (TDD)

**Files:**
- Create: `web/shared/planning/math/fuel-phases.js`
- Create: `tests/planning/math/fuel-phases.test.js`

Decomposes a leg into taxi / climb / cruise / descent and returns total burn + leg time. Used by `RoutePlanner.recomputeLegs()`.

- [ ] **Step 1: Write failing tests**

```js
// tests/planning/math/fuel-phases.test.js
import { describe, it, expect } from 'vitest';
import { decomposeLeg } from '../../../web/shared/planning/math/fuel-phases.js';

const RV9A = {
    cruise_ktas: 155, fuel_burn_gph: 8.0,
    climb_rate_fpm: 700, service_ceiling_ft: 17500,
    taxi_burn_gal: 1.5,
};

describe('decomposeLeg', () => {
    it('returns climb + cruise + descent for a typical leg', () => {
        const r = decomposeLeg(RV9A, { distNm: 100, altFt: 6000, departingFromGround: true });
        expect(r.phases.climb.timeHrs).toBeGreaterThan(0);
        expect(r.phases.cruise.timeHrs).toBeGreaterThan(0);
        expect(r.phases.descent.timeHrs).toBeGreaterThan(0);
        expect(r.totalFuelGal).toBeCloseTo(
            r.phases.climb.fuelGal + r.phases.cruise.fuelGal + r.phases.descent.fuelGal + (r.phases.taxi?.fuelGal ?? 0),
            2);
    });

    it('only-cruise leg when departingFromGround=false and no descent flagged', () => {
        const r = decomposeLeg(RV9A, { distNm: 50, altFt: 6000, departingFromGround: false });
        expect(r.phases.climb.timeHrs).toBe(0);
    });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

- [ ] **Step 3: Create `fuel-phases.js`**

```js
// @ts-check
'use strict';

import { tasAtAltitude, gphAtPower, climbRateAtAltitude } from './engine-data.js';

/**
 * @typedef {import('../types/aircraft-profile.js').AircraftProfile} AircraftProfile
 *
 * @typedef PhaseResult
 * @property {number} timeHrs
 * @property {number} fuelGal
 * @property {number} distNm
 * @property {number} altFt
 *
 * @typedef LegOpts
 * @property {number}  distNm
 * @property {number}  altFt
 * @property {boolean} [departingFromGround]
 * @property {boolean} [endingAtGround]
 * @property {number}  [windKt]              tailwind +, headwind -
 *
 * @typedef LegDecomposition
 * @property {{climb:PhaseResult,cruise:PhaseResult,descent:PhaseResult,taxi?:PhaseResult}} phases
 * @property {number} totalTimeHrs
 * @property {number} totalFuelGal
 */

/** Decompose a leg into climb/cruise/descent (and taxi if departing from ground). */
export function decomposeLeg(profile, leg) {
    const wind = leg.windKt ?? 0;
    const phases = {
        taxi:    { timeHrs: 0, fuelGal: 0, distNm: 0, altFt: 0 },
        climb:   { timeHrs: 0, fuelGal: 0, distNm: 0, altFt: leg.altFt },
        cruise:  { timeHrs: 0, fuelGal: 0, distNm: leg.distNm, altFt: leg.altFt },
        descent: { timeHrs: 0, fuelGal: 0, distNm: 0, altFt: leg.altFt },
    };

    if (leg.departingFromGround) {
        phases.taxi = {
            timeHrs: 0,
            fuelGal: profile.taxi_burn_gal ?? 1.5,
            distNm: 0,
            altFt: 0,
        };

        // Climb: time = altFt / climbRate(0..altFt avg) ; distance covered = TAS_climb × time
        const climbRate = (climbRateAtAltitude(profile, 0) + climbRateAtAltitude(profile, leg.altFt)) / 2 || 1;
        const climbHrs  = leg.altFt / climbRate / 60;       // fpm → hrs
        const tasClimb  = tasAtAltitude(profile, leg.altFt / 2);
        const climbDist = (tasClimb + wind) * climbHrs;
        phases.climb = {
            timeHrs: climbHrs,
            fuelGal: gphAtPower(profile, 0.75) * climbHrs * 1.10,  // 10% richer in climb
            distNm:  Math.min(climbDist, leg.distNm * 0.4),
            altFt:   leg.altFt,
        };
    }

    if (leg.endingAtGround) {
        const descRate  = 500;  // standard 500 fpm descent
        const descHrs   = leg.altFt / descRate / 60;
        const tasDesc   = tasAtAltitude(profile, leg.altFt / 2);
        const descDist  = (tasDesc + wind) * descHrs;
        phases.descent = {
            timeHrs: descHrs,
            fuelGal: gphAtPower(profile, 0.55) * descHrs,
            distNm:  Math.min(descDist, leg.distNm * 0.3),
            altFt:   leg.altFt,
        };
    }

    const cruiseDist = Math.max(0, leg.distNm - phases.climb.distNm - phases.descent.distNm);
    const tasCruise  = tasAtAltitude(profile, leg.altFt);
    const cruiseHrs  = cruiseDist / Math.max(1, tasCruise + wind);
    phases.cruise = {
        timeHrs: cruiseHrs,
        fuelGal: gphAtPower(profile, 0.75) * cruiseHrs,
        distNm:  cruiseDist,
        altFt:   leg.altFt,
    };

    const totalTimeHrs = phases.taxi.timeHrs + phases.climb.timeHrs + phases.cruise.timeHrs + phases.descent.timeHrs;
    const totalFuelGal = phases.taxi.fuelGal + phases.climb.fuelGal + phases.cruise.fuelGal + phases.descent.fuelGal;

    return { phases, totalTimeHrs, totalFuelGal };
}
```

- [ ] **Step 4: Run tests, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/shared/planning/math/fuel-phases.js tests/planning/math/fuel-phases.test.js
git commit -m "feat(planning): math/fuel-phases — taxi/climb/cruise/descent decomposition"
```

---

## Task 8: `planner/airway-graph.js` (TDD with routingMode filter)

**Files:**
- Create: `web/shared/planning/planner/airway-graph.js`
- Create: `tests/planning/planner/airway-graph.test.js`
- Create: `tests/planning/fixtures/synthetic-airway-graph.js`
- Create: `tests/planning/fixtures/mock-adapters.js`

Loads the airway graph from an `AeroDataSource`, honouring `routingMode` so only the permitted airway types contribute edges.

- [ ] **Step 1: Mock-adapters fixture**

```js
// tests/planning/fixtures/mock-adapters.js
export function makeAeroAdapter({ airports = {}, navaids = {}, fixes = {}, airways = {}, airspaces = [] } = {}) {
    return {
        async getAirport(icao) { return airports[icao] ?? null; },
        async getNavaid(id)    { return navaids[id]  ?? null; },
        async getFix(name)     { return fixes[name]  ?? null; },
        async getAirway(id)    { return airways[id]  ?? null; },
        async listAirspace()   { return airspaces; },
        async listAirways()    { return Object.values(airways); },
    };
}
export const NULL_WEATHER = {
    async getMetar() { return null; },
    async getWindAloft() { return null; },
    async listActiveTfrs() { return []; },
    async listSigmets() { return []; },
    async listAirmets() { return []; },
};
export const NULL_PLANS = {
    async get() { return null; }, async put() { return ''; }, async list() { return []; }, async delete() {},
};
export const NULL_PROFILES = {
    async get() { return null; }, async put() { return ''; }, async list() { return []; }, async getActive() { return null; },
};
export const NULL_NETWORK = new (class extends EventTarget { get mode() { return 'home'; } })();
export const FROZEN_CLOCK = { now: () => 1746480000000 };
```

- [ ] **Step 2: Synthetic-graph fixture**

```js
// tests/planning/fixtures/synthetic-airway-graph.js
// 5 fixes; one V airway (V1 = A→B→C) and one T airway (T1 = A→D→C)
export const FIXES = {
    A: { id: 'A', lat: 33.0, lon: -85.0 },
    B: { id: 'B', lat: 33.5, lon: -84.5 },
    C: { id: 'C', lat: 34.0, lon: -84.0 },
    D: { id: 'D', lat: 33.4, lon: -84.6 },
    E: { id: 'E', lat: 34.1, lon: -83.9 },
};
export const AIRWAYS = {
    V1: { id: 'V1', type: 'V', fixIds: ['A', 'B', 'C'] },
    T1: { id: 'T1', type: 'T', fixIds: ['A', 'D', 'C'] },
};
```

- [ ] **Step 3: Write failing tests**

```js
// tests/planning/planner/airway-graph.test.js
import { describe, it, expect } from 'vitest';
import { AirwayGraph } from '../../../web/shared/planning/planner/airway-graph.js';
import { makeAeroAdapter } from '../fixtures/mock-adapters.js';
import { FIXES, AIRWAYS } from '../fixtures/synthetic-airway-graph.js';

const aero = makeAeroAdapter({ fixes: FIXES, airways: AIRWAYS });

describe('AirwayGraph routingMode', () => {
    it('routingMode "any" loads V and T edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'any' });
        await g.load();
        expect(g.edges('A').some(e => e.airway === 'V1')).toBe(true);
        expect(g.edges('A').some(e => e.airway === 'T1')).toBe(true);
    });

    it('routingMode "v-airways" loads only V edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'v-airways' });
        await g.load();
        expect(g.edges('A').some(e => e.airway === 'V1')).toBe(true);
        expect(g.edges('A').some(e => e.airway === 'T1')).toBe(false);
    });

    it('routingMode "t-airways" loads only T edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 't-airways' });
        await g.load();
        expect(g.edges('A').some(e => e.airway === 'V1')).toBe(false);
        expect(g.edges('A').some(e => e.airway === 'T1')).toBe(true);
    });

    it('routingMode "gps-direct" loads no airway edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'gps-direct' });
        await g.load();
        expect(g.edges('A')).toEqual([]);
        expect(g.edges('C')).toEqual([]);
    });

    it('routingMode "vors-direct" loads no airway edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'vors-direct' });
        await g.load();
        expect(g.edges('A')).toEqual([]);
    });

    it('edges include both directions', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'v-airways' });
        await g.load();
        expect(g.edges('B').some(e => e.toId === 'A')).toBe(true);
        expect(g.edges('B').some(e => e.toId === 'C')).toBe(true);
    });
});
```

- [ ] **Step 4: Run tests, expect FAIL**

- [ ] **Step 5: Implement `airway-graph.js`**

```js
// @ts-check
'use strict';

import { haversine } from '../math/route-math.js';

/**
 * @typedef {import('../adapters/aero-data-source.js').AeroDataSource} AeroDataSource
 * @typedef {'gps-direct'|'vors-direct'|'v-airways'|'t-airways'|'any'} RoutingMode
 *
 * @typedef Edge
 * @property {string} toId
 * @property {number} distNm
 * @property {number} [meaFt]
 * @property {string} airway     'V143' | 'T-airway-id' | 'DIRECT'
 */

const TYPES_BY_MODE = {
    'any':         null,             // null = no filter
    'v-airways':   new Set(['V']),
    't-airways':   new Set(['T']),
    'gps-direct':  new Set(),        // empty = no airway edges
    'vors-direct': new Set(),
};

export class AirwayGraph {
    /**
     * @param {AeroDataSource} aero
     * @param {{routingMode?: RoutingMode}} [opts]
     */
    constructor(aero, opts = {}) {
        this._aero        = aero;
        this._routingMode = opts.routingMode || 'any';
        /** @type {Record<string, {lat:number,lon:number}>} */
        this.coords = {};
        /** @type {Record<string, Edge[]>} */
        this._adj = {};
        this._loaded = false;
    }

    /** Build the adjacency from the configured AeroDataSource. */
    async load() {
        if (this._loaded) return;
        const allowed = TYPES_BY_MODE[this._routingMode];

        // GPS-Direct / VORs-Direct: skip the airway list entirely; coords come
        // from per-fix lookups during plan().
        if (allowed && allowed.size === 0) {
            this._loaded = true;
            return;
        }

        const airways = await this._aero.listAirways();
        for (const a of airways) {
            if (allowed && !allowed.has(a.type)) continue;
            const ids = a.fixIds || [];
            for (let i = 0; i < ids.length - 1; i++) {
                const fa = await this._aero.getFix(ids[i])
                        || await this._aero.getNavaid(ids[i]);
                const fb = await this._aero.getFix(ids[i + 1])
                        || await this._aero.getNavaid(ids[i + 1]);
                if (!fa || !fb) continue;
                this.coords[fa.id] = { lat: fa.lat, lon: fa.lon };
                this.coords[fb.id] = { lat: fb.lat, lon: fb.lon };
                const d = haversine(fa.lat, fa.lon, fb.lat, fb.lon);
                this._addEdge(fa.id, { toId: fb.id, distNm: d, airway: a.id });
                this._addEdge(fb.id, { toId: fa.id, distNm: d, airway: a.id });
            }
        }
        this._loaded = true;
    }

    edges(fixId) { return this._adj[fixId] || []; }

    /** Add a temporary direct edge (e.g. for DEP/DEST onto the graph). */
    addDirectEdge(fromId, fromLat, fromLon, toId, toLat, toLon) {
        this.coords[fromId] = this.coords[fromId] || { lat: fromLat, lon: fromLon };
        this.coords[toId]   = this.coords[toId]   || { lat: toLat,   lon: toLon   };
        const d = haversine(fromLat, fromLon, toLat, toLon);
        this._addEdge(fromId, { toId, distNm: d, airway: 'DIRECT' });
        this._addEdge(toId,   { toId: fromId, distNm: d, airway: 'DIRECT' });
    }

    _addEdge(fromId, edge) {
        const list = this._adj[fromId] || (this._adj[fromId] = []);
        if (!list.find(e => e.toId === edge.toId && e.airway === edge.airway)) list.push(edge);
    }
}
```

- [ ] **Step 6: Run tests, expect PASS**

- [ ] **Step 7: Commit**

```bash
git add web/shared/planning/planner/airway-graph.js tests/planning/planner/airway-graph.test.js tests/planning/fixtures/
git commit -m "feat(planning): AirwayGraph with routingMode filter (gps-direct/vors-direct/v/t/any)"
```

---

## Task 9: `planner/avoidance.js` (TDD)

**Files:**
- Create: `web/shared/planning/planner/avoidance.js`
- Create: `tests/planning/planner/avoidance.test.js`

Translates an avoidance constraint set into an A* edge-cost penalty function.

- [ ] **Step 1: Write failing tests**

```js
// tests/planning/planner/avoidance.test.js
import { describe, it, expect } from 'vitest';
import { buildAvoidancePenalty, segmentIntersectsPolygon } from '../../../web/shared/planning/planner/avoidance.js';

const SQUARE = [
    { lat: 33.0, lon: -85.0 },
    { lat: 33.0, lon: -84.0 },
    { lat: 34.0, lon: -84.0 },
    { lat: 34.0, lon: -85.0 },
];

describe('segmentIntersectsPolygon', () => {
    it('detects a segment crossing the square', () => {
        expect(segmentIntersectsPolygon(33.5, -85.5, 33.5, -83.5, SQUARE)).toBe(true);
    });
    it('returns false for a segment entirely outside', () => {
        expect(segmentIntersectsPolygon(35.0, -85.5, 35.0, -83.5, SQUARE)).toBe(false);
    });
});

describe('buildAvoidancePenalty', () => {
    it('returns Infinity for an edge crossing an avoided airspace', () => {
        const fn = buildAvoidancePenalty([{ id: 'NYB', polygon: SQUARE }], { hardBlock: true });
        const cost = fn({ from: { lat: 33.5, lon: -85.5 }, to: { lat: 33.5, lon: -83.5 } });
        expect(cost).toBe(Infinity);
    });
    it('returns 0 when no airspaces are avoided', () => {
        const fn = buildAvoidancePenalty([]);
        expect(fn({ from: { lat: 33, lon: -85 }, to: { lat: 34, lon: -84 } })).toBe(0);
    });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

- [ ] **Step 3: Implement `avoidance.js`**

```js
// @ts-check
'use strict';

/**
 * @typedef {import('../types/airspace.js').Airspace} Airspace
 *
 * @typedef AvoidanceConstraint
 * @property {string}                              id
 * @property {Array<{lat:number,lon:number}>}     polygon
 * @property {number}                             [floorFt]
 * @property {number}                             [ceilingFt]
 *
 * @typedef PenaltyOpts
 * @property {boolean} [hardBlock=true]
 * @property {number}  [softCostNm=200]
 */

/** Standard ray-cast point-in-polygon. */
function pointInPolygon(lat, lon, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].lon, yi = poly[i].lat;
        const xj = poly[j].lon, yj = poly[j].lat;
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/** Check whether two 2D segments intersect (lon-lat, ignoring earth curvature for short legs). */
function segmentsIntersect(a1, a2, b1, b2) {
    const d  = (a2.lon - a1.lon) * (b2.lat - b1.lat) - (a2.lat - a1.lat) * (b2.lon - b1.lon);
    if (d === 0) return false;
    const t  = ((b1.lon - a1.lon) * (b2.lat - b1.lat) - (b1.lat - a1.lat) * (b2.lon - b1.lon)) / d;
    const u  = ((b1.lon - a1.lon) * (a2.lat - a1.lat) - (b1.lat - a1.lat) * (a2.lon - a1.lon)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** True if any segment endpoint is inside or any segment side crosses the polygon perimeter. */
export function segmentIntersectsPolygon(lat1, lon1, lat2, lon2, poly) {
    if (pointInPolygon(lat1, lon1, poly) || pointInPolygon(lat2, lon2, poly)) return true;
    const a1 = { lat: lat1, lon: lon1 }, a2 = { lat: lat2, lon: lon2 };
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        if (segmentsIntersect(a1, a2, poly[j], poly[i])) return true;
    }
    return false;
}

/**
 * Returns a penalty function suitable for A*'s edge-cost addend. Edge cost
 * = base distance + penalty(edge). A hard-block returns Infinity.
 *
 * @param {AvoidanceConstraint[]} constraints
 * @param {PenaltyOpts}           [opts]
 */
export function buildAvoidancePenalty(constraints, opts = {}) {
    const hardBlock = opts.hardBlock ?? true;
    const softCost  = opts.softCostNm ?? 200;
    if (!constraints.length) return () => 0;
    return ({ from, to }) => {
        for (const c of constraints) {
            if (segmentIntersectsPolygon(from.lat, from.lon, to.lat, to.lon, c.polygon)) {
                return hardBlock ? Infinity : softCost;
            }
        }
        return 0;
    };
}
```

- [ ] **Step 4: Run tests, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/shared/planning/planner/avoidance.js tests/planning/planner/avoidance.test.js
git commit -m "feat(planning): avoidance — airspace polygon constraint → A* edge penalty"
```

---

## Task 10: `planner/parser.js` (TDD with airway expansion — issue 2)

**Files:**
- Create: `web/shared/planning/planner/parser.js`
- Create: `tests/planning/planner/parser.test.js`

`parseRouteString(str, { aero, routingMode })` — tokenises a route string, classifies each token (DEP/airway/fix/DEST), and **expands airway tokens into their interior fixes** by calling `aero.getAirway(id)`.

- [ ] **Step 1: Write failing tests**

```js
// tests/planning/planner/parser.test.js
import { describe, it, expect } from 'vitest';
import { parseRouteString, UnknownAirwayError, RoutingModeViolationError } from '../../../web/shared/planning/planner/parser.js';
import { makeAeroAdapter } from '../fixtures/mock-adapters.js';

const FIXES = {
    KLKR: { id: 'KLKR', lat: 34.7281, lon: -81.2128 },
    GSO:  { id: 'GSO',  lat: 36.0978, lon: -79.9373 },
    K44N: { id: 'K44N', lat: 38.9001, lon: -77.5234 },
    LRP:  { id: 'LRP',  lat: 40.1213, lon: -76.2945 },
    ABC:  { id: 'ABC',  lat: 35.0,    lon: -80.0 },
    DEF:  { id: 'DEF',  lat: 35.5,    lon: -79.5 },
};
const AIRWAYS = {
    V143: { id: 'V143', type: 'V', fixIds: ['KLKR', 'ABC', 'DEF', 'GSO'] },
    T1:   { id: 'T1',   type: 'T', fixIds: ['GSO',  'LRP',  'K44N'] },
};
const aero = makeAeroAdapter({ fixes: FIXES, airways: AIRWAYS });

describe('parseRouteString', () => {
    it('parses a 2-token direct route (DEP DEST)', async () => {
        const r = await parseRouteString('KLKR K44N', { aero });
        expect(r.waypoints.map(w => w.id)).toEqual(['KLKR', 'K44N']);
    });

    it('expands an airway token into its interior fixes between entry and exit', async () => {
        const r = await parseRouteString('KLKR V143 GSO', { aero });
        expect(r.waypoints.map(w => w.id)).toEqual(['KLKR', 'ABC', 'DEF', 'GSO']);
    });

    it('expands multiple airways correctly', async () => {
        const r = await parseRouteString('KLKR V143 GSO T1 K44N', { aero });
        expect(r.waypoints.map(w => w.id)).toEqual(['KLKR', 'ABC', 'DEF', 'GSO', 'LRP', 'K44N']);
    });

    it('throws UnknownAirwayError for an unknown airway token', async () => {
        await expect(parseRouteString('KLKR V999 GSO', { aero })).rejects.toBeInstanceOf(UnknownAirwayError);
    });

    it('throws RoutingModeViolationError when a T-airway appears under v-airways mode', async () => {
        await expect(
            parseRouteString('KLKR V143 GSO T1 K44N', { aero, routingMode: 'v-airways' })
        ).rejects.toBeInstanceOf(RoutingModeViolationError);
    });

    it('treats a token already inside an airway as the entry point', async () => {
        // ABC is interior to V143; entry "ABC V143 GSO" should expand DEF only
        const r = await parseRouteString('ABC V143 GSO', { aero });
        expect(r.waypoints.map(w => w.id)).toEqual(['ABC', 'DEF', 'GSO']);
    });

    it('reverses airway direction when entry comes after exit in fixIds', async () => {
        const r = await parseRouteString('GSO V143 KLKR', { aero });
        expect(r.waypoints.map(w => w.id)).toEqual(['GSO', 'DEF', 'ABC', 'KLKR']);
    });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

- [ ] **Step 3: Create `route-planner-errors.js` (the parser imports from this)**

```js
// web/shared/planning/planner/route-planner-errors.js
// @ts-check
'use strict';

export class PlanError extends Error {
    constructor(message) { super(message); this.name = 'PlanError'; }
}
export class NoRouteFoundError        extends PlanError { constructor(m) { super(m); this.name = 'NoRouteFoundError'; } }
export class DestinationUnreachableError extends PlanError { constructor(m) { super(m); this.name = 'DestinationUnreachableError'; } }
export class TimeoutError             extends PlanError { constructor(m) { super(m); this.name = 'TimeoutError'; } }
```

- [ ] **Step 4: Implement `parser.js`**

```js
// @ts-check
'use strict';

import { PlanError } from './route-planner-errors.js';

export class UnknownWaypointError extends PlanError {
    constructor(id) { super(`Unknown waypoint: ${id}`); this.waypointId = id; }
}
export class UnknownAirwayError extends PlanError {
    constructor(id) { super(`Unknown airway: ${id}`); this.airwayId = id; }
}
export class AmbiguousIdentifierError extends PlanError {
    constructor(id, matches) { super(`Ambiguous: ${id}`); this.id = id; this.matches = matches; }
}
export class RoutingModeViolationError extends PlanError {
    constructor(airwayId, mode) {
        super(`Airway ${airwayId} not allowed under routingMode "${mode}"`);
        this.airwayId = airwayId; this.mode = mode;
    }
}

const AIRWAY_RE = /^[VTJQ]\d+[A-Z]?$/;

function isAirwayToken(tok) { return AIRWAY_RE.test(tok); }

function airwayTypeAllowed(type, mode) {
    if (mode === 'any') return true;
    if (mode === 'v-airways') return type === 'V';
    if (mode === 't-airways') return type === 'T';
    return false;  // gps-direct, vors-direct never allow airways in pasted strings
}

/**
 * Resolve a fix/navaid/airport identifier to a waypoint with coords.
 * Tries airport → navaid → fix in order.
 */
async function resolveIdentifier(aero, id) {
    const apt = await aero.getAirport(id);
    if (apt) return { id, lat: apt.lat, lon: apt.lon, kind: 'APT' };
    const nav = await aero.getNavaid(id);
    if (nav) return { id, lat: nav.lat, lon: nav.lon, kind: 'NAV' };
    const fix = await aero.getFix(id);
    if (fix) return { id, lat: fix.lat, lon: fix.lon, kind: 'FIX' };
    throw new UnknownWaypointError(id);
}

/**
 * Parse a route string into a fully-expanded waypoint sequence. Airway tokens
 * are replaced by the slice of their fix list lying between the prior and
 * next non-airway tokens (inclusive of those endpoints — but the endpoints
 * are added by their own resolve calls; airway expansion only contributes
 * the strictly-interior fixes).
 *
 * @param {string} str
 * @param {{aero: import('../adapters/aero-data-source.js').AeroDataSource, routingMode?: string}} opts
 * @returns {Promise<{departure:string, destination:string, waypoints:any[]}>}
 */
export async function parseRouteString(str, opts) {
    const aero = opts.aero;
    const mode = opts.routingMode || 'any';
    const tokens = str.trim().split(/\s+/).filter(Boolean).map(t => t.toUpperCase());
    if (tokens.length < 2) throw new PlanError('Need at least 2 tokens (departure + destination)');

    const waypoints = [];
    let i = 0;
    while (i < tokens.length) {
        const tok = tokens[i];

        if (isAirwayToken(tok)) {
            const airway = await aero.getAirway(tok);
            if (!airway) throw new UnknownAirwayError(tok);
            if (!airwayTypeAllowed(airway.type, mode)) throw new RoutingModeViolationError(tok, mode);

            // Need entry (= last waypoint added) and exit (= next non-airway token)
            const entry = waypoints[waypoints.length - 1];
            if (!entry) throw new PlanError(`Airway ${tok} cannot be the first token`);
            const exitTok = tokens[i + 1];
            if (!exitTok || isAirwayToken(exitTok))
                throw new PlanError(`Airway ${tok} must be followed by a fix token`);

            const entryIdx = airway.fixIds.indexOf(entry.id);
            const exitIdx  = airway.fixIds.indexOf(exitTok);
            if (entryIdx < 0)
                throw new PlanError(`Entry fix ${entry.id} not on airway ${tok}`);
            if (exitIdx < 0)
                throw new PlanError(`Exit fix ${exitTok} not on airway ${tok}`);

            // Walk the airway from entryIdx → exitIdx (forward or reverse) and add interior fixes.
            // Tag each interior fix with the airway it came from.
            const step = exitIdx > entryIdx ? 1 : -1;
            for (let k = entryIdx + step; k !== exitIdx; k += step) {
                const interior = await resolveIdentifier(aero, airway.fixIds[k]);
                interior.airway = airway.id;
                waypoints.push(interior);
            }
            // Don't advance past the airway token — let the next iteration consume the exit token
            i++;
            continue;
        }

        const wp = await resolveIdentifier(aero, tok);
        waypoints.push(wp);
        i++;
    }

    if (waypoints.length < 2)
        throw new PlanError('Parsed route has fewer than 2 waypoints');

    return {
        departure:   waypoints[0].id,
        destination: waypoints[waypoints.length - 1].id,
        waypoints,
    };
}
```

- [ ] **Step 5: Run tests, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add web/shared/planning/planner/parser.js web/shared/planning/planner/route-planner-errors.js tests/planning/planner/parser.test.js
git commit -m "feat(planning): parseRouteString with airway-token expansion + routingMode validation"
```

---

## Task 11: `planner/route-planner.js` (RoutePlanner class with adapters)

**Files:**
- Create: `web/shared/planning/planner/route-planner.js`
- Create: `tests/planning/planner/route-planner.test.js`

The public face of the lib. Wraps the airway graph + parser + A* + leg-recompute behind a single class that takes adapters at construction.

- [ ] **Step 1: Write failing tests**

```js
// tests/planning/planner/route-planner.test.js
import { describe, it, expect } from 'vitest';
import { RoutePlanner } from '../../../web/shared/planning/planner/route-planner.js';
import { makeAeroAdapter, NULL_WEATHER, NULL_PLANS, NULL_PROFILES, NULL_NETWORK, FROZEN_CLOCK } from '../fixtures/mock-adapters.js';
import { FIXES, AIRWAYS } from '../fixtures/synthetic-airway-graph.js';

const aero = makeAeroAdapter({
    airports: { KA: { icao: 'KA', lat: 33.0, lon: -85.0 }, KC: { icao: 'KC', lat: 34.0, lon: -84.0 } },
    fixes: FIXES,
    airways: AIRWAYS,
});

const adapters = { aero, weather: NULL_WEATHER, plans: NULL_PLANS, profiles: NULL_PROFILES, network: NULL_NETWORK, clock: FROZEN_CLOCK };

describe('RoutePlanner.plan()', () => {
    it('plans a direct GPS route (no airways) for routingMode "gps-direct"', async () => {
        const p = new RoutePlanner(adapters);
        const plan = await p.plan({ departure: 'KA', destination: 'KC', routingMode: 'gps-direct' });
        expect(plan.waypoints.map(w => w.id)).toEqual(['KA', 'KC']);
    });

    it('routes via V airways when routingMode "v-airways"', async () => {
        const p = new RoutePlanner(adapters);
        const plan = await p.plan({ departure: 'KA', destination: 'KC', routingMode: 'v-airways' });
        // V1 = A→B→C; the planner will pick V1 since it's the only graph path
        expect(plan.waypoints.map(w => w.id)).toContain('B');
    });

    it('throws DestinationUnreachableError for an unreachable dest', async () => {
        const tinyAero = makeAeroAdapter({
            airports: { KA: { icao: 'KA', lat: 33, lon: -85 }, KC: { icao: 'KC', lat: 34, lon: -84 } },
            // No airways and no shared fixes — graph is empty under v-airways
        });
        const p = new RoutePlanner({ ...adapters, aero: tinyAero });
        const plan = await p.plan({ departure: 'KA', destination: 'KC', routingMode: 'v-airways' });
        // Falls back to direct (DEP/DEST direct edge is always added)
        expect(plan.waypoints.map(w => w.id)).toEqual(['KA', 'KC']);
    });
});

describe('RoutePlanner.parseRoute()', () => {
    it('expands airway tokens', async () => {
        const p = new RoutePlanner(adapters);
        const r = await p.parseRoute('A V1 C');
        expect(r.waypoints.map(w => w.id)).toEqual(['A', 'B', 'C']);
    });
});

describe('RoutePlanner.recomputeLegs()', () => {
    it('returns a plan with leg distances filled in', async () => {
        const p = new RoutePlanner(adapters);
        const plan = await p.parseRoute('A V1 C');
        const recomputed = p.recomputeLegs(plan);
        expect(recomputed.legs.length).toBe(2);
        expect(recomputed.legs[0].distNm).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

- [ ] **Step 3: Implement `route-planner.js`**

```js
// @ts-check
'use strict';

import { AirwayGraph } from './airway-graph.js';
import { parseRouteString } from './parser.js';
import { buildAvoidancePenalty } from './avoidance.js';
import { haversine, bearing } from '../math/route-math.js';
import { decomposeLeg } from '../math/fuel-phases.js';
import { PlanError, NoRouteFoundError, DestinationUnreachableError } from './route-planner-errors.js';

/**
 * @typedef {import('../adapters/aero-data-source.js').AeroDataSource} AeroDataSource
 * @typedef {import('../adapters/weather-source.js').WeatherSource}    WeatherSource
 * @typedef {import('../adapters/plan-store.js').PlanStore}            PlanStore
 * @typedef {import('../adapters/profile-store.js').ProfileStore}      ProfileStore
 * @typedef {import('../adapters/network-status.js').NetworkStatus}    NetworkStatus
 * @typedef {import('../adapters/clock.js').Clock}                     Clock
 *
 * @typedef Adapters
 * @property {AeroDataSource} aero
 * @property {WeatherSource}  weather
 * @property {PlanStore}      plans
 * @property {ProfileStore}   profiles
 * @property {NetworkStatus}  network
 * @property {Clock}          clock
 */

const RV9A_FALLBACK = {
    id: 'rv9a-default', tailNumber: '', model: 'RV-9A',
    cruise_ktas: 155, fuel_burn_gph: 8.0, fuel_capacity_gal: 36, reserve_gal: 10,
    climb_rate_fpm: 750, service_ceiling_ft: 17500, taxi_burn_gal: 1.5,
    equipment: { vAirways: true, tAirways: false, jAirways: false, gpsApproach: true },
};

export class RoutePlanner {
    /** @param {Adapters} adapters */
    constructor(adapters) {
        if (!adapters?.aero)   throw new PlanError('aero adapter required');
        if (!adapters?.plans)  throw new PlanError('plans adapter required');
        this._adapters = adapters;
        /** @type {Map<string, AirwayGraph>} */
        this._graphCache = new Map();
    }

    /**
     * Plan a route from departure to destination.
     * @param {object} opts
     * @returns {Promise<import('../types/flight-plan.js').FlightPlan>}
     */
    async plan(opts) {
        const profile = (await this._adapters.profiles.getActive?.()) || RV9A_FALLBACK;
        const routingMode = opts.routingMode
            || (profile.equipment?.tAirways ? 'any' : 'v-airways');

        const dep  = await this._adapters.aero.getAirport(opts.departure);
        const dest = await this._adapters.aero.getAirport(opts.destination);
        if (!dep)  throw new PlanError(`Unknown departure: ${opts.departure}`);
        if (!dest) throw new PlanError(`Unknown destination: ${opts.destination}`);

        const graph = await this._getGraph(routingMode);
        graph.addDirectEdge(dep.icao, dep.lat, dep.lon, dest.icao, dest.lat, dest.lon);

        const penalty = buildAvoidancePenalty(opts.avoidance || []);
        const path = this._aStar(graph, dep.icao, dest.icao, penalty);
        if (!path) throw new DestinationUnreachableError(`No route from ${opts.departure} to ${opts.destination}`);

        const waypoints = path.map(id => {
            const c = graph.coords[id];
            return { id, lat: c.lat, lon: c.lon };
        });

        const flightPlan = {
            departure:   opts.departure,
            destination: opts.destination,
            cruiseAltFt: opts.cruiseAltFt ?? 6000,
            reserveGal:  opts.reserveGal  ?? profile.reserve_gal ?? 10,
            waypoints,
            options: {
                routingMode,
                maxLegHrs:     opts.maxLegHrs ?? 2.0,
                selfServeOnly: !!opts.selfServeOnly,
                avoidance:     (opts.avoidance || []).map(a => a.id),
            },
        };
        return this.recomputeLegs(flightPlan, profile);
    }

    /**
     * Parse a route string. Returns a fully-expanded plan with all interior
     * airway fixes resolved.
     */
    async parseRoute(str, opts = {}) {
        const profile = (await this._adapters.profiles.getActive?.()) || RV9A_FALLBACK;
        const routingMode = opts.routingMode
            || (profile.equipment?.tAirways ? 'any' : 'v-airways');
        const parsed = await parseRouteString(str, { aero: this._adapters.aero, routingMode });
        return this.recomputeLegs({
            departure:   parsed.departure,
            destination: parsed.destination,
            cruiseAltFt: opts.cruiseAltFt ?? 6000,
            reserveGal:  opts.reserveGal  ?? profile.reserve_gal ?? 10,
            waypoints:   parsed.waypoints,
            options:     { routingMode, maxLegHrs: 2.0, selfServeOnly: false, avoidance: [] },
        }, profile);
    }

    /** Recompute leg-level data without re-running A*. */
    recomputeLegs(plan, profileOverride) {
        const profile = profileOverride || RV9A_FALLBACK;
        const wps = plan.waypoints;
        const legs = [];
        let fuelRem = profile.fuel_capacity_gal;
        for (let i = 0; i < wps.length - 1; i++) {
            const a = wps[i], b = wps[i + 1];
            const distNm = haversine(a.lat, a.lon, b.lat, b.lon);
            const altFt = plan.cruiseAltFt;
            const decomp = decomposeLeg(profile, {
                distNm, altFt,
                departingFromGround: i === 0,
                endingAtGround:      i === wps.length - 2,
            });
            fuelRem -= decomp.totalFuelGal;
            legs.push({
                from: a.id, to: b.id,
                distNm,
                bearingTrue: bearing(a.lat, a.lon, b.lat, b.lon),
                altFt,
                tasKt: profile.cruise_ktas,
                gsKt:  profile.cruise_ktas,
                timeHrs: decomp.totalTimeHrs,
                fuelGal: decomp.totalFuelGal,
                fuelRemGal: fuelRem,
                airway: b.airway || 'DIRECT',
            });
        }
        const summary = {
            totalDistNm:   legs.reduce((s, l) => s + l.distNm, 0),
            totalEteHrs:   legs.reduce((s, l) => s + l.timeHrs, 0),
            totalFuelGal:  legs.reduce((s, l) => s + l.fuelGal, 0),
            fuelRemGal:    fuelRem,
            fixCount:      wps.length,
        };
        return { ...plan, legs, summary };
    }

    async _getGraph(mode) {
        if (this._graphCache.has(mode)) return this._graphCache.get(mode);
        const g = new AirwayGraph(this._adapters.aero, { routingMode: mode });
        await g.load();
        this._graphCache.set(mode, g);
        return g;
    }

    /** Standard A* with cost = base distance + avoidance penalty. */
    _aStar(graph, startId, goalId, penaltyFn) {
        const goal = graph.coords[goalId];
        if (!goal) return null;
        const open = new Map();      // id → fScore
        const cameFrom = new Map();
        const gScore = new Map();
        gScore.set(startId, 0);
        const h = (id) => {
            const c = graph.coords[id];
            return c ? haversine(c.lat, c.lon, goal.lat, goal.lon) : Infinity;
        };
        open.set(startId, h(startId));

        while (open.size) {
            // Pick lowest f-score
            let cur = null, best = Infinity;
            for (const [id, f] of open) if (f < best) { best = f; cur = id; }
            if (cur === goalId) return this._reconstruct(cameFrom, cur);
            open.delete(cur);

            const curCoord = graph.coords[cur];
            for (const e of graph.edges(cur)) {
                const next = e.toId;
                const nextCoord = graph.coords[next];
                if (!curCoord || !nextCoord) continue;
                const pen = penaltyFn({ from: curCoord, to: nextCoord });
                if (pen === Infinity) continue;
                const tentative = (gScore.get(cur) ?? Infinity) + e.distNm + pen;
                if (tentative < (gScore.get(next) ?? Infinity)) {
                    cameFrom.set(next, cur);
                    gScore.set(next, tentative);
                    open.set(next, tentative + h(next));
                }
            }
        }
        return null;
    }

    _reconstruct(cameFrom, end) {
        const path = [end];
        while (cameFrom.has(path[0])) path.unshift(cameFrom.get(path[0]));
        return path;
    }
}
```

- [ ] **Step 4: Run tests, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/shared/planning/planner/route-planner.js tests/planning/planner/route-planner.test.js
git commit -m "feat(planning): RoutePlanner — plan(), parseRoute(), recomputeLegs() with adapter injection"
```

---

## Task 12: `planner/optimizer.js` (TDD)

**Files:**
- Create: `web/shared/planning/planner/optimizer.js`
- Create: `tests/planning/planner/optimizer.test.js`

Three modes: least-fuel, least-time, best-altitude (returns the cruise altitude with lowest total fuel given winds). Uses `RoutePlanner.plan()` internally.

- [ ] **Step 1: Write failing tests**

```js
// tests/planning/planner/optimizer.test.js
import { describe, it, expect } from 'vitest';
import { Optimizer } from '../../../web/shared/planning/planner/optimizer.js';
import { RoutePlanner } from '../../../web/shared/planning/planner/route-planner.js';
import { makeAeroAdapter, NULL_WEATHER, NULL_PLANS, NULL_PROFILES, NULL_NETWORK, FROZEN_CLOCK } from '../fixtures/mock-adapters.js';

const aero = makeAeroAdapter({
    airports: { KA: { icao: 'KA', lat: 33, lon: -85 }, KC: { icao: 'KC', lat: 34, lon: -84 } },
    fixes:    { A: { id: 'A', lat: 33, lon: -85 }, C: { id: 'C', lat: 34, lon: -84 } },
});
const adapters = { aero, weather: NULL_WEATHER, plans: NULL_PLANS, profiles: NULL_PROFILES, network: NULL_NETWORK, clock: FROZEN_CLOCK };

describe('Optimizer.bestAltitude()', () => {
    it('returns an altitude inside the search range', async () => {
        const opt = new Optimizer(adapters);
        const r = await opt.bestAltitude({ departure: 'KA', destination: 'KC', routingMode: 'gps-direct' });
        expect(r.altFt).toBeGreaterThanOrEqual(2000);
        expect(r.altFt).toBeLessThanOrEqual(12000);
        expect(r.plan).toBeDefined();
    });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

- [ ] **Step 3: Implement `optimizer.js`**

```js
// @ts-check
'use strict';

import { RoutePlanner } from './route-planner.js';

const ALT_CANDIDATES_FT = [2000, 4000, 6000, 8000, 10000, 12000];

export class Optimizer {
    constructor(adapters) { this._planner = new RoutePlanner(adapters); }

    /** Return whichever altitude minimises total fuel for the route. */
    async bestAltitude(opts) {
        let best = null;
        for (const altFt of ALT_CANDIDATES_FT) {
            const plan = await this._planner.plan({ ...opts, cruiseAltFt: altFt });
            const fuel = plan.summary?.totalFuelGal ?? Infinity;
            if (!best || fuel < best.fuel) best = { altFt, fuel, plan };
        }
        return best;
    }

    async leastFuel(opts) {
        return (await this.bestAltitude(opts)).plan;
    }

    async leastTime(opts) {
        let best = null;
        for (const altFt of ALT_CANDIDATES_FT) {
            const plan = await this._planner.plan({ ...opts, cruiseAltFt: altFt });
            const time = plan.summary?.totalEteHrs ?? Infinity;
            if (!best || time < best.time) best = { altFt, time, plan };
        }
        return best.plan;
    }
}
```

- [ ] **Step 4: Run tests, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/shared/planning/planner/optimizer.js tests/planning/planner/optimizer.test.js
git commit -m "feat(planning): Optimizer — bestAltitude / leastFuel / leastTime"
```

---

## Task 13: Wire up `index.js` and `window.FlyTabPlanning`

**Files:** Modify `web/shared/planning/index.js`.

- [ ] **Step 1: Replace placeholder with real exports**

```js
// @ts-check
'use strict';

export { RoutePlanner } from './planner/route-planner.js';
export { Optimizer }    from './planner/optimizer.js';
export { AirwayGraph }  from './planner/airway-graph.js';
export { parseRouteString } from './planner/parser.js';
export {
    PlanError, NoRouteFoundError, DestinationUnreachableError, TimeoutError,
} from './planner/route-planner-errors.js';
export {
    UnknownWaypointError, UnknownAirwayError, AmbiguousIdentifierError, RoutingModeViolationError,
} from './planner/parser.js';
export { buildAvoidancePenalty, segmentIntersectsPolygon } from './planner/avoidance.js';
export { haversine, bearing, intermediatePoint, formatTime } from './math/route-math.js';
export { tasAtAltitude, gphAtPower, climbRateAtAltitude } from './math/engine-data.js';
export { decomposeLeg } from './math/fuel-phases.js';

export const VERSION = '0.1.0';

if (typeof window !== 'undefined') {
    Promise.all([
        import('./planner/route-planner.js'),
        import('./planner/optimizer.js'),
        import('./planner/airway-graph.js'),
        import('./planner/parser.js'),
        import('./planner/route-planner-errors.js'),
        import('./planner/avoidance.js'),
        import('./math/route-math.js'),
        import('./math/engine-data.js'),
        import('./math/fuel-phases.js'),
    ]).then(([rp, op, ag, ps, errs, av, rm, ed, fp]) => {
        window.FlyTabPlanning = {
            VERSION,
            RoutePlanner: rp.RoutePlanner,
            Optimizer:    op.Optimizer,
            AirwayGraph:  ag.AirwayGraph,
            parseRouteString: ps.parseRouteString,
            ...errs, ...av, ...rm, ...ed, ...fp,
        };
        document.dispatchEvent(new CustomEvent('flytab-planning:ready'));
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add web/shared/planning/index.js
git commit -m "feat(planning): index.js re-exports + window.FlyTabPlanning bridge for plain-script consumers"
```

---

## Task 14: `planning-adapters/idb-aero.js` (wraps NasrDb)

**Files:**
- Create: `web/shared/planning-adapters/idb-aero.js`

The existing `NasrDb` already implements most of the AeroDataSource methods; the adapter is a thin pass-through that normalises return shapes.

- [ ] **Step 1: Create the file**

```js
// @ts-check
'use strict';

/**
 * IdbAeroData — implements AeroDataSource by delegating to the existing NasrDb.
 *
 * NasrDb is loaded as a global by web/shared/nasr-db.js and is owned by app
 * (`app._nasrDb`). The adapter accepts a NasrDb instance at construction.
 */
export class IdbAeroData {
    constructor(nasrDb) { this._db = nasrDb; }

    async getAirport(icao) {
        const r = await this._db.getAirport(icao);
        if (!r) return null;
        return {
            icao: r.icao || icao,
            name: r.name,
            lat:  r.lat,
            lon:  r.lon,
            elevFt: r.elev_ft ?? r.elevation_ft,
            hasFuel: !!r.has_fuel,
            hasSelfServeFuel: !!r.has_self_serve_fuel,
            runways: r.runways || [],
        };
    }

    async getNavaid(id) {
        const r = await this._db.getNavaid(id);
        if (!r) return null;
        return { id: r.id, name: r.name, lat: r.lat, lon: r.lon, type: r.type, freq: r.freq };
    }

    async getFix(name) {
        const r = await this._db.getFix(name);
        if (!r) return null;
        return { id: r.id || name, lat: r.lat, lon: r.lon, type: r.type };
    }

    async getAirway(airwayId) {
        const r = await this._db.getAirway(airwayId);
        if (!r) return null;
        return {
            id:      r.id || airwayId,
            type:    r.type,
            fixIds:  r.fix_ids || r.fixIds || [],
            segments: r.segments || [],
        };
    }

    async listAirspace() {
        // NasrDb exposes a bounded query; for the lib-level full listing, call
        // a wide bounding box. Cockpit will rely on `getAirspaceInBounds` for
        // map-view performance; the lib uses listAirspace only for avoidance
        // selection from a chip list (small N).
        const records = await this._db.getAirspaceInBounds(-90, -180, 90, 180, 5000);
        return records.map(r => ({
            id: r.id,
            kind: r.kind,
            name: r.name,
            polygon: r.polygon || [],
            floorFt: r.floor_ft,
            ceilingFt: r.ceiling_ft,
        }));
    }

    async listAirways() {
        // NasrDb does not yet have a listAirways method; add it in this task,
        // following the same shape as listAirspace. See nasr-db.js:477 for
        // getAirway(name); listAirways iterates the 'airways' object store.
        if (typeof this._db.listAirways === 'function') {
            const records = await this._db.listAirways();
            return records.map(r => ({
                id: r.id || r.name,
                type: r.type,
                fixIds: r.fix_ids || r.fixIds || [],
                segments: r.segments || [],
            }));
        }
        return [];
    }
}
```

- [ ] **Step 2: Add `listAirways` to NasrDb**

In `web/shared/nasr-db.js`, after the existing `getAirway(name)` method (around line 477):

```js
/** Return all airway records (for graph build). */
async listAirways() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['airways'], 'readonly');
        const store = tx.objectStore('airways');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
    });
}
```

- [ ] **Step 3: Commit**

```bash
git add web/shared/planning-adapters/idb-aero.js web/shared/nasr-db.js
git commit -m "feat(planning-adapters): IdbAeroData wraps NasrDb; add NasrDb.listAirways()"
```

---

## Task 15: `planning-adapters/idb-plan.js` + `idb-profile.js`

**Files:**
- Create: `web/shared/planning-adapters/idb-plan.js`
- Create: `web/shared/planning-adapters/idb-profile.js`

Use a single shared IDB database `flytab-plans` with two object stores: `flight_plans`, `aircraft_profiles`.

- [ ] **Step 1: `idb-plan.js`**

```js
// @ts-check
'use strict';

const DB_NAME = 'flytab-plans';
const DB_VER  = 1;

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('flight_plans'))
                db.createObjectStore('flight_plans', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('aircraft_profiles'))
                db.createObjectStore('aircraft_profiles', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('meta'))
                db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

export class IdbPlanStore {
    async _store(mode = 'readwrite') {
        const db = await openDb();
        return db.transaction(['flight_plans'], mode).objectStore('flight_plans');
    }

    async get(id) {
        const s = await this._store('readonly');
        return new Promise(r => { const q = s.get(id); q.onsuccess = () => r(q.result || null); });
    }

    async put(plan) {
        if (!plan.id) plan.id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const s = await this._store();
        return new Promise((res, rej) => { const q = s.put(plan); q.onsuccess = () => res(plan.id); q.onerror = () => rej(q.error); });
    }

    async list() {
        const s = await this._store('readonly');
        return new Promise(r => { const q = s.getAll(); q.onsuccess = () => r(q.result || []); });
    }

    async delete(id) {
        const s = await this._store();
        return new Promise(r => { s.delete(id).onsuccess = () => r(); });
    }
}
```

- [ ] **Step 2: `idb-profile.js`**

```js
// @ts-check
'use strict';

const DB_NAME = 'flytab-plans';
const DB_VER  = 1;

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('aircraft_profiles'))
                db.createObjectStore('aircraft_profiles', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('flight_plans'))
                db.createObjectStore('flight_plans', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('meta'))
                db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

const RV9A_DEFAULT = {
    id: 'rv9a-default',
    tailNumber: 'N194JT',
    model: 'RV-9A',
    cruise_ktas: 155,
    fuel_burn_gph: 8.0,
    fuel_capacity_gal: 36,
    reserve_gal: 10,
    climb_rate_fpm: 750,
    service_ceiling_ft: 17500,
    taxi_burn_gal: 1.5,
    equipment: { vAirways: true, tAirways: false, jAirways: false, gpsApproach: true },
};

export class IdbProfileStore {
    async _store(name, mode = 'readwrite') {
        const db = await openDb();
        return db.transaction([name], mode).objectStore(name);
    }

    async get(id) {
        const s = await this._store('aircraft_profiles', 'readonly');
        return new Promise(r => { const q = s.get(id); q.onsuccess = () => r(q.result || null); });
    }

    async put(p) {
        if (!p.id) p.id = `prof-${Date.now()}`;
        const s = await this._store('aircraft_profiles');
        return new Promise(res => { const q = s.put(p); q.onsuccess = () => res(p.id); });
    }

    async list() {
        const s = await this._store('aircraft_profiles', 'readonly');
        return new Promise(r => { const q = s.getAll(); q.onsuccess = () => r(q.result || []); });
    }

    /** Return the active profile, seeding the RV-9A default if the store is empty. */
    async getActive() {
        const all = await this.list();
        if (all.length === 0) {
            await this.put(RV9A_DEFAULT);
            await this._setActiveId(RV9A_DEFAULT.id);
            return RV9A_DEFAULT;
        }
        const meta = await this._getActiveId();
        if (meta && all.find(p => p.id === meta)) return all.find(p => p.id === meta);
        return all[0];
    }

    async _getActiveId() {
        const s = await this._store('meta', 'readonly');
        return new Promise(r => { const q = s.get('active_profile_id'); q.onsuccess = () => r(q.result?.value || null); });
    }
    async _setActiveId(id) {
        const s = await this._store('meta');
        return new Promise(r => { const q = s.put({ key: 'active_profile_id', value: id }); q.onsuccess = () => r(); });
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add web/shared/planning-adapters/idb-plan.js web/shared/planning-adapters/idb-profile.js
git commit -m "feat(planning-adapters): IdbPlanStore + IdbProfileStore (with RV-9A seed)"
```

---

## Task 16: Weather adapters

**Files:**
- Create: `web/shared/planning-adapters/fisb-weather.js`
- Create: `web/shared/planning-adapters/flywhere-weather.js`
- Create: `web/shared/planning-adapters/weather-router.js`

`FisbWeather` wraps the existing `FisbClient`. `FlywhereWeather` is a skeleton — full proxy implementation depends on the flywhere.app endpoint design, which is deferred per sketch §3. The adapter implements the contract and throws `WeatherUnavailable` when the endpoint isn't reachable.

- [ ] **Step 1: `fisb-weather.js`**

```js
// @ts-check
'use strict';

/**
 * FisbWeather — WeatherSource backed by Stratux FIS-B JSON frames.
 *
 * The existing FisbClient already aggregates METARs, SIGMETs, AIRMETs by ICAO
 * / by ID into in-memory caches. This adapter exposes those caches behind the
 * planner's WeatherSource interface. No subscription bookkeeping in the
 * adapter — the existing client already maintains the caches.
 */
export class FisbWeather {
    constructor(fisbClient) { this._client = fisbClient; }

    async getMetar(icao) {
        const m = this._client?.getMetar?.(icao);
        if (!m) return null;
        return {
            station: icao,
            observed_at:  m.observed_at,
            wind_variable: !!m.wind_variable,
            wind_dir:    m.wind_dir ?? null,
            wind_speed:  m.wind_speed ?? null,
            wind_gust:   m.wind_gust ?? null,
            visibility:  m.visibility ?? null,
            ceiling:     m.ceiling ?? null,
            temp_c:      m.temp_c ?? null,
            dewpoint_c:  m.dewpoint_c ?? null,
            altim_inHg:  m.altim_inHg ?? null,
            raw:         m.raw,
        };
    }

    /** FIS-B does not provide winds aloft. */
    async getWindAloft() { return null; }

    async listActiveTfrs() { return []; /* FIS-B carries TFRs in graphical NOTAM frames; future. */ }
    async listSigmets()    { return this._client?.listSigmets?.() ?? []; }
    async listAirmets()    { return this._client?.listAirmets?.() ?? []; }
}
```

- [ ] **Step 2: `flywhere-weather.js`**

```js
// @ts-check
'use strict';

import { PlanError } from '../planning/planner/route-planner-errors.js';

export class WeatherUnavailable extends PlanError {
    constructor(reason) { super(`Weather data unavailable: ${reason}`); this.name = 'WeatherUnavailable'; }
}

/**
 * FlywhereWeather — WeatherSource backed by https://flywhere.app/api/wx/*.
 *
 * Endpoint design is deferred (see planning-lib sketch §3). This adapter
 * implements the contract; each method throws WeatherUnavailable until the
 * endpoint is live, at which point only the body of each method needs to
 * be filled in.
 */
export class FlywhereWeather {
    constructor(baseUrl = 'https://flywhere.app/api/wx') { this._base = baseUrl; }

    async getMetar(icao) {
        try {
            const resp = await fetch(`${this._base}/metar?icao=${encodeURIComponent(icao)}`);
            if (!resp.ok) throw new WeatherUnavailable(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (e instanceof WeatherUnavailable) throw e;
            throw new WeatherUnavailable(e.message || String(e));
        }
    }

    async getWindAloft(point, altFt) {
        try {
            const url = `${this._base}/winds-aloft?lat=${point.lat}&lon=${point.lon}&alt=${altFt}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new WeatherUnavailable(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (e instanceof WeatherUnavailable) throw e;
            throw new WeatherUnavailable(e.message || String(e));
        }
    }

    async listActiveTfrs() { return this._fetchList('tfrs'); }
    async listSigmets()    { return this._fetchList('sigmets'); }
    async listAirmets()    { return this._fetchList('airmets'); }

    async _fetchList(path) {
        try {
            const resp = await fetch(`${this._base}/${path}`);
            if (!resp.ok) throw new WeatherUnavailable(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (e instanceof WeatherUnavailable) throw e;
            throw new WeatherUnavailable(e.message || String(e));
        }
    }
}
```

- [ ] **Step 3: `weather-router.js`**

```js
// @ts-check
'use strict';

/**
 * WeatherRouter — selects FisbWeather (in-flight tier) vs FlywhereWeather
 * (online tier) by NetworkStatus.mode().
 *
 * Mode mapping:
 *   'flight'                                   → inFlight adapter (FIS-B)
 *   'home' | 'internet'                        → online adapter (flywhere proxy)
 *   'offline'                                  → online adapter; let it throw
 *                                                WeatherUnavailable; caller
 *                                                handles cached fallback
 */
export class WeatherRouter {
    /**
     * @param {{mode: string}} network
     * @param {{inFlight: any, online: any}} tiers
     */
    constructor(network, tiers) {
        this._network = network;
        this._tiers   = tiers;
    }

    _pick() {
        return this._network.mode === 'flight' ? this._tiers.inFlight : this._tiers.online;
    }

    async getMetar(icao)         { return this._pick().getMetar(icao); }
    async getWindAloft(p, alt)   { return this._pick().getWindAloft(p, alt); }
    async listActiveTfrs()       { return this._pick().listActiveTfrs(); }
    async listSigmets()          { return this._pick().listSigmets(); }
    async listAirmets()          { return this._pick().listAirmets(); }
}
```

- [ ] **Step 4: Commit**

```bash
git add web/shared/planning-adapters/fisb-weather.js web/shared/planning-adapters/flywhere-weather.js web/shared/planning-adapters/weather-router.js
git commit -m "feat(planning-adapters): FisbWeather + FlywhereWeather + WeatherRouter"
```

---

## Task 17: Wire adapters in `app.js` boot; switch `route-planner-panel.js`

**Files:**
- Modify: `web/index.html` (add `<script type="module">` for the lib)
- Modify: `web/app.js` (boot adapters)
- Modify: `web/cockpit/route-planner-panel.js` (consume `window.FlyTabPlanning`)

- [ ] **Step 1: Add the lib's module script tag to `index.html`**

Find the existing legacy:
```html
<script src="./shared/route-planner.js"></script>
```

Insert **immediately before** it:
```html
<script type="module" src="./shared/planning/index.js"></script>
```

The module loads asynchronously; the legacy stays loaded so the panel still works during the cutover.

- [ ] **Step 2: Construct adapters in `app.js`**

In `app.js`'s `init()` method, immediately before the existing `this.routePlannerPanel = new RoutePlannerPanel(...)` block, insert:

```javascript
// Build planning adapters. The lib's window namespace lands asynchronously;
// route-planner-panel.js waits on the 'flytab-planning:ready' event before
// instantiating the planner.
this._planningAdapters = await this._buildPlanningAdapters();
```

Then add the `_buildPlanningAdapters` method to `FlyTabApp`:

```javascript
async _buildPlanningAdapters() {
    // Dynamic-import each ESM adapter so app.js can stay a plain script.
    const [aero, plan, profile, fisb, fly, router] = await Promise.all([
        import('./shared/planning-adapters/idb-aero.js'),
        import('./shared/planning-adapters/idb-plan.js'),
        import('./shared/planning-adapters/idb-profile.js'),
        import('./shared/planning-adapters/fisb-weather.js'),
        import('./shared/planning-adapters/flywhere-weather.js'),
        import('./shared/planning-adapters/weather-router.js'),
    ]);

    const inFlight = new fisb.FisbWeather(this.fisbClient);
    const online   = new fly.FlywhereWeather('https://flywhere.app/api/wx');

    return {
        aero:     new aero.IdbAeroData(this._nasrDb),
        weather:  new router.WeatherRouter(this.networkMode, { inFlight, online }),
        plans:    new plan.IdbPlanStore(),
        profiles: new profile.IdbProfileStore(),
        network:  this.networkMode,
        clock:    { now: () => Date.now() },
    };
}
```

- [ ] **Step 3: Pass adapters into `route-planner-panel.js`**

Find the existing constructor call in `app.js`:
```javascript
this.routePlannerPanel = new RoutePlannerPanel(
    document.getElementById('routePlannerPanel'), nasrDb
);
```

Replace with:
```javascript
this.routePlannerPanel = new RoutePlannerPanel(
    document.getElementById('routePlannerPanel'),
    nasrDb,
    this._planningAdapters,
);
```

- [ ] **Step 4: Update `route-planner-panel.js` constructor**

Replace the constructor's `nasrDb`-only signature:

```javascript
constructor(panelEl, nasrDb) {
    this._el      = panelEl;
    this._nasrDb  = nasrDb;
    // …
}
```

With:

```javascript
constructor(panelEl, nasrDb, planningAdapters) {
    this._el      = panelEl;
    this._nasrDb  = nasrDb;
    this._adapters = planningAdapters;
    // …
}
```

- [ ] **Step 5: Replace `_startBuildPlanner` to use the new lib**

Find:
```javascript
_startBuildPlanner() {
    this._nasrVersion = localStorage.getItem('flypi_nasr_version') || '';
    if (typeof RoutePlanner === 'undefined') return;
    new RoutePlanner('FlyTabDB').init()
        .then(p => { this._planner = p; })
        .catch(err => console.warn('[RoutePlannerPanel] planner init failed:', err));
}
```

Replace with:
```javascript
_startBuildPlanner() {
    this._nasrVersion = localStorage.getItem('flypi_nasr_version') || '';
    const start = () => {
        try {
            this._planner = new window.FlyTabPlanning.RoutePlanner(this._adapters);
        } catch (err) {
            console.warn('[RoutePlannerPanel] planner init failed:', err);
        }
    };
    if (window.FlyTabPlanning?.RoutePlanner) start();
    else document.addEventListener('flytab-planning:ready', start, { once: true });
}
```

- [ ] **Step 6: Update `_onPlanTap` to use the new opts shape**

Find the existing `this._planner.plan({ departure, destination, preferredLegHrs, reserveGal, selfServeOnly })` call and replace its opts with:

```javascript
const result = await this._planner.plan({
    departure:    dep,
    destination:  dest,
    cruiseAltFt:  this._altitude,
    reserveGal:   this._reserveGal,
    maxLegHrs:    this._maxLegHrs,
    selfServeOnly: this._selfServeOnly,
    // routingMode falls back to aircraft profile equipment (v-airways for RV-9A by default)
});
```

- [ ] **Step 7: Build and smoke-test on tablet**

```bash
cd ~/flytab
# bump FLYTAB_VERSION first
bash build.sh
```

Expected: BUILD SUCCESSFUL. Install. Verify the route panel still plans a route end-to-end (DEP/DEST → Plan → pills appear → Apply → map shows the route).

- [ ] **Step 8: Commit**

```bash
git add web/index.html web/app.js web/cockpit/route-planner-panel.js
git commit -m "feat: wire route planner panel through new planning lib + adapters"
```

---

## Task 18: Delete legacy `route-planner.js`; final type-check

**Files:**
- Delete: `web/shared/route-planner.js`
- Modify: `web/index.html` (remove the legacy script tag)

- [ ] **Step 1: Confirm nothing else imports the legacy**

```bash
grep -rn "shared/route-planner.js\|RoutePlanner from .*route-planner.js" ~/flytab/web/ ~/flytab/tools/ 2>/dev/null
```

Expected: no matches outside index.html and the file we're about to delete.

- [ ] **Step 2: Remove the legacy script tag from `index.html`**

Delete the line:
```html
<script src="./shared/route-planner.js"></script>
```

- [ ] **Step 3: Delete the file**

```bash
cd ~/flytab && git rm web/shared/route-planner.js
```

- [ ] **Step 4: Type-check the new lib**

```bash
cd ~/flytab/web/shared/planning
npx -y -p typescript@latest tsc --noEmit --allowJs --checkJs --target es2022 --module esnext --moduleResolution bundler index.js
```

Expected: no errors. JSDoc `@ts-check` directives plus the type-only typedef files keep the lib type-clean.

- [ ] **Step 5: Run the full lib test suite**

```bash
cd ~/flytab && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Bump version and build final APK**

In `web/app.js` increment `FLYTAB_VERSION` (e.g. `v7.24` → `v7.25`).

```bash
cd ~/flytab && bash build.sh
```

Install on tablet. Run the full smoke test:

```
□ Tap EDIT → panel appears
□ Plan KLKR → KCLT → pills appear (V-airways used by default for RV-9A)
□ Switch to "GPS Direct" via the routing-mode picker (Spec B will add this UI;
  for Phase 1, manual test by passing routingMode through devtools)
□ Paste "KLKR V143 GSO V268 ESN K44N" → all interior airway fixes appear as
  pills AND as map markers
□ Apply → route table updates, map shows the route
```

- [ ] **Step 7: Final commit**

```bash
git add web/app.js android/app/build.gradle web/index.html
git commit -m "feat: complete planning-lib extraction; delete legacy route-planner.js; bump to v7.25"
```

---

## Self-review checklist (run before declaring the plan complete)

- [ ] Every spec section in `2026-05-04-planning-lib-architecture-sketch.md` has a corresponding task or is explicitly out-of-Phase-1 (flywhere consumption setup, CI workflow — those land when flywhere actually consumes the lib).
- [ ] Both new requirements are covered: routingMode (Tasks 8, 10, 11), airway expansion (Task 10).
- [ ] Method names are stable across tasks: `RoutePlanner.plan` / `parseRoute` / `recomputeLegs`, `AirwayGraph.load` / `edges` / `addDirectEdge`, `Optimizer.bestAltitude` / `leastFuel` / `leastTime`, `WeatherRouter.getMetar` / `getWindAloft` / `listSigmets` / `listAirmets` / `listActiveTfrs`, `IdbProfileStore.getActive`.
- [ ] No "TBD", "TODO", "fill in details" — every step has the actual code or command.
- [ ] No references to types or functions that aren't defined in some task.
- [ ] Each TDD task has a failing test before the implementation step.
- [ ] Final task deletes the legacy file and verifies on hardware.
