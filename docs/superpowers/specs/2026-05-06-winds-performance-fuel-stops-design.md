# Winds Aloft + Altitude Performance + Fuel Stops Design

**Date:** 2026-05-06
**Status:** Approved
**Scope:** FlyTab route planner — accurate time/fuel prediction

---

## Overview

Upgrade `recomputeLegs` to produce wind-corrected, altitude-accurate time and fuel estimates, then add a proactive fuel stop recommendation panel. Work is split into two milestones:

- **Milestone 1** — Core accuracy: winds, altitude-based TAS/fuel, VFR auto-altitude, power setting, per-leg altitude overrides (IFR step climbs), departure time/ETA
- **Milestone 2** — Fuel stops: proactive candidate search with fuel pricing, dual stacked plans

---

## Milestone 1: Core Accuracy

### Winds Aloft Data

**Source priority (cache-on-demand):**
1. Fresh AWC fetch on plan tap (`aviationweather.gov/api/data/windtemp`, low-level FD format)
2. FIS-B cached winds from last Stratux connection (UAT product #101 — format must be mapped to canonical shape at implementation time; investigate `fisb-client.js` output before building the adapter)
3. Last AWC cached fetch
4. No-wind fallback (notify pilot)

**Data shape** (matching flywhere):
```javascript
// allWinds: Record<stationId, Record<altFt, WindEntry>>
// altFt keys: 3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000
// WindEntry: { dir: number, spd: number, temp?: number, variable?: boolean }
{ 'CLT': { 6000: { dir: 270, spd: 25, temp: 5 } }, ... }
```

**Wind lookup per leg:**
- Find nearest FD station to leg midpoint using haversine (`findNearestFdStation`)
- Select nearest altitude key to cruise altitude (`getWindAtAlt`) — no interpolation, matches flywhere
- Skip leg wind correction if `variable: true`

### Computation Pipeline

`recomputeLegs(plan, profile, { departureTime, winds } = {})` extended signature.

**Pre-loop:**
```
cruiseAltFt = vfrAltitude(magCourse, dep, dest)  // or pilot override
eta = departureTime ?? Date.now()
```

**Per-leg:**
```
midLat, midLon = midpoint(wps[i], wps[i+1])
station = findNearestFdStation(winds, midLat, midLon)
wind = getWindAtAlt(winds[station], cruiseAltFt)

tas = engineData.tasAtAltitude(cruiseAltFt)   // parametric FlyTab model
   OR profile.cruise_ktas                      // fallback for generic profiles

gs = groundSpeed(tas, bearingTrue, wind.dir, wind.spd)
oatC = wind.temp ?? null

decomp = decomposeLeg(profile, {
    distNm, altFt: cruiseAltFt,
    departingFromGround, endingAtGround,
    gsKt: gs,       // wind-corrected ground speed
    tasKt: tas,     // altitude-corrected TAS
    oatC            // for phase fuel calculations
})

leg.eta = prevEta + decomp.totalTimeHrs * 3_600_000
```

**Per-leg altitude:** Each leg uses `legAltFt = wps[i+1].overrideAlt ?? cruiseAltFt`. TAS, ground speed, wind lookup, and fuel burn all use `legAltFt` — legs at different altitudes (step climbs, per-leg overrides) automatically get the correct performance numbers for that altitude.

**TAS and ground speed per leg:**
```javascript
// OAT from wind data at legAltFt; null falls back to ISA standard
const oatC  = wind?.temp ?? null;
const tas   = profile.cruise_ias
            ? iasToTas(profile.cruise_ias, legAltFt, oatC)   // ISA atmosphere model
            : tasAtAltitude(profile, legAltFt);               // empirical fallback
const gs    = groundSpeed(tas, bearingTrue, wind?.dir ?? 0, wind?.spd ?? 0);
```

TAS rises with altitude (thinner air for same IAS) and falls slightly above the engine's critical altitude. At 9,500 ft vs 5,500 ft the difference for an RV-9A is roughly 8–10 kt TAS — a material difference in leg time and fuel.

**Fuel burn at altitude:**
- Cruise: `gphAtPower(profile, pctPower / 100, legAltFt, 'LOP')` — lean of peak for all cruise phases
- Climb/descent phases: `gphAtPower(profile, climbPowerFrac, midAltFt, 'FULL_RICH')` — full rich as in existing model
- All calculations driven by aircraft profile data — no hardcoded SFC constants in planning code

**`gphAtPower` extension (engine-data.js):**

When the profile carries `max_hp`, use SFC-based calculation matching flywhere's model:
```javascript
// SFC defaults from flywhere engine-data.ts (gal/HP/hr):
const SFC = { LOP: 0.067, ROP: 0.083, FULL_RICH: 0.093 };
export function gphAtPower(profile, powerFrac, altFt, mixture = 'ROP') {
    if (profile.max_hp) {
        const maxPct = maxPowerAtAltitude(profile, altFt);  // % available at altitude
        const actualFrac = Math.min(powerFrac, maxPct / 100);
        return actualFrac * profile.max_hp * (profile['sfc_' + mixture.toLowerCase()] ?? SFC[mixture]);
    }
    // Fallback: linear scale from fuel_burn_gph (assumed at 75% power, ROP)
    return profile.fuel_burn_gph * (powerFrac / 0.75);
}

export function maxPowerAtAltitude(profile, altFt) {
    const lossPerKft = profile.alt_power_loss_pct_per_kft ?? 3.0;
    return Math.max(0, 100 - altFt * lossPerKft / 1000);
}
```

**`AircraftProfile` additions** (types/aircraft-profile.js):
```
cruise_ias                indicated airspeed at cruise power (kt); enables ISA-model TAS
max_hp                    engine rated HP (e.g. 180 for O-360-A1A)
alt_power_loss_pct_per_kft  % power lost per 1000 ft (default 3.0)
sfc_lop                   optional override for LOP SFC (gal/HP/hr)
sfc_rop                   optional override for ROP SFC (gal/HP/hr)
sfc_full_rich             optional override for full-rich SFC
```

The RV-9A default profile in `route-planner.js` gains `max_hp: 180` and `cruise_ias` (derived from 155 KTAS at 8,000 ft standard day ≈ 148 KIAS). Profiles without `cruise_ias` fall back to `tasAtAltitude` (empirical two-segment model).

### Phase Model

`decomposeLeg` is extended with optional `{ gsKt, tasKt, oatC }` overrides:
- When present, replace `profile.cruise_ktas` for time and fuel calculations for that leg
- Climb and descent mid-altitude TAS computed via `tasAtAltitude` at the phase midpoint altitude
- Existing climb/cruise/descent phase structure unchanged

### Per-Leg Altitude Overrides and IFR Step Climbs

Any fix waypoint can carry an `overrideAlt` that supersedes the global cruise altitude for legs that pass through it.

**Data model:** `waypoint.overrideAlt?: number` — added to the `FlightPlan` waypoints type.

**Interaction:** Long-press any fix pill → altitude picker appears (same VFR altitude options as the global selector, plus a "Clear" option to remove the override). Pill shows a small altitude badge (e.g., `9,500`) when an override is set.

**IFR step climbs** use this same mechanism — pilot sets `overrideAlt` at the fix where ATC assigns a new altitude; subsequent legs use that altitude until the next override or the route end.

**Computation:** `recomputeLegs` resolves altitude per leg:
```
legAltFt = wps[i+1].overrideAlt ?? cruiseAltFt
```
Wind, TAS, and fuel burn all use `legAltFt` for that leg. Where consecutive legs share the same altitude, the phase model is continuous (no repeated climb/descent penalty).

**Persistence:** `overrideAlt` is stored in the plan's waypoints array in `flypi_planner_opts`.

### VFR Altitude Auto-Selection

Ported verbatim from flywhere `vfrAltitude()`:
- Compute overall route magnetic course (dep → dest)
- Eastbound (0–179°): odd-thousands + 500 ft, distance-scaled base (4,000 / 6,000 / 8,000 / 10,000 ft)
- Westbound (180–359°): even-thousands + 500 ft, same scale
- Caps: eastbound 3,500–17,500 ft; westbound 4,500–16,500 ft

### New Math Functions (ported from flywhere to `web/shared/planning/math/route-math.js`)

```javascript
iasToTas(ias, altFt, tempC)      // standard lapse rate, OAT correction
groundSpeed(tas, course, windDir, windSpd)  // WCA math, min 30% TAS
vfrAltitude(magCourse, dep, dest)           // hemispheric rule
```

Wind lookup functions (`getWindAtAlt`, `findNearestFdStation`) live in `winds-interpolator.js`, not `route-math.js`.

### New Module: `web/shared/planning/planner/winds-interpolator.js`

Responsibilities:
- `fetchWinds(departureTime)` — AWC fetch (with cycle selected from `departureTime.getUTCHours()`) → FIS-B fallback → cache fallback → null
- `findNearestFdStation(allWinds, lat, lon)` — delegates to `WeatherClient.findNearestFdStation` (already implemented)
- `getWindAtAlt(stationWinds, altFt)` — nearest-key lookup (simple, inline)
- Cache management (localStorage keyed by forecast cycle + date)

**Reuse note:** `WeatherClient.parseAllWindsAloft`, `WeatherClient.findNearestFdStation`, and `WeatherClient.parseWindGroup` already exist in `web/shared/weather-client.js` — call them directly rather than reimplementing.

### Departure Time and ETA

**Time zones:** AWC FD data and FIS-B winds are always Zulu (UTC). The pilot-facing UI shows local time. All internal times are stored as ms since epoch (UTC). Conversion points:

| Layer | Format | How |
|---|---|---|
| `datetime-local` input | Local time (browser default) | `new Date(inputValue)` → UTC ms internally |
| Forecast cycle selection | UTC | `departureDate.getUTCHours()` selects FD cycle |
| `leg.eta` | UTC ms epoch | `Date.toLocaleTimeString()` for display |
| FIS-B wind timestamps | Zulu | Map to canonical shape before use |

**Forecast cycle selection:** FD bulletins are issued ~00Z and ~12Z with 6/12/24-hour lookaheads. Given departure UTC hour, pick the FD cycle whose valid time is closest to departure:

```javascript
// fcst param: '06', '12', or '24'
function selectFdCycle(departureUtcHour) {
    if (departureUtcHour < 9)  return '06';   // valid ~06Z
    if (departureUtcHour < 21) return '12';   // valid ~12Z or ~18Z
    return '24';                               // valid ~00Z next day
}
```

**Panel behavior:**
- Pilot sets departure time via `<input type="datetime-local">` (displays local, stored as UTC ms)
- Defaults to `Date.now()`
- Stored in `flypi_planner_opts`
- Changing departure time re-runs `recomputeLegs` only (no A* re-run — fast)
- ETAs displayed as local time throughout panel and route table

---

## Milestone 2: Fuel Stops

### Search Model

After every successful plan, search for fuel stop candidates based on `maxLegHrs`:

1. Run `findSplitPoints(legs, maxLegHrs)` — finds route positions where cumulative ETE hits `maxLegHrs`; interpolates lat/lon within the crossing leg
2. For each split point, search airports within 25nm with 100LL or Jet-A fuel (from NASR airport data)
3. Rank by: (1) fuel availability, (2) runway length ≥ 3,000 ft, (3) distance off-route, (4) paved surface
4. Fetch fuel price per candidate airport — source to be confirmed before Milestone 2 begins (investigate AirNav, AOPA Fuel Hub, SkyVector); cache per airport for 24 hours; display inline; omit gracefully on fetch failure
5. Show top 3 candidates per split point

### Dual Plan Model

When pilot selects a fuel stop:
- Plan 1: `departure → fuel stop` (re-planned with A*)
- Plan 2: `fuel stop → destination` (re-planned with A*)
- Panel shows two stacked plan blocks, each with pills, stats, and Field 15 copy button
- Fuel stop section collapses (replaced by dual-plan view)

### `findSplitPoints` (ported from flywhere)

```javascript
// Returns array of { lat, lon, afterLegIndex, cumulativeTimeMin }
// maxLegHrs converted to minutes internally (maxMin = maxLegHrs * 60)
findSplitPoints(legs, maxLegHrs, coords)
// Interpolates position within the crossing leg using time fraction
```

---

## Display Integration

### FlightPlan.legs[] — New Fields

`recomputeLegs` must store all computed values in the leg so downstream consumers don't need to recompute them:

| Field | Type | Description |
|---|---|---|
| `eta` | `number` (ms UTC) | Absolute arrival time at `to` waypoint |
| `legAltFt` | `number` | Resolved altitude for this leg (`overrideAlt ?? cruiseAltFt`) |
| `windDir` | `number\|null` | Wind direction used (degrees true) |
| `windSpd` | `number\|null` | Wind speed used (kt) |
| `tasKt` | `number` | Altitude-corrected TAS (already present; confirm populated) |
| `gsKt` | `number` | Wind-corrected ground speed (already present; confirm populated) |
| `pctPower` | `number` | Power setting used (e.g. 65) |

These fields are stored in `flight-plan.js` type and written by `recomputeLegs`.

### route-table.js

The route table has `_computeEnroute()` which calculates per-waypoint display values. When a plan is loaded pre-flight, `_computeEnroute()` should read `tasKt`, `gsKt`, `windDir`, `windSpd`, `legAltFt`, and `eta` from `plan.legs[]` rather than recomputing them — the plan is now the authoritative source for these values. In-flight, live GPS/engine data continues to override as it does today.

**Changes needed in route-table.js:**

1. **ETA column** — not currently shown anywhere. Read `leg.eta`, format as local time (`toLocaleTimeString()`). Add as a column in the route table alongside ETE. Also add to the `upcoming` waypoints list in the nav strip event.

2. **Per-leg altitude** — route-table already shows `wp.altitude`; confirm it reads `leg.legAltFt` when set (may require routing through `_computeEnroute()`).

3. **TAS / GS / wind** — already displayed; wire to read from `leg.tasKt`, `leg.gsKt`, `leg.windDir/windSpd` when plan is loaded, so pre-flight table shows wind-corrected values without requiring live GPS.

4. **Power %** — already displayed (`wp._pwr`); read `leg.pctPower` from plan when pre-flight.

### activeroute:legupdate Event

Add to the event payload emitted by `route-table._emitLegUpdate()`:

```javascript
eta: leg.eta,              // ms UTC — arrival time at active waypoint
destEta: destLeg.eta,      // ms UTC — arrival time at destination
legAltFt: leg.legAltFt,    // resolved altitude for active leg
```

### Nav Strip / Instrument Strip

- **Nav strip**: Show `destEta` formatted as local time alongside existing `destEteMin`. E.g.: `KMIA  342nm  ETE 2:14  ETA 14:32`.
- **Instrument strip**: Show `destEta` in the ETE delta field area; pilot can compare plan ETA vs live ETA as winds deviate from forecast.

---

## UI Changes: route-planner-panel.js

### Opts Row Additions

| Control | Type | Default | Persisted |
|---|---|---|---|
| Departure time | `datetime-local` input | `now` | `flypi_planner_opts` |
| Cruise altitude | Dropdown (Auto / VFR altitudes) | Auto | `flypi_planner_opts` |
| Power % | Dropdown (55 / 60 / 65 / 70 / 75%) | 65% LOP | `flypi_planner_opts` |

Auto altitude label shows resolved value: `Auto · 6,500 ft`.
Altitude dropdown options filtered by route bearing (eastbound shows odd+500, westbound shows even+500).
Changing departure time or power % re-runs `recomputeLegs` only (no A* re-run — fast).

### Stats Bar Update

```
6,500 ft · HW 12kt avg   |   Route 342nm   +47nm (+16%)   |   2h 14m   18.3 gal
```

- Wind summary: average head/tailwind across all legs
- ETE and fuel total from wind-corrected `recomputeLegs`
- During winds fetch: wind slot shows `Fetching winds…`

### Fuel Stop Section (Milestone 2)

Appears below stats bar after every successful plan. Shows top candidates:

```
Fuel Stops  (based on 2.0 hr max leg)
  KFLO  Florence Rgnl     $5.89/gal   12nm off-route
  KCQW  Cheraw             No price    8nm off-route
  K5J9  Mullins            No price    19nm off-route
```

Tapping a candidate splits panel into two stacked plan blocks.

### Amber Warning Strip

Reuses existing avoid-strip pattern. Stacks dismissible warnings:
- `Wind data unavailable — time and fuel use calm-air estimates`
- `Variable winds reported — [LEG] treated as calm`
- `No wind data near [FIX] — leg treated as calm`
- `No fuel available near this point — adjust max leg time` (Milestone 2)

Clears automatically when condition resolves.

---

## Modified Files

| File | Change |
|---|---|
| `web/shared/planning/math/route-math.js` | Add `iasToTas`, `groundSpeed`, `vfrAltitude`, `getWindAtAlt`, `findNearestFdStation` |
| `web/shared/planning/math/engine-data.js` | Extend `gphAtPower` with `altFt` + `mixture` params; add `maxPowerAtAltitude` |
| `web/shared/planning/math/fuel-phases.js` | Extend `decomposeLeg` opts: `gsKt`, `tasKt`, `oatC` |
| `web/shared/planning/types/aircraft-profile.js` | Add `max_hp`, `alt_power_loss_pct_per_kft`, `sfc_lop/rop/full_rich` |
| `web/shared/planning/planner/route-planner.js` | Extend `recomputeLegs` signature; wire winds + altitude |
| `web/shared/planning/planner/winds-interpolator.js` | **New** — fetch, cache, lookup |
| `web/shared/planning/planner/fuel-stop-search.js` | **New** (Milestone 2) — `findSplitPoints`, airport search, ranking |
| `web/shared/planning/types/flight-plan.js` | Add `overrideAlt?` to waypoint type; add `eta`, `legAltFt`, `windDir`, `windSpd`, `pctPower` to leg type |
| `web/cockpit/route-planner-panel.js` | Departure time picker, altitude selector, power % selector, per-fix altitude override UI, stats bar update, fuel stop section |
| `web/cockpit/route-table.js` | ETA column; read `tasKt`/`gsKt`/`windDir`/`windSpd`/`legAltFt`/`pctPower` from plan legs pre-flight; add `eta`/`destEta`/`legAltFt` to `activeroute:legupdate` event |
| `web/cockpit/route-nav-strip.js` | Show `destEta` as local time alongside ETE |
| `web/style.css` | New panel elements for opts additions, fuel stop section |
| `web/index.html` | Add `<script>` tag for `winds-interpolator.js` |

---

## Out of Scope

- Terrain-aware altitude selection (minimum en-route altitude enforcement) — separate future spec
