# Fuel Management System — Consistency & Correctness Redesign

**Date:** 2026-07-31
**Status:** Approved
**Scope:** FlyTab cockpit app — fuel tracking, display, and planning (RV-9A N194JT)

---

## Background

A pilot-reported display inconsistency (fuel REM jumping upward at a fuel-stop waypoint in the route table) led to a full audit of the fuel management system, run as five parallel research passes over every fuel-related module. The audit found the jump was one symptom of a broader architectural problem: **the app has no single source of truth for "fuel remaining."** At least five independent concepts of current fuel are computed and displayed by different screens with no reconciliation:

1. The Raspberry Pi's own `FuelTracker` integrator (`data.fuel.fuel_remaining`)
2. The raw EDM tank-sender reading (`Fuel_Remaining`)
3. `FuelState.getStartFuel()` — client-side priority-chain resolver (manual → tic/EDM → capacity)
4. `FuelTankState.left_gal`/`right_gal` — a separate client-side per-tank burn integrator
5. The route-planning library's hardcoded GPH assumptions vs. `aircraft-config.json`'s — even the *planned* number isn't singular

And the two client-side state objects (`FuelState`, `FuelTankState`) are only kept in sync at 2 of the ~5 places that mutate fuel state. This document is the design for resolving that, plus every other consistency/correctness finding the audit produced (full list in Appendix A).

This is a safety-critical subsystem — fuel exhaustion is a leading cause of GA accidents — and the app has a documented history of recurring fuel bugs (see git log, many past `fix(fuel):` commits).

## Goals

Stated by the aircraft owner/pilot, verbatim intent preserved:

1. Accurate fuel display based on fuel flow (GPH integration)
2. Correct fuel level in gallons before takeoff (preflight tic measurement)
3. Fuel level displayed during flight, based on fuel flow
4. Compare fuel used per the EDM (fuel-flow integration) against fuel used as calculated from tic measurements taken at each fuel stop
5. Fuel remaining for each leg of a flight, based on fuel flow and predicted winds at the flight level
6. A canonical fuel-flow-by-%-power table, graduated in 5% increments (e.g. 40–45%, 46–50%, 51–55%, ...)

## Non-goals / preserved behavior

- **The live-GPH-override capability in `route-table.js:_computeEnroute()` must survive intact.** Per `docs/superpowers/specs/2026-05-06-winds-performance-fuel-stops-design.md`: planned GPH (wind/altitude-corrected baseline from the route planner) is the pre-flight reference; live GPH from the engine monitor overrides it automatically once airborne. This redesign changes *which* live-fuel-remaining number consumers read, not this override mechanism.
- **Wind-corrected per-leg time/TAS/GS math is not being redone.** It was built in the May design and is assumed correct; this design only fixes what GPH feeds into it and how the resulting fuel-remaining figure is displayed downstream.
- **The Pi's own `FuelTracker` (`engine_monitor.py`) is not being replaced or made canonical.** It cannot fully take over `FuelTankState`'s role because tank-selection state (`active_tank`) lives client-side and the Pi has no per-tank L/R model — it only integrates a single total from `Fuel_Flow`. It continues to receive corrections via the existing `POST /api/fuel/set` / `/api/fuel/add` calls in `fuel-overlay.js` as a secondary mirror, unchanged.

## Architecture

### 1. Canonical live fuel source: `FuelTankState`

`FuelTankState` (per-tank, continuously burn-integrated via `onSample(gph, nowMs)`, already has staleness/confirm logic) becomes the **one** live "fuel on board" ledger. No change to its integration formula. What changes is that every consumer in the app reads from it — directly or via `FuelState` — instead of independently re-deriving a number from raw EDM data.

**Interface contract:** `FuelTankState.getState()` returns `{ left_gal: number, right_gal: number, active_tank: 'L'|'R'|'BOTH', requires_confirm: boolean, imbalance: boolean, last_sample_at: string(ISO), initialized_at: string(ISO) }` or `null` if never initialized. All consumers MUST null-check and fall back to a capacity-based placeholder (never crash/blank) when `null`.

