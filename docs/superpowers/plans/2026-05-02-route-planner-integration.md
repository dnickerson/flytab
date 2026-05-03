# Route Planner Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unstable overlay `RouteEditor` with a stable split-layout `RoutePlannerPanel` that integrates A* airway routing, pill-based manual editing, planning options (altitude, leg hours, fuel prefs), and paste-from-clipboard into a dedicated layout slot that does not touch-overlap the map.

**Architecture:** A new `#cockpitContainer` div wraps the map and panel in a CSS grid. Toggling `.route-editing` on that div switches portrait (60/40 vertical) and landscape (40/60 horizontal) layouts. The new `RoutePlannerPanel` class owns all pill UI and calls `app.applyRouteEdit(plan)` + `app.closeRoutePlanner()` as its only outward API. The existing `RouteEditor` overlay and prototype files are deleted.

**Tech Stack:** Vanilla JS (no bundler), Leaflet, IndexedDB via `NasrDb`, `localStorage` for opts persistence, CSS grid for layout. No test suite — verify in browser after each task.

**Spec:** `docs/superpowers/specs/2026-05-02-route-planner-integration-design.md`

---

## File Map

| File | Action |
|------|--------|
| `web/shared/route-planner.js` | **Create** — `routePlanner.js` from repo root, moved here; exports removed; WorkGraph reliability fix; RV-9A aircraft fallback |
| `web/cockpit/route-planner-panel.js` | **Create** — new `RoutePlannerPanel` class (Tasks 5–11) |
| `web/style.css` | **Modify** — add `#cockpitContainer` base rule, `.route-editing` grid rules, pill styles, planning options row styles |
| `web/index.html` | **Modify** — add `#cockpitContainer` wrapper, `id="mapContainer"` on `.map-area`, `<div id="routePlannerPanel">`, swap script tags |
| `web/cockpit/route-table.js` | **Modify** — EDIT button calls `app.openRoutePlanner(app._currentTrip)` |
| `web/app.js` | **Modify** — add `openRoutePlanner`/`closeRoutePlanner`; replace all `routeEditor` refs with `routePlannerPanel` |
| `web/cockpit/route-editor.js` | **Delete** |
| `routeEditor.html` (repo root) | **Delete** |
| `routePlanner.js` (repo root) | **Delete** |

---

### Task 1: Create `web/shared/route-planner.js` with WorkGraph fix

**Files:**
- Create: `web/shared/route-planner.js`

This copies `routePlanner.js` from the repo root, removes ES module `export` keywords (the app uses `<script>` tags, not ES modules), replaces the expensive `JSON.parse(JSON.stringify(...))` deep-copy in `RouteConstructor.build()` with a lightweight `WorkGraph` proxy, and adds an RV-9A fallback so `plan()` doesn't throw when `aircraft_profiles` IDB store is empty.

- [ ] **Step 1: Copy the file**

```bash
cp ~/flytab/routePlanner.js ~/flytab/web/shared/route-planner.js
```

- [ ] **Step 2: Remove ES module export keywords**

In `web/shared/route-planner.js`, find and remove two export keywords (the classes/functions stay global):

Replace:
```javascript
export class RoutePlanner {
```
with:
```javascript
class RoutePlanner {
```

Replace:
```javascript
export async function createRoutePlanner(dbName = 'FlyTabDB') {
```
with:
```javascript
async function createRoutePlanner(dbName = 'FlyTabDB') {
```

- [ ] **Step 3: Insert the `WorkGraph` class**

Insert this class immediately before `class RouteConstructor {` (around line 363 of the original):

```javascript
// ---------------------------------------------------------------------------
// WORK GRAPH — lightweight proxy over the shared AirwayGraph for one plan()
// call. Reads through to the shared immutable graph for all existing edges;
// only the small set of temporary DEP/DEST edges are stored separately.
// Eliminates the JSON.parse(JSON.stringify(...)) deep-copy in build().
// ---------------------------------------------------------------------------

class WorkGraph {
    constructor(base) {
        this._base  = base;
        this._extra = {};
        // Shallow-copy coords so DEP/DEST entries don't mutate the shared graph
        this.coords = { ...base.coords };
        // Proxy the adjacency list: merge base + extra on each fixId lookup
        const self = this;
        this.graph = new Proxy(base.graph, {
            get(target, fixId) {
                if (typeof fixId !== 'string') return target[fixId];
                const base  = target[fixId]      || [];
                const extra = self._extra[fixId] || [];
                return extra.length ? [...base, ...extra] : base;
            },
        });
    }

    _addEdge(from, to, distNm, mea, airway) {
        if (!this._extra[from]) this._extra[from] = [];
        if (!this._extra[from].find(e => e.to === to && e.airway === airway))
            this._extra[from].push({ to, distNm, mea, airway });
    }

    addDirectEdge(fromId, fromLat, fromLon, toId, toLat, toLon) {
        if (!this.coords[fromId]) this.coords[fromId] = { lat: fromLat, lon: fromLon };
        if (!this.coords[toId])   this.coords[toId]   = { lat: toLat,   lon: toLon   };
        const dist = haversine(fromLat, fromLon, toLat, toLon);
        this._addEdge(fromId, toId, dist, 0, 'DIRECT');
        this._addEdge(toId, fromId, dist, 0, 'DIRECT');
    }

    nearestFixes(lat, lon, maxNm = 60, limit = 5) {
        const candidates = [];
        for (const [id, c] of Object.entries(this.coords)) {
            const d = haversine(lat, lon, c.lat, c.lon);
            if (d <= maxNm) candidates.push({ fixId: id, distNm: d });
        }
        candidates.sort((a, b) => a.distNm - b.distNm);
        return candidates.slice(0, limit);
    }
}
```

- [ ] **Step 4: Replace the deep-copy in `RouteConstructor.build()`**

Find this block in `build()` (was line 458–460):
```javascript
    const workGraph = new AirwayGraph();
    workGraph.graph  = JSON.parse(JSON.stringify(this.graph.graph));
    workGraph.coords = { ...this.graph.coords };
```

Replace with:
```javascript
    const workGraph = new WorkGraph(this.graph);
```

- [ ] **Step 5: Add RV-9A aircraft fallback in `RoutePlanner.plan()`**

Find:
```javascript
    if (!aircraft) throw new Error('Aircraft profile required');
```

Replace with:
```javascript
    if (!aircraft) {
        // Fall back to RV-9A defaults when aircraft_profiles IDB store is empty
        aircraft = { ktas: 155, gph: 8.0, usableGal: 36.0,
                     cruise_ktas: 155, fuel_burn_gph: 8.0, fuel_capacity_gal: 36.0 };
    }
```

- [ ] **Step 6: Verify the file loads**

```bash
cd ~/flytab/web
python3 -m http.server 9090 &
# Open http://localhost:9090/ in Chrome, open DevTools console
# Add a temporary <script src="./shared/route-planner.js"> to index.html, reload, check console
# Expected: no "Unexpected token 'export'" or other syntax errors
# Remove the temporary script tag before committing
```

- [ ] **Step 7: Commit**

```bash
cd ~/flytab
git add web/shared/route-planner.js
git commit -m "feat: add route-planner.js to web/shared; WorkGraph proxy replaces deep-copy; RV-9A fallback"
```

---

### Task 2: Add CSS layout and pill styles to `web/style.css`

**Files:**
- Modify: `web/style.css`

- [ ] **Step 1: Add the `#cockpitContainer` base rule and `.route-editing` grid rules**

Append to the end of `web/style.css`:

```css
/* ── Route Planner Layout ──────────────────────────────────────────────────── */

/* cockpitContainer wraps the map area + route planner panel.
   Left rail remains outside and is unaffected by route editing mode. */
#cockpitContainer {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    position: relative;
}

/* Portrait: map top 60%, editor bottom 40% */
.route-editing #cockpitContainer {
    display: grid;
    grid-template-rows: 60fr 40fr;
    grid-template-columns: 1fr;
    height: 100%;
}
.route-editing #routePlannerPanel {
    grid-row: 2;
    grid-column: 1;
}

/* Landscape: editor left 40%, map right 60%.
   Right sidebar overlays the map column — pilot can tap an airport while
   the route editor is open. */
@media (orientation: landscape) {
    .route-editing #cockpitContainer {
        grid-template-rows: 1fr;
        grid-template-columns: 40fr 60fr;
    }
    .route-editing #routePlannerPanel {
        grid-row: 1;
        grid-column: 1;
        order: -1;
    }
    .route-editing #mapContainer {
        grid-row: 1;
        grid-column: 2;
    }
}

#routePlannerPanel {
    display: none;
    overflow-y: auto;
    background: #f0f2f4;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 13px;
    color: #0a0c0f;
}
.route-editing #routePlannerPanel {
    display: flex;
    flex-direction: column;
}

/* ── Route Planner Panel Inner Layout ────────────────────────────────────── */
.rpp-inner {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
}

/* DEP/DEST row */
.rpp-dep-row {
    display: grid;
    grid-template-columns: 1fr 28px 1fr;
    gap: 6px;
    align-items: center;
}
.rpp-icao-field {
    background: #fff;
    border: 1.5px solid #b0bac6;
    border-radius: 8px;
    padding: 8px 10px;
}
.rpp-icao-field label {
    display: block;
    font-size: 9px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: #6b7a8d;
    margin-bottom: 3px;
}
.rpp-icao-field input {
    background: transparent;
    border: none;
    outline: none;
    font-family: inherit;
    font-size: 17px;
    font-weight: 700;
    color: #0a0c0f;
    width: 100%;
    text-transform: uppercase;
    letter-spacing: .06em;
}
.rpp-icao-field input::placeholder { color: #b0bac6; }
.rpp-arrow-sep { text-align: center; font-size: 16px; color: #6b7a8d; }

/* Options row */
.rpp-opts-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}
.rpp-opts-label {
    font-size: 9px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: #6b7a8d;
    white-space: nowrap;
}
.rpp-alt-input {
    width: 72px;
    background: #fff;
    border: 1.5px solid #b0bac6;
    border-radius: 6px;
    padding: 5px 7px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    color: #0a0c0f;
    outline: none;
    text-align: right;
}
.rpp-alt-input:focus { border-color: #1a6fbb; }
.rpp-leg-btns { display: flex; gap: 3px; }
.rpp-leg-btn {
    background: #fff;
    border: 1.5px solid #b0bac6;
    border-radius: 6px;
    padding: 5px 9px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    color: #0a0c0f;
    cursor: pointer;
    min-width: 44px;
    min-height: 36px;
}
.rpp-leg-btn.active {
    background: #1a6fbb;
    border-color: #1a6fbb;
    color: #fff;
}
.rpp-check-row {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: #0a0c0f;
    white-space: nowrap;
}
.rpp-check-row input[type=checkbox] { width: 18px; height: 18px; cursor: pointer; }
.rpp-reserve-input {
    width: 46px;
    background: #fff;
    border: 1.5px solid #b0bac6;
    border-radius: 6px;
    padding: 5px 6px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    color: #0a0c0f;
    outline: none;
    text-align: right;
}
.rpp-reserve-input:focus { border-color: #1a6fbb; }

/* Pill box */
.rpp-pill-box {
    background: #fff;
    border: 1.5px solid #b0bac6;
    border-radius: 10px;
    padding: 10px;
    min-height: 60px;
}
.rpp-pill-box.drag-active {
    border-color: #1a6fbb;
    background: #f0f6ff;
}

/* Pills — horizontal left-to-right wrapping */
.rpp-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    align-items: center;
    min-height: 38px;
}

.rpp-pill {
    position: relative;
    display: inline-flex;
    align-items: center;
    height: 32px;
    border-radius: 16px;
    font-family: inherit;
    font-weight: 600;
    font-size: 12px;
    letter-spacing: .04em;
    cursor: default;
    transition: transform .1s, box-shadow .1s;
    padding: 0 11px 0 6px;
    user-select: none;
    -webkit-user-select: none;
}
.rpp-pill.dragging { opacity: .35; transform: scale(.96); }
.rpp-pill.drag-over-left  { box-shadow: -3px 0 0 2px #1a6fbb; }
.rpp-pill.drag-over-right { box-shadow:  3px 0 0 2px #1a6fbb; }

.rpp-pill-fix    { background: #dbeffe; border: 1.5px solid #5aaee8; color: #0a4a7c; }
.rpp-pill-dep,
.rpp-pill-dest   { background: #e8e2ff; border: 1.5px solid #7c62d4; color: #3a1e8a; }
.rpp-pill-awy    { background: #d4f5e2; border: 1.5px solid #3fb86a; color: #0e4a26; }
.rpp-pill-direct { background: #fff3d0; border: 1.5px solid #d4a017; color: #5a3a00; font-style: italic; }
.rpp-pill-fuel   { background: #ffe4cc; border: 1.5px solid #e07030; color: #7a2800; }

.rpp-pill-handle {
    display: inline-flex;
    align-items: center;
    margin-right: 4px;
    opacity: .4;
    font-size: 10px;
    cursor: grab;
    touch-action: none;  /* handle only — lets pill list scroll */
    padding: 4px 2px;
    min-width: 18px;
    min-height: 28px;
    justify-content: center;
}
.rpp-pill-handle:active { cursor: grabbing; }

.rpp-pill-del {
    display: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: rgba(0,0,0,.12);
    margin-left: 5px;
    font-size: 11px;
    cursor: pointer;
    color: inherit;
    flex-shrink: 0;
}
.rpp-pill:hover .rpp-pill-del { display: inline-flex; }

.rpp-type-badge {
    font-size: 9px;
    background: rgba(0,0,0,.09);
    border-radius: 6px;
    padding: 1px 5px;
    margin-left: 4px;
    letter-spacing: .04em;
}

/* Add input row */
.rpp-add-row {
    display: flex;
    gap: 6px;
}
.rpp-add-input {
    flex: 1;
    background: #fff;
    border: 1.5px solid #b0bac6;
    border-radius: 8px;
    padding: 7px 10px;
    font-family: inherit;
    font-size: 13px;
    color: #0a0c0f;
    outline: none;
    text-transform: uppercase;
}
.rpp-add-input:focus { border-color: #1a6fbb; }
.rpp-add-input::placeholder { text-transform: none; color: #b0bac6; }
.rpp-add-sel {
    flex: 0 0 82px;
    background: #fff;
    border: 1.5px solid #b0bac6;
    border-radius: 8px;
    padding: 7px 6px;
    font-family: inherit;
    font-size: 12px;
    color: #0a0c0f;
    outline: none;
}
.rpp-add-sel:focus { border-color: #1a6fbb; }
.rpp-add-btn {
    background: #1a6fbb;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 7px 12px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    min-height: 44px;
}
.rpp-add-btn:active { background: #155fa0; }

/* Toolbar buttons */
.rpp-toolbar {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}
.rpp-tbtn {
    background: #fff;
    border: 1.5px solid #b0bac6;
    border-radius: 7px;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 11px;
    color: #0a0c0f;
    cursor: pointer;
    flex: 1;
    text-align: center;
    min-height: 44px;
}
.rpp-tbtn:active { background: #e8f0fb; border-color: #1a6fbb; }
.rpp-tbtn-apply {
    background: #1a6fbb;
    color: #fff;
    border-color: #1a6fbb;
    font-weight: 700;
}
.rpp-tbtn-apply:active { background: #155fa0; }

/* Route string display */
.rpp-route-label {
    font-size: 9px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: #6b7a8d;
    margin-bottom: 2px;
}
.rpp-route-str {
    background: #fff;
    border: 1.5px solid #b0bac6;
    border-radius: 8px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 11px;
    color: #0a4a7c;
    letter-spacing: .04em;
    word-break: break-all;
    line-height: 1.8;
    min-height: 36px;
}

/* Context menu */
.rpp-menu {
    position: fixed;
    background: #fff;
    border: 1.5px solid #b0bac6;
    border-radius: 10px;
    box-shadow: 0 4px 18px rgba(0,0,0,.16);
    z-index: 9999;
    min-width: 170px;
    padding: 4px 0;
    display: none;
}
.rpp-menu.open { display: block; }
.rpp-menu-item {
    padding: 9px 14px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    color: #0a0c0f;
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
}
.rpp-menu-item:hover { background: #f0f6ff; }
.rpp-menu-item:active { background: #e0eefa; }
.rpp-menu-item.danger { color: #c0231f; }
.rpp-menu-item.danger:hover { background: #fff0f0; }
.rpp-menu-sep { height: .5px; background: #e0e5ea; margin: 3px 0; }
.rpp-menu-label {
    padding: 5px 14px 2px;
    font-size: 9px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: #6b7a8d;
}
```

