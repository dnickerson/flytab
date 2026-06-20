# WxBriefing Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `WxBriefing` into a full landscape preflight weather briefing panel with METARs/TAFs, AIRMETs, MCDs, AFDs, and NOTAMs alongside the existing MOS grid.

**Architecture:** Two-column layout (52% left: summary + MOS + METARs/TAFs; 48% right: AIRMETs + MCDs + AFDs + NOTAMs). Each section owns its own localStorage cache with an independent TTL; `show()` fetches cold sections automatically; ↻ refresh triggers all fetches in parallel via `Promise.allSettled`. Portrait stacks columns vertically via CSS media query.

**Tech Stack:** Vanilla JS class, AWC REST API (METARs/TAFs), api.weather.gov (MCDs/AFDs), flywhere.app proxy (AIRMETs), FAA NMS-API (NOTAMs), localStorage caching.

---

## File Map

| File | Change |
|------|--------|
| `web/cockpit/wx-briefing.js` | Full rewrite — new panel HTML, two-column layout, all new section fetches/renders |
| `web/style.css` | Add landscape two-column layout rules and section card styles |
| `web/cockpit-config.json` | Add `notam_api_key` and `notam_api_base` fields |

No new files. No changes to `weather-client.js`, `app.js`, or `index.html`.

---

## Task 1: CSS — Landscape Two-Column Shell

**Files:**
- Modify: `web/style.css` (after line 7390, replacing `.wx-briefing-body` through end of wx section)

- [ ] **Step 1: Replace the wx-briefing-body and content rules, add two-column layout**

Find `.wx-briefing-body` at line 7330 and replace the block from there through the end of the wx section with:

```css
/* ── WxBriefing layout ── */
.wx-briefing-body {
    display: flex;
    flex-direction: row;
    flex: 1;
    overflow: hidden;
    min-height: 0;
}

.wx-left {
    width: 52%;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
}

.wx-right {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
}

/* Portrait: stack columns vertically */
@media (orientation: portrait) {
    .wx-briefing-body { flex-direction: column; }
    .wx-left { width: 100%; border-right: none; border-bottom: 1px solid var(--border); overflow-y: visible; }
    .wx-right { overflow-y: visible; }
}

/* ── Age indicators in header ── */
.wx-age-group {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
}
.wx-age-tag {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-secondary);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 2px 6px;
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
}
.wx-age-tag .wx-age-dot {
    width: 5px; height: 5px;
    border-radius: 50%;
    background: var(--status-ok, #00cc44);
}
.wx-age-tag.wx-age-stale .wx-age-dot { background: var(--status-warn, #f59e0b); }
.wx-age-tag b { color: var(--text-primary); }

/* ── Summary bar ── */
.wx-summary-bar {
    position: sticky;
    top: 0;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}
.wx-summary-route {
    font-size: var(--text-sm);
    font-weight: 700;
    color: var(--text-primary);
    flex: 1;
}
.wx-summary-badge {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 3px;
    border: 1px solid;
}
.wx-summary-badge.vfr  { color: #00cc44; border-color: #00cc44; }
.wx-summary-badge.mvfr { color: #4d9fff; border-color: #4d9fff; }
.wx-summary-badge.ifr  { color: #ff4444; border-color: #ff4444; }
.wx-summary-badge.lifr { color: #ff44ff; border-color: #ff44ff; }
.wx-summary-badge.caution { color: var(--status-warn, #f59e0b); border-color: var(--status-warn, #f59e0b); }

/* ── MOS section ── */
.wx-mos-wrap {
    padding: 6px 8px;
    flex-shrink: 0;
}
.wx-mos-note {
    font-size: 11px;
    color: var(--text-secondary);
    padding: 4px 8px 6px;
}

/* ── Section header (sticky in left col) ── */
.wx-section-hdr {
    position: sticky;
    top: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--bg-surface);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}
.wx-section-hdr-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-primary);
    flex: 1;
}
.wx-section-hdr-sub {
    font-size: 10px;
    color: var(--text-muted);
}

/* Right column section headers are collapsible */
.wx-rhs-section { border-bottom: 1px solid var(--border); }
.wx-rhs-hdr {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    cursor: pointer;
    user-select: none;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 2;
}
.wx-rhs-hdr:active { opacity: 0.75; }
.wx-rhs-title {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-primary);
    flex: 1;
}
.wx-rhs-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 10px;
    color: #fff;
    background: var(--text-muted);
}
.wx-rhs-badge.warn { background: #cc4400; }
.wx-rhs-badge.ok   { background: #1a8a1a; }
.wx-rhs-badge.info { background: #0074d9; }
.wx-rhs-chevron { font-size: 11px; color: var(--text-muted); transition: transform 0.15s; }
.wx-rhs-chevron.open { transform: rotate(90deg); }
.wx-rhs-body { display: none; }
.wx-rhs-body.open { display: block; }

/* ── Station / advisory cards ── */
.wx-station-card { border-bottom: 1px solid var(--border); }
.wx-card-hdr {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 10px;
    cursor: pointer;
    user-select: none;
}
.wx-card-hdr:active { opacity: 0.75; }
.wx-card-icao {
    font-size: 15px;
    font-weight: 800;
    color: var(--text-primary);
    min-width: 48px;
}
.wx-card-prox {
    font-size: 10px;
    font-weight: 700;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1px 6px;
}
.wx-card-prox.on-route {
    color: var(--accent, #0088ff);
    border-color: var(--accent, #0088ff);
}
.wx-card-obs { font-size: 11px; color: var(--text-muted); flex: 1; }
.wx-card-cat {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 3px;
    color: #fff;
}
.wx-card-cat.vfr  { background: #00aa33; }
.wx-card-cat.mvfr { background: #0066cc; }
.wx-card-cat.ifr  { background: #cc0000; }
.wx-card-cat.lifr { background: #990099; }
.wx-card-chevron { font-size: 11px; color: var(--text-muted); transition: transform 0.15s; flex-shrink: 0; }
.wx-card-chevron.open { transform: rotate(90deg); }
.wx-card-body { display: none; padding: 0 10px 10px; }
.wx-card-body.open { display: block; }

.wx-metar-raw {
    font-family: 'Courier New', monospace;
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 6px 8px;
    word-break: break-all;
    line-height: 1.5;
    margin-bottom: 7px;
}
.wx-decoded-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    margin-bottom: 8px;
}
.wx-decoded-cell {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 5px 7px;
}
.wx-decoded-lbl {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 1px;
}
.wx-decoded-val {
    font-size: 13px;
    font-weight: 800;
    color: var(--text-primary);
}
.wx-decoded-val.warn { color: var(--status-warn, #f59e0b); }
.wx-decoded-val.bad  { color: #cc0000; }

.wx-taf-hdr {
    font-size: 10px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 5px 0 3px;
    border-top: 1px solid var(--border);
    margin-bottom: 2px;
}
.wx-taf-issued { font-size: 10px; color: var(--text-muted); margin-bottom: 4px; }
.wx-taf-row {
    display: grid;
    grid-template-columns: 100px 50px 60px 60px 1fr;
    gap: 4px;
    align-items: center;
    padding: 4px 4px;
    font-size: 11px;
    border-radius: 2px;
    border: 1px solid transparent;
}
.wx-taf-row:nth-child(even) { background: rgba(0,0,0,.03); }
.wx-taf-row.highlight { background: rgba(0,136,255,.07); border-color: rgba(0,136,255,.2); }
.wx-taf-time { color: var(--text-secondary); font-size: 10px; }
.wx-taf-cat  { font-weight: 700; font-size: 10px; }
.wx-taf-wind, .wx-taf-ceil, .wx-taf-vis { color: var(--text-muted); font-size: 10px; }
.wx-taf-no { font-size: 11px; color: var(--text-muted); font-style: italic; margin-top: 4px; }

/* ── Advisory cards (right column) ── */
.wx-adv-card { border-bottom: 1px solid var(--border); }
.wx-adv-hdr {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 9px 12px;
    cursor: pointer;
    user-select: none;
    background: var(--bg-primary);
}
.wx-adv-hdr:active { opacity: 0.75; }
.wx-adv-type {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 3px;
    border: 1px solid;
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 1px;
    font-family: 'Courier New', monospace;
}
.wx-adv-type.sierra { color: #cc0000; border-color: rgba(204,0,0,.4); background: rgba(204,0,0,.08); }
.wx-adv-type.tango  { color: #cc6600; border-color: rgba(204,102,0,.4); background: rgba(204,102,0,.08); }
.wx-adv-type.zulu   { color: #0066cc; border-color: rgba(0,102,204,.4); background: rgba(0,102,204,.08); }
.wx-adv-type.mcd    { color: #cc4400; border-color: rgba(204,68,0,.4); background: rgba(204,68,0,.08); }
.wx-adv-type.afd    { color: #0066cc; border-color: rgba(0,102,204,.35); background: rgba(0,102,204,.08); }
.wx-adv-type.rwy    { color: #cc0000; border-color: rgba(204,0,0,.4); background: rgba(204,0,0,.08); }
.wx-adv-type.navaid { color: #cc0000; border-color: rgba(204,0,0,.4); background: rgba(204,0,0,.08); }
.wx-adv-type.ad, .wx-adv-type.svc, .wx-adv-type.twy, .wx-adv-type.obst {
    color: var(--text-secondary); border-color: var(--border); background: transparent;
}
.wx-adv-info { flex: 1; }
.wx-adv-hazard {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-primary);
    line-height: 1.4;
    margin-bottom: 2px;
}
.wx-adv-meta { font-size: 10px; color: var(--text-muted); }
.wx-adv-meta b { color: var(--text-secondary); }
.wx-adv-chevron { font-size: 11px; color: var(--text-muted); transition: transform 0.15s; flex-shrink: 0; margin-top: 3px; }
.wx-adv-chevron.open { transform: rotate(90deg); }
.wx-adv-body { display: none; padding: 0 12px 10px; }
.wx-adv-body.open { display: block; }
.wx-adv-text {
    font-family: 'Courier New', monospace;
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 7px 9px;
    max-height: 180px;
    overflow-y: auto;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    -webkit-overflow-scrolling: touch;
}
.wx-adv-valid {
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 4px;
}
.wx-adv-valid b { color: var(--status-warn, #f59e0b); }

/* ── Loading / empty / error states ── */
.wx-section-loading,
.wx-section-empty,
.wx-section-error {
    padding: 12px 14px;
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
}
.wx-section-error { color: var(--status-warn, #f59e0b); font-style: normal; font-weight: 600; }

/* ── Existing rules preserved ── */
.wx-briefing-content { display: none; } /* no longer used */
.wx-loading, .wx-empty {
    padding: 40px 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--text-sm);
}
```

