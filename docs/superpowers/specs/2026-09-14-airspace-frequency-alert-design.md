# Airspace Frequency Alert — Design

Date: 2026-09-14
Status: Reviewed — ready for implementation planning (see Open risks for
pre-implementation spikes)

## Problem

When approaching controlled airspace (Class B/C/D, TRSA) or other airspace
worth a heads-up (Class E surface areas, SUA), the pilot currently has to
know or look up the controlling frequency manually. ForeFlight surfaces this
automatically with a popup as you approach a boundary. FlyTab has no
equivalent — the motivating case is landing at 1NC7 and needing the Wilmington
TRSA approach frequency before entry.

## Goals

- Auto-popup showing the controlling frequency (or an advisory, for
  non-mandatory-call airspace) as the aircraft approaches a relevant boundary,
  using predicted track/groundspeed the same way ForeFlight does.
- Per-airspace-type on/off configurability (Class B, Class C, Class D, TRSA,
  Class E surface, SUA) — not a single global switch.
- Works entirely offline in flight, consistent with the no-internet-in-air
  constraint — all data must already be in the NASR bundle before departure.
- Does not depend on what the map is currently showing (pan/zoom-independent).

## Non-goals

- Two-way frequency confirmation, auto-tune, or radio integration — FlyTab
  has no radio control hardware interface. This feature only *displays* the
  frequency.
- Historical/enroute Center frequencies, FSS, or non-airspace-triggered
  frequency lookup (e.g. "what's the CTAF at an airport I'm not near") — that
  already exists via the airport-tap popup.
- Automatic alert for airspace the aircraft is not physically approaching
  (e.g. no "search along route" preview in this feature; that could be a
  future extension of the existing route-planning Class B avoidance logic).

## Two deliverables, one data contract

This feature spans two repositories:

1. **`fly-pipeline`** (separate repo, not in this working directory) —
   attaches controlling-frequency data to airspace records and adds TRSA
   boundary ingestion.
2. **`flytab`** (this repo) — consumes that data at runtime to detect
   approach and show the popup.

The two are connected by a bundle schema addition (below), the same way the
Pi/FlyTab engine contract (`PI_API_CONTRACT`) connects `engine_monitor.py`
and `engine-client.js`. `flytab`-side work should degrade gracefully against
an older bundle that doesn't yet have the new field (no crash, feature just
shows nothing for that record) rather than assuming the field is always
present.

## Data model

### Pipeline side (`fly-pipeline`)

- `build_nasr.py`'s existing Class B/C/D/E airspace parsing gains a
  `controlling_freq` field per record:
  ```json
  { "type": "app", "freq": "125.5", "facility_name": "WILMINGTON APP" }
  ```
  **Correction from an earlier draft of this spec**: `flytab-pipeline`'s
  actual frequency `type` values are lowercase (`twr`, `app`, `gnd`,
  `clr_del`, `dep`, `atis`, `ctaf`, `unicom`), not the uppercase shown
  originally — confirmed by reading `build_nasr.py`'s `USE_MAP` directly.

  Populated by **geometric point-in-polygon matching**, not name-string
  matching as originally drafted — `flytab-pipeline` research found no
  existing name-matching precedent and no fuzzy-match library in that repo,
  while a geometric point-in-polygon join already exists there for a
  different feature (`mark_restricted_airway_segments`) and is directly
  reusable. The airport whose `(lat, lon)` falls inside the airspace
  boundary is the match; multiple candidates (e.g. a satellite towered field
  inside a Class B/C outer shelf) are tie-broken by name similarity, then by
  longest runway. Per-class frequency-type priority:
  - Class D → `twr` only.
  - Class B / Class C → `app`, falling back to `twr`.
  - Class E surface → `twr`, falling back to `app`, falling back to `ctaf`.
  - **TRSA does not go through this priority list.** Unlike Class B/C/D/E,
    a TRSA's frequency doesn't need geometric matching at all — `TWR.txt`
    already ties the `TRSA`-tagged frequency directly to a specific airport
    by `loc_id`, the same join `merge_frequencies()` already performs for
    every other tower frequency type. See the TRSA findings below.
  Where the automatic match is wrong or produces nothing, a **curated
  override file** (new to that repo — no such pattern existed before),
  keyed by `"<name>|<class>"` rather than airspace `id` (the `id` field
  embeds a shapefile enumeration index that isn't guaranteed stable across
  NASR cycles). Full algorithm and rationale now live in the
  `flytab-pipeline` implementation plan, since that's where this code
  actually lives.

