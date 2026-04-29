# G-AIRMET Structured Display Design

**Date:** 2026-04-29
**Status:** Approved

## Problem

The current AIRMET display has three usability failures:

1. **Sidebar shows raw text** — the FAA AIRMET text format is dense and not scannable in flight. A pilot cannot quickly determine whether icing affects their cruise altitude.
2. **Map tap opens the wrong thing** — tapping any polygon opens the side panel, not a popup. Overlapping polygons (e.g. Zulu and Tango in the same area) cannot be inspected together.
3. **No altitude filter on the map** — all polygons are visible at once. A pilot at 9,500 ft needs to know which icing advisories cover *their* altitude, not all altitudes simultaneously.

## Solution Overview

Five coordinated changes:

1. **Drop traditional AIRMETs** — use G-AIRMETs exclusively for AIRMET display. SIGMETs continue using the existing `airsigmet` endpoint.
2. **Preserve structured G-AIRMET fields** — carry `base`, `top`, `severity`, `fzlbase`, `fzltop`, `due_to`, `product` on the advisory object so downstream rendering never parses text.
3. **Structured sidebar cards** — replace raw text with altitude band + severity rows.
4. **Consolidated tap popup** — collect all hit polygons at a tap point, show them in one popup sorted by base altitude.
5. **Altitude band toggles on the map** — LOW / MID / HIGH chips floating on the map that filter which polygons are visible.

---

## Section 1 — Data Layer (`weather-client.js`)

### 1a. Filter AIRMETs out of the `airsigmet` response

`fetchAndCacheAdvisories` currently calls both `airsigmet` and `gairmet` and merges them. Change it to retain only SIGMET and Convective SIGMET records from the `airsigmet` response — any item where `airSigmetType` is not `SIGMET` or `CONVECTIVE SIGMET` is discarded. G-AIRMETs become the sole source of AIRMET records.

`_parseAirsigmet` is unchanged — it continues to parse SIGMETs correctly.

### 1b. Preserve structured fields in `_parseGairmet`

Currently these fields are embedded into the synthesized `raw` string and then discarded. Add them as first-class fields on the returned object:

```js
{
  raw,           // synthesized one-liner (kept for legacy popup fallback)
  type: 'airmet',
  hazard,        // normalized token: 'ICING', 'TURB', 'IFR', 'MTN OBSCN', 'FRZLVL'
  product,       // 'ZULU', 'TANGO', 'SIERRA'
  points,
  received_at,
  expires_at,
  isSigmet: false,
  isGairmet: true,
  // NEW structured fields:
  base,          // MSL feet or null (e.g. 8000, 'SFC')
  top,           // MSL feet or null (e.g. 18000, 'FL240')
  severity,      // 'LGT', 'MDT', 'SEV' or null
  fzlbase,       // freezing level base MSL feet or null
  fzltop,        // freezing level top MSL feet or null
  due_to,        // cause string or ''
}
```

`base` and `top` from the AWC G-AIRMET API are already in the item — pass them through directly. No parsing required.

---

## Section 2 — Sidebar List (`wx-briefing.js`)

### Structured card layout

Replace `_renderAirmetSection`'s raw-text card with a structured two-row card per advisory (as prototyped):

```
┌─────────────────────────────────────────────────┐
│ [ZULU]  MIXED ICING                             │
│         8,000 – FL180                           │
│ MDT · FZL 8,000                    Until 21:00L │
└─────────────────────────────────────────────────┘
```

- **Badge** — ZULU / TANGO / SIERRA, color-coded (cyan / amber / pink)
- **Hazard** — `due_to` if present, else normalized hazard token
- **Altitude band** — `base`–`top` formatted as feet or FL. `SFC` displayed as `SFC`, FL levels as `FL180`. FRZLVL entries use `fzlbase`–`fzltop`.
- **Severity** — color-coded: LGT=green, MDT=amber, SEV=orange. Null omitted.
- **FZL note** — shown inline with severity for Zulu entries that carry `fzlbase`
- **Valid until** — `expires_at` formatted to local HH:MM

Sort order: by product (ZULU first, then TANGO, SIERRA), then by `base` altitude ascending within each product.

Cards are still filtered by `_filterAdvisoriesForRoute` — only on-route advisories appear.

---

## Section 3 — Consolidated Tap Popup (`fisb-weather.js`)

### 3a. Fix touch registration

Current code registers `touchstart` with `capture: false`. Per the Leaflet tap pattern documented in CLAUDE.md, it must be `capture: true` — otherwise Leaflet's `stopPropagation` in the bubble phase silently drops taps over airport/navaid markers. The `destroy()` `removeEventListener` call also uses `capture: false` and therefore leaks. Both must use `{ capture: true }`.

### 3b. Collect all hits — don't stop at first

`_handleAdvisoryTap` currently finds the first polygon containing the tap point and calls `openAdvisoryPanel()`. Change it to:

1. Iterate **all** visible AIRMET and SIGMET polygon entries
2. For each, run the SVG `isPointInFill` / `isPointInStroke` hit test
3. Collect every entry that hits — do not stop at first
4. If no hits: return immediately (tap falls through to map)
5. If hits found: open one consolidated popup (see 3c)

