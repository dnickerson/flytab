# Offline Maps section → Aeronautical Database framework

**Date:** 2026-07-11
**Status:** Approved, ready for implementation plan

## Problem

The Data & Maps page's "Offline Maps" section (Sectional Charts, IFR Low Enroute, IFR Area Charts,
Terminal Area Charts) already renders through the same `_section()` card component as
"Aeronautical Database" and "Approach Plates & A/FD", but shows different *content*:

- Server/Tablet lines show only file size (`~1,800 MB available` / `342 MB on tablet`) — no cycle
  date or expiration date, even though this data is already fetched and used internally.
- The badge is a static `ON DEVICE` (green) once a layer is downloaded, regardless of how close
  to FAA cycle expiration it is — unlike Aeronautical Database and Plates, which show
  `CURRENT (Nd left)` / `EXPIRING (≤3d)` / `EXPIRED` via `_cycleStatus()`.
- `.ds-row-value` (the actual data pilots read across the whole page — cycle dates, sizes, state
  chips) has no explicit `font-weight`, defaulting to 400. This violates this repo's own
  CLAUDE.md Design Token Standards ("never use font-weight: 600 or lower in cockpit UI") and the
  sunlight-readability requirement (weight ≥600 for data).
- "Sync All Outdated" only checks whether `sectional` and `ifr-low` mbtiles *exist* on the
  tablet — it ignores `ifr-area`/`tac` entirely and never checks expiration for any of the four.

## Root cause — confirmed, not assumed

`flytab-pipeline/build_mbtiles.py` (lines ~176–191) already writes, per layer, into
`manifest.json`'s `tiles` section:

```json
"tiles": {
  "sectional": {
    "cycle_date": "2026-07-09",
    "expiration_date": "2026-09-03",
    "built_at": "2026-07-10T14:22:01Z",
    "tile_count": 184223,
    "size_mb": 1780.4
  },
  "ifr-low": { ... }, "ifr-area": { ... }, "tac": { ... }
}
```

for all four layers defined in `build_mbtiles.py`'s `LAYERS` list. `data-status.js` already reads
`serverManifest.tiles[layer]` (`sTile`) and `deviceManifest.tiles[layer]` (`dTile`) to compute
`tileUpdateAvail` (lines ~335–345) — it just never surfaces `cycle_date`/`expiration_date` in the
rendered HTML. The device manifest already stores the full server tile object verbatim on
download (`data-status.js:1153,1427`), so `dTile.cycle_date`/`dTile.expiration_date` are available
post-sync with zero pipeline or download-handler changes required.

**Scope: this is a display-and-logic fix confined to `web/cockpit/data-status.js` and
`web/style.css`. No changes to `flytab-pipeline` or the home server.**

## Design

### 1. Per-layer card content

Replace the `.map()` block at `data-status.js:326–368` (the array of
`{layer, label, approxMb}` → `this._section(...)` calls) with a version that mirrors the
Aeronautical Database card's field order: cycle/expiration on the primary line, size as a
`ds-muted` subline.

