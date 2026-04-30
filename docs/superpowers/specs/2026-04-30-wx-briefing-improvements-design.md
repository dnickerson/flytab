# WX Briefing Improvements — Design Spec

**Date:** 2026-04-30
**Status:** Approved for implementation planning

---

## Overview

Five targeted improvements to `web/cockpit/wx-briefing.js`:

1. Fix METAR/TAF station sort order (departure → destination)
2. Add route corridor width selector (10 / 25 / 50 mi) above METAR list
3. Fix Forecast Discussions to cover all route waypoints, not just dep/dest
4. Surface NOTAM proxy auth errors instead of silently showing "None"
5. Add derived state abbreviations to G-AIRMET cards

All changes confined to `web/cockpit/wx-briefing.js`, `web/shared/weather-client.js`, and `web/style.css`. No new files. A separate server-side task (flywhere.app proxy token refresh) is noted but out of scope here.

---

## Section 1 — METAR/TAF Sort Order

### Problem

`_renderMetarSection` sorts on-route stations by `_distToNearestCoord`, which returns ~0 for all route stations (each is its own coord). The tie-break is unstable, so destination often appears before departure. Off-route nearby stations can also interleave with route stations when they share a close distance.

### Fix

**In `_renderMetarSection`:**

Build a `routeIndexMap` from `_getStationList()`:
```js
const stations = this._getStationList();
const routeIndexMap = new Map(stations.map((id, i) => [id, i]));
```

Sort comparator:
1. On-route stations first (`routeIndexMap.has(id)`), ordered by their index (0 = departure, last = destination).
2. Off-route stations below, ordered by `_distToNearestSegment(lat, lon, routeCoords)` ascending.

`_distToNearestSegment` computes the perpendicular distance from a point to the nearest route segment (not just the nearest waypoint). This is the same helper added for the corridor filter (Section 2).

**Result:** Station list reads departure → intermediate waypoints → destination on top, with nearby off-route airports below in order of proximity to the route line.

---

## Section 2 — Corridor Width Selector

### New state

Add to constructor:
```js
this._corridorMi = 25;  // default ~0.5°, matches prior hardcoded value
```

On `init()`, load from `localStorage`:
```js
const saved = parseInt(localStorage.getItem('flytab_wx_corridor'));
if ([10, 25, 50].includes(saved)) this._corridorMi = saved;
```

### UI — inline chips above METAR list

Rendered by `_renderMetarSection` above the section header:

```html
<div class="wx-corridor-chips">
  <button class="wx-corridor-chip" data-mi="10">10 mi</button>
  <button class="wx-corridor-chip active" data-mi="25">25 mi</button>
  <button class="wx-corridor-chip" data-mi="50">50 mi</button>
</div>
```

Tapping a chip:
1. Updates `_corridorMi`
2. Saves to `localStorage('flytab_wx_corridor')`
3. Invalidates METAR cache (`this._metarFetchedAt = 0; this._metarData = null`)
4. Calls `_fetchMetarTaf()`

Active chip reflects `_corridorMi` on every render.

### Fetch — bbox + corridor filter

`_fetchMetarTaf` currently calls `_getRouteBbox(0.5)`. Change to:
```js
const bufDeg = this._corridorMi / 69;
const bbox = await this._getRouteBbox(bufDeg);
```

After the METAR bbox fetch returns stations, filter by true corridor distance. `routeCoords` is already available at this point because `_fetchMetarTaf` calls `_getRouteCoords()` to build the bbox — store the result and reuse it here:
```js
const routeCoords = await this._getRouteCoords();
const routeStations = new Set(this._getStationList());
// Filter to stations within corridorMi of any route segment
const corridorMetarData = {};
for (const [icao, m] of Object.entries(rawMetarData)) {
    if (!m.lat || !m.lon) { corridorMetarData[icao] = m; continue; }
    if (routeStations.has(icao)) { corridorMetarData[icao] = m; continue; } // always keep on-route
    const dist = this._distToNearestSegment(m.lat, m.lon, routeCoords);
    if (dist <= this._corridorMi) corridorMetarData[icao] = m;
}
this._metarData = corridorMetarData;
```

### AIRMET filter

`_filterAdvisoriesForRoute` currently hardcodes `bufferDeg = 0.83` (~50 nm). Change signature to derive from `_corridorMi`:
```js
_filterAdvisoriesForRoute(advisories) {
    const bufferDeg = this._corridorMi / 69;
    ...
}
```

All callers drop the `bufferDeg` argument.

### `_distToNearestSegment` helper

New method. Returns distance in nautical miles from `(lat, lon)` to the nearest segment of `coords` (array of `{lat, lon}`):

```js
_distToNearestSegment(lat, lon, coords) {
    if (!coords.length) return 0;
    if (coords.length === 1) return this._nmDist(lat, lon, coords[0].lat, coords[0].lon);
    let minDist = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
        minDist = Math.min(minDist, this._distToSegment(lat, lon, coords[i], coords[i + 1]));
    }
    return minDist;
}

_distToSegment(lat, lon, a, b) {
    // Project point onto segment, clamp t to [0,1], return distance to closest point
    const dx = b.lon - a.lon, dy = b.lat - a.lat;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return this._nmDist(lat, lon, a.lat, a.lon);
    const t = Math.max(0, Math.min(1, ((lon - a.lon) * dx + (lat - a.lat) * dy) / lenSq));
    return this._nmDist(lat, lon, a.lat + t * dy, a.lon + t * dx);
}

_nmDist(lat1, lon1, lat2, lon2) {
    const R = 3440.065; // Earth radius in nm
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
```

