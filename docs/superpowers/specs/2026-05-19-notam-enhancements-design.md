# NOTAM Enhancements — Prioritization, Search, Map Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this spec task-by-task.

**Goal:** Surface the NOTAMs that matter for the planned flight immediately — critical items at the
top, route-ordered below that — without requiring the pilot to page through irrelevant entries.
Add a text search, a "go to map" pill on each card, fix TFR geometry rendering, and turn the SUA
layer on by default.

**Architecture:** All changes are in `wx-briefing.js` (sort/search/classification/rendering),
`app.js` (`notam:goto` handler), `vector-map-layers.js` / `cockpit-config.js` (SUA default), and
`style.css` (search bar + map pill). No new files. No changes to the NOTAM fetch pipeline or API.

**Tech stack:** Vanilla JS, Leaflet, existing `_buildAdvCard()` component, `document.dispatchEvent`
event bus already used by `notam:tfrs`.

---

## Files Affected

| File | Change |
|---|---|
| `web/cockpit/wx-briefing.js` | Priority tiers, new types, merged sorted list, search bar, map pill, TFR geometry hardening |
| `web/app.js` | Listen for `notam:goto` event; hide wxBriefing and flyTo location |
| `web/shared/cockpit-config.js` | SUA overlay default `enabled: false → true` |
| `web/style.css` | `.wx-notam-search`, `.wx-notam-map-pill`, `.wx-notam-tier-hdr`, `.wx-adv-type.fisb`, `.wx-adv-type.gps`, `.wx-adv-type.apch`, `.wx-adv-type.mea` |

---

## Section 1 — New NOTAM Type Classifications

### 1a. Airport NOTAMs — add `APCH` type

Add to `_classifyByQcode()` **before** the existing NAVAID check:

```javascript
if (q.startsWith('QPI') || q.startsWith('QIL') || q.startsWith('QIC') || q.startsWith('QAL'))
    return 'APCH';
```

Add to `_classifyNotam()` **before** the existing NAVAID check:

```javascript
if (/\bMDA\b|\bDA\s+\d{3}|\bDECISION ALTITUDE\b|\bMINIMUMS\b|\bINSTRUMENT APPROACH\b|\bILS CAT\b/.test(r))
    return 'APCH';
```

### 1b. En-route NOTAMs — add `FISB`, `GPS`, `MEA` types

Extend `_isEnrouteRelevant(raw)`:

```javascript
// Existing checks remain. Add:
/\bFIS-?B\b|\bNBCAP\b/.test(r) ||
/\bGPS\s+(INTERFERENCE|UNRELIABLE|UNREL|OUTAGE)\b/.test(r) ||
/\bMEA\b|\bMOCA\b|\bMINIMUM EN.?ROUTE\b/.test(r)
```

Extend `_classifyEnrouteNotam(raw)` — add before the final `return 'SUA'`:

```javascript
if (/\bFIS-?B\b|\bNBCAP\b/.test(r)) return 'FISB';
if (/\bGPS\s+(INTERFERENCE|UNRELIABLE|UNREL|OUTAGE)\b/.test(r)) return 'GPS';
if (/\bMEA\b|\bMOCA\b|\bMINIMUM EN.?ROUTE\b/.test(r)) return 'MEA';
```

---

## Section 2 — Geo Field on Every NOTAM

Every NOTAM object gets an optional `geo: { lat, lon } | null` field. This powers the map pill.

### 2a. Airport NOTAMs — geo from waypoint coords

In `_fetchNotams()`, build a coord lookup before the parse loop:

```javascript
const wpGeoMap = new Map();
for (const wp of this._flightPlan?.waypoints || []) {
    if (wp.icao && wp.lat != null && wp.lon != null)
        wpGeoMap.set(wp.icao.toUpperCase(), { lat: wp.lat, lon: wp.lon });
}
```

In `_parseNotam()`, add `geo` to the returned object:

```javascript
// loc is the ICAO already resolved (e.g. 'KLKR')
const geo = wpGeoMap?.get(loc) ?? null;
return { airport, type, summary, raw, validFrom, validTo, geo };
```