- [ ] **Step 2: Verify no CSS parse errors**

```bash
# Open http://localhost:9090/ in Chrome
# DevTools → Console — check for stylesheet parse errors
# DevTools → Elements → Styles — confirm .rpp-pill-fix etc. appear
```

- [ ] **Step 3: Commit**

```bash
cd ~/flytab
git add web/style.css
git commit -m "style: add route planner panel layout grid and pill styles"
```

---

### Task 3: Update `web/index.html`

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add `#cockpitContainer` wrapper and `id="mapContainer"` to `.map-area`**

Find the `<div class="cockpit-main">` block:
```html
            <div class="cockpit-main">
                <!-- Left rail: icon-only, 44px, NOT overlaying map -->
                <div id="leftRail"></div>
                <!-- Map area: fills remaining space -->
                <div class="map-area">
                    <div id="primaryView" class="primary-view"></div>
                    <!-- 3 corner buttons (auto-pan, D→, ⋮) -->
                    <div id="mapCornerBtns"></div>
                </div>
            </div>
```

Replace with:
```html
            <div class="cockpit-main">
                <!-- Left rail: icon-only, 44px, NOT overlaying map -->
                <div id="leftRail"></div>
                <!-- cockpitContainer: map + route planner panel in CSS grid -->
                <div id="cockpitContainer">
                    <div class="map-area" id="mapContainer">
                        <div id="primaryView" class="primary-view"></div>
                        <!-- 3 corner buttons (auto-pan, D→, ⋮) -->
                        <div id="mapCornerBtns"></div>
                    </div>
                    <div id="routePlannerPanel"></div>
                </div>
            </div>
```

- [ ] **Step 2: Swap script tags**

Find the line:
```html
    <script src="./cockpit/route-editor.js"></script>
```

Replace with:
```html
    <script src="./shared/route-planner.js"></script>
    <script src="./cockpit/route-planner-panel.js"></script>
```

`route-planner.js` must load before `route-planner-panel.js`. Both load before `app.js` at the bottom.

- [ ] **Step 3: Verify map still renders**

```bash
# Reload http://localhost:9090/ in Chrome
# Map should appear at full width — #cockpitContainer has flex:1, same as old .map-area
# DevTools Console — no errors
# DevTools Elements — confirm #cockpitContainer contains #mapContainer and #routePlannerPanel
```

- [ ] **Step 4: Commit**

```bash
cd ~/flytab
git add web/index.html
git commit -m "feat: add cockpitContainer wrapper and routePlannerPanel div to index.html"
```

---

### Task 4: Update EDIT button in `web/cockpit/route-table.js`

**Files:**
- Modify: `web/cockpit/route-table.js:2078–2085`

- [ ] **Step 1: Rewire the EDIT button**

Find (around line 2078):
```javascript
        // EDIT button opens the separate route editor
        this._editBtn = this._handleEl.querySelector('.route-table-edit-btn');
        wireTap(this._editBtn, () => {
            console.log('[RouteTable] EDIT button fired, routeEditor=', !!(typeof app !== 'undefined' && app.routeEditor));
            if (typeof app !== 'undefined' && app.routeEditor) {
                app.routeEditor.startEditRoute();
            }
        });
```

Replace with:
```javascript
        // EDIT button opens the route planner panel
        this._editBtn = this._handleEl.querySelector('.route-table-edit-btn');
        wireTap(this._editBtn, () => {
            if (typeof app !== 'undefined') {
                app.openRoutePlanner(app._currentTrip);
            }
        });
```

- [ ] **Step 2: Remove `setRouteEditor` method**

Find and delete the entire method (around line 99):
```javascript
    /** Wire up route editor so Direct-To still works */
    setRouteEditor(editor) {
        this._routeEditor = editor;
    }
```

Also delete the `this._routeEditor = null;` line in the constructor (around line 83).

- [ ] **Step 3: Commit**

```bash
cd ~/flytab
git add web/cockpit/route-table.js
git commit -m "feat: route-table EDIT button calls app.openRoutePlanner(); remove setRouteEditor"
```

---

### Task 5: Create `RoutePlannerPanel` — skeleton, DOM builder, open/close

**Files:**
- Create: `web/cockpit/route-planner-panel.js`

- [ ] **Step 1: Create the file with constructor, lifecycle methods, and DOM builder**

Create `web/cockpit/route-planner-panel.js` with this complete content:

```javascript
'use strict';

/**
 * RoutePlannerPanel
 * Ground planning tool: pill-based route editor + A* auto-routing.
 * Occupies #routePlannerPanel div; layout controlled by .route-editing on #cockpitContainer.
 * Only outward calls: app.applyRouteEdit(plan) and app.closeRoutePlanner().
 */
class RoutePlannerPanel {
    constructor(panelEl, nasrDb) {
        this._el      = panelEl;
        this._nasrDb  = nasrDb;

        // Route state — [{id, type}] where type: dep|dest|fix|awy|direct|fuel
        this._route   = [];
        // Index where next add-input item will be inserted (null = before last pill)
        this._insertIndex = null;

        // Coordinate cache from last RoutePlanner.plan() call; also populated by IDB lookups on Apply
        this._coords  = {};   // id -> {lat, lon}

        // RoutePlanner instance — built once, reused across plan() calls
        this._planner = null;
        this._nasrVersion = '';  // localStorage version at graph-build time

        // Planning options (persisted to localStorage)
        this._altitude      = 5500;
        this._maxLegHrs     = 2.0;
        this._selfServeOnly = false;
        this._reserveGal    = 10;

        // DOM refs (set by _buildDOM)
        this._depInput    = null;
        this._destInput   = null;
        this._pillsEl     = null;
        this._addInput    = null;
        this._addSel      = null;
        this._routeStrEl  = null;
        this._ctxMenu     = null;
        this._ctxMenuIdx  = null;
        this._altInput    = null;
        this._reserveInput = null;

        // Drag state
        this._dragIdx = null;
    }

    /** Build DOM, wire events, start building airway graph. */
    init() {
        this._loadOpts();
        this._buildDOM();
        this._startBuildPlanner();
    }

    /** Load plan into pill editor and show. Called by app.openRoutePlanner(plan). */
    open(plan) {
        this._loadPlan(plan);
        this._render();
    }

    /** Clear state. Called by app.closeRoutePlanner(). */
    close() {
        this._route       = [];
        this._insertIndex = null;
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    _loadOpts() {
        try {
            const saved = JSON.parse(localStorage.getItem('flypi_planner_opts') || '{}');
            if (saved.altitude      != null) this._altitude      = saved.altitude;
            if (saved.maxLegHrs     != null) this._maxLegHrs     = saved.maxLegHrs;
            if (saved.selfServeOnly != null) this._selfServeOnly = saved.selfServeOnly;
            if (saved.reserveGal    != null) this._reserveGal    = saved.reserveGal;
        } catch {}
    }

    _saveOpts() {
        try {
            localStorage.setItem('flypi_planner_opts', JSON.stringify({
                altitude:      this._altitude,
                maxLegHrs:     this._maxLegHrs,
                selfServeOnly: this._selfServeOnly,
                reserveGal:    this._reserveGal,
            }));
        } catch {}
    }

    // ── Plan loader ───────────────────────────────────────────────────────────

    _loadPlan(plan) {
        if (!plan) { this._route = []; return; }

        const wps = plan.waypoints || [];
        if (wps.length === 0) { this._route = []; return; }

        // Rebuild pill array from waypoints (no airway annotation at load time)
        this._route = wps.map((wp, i) => {
            const id   = wp.icao || wp.name || '?';
            let   type = 'fix';
            if (i === 0)            type = 'dep';
            else if (i === wps.length - 1) type = 'dest';
            else if (wp.type === 'APT' || (id.length === 4 && id.startsWith('K')))
                type = 'fix'; // intermediate airport
            return { id, type };
        });

        // Seed _coords from loaded plan so Apply works without re-running plan()
        for (const wp of wps) {
            const id = wp.icao || wp.name;
            if (id && wp.lat != null && wp.lon != null)
                this._coords[id] = { lat: wp.lat, lon: wp.lon };
        }

        // Sync DEP/DEST inputs
        if (this._depInput && wps.length > 0)
            this._depInput.value = wps[0].icao || wps[0].name || '';
        if (this._destInput && wps.length > 1)
            this._destInput.value = wps[wps.length - 1].icao || wps[wps.length - 1].name || '';
    }

    // ── Async planner build ───────────────────────────────────────────────────

    _startBuildPlanner() {
        // Build RoutePlanner (opens IDB + warms airway graph) in background.
        // Plan button waits for this._planner to be non-null.
        this._nasrVersion = localStorage.getItem('flypi_nasr_version') || '';
        if (typeof RoutePlanner === 'undefined') return;
        new RoutePlanner('FlyTabDB').init()
            .then(p => { this._planner = p; })
            .catch(err => console.warn('[RoutePlannerPanel] planner init failed:', err));
    }

    _checkPlannerVersion() {
        const current = localStorage.getItem('flypi_nasr_version') || '';
        if (current !== this._nasrVersion) {
            this._nasrVersion = current;
            this._planner = null;
            this._startBuildPlanner();
        }
    }

    // ── DOM builder ───────────────────────────────────────────────────────────

    _buildDOM() {
        this._el.innerHTML = '';

        const inner = document.createElement('div');
        inner.className = 'rpp-inner';

        // DEP / DEST row
        inner.appendChild(this._buildDepDestRow());

        // Planning options row
        inner.appendChild(this._buildOptsRow());

        // Pill box
        const pillBox = document.createElement('div');
        pillBox.className = 'rpp-pill-box';
        this._pillsEl = document.createElement('div');
        this._pillsEl.className = 'rpp-pills';
        pillBox.appendChild(this._pillsEl);
        inner.appendChild(pillBox);

        // Add-input row
        inner.appendChild(this._buildAddRow());

        // Toolbar: Paste | Plan | Clear | Copy
        inner.appendChild(this._buildToolbar());

        // Route string
        const routeLabel = document.createElement('div');
        routeLabel.className = 'rpp-route-label';
        routeLabel.textContent = 'Route string';
        inner.appendChild(routeLabel);

        this._routeStrEl = document.createElement('div');
        this._routeStrEl.className = 'rpp-route-str';
        inner.appendChild(this._routeStrEl);

        this._el.appendChild(inner);

        // Context menu (appended to body so it floats above everything)
        this._buildContextMenu();
    }

    _buildDepDestRow() {
        const row = document.createElement('div');
        row.className = 'rpp-dep-row';

        const depField = document.createElement('div');
        depField.className = 'rpp-icao-field';
        depField.innerHTML = '<label>Departure</label>';
        this._depInput = document.createElement('input');
        this._depInput.maxLength = 5;
        this._depInput.placeholder = 'ICAO';
        depField.appendChild(this._depInput);

        const arrow = document.createElement('div');
        arrow.className = 'rpp-arrow-sep';
        arrow.textContent = '→';

        const destField = document.createElement('div');
        destField.className = 'rpp-icao-field';
        destField.innerHTML = '<label>Destination</label>';
        this._destInput = document.createElement('input');
        this._destInput.maxLength = 5;
        this._destInput.placeholder = 'ICAO';
        destField.appendChild(this._destInput);

        row.appendChild(depField);
        row.appendChild(arrow);
        row.appendChild(destField);

        // Sync DEP/DEST inputs → first/last pill
        this._depInput.addEventListener('change', () => {
            const v = this._depInput.value.trim().toUpperCase();
            if (!v) return;
            this._depInput.value = v;
            if (this._route.length > 0) this._route[0] = { id: v, type: 'dep' };
            else this._route.unshift({ id: v, type: 'dep' });
            this._render();
        });
        this._destInput.addEventListener('change', () => {
            const v = this._destInput.value.trim().toUpperCase();
            if (!v) return;
            this._destInput.value = v;
            if (this._route.length > 1) this._route[this._route.length - 1] = { id: v, type: 'dest' };
            else this._route.push({ id: v, type: 'dest' });
            this._render();
        });

        return row;
    }

    _buildOptsRow() {
        const row = document.createElement('div');
        row.className = 'rpp-opts-row';

        // Altitude
        const altLabel = document.createElement('span');
        altLabel.className = 'rpp-opts-label';
        altLabel.textContent = 'Alt';
        this._altInput = document.createElement('input');
        this._altInput.className = 'rpp-alt-input';
        this._altInput.type = 'number';
        this._altInput.min = '500';
        this._altInput.max = '17500';
        this._altInput.step = '500';
        this._altInput.value = this._altitude;
        const altSuffix = document.createElement('span');
        altSuffix.className = 'rpp-opts-label';
        altSuffix.textContent = 'ft';
        this._altInput.addEventListener('change', () => {
            this._altitude = parseInt(this._altInput.value, 10) || 5500;
            this._saveOpts();
        });

        // Max leg buttons
        const legLabel = document.createElement('span');
        legLabel.className = 'rpp-opts-label';
        legLabel.textContent = 'Leg';
        const legBtns = document.createElement('div');
        legBtns.className = 'rpp-leg-btns';
        [2.0, 2.5, 3.0].forEach(hrs => {
            const btn = document.createElement('button');
            btn.className = 'rpp-leg-btn' + (this._maxLegHrs === hrs ? ' active' : '');
            btn.textContent = hrs === 2.0 ? '2h' : hrs === 2.5 ? '2.5h' : '3h';
            btn.dataset.hrs = hrs;
            wireTap(btn, () => {
                this._maxLegHrs = hrs;
                this._saveOpts();
                legBtns.querySelectorAll('.rpp-leg-btn').forEach(b =>
                    b.classList.toggle('active', parseFloat(b.dataset.hrs) === hrs));
            });
            legBtns.appendChild(btn);
        });

        // Self-serve checkbox
        const ssLabel = document.createElement('label');
        ssLabel.className = 'rpp-check-row';
        const ssCheck = document.createElement('input');
        ssCheck.type = 'checkbox';
        ssCheck.checked = this._selfServeOnly;
        ssCheck.addEventListener('change', () => {
            this._selfServeOnly = ssCheck.checked;
            this._saveOpts();
        });
        ssLabel.appendChild(ssCheck);
        ssLabel.appendChild(document.createTextNode('Self-serve'));

        // Reserve gallon input
        const rsvLabel = document.createElement('span');
        rsvLabel.className = 'rpp-opts-label';
        rsvLabel.textContent = 'Rsv';
        this._reserveInput = document.createElement('input');
        this._reserveInput.className = 'rpp-reserve-input';
        this._reserveInput.type = 'number';
        this._reserveInput.min = '1';
        this._reserveInput.max = '30';
        this._reserveInput.value = this._reserveGal;
        const rsvSuffix = document.createElement('span');
        rsvSuffix.className = 'rpp-opts-label';
        rsvSuffix.textContent = 'gal';
        this._reserveInput.addEventListener('change', () => {
            this._reserveGal = parseInt(this._reserveInput.value, 10) || 10;
            this._saveOpts();
        });

        row.appendChild(altLabel);
        row.appendChild(this._altInput);
        row.appendChild(altSuffix);
        row.appendChild(legLabel);
        row.appendChild(legBtns);
        row.appendChild(ssLabel);
        row.appendChild(rsvLabel);
        row.appendChild(this._reserveInput);
        row.appendChild(rsvSuffix);

        return row;
    }

    _buildAddRow() {
        const row = document.createElement('div');
        row.className = 'rpp-add-row';

        this._addInput = document.createElement('input');
        this._addInput.className = 'rpp-add-input';
        this._addInput.placeholder = 'Fix or airway (e.g. RIC, V3)';

        this._addSel = document.createElement('select');
        this._addSel.className = 'rpp-add-sel';
        [['fix','Fix'],['awy','Airway'],['direct','Direct']].forEach(([v,t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            this._addSel.appendChild(o);
        });

        const addBtn = document.createElement('button');
        addBtn.className = 'rpp-add-btn';
        addBtn.textContent = '+ Add';

        wireTap(addBtn, () => this._onAddTap());
        this._addInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') this._onAddTap();
        });

        row.appendChild(this._addInput);
        row.appendChild(this._addSel);
        row.appendChild(addBtn);

        return row;
    }

    _buildToolbar() {
        const bar = document.createElement('div');
        bar.className = 'rpp-toolbar';

        const mkBtn = (label, handler, extraClass = '') => {
            const btn = document.createElement('button');
            btn.className = 'rpp-tbtn' + (extraClass ? ' ' + extraClass : '');
            btn.textContent = label;
            wireTap(btn, handler);
            return btn;
        };

        bar.appendChild(mkBtn('Paste',       () => this._onPasteTap()));
        bar.appendChild(mkBtn('Plan',        () => this._onPlanTap()));
        bar.appendChild(mkBtn('Clear',       () => this._onClearTap()));
        bar.appendChild(mkBtn('Copy',        () => this._onCopyTap()));

        // Apply button on its own row (full-width, prominent)
        const applyBar = document.createElement('div');
        applyBar.className = 'rpp-toolbar';
        applyBar.appendChild(mkBtn('Apply & Close', () => this._onApplyTap(), 'rpp-tbtn-apply'));

        // Return a fragment with both bars
        const frag = document.createDocumentFragment();
        frag.appendChild(bar);
        frag.appendChild(applyBar);
        return frag;
    }

    _buildContextMenu() {
        this._ctxMenu = document.createElement('div');
        this._ctxMenu.className = 'rpp-menu';
        this._ctxMenu.innerHTML = `
            <div class="rpp-menu-label" id="rppMenuTitle">Waypoint</div>
            <div class="rpp-menu-sep"></div>
            <div class="rpp-menu-item" id="rppMInsertBefore">Insert before</div>
            <div class="rpp-menu-item" id="rppMInsertAfter">Insert after</div>
            <div class="rpp-menu-sep"></div>
            <div class="rpp-menu-item" id="rppMChangeType">Change type</div>
            <div class="rpp-menu-sep"></div>
            <div class="rpp-menu-item danger" id="rppMDelete">Remove</div>
        `;
        document.body.appendChild(this._ctxMenu);

        document.addEventListener('click', () => this._closeMenu());
        this._ctxMenu.addEventListener('click', e => e.stopPropagation());

        this._ctxMenu.querySelector('#rppMDelete').addEventListener('click', () => {
            if (this._ctxMenuIdx !== null) this._route.splice(this._ctxMenuIdx, 1);
            this._closeMenu(); this._render();
        });
        this._ctxMenu.querySelector('#rppMInsertBefore').addEventListener('click', () => {
            const i = this._ctxMenuIdx; this._closeMenu();
            if (i !== null) { this._insertIndex = i; this._addInput.focus(); }
        });
        this._ctxMenu.querySelector('#rppMInsertAfter').addEventListener('click', () => {
            const i = this._ctxMenuIdx; this._closeMenu();
            if (i !== null) { this._insertIndex = i + 1; this._addInput.focus(); }
        });
        this._ctxMenu.querySelector('#rppMChangeType').addEventListener('click', () => {
            if (this._ctxMenuIdx === null) { this._closeMenu(); return; }
            const types = ['fix','awy','direct','dep','dest','fuel'];
            const cur = this._route[this._ctxMenuIdx].type;
            this._route[this._ctxMenuIdx].type = types[(types.indexOf(cur) + 1) % types.length];
            this._closeMenu(); this._render();
        });
    }

    _openMenu(e, idx) {
        this._ctxMenuIdx = idx;
        const item = this._route[idx];
        this._ctxMenu.querySelector('#rppMenuTitle').textContent =
            item.id + ' · ' + item.type.toUpperCase();
        this._ctxMenu.classList.add('open');
        const x = Math.min((e.clientX || e.pageX || 0), window.innerWidth  - 180);
        const y = Math.min((e.clientY || e.pageY || 0) + 8, window.innerHeight - 180);
        this._ctxMenu.style.left = x + 'px';
        this._ctxMenu.style.top  = y + 'px';
    }

    _closeMenu() {
        this._ctxMenu.classList.remove('open');
        this._ctxMenuIdx = null;
    }

    // ── Render ────────────────────────────────────────────────────────────────

    _render() {
        this._renderPills();
        this._renderRouteStr();
    }

    _renderRouteStr() {
        if (this._routeStrEl)
            this._routeStrEl.textContent = this._route.map(r => r.id).join(' ');
    }

    _renderPills() {
        if (!this._pillsEl) return;
        this._pillsEl.innerHTML = '';

        this._route.forEach((item, i) => {
            const pill = this._buildPill(item, i);
            this._pillsEl.appendChild(pill);
        });
    }

    _pillClass(type) {
        return {
            fix: 'rpp-pill-fix', awy: 'rpp-pill-awy', direct: 'rpp-pill-direct',
            dep: 'rpp-pill-dep', dest: 'rpp-pill-dest', fuel: 'rpp-pill-fuel',
        }[type] || 'rpp-pill-fix';
    }

    _typeLabel(type) {
        return { fix: 'FIX', awy: 'AWY', direct: 'GPS', dep: 'DEP', dest: 'DEST', fuel: '⛽' }[type] || '';
    }

    _buildPill(item, i) {
        const pill = document.createElement('div');
        pill.className = 'rpp-pill ' + this._pillClass(item.type);
        pill.dataset.idx = i;

        const handle = document.createElement('span');
        handle.className = 'rpp-pill-handle';
        handle.textContent = '⠿';

        const label = document.createTextNode(item.id);

        const badge = document.createElement('span');
        badge.className = 'rpp-type-badge';
        badge.textContent = this._typeLabel(item.type);

        const del = document.createElement('span');
        del.className = 'rpp-pill-del';
        del.title = 'Remove';
        del.textContent = '✕';
        del.addEventListener('click', e => {
            e.stopPropagation();
            this._route.splice(i, 1);
            this._render();
        });

        pill.appendChild(handle);
        pill.appendChild(label);
        pill.appendChild(badge);
        pill.appendChild(del);

        // Context menu on right-click and long-press
        pill.addEventListener('contextmenu', e => { e.preventDefault(); this._openMenu(e, i); });
        this._wireLongPress(pill, i);

        // Touch drag on handle
        this._wireDragHandle(handle, i);

        return pill;
    }

    _wireLongPress(pill, idx) {
        let timer = null;
        pill.addEventListener('touchstart', e => {
            timer = setTimeout(() => this._openMenu(e.touches[0], idx), 400);
        }, { passive: true });
        pill.addEventListener('touchend',   () => clearTimeout(timer), { passive: true });
        pill.addEventListener('touchmove',  () => clearTimeout(timer), { passive: true });
    }

    // ── Touch drag handle (2D nearest-center slot detection) ──────────────────

    _wireDragHandle(handleEl, idx) {
        let ghost = null;
        let dropTarget = null;  // {idx, before}

        const allPills = () => Array.from(this._pillsEl.querySelectorAll('.rpp-pill'));

        handleEl.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const t = e.touches[0];
            this._dragIdx = idx;

            const pill = handleEl.closest('.rpp-pill');
            pill.classList.add('dragging');

            ghost = pill.cloneNode(true);
            const r = pill.getBoundingClientRect();
            ghost.style.cssText = [
                'position:fixed', 'opacity:0.75', 'pointer-events:none', 'z-index:9999',
                `left:${r.left}px`, `top:${r.top}px`, `width:${r.width}px`,
                'box-shadow:0 4px 14px rgba(0,0,0,.22)', 'transition:none',
            ].join(';');
            document.body.appendChild(ghost);
        }, { passive: false });

        handleEl.addEventListener('touchmove', (e) => {
            if (this._dragIdx === null) return;
            e.preventDefault();
            const t = e.touches[0];

            ghost.style.left = (t.clientX - ghost.offsetWidth / 2) + 'px';
            ghost.style.top  = (t.clientY - 16) + 'px';

            let nearestEl = null, nearestDist = Infinity, nearestIdx = -1, nearestBefore = true;
            allPills().forEach((p, i) => {
                if (i === this._dragIdx) return;
                const r  = p.getBoundingClientRect();
                const cx = r.left + r.width  / 2;
                const cy = r.top  + r.height / 2;
                const dist = Math.hypot(t.clientX - cx, t.clientY - cy);
                if (dist < nearestDist) {
                    nearestDist   = dist;
                    nearestEl     = p;
                    nearestIdx    = i;
                    nearestBefore = t.clientX < cx;
                }
            });

            allPills().forEach(p => p.classList.remove('drag-over-left', 'drag-over-right'));

            if (nearestEl) {
                nearestEl.classList.add(nearestBefore ? 'drag-over-left' : 'drag-over-right');
                dropTarget = { idx: nearestIdx, before: nearestBefore };
            } else {
                dropTarget = null;
            }
        }, { passive: false });

        handleEl.addEventListener('touchend', () => {
            if (this._dragIdx === null) return;

            ghost?.remove();
            ghost = null;
            allPills().forEach(p =>
                p.classList.remove('dragging', 'drag-over-left', 'drag-over-right'));

            if (dropTarget !== null) {
                const from = this._dragIdx;
                const item = this._route.splice(from, 1)[0];
                let insertAt = dropTarget.before ? dropTarget.idx : dropTarget.idx + 1;
                if (from < insertAt) insertAt--;
                this._route.splice(Math.max(0, Math.min(insertAt, this._route.length)), 0, item);
            }

            this._dragIdx = null;
            dropTarget    = null;
            this._render();
        }, { passive: true });
    }

    // ── Add input handler ─────────────────────────────────────────────────────

    _onAddTap() {
        const v = this._addInput.value.trim().toUpperCase();
        if (!v) return;

        let type = this._addSel.value;
        // Auto-detect: override select if input looks like a known type
        if (v === 'DIRECT') type = 'direct';
        else if (/^[VT]\d/.test(v)) type = 'awy';

        // Determine insertion index
        let at;
        if (this._insertIndex !== null) {
            at = this._insertIndex;
            this._insertIndex = null;
        } else {
            // Default: insert before last pill (destination)
            at = Math.max(0, this._route.length - 1);
        }

        this._route.splice(at, 0, { id: v, type });
        this._addInput.value = '';
        this._render();
    }

    // ── Toolbar handlers ──────────────────────────────────────────────────────

    _onClearTap() {
        const dep  = this._depInput?.value.trim().toUpperCase()  || '';
        const dest = this._destInput?.value.trim().toUpperCase() || '';
        this._route = [];
        if (dep)  this._route.push({ id: dep,  type: 'dep'  });
        if (dest) this._route.push({ id: dest, type: 'dest' });
        this._insertIndex = null;
        this._render();
    }

    _onCopyTap() {
        const str = this._route.map(r => r.id).join(' ');
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(str).catch(() => this._selectRouteStr());
        } else {
            this._selectRouteStr();
        }
    }

    _selectRouteStr() {
        if (!this._routeStrEl) return;
        const range = document.createRange();
        range.selectNode(this._routeStrEl);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    }

    // ── Plan button ───────────────────────────────────────────────────────────

    async _onPlanTap() {
        const dep  = this._depInput?.value.trim().toUpperCase();
        const dest = this._destInput?.value.trim().toUpperCase();
        if (!dep || !dest) {
            this._toast('Enter departure and destination');
            return;
        }

        this._checkPlannerVersion();

        if (!this._planner) {
            this._toast('Route planner loading — try again in a moment');
            return;
        }

        this._toast('Planning route…', 0);
        try {
            const result = await this._planner.plan({
                departure:       dep,
                destination:     dest,
                preferredLegHrs: this._maxLegHrs,
                reserveGal:      this._reserveGal,
                selfServeOnly:   this._selfServeOnly,
            });

            // Cache all fix coordinates returned by the planner
            if (result.waypoints) {
                for (const wp of result.waypoints) {
                    if (wp.fix && wp.lat != null)
                        this._coords[wp.fix] = { lat: wp.lat, lon: wp.lon };
                }
            }

            this._route = this._resultToPills(dep, dest, result);
            this._depInput.value  = dep;
            this._destInput.value = dest;
            this._render();
            this._toast('Route planned');
        } catch (err) {
            console.error('[RoutePlannerPanel] plan() failed:', err);
            this._toast('Could not plan route: ' + (err.message || err));
        }
    }

    _resultToPills(dep, dest, result) {
        const pills = [];
        const routeLegs = result.routeLegs || result.legs || [];

        pills.push({ id: dep, type: 'dep' });

        // Build from routeLegs: each leg has from→to and airway
        for (let i = 0; i < routeLegs.length; i++) {
            const leg = routeLegs[i];
            // Insert airway pill if this leg uses a named airway
            if (leg.airway && leg.airway !== 'DIRECT' &&
                (pills.length === 0 || pills[pills.length - 1].id !== leg.airway))
                pills.push({ id: leg.airway, type: 'awy' });

            // Insert the 'to' fix unless it's the destination (added at the end)
            if (leg.to && leg.to !== dest) {
                // Mark as fuel stop if it appears in fuelStops
                const isFuel = (result.fuelStops || []).some(fs => fs.icao === leg.to);
                pills.push({ id: leg.to, type: isFuel ? 'fuel' : 'fix' });
            }
        }

        pills.push({ id: dest, type: 'dest' });
        return pills;
    }

    // ── Paste button ──────────────────────────────────────────────────────────

    async _onPasteTap() {
        let str = '';
        try {
            if (navigator.clipboard?.readText) {
                str = await navigator.clipboard.readText();
            }
        } catch {}

        if (!str.trim()) {
            str = await this._promptPasteModal();
            if (!str) return;
        }

        const pills = this._parsePasteStr(str.trim());
        if (pills.length < 2) {
            this._toast('Could not parse route — need at least 2 tokens');
            return;
        }

        if (this._route.length > 0) {
            const ok = await this._confirm('Replace current route with pasted route?');
            if (!ok) return;
        }

        this._route = pills;
        this._depInput.value  = pills[0].id;
        this._destInput.value = pills[pills.length - 1].id;
        this._render();
    }

    _parsePasteStr(str) {
        const tokens = str.split(/\s+/).filter(Boolean).map(t => t.toUpperCase());
        return tokens.map((t, i) => {
            let type;
            if (i === 0)                       type = 'dep';
            else if (i === tokens.length - 1)  type = 'dest';
            else if (/^[VT]\d/.test(t))        type = 'awy';
            else if (t === 'DIRECT')            type = 'direct';
            else                               type = 'fix';
            return { id: t, type };
        });
    }

    _promptPasteModal() {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = [
                'position:fixed','inset:0','background:rgba(0,0,0,.5)',
                'z-index:10000','display:flex','align-items:center','justify-content:center',
            ].join(';');

            const box = document.createElement('div');
            box.style.cssText = 'background:#fff;border-radius:12px;padding:20px;width:90%;max-width:480px';
            box.innerHTML = `
                <div style="font-size:13px;font-weight:700;margin-bottom:10px">Paste route string</div>
                <textarea rows="4" style="width:100%;font-family:inherit;font-size:13px;border:1.5px solid #b0bac6;border-radius:8px;padding:8px;text-transform:uppercase;resize:none;outline:none" placeholder="KLKR GSO V225 RIC V268 ESN KMHT"></textarea>
                <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
                    <button id="rppPasteCancel" style="padding:8px 16px;border:1.5px solid #b0bac6;border-radius:8px;background:#fff;font-family:inherit;cursor:pointer">Cancel</button>
                    <button id="rppPasteOk" style="padding:8px 16px;border:none;border-radius:8px;background:#1a6fbb;color:#fff;font-family:inherit;font-weight:700;cursor:pointer">Use Route</button>
                </div>
            `;
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const ta = box.querySelector('textarea');
            ta.focus();

            box.querySelector('#rppPasteOk').addEventListener('click', () => {
                overlay.remove();
                resolve(ta.value);
            });
            box.querySelector('#rppPasteCancel').addEventListener('click', () => {
                overlay.remove();
                resolve('');
            });
        });
    }

    // ── Apply button ──────────────────────────────────────────────────────────

    async _onApplyTap() {
        const wps = await this._pillsToWaypoints();
        if (wps.length < 2) {
            this._toast('Add at least 2 waypoints');
            return;
        }

        const dep  = wps[0].icao  || wps[0].name;
        const dest = wps[wps.length - 1].icao || wps[wps.length - 1].name;

        const plan = {
            departure:       dep,
            destination:     dest,
            cruise_altitude: this._altitude,
            waypoints:       wps,
            flight_plan: {
                departure,
                destination: dest,
                route: this._route.map(r => r.id),
                legs:  [],
            },
        };

        if (typeof app !== 'undefined') {
            await app.applyRouteEdit(plan);
            app.closeRoutePlanner();
        }
    }

    async _pillsToWaypoints() {
        const wps = [];
        const skipped = [];

        for (const pill of this._route) {
            // Airway pills don't become waypoints
            if (pill.type === 'awy') continue;

            const id = pill.id;
            let coord = this._coords[id];

            if (!coord && this._nasrDb) {
                // Try IDB: airport → navaid → fix
                let rec = await this._nasrDb.getAirport(id).catch(() => null);
                if (!rec) rec = await this._nasrDb.getNavaid(id).catch(() => null);
                if (!rec) rec = await this._nasrDb.getFix(id).catch(() => null);
                if (rec?.lat != null) {
                    coord = { lat: rec.lat, lon: rec.lon };
                    this._coords[id] = coord;
                }
            }

            if (!coord) {
                skipped.push(id);
                continue;
            }

            wps.push({
                icao: id,
                name: id,
                lat:  coord.lat,
                lon:  coord.lon,
                type: pill.type === 'dep'  ? 'APT' :
                      pill.type === 'dest' ? 'APT' :
                      pill.type === 'fuel' ? 'APT' : undefined,
                alt: this._altitude,
            });
        }

        if (skipped.length > 0)
            this._toast(`Skipped (not found): ${skipped.join(', ')}`);

        return wps;
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    _toast(msg, duration = 2500) {
        const existing = document.getElementById('rppToast');
        if (existing) existing.remove();

        const el = document.createElement('div');
        el.id = 'rppToast';
        el.style.cssText = [
            'position:fixed','bottom:80px','left:50%','transform:translateX(-50%)',
            'background:rgba(10,12,15,.85)','color:#fff','border-radius:8px',
            'padding:10px 18px','font-size:13px','z-index:10001',
            'font-family:\'SF Mono\',monospace','pointer-events:none',
        ].join(';');
        el.textContent = msg;
        document.body.appendChild(el);

        if (duration > 0) setTimeout(() => el.remove(), duration);
    }

    _confirm(msg) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = [
                'position:fixed','inset:0','background:rgba(0,0,0,.4)',
                'z-index:10000','display:flex','align-items:center','justify-content:center',
            ].join(';');
            const box = document.createElement('div');
            box.style.cssText = 'background:#fff;border-radius:12px;padding:20px;max-width:320px;width:90%;text-align:center';
            box.innerHTML = `
                <p style="font-size:14px;margin-bottom:16px">${msg}</p>
                <div style="display:flex;gap:8px;justify-content:center">
                    <button id="rppCfNo"  style="padding:8px 20px;border:1.5px solid #b0bac6;border-radius:8px;background:#fff;font-family:inherit;cursor:pointer">Cancel</button>
                    <button id="rppCfYes" style="padding:8px 20px;border:none;border-radius:8px;background:#1a6fbb;color:#fff;font-family:inherit;font-weight:700;cursor:pointer">Replace</button>
                </div>
            `;
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            box.querySelector('#rppCfYes').addEventListener('click', () => { overlay.remove(); resolve(true);  });
            box.querySelector('#rppCfNo' ).addEventListener('click', () => { overlay.remove(); resolve(false); });
        });
    }
}
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node --check web/cockpit/route-planner-panel.js
# Expected: no output (syntax OK)
```

