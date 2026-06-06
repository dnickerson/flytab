# Terminal Area Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in Class B terminal area detection to the IFR route planner — a wizard that lets the pilot pick T-routes or avoidance corridors before A* runs, producing ATC-preferred route strings.

**Architecture:** New `TerminalAnalyzer` class in the planning library detects Class B intersections and builds routing options from static data + live airways IDB. A wizard overlay in `RoutePlannerPanel` collects pilot selections; those become mandatory via-pins fed to the existing `planVia()` API. The existing `plan()` path is unchanged — every failure/cancel path falls through to it.

**Tech Stack:** Vanilla JS ES modules, IndexedDB via `AeroDataSource` adapter, Vitest for tests, existing `planVia()` in `web/shared/planning/planner/route-planner.js`.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `web/shared/planning/planner/terminal-analyzer.js` | **Create** | Class B detection, option building, via-pin resolution |
| `tests/planning/planner/terminal-analyzer.test.js` | **Create** | Unit tests for `TerminalAnalyzer` |
| `web/shared/planning/index.js` | **Modify** | Export `TerminalAnalyzer` + add to `window.FlyTabPlanning` |
| `web/cockpit/route-planner-panel.js` | **Modify** | Setting toggle, wizard overlay, `_onPlanRouteTap()` pre-step |
| `web/style.css` | **Modify** | Wizard CSS classes |

---

## Task 1: `TerminalAnalyzer` — `analyzeRoute()` (TDD)

**Files:**
- Create: `tests/planning/planner/terminal-analyzer.test.js`
- Create: `web/shared/planning/planner/terminal-analyzer.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/planning/planner/terminal-analyzer.test.js`:

```javascript
// @ts-check
'use strict';

import { describe, it, expect } from 'vitest';
import { TerminalAnalyzer } from '../../../web/shared/planning/planner/terminal-analyzer.js';
import { makeAeroAdapter } from '../fixtures/mock-adapters.js';

// Real-world airports used in tests
const KLKR = { icao: 'KLKR', lat: 35.18, lon: -81.09 };  // Chester Metro, SC — south of CLT
const KMHT = { icao: 'KMHT', lat: 42.93, lon: -71.44 };  // Manchester, NH — north of all Class B
const KSAV = { icao: 'KSAV', lat: 32.13, lon: -81.20 };  // Savannah, GA — no Class B in KLKR→KSAV
const KCLT = { icao: 'KCLT', lat: 35.21, lon: -80.94 };  // Charlotte Douglas (Class B itself)

// Minimal T200 airway fixture threading through CLT's Class B
const T200 = {
    name: 'T200',
    type: 'T',
    waypoints: [
        { seq: 10, name: 'SHIPP', id: 'SHIPP', lat: 35.05, lon: -81.20 },
        { seq: 20, name: 'CLT',   id: 'CLT',   lat: 35.21, lon: -80.94 },
        { seq: 30, name: 'KILNS', id: 'KILNS', lat: 35.37, lon: -80.68 },
    ],
    segments: [
        { from_seq: 10, to_seq: 20, dist_nm: 16, mea_ft: 3000 },
        { from_seq: 20, to_seq: 30, dist_nm: 16, mea_ft: 3000 },
    ],
};

function makeAero(airports = {}, airways = {}) {
    return makeAeroAdapter({ airports, airways });
}

describe('TerminalAnalyzer.analyzeRoute', () => {
    it('returns hasTerminalAreas:false when route does not cross any Class B', async () => {
        // KLKR → KSAV tracks south-southwest — nowhere near a Class B
        const aero = makeAero({ KLKR, KSAV });
        const analyzer = new TerminalAnalyzer(aero);
        const result = await analyzer.analyzeRoute('KLKR', 'KSAV');
        expect(result.hasTerminalAreas).toBe(false);
        expect(result.terminalAreas).toHaveLength(0);
    });

    it('detects KCLT on a KLKR→KMHT route', async () => {
        const aero = makeAero({ KLKR, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const result = await analyzer.analyzeRoute('KLKR', 'KMHT');
        expect(result.hasTerminalAreas).toBe(true);
        const clt = result.terminalAreas.find(ta => ta.icao === 'KCLT');
        expect(clt).toBeDefined();
    });

    it('builds T_ROUTE, AVOIDANCE, and ATC_DIRECT options for KCLT', async () => {
        const aero = makeAero({ KLKR, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const { terminalAreas } = await analyzer.analyzeRoute('KLKR', 'KMHT');
        const clt = terminalAreas.find(ta => ta.icao === 'KCLT');
        expect(clt.options.some(o => o.type === 'T_ROUTE')).toBe(true);
        expect(clt.options.some(o => o.type === 'AVOIDANCE')).toBe(true);
        expect(clt.options.some(o => o.type === 'ATC_DIRECT')).toBe(true);
    });

    it('T_ROUTE options are sorted by detour; first has recommended:true', async () => {
        const aero = makeAero({ KLKR, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const { terminalAreas } = await analyzer.analyzeRoute('KLKR', 'KMHT');
        const clt = terminalAreas.find(ta => ta.icao === 'KCLT');
        const tRoutes = clt.options.filter(o => o.type === 'T_ROUTE');
        expect(tRoutes.length).toBeGreaterThan(0);
        expect(tRoutes[0].recommended).toBe(true);
        for (let i = 1; i < tRoutes.length; i++) {
            expect(tRoutes[i].recommended).toBe(false);
            expect(tRoutes[i].detourNm).toBeGreaterThanOrEqual(tRoutes[i - 1].detourNm);
        }
    });

    it('T_ROUTE waypoints array contains all fixes including interior', async () => {
        const aero = makeAero({ KLKR, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const { terminalAreas } = await analyzer.analyzeRoute('KLKR', 'KMHT');
        const clt = terminalAreas.find(ta => ta.icao === 'KCLT');
        const t200 = clt.options.find(o => o.id === 'T200');
        expect(t200).toBeDefined();
        const ids = t200.waypoints.map(w => w.id);
        expect(ids).toContain('SHIPP');
        expect(ids).toContain('CLT');
        expect(ids).toContain('KILNS');
    });

    it('does not flag KCLT when it is the departure airport', async () => {
        const aero = makeAero({ KCLT, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const result = await analyzer.analyzeRoute('KCLT', 'KMHT');
        expect(result.terminalAreas.find(ta => ta.icao === 'KCLT')).toBeUndefined();
    });

    it('does not flag KCLT when it is the destination airport', async () => {
        const aero = makeAero({ KLKR, KCLT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const result = await analyzer.analyzeRoute('KLKR', 'KCLT');
        expect(result.terminalAreas.find(ta => ta.icao === 'KCLT')).toBeUndefined();
    });

    it('throws when departure airport is not found in IDB', async () => {
        const aero = makeAero({ KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        await expect(analyzer.analyzeRoute('KLKR', 'KMHT'))
            .rejects.toThrow('KLKR not found');
    });

    it('throws when destination airport is not found in IDB', async () => {
        const aero = makeAero({ KLKR });
        const analyzer = new TerminalAnalyzer(aero);
        await expect(analyzer.analyzeRoute('KLKR', 'KMHT'))
            .rejects.toThrow('KMHT not found');
    });

    it('ATC_DIRECT is always the last option', async () => {
        const aero = makeAero({ KLKR, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const { terminalAreas } = await analyzer.analyzeRoute('KLKR', 'KMHT');
        const clt = terminalAreas.find(ta => ta.icao === 'KCLT');
        expect(clt.options[clt.options.length - 1].type).toBe('ATC_DIRECT');
    });
});
```

