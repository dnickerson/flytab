# WxBriefing Redesign — Design Spec
**Date:** 2026-04-25  
**Status:** Approved for implementation planning

---

## Overview

Redesign `web/cockpit/wx-briefing.js` into a full preflight weather briefing panel that consolidates all internet-sourced weather data into one place. Used in landscape mode during preflight planning (internet connected). The existing portrait MOS grid is preserved; new data sources are added alongside it.

---

## Layout

### Landscape (planning mode — primary use)

Two-column layout inside a fixed-height panel:

**Left column (52%) — station data, scrollable:**
1. Summary bar (route + best-day badge) — sticky
2. MOS grid (7-day or 24H toggle)
3. Hourly drill-down (appears below grid when a cell is tapped)
4. "METARs & TAFs" section header — sticky
5. METAR/TAF cards, one per station, sorted by proximity to route

**Right column (48%) — area/corridor data, scrollable:**
1. AIRMETs
2. Mesoscale Discussions (MCDs)
3. Forecast Discussions (AFDs)
4. NOTAMs

**Header (full width, fixed):** route label · age indicators · 7-DAY/24H toggle · ↻ refresh

### Portrait (informational — not the primary planning use case)

Existing single-column layout is preserved. New sections (METARs/TAFs, AIRMETs, MCDs, AFDs, NOTAMs) are appended as collapsible sections below the MOS grid, same pattern as existing WxBriefing.

---

## MOS Grid (existing, enhanced)

### 7-DAY mode
- One column per day, worst flight category during prime flying hours (15Z–03Z)
- Tap any cell → hourly timeline replaces empty space below grid in left column
- Hourly timeline shows: time (local), flight category (color-coded), ceiling, visibility, wind, weather phenomena
- Marginal periods highlighted with amber outline row background
- Summary note at bottom: derived from hourly data — find contiguous marginal/IFR periods and describe them in plain language, e.g. "MVFR 6–11 AM only. Afternoon VFR."

### 24H mode
- One column per 3-hour MOS period, next 24 hours
- Each cell shows: category, ceiling/sky, vis, wind, ⛈% if ≥20%
- Marginal periods highlighted with amber outline
- Horizontally scrollable

---

## METARs & TAFs

### Data source
- METARs: `https://aviationweather.gov/api/data/metar?bbox={s},{w},{n},{e}&format=json` where the bbox is the route corridor bounding box expanded by ~0.15° (~10 nm) on each side. Returns all reporting stations in the corridor in one request.
- TAFs: `https://aviationweather.gov/api/data/taf?ids=...&format=json` for route airports only (TAFs exist only at towered/controlled fields — not worth fetching by bbox). AWC JSON response includes structured `fcsts` array with per-period conditions — no raw text parsing needed.
- Route airports are fetched by `ids=` for the TAF call; nearby stations come from the bbox METAR call.

### Station sorting
1. Route airports (departure, destination, intermediate waypoints) — labeled "ON ROUTE"
2. Airports within 10 nm of any route segment, sorted ascending by distance from nearest route segment

### Display (per station card, collapsible)
**Card header (always visible):**
- Airport ID · proximity badge (ON ROUTE / X.X nm) · observation time (local) · flight category badge

**Expanded:**
- Raw METAR string (monospace)
- Decoded fields grid: Wind, Visibility, Ceiling, Temp/Dew, Altimeter, Observed (local time)
- TAF section (if available):
  - "Issued HH:MM L · Valid [day time] → [day time] L"
  - One row per forecast group from AWC `fcsts` array: local time range · flight category badge (computed from ceiling/vis) · wind · ceiling · visibility

### Time decoding
All UTC timestamps decoded to device local time using `Date` object local methods. Format: `2:53 PM L` for observations, `Sat 3PM → Sun 6AM L` for TAF validity periods.

### Fetch trigger
- On `show()` if cache is cold (>15 min old or absent)
- On ↻ refresh (parallel with all other fetches)
- Cached in `localStorage` under `flytab_metar_cache` with 15-min TTL

---

## AIRMETs

### Data source
`WeatherClient.fetchAndCacheAdvisories()` — already implemented, fetches from `flywhere.app/api/weather?type=airsigmet`. AIRMETs are already parsed and cached in `flytab_advisories_cache`.

### Filtering
Route corridor: 50 nm buffer around all route segments. Filter to AIRMETs whose polygon intersects the corridor using the same point-in-polygon logic as MCDs.

### Display (per AIRMET card, collapsible)
**Header:** type (SIERRA / TANGO / ZULU) · hazard · valid until (local time)  
**Expanded:** full advisory text (monospace, max 180px scrollable)

