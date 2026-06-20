# NOTAM Relevance Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface operationally relevant NOTAMs first by using the CGI Q-code for smarter classification, filtering to the active flight time window, and collapsing low-priority obstacle light outages by default.

**Architecture:** All changes are in `web/cockpit/wx-briefing.js`. A new `_classifyByQcode()` method reads the NOTAM's `selectionCode` field (already returned by the proxy) and maps it to a type, with the existing text-based `_classifyNotam()` kept as fallback. Two new methods `_getFlightWindow()` / `_filterByFlightWindow()` compute ETD/ETA from the flight plan and filter NOTAMs at render time. `_renderNotamSection()` is updated to split airport NOTAMs into priority and collapsible light-outage groups.

**Tech Stack:** Vanilla JS, existing `wireTap` tap utility, existing CSS variables

---

### Task 1: Q-code classifier and sort order

**Files:**
- Modify: `web/cockpit/wx-briefing.js` — `_parseNotam`, `_classifyNotam`, add `_classifyByQcode`, update sort in `_fetchNotams`

The CGI API returns `selectionCode` (e.g. `QOLAS`, `QPICH`, `QMRLC`) on every NOTAM. We use it as the primary classifier and fall back to text matching only when the code is absent.

Q-code prefix mapping:
- `QMR*` → `RWY` (runway closed/limited)
- `QNV*` or `QPI*` → `NAVAID` (navaid U/S or approach procedure change — both affect approaches)
- `QOL*` → `OBST_LGT` (obstacle lights only — new low-priority type)
- `QOB*` → `OBST` (physical obstacle, not just lights)
- `QTW*` → `TWY` (taxiway)
- `QFA*` or `QAP*` → `AD` (aerodrome/apron)
- anything else → `null` (falls through to text classifier)

- [ ] **Step 1: Add `_classifyByQcode` just before `_classifyNotam`**

In `web/cockpit/wx-briefing.js`, find `_classifyNotam(raw) {` (currently around line 1963) and insert the new method immediately before it:

```javascript
_classifyByQcode(q) {
    if (!q) return null;
    q = q.toUpperCase();
    if (q.startsWith('QMR')) return 'RWY';
    if (q.startsWith('QNV') || q.startsWith('QPI')) return 'NAVAID';
    if (q.startsWith('QOL')) return 'OBST_LGT';
    if (q.startsWith('QOB')) return 'OBST';
    if (q.startsWith('QTW')) return 'TWY';
    if (q.startsWith('QFA') || q.startsWith('QAP')) return 'AD';
    return null;
}
```

- [ ] **Step 2: Update `_parseNotam` to use Q-code first**

Replace the existing `_parseNotam` method:

```javascript
_parseNotam(feature, airport) {
    const n = feature.properties?.coreNOTAMData?.notam || {};
    const translations = feature.properties?.coreNOTAMData?.notamTranslation || [];
    const localFmt = translations.find(t => t.type === 'LOCAL_FORMAT');
    const raw = localFmt?.simpleText || localFmt?.domestic_message || n.text || '';
    const type = this._classifyByQcode(n.selectionCode) || this._classifyNotam(raw);
    const summary = this._summarizeNotam(raw);
    return { airport, type, summary, raw, validFrom: n.effectiveStart || null, validTo: n.effectiveEnd || null };
}
```

- [ ] **Step 3: Update sort order in `_fetchNotams` to put `OBST_LGT` last**

Find this line in `_fetchNotams` (around line 1798):
```javascript
const order = ['RWY', 'NAVAID', 'OBST', 'TWY', 'AD', 'SVC'];
```
Replace with:
```javascript
const order = ['RWY', 'NAVAID', 'OBST', 'TWY', 'AD', 'SVC', 'OBST_LGT'];
```

- [ ] **Step 4: Update `typeClass` mapping in `_renderNotamSection` to handle `OBST_LGT`**

