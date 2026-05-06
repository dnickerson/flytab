# Spec B — Route Editing UX

*Status: drafted 2026-05-04, awaiting user review.*
*Builds on the [Planning Library Architecture Sketch](./2026-05-04-planning-lib-architecture-sketch.md) of the same date.*
*References the [Route Planner Best Practices Comparison](./2026-05-04-route-planner-best-practices-comparison.md) and the prior Garmin Connext research finding (no realistic OSS path).*

## TL;DR — what this spec covers

A route editing UX that lets the pilot:
1. **Open a long route** (100 fixes is realistic) and navigate it with search + jump-to.
2. **Paste an externally-supplied route** (e.g. 1800wxbrief recommended IFR routing) and apply it.
3. **Smart-suggest avoid an airspace** by tapping its polygon; planner picks the branch point automatically; pilot can override.
4. **See an old-vs-new comparison** with wind-corrected ETE/fuel deltas and TFR-conflict status.
5. **Edit in conjunction with the map** — bidirectional tap/list highlight, tap waypoint markers to inspect or edit, long-press a route segment to insert.
6. **Apply changes** without dismissing the editor (iterate freely), or **Apply & Close** when done.
7. **Use the same editor in flight** for ATC clearance amendments — same UI, different default section visibility (mode-aware).
8. **Copy / share the ICAO Field 15 route string** for manual transcription into a panel GPS or for a clearance read-back.

Eleven decisions confirmed in brainstorm:

| # | Decision |
|---|---|
| 1 | Editor and map side-by-side. **40% editor / 60% map**, never less map than 60%. |
| 2 | Mode-aware UI — **same layout** in flight, internal sections collapse via `app.networkMode.mode`. |
| 3 | **Apply** = save to IDB + render on map (editor stays open). **Apply & Close** = same + close. **Close-without-apply** with dirty edits gets a confirmation. |
| 4 | Map↔list gestures: tap-list-to-highlight-map; tap-marker-to-popup; long-press-segment-to-insert; tap-airport-to-popup; tap-airspace-to-avoid. (5 in scope; rubber-band-drag deferred.) |
| 5 | **AirportPopup** is the unified waypoint info + edit-actions surface. The `route-editing` skip guards in `app.js` are removed; popup gains `setEditMode()`. |
| 6 | **Two close affordances** (top-right `[×]` + bottom toolbar `[Close]`) — both bind to one handler. Close is **synchronous**; aborts pending async first. |
| 7 | **Map visibility is invariant** — at most 40% of viewport is editor; no fullscreen modals; force-close watchdog if editor stuck. |
| 8 | All map-touch uses **custom touchend + SVG CTM hit-test**, never Leaflet's `.on('click')`. Capture-phase touchstart mandatory. |
| 9 | Editor pane respects **`env(safe-area-inset-top)`** for the Android system banner. Close X is **56×56 high-contrast**. |
| 10 | New planner work routes through the **planning library adapters** from the architecture sketch — no direct IDB/network calls in the editor. |
| 11 | **Vitest + jsdom** for unit/integration tests; **Playwright** for E2E; **hardware checklist** on the Yoga Tab Plus is a release gate. |

## Section 1 — Architecture overview

The route editor is a **shell-side component** in `web/cockpit/`. Not part of the planning library — it owns DOM, gestures, presentation. Consumes the planning library through adapters wired up in `web/app.js`.

### File layout

```
web/cockpit/
  route-planner-panel.js          ← EXISTING, extended (not replaced)
  route-editor-list.js            ← NEW: pill list, search, jump-to, 100-fix scroll
  route-editor-paste.js           ← NEW: paste box + ICAO Field 15 parser
  route-editor-avoidance.js       ← NEW: avoidance picker (tap-on-map + chip list)
  route-editor-comparison.js      ← NEW: old-vs-new comparison (wind-corrected, TFR-checked, phase-aware)
  route-editor-actions.js         ← NEW: toolbar (Apply, Apply&Close, Copy, Share, Clear, Close)
  route-editor-modes.js           ← NEW: ground/in-flight section visibility
  route-table.js                  ← EXISTING, extended (NOT a new file): adds phase-aware columns
                                    (Alt/Hdg/Dist/TAS/RPM/MP/%Pwr/Wind/GS/Time/Fuel/Rem)
                                    powered by the planning lib's fuel-phases output
  airport-popup.js                ← EXISTING, extended (NOT a new file):
                                    gains setEditMode(active, bus) and an edit-actions row
```

### Module shape and isolation

- Vanilla JS classes, one per file, ~150–300 LOC each.
- Internally each consumes the planning library via ESM (`import { RoutePlanner } from '../shared/planning/index.js'`).
- **No sibling cross-imports.** All cross-module communication via `EditorBus` (a tiny `EventTarget` subclass instantiated by `route-planner-panel.js` and passed in).
- Avoids the 3000-line god-object problem in `route-table.js`.

### Reused infrastructure (no duplicates created)

| Existing singleton | Where it lives | What the editor uses it for |
|---|---|---|
| **`app.networkMode`** | `web/shared/network-mode.js` | Mode-aware section visibility; `route-editor-modes.js` listens to `mode:changed` |
| **`app.fisbClient`** | `web/shared/fisb-client.js` | Wrapped by `FisbWeather` adapter — supplies `winds`, `sigmets`, `airmets` for in-flight weather/avoidance computation. Editor subscribes to `fisb:winds` / `fisb:sigmet` / `fisb:airmet` events to refresh comparison |
| **`app.weatherClient`** | `web/shared/weather-client.js` | Wrapped by `FlywhereWeather` adapter (post-port) |
| **`app._nasrDb`** | `web/shared/nasr-db.js` | Wrapped by `IdbAeroData` adapter |
| **`app.stratuxClient`** | `web/shared/stratux-client.js` | Already feeds `app.fisbClient`; editor doesn't touch directly |
| **`app.airportPopup`** | `web/cockpit/airport-popup.js` | Single instance; gains `setEditMode()` for edit-actions row |
| **`wireTap()`** | `web/cockpit/tap-utils.js` | Required for all gesture handlers (per CLAUDE.md double-fire guard) |

