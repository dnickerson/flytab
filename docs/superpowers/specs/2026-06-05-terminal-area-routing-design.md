# Terminal Area Routing — Design Spec
**Date:** 2026-06-05
**Status:** Approved

## Overview

Adds opt-in Class B terminal area detection to the IFR route planner. Before A\* runs, the pilot is shown a wizard for each Class B airport that lies along the direct route. The pilot picks a routing strategy per terminal area; those selections become mandatory via-pins fed to the existing `planVia()` API. Routes exit the planner as ATC-preferred strings the pilot is likely to receive clearance on as filed.

---

## Architecture

Three files change:

| File | Change |
|------|--------|
| `web/shared/planning/planner/terminal-analyzer.js` | **New.** Class B detection and option builder. |
| `web/shared/planning/index.js` | **Modified.** Add `TerminalAnalyzer` to static exports and to `window.FlyTabPlanning` block — same pattern as `RoutePlanner`. No new `<script>` tag needed. |
| `web/cockpit/route-planner-panel.js` | **Modified.** Wizard overlay + opt-in setting + `planVia()` call path. |
| `web/index.html` | **No change.** |

---

## Safety Contract

The existing `plan()` call path is **never modified**. The terminal wizard is a pre-step that either:
- resolves to `planVia()` (when pilot completes the wizard), or
- falls through to the unchanged `plan()` call (on Cancel, analyzer error, or feature disabled).

```
_onPlan():
  if (!this._terminalRoutingEnabled) return this._runPlan(dep, dest)

  let analysis
  try {
    analysis = await this._terminalAnalyzer.analyzeRoute(dep, dest)
  } catch {
    analysis = { hasTerminalAreas: false }   // silent fallback — never breaks existing flow
  }

  if (!analysis.hasTerminalAreas) return this._runPlan(dep, dest)

  const selections = await this._showTerminalWizard(analysis.terminalAreas)
  if (!selections) return this._runPlan(dep, dest)   // pilot cancelled

  const pins = await this._terminalAnalyzer.resolveViaPins(dep, dest, selections)
  return this._runPlanVia(pins)
```

`planVia()` is already in production in the planning library. No new A\* logic is introduced.

---

## `TerminalAnalyzer` Class

**Location:** `web/shared/planning/planner/terminal-analyzer.js`

**Constructor:** `new TerminalAnalyzer(aeroDataSource)`
Uses the same `AeroDataSource` adapter as `RoutePlanner` — no direct IDB access, fully mockable for tests.

### Static Data (baked into module)

**Class B airports — Eastern US corridor (initial scope):**

| ICAO | Name | Radius |
|------|------|--------|
| KATL | Atlanta | 40nm |
| KCLT | Charlotte/Douglas | 40nm |
| KRDU | Raleigh-Durham | 30nm |
| KDCA | Reagan National | 30nm |
| KIAD | Dulles | 35nm |
| KBWI | Baltimore/Washington | 30nm |
| KPHL | Philadelphia | 35nm |
| KEWR | Newark | 30nm |
| KJFK | JFK | 30nm |
| KLGA | LaGuardia | 22nm |
| KBOS | Boston | 30nm |

**Per-airport T-route associations** (verified against airways IDB at runtime):

| Airport | T-routes |
|---------|----------|
| KCLT | T200, T201, T202, T203 |
| KATL | T228, T229 |
| KRDU | T289 |
| KJFK / KEWR / KLGA | *(none — NYC handled via lateral corridor)* |
| KDCA / KIAD / KBWI / KPHL / KBOS | *(avoidance corridors only)* |

**Per-airport avoidance corridors:**

| Airport | Label | Via fixes |
|---------|-------|-----------|
| KCLT | East of Charlotte — LOCAS direct GSO | LOCAS, GSO |
| KRDU | South of Raleigh-Durham — direct RIC | RIC |
| KDCA | East of DC SFRA — via ESN | RIC, ESN |
| KJFK / KEWR / KLGA | Eastern Shore corridor — ESN to SBJ | ESN, SBJ, PUT |
| KPHL | South via SBJ | SBJ |
| KBWI | East via ESN | ESN |
| KBOS | South via ORW | ORW, MHT |

### `analyzeRoute(depId, destId)` → `TerminalAnalysis`

1. Resolves dep/dest coordinates via `aeroDataSource.getAirport()`
2. Iterates Class B airports; skips dep/dest airports
3. Checks `gcIntersectsCircle()` — 25-sample great-circle scan at 4% fractions
4. For each intersection, builds options:
   - **T_ROUTE** — looks up each named T-route in the airways store; verifies waypoints exist and route is near the Class B; computes detour vs. direct; via-pins are **all T-route waypoints** (not just entry/exit) to force A\* onto the exact preferred routing
   - **AVOIDANCE** — corridor fixes become via-pins; coordinates resolved from the airways fix cache
   - **ATC_DIRECT** — always present as last option; produces no via-pins; falls through to `plan()`