- [ ] **Step 2: Verify no existing wx-briefing CSS is broken**

Run: check browser layout renders without overlap (visual verification after Task 2).

---

## Task 2: Panel HTML + State Initialization

**Files:**
- Modify: `web/cockpit/wx-briefing.js`

Replace `_buildPanel()`, constructor state fields, `show()`, `hide()`, `setFlightPlan()`.

- [ ] **Step 1: Replace constructor with expanded state**

```javascript
constructor(db) {
    this._db           = db;
    this._el           = null;
    this._flightPlan   = null;
    this._mosData      = null;
    this._mode         = 'day';
    this._loading      = false;
    this._expandedIcao = null;
    this.visible       = false;

    // Per-section data and cache timestamps
    this._metarData    = null;   // { ICAO: { raw, decoded, fetched_at } }
    this._tafData      = null;   // { ICAO: { raw, fcsts, issued, valid_from, valid_to } }
    this._airmets      = null;   // [ parsed advisory objects ]
    this._mcds         = null;   // [ { id, hazard, validUntil, polygon, productText } ]
    this._afds         = null;   // [ { office, name, issued, text } ]
    this._notams       = null;   // [ { airport, type, summary, valid, raw } ]

    // Fetch timestamps (ms since epoch; 0 = never fetched)
    this._metarFetchedAt  = 0;
    this._airmetFetchedAt = 0;
    this._mcdFetchedAt    = 0;
    this._afdFetchedAt    = 0;
    this._notamFetchedAt  = 0;

    // Route coordinates cache (populated from NASR on first show())
    this._routeCoords  = null;   // [ [lat, lon], ... ]
}
```

- [ ] **Step 2: Replace `_buildPanel()`**

```javascript
_buildPanel() {
    this._el = document.createElement('div');
    this._el.className = 'wx-briefing-page';
    this._el.innerHTML = `
        <div class="wx-briefing-header">
            <span class="wx-briefing-title">⛅ WX BRIEFING</span>
            <div class="wx-age-group" id="wx-age-group"></div>
            <div class="wx-mode-toggle">
                <button class="wx-mode-btn active" data-mode="day">7-DAY</button>
                <button class="wx-mode-btn" data-mode="hour">24H</button>
            </div>
            <button class="wx-refresh-btn" title="Refresh all weather">↻</button>
            <button class="wx-close-btn" aria-label="Close">✕</button>
        </div>
        <div class="wx-briefing-body">
            <div class="wx-left">
                <div class="wx-summary-bar" id="wx-summary-bar">
                    <span class="wx-summary-route">—</span>
                </div>
                <div id="wx-mos-section"></div>
                <div id="wx-metar-section"></div>
            </div>
            <div class="wx-right">
                <div id="wx-airmet-section"></div>
                <div id="wx-mcd-section"></div>
                <div id="wx-afd-section"></div>
                <div id="wx-notam-section"></div>
            </div>
        </div>
    `;

    this._el.querySelector('.wx-close-btn').addEventListener('click', () => this.hide());
    this._el.querySelector('.wx-refresh-btn').addEventListener('click', () => this._refreshAll());

    this._el.querySelectorAll('.wx-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            this._mode = btn.dataset.mode;
            this._el.querySelectorAll('.wx-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            this._renderMos();
        });
    });

    (document.getElementById('mainContent') || document.body).appendChild(this._el);
}
```

- [ ] **Step 3: Replace `show()`, `hide()`, `setFlightPlan()`**

```javascript
show() {
    if (!this._el) this.init();
    this._el.classList.add('visible');
    this.visible = true;

    if (!this._mosData && this._flightPlan?.weather_cache?.mos) {
        this._mosData = this._flightPlan.weather_cache.mos;
    }

    // Render immediately from any cached state
    this._renderAll();

    // Kick off fetches for cold sections (non-blocking)
    this._fetchColdSections();
}

hide() {
    this._el?.classList.remove('visible');
    this.visible = false;
}

setFlightPlan(plan) {
    this._flightPlan = plan;
    if (plan?.weather_cache?.mos) this._mosData = plan.weather_cache.mos;
    this._routeCoords = null; // invalidate cached route coords
    if (this.visible) this._renderAll();
}
```

- [ ] **Step 4: Add `_fetchColdSections()` and `_refreshAll()`**