### Adapters wired up in `web/app.js` boot sequence (post-port)

```js
const adapters = {
  aero:     new IdbAeroData(this._nasrDb),
  weather:  new WeatherRouter(this.networkMode, {
              inFlight: new FisbWeather(this.fisbClient),                  // reuses app.fisbClient
              online:   new FlywhereWeather('https://flywhere.app/api'),
            }),
  plans:    new IdbPlanStore(/* IDB instance */),
  profiles: new IdbProfileStore(/* IDB instance */),
  network:  this.networkMode,                                                // reuses app.networkMode
  clock:    { now: () => Date.now() },
};
this.routePlanner = new RoutePlanner(adapters);
this.optimizer    = new Optimizer(adapters);
```

### Flight-phase data flow

```
planning lib                                    flytab UI
─────────────────────────────                   ─────────────────────────────
RoutePlanner.plan(opts)
  └─ uses math/fuel-phases.js                   route-editor-comparison.js
     to decompose route into                    ─ reads phase totals from
     climb / cruise / descent                     plan.summary for old vs new
     phases per leg                  ──────▶
                                                route-table.js (extended)
plan.legs[i] = {                                ─ renders one row per leg
  …existing fields…,                              with new phase-aware columns:
  phase: 'climb'|'cruise'|'descent',              Alt, Hdg, Dist, TAS, RPM, MP,
  altFt, tasKt, gsKt, windDir, windKt,            %Pwr, Wind, GS, Time, Fuel, Rem
  rpm, mp, percentPwr,
  timeHrs, gphActual, fuelGal, fuelRemGal       cockpit map / route nav strip
}                                               ─ already consume plan.legs;
                                                  no changes needed
```

## Section 2 — Layout

### Ground mode (all sections visible)

```
┌──────────────────────────────────────┬─────────────────────────────────────────────┐
│ ROUTE EDITOR                  [×]    │                                             │
│ ─────────────────────────────────────│                                             │
│ DEP [KLKR  ]  →  DEST [K44N  ]       │                                             │
│ Cruise: [6000 ▼]  Reserve: [10 gal]  │                                             │
│ Routing: [V-airways ▼]               │                                             │
│ ─────────────────────────────────────│                                             │
│ 📋 PASTE / TYPE ROUTE                │                                             │
│ ┌────────────────────────────────┐   │                                             │
│ │ LOCAS V409 GANTS V103 GSO ...  │   │                                             │
│ └────────────────────────────────┘   │                                             │
│ [Parse]                              │                  60% MAP                    │
│ ─────────────────────────────────────│                                             │
│ 🚫 AVOIDANCE                         │     • Route line (active in magenta)        │
│ [NY Class B ×] [+ Add airspace]      │     • Old tail (gray dashed) when comparing │
│ ─────────────────────────────────────│     • Highlighted fix marker (orange ring)  │
│ ROUTE FIXES (98)        [🔍 Search]  │       — synced with selection in list       │
│ ┌──────────────────────────────────┐ │     • Avoidance polygons tappable           │
│ │ KLKR  → V143 → ...               │ │     • Long-press segment → insert waypoint  │
│ │ ▶ RBV   ← scrolled-to / selected │ │                                             │
│ │ ─ 100 fixes total ─              │ │                                             │
│ └──────────────────────────────────┘ │                                             │
│ ─────────────────────────────────────│                                             │
│ 📊 COMPARISON   (visible only when   │                                             │
│    a suggestion is pending)          │                                             │
│ Branch: RBV (auto)   [Change…]       │                                             │
│   Old: 49 / 287nm / 1:55 / 19.2gal   │                                             │
│   New: 23 / 312nm / 2:01 / 20.4gal   │                                             │
│ ✓ Clear of NY Class B · No TFRs      │                                             │
│ [ACCEPT]              [Reject]       │                                             │
│ ─────────────────────────────────────│                                             │
│ [Apply]  [Apply & Close]  [Close][⋯] │                                             │
└──────────────────────────────────────┴─────────────────────────────────────────────┘
   ◀──────── 40% ────────▶               ◀────────────── 60% ──────────────▶
```

### In-flight mode (collapsed for ATC amendments)

```
┌──────────────────────────────────────┬─────────────────────────────────────────────┐
│ ROUTE EDITOR · IN FLIGHT       [×]   │                                             │
│ ─────────────────────────────────────│                                             │
│ 📋 ATC AMENDMENT                     │                                             │
│ ┌────────────────────────────────┐   │              60% MAP                        │
│ │ DCT ABCDE V139 SAX DCT         │   │                                             │
│ └────────────────────────────────┘   │      Pilot pastes the amendment, sees       │
│ [Parse]                              │      it on map briefly, hits Apply&Close,   │
│ ─────────────────────────────────────│      map returns to full-screen.            │
│ 📊 COMPARISON (auto-shown on parse)  │                                             │
│ Old → New: −18nm / −0:08 / −1.4 gal  │                                             │
│ ✓ Clear of TFRs                      │                                             │
│ ─────────────────────────────────────│                                             │
│ [Apply]  [Apply & Close]  [Close]    │                                             │
│ ─────────────────────────────────────│                                             │
│ ▸ Route fixes (98)  [tap to expand]  │                                             │
│ ▸ Avoidance         [tap to expand]  │                                             │
│ ▸ Header / options  [tap to expand]  │                                             │
└──────────────────────────────────────┴─────────────────────────────────────────────┘
```

