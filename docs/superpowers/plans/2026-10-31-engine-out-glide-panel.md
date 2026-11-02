# Engine-Out Glide Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live engine-out glide check in the airport panel whenever an airport is tapped in flight, built on one configurable glide model that the anomaly-triggered EmergencyGlide also uses.

**Architecture:** A pure model (`web/shared/glide-model.js`, no DOM, no globals except `GlideModel`) ports the agreed reference (`plan`, `initialTurn`, `triangle`) with every number from a settings object and real runway geometry. An adapter (`web/cockpit/glide-inputs.js`) turns app state (Stratux situation, NASR airport record, FIS-B winds and METARs, pre-flight winds, Configuration) into model inputs. The airport panel renders the model's output once a second and draws the line to the final point on the map; EmergencyGlide swaps its range estimate for the model.

**Tech Stack:** vanilla JS classic scripts loaded from `web/index.html`, vitest (`npm test`), Leaflet, Capacitor Android (`bash build.sh`).

**Spec:** `docs/superpowers/specs/2026-10-31-engine-out-glide-panel-design.md` (approved 2026-10-31) and its reference model `docs/superpowers/specs/2026-10-31-engine-out-glide-reference.js`. Executors read both.

## Global Constraints

- No hardcoded model values: every number in the spec's settings table comes from settings; the agreed RV-9A values are only defaults (Dana: "Don't hardcode values. Assume that this app could be used by other pilots with other aircraft"). Physical constants (6076.12 ft/nm, 101.269 fpm per kt, standard-rate formula 1091·tan(bank)/TAS) are not settings.
- Settings and defaults (spec table): aircraft `glide_ias_kt` 65, `glide_sink_fpm` 700, `glide_density_pct_per_kft` 2, existing `min_runway_ft`; pilot section `engineOutGlide`: `turnBankDeg` 30, `marginFt` 200, `lineUpFtPerDeg` 1.5, `finalPointFraction` 0.25, `finalPointMinFt` 500, `finalPointMaxFt` 1000, `noWindHeadwindKt` 10, `planBHysteresisFt` 100, `onCourseDeg` 5, `windMaxStationNm` 100, `metarMaxAgeMin` 75, `metarMaxStationNm` 10. Added by this plan: `windMaxAgeMin` 360 — the spec says "forecast period still valid", but FIS-B winds carry only `received_at` and the planner's winds no fetch time, so validity is judged by age; `showAboveGsKt` 40 — the airborne signal (spec: builder's call); `flightRecorder.recording` was rejected because it is true during taxi, and the spec says no block on the ground.
- Turn sink factor is derived: `1 / cos(bank)^1.5` (1.24 at 30°), not a setting.
- Altitude: Stratux GPS `alt_msl` only, never `alt_baro`; no 3D fix (`GpsFix.has3DFix(sit)` false) → no glide block.
- Err high: a missing or untrusted input always takes the more conservative path (no-wind headwind; plan B to the airport reference point; no block).
- Never rename `flypi_*` keys; aircraft settings persist through the existing `flypi_user_aircraft` override (config-editor saves the whole performance block, so every new key must be an editable field).
- Light theme, design tokens only (`--font-instrument` weight 900 for numbers, `--touch-min`), panel text 17–30 px; no "terrain not checked" text; the airport text is not enlarged.
- Tap Handler Regression Rule: `onAirportClick`, `onNavaidClick`, `onFixClick` in `app.js` unchanged; the airport popup must still open on a tap.
- Each task that changes app JS: run `npm test` (all) before committing. The last task bumps `FLYTAB_VERSION` and runs `bash build.sh`. User manual updated in the same commit as the user-visible change.

## Review Focus

