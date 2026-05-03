# Route Planner Integration — Design Spec
**Date:** 2026-05-02
**Project:** flytab
**Status:** Approved

---

## Goal

Replace the unstable overlay-based `route-editor.js` with a new `RoutePlannerPanel` that:
- Occupies a dedicated layout slot alongside the map (no touch overlap)
- Integrates `routePlanner.js` (A* airway routing) and `routeEditor.html` (pill-based manual editor) as a unified ground planning tool
- Feeds the existing route display components via `app.applyRouteEdit(plan)` unchanged

---

## Root Cause of Existing Instability

- `RouteEditor` is a slide-up overlay on top of the map — touch events bleed between layers
- `direct-to-modal` appended separately to `document.body` — a second floating conflict layer
- State drift between `routeTable._waypoints` and `routeEditor._waypoints` required active detection in `app.js`
- `_parseSeq` counter to discard stale async results — symptom of race conditions in the search path
- Three event listeners on search input with `setTimeout` paste workarounds — fragile on Android

---

## Layout

### Trigger
The pilot opens the route planner by tapping an **"Edit Route"** button on the route display (`route-table.js`). This calls `app.openRoutePlanner(currentPlan)`. A close/apply button inside the panel calls `app.closeRoutePlanner()`.

### CSS layout switch
`app.js` toggles class `.route-editing` on `#cockpitContainer`. The map and panel are in separate CSS grid cells — physically distinct touch zones, no event capture tricks needed.

```css
/* Portrait: map top 60%, editor bottom 40% */
.route-editing #cockpitContainer {
    display: grid;
    grid-template-rows: 60fr 40fr;
    grid-template-columns: 1fr;
    height: 100%;
}
.route-editing #routePlannerPanel { grid-row: 2; grid-column: 1; }

/* Landscape: editor left 40%, map right 60%
   Right sidebar (airport info, plates, weather) overlays the right 60% —
   pilot can tap an airport while route editor is open */
@media (orientation: landscape) {
    .route-editing #cockpitContainer {
        grid-template-rows: 1fr;
        grid-template-columns: 40fr 60fr;
    }
    .route-editing #routePlannerPanel { grid-row: 1; grid-column: 1; }
    .route-editing #mapContainer      { grid-row: 1; grid-column: 2; }
}

#routePlannerPanel { display: none; overflow-y: auto; }
.route-editing #routePlannerPanel { display: block; }
```

### Map resize
`map.invalidateSize()` fires 300 ms after `.route-editing` is added or removed (after CSS transition settles). The panel also calls `invalidateSize()` on `window` resize to handle tablet rotation while the editor is open.

---

## Components

### Files created
| File | Responsibility |
|------|---------------|
| `web/shared/route-planner.js` | `routePlanner.js` moved here. Contains `AirwayGraph`, `RouteConstructor`, `FuelStopOptimizer`, `RoutePlanner` classes. No logic changes except reliability fixes (see below). Added as `<script>` in `index.html` before cockpit components. |
| `web/cockpit/route-planner-panel.js` | New class `RoutePlannerPanel`. Owns pill UI (ported from `routeEditor.html`), Plan button, Apply button, Close button. Communicates outward only via `app.applyRouteEdit()` and `app.closeRoutePlanner()`. |

### Files modified
| File | Change |
|------|--------|
| `web/style.css` | Layout grid rules above + pill editor styles (moved from `routeEditor.html` `<style>` block) |
| `web/index.html` | Add `<script>` for `route-planner.js` and `route-planner-panel.js`; remove `route-editor.js`; add `<div id="routePlannerPanel">` inside `#cockpitContainer` |
| `web/cockpit/route-table.js` | Add "Edit Route" button; on tap call `app.openRoutePlanner(this._currentPlan)` |
| `web/app.js` | Replace `this.routeEditor` with `this.routePlannerPanel`; add `openRoutePlanner(plan)` and `closeRoutePlanner()`; remove all `this.routeEditor` references |

### Files deleted
- `web/cockpit/route-editor.js`
- `routeEditor.html` (repo root)
- `routePlanner.js` (repo root)

---

## `RoutePlannerPanel` Public Interface

```javascript
class RoutePlannerPanel {
    constructor(panelEl, nasrDb)   // panelEl = #routePlannerPanel div
    init()                          // build DOM, wire events, build airway graph
    destroy()                       // remove listeners
    open(plan)                      // load plan into pill editor, called by app.openRoutePlanner()
    close()                         // clear state, called by app.closeRoutePlanner()
}
```

`app.js` additions:
```javascript
openRoutePlanner(plan) {
    document.getElementById('cockpitContainer').classList.add('route-editing');
    this.routePlannerPanel.open(plan);
    setTimeout(() => this.cockpitMap?.getMap()?.invalidateSize(), 300);
}
closeRoutePlanner() {
    document.getElementById('cockpitContainer').classList.remove('route-editing');
    this.routePlannerPanel.close();
    setTimeout(() => this.cockpitMap?.getMap()?.invalidateSize(), 300);
}
```