- [ ] **Step 3: Commit**

```bash
cd ~/flytab
git add web/cockpit/route-planner-panel.js
git commit -m "feat: implement RoutePlannerPanel — pill editor, drag, plan/paste/apply"
```

---

### Task 6: Wire `app.js` — replace all `routeEditor` with `routePlannerPanel`

**Files:**
- Modify: `web/app.js`

This task has many changes across the file. Follow each step precisely; the full file context is in the conversation.

- [ ] **Step 1: Replace `this.routeEditor = null` in the constructor**

Find (line ~61):
```javascript
        this.routeEditor = null;
```

Replace with:
```javascript
        this.routePlannerPanel = null;
```

- [ ] **Step 2: Add `openRoutePlanner` and `closeRoutePlanner` methods**

Find the line `async applyRouteEdit(plan, { fromRouteTable = false } = {}) {` (around line 1079) and insert immediately **before** it:

```javascript
    openRoutePlanner(plan) {
        document.getElementById('cockpitContainer').classList.add('route-editing');
        this.routePlannerPanel?.open(plan || this._currentTrip);
        setTimeout(() => this.cockpitMap?.getMap()?.invalidateSize(), 300);
    }

    closeRoutePlanner() {
        document.getElementById('cockpitContainer').classList.remove('route-editing');
        this.routePlannerPanel?.close();
        setTimeout(() => this.cockpitMap?.getMap()?.invalidateSize(), 300);
    }

```