Find this line in `_renderNotamSection` (inside the airport NOTAM loop, around line 469):
```javascript
const typeClass = (notam.type === 'RWY' || notam.type === 'NAVAID') ? 'rwy' : notam.type.toLowerCase();
```
Replace with:
```javascript
const typeClass = (notam.type === 'RWY' || notam.type === 'NAVAID') ? 'rwy'
    : notam.type === 'OBST_LGT' ? 'obst'
    : notam.type.toLowerCase();
```

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat(notams): Q-code classifier — OBST_LGT type, IAP elevated to NAVAID priority"
```

---

### Task 2: Flight window filter

**Files:**
- Modify: `web/cockpit/wx-briefing.js` — add `_getFlightWindow`, `_filterByFlightWindow`; update `_renderNotamSection`

ETD comes from `flightPlan.filed_plan.proposed_departure` (ISO string, often null). When null, use `Date.now()` (i.e. "flying now"). ETA is ETD + sum of `flight_plan.legs[].ete_min` minutes. When no legs are computed yet, use a 4-hour default window — conservative enough to keep nearly all relevant NOTAMs.

A NOTAM is kept when its validity window overlaps the flight window: `validFrom ≤ ETA && validTo ≥ ETD`. NOTAMs with no `validFrom` are treated as starting at epoch 0 (always started). NOTAMs with no `validTo` (permanent) are treated as `Infinity` (never expires).

- [ ] **Step 1: Add `_getFlightWindow` and `_filterByFlightWindow` after `_getStationList`**

Find the line `_getStationList() {` (around line 1004). Add the two new methods immediately after the closing `}` of `_getStationList`:

```javascript
_getFlightWindow() {
    const plan = this._flightPlan;
    if (!plan) return null;
    const proposed = plan.filed_plan?.proposed_departure;
    const etdMs = proposed ? new Date(proposed).getTime() : Date.now();
    const legs = plan.flight_plan?.legs || [];
    const eteTotalMin = legs.reduce((s, l) => s + (l.ete_min || 0), 0);
    const etaMs = etdMs + (eteTotalMin > 0 ? eteTotalMin : 240) * 60000;
    return { etd: etdMs, eta: etaMs };
}

_filterByFlightWindow(notams) {
    const win = this._getFlightWindow();
    if (!win) return notams;
    return notams.filter(n => {
        const from = n.validFrom ? new Date(n.validFrom).getTime() : 0;
        const to   = n.validTo   ? new Date(n.validTo).getTime()   : Infinity;
        return from <= win.eta && to >= win.etd;
    });
}
```

- [ ] **Step 2: Apply filter at the top of `_renderNotamSection` and use filtered arrays throughout**

In `_renderNotamSection`, replace the current allNotams/critical computation block:

Current (around lines 426–436):
```javascript
const allNotams = [...(this._notams || []), ...(this._enrouteNotams || [])];
const critical = allNotams.filter(n => ['RWY', 'NAVAID', 'TFR', 'RESTR'].includes(n.type));
const fetchErr = !loading && this._notamFetchError && !allNotams.length;
const fetchErrWithCache = !loading && this._notamFetchError && allNotams.length > 0;
const anyErr = fetchErr || fetchErrWithCache || (!loading && this._enrouteNotamFetchError);
const badgeClass = loading ? null : (fetchErr ? 'warn' : anyErr ? 'warn' : critical.length > 0 ? 'warn' : allNotams.length > 0 ? 'info' : 'ok');
const badgeText  = loading
    ? 'Fetching…'
    : (anyErr && !allNotams.length)
    ? 'UNAVAIL'
    : (critical.length > 0 ? `${critical.length} CRITICAL` : allNotams.length > 0 ? `${allNotams.length} ACTIVE` : 'NONE');
```

Replace with:
```javascript
const filteredApt = airportLoading  ? [] : this._filterByFlightWindow(this._notams);
const filteredEnr = enrouteLoading  ? [] : this._filterByFlightWindow(this._enrouteNotams);
const allNotams = [...filteredApt, ...filteredEnr];
const critical = allNotams.filter(n => ['RWY', 'NAVAID', 'TFR', 'RESTR'].includes(n.type));
const fetchErr = !loading && this._notamFetchError && !allNotams.length;
const fetchErrWithCache = !loading && this._notamFetchError && allNotams.length > 0;
const anyErr = fetchErr || fetchErrWithCache || (!loading && this._enrouteNotamFetchError);
const badgeClass = loading ? null : (fetchErr ? 'warn' : anyErr ? 'warn' : critical.length > 0 ? 'warn' : allNotams.length > 0 ? 'info' : 'ok');
const badgeText  = loading
    ? 'Fetching…'
    : (anyErr && !allNotams.length)
    ? 'UNAVAIL'
    : (critical.length > 0 ? `${critical.length} CRITICAL` : allNotams.length > 0 ? `${allNotams.length} ACTIVE` : 'NONE');