- [ ] **Step 2: Run tests — verify they fail with "module not found"**

```bash
npm test -- tests/planning/planner/terminal-analyzer.test.js
```

Expected: FAIL — `Cannot find module '../../../web/shared/planning/planner/terminal-analyzer.js'`

- [ ] **Step 3: Implement `terminal-analyzer.js`**

Create `web/shared/planning/planner/terminal-analyzer.js`:

```javascript
// @ts-check
'use strict';

import { haversine, bearing, intermediatePoint } from '../math/route-math.js';

// ---------------------------------------------------------------------------
// Static Class B data — Eastern US corridor
// ---------------------------------------------------------------------------

const CLASS_B_AIRPORTS = [
    { icao: 'KATL', name: 'Atlanta',              lat: 33.6407, lon: -84.4277, radiusNm: 40 },
    { icao: 'KCLT', name: 'Charlotte/Douglas',    lat: 35.2140, lon: -80.9431, radiusNm: 40 },
    { icao: 'KRDU', name: 'Raleigh-Durham',       lat: 35.8777, lon: -78.7875, radiusNm: 30 },
    { icao: 'KDCA', name: 'Reagan National',      lat: 38.8521, lon: -77.0377, radiusNm: 30 },
    { icao: 'KIAD', name: 'Dulles',               lat: 38.9445, lon: -77.4558, radiusNm: 35 },
    { icao: 'KBWI', name: 'Baltimore/Washington', lat: 39.1754, lon: -76.6683, radiusNm: 30 },
    { icao: 'KPHL', name: 'Philadelphia',         lat: 39.8719, lon: -75.2411, radiusNm: 35 },
    { icao: 'KEWR', name: 'Newark',               lat: 40.6895, lon: -74.1745, radiusNm: 30 },
    { icao: 'KJFK', name: 'JFK',                  lat: 40.6413, lon: -73.7781, radiusNm: 30 },
    { icao: 'KLGA', name: 'LaGuardia',            lat: 40.7773, lon: -73.8726, radiusNm: 22 },
    { icao: 'KBOS', name: 'Boston',               lat: 42.3656, lon: -71.0096, radiusNm: 30 },
];

const CLASS_B_T_ROUTES = {
    KATL: ['T228', 'T229'],
    KCLT: ['T200', 'T201', 'T202', 'T203'],
    KRDU: ['T289'],
    KDCA: [], KIAD: [], KBWI: [], KPHL: [],
    KEWR: [], KJFK: [], KLGA: [],
    KBOS: [],
};

const CLASS_B_AVOIDANCE = {
    KCLT: { label: 'East of Charlotte — LOCAS direct GSO',
            description: 'RNAV transition via LOCAS, avoids core Class B',
            fixes: ['LOCAS', 'GSO'] },
    KRDU: { label: 'South of Raleigh-Durham — direct RIC',
            description: 'Route south of the Class B via V225 or direct',
            fixes: ['RIC'] },
    KDCA: { label: 'East of DC SFRA — via ESN',
            description: 'Easton VOR (ESN), 39nm east of P-40. Standard GA routing.',
            fixes: ['RIC', 'ESN'] },
    KJFK: { label: 'Eastern Shore corridor — ESN to SBJ',
            description: 'Stay east of NYC Class B via Easton → Solberg',
            fixes: ['ESN', 'SBJ', 'PUT'] },
    KEWR: { label: 'Eastern Shore corridor — ESN to SBJ',
            description: 'Stay east of Newark Class B via Easton → Solberg',
            fixes: ['ESN', 'SBJ', 'PUT'] },
    KLGA: { label: 'Eastern Shore corridor — ESN to SBJ',
            description: 'Stay east of LaGuardia Class B via Easton → Solberg',
            fixes: ['ESN', 'SBJ', 'PUT'] },
    KPHL: { label: 'Route via SBJ south of Philadelphia',
            description: 'Solberg VOR keeps you south and east of PHL Class B',
            fixes: ['SBJ'] },
    KBWI: { label: 'Route via ESN east of Baltimore',
            description: 'Easton VOR routes you east of BWI Class B',
            fixes: ['ESN'] },
    KBOS: { label: 'Route via ORW south of Boston',
            description: 'Norwich VOR routes you south of BOS Class B',
            fixes: ['ORW', 'MHT'] },
};

// ---------------------------------------------------------------------------
// Geometry helpers (not in route-math — private to this module)
// ---------------------------------------------------------------------------

function gcIntersectsCircle(lat1, lon1, lat2, lon2, cLat, cLon, radiusNm) {
    for (let f = 0; f <= 1; f += 0.04) {
        const p = intermediatePoint(lat1, lon1, lat2, lon2, f);
        if (haversine(p.lat, p.lon, cLat, cLon) < radiusNm) return true;
    }
    return false;
}

function nearestFraction(lat1, lon1, lat2, lon2, fixLat, fixLon) {
    let best = 0, bestDist = Infinity;
    for (let f = 0; f <= 1; f += 0.01) {
        const p = intermediatePoint(lat1, lon1, lat2, lon2, f);
        const d = haversine(p.lat, p.lon, fixLat, fixLon);
        if (d < bestDist) { bestDist = d; best = f; }
    }
    return best;
}

function tRouteNearTerminal(waypoints, cLat, cLon, radiusNm) {
    return waypoints?.some(w => haversine(w.lat, w.lon, cLat, cLon) < radiusNm) ?? false;
}

// ---------------------------------------------------------------------------
// TerminalAnalyzer
// ---------------------------------------------------------------------------

export class TerminalAnalyzer {
    /**
     * @param {import('../adapters/aero-data-source.js').AeroDataSource} aero
     */
    constructor(aero) {
        this._aero = aero;
        /** @type {object[]|null} */
        this._airways = null;
        /** @type {Map<string,{lat:number,lon:number}>} */
        this._fixCoords = new Map();
    }

    async _ensureAirwaysLoaded() {
        if (this._airways !== null) return;
        const airways = await this._aero.listAirways();
        this._airways = airways;
        for (const awy of airways) {
            for (const w of (awy.waypoints ?? [])) {
                const id = w.name || w.id;
                if (id && w.lat != null && !this._fixCoords.has(id)) {
                    this._fixCoords.set(id, { lat: w.lat, lon: w.lon });
                }
            }
        }
    }

    /**
     * Detect Class B airspace intersections along the dep→dest great-circle.
     * @param {string} depId
     * @param {string} destId
     * @returns {Promise<{terminalAreas: object[], hasTerminalAreas: boolean}>}
     */
    async analyzeRoute(depId, destId) {
        const [dep, dest] = await Promise.all([
            this._aero.getAirport(depId),
            this._aero.getAirport(destId),
        ]);
        if (!dep)  throw new Error(`Departure ${depId} not found`);
        if (!dest) throw new Error(`Destination ${destId} not found`);

        await this._ensureAirwaysLoaded();

        const terminalAreas = [];

        for (const cb of CLASS_B_AIRPORTS) {
            if (cb.icao === depId || cb.icao === destId) continue;

            const frac = nearestFraction(dep.lat, dep.lon, dest.lat, dest.lon, cb.lat, cb.lon);
            if (frac < 0.05 || frac > 0.95) continue;

            if (!gcIntersectsCircle(dep.lat, dep.lon, dest.lat, dest.lon, cb.lat, cb.lon, cb.radiusNm)) continue;

            const gcPt = intermediatePoint(dep.lat, dep.lon, dest.lat, dest.lon, frac);
            const distFromTrack = Math.round(haversine(gcPt.lat, gcPt.lon, cb.lat, cb.lon) * 10) / 10;

            const options = this._buildOptions(cb, dep.lat, dep.lon, dest.lat, dest.lon);

            terminalAreas.push({
                icao:          cb.icao,
                name:          cb.name,
                lat:           cb.lat,
                lon:           cb.lon,
                radiusNm:      cb.radiusNm,
                distFromTrack,
                routeFraction: Math.round(frac * 100) / 100,
                options,
            });
        }

        terminalAreas.sort((a, b) => a.routeFraction - b.routeFraction);
        return { terminalAreas, hasTerminalAreas: terminalAreas.length > 0 };
    }

    _buildOptions(cb, depLat, depLon, destLat, destLon) {
        const options = [];
        const directDist = haversine(depLat, depLon, destLat, destLon);
        const airways = this._airways ?? [];

        // T-routes from static list
        const tRouteNames = CLASS_B_T_ROUTES[cb.icao] ?? [];
        for (const routeName of tRouteNames) {
            const record = airways.find(a => a.name === routeName);
            if (!record?.waypoints?.length) continue;
            if (!tRouteNearTerminal(record.waypoints, cb.lat, cb.lon, cb.radiusNm)) continue;

            const wpts       = record.waypoints;
            const entryFix   = wpts[0];
            const exitFix    = wpts[wpts.length - 1];
            const mea        = record.segments?.[0]?.mea_ft ?? null;
            const routeDist  = record.segments?.reduce((s, sg) => s + (sg.dist_nm ?? 0), 0) ?? 0;
            const entryDist  = haversine(depLat, depLon, entryFix.lat, entryFix.lon);
            const exitDist   = haversine(exitFix.lat, exitFix.lon, destLat, destLon);
            const detourNm   = Math.max(0, Math.round((entryDist + routeDist + exitDist - directDist) * 10) / 10);

            options.push({
                type:        'T_ROUTE',
                id:          routeName,
                label:       `${routeName} — through ${cb.name} Class B`,
                description: `Enter ${entryFix.name ?? entryFix.id} · exit ${exitFix.name ?? exitFix.id}`
                           + (mea ? ` · MEA ${mea.toLocaleString()}ft` : '')
                           + (detourNm > 0 ? ` · +${detourNm}nm` : ' · on track'),
                waypoints:   wpts.map(w => ({ id: w.name || w.id, lat: w.lat, lon: w.lon })),
                meaFt:       mea,
                detourNm,
                recommended: false,
            });
        }

        // Sort T-routes by detour; mark shortest as recommended
        options.sort((a, b) => a.detourNm - b.detourNm);
        if (options.length > 0) options[0].recommended = true;

        // Avoidance corridor
        const avoid = CLASS_B_AVOIDANCE[cb.icao];
        if (avoid) {
            let total = 0;
            let prev  = { lat: depLat, lon: depLon };
            const resolvedFixes = [];
            for (const fixId of avoid.fixes) {
                const c = this._fixCoords.get(fixId);
                if (c) {
                    total += haversine(prev.lat, prev.lon, c.lat, c.lon);
                    prev = c;
                    resolvedFixes.push({ id: fixId, lat: c.lat, lon: c.lon });
                }
            }
            total += haversine(prev.lat, prev.lon, destLat, destLon);
            const detourNm = Math.max(0, Math.round((total - directDist) * 10) / 10);

            options.push({
                type:        'AVOIDANCE',
                id:          `AVOID_${cb.icao}`,
                label:       avoid.label,
                description: avoid.description + (detourNm > 0 ? ` · +${detourNm}nm` : ''),
                waypoints:   resolvedFixes,
                detourNm,
                recommended: false,
            });
        }

        // ATC direct — always last, never recommended
        options.push({
            type:        'ATC_DIRECT',
            id:          `DIRECT_${cb.icao}`,
            label:       'File direct — let ATC amend',
            description: 'ATC will likely issue a preferred route on the ground. Re-check fuel and time after amendment.',
            waypoints:   [],
            detourNm:    0,
            recommended: false,
        });

        return options;
    }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test -- tests/planning/planner/terminal-analyzer.test.js
```

