# WX Briefing Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix METAR/TAF station order, add corridor width selector, fix AFD coverage, surface NOTAM auth errors, and add state labels to G-AIRMET cards.

**Architecture:** All changes in `web/cockpit/wx-briefing.js` and `web/style.css`. The existing `_distToNearestCoord` helper already does segment-projection distance in nm — no new geometry helpers needed. Corridor width drives both METAR bbox fetch and the existing 30 nm distance filter. AFD fix is a one-liner. NOTAM error surfacing threads a `_notamFetchError` string through fetch → render.

**Tech Stack:** Vanilla JS, no bundler. CSS in `web/style.css`. Build with `bash build.sh`.

---

## File Map

| File | Changes |
|------|---------|
| `web/app.js` | Bump `FLYTAB_VERSION` to `v6.52` |
| `web/cockpit/wx-briefing.js` | All logic changes (Tasks 1–7) |
| `web/style.css` | New styles for corridor chips and AIRMET state line |

---

### Task 1: Fix METAR/TAF station sort order

**Files:**
- Modify: `web/cockpit/wx-briefing.js:228-269`

The current sort uses `_distToNearestCoord` for both on-route and off-route stations, which returns ~0 for all route stations and produces unstable (often reversed) order. Fix: sort on-route stations by their index in the waypoints list, off-route by distance from the route line.

- [ ] **Step 1: Replace the sort block in `_renderMetarSection`**

Find these lines (starting around line 241):
```js
        const stations = this._getStationList();
        const allIcaos = Object.keys(this._metarData).filter(k => k !== '_error');
        const routeSet = new Set(stations);
        const coords = this._routeCoords || [];

        const sorted = [...allIcaos].sort((a, b) => {
            const aRoute = routeSet.has(a) ? 0 : 1;
            const bRoute = routeSet.has(b) ? 0 : 1;
            if (aRoute !== bRoute) return aRoute - bRoute;
            if (!coords.length) return 0;
            const distA = this._distToNearestCoord(this._metarData[a]?.lat, this._metarData[a]?.lon, coords);
            const distB = this._distToNearestCoord(this._metarData[b]?.lat, this._metarData[b]?.lon, coords);
            return distA - distB;
        });
```

Replace with:
```js
        const stations = this._getStationList();
        const allIcaos = Object.keys(this._metarData).filter(k => k !== '_error');
        const routeIndexMap = new Map(stations.map((id, i) => [id, i]));
        const coords = this._routeCoords || [];

        const sorted = [...allIcaos].sort((a, b) => {
            const aIdx = routeIndexMap.has(a) ? routeIndexMap.get(a) : Infinity;
            const bIdx = routeIndexMap.has(b) ? routeIndexMap.get(b) : Infinity;
            const aOnRoute = aIdx < Infinity, bOnRoute = bIdx < Infinity;
            if (aOnRoute !== bOnRoute) return aOnRoute ? -1 : 1;
            if (aOnRoute) return aIdx - bIdx;   // both on-route: preserve dep→dest order
            if (!coords.length) return 0;
            const distA = this._distToNearestCoord(this._metarData[a]?.lat, this._metarData[a]?.lon, coords);
            const distB = this._distToNearestCoord(this._metarData[b]?.lat, this._metarData[b]?.lon, coords);
            return distA - distB;
        });
```

- [ ] **Step 2: Verify the change visually**

Open WX Briefing with a route loaded (e.g. KLKR → KCLT). Confirm: departure airport card appears first, destination last, nearby off-route airports grouped below all route airports.

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "fix: METAR list order dep→dest, off-route airports below"
```

---

### Task 2: Add corridor width state + CSS

**Files:**
- Modify: `web/cockpit/wx-briefing.js:14-40` (constructor)
- Modify: `web/style.css` (append new rules)

- [ ] **Step 1: Add `_corridorMi` to the constructor**

Find the constructor body (around line 15–40). After `this._routeCoords = null;`, add:

```js
        const savedCorridor = parseInt(localStorage.getItem('flytab_wx_corridor'));
        this._corridorMi    = [10, 25, 50].includes(savedCorridor) ? savedCorridor : 25;
        this._notamFetchError = null;