---

## Planning Options State

`RoutePlannerPanel` holds these user-adjustable fields (persisted to `localStorage` under key `flypi_planner_opts`):

| Field | Default | UI control |
|-------|---------|------------|
| `_altitude` | `5500` | Text input (ft MSL) |
| `_maxLegHrs` | `2.0` | 3-button toggle: `2h / 2.5h / 3h` |
| `_selfServeOnly` | `false` | Checkbox |
| `_reserveGal` | `10` | Number input (gallons) |

These are shown in a compact options row between the DEP/DEST fields and the pill box:

```
┌───────────────────────────────────────────────────────────────┐
│  DEP [____]  →  DEST [____]      Altitude [5500] ft          │
│  Max leg: [2h] [2.5h] [3h]   □ Self-serve   Reserve [10] gal │
├───────────────────────────────────────────────────────────────┤
│  pill box (flex-wrap)                                         │
│  add-input row                                                │
├───────────────────────────────────────────────────────────────┤
│  [Paste]  [Plan]  [Clear]   [Copy string]                     │
│  [Apply & Close]                                              │
└───────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### "Plan" button (auto-route)
1. Pilot enters DEP + DEST ICAO fields; adjusts planning options if needed
2. Tap "Plan" → `RoutePlanner.plan({departure, destination, preferredLegHrs: this._maxLegHrs, reserveGal: this._reserveGal, selfServeOnly: this._selfServeOnly})` (uses cached airway graph)
3. Returns `{waypoints, legs, routeString, fuelStops}`
4. `legs` converted to pills: DEP airport → `{id, type:'dep'}`, each intermediate fix → `{id, type:'fix'}`, each airway label → `{id, type:'awy'}`, DEST airport → `{id, type:'dest'}`
5. Fuel stop airports inserted as pills of type `'fuel'` at their position in the sequence
6. Pills rendered in editor; route string displayed below

### "Paste" button (import route string)
1. Read clipboard via `navigator.clipboard.readText()`. If unavailable, show a modal `<textarea>` for manual paste.
2. Parse the pasted string: split on whitespace, classify each token:
   - Matches `/^[VT]\d/` → `type:'awy'`
   - Equals `'DIRECT'` → `type:'direct'`
   - First token → `type:'dep'`
   - Last token → `type:'dest'`
   - All others → `type:'fix'`
3. If current pill list is non-empty, confirm: "Replace current route with pasted route?" (toast with Confirm / Cancel). If empty, replace immediately.
4. Set `_depInput` and `_destInput` fields from first/last token.
5. Render pills. Coordinates resolved lazily on Apply (same path as manual-only flow).

### "Apply" button (commit route)
1. Pill list → waypoint array:
   - Non-airway, non-fuel pills: coordinates from `AirwayGraph.coords[id]` (in memory from last plan) or IDB airports store for DEP/DEST
   - Airway pills: skipped (they annotate the route string, not waypoints)
   - Manually added pills not in `coords`: IDB `searchAll()` lookup; if still not found, skip with warning toast
2. Build plan object:
   ```javascript
   {
     departure: wps[0].icao || wps[0].name,
     destination: wps[last].icao || wps[last].name,
     cruise_altitude: this._altitude,
     waypoints: wps,   // [{icao, name, lat, lon, type, alt}]
     flight_plan: { departure, destination, route: [...ids], legs: [] }
   }
   ```
3. `app.applyRouteEdit(plan)` — fans out to map, route-table, weather, charts, clearance (unchanged)
4. `app.closeRoutePlanner()`

### Manual-only flow (no "Plan" call)
Pilot builds route pill-by-pill using the add-input row. "Apply" resolves coordinates as above.

---

## Pill Editor — Reliability Fixes from Prototype

### Replace desktop drag-and-drop with touch drag handle

`routeEditor.html` uses `dragstart/dragover/drop` which never fires on Android WebView — the browser fires touch events, not mouse events, and does not synthesize drag events from them. The `⠿` handle icon is already in the prototype; the missing piece is the touch implementation.

Pills flow **left-to-right, wrapping** (`display:flex; flex-wrap:wrap`). This matches the prototype and keeps the route readable in reading order. Drag detection must be 2D (X and Y) because pills can be on any row.

**Implementation (~90 lines, three handlers on the handle element):**

```
touchstart on ⠿ handle
  → mark pill as dragging (reduce opacity, add dragging class)
  → create a floating ghost clone that follows the finger
  → record touch start and original index