Also add a `window` resize listener to re-invalidate while the editor is open. In the `init()` method, after `this._startWatchdog();`, add:

```javascript
        window.addEventListener('resize', () => {
            if (document.getElementById('cockpitContainer')?.classList.contains('route-editing'))
                setTimeout(() => this.cockpitMap?.getMap()?.invalidateSize(), 50);
        });
```

- [ ] **Step 3: Replace route editor construction block**

Find (around line 783):
```javascript
        // Route editor (NasrDB lazy-opens on first query)
        this.routeEditor = new RouteEditor(
            document.body, nasrDb, this.stratuxClient, this.cockpitMap
        );
        this.routeEditor.init();

        // Wire route table EDIT button to route editor
        if (this.routeTable) {
            this.routeTable.setRouteEditor(this.routeEditor);
        }

        // Wire airport popup Direct-To to route editor
        if (this.airportPopup && this.routeEditor) {
            this.airportPopup.onDirectTo((apt) => {
                this.routeEditor._executeDirectTo(apt);
            });
        }
```

Replace with:
```javascript
        // Route planner panel
        if (typeof RoutePlannerPanel !== 'undefined') {
            this.routePlannerPanel = new RoutePlannerPanel(
                document.getElementById('routePlannerPanel'), nasrDb
            );
            this.routePlannerPanel.init();
        }
```