```

- [ ] **Step 2: Reset `_notamFetchError` in `_refreshAll`**

Find `_refreshAll` (around line 86):
```js
    _refreshAll() {
        this._metarFetchedAt = this._airmetFetchedAt = this._afdFetchedAt =
            this._notamFetchedAt = this._enrouteNotamFetchedAt = 0;
        this._fetchMos();
        this._fetchColdSections();
    }
```

Replace with:
```js
    _refreshAll() {
        this._notamFetchError = null;
        this._metarFetchedAt = this._airmetFetchedAt = this._afdFetchedAt =
            this._notamFetchedAt = this._enrouteNotamFetchedAt = 0;
        this._fetchMos();
        this._fetchColdSections();
    }
```

- [ ] **Step 3: Add corridor chip CSS to `web/style.css`**

Append to the end of `web/style.css`:

```css
/* ── WxBriefing corridor width selector ── */
.wx-corridor-chips {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px 4px;
}
.wx-corridor-chips::before {
    content: 'Corridor:';
    font-size: 10px;
    font-weight: 700;
    color: #888;
    letter-spacing: 0.05em;
    margin-right: 4px;
    flex-shrink: 0;
}
.wx-corridor-chip {
    background: #f0f0f0;
    border: 1px solid #ccc;
    color: #444;
    font-size: 10px;
    font-weight: 700;
    padding: 3px 8px;
    cursor: pointer;
    border-radius: 3px;
    letter-spacing: 0.03em;
    min-height: 28px;
}
.wx-corridor-chip.active {
    background: #1a2744;
    color: #fff;
    border-color: #1a2744;
}

/* ── WxBriefing G-AIRMET state abbreviations ── */
.wx-adv-states {
    font-size: 10px;
    font-weight: 600;
    color: #888;
    letter-spacing: 0.04em;
    padding: 0 12px 4px;
}
```

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/wx-briefing.js web/style.css
git commit -m "feat: add corridor width state + CSS for chips and AIRMET states"
```

---

### Task 3: Render corridor chips above METAR list

**Files:**
- Modify: `web/cockpit/wx-briefing.js:228-269` (`_renderMetarSection`)

The chips need to appear above the station header and re-fetch when tapped.

- [ ] **Step 1: Add chips rendering at the start of `_renderMetarSection`**

Find the end of the METAR data/error guard block (around line 238), just before:
```js
        const stations = this._getStationList();
```

The full `_renderMetarSection` from line 228 currently starts with guards, then the sort block, then `sec.innerHTML = ...`. Rearrange so `sec.innerHTML = ''` is set first, then chips appended, then header and cards.

Replace the `sec.innerHTML = \`...\`` block (around line 257) and the `for` card loop:

```js
        const count = allIcaos.length;

        sec.innerHTML = '';

        // Corridor chip row
        const chips = document.createElement('div');
        chips.className = 'wx-corridor-chips';
        for (const mi of [10, 25, 50]) {
            const btn = document.createElement('button');
            btn.className = 'wx-corridor-chip' + (this._corridorMi === mi ? ' active' : '');
            btn.textContent = `${mi} mi`;
            btn.addEventListener('click', () => {
                if (this._corridorMi === mi) return;
                this._corridorMi = mi;
                localStorage.setItem('flytab_wx_corridor', String(mi));
                this._metarFetchedAt = 0;
                this._metarData = null;
                this._fetchMetarTaf();
            });
            chips.appendChild(btn);
        }
        sec.appendChild(chips);

        // Section header
        const hdrDiv = document.createElement('div');
        hdrDiv.className = 'wx-section-hdr';
        hdrDiv.innerHTML = `
            <span class="wx-section-hdr-title">METARs &amp; TAFs</span>
            <span class="wx-section-hdr-sub">${count} STATION${count !== 1 ? 'S' : ''}</span>
        `;
        sec.appendChild(hdrDiv);

        for (const icao of sorted) {
            const m = this._metarData[icao];
            if (!m) continue;
            sec.appendChild(this._buildStationCard(icao, m, routeIndexMap.has(icao)));
        }
```

Note: `routeSet` is no longer used — `routeIndexMap` replaced it in Task 1. Update the `_buildStationCard` call: the third argument (previously `routeSet.has(icao)`) is now `routeIndexMap.has(icao)`.