**Interface contract — inputs consumed per layer, all already present:**
- `entry` = `mbt.find(l => l.layer === layer)` — from `GET {LOCAL_BASE}/mbtiles/status`, shape
  `{layer, exists, size_mb, tile_count}` (physical file presence on the tablet's NanoHTTPD).
- `sTile` = `serverManifest?.tiles?.[layer]` — shape `{cycle_date, expiration_date, built_at,
  tile_count, size_mb}` or `null` if server unreachable or layer never built.
- `dTile` = `deviceManifest?.tiles?.[layer]` — same shape once synced via this page, OR `{}` for
  tablets migrated from the pre-manifest per-layer probe (`_readOrMigrateDeviceManifest`,
  line 166) — no `cycle_date` present in that case.

**Server line:**
```
if (!base):        '<span class="ds-muted">Server not reachable</span>'
elif sTile?.cycle_date:
    expStr = sTile.expiration_date ? ` → exp ${sTile.expiration_date}` : ''
    sizeMb = sTile.size_mb ?? approxMb   // prefer real manifest size over the hardcoded estimate
    → `Cycle ${sTile.cycle_date}${expStr}<br><span class="ds-muted">~${sizeMb} MB</span>`
else:               '<span class="ds-muted">Unavailable</span>'
```

**Tablet line:**
```
if entry?.exists:
    cycleStr = dTile?.cycle_date ? `Cycle ${dTile.cycle_date}` : 'On tablet'
    builtStr = dTile?.built_at ? ` (built ${dTile.built_at.slice(0,10)})` : ''
    → `${cycleStr}${builtStr}<br><span class="ds-muted">${entry.size_mb} MB on tablet</span>`
else:
    → '<span class="ds-muted">Not downloaded</span>'
```
The `dTile?.cycle_date` fallback to `'On tablet'` (no cycle claim) covers the migrated-device
case honestly — it does not fabricate a cycle date it doesn't have. This does not affect update
detection: `tileUpdateAvail`'s primary branch only needs `sTile.expiration_date`, which is always
present once a layer has been built by the current pipeline.

**Badge + action button** (mirrors Aeronautical Database's `aeroBadge`/`aeroPrimary` structure at
`data-status.js:244–258`, one deliberate simplification noted below):
```
if !entry?.exists:
    badge = NOT DOWNLOADED (gray)
    action = base ? `DOWNLOAD (~${sizeMb} MB)` : ''      // unchanged from today
elif tileUpdateAvail:                                     // existing logic, untouched
    badge = UPDATE AVAILABLE (yellow)
    action = base ? `RE-DOWNLOAD` (ds-update / highlighted style) : ''
else:
    expDate = sTile?.expiration_date ?? dTile?.expiration_date
    badge = expDate ? this._cycleStatus(expDate, now) : ON DEVICE (green)
    action = base ? `SYNC` (ds-secondary style) : ''
```
Both `DOWNLOAD`/`RE-DOWNLOAD`/`SYNC` buttons keep the existing `ds-mbt-dl-btn` class and
`data-layer` attribute — **zero changes to `_wireDataSections`'s `.ds-mbt-dl-btn` handler
(line 663) or `_downloadMbtiles()` (line 1387)**, since neither branches on button label text,
only on `btn.dataset.layer`.

**Deliberate deviation from the Aeronautical Database pattern:** no separate secondary
"RE-DOWNLOAD" button next to "SYNC" in the update-available state. Aeronautical Database has
NASR+CIFP as two independently-versioned sub-resources where SYNC vs. RE-DOWNLOAD can mean
different things (incremental vs. force-clear-cycle-stamp). Tiles are a single monolithic
mbtiles file with no incremental sync — SYNC and RE-DOWNLOAD would trigger the identical
`_downloadMbtiles()` call, so a second button would be redundant, not consistent.

### 2. "Sync All Outdated" — existence + expiration for all 4 layers

Replace the ad hoc check at `data-status.js:374–375`
(`!mbt.find(l => l.layer === 'sectional')?.exists || !mbt.find(l => l.layer === 'ifr-low')?.exists`)
with a derivation from the SAME `tileUpdateAvail` computation already run per-layer in the
`.map()` above — captured into an array during that pass rather than recomputed, so the two
checks cannot drift out of sync with each other:

```js
const tileStates = [];   // populated inside the existing .map(), one entry per layer
// each entry: { layer, exists: !!entry?.exists, updateAvail: tileUpdateAvail }
...
const needsSync = !!base && (
    aeroUpdateAvail ||
    (serverHasPlates && (!cycleOkForStates || serverStates.some(s => !syncedStates.includes(s)))) ||
    tileStates.some(t => !t.exists || t.updateAvail)
);
```

### 3. Typography — page-wide token bump

All four sections (Aeronautical Database, Terrain, Plates, Offline Maps) share these CSS classes
in `web/style.css`, so one change applies consistently everywhere:

| Class | Current | New |
|---|---|---|
| `.ds-section-name` (card title) | 15px / weight 600 | 17px / weight 800 |
| `.ds-section-badge` | 13px / weight 600 | 15px / weight 700 |
| `.ds-badge` (inline badge text) | inherits / weight 600 | weight 700 (explicit) |
| `.ds-inv-label` (SERVER/TABLET) | 11px / weight 700 | 13px / weight 700 |
| `.ds-row-value` (main data — the CLAUDE.md violation) | 13px / weight **400 (unset)** | 15px / weight **700** |
| `.ds-muted` subline (size, notes) | 10–12px / weight 400 | 13px / weight 600 |
| `.ds-action-btn` (primary button) | 13px / weight 700 | 15px / weight 700 |
| `.ds-action-btn.ds-secondary` | 12px / weight 600 | 14px / weight 700 |
| `.ds-section-title` (ALL-CAPS section header) | 11px / weight 700 | 12px / weight 700 |
| `.ds-state-chip` | 12px / weight 600 | 13px / weight 700 |

The inline `style="font-size:10px"` on `platesIncludesNote` (`data-status.js:304`) is replaced
with the `.ds-muted` class's new 13px/600 default (no more one-off inline override).

## Out of scope

- No changes to `flytab-pipeline` (`build_mbtiles.py`, `config.py`) — cycle/expiration data is
  already correctly produced.
- No changes to `_downloadMbtiles()`, `_wireDataSections()`'s `.ds-mbt-dl-btn` wiring, or the
  `/mbtiles/status` and `/fetch-mbtiles` NanoHTTPD endpoints.
- No changes to the Aeronautical Database, Terrain, or Plates card *content* logic — only the
  shared CSS tokens they render with.

## Testing plan

Verify against the real home server already running on this dev machine
(`192.168.1.77:8090`, serving `~/flytab-pipeline/data`) instead of mocked data — real manifest,
no fakes needed. Via claude-in-chrome with real taps (not headless `.click()` — the prior radar
bugfix session found real clicks and headless clicks can diverge on CSS like
`pointer-events: none`):

1. All four layers in each reachable badge state: NOT DOWNLOADED (gray), UPDATE AVAILABLE
   (yellow), CURRENT (green, N days left), and — if reachable by adjusting a local copy of the
   manifest's `expiration_date` — EXPIRING (yellow, ≤3d) / EXPIRED (red).
2. Server/Tablet lines show cycle date + expiration + size for a layer with real manifest data,
   and the "On tablet" (no cycle) fallback for a simulated migrated-device state
   (`dTile = {}`).
3. Button labels/actions: DOWNLOAD when missing, SYNC when current, RE-DOWNLOAD when update
   available — confirm each still triggers `_downloadMbtiles()` correctly (existing handler,
   unchanged).
4. "Sync All Outdated" toggles on when any of the 4 layers is missing or expired, off when all
   are current — including a layer other than sectional/ifr-low (e.g. tac missing) that the old
   logic would have ignored.
5. Visual check of the typography bump across Aeronautical Database, Terrain, Plates, and
   Offline Maps sections together on one screen — confirm nothing overflows/wraps badly on the
   tablet's viewport width.