Remove the `openAdvisoryPanel()` call from the tap handler entirely — the popup replaces it for point-specific queries.

### 3c. Single programmatic `L.popup`

Do not use `bindPopup` on individual polygons. Instead, maintain one `L.popup` instance on the `FisbWeatherDisplay`:

```js
this._advisoryPopup = L.popup({ minWidth: 300, maxWidth: 380, className: 'advisory-tap-popup' });
```

On hit, convert the tap `clientX/clientY` to a Leaflet `LatLng` via `this._map.containerPointToLatLng(L.point(x - containerRect.left, y - containerRect.top))`, set the popup content, and open it at that latlng.

**Popup content** — each hit advisory gets one row sorted by base altitude ascending:

```
Advisories at point
─────────────────────────────────
[ZULU]  8,000 – FL180
        MDT MIXED ICING · FZL 8,000 · Until 21:00L
─────────────────────────────────
[TANGO] FL100 – FL200
        MDT TURB · Until 19:00L
─────────────────────────────────
[SIGMET] FL240 – FL450
        CONVECTIVE · Until 18:30L
```

**Remove all existing `bindPopup` calls** from `_addAirmet` and `_addSigmet` — they are replaced by this single consolidated popup.

---

## Section 4 — Altitude Band Toggles on the Map (`layer-panel.js`, `fisb-weather.js`)

### 4a. Three fixed bands

| Chip | Band | Covers |
|------|------|--------|
| LOW  | low  | SFC – 10,000 ft |
| MID  | mid  | 10,000 – FL180  |
| HIGH | high | FL180 – FL240   |

**Overlap semantics:** A polygon is visible whenever its altitude range overlaps *any* active band. A polygon with `base=SFC, top=FL240` overlaps all three bands, so it remains visible as long as at least one band is on. This is the correct aviation interpretation — a pilot who turns off HIGH should still see a SFC–FL240 icing area because it covers their altitude too.

**Band overlap test per polygon** (computed once in `_addAirmet`, stored as a `Set` on the entry):
```js
const baseFt  = (base === 'SFC' || base == null) ? 0 : Number(base);
const topFt   = top  != null ? (String(top).startsWith('FL') ? parseInt(top.slice(2)) * 100 : Number(top)) : 99999;
const bands   = new Set();
if (baseFt < 10000 && topFt > 0)     bands.add('low');
if (baseFt < 18000 && topFt > 10000) bands.add('mid');
if (baseFt < 24000 && topFt > 18000) bands.add('high');
```

A polygon is shown when `entry.bands` intersects `_activeBands` (i.e., `[...entry.bands].some(b => _activeBands.has(b))`).

### 4b. Rendering the toggle chips

The altitude band chips are a **floating map overlay**, not in the slide-in layer panel. They are always visible on the map as a small chip group, positioned to the right of any existing map controls (or below the existing type toggles in the same overlay area used by the layer panel controls).

Add a `div.airmet-band-chips` overlay to the map container in `FisbWeatherDisplay.init()`:

```html
<div class="airmet-band-chips">
  <button class="airmet-band-chip active" data-band="low">LOW<span>SFC–10K</span></button>
  <button class="airmet-band-chip active" data-band="mid">MID<span>10K–FL180</span></button>
  <button class="airmet-band-chip active" data-band="high">HIGH<span>FL180+</span></button>
</div>
```

Style in `style.css`: small pill buttons, positioned absolute top-right of the map container below the existing SIGMET/AIRMET badge. Toggle `active` class on tap. No layer panel involvement — wired directly in `FisbWeatherDisplay`.

### 4c. Band filtering in `FisbWeatherDisplay`

Add `_activeBands = new Set(['low','mid','high'])` to state.

`_addAirmet(airmet)` — compute band from `airmet.base`, store it on the `_airmetPolygons` entry.

`_applyBandFilter()` — called after any band toggle change. Re-evaluates each entry in `_airmetPolygons`: if `entry.bands` intersects `_activeBands` AND the type layer is currently on the map, add the polygon to its layer group; otherwise remove it from the layer group (but keep it in `_airmetPolygons` so it can be restored when a band is re-enabled).

### 4d. Persistence

Band toggle state saved to `localStorage` key `flytab_airmet_bands` (JSON array of active bands) alongside existing layer state. Loaded at layer panel init and applied before the first advisory render.

---

## Files Changed

| File | Change |
|------|--------|
| `web/shared/weather-client.js` | Filter AIRMETs from airsigmet response; add structured fields to `_parseGairmet` return |
| `web/cockpit/wx-briefing.js` | Structured card rendering in `_renderAirmetSection` |
| `web/cockpit/fisb-weather.js` | Fix `capture:true`, collect-all hit test, single `L.popup`, band state + filter methods |
| `web/style.css` | Styles for `.airmet-band-chips` floating overlay and `advisory-tap-popup` |

No new files. No changes to `web/index.html` or build scripts.