In-flight collapse rules in `route-editor-modes.js`:
- **Always visible**: paste box, comparison (if pending), action toolbar, mode banner.
- **Collapsed** (single-row "tap to expand"): route fixes list, avoidance picker, header.
- **Trigger**: `app.networkMode.mode === 'flight'`.
- **Override**: pilot tap-to-expand persists for the editor session.
- **Banner**: orange "IN FLIGHT" badge top-right of editor.

### Layout mechanics

- **40/60 split** as a CSS grid on `.route-editing` container: `grid-template-columns: minmax(0, 40%) minmax(60%, 1fr)`. The `minmax(60%, 1fr)` hard-enforces the map can never be smaller than 60%.
- Editor pane scrolls independently. Action toolbar is **sticky-bottom** so Apply/Apply&Close/Close are always reachable on a long route list.
- When Edit Mode is off, grid collapses to a single column (full-width map).
- Map pane keeps standard FlyTab map; existing tap/long-press/airspace handlers rebound via `app.js` to emit on `EditorBus` when Edit Mode is active.

### Comparison panel placement

Inside the editor pane (40% width), not overlaid on the map. Pilot reads numbers in the editor; map is left clean for the route geometry (gray-dashed old tail vs solid magenta new tail).

### AirportPopup integration

The `route-editing` skip guards at `app.js:432, 445, 458` are **removed**. Tapping a waypoint always opens the popup, in any mode.

`AirportPopup` (the existing single instance, `app.airportPopup`) gains a `setEditMode(active, bus)` method. When Edit Mode is active, it renders an additional **Edit actions row** at the top:

| Button | Behavior |
|---|---|
| Insert before nearest leg fix | Inserts this waypoint before the nearest existing fix on the active leg |
| Insert after nearest leg fix  | Same, after |
| Replace nearest fix           | Swaps for the nearest existing fix |
| Set as departure              | Replaces dep |
| Set as destination            | Replaces dest |
| Remove from route             | Only shown when this waypoint already appears in the active route |

All buttons emit on `EditorBus`; `route-editor-list.js` handles the mutation and re-renders. AirportPopup slides in from the right edge of the 60% map column — does not overlap the editor pane. Existing FIS-B-aware popup content (METAR/TAF) already works; just becomes reachable in Edit Mode.

### Close affordances

| Affordance | Where | Behavior |
|---|---|---|
| Top-right `[×]` | Editor pane header, **56×56**, dark navy on saturated yellow circle for sun visibility | Same handler as `[Close]` |
| `[Close]` button | Bottom action toolbar, alongside `[Apply]` and `[Apply & Close]` | Primary fat-finger reach |
| Long-press `[×]` | Top-right corner | **Force-close** — last resort, no confirmations |

Both X and Close call `_onCloseTap()`:

```
clean state           → close immediately
dirty state           → in-pane confirmation: "Discard unsaved changes?" [Discard] [Cancel]
pending comparison    → in-pane confirmation: "Discard pending suggestion?" [Discard] [Cancel]
in-flight mode        → confirmation always: "Exit editor in flight?" [Yes, exit] [Stay]
```

Confirmations are **inside the editor pane**, not over the map.

### Bottom-toolbar overflow `[⋯]` menu

| Action | Notes |
|---|---|
| Copy ICAO route to clipboard | Field 15 string for manual GPS transcription, ATC read-back, or paste into Garmin Pilot |
| Share via Android intent | Same string, surfaces system share sheet |
| Clear route | Confirmation: "Clear all 98 fixes?" |
| Export .gpx | Universal format for backup / external tools |

These are deferred-utility — useful but not the centerpiece. They live in the overflow menu to keep the primary toolbar clean.

### Android safe-area handling

```css
#routePlannerPanel {
  padding-top: env(safe-area-inset-top, 0);
}
```

Editor's header (`[×]` + title) sits below the system banner. All editor-spawned UI (banners, toasts, comparison) respects the same boundary.

## Section 3 — Data flow

### Editor state (in-memory, owned by `route-planner-panel.js`)

```js
this._editorState = {
  baseline:          FlightPlan,    // last-Apply'd plan; matches what's in IDB
  working:           FlightPlan,    // editor's working copy with unapplied edits
  pendingComparison: null | {
    proposed:    FlightPlan,         // candidate from smart-suggest / paste / branch-change
    branchPoint: WaypointId | null,  // null when paste replaces whole route
    avoidance:   AirspaceId[],       // active avoidance constraints
    comparison:  {
      old:       PlanSummary,        // distance, ETE, fuel, #fixes — phase-aware totals
      new:       PlanSummary,
      conflicts: ConflictReport,     // intersected airspace / TFR / SUA on each
    },
  },
  dirty:        boolean,             // !deepEqual(working, baseline)
  flightMode:   'flight'|'home'|'internet'|'offline',
};
```

`baseline` and `working` are immutable plain objects produced via the helpers in `web/shared/flight-plan-model.js`. Diffing is deep-equal.

### Planner invocation triggers

