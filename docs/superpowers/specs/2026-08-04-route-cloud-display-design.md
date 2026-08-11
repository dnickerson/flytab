# Route Cloud Display — Design

**Date:** 2026-08-04
**Status:** Approved, ready for implementation planning
**Scope:** Cloud layers + freezing level on the route profile view

---

## Problem

`web/cockpit/route-profile.js` already renders cloud layers and a freezing level:

- Line 330 — `routeData.cloudLayers` → `{dist_nm, base_ft, top_ft}` rectangles
- Line 309 — `routeData.freezingLevelFt` → a horizontal reference line

A repo-wide grep for both identifiers hits only `route-profile.js` and its two build
copies. **Nothing ever populates either field.** The renderer has been dead code since
it was written.

This is therefore a data-sourcing problem, not a UI problem. The deliverable is whatever
produces the cell/contour/freezing-level arrays the renderer consumes.

## Goals

Give the pilot an honest situational picture of cloud along the planned route, at the
altitudes flown, valid at the time each point is reached.

Explicitly **not** goals — the pilot interprets the picture:

- No icing-risk alerting or cloud/freezing-level overlap logic
- No VMC-on-top or "can I get above it" computation
- No map overlay (profile view only)
- No manual refresh control

## Data source

### Selected: Open-Meteo pressure-level cloud cover

Verified live on 2026-08-04 (evidence in the Appendix):

| Property | Value |
|---|---|
| Vertical structure | 10 pressure levels with geopotential heights |
| CORS | `access-control-allow-origin: *` — **no flywhere proxy needed** |
| Multi-point | Whole route in one call |
| Payload | measured 20 pts × 12 levels × 24 h = 97 KB raw, **9.7 KB gzipped**. This design uses 10 levels × 48 h, so expect roughly **~16 KB gzipped** — same order, still trivial. |
| Freezing level | `freezing_level_height`, same response |
| Licence | CC-BY 4.0, non-commercial only |

The Capacitor WebView runs as `http://localhost`. Unlike `aviationweather.gov` — which
sends no CORS headers and is why `Settings.workerBase` exists — Open-Meteo sends
`*`, so this is a direct fetch with no proxy hop.

### Rejected alternatives

| Source | Why not |
|---|---|
| **FIS-B / Stratux** | No cloud product exists. Verified against `~/stratux/stratux-full/main/gen_gdl90.go:132` — IDs 81–83 are *radar echo tops* (storm tops), not cloud tops, and there is no icing/turbulence/cloud entry anywhere in `product_name_map`. In flight, clouds are available only as METAR/TAF text at points and G-AIRMET IFR/MT_OBSC areas. |
| **AWC `griddata`** | Endpoint returns HTTP 404. See Known Adjacent Issues. |
| **NWS `api.weather.gov`** | `skyCover` is a single scalar percentage with no vertical structure, and `ceilingHeight` is sparse. One HTTP call per ~2.5 km grid cell means N calls per route. |
| **HRRR GRIB direct** | Best data — carries true diagnosed `HGT:cloud base`, `HGT:cloud top`, `HGT:cloud ceiling`, `LCDC/MCDC/HCDC/TCDC`, verified present in a live inventory. Rejected for *this* build only because GRIB2 decoding requires server-side work in `~/fly-pipeline`. This is the fallback if the licence ever becomes a blocker. |

### API traps — do not rediscover these

**Never request `cloud_base` or `cloud_top`.** Open-Meteo accepts both parameters,
returns them as keys, and reports `"units": "undefined"` with **every value `null`** —
even where `cloud_cover` reads 61%. Tested across six models (default, `best_match`,
`gfs_seamless`, `icon_seamless`, `ecmwf_ifs025`, `gfs_graphcast025`): zero non-null
values in all six. Reading the key list alone would produce a feature that silently
renders nothing. A comment stating this must sit next to the URL builder.

Vertical structure comes from `cloud_cover_<L>hPa` + `geopotential_height_<L>hPa`.

## Vertical resolution — and the honesty decision

Real geopotential heights from the live fetch:

| Level | Height | Gap below |
|---|---|---|
| 1000 hPa | 400 ft | — |
| 975 hPa | 1,131 ft | 731 ft |
| 950 hPa | 1,873 ft | 742 ft |
| 925 hPa | 2,631 ft | 758 ft |
| 900 hPa | 3,408 ft | 777 ft |
| 850 hPa | 5,013 ft | 1,605 ft |
| 800 hPa | 6,686 ft | 1,673 ft |
| 700 hPa | 10,354 ft | **3,668 ft** |
| 600 hPa | 14,520 ft | **4,166 ft** |
| 500 hPa | 19,274 ft | **4,754 ft** |

Resolution is ~750 ft below 6,700 ft — genuinely useful for a low deck — and collapses
above it. A cloud layer living entirely between 6,686 and 10,354 ft is invisible to this
data, and that gap straddles typical RV-9A cruise altitudes.

