'use strict';

/**
 * RoutePlannerPanel
 * Ground planning tool: pill-based route editor + A* auto-routing.
 * Occupies #routePlannerPanel div; layout controlled by .route-editing on #cockpitContainer.
 * Only outward calls: app.applyRouteEdit(plan) and app.closeRoutePlanner().
 */
class RoutePlannerPanel {
    constructor(panelEl, nasrDb, planningAdapters) {
        this._el      = panelEl;
        this._nasrDb  = nasrDb;
        this._adapters = planningAdapters;

        // Route state — [{id, type}] where type: dep|dest|fix|awy|direct|fuel
        this._route   = [];
        // Index where next add-input item will be inserted (null = before last pill)
        this._insertIndex = null;

        // Coordinate cache from last RoutePlanner.plan() call; also populated by IDB lookups on Apply
        this._coords  = {};   // id -> {lat, lon}

        // RoutePlanner instance — built once, reused across plan() calls
        this._planner = null;
        this._nasrVersion = '';  // localStorage version at graph-build time

        // Planning options (persisted to localStorage)
        this._altitude      = 5500;
        this._maxLegHrs     = 2.0;
        this._selfServeOnly = false;
        this._reserveGal    = 10;

        // Display: compact view shows airways only (no transition fixes).
        // Default ON — pilots want the airway summary in the planner; the map
        // shows all fixes separately.
        this._compactView   = true;

        // Routing mode for A* planner. Default v-airways — GPS 175 doesn't support T-airways.
        this._routingMode   = 'v-airways';

        // DOM refs (set by _buildDOM)
        this._depInput     = null;
        this._destInput    = null;
        this._pillsEl      = null;
        this._avoidStripEl = null;
        this._addInput    = null;
        this._addSel      = null;
        this._routeStrEl  = null;
        this._ctxMenu     = null;
        this._ctxMenuIdx  = null;
        this._altInput    = null;
        this._reserveInput = null;
        this._modeSel      = null;
        this._statsEl      = null;
        this._warnStripEl  = null;

        // Drag state
        this._dragIdx = null;

        // Avoid list — IDs of fixes/airways the user has chosen to route around
        this._avoidList = [];

        // Render epoch — incremented on each _renderPills() call to invalidate stale long-press timers
        this._renderEpoch = 0;

        // Document click handler ref for destroy()
        this._onDocClick = null;

        // Winds / performance opts
        this._departureTime = null;     // Date | null
        this._cruiseAltFt   = null;     // number | null — separate from _altitude (A* planning alt)
        this._pctPower      = 65;
        this._altSel        = null;     // <select> DOM ref
        this._depTimeSel    = null;     // <input datetime-local> DOM ref
        this._pwrSel        = null;     // <select> DOM ref
        this._lastPlan      = null;     // raw A* result before winds applied
        this._currentPlan   = null;     // wind-corrected result
        this._fetchingWinds = false;
        this._windWarnings  = [];
    }

    /** Build DOM, wire events, start building airway graph. */
    init() {
        this._loadOpts();
        this._buildDOM();
        this._startBuildPlanner();
    }

    /** Load plan into pill editor and show. Called by app.openRoutePlanner(plan). */
    open(plan) {
        this._applyAborted = false;
        this._loadPlan(plan);
        this._render();
    }

    /** Clear state. Called by app.closeRoutePlanner(). */
    close() {
        this._applyAborted = true;
        this._route        = [];
        this._insertIndex  = null;
    }