Also: the loading and error guard blocks at the top of `_renderMetarSection` render `sec.innerHTML = ...` and return early. Leave those unchanged — chips only render when data is present.

- [ ] **Step 2: Verify chips render and active state reflects `_corridorMi`**

Open WX Briefing. Confirm 3 chips appear above the METAR list with "25 mi" active by default. Tap "10 mi" — confirm it goes active and METARs re-fetch (loading spinner appears briefly).

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat: render corridor width chips above METAR list"
```

---

### Task 4: Wire corridor to METAR fetch

**Files:**
- Modify: `web/cockpit/wx-briefing.js:1134-1180` (`_fetchMetarTaf`)

Two hardcoded values to replace with `this._corridorMi`.

- [ ] **Step 1: Replace hardcoded 0.5 bbox buffer**

Find (around line 1144):
```js
            const bbox = await this._getRouteBbox(0.5);
```

Replace with:
```js
            const bbox = await this._getRouteBbox(this._corridorMi / 69);
```

- [ ] **Step 2: Replace hardcoded 30 nm distance cutoff**

Find (around line 1167):
```js
                    if (m?.lat && m?.lon && this._distToNearestCoord(m.lat, m.lon, coords) > 30)
```

Replace with:
```js
                    if (m?.lat && m?.lon && this._distToNearestCoord(m.lat, m.lon, coords) > this._corridorMi)
```

- [ ] **Step 3: Verify corridor filtering works**

With a route loaded, set corridor to 10 mi — confirm fewer stations appear in the METAR list. Set to 50 mi — confirm more stations appear, including airports further from the route.

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat: wire corridor width selector to METAR bbox + distance filter"
```

---

### Task 5: Wire corridor to AIRMET filter

**Files:**
- Modify: `web/cockpit/wx-briefing.js:1529-1554` (`_filterAdvisoriesForRoute`)

- [ ] **Step 1: Remove hardcoded `bufferDeg` parameter and derive from `_corridorMi`**

Find (line 1529):
```js
    _filterAdvisoriesForRoute(advisories, bufferDeg = 0.83) {
        const coords = this._routeCoords || [];
        if (!coords.length || !advisories?.length) return advisories || [];

        const routeLats = coords.map(c => c.lat);
        const routeLons = coords.map(c => c.lon);
        const bbox = {
            s: Math.min(...routeLats) - bufferDeg,
            n: Math.max(...routeLats) + bufferDeg,
            w: Math.min(...routeLons) - bufferDeg,
            e: Math.max(...routeLons) + bufferDeg,
        };
```

Replace with:
```js
    _filterAdvisoriesForRoute(advisories) {
        const bufferDeg = this._corridorMi / 69;
        const coords = this._routeCoords || [];
        if (!coords.length || !advisories?.length) return advisories || [];

        const routeLats = coords.map(c => c.lat);
        const routeLons = coords.map(c => c.lon);
        const bbox = {
            s: Math.min(...routeLats) - bufferDeg,
            n: Math.max(...routeLats) + bufferDeg,
            w: Math.min(...routeLons) - bufferDeg,
            e: Math.max(...routeLons) + bufferDeg,
        };
```

- [ ] **Step 2: Verify no callers pass a second argument**

Confirm the only two callers are at lines 279 and 1879, both calling `this._filterAdvisoriesForRoute(this._airmets)` with no second argument. No change needed to callers.

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat: wire corridor width to AIRMET route filter"
```

---

### Task 6: Fix AFD — query all route waypoints

**Files:**
- Modify: `web/cockpit/wx-briefing.js:1988-1991` (`_fetchAfds`)

- [ ] **Step 1: Replace dep/dest-only keyCoords with all coords**

Find (around line 1988):
```js
            const keyCoords = [];
            if (coords.length > 0) keyCoords.push(coords[0]);
            if (coords.length > 1) keyCoords.push(coords[coords.length - 1]);
```

Replace with:
```js
            const keyCoords = coords;
```

- [ ] **Step 2: Verify more AFDs appear on a long route**

Load a route with departure and destination in different NWS CWAs (e.g. KLKR to KBNA crosses GSP and MRX offices). Confirm 2+ AFD cards appear in the Fcst Discussions section.

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "fix: AFD fetch queries all route waypoints, not just dep/dest"
```

