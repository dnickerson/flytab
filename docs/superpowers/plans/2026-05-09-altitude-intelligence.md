# Altitude Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an altitude optimizer table to the route planner settings popup (Feature A), a mixing-height column sourced from MOS weather (Feature C), and MEA labels on airway pills (Feature B).

**Architecture:** All three features live in `web/cockpit/route-planner-panel.js`. Feature A computes ETE/GS/fuel at five FD altitudes using the existing `recomputeLegs()` and renders the table inline in the settings popup. Feature C fetches MOS from the flywhere.app proxy (same endpoint as wx-briefing) and adds a MIX HT column to that table. Feature B reads MEA from NASR airways already in IndexedDB and adds a small label inside each airway pill, highlighting in orange when planned altitude < MEA.

**Tech Stack:** Vanilla JS, no bundler. IndexedDB via `this._nasrDb`. Fetch to `Settings.workerBase`. Leaflet not involved. Build: `bash build.sh`.

---

## File Map

| File | What changes |
|------|-------------|
| `web/cockpit/route-planner-panel.js` | New fields, new methods, edits to `_buildSettingsPopup()`, `_openSettingsPopup()`, `_altSel` change handler, `_applyWindsToLastPlan()`, `_buildPill()`, `_renderPills()` |
| `web/style.css` | New rules: `.rpp-opt-*` (optimizer table), `.rpp-pill-mea`, `.rpp-pill-mea-warn` |
| `web/app.js` | Version bump |

---

## Task 1: Feature A — Optimizer state + `_computeAltComparison()`

**Files:**
- Modify: `web/cockpit/route-planner-panel.js`

- [ ] **Add new instance fields to the constructor** (after `this._lastWinds = null;` at ~line 84)

```javascript
this._optTableEl = null;  // optimizer table container div
this._lastMos    = null;  // MOS data for mixing height (Feature C)
this._meaEpoch   = 0;     // stale-fetch guard for _fetchRouteMea (Feature B)
```

- [ ] **Add `_computeAltComparison()` method** (place before `_buildSettingsPopup()`)

```javascript
_computeAltComparison() {
    const ALTS = [3000, 6000, 9000, 12000, 18000];
    const CEILING_FT = 14000;
    if (!this._lastPlan || !this._lastPlan.waypoints || this._lastPlan.waypoints.length < 2) return [];
    const rows = [];
    for (const altFt of ALTS) {
        if (altFt > CEILING_FT) {
            rows.push({ altFt, aboveCeiling: true });
            continue;
        }
        const result = this._planner.recomputeLegs(this._lastPlan, null, {
            cruiseAltFt: altFt,
            winds:       this._lastWinds ?? undefined,
            pctPower:    this._pctPower,
        });
        const s = result.summary;
        const gsKt = s.totalEteHrs > 0 ? Math.round(s.totalDistNm / s.totalEteHrs) : 0;
        rows.push({ altFt, eteHrs: s.totalEteHrs, gsKt, fuelGal: s.totalFuelGal, aboveCeiling: false });
    }
    const validRows = rows.filter(r => !r.aboveCeiling);
    if (validRows.length) {
        const best = validRows.reduce((a, b) => a.eteHrs < b.eteHrs ? a : b);
        best.isOptimal = true;
    }
    return rows;
}
```

- [ ] **Verify `recomputeLegs` returns `summary`** — open `web/shared/planning/planner/route-planner.js` and confirm the return value includes `{ ...plan, legs, summary }`. If the shape differs, update the field access above before continuing.

---

## Task 2: Feature A — DOM container + `_renderOptTable()` + CSS

**Files:**
- Modify: `web/cockpit/route-planner-panel.js`
- Modify: `web/style.css`

- [ ] **In `_buildSettingsPopup()`, insert the optimizer table container** immediately after `popup.appendChild(mkRow('Power', this._pwrSel));` (~line 634):

```javascript
        this._optTableEl = document.createElement('div');
        this._optTableEl.className = 'rpp-opt-table';
        popup.appendChild(this._optTableEl);
```

- [ ] **Add `_renderOptTable()` method** (place after `_computeAltComparison()`):