**Decision: render at native resolution. No interpolation anywhere.**

Interpolation would produce a clean-looking `BKN 8,500–11,000` whose precision is
manufactured — nothing was sampled between those levels. The blocky native rendering
quotes the wider band that the model actually resolves, which prompts the pilot to ask
the question rather than trust a number invented by the renderer. This is the same
principle as the fuel work in 45467e4 ("no fabricated figures").

## Architecture

One new shared module, `web/shared/cloud-forecast.js`, exposing `CloudForecastStore`,
modelled on the existing `HRRRPreflightStore` (IDB open/load/save, staleness, age label).
The trigger point and the renderer already exist.

```
route or cruise-alt change  (route-table.js)
   └─ NetworkMode.mode ∈ {home, internet} ?
        └─ CloudForecastStore.fetchAndStore(samplePoints)
             └─ 1 × Open-Meteo call
                  └─ normalize → IndexedDB 'flytab_cloud_forecast'

_buildProfileData()  (route-table.js:2574)
   └─ CloudForecastStore.getCells({routeHash, samplePoints, etaMs})   ← cache ONLY
        └─ routeData.cloudCells / .cloudContours / .freezingLevel
             └─ RouteProfileView._render()
```

### Two non-obvious decisions

**Store the raw hourly cube; resolve ETA→hour at render time.** Baking the time-correct
slice at fetch time breaks when departure slips — the cache would be pinned to the ETAs
held at planning time, and it cannot be refetched from the hold short with no internet.
Storing all 48 hours means a two-hour delay still renders correctly, offline. Cost is
~10 KB instead of ~2 KB.

**The cache is keyed by a route hash.** If the stored hash does not match the current
route, the store reports no data rather than returning the previous route's clouds.
Without this, editing a route offline yields a confident, wrong picture — the worst
available failure mode.

**The profile never touches the network.** It reads cache or renders nothing. The
in-flight path is identical to the on-ground path, and no code can hang on a dead socket
at 7,500 ft.

## Interface contracts

### Sampling

`N = clamp(ceil(totalDistNm / 25), 2, 20)` points spaced evenly by route distance.
The 20-point ceiling is the size measured end-to-end, not an estimate.

### Level ladder

`[1000, 975, 950, 925, 900, 850, 800, 700, 600, 500]` hPa. 500 hPa is ~19,270 ft, above
any altitude the RV-9A will be flown at; higher levels are wasted bytes.

### Stored record — IDB `flytab_cloud_forecast`, key `data`

| Field | Type |
|---|---|
| `routeHash` | string — ordered lat/lon rounded to 2 dp |
| `fetchedAt` | ISO 8601 string |
| `points` | `[{lat, lon, distNm}]` |
| `times` | `[ISO 8601]`, hourly UTC, ~48 entries |
| `levels` | `[1000, 975, …, 500]` hPa |
| `coverPct` | `[pointIdx][timeIdx][levelIdx]` → `0–100 \| null` |
| `heightFt` | `[pointIdx][timeIdx][levelIdx]` → MSL ft `\| null` |
| `freezingFt` | `[pointIdx][timeIdx]` → MSL ft `\| null` |

The stored cube is `coverPct` (raw percentage), never `cover`. The bare name `cover`
is reserved for the octa *class string* on an emitted cell. Two different types must not
share one field name across this boundary.

`null` means *missing* and is skipped at every consumer. It is never coerced to 0 —
that distinction is the difference between "no cloud" and "no data".

### `getCells({routeHash, samplePoints, etaMs})`

Returns `null` if `routeHash` mismatches or no record exists. Otherwise:

```js
{
  staleness,      // 'fresh' | 'aging' | 'stale' | 'expired'  — fetch AGE only
  covered,        // boolean — do the cached `times` span every requested ETA?
  fetchedAt,      // ISO string
  ageLabel,       // e.g. "2h 14m ago"
  cells:         [{ distNm, spanNm, baseFt, topFt, coverPct, cover }],
  contours:      [{ distNm, spanNm, baseFt, topFt, cover }],
  freezingLevel: [{ distNm, altFt }],
}
```

`cover` on a cell is the octa class string (`FEW`/`SCT`/`BKN`/`OVC`); `coverPct` is the
raw model percentage.

**`staleness` and `covered` are independent and must not be conflated.** `staleness`
describes only how old the fetch is, and `'expired'` (> 6 h) is still drawn. `covered:
false` is the sole condition under which nothing is drawn, and it emits empty `cells`,
`contours`, and `freezingLevel` arrays rather than `null`, so the renderer needs no
special case.

### ETA resolution

