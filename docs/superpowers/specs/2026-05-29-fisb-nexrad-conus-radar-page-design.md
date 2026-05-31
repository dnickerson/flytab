# FIS-B NEXRAD: Regional/CONUS split + CONUS radar page

**Date:** 2026-05-29
**Status:** Design — pending review
**Author:** Claude (with Dana)

## Problem

FIS-B NEXRAD started being received on the tablet for the first time (v9.26). On the
moving map, some radar squares paint correctly while others are "much too large,"
obscuring the good detail.

### Root cause (confirmed from Stratux `uatparse/nexrad.go`)

FIS-B broadcasts NEXRAD as two products, distinguished by `Product_id` and a `Scale`
factor that **scales the block's geographic size**:

| Product | `Radar_Type` | `Scale` → realScale | Block size | Bin grid |
|---|---|---|---|---|
| **Regional** (high-res) | 63 | 0 → ×1 | 0.8° × 0.067° | 32 (lon) × 4 (lat) = 128 bins |
| **CONUS** (low-res) | 64 | 1 → ×5, 2 → ×9 | up to 7.2° × 0.6° | same 128-bin grid → bins 5–9× larger |

The per-bin geometry math in `fisb-nexrad.js` is already correct. The defect is that
**the renderer draws both products identically** and **discards `Radar_Type`/`Scale`**
(`_handleNexrad`, fisb-nexrad.js:174–181 keeps only `latN, lonW, height, width,
intensity, received_at`). CONUS blocks are 5–9× larger and presence-only CONUS blocks
are filled with a uniform intensity `1` (solid light-green), so a single block paints a
~200+ nm solid rectangle over the crisp Regional data. That is the "too large" symptom.

## Goals

1. **Map shows Regional only**, correctly scaled at any navigation zoom — the giant
   CONUS squares never appear on the map.
