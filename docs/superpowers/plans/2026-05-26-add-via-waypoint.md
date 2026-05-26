# Add-Via-Waypoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a pilot tap any airport, navaid, or fix on the map and add it to the active route via a confirmation popup, triggering a full end-to-end A* re-route through all pinned waypoints.

**Architecture:** A new `planVia(pins, opts)` method on `RoutePlanner` chains sub-segment A* calls between ordered pin waypoints and merges them into a single `FlightPlan`. `app.js` orchestrates: extracts current pins from the active trip, inserts the tapped fix at the minimum-detour position, calls `planVia()`, then applies the result via the existing `applyRouteEdit()` pipeline. Map tap handlers are updated to show a bottom-anchored confirmation popup when a route is active, replacing the direct `addWaypointSmart()` call.

**Tech Stack:** Vanilla JS, Vitest (planning lib tests), Leaflet (map), IDB via planning adapters.

**Spec:** `docs/superpowers/specs/2026-05-26-add-via-waypoint-design.md`

---

## File Map

| File | Role |
|------|------|
| `web/shared/planning/planner/route-planner.js` | Add `planVia()` method |
| `tests/planning/route-planner.test.js` | Tests for `planVia()` |
| `web/app.js` | Add `_addViaAndReplan()`, `_getCurrentPins()`, `_currentPlanOpts()`, `_offerAddViaWaypoint()`, `_dismissViaConfirm()`; modify 3 tap handlers; modify `applyRouteEdit()` |
| `web/index.html` | Add `#viaConfirmOverlay` DOM element |
| `web/style.css` | Add `.via-confirm-*` styles |
| `web/app.js` (version) | Bump `FLYTAB_VERSION` |

---

## Task 1: `planVia()` in RoutePlanner — with TDD

**Files:**
- Modify: `web/shared/planning/planner/route-planner.js`
- Modify: `tests/planning/route-planner.test.js`

### Background

`planVia(pins, opts)` takes an ordered array of `{id, lat, lon}` objects (dep first, dest last, any vias in between). For each consecutive pair it fans out onto the airway graph, runs A*, clears edges, then concatenates sub-paths. Coordinates for pin nodes are injected into `graph.coords` before each A* call so the planner never needs an airport lookup.

The existing airway graph's `clearDirectEdges()` removes only edges with `airway === 'DIRECT'`, so it is safe to call between sub-segments without invalidating the loaded airway data.

- [ ] **Step 1: Write three failing tests**

Append to `tests/planning/route-planner.test.js` (after the last existing `describe` block):

```javascript
// ── planVia ───────────────────────────────────────────────────────────────
// Tests use a minimal graph: three fixes in a triangle so we can verify
// sub-segment stitching without needing real NASR data.

describe('planVia', () => {
    // Fixture: three collinear fixes spaced ~60 nm apart
    // A ──V1──> B ──V1──> C
    const A = { id: 'A', lat: 35.0, lon: -82.0 };
    const B = { id: 'B', lat: 35.0, lon: -81.0 };  // ~53 nm east of A
    const C = { id: 'C', lat: 35.0, lon: -80.0 };  // ~53 nm east of B

    function makePlannerWithGraph() {
        // Build a planner whose aero adapter returns one airway: A-B-C on V1
        const airways = [{
            id: 'V1', type: 'V',
            fixIds: ['A', 'B', 'C'],
            waypoints: [
                { id: 'A', lat: A.lat, lon: A.lon },
                { id: 'B', lat: B.lat, lon: B.lon },
                { id: 'C', lat: C.lat, lon: C.lon },
            ],
            unusable_pairs: new Set(),
        }];
        return new RoutePlanner({
            aero: {
                nearestAirports: () => Promise.resolve([]),
                getAirport:      () => Promise.resolve(null),
                getNavaid:       () => Promise.resolve(null),
                getFix:          () => Promise.resolve(null),
                getAirway:       () => Promise.resolve(null),
                listAirspace:    () => Promise.resolve([]),
                listAirways:     () => Promise.resolve(airways),
            },
            plans:    { save: () => {}, load: () => null },
            profiles: { getActive: () => null },
            weather:  {},
            network:  {},
            clock:    {},
        });
    }

    it('two-pin case returns a plan with dep and dest', async () => {
        const planner = makePlannerWithGraph();
        const plan = await planner.planVia([A, C]);
        expect(plan.departure).toBe('A');
        expect(plan.destination).toBe('C');
        expect(plan.waypoints[0].id).toBe('A');
        expect(plan.waypoints[plan.waypoints.length - 1].id).toBe('C');
        expect(plan.legs.length).toBeGreaterThan(0);
        expect(plan.summary.totalDistNm).toBeGreaterThan(0);
    });

    it('three-pin case routes through via without duplicating the junction', async () => {
        const planner = makePlannerWithGraph();
        const plan = await planner.planVia([A, B, C]);
        const ids = plan.waypoints.map(w => w.id);
        // B must appear exactly once (junction dedup)
        expect(ids.filter(id => id === 'B').length).toBe(1);
        expect(ids[0]).toBe('A');
        expect(ids[ids.length - 1]).toBe('C');
    });

    it('throws DestinationUnreachableError when a sub-segment has no path', async () => {
        // Planner with empty airway graph — no connections
        const empty = new RoutePlanner({
            aero: {
                nearestAirports: () => Promise.resolve([]),
                getAirport:      () => Promise.resolve(null),
                getNavaid:       () => Promise.resolve(null),
                getFix:          () => Promise.resolve(null),
                getAirway:       () => Promise.resolve(null),
                listAirspace:    () => Promise.resolve([]),
                listAirways:     () => Promise.resolve([]),
            },
            plans:    { save: () => {}, load: () => null },
            profiles: { getActive: () => null },
            weather:  {},
            network:  {},
            clock:    {},
        });
        // No airways → even the DIRECT fallback in _aStar only fires when the two
        // nodes are already connected; with an empty graph the fallback edge won't
        // bridge truly isolated nodes unless we explicitly add it. To force the
        // DestinationUnreachableError, use two disconnected fixes far apart.
        const X = { id: 'X', lat: 10.0, lon: -10.0 };
        const Y = { id: 'Y', lat: 80.0, lon: 80.0 };
        await expect(empty.planVia([X, Y])).rejects.toThrow('No route from X to Y');
    });
});
```

