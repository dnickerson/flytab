# Route Planner UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the route planner panel to be more compact and pilot-friendly: header with close ✕, compact dep/dest + fuel-stop buttons on one row, settings gear that opens a popup containing all planning options, summary bar showing current settings, Paste/Copy adjacent, "Apply & Close" removed, and a split Plan UX (toolbar Plan = recompute winds on current pills; popup "Plan Route" = A* auto-route).

**Architecture:** All changes confined to `route-planner-panel.js` (DOM rebuild) and `style.css` (new + updated CSS rules). No changes to the planning library, data layer, or apply pipeline. The existing `_onPlanTap()` logic is preserved verbatim and wired to the popup "Plan Route" button; a new lightweight `_onRecomputeTap()` replaces the toolbar Plan button.

**Tech Stack:** Vanilla JS (no framework), CSS in `web/style.css`, Capacitor Android WebView, `wireTap()` for touch events.

---

## File map

| File | Change |
|------|--------|
| `web/cockpit/route-planner-panel.js` | New `_buildHeader()`, rewrite `_buildDepDestRow()`, remove `_buildOptsRow()`, add `_buildSummaryBar()` + `_buildSettingsPopup()` + `_openSettingsPopup()` + `_closeSettingsPopup()` + `_updateSummaryBar()` + `_onRecomputeTap()`, rename A* handler to `_onPlanRouteTap()`, update `_buildToolbar()` and `_buildDOM()`, add constructor refs |
| `web/style.css` | Add ~80 lines of new rpp- rules; retire old opts-row rules |

---

## Task 1 — Constructor: add new DOM refs

**Files:**
- Modify: `web/cockpit/route-planner-panel.js:41-55`

- [ ] Add `this._summaryEl`, `this._popupOverlay`, and `this._legBtnsEl` to the DOM-refs block in the constructor (near the existing `this._ctxMenu` declaration).

```javascript
        this._ctxMenu     = null;
        this._ctxMenuIdx  = null;
        this._typeSubMenu = null;
        this._summaryEl   = null;   // summary bar element
        this._popupOverlay= null;   // settings popup overlay
        this._legBtnsEl   = null;   // leg-button container (for active-state sync)
```

- [ ] Build and confirm no errors:
```bash
bash build.sh 2>&1 | tail -6
```

---

## Task 2 — CSS: new rules for header, compact dep-row, summary bar, settings popup

**Files:**
- Modify: `web/style.css` — append after the last existing `.rpp-` block (around line 10240)

- [ ] Locate the end of the rpp CSS block:
```bash
grep -n "rpp-stat-fuel\|rpp-stat-fetching\|rpp-stat-alt" web/style.css | tail -5
```

- [ ] Append the following CSS block immediately after the last `.rpp-stat-*` rule:

```css
/* ── Route Planner Redesign ─────────────────────────────────────────────── */

/* Panel header — title + close ✕ */
.rpp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 0 10px;
    background: #fff;
    border-bottom: 1px solid #d0d8e4;
    flex-shrink: 0;
    min-height: 48px;
}
.rpp-header-title {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: #1a6fbb;
}
.rpp-close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    min-width: 48px;
    background: none;
    border: none;
    color: #6a7e94;
    font-size: 22px;
    cursor: pointer;
    touch-action: manipulation;
    border-radius: 6px;
}
.rpp-close-btn:active { background: #e8f0f8; }

/* Compact dep/dest row */
.rpp-top-row {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 8px 8px 7px;
    background: #fff;
    border-bottom: 2px solid #d0d8e4;
    flex-shrink: 0;
}
.rpp-icao-wrap {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.rpp-icao-lbl {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .09em;
    text-transform: uppercase;
    color: #8090a8;
    padding-left: 1px;
}
.rpp-icao-inp {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 17px;
    font-weight: 700;
    color: #0a0c0f;
    width: 72px;
    padding: 5px 7px;
    border: 1.5px solid #b8c8d8;
    border-radius: 5px;
    text-align: center;
    text-transform: uppercase;
    background: #fff;
    outline: none;
}
.rpp-icao-inp:focus { border-color: #1a6fbb; }
.rpp-icao-inp::placeholder { color: #b0bac6; font-weight: 400; }
.rpp-top-arrow { font-size: 16px; color: #8090a8; flex-shrink: 0; padding-bottom: 7px; }

/* Leg (fuel-stop) buttons in top row */
.rpp-leg-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-left: 2px;
}
.rpp-leg-group-lbl {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .09em;
    text-transform: uppercase;
    color: #8090a8;
    padding-left: 1px;
}

/* Settings gear button */
.rpp-settings-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 9px;
    background: #fff;
    border: 1.5px solid #b8c8d8;
    border-radius: 5px;
    cursor: pointer;
    color: #2a3a50;
    font-family: inherit;
    font-size: 12px;
    font-weight: 700;
    touch-action: manipulation;
    white-space: nowrap;
    margin-bottom: 0;
}
.rpp-settings-btn:active { background: #edf2fa; }
.rpp-top-spacer { flex: 1; }

/* Summary bar */
.rpp-summary {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0 10px;
    padding: 4px 10px;
    background: #eef4ff;
    border-bottom: 1.5px solid #c0d4f0;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
    touch-action: manipulation;
}
.rpp-summary:active { background: #e4ecfa; }
.rpp-sum-chip { display: flex; align-items: baseline; gap: 3px; white-space: nowrap; }
.rpp-sum-lbl {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: #6080b0;
}
.rpp-sum-val {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 11px;
    font-weight: 700;
    color: #0d2b55;
}
.rpp-sum-sep { color: #90a8c8; font-size: 10px; }

/* Settings popup overlay */
.rpp-popup-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,10,30,.48);
    z-index: 10000;
    display: none;
    align-items: flex-start;
    justify-content: center;
    padding: 56px 16px 16px;
}
.rpp-popup-overlay.open { display: flex; }
.rpp-popup {
    background: #fff;
    border-radius: 8px;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 12px 48px rgba(0,10,40,.28);
    overflow: hidden;
}
.rpp-popup-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    background: #0d2b55;
    color: #fff;
}
.rpp-popup-title {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: .07em;
    text-transform: uppercase;
}
.rpp-popup-hdr-close {
    background: none;
    border: none;
    color: rgba(255,255,255,.65);
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    touch-action: manipulation;
}
.rpp-popup-section {
    padding: 8px 14px 4px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .11em;
    text-transform: uppercase;
    color: #90a8c0;
    border-top: 1px solid #eaf0f8;
}
.rpp-popup-row {
    display: flex;
    align-items: center;
    padding: 6px 14px;
    gap: 10px;
}
.rpp-popup-lbl {
    font-size: 12px;
    font-weight: 700;
    color: #3a5070;
    width: 66px;
    flex-shrink: 0;
}
.rpp-popup-ctrl { flex: 1; }
.rpp-popup-sel,
.rpp-popup-inp-dt {
    font-family: inherit;
    font-size: 14px;
    font-weight: 700;
    width: 100%;
    padding: 7px 9px;
    border: 1.5px solid #c0d0e0;
    border-radius: 5px;
    color: #0a0c0f;
    background: #fff;
    outline: none;
}
.rpp-popup-sel:focus,
.rpp-popup-inp-dt:focus { border-color: #1a6fbb; }
.rpp-popup-num-row { display: flex; align-items: center; gap: 7px; }
.rpp-popup-inp-num {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 15px;
    font-weight: 700;
    width: 70px;
    padding: 6px 8px;
    border: 1.5px solid #c0d0e0;
    border-radius: 5px;
    color: #0a0c0f;
    text-align: center;
    outline: none;
}
.rpp-popup-inp-num:focus { border-color: #1a6fbb; }
.rpp-popup-unit { font-size: 12px; font-weight: 700; color: #6080a0; }
.rpp-popup-check-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 5px 14px 8px;
    cursor: pointer;
}
.rpp-popup-check-row input[type=checkbox] {
    width: 20px; height: 20px; cursor: pointer; accent-color: #1a6fbb;
}
.rpp-popup-check-row label { font-size: 13px; font-weight: 700; color: #2a3a50; cursor: pointer; }
.rpp-popup-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px 14px;
    border-top: 1.5px solid #e0eaf4;
    gap: 8px;
}
.rpp-popup-plan-btn {
    font-family: inherit;
    font-size: 14px;
    font-weight: 700;
    padding: 10px 20px;
    background: #0d2b55;
    color: #fff;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    touch-action: manipulation;
}
.rpp-popup-plan-btn:active { background: #06182e; }
.rpp-popup-done-btn {
    font-family: inherit;
    font-size: 14px;
    font-weight: 700;
    padding: 10px 24px;
    background: #1a6fbb;
    color: #fff;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    touch-action: manipulation;
}
.rpp-popup-done-btn:active { background: #155fa0; }
```

- [ ] Build and confirm no errors:
```bash
bash build.sh 2>&1 | tail -6
```

---

## Task 3 — JS: `_buildDOM()` — wire new structure

**Files:**
- Modify: `web/cockpit/route-planner-panel.js:308-361`

- [ ] Replace the entire `_buildDOM()` method:

```javascript
    _buildDOM() {
        this._el.innerHTML = '';

        const inner = document.createElement('div');
        inner.className = 'rpp-inner';

        inner.appendChild(this._buildHeader());
        inner.appendChild(this._buildTopRow());
        inner.appendChild(this._buildSummaryBar());

        // Avoid strip
        this._avoidStripEl = document.createElement('div');
        this._avoidStripEl.className = 'rpp-avoid-strip';
        this._avoidStripEl.style.display = 'none';
        inner.appendChild(this._avoidStripEl);

        // Warning strip
        this._warnStripEl = document.createElement('div');
        this._warnStripEl.className = 'rpp-warn-strip';
        this._warnStripEl.style.display = 'none';
        inner.appendChild(this._warnStripEl);

        // Stats bar
        this._statsEl = document.createElement('div');
        this._statsEl.className = 'rpp-stats';
        this._statsEl.style.display = 'none';
        inner.appendChild(this._statsEl);

        // Pill box
        const pillBox = document.createElement('div');
        pillBox.className = 'rpp-pill-box';
        this._pillsEl = document.createElement('div');
        this._pillsEl.className = 'rpp-pills';
        pillBox.appendChild(this._pillsEl);
        inner.appendChild(pillBox);

        inner.appendChild(this._buildAddRow());
        inner.appendChild(this._buildToolbar());

        this._routeStrEl = document.createElement('div');
        this._routeStrEl.hidden = true;
        inner.appendChild(this._routeStrEl);

        this._el.appendChild(inner);

        this._buildContextMenu();
        this._buildSettingsPopup();
    }
```

- [ ] Build:
```bash
bash build.sh 2>&1 | tail -6
```

---

## Task 4 — JS: `_buildHeader()` and `_buildTopRow()`

**Files:**
- Modify: `web/cockpit/route-planner-panel.js` — replace `_buildDepDestRow()` with two new methods

- [ ] Replace `_buildDepDestRow()` entirely with `_buildHeader()` and `_buildTopRow()`:

```javascript
    _buildHeader() {
        const hdr = document.createElement('div');
        hdr.className = 'rpp-header';
        const title = document.createElement('div');
        title.className = 'rpp-header-title';
        title.textContent = 'Route Planner';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'rpp-close-btn';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML = '&#x2715;';
        wireTap(closeBtn, () => {
            if (typeof app !== 'undefined') app.closeRoutePlanner();
        });
        hdr.appendChild(title);
        hdr.appendChild(closeBtn);
        return hdr;
    }

    _buildTopRow() {
        const row = document.createElement('div');
        row.className = 'rpp-top-row';

        // Departure
        const depWrap = document.createElement('div');
        depWrap.className = 'rpp-icao-wrap';
        const depLbl = document.createElement('div');
        depLbl.className = 'rpp-icao-lbl';
        depLbl.textContent = 'Dep';
        this._depInput = document.createElement('input');
        this._depInput.className = 'rpp-icao-inp';
        this._depInput.maxLength = 5;
        this._depInput.placeholder = 'ICAO';
        this._depInput.autocomplete = 'off';
        this._depInput.spellcheck = false;
        depWrap.appendChild(depLbl);
        depWrap.appendChild(this._depInput);

        const arrow = document.createElement('div');
        arrow.className = 'rpp-top-arrow';
        arrow.textContent = '→';

        // Destination
        const destWrap = document.createElement('div');
        destWrap.className = 'rpp-icao-wrap';
        const destLbl = document.createElement('div');
        destLbl.className = 'rpp-icao-lbl';
        destLbl.textContent = 'Dest';
        this._destInput = document.createElement('input');
        this._destInput.className = 'rpp-icao-inp';
        this._destInput.maxLength = 5;
        this._destInput.placeholder = 'ICAO';
        this._destInput.autocomplete = 'off';
        this._destInput.spellcheck = false;
        destWrap.appendChild(destLbl);
        destWrap.appendChild(this._destInput);

        // Fuel-stop / max-leg buttons
        const legGroup = document.createElement('div');
        legGroup.className = 'rpp-leg-group';
        const legLbl = document.createElement('div');
        legLbl.className = 'rpp-leg-group-lbl';
        legLbl.textContent = 'Fuel stop';
        this._legBtnsEl = document.createElement('div');
        this._legBtnsEl.className = 'rpp-leg-btns';
        [2.0, 2.5, 3.0].forEach(hrs => {
            const btn = document.createElement('button');
            btn.className = 'rpp-leg-btn' + (this._maxLegHrs === hrs ? ' active' : '');
            btn.textContent = hrs === 2.0 ? '2h' : hrs === 2.5 ? '2.5h' : '3h';
            btn.dataset.hrs = hrs;
            wireTap(btn, () => {
                this._maxLegHrs = hrs;
                this._saveOpts();
                this._legBtnsEl.querySelectorAll('.rpp-leg-btn').forEach(b =>
                    b.classList.toggle('active', parseFloat(b.dataset.hrs) === hrs));
                if (this._route.length >= 2) this._recheckFuelStops();
            });
            this._legBtnsEl.appendChild(btn);
        });
        legGroup.appendChild(legLbl);
        legGroup.appendChild(this._legBtnsEl);

        const spacer = document.createElement('div');
        spacer.className = 'rpp-top-spacer';

        // Settings gear
        const settingsBtn = document.createElement('button');
        settingsBtn.className = 'rpp-settings-btn';
        settingsBtn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="12" cy="12" r="3"/>' +
            '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06' +
            'a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09' +
            'A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83' +
            'l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09' +
            'A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83' +
            'l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09' +
            'a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83' +
            'l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09' +
            'a1.65 1.65 0 0 0-1.51 1z"/></svg> Settings';
        wireTap(settingsBtn, () => this._openSettingsPopup());

        row.appendChild(depWrap);
        row.appendChild(arrow);
        row.appendChild(destWrap);
        row.appendChild(legGroup);
        row.appendChild(spacer);
        row.appendChild(settingsBtn);

        // Sync DEP/DEST inputs → first/last pill (identical to old behaviour)
        this._depInput.addEventListener('change', () => {
            const v = this._depInput.value.trim().toUpperCase();
            if (!v) return;
            this._depInput.value = v;
            if (this._route.length > 0) this._route[0] = { id: v, type: 'dep' };
            else this._route.unshift({ id: v, type: 'dep' });
            this._render();
        });
        this._destInput.addEventListener('change', () => {
            const v = this._destInput.value.trim().toUpperCase();
            if (!v) return;
            this._destInput.value = v;
            if (this._route.length > 1) this._route[this._route.length - 1] = { id: v, type: 'dest' };
            else this._route.push({ id: v, type: 'dest' });
            this._render();
        });

        return row;
    }
```