```javascript
_renderOptTable() {
    if (!this._optTableEl) return;
    const rows = this._computeAltComparison();
    if (!rows.length) {
        this._optTableEl.innerHTML = '<div class="rpp-opt-empty">Plan a route to see altitude comparison</div>';
        return;
    }

    const mixHt = this._getMixHt ? this._getMixHt(this._departureTime ?? new Date()) : null;
    const hasMix = mixHt !== null;
    this._optTableEl.classList.toggle('rpp-opt-has-mix', hasMix);

    const windsOk = !!this._lastWinds;
    const calNote = windsOk ? null
        : this._fetchingWinds ? 'calm-air \xb7 winds loading…'
        : 'calm-air \xb7 no wind data';

    const fmtEte = (hrs) => {
        const h = Math.floor(hrs);
        const m = Math.round((hrs - h) * 60);
        return `${h}:${String(m).padStart(2, '0')}`;
    };

    let html = '<div class="rpp-opt-header">';
    html += '<span>ALT</span><span>ETE</span><span>GS</span><span>GAL</span>';
    if (hasMix) html += '<span>MIX</span>';
    html += '</div>';

    for (const row of rows) {
        const isSel = this._cruiseAltFt === row.altFt;
        let cls = 'rpp-opt-row';
        if (isSel)         cls += ' rpp-opt-selected';
        if (row.isOptimal) cls += ' rpp-opt-best';
        if (row.aboveCeiling) cls += ' rpp-opt-dim';
        html += `<div class="${cls}" data-alt="${row.altFt}">`;
        html += `<span class="rpp-opt-alt">${row.altFt.toLocaleString()}</span>`;
        if (row.aboveCeiling) {
            html += '<span>—</span><span>—</span><span>—</span>';
            if (hasMix) html += '<span>—</span>';
        } else {
            html += `<span class="rpp-opt-ete">${fmtEte(row.eteHrs)}${row.isOptimal ? ' ★' : ''}</span>`;
            html += `<span class="rpp-opt-gs">${row.gsKt}</span>`;
            html += `<span class="rpp-opt-gal">${row.fuelGal.toFixed(1)}</span>`;
            if (hasMix) {
                if (row.altFt > mixHt) {
                    html += '<span class="rpp-opt-mix-ok">✓ above</span>';
                } else {
                    html += '<span class="rpp-opt-mix-warn">⚠ in BL</span>';
                }
            }
        }
        html += '</div>';
    }

    const noteParts = [];
    if (calNote) noteParts.push(calNote);
    if (hasMix && this._lastMos?.fetched_at) {
        const stations = Object.keys(this._lastMos.stations).slice(0, 3).join(', ');
        noteParts.push(`mix ht ~${mixHt.toLocaleString()} ft (${stations})`);
    }
    if (noteParts.length) {
        html += `<div class="rpp-opt-note">${noteParts.join(' \xb7 ')}</div>`;
    }

    this._optTableEl.innerHTML = html;
}
```

- [ ] **Add CSS for the optimizer table** — append to `web/style.css` after the `.rpp-stat-fuel` block:

```css
/* ── Altitude Optimizer Table ── */
.rpp-opt-table {
    margin-top: 10px;
    background: #1a1a2e;
    border-radius: 6px;
    padding: 8px 10px;
    font-family: monospace;
    font-size: 0.85em;
    color: #ccc;
}
.rpp-opt-header,
.rpp-opt-row {
    display: grid;
    grid-template-columns: 70px 1fr 48px 48px;
    gap: 0 4px;
}
.rpp-opt-has-mix .rpp-opt-header,
.rpp-opt-has-mix .rpp-opt-row {
    grid-template-columns: 68px 1fr 44px 44px 62px;
}
.rpp-opt-header {
    color: #777;
    font-size: 0.8em;
    border-bottom: 1px solid #333;
    padding-bottom: 4px;
    margin-bottom: 4px;
}
.rpp-opt-row {
    padding: 5px 6px;
    border-radius: 4px;
    border-left: 3px solid transparent;
}
.rpp-opt-row.rpp-opt-selected {
    background: #1e3a6e;
    border-left-color: #5588ff;
    color: #88aaff;
    font-weight: 600;
}
.rpp-opt-row.rpp-opt-dim {
    color: #555;
}
.rpp-opt-mix-ok  { color: #4f8; }
.rpp-opt-mix-warn { color: #f84; }
.rpp-opt-empty,
.rpp-opt-note {
    color: #777;
    font-size: 0.8em;
    text-align: center;
    padding: 6px 0 2px;
}
```