`_parseNotam()` needs `wpGeoMap` passed in as a parameter: `_parseNotam(feature, airport, wpGeoMap)`.

### 2b. En-route NOTAMs — geo from parsed TFR geometry or raw text

Extend `_parseTfrGeometry(raw)` to return a `center` field alongside existing geometry:

```javascript
// After computing points[] polygon:
const center = _centroid(points);   // average lat/lon
return { points, center };

// After computing circle:
return { lat, lon, radiusNm, center: { lat, lon } };

// Helper:
function _centroid(pts) {
    const lat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lon = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return { lat, lon };
}
```

In `_fetchEnrouteNotams()`, set `geo` on each notam:

```javascript
const geo = notam.type === 'TFR' ? (this._parseTfrGeometry(raw)?.center ?? null)
          : this._parseCoordFromText(raw);   // new helper, see §3b
notams.push({ airport, type, summary, raw, validFrom, validTo, isEnroute: true, geo });
```

### 2c. Coordinate fallback parser for non-TFR en-route NOTAMs

New private method `_parseCoordFromText(raw)` — tries common patterns, returns `{lat,lon}` or
`null`:

```javascript
_parseCoordFromText(raw) {
    // DDMM(N|S)/DDDMM(W|E) — same as TFR polygon pattern, first occurrence
    const m = raw.match(/(\d{2})(\d{2})(N|S)\s*\/?(\d{2,3})(\d{2})(W|E)/i);
    if (!m) return null;
    let lat = parseInt(m[1]) + parseInt(m[2]) / 60;
    if (m[3].toUpperCase() === 'S') lat = -lat;
    let lon = parseInt(m[4]) + parseInt(m[5]) / 60;
    if (m[6].toUpperCase() === 'W') lon = -lon;
    return { lat, lon };
}
```

---

## Section 3 — TFR Geometry Hardening

### 3a. Inspect before fixing

**Before writing any code**, run:

```bash
NOTAM_BASE=$(node -e "const c=require('./web/cockpit-config.json'); console.log(c.notamBase||'')")
# or use staging URL from CockpitConfig
curl -s "https://www.flywhere.app/api/notams?location=KWAY,KSAV,ZJX" | \
    python3 -m json.tool | grep -A5 -i "waycross\|tfr\|temporary"
```

Inspect the `text` and `simpleText` fields of any TFR result to see the exact coordinate format.

### 3b. Add coordinate format variants to `_parseTfrGeometry()`

After the existing polygon regex, add fallbacks (try each in order, stop at first match):

```javascript
// Variant 2: no slash between lat/lon — "3031N08210W"
const pat2 = /(\d{2})(\d{2})(N|S)(\d{2,3})(\d{2})(W|E)/g;

// Variant 3: degrees-minutes-seconds — "30-31-00N/082-10-00W"
const pat3 = /(\d{2})-(\d{2})-(\d{2})(N|S)\s*\/?(\d{2,3})-(\d{2})-(\d{2})(W|E)/g;
// lat = d + m/60 + s/3600; lon = d + m/60 + s/3600

// Variant 4: circle — "n NM RADIUS OF" or "WITHIN A n NM RADIUS OF"
const circlePat2 = /(\d+(?:\.\d+)?)\s*NM\s+RADIUS\s+OF\s+(\d{2})(\d{2})(N|S)\s*\/?(\d{2,3})(\d{2})(W|E)/i;
```

Geometry only dispatches to the map when `points.length >= 3` (polygon) or `radiusNm > 0`
(circle) — no change to this guard.

### 3c. Also dispatch TFRs found in airport NOTAM fetch

After sorting `this._notams` in `_fetchNotams()`, add:

```javascript
const airportTfrShapes = this._notams
    .filter(n => n.type === 'TFR')
    .map(n => {
        const geo = this._parseTfrGeometry(n.raw);
        if (!geo) return null;
        return { raw: n.raw, summary: n.summary, validFrom: n.validFrom, validTo: n.validTo, ...geo };
    })
    .filter(Boolean);
if (airportTfrShapes.length) {
    document.dispatchEvent(new CustomEvent('notam:tfrs-apt', { detail: { shapes: airportTfrShapes } }));
}
```