1. **Aircraft over or inside the airport** (distance to the reference point < the final-point offset, or directly over a runway) → a valid plan with finite numbers and a sensible turn cue, never NaN / Infinity in the panel. *(Task 1 test `aircraft over the field`.)*
2. **Runways with one known end, or none** → final points only from ends with coordinates; no runway with coordinates → the "RUNWAY POSITION NOT KNOWN" plan-B check to the reference point. *(Task 2 test `partial and missing runway coordinates`.)*
3. **GPS lost or stale while the panel is open** (situation older than 5 s, or no 3D fix) → the block disappears, not frozen numbers. *(Task 4 test `GPS lost hides the block`.)*
4. **Settings out of range** (0 or negative sink, margin, bank ≥ 90°, min > max final point) → invalid values fall back to the defaults, never NaN. *(Task 3 test `invalid settings fall back`.)*
5. **Other pilots, other places:** an airport in the southern / eastern hemisphere and a far airport at high altitude (80 nm, FL180) → correct bearings and a finite "CANNOT REACH · N ft short". *(Task 1 test `southern-eastern hemisphere and far airport`.)*

---

### Task 1: The glide model

**Files:**
- Create: `web/shared/glide-model.js`
- Test: `tests/shared/glide-model.test.js`

**Interfaces:**
- Produces (global `GlideModel`, classic script):
  - `GlideModel.DEFAULTS` — the settings object with every default from Global Constraints (aircraft keys under `aircraft`, pilot keys under `pilot`, as `{ aircraft: { glide_ias_kt, glide_sink_fpm, glide_density_pct_per_kft, min_runway_ft }, pilot: { turnBankDeg, marginFt, … } }`).
  - `GlideModel.triangle(courseTrue, tasKt, wind|null, settings) -> { hdg, gs, wca }` (wind = `{ from, kt }`).
  - `GlideModel.initialTurn(pos, trkTrue, target, altFt, glideWind, settings) -> { pos, trk, lost, deg }`.
  - `GlideModel.plan(input, settings) -> Plan` where `input = { airport: { elevFt, ref: {x,y}, ends: [{ id, thr: {x,y}, hdgTrue, rwyLenFt, mid: {x,y}, rwy: {a:{x,y}, b:{x,y}} }] }, ac: { pos: {x,y}, altMsl, gs, trkTrue, vs }, glideWind: {from,kt}|null, runwayWind: RunwayWind, preferDirect: bool }` (positions in nm, local plane, x east, y north, airport reference at 0,0), and `Plan = { kind: 'final'|'direct'|'ref', endId, pt, needMsl, spare, hdgTrue, legNm, tMin, target, projected, measured, targetNow, turnNow, headRwy, tailwindKt }`.
  - `GlideModel.toLocal(refLat, refLon, lat, lon) -> {x,y}` and `GlideModel.fromLocal(refLat, refLon, {x,y}) -> {lat, lon}` (equirectangular, cos(refLat)).
- Port rule: the reference file's `plan()` is the algorithm, with these generalisations only: settings instead of its constants; per-end `rwyLenFt` / `thr` / `mid` / `hdgTrue` instead of one centred runway; plan B to the nearest point of the nearest candidate runway segment `rwy.a–rwy.b`; `kind: 'ref'` (plan B to `ref`) when `ends` is empty; `RunwayWind` is one of `{ kind: 'metar', from, kt, gustKt|null }` (end choice and `headRwy` from it, gust rule: a headwind component uses `gustKt` when present, a tailwind component uses `kt`), `{ kind: 'calm' }` (end by least turn, `headRwy = 0`), `{ kind: 'vrb' }` (end by least turn, `headRwy = noWindHeadwindKt`), or `{ kind: 'none' }` (no usable METAR: end choice and `headRwy` from `glideWind` exactly as the reference does, and with `glideWind` null `headRwy = noWindHeadwindKt`); ties keep the first end.

