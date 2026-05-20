# NOTAM Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current two-group NOTAM panel with a single priority-sorted list (Critical → Route → Area → Lights), add a text search bar, a "▶ Map" pill on each card that flies the map to the NOTAM's location, harden TFR geometry parsing so shapes actually draw on the map, and turn the SUA layer on by default.

**Architecture:** All UI logic changes are in `web/cockpit/wx-briefing.js`. Event wiring is split between `web/cockpit/map.js` (`notam:tfrs-apt` listener) and `web/app.js` (`notam:goto` listener). The SUA default is a one-line change in `web/shared/cockpit-config.js`. No new files are needed.

**Tech Stack:** Vanilla JS, Leaflet 1.x, custom `wireTap()` for touch events, `document.dispatchEvent` event bus pattern already established by `notam:tfrs`.

**Spec:** `docs/superpowers/specs/2026-05-19-notam-enhancements-design.md`

---

## Critical codebase facts for implementers

- **No bundler.** All JS loaded via `<script>` tags in `web/index.html`. Load order matters.
- **`wireTap(element, fn)`** must be used for all tappable buttons (defined in `web/shared/tap-utils.js`). Plain `addEventListener('click')` is unreliable on the Android tablet — Leaflet's drag handler swallows it. Use `addEventListener('input')` for text inputs only.
- **`wx-briefing.js` is 2466 lines.** Method locations used below are approximate — search by name if off by a few lines.
- **Build command:** `bash build.sh` from the repo root. Always increment `FLYTAB_VERSION` in `web/app.js` first.
- **NOTAM fetch flow:** Two parallel fetches on show — `_fetchNotams()` (airport NOTAMs for route stations) and `_fetchEnrouteNotams()` (ARTCC-sourced NOTAMs). Both set `this._notams` / `this._enrouteNotams` then call `_renderNotamSection()`.
- **Existing notam object shape** (airport): `{ airport, type, summary, raw, validFrom, validTo }`. We add `geo: { lat, lon } | null`.
- **Existing notam object shape** (en-route): above plus `isEnroute: true`.

---

## Task 1: Inspect live TFR data and harden `_parseTfrGeometry()`

**Files:**
- Modify: `web/cockpit/wx-briefing.js` (around line 2131 — `_parseTfrGeometry`)

### Step 1: Fetch live TFR data and inspect coordinate format

- [ ] Run:

```bash
curl -s "https://www.flywhere.app/api/notams?location=KZJX,ZZZ" | \
  python3 -c "
import json,sys
data = json.load(sys.stdin)
for f in data.get('features',[]):
    n = f.get('properties',{}).get('coreNOTAMData',{}).get('notam',{})
    t = f.get('properties',{}).get('coreNOTAMData',{}).get('notamTranslation',[])
    raw = n.get('text','') or next((x.get('simpleText','') for x in t if x.get('type')=='LOCAL_FORMAT'),'')
    if 'TFR' in raw.upper() or 'TEMPORARY FLIGHT' in raw.upper():
        print('=== TFR NOTAM ===')
        print(raw[:600])
        print()
" 2>/dev/null | head -100
```

Expected: one or more TFR NOTAM text blocks with coordinate strings visible.

Note the coordinate format used (DDMM, DDMMSS, decimal degrees, etc.) — the fix in Step 2 covers all known variants.

### Step 2: Replace `_parseTfrGeometry()` with hardened version

- [ ] Find `_parseTfrGeometry(raw)` at approximately line 2131. Replace the entire method with:

```javascript
_parseTfrGeometry(raw) {
    const pts = [];

    // Format 1 (existing): DDMM(N|S)/DDDMM(W|E) or DDMM(N|S)DDDMM(W|E)
    const pat1 = /(\d{2})(\d{2})(N|S)\s*\/?(\d{2,3})(\d{2})(W|E)/gi;
    let m;
    while ((m = pat1.exec(raw)) !== null) {
        let lat = parseInt(m[1]) + parseInt(m[2]) / 60;
        if (m[3].toUpperCase() === 'S') lat = -lat;
        let lon = parseInt(m[4]) + parseInt(m[5]) / 60;
        if (m[6].toUpperCase() === 'W') lon = -lon;
        pts.push([lat, lon]);
    }

    // Format 2: DDMMSS(N|S)/DDDMMSS(W|E) degrees-minutes-seconds
    if (!pts.length) {
        const pat2 = /(\d{2})(\d{2})(\d{2})(N|S)\s*\/?(\d{2,3})(\d{2})(\d{2})(W|E)/gi;
        while ((m = pat2.exec(raw)) !== null) {
            let lat = parseInt(m[1]) + parseInt(m[2]) / 60 + parseInt(m[3]) / 3600;
            if (m[4].toUpperCase() === 'S') lat = -lat;
            let lon = parseInt(m[5]) + parseInt(m[6]) / 60 + parseInt(m[7]) / 3600;
            if (m[8].toUpperCase() === 'W') lon = -lon;
            pts.push([lat, lon]);
        }
    }

    if (pts.length >= 3) {
        const clat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const clon = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        return { points: pts, center: { lat: clat, lon: clon } };
    }

    // Circle variants
    const circlePats = [
        // "WITHIN n NM OF DDMM(N|S) DDDMM(W|E)"
        /WITHIN\s+(\d+(?:\.\d+)?)\s*NM\s+(?:RADIUS\s+)?OF\s+(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/i,
        // "WITHIN A n NM RADIUS OF ..."
        /WITHIN\s+A\s+(\d+(?:\.\d+)?)\s*NM\s+RADIUS\s+OF\s+(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/i,
        // "n-NM RADIUS OF ..."
        /(\d+(?:\.\d+)?)-NM\s+RADIUS.*?(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/i,
        // "n NM RADIUS OF ..."
        /(\d+(?:\.\d+)?)\s*NM\s+RADIUS\s+OF\s+(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/i,
    ];
    for (const pat of circlePats) {
        const c = raw.match(pat);
        if (c) {
            const radiusNm = parseFloat(c[1]);
            let lat = parseInt(c[2]) + parseInt(c[3]) / 60;
            if (c[4].toUpperCase() === 'S') lat = -lat;
            let lon = parseInt(c[5]) + parseInt(c[6]) / 60;
            if (c[6 + 1] && c[6 + 1].toUpperCase() === 'W') lon = -lon;
            // Reindex safely
            const iW = c.findIndex((v, i) => i > 4 && /^[WE]$/i.test(v));
            if (iW > 0 && c[iW].toUpperCase() === 'W') lon = Math.abs(lon) * -1;
            return { lat, lon, radiusNm, center: { lat, lon } };
        }
    }

    return null;
}
```

### Step 3: Add `_parseCoordFromText()` helper right after `_parseTfrGeometry()`

- [ ] Insert this new method immediately after the closing `}` of `_parseTfrGeometry`:

```javascript
_parseCoordFromText(raw) {
    // Returns {lat, lon} for the first DDMM coordinate found, or null.
    const m = (raw || '').match(/(\d{2})(\d{2})(N|S)\s*\/?(\d{2,3})(\d{2})(W|E)/i);
    if (!m) return null;
    let lat = parseInt(m[1]) + parseInt(m[2]) / 60;
    if (m[3].toUpperCase() === 'S') lat = -lat;
    let lon = parseInt(m[4]) + parseInt(m[5]) / 60;
    if (m[6].toUpperCase() === 'W') lon = -lon;
    return { lat, lon };
}
```

### Step 4: Commit

- [ ] Run:

```bash
git add web/cockpit/wx-briefing.js
git commit -m "fix(notam): harden TFR geometry parsing — all coordinate formats + center field"
```

---

## Task 2: Extend NOTAM type classifications (APCH, FISB, GPS, MEA)

**Files:**
- Modify: `web/cockpit/wx-briefing.js` (lines ~2161–2224)

### Step 1: Fix `_classifyByQcode()` — add APCH, fix QPI

- [ ] Find `_classifyByQcode(q)` at approximately line 2204. The current body is:

```javascript
if (q.startsWith('QMR')) return 'RWY';
if (q.startsWith('QNV') || q.startsWith('QPI')) return 'NAVAID';
if (q.startsWith('QOL')) return 'OBST_LGT';
if (q.startsWith('QOB')) return 'OBST';
if (q.startsWith('QTW')) return 'TWY';
if (q.startsWith('QFA') || q.startsWith('QAP')) return 'AD';
return null;
```