---

### Task 7: NOTAM fetch error surfacing

**Files:**
- Modify: `web/cockpit/wx-briefing.js:1632-1687` (`_fetchNotams`)
- Modify: `web/cockpit/wx-briefing.js:1689-1753` (`_fetchEnrouteNotams`)
- Modify: `web/cockpit/wx-briefing.js:382-446` (`_renderNotamSection`)

- [ ] **Step 1: Update `_fetchNotams` to capture the error body**

Find inside `_fetchNotams` (around line 1642):
```js
            const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) throw new Error(`NOTAM proxy ${resp.status}`);
```

Replace with:
```js
            const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) {
                let errMsg = `NOTAM fetch failed (${resp.status})`;
                try { const d = await resp.json(); if (d.error) errMsg = d.error; } catch (_) {}
                throw new Error(errMsg);
            }
```

- [ ] **Step 2: Set `_notamFetchError` in the `_fetchNotams` catch block**

Find the catch block inside `_fetchNotams` (around line 1676):
```js
        } catch (err) {
            console.error('NOTAM fetch failed:', err);
            try {
                const raw = localStorage.getItem('flytab_notam_cache');
                if (raw) { const c = JSON.parse(raw); this._notams = c.data || []; }
                else this._notams = [];
            } catch (_) { this._notams = []; }
        }
```

Replace with:
```js
        } catch (err) {
            console.error('NOTAM fetch failed:', err);
            this._notamFetchError = err.message;
            try {
                const raw = localStorage.getItem('flytab_notam_cache');
                if (raw) { const c = JSON.parse(raw); this._notams = c.data || []; }
                else this._notams = [];
            } catch (_) { this._notams = []; }
        }
```

- [ ] **Step 3: Apply the same two changes to `_fetchEnrouteNotams`**

Find inside `_fetchEnrouteNotams` (around line 1704):
```js
            const resp = await fetch(`${base}/notams?location=${locations}`, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) throw new Error(`En-route NOTAM proxy ${resp.status}`);
```

Replace with:
```js
            const resp = await fetch(`${base}/notams?location=${locations}`, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) {
                let errMsg = `En-route NOTAM fetch failed (${resp.status})`;
                try { const d = await resp.json(); if (d.error) errMsg = d.error; } catch (_) {}
                throw new Error(errMsg);
            }
```

Find the catch block inside `_fetchEnrouteNotams` (around line 1747):
```js
        } catch (err) {
            console.error('En-route NOTAM fetch failed:', err);
            this._enrouteNotams = [];
        }
```

Replace with:
```js
        } catch (err) {
            console.error('En-route NOTAM fetch failed:', err);
            this._notamFetchError = err.message;
            this._enrouteNotams = [];
        }
```

- [ ] **Step 4: Update `_renderNotamSection` badge + error body**

In `_renderNotamSection`, find the badge variables (around line 392):
```js
        const allNotams = [...(this._notams || []), ...(this._enrouteNotams || [])];
        const critical = allNotams.filter(n => ['RWY', 'NAVAID', 'TFR', 'RESTR'].includes(n.type));
        const badgeClass = loading ? null : (critical.length > 0 ? 'warn' : allNotams.length > 0 ? 'info' : 'ok');
        const badgeText  = loading
            ? 'Fetching…'
            : (critical.length > 0 ? `${critical.length} CRITICAL` : allNotams.length > 0 ? `${allNotams.length} ACTIVE` : 'NONE');
```

Replace with:
```js
        const allNotams = [...(this._notams || []), ...(this._enrouteNotams || [])];
        const critical = allNotams.filter(n => ['RWY', 'NAVAID', 'TFR', 'RESTR'].includes(n.type));
        const fetchErr = !loading && this._notamFetchError && !allNotams.length;
        const badgeClass = loading ? null : fetchErr ? 'warn' : (critical.length > 0 ? 'warn' : allNotams.length > 0 ? 'info' : 'ok');
        const badgeText  = loading
            ? 'Fetching…'
            : fetchErr
            ? 'UNAVAIL'
            : (critical.length > 0 ? `${critical.length} CRITICAL` : allNotams.length > 0 ? `${allNotams.length} ACTIVE` : 'NONE');
```