touchmove
  → translate ghost to follow touch X, Y freely
  → for each sibling pill, compute getBoundingClientRect() center
  → find the pill whose center is nearest to current touch X, Y
  → determine before/after by comparing touch X to that pill's horizontal midpoint
  → highlight the insertion gap with a coloured left or right border on the target pill

touchend
  → splice pill from original index to detected slot
  → remove ghost, re-render pills
```

No timers, no async, no state machine. Works for moves of any distance in one gesture.
The `touch-action: none` already on pills in the prototype suppresses scroll interference — keep it on the handle only (not the whole pill) so the pill list itself remains scrollable when the pilot is not dragging.

### Replace `prompt()` with the existing add-input row
"Insert Before/After" from the context menu sets an `_insertIndex` and focuses the add-input row. Same pattern as the old editor.

### Replace fragile long-press detection
`routeEditor.html` uses `setTimeout(500)` on `touchstart` cleared by `touchend`/`touchmove`. Replace with `wireTap` long-press (400 ms, matches `tap-utils.js` conventions).

### `navigator.clipboard` fallback
```javascript
if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(str);
} else {
    // Select the route string element so the pilot can copy manually
    const range = document.createRange();
    range.selectNode(routeStrEl);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
}
```

---

## `routePlanner.js` — Reliability Fixes

### Cache the airway graph
Build `AirwayGraph` once in `RoutePlannerPanel.init()`. Subsequent `plan()` calls reuse it. Invalidate (rebuild) only when `nasr-db.js` signals a new NASR import (via existing `nasrDb` event or by comparing `bundle_version` stored in `localStorage`).

### Shallow-copy the work-graph instead of deep-copy
`RouteConstructor.build()` currently does:
```javascript
workGraph.graph = JSON.parse(JSON.stringify(this.graph.graph));  // expensive
```
Replace with a `WorkGraph` wrapper that reads through to the shared graph for all existing edges and tracks only the temporary DEP/DEST edges added for this search. The shared `graph.graph` adjacency list and `coords` dict are never copied — only the small set of temporary edges is held separately and merged at lookup time.

### Known limitation: full airport scan in `FuelStopOptimizer`
`_candidateStops()` loads all airports from IDB on each call. Acceptable for v1 (typical IDB airport count is ~5,000 records, scan completes in <100ms). Noted here to avoid treating it as a bug.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| `plan()` throws (no route, IDB empty, DEP/DEST not found) | Toast error, current pills unchanged, pilot builds manually |
| Pill ID not in `coords` or IDB on Apply | Skip waypoint, warn toast: "GSO not found — skipped" |
| Apply with < 2 valid waypoints | Toast: "Add at least 2 waypoints", do not call `applyRouteEdit` |
| Tablet rotates while editor open | `window` resize → `invalidateSize()`, CSS auto-reflows grid |
| Clipboard read unavailable on Paste | Show modal `<textarea>` for manual paste; parse on confirm |
| Paste into non-empty pill list | Confirm toast before replacing existing route |

---

## Scope Boundaries

### Stage 1 — Ground Planning (this spec, ~1 week before flight)

**In scope:**
- New `RoutePlannerPanel` component with pill editor + A* planning
- Layout switch (portrait bottom / landscape left)
- Reliability fixes to `routeEditor.html` and `routePlanner.js` prototypes
- "Edit Route" button on `route-table.js`
- `app.js` wiring (open/close, remove old `routeEditor` references)
- Planning options: cruise altitude, max leg hours, self-serve filter, reserve gallons
- Paste route string → pills
- Fuel stop pills shown in pill sequence after Plan

**Not in this stage:**
- Search-while-typing for add-input (plain ICAO/fix-ID entry only)
- `aircraft_profiles` IDB store population (planner falls back to RV-9A defaults when store is empty)
- `DIRECT-TO` modal (separate feature)
- Per-waypoint min/max crossing altitude constraints (Stage 2)

---

### Stage 2 — Pre-flight Briefing (~1 day before flight)
*Implemented via `wx-briefing.js` + `ifr-clearance.js`, already partially built. Route planner feeds plans forward; Stage 2 refines them.*

- Load Stage 1 plan into wx-briefing panel
- TAF review for DEP, DEST, and every fuel stop airport
- NOTAM scan for all route airports
- IFR alternate identification and weather check
- Per-waypoint MEA / crossing altitude annotation (from enriched airway bundle)
- Route adjustments driven by weather (edit pills, re-apply)
- Pre-file IFR clearance generation

---

### Stage 3 — Final Review (day of flight)
*Integrates real-time data available only close to departure.*

- METAR review at DEP and route airports
- Winds aloft integration → suggest optimal cruise altitude per leg
- Fuel burn recalculation with forecast winds (actual TAS vs GS)
- Go/no-go checklist with weather and NOTAM confirmation
- Final route lock and export to IFR clearance