- [ ] **Step 4: Remove the `everywhereSearch.setRouteEditor` call**

Find (around line 841):
```javascript
            if (this.routeEditor)    this.everywhereSearch.setRouteEditor(this.routeEditor);
```

Delete that line.

- [ ] **Step 5: Fix the three `isVisible()` guards on map click handlers**

Find these three guards (around lines 426, 439, 452):
```javascript
                    if (this.routeEditor?.isVisible()) return;
```
All three occurrences — replace each with:
```javascript
                    if (document.getElementById('cockpitContainer')?.classList.contains('route-editing')) return;
```

- [ ] **Step 6: Replace the `routeEditor.loadRoute` call and drift check in `_applyPlan`**

Find (around lines 1253–1259):
```javascript
        if (this.routeEditor) this.routeEditor.loadRoute(normalized);

        if (!skipRouteTable && this.routeTable && this.routeEditor) {
            const tLen = this.routeTable._waypoints?.length;
            const eLen = this.routeEditor._waypoints?.length;
            if (tLen !== eLen)
                DiagLog.log('plan', `state-drift: routeTable(${tLen}) ≠ routeEditor(${eLen})`);
        }
```

Replace with:
```javascript
        // routePlannerPanel syncs via open() when the pilot explicitly opens it;
        // no live-sync needed while the panel is closed.
```