| Trigger | Operation | Cost |
|---|---|---|
| Paste + Parse | `RoutePlanner.parseRoute(str)` → full plan, replaces working. **Each airway token is expanded into its interior transition fixes** via `AeroDataSource.getAirway(id)` so all fixes render as map markers and as pills in the list. | one airway-graph lookup per airway token + phase decomposition |
| Tap airspace polygon to avoid | `RoutePlanner.replanWithAvoidance(working, constraints)` → produces `pendingComparison` | one A* with avoidance cost |
| Branch-point override (in comparison) | Same with branch-point override | one A* |
| Add/remove avoidance constraint | Same | one A* |
| Insert / Replace / Remove fix via popup | `RoutePlanner.recomputeLegs(working)` — no graph search | leg math + phase decomposition |
| Change cruise altitude / reserve / leg time | `RoutePlanner.recomputeLegs(working)` | leg math + phase decomposition |
| Change **routing mode** (GPS-Direct / VORs-Direct / V-airways / T-airways / Any) | `RoutePlanner.plan(working, { routingMode })` re-runs A* with the airway-type filter applied to the graph. | one A* + phase decomposition |
| Mode change (`mode:changed`) | None — section visibility only | nothing |

### Routing-mode picker

A dropdown in the Ground-mode header (one row below Cruise/Reserve). Defaults from `aircraft.equipment` on the active profile; pilot can override per flight. The active value is part of `working.options.routingMode` and is included in the comparison panel's "what changed" line when it differs from baseline.

| Mode | A* graph | Use case |
|---|---|---|
| `gps-direct` | No airway edges. Direct point-to-point only. | Equipment without IFR airway capability; sightseeing direct. |
| `vors-direct` | No airway edges; A* pinned through VOR navaids. | Conventional VOR-based routing without committing to a published airway. |
| `v-airways` | Only `V`-prefixed (Victor — conventional low-altitude) airway edges. | **Default for Garmin GPS 175 — does not support T airways.** |
| `t-airways` | Only `T`-prefixed (RNAV) airway edges. | RNP-capable GPS, RNAV-only routing. |
| `any` | All airway types in the graph. | Latest GPS, no airway-type restrictions. |

Cheap path runs sync in-process. Expensive path runs async, cancellable via `AbortController`. Comparison panel shows `Computing…` while awaiting; editor remains responsive.

### Apply flow

```
1. If pendingComparison is non-null:
     working = pendingComparison.proposed
     pendingComparison = null
2. await plans.put(working)              // PlanStore adapter writes to IDB
3. baseline = deepClone(working)         // dirty becomes false
4. emit('editor:applied', { plan: working })
5. Editor stays open (Apply); closes (Apply & Close)
```

### Close-without-apply / discard

```
1. working = deepClone(baseline)
2. pendingComparison = null
3. dirty = false
4. emit('editor:reverted', { plan: working })
5. emit('editor:closed') if user chose Discard
```

### How the rest of the app sees changes

```js
editorBus.addEventListener('editor:applied', (e) => {
  this._currentTrip = e.detail.plan;
  this.cockpitMap.setRoute(e.detail.plan);
  this.routeTable.setPlan(e.detail.plan);
  this.routeNavStrip.setPlan(e.detail.plan);
  this.routeProfile.setPlan(e.detail.plan);
});
```

All downstream consumers read from `app._currentTrip` and re-render. None peek into editor state.

### EditorBus event catalog

| Event | Emitted by | Payload | Consumers |
|---|---|---|---|
| `editor:opened`              | route-planner-panel | `{ plan, mode }` | all modules — initial render |
| `editor:list-tap`            | route-editor-list | `{ fixId }` | map (highlight), popup (open) |
| `editor:map-tap-waypoint`    | app.js (bridge) | `{ waypoint }` | list (scroll), popup (open) |
| `editor:map-tap-airspace`    | app.js (bridge) | `{ airspace }` | route-editor-avoidance |
| `editor:map-longpress-segment`| app.js (bridge) | `{ leg, latLon }` | route-editor-list (insert picker) |
| `editor:popup-action`        | airport-popup | `{ action, waypoint }` | route-editor-list (mutate) |
| `editor:paste-parsed`        | route-editor-paste | `{ plan }` | route-editor-comparison |
| `editor:avoidance-changed`   | route-editor-avoidance | `{ constraints }` | route-editor-comparison (triggers replan) |
| `editor:branch-point-changed`| route-editor-comparison | `{ fixId }` | route-editor-comparison (triggers replan) |
| `editor:computing`           | route-editor-comparison | `{ active: bool }` | route-editor-actions (disable Apply during) |
| `editor:comparison-accepted` | route-editor-comparison | none | route-editor-actions (triggers Apply) |
| `editor:comparison-rejected` | route-editor-comparison | none | route-editor-comparison (clears pending) |
| `editor:dirty-changed`       | various | `{ dirty: bool }` | route-editor-actions (Apply enabled/disabled) |
| `editor:applied`             | route-editor-actions | `{ plan }` | app.js + downstream consumers |
| `editor:reverted`            | route-editor-actions | `{ plan }` | all modules — re-render |
| `editor:closed`              | route-editor-actions | none | route-planner-panel — DOM cleanup |
| `mode:changed` (external)    | app.networkMode | `{ mode, previous }` | route-editor-modes |

### Map-↔-editor bridge

Tap handlers in `app.js:430-465` get a small dispatch layer:

```js
this.vectorLayers.onAirportClick((apt) => {
  if (this._isEditorActive()) {
    this.editorBus.dispatchEvent(new CustomEvent('editor:map-tap-waypoint', { detail: { waypoint: apt } }));
    this.airportPopup.show(apt);   // popup also opens, with setEditMode true
    return;
  }
  // ... existing non-edit-mode behavior
});
```

The map module knows nothing about `EditorBus`; only `app.js` bridges. Keeps map code free of editor-specific code.

## Section 4 — Error handling

Cockpit principles: never block the pilot from making a decision; surface what data the editor is using; stale > nothing; loud failures only for safety-critical (TFR conflict, route impossible).

### Paste / parse failures

