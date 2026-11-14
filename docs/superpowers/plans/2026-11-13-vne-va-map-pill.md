# Vne / Va Map Pill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A map pill under the engine box showing Vne-at-altitude and weight-adjusted Va; tapping it opens a floating card for altimeter, altitude, OAT °F and KIAS.

**Architecture:** Pure math in `AirspeedLimits` (pressure altitude from altimeter, Va for weight). `VnePanel` becomes the floating card and an `EventTarget` that fires `change`; `VnePill` renders its summary. W&B station weights are saved in Settings and read by the card.

**Tech Stack:** Vanilla JS classic scripts, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-11-13-vne-va-map-pill-design.md`

## Global Constraints

- Conservative rounding: Vne and Va DOWN, TAS UP, pressure/density altitude UP to 10 ft.
- Typed out-of-range values are rejected, never clamped; step buttons clamp.
- Design tokens only; touch targets ≥ `--touch-min`; no colour-only signal.
- Do not rename any `flypi_` key. New keys via `Settings._key()`: `wb_station_weights`.
- Never feed the card the Pi engine_monitor `oat`.

## Review Focus

- W&B weights saved from a previous flight (passenger) — card must list the weights used.
- Fuel stale / untracked — fuel left out, card says "fuel not counted".
- Engine box disabled or field count changed — pill must still sit under it (or at 156 px).
- Altimeter typed as "3012" (no decimal) — rejected as out of range, not read as 30.12.
- Pressure altitude pushed out of range by the altimeter (18,000 ft at 28.50) — rejected with a message on the altitude field.

---

### Task 1: Math — pressure altitude, °F input, Va for weight

**Files:** Modify `web/shared/airspeed-limits.js`; Test `tests/shared/airspeed-limits.test.js`

**Produces:**
- `ALTIMETER_MIN_INHG = 27.5`, `ALTIMETER_MAX_INHG = 31.5`, `STD_ALTIMETER_INHG = 29.92`, `VA_GROSS_LB = 1800`
- `pressureAltitudeFt(indicatedFt, altimeterInHg) -> number` = ind + 145366.45 × (1 − (alt/29.9213)^0.190263)
- `checkAltimeter(inHg) -> 'missing'|'range'|null`
- `vaForWeight(weightLb, {grossLb, pecKt}) -> {kias, overGross} | null`
- `evaluate()` also accepts `{indicatedAltFt, altimeterInHg}` instead of `pressureAltFt`, `oatF` instead of `oatC`, and `weightLb`; adds `pressureAltFt` (ceil 10), `vaKias`, `overGross`, `errors.altimeter`. Va is computed even when altitude/OAT are missing.

Tests: 29.92 → +1.2 ft; 30.92 → −911 ± 1; 28.92 → +937 ± 1; 8000 ft @ 29.92 / 32 °F → Vne 161; altimeter 3012 → errors.altimeter 'range'; 18,000 @ 28.50 → errors.alt 'range'; Va 1800 → 102, 1450 → 91, 1900 → 102 overGross, 0/NaN → null, pec 2 at 1450 → 91.

### Task 2: Save W&B station weights

**Files:** Modify `web/shared/settings.js`, `web/cockpit/wb-overlay.js`; Test `tests/cockpit/wb-overlay-weights.test.js`

**Produces:** `Settings.wbStationWeights` (`{ [stationName]: string }`), window event `wb:weightschanged`. Non-fuel inputs pre-fill from it and save on every input. Fuel never saved. Tests: reopen keeps Pilot/Passenger/Baggage; corrupt storage opens empty; event fires; fuel field not saved; existing `wb-overlay-fuel.test.js` still passes.

### Task 3: Floating card

**Files:** Modify `web/cockpit/vne-panel.js`, `web/style.css`; Test `tests/cockpit/vne-panel.test.js` (rewritten)

**Produces:** `class VnePanel extends EventTarget` — `constructor(container)`, `show() / hide() / toggle()`, `visible`, `summary() -> {vneKias, vaKias, altFt, ok}`, `setInputs({pressureAltFt | altimeterInHg + indicatedAltFt, oatC | oatF, kias}, source)`, `destroy()`, fires `change`. Fields `altimeter` (±0.01, start 29.92), `alt` (±500), `oat` °F (±1, start ISA), `kias` (±1, clear). State `{altimeter, alt, oatF, kias}` in `Settings.vneInputs`. Weight via `VnePanel.weightNow()` -> `{weightLb|null, stations:[{name,lb}], fuelGal|null, fuelCounted, reason}`. Refreshes on `wb:weightschanged`, `fuelstate:changed`, `fueltankstate:changed`, every 15 s.

### Task 4: Map pill + wiring

**Files:** Create `web/cockpit/vne-pill.js`, Test `tests/cockpit/vne-pill.test.js`; Modify `web/app.js`, `web/index.html`, `web/cockpit/tab-bar.js` (remove MORE row), `web/style.css`

**Produces:** `class VnePill` — `constructor(container, panel)`, `place()`, `destroy()`. Text `Vne 161 · Va 96` + `@ 8,000`. Tap toggles the card. Top = engine box bottom + 6 px, else 156 px; card top = pill bottom + 6 px.

### Task 5: Manual, version, build, verify

Manual section rewritten, MORE row removed; `FLYTAB_VERSION` v13.13; `npm test`; `bash build.sh`; revert `android/capacitor.settings.gradle`; headless render at 800×1280.