### Persistence

`localStorage` key `flytab_wx_corridor` — string value `"10"`, `"25"`, or `"50"`.

---

## Section 3 — Forecast Discussions (AFD) — All Waypoints

### Problem

`_fetchAfds` builds `keyCoords` from only `coords[0]` (departure) and `coords[last]` (destination). A route passing through 3 NWS CWA boundaries only gets 1–2 AFDs.

### Fix

Replace:
```js
const keyCoords = [];
if (coords.length > 0) keyCoords.push(coords[0]);
if (coords.length > 1) keyCoords.push(coords[coords.length - 1]);
```

With:
```js
const keyCoords = coords;
```

The CWA deduplication (`officeMap.has(cwa)`) already handles repeated offices — querying 8 waypoints that resolve to 3 unique offices still produces exactly 3 AFDs.

No other change to `_fetchAfds` is needed.

---

## Section 4 — NOTAMs — Error Surfacing

### Root cause

`flywhere.app/api/notams` returns HTTP 502 with body `{"error":"CGI auth failed: 401","features":[]}`. The current code checks `resp.ok` (false for 502) and throws, falling back to empty cache — displaying "No active NOTAMs" as if the route is clean.

### Client-side fix

In `_fetchNotams` and `_fetchEnrouteNotams`, after `resp.ok` check fails, attempt to parse the error body:

```js
if (!resp.ok) {
    let errMsg = `NOTAM proxy ${resp.status}`;
    try {
        const errData = await resp.json();
        if (errData.error) errMsg = errData.error;
    } catch (_) {}
    throw new Error(errMsg);
}
```

In the `catch` block, set a `_notamError` flag (string or null):
```js
} catch (err) {
    this._notamError = err.message;
    // fall back to cache as before
}
```

Add `this._notamError = null` to the constructor. Reset to `null` at the top of `_refreshAll()` before re-fetching.

In `_renderNotamSection`, when `this._notamError` is set and cache is empty, render:
```html
<div class="wx-section-error">⚠ NOTAMs unavailable — auth error · tap ↻ to retry</div>
```

This distinguishes "no NOTAMs active" (valid) from "couldn't fetch NOTAMs" (failure).

### Server-side fix (separate task)

Refresh the CGI Federal API token on the flywhere.app proxy. This is tracked separately and unblocks both airport and en-route NOTAM sections automatically once resolved.

---

## Section 5 — G-AIRMET State Abbreviations

### Problem

AWC G-AIRMET API has no `states` field. State info must be derived from the advisory polygon.

### Approach

Compute the polygon centroid (mean lat/lon of all coordinate points). Look up the centroid against a compact 48-state bounding box table to get 1–3 state abbreviations covering the advisory area.

State bounding boxes are approximate rectangles (sufficient for CONUS G-AIRMETs). Multiple states can match if the centroid falls near a border — return all that contain the centroid, up to 3.

### Implementation

New method `_statesForPoints(points)`:
- Compute centroid `{ lat: meanLat, lon: meanLon }`
- Iterate compact state bounding box table (48 entries, hardcoded in the method)
- Collect all states whose bbox contains the centroid
- Return array of abbreviations, e.g. `['NC', 'SC']`

`_parseGairmet` in `weather-client.js` is not changed — it has no state table access. The `states` field is added to each advisory object in `_fetchAirmets` (in `wx-briefing.js`) after parsing:
```js
for (const adv of parsed) {
    adv.states = this._statesForPoints(adv.points);
}
```

### Display in `_buildGairmetCard`

Add one line below the altitude band in `wx-adv-alt`:
```js
const statesStr = adv.states?.length ? adv.states.join(' · ') : '';
```

```html
<div class="wx-adv-alt">${this._escHtml(altBand)}</div>
${statesStr ? `<div class="wx-adv-states">${this._escHtml(statesStr)}</div>` : ''}
```

Style `.wx-adv-states` in `style.css`: small, muted grey text, same size as the severity line.

---

## Files Changed

| File | Change |
|------|--------|
| `web/cockpit/wx-briefing.js` | METAR sort fix; corridor chips UI + state persistence; `_distToNearestSegment` + helpers; AFD all-waypoints fix; NOTAM error surfacing; `_statesForPoints` + state table; `_buildGairmetCard` states line |
| `web/shared/weather-client.js` | No change — states derived in `wx-briefing.js` post-parse |
| `web/style.css` | `.wx-corridor-chips`, `.wx-corridor-chip`, `.wx-adv-states` |

No new files. No changes to `web/index.html` or build scripts.

---

## Out of Scope

- flywhere.app proxy token refresh (server-side, tracked separately)
- Portrait layout changes
- MCD (Mesoscale Discussion) section