Expected: All 9 tests PASS.

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
npm test
```

Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/shared/planning/planner/terminal-analyzer.js \
        tests/planning/planner/terminal-analyzer.test.js
git commit -m "feat(planning): add TerminalAnalyzer — Class B route detection

Detects eastern US Class B intersections on dep→dest great-circle;
returns T-route, avoidance corridor, and ATC-direct options per area.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: `TerminalAnalyzer` — `resolveViaPins()` (TDD)

**Files:**
- Modify: `tests/planning/planner/terminal-analyzer.test.js`
- Modify: `web/shared/planning/planner/terminal-analyzer.js`

- [ ] **Step 1: Add failing tests for `resolveViaPins()`**

Append to `tests/planning/planner/terminal-analyzer.test.js`:

```javascript
describe('TerminalAnalyzer.resolveViaPins', () => {
    it('returns null when all selections are ATC_DIRECT', async () => {
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KCLT', { type: 'ATC_DIRECT', waypoints: [] }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        expect(pins).toBeNull();
    });

    it('returns dep pin first and dest pin last', async () => {
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KCLT', {
                type: 'T_ROUTE',
                waypoints: [{ id: 'SHIPP', lat: 35.05, lon: -81.20 }],
            }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        expect(pins[0].id).toBe('KLKR');
        expect(pins[0].lat).toBeCloseTo(35.18, 2);
        expect(pins[pins.length - 1].id).toBe('KMHT');
    });

    it('includes all T-route waypoints in order between dep and dest', async () => {
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KCLT', {
                type: 'T_ROUTE',
                waypoints: [
                    { id: 'SHIPP', lat: 35.05, lon: -81.20 },
                    { id: 'CLT',   lat: 35.21, lon: -80.94 },
                    { id: 'KILNS', lat: 35.37, lon: -80.68 },
                ],
            }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        const ids = pins.map(p => p.id);
        expect(ids).toEqual(['KLKR', 'SHIPP', 'CLT', 'KILNS', 'KMHT']);
    });

    it('deduplicates adjacent identical pin IDs', async () => {
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KCLT', {
                type: 'AVOIDANCE',
                waypoints: [
                    { id: 'ESN', lat: 38.80, lon: -76.07 },
                    { id: 'ESN', lat: 38.80, lon: -76.07 },
                ],
            }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        const esnPins = pins.filter(p => p.id === 'ESN');
        expect(esnPins).toHaveLength(1);
    });

    it('skips ATC_DIRECT selection but uses T_ROUTE from another terminal area', async () => {
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KCLT', { type: 'T_ROUTE',   waypoints: [{ id: 'SHIPP', lat: 35.05, lon: -81.20 }] }],
            ['KBWI', { type: 'ATC_DIRECT', waypoints: [] }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        expect(pins).not.toBeNull();
        const ids = pins.map(p => p.id);
        expect(ids).toContain('SHIPP');
        expect(ids).not.toContain('KBWI');
    });

    it('sorts via-pins in dep→dest along-track order', async () => {
        // ESN (BWI avoidance, lat≈38.8) should come after SHIPP (CLT T-route, lat≈35.05)
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KBWI', { type: 'AVOIDANCE', waypoints: [{ id: 'ESN',   lat: 38.80, lon: -76.07 }] }],
            ['KCLT', { type: 'T_ROUTE',   waypoints: [{ id: 'SHIPP', lat: 35.05, lon: -81.20 }] }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        const ids = pins.map(p => p.id);
        expect(ids.indexOf('SHIPP')).toBeLessThan(ids.indexOf('ESN'));
    });
});
```

- [ ] **Step 2: Run tests — verify new tests fail**

```bash
npm test -- tests/planning/planner/terminal-analyzer.test.js
```

Expected: The 9 `analyzeRoute` tests still pass; the 6 new `resolveViaPins` tests fail with `analyzer.resolveViaPins is not a function`.

- [ ] **Step 3: Add `resolveViaPins()` to `terminal-analyzer.js`**

Add this method to the `TerminalAnalyzer` class, after `_buildOptions()`:

```javascript
    /**
     * Convert pilot selections into an ordered pin array for planVia().
     * Skips ATC_DIRECT selections. Returns null if all selections are ATC_DIRECT.
     *
     * @param {string} depId
     * @param {string} destId
     * @param {Map<string, {type:string, waypoints:Array<{id:string,lat:number,lon:number}>}>} selections
     * @returns {Promise<Array<{id:string,lat:number,lon:number}>|null>}
     */
    async resolveViaPins(depId, destId, selections) {
        const [dep, dest] = await Promise.all([
            this._aero.getAirport(depId),
            this._aero.getAirport(destId),
        ]);

        // Collect raw via-waypoints from non-ATC_DIRECT selections
        const rawPins = [];
        for (const [, option] of selections) {
            if (option.type === 'ATC_DIRECT') continue;
            for (const wp of (option.waypoints ?? [])) {
                rawPins.push(wp);
            }
        }

        if (rawPins.length === 0) return null;

        // Sort by along-track fraction so pins stay in dep→dest order
        // regardless of which terminal area they came from
        rawPins.sort((a, b) => {
            const fa = haversine(dep.lat, dep.lon, a.lat, a.lon);
            const fb = haversine(dep.lat, dep.lon, b.lat, b.lon);
            return fa - fb;
        });

        // Deduplicate adjacent identical fix IDs
        const deduped = [rawPins[0]];
        for (let i = 1; i < rawPins.length; i++) {
            if (rawPins[i].id !== deduped[deduped.length - 1].id) {
                deduped.push(rawPins[i]);
            }
        }

        return [
            { id: depId,  lat: dep.lat,  lon: dep.lon  },
            ...deduped,
            { id: destId, lat: dest.lat, lon: dest.lon },
        ];
    }
