# Route Display Redesign

**Date:** 2026-05-27  
**Scope:** Route table UX (draggable sheet, WPT column), landscape compact mode, MORE drawer cleanup  
**Files primarily affected:** `web/cockpit/route-table.js`, `web/style.css`, `web/cockpit/tab-bar.js`, `web/app.js`, `web/cockpit/track-log.js`

---

## 1. Draggable Route Table Sheet

### Current behaviour
The route table handle cycles through three fixed states on tap: closed (0) → partial (25vh) → full (50vh). A `_expandState` integer and a `▲/▲▲/▼` toggle button drive this. No drag support.

### New behaviour
Free-drag with an X close button. No fixed snap stops.

#### Handle bar layout (Option 2 — center pill)
```
┌─────────────────────────────────────────────┐
│              ────  (drag pill)               │
│ KLKR → KCHS   142nm  1:12  8.4gal  [EDIT][✕]│
└─────────────────────────────────────────────┘
```
- A centered 40×4px pill at the very top of the handle signals the drag target
- The entire `.route-table-handle` area is draggable (not just the pill)
- `[EDIT]` button opens the route planner panel (unchanged)
- `[✕]` is a bordered button that closes the table body (sets height to 0)
- The existing `[▲]` toggle button is removed
- When body height is 0, a faint `↑` hint text appears in the handle to indicate drag-to-open

#### Drag mechanics
- `touchstart` / `touchmove` / `touchend` on `.route-table-handle`
- `touch-action: none` on the handle element to prevent Leaflet scroll conflict
- During drag: `_bodyEl.style.height = computedPx + 'px'` set live on each `touchmove`
- Height bounded: `min = 0`, `max = min(window.innerHeight * 0.65, window.innerHeight - 200)`
- On `touchend`: save final height to `localStorage('flypi_route_table_height')` if > 0
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

## 2. WPT Column Width Fix

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

## 3. Landscape Compact Mode

### Tab bar change
The **TMR** tab (index 5) is replaced by **CMPCT**:

```javascript
{ id: 'cmpct', icon: '⊟', label: 'CMPCT' }
```

- Icon flips to `⊞` when strips are hidden
- Tapping toggles `body.compact-strips` class
- State saved to `localStorage('flypi_compact_strips')`; restored on app load
- Works in any orientation (most useful in landscape)
- The tab bar itself always stays visible — CMPCT is always reachable

### CSS
```css
body.compact-strips #instrumentStrip,
body.compact-strips .route-table-sheet {
    display: none !important;
}
```

### Timer
TMR timer functionality moves to the MORE drawer (see §4 — added as first In-flight item).

---

## 4. MORE Drawer Cleanup

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