Replace with:

```javascript
if (q.startsWith('QMR')) return 'RWY';
if (q.startsWith('QPI') || q.startsWith('QIL') || q.startsWith('QIC') || q.startsWith('QAL'))
    return 'APCH';
if (q.startsWith('QNV')) return 'NAVAID';
if (q.startsWith('QOL')) return 'OBST_LGT';
if (q.startsWith('QOB')) return 'OBST';
if (q.startsWith('QTW')) return 'TWY';
if (q.startsWith('QFA') || q.startsWith('QAP')) return 'AD';
return null;
```

### Step 2: Fix `_classifyNotam()` — add APCH before NAVAID

- [ ] Find `_classifyNotam(raw)` at approximately line 2216. The current body starts with:

```javascript
const r = raw.toUpperCase();
if (/\bRWY\b/.test(r)) return 'RWY';
if (/\bNAVAID\b|ILS|VOR|NDB|LOC\b|PAPI|VASI/.test(r)) return 'NAVAID';
```

Add the APCH check between RWY and NAVAID:

```javascript
const r = raw.toUpperCase();
if (/\bRWY\b/.test(r)) return 'RWY';
if (/\bMDA\b|\bDA\s+\d{3}|\bDECISION ALTITUDE\b|\bMINIMUMS\b|\bINSTRUMENT APPROACH\b|\bILS CAT\b/.test(r))
    return 'APCH';
if (/\bNAVAID\b|ILS|VOR|NDB|LOC\b|PAPI|VASI/.test(r)) return 'NAVAID';
if (/\bOBST\b|CRANE|TOWER|ANTENNA/.test(r)) return 'OBST';
if (/\bTWY\b/.test(r)) return 'TWY';
if (/\bAD\b|\bAPRON\b|\bRAMP\b/.test(r)) return 'AD';
return 'SVC';
```

### Step 3: Extend `_isEnrouteRelevant()` — add FISB, GPS, MEA

- [ ] Find `_isEnrouteRelevant(raw)` at approximately line 2161. Add three lines at the end of the `return` expression (before the final `;`):

```javascript
_isEnrouteRelevant(raw) {
    const r = raw.toUpperCase();
    return /\bTFR\b|TEMPORARY FLIGHT RESTRICTION/.test(r) ||
           /\bUAS\b|\bDRONE\b/.test(r) ||
           /\bLASER\b/.test(r) ||
           / P-\d+|\bPROHIBITED AREA\b/.test(r) ||
           / R-\d+|\bRESTRICTED AREA\b/.test(r) ||
           /\bMOA\b/.test(r) ||
           /\bWARNING AREA\b| W-\d+/.test(r) ||
           /\bATCAA\b/.test(r) ||
           /\bFIS-?B\b|\bNBCAP\b/.test(r) ||
           /\bGPS\s+(INTERFERENCE|UNRELIABLE|UNREL|OUTAGE)\b/.test(r) ||
           /\bMEA\b|\bMOCA\b|\bMINIMUM EN.?ROUTE\b/.test(r);
}
```

### Step 4: Extend `_classifyEnrouteNotam()` — add FISB, GPS, MEA

- [ ] Find `_classifyEnrouteNotam(raw)` at approximately line 2173. Add three lines before `return 'SUA'`:

```javascript
_classifyEnrouteNotam(raw) {
    const r = raw.toUpperCase();
    if (/\bTFR\b|TEMPORARY FLIGHT RESTRICTION/.test(r)) return 'TFR';
    if (/ P-\d+|\bPROHIBITED AREA\b/.test(r)) return 'RESTR';
    if (/ R-\d+|\bRESTRICTED AREA\b/.test(r)) return 'RESTR';
    if (/\bMOA\b/.test(r)) return 'MOA';
    if (/\bWARNING AREA\b| W-\d+/.test(r)) return 'WARN';
    if (/\bATCAA\b/.test(r)) return 'ATCAA';
    if (/\bUAS\b|\bDRONE\b/.test(r)) return 'UAS';
    if (/\bLASER\b/.test(r)) return 'LASER';
    if (/\bFIS-?B\b|\bNBCAP\b/.test(r)) return 'FISB';
    if (/\bGPS\s+(INTERFERENCE|UNRELIABLE|UNREL|OUTAGE)\b/.test(r)) return 'GPS';
    if (/\bMEA\b|\bMOCA\b|\bMINIMUM EN.?ROUTE\b/.test(r)) return 'MEA';
    return 'SUA';
}
```