Then find the `const body = document.createElement('div');` line (around line 401) and insert an error check right after the body is created and before the AIRPORT group header:

Find:
```js
        const body = document.createElement('div');
        body.className = 'wx-rhs-body open';

        // ── Airport NOTAMs ────────────────────────────────────────────────────
        const aptGrpHdr = document.createElement('div');
```

Replace with:
```js
        const body = document.createElement('div');
        body.className = 'wx-rhs-body open';

        if (fetchErr) {
            body.insertAdjacentHTML('beforeend',
                `<div class="wx-section-error">⚠ ${this._escHtml(this._notamFetchError)} · tap ↻ to retry</div>`);
            sec.appendChild(body);
            return;
        }

        // ── Airport NOTAMs ────────────────────────────────────────────────────
        const aptGrpHdr = document.createElement('div');
```

- [ ] **Step 5: Verify error state renders correctly**

With the current broken proxy, open WX Briefing. The NOTAMs section should now show the "UNAVAIL" badge in the header and "⚠ CGI auth failed: 401 · tap ↻ to retry" in the body, instead of "NONE."

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "fix: surface NOTAM proxy auth error instead of silently showing NONE"
```

---

### Task 8: G-AIRMET state abbreviations

**Files:**
- Modify: `web/cockpit/wx-briefing.js:1512-1527` (`_fetchAirmets`)
- Modify: `web/cockpit/wx-briefing.js:307-342` (`_buildGairmetCard`)
- Add method `_statesForPoints` to `wx-briefing.js`

- [ ] **Step 1: Add `_statesForPoints` method**

Add this method after `_filterAdvisoriesForRoute` (around line 1555):

```js
    _statesForPoints(points) {
        if (!points.length) return [];
        const lats = points.map(p => p[0]);
        const lons = points.map(p => p[1]);
        const cLat = lats.reduce((s, v) => s + v, 0) / lats.length;
        const cLon = lons.reduce((s, v) => s + v, 0) / lons.length;
        // Sample centroid + midpoints toward bbox edges to catch multi-state advisories
        const samples = [
            [cLat, cLon],
            [(Math.min(...lats) + cLat) / 2, cLon],
            [(Math.max(...lats) + cLat) / 2, cLon],
            [cLat, (Math.min(...lons) + cLon) / 2],
            [cLat, (Math.max(...lons) + cLon) / 2],
        ];
        // [abbr, minLat, maxLat, minLon, maxLon]
        const STATES = [
            ['AL',30.1,35.0,-88.5,-84.9],['AR',33.0,36.5,-94.6,-89.6],
            ['AZ',31.3,37.0,-114.8,-109.0],['CA',32.5,42.0,-124.5,-114.1],
            ['CO',37.0,41.0,-109.1,-102.0],['CT',41.0,42.1,-73.7,-71.8],
            ['DE',38.4,39.8,-75.8,-75.0],['FL',24.4,31.0,-87.6,-80.0],
            ['GA',30.3,35.0,-85.6,-80.8],['IA',40.4,43.5,-96.6,-90.1],
            ['ID',42.0,49.0,-117.2,-111.0],['IL',36.9,42.5,-91.5,-87.0],
            ['IN',37.8,41.8,-88.1,-84.8],['KS',37.0,40.0,-102.1,-94.6],
            ['KY',36.5,39.1,-89.6,-81.9],['LA',29.0,33.0,-94.0,-89.0],
            ['MA',41.2,42.9,-73.5,-69.9],['MD',37.9,39.7,-79.5,-75.0],
            ['ME',43.1,47.5,-71.1,-67.0],['MI',41.7,47.5,-90.4,-82.4],
            ['MN',43.5,49.4,-97.2,-89.5],['MO',36.0,40.6,-95.8,-89.1],
            ['MS',30.2,35.0,-91.7,-88.1],['MT',44.4,49.0,-116.0,-104.0],
            ['NC',33.8,36.6,-84.3,-75.5],['ND',45.9,49.0,-104.1,-96.6],
            ['NE',40.0,43.0,-104.1,-95.3],['NH',42.7,45.3,-72.6,-70.6],
            ['NJ',38.9,41.4,-75.6,-73.9],['NM',31.3,37.0,-109.1,-103.0],
            ['NV',35.0,42.0,-120.0,-114.0],['NY',40.5,45.0,-79.8,-71.9],
            ['OH',38.4,42.3,-84.8,-80.5],['OK',33.6,37.0,-103.0,-94.4],
            ['OR',42.0,46.2,-124.6,-116.5],['PA',39.7,42.3,-80.5,-74.7],
            ['RI',41.1,42.0,-71.9,-71.1],['SC',32.0,35.2,-83.4,-78.6],
            ['SD',42.5,45.9,-104.1,-96.4],['TN',35.0,36.7,-90.3,-81.6],
            ['TX',25.8,36.5,-106.6,-93.5],['UT',37.0,42.0,-114.1,-109.0],
            ['VA',36.5,39.5,-83.7,-75.2],['VT',42.7,45.0,-73.4,-71.5],
            ['WA',45.5,49.0,-124.8,-116.9],['WI',42.5,47.1,-92.9,-86.2],
            ['WV',37.2,40.6,-82.6,-77.7],['WY',41.0,45.0,-111.1,-104.1],
        ];
        const found = new Set();
        for (const [sLat, sLon] of samples) {
            for (const [abbr, s, n, w, e] of STATES) {
                if (sLat >= s && sLat <= n && sLon >= w && sLon <= e) found.add(abbr);
            }
        }
        return [...found].sort();
    }
