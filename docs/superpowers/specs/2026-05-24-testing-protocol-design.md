# FlyTab Testing Protocol Design

**Date:** 2026-05-24  
**Status:** Approved

## Overview

A three-tier testing protocol for FlyTab. Tier 1 runs on every save, Tier 2 runs per-domain when relevant files are touched, Tier 3 runs on the tablet before flight.

---

## Architecture & Toolchain

### Three tiers

| Tier | Name | Trigger | Runtime | Target |
|------|------|---------|---------|--------|
| 1 | Unit | `npm test` (on save / pre-commit) | Vitest + jsdom | Planning lib, shared logic |
| 2a | Component | `npm run test:<domain>` | Playwright | Individual cockpit components in harness pages |
| 2b | Smoke | `npm run test:smoke` | Playwright | Full app (`web/index.html`) end-to-end |
| 3 | Tablet | Manual + CDP scripts | Real Android device | Hardware integration, touch, rendering |

### Toolchain

- **Vitest** — Tier 1, already configured in `vitest.config.js`
- **Playwright** — Tier 2a and 2b, already in `devDependencies`
- `playwright.config.js` at repo root drives both component and smoke projects
- No new test runner added

### Directory layout

```
tests/
  planning/            ← existing vitest tests (unchanged)
  cockpit/             ← existing + new vitest tests for pure-logic cockpit modules
  components/          ← Playwright component tests
    harnesses/         ← minimal HTML page per component
    *.spec.js
  smoke/               ← Playwright full-app tests
    *.spec.js
  fixtures/
    mock-adapters.js   ← existing
    mock-home-server.js ← new: lightweight Node HTTP server
    stratux-messages.js ← new: canonical Stratux fixture objects
    engine-messages.js  ← new: canonical engine monitor fixture objects
    tiles/             ← real sample WebP tiles for visual regression (z8–z10, KLKR area)
    plates/            ← one real FAA approach plate PDF (KLKR ILS/LOC)
```

---

## Tier 1: Unit Tests

### What it covers

Pure logic — no DOM, no hardware, no Leaflet. Runs in ~1s.

### Existing coverage (unchanged)

- `tests/planning/` — 104 tests: route math, fuel phases, airway graph, optimizer, parser, winds interpolator
- `tests/cockpit/route-planner-panel.test.js` — route editor panel state machine

### New unit test targets

| Module | What to test |
|--------|-------------|
| `web/shared/altitude-utils.js` | `parseAltFt`, `formatAlt`, `formatAdvisoryAltBand` — AWC altitude conventions (numeric=hundreds of ft, `"FZL"` token, empty string ≠ null) |
| `web/shared/fuel-engine.js`, `fuel-state.js`, `fuel-tank-state.js` | Fuel flow math, tank state transitions |
| `web/shared/wb-calculator.js` | W&B arm/moment calculations |
| `web/shared/gps-source.js` | Source selection logic, priority rules |
| `web/shared/flight-plan-model.js` | Model mutations, serialization |
| `web/shared/stratux-client.js` (parsing only) | `_handleSituation` and `_handleTraffic` field normalization — call with fixture objects, assert output shape |
| `web/shared/engine-client.js` (parsing only) | Nested `data` flatten: `raw.data ? { ...raw, ...raw.data } : raw` |
| NOTAM classifiers in `wx-briefing.js` | `_notamTier`, `_sortedNotams` — pure functions, exercise all type/tier combinations |

### Policy for new code

Any new module added to `web/shared/` or pure-logic function extracted from a cockpit component requires a unit test before the PR merges. Rule: if it has no DOM dependency and no hardware dependency, it belongs in Tier 1.

### Coverage threshold

`vitest --coverage` with warning at 70% on `web/shared/`, build failure below 50%. Grows as backfill proceeds.

---

## Tier 2a: Component Tests

### Pattern

Each cockpit component under test gets a minimal HTML harness at `tests/components/harnesses/<component>.html`. The harness:
- Loads only the dependencies that component needs (following `web/index.html` load order)
- Exposes `window.__testHarness` to inject fixture data
- Does NOT start real network connections — hardware clients replaced with stubs at harness load

`playwright.config.js` `globalSetup` starts all three mock hardware fixtures and tears them down in `globalTeardown`.

### Priority component test targets (first 8)

| Component | Key behaviors |
|-----------|--------------|
| `engine-panel.js` | RPM/EGT/CHT render, DISCONNECTED/STALE banners, fuel endurance calculation |
| `nav-strip.js` | GPS position, ground speed, course display |
| `instrument-strip.js` | Altitude/speed/VSI from GPS situation data |
| `traffic-diag.js` | Target count, 60s age purge |
| `wx-briefing.js` | Tab switching, NOTAM search filter |
| `route-planner-panel.js` | Open/close, plan trigger, waypoint list render |
| `layer-panel.js` | Toggle state persistence across reload |
| `sua-notams.js` | Tier-sorted list, type badges, search |

