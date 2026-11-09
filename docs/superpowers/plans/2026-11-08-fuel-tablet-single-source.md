# Fuel On Board: Tablet Is The Single Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every fuel-on-board figure FlyTab shows, records or plans with comes from the tablet's `FuelTankState`; the Pi supplies only fuel **flow** (and the Dynon EMS's own instrument readings), and FlyTab no longer writes fuel state to the Pi.

**Architecture:** `FuelTankState` (`web/shared/fuel-tank-state.js`) already integrates burn and already feeds most displays through `FuelState.getCurrentFuel()`. This plan removes the remaining readers of the Pi's legacy `FuelTracker` (`data.fuel.*`), removes the four tablet→Pi fuel writes and their retry UI, moves the K-factor ratio onto tablet data, closes the one integration gap that matters once the tablet is the only source (burning a frozen fuel-flow value), and finally removes the Pi's FuelTracker itself (Task 6, contract bump).

**Tech Stack:** vanilla JS classic scripts (`web/`), vitest (`tests/`), `bash build.sh`.

**Spec:** Dana, 2026-11-08: *"Syncing to the pi was a legacy design. Fuel measurement should be on the flytab."* Facts below are from origin/main `53d1efd`. Background: `docs/superpowers/specs/2026-07-31-fuel-management-consistency-design.md` (made FuelTankState canonical for displays).

## Decisions (Dana, 2026-11-09)

