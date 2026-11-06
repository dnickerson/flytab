# Engine-out glide: land on the runway, measured surface wind (amends 2026-10-31 design)

**Status:** decided by Dana 2026-11-06 ("make the changes"). Amends
`2026-10-31-engine-out-glide-panel-design.md`; where they differ, this file wins. The
reference simulator (`2026-10-31-engine-out-glide-reference.js`) stays the source for
the glide physics (turn, wind triangle, sink, density) but no longer for target choice.

## Why

11-06 KLKR pattern flight (tablet v12.76, screen recording + `20261106_KLKR-KLKR.csv`).
Replaying the CSV through the real model reproduced every on-screen verdict within
~10 ft, so the code did what the model says. Dana: *"I could have made the airport at
any point during the downwind"*, *"if the engine quit while on downwind, I would turn
towards the airport and land. I would not fly to the point off the end of the runway"*,
ground wind VRB 4 kt. Findings:

1. "GLIDE OK" required reaching a final point 500-1,000 ft before the threshold with
   height to glide on to **mid-runway** + 200 ft. In a pattern it is never green.
2. With no winds aloft (always, below FIS-B's lowest level, 3,000 ft) every leg got an
   assumed **10 kt headwind**, and a VRB METAR was also treated as 10 kt. With calm wind
   the downwind is reachable (200 ft margin: to −1 ft at its last second; 100 ft: into
   the base turn).
3. Display bugs: below 200 ft on a lined-up final the plan said CANNOT REACH (target
   = field + 200 at the runway edge); on the runway the nearest-point target is abeam,
   so a phantom 90° turn showed "~860 ft low" on the rollout.

## Decisions

### 1. One plan: turn toward the airport and land on the runway
- The target is the **nearest point of the nearest runway segment** (today's plan-B
  geometry, `kind 'direct'`), arriving **≥ marginFt (200) above the field**, glide
  physics unchanged (flown turn at `turnBankDeg`, wind triangle, sink at altitude). No
  line-up allowance (unchanged from plan B).
- Reachable (`spare ≥ 0`) → green **"✓ GLIDE OK · N ft high"**; else red
  **"✗ CANNOT REACH ICAO · N ft low"**. TO: `RWY 06/24`, note `nearest part`.
- The final point off the end, its "glide to mid-runway" height, plan A/B switching,
  hysteresis and the amber "FINAL POINT OUT OF REACH" are **removed**. `preferDirect`
  is accepted and ignored. `kind 'final'` now means short final (§3).
- No runway coordinates → `kind 'ref'`, unchanged ("RUNWAY POSITION NOT KNOWN" /
  "NO SUITABLE RUNWAY · steer to the airport").
- Settings no longer used: `finalPointFraction`, `finalPointMinFt`, `finalPointMaxFt`,
  `lineUpFtPerDeg`, `planBHysteresisFt`. Removed from the MORE → Configuration editor;
  the keys may stay in `cockpit-config.json` / `GlideInputs.validate` (no effect).

### 2. Glide wind: measured surface wind before the assumed headwind
Order for the glide legs (initial turn and straight leg):
1. Winds aloft, as today (`GlideInputs.glideWind`: FIS-B, else pre-flight; trust limits).
2. Else the **airport's runway wind** (`GlideInputs.runwayWind`, same sources and
   freshness / distance rules as today):
   - METAR with direction → `{ from, kt, gustKt }`; on a leg whose wind component is a
     headwind the gust speed is used (err high), else the steady speed.
   - VRB n (gust g) → `{ headKt: max(n, g) }`: an n kt headwind on every course (the
     worst a variable wind can do).
   - calm → `{ headKt: 0 }`.
3. Else the assumed `noWindHeadwindKt` (10) headwind on every course, as today.

Model input `glideWind` is therefore `null | { from, kt, gustKt? } | { headKt }`.
`triangle()` (and so `initialTurn()`): `null` → `gs = tas − noWindHeadwindKt`;
`{ headKt }` → `gs = tas − headKt`; `{ from, kt, gustKt }` → vector triangle with
`kt` replaced by `max(kt, gustKt)` when `cos(from − course) > 0`.