---

## Task 3: Feature A — Wire popup open + live update triggers

**Files:**
- Modify: `web/cockpit/route-planner-panel.js`

- [ ] **In `_openSettingsPopup()`, call `_renderOptTable()` at the end** (after the last `if (this._altInput)` sync line, ~line 747):

```javascript
        this._renderOptTable();
```

- [ ] **In the `_altSel` change handler** (~line 617), add a `_renderOptTable()` call after `_updateSummaryBar()`:

The existing handler looks like:
```javascript
        this._altSel.addEventListener('change', () => {
            this._cruiseAltFt = this._altSel.value ? parseInt(this._altSel.value, 10) : null;
            this._saveOpts();
            this._updateSummaryBar();
            if (this._lastPlan) this._windsPromise = (this._windsPromise || Promise.resolve()).then(() => this._applyWindsToLastPlan());
        });
```

Add one line after `_updateSummaryBar()`:
```javascript
            this._renderOptTable();
```

- [ ] **In `_applyWindsToLastPlan()`, trigger a table refresh when popup is open** — find the line `this._renderWindWarnings();` at the end of `_applyWindsToLastPlan()` (~line 1731) and add after it:

```javascript
        if (this._popupOverlay?.classList.contains('open')) this._renderOptTable();
```

- [ ] **Commit Feature A so far:**

```bash
git add web/cockpit/route-planner-panel.js web/style.css
git commit -m "feat(planner): altitude optimizer table in settings popup (Feature A)"
```

---

## Task 4: Feature A — Build and visual verify

**Files:**
- Modify: `web/app.js`

- [ ] **Bump version in `web/app.js`** — find `const FLYTAB_VERSION = 'v7.76';` and change to `'v7.77'`

- [ ] **Build:**

```bash
bash build.sh
```

Expected: `BUILD SUCCESSFUL`. APK at `data/flytab-debug-v7.77.apk`.

- [ ] **Verify on tablet or browser:**
  1. Open the app → Plan a route (at least dep + dest)
  2. Open Settings gear → Winds & Performance section
  3. Confirm optimizer table appears below Power row with 5 rows (3k–18k)
  4. 18,000 row is grayed
  5. Fastest row shows ★
  6. Change altitude dropdown → selected row highlights blue without page reload
  7. Without a route planned: table shows "Plan a route to see altitude comparison"

- [ ] **Commit version bump:**

```bash
git add web/app.js android/app/build.gradle
git commit -m "chore: bump version to v7.77 (Feature A build)"
```

---

## Task 5: Feature C — MOS fetch + mixing height + MIX HT column

**Files:**
- Modify: `web/cockpit/route-planner-panel.js`

- [ ] **Verify `mix_ht` units from live MOS endpoint before writing any code.** Run:

```bash
curl -s "https://www.flywhere.app/api/mos?ids=KABE,KORF" | python3 -m json.tool | grep -A5 "mix_ht"
```

Expected: `mix_ht` values in the hundreds-of-thousands range suggest feet; values in hundreds suggest the proxy already converted from meters. Confirm the field is a number in feet (consistent with wx-briefing displaying it directly as `p.mix_ht.toLocaleString() + 'ft'`).

- [ ] **Add `_fetchMos()` method** (place after `_renderOptTable()`):

```javascript
async _fetchMos() {
    if (!this._lastPlan?.waypoints?.length) return;
    const ids = [...new Set(
        this._lastPlan.waypoints
            .map(w => w.icao)
            .filter(id => id && /^[A-Z]{3,4}$/.test(id))
    )];
    if (!ids.length) return;

    const base = (typeof Settings !== 'undefined' && Settings.workerBase)
        ? Settings.workerBase : 'https://www.flywhere.app/api';
    const url = `${base}/mos?ids=${ids.join(',')}`;

    let resp;
    try {
        resp = await fetch(url, { signal: AbortSignal.timeout(45000) });
        if (resp.status === 503) {
            await new Promise(r => setTimeout(r, 2000));
            resp = await fetch(url, { signal: AbortSignal.timeout(45000) });
        }
        if (!resp.ok) throw new Error(`mos ${resp.status}`);
        const raw = await resp.json();
        // Normalize: if data already has .stations, use as-is; else wrap it
        this._lastMos = (raw?.stations && typeof raw.stations === 'object')
            ? raw
            : { fetched_at: new Date().toISOString(), stations: raw };
        if (!this._lastMos.fetched_at) this._lastMos.fetched_at = new Date().toISOString();
    } catch (_) {
        // leave _lastMos as-is (stale or null); don't clear good cached data
    }
    if (this._popupOverlay?.classList.contains('open')) this._renderOptTable();
}
```