### 2. `FuelState` becomes the override layer

`FuelState` stops independently resolving EDM/tic values. New method `FuelState.getCurrentFuel()` replaces the live-value role of `getStartFuel()`:

```
getCurrentFuel():
    if Settings.fuelManualOverride is set (number > 0):
        return { gallons: override, source: 'manual' }
    else if FuelTankState.getState() is not null:
        return { gallons: state.left_gal + state.right_gal, source: 'tank_state' }
    else:
        return { gallons: capacity, source: 'capacity' }
```

`getStartFuel()` is retained for existing pre-flight-planning call sites (`route-table.js` flight-0 start fuel, `wb-overlay.js`) but its body is simplified to delegate to `getCurrentFuel()` — no independent EDM/tic resolution logic remains in `fuel-state.js`.

**Capacity fallback fix:** `fuel-state.js`'s hardcoded fallback changes from `50` to read `CockpitConfig.aircraft('performance.fuel_capacity_gal')` with no override default (or a default matching `fuel-tanks.js`'s own fallback derivation) — the two files' fallbacks must never disagree.

### 3. Fuel-stop and preflight are the same operation

Every fuel quantity reset — preflight, an auto-detected in-flight fuel stop, or a manual "record fuel stop" — is: **pilot takes a fresh tic reading → `FuelEngine.ticToGallons()` → `FuelTankState.init(leftGal, rightGal, activeTank)`.** This replaces the current additive "estimate remaining + gallons added, clipped to capacity" arithmetic entirely — there is no estimate to get wrong, because a fresh physical measurement is definitionally ground truth.

**Trigger conditions for this flow (must all lead to the same code path):**
- Preflight, pilot taps the fuel-tanks widget edit pencil (`fuel-tanks.js` init dialog)
- In-flight, the app auto-detects proximity to a fuel-stop waypoint and shows the overlay (`app.js:_showFuelStopOverlay`) — **currently asks "gallons added," must change to prompt for a fresh tic reading**, reusing `fuel-overlay.js`'s existing tic-entry UI rather than duplicating it
- In-flight, pilot manually opens "RECORD FUEL STOP" (`fuel-overlay.js:_recordFuelStop`) — already correct, becomes the reference implementation the other two call sites converge on