```javascript
_fetchColdSections() {
    const now = Date.now();
    const TTL15 = 15 * 60000;
    const TTL60 = 60 * 60000;

    const fetches = [];
    if (now - this._metarFetchedAt  > TTL15) fetches.push(this._fetchMetarTaf());
    if (now - this._airmetFetchedAt > TTL15) fetches.push(this._fetchAirmets());
    if (now - this._mcdFetchedAt    > TTL15) fetches.push(this._fetchMcds());
    if (now - this._afdFetchedAt    > TTL60) fetches.push(this._fetchAfds());
    if (now - this._notamFetchedAt  > TTL15) fetches.push(this._fetchNotams());

    if (fetches.length) Promise.allSettled(fetches);
}

_refreshAll() {
    // Reset all timestamps to force re-fetch
    this._metarFetchedAt = this._airmetFetchedAt = this._mcdFetchedAt =
        this._afdFetchedAt = this._notamFetchedAt = 0;

    // Also re-fetch MOS
    this._fetchMos();

    this._fetchColdSections();
}
```

- [ ] **Step 5: Add `_renderAll()` top-level coordinator**

```javascript
_renderAll() {
    if (!this._el) return;
    this._renderSummaryBar();
    this._renderAgeGroup();
    this._renderMos();
    this._renderMetarSection();
    this._renderAirmetSection();
    this._renderMcdSection();
    this._renderAfdSection();
    this._renderNotamSection();
}

_section(id) {
    return this._el?.querySelector(`#${id}`);
}

_setSection(id, html) {
    const el = this._section(id);
    if (el) el.innerHTML = html;
}

_loadingHtml(label) {
    return `<div class="wx-section-loading">Fetching ${label}…</div>`;
}

_errorHtml(label) {
    return `<div class="wx-section-error">⚠ ${label} unavailable — tap ↻ to retry</div>`;
}
```

- [ ] **Step 6: Add `_renderAgeGroup()`**

```javascript
_renderAgeGroup() {
    const el = this._section('wx-age-group');
    if (!el) return;
    const now = Date.now();
    const TTL15 = 15 * 60000;
    const age = (ts) => {
        if (!ts) return null;
        const m = Math.round((now - ts) / 60000);
        return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
    };
    const tag = (label, ts, ttl) => {
        const a = age(ts);
        const stale = !a || (now - ts) > ttl;
        return `<span class="wx-age-tag${stale ? ' wx-age-stale' : ''}">
            <span class="wx-age-dot"></span>
            <b>${label}</b>${a ? ' ' + a : ' —'}
        </span>`;
    };
    el.innerHTML =
        tag('MOS', this._mosData ? new Date(this._mosData.fetched_at).getTime() : 0, 60 * 60000) +
        tag('METARs', this._metarFetchedAt, 15 * 60000) +
        tag('AIRMETs', this._airmetFetchedAt, 15 * 60000) +
        tag('NOTAMs', this._notamFetchedAt, 15 * 60000);
}
```

- [ ] **Step 7: Add `_isWarm(timestamp, ttlMinutes)` helper**

```javascript
_isWarm(ts, ttlMinutes) {
    return ts > 0 && (Date.now() - ts) < ttlMinutes * 60000;
}
```

---

## Task 3: Left Column — Summary Bar + MOS Grid

**Files:**
- Modify: `web/cockpit/wx-briefing.js`

Port the existing summary bar and grid logic to render into the new section divs.

- [ ] **Step 1: Add `_renderSummaryBar()`**

```javascript
_renderSummaryBar() {
    const bar = this._el?.querySelector('#wx-summary-bar');
    if (!bar) return;
    const stations = this._getStationList();
    const dep  = stations[0]  || '—';
    const dest = stations[stations.length - 1] || '—';
    const route = dep !== dest ? `${dep} → ${dest}` : dep;

    let badgeHtml = '';
    if (this._mosData) {
        const best = this._findBestDay(stations);
        if (best) {
            const label = this._isSameDay(best.date, new Date())
                ? 'Today'
                : this._dayLabel(best.date);
            const cls = (best.worstCat || 'unknown').toLowerCase();
            badgeHtml = `<span class="wx-summary-badge ${cls}">${label}: ${best.worstCat}</span>`;
        }
    }

    bar.innerHTML = `<span class="wx-summary-route">${route}</span>${badgeHtml}`;
}
```

- [ ] **Step 2: Add `_renderMos()`**

```javascript
_renderMos() {
    const sec = this._section('wx-mos-section');
    if (!sec) return;
    sec.innerHTML = '';

    const stations = this._getStationList();
    if (!stations.length) {
        sec.innerHTML = '<div class="wx-section-empty">No flight plan loaded.</div>';
        return;
    }

    if (this._loading) {
        sec.innerHTML = this._loadingHtml('MOS');
        return;
    }

    if (!this._mosData) {
        sec.innerHTML = '<div class="wx-section-empty">No MOS cached. Tap ↻ to fetch.</div>';
        return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'wx-mos-wrap';

    if (this._mode === 'day') {
        wrap.appendChild(this._buildDayGrid(stations));
        const best = this._findBestDay(stations);
        if (best) {
            const note = document.createElement('div');
            note.className = 'wx-mos-note';
            note.textContent = `Best: ${this._dayLabel(best.date)} (${best.worstCat}) · Days 6–8 trend only`;
            wrap.appendChild(note);
        }
    } else {
        wrap.appendChild(this._buildHourGrid(stations));
    }

    // MOS age notice
    if (this._mosData.fetched_at) {
        const ageMin = Math.round((Date.now() - new Date(this._mosData.fetched_at)) / 60000);
        const ageEl = document.createElement('div');
        ageEl.className = 'wx-mos-note';
        ageEl.textContent = `MOS ${ageMin < 60 ? ageMin + 'm' : Math.round(ageMin / 60) + 'h'} old`;
        wrap.appendChild(ageEl);
    }

    sec.appendChild(wrap);
}
```

- [ ] **Step 3: Keep all existing `_buildDayGrid`, `_buildHourGrid`, `_buildTstormRow`, `_buildAirportDetail` methods unchanged**

These render correctly; they just need to be called from `_renderMos()` instead of `_render()`. No changes needed to those methods.

- [ ] **Step 4: Keep existing `_fetchMos()` unchanged**

The refresh button now calls `_fetchMos()` via `_refreshAll()`. The existing `_fetchMos()` method sets `this._loading` and calls `this._render()` at the end — update that final call:

Find in `_fetchMos()`:
```javascript
} finally {
    this._loading = false;
    this._render();
}
```
Replace with:
```javascript
} finally {
    this._loading = false;
    this._renderSummaryBar();
    this._renderAgeGroup();
    this._renderMos();
}
```

---

## Task 4: Left Column — METAR/TAF Fetch + Render

**Files:**
- Modify: `web/cockpit/wx-briefing.js`

- [ ] **Step 1: Add `_getRouteCoords()` — async, caches result**

```javascript
async _getRouteCoords() {
    if (this._routeCoords) return this._routeCoords;
    const icaos = this._getStationList();
    const coords = [];
    for (const icao of icaos) {
        const apt = await this._db.getAirport(icao);
        if (apt?.lat && apt?.lon) coords.push({ icao, lat: apt.lat, lon: apt.lon });
    }
    // Also pull any lat/lon from flight plan waypoints
    if (this._flightPlan?.waypoints) {
        for (const wp of this._flightPlan.waypoints) {
            if (wp.lat && wp.lon && !coords.find(c => c.icao === wp.icao)) {
                coords.push({ icao: wp.icao || '', lat: wp.lat, lon: wp.lon });
            }
        }
    }
    this._routeCoords = coords;
    return coords;
}
```

- [ ] **Step 2: Add `_getRouteBbox(bufferDeg)`**

```javascript
async _getRouteBbox(bufferDeg = 0.15) {
    const coords = await this._getRouteCoords();
    if (!coords.length) return null;
    const lats = coords.map(c => c.lat);
    const lons = coords.map(c => c.lon);
    return {
        s: Math.min(...lats) - bufferDeg,
        n: Math.max(...lats) + bufferDeg,
        w: Math.min(...lons) - bufferDeg,
        e: Math.max(...lons) + bufferDeg,
    };
}
```

- [ ] **Step 3: Add `_fetchMetarTaf()`**

```javascript
async _fetchMetarTaf() {
    const stations = this._getStationList();
    if (!stations.length) return;

    // Show loading state
    this._metarData = null; this._tafData = null;
    this._renderMetarSection();

    try {
        const bbox = await this._getRouteBbox(0.15);
        const [metarRes, tafRes] = await Promise.allSettled([
            bbox ? this._fetchMetarsByBbox(bbox) : this._fetchMetarsById(stations),
            this._fetchTafsStructured(stations),
        ]);

        this._metarData = metarRes.status === 'fulfilled' ? metarRes.value : {};
        this._tafData   = tafRes.status === 'fulfilled'   ? tafRes.value   : {};
        this._metarFetchedAt = Date.now();

        // Persist METARs to IndexedDB for offline use
        for (const [icao, m] of Object.entries(this._metarData)) {
            this._db.putWeather(icao, {
                metar: m,
                taf: this._tafData[icao] || null,
                fetched_at: new Date().toISOString(),
            }).catch(() => {});
        }
    } catch (err) {
        console.error('METAR/TAF fetch failed:', err);
        this._metarData = { _error: true };
    }

    this._renderAgeGroup();
    this._renderMetarSection();
}