- [ ] **Step 1: Write the failing tests** in `tests/shared/glide-model.test.js`:
  - `golden cases match the reference` — build the KLKR input exactly as the reference does (elev 486, one runway 6,004 ft centred on 0,0, end A true 233°, end B 053°, `glideWind = runwayWind` = the case wind) for the 12 rows of the spec's "Golden cases" table and assert kind, end, spare (±1 ft), needMsl (±1 ft), hdgTrue (±1°), legNm (±0.01), target (±1 fpm), projected (±1 fpm), turnNow (±1°).
  - `every number comes from settings` — doubling `glide_sink_fpm` doubles `projected` and changes `spare`; `marginFt: 0` lowers `needMsl` by exactly 200 vs default; `noWindHeadwindKt: 0` with no winds gives `gs = tas`.
  - `METAR runway wind with gusts` — runway wind 240/12G18 on end A (landing 233°): `headRwy` uses 18·cos(7°); a tailwind case uses the steady speed.
  - `tailwind end choice` — glide wind 250/14, METAR 060/15 at the airport, aircraft placed so only end A (233°) is reachable: `endId` A and `tailwindKt` ≈ 15·cos(7°) (±0.5).
  - `calm and VRB pick the least turn` — aircraft south of the field tracking 360: `{kind:'calm'}` and `{kind:'vrb'}` both pick the end needing the least turn from the current track; VRB `needMsl` > calm `needMsl` (a 10 kt headwind on final needs more height than calm).
  - `missing-threshold fallback` — `ends: []` → `kind: 'ref'`, `pt` = `ref`, `needMsl = elevFt + marginFt`, finite `spare`.
  - `aircraft over the field` — `ac.pos = {x:0,y:0}`: all output numbers finite.
  - `southern-eastern hemisphere and far airport` — `toLocal`/`fromLocal` round-trip within 1e-6 at lat −33.9, lon 151.2; an airport 80 nm away at 18,000 ft → `kind: 'direct'`, finite negative `spare`.
- [ ] **Step 2: Run** `npx vitest run tests/shared/glide-model.test.js` → FAIL (`GlideModel` not defined).
- [ ] **Step 3: Implement** `web/shared/glide-model.js` per the Interfaces and port rule.
- [ ] **Step 4: Run** the test file → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat(glide): configurable engine-out glide model ported from the agreed simulator`.

### Task 2: Inputs from the app

**Files:**
- Create: `web/cockpit/glide-inputs.js`
- Modify: `web/cockpit/route-planner-panel.js:2677` and `web/cockpit/route-planner-v2.js:949` (set `this._lastWindsAt = Date.now()` beside each `_lastWinds` assignment; `null` when the winds are `null`)
- Modify: `web/index.html` (script tags: `shared/glide-model.js` before cockpit components; `cockpit/glide-inputs.js` before `cockpit/airport-popup.js`)
- Test: `tests/cockpit/glide-inputs.test.js`

**Interfaces:**
- Consumes: Task 1 `GlideModel.toLocal`, `GlideModel.DEFAULTS`; Task 3 `GlideInputs.settings()` source keys (this task reads them through `CockpitConfig.aircraft('performance.<key>')` and `CockpitConfig.get('engineOutGlide')`, falling back to `GlideModel.DEFAULTS`).
- Produces (global `GlideInputs`):
  - `GlideInputs.settings() -> settings` (resolved, validated — see Task 3 for validation rules; this task calls `GlideInputs.validate(raw)`).
  - `GlideInputs.aircraft(sit, settings) -> { pos:{x,y}, altMsl, gs, trkTrue, vs } | null` relative to an airport ref (pass `ref`), null when `!GpsFix.has3DFix(sit)`, situation older than 5000 ms (`sit.timestamp`), or `ground_speed < showAboveGsKt`.
  - `GlideInputs.airport(rec, settings) -> { elevFt, ref, ends, refLatLon, excluded: 'heliport'|'seaplane'|null, noSuitable: bool }`: candidate runways = length ≥ `min_runway_ft` (unset → no filter), paved first (surface contains ASPH or CONC; turf/gravel only when no paved runway qualifies); an end is included only when its `*_thr_lat/lon` (else `*_lat/lon`) are finite; `rwy.a/b` from the physical ends; `fac_type` HELIPORT / SEAPLANE BASE → `excluded`.
  - `GlideInputs.glideWind(lat, lon, altMsl, settings, now) -> { wind:{from,kt}|null, label }`: FIS-B `fisbClient.getNearestWind` when its station is ≤ `windMaxStationNm` and `received_at` ≤ `windMaxAgeMin` old; else the route planner's `_lastWinds` (via `window.FlyTabPlanning.findNearestFdStation` + `getWindAtAlt`) when `_lastWindsAt` ≤ `windMaxAgeMin` old and the station ≤ `windMaxStationNm`; else `null` with label "NO CURRENT WINDS ALOFT · {noWindHeadwindKt} kt headwind assumed". A level below the lowest reported is labelled with the level used.
  - `async GlideInputs.runwayWind(icao, refLatLon, settings, now) -> { wind: RunwayWind, label }` (Task 1 type): the airport's METAR (FIS-B `getMetar(icao)` first, else the airport panel's cached wx) when `decoded.observed_at` ≤ `metarMaxAgeMin` old; else the nearest FIS-B METAR station within `metarMaxStationNm` (coordinates via `nasrDb.getAirport`); speed 0 → `{kind:'calm'}`; `wind_dir` null with speed > 0 → `{kind:'vrb'}`; else `{kind:'metar', from, kt, gustKt}`; no usable METAR → `{kind:'none'}`. Label e.g. "METAR KLKR 240/12G18 (18 min)".
- [ ] **Step 1: Failing tests:** `paved preferred, min length, heliport excluded`; `partial and missing runway coordinates` (one-ended runway → one end; none → `ends: []`); `METAR too old falls to nearest station, then to none`; `calm, VRB and gusts map to their RunwayWind kinds`; `FIS-B wind too far or too old → null with the NO CURRENT WINDS label`; `aircraft null without 3D fix, stale, or below showAboveGsKt`; `alt_msl used, alt_baro ignored`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test`.
- [ ] **Step 5: Commit** `feat(glide): model inputs from GPS, NASR runways, FIS-B winds and METARs`.