---

## Tier 2b: Smoke Tests

### Setup

Playwright `smoke` project loads `web/index.html` via a local static file server. A test-injected `cockpit-config.json` points all hardware addresses at the mock fixture servers.

Each suite gets a fresh browser context with IndexedDB cleared via `page.evaluate(() => indexedDB.deleteDatabase('flytab'))` before load.

### Golden-path suites

| Suite | Steps | Asserts |
|-------|-------|---------|
| **Startup** | App loads, all mocks connected | GPS marker on map, engine CONNECTED, no console errors |
| **NASR import** | Empty IDB, home server returns new `sua_count` | Import triggered, KLKR lookup returns airport record |
| **NASR skip** | IDB already current, `sua_count` matches | No import, IDB write count = 0 |
| **Route planning** | Open planner, KLKR→KCLT, tap Plan | ≥2 legs rendered, estimated time shown |
| **Weather briefing** | Open WX tab, switch NOTAM tab, enter search | List renders, search filters correctly |
| **Engine panel** | Engine data flowing | RPM/EGT/CHT bars rendered, fuel endurance shown |
| **Traffic** | Mock Stratux sends 3 targets | 3 traffic markers on map |
| **Offline resilience** | Home server stopped, app reloaded | Starts without crash, uses cached IDB |

### Map and chart rendering tests (visual regression)

Run via `npm run test:visual`. Require real fixture data (see fixtures below).

| Test | Fixture | Assert |
|------|---------|--------|
| VFR sectional tiles render | 3–5 real sectional WebP tiles at z8–z10 around KLKR | `toHaveScreenshot()` vs baseline |
| IFR low enroute tiles render | 3–5 real IFR WebP tiles | `toHaveScreenshot()` vs baseline |
| TAC tiles render | 3–5 real TAC WebP tiles | `toHaveScreenshot()` vs baseline |
| Vector airspace layer renders | NASR bundle with ≥1 airspace polygon | SVG `<path>` elements non-empty |
| Vector airport/navaid markers | NASR bundle with KLKR + MRB | Marker elements at correct map position |
| Approach chart PDF renders | 1 real FAA approach plate (KLKR ILS/LOC) | `toHaveScreenshot()` vs baseline; no PDF.js error |

**Trigger condition:** Visual regression tests run when `git diff --name-only` includes any of: `map.js`, `vector-map-layers.js`, `approach-charts.js`, `layer-panel.js`, `fisb-nexrad.js`, or any file under `web/lib/`.

**Baseline management:** Snapshots committed to `tests/components/snapshots/`. When rendering intentionally changes, run `playwright test --update-snapshots` and commit new baselines alongside the code change.

### What smoke tests explicitly skip

- Approach plate PDF rendering (needs real PDFs in fixtures, tested via visual regression only)
- Touch gesture accuracy (Playwright mouse ≠ tablet touch — covered by Tier 3)
- Engine ML anomaly scoring (requires Android Capacitor plugin)

---

## Fixture Servers

Three mock hardware servers started by Playwright `globalSetup`:

### 1. `mock-stratux.py` (port 5678)

Already exists at `tools/mock-stratux.py`. Minor update needed: `_traffic_msgs()` already uses the canonical field names. No changes required for situation messages.

Unit tests use `tests/fixtures/stratux-messages.js` with exact fixture objects — no running server needed at Tier 1.

### 2. `fake-engine.js` (ports 8080/8082)

**Requires update.** Current format (`egt: [...]` arrays, lowercase `rpm`) does NOT match the real Pi. The engine panel handles both via `??` fallback chains, but tests must exercise the real path.

Updated format must match `get_status()` output with nested `data` sub-object (see Canonical Formats below).

### 3. `mock-home-server.js` (port 8090) — new

Lightweight Node `http.createServer`. Does NOT require `~/fly-pipeline/data/` to exist. Serves:
- `GET /manifest.json` — minimal manifest with `sua_count`
- `GET /nasr/cycle_info.json` — cycle metadata
- `GET /nasr/bundle.json` — minimal NASR fixture (3 airports, 2 navaids, 2 airways)
- `GET /cifp/cifp_bundle.json` — empty procedures bundle
- `GET /cifp/cifp_cycle_info.json` — cycle metadata
- `GET /plates/plate_index.json` — minimal plate index
- `GET /terrain/grid/status` — `{ exists: false }`
- `GET /tiles/<type>/<z>/<x>/<y>.webp` — serves real sample tiles from `tests/fixtures/tiles/` when present, 404 otherwise
- `GET /plates/<icao>/<chart>.pdf` — serves real sample plate from `tests/fixtures/plates/` when present, 404 otherwise