- **TRSA spike resolved (2026-09-15), against the real September 2026 NASR
  cycle, not assumed.** Findings:
  - **Frequency**: real and already reachable. `TWR.txt` (already parsed by
    `parse_tower_frequencies()`) tags frequencies with a literal `TRSA` use
    code at 28 airports nationwide, including **ILM (Wilmington)** — this
    spec's own motivating example. Extending `USE_MAP` with `'TRSA': 'trsa'`
    is a one-line change to existing, working code.
  - **Boundary geometry**: genuinely absent, confirmed by checking the raw
    *unfiltered* `Class_Airspace` shapefile (only classes `B`/`C`/`D`/`E`
    exist in it) and the CSV product's `CLS_ARSP.csv` (columns are literally
    `CLASS_B/C/D/E_AIRSPACE`, no TRSA column). This isn't a gap in what the
    pipeline parses — TRSA participation is voluntary, not FAA-regulated
    controlled airspace, so the FAA doesn't publish a legal boundary for it
    the way it does Class B/C/D. It's chart-only.
  - **Radius, for most of them**: `TWR.txt`'s `TWR4` remark records (not
    previously parsed by this pipeline at all) carry free-text service
    remarks like `"TRSA CTC APCH CTL WITHIN 20 NM"` for ILM. 16 of the 28
    airports have an explicit radius in this text; 12 do not
    (AGS/AZO/BGM/DWU/FAI/GPT/GTF/HTS/MGM/MKG/RFD/TRI).
  - **Decision**: approximate TRSA laterally as a **circle** around the
    airport, radius from the parsed remark text where present — an honest
    approximation of the real (irregular, often sectored) shape, not a
    guess, since the radius itself is FAA-published data, not invented.
    Flag it as such on the record (`approximate: true`) so the UI can be
    transparent about it rather than presenting it as precisely as a real
    Class B/C/D boundary. For the 12 without a published radius: still
    attach the real frequency (useful on its own via the airport-tap
    popup), but no boundary — proximity alerting is simply not attempted
    for those until someone looks up the real chart radius (no invented
    default radius).
  - **Vertical extent**: no clean floor/ceiling either, except one remark
    (MLU: `"WITHIN 25 NM BLW 7000"`) that gives an explicit ceiling. Default
    `lower_ft: 0` (TRSA is a surface-based service everywhere it applies),
    no `upper_ft` unless a `BLW n` value was parsed — the existing fail-open
    vertical-bound-check design (below) already treats a missing upper
    bound as unbounded, which is the right behavior here rather than
    guessing a typical ceiling.

- Bundle versioning: this is an additive field/store, so existing
  `sua_count`-style staleness detection doesn't need to change shape, but the
  cycle_info / bundle metadata should be bumped so the tablet knows to
  re-import and pick up the new field on next NASR update.

### FlyTab side (`nasr-db.js`)

- `airspace` object store: add optional `controlling_freq` field, same shape
  as above. Absent field → treated as "no frequency data," not an error.
- New `trsa` object store, keyed by `id`, indexed for bounding-box query
  the same way `airspace`/`sua` are. Records: `{id, name, freq,
  facility_name, lower_ft: 0, upper_ft: number|null, boundary: [[lat,lon],
  ...]|[], radius_nm: number|null, approximate: true}`. `boundary` is empty
  for the ~12 airports (of 28) with no published radius — those still carry
  a real frequency (shown via the airport-tap popup) but get no proximity
  alert until a radius is added via override.
- IDB schema version bump required for the new store (`NasrDB` version
  constant), with a no-op migration for tablets that haven't re-imported yet.

## Runtime detection (`web/cockpit/airspace-alert.js`, new module)

- **Position source**: reads the same shared aircraft-position object other
  modules already use — **correction from an earlier draft**: verified as
  `window.app.stratuxClient.situation` (not `window.app._stratux.situation`,
  which was never the real property name), same pattern as
  `emergency-glide.js` — not a fresh `GpsSource` subscription, keeping one
  source of truth for position across the app.
- **Track/groundspeed field names** (needed to project position forward for
  predictive lead time) must be verified against `stratux-client.js`'s actual
  parsed fields before coding against them — do not assume `GPSTrueCourse`/
  `GPSGroundSpeed` naming from memory; confirm the real property names in the
  situation object this app already populates.