- [ ] Build:
```bash
bash build.sh 2>&1 | tail -6
```

---

## Task 5 — JS: `_buildSummaryBar()` and `_updateSummaryBar()`

**Files:**
- Modify: `web/cockpit/route-planner-panel.js` — add after `_buildTopRow()`

- [ ] Add both methods. `_updateSummaryBar()` is the single source of truth for summary text and must be called whenever settings change.

```javascript
    _buildSummaryBar() {
        this._summaryEl = document.createElement('div');
        this._summaryEl.className = 'rpp-summary';
        this._summaryEl.title = 'Tap to edit settings';
        wireTap(this._summaryEl, () => this._openSettingsPopup());
        this._updateSummaryBar();
        return this._summaryEl;
    }

    _updateSummaryBar() {
        if (!this._summaryEl) return;
        const ROUTE_LABELS = {
            'v-airways':  'V-airways',
            't-airways':  'T-airways',
            'any':        'Any airway',
            'gps-direct': 'GPS Direct',
            'vors-direct':'VORs Direct',
        };
        const altText   = this._cruiseAltFt
            ? this._cruiseAltFt.toLocaleString() + ' ft'
            : 'Auto VFR';
        const pwrText   = this._pctPower + '% LOP';
        const routeText = ROUTE_LABELS[this._routingMode] || this._routingMode;
        const depText   = this._departureTime
            ? this._departureTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + 'Z'
            : 'Now';
        const rsvText   = this._reserveGal + ' gal rsv';

        const chip = (lbl, val) =>
            `<span class="rpp-sum-chip"><span class="rpp-sum-lbl">${lbl}</span>` +
            `<span class="rpp-sum-val">${val}</span></span>`;
        const sep = '<span class="rpp-sum-sep">·</span>';

        this._summaryEl.innerHTML =
            chip('Alt', altText) + sep +
            chip('Pwr', pwrText) + sep +
            `<span class="rpp-sum-chip"><span class="rpp-sum-val">${routeText}</span></span>` + sep +
            chip('Dep', depText) + sep +
            `<span class="rpp-sum-chip"><span class="rpp-sum-val">${rsvText}</span></span>`;

        // Re-attach tap after innerHTML wipe
        wireTap(this._summaryEl, () => this._openSettingsPopup());
    }
```

- [ ] Build:
```bash
bash build.sh 2>&1 | tail -6
```

---

## Task 6 — JS: `_buildSettingsPopup()`, `_openSettingsPopup()`, `_closeSettingsPopup()`

**Files:**
- Modify: `web/cockpit/route-planner-panel.js` — add after `_updateSummaryBar()`

These replace `_buildOptsRow()`. All the same DOM refs (`_altInput`, `_reserveInput`, `_modeSel`, `_depTimeSel`, `_altSel`, `_pwrSel`) are created here and appended to body as an overlay.

- [ ] Add the three methods:

```javascript
    _buildSettingsPopup() {
        this._popupOverlay = document.createElement('div');
        this._popupOverlay.className = 'rpp-popup-overlay';

        const popup = document.createElement('div');
        popup.className = 'rpp-popup';

        // Header
        const hdr = document.createElement('div');
        hdr.className = 'rpp-popup-hdr';
        const hdrTitle = document.createElement('div');
        hdrTitle.className = 'rpp-popup-title';
        hdrTitle.textContent = 'Flight Settings';
        const hdrClose = document.createElement('button');
        hdrClose.className = 'rpp-popup-hdr-close';
        hdrClose.textContent = '✕';
        wireTap(hdrClose, () => this._closeSettingsPopup());
        hdr.appendChild(hdrTitle);
        hdr.appendChild(hdrClose);
        popup.appendChild(hdr);

        // Helper to build a label+control row
        const mkRow = (lbl, ctrl) => {
            const row = document.createElement('div');
            row.className = 'rpp-popup-row';
            const l = document.createElement('div');
            l.className = 'rpp-popup-lbl';
            l.textContent = lbl;
            const c = document.createElement('div');
            c.className = 'rpp-popup-ctrl';
            c.appendChild(ctrl);
            row.appendChild(l);
            row.appendChild(c);
            return row;
        };
        const mkSel = (options, currentVal) => {
            const sel = document.createElement('select');
            sel.className = 'rpp-popup-sel';
            options.forEach(([v, t]) => {
                const o = document.createElement('option');
                o.value = v; o.textContent = t;
                if (v === currentVal) o.selected = true;
                sel.appendChild(o);
            });
            return sel;
        };
        const mkSection = (label) => {
            const s = document.createElement('div');
            s.className = 'rpp-popup-section';
            s.textContent = label;
            return s;
        };

        // ── Winds & Performance ──
        popup.appendChild(mkSection('Winds & Performance'));

        // Departure time
        this._depTimeSel = document.createElement('input');
        this._depTimeSel.type = 'datetime-local';
        this._depTimeSel.className = 'rpp-popup-inp-dt';
        this._depTimeSel.addEventListener('change', () => {
            this._departureTime = this._depTimeSel.value ? new Date(this._depTimeSel.value) : null;
            this._saveOpts();
            this._updateSummaryBar();
            if (this._lastPlan) this._windsPromise = (this._windsPromise || Promise.resolve()).then(() => this._applyWindsToLastPlan());
        });
        popup.appendChild(mkRow('Depart', this._depTimeSel));

        // Cruise altitude
        this._altSel = mkSel([
            ['',     'Auto (VFR)'],
            ['3500', '3,500 ft'],
            ['4500', '4,500 ft'],
            ['5500', '5,500 ft'],
            ['6500', '6,500 ft'],
            ['7500', '7,500 ft'],
            ['8500', '8,500 ft'],
            ['9500', '9,500 ft'],
            ['10500','10,500 ft'],
            ['11500','11,500 ft'],
        ], this._cruiseAltFt ? String(this._cruiseAltFt) : '');
        this._altSel.addEventListener('change', () => {
            this._cruiseAltFt = this._altSel.value ? parseInt(this._altSel.value, 10) : null;
            this._saveOpts();
            this._updateSummaryBar();
            if (this._lastPlan) this._windsPromise = (this._windsPromise || Promise.resolve()).then(() => this._applyWindsToLastPlan());
        });
        popup.appendChild(mkRow('Altitude', this._altSel));

        // Power
        this._pwrSel = mkSel([
            ['55','55% LOP'],['60','60% LOP'],['65','65% LOP'],['70','70% LOP'],['75','75% LOP'],
        ], String(this._pctPower));
        this._pwrSel.addEventListener('change', () => {
            this._pctPower = parseInt(this._pwrSel.value, 10);
            this._saveOpts();
            this._updateSummaryBar();
            if (this._lastPlan) this._windsPromise = (this._windsPromise || Promise.resolve()).then(() => this._applyWindsToLastPlan());
        });
        popup.appendChild(mkRow('Power', this._pwrSel));

        // ── Auto-routing ──
        popup.appendChild(mkSection('Auto-routing'));

        this._modeSel = mkSel([
            ['v-airways', 'V-airways (default)'],
            ['t-airways', 'T-airways (RNAV)'],
            ['any',       'Any airway'],
            ['gps-direct','GPS Direct'],
            ['vors-direct','VORs Direct'],
        ], this._routingMode);
        this._modeSel.addEventListener('change', () => {
            this._routingMode = this._modeSel.value;
            this._saveOpts();
            this._updateSummaryBar();
        });
        popup.appendChild(mkRow('Routing', this._modeSel));

        // A* planning altitude (distinct from cruise altitude)
        this._altInput = document.createElement('input');
        this._altInput.className = 'rpp-popup-inp-num';
        this._altInput.type = 'number';
        this._altInput.min = '500';
        this._altInput.max = '17500';
        this._altInput.step = '500';
        this._altInput.value = this._altitude;
        this._altInput.addEventListener('change', () => {
            this._altitude = parseInt(this._altInput.value, 10) || 5500;
            this._saveOpts();
        });
        const altNumRow = document.createElement('div');
        altNumRow.className = 'rpp-popup-num-row';
        altNumRow.appendChild(this._altInput);
        const altUnit = document.createElement('span');
        altUnit.className = 'rpp-popup-unit';
        altUnit.textContent = 'ft';
        altNumRow.appendChild(altUnit);
        popup.appendChild(mkRow('A* Alt', altNumRow));

        // ── Fuel Planning ──
        popup.appendChild(mkSection('Fuel Planning'));

        this._reserveInput = document.createElement('input');
        this._reserveInput.className = 'rpp-popup-inp-num';
        this._reserveInput.type = 'number';
        this._reserveInput.min = '1';
        this._reserveInput.max = '30';
        this._reserveInput.value = this._reserveGal;
        this._reserveInput.addEventListener('change', () => {
            this._reserveGal = parseInt(this._reserveInput.value, 10) || 10;
            this._saveOpts();
            this._updateSummaryBar();
        });
        const rsvNumRow = document.createElement('div');
        rsvNumRow.className = 'rpp-popup-num-row';
        rsvNumRow.appendChild(this._reserveInput);
        const rsvUnit = document.createElement('span');
        rsvUnit.className = 'rpp-popup-unit';
        rsvUnit.textContent = 'gal';
        rsvNumRow.appendChild(rsvUnit);
        popup.appendChild(mkRow('Reserve', rsvNumRow));

        // Self-serve checkbox
        const ssRow = document.createElement('div');
        ssRow.className = 'rpp-popup-check-row';
        const ssCheck = document.createElement('input');
        ssCheck.type = 'checkbox';
        ssCheck.id = 'rppSelfServe';
        ssCheck.checked = this._selfServeOnly;
        ssCheck.addEventListener('change', () => {
            this._selfServeOnly = ssCheck.checked;
            this._saveOpts();
        });
        const ssLabel = document.createElement('label');
        ssLabel.htmlFor = 'rppSelfServe';
        ssLabel.textContent = 'Self-serve fuel only';
        ssRow.appendChild(ssCheck);
        ssRow.appendChild(ssLabel);
        popup.appendChild(ssRow);

        // Footer: Plan Route | Done
        const footer = document.createElement('div');
        footer.className = 'rpp-popup-footer';
        const planRouteBtn = document.createElement('button');
        planRouteBtn.className = 'rpp-popup-plan-btn';
        planRouteBtn.textContent = 'Plan Route';
        wireTap(planRouteBtn, () => { this._closeSettingsPopup(); this._onPlanRouteTap(); });
        const doneBtn = document.createElement('button');
        doneBtn.className = 'rpp-popup-done-btn';
        doneBtn.textContent = 'Done';
        wireTap(doneBtn, () => this._closeSettingsPopup());
        footer.appendChild(planRouteBtn);
        footer.appendChild(doneBtn);
        popup.appendChild(footer);

        this._popupOverlay.appendChild(popup);
        document.body.appendChild(this._popupOverlay);

        // Dismiss on backdrop tap
        this._popupOverlay.addEventListener('click', e => {
            if (e.target === this._popupOverlay) this._closeSettingsPopup();
        });
    }

    _openSettingsPopup() {
        // Sync all inputs to current state before showing
        if (this._depTimeSel && this._departureTime) {
            const d = this._departureTime;
            const pad = n => String(n).padStart(2, '0');
            this._depTimeSel.value =
                `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
                `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
        if (this._altSel) this._altSel.value = this._cruiseAltFt ? String(this._cruiseAltFt) : '';
        if (this._pwrSel) this._pwrSel.value = String(this._pctPower);
        if (this._modeSel) this._modeSel.value = this._routingMode;
        if (this._altInput) this._altInput.value = this._altitude;
        if (this._reserveInput) this._reserveInput.value = this._reserveGal;
        const ssCheck = this._popupOverlay?.querySelector('#rppSelfServe');
        if (ssCheck) ssCheck.checked = this._selfServeOnly;
        this._popupOverlay?.classList.add('open');
    }

    _closeSettingsPopup() {
        this._popupOverlay?.classList.remove('open');
    }
```

