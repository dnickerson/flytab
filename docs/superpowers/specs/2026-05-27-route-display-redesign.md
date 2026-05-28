# Route Display Redesign

**Date:** 2026-05-27  
**Scope:** Route table UX (draggable sheet, WPT column), map/table layout separation, landscape compact mode, MORE drawer cleanup  
**Files primarily affected:** `web/cockpit/route-table.js`, `web/style.css`, `web/cockpit/tab-bar.js`, `web/app.js`, `web/cockpit/track-log.js`

---

## 1. Draggable Route Table Sheet

### Current behaviour
The route table handle cycles through three fixed states on tap: closed (0) → partial (25vh) → full (50vh). A `_expandState` integer and a `▲/▲▲/▼` toggle button drive this. No drag support.

### New behaviour
Free-drag with an X close button. No fixed snap stops.

#### Handle bar layout (Option 2 — center pill)
```
┌──────────────────────────────────────────────────┐
│                 ────  (drag pill)                  │
│ KLKR → KCHS   142nm  1:12  8.4gal  [⛰][EDIT][✕] │
└──────────────────────────────────────────────────┘
```
- A centered 40×4px pill at the very top of the handle signals the drag target
- The entire `.route-table-handle` area is draggable (not just the pill)
- `[⛰]` terrain profile button remains in the handle (unchanged from current)
- `[EDIT]` button opens the route planner panel (unchanged)
- `[✕]` is a bordered button that closes the table body (sets height to 0); `min-width: 44px; min-height: 44px` for gloved-hand tap target
- The existing `[▲]` toggle button is removed
- When body height is 0, a faint `↑` hint appears right-aligned in the handle: color `#999`, font-size 18px, minimum tap area 44×44px. It disappears once the body is open.

#### Drag mechanics
- `touchstart` / `touchmove` / `touchend` on `.route-table-handle`
- `touch-action: none` on the handle element to prevent Leaflet scroll conflict
- During drag: `_bodyEl.style.height = computedPx + 'px'` set live on each `touchmove`; call `_broadcastHeight()` immediately after to keep `--route-table-height` current (sidebars track it live)
- Height bounded: `min = 0`, `max` is orientation-aware:
  - Portrait (`window.innerWidth ≤ window.innerHeight`): `min(window.innerHeight * 0.40, window.innerHeight - 200)`
  - Landscape: `min(window.innerHeight * 0.65, window.innerHeight - 200)`
- On `touchend`: if downward swipe velocity > 300 px/s, close regardless of final height position (fast-flick to dismiss)
- On `touchend`: save final height to `localStorage('flypi_route_table_height')` if > 0; call `this._map.invalidateSize()` once
- Drag down to 0 closes the body (same effect as ✕)

#### Re-open after close
Dragging upward on the handle when body height is 0 restores to `localStorage('flypi_route_table_height')` or a default of 120px if no saved height exists.

#### Removed / changed
- `_expandState` integer and `_expanded` flag — both removed; height is the single source of truth
- `toggle()` is **reimplemented** (not deleted) as a simple open/close: if body height > 0 → close; if 0 → open to saved height or 120px. External caller `app.js:992` (left rail ≡ button) continues to work unchanged.
- `_toggleEditMode()` and `loadPlan()` call `toggle()` as before; the new implementation opens to saved height instead of cycling states
- CSS classes `route-table-partial`, `route-table-expanded` and their rules removed
- The `▲/▲▲/▼` toggle button (`rt-toggle-btn`) and its `wireTap` handler removed

---

## 2. Route Table Layout — Remove Fixed Positioning

### Problem
`.route-table-sheet` is `position: fixed`, which takes it out of the document flow. The Leaflet map container (`#primaryView`) fills 100% of its parent regardless of table height, so the map renders behind the table. Touch events intended for map elements (airports, navaids) in the covered area land on the table instead.

`--route-table-height` and `invalidateSize()` are already wired but don't help: `invalidateSize()` re-reads the container size, which hasn't changed because the fixed sheet doesn't affect layout.

### Fix — in-flow layout

Change `#cockpitContainer` to a flex column that contains both the map area and the route table sheet. The map grows and shrinks naturally as the table changes height.

#### Layout restructure