- **Independent of map viewport**: this module must run its own
  `NasrDB.getAirspaceInBounds()`/`getSuaInBounds()`/`getTrsaInBounds()`
  queries scoped around the aircraft's *own* position and projected path —
  it must NOT read from whatever `vector-map-layers.js` currently has loaded,
  since that reflects the map's pan/zoom state, not the aircraft's position.
  Panning the map away from the aircraft must not silence alerts.
- **Trigger logic**: on each position tick (matched to GPS update rate),
  project the aircraft position forward by the configured `lead_time_min`
  using current track/groundspeed, then test the **line segment from current
  position to the projected position** against each candidate airspace
  polygon in range (lateral test only — see vertical bound check below), not
  just the single projected endpoint. A narrow shelf can be crossed in well
  under the lead time at typical cruise speeds (e.g. a 4nm-radius Class D at
  120kt is fully traversed in ~4 minutes, less than half that to cross the
  diameter) — testing only the far endpoint risks the projected point
  jumping from "before the polygon" to "past the polygon" between two
  consecutive ticks without either endpoint ever having landed inside it,
  silently skipping the alert entirely for small airspace relative to
  groundspeed. Segment-vs-polygon intersection (or sampling several points
  along the segment) avoids this. "In range" means the `NasrDB`
  bounding-box query passed to `getAirspaceInBounds()` etc. must cover
  *both* the current position and the projected position, expanded by a
  fixed margin (e.g. +10nm) to catch polygons whose edge is closer to the
  flight path than either endpoint — a box drawn tightly around just the two
  points can clip a boundary that bulges between them.
- **Don't re-query `NasrDB` every tick.** GPS position ticks at ~1Hz; running
  three IndexedDB bounding-box queries (`airspace`/`sua`/`trsa`) that often
  for the whole flight is unnecessary IDB load and battery drain on a tablet.
  Cache the candidate polygon set and only re-run the `NasrDB` query when
  **either** the aircraft's current position **or its projected position**
  moves outside the bounding box used for the *previous* query (checking
  current position alone is not enough — a sharp turn can move the projected
  point outside the cached box's coverage well before the current position
  does, since the box was sized around the old heading's projected point,
  and a new heading could point toward airspace the stale cache never
  fetched). The point-in-polygon and altitude checks still run every tick
  against the cached candidates; only the IDB fetch itself is throttled.
- **Vertical (altitude) bound check**: lateral containment alone is not
  sufficient to decide "inside" — an aircraft flying beneath a Bravo/Charlie
  shelf, or above a Class D ceiling, is laterally inside the polygon but not
  actually in that airspace. After a candidate polygon passes the lateral
  test, compare the aircraft's current altitude (MSL, read from the same
  Stratux situation object used for position — reuse rather than a second
  source) against that record's `lower_ft`/`upper_ft`. Only transition to
  `inside`/fire `alerted` if altitude falls within `[lower_ft, upper_ft]`.
  `lower_ft` of `0` or a `"SFC"`-style surface marker means the floor is
  always satisfied at or above ground.
  - **Needs verification before coding**: whether `lower_ft`/`upper_ft` (or
    `lower`/`upper` — `nasr-db.js` uses inconsistent naming between the two,
    per the earlier codebase exploration; pick one canonical name during
    pipeline work) are stored as MSL or AGL. FAA charts publish Class B/C/D
    shelf altitudes in MSL, but this repo's own parsing hasn't been
    confirmed field-by-field — do not assume from chart convention alone.
  - **Fail-open on missing/malformed bound data**: if a candidate record's
    altitude fields are absent or unparseable, do not use the vertical check
    to suppress an otherwise-valid lateral match — treat the record as
    vertically unbounded (still eligible to alert) rather than silently
    skipping it. An extra popup is a minor nuisance; silently missing a
    controlled-airspace call because of a parsing gap is not an acceptable
    trade for this feature.
- **Point-in-polygon / segment-intersection**: consolidate the four existing
  near-duplicate ray-casting implementations (`avoidance.js:25`,
  `route-table.js:11`, `fisb-weather.js:420`, `wx-briefing.js:1887`) into one
  shared utility (e.g. `web/shared/geo-utils.js`), extended with a
  segment-vs-polygon intersection test (per the trigger logic above) as the
  fifth consumer. This is in-scope cleanup, not unrelated refactor — this
  feature is the first caller that needs more than a single static
  point-in-polygon test, so it's a natural point to de-duplicate the four
  existing copies it would otherwise become a fifth (near-)copy of.