- [ ] **Step 2: Run tests — verify all three fail**

```bash
cd /home/dananickerson/flytab && npm test -- --reporter=verbose 2>&1 | grep -A3 "planVia"
```

Expected: three FAIL lines (planVia tests), existing tests still PASS.

- [ ] **Step 3: Implement `planVia()` in route-planner.js**

Add this method to the `RoutePlanner` class, immediately after the `plan()` method (after line ~172, before `parseRoute`):

```javascript
/**
 * Plan a route through an ordered sequence of required waypoints (pins).
 * Runs A* for each consecutive pin pair and merges the sub-paths.
 *
 * @param {Array<{id:string, lat:number, lon:number}>} pins
 *   Ordered waypoints — first is departure, last is destination.
 *   All must be pre-resolved (caller supplies lat/lon).
 * @param {object} [opts]  Same options as plan() except departure/destination.
 * @returns {Promise<import('../types/flight-plan.js').FlightPlan>}
 */
async planVia(pins, opts = {}) {
    if (!pins || pins.length < 2) throw new PlanError('planVia requires at least 2 pins');

    const profile = (await this._adapters.profiles.getActive?.()) || RV9A_FALLBACK;
    const routingModeOrNull = opts.routingMode
        || (profile.equipment?.tAirways ? 'any' : 'v-airways');
    const routingMode = /** @type {import('./airway-graph.js').RoutingMode} */ (routingModeOrNull);

    const graph = await this._getGraph(routingMode);

    const AIRWAY_RE = /^[VTJQ]\d+[A-Z]?$/;
    const excludeFixIds  = new Set();
    const excludeAirways = new Set();
    const avoidanceConstraints = [];
    for (const a of (opts.avoidance || [])) {
        const id = typeof a === 'string' ? a : a.id;
        if (typeof a !== 'string' && a.polygon?.length) {
            avoidanceConstraints.push(/** @type {import('./avoidance.js').AvoidanceConstraint} */ (a));
        } else if (AIRWAY_RE.test(id)) {
            excludeAirways.add(id);
        } else {
            excludeFixIds.add(id);
        }
    }
    const penalty = buildAvoidancePenalty(avoidanceConstraints);
    const excl = { excludeFixIds, excludeAirways };

    /** @type {Array<{id:string, lat:number, lon:number, airway?:string}>} */
    const mergedWaypoints = [];

    for (let i = 0; i < pins.length - 1; i++) {
        const a = pins[i];
        const b = pins[i + 1];

        graph.clearDirectEdges();

        // Inject pin coordinates so A* can start/end at non-airway points
        graph.coords[a.id] = graph.coords[a.id] || { lat: a.lat, lon: a.lon };
        graph.coords[b.id] = graph.coords[b.id] || { lat: b.lat, lon: b.lon };

        // Fan out from both pin endpoints onto the airway network
        for (const f of graph.nearestFixes(a.lat, a.lon, 60, 5)) {
            const c = graph.coords[f.id];
            graph.addDirectEdge(a.id, a.lat, a.lon, f.id, c.lat, c.lon);
        }
        for (const f of graph.nearestFixes(b.lat, b.lon, 60, 5)) {
            const c = graph.coords[f.id];
            graph.addDirectEdge(b.id, b.lat, b.lon, f.id, c.lat, c.lon);
        }

        let subPath = this._aStar(graph, a.id, b.id, penalty, excl);
        if (!subPath) {
            subPath = this._aStar(graph, a.id, b.id, penalty, { corridorNm: 300, ...excl });
        }
        if (!subPath) {
            graph.addDirectEdge(a.id, a.lat, a.lon, b.id, b.lat, b.lon);
            subPath = this._aStar(graph, a.id, b.id, penalty, { corridorNm: Infinity, ...excl });
        }

        if (!subPath) {
            graph.clearDirectEdges();
            throw new DestinationUnreachableError(`No route from ${a.id} to ${b.id}`);
        }

        // Append segment — skip first node on i>0 to dedup the shared junction
        const startIdx = i === 0 ? 0 : 1;
        for (let j = startIdx; j < subPath.length; j++) {
            const node = subPath[j];
            const c = graph.coords[node.id] || { lat: a.lat, lon: a.lon };
            mergedWaypoints.push({
                id:  node.id,
                lat: c.lat,
                lon: c.lon,
                ...(node.airway ? { airway: node.airway } : {}),
            });
        }
    }

    graph.clearDirectEdges();

    const flightPlan = {
        departure:   pins[0].id,
        destination: pins[pins.length - 1].id,
        cruiseAltFt: opts.cruiseAltFt ?? 6000,
        reserveGal:  opts.reserveGal ?? profile.reserve_gal ?? 10,
        waypoints:   mergedWaypoints,
        options: {
            routingMode,
            maxLegHrs:    opts.maxLegHrs    ?? 2.0,
            selfServeOnly: !!opts.selfServeOnly,
            avoidance: (opts.avoidance || []).map(a => typeof a === 'string' ? a : a.id),
        },
    };

    const computed = this.recomputeLegs(flightPlan, profile, { winds: opts.winds });
    return this._insertFuelStops(computed, profile);
}
```