`etaMs[i]` is linearly interpolated by distance between the bracketing waypoints'
`wp._eta` (UTC ms, set at `route-table.js:308`). If any `_eta` is null — no groundspeed
yet, or the route has not been computed — the entire render falls back to the current
UTC hour for every column and the panel is labelled *valid now (no ETA)* rather than
implying time-correctness it does not have.

### Slab geometry — native

Level *i* at a given point spans `midpoint(h[i-1], h[i])` → `midpoint(h[i], h[i+1])`,
using that point's own geopotential heights at that hour. The lowest and highest levels
extend by half their one-sided gap. `spanNm` runs to the midpoint of the neighbouring
sample points.

### Octa classification

`octa = round(coverPct / 12.5)`

| Octa | Class | Drawn |
|---|---|---|
| 0 | SKC | omitted |
| 1–2 | FEW | cell only |
| 3–4 | SCT | cell only |
| 5–7 | BKN | cell + contour |
| 8 | OVC | cell + contour |

Contours merge adjacent cells at octa ≥ 5 into rectangles with a label.

**Caveat to surface in the UI:** model cloud fraction is areal coverage over a ~3 km grid
cell, which is close to but not identical to an observer's octas. Labels must read as
model-derived, not as a METAR observation.

## Rendering

Two blocks in `route-profile.js` are replaced:

- **Line 330** — `cloudLayers` rectangles → `cloudCells` (density fill) + `cloudContours`
  (hard outline + label)
- **Line 309** — scalar `freezingLevelFt` → `freezingLevel` polyline. The freezing level
  moves materially over 300 nm; a single scalar would be the same invented precision
  rejected above.

### Colour tokens

New tokens in `web/style.css`. No inline hex, per the design token standard.

| Token | Value | Role | Contrast on white |
|---|---|---|---|
| `--cloud-fill` | `#5b6b7f` | cell fill, opacity ramp 0.12 → 0.45 | n/a (fill) |
| `--cloud-contour` | `#1f3348` | BKN/OVC outline + label | **12.9:1** |
| freezing level | `--color-danger-on-light` (existing) | solid line, distinct from the blue dashed cruise line | 7.35:1 |

The soft fill is texture; the contour carries legibility. Nothing safety-relevant depends
on reading the fill — this is the deliberate answer to the sunlight-readability
constraint, since a density gradient is inherently mid-tone.

**The existing fill `rgba(148,163,184,0.4)` at line 331 is removed.** It is a 40%-opacity
mid-grey on a light background — roughly 1.6:1 — and violates the project's contrast
standard.

## Staleness and failure handling

Fetch age and coverage are distinct. A 5-hour-old HRRR run forecasting a 19:00Z arrival
is a legitimate forecast, merely superseded. Missing coverage is the only case with
nothing to draw.

| Condition | Behaviour |
|---|---|
| < 1 h | draw; chip in `--text-muted` |
| 1–3 h | draw; chip in `--text-muted` |
| 3–6 h | draw; chip in `--color-caution-on-light` |
| > 6 h (`'expired'`) | **draw**; chip in `--color-danger-on-light` |
| `covered: false` | **do not draw**; "Cloud data doesn't cover your ETA" |

It refuses to draw only when it has nothing — never because data is merely old. Note
that `'expired'` still draws; the name refers to fetch age, not to usability.

**Fetch failure** (offline, timeout, non-200, malformed) leaves the existing cache
untouched and writes to DiagLog. No toast: the fetch fires on every route edit and a
toast would become noise. The age chip is the signal — a chip reading 4h while on home
wifi means the fetch is not working. A partial or malformed response is treated as a
failure and never partially written.

**The cloud block in `_render` is wrapped in try/catch.** The profile's primary job is
terrain clearance; a cloud-rendering bug must not be able to take that down. Same
reasoning as the tap-handler regression rule — the critical path survives when the
decoration breaks.

## Testing

`tests/shared/cloud-forecast.test.js` (vitest; `vitest.config.js` includes
`tests/**/*.test.js`). The real 20-point HRRR response captured during this
investigation is committed as `tests/fixtures/open-meteo-route.json` — tests run against
actual captured data, not hand-written fakes.

1. Slab geometry — midpoint rule and outermost-level extension
2. Octa boundaries at 6.24/6.25, 31.2/31.3, 56.2/56.3, 93.7/93.8
3. `null` cover skipped, never coerced to 0
4. ETA→hour selection, including out-of-window
5. Missing `_eta` → current-hour fallback
6. Route-hash mismatch → `getCells` returns `null`
7. Staleness boundaries, and that `'expired'` still emits cells
8. `covered: false` emits empty arrays, not `null`
9. Contour merging across adjacent BKN cells

**Not covered by tests — requires the tablet:** canvas rendering, and whether the contour
actually reads in direct sunlight. The tap-handler regression rule does not apply (no map
tap handlers are touched); this will be confirmed explicitly rather than assumed.

## Licensing