In `map.js`, add listener for `notam:tfrs-apt` alongside `notam:tfrs` — same handler, same
`_notamTfrGroup` layer.

---

## Section 4 — Priority Tier Sort

### 4a. Tier function

New private method `_notamTier(n)`:

```javascript
_notamTier(n) {
    const CRITICAL = new Set(['TFR', 'RESTR', 'RWY', 'FISB', 'GPS', 'APCH', 'MEA']);
    if (CRITICAL.has(n.type)) return 0;
    if (n.isEnroute) return 2;   // ARTCC-sourced non-critical
    if (n.type === 'OBST_LGT') return 3;
    return 1;   // route airport NAVAID/TWY/AD/OBST/SVC
}
```

### 4b. Sub-sort within tier 0

```javascript
const T0_ORDER = ['TFR', 'RESTR', 'RWY', 'FISB', 'GPS', 'APCH', 'MEA'];
```

### 4c. Merge + sort

New private method `_sortedNotams()`:

```javascript
_sortedNotams() {
    const aptLoaded  = Array.isArray(this._notams);
    const enrLoaded  = Array.isArray(this._enrouteNotams);
    const apt = aptLoaded  ? this._filterByFlightWindow(this._notams)        : [];
    const enr = enrLoaded  ? this._filterByFlightWindow(this._enrouteNotams) : [];

    // Route station index for sort-within-tier-1
    const stations = this._getStationList();
    const stationIdx = new Map(stations.map((id, i) => [id, i]));

    const T0_ORDER = ['TFR', 'RESTR', 'RWY', 'FISB', 'GPS', 'APCH', 'MEA'];

    return [...apt, ...enr].sort((a, b) => {
        const ta = this._notamTier(a), tb = this._notamTier(b);
        if (ta !== tb) return ta - tb;

        // Within tier 0: by T0_ORDER
        if (ta === 0) {
            const ai = T0_ORDER.indexOf(a.type), bi = T0_ORDER.indexOf(b.type);
            if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        }

        // Within tier 1: by route station order
        if (ta === 1) {
            const ai = stationIdx.get(a.airport) ?? 999;
            const bi = stationIdx.get(b.airport) ?? 999;
            if (ai !== bi) return ai - bi;
        }

        return 0;
    });
}
```

---

## Section 5 — Unified Sorted List with Search Bar

### 5a. State

Add to constructor:

```javascript
this._notamSearch = '';
```

### 5b. Rewrite `_renderNotamSection()`

Replace the existing two-group layout entirely.

**Header badge logic** (unchanged semantics, new types included):

```javascript
const all = this._sortedNotams();  // uses loaded data, empty arrays if still loading
const critical = all.filter(n => this._notamTier(n) === 0);
const loading = this._notams === null || this._enrouteNotams === null;
const badgeClass = loading ? null
    : critical.length ? 'warn'
    : all.length       ? 'info'
    : 'ok';
const badgeText = loading ? 'Fetching…'
    : critical.length ? `${critical.length} CRITICAL`
    : all.length       ? `${all.length} ACTIVE`
    : 'NONE';
```

**Search bar** (rendered above list, always visible once data loads):

```javascript
const searchRow = document.createElement('div');
searchRow.className = 'wx-notam-search-row';
searchRow.innerHTML = `
    <input class="wx-notam-search" type="text" placeholder="Search NOTAMs…"
           value="${this._escHtml(this._notamSearch)}">
    ${this._notamSearch ? '<button class="wx-notam-search-clear">✕</button>' : ''}
`;
const searchInput = searchRow.querySelector('.wx-notam-search');
searchInput.addEventListener('input', () => {
    this._notamSearch = searchInput.value;
    this._renderNotamSection();
});
const clearBtn = searchRow.querySelector('.wx-notam-search-clear');
if (clearBtn) wireTap(clearBtn, () => { this._notamSearch = ''; this._renderNotamSection(); });
body.appendChild(searchRow);
```