```

- [ ] **Step 4: Run all `TerminalAnalyzer` tests — verify all pass**

```bash
npm test -- tests/planning/planner/terminal-analyzer.test.js
```

Expected: All 15 tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/planning/planner/terminal-analyzer.test.js \
        web/shared/planning/planner/terminal-analyzer.js
git commit -m "feat(planning): add resolveViaPins() to TerminalAnalyzer

Converts pilot selections to an ordered pin array for planVia():
skips ATC_DIRECT, sorts by along-track distance, deduplicates adjacents.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Export `TerminalAnalyzer` from `index.js`

**Files:**
- Modify: `web/shared/planning/index.js`

- [ ] **Step 1: Add static export**

In `web/shared/planning/index.js`, add after the `export { RoutePlanner }` line (line 10):

```javascript
export { TerminalAnalyzer } from './planner/terminal-analyzer.js';
```

- [ ] **Step 2: Add to `window.FlyTabPlanning` block**

The `Promise.all([...])` block starting at line 28 imports each module. Add `terminal-analyzer.js` to the import list and to the resulting object.

Change the `Promise.all` call from:
```javascript
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
        import('./planner/winds-interpolator.js'),
    ]).then(([rp, op, ag, ps, errs, av, rm, ed, fp, wi]) => {
        // @ts-ignore - augment window
        window.FlyTabPlanning = {
            VERSION,
            RoutePlanner: rp.RoutePlanner,
            Optimizer:    op.Optimizer,
            AirwayGraph:  ag.AirwayGraph,
            parseRouteString: ps.parseRouteString,
            ...errs, ...av, ...rm, ...ed, ...fp, ...wi,
        };
        document.dispatchEvent(new CustomEvent('flytab-planning:ready'));
    });
