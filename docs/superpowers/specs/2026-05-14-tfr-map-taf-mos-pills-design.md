# TFR Map Layer + TAF/MOS Pills Design

**Date:** 2026-05-14

## Goal

Three related improvements to WX Briefing and the map layer:
1. Render active TFR polygons from NOTAM raw text on the map (not just FIS-B)
2. Show a TAF pill on each airport METAR row; tap to expand inline TAF summary
3. Show an MOS pill on each airport METAR row; tap to expand inline MOS summary

---

## Feature 1: TFR Map Layer — NOTAM-Sourced Polygons

### Architecture

`wx-briefing.js` already fetches en-route NOTAMs and classifies TFRs (`type=TFR`). After parsing, TFR NOTAMs get a geometry extraction pass before the results are stored. Parsed shapes are dispatched as a `notam:tfrs` DOM CustomEvent carrying `{ shapes: [...] }`. `map.js` listens, clears its NOTAM TFR layer group, and re-renders.

### Geometry Parsing (in `wx-briefing.js`)

New method `_parseTfrGeometry(raw)` returns `null` or a geometry object. Uses the same patterns already in `fisb-client.js`:

- **Polygon:** coordinate pairs matching `(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)` — collect all, return `{ type: 'polygon', coords: [[lat,lon], ...] }`
- **Circle (WITHIN):** `WITHIN (\d+(?:\.\d+)?) NM OF (\d{2})(\d{2})(\d{2})(N|S)\s+(\d{2,3})(\d{2})(\d{2})(W|E)` — return `{ type: 'circle', lat, lon, radiusNm }`
- **Circle (RADIUS):** `(\d+(?:\.\d+)?)-NM RADIUS OF (\d{2})(\d{2})(\d{2})(N|S)\s+(\d{2,3})(\d{2})(\d{2})(W|E)` — return `{ type: 'circle', lat, lon, radiusNm }`
- If no geometry matches, return `null` (NOTAM skipped from map — not dropped from list)

Coordinate conversion: DDMM → decimal degrees as `DD + MM/60`.

Shape object passed in event:
```javascript
{ type: 'circle'|'polygon', lat?, lon?, radiusNm?, coords?, validFrom, validTo, summary }
```

### map.js Changes

- Add `_notamTfrGroup` (a `L.LayerGroup`) created in `init()`, added to `_tfrLayer` so the existing TFR toggle controls it
- Listen for `document` event `notam:tfrs` in `init()`, remove in `destroy()`
- Handler: clear `_notamTfrGroup`, iterate shapes, call `_addNotamTfrShape(shape)` for each
- `_addNotamTfrShape(shape)`: same red dashed style as FIS-B TFRs — `L.polygon` for polygon type, `L.circle` with `radius: radiusNm * 1852` for circle type. No popup needed (WX Briefing already shows the NOTAM text).

### layer-panel.js Changes

- Toggle label: `"TFRs (FIS-B)"` → `"TFR"`
- Default: `tfrInput.checked = false` → `true` (toggle starts ON)
- No other changes — single toggle controls both FIS-B and NOTAM TFR shapes

### Data Flow

```
_fetchEnrouteNotams() in wx-briefing.js
  → parses NOTAMs, classifies type=TFR
  → for each TFR: _parseTfrGeometry(raw) → shape or null
  → dispatch CustomEvent('notam:tfrs', { detail: { shapes } }) on document
  → shapes stored alongside this._enrouteNotams (for list rendering, unchanged)

map.js listens 'notam:tfrs'
  → clears _notamTfrGroup
  → _addNotamTfrShape(shape) for each
```

---

## Feature 2: TAF Pill on Airport Rows

### Architecture

In `_renderWxSection()` (or wherever airport METAR cards are built), the card header `.wx-card-hdr` is augmented with a TAF pill when `this._tafData?.[icao]` exists.

Tapping the TAF pill expands an inline TAF summary immediately below the METAR row content. The pill toggles open/closed. State is tracked in a `_tafPillOpen` Set (keyed by ICAO) on the component instance, initialized in the constructor. The Set persists across re-renders so the user's expanded state survives data refreshes. It is cleared only when the WX briefing panel is closed (`_reset()` or equivalent teardown).

### TAF Inline Summary

Compact card (no section switch required) showing:
- **Header:** `TAF` label + validity window (e.g. `Valid 1200Z–1800Z`)
- **Forecast periods:** each `fcst` in `_tafData[icao].fcsts[]`, one row per period:
  - Time range, sky condition (ceiling/OVC/SCT), wind (`270/10`), significant weather if present
- Max 4–5 periods displayed; if more exist, show all (TAF is rarely more than 8 periods)
- Rendered as a `<div class="wx-taf-inline">` appended after the METAR card body

### Pill rendering

```html
<span class="wx-pill wx-pill-taf">TAF</span>
```

Pill is greyed if `_tafData[icao]` is absent — actually, just omit it entirely when absent (no grey placeholder).

---

## Feature 3: MOS Pill on Airport Rows

### Architecture

Same structure as TAF pill. Pill appears when `this._mosData?.[icao]` exists.

State tracked in `_mosPillOpen` Set (same lifecycle as `_tafPillOpen`).

### MOS Inline Summary

Compact card showing current + next 3 forecast periods from `_mosData[icao]`:
- **Header:** `MOS` label + model run time
- **Periods:** each period shows hour, sky, weather, temp (°F), wind
- Rendered as `<div class="wx-mos-inline">`

MOS data shape (from existing `_mosData`): periods keyed by hour with fields `sky`, `wx`, `tmp`, `wdr`, `wsp`.

### Both Pills Open

TAF and MOS pills are independent — both can be expanded simultaneously for an airport. Layout: METAR row → TAF inline (if open) → MOS inline (if open).

---

## CSS

New shared pill base class + type variants:

```css
.wx-pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    line-height: 16px;
    cursor: pointer;
    user-select: none;
}
.wx-pill-taf { background: #1a6bbf; color: #fff; }
.wx-pill-mos { background: #0f8a6e; color: #fff; }

.wx-taf-inline, .wx-mos-inline {
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    font-size: 12px;
}
```

---

## Files Modified

| File | Change |
|------|--------|
| `web/cockpit/wx-briefing.js` | Add `_parseTfrGeometry()`, dispatch `notam:tfrs` event in `_fetchEnrouteNotams`, add `_tafPillOpen`/`_mosPillOpen` Sets, render pills + inline cards in airport METAR section |
| `web/cockpit/map.js` | Add `_notamTfrGroup`, listen for `notam:tfrs`, add `_addNotamTfrShape()` |
| `web/cockpit/layer-panel.js` | Rename TFR label, default toggle ON |
| `web/style.css` | Add `.wx-pill`, `.wx-pill-taf`, `.wx-pill-mos`, `.wx-taf-inline`, `.wx-mos-inline` |
| `web/app.js` | Version bump |

---

## What This Does Not Change

- The existing FIS-B TFR rendering path (`fisb:notam` events) is untouched
- The existing TAF card in the TAF section is untouched — pills are additive
- The existing MOS grid section is untouched — pills are additive
- NOTAM list rendering in WX Briefing is untouched
