# Engine-Out Glide Panel — Design

Status: agreed with Dana (pilot, RV-9A N194JT) on 2026-10-28 in an interactive simulator; runway-threshold data shipped 2026-10-30 (bundle v11); this document approved before planning.

Simulator: https://claude.ai/artifact/G632nTeyWPH8uW2G2PiisX. Its `plan()`, `initialTurn()`, `triangle()` are copied verbatim (airport as a parameter) into **`docs/superpowers/specs/2026-10-31-engine-out-glide-reference.js`** — that file is the model; port it, don't reinvent it, and match the golden cases below. First mockup: https://claude.ai/artifact/KRWFDGbwowH7urZvEemu9J.

## Intent

Dana, in his words: "I'm looking for a function that is always available so I can see it when I click on an airport inflight. This way, I'm always planning for an engine out and I'm not surprised when it happens, the data is always available." And: "the pilot [has] tunnel vision, being surprised and not performing at the highest level" — so FlyTab works out the best point to arrive on the runway centreline and tells him how to fly there.

Safety direction, his words: "if the glide-to-point is too far out or too low, the aircraft could land short at a high rate of speed with injuries. If the pilot is high at the glide to point, the descent rate and airspeed will increase but the collision speed at the end of the runway will be less and more survivable." **Err high. A wrong "GLIDE OK" is the failure to avoid.**

## Goals

1. Whenever the airport panel is open in flight (airport tapped on the map, airborne), it shows a live engine-out glide block for that airport, updating about once a second while open.
2. One glide model shared by this panel and the existing anomaly-triggered `EmergencyGlide` (`web/cockpit/emergency-glide.js`), replacing EmergencyGlide's `_windAdjustRange` (ground speed ÷ 80 kt, clamped 0.6–1.3 — overstates range by up to 30% in cruise) and its fixed `GLIDE_RATIO = 10` / `performance.glide_ratio`.

## Non-goals