| Failure | Detection | UI surface | Editor state | Pilot affordance |
|---|---|---|---|---|
| Unparseable token | Parser returns `{ error, position }` | Inline error pill below paste box, **highlights the offending token** in red within the input | Working unchanged | Edit token in place; re-tap Parse |
| Unknown waypoint | Parser returns `{ unknownWaypoints: [...] }` | Yellow warning under paste box | **Partial parse accepted.** Working contains all known fixes; unknown rendered as `?` placeholder pill | Tap the placeholder pill → search picker to replace, or tap × to drop |
| Ambiguous identifier | Parser finds 2+ matches | Inline disambiguation: "GPS — 3 matches: navaid, fix, airport" | Pause, no insert | Pilot picks |
| Empty paste | No tokens | Toast "Nothing to parse" | Unchanged | — |

### Planner failures (smart-suggest avoidance)

| Failure | Detection | UI surface | Pilot affordance |
|---|---|---|---|
| No route avoiding airspace | A* exhausts graph | Red banner in comparison: "No route to K44N avoiding NY Bravo. The constraint may be too tight." With suggestions: "Loosen buffer (5→2 nm)" / "Allow shoulder of class B" / "Add a via point" | One-tap actions; or tap × on constraint to remove |
| Branch point makes route impossible | A* from branch fails | Same banner + "Try a different branch — RBV is unreachable from the avoidance corridor" | Pilot picks a different fix |
| A* timeout (>10s) | AbortController fires | "Computing took too long. Simplify constraints or split into legs." | Retry or relax |
| Avoidance polygon engulfs destination | Pre-flight check | Red toast: "Destination K44N is inside this airspace — cannot avoid" | Constraint rejected, not added |

Planner returns typed errors (`PlanError` subclasses): `NoRouteFoundError`, `DestinationUnreachableError`, `TimeoutError`, `DestinationInsideAvoidanceError`. Editor maps each to a specific banner.

### Weather / data source failures

| Tier | Failure | UI surface | Editor state | Pilot affordance |
|---|---|---|---|---|
| Online | flywhere.app proxy 5xx / timeout | Yellow badge: "Weather data unavailable — using cached" | **Comparison still shown** with last-cached winds + TFRs. ETE/fuel stamped with cache timestamp | Retry button on badge |
| Online | Specific endpoint fails (TFR feed down) | Per-data-source badges | Comparison without that data | "Use last cached TFRs" if any exist |
| In flight | Stratux disconnected | Red banner: "FIS-B unavailable — using last received data" | Working continues; comparison uses cached FIS-B if any | "Reconnect Stratux" link |
| In flight | FIS-B reception spotty | Per-source badge: "SIGMETs: not received this flight" | Comparison shows winds + warns about gap | Acknowledge & continue |
| All tiers | Winds aloft for cruise altitude unavailable | Yellow inline note: "ETE assumes calm winds (no forecast available)" | Comparison shown without wind correction | None — best effort |
| All tiers | METAR unavailable | Subtle indicator in route list; comparison unaffected | Continues | Pilot calls FSS if needed |

**Key principle:** the comparison panel **always renders** when there's a pending suggestion, even with missing data. Missing pieces become explicit badges, not blocking errors. Pilot can always Accept and Apply.

### Persistence failures

| Failure | Detection | UI surface | Editor state | Pilot affordance |
|---|---|---|---|---|
| `PlanStore.put()` throws | Promise rejection | Toast: "Save failed: <reason>" | Working unchanged; baseline unchanged; dirty stays true; **NOT applied** | Apply button stays enabled; pilot retries. Editor never silently loses data. |
| IDB quota exceeded | Specific error code | Persistent banner: "Storage full — delete old plans in Library" | No save | Library button to manage stored plans |
| IDB blocked / locked | Hangs >5s | Toast: "Storage busy — retrying" | Auto-retry up to 3x with backoff | If retry exhausted, surface "Save failed" |

### Mode transitions during edit

| From → To | Action |
|---|---|
| home/internet → flight | Banner: "Now in flight — editor switched to in-flight layout." Sections collapse. Weather routing flips to `FisbWeather`. Pending comparison **persists**. |
| flight → internet/home | Banner: "Internet available — refreshed weather data." Sections expand. Weather routing flips to `FlywhereWeather`. Pending comparison weather badges revalidate. |
| any → offline | Banner: "Offline — using cached data only." Comparison continues with caches. Apply still works (writes to local IDB). |

Transitions are **never destructive**. Working copy + pending comparison survive every flip.

### Concurrent state collisions

| Collision | Resolution |
|---|---|
| User taps Apply while comparison computing | Apply is **disabled** while `editor:computing { active: true }`. Visible spinner on the button. |
| User changes branch point during in-flight A* | Old AbortController fires; new A* starts. Comparison shows "Computing…" briefly. |
| User pastes new route while comparison is pending | Confirmation: "Discard pending suggestion to load pasted route?" |
| User closes editor mid-A* | Close handler aborts in-flight planner request before tearing down. |

### Map gesture errors

| Gesture | Failure | UI |
|---|---|---|
| Long-press dead area | No leg within 5 nm of tap | Toast: "Long-press a route segment to insert" |
| Tap overlapping airspaces | 2+ polygons share tap | Disambiguation menu: "Avoid: NY Class B, NY SFRA?" |
| Tap a fix already in route | Popup's "Remove from route" affordance is shown instead of "Insert" |

### Map-visibility safety invariants (non-negotiable)

**Invariant 1: The map is never hidden.**