2. **CONUS gets its own home**: a dedicated, zoomed-out radar page ("show me all of the
   Southeast") with the ownship icon for context.
3. **Looping in both modes** — animation is the only way to gauge storm movement, so it
   is required on the Regional map *and* the CONUS page, not optional.
4. **A product + age badge** on each view so the pilot always knows which product and how
   old it is (the ForeFlight habit).
5. **Persist the frame cache** (`radar.cacheHours`) so the loop survives an app restart and
   can be **exported** as a real fixture for ground testing — implementing config that was
   provisioned but never wired up.

## Non-goals

- **Do not touch the internet/ground radar path.** `_sampleInternetTiles`,
  `_sampleProduct`, `_rgbToNexradIntensity`, and the IEM tile sources stay exactly as-is.
  Internet NEXRAD on the ground is verified working and must not regress.
- **No base-tile snapshotting.** The live Leaflet map composites base chart tiles + radar
  overlay and provides pan/zoom natively; a static PNG base would break the pannable
  requirement and adds a CORS-taint hazard. (Rasterizing *radar frames* to images for
  loop performance is a deferred optimization, only if tablet redraw proves too heavy.)
- **No new tab-bar button.** Entry point is the MORE drawer.

## Design

### 1. Data model — tag every block with its product

`FisbNexrad._handleNexrad` keeps two more fields per stored block:

```
block = { latN, lonW, height, width, intensity, received_at,
          radarType,   // = msg.NEXRAD[i].Radar_Type  (63 Regional | 64 CONUS)
          scale }      // = msg.NEXRAD[i].Scale        (0 | 1 | 2)
```

Pure classifier (extractable for unit test):

```
FisbNexrad._productOf(block) → 'conus' | 'regional'
  return (block.radarType === 64 || block.scale > 0) ? 'conus' : 'regional'
```

Frame-history snapshots already clone the whole block set every 2.5 min (24-frame /
~60-min ring), so each frame now carries both products automatically — both loops read
the same history.

Per-product freshness for the badge:
```
this._newestAt = { regional: 0, conus: 0 }   // updated in _handleNexrad per block product
getDataAgeMs(product) → this._newestAt[product] ? Date.now() - this._newestAt[product] : null
```

### 2. Renderer: one data layer, product-aware render to a target

`FisbNexrad` remains the single data owner (block store + frame history). Rendering is
parameterized by a **target** and a **product filter** so the same blocks can paint to
the main map (Regional) or the CONUS page (CONUS) without duplicating data or event
listeners.

```
// target = { map, canvas, ctx }   product = 'regional' | 'conus'
FisbNexrad.draw(target, product)                  // live current blocks
FisbNexrad.drawFrame(target, product, frameIndex)  // a history frame (for the loop)
```

- Internal refactor: current `_draw()` / `drawFrame(i)` bodies move into
  `_drawToTarget(target, product, blockMap, zoom)`, which iterates `blockMap`, skips
  blocks where `_productOf(block) !== product`, runs the existing viewport-bounds cull,
  and calls the **unchanged** `_drawBlock(ctx, map, block, zoom)`.
- Main map keeps its existing canvas in `overlayPane`; `FisbNexrad` stores it as
  `this._mainTarget = { map, canvas, ctx }`. The existing `move/zoom/resize` handlers call
  `this.draw(this._mainTarget, 'regional')`.
- `addTo(map)` / `remove()` semantics for the main target are unchanged.

### 3. Main map — Regional only + loop + badge

- Renders **Regional only**. CONUS blocks are filtered out → no oversized squares, and the
  remaining Regional detail is correctly scaled at every nav zoom.
- The existing `RadarLoop` continues to drive the main map, now with `product='regional'`.
- Badge (small, light-theme): `FIS-B · Regional · <age>` using `getDataAgeMs('regional')`.
  Reuses the map's existing badge/overlay styling conventions.

### 4. `RadarPage` — dedicated CONUS view (new file `web/cockpit/radar-page.js`)

Full-screen page following the existing page pattern (`engine-page`, `approach-charts`).

- **Own Leaflet map** (`this._map`) on its own container — never touches the nav map, the
  route editor, or the three map tap handlers. (Honors the Tap Handler Regression Rule:
  the main-map handlers are not modified.)
- Base layer: the same chart tile source the main map uses (chart tiles exist to zoom 4).
- **Default view (option C):** on `show()`, center on ownship at a fixed Southeast-wide
  zoom (~zoom 5–6, tunable via `cockpit-config` `radar.conusDefaultZoom`). **Pannable and
  pinch-zoomable.** A **"Recenter on me"** button restores center=ownship, zoom=default.
- **Ownship icon** marker, updated from `GpsSource` while the page is visible (reuse the
  app's existing ownship icon asset/rotation if available; otherwise a simple aircraft
  divIcon).
- Renders **CONUS only**: a canvas overlay in its map's `overlayPane`; the page calls
  `fisbNexrad.draw(this._target, 'conus')` on map move/zoom and on new data.
- **Own loop control** (see §5), reading the shared CONUS frames.
- Badge: `FIS-B · CONUS · <age>` using `getDataAgeMs('conus')`.
- Empty state: if no CONUS frames, show "NO FIS-B CONUS RADAR" (mirrors `RadarLoop`'s
  existing no-data message).

**Lifecycle:**
- `_map` and canvas are **lazily created on first `show()`** and retained (creating/
  destroying a Leaflet map per open is wasteful).
- While visible: subscribe to `fisb:nexrad` redraws and a position tick for the ownship
  marker. On `hide()`: stop the loop, unsubscribe the position tick, leave `_map` intact
  for reuse.
- `isVisible()` returns whether the page is shown.

### 5. Loop — target-aware `RadarLoop`

Make `RadarLoop` construct against a `{ renderer, target, product }` so playback logic is
written once and reused:

- **Main-map loop:** existing instance, `target=mainTarget`, `product='regional'`.
- **CONUS-page loop:** new instance owned by `RadarPage`, `target=pageTarget`,
  `product='conus'`.

Both iterate `renderer.frameHistory` and call `renderer.drawFrame(target, product, i)`.
`enterLoopMode`/`exitLoopMode` suppression of live draws applies per target. The CONUS
loop is FIS-B-only (no internet fallback on this page).

### 6. MORE drawer entry

Add to the **In-flight** section of `tab-bar.js` `_buildMoreDrawer()` (after Approach
Charts), matching the existing item shape:

```
{ icon: '🌧', label: 'Radar', action: () => {
    c.radarPage?.show();
    this._hideRadarControls();
    this._closeMoreDrawer();
}}
```

`RadarPage` is instantiated in `app.js` and passed into `TabBar` components as
`c.radarPage`, wired with the shared `FisbNexrad` instance and `GpsSource`.

### 7. Frame persistence & export (`radar.cacheHours`)

Implement the provisioned-but-dead config so the frame ring survives an app restart and
can be replayed on the ground.

**Wire the existing config into `FisbNexrad`** (currently hardcodes a 24-frame / 2.5-min
ring and ignores all three knobs):
- `radar.frameIntervalMinutes` → snapshot cadence (replaces the hardcoded 150 000 ms).
- `radar.loopDurationHours` → `_maxFrames = loopDurationHours * 60 / frameIntervalMinutes`.
- `radar.cacheHours` → persistence retention window.

**Persistence (IndexedDB):**
- New object store `nexradFrames` in the app's existing IDB. One record per snapshot:
  `{ dataTime (keyPath), time, blocks: [{ latN, lonW, height, width, intensity[],
  radarType, scale }] }`.
- The data layer writes one record each time it takes a snapshot (the `frameIntervalMinutes`
  cadence), **not** per-draw. Writes are small (hundreds of blocks) — no NASR-style bulk-
  transaction hang risk (see CLAUDE.md IDB caveat, which applies only to huge single txns).
- **Purge** records older than `cacheHours` on write and on the existing 30 s purge timer.
- **Hydrate on startup:** `FisbNexrad` loads `nexradFrames` within `cacheHours` into
  `_frameHistory` (and seeds `_blocks` from the newest frame) so both the Regional map loop
  and the CONUS page loop resume immediately after the app reopens. This is what prevents a
  repeat of "today's frames are gone."

**Export (ground fixture):**
- `FisbNexrad.exportFrames()` serializes cached frames to **NDJSON** (one frame per line,
  blocks emitted in the **exact Stratux `NEXRAD[]` shape**: `Radar_Type, Scale, LatNorth,
  LonWest, Height, Width, Intensity`) so the file is a faithful capture, not a lossy re-shape.
- Written to the home-server flights path via the existing `FlightRecorder` fetch pattern
  (`LOCAL_BASE`), filename `nexrad-<ISO>.ndjson`, landing next to the engine CSV and pullable.
- **Trigger: manual only** — a small "Export radar frames" control (radar page or config
  editor). Never automatic.
- `mock-stratux.py` gains `--replay-nexrad <file.ndjson>`: re-emits those frames on `/jsonio`
  with original inter-frame timing (optionally time-scaled), replaying the full pipeline on
  the ground.

This closes the test loop: build against the synthetic emitter now → next FIS-B flight
**auto-caches real frames (persisted)** → export NDJSON → replay through `mock-stratux.py`
→ validate the synthetic geometry and the CONUS page against real data.

## Interface contracts (summary)

| Boundary | Contract |
|---|---|
| Stratux → `FisbNexrad` | `msg.NEXRAD[i]`: `Radar_Type` (int), `Scale` (int), `LatNorth`, `LonWest`, `Height`, `Width`, `Intensity[]` |
| stored block | adds `radarType` (number), `scale` (number); `_productOf(block)` → `'conus'\|'regional'` |
| `FisbNexrad.draw(target, product)` | `target={map,canvas,ctx}`, `product∈{'regional','conus'}` |
| `FisbNexrad.drawFrame(target, product, i)` | `i` indexes `frameHistory` |
| `FisbNexrad.getDataAgeMs(product)` | ms since newest block of that product, or null |
| `RadarPage(fisbNexrad, gpsSource)` | `.show()`, `.hide()`, `.isVisible()` |
| `RadarLoop({renderer, target, product})` | playback over `renderer.frameHistory` |
| TabBar components | `c.radarPage` present |
| IDB store `nexradFrames` | keyPath `dataTime`; value `{time, dataTime, blocks[]}` |
| `FisbNexrad` config reads | `radar.cacheHours`, `radar.loopDurationHours`, `radar.frameIntervalMinutes` |
| `FisbNexrad.exportFrames()` | writes `nexrad-<ISO>.ndjson` via `LOCAL_BASE`; returns path |
| `mock-stratux.py --replay-nexrad <file>` | re-emits NDJSON frames on `/jsonio` |

## Testing

- **Pure unit test** (extractable): `_productOf` classification — 63/scale0 → regional;
  64 → conus; scale 1/2 → conus. (Not in `web/shared/planning/`, so a small standalone
  assertion or manual verification; no vitest harness covers cockpit JS.)
- **Manual on tablet (required):**
  - Map: only Regional paints; no oversized squares; badge shows `Regional · <age>`.
  - Map loop animates Regional history.
  - MORE → Radar opens the CONUS page; ownship centered at SE-wide zoom; pan/zoom works;
    Recenter returns to ownship/default; CONUS blocks paint; badge shows `CONUS · <age>`;
    loop animates.
  - **Tap Handler Regression Rule:** after this work, confirm tapping an airport on the
    **main** map still opens its popup (the main-map handlers must be untouched).
  - Internet/ground radar on the ground still works unchanged.
- **Persistence:** record frames, force-stop and reopen the app, confirm both loops resume
  with the prior frames; confirm frames older than `cacheHours` are purged; confirm
  `frameIntervalMinutes`/`loopDurationHours` changes affect cadence and ring length.
- **Export + replay:** trigger Export, confirm `nexrad-<ISO>.ndjson` on the home server with
  the correct Stratux field shape; `mock-stratux.py --replay-nexrad` it and confirm the
  Regional map and CONUS page render identically to the live flight.

## Risks / open items

- **Second Leaflet instance on the tablet** — watch redraw cost; the radar-frame→PNG
  rasterization (deferred) is the mitigation if the CONUS loop is heavy.
- **Light theme only** — the radar page must not set `data-mode="cockpit"`.
- **Default CONUS zoom** (~5–6) is a starting value; tune on-device for a Southeast-wide
  framing.
- **Ownship asset reuse** — confirm whether the main map exposes a reusable ownship
  icon/rotation helper, else use a simple aircraft divIcon on the page.
- **IDB frame writes** — keep cadence low (per snapshot) and serialize `Intensity` compactly;
  small per-write payloads avoid the long-transaction hang documented in CLAUDE.md (which is
  specific to the 18 MB NASR import, not these writes).
- **Scope** — this feature now spans the Regional/CONUS render split, the CONUS page, the two
  loops, **and** frame persistence/export. Still one coherent feature; the implementation plan
  should phase it (render split + badge first, then CONUS page + loop, then persistence/export).