### Step 5: Commit

- [ ] Run:

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat(notam): add APCH/FISB/GPS/MEA type classifications"
```

---

## Task 3: Add `geo` field to every NOTAM object

**Files:**
- Modify: `web/cockpit/wx-briefing.js` (lines ~1979–2003 in `_fetchNotams`, ~2063–2099 in `_fetchEnrouteNotams`, ~2194–2202 in `_parseNotam`)

### Step 1: Update `_parseNotam()` to accept and use `wpGeoMap`

- [ ] Find `_parseNotam(feature, airport)` at approximately line 2194. Replace the entire method:

```javascript
_parseNotam(feature, airport, wpGeoMap = new Map()) {
    const n = feature.properties?.coreNOTAMData?.notam || {};
    const translations = feature.properties?.coreNOTAMData?.notamTranslation || [];
    const localFmt = translations.find(t => t.type === 'LOCAL_FORMAT');
    const raw = localFmt?.simpleText || localFmt?.domestic_message || n.text || '';
    const type = this._classifyByQcode(n.selectionCode) || this._classifyNotam(raw);
    const summary = this._summarizeNotam(raw);
    const geo = wpGeoMap.get(airport.toUpperCase()) ?? null;
    return { airport, type, summary, raw, validFrom: n.effectiveStart || null, validTo: n.effectiveEnd || null, geo };
}
```

### Step 2: Update `_fetchNotams()` to build `wpGeoMap` and pass it

- [ ] Find `_fetchNotams()` at approximately line 1960. Inside the `try` block, right before `const notams = [];` (around line 1979), add:

```javascript
const wpGeoMap = new Map();
for (const wp of this._flightPlan?.waypoints || []) {
    const key = (wp.icao || wp.id || '').toUpperCase();
    if (key && wp.lat != null && wp.lon != null)
        wpGeoMap.set(key, { lat: wp.lat, lon: wp.lon });
}
```

- [ ] Change the `_parseNotam` call at approximately line 1989 from:

```javascript
notams.push(this._parseNotam(feature, loc));
```

to:

```javascript
notams.push(this._parseNotam(feature, loc, wpGeoMap));
```

### Step 3: Dispatch airport-path TFRs to map + add their geo

- [ ] In `_fetchNotams()`, find where `this._notams = notams;` is set (approximately line 2003). After that line, add:

```javascript
const airportTfrShapes = notams
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

### Step 4: Add `geo` field in `_fetchEnrouteNotams()`

- [ ] Find the `notams.push({...})` block at approximately line 2069. The current code is:

```javascript
notams.push({
    airport: n.location || '',
    type: this._classifyEnrouteNotam(raw),
    summary: this._summarizeEnrouteNotam(raw),
    raw,
    validFrom: n.effectiveStart || null,
    validTo:   n.effectiveEnd   || null,
    isEnroute: true,
});
```

Replace with (compute `type` first so it can be used for geo resolution):

```javascript
const enrType = this._classifyEnrouteNotam(raw);
const geo = enrType === 'TFR'
    ? (this._parseTfrGeometry(raw)?.center ?? null)
    : this._parseCoordFromText(raw);
notams.push({
    airport: n.location || '',
    type: enrType,
    summary: this._summarizeEnrouteNotam(raw),
    raw,
    validFrom: n.effectiveStart || null,
    validTo:   n.effectiveEnd   || null,
    isEnroute: true,
    geo,
});
```

### Step 5: Verify the existing en-route sort still works

- [ ] Find the sort at approximately line 2080:

```javascript
const PRIORITY = { TFR: 0, RESTR: 1, MOA: 2, WARN: 3, ATCAA: 4, UAS: 5, LASER: 6 };
notams.sort((a, b) => {
    const ap = PRIORITY[a.type] ?? 9;
    const bp = PRIORITY[b.type] ?? 9;
    return ap !== bp ? ap - bp : a.airport.localeCompare(b.airport);
});
```

This sort can stay as-is — `_sortedNotams()` (added in Task 5) will fully replace the rendered order. No change needed here.