| Rule | Enforcement |
|---|---|
| Editor occupies **at most 40% of viewport width**, ever | CSS grid `minmax(60%, 1fr)` on the map column — enforced by layout engine |
| **No modal dialogs cover the map.** Confirmations appear inside the editor pane | All confirmations are inline editor-pane sections, never `position: fixed` overlays |
| **No fullscreen takeover.** All loading indicators confined to the editor pane | A small spinner in the comparison area, never a splash |
| **Map gestures stay live during compute** | Planner runs async; never blocks the event loop synchronously |
| **In-flight emergency map tap dismisses pending comparison** but leaves editor mounted | Map-pan / map-tap fires `editor:comparison-rejected`; editor stays |
| Editor pane is **opaque** so map data layers under it can't bleed through | Background `#f0f2f4`, no transparency tricks |

**Invariant 2: The editor always closes.**

| Failure pattern | Defense |
|---|---|
| Async operation in flight; close awaits its resolution | Close is **synchronous**. Step 1: `this._abortController?.abort()`. Step 2: DOM teardown. Pending promises check `if (aborted) return` before touching DOM. **Never `await` inside the close handler.** |
| Confirmation dialog has only an "Action required" button | Every confirmation has a Cancel. Including in-flight "Exit editor?" — Cancel always available. |
| Keyboard stays open over editor after close | Close handler explicitly calls `document.activeElement?.blur()` before DOM teardown. |
| CSS class doesn't get removed on close | DOM teardown two phases: phase 1 fires `editor:closed`, phase 2 (in `route-planner-panel.js`) **forcibly** removes `.route-editing` from `cockpitContainer` and sets `display: none` on the panel. Phase 2 is a hard write. |
| Z-index leak — closed editor still intercepts taps | Editor pane sets `pointer-events: none` immediately on close, before DOM removal. |
| Watchdog: editor enters corrupt state | **Force-close fallback**: if `cockpitContainer` still has `.route-editing` 1 second after close handler runs, top-level safety timer in `app.js` removes the class and forces `route-planner-panel` to `null` state. Diagnostic logged. **Pilot is never trapped.** |
| Force-close from outside | `app.forceCloseEditor()`, callable from devtools and from long-press on `[×]`. Tears down everything synchronously, no confirmations, no awaits. |

### Mid-edit pause for critical flight events

If a critical event fires (TFR ahead of aircraft, FIS-B SIGMET activates over current position, traffic alert), the editor doesn't disappear but:

```
mode:flight + critical-event:fired
  → editor pane: opacity 0.35, pointer-events:none
  → alert banner appears at TOP of editor pane (still 40% width — doesn't cover map)
  → pilot taps "Acknowledge" or "Resume editing" → editor returns to full opacity
```

Map continues to show the alert in its proper geographic position; banner duplicates the alert text in the editor pane so pilot doesn't lose their amendment context.

### Leaflet touch inconsistencies (a design constraint)

Leaflet's `.on('click')` is unreliable on Android tablets — drag handler swallows synthetic clicks; `L.Map.Tap` not loaded; `disableClickPropagation` on markers stops touchstart in bubble phase.

**All map-touch in Spec B uses the custom touchend + SVG CTM hit-test pattern from CLAUDE.md, never Leaflet's `.on('click')`.**

```js
// In map module / vector-layers, NOT in the editor
this._tapStart = null;
this._onTapStart = (e) => {
  if (e.touches.length === 1) {
    this._tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  } else { this._tapStart = null; }
};
this._onTapEnd = (e) => {
  if (!this._tapStart || e.changedTouches.length !== 1) { this._tapStart = null; return; }
  const ts = this._tapStart; this._tapStart = null;
  const dx = e.changedTouches[0].clientX - ts.x;
  const dy = e.changedTouches[0].clientY - ts.y;
  const dt = Date.now() - ts.t;
  if (dx*dx + dy*dy > 400) return;          // >20 px = drag
  if (dt > 1500) return;                     // ridiculously long
  if (dt > 500) {
    this._handleLongPress(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
  } else {
    this._handleTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
  }
};
container.addEventListener('touchstart', this._onTapStart, { capture: true,  passive: true });
container.addEventListener('touchend',   this._onTapEnd,   { capture: false, passive: true });
```

Hit-test cascade in `_handleTap` (priority — first hit wins):
1. Marker SVG hit (airport/navaid/fix) → emit `editor:map-tap-waypoint`
2. Polygon hit (airspace) → emit `editor:map-tap-airspace`
3. Polyline hit within ε px (route segment) → emit `editor:map-tap-segment` (only meaningful for long-press)
4. Empty area → no-op

The `_wireTapLastTouchAt` global from `tap-utils.js` is updated by the map handler too, to coordinate with `wireTap` callers elsewhere.

### Leaflet failure modes mapped

| Symptom | Likely cause | Fix |
|---|---|---|
| Tap polygon does nothing on tablet but works on desktop | Used Leaflet `.on('click')` | Replace with custom touchend + `isPointInFill` |
| Tap marker on tablet does nothing | Marker has `bubblingMouseEvents: false` | Re-register touchstart with `{capture: true}` |
| Long-press triggers on every short tap | No timer guard | Check `dt > 500` |
| Long-press fires during drag | No movement guard | Check `dx*dx + dy*dy <= 400` |
| Two-finger tap registers as single tap | No multi-touch guard | Check `e.touches.length !== 1` |
| Popup double-opens after wireTap fix | Global timestamp guard not coordinated | Map handler updates `_wireTapLastTouchAt` |

### Android system banner + close-button reachability

```css
#routePlannerPanel {
  padding-top: env(safe-area-inset-top, 0);
}
```

- Editor's header is the first child *inside* the safe area — never at viewport `top: 0`.
- Comparison panel and any toast/banner respect the same safe-area boundary.
- Top-right `[×]` is **56×56** — high-contrast (dark navy on saturated yellow circle) for sun visibility, centered in its hit box.
- `[Close]` in bottom toolbar is also 56-tall, full editor-pane width.
- X and Close are functionally equivalent — one handler, two reachable affordances.