**Filtered list:**

```javascript
const query = this._notamSearch.trim().toLowerCase();
const visible = query
    ? all.filter(n => (n.raw + ' ' + n.summary).toLowerCase().includes(query))
    : all;
```

**Tier section headers and cards:**

Render in order: tier 0 (CRITICAL), tier 1 (ROUTE), tier 2 (AREA), tier 3 (LIGHTS collapsed).

```javascript
const TIER_LABELS = ['CRITICAL', 'ROUTE', 'AREA', null /* lights handled separately */];
let lastTier = -1;

for (const notam of visible.filter(n => this._notamTier(n) < 3)) {
    const tier = this._notamTier(notam);
    if (tier !== lastTier) {
        const tierHdr = document.createElement('div');
        tierHdr.className = `wx-notam-tier-hdr wx-notam-tier-${tier}`;
        tierHdr.textContent = TIER_LABELS[tier];
        body.appendChild(tierHdr);
        lastTier = tier;
    }
    body.appendChild(this._buildNotamCard(notam));
}

// Lights section (tier 3) — collapsed toggle
const lights = visible.filter(n => this._notamTier(n) === 3);
if (lights.length) {
    // existing lights toggle pattern
}

if (!visible.length) {
    body.insertAdjacentHTML('beforeend',
        `<div class="wx-section-empty">${query ? 'No NOTAMs match your search.' : 'No active NOTAMs.'}</div>`);
}
```

### 5c. `_buildNotamCard(notam)` — replaces inline `_buildAdvCard` calls

```javascript
_buildNotamCard(notam) {
    const TIER = this._notamTier(notam);
    const TYPE_CLASS = {
        TFR: 'rwy', RESTR: 'restr', RWY: 'rwy', FISB: 'fisb', GPS: 'gps',
        APCH: 'apch', MEA: 'mea',
        NAVAID: 'rwy', TWY: 'twy', AD: 'ad', OBST: 'obst', SVC: 'svc',
        MOA: 'moa', ATCAA: 'atcaa', UAS: 'uas', LASER: 'laser',
    };
    const typeClass = TYPE_CLASS[notam.type] || 'sua';
    const label = notam.airport ? `${notam.airport} · ${notam.summary}` : notam.summary;
    const validStr = notam.validTo
        ? `Valid to <b>${new Date(notam.validTo).toLocaleDateString([],
            { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })} L</b>`
        : '';

    const card = this._buildAdvCard(notam.type, typeClass, label, notam.airport || '', notam.raw, validStr);

    // Map pill — only when geo is available
    if (notam.geo) {
        const pill = document.createElement('button');
        pill.className = 'wx-notam-map-pill';
        pill.textContent = '▶ Map';
        const { lat, lon } = notam.geo;
        const zoom = (notam.type === 'RWY' || notam.type === 'NAVAID' || notam.type === 'APCH') ? 12 : 9;
        wireTap(pill, () => {
            document.dispatchEvent(new CustomEvent('notam:goto', { detail: { lat, lon, zoom } }));
        });
        // Insert pill into card header, before the chevron
        card.querySelector('.wx-adv-hdr').insertBefore(pill,
            card.querySelector('.wx-adv-chevron'));
    }

    return card;
}
```

---

## Section 6 — `notam:goto` Event Handler in `app.js`

In `app.js`, after the existing `notam:tfrs` listener setup, add:

```javascript
document.addEventListener('notam:goto', (e) => {
    const { lat, lon, zoom } = e.detail;
    this.wxBriefing?.hide();
    this.cockpitMap?.map?.flyTo([lat, lon], zoom, { animate: true, duration: 0.8 });
});
```

Also add `notam:tfrs-apt` listener in `map.js` alongside `notam:tfrs`:

```javascript
document.addEventListener('notam:tfrs-apt', this._onNotamTfrs);
```