- [ ] **Step 4: Run tests — verify all three pass**

```bash
cd /home/dananickerson/flytab && npm test -- --reporter=verbose 2>&1 | grep -A3 "planVia"
```

Expected: three PASS lines. All other tests still pass.

- [ ] **Step 5: Commit**

```bash
cd /home/dananickerson/flytab && git add web/shared/planning/planner/route-planner.js tests/planning/route-planner.test.js && git commit -m "$(cat <<'EOF'
feat(planning): add planVia() — sub-segment A* through ordered pin waypoints

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Confirmation Popup — HTML + CSS

**Files:**
- Modify: `web/index.html`
- Modify: `web/style.css`

- [ ] **Step 1: Add overlay element to index.html**

Find the closing `</body>` tag in `web/index.html` and add the overlay div just before it:

```html
  <!-- Via-waypoint confirmation overlay -->
  <div id="viaConfirmOverlay" hidden>
    <div class="via-confirm-card">
      <div id="viaConfirmTitle" class="via-confirm-title"></div>
      <div id="viaConfirmSub" class="via-confirm-sub"></div>
      <div class="via-confirm-btns">
        <button id="viaConfirmCancel">Cancel</button>
        <button id="viaConfirmAdd">Add</button>
      </div>
    </div>
  </div>
</body>
```

- [ ] **Step 2: Add styles to style.css**

Append to `web/style.css`:

```css
/* ── Via-waypoint confirmation popup ─────────────────────────────────── */
#viaConfirmOverlay {
  position: fixed;
  bottom: 90px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1200;
  pointer-events: auto;
}
.via-confirm-card {
  background: #fff;
  border-radius: 12px;
  padding: 16px 20px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.40);
  min-width: 280px;
  max-width: 380px;
}
.via-confirm-title {
  font-size: 18px;
  font-weight: 700;
  color: #111;
  margin-bottom: 4px;
}
.via-confirm-sub {
  font-size: 13px;
  font-weight: 600;
  color: #555;
  margin-bottom: 16px;
}
.via-confirm-btns {
  display: flex;
  gap: 12px;
}
.via-confirm-btns button {
  flex: 1;
  height: 52px;
  font-size: 16px;
  font-weight: 700;
  border: none;
  border-radius: 8px;
  cursor: pointer;
}
#viaConfirmCancel { background: #e0e0e0; color: #333; }
#viaConfirmAdd    { background: #0057b8; color: #fff; }
```

- [ ] **Step 3: Commit**

```bash
cd /home/dananickerson/flytab && git add web/index.html web/style.css && git commit -m "$(cat <<'EOF'
feat(ui): add via-confirm overlay markup and styles

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Orchestrator + Tap Handler Wiring in app.js