## Section 5 — Testing

### Test infrastructure

```
flytab/
  package.json                    ← add: vitest, @vitest/ui, jsdom
                                    scripts: "test", "test:ui", "test:e2e"
  vitest.config.js                ← jsdom environment, ESM, no transform
  playwright.config.ts            ← already exists; extend with editor specs
  tests/
    planning/                     ← unit tests for the planning lib
      math/{engine-data,route-math,fuel-phases}.test.js
      planner/{route-planner,avoidance}.test.js
    editor/                       ← unit tests for editor modules
      route-editor-state.test.js
      route-editor-bus.test.js
      route-editor-paste.test.js
      route-editor-list.test.js
      route-editor-comparison.test.js
      route-editor-actions.test.js
      route-editor-modes.test.js
    integration/                  ← multi-module flows with mocked adapters
      paste-then-apply.test.js
      smart-suggest-replan.test.js
      mode-flip-during-edit.test.js
      close-reliability.test.js
    e2e/                          ← Playwright against served web/
      route-editor.spec.ts
      close-reliability.spec.ts
      safe-area-inset.spec.ts
    fixtures/
      mock-adapters.js
      sample-routes.js            ← KLKR-K44N (100 fixes), simple-direct, paste-strings
      sample-airspaces.js         ← NY Bravo polygon, P-40, etc.
```

Tooling: **vitest** (good ESM, runs in jsdom with no transform, watch UI). Lighter alternative: `node --test`.

### Tier 1 — Required automated (block Spec B completion)

| Suite | Purpose |
|---|---|
| `editor/route-editor-state.test.js` | Apply / Apply&Close / discard transitions; dirty detection; pendingComparison preserves through mode flips |
| `editor/route-editor-bus.test.js` | Every documented event reaches every documented consumer; no infinite loops; AbortController cancels in-flight planner |
| `integration/close-reliability.test.js` | Close from each editor state (clean / dirty / pending-suggestion / mid-compute / keyboard-open). Force-close watchdog fires on stuck-state simulation. `app.forceCloseEditor()` always succeeds. |
| `integration/paste-then-apply.test.js` | Paste valid string → Parse → Apply persists to mock PlanStore; baseline updates; downstream `editor:applied` event fires |
| `e2e/route-editor.spec.ts` | Open editor → paste → apply → editor closes → cockpit map shows new route |
| `e2e/safe-area-inset.spec.ts` | Inject simulated safe-area inset; verify editor header sits below it; `[×]` fully visible/tappable |
| Touch-handling tests in `editor/route-editor-list.test.js` | Synthetic `TouchEvent` sequences verify timer thresholds and multi-touch reset |

### Tier 2 — Strongly recommended automated

| Suite | Purpose |
|---|---|
| `integration/smart-suggest-replan.test.js` | Tap airspace → planner produces comparison → branch-point change re-runs → accept → applied. End-to-end with mocked aero + weather. |
| `integration/mode-flip-during-edit.test.js` | Pending comparison survives `mode:changed`; section visibility flips; weather adapter swaps |
| `editor/route-editor-paste.test.js` × failure modes | Each parser failure produces specified UI state |
| `editor/route-editor-comparison.test.js` × failure modes | flywhere.app 5xx → cached badge; FIS-B disconnect → cached banner; missing winds → "calm winds" note |

### Tier 3 — Required hardware / cockpit manual tests (release gate)

Documented as `tests/cockpit-checklist.md`. Run before declaring Spec B done.

```
Hardware: Lenovo Yoga Tab Plus (Android)
Lighting: outdoor sunlight (south-facing window if not sunny)
Hands:    bare + winter glove

EDITOR REACHABILITY
  □ Editor opens via existing entry point
  □ Top-right [×] tappable bare finger
  □ Top-right [×] tappable with glove
  □ Top-right [×] not obscured by Android system banner
  □ Bottom-toolbar [Close] tappable bare/glove
  □ Bottom-toolbar [Apply] and [Apply & Close] tappable in sun

MAP VISIBILITY
  □ At least 60% viewport width is map at all times
  □ Map shows GPS, traffic, weather while editor open
  □ Map pan not swallowed by editor
  □ Critical event (synthetic TFR alert) dims editor, doesn't hide map

GESTURES (each ≥3/5 successful under sun)
  □ Tap fix in list → marker highlights on map
  □ Tap airport marker → popup with edit actions
  □ Tap navaid marker → popup
  □ Tap fix marker → popup
  □ Tap airspace polygon → "Avoid this airspace"
  □ Long-press route segment → insert picker
  □ Tap during map drag does NOT trigger insert/avoid

PASTE FLOW
  □ Paste 1800wxbrief route, hit Parse → see route on map within 2s
  □ Pasted airway tokens (e.g., V143) expand to their interior transition fixes;
    every fix appears as a map marker AND as a pill in the route list
  □ Invalid route → inline error visible, doesn't dismiss editor
  □ Apply → map updates, editor stays open
  □ Apply & Close → editor closes, map full-screen

ROUTING-MODE PICKER
  □ Aircraft profile defaults to v-airways → planner produces V-only routes
  □ Switch to gps-direct → next plan/replan returns 2 fixes (DEP, DEST)
  □ Switch to t-airways with a profile that has none → red "no T-airway route"
    banner; pilot can switch back without losing edits

SMART-SUGGEST AVOIDANCE
  □ Open KLKR→K44N route, tap NY Class B → comparison appears within 5s
  □ Comparison shows wind-corrected ETE delta, fuel delta, "clear of TFRs"
  □ Tap Change branch point → tap RBV → comparison re-runs
  □ Accept → editor reflects new route; map updates

CLOSE RELIABILITY
  □ Close clean: editor closes immediately
  □ Close dirty: confirm dialog appears INSIDE editor pane (not over map)
  □ Close mid-compute: editor closes, no orphan spinner
  □ Force-close (long-press [×]): editor closes regardless of state

MODE TRANSITIONS
  □ Editor open on home WiFi; disconnect WiFi → "now using internet" badge
  □ Editor open with internet; tablet enters airplane → "in flight" banner,
    sections collapse, weather routing flips to FisbWeather
  □ Pending comparison survives both transitions

PERFORMANCE
  □ Paste 100-fix route → first render in <2s
  □ Tap airspace → comparison rendered in <5s (online tier)
  □ Apply persists in <1s
```