```

To:
```javascript
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
        import('./planner/winds-interpolator.js'),
        import('./planner/terminal-analyzer.js'),
    ]).then(([rp, op, ag, ps, errs, av, rm, ed, fp, wi, ta]) => {
        // @ts-ignore - augment window
        window.FlyTabPlanning = {
            VERSION,
            RoutePlanner:     rp.RoutePlanner,
            Optimizer:        op.Optimizer,
            AirwayGraph:      ag.AirwayGraph,
            TerminalAnalyzer: ta.TerminalAnalyzer,
            parseRouteString: ps.parseRouteString,
            ...errs, ...av, ...rm, ...ed, ...fp, ...wi,
        };
        document.dispatchEvent(new CustomEvent('flytab-planning:ready'));
    });
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add web/shared/planning/index.js
git commit -m "feat(planning): export TerminalAnalyzer from planning lib index

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Panel — `_terminalRouting` setting

**Files:**
- Modify: `web/cockpit/route-planner-panel.js` (~lines 60–80 constructor, ~241–279 load/save, ~933–1160 settings popup)

- [ ] **Step 1: Add instance fields to constructor**

In `RoutePlannerPanel` constructor, after `this._modeSel = null;` (around line 60), add:

```javascript
        // Terminal area routing setting ('off' | 't-routes')
        this._terminalRouting = 'off';
        this._terminalSel     = null;
```