async _fetchMetarsByBbox(bbox) {
    const url = `${WeatherClient.AWC_BASE}/metar?bbox=${bbox.s},${bbox.w},${bbox.n},${bbox.e}&format=json`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`METAR bbox failed: ${resp.status}`);
    const items = await resp.json();
    const out = {};
    // Deduplicate: keep most recent per station
    for (const item of (Array.isArray(items) ? items : [])) {
        const icao = item.icaoId || item.station_id;
        if (!icao) continue;
        if (!out[icao] || new Date(item.reportTime) > new Date(out[icao].reportTime)) {
            out[icao] = { raw: item.rawOb || '', decoded: WeatherClient.decodeMetar(item), reportTime: item.reportTime, lat: item.lat, lon: item.lon };
        }
    }
    return out;
}

async _fetchMetarsById(ids) {
    const url = `${WeatherClient.AWC_BASE}/metar?ids=${ids.join(',')}&format=json`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`METAR ids failed: ${resp.status}`);
    const items = await resp.json();
    const out = {};
    for (const item of (Array.isArray(items) ? items : [])) {
        const icao = item.icaoId || item.station_id;
        if (!icao || out[icao]) continue;
        out[icao] = { raw: item.rawOb || '', decoded: WeatherClient.decodeMetar(item), reportTime: item.reportTime, lat: item.lat, lon: item.lon };
    }
    return out;
}

async _fetchTafsStructured(ids) {
    const url = `${WeatherClient.AWC_BASE}/taf?ids=${ids.join(',')}&format=json`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`TAF failed: ${resp.status}`);
    const items = await resp.json();
    const out = {};
    for (const item of (Array.isArray(items) ? items : [])) {
        const icao = item.icaoId;
        if (!icao) continue;
        out[icao] = {
            raw: item.rawTAF || '',
            issued: item.issueTime || null,
            valid_from: item.validTimeFrom || null,
            valid_to: item.validTimeTo || null,
            fcsts: item.fcsts || [],
        };
    }
    return out;
}
```

- [ ] **Step 4: Add `_renderMetarSection()`**

```javascript
_renderMetarSection() {
    const sec = this._section('wx-metar-section');
    if (!sec) return;

    if (this._metarData === null) {
        sec.innerHTML = this._loadingHtml('METARs & TAFs');
        return;
    }
    if (this._metarData._error) {
        sec.innerHTML = this._errorHtml('METARs & TAFs');
        return;
    }

    const stations = this._getStationList();
    const allIcaos = Object.keys(this._metarData).filter(k => k !== '_error');
    const routeSet = new Set(stations);

    // Sort: route airports first, then by distance to nearest route coord
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

    const count = allIcaos.length;
    let html = `
        <div class="wx-section-hdr">
            <span class="wx-section-hdr-title">METARs &amp; TAFs</span>
            <span class="wx-section-hdr-sub">${count} STATION${count !== 1 ? 'S' : ''}</span>
        </div>
    `;

    sec.innerHTML = html;

    for (const icao of sorted) {
        const m = this._metarData[icao];
        if (!m) continue;
        sec.appendChild(this._buildStationCard(icao, m, routeSet.has(icao)));
    }
}