### Tier 4 — Recommended manual

- Full edit-flow walkthrough during a real (or simulated via `tools/fake-stratux.js`) flight.
- Block `https://flywhere.app/api` in dev tools; verify cached-fallback path.
- Run editor on browser shell (Python static server) and verify everything works without Capacitor.
- Run editor with stale NASR (older than 28 days) — no crash, just a stale badge.

### Test data fixtures

```js
// fixtures/sample-routes.js
export const KLKR_K44N_VIA_AIRWAYS_100FIX  = { /* 100-fix airway-expanded route */ };
export const KLKR_K44N_DIRECT_2FIX         = { /* simple direct */ };
export const KLKR_K44N_WX_BRIEF_REFERENCE  = { /* 1800wxbrief gold standard */ };
export const PASTE_ICAO_VALID    = "LOCAS V409 GANTS V103 GSO V143 LRP V39 SAX V249 HELON V167 SPEC";
export const PASTE_ICAO_TYPO     = "LOCAS V409 GANTSXXX V103 GSO";
export const PASTE_ICAO_AMBIG    = "GPS V139";
```

## Out of scope (explicit non-goals)

- **Drag-to-rubber-band on map** — ForeFlight signature gesture; complex (snap-to-airway, real-time replan validation). Defer to its own spec.
- **Two-finger / multi-touch gestures** — cockpit-unfriendly.
- **Pinch to fit route to screen** — already handled by map zoom controls.
- **Multi-device flight plan sync** — no Supabase/cloud sync. flytab IDB is the active source on the tablet.
- **Garmin GPS 175 Bluetooth sync** — per Connext research, no realistic OSS path.
- **USB / SD card .fpl import-export** — explicitly removed per pilot direction (impractical).
- **Preferred-route DB integration (FAA NFDC PRD)** — bundled into a future spec on planner improvements.
- **Multi-flight-plan comparison** — pilot can store multiple plans but only one is "active". Side-by-side comparison of plans is future work.
- **ATC clearance amendment via voice / NLP** — not Spec B scope.
- **Cross-runtime UI sharing with flywhere** — covered by the "unified app" deferred brainstorm.

## Dependencies / prerequisites

| Prerequisite | Status | Notes |
|---|---|---|
| Planning library architecture sketch | ✅ approved 2026-05-04 | Module boundaries fixed |
| Port flywhere planning lib (engine-data, route-math, fuel-phases, optimizer) | ⏳ work item | Mechanical TS→JS port; no separate brainstorm needed |
| flywhere.app proxy endpoints (`/api/wx/*`, `/api/notam`) | ⏳ work item | Requires its own design (URL paths, auth, response shapes, caching, error contract) |
| `app.networkMode` already exists | ✅ | `web/shared/network-mode.js` |
| `app.fisbClient` already exists | ✅ | `web/shared/fisb-client.js` |
| `app.airportPopup` already exists | ✅ | `web/cockpit/airport-popup.js` — needs `setEditMode()` extension |
| Existing `route-planner-panel.js` to extend | ✅ | `web/cockpit/route-planner-panel.js` |
| `route-table.js` extension for phase columns | ⏳ part of Spec B implementation | Adds Alt/Hdg/TAS/RPM/MP/%Pwr/Wind/GS/Fuel/Rem columns |
| Vitest + Playwright + jsdom | ⏳ part of Spec B implementation | First test infra in flytab |

## Deferred questions (own brainstorms when relevant)

1. **Cross-runtime / unified-app strategic direction** — converge flywhere + flytab into one product, or keep them as two apps sharing a lib? 1–2 day brainstorm.
2. **flywhere.app proxy endpoint design** — exact URL paths, auth, response shapes, rate limits, caching, error contract.
3. **Drag-to-rubber-band on map** — own spec.
4. **Preferred IFR route DB integration** — FAA NFDC PRD into the planner's cost function.
5. **Multi-flight-plan library + side-by-side comparison** — store and compare multiple alternates.
6. **Project-wide safe-area-inset audit** — every flytab page respects Android system banner. Spec B leads by example; rest of app follows.
7. **Garmin GPS 175 interop** — deferred indefinitely; no realistic OSS path.

## What this spec commits

- The complete editing UX described in the TL;DR.
- 6 new editor modules + extensions to `route-planner-panel.js`, `route-table.js`, `airport-popup.js`.
- `EditorBus` event protocol; no sibling cross-imports between editor modules.
- Reuse of `app.networkMode`, `app.fisbClient`, `app.airportPopup` singletons; no duplicates.
- Mode-aware section visibility (ground full / in-flight collapsed) driven by `app.networkMode.mode`.
- Custom touchend + SVG CTM map hit-testing (no Leaflet `.on('click')`).
- Hard map-visibility invariants (≥60% map width, no fullscreen modals, force-close watchdog).
- Android safe-area-inset compliance + 56×56 high-contrast close X.
- Vitest + Playwright + jsdom test infrastructure; Tier 1 automated suite + Tier 3 hardware checklist as release gates.