`GlideInputs.runwayWind` VRB result gains its speed: `{ kind: 'vrb', kt, gustKt|null }`.
`runwayHead()` for VRB returns `max(kt, gustKt)` (was `noWindHeadwindKt`); a VRB with no
finite speed keeps `noWindHeadwindKt`.

Wind line: the glide part names the source, e.g. `Glide: METAR KLKR VRB/04 (8 min) ·
surface` / `Glide: 250/14 at 3,000 ft · FIS-B`; **amber only** when the 10 kt headwind
is assumed (`NO CURRENT WINDS ALOFT · 10 kt headwind assumed`).

The map's nearest-airports list (`EmergencyGlide`) keeps winds aloft or the assumed
headwind (it has no per-airport METAR); it gets decision 1 through `plan()`.

### 3. You have made it
- **Over the runway:** the aircraft's projection lies on the runway segment (0 < k < 1)
  and its distance from the centreline is ≤ `max(widthFt / 2, 50) + 150` ft (`widthFt`
  from the NASR runway `width_ft`, 100 ft if unknown) → `kind 'over'`: green
  **"✓ OVER RWY 06/24"**, no grid, no map line. Plan numbers stay finite
  (`spare = alt − elev`, `legNm 0`, `target 0`, `hdgTrue = track`, `turnNow 0`).
- **Short final:** for a runway end, threshold ahead along the landing heading by
  0 < d ≤ 1.0 nm, lateral offset from the extended centreline ≤ 0.1 nm, track within
  30° of the landing heading → `kind 'final'`: straight glide to the **threshold** with
  **no margin** (`needMsl = elev`), ground speed from the wind triangle on the landing
  heading, no turn. Spare ≥ 0 → **"✓ GLIDE OK · N ft high"**, TO `RWY 06`, note
  `on final`; else red CANNOT REACH. Tailwind amber line (`RWY 06: n kt TAILWIND`) only
  for `final`, from `headRwy` (`runwayHead`).
- Precedence: `over`, then `final`, then `direct`; `ref` when no runway segments.

### Rulings during implementation (2026-11-06, after the first replay)
- **Short final target = the physical runway end, ground = that end's elevation.** The
  first build gave −4.8 ft at 20:04:51: the aircraft was 337 ft before the 06 *landing*
  threshold, which is displaced 105 ft, and the 06 end (459.7 ft) is 26 ft below the
  field elevation (486). For `kind 'final'` the straight glide goes to the end's
  **physical** end (`base_lat/lon` / `recip_lat/lon`; the threshold when there is none)
  and `needMsl` is that end's NASR elevation (`base_elev_ft` / `recip_elev_ft`; the field
  elevation when unknown). The along-track gate (0 < d ≤ 1.0 nm) is measured to the same
  point. `direct` keeps the field elevation + margin.
- **Over the runway needs to be low:** `kind 'over'` only when also `alt − elev ≤ marginFt`.
  Higher over the runway footprint (same lateral gate), `direct` is used with **no
  initial turn and a zero leg** (`spare = alt − elev − marginFt`), so there is no
  phantom turn toward an abeam point.
- 20:03:14 (last second of the downwind) is −51 ft under VRB/04 (+11 at 20:03:10): the
  200 ft margin decides it; not tuned.

## Acceptance (the 11-06 flight, VRB 04 surface wind, 200 ft margin)
- Downwind 20:02:11-20:03:10: GLIDE OK. (20:03:14 may be within a few ft either side.)
- Base at 20:04:01 (569 ft AGL, 0.8 nm): CANNOT REACH (genuinely marginal).
- 20:04:51 (33 ft above the field, lined up, ~230 ft before the pavement): GLIDE OK, on final.
- Rollout 20:04:55 onward: OVER RWY 06/24, never "~860 ft low".
- Same flight, no METAR and no winds aloft: the assumed 10 kt applies (amber wind line).