### Step 6: Commit

- [ ] Run:

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat(notam): add geo field to all NOTAM objects; dispatch airport-path TFRs to map"
```

---

## Task 4: Wire `notam:tfrs-apt` in `map.js` and `notam:goto` in `app.js`

**Files:**
- Modify: `web/cockpit/map.js` (lines ~249, ~267)
- Modify: `web/app.js` (after line ~786)

### Step 1: Register `notam:tfrs-apt` listener in `map.js`

- [ ] Find `document.addEventListener('notam:tfrs', this._onNotamTfrs);` at approximately line 249. Add the identical listener for the new event directly below it:

```javascript
document.addEventListener('notam:tfrs', this._onNotamTfrs);
document.addEventListener('notam:tfrs-apt', this._onNotamTfrs);
```

The `_onNotamTfrs` handler already accepts any `{ shapes: [...] }` payload — no change needed.

### Step 2: Remove `notam:tfrs-apt` listener in `destroy()`

- [ ] Find `document.removeEventListener('notam:tfrs', this._onNotamTfrs);` at approximately line 267. Add the removal directly below it:

```javascript
document.removeEventListener('notam:tfrs', this._onNotamTfrs);
document.removeEventListener('notam:tfrs-apt', this._onNotamTfrs);
```

### Step 3: Add `notam:goto` listener in `app.js`

- [ ] Find `this.wxBriefing.init();` at approximately line 786. Add the event listener directly after it:

```javascript
this.wxBriefing.init();
document.addEventListener('notam:goto', (e) => {
    const { lat, lon, zoom } = e.detail;
    this.wxBriefing?.hide();
    this.cockpitMap?.map?.flyTo([lat, lon], zoom ?? 9, { animate: true, duration: 0.8 });
});
```

### Step 4: Commit

- [ ] Run:

```bash
git add web/cockpit/map.js web/app.js
git commit -m "feat(notam): wire notam:tfrs-apt to map TFR layer; notam:goto closes panel and flies map"
```

---

## Task 5: Add `_notamTier()` and `_sortedNotams()` to `wx-briefing.js`

**Files:**
- Modify: `web/cockpit/wx-briefing.js` (add after `_filterByFlightWindow` at ~line 1088)

### Step 1: Add `_notamTier()` after `_filterByFlightWindow()`

- [ ] Find the closing `}` of `_filterByFlightWindow` at approximately line 1088. Insert after it:

```javascript
_notamTier(n) {
    if (['TFR','RESTR','RWY','FISB','GPS','APCH','MEA'].includes(n.type)) return 0;
    if (n.type === 'OBST_LGT') return 3;
    if (n.isEnroute) return 2;
    return 1;
}
```

### Step 2: Add `_sortedNotams()` immediately after `_notamTier()`

- [ ] Insert after `_notamTier()`:

```javascript
_sortedNotams() {
    const apt = Array.isArray(this._notams)
        ? this._filterByFlightWindow(this._notams) : [];
    const enr = Array.isArray(this._enrouteNotams)
        ? this._filterByFlightWindow(this._enrouteNotams) : [];

    const stations = this._getStationList();
    const stationIdx = new Map(stations.map((id, i) => [id, i]));
    const T0 = ['TFR','RESTR','RWY','FISB','GPS','APCH','MEA'];

    return [...apt, ...enr].sort((a, b) => {
        const ta = this._notamTier(a), tb = this._notamTier(b);
        if (ta !== tb) return ta - tb;
        if (ta === 0) {
            const ai = T0.indexOf(a.type), bi = T0.indexOf(b.type);
            if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        }
        if (ta === 1) {
            const ai = stationIdx.get(a.airport) ?? 999;
            const bi = stationIdx.get(b.airport) ?? 999;
            if (ai !== bi) return ai - bi;
        }
        return 0;
    });
}
```

### Step 3: Commit

- [ ] Run:

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat(notam): add _notamTier() and _sortedNotams() for priority-ordered unified list"
```

---

## Task 6: Add `_notamSearch` state, `_buildNotamCard()`, `_renderNotamList()`, rewrite `_renderNotamSection()`

**Files:**
- Modify: `web/cockpit/wx-briefing.js` (constructor ~line 30, near `_buildAdvCard` ~line 1929, `_renderNotamSection` ~line 423)