    /** Clean up listeners. Call when the panel is permanently removed. */
    destroy() {
        if (this._onDocClick) {
            document.removeEventListener('click', this._onDocClick);
            this._onDocClick = null;
        }
        if (this._ctxMenu) {
            this._ctxMenu.remove();
            this._ctxMenu = null;
        }
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    _loadOpts() {
        try {
            const saved = JSON.parse(localStorage.getItem('flypi_planner_opts') || '{}');
            if (saved.altitude      != null) this._altitude      = saved.altitude;
            if (saved.maxLegHrs     != null) this._maxLegHrs     = saved.maxLegHrs;
            if (saved.selfServeOnly != null) this._selfServeOnly = saved.selfServeOnly;
            if (saved.reserveGal    != null) this._reserveGal    = saved.reserveGal;
            if (saved.compactView   != null) this._compactView   = saved.compactView;
            if (saved.routingMode   != null) this._routingMode   = saved.routingMode;
            if (Array.isArray(saved.avoidList)) this._avoidList  = saved.avoidList;
            if (saved.departureTime) this._departureTime = new Date(saved.departureTime);
            if (saved.cruiseAltFt  != null) {
                this._cruiseAltFt = saved.cruiseAltFt;
                if (this._altSel) this._altSel.value = String(saved.cruiseAltFt);
            }
            if (saved.pctPower != null) {
                this._pctPower = saved.pctPower;
                if (this._pwrSel) this._pwrSel.value = String(saved.pctPower);
            }
        } catch {}
    }

    _saveOpts() {
        try {
            localStorage.setItem('flypi_planner_opts', JSON.stringify({
                altitude:      this._altitude,
                maxLegHrs:     this._maxLegHrs,
                selfServeOnly: this._selfServeOnly,
                reserveGal:    this._reserveGal,
                compactView:   this._compactView,
                routingMode:   this._routingMode,
                avoidList:     this._avoidList,
                departureTime: this._departureTime ? this._departureTime.toISOString() : null,
                cruiseAltFt:   this._cruiseAltFt,
                pctPower:      this._pctPower,
            }));
        } catch {}
    }

    // ── Plan loader ───────────────────────────────────────────────────────────

    _loadPlan(plan) {
        if (!plan) { this._route = []; return; }

        // Prefer flight_plan.route — it preserves airway pills (V143, T295, etc.)
        // that otherwise would be stripped when only waypoints are saved.
        // Process the array directly — joining with spaces would split multi-word
        // fix names like 'La Guardia' into two pills (LA + GUARDIA).
        const routeIds = plan.flight_plan?.route;
        if (Array.isArray(routeIds) && routeIds.length >= 2) {
            this._route = routeIds.map((id, i) => {
                let type;
                if (i === 0)                          type = 'dep';
                else if (i === routeIds.length - 1)   type = 'dest';
                else if (/^[VTJQ]\d/.test(id))        type = 'awy';
                else if (id === 'DIRECT')             type = 'direct';
                else                                   type = 'fix';
                return { id, type };
            });
            // Re-tag fix pills with their preceding airway so _collapseSameAirway
            // can identify interior fixes in compact view. Without this, saved
            // routes load with no airway tags and compact has nothing to hide.
            let activeAirway = null;
            for (const pill of this._route) {
                if (pill.type === 'awy')    activeAirway = pill.id;
                else if (pill.type === 'direct') activeAirway = null;
                else if (pill.type === 'fix' && activeAirway) pill.airway = activeAirway;
            }
        } else {
            const wps = plan.waypoints || [];
            if (wps.length === 0) { this._route = []; return; }
            // Fall back to fix-only pills from waypoints (no airway annotation)
            this._route = wps.map((wp, i) => {
                const id   = wp.icao || wp.name || wp.fix || '?';
                let   type = 'fix';
                if (i === 0)                   type = 'dep';
                else if (i === wps.length - 1) type = 'dest';
                return { id, type };
            });
        }

        // Seed _coords from loaded plan so Apply works without re-running plan()
        const wps = plan.waypoints || [];
        for (const wp of wps) {
            const id = wp.icao || wp.name || wp.fix;
            if (id && wp.lat != null && wp.lon != null)
                this._coords[id] = { lat: wp.lat, lon: wp.lon };
        }

        // Sync DEP/DEST inputs from the first/last non-airway pill
        const firstFix = this._route.find(p => p.type !== 'awy' && p.type !== 'direct');
        const lastFix  = [...this._route].reverse().find(p => p.type !== 'awy' && p.type !== 'direct');
        if (this._depInput  && firstFix) this._depInput.value  = firstFix.id;
        if (this._destInput && lastFix)  this._destInput.value = lastFix.id;
    }

    // ── Async planner build ───────────────────────────────────────────────────

    _startBuildPlanner() {
        // Use the new planning library via window.FlyTabPlanning. If the module
        // hasn't loaded yet (asynchronous), wait for the 'flytab-planning:ready' event.
        this._nasrVersion = localStorage.getItem('flypi_nasr_version') || '';
        const start = () => {
            try {
                this._planner = new window.FlyTabPlanning.RoutePlanner(this._adapters);
            } catch (err) {
                console.warn('[RoutePlannerPanel] planner init failed:', err);
            }
        };
        if (window.FlyTabPlanning?.RoutePlanner) start();
        else document.addEventListener('flytab-planning:ready', start, { once: true });
    }

    /**
     * Read record counts from the NASR database so the user can see at a glance
     * whether the NASR import populated the right stores. Returns a summary string.
     */
    async _diagnoseIdb() {
        const dbName = this._nasrDb?.constructor?.DB_NAME || 'flypi';
        const STORES = ['airports', 'airways', 'navaids', 'fixes', 'sua'];
        const counts = {};
        let dbVersion = null;
        try {
            const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(dbName);
                req.onsuccess = () => resolve(req.result);
                req.onerror   = () => reject(req.error);
            });
            dbVersion = db.version;
            const existing = STORES.filter(n => db.objectStoreNames.contains(n));
            for (const name of STORES) {
                if (!existing.includes(name)) { counts[name] = 'no store'; continue; }
                counts[name] = await new Promise((resolve, reject) => {
                    const tx = db.transaction(name, 'readonly');
                    const req = tx.objectStore(name).count();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror   = () => reject(req.error);
                });
            }
            db.close();
        } catch (err) {
            return `IDB read failed: ${err?.message || err}`;
        }
        const parts = STORES.map(n => `${n}=${counts[n]}`);
        return `${dbName} v${dbVersion}, ${parts.join(', ')}`;
    }

    _checkPlannerVersion() {
        const current = localStorage.getItem('flypi_nasr_version') || '';
        if (current !== this._nasrVersion) {
            this._nasrVersion = current;
            this._planner = null;
            this._startBuildPlanner();
        }
    }

    // ── DOM builder ───────────────────────────────────────────────────────────

    _buildDOM() {
        this._el.innerHTML = '';

        const inner = document.createElement('div');
        inner.className = 'rpp-inner';

        // DEP / DEST row
        inner.appendChild(this._buildDepDestRow());

        // Planning options row
        inner.appendChild(this._buildOptsRow());

        // Avoid strip — shown above pills when the user has excluded fixes/airways
        this._avoidStripEl = document.createElement('div');
        this._avoidStripEl.className = 'rpp-avoid-strip';
        this._avoidStripEl.style.display = 'none';
        inner.appendChild(this._avoidStripEl);

        // Amber warning strip — shown when wind data unavailable or other planning warnings
        this._warnStripEl = document.createElement('div');
        this._warnStripEl.className = 'rpp-warn-strip';
        this._warnStripEl.style.display = 'none';
        inner.appendChild(this._warnStripEl);

        // Distance/time/fuel stats bar — shown above pills after plan() so it's always visible
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

        // Add-input row
        inner.appendChild(this._buildAddRow());

        // Toolbar: action buttons + Apply on the same row
        inner.appendChild(this._buildToolbar());

        // Hidden element backing the Copy button (kept so Copy can read the route)
        this._routeStrEl = document.createElement('div');
        this._routeStrEl.hidden = true;
        inner.appendChild(this._routeStrEl);

        this._el.appendChild(inner);

        // Context menu (appended to body so it floats above everything)
        this._buildContextMenu();
    }

    _buildDepDestRow() {
        const row = document.createElement('div');
        row.className = 'rpp-dep-row';

        const depField = document.createElement('div');
        depField.className = 'rpp-icao-field';
        depField.innerHTML = '<label>Departure</label>';
        this._depInput = document.createElement('input');
        this._depInput.maxLength = 5;
        this._depInput.placeholder = 'ICAO';
        depField.appendChild(this._depInput);

        const arrow = document.createElement('div');
        arrow.className = 'rpp-arrow-sep';
        arrow.textContent = '→';

        const destField = document.createElement('div');
        destField.className = 'rpp-icao-field';
        destField.innerHTML = '<label>Destination</label>';
        this._destInput = document.createElement('input');
        this._destInput.maxLength = 5;
        this._destInput.placeholder = 'ICAO';
        destField.appendChild(this._destInput);

        row.appendChild(depField);
        row.appendChild(arrow);
        row.appendChild(destField);

        // Sync DEP/DEST inputs → first/last pill
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

    _buildOptsRow() {
        const row = document.createElement('div');
        row.className = 'rpp-opts-row';

        // Altitude
        const altLabel = document.createElement('span');
        altLabel.className = 'rpp-opts-label';
        altLabel.textContent = 'Alt';
        this._altInput = document.createElement('input');
        this._altInput.className = 'rpp-alt-input';
        this._altInput.type = 'number';
        this._altInput.min = '500';
        this._altInput.max = '17500';
        this._altInput.step = '500';
        this._altInput.value = this._altitude;
        const altSuffix = document.createElement('span');
        altSuffix.className = 'rpp-opts-label';
        altSuffix.textContent = 'ft';
        this._altInput.addEventListener('change', () => {
            this._altitude = parseInt(this._altInput.value, 10) || 5500;
            this._saveOpts();
        });

        // Max leg buttons
        const legLabel = document.createElement('span');
        legLabel.className = 'rpp-opts-label';
        legLabel.textContent = 'Leg';
        const legBtns = document.createElement('div');
        legBtns.className = 'rpp-leg-btns';
        [2.0, 2.5, 3.0].forEach(hrs => {
            const btn = document.createElement('button');
            btn.className = 'rpp-leg-btn' + (this._maxLegHrs === hrs ? ' active' : '');
            btn.textContent = hrs === 2.0 ? '2h' : hrs === 2.5 ? '2.5h' : '3h';
            btn.dataset.hrs = hrs;
            wireTap(btn, () => {
                this._maxLegHrs = hrs;
                this._saveOpts();
                legBtns.querySelectorAll('.rpp-leg-btn').forEach(b =>
                    b.classList.toggle('active', parseFloat(b.dataset.hrs) === hrs));
            });
            legBtns.appendChild(btn);
        });

        // Self-serve checkbox
        const ssLabel = document.createElement('label');
        ssLabel.className = 'rpp-check-row';
        const ssCheck = document.createElement('input');
        ssCheck.type = 'checkbox';
        ssCheck.checked = this._selfServeOnly;
        ssCheck.addEventListener('change', () => {
            this._selfServeOnly = ssCheck.checked;
            this._saveOpts();
        });
        ssLabel.appendChild(ssCheck);
        ssLabel.appendChild(document.createTextNode('Self-serve'));

        // Reserve gallon input
        const rsvLabel = document.createElement('span');
        rsvLabel.className = 'rpp-opts-label';
        rsvLabel.textContent = 'Rsv';
        this._reserveInput = document.createElement('input');
        this._reserveInput.className = 'rpp-reserve-input';
        this._reserveInput.type = 'number';
        this._reserveInput.min = '1';
        this._reserveInput.max = '30';
        this._reserveInput.value = this._reserveGal;
        const rsvSuffix = document.createElement('span');
        rsvSuffix.className = 'rpp-opts-label';
        rsvSuffix.textContent = 'gal';
        this._reserveInput.addEventListener('change', () => {
            this._reserveGal = parseInt(this._reserveInput.value, 10) || 10;
            this._saveOpts();
        });

        row.appendChild(altLabel);
        row.appendChild(this._altInput);
        row.appendChild(altSuffix);
        row.appendChild(legLabel);
        row.appendChild(legBtns);
        row.appendChild(ssLabel);
        row.appendChild(rsvLabel);
        row.appendChild(this._reserveInput);
        row.appendChild(rsvSuffix);

        // Routing-mode row
        const modeRow = document.createElement('div');
        modeRow.className = 'rpp-mode-row';
        const modeLabel = document.createElement('span');
        modeLabel.className = 'rpp-opts-label';
        modeLabel.textContent = 'Routing';
        this._modeSel = document.createElement('select');
        this._modeSel.className = 'rpp-mode-sel';
        [
            ['v-airways',  'V-airways (default)'],
            ['t-airways',  'T-airways (RNAV)'],
            ['any',        'Any airway'],
            ['gps-direct', 'GPS Direct'],
            ['vors-direct','VORs Direct'],
        ].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            if (v === this._routingMode) o.selected = true;
            this._modeSel.appendChild(o);
        });
        this._modeSel.addEventListener('change', () => {
            this._routingMode = this._modeSel.value;
            this._saveOpts();
        });
        modeRow.appendChild(modeLabel);
        modeRow.appendChild(this._modeSel);
        row.appendChild(modeRow);

        // Departure time row
        const depRow = document.createElement('div');
        depRow.className = 'rpp-mode-row';
        const depLabel = document.createElement('span');
        depLabel.className = 'rpp-opts-label';
        depLabel.textContent = 'Depart';
        this._depTimeSel = document.createElement('input');
        this._depTimeSel.type = 'datetime-local';
        this._depTimeSel.className = 'rpp-dep-time';
        this._depTimeSel.addEventListener('change', () => {
            this._departureTime = this._depTimeSel.value ? new Date(this._depTimeSel.value) : null;
            this._saveOpts();
            if (this._lastPlan) this._applyWindsToLastPlan();
        });
        depRow.appendChild(depLabel);
        depRow.appendChild(this._depTimeSel);
        row.appendChild(depRow);

        // Altitude (cruise, for wind/perf — distinct from A* planning altitude)
        const altRow = document.createElement('div');
        altRow.className = 'rpp-mode-row';
        const altLabel2 = document.createElement('span');
        altLabel2.className = 'rpp-opts-label';
        altLabel2.textContent = 'Altitude';
        this._altSel = document.createElement('select');
        this._altSel.className = 'rpp-mode-sel';
        [
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
        ].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            if (v && parseInt(v) === this._cruiseAltFt) o.selected = true;
            this._altSel.appendChild(o);
        });
        this._altSel.addEventListener('change', () => {
            this._cruiseAltFt = this._altSel.value ? parseInt(this._altSel.value, 10) : null;
            this._saveOpts();
            if (this._lastPlan) this._applyWindsToLastPlan();
        });
        altRow.appendChild(altLabel2);
        altRow.appendChild(this._altSel);
        row.appendChild(altRow);

        // Power %
        const pwrRow = document.createElement('div');
        pwrRow.className = 'rpp-mode-row';
        const pwrLabel = document.createElement('span');
        pwrLabel.className = 'rpp-opts-label';
        pwrLabel.textContent = 'Power';
        this._pwrSel = document.createElement('select');
        this._pwrSel.className = 'rpp-mode-sel';
        [
            ['55', '55% LOP'],
            ['60', '60% LOP'],
            ['65', '65% LOP'],
            ['70', '70% LOP'],
            ['75', '75% LOP'],
        ].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            if (parseInt(v) === this._pctPower) o.selected = true;
            this._pwrSel.appendChild(o);
        });
        this._pwrSel.addEventListener('change', () => {
            this._pctPower = parseInt(this._pwrSel.value, 10);
            this._saveOpts();
            if (this._lastPlan) this._applyWindsToLastPlan();
        });
        pwrRow.appendChild(pwrLabel);
        pwrRow.appendChild(this._pwrSel);
        row.appendChild(pwrRow);

        return row;
    }

    _buildAddRow() {
        const row = document.createElement('div');
        row.className = 'rpp-add-row';

        this._addInput = document.createElement('input');
        this._addInput.className = 'rpp-add-input';
        this._addInput.placeholder = 'Fix or airway (e.g. RIC, V3)';

        this._addSel = document.createElement('select');
        this._addSel.className = 'rpp-add-sel';
        [['fix','Fix'],['awy','Airway'],['direct','Direct']].forEach(([v,t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            this._addSel.appendChild(o);
        });

        const addBtn = document.createElement('button');
        addBtn.className = 'rpp-add-btn';
        addBtn.textContent = '+ Add';

        wireTap(addBtn, () => this._onAddTap());
        this._addInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') this._onAddTap();
        });

        row.appendChild(this._addInput);
        row.appendChild(this._addSel);
        row.appendChild(addBtn);

        return row;
    }

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

        bar.appendChild(mkBtn('Paste',       () => this._onPasteTap()));
        this._planBtn = mkBtn('Plan',        () => this._onPlanTap());
        bar.appendChild(this._planBtn);
        bar.appendChild(mkBtn('Clear',       () => this._onClearTap()));
        bar.appendChild(mkBtn('Copy',        () => this._onCopyTap()));

        // Compact toggle — label always reads 'Compact'; active state shown via blue fill
        this._compactBtn = mkBtn('Compact',
                                  () => this._onCompactToggle(),
                                  this._compactView ? 'rpp-tbtn-active' : '');
        bar.appendChild(this._compactBtn);

        // Apply (panel stays open, pilot can iterate) and Apply & Close
        // (legacy commit-and-dismiss). Both run the same _doApply() pipeline.
        bar.appendChild(mkBtn('Apply',         () => this._onApplyKeepOpenTap(), 'rpp-tbtn-apply'));
        bar.appendChild(mkBtn('Apply & Close', () => this._onApplyTap(),         'rpp-tbtn-apply'));

        return bar;
    }

    _buildContextMenu() {
        this._ctxMenu = document.createElement('div');
        this._ctxMenu.className = 'rpp-menu';
        this._ctxMenu.innerHTML = `
            <div class="rpp-menu-label" id="rppMenuTitle">Waypoint</div>
            <div class="rpp-menu-sep"></div>
            <div class="rpp-menu-item" id="rppMInsertBefore">Insert before</div>
            <div class="rpp-menu-item" id="rppMInsertAfter">Insert after</div>
            <div class="rpp-menu-sep"></div>
            <div class="rpp-menu-item" id="rppMChangeType">Change type</div>
            <div class="rpp-menu-sep" id="rppMAvoidSep"></div>
            <div class="rpp-menu-item rpp-menu-avoid" id="rppMAvoid">Avoid &amp; Re-plan</div>
            <div class="rpp-menu-sep"></div>
            <div class="rpp-menu-item" id="rppMAlt">Set altitude…</div>
            <div class="rpp-menu-sep"></div>
            <div class="rpp-menu-item danger" id="rppMDelete">Remove</div>
        `;
        document.body.appendChild(this._ctxMenu);

        this._onDocClick = () => this._closeMenu();
        document.addEventListener('click', this._onDocClick);
        this._ctxMenu.addEventListener('click', e => e.stopPropagation());

        this._ctxMenu.querySelector('#rppMDelete').addEventListener('click', () => {
            if (this._ctxMenuIdx !== null) this._route.splice(this._ctxMenuIdx, 1);
            this._closeMenu(); this._render();
        });
        this._ctxMenu.querySelector('#rppMInsertBefore').addEventListener('click', () => {
            const i = this._ctxMenuIdx; this._closeMenu();
            if (i !== null) { this._insertIndex = i; this._addInput.focus(); }
        });
        this._ctxMenu.querySelector('#rppMInsertAfter').addEventListener('click', () => {
            const i = this._ctxMenuIdx; this._closeMenu();
            if (i !== null) { this._insertIndex = i + 1; this._addInput.focus(); }
        });
        this._ctxMenu.querySelector('#rppMChangeType').addEventListener('click', () => {
            if (this._ctxMenuIdx === null) { this._closeMenu(); return; }
            const types = ['fix','awy','direct','dep','dest','fuel'];
            const cur = this._route[this._ctxMenuIdx].type;
            this._route[this._ctxMenuIdx].type = types[(types.indexOf(cur) + 1) % types.length];
            this._closeMenu(); this._render();
        });
        this._ctxMenu.querySelector('#rppMAvoid').addEventListener('click', () => {
            const i = this._ctxMenuIdx;
            this._closeMenu();
            if (i === null) return;
            const item = this._route[i];
            if (!this._avoidList.includes(item.id)) this._avoidList.push(item.id);
            this._route.splice(i, 1);
            this._saveOpts();
            this._render();
            this._onPlanTap();
        });
        this._ctxMenu.querySelector('#rppMAlt').addEventListener('click', () => {
            const i = this._ctxMenuIdx; this._closeMenu();
            if (i === null) return;
            const item = this._route[i];
            if (item.type !== 'fix') return;
            const current = item.altFt ? String(item.altFt) : '';
            const input = prompt(`Altitude for ${item.id} (ft, blank = route default):`, current);
            if (input === null) return;
            item.altFt = input.trim() ? parseInt(input) : undefined;
            this._saveOpts();
            this._render();
            if (this._lastPlan) this._applyWindsToLastPlan();
        });
    }

    _openMenu(e, idx) {
        this._ctxMenuIdx = idx;
        const item = this._route[idx];
        this._ctxMenu.querySelector('#rppMenuTitle').textContent =
            item.id + ' · ' + item.type.toUpperCase();

        // "Avoid & Re-plan" is only meaningful for intermediate fix/airway pills
        // and requires the planner to be ready. Hide it for DEP, DEST, and fuel stops.
        const canAvoid = this._planner &&
            (item.type === 'fix' || item.type === 'awy' || item.type === 'direct');
        this._ctxMenu.querySelector('#rppMAvoid').style.display    = canAvoid ? '' : 'none';
        this._ctxMenu.querySelector('#rppMAvoidSep').style.display = canAvoid ? '' : 'none';

        const canSetAlt = item.type === 'fix';
        this._ctxMenu.querySelector('#rppMAlt').style.display = canSetAlt ? '' : 'none';

        this._ctxMenu.classList.add('open');
        const x = Math.min((e.clientX || e.pageX || 0), window.innerWidth  - 180);
        const y = Math.min((e.clientY || e.pageY || 0) + 8, window.innerHeight - 180);
        this._ctxMenu.style.left = x + 'px';
        this._ctxMenu.style.top  = y + 'px';
    }

    _closeMenu() {
        this._ctxMenu.classList.remove('open');
        this._ctxMenuIdx = null;
    }

    // ── Render ────────────────────────────────────────────────────────────────

    _render() {
        this._renderAvoidStrip();
        this._renderPills();
        this._renderRouteStr();
    }

    _renderAvoidStrip() {
        if (!this._avoidStripEl) return;
        this._avoidStripEl.innerHTML = '';
        if (!this._avoidList.length) {
            this._avoidStripEl.style.display = 'none';
            return;
        }
        this._avoidStripEl.style.display = '';
        const label = document.createElement('span');
        label.className = 'rpp-avoid-label';
        label.textContent = 'Avoiding:';
        this._avoidStripEl.appendChild(label);
        for (const id of this._avoidList) {
            const chip = document.createElement('span');
            chip.className = 'rpp-avoid-chip';
            chip.textContent = id + ' ×';
            chip.addEventListener('click', () => {
                this._avoidList = this._avoidList.filter(x => x !== id);
                this._saveOpts();
                this._render();
            });
            this._avoidStripEl.appendChild(chip);
        }
        const clearAll = document.createElement('span');
        clearAll.className = 'rpp-avoid-clearall';
        clearAll.textContent = 'Clear all';
        clearAll.addEventListener('click', () => { this._avoidList = []; this._saveOpts(); this._render(); });
        this._avoidStripEl.appendChild(clearAll);
    }

    _renderWindWarnings() {
        if (!this._warnStripEl) return;
        if (!this._windWarnings.length) { this._warnStripEl.style.display = 'none'; return; }
        this._warnStripEl.style.display = '';
        this._warnStripEl.innerHTML = this._windWarnings.map((w, i) =>
            `<span class="rpp-warn-chip">${w}<button class="rpp-warn-x" data-i="${i}">×</button></span>`
        ).join('');
        this._warnStripEl.querySelectorAll('.rpp-warn-x').forEach(btn => {
            btn.addEventListener('click', () => {
                this._windWarnings.splice(parseInt(btn.dataset.i), 1);
                this._renderWindWarnings();
            });
        });
    }

    _renderRouteStr() {
        if (this._routeStrEl)
            this._routeStrEl.textContent = this._buildField15String(this._route);
    }

    _updateStats(result) {
        if (!this._statsEl) return;
        const legs = result?.legs || [];
        const summary = result?.summary;
        const wps = result?.waypoints;
        if (!wps?.length) { this._statsEl.style.display = 'none'; return; }

        const dep  = wps[0];
        const dest = wps[wps.length - 1];
        const routeNm = summary?.totalDistNm ?? legs.reduce((s, l) => s + (l.distNm || 0), 0);
        if (routeNm == null || dep?.lat == null || dest?.lat == null) { this._statsEl.style.display = 'none'; return; }

        const directNm  = NasrDB.haversineNm(dep.lat, dep.lon, dest.lat, dest.lon);
        const deltaNm   = routeNm - directNm;
        const deltaPct  = directNm > 0 ? (deltaNm / directNm * 100) : 0;

        // Wind summary: average (GS - TAS) across legs that have wind data
        const windLegs = legs.filter(l => l.windDir !== undefined && l.gsKt && l.tasKt);
        let windLabel = '';
        if (windLegs.length) {
            const avgComp = windLegs.reduce((s, l) => s + (l.gsKt - l.tasKt), 0) / windLegs.length;
            const tag = avgComp >= 0 ? `TW ${Math.round(avgComp)}kt` : `HW ${Math.round(-avgComp)}kt`;
            windLabel = `<span class="rpp-stat-wind">${tag}</span>`;
        } else if (this._fetchingWinds) {
            windLabel = `<span class="rpp-stat-wind rpp-stat-fetching">Fetching winds…</span>`;
        }

        // Altitude label (first leg's altFt, or selector value)
        const altFt = legs[0]?.altFt ?? this._cruiseAltFt;
        const altLabel = altFt != null ? `<span class="rpp-stat-alt">${altFt.toLocaleString()} ft</span>` : '';

        // ETE
        const eteHrs = summary?.totalEteHrs;
        const eteLabel = eteHrs != null
            ? (() => { const h = Math.floor(eteHrs); const m = Math.round((eteHrs - h) * 60); return `${h}h ${String(m).padStart(2,'0')}m`; })()
            : '';

        // ETA — local time from last leg
        const lastEta = legs.length ? legs[legs.length - 1]?.eta : undefined;
        const etaLabel = lastEta
            ? new Date(lastEta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';

        // Fuel
        const fuelLabel = summary?.totalFuelGal != null
            ? `<span class="rpp-stat-fuel">${summary.totalFuelGal.toFixed(1)} gal</span>` : '';

        const sign = n => n >= 0 ? '+' : '';
        this._statsEl.innerHTML =
            `${altLabel}${windLabel}` +
            `<span class="rpp-stat-sep">·</span>` +
            `<span class="rpp-stat-item"><span class="rpp-stat-label">Route</span>${Math.round(routeNm)} nm</span>` +
            `<span class="rpp-stat-sep">·</span>` +
            `<span class="rpp-stat-item rpp-stat-delta">${sign(deltaNm)}${Math.round(deltaNm)} nm (${sign(deltaPct)}${deltaPct.toFixed(0)}%)</span>` +
            (eteLabel ? `<span class="rpp-stat-sep">·</span><span class="rpp-stat-item">${eteLabel}${etaLabel ? ` · ETA ${etaLabel}` : ''}</span>` : '') +
            (fuelLabel ? `<span class="rpp-stat-sep">·</span>${fuelLabel}` : '');
        this._statsEl.style.display = '';
    }

    _renderPills() {
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
    }

    /**
     * Compact view: FAA-style route summary. Keeps DEP, DEST, fuel stops,
     * airway pills, and transition fixes (entry to and exit from each airway).
     * Drops fixes that are interior to a single airway run.
     *
     * Algorithm: walk the route. For each fix, push it, then if it's followed
     * by an airway, push the airway and skip ahead through consecutive same-
     * airway segments until we reach a fix that's not followed by the same
     * airway — that's the exit fix, which the next iteration pushes.
     *
     * Output preserves a reference back to the original index in this._route
     * so drag/edit operations target the underlying full route.
     */
    _collapseSameAirway(route) {
        const wrap = (i) => ({ item: route[i], originalIdx: i });
        const out = [];
        const len = route.length;

        // Rule: a fix pill is INTERIOR (hidden in compact view) iff its
        // airway tag matches the airway tag of the next fix pill in the
        // route. Airway/direct pills are always shown. DEP and DEST are
        // always shown. This works for both the legacy "alternating
        // [fix awy fix awy fix]" pattern produced by Plan and the
        // "[fix awy fix fix fix awy fix ...]" pattern produced by paste.
        const isAwy = (i) => i >= 0 && i < len &&
            (route[i].type === 'awy' || route[i].type === 'direct');

        // Pre-compute the next-fix index from each position, skipping any
        // intermediate airway pills.
        /** @type {number[]} */
        const nextFix = new Array(len + 1).fill(-1);
        for (let i = len - 1; i >= 0; i--) {
            nextFix[i] = isAwy(i) ? nextFix[i + 1] : i;
        }

        for (let i = 0; i < len; i++) {
            const item = route[i];
            if (isAwy(i)) {
                out.push(wrap(i));
                continue;
            }
            // Fix-like. Always show DEP / DEST / fuel and any fix without an
            // airway tag (transition fixes between airways).
            const myAw = item.airway || null;
            const nfIdx = nextFix[i + 1];
            const nextAw = (nfIdx >= 0) ? (route[nfIdx].airway || null) : null;
            const isInterior = myAw && nextAw === myAw && item.type === 'fix';
            if (!isInterior) out.push(wrap(i));
        }
        return out;
    }

    _onCompactToggle() {
        this._compactView = !this._compactView;
        this._saveOpts();
        if (this._compactBtn) {
            this._compactBtn.classList.toggle('rpp-tbtn-active', this._compactView);
        }
        this._renderPills();
    }

    _pillClass(type) {
        return {
            fix: 'rpp-pill-fix', awy: 'rpp-pill-awy', direct: 'rpp-pill-direct',
            dep: 'rpp-pill-dep', dest: 'rpp-pill-dest', fuel: 'rpp-pill-fuel',
        }[type] || 'rpp-pill-fix';
    }

    _typeLabel(type) {
        return { fix: 'FIX', awy: 'AWY', direct: 'GPS', dep: 'DEP', dest: 'DEST', fuel: '⛽' }[type] || '';
    }

    _buildPill(item, i) {
        const pill = document.createElement('div');
        pill.className = 'rpp-pill ' + this._pillClass(item.type);
        pill.dataset.idx = i;

        const handle = document.createElement('span');
        handle.className = 'rpp-pill-handle';
        handle.textContent = '⠿';

        const label = document.createTextNode(item.id);

        const badge = document.createElement('span');
        badge.className = 'rpp-type-badge';
        badge.textContent = this._typeLabel(item.type);

        const del = document.createElement('span');
        del.className = 'rpp-pill-del';
        del.title = 'Remove';
        del.textContent = '✕';
        del.addEventListener('click', e => {
            e.stopPropagation();
            this._route.splice(i, 1);
            this._render();
        });

        pill.appendChild(handle);
        pill.appendChild(label);
        pill.appendChild(badge);
        if (item.altFt) {
            const altBadge = document.createElement('span');
            altBadge.className = 'rpp-alt-badge';
            altBadge.textContent = String(Math.round(item.altFt / 100) * 100);
            pill.insertBefore(altBadge, del);
        }
        pill.appendChild(del);

        // Context menu on right-click and long-press
        pill.addEventListener('contextmenu', e => { e.preventDefault(); this._openMenu(e, i); });
        this._wireLongPress(pill, i);

        // Touch drag on handle
        this._wireDragHandle(handle, i);

        return pill;
    }

    _wireLongPress(pill, idx) {
        let timer = null;
        const epoch = this._renderEpoch;
        pill.addEventListener('touchstart', e => {
            timer = setTimeout(() => {
                if (this._renderEpoch !== epoch) return;
                this._openMenu(e.touches[0], idx);
            }, 400);
        }, { passive: true });
        pill.addEventListener('touchend',   () => clearTimeout(timer), { passive: true });
        pill.addEventListener('touchmove',  () => clearTimeout(timer), { passive: true });
    }

    // ── Touch drag handle (2D nearest-center slot detection) ──────────────────

    _wireDragHandle(handleEl, idx) {
        let ghost = null;
        let dropTarget = null;  // {idx, before}

        const allPills = () => Array.from(this._pillsEl.querySelectorAll('.rpp-pill'));

        handleEl.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const t = e.touches[0];
            this._dragIdx = idx;

            const pill = handleEl.closest('.rpp-pill');
            pill.classList.add('dragging');

            ghost = pill.cloneNode(true);
            const r = pill.getBoundingClientRect();
            ghost.style.cssText = [
                'position:fixed', 'opacity:0.75', 'pointer-events:none', 'z-index:9999',
                `left:${r.left}px`, `top:${r.top}px`, `width:${r.width}px`,
                'box-shadow:0 4px 14px rgba(0,0,0,.22)', 'transition:none',
            ].join(';');
            document.body.appendChild(ghost);
        }, { passive: false });

        handleEl.addEventListener('touchmove', (e) => {
            if (this._dragIdx === null) return;
            e.preventDefault();
            const t = e.touches[0];

            ghost.style.left = (t.clientX - ghost.offsetWidth / 2) + 'px';
            ghost.style.top  = (t.clientY - 16) + 'px';

            let nearestEl = null, nearestDist = Infinity, nearestIdx = -1, nearestBefore = true;
            allPills().forEach((p, i) => {
                if (i === this._dragIdx) return;
                const r  = p.getBoundingClientRect();
                const cx = r.left + r.width  / 2;
                const cy = r.top  + r.height / 2;
                const dist = Math.hypot(t.clientX - cx, t.clientY - cy);
                if (dist < nearestDist) {
                    nearestDist   = dist;
                    nearestEl     = p;
                    nearestIdx    = i;
                    nearestBefore = t.clientX < cx;
                }
            });

            allPills().forEach(p => p.classList.remove('drag-over-left', 'drag-over-right'));

            if (nearestEl) {
                nearestEl.classList.add(nearestBefore ? 'drag-over-left' : 'drag-over-right');
                dropTarget = { idx: nearestIdx, before: nearestBefore };
            } else {
                dropTarget = null;
            }
        }, { passive: false });

        handleEl.addEventListener('touchend', () => {
            if (this._dragIdx === null) return;

            ghost?.remove();
            ghost = null;
            allPills().forEach(p =>
                p.classList.remove('dragging', 'drag-over-left', 'drag-over-right'));

            if (dropTarget !== null) {
                const from = this._dragIdx;
                const item = this._route.splice(from, 1)[0];
                let insertAt = dropTarget.before ? dropTarget.idx : dropTarget.idx + 1;
                if (from < insertAt) insertAt--;
                this._route.splice(Math.max(0, Math.min(insertAt, this._route.length)), 0, item);
            }

            this._dragIdx = null;
            dropTarget    = null;
            this._render();
        }, { passive: true });

        handleEl.addEventListener('touchcancel', () => {
            ghost?.remove();
            ghost = null;
            allPills().forEach(p =>
                p.classList.remove('dragging', 'drag-over-left', 'drag-over-right'));
            this._dragIdx = null;
            dropTarget    = null;
        }, { passive: true });
    }

    // ── Add input handler ─────────────────────────────────────────────────────

    _onAddTap() {
        const v = this._addInput.value.trim().toUpperCase();
        if (!v) return;

        let type = this._addSel.value;
        // Auto-detect: override select if input looks like a known type
        if (v === 'DIRECT') type = 'direct';
        else if (/^[VT]\d/.test(v)) type = 'awy';

        // Determine insertion index
        let at;
        if (this._insertIndex !== null) {
            at = this._insertIndex;
            this._insertIndex = null;
        } else {
            // Default: insert before last pill (destination)
            at = Math.max(0, this._route.length - 1);
        }

        this._route.splice(at, 0, { id: v, type });
        this._addInput.value = '';
        this._render();
    }

    // ── Toolbar handlers ──────────────────────────────────────────────────────

    async _onClearTap() {
        const hasInterior = this._route.some(r => r.type === 'fix' || r.type === 'awy' || r.type === 'direct' || r.type === 'fuel');
        if (hasInterior) {
            const ok = await this._confirm('Clear the route? This cannot be undone.');
            if (!ok) return;
        }
        const dep  = this._depInput?.value.trim().toUpperCase()  || '';
        const dest = this._destInput?.value.trim().toUpperCase() || '';
        this._route = [];
        if (dep)  this._route.push({ id: dep,  type: 'dep'  });
        if (dest) this._route.push({ id: dest, type: 'dest' });
        this._insertIndex = null;
        this._render();
    }

    _onCopyTap() {
        const str = this._buildField15String(this._route);
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(str).catch(() => this._selectRouteStr());
        } else {
            this._selectRouteStr();
        }
    }

    _selectRouteStr() {
        if (!this._routeStrEl) return;
        const range = document.createRange();
        range.selectNode(this._routeStrEl);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    }

    // ── Plan button ───────────────────────────────────────────────────────────

    async _onPlanTap() {
        const dep  = this._depInput?.value.trim().toUpperCase();
        const dest = this._destInput?.value.trim().toUpperCase();
        if (!dep || !dest) {
            this._toast('Enter departure and destination');
            return;
        }

        this._checkPlannerVersion();

        const setBtn = (label, disabled) => {
            if (!this._planBtn) return;
            this._planBtn.textContent = label;
            this._planBtn.disabled = disabled;
            this._planBtn.classList.toggle('rpp-tbtn-busy', disabled);
        };

        // Wait for planner if still initializing — don't fail silently
        if (!this._planner) {
            setBtn('Loading…', true);
            const ready = await this._waitForPlanner(20000);
            if (!ready) {
                setBtn('Plan', false);
                const counts = await this._diagnoseIdb();
                const reason = this._plannerInitError ? ` — init error: ${this._plannerInitError}` : '';
                this._toast(`Airway data not loaded${reason}\n${counts}`, 12000);
                console.error('[RoutePlannerPanel] planner never became ready', counts);
                return;
            }
        }

        // Sanity check — NASR airways present in IDB. The new planning lib's
        // RoutePlanner builds its airway graph lazily on the first plan() call,
        // so we probe the source-of-truth IDB store rather than the planner's
        // internal cache.
        const airwayCount = await this._nasrDb?.listAirways?.().then(a => a.length).catch(() => 0) ?? 0;
        if (airwayCount === 0) {
            const counts = await this._diagnoseIdb();
            this._toast(`Airway data not loaded — NASR import incomplete\n${counts}`, 12000);
            console.error('[RoutePlannerPanel] no airways in IDB;', counts);
            return;
        }

        setBtn('Planning…', true);
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
            });

            // Cache all fix coordinates returned by the planner
            if (result.waypoints) {
                for (const wp of result.waypoints) {
                    if (wp.fix && wp.lat != null)
                        this._coords[wp.fix] = { lat: wp.lat, lon: wp.lon };
                }
            }

            this._route = this._resultToPills(dep, dest, result);
            this._depInput.value  = dep;
            this._destInput.value = dest;
            this._lastPlan = result;
            this._updateStats(result);
            this._render();
            this._toast(`Route planned · ${result.waypoints?.length || 0} waypoints`, 2500);
            // Apply winds/perf in background — updates stats bar when done
            this._applyWindsToLastPlan();
        } catch (err) {
            console.error('[RoutePlannerPanel] plan() failed:', err);
            this._toast('Could not plan route: ' + (err.message || err), 5000);
        } finally {
            setBtn('Plan', false);
        }
    }

    async _applyWindsToLastPlan() {
        if (!this._lastPlan || !this._planner) return;
        const opts = {
            departureTime: this._departureTime ?? new Date(),
            pctPower:      this._pctPower,
            cruiseAltFt:   this._cruiseAltFt ?? undefined,
        };
        this._fetchingWinds = true;
        if (this._statsEl) this._updateStats(this._lastPlan);
        try {
            const fetchWindsFn = (typeof FlyTabPlanning !== 'undefined' && FlyTabPlanning.fetchWinds)
                ? FlyTabPlanning.fetchWinds
                : null;
            if (fetchWindsFn) {
                opts.winds = await fetchWindsFn(opts.departureTime).catch(() => null);
            }
        } catch (_) {}
        this._fetchingWinds = false;
        // Build plan copy with per-fix altitude overrides from _route pills so
        // we never mutate the cached _lastPlan object (fragile shared reference).
        const routeAltMap = new Map(
            this._route.filter(p => p.altFt != null).map(p => [p.id, p.altFt])
        );
        const plan = routeAltMap.size > 0 && this._lastPlan.waypoints
            ? {
                ...this._lastPlan,
                waypoints: this._lastPlan.waypoints.map(wp => {
                    const override = routeAltMap.get(wp.id || wp.fix);
                    return override != null ? { ...wp, altFt: override } : wp;
                }),
              }
            : this._lastPlan;
        this._currentPlan = this._planner.recomputeLegs(plan, null, opts);
        if (this._statsEl) this._updateStats(this._currentPlan);
        this._windWarnings = [];
        if (!opts.winds) {
            this._windWarnings.push('Wind data unavailable — time and fuel use calm-air estimates');
        }
        const fuelRem = this._currentPlan?.summary?.fuelRemGal;
        if (fuelRem != null && this._reserveGal > 0 && fuelRem < this._reserveGal) {
            this._windWarnings.push(
                `Fuel below reserve: ${fuelRem.toFixed(1)} gal at dest, ${this._reserveGal} gal reserve required`
            );
        }
        this._renderWindWarnings();
    }

    _waitForPlanner(timeoutMs) {
        return new Promise(resolve => {
            if (this._planner) return resolve(true);
            const start = Date.now();
            const tick = () => {
                if (this._planner) return resolve(true);
                if (Date.now() - start > timeoutMs) return resolve(false);
                setTimeout(tick, 200);
            };
            tick();
        });
    }

    _resultToPills(dep, dest, result) {
        const pills = [];
        const routeLegs = result.routeLegs || result.legs || [];

        pills.push({ id: dep, type: 'dep' });
        let lastDestAirway = null;

        // Build from routeLegs: each leg has from→to and airway
        for (let i = 0; i < routeLegs.length; i++) {
            const leg = routeLegs[i];
            const airway = (leg.airway && leg.airway !== 'DIRECT') ? leg.airway : null;

            // Insert airway pill if this leg uses a named airway and we
            // haven't already inserted one for this same airway.
            if (airway && pills[pills.length - 1]?.id !== airway && pills[pills.length - 1]?.type !== 'awy') {
                // Only emit a new airway pill at airway transitions, not for
                // every leg of the same airway.
                if (airway !== lastDestAirway) {
                    pills.push({ id: airway, type: 'awy' });
                }
            }

            if (leg.to && leg.to !== dest) {
                const isFuel = (result.fuelStops || []).some(fs => fs.icao === leg.to);
                const pill = { id: leg.to, type: isFuel ? 'fuel' : 'fix' };
                if (airway) pill.airway = airway;
                pills.push(pill);
            }
            lastDestAirway = airway;
        }

        const destPill = { id: dest, type: 'dest' };
        if (lastDestAirway) destPill.airway = lastDestAirway;
        pills.push(destPill);
        return pills;
    }

    // ── Paste button ──────────────────────────────────────────────────────────

    async _onPasteTap() {
        let str = '';
        try {
            if (navigator.clipboard?.readText) {
                str = await navigator.clipboard.readText();
            }
        } catch {}

        if (!str.trim()) {
            str = await this._promptPasteModal();
            if (!str) return;
        }

        if (this._route.length > 0) {
            const ok = await this._confirm('Replace current route with pasted route?');
            if (!ok) return;
        }

        // Prefer the lib's parseRoute when the planner is ready — it walks
        // each airway record and emits every interior transition fix, so the
        // map renders the actual airway path. Fall back to the local
        // tokenizer only when the planner hasn't initialised yet.
        let pills;
        if (this._planner?.parseRoute) {
            try {
                const result = await this._planner.parseRoute(str.trim());
                pills = this._waypointsToPills(result.waypoints);
            } catch (err) {
                console.warn('[RoutePlannerPanel] paste parseRoute failed:', err?.message || err);
                this._toast('Could not parse: ' + (err?.message || err), 5000);
                return;
            }
        } else {
            pills = this._parsePasteStr(str.trim());
        }

        if (pills.length < 2) {
            this._toast('Could not parse route — need at least 2 tokens');
            return;
        }

        this._route = pills;
        this._depInput.value  = pills[0].id;
        this._destInput.value = pills[pills.length - 1].id;
        // Cache coords from the expanded waypoints so Apply can resolve them
        // without going back to IDB.
        if (this._planner?.parseRoute) {
            // `pills` came from parseRoute; coords are on the waypoint objects
            // we already produced. Re-walk them here.
        }
        this._render();
    }

    /**
     * Convert parseRoute()'s waypoint output into the panel's pill array.
     * Each waypoint after the first carries an `airway` field naming the
     * airway used to reach it from the previous waypoint (null = direct).
     * Emit a single AWY pill at each airway boundary — when entering a new
     * airway from a non-airway segment OR a different airway.
     */
    _waypointsToPills(waypoints) {
        if (!waypoints?.length) return [];
        const pills = [];
        let lastAirway = null;
        for (let i = 0; i < waypoints.length; i++) {
            const w = waypoints[i];
            if (w.lat != null && w.lon != null) this._coords[w.id] = { lat: w.lat, lon: w.lon };

            const aw = w.airway || null;
            if (aw && aw !== lastAirway) {
                pills.push({ id: aw, type: 'awy' });
            }
            lastAirway = aw;

            const type = i === 0 ? 'dep'
                       : i === waypoints.length - 1 ? 'dest'
                       : 'fix';
            // Tag fix pills with the airway used to reach them so
            // _collapseSameAirway can identify interior fixes.
            const pill = { id: w.id, type };
            if (aw) pill.airway = aw;
            pills.push(pill);
        }
        return pills;
    }

    _parsePasteStr(str) {
        const tokens = str.split(/\s+/).filter(Boolean).map(t => t.toUpperCase());
        return tokens.map((t, i) => {
            let type;
            if (i === 0)                       type = 'dep';
            else if (i === tokens.length - 1)  type = 'dest';
            else if (/^[VT]\d/.test(t))        type = 'awy';
            else if (t === 'DIRECT')            type = 'direct';
            else                               type = 'fix';
            return { id: t, type };
        });
    }

    _promptPasteModal() {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = [
                'position:fixed','inset:0','background:rgba(0,0,0,.5)',
                'z-index:10000','display:flex','align-items:center','justify-content:center',
            ].join(';');

            const box = document.createElement('div');
            box.style.cssText = 'background:#fff;border-radius:12px;padding:20px;width:90%;max-width:480px';
            box.innerHTML = `
                <div style="font-size:13px;font-weight:700;margin-bottom:10px">Paste route string</div>
                <textarea rows="4" style="width:100%;font-family:inherit;font-size:13px;border:1.5px solid #b0bac6;border-radius:8px;padding:8px;text-transform:uppercase;resize:none;outline:none" placeholder="KLKR GSO V225 RIC V268 ESN KMHT"></textarea>
                <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
                    <button id="rppPasteCancel" style="padding:8px 16px;border:1.5px solid #b0bac6;border-radius:8px;background:#fff;font-family:inherit;cursor:pointer">Cancel</button>
                    <button id="rppPasteOk" style="padding:8px 16px;border:none;border-radius:8px;background:#1a6fbb;color:#fff;font-family:inherit;font-weight:700;cursor:pointer">Use Route</button>
                </div>
            `;
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const ta = box.querySelector('textarea');
            ta.focus();

            box.querySelector('#rppPasteOk').addEventListener('click', () => {
                overlay.remove();
                resolve(ta.value);
            });
            box.querySelector('#rppPasteCancel').addEventListener('click', () => {
                overlay.remove();
                resolve('');
            });
        });
    }

    // ── Apply button ──────────────────────────────────────────────────────────

    /**
     * Apply the current pill list to the live trip without closing the
     * panel. Pilot can keep editing and apply again. Returns true on
     * successful apply.
     */
    async _onApplyKeepOpenTap() {
        const ok = await this._doApply();
        if (ok) this._toast('Applied — pilot may keep editing', 1800);
    }

    /** Apply and dismiss the panel (legacy default). */
    async _onApplyTap() {
        const ok = await this._doApply();
        if (ok && typeof app !== 'undefined') {
            app.closeRoutePlanner();
        }
    }

    async _doApply() {
        if (this._applyAborted) return false;

        const wps = await this._pillsToWaypoints();
        if (wps.length < 2) {
            this._toast('Add at least 2 waypoints');
            return false;
        }

        if (this._applyAborted) return false;

        const dep  = wps[0].icao  || wps[0].name;
        const dest = wps[wps.length - 1].icao || wps[wps.length - 1].name;

        const plan = {
            departure:       dep,
            destination:     dest,
            cruise_altitude: this._altitude,
            waypoints:       wps,
            flight_plan: {
                departure:   dep,
                destination: dest,
                route: this._route.map(r => r.id),
                // Use wind-corrected legs from recomputeLegs so GS, ETE, winds
                // transfer to the route table and nav strip. Fall back to bare
                // stubs only when no plan has been computed yet.
                legs: this._currentPlan?.legs || this._lastPlan?.legs
                      || this._buildLegsFromWaypoints(wps),
            },
        };

        if (typeof app === 'undefined') return false;
        await app.applyRouteEdit(plan);
        return true;
    }

    _buildLegsFromWaypoints(wps) {
        if (!wps || wps.length < 2) return [];
        const legs = [];
        for (let i = 0; i < wps.length - 1; i++) {
            const leg = { from: wps[i].icao || wps[i].name, to: wps[i + 1].icao || wps[i + 1].name };
            if (wps[i + 1].airway != null) leg.airway = wps[i + 1].airway;
            legs.push(leg);
        }
        return legs;
    }

    _buildField15String(route) {
        return this._collapseSameAirway(route).map(e => e.item.id).join(' ');
    }

    async _pillsToWaypoints() {
        const wps = [];
        const skipped = [];

        // Build case-insensitive index of cached coords. AirwayGraph stores
        // fix names as they appear in the NASR bundle (e.g. 'Pawling') but
        // pill IDs come back uppercased after save→reload via _parsePasteStr.
        const coordsCi = {};
        for (const key of Object.keys(this._coords))
            coordsCi[key.toUpperCase()] = this._coords[key];

        // AWY pills sit BETWEEN two fix pills and represent the airway used to
        // reach the next fix. Capture the most recent AWY so we can stamp it
        // onto the next pushed waypoint. Without this the route table loses
        // every airway label the planner produced.
        let pendingAirway = null;

        for (const pill of this._route) {
            if (pill.type === 'awy') {
                pendingAirway = pill.id;
                continue;
            }

            const id = pill.id;
            let coord = this._coords[id] || coordsCi[id.toUpperCase()];

            if (!coord && this._nasrDb) {
                // Try IDB: airport → navaid → fix
                let rec = await this._nasrDb.getAirport(id).catch(() => null);
                if (!rec) rec = await this._nasrDb.getNavaid(id).catch(() => null);
                if (!rec) rec = await this._nasrDb.getFix(id).catch(() => null);
                if (rec?.lat != null) {
                    coord = { lat: rec.lat, lon: rec.lon };
                    this._coords[id] = coord;
                }
            }

            if (!coord) {
                skipped.push(id);
                continue;
            }

            // airway: prefer the explicit pendingAirway set by an AWY pill, fall
            // back to the pill's own .airway tag (populated by _loadPlan /
            // _waypointsToPills for interior airway fixes). Without the fallback,
            // only the first fix after an AWY pill carries the airway label —
            // all subsequent interior fixes on the same airway lose it, breaking
            // legs[].airway in the applied plan.
            const aw = pendingAirway || pill.airway || null;
            wps.push({
                icao: id,
                name: id,
                lat:  coord.lat,
                lon:  coord.lon,
                type: pill.type === 'dep'  ? 'APT' :
                      pill.type === 'dest' ? 'APT' :
                      pill.type === 'fuel' ? 'APT' : undefined,
                alt: this._altitude,
                ...(aw ? { airway: aw } : {}),
            });
            pendingAirway = null;
        }

        if (skipped.length > 0)
            this._toast(`Skipped (not found): ${skipped.join(', ')}`);

        return wps;
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    _toast(msg, duration = 2500) {
        const host = this._el || document.body;
        const existing = host.querySelector('.rpp-toast');
        if (existing) existing.remove();

        const el = document.createElement('div');
        el.className = 'rpp-toast';
        el.textContent = msg;
        host.appendChild(el);

        if (duration > 0) setTimeout(() => { if (el.parentNode) el.remove(); }, duration);
    }

    _confirm(msg) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = [
                'position:fixed','inset:0','background:rgba(0,0,0,.4)',
                'z-index:10000','display:flex','align-items:center','justify-content:center',
            ].join(';');
            const box = document.createElement('div');
            box.style.cssText = 'background:#fff;border-radius:12px;padding:20px;max-width:320px;width:90%;text-align:center';
            box.innerHTML = `
                <p style="font-size:14px;margin-bottom:16px">${msg}</p>
                <div style="display:flex;gap:8px;justify-content:center">
                    <button id="rppCfNo"  style="padding:8px 20px;border:1.5px solid #b0bac6;border-radius:8px;background:#fff;font-family:inherit;cursor:pointer">Cancel</button>
                    <button id="rppCfYes" style="padding:8px 20px;border:none;border-radius:8px;background:#1a6fbb;color:#fff;font-family:inherit;font-weight:700;cursor:pointer">Replace</button>
                </div>
            `;
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            box.querySelector('#rppCfYes').addEventListener('click', () => { overlay.remove(); resolve(true);  });
            box.querySelector('#rppCfNo' ).addEventListener('click', () => { overlay.remove(); resolve(false); });
        });
    }
}