- [ ] **Step 2: Load `terminalRouting` from localStorage**

In `_loadOpts()`, after the `if (saved.routingMode != null)` line (around line 249), add:

```javascript
            if (saved.terminalRouting != null) this._terminalRouting = saved.terminalRouting;
```

- [ ] **Step 3: Save `terminalRouting` to localStorage**

In `_saveOpts()`, add `terminalRouting` to the JSON object (around line 274):

```javascript
                terminalRouting: this._terminalRouting,
```

- [ ] **Step 4: Add the "Terminal areas" row to the settings popup**

In `_buildSettingsPopup()`, after `body.appendChild(pairRow);` (the Routing/Reserve pair row, around line 1109), add:

```javascript
        this._terminalSel = mkSel([
            ['off',      'Off'],
            ['t-routes', 'T-routes'],
        ], this._terminalRouting);
        this._terminalSel.addEventListener('change', () => {
            this._terminalRouting = this._terminalSel.value;
            this._saveOpts();
        });
        body.appendChild(mkRow('Terminal areas', this._terminalSel));
```

- [ ] **Step 5: Sync `_terminalSel` value when popup opens**

In `_openSettingsPopup()`, after the line `if (this._modeSel) this._modeSel.value = this._routingMode;` (around line 1151), add:

```javascript
        if (this._terminalSel) this._terminalSel.value = this._terminalRouting;
```

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/route-planner-panel.js
git commit -m "feat(planner-panel): add Terminal areas opt-in setting

Persisted in flypi_planner_opts localStorage; defaults to 'off'.
Shows 'Off' | 'T-routes' select in Flight Settings popup.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Panel — `_terminalAnalyzer` instantiation

**Files:**
- Modify: `web/cockpit/route-planner-panel.js` (~lines 22–25 constructor, ~360–373 `_startBuildPlanner`)

- [ ] **Step 1: Add instance field to constructor**

In `RoutePlannerPanel` constructor, after `this._planner = null;` (around line 24), add:

```javascript
        this._terminalAnalyzer = null;
```

- [ ] **Step 2: Instantiate `_terminalAnalyzer` in `_startBuildPlanner()`**

The current `start()` function inside `_startBuildPlanner()` (lines 364–369) is:

```javascript
        const start = () => {
            try {
                this._planner = new window.FlyTabPlanning.RoutePlanner(this._adapters);
            } catch (err) {
                console.warn('[RoutePlannerPanel] planner init failed:', err);
            }
        };
```

Replace it with:

```javascript
        const start = () => {
            try {
                this._planner = new window.FlyTabPlanning.RoutePlanner(this._adapters);
                if (window.FlyTabPlanning.TerminalAnalyzer) {
                    this._terminalAnalyzer = new window.FlyTabPlanning.TerminalAnalyzer(
                        this._adapters.aero);
                }
            } catch (err) {
                console.warn('[RoutePlannerPanel] planner init failed:', err);
            }
        };
```

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/route-planner-panel.js
git commit -m "feat(planner-panel): instantiate TerminalAnalyzer alongside RoutePlanner

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Panel — `_showTerminalWizard()` + CSS

**Files:**
- Modify: `web/cockpit/route-planner-panel.js` (add new method after `_buildSettingsPopup`)
- Modify: `web/style.css` (append wizard CSS)

- [ ] **Step 1: Add `_showTerminalWizard()` method**

Add this method to `RoutePlannerPanel` after the `_buildSettingsPopup()` method (around line 1140):