```

- [ ] **Step 3: Replace `this._notams` with `filteredApt` in the airport render block**

In the airport NOTAM render section, replace:
```javascript
        } else if (!this._notams.length) {
            body.insertAdjacentHTML('beforeend', '<div class="wx-section-empty">No active NOTAMs for route airports.</div>');
        } else {
            for (const notam of this._notams) {
```
With:
```javascript
        } else if (!filteredApt.length) {
            body.insertAdjacentHTML('beforeend', '<div class="wx-section-empty">No active NOTAMs for route airports.</div>');
        } else {
            for (const notam of filteredApt) {
```

- [ ] **Step 4: Replace `this._enrouteNotams` with `filteredEnr` in the en-route render block**

In the en-route NOTAM render section, replace:
```javascript
        } else if (!this._enrouteNotams.length) {
            body.insertAdjacentHTML('beforeend', '<div class="wx-section-empty">No TFRs, MOAs, or restricted areas on route.</div>');
        } else {
            for (const notam of this._enrouteNotams) {
```
With:
```javascript
        } else if (!filteredEnr.length) {
            body.insertAdjacentHTML('beforeend', '<div class="wx-section-empty">No TFRs, MOAs, or restricted areas on route.</div>');
        } else {
            for (const notam of filteredEnr) {
```

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat(notams): filter to flight window (ETD→ETA from filed plan, now+4h default)"
```

---

### Task 3: Collapsible obstacle light outages

**Files:**
- Modify: `web/cockpit/wx-briefing.js` — airport NOTAM render block in `_renderNotamSection`
- Modify: `web/style.css` — add `.wx-notam-lights-toggle` rule

- [ ] **Step 1: Add CSS for the collapse toggle row in `web/style.css`**

Find `.wx-notam-group-hdr:first-child { border-top: none; margin-top: 0; }` (around line 8268) and add immediately after:

```css
.wx-notam-lights-toggle {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 14px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    border-top: 1px solid var(--border);
    user-select: none;
}
.wx-notam-lights-toggle:active { background: var(--hover-bg, rgba(0,0,0,0.05)); }
```

- [ ] **Step 2: Split airport NOTAM render into priority + lights**

In `_renderNotamSection`, find the airport NOTAM `else` block (after the loading/empty guards). It currently iterates over `filteredApt` and renders each card. Replace the entire airport `else` block with:

```javascript
        } else {
            const priorityNotams = filteredApt.filter(n => n.type !== 'OBST_LGT');
            const lightNotams    = filteredApt.filter(n => n.type === 'OBST_LGT');

            if (!priorityNotams.length && !lightNotams.length) {
                body.insertAdjacentHTML('beforeend', '<div class="wx-section-empty">No active NOTAMs for route airports.</div>');
            }

            for (const notam of priorityNotams) {
                const typeClass = (notam.type === 'RWY' || notam.type === 'NAVAID') ? 'rwy'
                    : notam.type === 'OBST_LGT' ? 'obst'
                    : notam.type.toLowerCase();
                const validStr = notam.validTo
                    ? `Valid to <b>${new Date(notam.validTo).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} L</b>`
                    : '';
                body.appendChild(this._buildAdvCard(notam.type, typeClass, `${notam.airport} · ${notam.summary}`, notam.airport, notam.raw, validStr));
            }

            if (lightNotams.length > 0) {
                const count = lightNotams.length;
                const toggle = document.createElement('div');
                toggle.className = 'wx-notam-lights-toggle';
                toggle.innerHTML = `<span>${count} obstacle light outage${count > 1 ? 's' : ''}</span><span>▶</span>`;

                const lightsBody = document.createElement('div');
                lightsBody.style.display = 'none';
                for (const notam of lightNotams) {
                    const validStr = notam.validTo
                        ? `Valid to <b>${new Date(notam.validTo).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} L</b>`
                        : '';
                    lightsBody.appendChild(this._buildAdvCard(notam.type, 'obst', `${notam.airport} · ${notam.summary}`, notam.airport, notam.raw, validStr));
                }

                wireTap(toggle, () => {
                    const open = lightsBody.style.display !== 'none';
                    lightsBody.style.display = open ? 'none' : 'block';
                    toggle.querySelector('span:last-child').textContent = open ? '▶' : '▼';
                });

                body.appendChild(toggle);
                body.appendChild(lightsBody);
            }
        }
```

Note: Also remove the old `typeClass` line that was in the `for (const notam of filteredApt)` loop from Task 2 Step 3 — the `else` block is now entirely replaced above.

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/wx-briefing.js web/style.css
git commit -m "feat(notams): collapse obstacle light outages by default"
```

---

### Task 4: Version bump and build

**Files:**
- Modify: `web/app.js` — version

- [ ] **Step 1: Increment FLYTAB_VERSION in `web/app.js`**

```javascript
const FLYTAB_VERSION = 'v8.34';
```

- [ ] **Step 2: Build**

```bash
bash build.sh
```

Expected: `APK: flytab-debug-v8.34.apk`

- [ ] **Step 3: Commit**

```bash
git add web/app.js
git commit -m "build: v8.34 — NOTAM Q-code classifier, flight window filter, collapsible lights"
```