### Step 1: Add `_notamSearch` to the constructor

- [ ] Find the constructor body (class `WxBriefing`, around line 11). Inside the constructor, after `this._lightsExpanded = false;` (approximately line 45), add:

```javascript
this._notamSearch = '';
```

### Step 2: Add `_buildNotamCard()` after `_buildAdvCard()`

- [ ] Find the closing `}` of `_buildAdvCard()` at approximately line 1952. Insert this new method directly after it:

```javascript
_buildNotamCard(notam) {
    const TYPE_CLASS = {
        TFR: 'rwy', RESTR: 'restr', RWY: 'rwy', FISB: 'fisb', GPS: 'gps',
        APCH: 'apch', MEA: 'mea', NAVAID: 'rwy', TWY: 'twy', AD: 'ad',
        OBST: 'obst', SVC: 'svc', MOA: 'moa', ATCAA: 'atcaa', UAS: 'uas', LASER: 'laser',
    };
    const typeClass = TYPE_CLASS[notam.type] || 'sua';
    const label = notam.airport ? `${notam.airport} · ${notam.summary}` : notam.summary;
    const validStr = notam.validTo
        ? `Valid to <b>${new Date(notam.validTo).toLocaleDateString([],
            { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })} L</b>`
        : '';
    const card = this._buildAdvCard(notam.type, typeClass, label, notam.airport || '', notam.raw, validStr);
    if (notam.geo) {
        const pill = document.createElement('button');
        pill.className = 'wx-notam-map-pill';
        pill.textContent = '▶ Map';
        const { lat, lon } = notam.geo;
        const zoom = (['RWY','NAVAID','APCH'].includes(notam.type)) ? 12 : 9;
        wireTap(pill, () => {
            document.dispatchEvent(new CustomEvent('notam:goto', { detail: { lat, lon, zoom } }));
        });
        card.querySelector('.wx-adv-hdr').insertBefore(pill, card.querySelector('.wx-adv-chevron'));
    }
    return card;
}
```

### Step 3: Add `_renderNotamList()` immediately after `_buildNotamCard()`

- [ ] Insert directly after the `}` that closes `_buildNotamCard`:

```javascript
_renderNotamList(container) {
    container.innerHTML = '';
    if (this._notams === null || this._enrouteNotams === null) {
        container.insertAdjacentHTML('beforeend', '<div class="wx-section-loading">Fetching NOTAMs…</div>');
        return;
    }
    const query = this._notamSearch.trim().toLowerCase();
    const all = this._sortedNotams();
    const visible = query
        ? all.filter(n => (n.raw + ' ' + n.summary).toLowerCase().includes(query))
        : all;

    const mainItems = visible.filter(n => this._notamTier(n) < 3);
    const lights    = visible.filter(n => this._notamTier(n) === 3);

    if (!mainItems.length && !lights.length) {
        container.insertAdjacentHTML('beforeend',
            `<div class="wx-section-empty">${query ? 'No NOTAMs match your search.' : 'No active NOTAMs.'}</div>`);
        return;
    }

    const TIER_LABELS = ['CRITICAL', 'ROUTE', 'AREA'];
    let lastTier = -1;
    for (const notam of mainItems) {
        const tier = this._notamTier(notam);
        if (tier !== lastTier) {
            const hdr = document.createElement('div');
            hdr.className = `wx-notam-tier-hdr wx-notam-tier-${tier}`;
            hdr.textContent = TIER_LABELS[tier];
            container.appendChild(hdr);
            lastTier = tier;
        }
        container.appendChild(this._buildNotamCard(notam));
    }

    if (lights.length) {
        const toggle = document.createElement('div');
        toggle.className = 'wx-notam-lights-toggle';
        toggle.innerHTML = `<span>${lights.length} obstacle light outage${lights.length !== 1 ? 's' : ''}</span>`
            + `<span>${this._lightsExpanded ? '▼' : '▶'}</span>`;
        const lightsBody = document.createElement('div');
        lightsBody.style.display = this._lightsExpanded ? 'block' : 'none';
        for (const n of lights) lightsBody.appendChild(this._buildNotamCard(n));
        wireTap(toggle, () => {
            this._lightsExpanded = !this._lightsExpanded;
            lightsBody.style.display = this._lightsExpanded ? 'block' : 'none';
            toggle.querySelector('span:last-child').textContent = this._lightsExpanded ? '▼' : '▶';
        });
        container.appendChild(toggle);
        container.appendChild(lightsBody);
    }
}
```