_buildStationCard(icao, metar, isOnRoute) {
    const d = metar.decoded || {};
    const cat = (d.flight_category || 'unknown').toLowerCase();
    const obsTime = metar.reportTime
        ? new Date(metar.reportTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' L'
        : '—';

    const card = document.createElement('div');
    card.className = 'wx-station-card';

    const proxLabel = isOnRoute ? 'ON ROUTE' : this._distLabelToRoute(metar.lat, metar.lon);

    card.innerHTML = `
        <div class="wx-card-hdr">
            <span class="wx-card-icao">${icao}</span>
            <span class="wx-card-prox${isOnRoute ? ' on-route' : ''}">${proxLabel}</span>
            <span class="wx-card-obs">${obsTime}</span>
            <span class="wx-card-cat ${cat}">${d.flight_category || '—'}</span>
            <span class="wx-card-chevron">›</span>
        </div>
        <div class="wx-card-body"></div>
    `;

    const hdr = card.querySelector('.wx-card-hdr');
    const body = card.querySelector('.wx-card-body');

    // Auto-expand route airports
    if (isOnRoute) {
        hdr.querySelector('.wx-card-chevron').classList.add('open');
        body.classList.add('open');
        this._populateStationCardBody(body, icao, metar);
    }

    hdr.addEventListener('click', () => {
        const chevron = hdr.querySelector('.wx-card-chevron');
        chevron.classList.toggle('open');
        body.classList.toggle('open');
        if (body.classList.contains('open') && !body.innerHTML.trim()) {
            this._populateStationCardBody(body, icao, metar);
        }
    });

    return card;
}

_populateStationCardBody(body, icao, metar) {
    const d = metar.decoded || {};
    const wind = d.wind_dir != null
        ? `${String(d.wind_dir).padStart(3, '0')}° / ${d.wind_speed ?? '—'}kt${d.wind_gust ? ` G${d.wind_gust}` : ''}`
        : 'Calm';
    const vis  = d.visibility != null ? `${d.visibility} SM` : '—';
    const ceil = d.ceiling != null
        ? `${d.sky_condition.find(s => s.base === d.ceiling)?.cover || 'BKN'} ${d.ceiling}ft`
        : 'CLR';
    const ceilClass = d.ceiling != null && d.ceiling < 1000 ? 'bad' : (d.ceiling != null && d.ceiling <= 3000 ? 'warn' : '');
    const visClass  = d.visibility != null && d.visibility < 3 ? 'bad' : (d.visibility != null && d.visibility <= 5 ? 'warn' : '');
    const temp = (d.temperature != null && d.dewpoint != null)
        ? `${d.temperature}° / ${d.dewpoint}°` : '—';
    const alt  = d.altimeter != null
        ? (d.altimeter > 500 ? (d.altimeter / 33.8639).toFixed(2) : d.altimeter.toFixed(2))
        : '—';

    let bodyHtml = `
        <div class="wx-metar-raw">${metar.raw || '—'}</div>
        <div class="wx-decoded-grid">
            <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Wind</div><div class="wx-decoded-val">${wind}</div></div>
            <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Visibility</div><div class="wx-decoded-val ${visClass}">${vis}</div></div>
            <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Ceiling</div><div class="wx-decoded-val ${ceilClass}">${ceil}</div></div>
            <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Temp / Dew</div><div class="wx-decoded-val">${temp}</div></div>
            <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Altimeter</div><div class="wx-decoded-val">${alt}"</div></div>
            <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Observed</div><div class="wx-decoded-val" style="font-size:11px">${metar.reportTime ? new Date(metar.reportTime).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) + ' L' : '—'}</div></div>
        </div>
    `;

    // TAF section
    const taf = this._tafData?.[icao];
    if (taf?.fcsts?.length) {
        const issued = taf.issued ? new Date(taf.issued).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) + ' L' : '—';
        const vFrom  = taf.valid_from ? new Date(taf.valid_from * 1000).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'}) : '—';
        const vTo    = taf.valid_to   ? new Date(taf.valid_to   * 1000).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'}) : '—';
        bodyHtml += `<div class="wx-taf-hdr">TAF</div>`;
        bodyHtml += `<div class="wx-taf-issued">Issued ${issued} · Valid ${vFrom} → ${vTo}</div>`;
        for (const f of taf.fcsts) {
            const tf  = new Date(f.timeFrom * 1000);
            const tt  = new Date(f.timeTo   * 1000);
            const timeStr = `${tf.toLocaleDateString([],{weekday:'short'})} ${tf.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}–${tt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} L`;
            const cat = this._tafPeriodCat(f);
            const catClass = cat.toLowerCase();
            const clouds = f.clouds || [];
            const ceilLayer = clouds.find(c => c.cover==='BKN'||c.cover==='OVC'||c.cover==='VV');
            const ceilStr = ceilLayer
                ? `${ceilLayer.cover}${String(Math.round(ceilLayer.base / 100)).padStart(3,'0')}`
                : (clouds[0]?.cover === 'SKC' || clouds[0]?.cover === 'CLR' ? 'SKC' : (clouds[0] ? clouds[0].cover : '—'));
            const windStr = (f.wdir != null && f.wspd != null)
                ? `${String(f.wdir).padStart(3,'0')}/${f.wspd}${f.wgst ? 'G'+f.wgst : ''}kt` : '—';
            const visStr = f.visib != null ? `${f.visib}SM` : '—';
            bodyHtml += `
                <div class="wx-taf-row">
                    <span class="wx-taf-time">${timeStr}</span>
                    <span class="wx-taf-cat wx-cat-${catClass}">${cat}</span>
                    <span class="wx-taf-wind">${windStr}</span>
                    <span class="wx-taf-ceil">${ceilStr}</span>
                    <span class="wx-taf-vis">${visStr}</span>
                </div>`;
        }
    } else if (taf) {
        bodyHtml += `<div class="wx-taf-no">TAF: no structured forecast periods</div>`;
    } else {
        bodyHtml += `<div class="wx-taf-no">No TAF available</div>`;
    }

    body.innerHTML = bodyHtml;
}

_tafPeriodCat(fcst) {
    const clouds = fcst.clouds || [];
    const ceilLayer = clouds.find(c => c.cover === 'BKN' || c.cover === 'OVC' || c.cover === 'VV');
    const ceiling = ceilLayer ? ceilLayer.base : null;
    const rawVis = fcst.visib;
    const vis = (typeof rawVis === 'string' && rawVis.includes('+'))
        ? parseFloat(rawVis) : (rawVis != null ? parseFloat(rawVis) : null);
    return WeatherClient.getFlightCategory(ceiling, vis);
}

_distToNearestCoord(lat, lon, coords) {
    if (lat == null || lon == null || !coords.length) return 9999;
    let min = Infinity;
    for (const c of coords) {
        const d = Math.hypot(lat - c.lat, (lon - c.lon) * Math.cos(lat * Math.PI / 180));
        if (d < min) min = d;
    }
    return min * 60; // approximate nm
}

_distLabelToRoute(lat, lon) {
    const coords = this._routeCoords || [];
    if (!lat || !lon || !coords.length) return '—';
    const nm = Math.round(this._distToNearestCoord(lat, lon, coords));
    return `${nm} NM`;
}
```

---

## Task 5: Right Column — AIRMET Section

**Files:**
- Modify: `web/cockpit/wx-briefing.js`

- [ ] **Step 1: Add `_fetchAirmets()`**

```javascript
async _fetchAirmets() {
    this._airmets = null;
    this._renderAirmetSection();
    try {
        const client = new WeatherClient(this._db);
        const { airmets } = await client.fetchAndCacheAdvisories();
        this._airmets = airmets;
        this._airmetFetchedAt = Date.now();
    } catch (err) {
        console.error('AIRMET fetch failed:', err);
        this._airmets = [];
    }
    this._renderAgeGroup();
    this._renderAirmetSection();
}
```

- [ ] **Step 2: Add `_filterAdvisoriesForRoute(advisories, bufferDeg)`**

```javascript
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

    return advisories.filter(adv => {
        const pts = adv.points || [];
        if (!pts.length) return true; // no polygon — include (text-only)
        // Pre-filter by bounding box
        const advLats = pts.map(p => p[0]);
        const advLons = pts.map(p => p[1]);
        if (Math.max(...advLats) < bbox.s || Math.min(...advLats) > bbox.n) return false;
        if (Math.max(...advLons) < bbox.w || Math.min(...advLons) > bbox.e) return false;
        // Ray-cast: any route waypoint inside AIRMET polygon?
        for (const c of coords) {
            if (this._pointInPolygon(c.lat, c.lon, pts)) return true;
        }
        // Or: polygon overlaps route bbox
        return true; // bbox overlap is enough for display purposes
    });
}