- [ ] **Step 7: Replace the `cifp:load-procedure` handler**

Find the block (around line 697):
```javascript
            document.addEventListener('cifp:load-procedure', (e) => {
                const { icao, insertBefore = [], insertAfter = [], airportWp } = e.detail;
                if (!this.routeEditor) return;
                // ... all the routeEditor._addWaypoint and ._applyRoute calls
            });
```

Replace the entire block with:
```javascript
            document.addEventListener('cifp:load-procedure', (e) => {
                // Approach procedure insertion via route planner panel not yet implemented (Stage 2).
                console.log('[FlyTab] cifp:load-procedure received — Stage 2 feature', e.detail?.icao);
            });
```

- [ ] **Step 8: Verify no remaining `routeEditor` references**

```bash
grep -n "routeEditor" ~/flytab/web/app.js
# Expected: no output
```

- [ ] **Step 9: Build and smoke-test**

```bash
cd ~/flytab
# Increment FLYTAB_VERSION in web/app.js (e.g., v7.03 → v7.04) then:
bash build.sh
# Expected: BUILD SUCCESSFUL, APK copied to data/
```

Install on tablet. Open cockpit. Tap the EDIT button on the route table — the panel should appear below (portrait) or to the left (landscape) of the map. Tap Apply & Close — panel should hide and map should resize.

- [ ] **Step 10: Commit**

```bash
cd ~/flytab
git add web/app.js
git commit -m "feat: wire RoutePlannerPanel in app.js; add openRoutePlanner/closeRoutePlanner; remove all routeEditor refs"
```

---

### Task 7: Delete old files, final build, verify

**Files:**
- Delete: `web/cockpit/route-editor.js`
- Delete: `routeEditor.html` (repo root)
- Delete: `routePlanner.js` (repo root)

- [ ] **Step 1: Delete the three old files**

```bash
cd ~/flytab
git rm web/cockpit/route-editor.js
git rm routeEditor.html
git rm routePlanner.js
```

- [ ] **Step 2: Verify nothing imports the deleted files**

```bash
grep -rn "route-editor\|routeEditor\.html\|routePlanner\.js" ~/flytab/web/
# Expected: no output (index.html already updated in Task 3)
```

- [ ] **Step 3: Bump FLYTAB_VERSION and build final APK**

In `web/app.js`, increment `FLYTAB_VERSION` (e.g., `v7.03` → `v7.04`).

```bash
cd ~/flytab
bash build.sh
# Expected: BUILD SUCCESSFUL
```

- [ ] **Step 4: End-to-end verification checklist**

Install APK on tablet. Run through these scenarios:

```
□ Tap EDIT on route table → panel appears, map shrinks
□ Portrait: panel below map (40% height)
□ Landscape: panel left (40% width), map right — right sidebar still reachable
□ Rotate tablet while editor open → layout reflows without map blank spot
□ DEP/DEST inputs update first/last pill
□ + Add button inserts before last pill; select type works
□ Drag handle on a pill → ghost follows finger freely in 2D; drop reorders pills
□ Long-press on pill → context menu appears; Insert Before/After focuses add-input
□ Clear → resets to just DEP and DEST pills
□ Plan button with valid DEP/DEST → pills populate with airways and fixes
□ Fuel stop airports appear as orange fuel pills when max-leg constraint splits the route
□ Paste with clipboard content → pills replace; prompts confirm if non-empty
□ Paste with no clipboard → modal textarea appears
□ Apply & Close → route-table and map update; panel hides; map full-width
□ Planning opts (altitude, leg hours, self-serve, reserve) persist across open/close
□ Copy → route string lands in clipboard
```

- [ ] **Step 5: Final commit**

```bash
cd ~/flytab
git add web/app.js  # version bump
git commit -m "feat: delete route-editor.js, routeEditor.html, routePlanner.js; bump to v7.04"
```