```javascript
    /**
     * Show the terminal area routing wizard.
     * Returns a Map<icao, option> of pilot selections, or null if cancelled.
     * @param {object[]} terminalAreas
     * @returns {Promise<Map<string,object>|null>}
     */
    _showTerminalWizard(terminalAreas) {
        return new Promise((resolve) => {
            let pageIdx = 0;

            // Pre-select recommended option for each terminal area
            const selections = {};
            for (const ta of terminalAreas) {
                selections[ta.icao] = ta.options.find(o => o.recommended) || ta.options[0];
            }

            const overlay = document.createElement('div');
            overlay.className = 'rpp-wizard-overlay';

            const card = document.createElement('div');
            card.className = 'rpp-wizard-card';
            overlay.appendChild(card);

            const done = (result) => {
                overlay.remove();
                resolve(result);
            };

            const render = () => {
                card.innerHTML = '';
                const ta    = terminalAreas[pageIdx];
                const total = terminalAreas.length;
                const isLast = pageIdx === total - 1;

                // Header
                const hdr = document.createElement('div');
                hdr.className = 'rpp-wizard-hdr';
                const hdrTitle = document.createElement('div');
                hdrTitle.className = 'rpp-wizard-title';
                hdrTitle.textContent = `CLASS B: ${ta.name}`;
                const hdrPage = document.createElement('div');
                hdrPage.className = 'rpp-wizard-pager';
                hdrPage.textContent = total > 1 ? `${pageIdx + 1} of ${total}` : '';
                hdr.appendChild(hdrTitle);
                hdr.appendChild(hdrPage);
                card.appendChild(hdr);

                // Subtitle
                const sub = document.createElement('div');
                sub.className = 'rpp-wizard-sub';
                sub.textContent = `Route passes ${ta.distFromTrack}nm from track`;
                card.appendChild(sub);

                // Options
                const optList = document.createElement('div');
                optList.className = 'rpp-wizard-opts';

                for (const opt of ta.options) {
                    const isSelected = (opt === selections[ta.icao]);
                    const row = document.createElement('div');
                    row.className = 'rpp-wizard-opt-row' + (isSelected ? ' rpp-wizard-opt-selected' : '');

                    const radio = document.createElement('div');
                    radio.className = 'rpp-wizard-radio';
                    radio.textContent = isSelected ? '◉' : '○';

                    const text = document.createElement('div');
                    text.className = 'rpp-wizard-opt-text';

                    const lbl = document.createElement('div');
                    lbl.className = 'rpp-wizard-opt-label';
                    lbl.textContent = opt.label + (opt.recommended ? ' ★' : '');

                    const desc = document.createElement('div');
                    desc.className = 'rpp-wizard-opt-desc';
                    desc.textContent = opt.description;

                    text.appendChild(lbl);
                    text.appendChild(desc);
                    row.appendChild(radio);
                    row.appendChild(text);
                    optList.appendChild(row);

                    wireTap(row, () => {
                        selections[ta.icao] = opt;
                        render();
                    });
                }
                card.appendChild(optList);

                // Footer
                const footer = document.createElement('div');
                footer.className = 'rpp-wizard-footer';

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'rpp-wizard-btn rpp-wizard-btn-cancel';
                cancelBtn.textContent = 'Cancel';
                wireTap(cancelBtn, () => done(null));

                const continueBtn = document.createElement('button');
                continueBtn.className = 'rpp-wizard-btn rpp-wizard-btn-primary';
                continueBtn.textContent = isLast ? 'Plan Route' : 'Continue →';
                wireTap(continueBtn, () => {
                    if (isLast) {
                        done(new Map(Object.entries(selections)));
                    } else {
                        pageIdx++;
                        render();
                    }
                });

                footer.appendChild(cancelBtn);
                footer.appendChild(continueBtn);
                card.appendChild(footer);
            };

            render();
            this._el.appendChild(overlay);
        });
    }
```

- [ ] **Step 2: Add wizard CSS**

Append to `web/style.css`:

```css
/* ── Terminal area routing wizard ──────────────────────────────────────── */

.rpp-wizard-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.55);
    z-index: 120;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 16px;
    overflow-y: auto;
}

.rpp-wizard-card {
    background: var(--bg-primary);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    width: 100%;
    max-width: 560px;
    padding: 0;
    overflow: hidden;
}

.rpp-wizard-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
}

.rpp-wizard-title {
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 800;
    color: var(--text-primary);
    letter-spacing: 0.04em;
}

.rpp-wizard-pager {
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 700;
    color: var(--text-muted);
}

.rpp-wizard-sub {
    padding: 8px 16px 4px;
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 700;
    color: var(--text-secondary);
}

.rpp-wizard-opts {
    padding: 4px 0;
}

.rpp-wizard-opt-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 16px;
    min-height: var(--touch-min, 56px);
    border-bottom: 1px solid var(--border-light);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
}

.rpp-wizard-opt-row.rpp-wizard-opt-selected {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.rpp-wizard-radio {
    font-size: 20px;
    color: var(--accent);
    padding-top: 2px;
    flex-shrink: 0;
    min-width: 24px;
}

.rpp-wizard-opt-text {
    flex: 1;
    min-width: 0;
}

.rpp-wizard-opt-label {
    font-family: var(--font-ui);
    font-size: 14px;
    font-weight: 800;
    color: var(--text-primary);
    line-height: 1.3;
}

.rpp-wizard-opt-desc {
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 700;
    color: var(--text-secondary);
    margin-top: 2px;
    line-height: 1.4;
}

.rpp-wizard-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
}

.rpp-wizard-btn {
    font-family: var(--font-ui);
    font-size: 14px;
    font-weight: 800;
    padding: 0 20px;
    min-height: var(--touch-min, 56px);
    border-radius: 6px;
    border: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
}

.rpp-wizard-btn-cancel {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border-strong);
}

.rpp-wizard-btn-primary {
    background: var(--accent);
    color: #fff;
}
```

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/route-planner-panel.js web/style.css
git commit -m "feat(planner-panel): add terminal area routing wizard overlay