### Step 4: Rewrite `_renderNotamSection()`

- [ ] Find `_renderNotamSection()` at approximately line 423. Replace the entire method with:

```javascript
_renderNotamSection() {
    const sec = this._section('wx-notam-section');
    if (!sec) return;

    const loading = this._notams === null || this._enrouteNotams === null;
    const all = loading ? [] : this._sortedNotams();
    const critical = all.filter(n => this._notamTier(n) === 0);
    const fetchErr = !loading && this._notamFetchError && !this._notams?.length;
    const anyErr = fetchErr || (!loading && (this._notamFetchError || this._enrouteNotamFetchError));

    const badgeClass = loading ? null
        : (fetchErr ? 'warn' : critical.length ? 'warn' : all.length ? 'info' : 'ok');
    const badgeText = loading ? 'Fetching…'
        : (anyErr && !all.length) ? 'UNAVAIL'
        : critical.length ? `${critical.length} CRITICAL`
        : all.length ? `${all.length} ACTIVE`
        : 'NONE';

    const hdr = this._buildRhsHeader('NOTAMs', badgeClass, badgeText);
    sec.innerHTML = '';
    sec.appendChild(hdr);

    const body = document.createElement('div');
    body.className = 'wx-rhs-body open';

    if (fetchErr) {
        body.insertAdjacentHTML('beforeend',
            `<div class="wx-section-error">⚠ ${this._escHtml(this._notamFetchError)} · tap ↻ to retry</div>`);
        sec.appendChild(body);
        return;
    }
    if (!loading && this._notamFetchError && this._notams?.length) {
        body.insertAdjacentHTML('beforeend',
            `<div class="wx-section-error">⚠ Refresh failed — showing cached data · tap ↻ to retry</div>`);
    }

    // ── Search bar ───────────────────────────────────────────────────────────
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
        const list = body.querySelector('#wx-notam-list');
        if (list) this._renderNotamList(list);
    });
    const clearBtn = searchRow.querySelector('.wx-notam-search-clear');
    if (clearBtn) {
        wireTap(clearBtn, () => {
            this._notamSearch = '';
            this._renderNotamSection();
        });
    }
    body.appendChild(searchRow);

    // ── Sorted/filtered NOTAM list ───────────────────────────────────────────
    const listContainer = document.createElement('div');
    listContainer.id = 'wx-notam-list';
    body.appendChild(listContainer);
    sec.appendChild(body);

    this._renderNotamList(listContainer);
}
```

### Step 5: Commit