**Files:**
- Modify: `web/app.js`

### Background

`this._currentTrip` is the active plan (may be null). `this._planningAdapters` was built by `_buildPlanningAdapters()` during init. The planner instance lives on `this.routePlannerPanel._planner` (non-null once the panel has loaded airways). For `_addViaAndReplan()` we reuse it directly; if null we instantiate one on demand from `window.FlyTabPlanning`.

`applyRouteEdit()` is the existing public method that normalises and applies a plan. We add a `keepPins` option so `_addViaAndReplan()` can preserve `_pinnedIds` across its own re-apply calls.

The `haversine()` function is available as `FlyTabPlanning.haversine()`.

- [ ] **Step 1: Add `keepPins` option to `applyRouteEdit()`**

Find `applyRouteEdit` in app.js (line ~1203). Replace the signature line and add the pin reset:

Old:
```javascript
    async applyRouteEdit(plan, { fromRouteTable = false } = {}) {
        if (!plan) return;
        plan.edited_at = new Date().toISOString();
```

New:
```javascript
    async applyRouteEdit(plan, { fromRouteTable = false, keepPins = false } = {}) {
        if (!plan) return;
        if (!keepPins) this._pinnedIds = null;
        plan.edited_at = new Date().toISOString();
```

- [ ] **Step 2: Add `_pinnedIds` declaration in the constructor**

Find `this._currentTrip = null;` in the constructor (line ~90) and add below it:

```javascript
        this._pinnedIds    = null;    // Set<string> of pilot-added via waypoint IDs
```

- [ ] **Step 3: Add `_getCurrentPins()` method**

Add after the `closeRoutePlanner()` method (line ~1143):

```javascript
    /**
     * Extract the ordered pin waypoints from the active trip.
     * Pins are: departure, destination, and any IDs in this._pinnedIds.
     * Interior A* hops between pins are excluded.
     * @returns {Array<{id:string, lat:number, lon:number}>}
     */
    _getCurrentPins() {
        const wps = this._currentTrip?.waypoints;
        if (!wps || wps.length < 2) return [];
        const pinned = this._pinnedIds || new Set();
        return wps
            .filter((wp, idx) =>
                idx === 0 ||
                idx === wps.length - 1 ||
                pinned.has(wp.icao || wp.id || '')
            )
            .map(wp => ({
                id:  wp.icao || wp.id || '',
                lat: wp.lat,
                lon: wp.lon,
            }))
            .filter(p => p.id && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    }
```

- [ ] **Step 4: Add `_currentPlanOpts()` method**

Add directly after `_getCurrentPins()`:

```javascript
    /**
     * Extract planning options from the active trip to pass to planVia().
     * @returns {object}
     */
    _currentPlanOpts() {
        const opts = this._currentTrip?.options || {};
        return {
            routingMode:   opts.routingMode   || 'v-airways',
            cruiseAltFt:   this._currentTrip?.cruiseAltFt || opts.cruiseAltFt || 6000,
            reserveGal:    this._currentTrip?.reserveGal  || opts.reserveGal  || 10,
            maxLegHrs:     opts.maxLegHrs     || 2.0,
            selfServeOnly: !!opts.selfServeOnly,
            avoidance:     opts.avoidance     || [],
            winds:         this.routePlannerPanel?._lastWinds || undefined,
        };
    }
```

- [ ] **Step 5: Add `_addViaAndReplan()` method**

Add directly after `_currentPlanOpts()`:

```javascript
    /**
     * Insert a new via waypoint and re-plan the entire route end-to-end via A*.
     * @param {{id:string, name:string, lat:number, lon:number}} fix
     */
    async _addViaAndReplan(fix) {
        const pins = this._getCurrentPins();
        if (pins.length < 2) return;

        // Minimum-detour insertion: find which gap in the pin sequence costs least
        let bestIdx  = 1;
        let bestCost = Infinity;
        for (let i = 0; i < pins.length - 1; i++) {
            const a = pins[i], b = pins[i + 1];
            const cost = FlyTabPlanning.haversine(a.lat, a.lon, fix.lat, fix.lon)
                       + FlyTabPlanning.haversine(fix.lat, fix.lon, b.lat, b.lon)
                       - FlyTabPlanning.haversine(a.lat, a.lon, b.lat, b.lon);
            if (cost < bestCost) { bestCost = cost; bestIdx = i + 1; }
        }
        const newPins = [...pins];
        newPins.splice(bestIdx, 0, { id: fix.id, lat: fix.lat, lon: fix.lon });

        // Get or create a planner instance
        let planner = this.routePlannerPanel?._planner;
        if (!planner && window.FlyTabPlanning?.RoutePlanner) {
            planner = new window.FlyTabPlanning.RoutePlanner(this._planningAdapters);
        }
        if (!planner) {
            this.showToast('Route planner not ready — try again');
            return;
        }

        this.showToast('Re-routing…');
        let plan;
        try {
            plan = await planner.planVia(newPins, this._currentPlanOpts());
        } catch (e) {
            this.showToast(`No airway path through ${fix.id} — try a different fix`);
            return;
        }

        // Normalise planVia waypoints (id→icao) for _applyPlan's NASR resolver
        const normalised = {
            ...plan,
            waypoints: plan.waypoints.map(wp => ({
                icao: wp.id,
                name: wp.id,
                lat:  wp.lat,
                lon:  wp.lon,
                ...(wp.airway ? { airway: wp.airway } : {}),
            })),
        };

        if (!this._pinnedIds) this._pinnedIds = new Set();
        this._pinnedIds.add(fix.id);

        await this.applyRouteEdit(normalised, { keepPins: true });
        this.showToast(`${fix.id} added — route updated`);
    }
```

- [ ] **Step 6: Add `_offerAddViaWaypoint()` and `_dismissViaConfirm()` methods**

Add directly after `_addViaAndReplan()`:

```javascript
    /**
     * Show the via-waypoint confirmation popup for a tapped fix.
     * @param {{id:string, name:string, lat:number, lon:number}} fix
     */
    _offerAddViaWaypoint(fix) {
        const pins = this._getCurrentPins();
        if (pins.length < 2) return;

        // Compute insertion neighbours for the subtext label
        let bestIdx  = 1;
        let bestCost = Infinity;
        for (let i = 0; i < pins.length - 1; i++) {
            const a = pins[i], b = pins[i + 1];
            const cost = FlyTabPlanning.haversine(a.lat, a.lon, fix.lat, fix.lon)
                       + FlyTabPlanning.haversine(fix.lat, fix.lon, b.lat, b.lon)
                       - FlyTabPlanning.haversine(a.lat, a.lon, b.lat, b.lon);
            if (cost < bestCost) { bestCost = cost; bestIdx = i + 1; }
        }
        const before = pins[bestIdx - 1].id;
        const after  = pins[bestIdx].id;

        const overlay = document.getElementById('viaConfirmOverlay');
        if (!overlay) return;
        document.getElementById('viaConfirmTitle').textContent = `Add ${fix.id} to route?`;
        document.getElementById('viaConfirmSub').textContent   = `Between ${before} and ${after}`;

        this._viaConfirmFix = fix;
        overlay.hidden = false;

        // Auto-dismiss on next map touch outside the card
        const onOutside = (e) => {
            if (!overlay.contains(e.target)) this._dismissViaConfirm();
        };
        this._viaConfirmOutside = onOutside;
        setTimeout(() => document.addEventListener('touchstart', onOutside, { capture: true }), 0);
    }

    /** Hide the via-confirm popup and clean up listeners. */
    _dismissViaConfirm() {
        const overlay = document.getElementById('viaConfirmOverlay');
        if (overlay) overlay.hidden = true;
        if (this._viaConfirmOutside) {
            document.removeEventListener('touchstart', this._viaConfirmOutside, { capture: true });
            this._viaConfirmOutside = null;
        }
        this._viaConfirmFix = null;
    }
```

- [ ] **Step 7: Wire overlay buttons in the init block**

In the app's `init()` method, find where other UI buttons are wired (search for `document.getElementById` assignments near line 220–240). Add after the existing button wiring:

```javascript
        // Via-confirm overlay buttons
        document.getElementById('viaConfirmCancel')?.addEventListener('click', () => {
            this._dismissViaConfirm();
        });
        document.getElementById('viaConfirmAdd')?.addEventListener('click', async () => {
            const fix = this._viaConfirmFix;
            this._dismissViaConfirm();
            if (fix) await this._addViaAndReplan(fix);
        });
```

- [ ] **Step 8: Update the three tap handlers**

Find the `onAirportClick`, `onNavaidClick`, and `onFixClick` handlers (lines ~466–498). Replace all three with:

```javascript
                this.vectorLayers.onAirportClick((apt) => {
                    if (typeof _wireTapLastTouchAt !== 'undefined' && Date.now() - _wireTapLastTouchAt < 500) return;
                    if (this._currentTrip?.waypoints?.length >= 2) {
                        this._offerAddViaWaypoint({ id: apt.icao, name: apt.name || apt.icao, lat: apt.lat, lon: apt.lon });
                        return;
                    }
                    this.airportPopup.show(apt);
                });

                this.vectorLayers.onNavaidClick((nav) => {
                    if (typeof _wireTapLastTouchAt !== 'undefined' && Date.now() - _wireTapLastTouchAt < 500) return;
                    if (this._currentTrip?.waypoints?.length >= 2) {
                        this._offerAddViaWaypoint({ id: nav.id, name: nav.name || nav.id, lat: nav.lat, lon: nav.lon });
                        return;
                    }
                    this.airportPopup.showNavaid(nav);
                });

                this.vectorLayers.onFixClick((fix) => {
                    if (typeof _wireTapLastTouchAt !== 'undefined' && Date.now() - _wireTapLastTouchAt < 500) return;
                    if (this._currentTrip?.waypoints?.length >= 2) {
                        this._offerAddViaWaypoint({ id: fix.id, name: fix.id, lat: fix.lat, lon: fix.lon });
                    }
                });
```

Note: `onFixClick` previously called `addWaypointSmart()` only in edit mode and showed no popup otherwise. The new behavior offers add-via whenever a route is active — fix taps outside a route context are still silently ignored (no airportPopup for raw fixes).

- [ ] **Step 9: Commit**

```bash
cd /home/dananickerson/flytab && git add web/app.js && git commit -m "$(cat <<'EOF'
feat(app): add-via-waypoint orchestrator and map tap wiring

_addViaAndReplan() chains planVia() sub-segments; _offerAddViaWaypoint()
shows confirmation popup; tap handlers updated for all three fix types.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Version Bump + Build

**Files:**
- Modify: `web/app.js` (version constant, line 6)

- [ ] **Step 1: Increment FLYTAB_VERSION**

Current value is `v9.15`. Change to `v9.16`:

```javascript
const FLYTAB_VERSION = 'v9.16';
```

- [ ] **Step 2: Run full test suite**

```bash
cd /home/dananickerson/flytab && npm test 2>&1 | tail -20
```

Expected: all tests PASS (including the three new `planVia` tests).

- [ ] **Step 3: Build**

```bash
cd /home/dananickerson/flytab && bash build.sh 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL` and APK copied to `data/`.

- [ ] **Step 4: Commit**

```bash
cd /home/dananickerson/flytab && git add web/app.js android/app/build.gradle && git commit -m "$(cat <<'EOF'
chore: bump to v9.16 — add-via-waypoint

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist

- **`planVia()` spec coverage:** Three A* cases (2-pin, 3-pin, failure) tested ✓. Junction dedup tested ✓. Options forwarding (routingMode, avoidance, winds) wired in implementation ✓.
- **Popup spec:** Header with fix ID ✓. Subtext with neighbour IDs ✓. Two fat-finger buttons ✓. Auto-dismiss on outside tap ✓.
- **Pin tracking:** `_pinnedIds` null-checked in `_getCurrentPins()` ✓. Reset on non-keepPins `applyRouteEdit()` ✓. Added on every `_addViaAndReplan()` call ✓.
- **Planner availability:** Falls back to `new window.FlyTabPlanning.RoutePlanner(this._planningAdapters)` when panel planner is null ✓.
- **Type consistency:** `planVia` returns `{id, lat, lon, airway?}` waypoints; `_addViaAndReplan` maps these to `{icao, name, lat, lon}` before `applyRouteEdit()` ✓.
- **Fix-tap outside route:** `onFixClick` silently ignores when no active route (no fallback popup — consistent with prior behaviour) ✓.
- **No placeholder steps:** All code blocks are complete ✓.