```

- [ ] **Step 2: Wire state derivation into `_fetchAirmets`**

Find `_fetchAirmets` (around line 1512):
```js
    async _fetchAirmets() {
        this._airmets = null;
        this._renderAirmetSection();
        try {
            const client = new WeatherClient(this._db);
            const { airmets } = await client.fetchAndCacheAdvisories();
            this._airmets = airmets;
            this._airmetFetchedAt = Date.now();
```

Replace the `this._airmets = airmets;` line with:
```js
            for (const adv of (airmets || [])) {
                adv.states = this._statesForPoints(adv.points || []);
            }
            this._airmets = airmets;
            this._airmetFetchedAt = Date.now();
```

- [ ] **Step 3: Display states in `_buildGairmetCard`**

Find in `_buildGairmetCard` (around line 313):
```js
        const altBand  = formatAdvisoryAltBand(adv);
```

After that line, add:
```js
        const statesStr = adv.states?.length ? adv.states.join(' · ') : '';
```

Then find the card innerHTML (around line 329):
```js
                <div class="wx-adv-info">
                    <div class="wx-adv-hazard">${this._escHtml(hazard)}</div>
                    <div class="wx-adv-alt">${this._escHtml(altBand)}</div>
                </div>
```

Replace with:
```js
                <div class="wx-adv-info">
                    <div class="wx-adv-hazard">${this._escHtml(hazard)}</div>
                    <div class="wx-adv-alt">${this._escHtml(altBand)}</div>
                    ${statesStr ? `<div class="wx-adv-states">${this._escHtml(statesStr)}</div>` : ''}
                </div>
```

- [ ] **Step 4: Verify state labels appear on AIRMET cards**

Open WX Briefing when G-AIRMETs are active. Confirm each AIRMET card shows a grey state abbreviation line (e.g. "NC · SC · VA") below the altitude band. Confirm FRZLVL and other types also show states correctly.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat: add state abbreviations to G-AIRMET cards"
```

---

### Task 9: Version bump and build

**Files:**
- Modify: `web/app.js:1` (version)

- [ ] **Step 1: Bump version**

In `web/app.js`, change:
```js
const FLYTAB_VERSION = 'v6.51';
```
to:
```js
const FLYTAB_VERSION = 'v6.52';
```

- [ ] **Step 2: Build**

```bash
bash build.sh
```

Expected: build completes, APK copied to `data/`. No errors.

- [ ] **Step 3: Commit**

```bash
git add web/app.js android/app/build.gradle
git commit -m "build: v6.52 — WX briefing corridor selector, sort fix, AFD all-waypoints, NOTAM error surfacing, AIRMET states"
```