---

## Mesoscale Discussions (MCDs)

### Data source
`https://api.weather.gov/products?type=MCD&office=KWNS&limit=20`  
Returns JSON array with `id`, `issuanceTime`, `productText` fields. CORS-permissive — no proxy needed.

### Polygon parsing
Each MCD `productText` contains a `LAT...LON` line with space-separated coordinate tokens. Parse all numeric tokens after `LAT...LON`:
- Tokens ≤ 5999 are latitudes: divide by 100 → decimal degrees N
- Tokens ≥ 6000 are longitudes: divide by 100 → decimal degrees W (negate)
- Pairs alternate lat/lon

### Route filtering
1. Build bounding box around route with 50 nm buffer
2. Pre-filter: discard MCDs whose polygon bounding box does not intersect route bounding box
3. For remaining: ray-casting point-in-polygon check — any route waypoint inside MCD polygon = match

### Display (per MCD card, collapsible)
**Header:** MD NNNN · hazard summary · valid until (local time)  
**Expanded:** full `productText` (monospace, max 200px scrollable), with issued/valid times decoded to local

### Caching
`localStorage` key `flytab_mcd_cache`, 15-min TTL. Fetch on `show()` if cold; refresh on ↻.

---

## Area Forecast Discussions (AFDs)

### Data source
`https://api.weather.gov/products?type=AFD&office=XXXX` — one request per NWS office covering the route.

### Office selection
Call `https://api.weather.gov/points/{lat},{lon}` for the departure and destination coordinates. Response includes `cwa` (office ID) and `forecastOffice` URL. Deduplicate office IDs — typically 1–3 offices per route. One `products?type=AFD&office=XXXX` call per unique office.

### Display (per AFD card, collapsible)
**Header:** office ID (e.g. KGSP) · office name · issued time (local)  
**Expanded:** full AFD text (monospace, max 200px scrollable)

### Caching
`localStorage` key `flytab_afd_cache`, 60-min TTL (AFDs update every 6–12 hours).

---

## NOTAMs

### Data source
FAA NMS-API v1 (CGI Federal):
- **Test:** `https://api-staging.cgifederal-aim.com/nmsapi/v1`
- **Production:** TBD (provided after test environment validation)
- Authentication: API key stored in `cockpit-config.json` under `notam_api_key`

### Query
Fetch NOTAMs for each route airport by ICAO identifier plus a 10 nm radius. Deduplicate by NOTAM number.

### Parsing & display (per NOTAM card, collapsible)
**Card (collapsed):**
- Airport · type badge (RWY / NAVAID / OBST / TWY / AD / SVC) — RWY/NAVAID shown in red as critical
- Summary line (decoded from NOTAM text: what is affected)
- Valid period (local time): `Mon Apr 27 6:00 AM L → Tue Apr 28 6:00 AM L`

**Expanded:** raw NOTAM string (monospace)

### Sorting
1. Critical types (RWY, NAVAID) first
2. Then by airport (route order)
3. Then by valid-from time ascending

### Caching
`localStorage` key `flytab_notam_cache`, 15-min TTL.

---

## Refresh Behavior

The ↻ button triggers all fetches in parallel:
```
Promise.allSettled([fetchMos(), fetchMetars(), fetchAirmets(), fetchMcds(), fetchAfds(), fetchNotams()])
```
Each section renders independently as its data resolves — no section blocks another. A per-section loading spinner is shown while its fetch is in flight.

Auto-fetch on `show()`: each data type checks its own cache TTL independently. Cold caches trigger a fetch; warm caches render immediately.

---

## Error Handling

Each section has an independent error state: "Fetch failed — tap ↻ to retry." Non-blocking — other sections continue to render normally.

No internet → all sections show cached data with age indicator, or "No data cached — requires internet."

---

## Configuration

New fields in `cockpit-config.json`:
```json
{
  "notam_api_key": "",
  "notam_api_base": "https://api-staging.cgifederal-aim.com/nmsapi/v1"
}
```

`notam_api_base` defaults to the test environment URL until production onboarding is complete.

---

## Implementation Scope

All changes are confined to `web/cockpit/wx-briefing.js` and `web/style.css`. No new files are created. `WeatherClient` is used for METARs/TAFs/AIRMETs (already implemented). MCD and AFD fetches are new methods added to `WxBriefing` directly (lightweight enough to not warrant a shared client). NOTAM fetching is a new method in `WxBriefing`.

The existing `PreflightBrief` (`preflight-brief.js`) is not modified — consolidation of its weather data into `WxBriefing` is a separate future effort.