- [ ] Build:
```bash
bash build.sh 2>&1 | tail -6
```

---

## Task 7 — JS: `destroy()` — clean up popup overlay

**Files:**
- Modify: `web/cockpit/route-planner-panel.js:131-141`

- [ ] Add popup overlay teardown to `destroy()`:

```javascript
    destroy() {
        if (this._onDocClick) {
            document.removeEventListener('click', this._onDocClick);
            this._onDocClick = null;
        }
        if (this._ctxMenu) {
            this._ctxMenu.remove();
            this._ctxMenu = null;
        }
        if (this._typeSubMenu) {
            this._typeSubMenu.remove();
            this._typeSubMenu = null;
        }
        if (this._popupOverlay) {
            this._popupOverlay.remove();
            this._popupOverlay = null;
        }
    }
```

- [ ] Build:
```bash
bash build.sh 2>&1 | tail -6
```

---

## Task 8 — JS: `_buildToolbar()` and Plan button split

**Files:**
- Modify: `web/cockpit/route-planner-panel.js:643-673`

- [ ] Replace `_buildToolbar()`:

```javascript
    _buildToolbar() {
        const bar = document.createElement('div');
        bar.className = 'rpp-toolbar';

        const mkBtn = (label, handler, extraClass = '') => {
            const btn = document.createElement('button');
            btn.className = 'rpp-tbtn' + (extraClass ? ' ' + extraClass : '');
            btn.textContent = label;
            wireTap(btn, handler);
            return btn;
        };

        // Clipboard ops side by side
        bar.appendChild(mkBtn('Paste', () => this._onPasteTap()));
        bar.appendChild(mkBtn('Copy',  () => this._onCopyTap()));

        // Plan = recompute existing pills with winds; does not replace route
        this._planBtn = mkBtn('Plan', () => this._onRecomputeTap());
        bar.appendChild(this._planBtn);

        bar.appendChild(mkBtn('Clear', () => this._onClearTap()));

        this._compactBtn = mkBtn('Compact',
            () => this._onCompactToggle(),
            this._compactView ? 'rpp-tbtn-active' : '');
        bar.appendChild(this._compactBtn);

        // Apply (keep panel open) — Apply & Close removed; ✕ in header closes
        bar.appendChild(mkBtn('Apply', () => this._onApplyKeepOpenTap(), 'rpp-tbtn-apply'));

        return bar;
    }
```