5. Sorts T-route options by detour (shortest first); marks shortest T-route `recommended: true`
6. Returns `{terminalAreas: [...], hasTerminalAreas: boolean}`

### `resolveViaPins(depId, destId, selections)` → `Pin[]`

- `Pin = {id: string, lat: number, lon: number}`
- Iterates `selections` in along-track order; skips `ATC_DIRECT` selections (they contribute no pins)
- Resolves each remaining fix to coordinates via `aeroDataSource`
- Orders pins by along-track fraction (dep→dest) to guarantee route ordering
- Deduplicates adjacent identical pins
- Prepends dep pin, appends dest pin
- If all selections are `ATC_DIRECT`, returns `null` → caller falls through to `plan()`
- Returns the full `pins` array ready for `planVia()`

**Mixed-selection example:** Pilot picks T200 for KCLT and ATC_DIRECT for KBWI. `resolveViaPins()` includes T200 waypoints as pins, skips KBWI. `planVia()` routes dep→T200 waypoints→dest via airways; KBWI handling is left to ATC.

---

## Wizard UI

### Trigger

Inside `RoutePlannerPanel._onPlan()`, after the existing dep/dest validation and before the planner call.

### Layout

Full-width modal overlay, portrait-optimised. One "page" per Class B detected; paginated with "1 of N" indicator when multiple.

```
┌────────────────────────────────────┐
│  CLASS B: Charlotte/Douglas    1/2 │
│  Route passes 8nm from track       │
│                                    │
│  ◉ T200 — through CLT Class B   ★  │
│    Enter SHIPP · exit KILNS        │
│    MEA 3,000ft · on track          │
│                                    │
│  ○ East of Charlotte — LOCAS/GSO   │
│    RNAV transition, avoids core    │
│    +12nm                           │
│                                    │
│  ○ File direct — let ATC amend     │
│    Re-check fuel after amendment   │
│                                    │
│           [Cancel]  [Continue →]   │
└────────────────────────────────────┘
```

- Touch targets: `min-height: var(--touch-min, 56px)` on each option row
- Recommended option (`★`) pre-selected
- Colors: design token system only — no hardcoded hex
- "Continue →" advances to next Class B or, on last page, fires `resolveViaPins()` + `planVia()`
- "Cancel" on any page → falls through to existing `plan()` unchanged

### State

`_terminalSelections: Map<icao, option>` — one entry per terminal area, updated as pilot pages through wizard. Cleared at wizard open.

---

## Settings — Opt-in Toggle

**Location:** Existing ⚙ popup in `RoutePlannerPanel`, below "Routing mode" row.

**Label:** "Terminal areas"
**Options:** Off (default) | T-routes

**Persistence:** Added to `flypi_planner_opts` localStorage object under key `terminalRouting`. Value: `'off'` | `'t-routes'`. Default `'off'`.

```
Routing mode      [V-airways ▾]
Terminal areas    [Off       ▾]
```

When `'off'`: `_onPlan()` skips the terminal check entirely — zero change to existing behaviour.

---

## Data Flow Summary

```
Pilot taps Plan
  └─ terminalRouting === 'off'?  → _runPlan() [existing path, untouched]
  └─ TerminalAnalyzer.analyzeRoute(dep, dest)
       └─ error?                 → _runPlan() [silent fallback]
       └─ no Class B found?      → _runPlan() [existing path]
       └─ Class B found
            └─ _showTerminalWizard(terminalAreas)
                 └─ pilot cancels → _runPlan() [existing path]
                 └─ pilot confirms
                      └─ resolveViaPins() → Pin[]
                      └─ _runPlanVia(pins) → planVia() [existing method]
```

---

## Testing

**Unit tests** (add to `tests/` alongside existing planning lib tests):
- `TerminalAnalyzer.analyzeRoute()` with mocked `aeroDataSource`
  - Route with no Class B → `hasTerminalAreas: false`
  - KLKR→KMHT → detects KCLT; T200 option present; avoidance option present
  - Dep/dest is a Class B airport → not flagged as intersection
- `resolveViaPins()` — ordered, deduped, dep/dest prepended/appended

**Manual smoke tests before merge:**
1. Route with no Class B (e.g. KLKR→KSAV) — terminal routing off and on → identical result
2. Route through CLT (KLKR→KMHT) — terminal routing off → existing plan(); on → wizard appears, T200 selected → `planVia()` produces T200 waypoints in route string
3. Cancel wizard mid-flow → falls through to `plan()`, no error
4. Analyzer throws (IDB not loaded) → falls through to `plan()`, toast message

**`npm test` must pass before and after.**

---

## Out of Scope

- Class B airports outside Eastern US corridor (can be added later by extending static data)
- High-altitude (J-route / Class A) handling
- Automatic altitude suggestion based on MEA
- Preferred IFR routes (PIR) database integration