- **D1 — Pi side: REMOVE the Pi fuel code** (FuelTracker, KFactorCalibration, FUEL_CONFIG, every `/api/fuel/*` endpoint, the status `fuel` block, the `fuel_tracker` capability). The wire shape changes, so `PI_API_CONTRACT` 2→3 and `EngineClient.MIN_PI_CONTRACT` 2→3 (CLAUDE.md bump discipline). Task 6, last — after no tablet code reads `data.fuel`.
- **D2 — Keep the D-180's fuel computer.** The Dynon EMS fields the Pi merely forwards (`data.Fuel_Remaining` = the D-180's own fuel computer, `data.Fuel_Left/Fuel_Right` = tank senders) are instrument readings and **stay** (parsed in `parse_line`, untouched by Task 6). Only the Pi's own integration (`data.fuel.*`) goes.
- **D3 — ENG page gauge labelled "USED"**: gallons burned since the last tic measurement / fuel stop, from FuelTankState (replaces the Pi's `flight_fuel_used` "USED (FLIGHT)"). The manual says what it counts from.
- **D4 — Dropped burn** stays pilot-confirmed (APPLY CORRECTION), applied on the tablet only.
- **D5 — Low-fuel alerting**: a separate plan; not in this one.
- **Execution:** subagent-driven.

## Global Constraints

- localStorage keys are load-bearing (CLAUDE.md "FlyPi" section): keep `flytab_tank_state`, `flypi_fuel_measurement`, `flypi_fuel_manual_override`, `flypi_fuel_history`, `flytab_fuel_stops` names and existing record fields readable. New fields are additive; old records stay valid.
- No Content-Type change, no new network calls, nothing that needs internet in flight.
- Every build bumps `FLYTAB_VERSION` (`web/app.js`); versionCode = major*100+minor. `npm test` green before each build.
- User manual (`docs/user-manual.md`) updated in the same commit as each user-visible change.
- Fuel is safety-relevant: when a figure is unknown or stale, show it as unknown/stale (existing `stale` / UNCONFIRMED conventions) — never substitute a Pi number or capacity silently.

## Review Focus

1. **EMS goes quiet mid-flight** (Pi resends its last row): the tablet must stop burning, not keep integrating the frozen `Fuel_Flow`. → Task 1 test.
2. **Old `flypi_fuel_history` entries** carry `edm_gal` (Pi tracker figure) and no `tracked_gal`: the K-factor ratio and history list must still render, never NaN. → Task 4 test.
3. **Tablet restarted between fuel stop and next view**: no "RETRY PI SYNC" state or message may survive or reappear. → Task 3 test.
4. **No Pi at all** (home WiFi, Pi off): APPLY TIC and RECORD FUEL STOP succeed with no error, no 4 s wait. → Task 3 test.
5. **Flight-recorder CSV readers** (`fuel-overlay.js` `_resolveEdmFuel` CSV fallback reads column 9): after column 9 becomes the tablet figure, nothing may treat it as an independent EDM reading. → Task 5 test.

---

### Task 1: Burn only from current engine data

**Files:**
- Modify: `web/cockpit/fuel-tanks.js` `_handleEngineData` (~98-109)
- Test: `tests/cockpit/fuel-tanks-burn-gate.test.js` (new)

**Interfaces:** Consumes `EngineClient.edmCurrent(status)` (`web/shared/engine-client.js:157`, false when `serial_connected === false` or `serial_warning`), as `engine-ml.js:291` does.

- [ ] **Step 1: Write the failing tests** — `fuel-tanks-burn-gate.test.js`, loading `fuel-tanks.js` via `new Function` like `fuel-tanks-sender.test.js`, with a spy `FuelTankState.onSample`:
  - `it('burns from a current frame')`: `_handleEngineData({ Fuel_Flow: 9.5 })` → `onSample` called once with `9.5`.
  - `it('does not burn from a frozen frame (serial_warning)')`: `{ Fuel_Flow: 9.5, serial_warning: 'no EDM data 30 s' }` → not called.
  - `it('does not burn when serial_connected is false')`: `{ Fuel_Flow: 9.5, serial_connected: false }` → not called.
  - `it('still updates the sender display from a frozen frame')`: `_updateSenderDisplay` spy called.
- [ ] **Step 2: Run** `npx vitest run tests/cockpit/fuel-tanks-burn-gate.test.js` — the two "does not burn" tests FAIL.
- [ ] **Step 3: Implement** — in `_handleEngineData`, call `FuelTankState.onSample` only when `gph > 0 && (typeof EngineClient === 'undefined' || EngineClient.edmCurrent(d))`. A gap created this way is already handled by `onSample`'s `MAX_SAMPLE_DT_MS` / dropped-burn logic when data resumes.
- [ ] **Step 4: Run** the test file — PASS; `npm test` — PASS.
- [ ] **Step 5: Commit** `fix(fuel): burn only from current EMS data`.

### Task 2: One fuel source chain — tablet-tracked, not Pi

**Files:**
- Modify: `web/shared/fuel-state.js` (`getStartFuel` 23-70; header comment 1-11)
- Modify: `web/cockpit/fuel-overlay.js` `_updateSourceDisplay` (~630-645) and its chip HTML (158-169)
- Test: `tests/shared/fuel-state.test.js` (extend)

**Interfaces:** Produces: `getStartFuel()` removed; `_updateSourceDisplay` uses `FuelState.getCurrentFuel()` → `{ gallons, source: 'manual'|'tank_state'|'capacity', stale }`. Chips become `MANUAL › TRACKED › CAPACITY` (`data-src` `manual` / `tank_state` / `capacity`).

- [ ] **Step 1: Failing tests** in `fuel-state.test.js`: `it('getStartFuel no longer exists')` → `expect(FuelState.getStartFuel).toBeUndefined()`; `it('a Pi fuel figure never becomes the fuel on board')`: `window.enginePanel = { lastData: { fuel: { fuel_remaining: 16.9 } }, lastPollTime: Date.now() }`, `FuelTankState` state 15.6 + 18.0 → `getCurrentFuel()` = `{ gallons: 33.6, source: 'tank_state' }`. Add an overlay test (`tests/cockpit/fuel-overlay-source.test.js`, new) asserting the source line reads `33.6 gal (TRACKED)` and the `tank_state` chip is active; with `stale: true` the line carries `· UNCONFIRMED`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — delete `getStartFuel` (its only caller is `fuel-overlay.js:635`); rewrite `_updateSourceDisplay` on `getCurrentFuel()`; update the chip markup. Remove the stale repo-root copy `shared/fuel-state.js` only if `git grep -n "shared/fuel-state.js"` shows nothing loads it.
- [ ] **Step 4: Run** — PASS; `npm test` — PASS.
- [ ] **Step 5: Commit** `refactor(fuel): fuel source chain is manual > tracked > capacity`.

### Task 3: Stop writing fuel to the Pi

**Files:**
- Modify: `web/cockpit/fuel-overlay.js`: `_applyMeasurement` (~717-737), `_recordFuelStop` (~851-899), `_refreshFuelStopButton` (906-910), click handlers (402-427), `_applyDroppedBurnCorrection` (1004-1044), `_refreshDroppedBurnRow` (562-590), `show()` (503-515); delete `_syncFuelSetToEngine`, `_syncFuelAddToEngine`, `_retryFuelStopPiSync`, `_fuelStopAlreadyOnPi`, `_syncDroppedBurnToPi`, `_retryPiDroppedBurnSync` and the fields `_fuelStopPiSyncFailed`, `_lastFuelStopPending`, `_piSyncFailed`.
- Modify tests: `tests/cockpit/fuel-overlay-set-add-sync.test.js` (delete or rewrite as below), `fuel-overlay-fuelstop-guard.test.js`, `fuel-overlay-dropped-burn.test.js`.

**Interfaces:** Consumes Task 2's source display. Produces: APPLY TIC → `FuelState.saveMeasurement(m)` + `FuelTankState.init(...)` only; RECORD FUEL STOP → `flytab_fuel_stops` + `init` + `saveMeasurement` only; APPLY CORRECTION → `FuelTankState.applyDroppedBurn(g)` only.

- [ ] **Step 1: Failing tests** (`fuel-overlay-no-pi-writes.test.js`, new; `fetch` spied):
  - `it('APPLY TIC writes no /api/fuel request and hides the overlay with no error')`.
  - `it('RECORD FUEL STOP with no Pi: recorded, no error, no RETRY PI SYNC label')` — button text stays `RECORD FUEL STOP`.
  - `it('APPLY CORRECTION applies on the tablet only')` — `applyDroppedBurn` called, no fetch, row hides.
  - `it('no Pi-sync message on a later show()')` — Review Focus 3.
- [ ] **Step 2: Run** — FAIL (fetches to `/api/fuel/set|add|apply_dropped_burn`).
- [ ] **Step 3: Implement** — remove the Pi calls, flags, retry branches and messages listed above; keep every existing guard (`_applying`, `_recording`, fresh-tic, capacity, tap-through). Success status text drops the Pi clause.
- [ ] **Step 4: Run** — PASS; `npm test` — PASS (rewrite/delete the three old Pi-sync test files' Pi assertions; keep their guard assertions).
- [ ] **Step 5: Commit** `feat(fuel): fuel measurements stay on the tablet (no Pi sync)` with manual §Fuel Management (lines ~755, 757) updated: no Pi messages, no RETRY PI SYNC.

### Task 4: Tracked fuel replaces the Pi figure in comparisons and the K-factor

**Files:**
- Modify: `web/cockpit/fuel-overlay.js`: `_updateEdmComparison` (~600-620), `_resolveEdmFuel` (~744-784), measurement record (~700-714), `_renderKFactor` (1294-1356); delete the PI K-FACTOR panel (HTML 249-265, `_fetchPiCalibration`, `_renderPiKFactor`, `_applyPiKFactor`, the `show()` call at 515).
- Modify: `web/cockpit/engine-page.js` `_updateTicEdm` (754-777) label only.
- Test: `tests/cockpit/fuel-overlay-tracked-compare.test.js` (new); delete `fuel-overlay-pi-kfactor.test.js`.

**Interfaces:** Produces the measurement record field `tracked_gal` (number|null, FuelTankState total just before the tic was applied) alongside existing fields; `edm_gal` is now the **Dynon EMS** `data.Fuel_Remaining` when fresh, else null (D2). Comparison block: `TIC | TRACKED | VARIANCE (TIC − TRACKED) | ACCURACY`, plus a smaller `D-180: <x> gal` line when `Fuel_Remaining` is fresh.

- [ ] **Step 1: Failing tests:**
  - `it('compares TIC with the tablet-tracked figure, not data.fuel.fuel_remaining')`: tank state 16.0 total, Pi `fuel.fuel_remaining` 30 → TRACKED `16.0`, VARIANCE `+17.6` for TIC 33.6.
  - `it('saved measurement carries tracked_gal; edm_gal is the D-180 field or null')`.
  - `it('K-factor ratio from tracked burn between fills')`: history `[{total_gal: 33.6, tracked_gal: 15.0}, …]` + stops → expected ratio; and Review Focus 2: `it('old history entries with only edm_gal still render a number')` — falls back to `edm_gal`, never `NaN`.
  - `it('no /api/fuel/calibration request on show()')`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — FUEL USED = sum over consecutive history entries of `(prev.total_gal − next.tracked_gal ?? next.edm_gal)` where both are finite; drop the CSV fallback in `_resolveEdmFuel` (column 9 becomes the tablet figure in Task 5 — Review Focus 5). Rename on-screen "EDM" to "TRACKED"; keep the D-180 line. ENG page row label `TIC vs D-180` (it already reads the EMS field 12).
- [ ] **Step 4: Run** — PASS; `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(fuel): compare tic with tracked fuel; K-factor from tablet data` with manual (K-Factor ~783-785, TIC vs EDM ~253, and a short description of the comparison block, which the manual lacks today).

### Task 5: Remaining Pi-tracker readers → tablet (label per D3: "USED")

**Files:**
- Modify: `web/cockpit/engine-page.js` USED gauge (545, 632) and its label; `web/cockpit/flight-recorder.js:663`; `web/cockpit/fuel-tanks.js` `_updateSenderDisplay` (519-535); `web/cockpit/engine-panel.js:198-208`; `web/cockpit/engine-ml.js:244,390`; `web/shared/fuel-engine.js` `extractEdmFuel` (87-98).
- Modify: `web/shared/fuel-tank-state.js`: add `burned_since_init_gal`.
- Tests: extend `tests/shared/fuel-tank-state.test.js`, `tests/cockpit/engine-page-fuel.test.js`, `tests/cockpit/flight-recorder-fuel-remaining.test.js`, `tests/cockpit/fuel-tanks-sender.test.js`, `tests/shared/fuel-engine.test.js`.

**Interfaces:** Produces `FuelTankState` state field `burned_since_init_gal` (number, 0 at `init()`, += every debited gallon in `_debitTank`, += `applyDroppedBurn`); absent in old stored state → read as `null` (shown `—`, not 0).

- [ ] **Step 1: Failing tests:**
  - fuel-tank-state: `it('burned_since_init_gal counts burn and applied dropped burn; init resets it')`.
  - engine-page: `it('USED shows burned_since_init_gal, not data.fuel.flight_fuel_used')` (label text exactly `USED`); old state without the field → `—`.
  - flight-recorder: `it('Gallons Remaining column is the tablet-tracked total')` (`FuelState.getCurrentFuel` stub 21.4, Pi `fuel.fuel_remaining` 30 → `21.4`; capacity source → empty cell, not 36).
  - fuel-tanks sender: reads `d.Fuel_Left/Fuel_Right` (EMS), not `d.fuel.edm_fuel_left/right`.
  - fuel-engine: `it('extractEdmFuel ignores data.fuel.* (Pi tracker)')` → `{ fuel: { fuel_remaining: 30 }, Fuel_Remaining: 12.5 }` gives `12.5`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — as the tests state; `engine-panel.js` and `engine-ml.js` read `FuelState.getCurrentFuel()` (gallons when source ≠ capacity, else 0 / existing fallback) so the hidden panel and the ML advisor never see a Pi tracker number.
- [ ] **Step 4: Run** — PASS; `npm test` — PASS; `git grep -n "fuel\.\(fuel_remaining\|flight_fuel_used\|edm_fuel\)" web/` → no hits.
- [ ] **Step 5: Commit** `feat(fuel): no display, record or advisory reads the Pi fuel tracker`; manual ENG page FUEL STATUS (~247 USED, ~249) and gauge table row (~232) updated; bump version; `bash build.sh`.

---

### Task 6: Remove the Pi fuel tracker (D1)

**Files:**
- Modify: `engine-monitor/engine_monitor.py`: delete `FUEL_CONFIG` (~115-149), `KFactorCalibration` (151-241), `FuelTracker` (244-~720), `state.fuel_tracker` (781, 2753-2754), the update call in the serial loop (~1863-1875), the status `'fuel'` key (2228), the `/api/fuel` GET routes (2391-2410) and POST routes (2473-2568); `PI_API_CONTRACT = 3` with a comment line naming this change; `PI_CAPABILITIES` without `"fuel_tracker"`.
- Delete: `engine-monitor/test_fuel_tracker.py`.
- Modify: `web/shared/engine-client.js:81` `MIN_PI_CONTRACT = 3`.
- Test: `engine-monitor/test_status_contract.py` (new, plain `python3 -m pytest` or `unittest`, whichever the existing Pi tests use); `tests/shared/engine-client.test.js` (contract).

**Interfaces:** Consumes Tasks 1-5 (nothing on the tablet reads `data.fuel` or `/api/fuel/*` — verified by grep in Step 2). Produces: status JSON has no `fuel` key; `api_contract: 3`; `capabilities` = `["peak_egt", "gps_fix_quality"]`; `data.Fuel_Remaining`, `Fuel_Left`, `Fuel_Right`, `Fuel_Flow` unchanged.

- [ ] **Step 1: Failing tests:** Pi — `test_status_has_no_fuel_block` (`'fuel' not in get_status()`), `test_contract_is_3`, `test_capabilities_drop_fuel_tracker`, `test_dynon_fuel_fields_still_parsed` (a real EMS line from an existing fixture → `Fuel_Remaining`, `Fuel_Left`, `Fuel_Right`, `Fuel_Flow` present), `test_fuel_endpoints_gone` (`/api/fuel`, `/api/fuel/set` → 404). Tablet — `MIN_PI_CONTRACT === 3`, and a contract-2 Pi shows the update badge (`piContractBehind`).
- [ ] **Step 2: Run** them — FAIL. Also `git grep -n "data\.fuel\|/api/fuel\|fuel_tracker" web/ tests/` → only the lines this task deletes.
- [ ] **Step 3: Implement** the deletions and bumps. Do not touch `parse_line`, `Fuel_Flow` handling, `state.sfc`/peak-EGT code, or `FIELD_NAMES`. Leave the Pi's old `fuel_data.json` files in place (unused; no data loss).
- [ ] **Step 4: Run** — Pi tests PASS (`cd engine-monitor && python3 -m pytest -q`), `npm test` PASS.
- [ ] **Step 5: Commit** `feat(pi): remove the Pi fuel tracker (contract 3)`; CLAUDE.md "Pi ↔ FlyTab contract" paragraph updated (currently 3, fuel tracker removed); manual line(s) that mention the Pi's fuel tracker. **Deploy note for Dana:** run `bash deploy-pi.sh` after installing this build — until then the status bar shows the Pi-update badge (contract 2 < 3), and nothing fuel-related depends on the Pi any more. Bump version; `bash build.sh`.

---

## Not in this plan

- Tablet low-fuel alerting (D5), dropped-burn auto-apply (D4), engine-ml `distance_nm` TODO (makes the route-fuel advisory live), deleting the Pi's old `fuel_data.json`.
- Tablet testing: the fuel overlay, ENG page and widget must be checked on the tablet with the Pi on and off before calling it done (no automated UI coverage).