- Terrain and obstacles along the glide (Dana: the panel does not need to say "terrain not checked" — "the pilot will know that. It just takes up space").
- Slips, flaps, S-turns (how a high arrival is converted on short final) — not modelled.
- Wind change with altitude during the glide (one wind at the current altitude).
- Choosing which airport to go to (EmergencyGlide's ranking stays as is; it only gets the shared range/feasibility model).
- On the ground / taxi: no glide block.

## Anti-goals

- Never "GLIDE OK" from optimistic inputs: missing wind → assume a 10 kt headwind; missing threshold data → don't pretend precision (see Runway data).
- Never more text than the mockup: no disclaimers, no explanation paragraphs in the panel.

## No hardcoded values (Dana, 2026-10-31)

"Don't hardcode values. Assume that this app could be used by other pilots with other aircraft." Every number in the model below is a setting with the agreed RV-9A value as its default — none appears as a literal in the model code. Aircraft-specific values live in the aircraft performance block (`aircraft-config.json` `performance`, editable in MORE → Configuration → Aircraft, persisted through the existing `flypi_user_aircraft` override like every other performance field); pilot-technique values live in a new `engineOutGlide` section of `cockpit-config.json` (Configuration, own card). Defaults:

| Setting | Where | Default (agreed) |
|---|---|---|
| Best-glide speed (KIAS) | aircraft `glide_ias_kt` | 65 |
| Glide sink rate at sea level, prop windmilling, gross weight (fpm) | aircraft `glide_sink_fpm` | 700 |
| TAS/sink increase per 1,000 ft (%) | aircraft `glide_density_pct_per_kft` | 2 |
| Turn bank angle (°) | pilot `turnBankDeg` | 30 (turn sink factor derived: 1/cos(bank)^1.5 = 1.24 at 30°) |
| Margin above the field / at the final point (ft) | pilot `marginFt` | 200 |
| Line-up allowance (ft per degree of turn onto final) | pilot `lineUpFtPerDeg` | 1.5 |
| Final point: fraction of runway length before the threshold | pilot `finalPointFraction` | 0.25 |
| Final point: minimum / maximum distance (ft) | pilot `finalPointMinFt` / `finalPointMaxFt` | 500 / 1000 |
| Headwind assumed when there is no wind data (kt) | pilot `noWindHeadwindKt` | 10 |
| Plan-B hysteresis (ft a final point needs to take over again) | pilot `planBHysteresisFt` | 100 |
| Farthest forecast-wind station to trust (nm) | pilot `windMaxStationNm` | 100 |
| On-course band for the turn cue (°) | pilot `onCourseDeg` | 5 |
| Shortest runway to glide to (ft) | aircraft `min_runway_ft` (already exists, synced from the flywhere profile) | as configured |

Physical constants (ft per nm, kt→fpm, the standard-rate turn formula) are not settings. Magnetic variation comes from `MagVar.declination` (never a constant), and runway length, headings and positions from the NASR data (never per-airport constants). The existing `performance.glide_ratio` is retired; the migration (read it if present, ignore it) is the builder's call.

## The model (as agreed — port the reference file)

- **Glide:** 65 KIAS best glide, prop windmilling, **700 fpm** at sea level, fully loaded (Dana: "Use 65 kias as the airspeed and assume the prop is windmilling. The decent rate would likely be about 700 feet / min"; an estimate). TAS and sink both rise 2% per 1,000 ft (`tas = 65 × (1 + 0.02 × alt/1000)`, `sink = 700 × tas/65`); glide angle constant (~9.4:1 still air). These become aircraft performance settings (`glide_ias_kt` 65, `glide_sink_fpm` 700) in `aircraft-config.json` + Configuration → Aircraft, replacing `glide_ratio`.
- **Wind:** winds aloft at the current altitude — in flight from FIS-B (`FisbClient.getNearestWind(lat, lon, altFt)`), else the pre-flight winds the route planner downloaded, else none. **No wind data → 10 kt headwind assumed**, shown amber "NO WINDS ALOFT · 10 kt headwind assumed". Heading from the GPS track (Dana: "the heading can be inferred from the gps track and the winds aloft come from the weather data"). Wind triangle for heading and ground speed.
- **Runway end:** the end most into the wind that is reachable; if none is reachable, the end with the most height to spare (a tailwind shown amber "RWY nn: N kt TAILWIND"). No wind data: the reachable end needing the least turn.
- **Final ("glide-to") point** — option B (Dana: "flytab selects a point off the end of the ideal runway based on the winds and runway length, as the glide to point with the intent to glide to the center of the field. The glide to point could be 500 - 1000 feet off the end of the runway depending on the length of the runway"): on that end's extended centreline, **25% of runway length before the landing threshold, clamped 500–1,000 ft**.
- **Height needed at the final point** = straight best glide from the point to **mid-runway** with the runway headwind component + **1.5 ft per degree** to line up + **200 ft margin**.
- **Turn toward the airport, flown not estimated:** from the current GPS track toward the final point at **30° bank**, sink × **1.24**, position and wind drift integrated in 2° steps (`initialTurn()`); its height loss comes off the height to spare and the straight glide starts where the turn ends. (A flat 1.5 ft/° allowance was 89 ft optimistic for a 179° reversal; the flown turn matched the simulated glide within 7 ft.)
- **Plan B** (Dana: "If I need to turn towards the airport the app must do that … if the target decent is too high then turn towards the airport instead of holding to the initial point"): if no final point is reachable, steer straight to the **nearest part of the runway**, arriving **≥ 200 ft** above the field — amber "FINAL POINT OUT OF REACH · TURN TO THE AIRPORT"; if even that is out of reach, red "CANNOT REACH <ICAO> · N ft short" with the heading to the airport. **Hysteresis:** once on plan B, a final point needs **100 ft** to spare to take over again.
- **Exact semantics (from the reference file, so nothing is guessed):** "reachable" = `spare ≥ 0` where `spare = alt − needMsl − initialTurn.lost − sink × time`, i.e. the turn's height loss is included; the line-up allowance applies to |runway landing heading − straight-leg course|; the final leg uses the wind component along the runway (`headRwy`); sink is the value at the current altitude (not integrated down the glide); with no wind every leg gets the assumed headwind (`gs = tas − noWindHeadwindKt` on any course, `headRwy = noWindHeadwindKt`); ties between ends keep the first end evaluated.
- **Rates:** TARGET = height to lose ÷ time to the point; PROJECTED = the glide sink at the current altitude; MEASURED = current vertical speed against a target computed with the current ground speed. A rate above target shows red with "+N too steep" (Dana: "If the measured or projected decent rate is greater than the target, show the difference and make it red").
- **Margin decision (2026-10-31):** keep 200 ft. The simulator found the margins conservative ("354 ft short" still landed with 4,223 ft of runway left); Dana accepted the design with 200 ft — a low arrival is the dangerous direction.

## Decisions (Dana, 2026-10-31)

- **Altitude: GPS MSL.** The glide check uses the Stratux GPS altitude (true MSL, comparable with the field elevation), never pressure altitude. No 3D GPS fix → no glide block. "Be at H ft or higher there" is in MSL, like the field elevation.
- **Winds: trusted only if fresh and near.** A forecast wind (FIS-B, else the pre-flight download) is used only when its station is within `windMaxStationNm` (default 100 nm, setting) and its forecast period is still valid; otherwise the no-wind headwind applies and the wind line says why ("NO CURRENT WINDS ALOFT · 10 kt headwind assumed"). The wind line names the source and the level actually used (e.g. "Wind 250/14 · 3,000 ft forecast · FIS-B" when below the lowest reporting level).
- **Runways: paved and at least the aircraft's minimum length, paved preferred.** Candidate runways are those with length ≥ `performance.min_runway_ft` (no setting → no length filter); paved runways first, a turf/gravel runway only when no paved one qualifies; among the candidates, the most into-wind reachable end as in the model. Heliports and seaplane bases get no glide block. An airport with no qualifying runway shows the "RUNWAY POSITION NOT KNOWN"-style plan-B check to the airport reference point, worded "NO SUITABLE RUNWAY · steer to the airport".

## Runway data (now available — bundle v11)

Each NASR runway in IndexedDB (`airport.runways[]`, written by the pipeline's `build_nasr.py`) carries per end (`base_` / `recip_` prefix): `_id`, `_lat`/`_lon` (physical end), `_thr_lat`/`_thr_lon` (landing threshold: displaced if any), `_true_hdg`, `_elev_ft`, `_displ_ft`, `_tch_ft`. Absent when the FAA has none — decide by finite coordinates, never by `_id`. Known properties:
- Mid-runway and runway length for the glide: from the two **physical ends** (`_lat/_lon`) when both exist; the landing threshold (`_thr_*`) is where the final-point offset is measured from.
- `_elev_ft` is the threshold elevation, except on ~210 displaced ends where it is the physical end's (same field, small difference) — use the field elevation (`airport.elev_ft`) as the ground for the margin, as the simulator does.
- `_tch_ft` is NASR's visual glide-slope TCH, not used by this model.
- **No coordinates for the runway** (8% of public-use runway ends, many private strips): the panel still shows a glide check to the **airport reference point** (plan-B style: steer to the airport, arrive ≥ 200 ft above the field), labelled "RUNWAY POSITION NOT KNOWN · steer to the airport" — never a final-point instruction. Coverage: `ApproachCharts.runwayThreshold(airport, fixId)` (merged in #189) is the existing threshold helper.
- Magnetic headings: `MagVar.declination(lat, lon)` (`web/shared/mag-var.js`; magnetic = true − declination).

## The panel (as agreed in the mockup and simulator)

In the airport panel (`web/cockpit/airport-popup.js`), near the top, only when airborne (use the recorder's/app's existing airborne state — the builder picks the established signal) and a GPS fix exists:

1. Verdict line — one of four states:
   - **✓ GLIDE OK · N ft to spare** (green): a final point is reachable (plan A).
   - **⚠ FINAL POINT OUT OF REACH · TURN TO THE AIRPORT** (amber) + "N ft to spare over the runway": plan B reachable.
   - **✗ CANNOT REACH <ICAO> · N ft short** (red): plan B not reachable.
   - **RUNWAY POSITION NOT KNOWN · steer to the airport** (grey border, verdict colour from the plan-B check to the airport reference point).
   ("TOO LOW" from the mockup cannot occur in the agreed model — an unreachable final point always falls to plan B — and is dropped.)
2. Big magnetic heading to steer: the wind-corrected heading of the **straight leg after the turn**, with a turn cue from the current GPS track to the point: "↱ right N°" / "↰ left N°" / "↑ on course" (within 5°).
3. "Fly HHH° · D.D nm to RWY nn final point" (plan B: "to RWY nn/mm (nearest part)").
4. "Be at H ft or higher there".
5. Three cells: TARGET / PROJECTED / MEASURED fpm, red with "+N too steep" when above target.
6. Wind line: "Wind DDD/SS at AAAA ft · FIS-B" (source named) or the amber no-wind / tailwind text.
- Map: when the panel is open, a line from the aircraft to the final point, a ring at the point, and a short dashed final to the threshold (colour = verdict).
- Text sizes 17–30 px using the design tokens; panel width as the existing airport panel; light theme; numbers in `--font-instrument` weight 900.
- Dana reversed one earlier request: the airport text does not need to be larger.
- Live: recompute about once a second while the panel is open; stop when closed.

## EmergencyGlide

Its range/feasibility uses the shared model (65 KIAS / 700 fpm, wind triangle, 10 kt headwind without wind) instead of `glide_ratio` and the GS ÷ 80 factor. Its ranking, overlay and approach detail otherwise unchanged; where it shows a heading/height to an airport, it may reuse the shared plan output (builder's call, no new UI required).

## Constraints

- No internet in flight: everything from data already on the tablet (NASR in IndexedDB, FIS-B winds, pre-fetched winds).
- Tap Handler Regression Rule: the airport popup must still open on a normal tap; the glide block must not change the three map tap handlers.
- Pure model code in its own module (e.g. `web/shared/glide-model.js`, classic script, no DOM) with vitest tests ported from simulator scenarios (KLKR 06/24, the "6 nm at 5,500 ft" case, a 179° reversal, plan-B switch and the 100 ft hysteresis, no-wind headwind, tailwind end choice, missing-threshold fallback).
- User manual updated in the same commit; FLYTAB_VERSION bumped; `npm test` before `build.sh`.

## Left to the builder

- Module/file names and how the panel subscribes to position updates (existing Stratux situation events).
- Exact airborne signal (existing app/recorder state).
- Map overlay styling within the design tokens.
- Whether EmergencyGlide's approach detail shows the shared plan's heading/height (no new UI required).
- How the Configuration fields are grouped (next to the other aircraft performance fields).

## Golden cases (reference file output; KLKR 06/24, elev 486, 6,004 ft, runway end A true 233°)

The production model, given the same inputs and the default settings, must match these to ±1 ft (spare, need), ±1° (heading), ±0.01 nm, ±1 fpm. Generated by running `plan()` from the reference file; `[on plan B]` = `preferDirect` (hysteresis active).

| Case | kind | end | spare ft | need MSL ft | hdg true | leg nm | target fpm | projected fpm | turn now ° |
|---|---|---|---|---|---|---|---|---|---|
| A north 5 nm, 4500 ft, track 160, wind 250/14 | direct | both | 529 | 686 | 186 | 4.69 | 887 | 763 | 15 |
| A north 5 nm, 4500 ft, track 160, wind 250/14 [on plan B] | direct | both | 529 | 686 | 186 | 4.69 | 887 | 763 | 15 |
| B 6 nm south, 5500 ft, track 360, wind 250/14 | final | A | 200 | 1406 | 355 | 6.41 | 817 | 777 | 5 |
| B 6 nm south, 5500 ft, track 360, wind 250/14 [on plan B] | final | A | 200 | 1406 | 355 | 6.41 | 817 | 777 | 5 |
| C 3 nm NE, 2500 ft, track 045 (179 deg reversal), no wind | direct | both | -389 | 686 | 228 | 2.51 | 585 | 735 | 178 |
| C 3 nm NE, 2500 ft, track 045 (179 deg reversal), no wind [on plan B] | direct | both | -389 | 686 | 228 | 2.51 | 585 | 735 | 178 |
| D 9 nm west, 3500 ft, track 090, wind 250/14 | direct | both | -1886 | 686 | 096 | 8.61 | 448 | 749 | 2 |
| D 9 nm west, 3500 ft, track 090, wind 250/14 [on plan B] | direct | both | -1886 | 686 | 096 | 8.61 | 448 | 749 | 2 |
| E 15 nm north, 3000 ft, track 180, wind 360/20 | direct | both | -5052 | 686 | 178 | 14.71 | 233 | 742 | -2 |
| E 15 nm north, 3000 ft, track 180, wind 360/20 [on plan B] | direct | both | -5052 | 686 | 178 | 14.71 | 233 | 742 | -2 |
| F 6 nm NE, 4000 ft, track 225, wind 060/15 | final | A | 78 | 1051 | 221 | 5.35 | 777 | 756 | -1 |
| F 6 nm NE, 4000 ft, track 225, wind 060/15 [on plan B] | direct | both | 356 | 686 | 221 | 5.51 | 847 | 756 | -1 |