- **State machine per airspace ID**: `not-alerted → alerted (popup shown) →
  inside → exited → (back to not-alerted, re-armed)`.
  - `not-alerted → alerted`: the projected path segment (above) intersects
    the polygon, passing the vertical check.
  - `alerted → inside`: the aircraft's **actual current position** (not the
    projected one) is confirmed laterally and vertically inside the polygon.
  - `alerted → not-alerted` (**previously missing**): the projected path
    segment no longer intersects the polygon — i.e. the pilot altered course
    away from the boundary after the popup fired and never actually entered.
    Without this transition, a predicted-but-aborted approach leaves the
    airspace stuck in `alerted` forever, since the only other path out of
    `alerted` was `inside`; a later genuine approach to the same airspace
    would then silently fail to re-fire because the state machine never
    reaches `not-alerted` again. This must be treated as effectively an
    alert-only transition, not a mirror of `inside`.
  - `inside → exited → not-alerted`: actual current position leaves the
    polygon (laterally or vertically); `exited` immediately re-arms to
    `not-alerted` for a later separate approach (satisfies "once per entry"
    — no re-fire while still approaching/inside the same shelf).
  - **Evaluation order per tick**: check `alerted → inside` before
    `alerted → not-alerted`. Since both conditions could theoretically be
    true in the same tick (e.g. actual position just entered while the
    forward-projected segment happens to exit the far side of a narrow
    shelf), entry must take priority — otherwise a genuine entry could be
    misclassified as an abort in the same tick it happens.
- **Module init while already inside an airspace** (e.g. app restart
  mid-flight, or GPS fix acquired after departure): seed that airspace's
  state directly to `inside`, not `not-alerted`, so restart doesn't trigger
  a popup for airspace the pilot is already established in and presumably
  already talking to. Only fire when a `not-alerted → alerted` transition is
  observed, never on first classification.
- **No separate ground/departure-airport suppression.** Resolved: this is
  not needed as a distinct mechanism. In the normal case the app is already
  running (GPS position already acquired) before taxi, so the departure
  airport's own shelf is already `inside` at init per the rule above, and
  climb-out never produces a `not-alerted → alerted` transition — it only
  produces `inside → exited`, which doesn't alert. Adding airport-identity
  detection ("which airport am I at") to suppress a case the init rule
  already covers would be unjustified complexity. The one case this doesn't
  cover — the app started fresh *after* becoming airborne, so the departure
  shelf's first classification happens mid-climb — is treated as correct
  behavior, not a gap: the pilot is genuinely mid-approach to that shelf
  from the app's point of view and should be alerted.
- **Multiple simultaneous candidates** (e.g. a Class D satellite field inside
  a Class C shelf): each airspace fires its own alert independently (the
  pilot may genuinely need to call both facilities), but popups queue rather
  than stack on screen simultaneously.

## UI — alert popup

- Non-blocking toast/modal; must not cover the map (consistent with existing
  cockpit UX expectation that the map stays visible during interaction).
- Content:
  - Class B/C/D/TRSA: facility name + frequency, styled as an actionable
    "call" popup. For TRSA specifically, also show that the lateral boundary
    is an approximation (`record.approximate`), e.g. "Approximate boundary —
    verify on sectional chart" — the real shape is often irregular/sectored,
    while this feature only has a circle derived from the published radius.
  - Class E surface: frequency if `controlling_freq` is present, otherwise
    advisory text — no "call now" framing since it isn't mandatory-contact
    airspace.
  - SUA: always advisory text (active-times summary), never a frequency —
    **correction from an earlier draft**: SUA active-times data does not
    "already exist" in the bundle as this spec originally assumed; it
    required new parsing work in `flytab-pipeline` (now included in that
    repo's implementation plan). Restricted areas/MOAs also don't have a
    published ATC voice frequency the way towered airports do, so
    `controlling_freq` matching is never attempted for SUA at all, only for
    Class E surface.
- Design tokens throughout, per this repo's standards: frequency in
  `var(--font-instrument)` / weight 900, facility/section label at weight
  800, dismiss button sized `var(--touch-min, 56px)` or larger, no hardcoded
  hex colors.

## Configuration

New `cockpit-config.json` section:

```json
"airspace_alerts": {
  "enabled": true,
  "lead_time_min": 2,
  "types": {
    "class_b": true,
    "class_c": true,
    "class_d": true,
    "trsa": true,
    "class_e_surface": false,
    "sua": false
  }
}
```

All six type toggles are independently switchable, plus a global `enabled`
kill switch and a configurable `lead_time_min`. Exact surface for editing
this in-app (settings panel vs. layer panel) needs a short look at how
existing pilot-facing toggles are exposed before implementation — this spec
doesn't presume a specific existing panel handles it correctly without that
check. Persistence should follow the existing config-persistence pattern
(separate localStorage key from any `_fetchJson` cache, per prior project
convention) rather than writing directly into the fetched config object.

## Error handling / edge cases

- No GPS fix: detection loop simply doesn't fire (no crash, no false
  popups).
