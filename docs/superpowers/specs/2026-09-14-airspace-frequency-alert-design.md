# Airspace Frequency Alert — Design

Date: 2026-09-14
Status: Draft — pending user review

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
  { "type": "APP", "freq": "119.0", "facility_name": "WILMINGTON APP" }
  ```
  Populated by **name-matching** the airspace record's name field (e.g.
  `"WILMINGTON"`) against the airport dataset, then pulling that airport's
  approach/tower frequency from its existing `frequencies` array. Where the
  automatic match is wrong or ambiguous (e.g. multi-airport Class B with
  satellite fields sharing a name fragment), a **curated override file**
  (`airspace_freq_overrides.json` or similar, keyed by airspace ID) patches
  the specific case. This override file needs periodic review as AIRAC
  cycles update, same spirit as any other hand-maintained pipeline data.

- **TRSA is not currently parsed anywhere in either repo.** This is a gap,
  not a refinement — before implementation, a research spike must confirm
  where TRSA boundaries actually live in the FAA NASR 28-day
  subscription/shapefile product FlyTab already pulls from. Do not assume a
  file name or field from training memory; inspect the real subscription
  contents first, the same way the SUA AIXM parsing was verified against
  real XML before being trusted (see `reference_nasr_bundle_shape` /
  `project_sua_pipeline` prior work). If TRSA boundary data isn't present in
  the FAA products currently ingested, this spec's TRSA support is blocked
  until a source is found — Class B/C/D/E support can ship independently in
  the meantime.

- Bundle versioning: this is an additive field/store, so existing
  `sua_count`-style staleness detection doesn't need to change shape, but the
  cycle_info / bundle metadata should be bumped so the tablet knows to
  re-import and pick up the new field on next NASR update.

### FlyTab side (`nasr-db.js`)

- `airspace` object store: add optional `controlling_freq` field, same shape
  as above. Absent field → treated as "no frequency data," not an error.
- New `trsa` object store, same shape/indexing convention as `airspace`
  (keyed by `id`, indexed for bounding-box query) — added only once the
  pipeline-side TRSA spike above is resolved.
- IDB schema version bump required for the new store (`NasrDB` version
  constant), with a no-op migration for tablets that haven't re-imported yet.

## Runtime detection (`web/cockpit/airspace-alert.js`, new module)

- **Position source**: reads the same shared aircraft-position object other
  modules already use (`window.app._stratux.situation`-style pattern, as in
  `emergency-glide.js`), not a fresh `GpsSource` subscription — keeps one
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
  using current track/groundspeed, then point-in-polygon test that projected
  point against each candidate airspace polygon in range.
- **Point-in-polygon**: consolidate the four existing near-duplicate
  ray-casting implementations (`avoidance.js:25`, `route-table.js:11`,
  `fisb-weather.js:420`, `wx-briefing.js:1887`) into one shared utility
  (e.g. `web/shared/geo-utils.js`) and use it here as the fifth consumer.
  This is in-scope cleanup, not unrelated refactor — this feature is the
  first caller that needs point-in-polygon on a moving *projected* point
  rather than a static route/click point, so it's a natural point to
  de-duplicate the four existing copies it would otherwise become a fifth of.
- **State machine per airspace ID**: `not-alerted → alerted (popup shown) →
  inside → exited`, re-arming only after a full exit (satisfies "once per
  entry" — no re-fire while still approaching/inside the same shelf, but a
  later separate approach after fully leaving fires again).
- **Multiple simultaneous candidates** (e.g. a Class D satellite field inside
  a Class C shelf): each airspace fires its own alert independently (the
  pilot may genuinely need to call both facilities), but popups queue rather
  than stack on screen simultaneously.

## UI — alert popup

- Non-blocking toast/modal; must not cover the map (consistent with existing
  cockpit UX expectation that the map stays visible during interaction).
- Content:
  - Class B/C/D/TRSA: facility name + frequency, styled as an actionable
    "call" popup.
  - Class E surface / SUA: frequency if `controlling_freq` is present,
    otherwise advisory text (e.g. SUA active-times, already available in the
    existing `sua` store record) — no "call now" framing since these aren't
    mandatory-contact airspace.
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
  track toward a known Class C or TRSA boundary (once TRSA data exists) and
  confirm:
  - Popup fires at the configured lead time, not late/never.
  - Dismissing suppresses re-fire while still inside/approaching.
  - Re-arms correctly after a full exit and later re-approach.
  - Per-type toggles actually suppress/enable their respective alert types.
  - The existing airport-tap popup (`onAirportClick`) still opens normally
    afterward — required by this repo's tap-handler regression rule, since
    this feature adds a new map-adjacent popup path that could plausibly
    interact with existing tap handling if implemented carelessly.

## Open risks / unresolved before implementation

1. **TRSA data source is unverified.** Blocking for TRSA specifically; not
   blocking for Class B/C/D/E, which can ship first.
2. **Stratux situation object field names** for track/groundspeed need
   confirming against `stratux-client.js`, not assumed.
3. **Settings UI surface** for the new config toggles needs a quick check of
   existing patterns before deciding where they live.
4. **Name-match accuracy** for `controlling_freq` needs spot-checking against
   a handful of real Class B/C shelves (especially multi-airport Class B)
   before trusting the override-file approach is sufficiently rare.