### Task 3: Settings in Configuration

**Files:**
- Modify: `web/aircraft-config.json` (performance: `glide_ias_kt`, `glide_sink_fpm`, `glide_density_pct_per_kft`; remove `glide_ratio`)
- Modify: `web/shared/cockpit-config.js` (aircraft defaults ~l.171; new `engineOutGlide` defaults)
- Modify: `web/cockpit-config.json` (new `engineOutGlide` section with the defaults)
- Modify: `web/cockpit/config-editor.js` (aircraft fields: replace the `glide_ratio` field at l.350 with the three glide fields; new `_renderSection('engineOutGlide', 'Engine-Out Glide', …)` card; add `'engineOutGlide'` to the sections list at ~l.631)
- Modify: `web/cockpit/glide-inputs.js` (`GlideInputs.validate`)
- Test: `tests/cockpit/glide-settings.test.js`

**Interfaces:**
- Produces: `GlideInputs.validate(raw) -> settings` — each key: finite and within its range else the default. Ranges: `glide_ias_kt` 30–200, `glide_sink_fpm` 100–3000, `glide_density_pct_per_kft` 0–5, `turnBankDeg` 10–60, `marginFt` 0–2000, `lineUpFtPerDeg` 0–10, `finalPointFraction` 0–1, `finalPointMinFt` 0–5000, `finalPointMaxFt` ≥ min (else both defaults), `noWindHeadwindKt` 0–50, `planBHysteresisFt` 0–1000, `onCourseDeg` 1–30, `windMaxStationNm` 1–500, `windMaxAgeMin` 10–1440, `metarMaxAgeMin` 10–240, `metarMaxStationNm` 0–100, `showAboveGsKt` 0–200.
- Field labels: "Best-Glide Speed (KIAS)", "Glide Sink Rate (fpm, sea level, windmilling, gross)", "Glide TAS/Sink Increase (% per 1,000 ft)"; the Engine-Out Glide card lists the pilot keys with plain labels and units.
- [ ] **Step 1: Failing tests:** `defaults come from config files` (65/700/2 and the pilot defaults); `invalid settings fall back` (0 sink, −50 margin, bank 90, min 1200 > max 1000 → defaults); `Configuration shows every glide field and saves it` (render, change bank to 25, save → `CockpitConfig.get('engineOutGlide').turnBankDeg === 25`; aircraft sink 650 persists in `flypi_user_aircraft`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test`.
- [ ] **Step 5: Commit** `feat(glide): engine-out glide settings in Configuration (aircraft + pilot)`.

### Task 4: The panel and the map line

**Files:**
- Create: `web/cockpit/glide-panel.js` (render + update loop; keeps `airport-popup.js` from growing)
- Modify: `web/cockpit/airport-popup.js` (in `_showPanel`: mount `GlidePanel` near the top of the panel; stop it in `close()`)
- Modify: `web/style.css` (glide block, tokens only)
- Modify: `docs/user-manual.md` (airport panel section: the glide block, its four verdicts, the wind line, where the settings are)
- Test: `tests/cockpit/glide-panel.test.js`

**Interfaces:**
- Consumes: Tasks 1–3 (`GlideModel.plan`, `GlideInputs.*`), `window.app.stratuxClient.situation`, `window.app.cockpitMap.map`, `MagVar.declination(lat, lon)` (magnetic = true − declination).
- Produces: `class GlidePanel { constructor(containerEl, airportRec); start(); stop(); render(now) }` — `start()` renders once and every `GlidePanel.UPDATE_MS = 1000`; keeps `preferDirect` between updates (hysteresis); `stop()` clears the timer and removes the map layers.
- Copy (exact, from the spec): "✓ GLIDE OK · N ft to spare"; "⚠ FINAL POINT OUT OF REACH · TURN TO THE AIRPORT" + "N ft to spare over the runway"; "✗ CANNOT REACH {ICAO} · N ft short"; "RUNWAY POSITION NOT KNOWN · steer to the airport"; "NO SUITABLE RUNWAY · steer to the airport"; heading "HHH°" with "↱ right N°" / "↰ left N°" / "↑ on course" (within `onCourseDeg`); "Fly HHH° · D.D nm to RWY nn final point" / "… to RWY nn/mm (nearest part)" / "… to {ICAO}"; "Be at H ft or higher there"; cells TARGET / PROJECTED / MEASURED with "+N too steep" in red when above target; wind line "Runway: METAR {ICAO} DDD/SS[GGG] (N min) · Glide: DDD/SS at AAAA ft · {source}" or the no-wind / tailwind amber text. Numbers formatted with thousands separators; headings 3 digits.
- Map: while started, a polyline aircraft → final point, a ring at the point, a dashed line point → threshold, colour by verdict (green / amber / red), on its own Leaflet layer group, removed on `stop()`.
- [ ] **Step 1: Failing tests (jsdom, stubbed situation/NASR/winds):** one test per verdict state with its exact copy; `GPS lost hides the block`; `hysteresis keeps plan B until a final point has 100 ft to spare`; `magnetic heading uses MagVar`; `stop() clears the timer and the map layers`; `excluded heliport shows no block`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test`.
- [ ] **Step 5: Commit** `feat(glide): live engine-out glide block in the airport panel with the line to the final point`.

### Task 5: EmergencyGlide on the shared model

**Files:**
- Modify: `web/cockpit/emergency-glide.js` (remove `_windAdjustRange` and `GLIDE_RATIO`/`glide_ratio`; reachability and range from `GlideModel.plan` via `GlideInputs`)
- Test: `tests/cockpit/emergency-glide-model.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Behaviour: an airport counts as reachable when its `GlideModel.plan(...).spare ≥ 0` (any kind); ranking otherwise unchanged; no new UI.
- [ ] **Step 1: Failing tests:** `cruise ground speed no longer inflates range` (150 kt GS, no wind: an airport that the old GS÷80 factor called reachable but the model says `spare < 0` is not reachable); `headwind shrinks the reachable set`; `no glide_ratio read`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test`.
- [ ] **Step 5:** Bump `FLYTAB_VERSION` (minor +1), `bash build.sh` (exit 0), manual line on the emergency glide using the same model, commit `fix(emergency-glide): range from the shared glide model, not GS/80 (vX.Y)`.

---

**Not in this plan (controller, after merge):** tablet check — tap an airport in flight (or with mock Stratux): block shows, airport popup still opens on tap, map line drawn, Configuration fields save.