Full-screen modal, paginated per Class B, pre-selects recommended option.
Portrait-optimised with var(--touch-min) targets throughout.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Panel — terminal pre-step in `_onPlanRouteTap()`

**Files:**
- Modify: `web/cockpit/route-planner-panel.js` (~line 1999 in `_onPlanRouteTap`)

- [ ] **Step 1: Add terminal pre-step and conditional planVia()**

In `_onPlanRouteTap()`, locate the line `this._toast('Planning route…', 0);` (around line 2000). **Directly above it**, insert the terminal pre-step block:

```javascript
        // Terminal area pre-step — only when opt-in enabled and analyzer ready
        let viaPins = null;
        if (this._terminalRouting === 't-routes' && this._terminalAnalyzer) {
            let analysis = { hasTerminalAreas: false };
            try {
                analysis = await this._terminalAnalyzer.analyzeRoute(dep, dest);
            } catch (err) {
                console.warn('[RoutePlannerPanel] terminal analysis failed, falling back to plan():', err);
            }
            if (analysis.hasTerminalAreas) {
                const sel = await this._showTerminalWizard(analysis.terminalAreas);
                if (sel !== null) {
                    viaPins = await this._terminalAnalyzer.resolveViaPins(dep, dest, sel);
                }
            }
        }
```

Then replace the single `await this._planner.plan({...})` call (lines ~2002–2012) with a conditional:

```javascript
            const result = viaPins
                ? await this._planner.planVia(viaPins, {
                    cruiseAltFt:   this._altitude,
                    reserveGal:    this._reserveGal,
                    maxLegHrs:     this._maxLegHrs,
                    selfServeOnly: this._selfServeOnly,
                    avoidance:     this._avoidList.slice(),
                    routingMode:   this._routingMode,
                    winds:         this._lastWinds ?? undefined,
                })
                : await this._planner.plan({
                    departure:     dep,
                    destination:   dest,
                    cruiseAltFt:   this._altitude,
                    reserveGal:    this._reserveGal,
                    maxLegHrs:     this._maxLegHrs,
                    selfServeOnly: this._selfServeOnly,
                    avoidance:     this._avoidList.slice(),
                    routingMode:   this._routingMode,
                    winds:         this._lastWinds ?? undefined,
                });
```

Everything after this line — coordinate caching, manual-waypoint confirmation, `_resultToPills`, `_lastPlan`, stats, render, fuel stop picker — is **unchanged**.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: All tests pass (the panel change has no unit tests; correctness verified by smoke test in Task 8).

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/route-planner-panel.js
git commit -m "feat(planner-panel): add terminal area pre-step to _onPlanRouteTap()

When 't-routes' is enabled and Class B detected, shows wizard and calls
planVia() with pilot-selected via-pins. All cancel/error paths fall
through to the unchanged plan() call.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Build + smoke test

**Files:** None — verification only.

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 2: Increment version and build**

In `web/app.js`, increment `FLYTAB_VERSION` (e.g. `v9.56` → `v9.57`).

```bash
bash build.sh
```

Expected: Build succeeds, APK written to `data/`.

- [ ] **Step 3: Smoke test — route with NO Class B (terminal routing off)**

On the tablet:
1. Open Route Planner → ⚙ settings → confirm "Terminal areas" = **Off**
2. Enter `KLKR` → `KSAV` (Savannah GA — ~230nm south, no Class B)
3. Tap **Plan Route**
4. Expected: wizard does NOT appear; route plans normally via existing path

- [ ] **Step 4: Smoke test — route with NO Class B (terminal routing on)**

1. ⚙ → set "Terminal areas" = **T-routes**
2. Enter `KLKR` → `KSAV`
3. Tap **Plan Route**
4. Expected: wizard does NOT appear (no Class B on this route); plan proceeds as normal

- [ ] **Step 5: Smoke test — route through CLT (terminal routing on)**

1. ⚙ → confirm "Terminal areas" = **T-routes**
2. Enter `KLKR` → `KMHT`
3. Tap **Plan Route**
4. Expected:
   - Wizard appears: "CLASS B: Charlotte/Douglas"
   - T200 option is pre-selected with ★
   - Avoidance and ATC Direct options are visible and tappable
   - Tapping **Plan Route** produces a route string containing T200 waypoints (SHIPP, CLT, KILNS visible in pills)

- [ ] **Step 6: Smoke test — Cancel wizard falls through**

1. ⚙ → "Terminal areas" = **T-routes**
2. Enter `KLKR` → `KMHT` → Plan Route
3. When wizard appears, tap **Cancel**
4. Expected: route plans via normal `plan()` (no crash, no toast error)

- [ ] **Step 7: Smoke test — settings persist across restart**

1. Set "Terminal areas" = **T-routes** → close planner
2. Reopen planner → ⚙
3. Expected: "Terminal areas" still shows **T-routes**