(`_onNotamTfrs` already handles a shapes array — reuse it unchanged.)

---

## Section 7 — SUA Layer Default On

In `web/shared/cockpit-config.js`, `CockpitConfig.DEFAULTS.map.overlays` — add `sua`:

```javascript
overlays: {
    airspace: { enabled: true,  minZoom: 6 },
    airports: { enabled: true,  minZoom: 7, labelsMinZoom: 8 },
    navaids:  { enabled: true,  minZoom: 7, labelsMinZoom: 9 },
    fixes:    { enabled: false, minZoom: 10 },
    airways:  { enabled: false, minZoom: 8 },
    sua:      { enabled: true  },   // ← new
},
```

In `web/cockpit/vector-map-layers.js` line ~170, the existing guard:

```javascript
const suaUserSet = localStorage.getItem('flypi_show_sua');
if (suaUserSet !== null ? JSON.parse(suaUserSet) : overlays.sua?.enabled) ...
```

This already respects the default from config when no localStorage override is set — no change
needed here beyond the config value above.

---

## Section 8 — CSS

Add to `web/style.css`:

```css
/* NOTAM search bar */
.wx-notam-search-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--border-color);
}
.wx-notam-search {
    flex: 1; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--border-color); background: var(--bg-secondary);
    color: var(--text-primary); font-size: 15px;
}
.wx-notam-search-clear {
    padding: 6px 10px; border: none; background: transparent;
    color: var(--text-secondary); font-size: 18px; cursor: pointer; touch-action: manipulation;
}

/* Tier section headers */
.wx-notam-tier-hdr {
    padding: 4px 12px; font-size: 11px; font-weight: 700;
    letter-spacing: 0.08em; color: var(--text-secondary);
    border-top: 1px solid var(--border-color); margin-top: 4px;
}
.wx-notam-tier-0 { color: #d0330a; }   /* critical — readable red */

/* Map pill */
.wx-notam-map-pill {
    padding: 4px 10px; border-radius: 12px; border: 1px solid #2266cc;
    background: transparent; color: #4488ee; font-size: 12px; font-weight: 600;
    cursor: pointer; touch-action: manipulation; white-space: nowrap; flex-shrink: 0;
}

/* New type badge colors */
.wx-adv-type.fisb  { background: #6633aa; }
.wx-adv-type.gps   { background: #cc5500; }
.wx-adv-type.apch  { background: #1a5c9a; }
.wx-adv-type.mea   { background: #2e7d32; }
```

---

## Interface Contracts

- `_parseNotam(feature, airport, wpGeoMap)` — `wpGeoMap: Map<icao, {lat,lon}>` built in
  `_fetchNotams()` before the parse loop; passed to each call.
- `notam.geo: { lat: number, lon: number } | null` — present on every notam object after fetch;
  null means no pill shown.
- `notam:goto` event detail: `{ lat: number, lon: number, zoom: number }` — dispatched by
  `_buildNotamCard()`; handled in `app.js`.
- `notam:tfrs-apt` event — same `{ shapes: [...] }` structure as `notam:tfrs`; registered in
  `map.js` using the same `_onNotamTfrs` handler.
- `_sortedNotams()` returns filtered-by-flight-window, merged, sorted array. Returns `[]` (not
  null) when either dataset is still loading — loading state is checked separately via
  `this._notams === null`.

## Testing

1. Open WX Briefing with a route loaded — verify tier headers appear (CRITICAL / ROUTE / AREA).
2. Type "KLKR" in search — only NOTAMS containing "KLKR" show; tier headers update.
3. Type "FIS-B" — any FISB-type NOTAMs appear; type badge is purple.
4. Tap "▶ Map" on a runway NOTAM — wx-briefing closes, map flies to airport at zoom 12.
5. Tap "▶ Map" on a TFR — map flies to TFR center at zoom 9.
6. Clear search (✕) — full list restores.
7. Verify SUA layer is on by default on a fresh install (clear localStorage, reload).
8. Confirm a TFR with polygon coordinates draws on the map (check logcat for geometry parse errors).