- [ ] **Add `_getMixHt()` method** (place after `_fetchMos()`):

```javascript
_getMixHt(departureTime) {
    if (!this._lastMos?.stations) return null;
    const targetMs = (departureTime instanceof Date ? departureTime : new Date()).getTime();
    const values = [];
    for (const stData of Object.values(this._lastMos.stations)) {
        const periods = stData?.periods;
        if (!Array.isArray(periods)) continue;
        let best = null, bestDiff = Infinity;
        for (const p of periods) {
            if (!p.valid_time || p.mix_ht == null) continue;
            const diff = Math.abs(new Date(p.valid_time).getTime() - targetMs);
            if (diff < bestDiff) { bestDiff = diff; best = p.mix_ht; }
        }
        if (best != null) values.push(best);
    }
    if (!values.length) return null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}
```

- [ ] **Wire MOS fetch in `_openSettingsPopup()`** — add after the existing `this._renderOptTable();` call added in Task 3:

```javascript
        // Fetch MOS if stale or missing (60 min cache)
        const mosAgeMs = this._lastMos?.fetched_at
            ? Date.now() - new Date(this._lastMos.fetched_at).getTime()
            : Infinity;
        if (mosAgeMs > 60 * 60_000) this._fetchMos();
```

- [ ] **`_renderOptTable()` already handles `mixHt`** (it calls `this._getMixHt()` which is now defined). No further changes needed to `_renderOptTable()` — the MIX column appears automatically once `_lastMos` is populated.

- [ ] **Commit Feature C:**

```bash
git add web/cockpit/route-planner-panel.js
git commit -m "feat(planner): mixing height column from MOS in altitude optimizer (Feature C)"
```

---

## Task 6: Feature C — Build and visual verify

- [ ] **Bump version to v7.78 in `web/app.js`:**

```javascript
const FLYTAB_VERSION = 'v7.78';
```

- [ ] **Build:**

```bash
bash build.sh
```

- [ ] **Verify:**
  1. Open Settings popup with a route planned
  2. MIX HT column appears once MOS data loads (may take up to 45s on first open)
  3. Rows above mixing height show "✓ above" in green; rows at/below show "⚠ in BL" in orange
  4. Footnote shows "mix ht ~X,XXX ft (ICAO1, ICAO2)"
  5. On second open within 60 min: MOS column appears instantly (cached)
  6. If no airports in route (e.g., all fixes): MOS column shows "—" throughout — that's correct

- [ ] **Commit:**

```bash
git add web/app.js android/app/build.gradle
git commit -m "chore: bump version to v7.78 (Feature C build)"
```

---

## Task 7: Feature B — `_fetchRouteMea()` data lookup

**Files:**
- Modify: `web/cockpit/route-planner-panel.js`

- [ ] **Add `_fetchRouteMea()` method** (place after `_getMixHt()`):