- Bundle missing `controlling_freq` (stale/pre-update bundle): airspace still
  triggers proximity detection if type-enabled, but popup shows advisory-only
  content ("no frequency data — update NASR bundle") rather than a blank or
  broken frequency field.
- Overlapping/nested airspace of different classes: each fires independently
  per the state machine above; UI queues rather than overlaps.
- This feature only reads already-imported IndexedDB data — no live network
  call in flight, consistent with the no-internet-in-air constraint.

## Testing / verification

- No automated test coverage applies — this code lives outside
  `web/shared/planning/`, which is the only directory with vitest coverage
  in this repo. Verification is manual.
- Manual verification plan: use `tools/mock-stratux.py` to simulate a flight
  track toward a known Class C or TRSA boundary and confirm:
  - Popup fires at the configured lead time, not late/never.
  - Dismissing suppresses re-fire while still inside/approaching.
  - Re-arms correctly after a full exit and later re-approach.
  - Per-type toggles actually suppress/enable their respective alert types.
  - Flying laterally inside a shelf but below its floor does NOT alert;
    climbing through the floor while still laterally inside DOES alert —
    exercises the vertical bound check specifically, not just the lateral
    case the other scenarios above cover.
  - Approach a boundary until the popup fires, then turn away before
    actually entering — confirm the airspace re-arms (`alerted → not-alerted`)
    and a later genuine approach to the same airspace still alerts, rather
    than staying silently stuck.
  - Fly a narrow shelf (e.g. Class D) at a groundspeed fast enough that the
    lead-time distance exceeds the shelf's diameter — confirm the alert
    still fires, exercising the segment-intersection test rather than a
    single-endpoint check that could jump clean over it.
  - The existing airport-tap popup (`onAirportClick`) still opens normally
    afterward — required by this repo's tap-handler regression rule, since
    this feature adds a new map-adjacent popup path that could plausibly
    interact with existing tap handling if implemented carelessly.

## Open risks / unresolved before implementation

Resolved during plan-writing (kept here for history, not because they're
still open): TRSA data source (frequency + radius-where-published, see TRSA
findings above); Stratux situation field names (`true_course`,
`ground_speed`, `alt_msl`, `alt_baro` — verified in `stratux-client.js`);
altitude source for the vertical check (`alt_msl` primary, per Stratux's
own `CalcAltitude()` source showing `alt_baro` is fixed-29.92 pressure
altitude, not local-altimeter-corrected); settings UI surface (layer panel,
following the existing `conv-intel` toggle pattern); `lower_ft`/`upper_ft`
field-naming inconsistency (canonical name is `lower_ft`/`upper_ft` — the
`lower`/`upper` fallback seen in some JS call sites is defensive, not
evidence of a second real spelling); name-match accuracy for
`controlling_freq` (superseded — matching is geometric, not name-based, per
the correction above).

Still genuinely open:

1. **`lower_ft`/`upper_ft` units (MSL vs AGL) for Class B/C/D/E are
   unverified.** `parse_class_airspace()` reads the shapefile's
   `LOWER_VAL`/`UPPER_VAL` with no unit normalization or comment, unlike
   `_parse_altitude()` (used for SUA), which does. Must confirm against the
   FAA Class Airspace shapefile spec or real bundle data before the vertical
   bound check can be trusted for these classes.
2. **Geometric matching tie-break accuracy** for `controlling_freq` needs
   spot-checking against a handful of real multi-airport Class B shelves
   before trusting the name-then-runway tie-break is right often enough.
3. **12 of 28 TRSA airports have no published radius** in the NASR remark
   text (AGS/AZO/BGM/DWU/FAI/GPT/GTF/HTS/MGM/MKG/RFD/TRI) — they get real
   frequency data but no proximity alert until someone looks up the actual
   chart radius and adds it via override.