---

## Canonical Data Formats

These are the exact field names from the live hardware. Tests must use these. Deviations are what cause tests to pass while the real app fails.

### Stratux `/situation` WebSocket message

```json
{
  "GPSLatitude": 35.0,
  "GPSLongitude": -80.0,
  "GPSAltitudeMSL": 5000.0,
  "BaroPressureAltitude": 4950.0,
  "GPSGroundSpeed": 150.0,
  "GPSTrueCourse": 90.0,
  "GPSVerticalSpeed": 0.0,
  "GPSFixQuality": 2,
  "GPSSatellites": 9,
  "GPSSatellitesSeen": 11,
  "AHRSPitch": 1.5,
  "AHRSRoll": 0.5,
  "AHRSGLoad": 1.0,
  "AHRSGLoadMin": 0.98,
  "AHRSGLoadMax": 1.02
}
```

`stratux-client.js` normalizes to: `lat`, `lon`, `alt_msl`, `alt_baro`, `ground_speed`, `true_course`, `vertical_speed`, `gps_fix_quality`, `gps_sats`, `gps_sats_seen`, `pitch`, `roll`, `g_load`, `g_load_min`, `g_load_max`, `timestamp`.

### Stratux `/traffic` WebSocket message

```json
{
  "Icao_addr": 11256833,
  "Tail": "N123AB",
  "Lat": 35.25,
  "Lng": -80.0,
  "Alt": 3500,
  "Track": 270,
  "Speed": 120,
  "Vvel": 0,
  "Squawk": "1200",
  "OnGround": false,
  "Age": 0.0,
  "ExtrapolatedPosition": false,
  "SignalLevel": -45.0,
  "TargetType": 1
}
```

Note: longitude field is `Lng`, not `Lon`. Client normalizes to `lon`.

### Stratux `/jsonio` — NEXRAD frame

```json
{ "Product_id": 63, "NEXRAD": [ /* array of NEXRADBlock objects */ ] }
```

Discriminated by `msg.NEXRAD && msg.NEXRAD.length > 0`. All other `/jsonio` frames → `stratux:fisb-frame`.

### Engine monitor WebSocket (port 8082) — `get_status()` at 1Hz

The engine panel flattens via `raw.data ? { ...raw, ...raw.data } : raw`. Tests must send the nested shape:

```json
{
  "version": "3.3.0",
  "capturing": true,
  "serial_connected": true,
  "stratux_connected": false,
  "percent_power": 65.0,
  "rop_lop_percent": 2.5,
  "rop_lop_mode": "RICH",
  "sfc": 0.42,
  "gps_altitude": 5000,
  "pressure_altitude": 4950,
  "ground_speed": 150,
  "tas": 155,
  "oat": 12.0,
  "density_altitude": 6200,
  "sticky_valve_alert": null,
  "sticky_valve_dismissed": false,
  "serial_warning": null,
  "degrees_from_peak": {},
  "peaks_valid": false,
  "manual_altimeter": null,
  "manual_oat": null,
  "fuel": null,
  "data": {
    "RPM": 2200,
    "MP": 24.5,
    "Oil_Temp": 180.0,
    "Oil_Press": 76.0,
    "Fuel_Press": 4.7,
    "Volts": 13.7,
    "Amps": 34.0,
    "Fuel_Flow": 8.5,
    "Gallons_Rem": 24.9,
    "Fuel_L1": 11.8,
    "Fuel_L2": 8.6,
    "EGT1": 1350,
    "EGT2": 1320,
    "EGT3": 1360,
    "EGT4": 1340,
    "CHT1": 380,
    "CHT2": 365,
    "CHT3": 370,
    "CHT4": 355
  }
}
```

**`fake-engine.js` must be updated** to match this format. Current format (`egt: [...]` arrays, lowercase field names) is not canonical.

### Home server `/nasr/bundle.json` minimal fixture

```json
{
  "cycle_info": { "cycle": "20260424", "sua_count": 3 },
  "airports": {
    "KLKR": { "icao": "KLKR", "lat": 34.9, "lon": -81.1, "name": "Lancaster" }
  },
  "navaids": {
    "MRB": { "id": "MRB", "lat": 39.4, "lon": -77.9, "type": "VOR" }
  },
  "airways": {
    "V143": { "waypoints": ["MRB", "ETX"] }
  },
  "airspace": [],
  "sua": [],
  "fixes": {}
}
```

### Home server `/nasr/cycle_info.json`

```json
{ "cycle": "20260424", "sua_count": 1234, "airports": 19823, "navaids": 4521 }
```

---

## Domain-Based Test Execution

Tests are tagged by domain. Run only the domains matching what you changed.