```javascript
_fetchRouteMea() {
    const epoch = ++this._meaEpoch;
    // Clear any stale mea_ft from all route items first
    for (const item of this._route) delete item.mea_ft;

    const awyPills = this._route.filter(p => p.type === 'awy');
    if (!awyPills.length || !this._nasrDb) return;

    Promise.all(awyPills.map(async (pill) => {
        const routeIdx = this._route.indexOf(pill);
        // from-fix: last non-airway item before this pill
        const fromFix = this._route.slice(0, routeIdx).reverse()
            .find(p => p.type !== 'awy' && p.type !== 'direct');
        // to-fix: first non-airway item after this pill
        const toFix = this._route.slice(routeIdx + 1)
            .find(p => p.type !== 'awy' && p.type !== 'direct');
        if (!fromFix || !toFix) return;

        const awy = await this._nasrDb.getAirway(pill.id).catch(() => null);
        if (!awy?.waypoints?.length || !awy?.segments?.length) return;

        // Match waypoints: try by id first, then by uppercased name
        const matchWp = (fix) =>
            awy.waypoints.find(w => w.id === fix.id) ||
            awy.waypoints.find(w => w.name?.toUpperCase() === fix.id?.toUpperCase());

        const fromWp = matchWp(fromFix);
        const toWp   = matchWp(toFix);
        if (!fromWp || !toWp) return;

        // Segments are stored with lower seq as from_seq.
        // Collect all segments between fromWp and toWp (inclusive range).
        const minSeq = Math.min(fromWp.seq, toWp.seq);
        const maxSeq = Math.max(fromWp.seq, toWp.seq);
        const segs = awy.segments.filter(s => s.from_seq >= minSeq && s.to_seq <= maxSeq);
        const meas = segs
            .map(s => s.mea_gnss_ft ?? s.mea_ft ?? 0)
            .filter(v => v > 0);
        if (meas.length) pill.mea_ft = Math.max(...meas);
    })).then(() => {
        if (epoch !== this._meaEpoch) return; // route changed mid-fetch, discard
        this._renderPills();
    }).catch(() => {});
}
```

- [ ] **Commit:**

```bash
git add web/cockpit/route-planner-panel.js
git commit -m "feat(planner): _fetchRouteMea async MEA lookup from NASR airways"
```

---

## Task 8: Feature B — `_buildPill()` MEA display + CSS + wiring

**Files:**
- Modify: `web/cockpit/route-planner-panel.js`
- Modify: `web/style.css`

- [ ] **In `_buildPill()`, add MEA label to airway pills.** Find the block inside `_buildPill()` that constructs the pill and assembles its children (the section that appends `handle`, `label`, `badge`, `del` to `pill`). Add MEA label insertion after the badge append:

```javascript
        // MEA label for airway pills
        if (item.type === 'awy' && item.mea_ft) {
            const isBelowMea = this._cruiseAltFt && this._cruiseAltFt < item.mea_ft;
            if (isBelowMea) pill.classList.add('rpp-pill-mea-warn');
            const meaSpan = document.createElement('span');
            meaSpan.className = 'rpp-pill-mea';
            meaSpan.textContent = `MEA ${item.mea_ft.toLocaleString()} ${isBelowMea ? '▲' : '✓'}`;
            pill.appendChild(meaSpan);
        }
```

Insert this block immediately before `pill.appendChild(del);`.

- [ ] **Wire `_fetchRouteMea()` call after route changes.** In `_renderPills()` (~line 1126), add after `this._pillsEl.innerHTML = ''` and after the `view.forEach(...)` loop:

```javascript
        // Async MEA lookup — runs after first render, re-renders once MEA data arrives
        this._fetchRouteMea();
```

- [ ] **Wire altitude change to re-render pills for warning state.** In the `_altSel` change handler (where you added `this._renderOptTable()` in Task 3), also add:

```javascript
            this._renderPills();
```

This causes `_buildPill()` to re-evaluate `isBelowMea` with the new altitude, which triggers another `_fetchRouteMea()` call. MEA data is already on `pill.mea_ft` from the previous fetch (not cleared until next `_fetchRouteMea()` run, which re-attaches it).

Wait — `_renderPills()` calls `_fetchRouteMea()` which calls `_renderPills()` again. The `mea_ft` is deleted at the start of `_fetchRouteMea()`, then reattached async. This means the second render (from the altitude change) shows no MEA labels until the async fetch completes, then `_renderPills()` fires a third time with MEA data restored.

**To avoid this stale-clear problem on altitude change:** only call `_renderPills()` directly on altitude change (skip the extra `_fetchRouteMea()` call). Change the wiring so the `_altSel` handler calls a lightweight re-render that rebuilds pills from existing `item.mea_ft` without clearing:

Replace `this._renderPills()` in the `_altSel` handler with a call to a new method:

```javascript
            this._reRenderPillsInPlace();
```

And add this method (after `_renderPills()`):