**HTML** — move `.route-table-sheet` inside `#cockpitContainer` (currently it's appended directly to the container in `_buildDOM`; it must instead be appended inside `#cockpitContainer` after `#mapContainer`):

```
#cockpitContainer  (flex column, height: 100%)
  #mapContainer    (flex: 1, min-height: 0)
    #primaryView   (height: 100%)  ← Leaflet map
  .route-table-sheet  (flex shrink 0, height = handle + body)
```

**CSS changes to `.route-table-sheet`:**
```css
/* Remove */
position: fixed;
bottom: var(--tab-bar-height);
left: 0;
right: 0;
z-index: 500;

/* Add */
position: relative;   /* in-flow */
width: 100%;
flex-shrink: 0;
```

**CSS changes to `#cockpitContainer` / `.map-area`:**
```css
#cockpitContainer {
    display: flex;
    flex-direction: column;
}
#mapContainer {
    flex: 1;
    min-height: 0;   /* required for flex children to shrink below content size */
}
```

#### Drag mechanics update
- During `touchmove`: set `_bodyEl.style.height` as before; no `invalidateSize()` needed mid-drag
- On `touchend`: call `this._map.invalidateSize()` once so Leaflet redraws tile seams at the new boundary
- `_broadcastHeight()` and `--route-table-height` can be kept for any other consumers (fuel overlay positioning, etc.) but are no longer the mechanism driving map shrinkage

#### Compact mode interaction
When `body.compact-strips .route-table-sheet { display: none }` the flex column naturally gives all space back to `#mapContainer`. After toggling compact mode: call `invalidateSize()` and `_broadcastHeight()`. When the sheet is hidden, `offsetHeight` returns 0, so `--route-table-height` resets to `0px` — the layer panel expands to fill the full available height.

#### Sidebar CSS fixes

**`.airport-panel`** (inside `#mapContainer`, `position: absolute`):
```css
/* Remove */
bottom: 164px;   /* was: engine card + handle + strip + buffer */

/* Add */
bottom: 0;
```
With in-flow layout, `#mapContainer` physically shrinks as the route table grows; its bottom edge is always the top of the route table. `bottom: 0` stops the panel flush with the map's lower edge — the route table area is below and is never covered.

**`.layer-panel`** (fixed, full-height slide-in from left):
```css
/* Change from */
bottom: 0;

/* To */
bottom: calc(var(--bottom-chrome) + var(--route-table-height));
```
`--bottom-chrome` is already defined as `calc(var(--tab-bar-height) + 64px)` (tab bar + instrument strip). Adding `--route-table-height` keeps the panel above the route table at all heights, live during drag.

**Real-time `--route-table-height` updates**: `_broadcastHeight()` must be called on every `touchmove` (not only `touchend`) so sidebar CSS variables track the drag continuously. The existing `_broadcastHeight()` reads `this._el.offsetHeight` (the whole sheet: handle + body) — this is the correct value.

#### Auto-pan to keep ownship visible

When the table is opened or resized, the ownship marker must remain in the visible map area. On `touchend` (after `invalidateSize()`), if GPS position is known:

```javascript
const pos = this._lastGpsPosition;  // {lat, lng} updated by GPS callback
if (pos) {
    const mapHeight = this._map.getSize().y;
    const tableH   = this._el.offsetHeight;
    // if ownship is in lower 1/3 of the visible map, pan up
    const pt = this._map.latLngToContainerPoint([pos.lat, pos.lng]);
    if (pt.y > mapHeight * 0.66) {
        this._map.panBy([0, -(tableH / 2)], { animate: true, duration: 0.3 });
    }
}
```

Same pan on `toggle()` open. GPS position is available via the existing `onGpsUpdate` callback; store `this._lastGpsPosition` there.

#### Other fixed-position users to audit
Search for anything using `--route-table-height` or hardcoded bottom offsets that assumed the fixed-position sheet: fuel overlay, alt picker. These should be re-verified after the layout change and updated if they still rely on the old geometry.

---

## 3. WPT Column Width Fix

### Problem
With `table-layout: auto`, the fuel-stop row's long `colspan` text inflates the table minimum width, which causes the WPT column to be sized wider than the waypoint identifiers require.

### Fix
- Set `table-layout: fixed` on `.route-table-content`
- Add a `<colgroup>` at the start of every rendered table with `<col>` elements that have explicit widths:

| Column | Width |
|--------|-------|
| WPT    | 52px  |
| ALT    | 7%    |
| HDG    | 7%    |
| BRG    | 7%    |
| DIST   | 8%    |
| ETE    | 8%    |
| GS     | 7%    |
| FUEL   | 8%    |
| remaining columns | share remainder equally |

- The fuel-stop `<td colspan>` cell gets `white-space: normal` so long text wraps rather than pushing table minimum width
- Edit-mode drag/delete columns get a fixed narrow width (e.g. 36px each)

The `<colgroup>` must be regenerated in `_renderTable()` to match the active column set from `CockpitConfig.get('routeTable.columns')`.

---

## 4. Landscape Compact Mode

### Tab bar change
The **TMR** tab (index 5) is replaced by **CMPCT**:

```javascript
{ id: 'cmpct', icon: '⊟', label: 'CMPCT' }
```

- When strips are hidden the tab label changes to **MAP** and icon to `⊞` so the pilot sees what tapping it will do ("show MAP" vs "go CMPCT")
- Tapping toggles `body.compact-strips` class
- State saved to `localStorage('flypi_compact_strips')`; restored on app load
- Works in any orientation (most useful in landscape)
- The tab bar itself always stays visible — CMPCT is always reachable

#### Restore height after compact mode
Before hiding, save current route table body height to `this._preCompactHeight`. When compact mode is turned off, restore `_bodyEl.style.height` to `_preCompactHeight` (or to `localStorage('flypi_route_table_height')` if `_preCompactHeight` is not set). Pilot expectation: table returns to exactly where it was before compact was activated.

### CSS
```css
body.compact-strips #instrumentStrip,
body.compact-strips .route-table-sheet {
    display: none !important;
}
```

### Timer
TMR timer functionality moves to the MORE drawer (see §5 — added as first In-flight item).

---

## 5. MORE Drawer Cleanup

### Removed items (7)
These rows are deleted from the `rows` array in `_buildMoreDrawer()`:

| Item | Reason |
|------|--------|
| New Route | Duplicate of Clear in route planner toolbar |
| Save Plan | Duplicate of Save in route planner toolbar |
| Load Plan | Duplicate of Plans in route planner toolbar |
| FIS-B Status | Status bar FIS-B badge already opens it (app.js:120) |
| Export Track GPX | Post-flight only; no in-cockpit use case |
| Export Track CSV | Post-flight only; no in-cockpit use case |
| Help | Duplicate of User Manual |

### Orphaned methods to delete
Removing these drawer rows leaves dead code that must also be deleted:

| Method | File | Lines (approx) |
|--------|------|----------------|
| `_showNewRouteConfirm()` | `tab-bar.js` | ~266–294 |
| `saveCurrentPlan()` | `app.js` | ~1136–1160 |
| `exportGpx()` | `track-log.js` | ~115–140 |
| `exportCsv()` | `track-log.js` | ~90–114 |
| `_showHelp()` | `tab-bar.js` | ~712–780 |

**Not orphaned — keep underlying code:**
- `planSync` — still used by route-planner-panel Plans button and app.js deep-link handler
- `fisbStatus` — still opened by status bar FIS-B badge click (app.js:120) and used by `setRouteAirports()`

### Added item
**Timer** (moved from tab bar) is added as the first item in the drawer.

### Reorganised layout (13 items total, 3 sections)

**In-flight** (5 items)
1. ⏱ Timer
2. ⛽ Fuel Entry
3. 📊 Approach Charts
4. 🧠 Engine ML
5. 📡 Stratux Status

**Pre / Post flight** (5 items)
6. ✈️ Plan on flywhere.app
7. ⛅ Weather Briefing
8. 📋 Logbook
9. 📤 Flight Upload
10. 📖 User Manual

**Admin** (3 items, visually separated with a section label, dimmed opacity)
11. 🗄 Data Status
12. ⚙ Configuration
13. 🔄 Reset NASR Data

Section labels are rendered as non-tappable dividers inside `.more-drawer-body` using a `type: 'section'` marker in the `rows` array.