- [ ] Add `_onRecomputeTap()` immediately after `_buildToolbar()`. This replaces the toolbar Plan handler — it recomputes winds on existing pills without re-routing:

```javascript
    async _onRecomputeTap() {
        if (this._route.length < 2) {
            this._toast('Add at least 2 waypoints, or use Settings → Plan Route to auto-route');
            return;
        }
        const setBtn = (label, disabled) => {
            if (!this._planBtn) return;
            this._planBtn.textContent = label;
            this._planBtn.disabled = disabled;
            this._planBtn.classList.toggle('rpp-tbtn-busy', disabled);
        };
        setBtn('Planning…', true);
        try {
            await this._applyWindsToLastPlan();
        } finally {
            setBtn('Plan', false);
        }
    }
```

- [ ] Rename `_onPlanTap()` to `_onPlanRouteTap()` (the A* method now called only from the popup):

Find the line:
```javascript
    async _onPlanTap() {
```
Change it to:
```javascript
    async _onPlanRouteTap() {
```

And inside the method, update the two references to `'Plan'` in `setBtn` calls to stay consistent (they already say `'Plan'` which is fine since this button is in the popup now — but `this._planBtn` refers to the toolbar button). Replace the `setBtn` helper inside `_onPlanRouteTap()` so it doesn't corrupt the toolbar button:

```javascript
    async _onPlanRouteTap() {
        const dep  = this._depInput?.value.trim().toUpperCase();
        const dest = this._destInput?.value.trim().toUpperCase();
        if (!dep || !dest) {
            this._toast('Enter departure and destination');
            return;
        }
        // (rest of method body unchanged — no setBtn references to patch)
```

Actually — inspect the existing `_onPlanTap()` body: it calls `setBtn('Planning…', true)` and `setBtn('Plan', false)` which mutate `this._planBtn` (now the toolbar Plan button). Since Plan Route runs from the popup (not the toolbar), remove the `setBtn` calls from `_onPlanRouteTap()` and replace them with a toast:

```javascript
    async _onPlanRouteTap() {
        const dep  = this._depInput?.value.trim().toUpperCase();
        const dest = this._destInput?.value.trim().toUpperCase();
        if (!dep || !dest) {
            this._toast('Enter departure and destination');
            return;
        }

        this._checkPlannerVersion();

        if (!this._planner) {
            this._toast('Loading airway data…', 3000);
            const ready = await this._waitForPlanner(20000);
            if (!ready) {
                const counts = await this._diagnoseIdb();
                const reason = this._plannerInitError ? ` — init error: ${this._plannerInitError}` : '';
                this._toast(`Airway data not loaded${reason}\n${counts}`, 12000);
                console.error('[RoutePlannerPanel] planner never became ready', counts);
                return;
            }
        }

        const airwayCount = await this._nasrDb?.listAirways?.().then(a => a.length).catch(() => 0) ?? 0;
        if (airwayCount === 0) {
            const counts = await this._diagnoseIdb();
            this._toast(`Airway data not loaded — NASR import incomplete\n${counts}`, 12000);
            console.error('[RoutePlannerPanel] no airways in IDB;', counts);
            return;
        }

        this._toast('Planning route…', 0);
        try {
            const result = await this._planner.plan({
                departure:     dep,
                destination:   dest,
                cruiseAltFt:   this._altitude,
                reserveGal:    this._reserveGal,
                maxLegHrs:     this._maxLegHrs,
                selfServeOnly: this._selfServeOnly,
                avoidance:     this._avoidList.slice(),
                routingMode:   this._routingMode,
                winds:         this._lastWinds ?? undefined,
            });

            if (result.waypoints) {
                for (const wp of result.waypoints) {
                    if (wp.fix && wp.lat != null)
                        this._coords[wp.fix] = { lat: wp.lat, lon: wp.lon };
                }
            }

            const hasManual = this._route.some(
                p => p.type === 'fix' || p.type === 'airport' || p.type === 'awy' || p.type === 'direct' || p.type === 'fuel'
            );
            if (hasManual) {
                const ok = await this._confirm('Replace your current route with the newly planned route?');
                if (!ok) return;
            }

            this._route = this._resultToPills(dep, dest, result);
            this._depInput.value  = dep;
            this._destInput.value = dest;
            this._lastPlan = result;
            this._updateStats(result);
            this._render();
            this._toast(`Route planned · ${result.waypoints?.length || 0} waypoints`, 2500);

            if (result.fuelStopCandidates?.length > 0) {
                await this._processFuelStopCandidates(result);
            } else {
                this._windsPromise = this._applyWindsToLastPlan();
            }
        } catch (err) {
            console.error('[RoutePlannerPanel] plan() failed:', err);
            this._toast('Could not plan route: ' + (err.message || err), 5000);
        }
    }
```

- [ ] Delete the old `_onPlanTap()` method body entirely (it is now replaced by `_onPlanRouteTap()` above).

- [ ] Build:
```bash
bash build.sh 2>&1 | tail -6
```

---

## Task 9 — JS: call `_updateSummaryBar()` from `_loadOpts()`

**Files:**
- Modify: `web/cockpit/route-planner-panel.js` — end of `_loadOpts()`

The summary bar is built before opts are loaded on `init()`, so `_updateSummaryBar()` needs one more call after `_loadOpts()` finishes.

- [ ] Add call at the end of `_loadOpts()`:

```javascript
    _loadOpts() {
        try {
            // ... existing code unchanged ...
        } catch {}
        this._updateSummaryBar();   // ← add this line
    }
```

- [ ] Build:
```bash
bash build.sh 2>&1 | tail -6
```

---

## Task 10 — CSS: retire dead opts-row rules, bump version, final build

**Files:**
- Modify: `web/style.css` — mark old rules obsolete (or remove)
- Modify: `web/app.js` — bump `FLYTAB_VERSION`

The old rules for `.rpp-icao-field`, `.rpp-arrow-sep`, `.rpp-opts-row`, `.rpp-opts-label`, `.rpp-alt-input`, `.rpp-reserve-input`, `.rpp-mode-row`, `.rpp-mode-sel`, `.rpp-dep-time` are now dead. They are harmless to leave but should be removed for cleanliness. The `.rpp-dep-row` shared rule is also unused.

- [ ] Remove the dead rule block from `web/style.css` (lines ~9740–9921, the old shared flex row + opts-row section). Keep `.rpp-leg-btns` and `.rpp-leg-btn` rules — they are still used by the top row.

- [ ] Bump version in `web/app.js`:
```javascript
const FLYTAB_VERSION = 'v7.76';
```

- [ ] Final build:
```bash
bash build.sh 2>&1 | tail -6
```
Expected: `APK: flytab-debug-v7.76.apk`

---

## Self-review

| Requirement | Task |
|-------------|------|
| Panel header with ✕ close | Task 4 `_buildHeader()` |
| Compact dep/dest inputs | Task 4 `_buildTopRow()` |
| Fuel-stop buttons right of dep/dest | Task 4 `_buildTopRow()` |
| Settings gear → popup | Task 4 + Task 6 |
| Summary bar showing Alt/Pwr/Routing/Dep/Rsv | Task 5 |
| Tap summary bar → reopen popup | Task 5 |
| Popup: Depart, Altitude, Power, Routing, A* Alt, Reserve, Self-serve | Task 6 |
| Popup "Plan Route" → A* routing | Task 6 + Task 8 |
| Popup "Done" → save settings only | Task 6 |
| Toolbar Paste + Copy adjacent | Task 8 |
| Toolbar "Plan" → recompute winds only | Task 8 |
| "Apply & Close" removed | Task 8 |
| `destroy()` cleans up popup overlay | Task 7 |
| Dead CSS removed | Task 10 |
| Version bumped + clean build | Tasks 2,3,4,5,6,7,8,9,10 |