```javascript
_reRenderPillsInPlace() {
    if (!this._pillsEl) return;
    this._renderEpoch++;
    this._pillsEl.innerHTML = '';
    const view = this._compactView
        ? this._collapseSameAirway(this._route)
        : this._route.map((item, i) => ({ item, originalIdx: i }));
    view.forEach(({ item, originalIdx }) => {
        const pill = this._buildPill(item, originalIdx);
        this._pillsEl.appendChild(pill);
    });
    // NOTE: does NOT call _fetchRouteMea() — preserves existing item.mea_ft
}
```

And change `_renderPills()` body to call `_reRenderPillsInPlace()` then `_fetchRouteMea()`:

```javascript
_renderPills() {
    this._reRenderPillsInPlace();
    this._fetchRouteMea();
}
```

This avoids the stale-clear cycle.

- [ ] **Add CSS for MEA pill labels** — append to `web/style.css` after the `.rpp-opt-note` rule:

```css
/* ── MEA pill label ── */
.rpp-pill-mea {
    font-size: 0.72em;
    font-weight: 600;
    color: #4f8;
    margin-left: 5px;
    letter-spacing: 0.02em;
}
.rpp-pill-mea-warn {
    border: 2px solid #f84 !important;
}
.rpp-pill-mea-warn .rpp-pill-mea {
    color: #f84;
}
```

- [ ] **Commit Feature B:**

```bash
git add web/cockpit/route-planner-panel.js web/style.css
git commit -m "feat(planner): MEA labels on airway pills with below-MEA warning (Feature B)"
```

---

## Task 9: Feature B — Build and visual verify

- [ ] **Bump version to v7.79 in `web/app.js`:**

```javascript
const FLYTAB_VERSION = 'v7.79';
```

- [ ] **Build:**

```bash
bash build.sh
```

- [ ] **Verify:**
  1. Plan a V-airway route (e.g., using KABE → V39 → PSK → V143 → KORF)
  2. Airway pills show "MEA X,XXX ✓" in green
  3. Set altitude below the MEA for one segment → that airway pill gets orange border and "MEA X,XXX ▲"
  4. Raise altitude above MEA → warning clears, green ✓ returns
  5. DIRECT/GPS pills show no MEA label — correct
  6. Route with all DIRECT legs: no MEA labels anywhere — correct

- [ ] **Commit version bump:**

```bash
git add web/app.js android/app/build.gradle
git commit -m "chore: bump version to v7.79 (Feature B build)"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| FD levels 3k/6k/9k/12k/18k | Task 1 (`ALTS` array) |
| 18k grayed, O-360 ceiling | Task 1 (`CEILING_FT = 14000`) |
| Read-only table, dropdown = source of truth | Tasks 2–3 (no tap handler on rows) |
| Columns ALT/ETE/GS/GAL | Task 2 (`_renderOptTable`) |
| ★ = fastest, highlighted = selected | Task 2 |
| Always visible, no extra tap | Task 3 (`_openSettingsPopup`) |
| Calm-air fallback when no winds | Task 2 (`calNote`) |
| `_cruiseAltFt` change → table highlight updates | Task 3 |
| Winds-loaded → recompute | Task 3 (`_applyWindsToLastPlan`) |
| MOS fetch with 503 retry | Task 5 (`_fetchMos`) |
| 60 min MOS cache | Task 5 (`_openSettingsPopup` wiring) |
| `_getMixHt` averages across stations | Task 5 |
| MIX HT column ✓/⚠ | Task 2 (`_renderOptTable`, conditional) |
| MIX HT footnote | Task 2 (`noteParts`) |
| MEA only on `type==='awy'` pills | Task 8 |
| GNSS MEA preferred | Task 7 (`mea_gnss_ft ?? mea_ft`) |
| Max MEA across multi-segment span | Task 7 (filter by seq range, `Math.max`) |
| Warning when alt < MEA | Task 8 (`isBelowMea`) |
| Altitude change → warning re-evaluates | Task 8 (`_reRenderPillsInPlace`) |
| Airway direction handling | Task 7 (`minSeq/maxSeq`) |
| Waypoint ID mismatch fallback | Task 7 (`.name.toUpperCase()` fallback) |
| Popup closed mid-MOS-fetch | Task 5 (updates `_lastMos`, skips render) |
| Route < 2 waypoints | Task 1 (returns `[]`) |