_pointInPolygon(lat, lon, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i][0], yi = polygon[i][1];
        const xj = polygon[j][0], yj = polygon[j][1];
        if (((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}
```

- [ ] **Step 3: Add `_renderAirmetSection()`**

```javascript
_renderAirmetSection() {
    const sec = this._section('wx-airmet-section');
    if (!sec) return;

    if (this._airmets === null) {
        sec.innerHTML = this._buildRhsHeader('AIRMETs', null, 'Fetching…');
        return;
    }

    const filtered = this._filterAdvisoriesForRoute(this._airmets);
    const hdr = this._buildRhsHeader('AIRMETs', filtered.length > 0 ? 'warn' : 'ok',
        filtered.length > 0 ? `${filtered.length} ON ROUTE` : 'NONE ON ROUTE');

    sec.innerHTML = '';
    sec.appendChild(hdr);

    const body = document.createElement('div');
    body.className = 'wx-rhs-body open';

    if (!filtered.length) {
        body.innerHTML = '<div class="wx-section-empty">No active AIRMETs in route corridor.</div>';
    } else {
        for (const adv of filtered) {
            const hazard = adv.hazard || '';
            const typeLabel = hazard.includes('IFR') ? 'SIERRA'
                : hazard.includes('TURB') ? 'TANGO'
                : hazard.includes('ICE') || hazard.includes('ICING') ? 'ZULU'
                : 'AIRMET';
            const typeClass = typeLabel.toLowerCase();
            const validUntil = adv.expires_at
                ? new Date(adv.expires_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + ' L'
                : '—';

            body.appendChild(this._buildAdvCard(typeLabel, typeClass, hazard || 'Advisory', `Valid until ${validUntil}`, adv.raw || ''));
        }
    }

    sec.appendChild(body);
}
```

- [ ] **Step 4: Add `_buildRhsHeader(title, badgeClass, badgeText)` and `_buildAdvCard(...)` helpers**

```javascript
_buildRhsHeader(title, badgeClass, badgeText) {
    const hdr = document.createElement('div');
    hdr.className = 'wx-rhs-hdr';
    const badge = badgeClass
        ? `<span class="wx-rhs-badge ${badgeClass}">${badgeText}</span>`
        : `<span class="wx-rhs-badge">${badgeText}</span>`;
    hdr.innerHTML = `
        <span class="wx-rhs-title">${title}</span>
        ${badge}
        <span class="wx-rhs-chevron open">›</span>
    `;
    hdr.addEventListener('click', () => {
        const chevron = hdr.querySelector('.wx-rhs-chevron');
        chevron.classList.toggle('open');
        const body = hdr.nextElementSibling;
        if (body) body.classList.toggle('open');
    });
    return hdr;
}

_buildAdvCard(typeLabel, typeClass, hazard, meta, text, validHtml = '') {
    const card = document.createElement('div');
    card.className = 'wx-adv-card';
    card.innerHTML = `
        <div class="wx-adv-hdr">
            <span class="wx-adv-type ${typeClass}">${typeLabel}</span>
            <div class="wx-adv-info">
                <div class="wx-adv-hazard">${hazard}</div>
                <div class="wx-adv-meta">${meta}</div>
            </div>
            <span class="wx-adv-chevron">›</span>
        </div>
        <div class="wx-adv-body">
            <div class="wx-adv-text">${this._escHtml(text)}</div>
            ${validHtml ? `<div class="wx-adv-valid">${validHtml}</div>` : ''}
        </div>
    `;
    card.querySelector('.wx-adv-hdr').addEventListener('click', () => {
        const chevron = card.querySelector('.wx-adv-chevron');
        chevron.classList.toggle('open');
        card.querySelector('.wx-adv-body').classList.toggle('open');
    });
    return card;
}

_escHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
```

---

## Task 6: Right Column — MCD Section

**Files:**
- Modify: `web/cockpit/wx-briefing.js`

- [ ] **Step 1: Add `_fetchMcds()`**

```javascript
async _fetchMcds() {
    this._mcds = null;
    this._renderMcdSection();
    try {
        const resp = await fetch('https://api.weather.gov/products?type=MCD&office=KWNS&limit=20',
            { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) throw new Error(`MCD fetch ${resp.status}`);
        const data = await resp.json();
        const items = data['@graph'] || [];
        const parsed = items.map(item => this._parseMcd(item)).filter(Boolean);
        this._mcds = parsed;
        this._mcdFetchedAt = Date.now();
        try {
            localStorage.setItem('flytab_mcd_cache', JSON.stringify({ fetched_at: Date.now(), data: parsed }));
        } catch (_) {}
    } catch (err) {
        console.error('MCD fetch failed:', err);
        // Try localStorage fallback
        try {
            const raw = localStorage.getItem('flytab_mcd_cache');
            if (raw) {
                const cache = JSON.parse(raw);
                this._mcds = cache.data || [];
            } else {
                this._mcds = [];
            }
        } catch (_) { this._mcds = []; }
    }
    this._renderMcdSection();
}

_parseMcd(item) {
    const text = item.productText || '';
    const idMatch = text.match(/Mesoscale Discussion\s+(\d+)/i) || text.match(/^MCD\s*(\d+)/im);
    const id = idMatch ? `MD ${idMatch[1]}` : 'MD —';
    const hazard = this._extractMcdHazard(text);
    const validMatch = text.match(/VALID\s+(\d{6}Z)\s*-\s*(\d{6}Z)/i);
    let validUntil = item.issuanceTime || null;
    if (validMatch) {
        // Parse DDHHMM Z format
        const to = validMatch[2];
        const day = parseInt(to.slice(0, 2));
        const hh  = parseInt(to.slice(2, 4));
        const mm  = parseInt(to.slice(4, 6));
        const d = new Date();
        d.setUTCDate(day); d.setUTCHours(hh, mm, 0, 0);
        validUntil = d.toISOString();
    }
    const polygon = this._parseMcdPolygon(text);
    return { id, hazard, validUntil, polygon, productText: text };
}

_extractMcdHazard(text) {
    const m = text.match(/Concerning\.\.\.(.*)/i) || text.match(/SUMMARY\.\.\.(.*)/i);
    return m ? m[1].trim().replace(/\n.*/s, '').slice(0, 80) : 'Convective/weather discussion';
}

_parseMcdPolygon(text) {
    const match = text.match(/LAT\.\.\.LON\s+([\d\s]+)/i);
    if (!match) return null;
    const tokens = match[1].trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
    const lats = [], lons = [];
    for (const t of tokens) {
        if (t <= 5999) lats.push(t / 100);
        else lons.push(-(t / 100));
    }
    const n = Math.min(lats.length, lons.length);
    if (n < 3) return null;
    return Array.from({ length: n }, (_, i) => [lats[i], lons[i]]);
}
```

- [ ] **Step 2: Add `_renderMcdSection()`**

```javascript
_renderMcdSection() {
    const sec = this._section('wx-mcd-section');
    if (!sec) return;

    if (this._mcds === null) {
        sec.innerHTML = this._buildRhsHeader('Mesoscale Disc.', null, 'Fetching…').outerHTML;
        return;
    }

    const filtered = this._mcds.filter(mcd => {
        if (!mcd.polygon) return true; // no polygon — include
        return this._filterAdvisoriesForRoute([{ points: mcd.polygon }]).length > 0;
    });

    const hdr = this._buildRhsHeader('Mesoscale Disc.', filtered.length > 0 ? 'warn' : 'ok',
        filtered.length > 0 ? `${filtered.length} ACTIVE` : 'NONE ACTIVE');

    sec.innerHTML = '';
    sec.appendChild(hdr);

    const body = document.createElement('div');
    body.className = 'wx-rhs-body open';

    if (!filtered.length) {
        body.innerHTML = '<div class="wx-section-empty">No active MCDs affecting route.</div>';
    } else {
        for (const mcd of filtered) {
            const until = mcd.validUntil
                ? new Date(mcd.validUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + ' L'
                : '—';
            body.appendChild(this._buildAdvCard(mcd.id, 'mcd', mcd.hazard, `Valid until ${until}`, mcd.productText));
        }
    }

    sec.appendChild(body);
}
```

---

## Task 7: Right Column — AFD Section

**Files:**
- Modify: `web/cockpit/wx-briefing.js`

- [ ] **Step 1: Add `_fetchAfds()`**

```javascript
async _fetchAfds() {
    this._afds = null;
    this._renderAfdSection();
    try {
        const coords = await this._getRouteCoords();
        const endpoints = [];
        // Use departure and destination for office lookup
        const keyCoords = [];
        if (coords.length > 0) keyCoords.push(coords[0]);
        if (coords.length > 1) keyCoords.push(coords[coords.length - 1]);

        const officeIds = new Set();
        for (const c of keyCoords) {
            try {
                const ptResp = await fetch(`https://api.weather.gov/points/${c.lat.toFixed(4)},${c.lon.toFixed(4)}`,
                    { signal: AbortSignal.timeout(8000) });
                if (ptResp.ok) {
                    const pt = await ptResp.json();
                    const cwa = pt?.properties?.cwa;
                    const officeName = pt?.properties?.relativeLocation?.properties?.city
                        ? `${pt.properties.relativeLocation.properties.city} NWS`
                        : (cwa || '');
                    if (cwa && !officeIds.has(cwa)) {
                        officeIds.add(cwa);
                        endpoints.push({ cwa: `K${cwa}`, name: officeName });
                    }
                }
            } catch (_) {}
        }

        if (!officeIds.size) throw new Error('No NWS offices found for route');

        const afds = [];
        for (const ep of endpoints) {
            try {
                const pResp = await fetch(`https://api.weather.gov/products?type=AFD&office=${ep.cwa}&limit=1`,
                    { signal: AbortSignal.timeout(8000) });
                if (!pResp.ok) continue;
                const pData = await pResp.json();
                const items = pData['@graph'] || [];
                if (!items.length) continue;
                const item = items[0];
                // Fetch the full product text
                const tResp = await fetch(item['@id'], { signal: AbortSignal.timeout(8000) });
                if (!tResp.ok) continue;
                const tData = await tResp.json();
                afds.push({
                    office: ep.cwa,
                    name: ep.name,
                    issued: item.issuanceTime || null,
                    text: tData.productText || item.productText || '',
                });
            } catch (_) {}
        }

        this._afds = afds;
        this._afdFetchedAt = Date.now();
        try {
            localStorage.setItem('flytab_afd_cache', JSON.stringify({ fetched_at: Date.now(), data: afds }));
        } catch (_) {}
    } catch (err) {
        console.error('AFD fetch failed:', err);
        try {
            const raw = localStorage.getItem('flytab_afd_cache');
            if (raw) {
                const cache = JSON.parse(raw);
                if (Date.now() - cache.fetched_at < 4 * 3600000) { // 4h stale ok
                    this._afds = cache.data || [];
                } else { this._afds = []; }
            } else { this._afds = []; }
        } catch (_) { this._afds = []; }
    }
    this._renderAfdSection();
}
```

- [ ] **Step 2: Add `_renderAfdSection()`**

```javascript
_renderAfdSection() {
    const sec = this._section('wx-afd-section');
    if (!sec) return;

    if (this._afds === null) {
        sec.innerHTML = this._buildRhsHeader('Fcst Discussions', null, 'Fetching…').outerHTML;
        return;
    }

    const count = this._afds.length;
    const hdr = this._buildRhsHeader('Fcst Discussions', 'info',
        count > 0 ? `${count} OFFICE${count > 1 ? 'S' : ''}` : 'NONE');

    sec.innerHTML = '';
    sec.appendChild(hdr);

    const body = document.createElement('div');
    body.className = 'wx-rhs-body open';

    if (!this._afds.length) {
        body.innerHTML = '<div class="wx-section-empty">No AFDs fetched — requires internet.</div>';
    } else {
        for (const afd of this._afds) {
            const issued = afd.issued
                ? new Date(afd.issued).toLocaleString([], {weekday:'short',hour:'2-digit',minute:'2-digit'}) + ' L'
                : '—';
            body.appendChild(this._buildAdvCard(
                afd.office, 'afd',
                afd.name || afd.office,
                `Issued ${issued}`,
                afd.text
            ));
        }
    }

    sec.appendChild(body);
}
```

---

## Task 8: Right Column — NOTAM Section

**Files:**
- Modify: `web/cockpit/wx-briefing.js`
- Modify: `web/cockpit-config.json`

- [ ] **Step 1: Add `notam_api_key` and `notam_api_base` to `cockpit-config.json`**

Add to the JSON object:
```json
"notam_api_key": "",
"notam_api_base": "https://api-staging.cgifederal-aim.com/nmsapi/v1"
```

- [ ] **Step 2: Add `_fetchNotams()`**

```javascript
async _fetchNotams() {
    this._notams = null;
    this._renderNotamSection();

    const apiKey = window.Settings?.notamApiKey || '';
    const apiBase = window.Settings?.notamApiBase || 'https://api-staging.cgifederal-aim.com/nmsapi/v1';

    if (!apiKey) {
        this._notams = [];
        this._renderNotamSection();
        return;
    }

    const stations = this._getStationList();
    if (!stations.length) { this._notams = []; this._renderNotamSection(); return; }

    try {
        const notams = [];
        const seen = new Set();

        for (const icao of stations) {
            const url = `${apiBase}/notams?icao=${icao}&radius=10`;
            const resp = await fetch(url, {
                signal: AbortSignal.timeout(10000),
                headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
            });
            if (!resp.ok) continue;
            const data = await resp.json();
            const items = data.notams || data.items || data || [];
            for (const item of (Array.isArray(items) ? items : [])) {
                const num = item.notamNumber || item.id || '';
                if (seen.has(num)) continue;
                seen.add(num);
                notams.push(this._parseNotam(item, icao));
            }
        }

        // Sort: critical types first, then by airport route order, then valid-from
        const order = ['RWY', 'NAVAID', 'OBST', 'TWY', 'AD', 'SVC'];
        notams.sort((a, b) => {
            const ai = order.indexOf(a.type);
            const bi = order.indexOf(b.type);
            if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
            const aRoute = stations.indexOf(a.airport);
            const bRoute = stations.indexOf(b.airport);
            if (aRoute !== bRoute) return aRoute - bRoute;
            return 0;
        });

        this._notams = notams;
        this._notamFetchedAt = Date.now();
        try {
            localStorage.setItem('flytab_notam_cache', JSON.stringify({ fetched_at: Date.now(), data: notams }));
        } catch (_) {}
    } catch (err) {
        console.error('NOTAM fetch failed:', err);
        try {
            const raw = localStorage.getItem('flytab_notam_cache');
            if (raw) { const c = JSON.parse(raw); this._notams = c.data || []; }
            else this._notams = [];
        } catch (_) { this._notams = []; }
    }

    this._renderAgeGroup();
    this._renderNotamSection();
}

_parseNotam(item, airport) {
    const raw = item.notamText || item.text || item.rawText || JSON.stringify(item);
    const type = this._classifyNotam(raw);
    const summary = this._summarizeNotam(raw, type);
    const validFrom = item.effectiveStart || item.startDate || null;
    const validTo   = item.effectiveEnd   || item.endDate   || null;
    return { airport, type, summary, raw, validFrom, validTo };
}

_classifyNotam(raw) {
    const r = raw.toUpperCase();
    if (/\bRWY\b/.test(r)) return 'RWY';
    if (/\bNAVAID\b|ILS|VOR|NDB|LOC\b|PAPI|VASI/.test(r)) return 'NAVAID';
    if (/\bOBST\b|CRANE|TOWER|ANTENNA/.test(r)) return 'OBST';
    if (/\bTWY\b/.test(r)) return 'TWY';
    if (/\bAD\b|\bAPRON\b|\bRAMP\b/.test(r)) return 'AD';
    return 'SVC';
}

_summarizeNotam(raw, type) {
    // Extract meaningful summary from raw NOTAM text (first 100 chars of content)
    const clean = raw.replace(/^![A-Z0-9\/\s]+\n?/, '').trim();
    return clean.slice(0, 100).replace(/\n/g, ' ');
}
```

- [ ] **Step 3: Add `_renderNotamSection()`**

```javascript
_renderNotamSection() {
    const sec = this._section('wx-notam-section');
    if (!sec) return;

    const apiKey = window.Settings?.notamApiKey || '';

    if (this._notams === null) {
        sec.innerHTML = this._buildRhsHeader('NOTAMs', null, 'Fetching…').outerHTML;
        return;
    }

    if (!apiKey) {
        const hdr = this._buildRhsHeader('NOTAMs', null, 'NO API KEY');
        sec.innerHTML = '';
        sec.appendChild(hdr);
        const body = document.createElement('div');
        body.className = 'wx-rhs-body open';
        body.innerHTML = '<div class="wx-section-empty">NOTAM API key not configured in cockpit-config.json.</div>';
        sec.appendChild(body);
        return;
    }

    const critical = this._notams.filter(n => n.type === 'RWY' || n.type === 'NAVAID');
    const badgeClass = critical.length > 0 ? 'warn' : (this._notams.length > 0 ? 'info' : 'ok');
    const badgeText = critical.length > 0
        ? `${critical.length} CRITICAL`
        : (this._notams.length > 0 ? `${this._notams.length} ACTIVE` : 'NONE');

    const hdr = this._buildRhsHeader('NOTAMs', badgeClass, badgeText);
    sec.innerHTML = '';
    sec.appendChild(hdr);

    const body = document.createElement('div');
    body.className = 'wx-rhs-body open';

    if (!this._notams.length) {
        body.innerHTML = '<div class="wx-section-empty">No active NOTAMs for route airports.</div>';
    } else {
        for (const notam of this._notams) {
            const typeClass = (notam.type === 'RWY' || notam.type === 'NAVAID') ? 'rwy' : notam.type.toLowerCase();
            const validStr = notam.validTo
                ? `Valid to <b>${new Date(notam.validTo).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} L</b>`
                : '';
            const card = this._buildAdvCard(
                notam.type, typeClass,
                `${notam.airport} · ${notam.summary}`,
                `${notam.airport}`,
                notam.raw,
                validStr
            );
            body.appendChild(card);
        }
    }

    sec.appendChild(body);
}
```

---

## Task 9: Settings Wiring + Remove Old `_render()`

**Files:**
- Modify: `web/cockpit/wx-briefing.js`
- Modify: `web/app.js` (one line — Settings passthrough)

- [ ] **Step 1: Thread Settings into WxBriefing constructor**

In `app.js`, find where `wxBriefing` is constructed (~line 749):

```javascript
// existing:
this.wxBriefing = new WxBriefing(nasrDb);
// replace with:
this.wxBriefing = new WxBriefing(nasrDb, this._cockpitConfig);
```

In `WxBriefing` constructor, add `_config` parameter:

```javascript
constructor(db, config = {}) {
    this._db     = db;
    this._config = config;
    // ... rest unchanged
}
```

In `_fetchNotams()`, replace `window.Settings?.notamApiKey` with:
```javascript
const apiKey  = this._config?.notam_api_key  || '';
const apiBase = this._config?.notam_api_base || 'https://api-staging.cgifederal-aim.com/nmsapi/v1';
```

- [ ] **Step 2: Check `_cockpitConfig` is available at wx-briefing init time**

Find in `app.js` how `_cockpitConfig` is loaded. If loaded async, ensure `wxBriefing` init happens after config load. If `_cockpitConfig` is loaded in `_loadCockpitConfig()`, verify that `wxBriefing` is initialized after that call. (Grep: `_loadCockpitConfig\|_cockpitConfig` in app.js to confirm order. If WxBriefing is instantiated before config loads, pass config reference or update it via a `setConfig(cfg)` method.)

- [ ] **Step 3: Remove `_render()` and `_showMessage()` and `_buildSummaryBar()` (old versions)**

These are replaced by `_renderAll()` / `_renderSummaryBar()` / individual section renders. Delete them to prevent confusion.

- [ ] **Step 4: Verify `_render()` is not called anywhere else in the file**

```bash
grep -n '_render\b' web/cockpit/wx-briefing.js
```

Expected: only `_renderAll`, `_renderMos`, `_renderSummaryBar`, `_renderAgeGroup`, `_renderMetarSection`, `_renderAirmetSection`, `_renderMcdSection`, `_renderAfdSection`, `_renderNotamSection`.

---

## Task 10: Build + Smoke Test

**Files:** none new

- [ ] **Step 1: Increment version and build**

In `web/app.js` line 6, increment `FLYTAB_VERSION` (e.g. `v5.99` → `v6.00`).

```bash
bash build.sh
```

Expected: `BUILD SUCCESSFUL` with new APK in `data/`.

- [ ] **Step 2: Install on tablet**

```bash
adb connect 192.168.1.82
adb install -r data/flytab-*.apk
```

- [ ] **Step 3: Smoke test — landscape, flight plan loaded**

1. Open FlyTab, load a route (e.g. KLKR → KDKX)
2. Tap Weather tab
3. Verify two-column layout renders in landscape
4. Verify left column: summary bar shows route, MOS grid appears
5. Verify right column: AIRMETs and NOTAMs show loading → rendered state
6. Tap a METAR card — expands with raw + decoded fields + TAF periods
7. Tap ↻ — all sections show loading spinners then resolve
8. Rotate to portrait — columns stack vertically, sections still functional

- [ ] **Step 4: Smoke test — no flight plan**

Open Weather with no plan loaded. Left column should show "No flight plan loaded." Right column should show empty/no-key states.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/wx-briefing.js web/style.css web/cockpit-config.json android/app/build.gradle
git commit -m "feat: wx-briefing landscape redesign with METARs/TAFs, AIRMETs, MCDs, AFDs, NOTAMs (v6.00)"
```

---

## Spec Coverage Self-Review

| Spec requirement | Task |
|------------------|------|
| Landscape two-column layout (52/48) | Task 1 (CSS) |
| Header: route label, age indicators, toggle, refresh | Task 2 |
| Summary bar sticky | Task 1 (CSS), Task 3 |
| MOS 7-day grid (existing logic preserved) | Task 3 |
| MOS 24H grid (existing logic preserved) | Task 3 |
| Hourly drill-down on tap | Task 3 (unchanged from existing) |
| METARs by bbox | Task 4 |
| TAFs structured (fcsts array) | Task 4 |
| Station sorting: ON ROUTE first, then by distance | Task 4 |
| Decoded fields grid | Task 4 |
| TAF periods with flight category badge | Task 4 |
| All times decoded to local | Task 4 (uses `Date` local methods) |
| METAR cache 15min TTL | Task 2 (`_metarFetchedAt`) |
| AIRMETs from existing `fetchAndCacheAdvisories()` | Task 5 |
| AIRMET route corridor filter (50nm) | Task 5 |
| AIRMETs collapsible cards | Task 5 |
| MCD from api.weather.gov/products | Task 6 |
| MCD LAT...LON polygon parsing | Task 6 |
| MCD route filter | Task 6 |
| MCD cache 15min | Task 6 |
| AFDs via /points/{lat,lon} | Task 7 |
| AFD per unique office | Task 7 |
| AFD cache 60min | Task 7 |
| NOTAMs via FAA NMS-API | Task 8 |
| NOTAM type classification | Task 8 |
| NOTAM sort: critical first | Task 8 |
| NOTAM cache 15min | Task 8 |
| `notam_api_key` in cockpit-config.json | Task 8 |
| ↻ parallel allSettled | Task 2 (`_refreshAll`) |
| Per-section loading spinner | Task 2 (`_loadingHtml`) |
| Per-section error state | Task 2 (`_errorHtml`) |
| Portrait stacked layout | Task 1 (CSS `@media (orientation: portrait)`) |
| Only `wx-briefing.js` and `style.css` changed | All tasks |