**State lifecycle note:** `wp.fuel_add_gal` (pilot's pre-flight-declared expected refuel amount) is retained ONLY as an input to the *planning-time projection* for legs not yet reached (Section 5). It is never read or written by the actual fuel-stop-execution flow above once the pilot has physically reached and measured at that stop.

### 4. Raw EDM sender: secondary display, with a known accurate range

The resistive tank-level sender (`fuel_level_l`/`fuel_level_r` fields, distinct from the `Fuel_Flow` transducer) only reports meaningfully between 0 and 12 gal in an 18-gal-per-side tank — above 12 gal remaining it reads an invalid/flat value. This threshold is aircraft/sender-hardware-specific and must be a config value, not a hardcoded constant:

**New `aircraft-config.json` field:** `performance.fuel_sender_accurate_below_gal: 12` (per side; applies symmetrically to both tanks unless a future aircraft needs asymmetric values, which this field does not preclude — a per-side override can be added later without a schema break).

**Display behavior (`fuel-tanks.js:_updateSenderDisplay`):** for each tank, compare `FuelTankState`'s tracked level for that side against `fuel_sender_accurate_below_gal`. Above the threshold: sender readout is suppressed/grayed (e.g. `s:—`), never shown as a number. At or below the threshold: shown normally, exactly as today.

The sender remains purely a secondary cross-check — it never feeds into `FuelTankState`'s integration, `FuelState`'s resolution chain, or the fuel-used reconciliation in Section 8 (that reconciliation compares fuel-flow integration against tic measurements, a completely separate pair of data sources from the level sender).

### 5. `route-table.js` fixes

- **Active-flight fuel uses the live source.** Once the pilot's active waypoint index falls within flight N's waypoint range (any N, not just 0), that flight's starting fuel comes from `FuelState.getCurrentFuel()` — the same mechanism flight 0 already correctly uses today. The existing `activeFlightNum === 0` special case is removed; the condition becomes "is this the flight currently being flown," independent of its index.
- **Flights not yet reached** keep a forward-looking *projection*: `min(capacity, lastProjectedRemaining + (wp.fuel_add_gal ?? (capacity - lastProjectedRemaining)))`, clearly distinguished in the UI (e.g. a label or styling difference) from the live figure so a pilot never confuses a planning estimate with a measured value.
- **Reset-ordering fix:** for the projection path, a waypoint's own arrival-leg segments (CLB/CRZ/DES burn *into* the stop) must be deducted from the running projected total *before* any top-off/reset logic for that same waypoint index runs — currently backwards, causing the REM figure to jump upward at the arrival row instead of decreasing.
- **DEST reserve fuel-stop awareness:** `_updateSummary()`'s live-engine-data branch must compute remaining distance against the *active flight's* destination, not the trip's final destination, when a fuel stop lies between the active leg and the final destination. Today it unconditionally uses total remaining trip distance whenever live engine data is present, silently ignoring any stop.
- **Passed-leg staleness:** the "mark passed waypoints" step must null the same fields at the segment level (`seg._fuel`, `seg._fuelRem`, `seg._tas`, etc.) that it already nulls at the waypoint level — today only single-segment (no CLB/DES) passed legs display correctly as cleared; multi-segment legs (most departures/arrivals) keep showing stale numbers.
- **Destination lookup consistency:** `_updateSummary()`'s DEST reserve calculation and `_emitRouteChange()`'s saved-plan destination must both use the same APT-type-aware "walk backward to find the last actual airport" lookup that the header label already uses — not the raw last array entry, which can be a trailing missed-approach/hold fix.

### 6. Canonical %power → GPH table

`aircraft-config.json`'s existing `power_settings[]` array becomes the single source of truth, extended to cover 5%-wide bands across the aircraft's full operating range (e.g. `40-45`, `46-50`, `51-55`, ... `71-75`), each entry data-derived from EDM+GPS flight logs where sample data exists, else interpolated/extrapolated from the nearest populated bands with `samples: 0` and a UI indicator that the value is unvalidated.

**Interface contract:** `{ band: "51-55", pct_mid: 53, gph: number, samples: number }`. Lookup by a given `%power` value selects the band whose range contains it.

`web/shared/planning/planner/route-planner.js`'s `RV9A_FALLBACK` and `web/shared/planning-adapters/idb-profile.js`'s `RV9A_DEFAULT` stop carrying their own hardcoded `fuel_burn_gph`/`fuelPhases.cruise.gph` numbers — both look up the band table instead, at whatever `%power` the flight plan specifies (default cruise `%power` from `aircraft-config.json`'s `performance.cruise_pwr_pct`). This removes the 8.1-vs-9.0 disagreement and the three-way duplication of aircraft performance data at the root; there is one place to edit and one place the config UI needs to expose.

`reserve_gal` (currently only in the two duplicated JS objects, invisible to the config editor) moves into `aircraft-config.json`'s `performance` block alongside the rest, and becomes editable from `config-editor.js`.

### 7. Consumer migration

Every screen currently reading fuel independently switches to `FuelState.getCurrentFuel()` for gallons and the Section 6 table for GPH:

| File | Current behavior | New behavior |
|---|---|---|
| `engine-page.js` | Own inline EDM field-fallback chain, bypasses `FuelEngine.extractEdmFuel()` and `FuelState` entirely | `FuelState.getCurrentFuel()` |
| `range-calc.js` | Broken fallback chain (missing the one real field name) → permanently blank | `FuelState.getCurrentFuel()` — fixes the blank-display bug as a direct consequence |
| `route-table.js:_emitLegUpdate()` | Raw `engData.Fuel_Remaining`, feeds `route-nav-strip.js`/`power-tradeoff.js` | `FuelState.getCurrentFuel()` — manual override now reaches both downstream displays |
| `power-tradeoff.js` | Live GPH from raw engine data; fallback GPH from `ps.gph` (already close to the Section 6 table, just needs to point at the canonical one) | Canonical %power/GPH table |
| `wb-overlay.js` | Reads `FuelState.getStartFuel()` once per overlay-open, no staleness check | Same read, plus a `FuelTankState.needsConfirmation()` check — surface a warning rather than silently pre-filling an unconfirmed value |
| `engine-page.js` (config keys) | Reads non-existent `enginePage.fuelLowGal`/`fuelCriticalGal` | Reads the real `fuelCautionGal`/`fuelWarningGal` keys, matching every other consumer |
| `engine-page.js` ("used" gauge) | Reads non-existent `d.flight_fuel_used` | Reads `d.fuel.flight_fuel_used` (the real nested Pi-tracker field) |

### 8. Fuel-used reconciliation (Goal 4)

At every fresh tic measurement (preflight, fuel stop, or an ad hoc mid-flight recheck via the same UI), compute and persist:

- `edmUsedSinceLastMeasurement` — cumulative GPH×Δt already integrated by `FuelTankState.onSample()` since the prior `initialized_at`/measurement timestamp (this is exactly what `FuelTankState`'s running total already reflects; the delta is `previousInitTotal − currentTrackedTotalJustBeforeReinit`)
- `measuredUsed` — previous tic-measured gallons minus new tic-measured gallons (no "added" term needed, since a stop is now a fresh re-init rather than an additive operation — see Section 3)
- `varianceGal = edmUsedSinceLastMeasurement − measuredUsed`

**Interface contract, extends the existing measurement object** (`FuelEngine.createMeasurement()`'s output, already has an unused `variance_gal` field — this design activates it): add `edm_used_gal: number`, `measured_used_gal: number` alongside the existing `variance_gal`.

**Display:** shown on the `fuel-overlay.js` measurement-entry screen at the moment the pilot takes the new reading (most actionable point — if the sender/transducer is drifting, they see it immediately). Also appended to `flypi_fuel_history` (already the persisted flight-to-flight log) so a drifting trend across multiple flights is visible, not just a single-flight snapshot.

**Dropped-burn visibility:** `FuelTankState.onSample()` caps `dtMs` at `MAX_SAMPLE_DT_MS` (10s) to avoid over-counting a single large burn on reconnect after a comms gap — this stays as-is (it's the conservative direction: dropping unknown burn rather than guessing it, given a wrong guess could overcount). What changes: each time a sample's raw `dt` exceeds the cap, accumulate the discarded `(dt - MAX_SAMPLE_DT_MS) * gph / 3600` into a running `dropped_burn_estimate_gal` counter on the tank state. This is surfaced alongside the Section 8 variance figure — a pilot who sees a nonzero dropped-burn estimate at their next tic measurement knows some of any observed variance may be attributable to comms gaps rather than sender/transducer drift, instead of the two being indistinguishable as they are today.

### 9. Timing and staleness fixes

- **Confirm-prompt timing:** `FuelTankState._lastConfirmPromptAt` is an in-memory static field that resets to `0` on every page load, so the 30-minute "still on LEFT tank?" prompt fires immediately after every restart instead of 30 minutes later. Fix: seed it to `Date.now()` at `init()`/`_load()` time (i.e. "the clock starts now," not "the clock started at epoch") rather than leaving it at `0`.
- **Continuous staleness re-evaluation:** the 45-minute no-data staleness check currently only runs once, inside `_load()`'s `if (FuelTankState._loaded) return` guard — so a silent mid-flight data gap after the app has been open a while is never flagged. Fix: move the staleness comparison (`nowMs - last_sample_at > STALE_MS`) into `getState()`/`onSample()` so it's re-evaluated on every access, not just the first one per page load.
- **Open-panel sync gaps** (`fuel-tanks.js:_refreshOpenPanel()`, landed 2026-07-31): two gaps remain in the fix that closed the tic-measurement staleness case. (a) `FuelState.setManualOverride()` only dispatches `fuelstate:changed`, which `fuel-tanks.js` doesn't listen for — add that listener alongside the existing `fueltankstate:changed` one so a manual override also refreshes an open panel. (b) `_refreshOpenPanel()` runs unconditionally on every state-change event while the preflight dialog is open, including the routine per-sample burn-integration events — it can overwrite a pilot's in-progress, unsaved edit with a live value before they tap SET. Fix: track a "dirty since open" flag, set the moment the pilot changes either input field, and skip the auto-refresh while dirty (recovery-mode panels are unaffected, since `onSample()` already no-ops there while `requires_confirm` is true).
- **`Settings.fuelMeasurement` default:** currently a bare string (`'gallons'`) that doesn't match the real measurement-object shape — harmless today only because every read site happens to guard for it. Fix: change the default to `null` and make every read site's existing "no measurement yet" check use `== null` instead of relying on the accidental type mismatch.

## Data model changes summary

| File | Change |
|---|---|
| `web/aircraft-config.json` | `performance.power_settings[]` extended to 5%-band coverage; add `performance.fuel_sender_accurate_below_gal`; add `performance.reserve_gal` |
| `web/shared/fuel-state.js` | New `getCurrentFuel()`; `getStartFuel()` delegates to it; remove independent EDM/tic resolution; fix capacity fallback to match `fuel-tanks.js` |
| `web/shared/fuel-tank-state.js` | No burn-integration-formula change; add `dropped_burn_estimate_gal` running counter; seed `_lastConfirmPromptAt` to `Date.now()` at init instead of `0`; move 45-min staleness check out of the once-per-load `_load()` guard into `getState()`/`onSample()`; consumers elsewhere point at it instead of duplicating its logic |
| `web/shared/fuel-engine.js` | `createMeasurement()` gains `edm_used_gal`/`measured_used_gal` computation |
| `web/cockpit/fuel-tanks.js` | Sender-display suppression above `fuel_sender_accurate_below_gal` |
| `web/cockpit/fuel-overlay.js` | Becomes the reference tic-entry flow reused by `app.js`; variance display added to measurement screen |
| `web/app.js` | In-flight fuel-stop overlay switches from gallons-added input to tic-entry (reuses `fuel-overlay.js` UI) |
| `web/cockpit/route-table.js` | Active-flight live-source fix, reset-ordering fix, DEST reserve fuel-stop awareness, passed-leg segment clearing, destination lookup consistency |
| `web/cockpit/engine-page.js`, `range-calc.js`, `power-tradeoff.js`, `route-nav-strip.js`, `wb-overlay.js` | Migrate to canonical read APIs (Section 7 table) |
| `web/shared/planning/planner/route-planner.js`, `web/shared/planning-adapters/idb-profile.js` | Remove hardcoded GPH/reserve duplication, read Section 6 table |
| `web/cockpit/config-editor.js` | Expose `reserve_gal`, `fuel_sender_accurate_below_gal`, and the power-band table for editing |

## Testing / verification approach

- `web/shared/planning/` has a vitest suite (`npm test`) — the Section 6 power-table lookup and any `route-planner.js`/`fuel-phases.js` changes must have tests added there per CLAUDE.md's build policy (run before build on any change touching this directory).
- `route-table.js` and the cockpit UI files have no automated coverage (per CLAUDE.md) — manual verification required for:
  - The original KFGX-style scenario: a route with a fuel stop, confirming REM decreases monotonically into the stop and the post-stop flight reflects live tracked fuel once reached
  - A multi-leg trip where a deliberately partial (not full) fuel-stop measurement is entered, confirming the post-stop flight's figures reflect the partial fill, not capacity
  - Sender display suppression: verify it grays out above 12 gal and shows normally below, per tank independently
  - Manual override propagating to `route-nav-strip.js`/`power-tradeoff.js` live figures
  - `range-calc.js` no longer blank
  - Engine Page fuel-bar coloring responding to a customized `fuelCautionGal`/`fuelWarningGal` config change
- Per CLAUDE.md's Tap Handler Regression Rule: none of these changes touch `onAirportClick`/`onNavaidClick`/`onFixClick`, so that verification does not apply here — confirm this remains true during implementation (i.e. no incidental touches to those handlers).

## Out of scope

- Rewriting the Pi's own `FuelTracker` (Python side) — stays as a secondary mirror, unchanged.
- Milestone 2 of the May winds/fuel-stops design (proactive fuel-stop candidate search with pricing) — unrelated to this consistency pass.
- Terrain-aware altitude selection — already explicitly out of scope per the May design.

---

## Appendix A — Full audit findings mapped to fixing section

| # | Finding | Fixed by section |
|---|---|---|
| 1 | Flight 2+ always computes from full tank (`_plannedStartFuel` dead code) | §5 |
| 2 | `app.js` fuel-stop overlay never updates `FuelTankState` | §3 |
| 3 | Manual override doesn't reach `route-nav-strip.js`/`power-tradeoff.js` | §7 |
| 4 | `range-calc.js` fallback chain always blank | §7 |
| 5 | Fuel-stop reset ordering clips pilot's typed fuel-added entry | §3, §5 (moot once stops are re-init, not additive) |
| 6 | Planning GPH (8.1) vs. live cockpit GPH (9.0) mismatch | §6 |
| 7 | `FuelState` capacity fallback (50gal) disagrees with real 36gal aircraft | §2 |
| 8 | Original KFGX reset-ordering REM-jump bug | §5 |
| 9 | `FuelTankState` silently discards burn during >10s comms gaps | §8 — capping behavior kept (conservative), but now tracked via `dropped_burn_estimate_gal` and surfaced alongside the variance figure |
| 10 | Confirm-prompt fires immediately after every restart | §9 |
| 11 | Staleness check only runs once per page load | §9 |
| 12 | Fuel-stop L/R split not validated against declared total | §3 (moot — no separate split/total entry once stops are a single re-init reading) |
| 13 | No capacity validation on pilot-entered tank quantities | §3 — `FuelTankState.init()`/entry UI should clamp to configured per-side capacity |
| 14 | DEST reserve ignores fuel stops when live data present | §5 |
| 15 | W&B overlay ignores `FuelTankState` staleness flag | §7 |
| 16 | Engine Page reads wrong config keys for reserve thresholds | §7 |
| 17 | Passed multi-segment legs show stale fuel figures | §5 |
| 18 | Two divergent EDM-fuel extraction implementations | §7 |
| 19 | `_refreshOpenPanel()` gaps: manual override doesn't refresh open panel; can clobber in-progress pilot edits | §9 |
| 20 | Three duplicated hardcoded aircraft profile objects | §6 |
| 21 | `aircraft-config.json` internally inconsistent (9 vs 8.1) | §6 |
| 22 | `_updateSummary`/`_emitRouteChange` destination-lookup inconsistency | §5 |
| 23 | Engine Page "USED (FLIGHT)" placeholder-only gauge | §7 |
| 24 | `_recordFuelStop` mislabels measurement source | §3 (moot — single tic-based flow, source is always accurately 'tic') |
| 25 | `Settings.fuelMeasurement` malformed default | §9 |

Every finding from the audit is addressed by this design — none deferred.