| Domain | Run when touching… | Command |
|--------|-------------------|---------|
| `planning` | `web/shared/planning/`, `fuel-*.js`, `wb-calculator.js`, `gps-source.js` | `npm test` |
| `engine` | `engine-panel.js`, `engine-client.js`, `fake-engine.js`, `engine-monitor/` | `npm run test:engine` |
| `stratux` | `stratux-client.js`, `nav-strip.js`, `instrument-strip.js`, `traffic-diag.js` | `npm run test:stratux` |
| `map` | `map.js`, `vector-map-layers.js`, `layer-panel.js`, `fisb-nexrad.js`, `web/lib/` | `npm run test:map` (includes visual regression) |
| `charts` | `approach-charts.js`, `radar-loop.js` | `npm run test:charts` (includes visual regression) |
| `nasr` | `nasr-db.js`, `sync-shim.js`, `network-mode.js`, `planning-adapters/` | `npm run test:nasr` |
| `weather` | `wx-briefing.js`, `weather-client.js`, `fisb-client.js`, `altitude-utils.js` | `npm run test:weather` |
| `notam` | `sua-notams.js`, `wx-briefing.js` (NOTAM tab) | `npm run test:notam` |
| `planner-ui` | `route-planner-panel.js`, `route-table.js`, `route-nav-strip.js` | `npm run test:planner-ui` |
| `visual` | `map.js`, `vector-map-layers.js`, `approach-charts.js`, `layer-panel.js`, `fisb-nexrad.js`, `web/lib/` | `npm run test:visual` |

**Full suite commands:**

```bash
npm run test:all       # tiers 1 + 2, ~3 min — run before a release build
npm run test:smoke     # full-app golden paths only, ~90s — run after a big refactor
npm run test:visual    # all visual regression across all domains — convenience alias
```

Note: `npm run test:map` and `npm run test:charts` each include their own visual regression subset. `npm run test:visual` is a convenience command that runs all visual regression tests without the non-visual component tests.

**Practical examples:**
- Fix NOTAM classifier bug → `npm run test:notam`
- Change EGT bar rendering → `npm run test:engine`
- Update route planner optimizer → `npm test`
- Touch `vector-map-layers.js` → `npm run test:map` (includes visual regression)
- Update `fake-engine.js` → `npm run test:engine` + verify format matches canonical spec above
- Cut a release build → `npm run test:all` first

---

## Tier 3: Tablet Checklist

Run before any release install on N194JT.

### Track A — Automated via CDP

Script: `tools/tablet-check.sh`. Run after ADB forward:

```bash
adb forward tcp:9223 localabstract:webview_devtools_remote_$(adb shell pidof app.flywhere.flytab)
bash tools/tablet-check.sh
```

| Check | CDP assertion |
|-------|--------------|
| Stratux connected | `window.stratuxClient.connected === true` |
| GPS fix acquired | `window.stratuxClient.situation?.gps_fix_quality >= 2` |
| Engine client connected | `window.engineClient.connected === true` |
| NASR loaded | `(await NasrDb.getAirport('KLKR')) !== null` |
| CIFP loaded | IDB `cifp` store has records |
| Tile server reachable | HTTP 200 on a known tile URL |
| No JS console errors | `window.__consoleErrors?.length === 0` |
| EngineML plugin live | `window.engineML?.lastResult?.score !== undefined` |

### Track B — Manual visual checklist

```
[ ] Map pans and zooms smoothly — no tile gaps at current zoom
[ ] Ownship marker moves with GPS position
[ ] Traffic targets visible (if other aircraft on Stratux network)
[ ] Engine panel: RPM, EGT, CHT bars live and non-zero
[ ] Fuel endurance displayed (not "--")
[ ] WX briefing opens and loads METARs for KLKR
[ ] NOTAMs load for KLKR area
[ ] Route planner: KLKR→KCLT, plan succeeds, profile renders
[ ] Approach chart: KLKR ILS/LOC opens and renders
[ ] VFR sectional visible at zoom 10
[ ] IFR low chart visible at zoom 8 (if IFR layer enabled)
[ ] Layer panel toggles persist after app restart
[ ] Portrait orientation: all panels reachable, no clipped text
```

Both tracks must pass before N194JT installation.

---

## New Code Policy

| What you're adding | Requirement |
|-------------------|-------------|
| New `web/shared/` module | Unit test (Tier 1) before PR |
| New cockpit component | Component harness + ≥3 Playwright tests (Tier 2a) before PR |
| New map layer or rendering path | Visual regression baseline committed with the code |
| Any change to `fake-engine.js` or `mock-stratux.py` | Verify format still matches canonical spec in this document |
| Any change that touches `web/shared/planning/` | `npm test` must pass before `build.sh` |
