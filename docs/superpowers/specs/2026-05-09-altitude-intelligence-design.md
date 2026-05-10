# Altitude Intelligence — Design Spec

**Date:** 2026-05-09  
**Features:** A — Altitude Optimizer · B — MEA on Airway Pills · C — Mixing Height from MOS  
**Build order:** A → C → B (C adds a column to A's table; B is independent)

---

## Overview

Three related features that give the pilot altitude decision support directly in the route planner:

| Feature | Where | Data source |
|---------|-------|-------------|
| A: Altitude Optimizer | Settings popup, Winds & Performance section | Existing `_lastWinds` + `recomputeLegs()` |
| B: MEA on Airway Pills | Route pill row in planner panel | NASR airways bundle (`mea_ft` / `mea_gnss_ft`) |
| C: Mixing Height | MIX column added to Feature A's table | MOS endpoint at flywhere.app/api/mos |

---

## Feature A — Altitude Optimizer (Least Time)

### Purpose

Show the pilot a comparison of total ETE, ground speed, and fuel burn at each FD-reporting altitude level so they can pick the altitude that minimizes flight time given current winds aloft.

### Placement

Inline in the **Winds & Performance** section of the settings popup, directly below the existing altitude `<select>` dropdown. Always visible when the popup is open — no extra tap required.

### Altitudes Compared

Fixed FD reporting levels: **3,000 · 6,000 · 9,000 · 12,000 · 18,000 ft**.  
18,000 ft is always grayed and shows `—` — above the O-360's practical ceiling (~14,000 ft).

### Table Columns

| ALT | ETE | GS | GAL |
|-----|-----|----|-----|
| 3,000 | 2:41 | 138 | 20.1 |
| **6,000** | **2:14 ★** | **162** | **19.4** |
| 9,000 | 2:28 | 150 | 20.8 |
| 12,000 | 2:35 | 145 | 21.2 |
| ~~18,000~~ | — | — | — |

- **★** marks the row with the smallest `totalEteHrs` (fastest altitude).
- **Highlighted row** (blue left bar) = currently selected `_cruiseAltFt`. Updates instantly when the dropdown changes.
- ETE format: `h:mm` (e.g., `2:14`). GS in knots. GAL to one decimal.

### Computation

Calls `this._planner.recomputeLegs(plan, null, { cruiseAltFt: altFt, winds: this._lastWinds, pctPower: this._pctPower })` for each of the 5 non-ceiling altitudes. (`_pctPower` is the power percentage field stored on the panel — verify exact field name against the `pctPower` dropdown's `change` handler.) Pure JS; all 5 calls complete in < 5 ms.

Values from each result: `summary.totalEteHrs`, `summary.totalFuelGal`, and overall GS computed as `Math.round(summary.totalDistNm / summary.totalEteHrs)` (weighted by distance, not a per-leg average).

**Method signature:**  
```javascript
_computeAltComparison()
// Returns: Array<{ altFt, eteHrs, gsKt, fuelGal, isOptimal, aboveCeiling }>
// Reads: this._lastPlan (A* result), this._lastWinds, this._cruiseAltFt, this._pctPower
// Returns [] if this._lastPlan is null (no route planned yet)
```

### Trigger

- On popup open (`_openSettingsPopup`): call `_computeAltComparison()` and render the table.
- On altitude dropdown change: re-highlight the selected row (no recompute needed — just update CSS).
- On winds loaded (`_applyWindsToLastPlan` completes): if popup is open, recompute and re-render.
- On `_onRecomputeTap` / `_onPlanRouteTap` completes: if popup is open, recompute and re-render.

### States

| Condition | Display |
|-----------|---------|
| No route (`_lastPlan` null) | Single placeholder: "Plan a route to see altitude comparison" |
| Route exists, winds loading | Table rendered with calm-air estimates; footnote: "calm-air estimates · wind data loading…" |
| Route + winds loaded | Full table with wind-corrected values |
| Route exists, winds unavailable | Table with calm-air estimates; footnote: "calm-air estimates · no wind data" |

### DOM Structure

```html
<div class="rpp-opt-table">
  <div class="rpp-opt-header">
    <span>ALT</span><span>ETE</span><span>GS</span><span>GAL</span>
  </div>
  <div class="rpp-opt-row [rpp-opt-selected] [rpp-opt-best] [rpp-opt-dim]" data-alt="6000">
    <span class="rpp-opt-alt">6,000</span>
    <span class="rpp-opt-ete">2:14 ★</span>
    <span class="rpp-opt-gs">162</span>
    <span class="rpp-opt-gal">19.4</span>
  </div>
  ...
  <div class="rpp-opt-note">calm-air estimates · no wind data</div>
</div>
```

CSS classes:
- `.rpp-opt-selected` — blue left border, bolder text (current altitude)
- `.rpp-opt-best` — ★ appended to ETE span
- `.rpp-opt-dim` — gray text (18,000 ft ceiling row)

---

## Feature B — MEA on Airway Pills

### Purpose

Show the Minimum Enroute Altitude (MEA) on each airway pill so the pilot can see at a glance whether their planned altitude meets MEA requirements. Warn when planned altitude is below MEA.

### Which Pills Show MEA

Only pills with `item.type === 'awy'` (Victor/Tango airway legs). DIRECT/GPS pills have no published MEA and show nothing.

### Data Lookup

**Source:** NASR airways bundle, already in IndexedDB.  
**Preference:** `mea_gnss_ft` when non-null; fallback to `mea_ft`.

**Async method `_fetchRouteMea()`:**

```
for each pill in this._route where type === 'awy':
  1. Find adjacent from-fix and to-fix pills (immediately before/after the airway pill)
  2. Call NasrDb.getAirway(pill.id)  → airway record
  3. Match from-fix: find airway.waypoints[] where wp.id === fromFix.id
  4. Match to-fix:   find airway.waypoints[] where wp.id === toFix.id
  5. Find segment: airway.segments[] where from_seq === fromWp.seq (regardless of to_seq direction)
  6. Set pill.mea_ft = mea_gnss_ft ?? mea_ft ?? null
```

Run `_fetchRouteMea()` after any route change (after `_renderPills()`), then call `_renderPills()` again once the async fetch completes. On failure (DB miss, no segment), set `pill.mea_ft = null` — no label shown.

**Direction handling:** airways run in both directions. Segments are stored with the lower-seq waypoint as `from_seq`. When flying an airway in reverse (higher seq → lower seq), `fromWp.seq` > `toWp.seq`. In that case match the segment where `to_seq === fromWp.seq` (i.e., the stored segment runs in the opposite physical direction). Logic: `seg.from_seq === fromWp.seq || seg.to_seq === fromWp.seq` — take the first match. MEA is the same regardless of direction.

### Display on Pill

```html
<div class="rpp-pill rpp-pill-awy [rpp-pill-mea-warn]">
  ⠿ V143
  <span class="rpp-type-badge">AWY</span>
  <span class="rpp-pill-mea">MEA 3,000 ✓</span>   <!-- green, alt above MEA -->
  <span class="rpp-pill-del">×</span>
</div>
```

Warning state (`rpp-pill-mea-warn`): orange border + label becomes `MEA 6,000 ▲`.

**Warning condition:** `this._cruiseAltFt < pill.mea_ft` (or `mea_gnss_ft` if that's what was used). Recheck and re-render pills whenever `_cruiseAltFt` changes.

### MEA label format

`MEA X,XXX ✓` (green) or `MEA X,XXX ▲` (orange). Use thousands-comma formatting: `(mea_ft / 1000).toFixed(0) + ',000'` is wrong — use `mea_ft.toLocaleString()`.

---

## Feature C — Mixing Height Column

### Purpose

Fetch MOS mixing height for airports along the route and add a `MIX HT` column to the altitude optimizer table. Rows above the mixing height show "✓ above" (green); rows at or below show "⚠ in BL" (orange).

### MOS Fetch

**Endpoint:** `${Settings.workerBase || 'https://www.flywhere.app/api'}/mos?ids=${ids}`  
**Station IDs:** Same as wx-briefing — ICAO codes of dep + intermediate airports + dest from `this._lastPlan.waypoints` (filter for `wp.icao` matching `/^[A-Z]{3,4}$/`).  
**Timeout:** 45 s (server can be slow; same as wx-briefing).  
**503 retry:** If response status is 503, wait 2 s and retry once. If still 503 or error, `_lastMos = null`.  
**Cache:** Store in `this._lastMos`. Re-fetch on popup open only if `_lastMos` is null or older than 60 min.

**Method signature:**
```javascript
async _fetchMos()
// Sets: this._lastMos = { fetched_at, stations: { ICAO: { periods: [...] } } }
// Calls _renderOptTable() when done
```

### Mix Height Derivation

```javascript
_getMixHt(departureTime)
// Returns: number|null (feet)
// 1. Collect all station IDs from this._lastMos.stations
// 2. For each station, find the period with valid_time nearest to departureTime
// 3. Extract period.mix_ht — wx-briefing displays this directly as feet (no *100 factor);
//    verify against live endpoint before implementation if uncertain
// 4. Average non-null values; return null if no data
```

### Column in Optimizer Table

Added as a 5th column, after GAL. Column header: `MIX HT`.

| Condition | Cell content | Color |
|-----------|-------------|-------|
| `altFt > mixHt` | `✓ above` | Green |
| `altFt <= mixHt` | `⚠ in BL` | Orange |
| `mixHt` null | `—` | Gray |
| Row is ceiling row | `—` | Gray |

Table footnote when MOS is loaded: `Mix ht ~X,XXX ft avg (ICAO1, ICAO2, …) · MOS cycle`.  
When MOS unavailable: `MOS unavailable` in note, all MIX HT cells show `—`.

### Trigger

- On popup open: if `_lastMos` is stale/null and route exists, call `_fetchMos()`.
- Column appears immediately with `—` placeholders; fills in when fetch completes.
- MOS fetch is independent of winds fetch (both can run in parallel).

---

## Files Changed

| File | Changes |
|------|---------|
| `web/cockpit/route-planner-panel.js` | All three features: `_computeAltComparison()`, `_renderOptTable()`, `_fetchRouteMea()`, `_fetchMos()`, `_getMixHt()`, `_buildSettingsPopup()` update, `_buildPill()` update, `_openSettingsPopup()` update |
| `web/style.css` | New rules: `.rpp-opt-*` (optimizer table), `.rpp-pill-mea`, `.rpp-pill-mea-warn` |
| `web/app.js` | Version bump |

No new files. No changes to the planning library (`web/shared/planning/`).

---

## Edge Cases

- **Route has no airway legs (all DIRECT):** Feature B shows nothing. Feature A still works.
- **Route has one waypoint:** `recomputeLegs()` returns empty legs; optimizer shows placeholder.
- **Airway not found in DB:** `pill.mea_ft = null`; no label rendered.
- **Airway waypoint ID mismatch:** Some waypoints use navaid ID (e.g., `PSK`) while the pill may store the fix name. Match by `wp.id` first, then by `wp.name.toUpperCase()` as fallback.
- **MOS station has no `mix_ht`:** Period's `mix_ht` is null/undefined; skip in average.
- **All MOS stations missing `mix_ht`:** `_getMixHt()` returns null; column shows all `—`.
- **Popup closed mid-fetch:** MOS fetch completes but popup is closed; update `_lastMos` anyway (data is good for next open), skip render.