- [ ] Run:

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat(notam): unified sorted list with search bar, tier headers, and map pill"
```

---

## Task 7: CSS additions

**Files:**
- Modify: `web/style.css`

### Step 1: Find the right insertion point

- [ ] Search for `.wx-notam-lights-toggle` in `web/style.css`:

```bash
grep -n "wx-notam-lights-toggle\|wx-adv-type\b" web/style.css | head -10
```

Note the line number of `.wx-notam-lights-toggle`.

### Step 2: Insert new CSS rules before `.wx-notam-lights-toggle`

- [ ] Immediately before the `.wx-notam-lights-toggle` rule, insert:

```css
/* NOTAM search bar */
.wx-notam-search-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color);
}
.wx-notam-search {
    flex: 1;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary, #0e1628);
    color: var(--text-primary, #e8ecf0);
    font-size: 15px;
}
.wx-notam-search-clear {
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: var(--text-secondary, #a0b8d0);
    font-size: 18px;
    cursor: pointer;
    touch-action: manipulation;
}

/* NOTAM tier section headers */
.wx-notam-tier-hdr {
    padding: 4px 12px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--text-secondary, #a0b8d0);
    border-top: 1px solid var(--border-color);
    margin-top: 4px;
}
.wx-notam-tier-0 { color: #d0330a; }

/* Map pill button on NOTAM cards */
.wx-notam-map-pill {
    padding: 4px 10px;
    border-radius: 12px;
    border: 1px solid #2266cc;
    background: transparent;
    color: #4488ee;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    touch-action: manipulation;
    white-space: nowrap;
    flex-shrink: 0;
    margin-left: 6px;
}

/* New NOTAM type badge colors */
.wx-adv-type.fisb  { background: #6633aa; }
.wx-adv-type.gps   { background: #cc5500; }
.wx-adv-type.apch  { background: #1a5c9a; }
.wx-adv-type.mea   { background: #2e7d32; }
```

### Step 3: Commit

- [ ] Run:

```bash
git add web/style.css
git commit -m "feat(notam): CSS for search bar, tier headers, map pill, new type badges"
```

---

## Task 8: SUA layer default on, version bump, build, install

**Files:**
- Modify: `web/shared/cockpit-config.js` (line ~27)
- Modify: `web/app.js` (FLYTAB_VERSION)

### Step 1: Add SUA to cockpit-config.js overlay defaults

- [ ] Find the `overlays` object in `CockpitConfig.DEFAULTS.map` in `web/shared/cockpit-config.js` (approximately line 22). It currently ends with:

```javascript
airways: { enabled: false, minZoom: 8 },
```

Add `sua` after it:

```javascript
airways: { enabled: false, minZoom: 8 },
sua:     { enabled: true  },
```

### Step 2: Increment FLYTAB_VERSION

- [ ] Open `web/app.js` and change `FLYTAB_VERSION`:

```javascript
const FLYTAB_VERSION = 'v8.76';
```

(Or whatever is one patch above the current version — check the current value first with `grep FLYTAB_VERSION web/app.js`.)

### Step 3: Build

- [ ] Run:

```bash
bash build.sh
```

Expected output ends with:
```
==============================
 Done!
 APK: flytab-debug-v8.76.apk
 Latest: /home/dananickerson/flytab/flytab-latest.apk → flytab-debug-v8.76.apk
==============================
```

### Step 4: Install on tablet

- [ ] Run:

```bash
adb -s 192.168.1.63:42781 install -r flytab-debug-v8.76.apk
```

Expected: `Performing Streamed Install` … `Success`

### Step 5: Verify on tablet

Open the WX Briefing panel with a route loaded and verify:

- [ ] **Tier headers** — "CRITICAL", "ROUTE", "AREA" section dividers appear
- [ ] **Sort order** — TFRs (if any) appear before runway NOTAMs; runway NOTAMs before obstacle NOTAMs
- [ ] **Search** — Type "KLKR"; only NOTAMs containing "KLKR" show. Clear with ✕; full list restores
- [ ] **Map pill** — Tap "▶ Map" on a runway NOTAM; panel closes, map flies to airport at zoom 12
- [ ] **SUA layer** — Map layer panel shows SUA (Restricted/MOA) toggle enabled by default
- [ ] **TFR on map** — If a TFR is in the list, verify a shape appears on the map (zoom out to confirm)

### Step 6: Commit

- [ ] Run:

```bash
git add web/shared/cockpit-config.js web/app.js android/app/build.gradle
git commit -m "feat(notam): SUA layer on by default; bump to v8.76"
```

---

## Self-Review Notes

**Spec coverage check:**
- ✅ Section 1 (tier sort): Tasks 5 + 6
- ✅ Section 2 (APCH/FISB/GPS/MEA types): Task 2
- ✅ Section 3 (unified list + search): Task 6
- ✅ Section 4 (map pill + notam:goto): Tasks 3 + 4 + 6
- ✅ Section 5 (TFR geometry + SUA default): Tasks 1 + 8
- ✅ Airport TFR dispatch to map (`notam:tfrs-apt`): Tasks 3 + 4

**Interface contract verification:**
- `_parseNotam(feature, airport, wpGeoMap)` — used only in `_fetchNotams()`; default `new Map()` means callers that don't pass it get `geo: null` safely
- `notam.geo` — set in `_parseNotam()` and in `_fetchEnrouteNotams()` push; `_buildNotamCard()` gates pill on truthiness
- `notam:goto` detail `{ lat, lon, zoom }` — dispatched by `_buildNotamCard()`, handled in `app.js`
- `notam:tfrs-apt` — same payload as `notam:tfrs`; same handler in `map.js`
- `_sortedNotams()` returns `[]` (not null) when data is loading; loading state is detected separately via `this._notams === null`