CC-BY 4.0 requires attribution: a credit line on the profile panel and one in About.

The free tier is **non-commercial only** (600 calls/min, 5,000/hour, 10,000/day). This is
fine for FlyTab sideloaded to a personal tablet. It blocks routing this through
flywhere.app as a product without a paid plan. If that becomes the goal, the fallback is
the HRRR GRIB path in `~/fly-pipeline` — public domain, and carrying true diagnosed cloud
base/top rather than inferred layers.

## Known adjacent issues — out of scope

`web/shared/hrrr-preflight.js:57` calls `${base}/weather?type=griddata&…`, which the
flywhere proxy forwards verbatim to `https://aviationweather.gov/api/data/griddata`.
That endpoint returns:

```
HTTP 404
{"status":"error","error":"Not found"}
```

The store is wired in live at `app.js:717`, so `ConvectiveIntelligenceEngine` has been
running against a cache that can never populate. This predates the present work and is
tracked separately.

## Ship checklist

- [ ] Bump `FLYTAB_VERSION` in `web/app.js` (currently `v10.18`)
- [ ] `npm test`
- [ ] `bash build.sh`
- [ ] Update `docs/user-manual.md` **and** `web/user-manual.md` in the same commit — the
      profile gains visible content (cloud shading, BKN/OVC labels, freezing level, age
      chip)
- [ ] Add `--cloud-fill` / `--cloud-contour` to `web/style.css`
- [ ] Register `cloud-forecast.js` as a `<script>` tag in `web/index.html`, before the
      cockpit components that consume it

---

## Appendix — verification evidence

All commands run 2026-08-04. Reproducible.

**Open-Meteo CORS:**
```
$ curl -sD - -H "Origin: http://localhost" \
    "https://api.open-meteo.com/v1/forecast?latitude=39.4&longitude=-78&hourly=cloud_cover&forecast_days=1"
HTTP/1.1 200 OK
access-control-allow-origin: *
```

**Payload, 20-point route × 12 levels × 24 h:**
```
HTTP 200
raw bytes:   96753
gzipped:     9659
points: 20  hours: 24  fields/pt: 25
```

Regenerate the test fixture (`tests/fixtures/open-meteo-route.json`) with the ladder and
horizon this design actually uses — 10 levels, 48 h. Values change with the weather; the
*shape* is what the tests pin:
```bash
LEVELS="1000 975 950 925 900 850 800 700 600 500"
Q="freezing_level_height"
for L in $LEVELS; do Q="$Q,cloud_cover_${L}hPa,geopotential_height_${L}hPa"; done
curl -s "https://api.open-meteo.com/v1/forecast\
?latitude=39.40,39.05&longitude=-77.98,-84.67\
&hourly=${Q}&forecast_days=2&timezone=UTC&models=gfs_hrrr" \
  -o tests/fixtures/open-meteo-route.json
```

**Pressure-level clouds populate (max over 2 days):**
```
lat=25.79 lon=-80.31 | total=100 low=100 mid=100 high=100 850=70 700=30 500=56
lat=41.91 lon=-87.65 | total=100 low=100 mid=100 high=100 850=55 700=81 500=69
```

**`cloud_base` / `cloud_top` are dead across all models:**
```
model='default'              non-null base=0 top=0
model='best_match'           non-null base=0 top=0
model='gfs_seamless'         non-null base=0 top=0
model='icon_seamless'        non-null base=0 top=0
model='ecmwf_ifs025'         non-null base=0 top=0
model='gfs_graphcast025'     non-null base=0 top=0
```

**A real vertical profile (Chicago, first forecast hour):**
```
  700hPa   10354 ft MSL   0%
  850hPa    5013 ft MSL  34%   ← a real scattered layer
  900hPa    3408 ft MSL   0%
  1000hPa    400 ft MSL   0%
```

**AWC `griddata` is 404:**
```
$ curl "https://aviationweather.gov/api/data/griddata?bbox=38,-79,41,-76&fields=cape,cin&format=json"
HTTP 404
{"status":"error","error":"Not found"}
```

**HRRR GRIB carries true cloud fields** (fallback source):
```
$ curl .../hrrr.20260803/conus/hrrr.t20z.wrfprsf01.grib2.idx
LCDC:low cloud layer      MCDC:middle cloud layer     HCDC:high cloud layer
TCDC:entire atmosphere    HGT:cloud ceiling
HGT:cloud base            HGT:cloud top
```

**FIS-B has no cloud product** — `~/stratux/stratux-full/main/gen_gdl90.go:132`:
```
81: "Tops",   // Radar echo tops graphic, scheme 1: 16-level
82: "Tops",   // Radar echo tops graphic, scheme 2: 8-level
83: "Tops",   // Storm tops and velocity
```
No cloud, icing, or turbulence entry exists anywhere in `product_name_map`.
