/**
 * FlyTab — Route Planner (preview): the redesign, beside the current planner.
 * Spec: docs/superpowers/specs/2026-10-15-route-planner-redesign-design.md.
 *
 * Opened from MORE → Route Planner (preview); the current planner is untouched.
 * Same route model and engine (it extends RoutePlannerPanel and shares the
 * current planner's route engine, caches and saved settings), new screen:
 *  - one route field: bubbles you type into, in clearance order; the cursor sits
 *    before the destination unless you tap after it; tap a bubble for actions;
 *  - route checks (RouteCheck) on every change, red problems make Apply ask;
 *  - the settings grid (no popup);
 *  - airways expanded along the airway when the route is computed and applied.
 * Not in the preview yet: Routes (Recents/Favorites) and the fuel-stop picker's
 * new wording -- Routes opens today's plan list.
 */
class RoutePlannerV2 extends RoutePlannerPanel {
    constructor(panelEl, nasrDb, planningAdapters, main) {
        super(panelEl, nasrDb, planningAdapters);
        this._main = main || null;              // the current planner: shared engine and caches
        if (this._main?._coords) this._coords = this._main._coords;
        // The base class reads and writes DEP/DEST through these; no boxes here.
        this._depInput = { value: '' };
        this._destInput = { value: '' };
        this._cursorAtEnd = false;              // typed tokens go before the destination
        this._problems = [];
        this._computed = null;
        this._checkEpoch = 0;
        this._checkTimer = null;
        this._typing = Promise.resolve();       // typed tokens are looked up and inserted in order
        this._airwayCache = new Map();
        this._quiet = 0;
    }

    // Route engine: the current planner's (built once), never a second one.
    get _planner() { return this._main?._planner ?? this.__planner ?? null; }
    set _planner(v) { this.__planner = v; }
    _startBuildPlanner() {}
    _getAirwayPairCache() { return this._main ? this._main._getAirwayPairCache() : super._getAirwayPairCache(); }

    // Settings are shared (same localStorage key): keep the current planner in step.
    _saveOpts() {
        super._saveOpts();
        try { this._main?._loadOpts?.(); this._main?._updateSummaryBar?.(); } catch { /* ignore */ }
    }

    _toast(msg, duration) {
        if (this._quiet) return;                // checks run quietly; Apply/actions speak
        super._toast(msg, duration);
    }

    // ── Screen ───────────────────────────────────────────────────────────────

    _buildDOM() {
        const el = this._el;
        el.innerHTML = '';
        const inner = document.createElement('div');
        inner.className = 'rp2-inner';

        const hdr = document.createElement('div');
        hdr.className = 'rp2-hdr';
        hdr.innerHTML = '<span class="rp2-title">ROUTE PLANNER <span class="rp2-badge">PREVIEW</span></span>';
        const close = document.createElement('button');
        close.className = 'rp2-close';
        close.setAttribute('aria-label', 'Close');
        close.textContent = '✕';
        wireTap(close, () => { if (typeof app !== 'undefined') app.closeRoutePlanner(); });
        hdr.appendChild(close);
        inner.appendChild(hdr);

        // Search: airport name, city or identifier -> tap a result to add it at the cursor
        const search = document.createElement('div');
        search.className = 'rp2-search';
        this._searchInput = document.createElement('input');
        this._searchInput.className = 'rp2-search-input';
        this._searchInput.type = 'search';
        this._searchInput.placeholder = '🔍 Airport name, city or identifier';
        this._searchInput.setAttribute('autocomplete', 'off');
        this._searchInput.setAttribute('autocorrect', 'off');
        this._searchInput.spellcheck = false;
        this._searchInput.addEventListener('input', () => this._onSearchInput());
        this._resultsEl = document.createElement('div');
        this._resultsEl.className = 'rp2-results';
        this._resultsEl.hidden = true;
        search.appendChild(this._searchInput);
        search.appendChild(this._resultsEl);
        inner.appendChild(search);

        // Route field
        this._fieldEl = document.createElement('div');
        this._fieldEl.className = 'rp2-field';
        this._bubblesEl = document.createElement('div');
        this._bubblesEl.className = 'rp2-bubbles';
        this._fieldEl.appendChild(this._bubblesEl);
        this._inputEl = document.createElement('input');
        this._inputEl.className = 'rp2-input';
        this._inputEl.type = 'text';
        this._inputEl.setAttribute('autocapitalize', 'characters');
        this._inputEl.setAttribute('autocomplete', 'off');
        this._inputEl.setAttribute('autocorrect', 'off');
        this._inputEl.setAttribute('enterkeyhint', 'done');
        this._inputEl.spellcheck = false;
        this._inputEl.placeholder = 'type';
        this._inputEl.addEventListener('input', () => this._onTyping());
        this._inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this._finishTyping(); }
        });
        const fbtns = document.createElement('div');
        fbtns.className = 'rp2-fbtns';
        const rev = document.createElement('button');
        rev.className = 'rp2-btn';
        rev.textContent = '⇄ REV';
        wireTap(rev, async () => { await this._commitTyped(); this._onReverseTap(); });
        const clr = document.createElement('button');
        clr.className = 'rp2-btn';
        clr.textContent = 'Clear';
        wireTap(clr, async () => { await this._commitTyped(); this._syncFieldsFromPills(); await this._onClearTap(); this._cursorAtEnd = false; this._render(); });
        fbtns.appendChild(rev);
        fbtns.appendChild(clr);
        this._fieldEl.appendChild(fbtns);
        // A tap on the field's empty space: type there. After the destination
        // bubble (or with no destination yet) -> the end; anywhere else -> before it.
        this._fieldEl.addEventListener('click', (e) => {
            if (e.target.closest('.rp2-b, .rp2-btn, .rp2-input')) return;
            this._insertIndex = null;
            this._cursorAtEnd = this._tapIsAfterDest(e);
            this._render();
            this._inputEl.focus();
        });
        inner.appendChild(this._fieldEl);

        // Problem line
        this._problemEl = document.createElement('div');
        this._problemEl.className = 'rp2-problem';
        wireTap(this._problemEl, () => this._openProblemSheet());
        inner.appendChild(this._problemEl);

        // Settings grid
        inner.appendChild(this._buildGrid());

        // Stats strip
        this._statsStripEl = document.createElement('div');
        this._statsStripEl.className = 'rp2-stats';
        inner.appendChild(this._statsStripEl);
        this._flightsEl = document.createElement('div');
        this._flightsEl.className = 'rp2-flights';
        inner.appendChild(this._flightsEl);

        // Toolbar
        const tb = document.createElement('div');
        tb.className = 'rp2-toolbar';
        const mk = (label, fn, cls = '') => {
            const b = document.createElement('button');
            b.className = 'rp2-tbtn' + (cls ? ' ' + cls : '');
            b.textContent = label;
            wireTap(b, async () => { await this._commitTyped(); this._endInsert(); fn(); });
            tb.appendChild(b);
            return b;
        };
        // Plan route takes a few seconds on the tablet: say so on the button.
        const planBtn = mk('Plan route', async () => {
            if (planBtn.disabled) return;
            planBtn.disabled = true;
            planBtn.textContent = 'Planning…';
            try {
                this._syncFieldsFromPills();
                await this._onPlanRouteTap();
            } finally {
                planBtn.disabled = false;
                planBtn.textContent = 'Plan route';
            }
        });
        mk('Routes', () => this._onPlansTap());
        this._saveBtn = mk('Save', () => this._onSaveTap());
        this._saveBtn.disabled = !this._lastPlan;
        mk('⋯', () => this._openMoreSheet());
        mk('Apply', () => this._onApplyKeepOpenTap(), 'rp2-apply');
        inner.appendChild(tb);

        // Sheet (bubble actions, problems, ⋯)
        this._sheetEl = document.createElement('div');
        this._sheetEl.className = 'rp2-sheet';
        this._sheetEl.hidden = true;
        inner.appendChild(this._sheetEl);

        el.appendChild(inner);
        this._render();
    }

    _buildGrid() {
        const grid = document.createElement('div');
        grid.className = 'rp2-grid';
        const box = (label, sel) => {
            const c = document.createElement('label');
            c.className = 'rp2-cell';
            const k = document.createElement('span');
            k.className = 'rp2-k';
            k.textContent = label;
            c.appendChild(k);
            c.appendChild(sel);
            grid.appendChild(c);
        };
        const mkSel = (opts, value, onChange) => {
            const s = document.createElement('select');
            s.className = 'rp2-sel';
            for (const [v, t] of opts) {
                const o = document.createElement('option');
                o.value = v; o.textContent = t;
                s.appendChild(o);
            }
            s.value = value;
            s.addEventListener('change', () => { onChange(s.value); this._saveOpts(); this._scheduleCheck(); });
            return s;
        };
        const rewind = () => { if (this._lastPlan) this._windsPromise = (this._windsPromise || Promise.resolve()).then(() => this._applyWindsToLastPlan()); };

        const alts = [['', 'Auto']];
        for (let a = 3000; a <= 13000; a += 1000) alts.push([String(a), a.toLocaleString()]);
        for (let a = 3500; a <= 12500; a += 1000) alts.push([String(a), a.toLocaleString() + ' VFR']);
        this._g = {};
        this._g.alt = mkSel(alts, this._cruiseAltFt ? String(this._cruiseAltFt) : '', (v) => {
            this._cruiseAltFt = v ? parseInt(v, 10) : null;
            this._altitude = this._cruiseAltFt ?? 5500;
            rewind();
        });
        box('ALTITUDE', this._g.alt);
        this._g.pwr = mkSel([55, 60, 65, 70, 75].map((p) => [String(p), `${p}% LOP`]), String(this._pctPower), (v) => {
            this._pctPower = parseInt(v, 10);
            rewind();
        });
        box('POWER', this._g.pwr);
        this._g.mode = mkSel([['v-airways', 'V-airways'], ['t-airways', 'T-airways'], ['any', 'Any airway'], ['gps-direct', 'GPS Direct'], ['vors-direct', 'VORs Direct']],
            this._routingMode, (v) => { this._routingMode = v; });
        box('ROUTING', this._g.mode);
        this._g.dep = mkSel([['0', 'Now'], ['30', '+30 min'], ['60', '+1 h'], ['120', '+2 h'], ['180', '+3 h']], '0', (v) => {
            const min = parseInt(v, 10);
            this._departureTime = min ? new Date(Date.now() + min * 60000) : null;
            rewind();
        });
        box('DEPART', this._g.dep);
        const rsv = [];
        for (let g = 5; g <= 20; g++) rsv.push([String(g), `${g} gal`]);
        this._g.rsv = mkSel(rsv, String(Math.min(20, Math.max(5, this._reserveGal || 10))), (v) => { this._reserveGal = parseInt(v, 10); });
        box('RESERVE', this._g.rsv);
        this._g.fuel = mkSel([['2', '2h'], ['2.5', '2.5h'], ['3', '3h']], String(this._maxLegHrs), (v) => { this._maxLegHrs = parseFloat(v); });
        box('FUEL STOP', this._g.fuel);
        return grid;
    }

    _syncGrid() {
        if (!this._g) return;
        this._g.alt.value = this._cruiseAltFt ? String(this._cruiseAltFt) : '';
        this._g.pwr.value = String(this._pctPower);
        this._g.mode.value = this._routingMode;
        this._g.rsv.value = String(Math.min(20, Math.max(5, this._reserveGal || 10)));
        this._g.fuel.value = String(this._maxLegHrs);
    }

    /** Load a plan and show it (the base open(), then this screen's state). */
    async open(plan) {
        this._loadOpts();
        this._cursorAtEnd = false;
        this._insertIndex = null;
        this._closeSheet();
        await super.open(plan);
        this._syncGrid();
    }

    // ── Route field ──────────────────────────────────────────────────────────

    /** Index in _route where the next typed token goes. */
    _cursorIndex() {
        if (this._insertIndex !== null && this._insertIndex !== undefined) return this._insertIndex;
        const d = this._destPillIndex();
        if (this._cursorAtEnd || d < 0) return this._route.length;
        return d;
    }

    _tapIsAfterDest(e) {
        const d = this._destPillIndex();
        if (d < 0) return true;
        const bubble = this._bubblesEl.querySelector(`.rp2-b[data-idx="${d}"]`);
        if (!bubble) return true;
        const r = bubble.getBoundingClientRect();
        // Right of it on its row, or below its row.
        return e.clientY > r.bottom || (e.clientY >= r.top && e.clientX > r.right);
    }

    _render() {
        this._syncFieldsFromPills();
        if (this._bubblesEl) {
            // The text cursor (input) is never taken out of the page: a focused
            // input that is detached loses focus, and Android drops the keyboard.
            // Bubbles are rebuilt around it.
            if (this._inputEl.parentNode !== this._bubblesEl) this._bubblesEl.appendChild(this._inputEl);
            for (const ch of [...this._bubblesEl.children]) if (ch !== this._inputEl) ch.remove();
            const view = this._compactView
                ? this._collapseSameAirway(this._route)
                : this._route.map((item, i) => ({ item, originalIdx: i }));
            const at = this._cursorIndex();
            // Say where typing goes when it isn't the usual place (before the destination).
            const prev = this._insertIndex != null ? this._route[this._insertIndex - 1] : null;
            this._inputEl.placeholder = this._insertIndex != null
                ? (prev ? `insert after ${prev.id}` : `insert before ${this._route[0]?.id || ''}`)
                : 'type';
            for (const { item, originalIdx } of view) {
                const b = this._buildBubble(item, originalIdx);
                if (originalIdx < at) this._bubblesEl.insertBefore(b, this._inputEl);
                else this._bubblesEl.appendChild(b);
            }
            // While inserting: a ✓ Done button right after the cursor.
            if (this._insertIndex != null) {
                const done = document.createElement('button');
                done.className = 'rp2-insert-done';
                done.textContent = '✓ Done';
                const tap = typeof wireIsolatedTap === 'function' ? wireIsolatedTap : wireTap;
                tap(done, () => this._finishTyping());
                this._bubblesEl.insertBefore(done, this._inputEl.nextSibling);
            }
            this._markBubbles();
        }
        this._scheduleCheck();
    }

    _buildBubble(item, idx) {
        const b = document.createElement('button');
        const kind = item.type === 'awy' ? 'awy'
            : item.type === 'direct' ? 'dct'
            : item.type === 'fuel' ? 'fuel'
            : (item.type === 'dep' || item.type === 'dest' || item.type === 'airport') ? 'apt' : 'fix';
        b.className = `rp2-b rp2-b-${kind}`;
        b.dataset.idx = String(idx);
        b.textContent = (item.type === 'fuel' ? '⛽ ' : '') + item.id + (item.altFt ? ` ${item.altFt / 100 | 0}` : '');
        wireTap(b, async () => { await this._commitTyped(); this._showOnMap(idx); this._openBubbleSheet(idx); });
        return b;
    }

    /**
     * Centre the map on a bubble: a fix, airport or navaid; an airway bubble
     * fits its segment (entry to exit). Following own-ship is held meanwhile
     * (CockpitMap.showPoint).
     */
    async _showOnMap(i) {
        const map = typeof app !== 'undefined' ? app.cockpitMap : null;
        const r = this._route;
        const item = r[i];
        if (!map || !item) return;
        const isPoint = (p) => p && p.type !== 'awy' && p.type !== 'direct';
        const aero = this._aero();
        if (isPoint(item)) {
            const c = await aero.resolve(item.id);
            if (c) map.showPoint?.(c.lat, c.lon);
            return;
        }
        let a = i - 1; while (a >= 0 && !isPoint(r[a])) a--;
        let b = i + 1; while (b < r.length && !isPoint(r[b])) b++;
        const ca = a >= 0 ? await aero.resolve(r[a].id) : null;
        const cb = b < r.length ? await aero.resolve(r[b].id) : null;
        if (ca && cb) map.showBounds?.(ca, cb);
        else if (ca || cb) map.showPoint?.((ca || cb).lat, (ca || cb).lon);
    }

    _markBubbles() {
        if (!this._bubblesEl) return;
        const sev = new Map();
        for (const p of this._problems) {
            for (const i of p.pillIndexes) if (!sev.has(i) || p.severity === 'red') sev.set(i, p.severity);
        }
        for (const b of this._bubblesEl.querySelectorAll('.rp2-b')) {
            const s = sev.get(parseInt(b.dataset.idx, 10));
            b.classList.toggle('rp2-red', s === 'red');
            b.classList.toggle('rp2-amber', s === 'amber');
        }
    }

    /**
     * Done (keyboard Done/Enter, or ✓ Done while inserting): add what was typed,
     * end an insert (typing goes back to before the destination), and close
     * the keyboard -- there was no clear way to finish an insert (2026-10-16).
     */
    async _finishTyping() {
        await this._commitTyped();
        this._endInsert();
        this._inputEl?.blur();
    }

    _endInsert() {
        if (this._insertIndex == null) return;
        this._insertIndex = null;
        this._render();
    }

    _onTyping() {
        const v = this._inputEl.value;
        if (!/\s/.test(v)) return;
        const parts = v.split(/\s+/);
        this._inputEl.value = parts.pop();
        for (const t of parts) if (t) this._queueToken(t);
    }

    /** Commit whatever is typed (Enter, Done, or before any action). */
    _commitTyped() {
        const v = this._inputEl?.value || '';
        if (this._inputEl) this._inputEl.value = '';
        for (const t of v.split(/\s+/)) if (t) this._queueToken(t);
        return this._typing;
    }

    _queueToken(t) {
        this._typing = this._typing.then(() => this._insertToken(t.trim().toUpperCase())).catch((err) => console.error('[RoutePlannerV2] token', err));
        return this._typing;
    }

    async _insertToken(id) {
        if (!id) return;
        let type;
        if (id === 'DIRECT' || id === 'DCT') type = 'direct';
        else if (/^[VTJQ]\d/.test(id)) type = 'awy';
        else type = (await this._isAirport(id)) ? 'airport' : 'fix';
        const isPoint = type !== 'awy' && type !== 'direct';
        const r = this._route;
        const destIdx = this._destPillIndex();

        if (isPoint && !r.some((p) => p.type !== 'awy' && p.type !== 'direct')) {
            r.push({ id, type: 'dep' });                          // first point: departure
        } else if (isPoint && destIdx < 0 && this._insertIndex == null) {
            r.push({ id, type: 'dest' });                         // then the destination
        } else if (isPoint && this._cursorAtEnd && this._insertIndex == null) {
            // Typed after the destination: it becomes the new destination.
            const old = r[destIdx];
            old.type = (await this._isAirport(old.id)) ? 'airport' : 'fix';
            r.push({ id, type: 'dest' });
        } else {
            const at = this._cursorIndex();
            r.splice(at, 0, { id, type });
            if (this._insertIndex != null) this._insertIndex = at + 1;   // keep typing in order
        }
        this._render();
    }

    async _isAirport(id) {
        if (!this._nasrDb) return /^K[A-Z0-9]{3}$/.test(id);
        try { return !!(await this._nasrDb.getAirport(id)); } catch { return false; }
    }

    // ── Sheets ───────────────────────────────────────────────────────────────

    _openSheet(title, rows) {
        // Sheet buttons cancel the browser's follow-on mouse events: the sheet
        // closes on the tap, and the synthetic mousedown then landed on what was
        // under it and took the focus from the route field -- Insert after…
        // focused the field and the keyboard never came up (2026-10-16).
        const tap = typeof wireIsolatedTap === 'function' ? wireIsolatedTap : wireTap;
        // A sheet replacing one that was waiting for an answer: that one is "no".
        const pending = this._onSheetClose;
        this._onSheetClose = null;
        if (pending) pending();
        const s = this._sheetEl;
        s.innerHTML = '';
        const h = document.createElement('div');
        h.className = 'rp2-sheet-hdr';
        const t = document.createElement('span');
        t.textContent = title;
        const x = document.createElement('button');
        x.className = 'rp2-btn';
        x.textContent = '✕';
        tap(x, () => this._closeSheet());
        h.appendChild(t);
        h.appendChild(x);
        s.appendChild(h);
        const grid = document.createElement('div');
        grid.className = 'rp2-acts';
        for (const r of rows) {
            if (r.note) {
                const n = document.createElement('div');
                n.className = 'rp2-sheet-note' + (r.severity ? ' rp2-note-' + r.severity : '');
                n.textContent = r.note;
                grid.appendChild(n);
                continue;
            }
            const b = document.createElement('button');
            b.className = 'rp2-act' + (r.danger ? ' rp2-act-danger' : '') + (r.primary ? ' rp2-act-primary' : '');
            b.textContent = r.label;
            tap(b, async () => { this._onSheetClose = null; this._closeSheet(); await r.fn(); });
            grid.appendChild(b);
        }
        s.appendChild(grid);
        s.hidden = false;
    }

    _closeSheet() {
        if (this._sheetEl) this._sheetEl.hidden = true;
        const pending = this._onSheetClose;      // ✕ on a question = "no"
        this._onSheetClose = null;
        if (pending) pending();
    }

    _fixRows(problems) {
        const rows = [];
        for (const p of problems) {
            rows.push({ note: '⚠ ' + p.message, severity: p.severity });
            for (const f of p.fixes) rows.push({ label: f.label, primary: true, fn: () => this._applyFix(f) });
        }
        return rows;
    }

    _openBubbleSheet(i) {
        const item = this._route[i];
        if (!item) return;
        const rows = this._fixRows(this._problems.filter((p) => p.pillIndexes.includes(i)));
        const isPoint = item.type !== 'awy' && item.type !== 'direct';
        if (item.type === 'dest') rows.push({ label: 'Approaches & arrivals…', primary: true, fn: () => this._openProcedures(i) });
        if (isPoint && item.type !== 'dest' && item.type !== 'fuel') rows.push({ label: 'Fuel stop near here…', fn: () => this._fuelStopNear(i) });
        rows.push({ label: 'Insert before…', fn: () => this._startInsert(i) });
        rows.push({ label: 'Insert after…', fn: () => this._startInsert(i + 1) });
        if (item.type === 'airport' || item.type === 'fuel') {
            rows.push({ label: item.type === 'fuel' ? 'Not a fuel stop' : 'Fuel stop here', fn: () => { item.type = item.type === 'fuel' ? 'airport' : 'fuel'; this._render(); } });
        }
        if (isPoint && item.type !== 'dep' && item.type !== 'dest') {
            rows.push({ label: 'Altitude…', fn: () => this._askAltitude(item) });
            rows.push({ label: 'Start route here', fn: () => this._startHere(i) });
            rows.push({ label: 'End route here', fn: () => this._endHere(i) });
        }
        rows.push({ label: 'Remove', danger: true, fn: () => this._removeAt(i) });
        this._openSheet(item.id, rows);
    }

    _openProblemSheet() {
        if (!this._problems.length) return;
        this._openSheet('Route check', this._fixRows(this._problems));
    }

    _openMoreSheet() {
        this._openSheet('More', [
            { label: 'Use clearance (CLR)', primary: true, fn: () => window.app?.routeFromClearance?.() },
            { label: 'Copy route', fn: () => this._onCopyTap() },
            { label: this._compactView ? 'Show all fixes' : 'Compact view', fn: () => { this._compactView = !this._compactView; this._saveOpts(); this._render(); } },
            { note: 'To paste a route, long-press the route field and paste: each identifier becomes a bubble.' },
        ]);
    }

    _startInsert(at) {
        this._insertIndex = at;
        this._render();
        this._inputEl.focus();
    }

    _askAltitude(item) {
        const v = prompt(`Altitude for ${item.id} (ft, blank = route default):`, item.altFt ? String(item.altFt) : '');
        if (v === null) return;
        item.altFt = v.trim() ? parseInt(v, 10) : undefined;
        if (!Number.isFinite(item.altFt)) delete item.altFt;
        this._render();
    }

    _startHere(i) {
        const p = this._route[i];
        this._route.splice(0, i);
        p.type = 'dep';
        this._render();
    }

    _endHere(i) {
        const p = this._route[i];
        this._route.splice(i + 1);
        p.type = 'dest';
        this._render();
    }

    _removeAt(i) {
        const removed = this._route.splice(i, 1)[0];
        const pts = () => this._route.map((p, k) => ({ p, k })).filter(({ p }) => p.type !== 'awy' && p.type !== 'direct');
        if (removed?.type === 'dep' && pts().length) pts()[0].p.type = 'dep';
        if (removed?.type === 'dest' && pts().length > 1) pts()[pts().length - 1].p.type = 'dest';
        if (this._insertIndex != null && this._insertIndex > i) this._insertIndex--;
        this._render();
    }

    async _applyFix(f) {
        if (f.apply === 'setRouting') {
            this._routingMode = f.arg.mode;
            this._saveOpts();
            this._syncGrid();
            this._scheduleCheck();
            return;
        }
        if (f.apply === 'addFuelStop') { await this._addFuelStop(); return; }
        this._route = RouteCheck.applyFix(this._route, f);
        this._render();
    }

    async _addFuelStop(depth = 0) {
        if (!this._planner) { this._toast('Route engine still loading — try again in a moment'); return; }
        const computed = await this._compute();
        if (!computed) { this._toast('Route not complete'); return; }
        this._computed = computed;
        const dep = this._route.find((p) => p.type === 'dep')?.id;
        const dest = this._route[this._destPillIndex()]?.id;
        const result = await this._planner.insertFuelStops({
            ...computed, departure: dep, destination: dest,
            options: { maxLegHrs: this._maxLegHrs, selfServeOnly: this._selfServeOnly },
        });
        if (!result.fuelStopCandidates?.length) { this._toast('No airports with avgas found near where the limit is reached', 4000); return; }
        await this._processFuelStopCandidates(result, depth);
    }

    /**
     * One fuel stop at a time: the engine works out every stop from times
     * computed WITHOUT stops, so after the first one (with its descent and
     * climb) the next is in the wrong place -- it suggested a second stop next
     * to the destination on KLKR-KTMB. Offer the first, add it, re-check, and
     * offer the next from the new times only if still over the limit.
     * Used by Add fuel stop and by Plan route.
     */
    async _processFuelStopCandidates(result, depth = 0) {
        const first = (result?.fuelStopCandidates || [])[0];
        if (!first) return;
        const chosen = await this._showFuelStopPicker(first);
        if (!chosen) return;
        if (this._route.some((p) => p.type === 'fuel' && p.id === chosen.icao)) {
            this._toast(`${chosen.icao} is already a fuel stop`);
            return;
        }
        this._coords[chosen.icao] = { lat: chosen.lat, lon: chosen.lon };
        await this._insertFuelStop(first.afterFixId, { id: chosen.icao, type: 'fuel' }, chosen);
        this._render();
        const problems = await this._runChecks();
        if (depth < 3 && problems.some((p) => p.code === 'fuel-over-limit')) await this._addFuelStop(depth + 1);
    }

    /**
     * Put a fuel stop suggested "after <fix>" into the pills: land there, then
     * carry on from where the route was left. On an airway, split it at the
     * airway fix nearest the airport (E entry, X exit, N that fix):
     *   N = E:  E ⛽ E AWY … X        N = X:  E AWY … X ⛽ X …
     *   else:   E AWY N ⛽ N AWY X
     * (KLKR-KTMB: KCRG next to CRG, the V267 entry; K2IS ~150 nm down V157 had
     * been put after LAL with a rejoin at LAL, flying back north: +43 %.)
     * Off airways: just after the fix. Never after the destination.
     */
    async _insertFuelStop(afterFixId, stop, where) {
        const r = this._route;
        const isPoint = (p) => p.type !== 'awy' && p.type !== 'direct';
        const up = (x) => String(x ?? '').toUpperCase();
        const seg = this._airwaySegment(afterFixId);
        const rec = seg ? await this._getAirway(seg.name) : null;
        if (seg && rec?.waypoints?.length && where && Number.isFinite(where.lat)) {
            const pts = rec.waypoints.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
            const is = (p, id) => up(p.id) === up(id) || up(p.name) === up(id);
            const iE = pts.findIndex((p) => is(p, r[seg.e].id));
            const iX = pts.findIndex((p) => is(p, r[seg.x].id));
            if (iE >= 0 && iX >= 0) {
                const along = iE <= iX ? pts.slice(iE, iX + 1) : pts.slice(iX, iE + 1).reverse();
                let best = -1, bestNm = Infinity;
                along.forEach((p, i) => {
                    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
                    const nm = RouteCheck._directNm(where, p);
                    if (nm < bestNm) { bestNm = nm; best = i; }
                });
                // Keep the airway (split at the nearest fix: 2 x the distance to the
                // airport) unless leaving it -- entry, stop, exit direct -- saves more
                // than KEEP_AIRWAY_NM. K2IS was ~20 nm off V157, nearest end 60 nm away.
                const d = (a, b) => RouteCheck._directNm(a, b);
                let path = 0;
                for (let i = 1; i < along.length; i++) if (Number.isFinite(along[i].lat) && Number.isFinite(along[i - 1].lat)) path += d(along[i - 1], along[i]);
                const E = along[0], X = along[along.length - 1];
                const directExtra = d(E, where) + d(where, X) - path;
                if (best < 0 || 2 * bestNm > directExtra + RoutePlannerV2.KEEP_AIRWAY_NM) {
                    const exit = { ...r[seg.x] };
                    delete exit.airway;
                    r.splice(seg.a, seg.x - seg.a + 1, stop, exit);
                    return;
                }
                // The destination as the airway's exit: stop at the fix before it.
                if (best === along.length - 1 && r[seg.x].type === 'dest') best = Math.max(0, best - 1);
                if (best === 0) { r.splice(seg.e + 1, 0, stop, { id: r[seg.e].id, type: 'fix' }); return; }
                if (best === along.length - 1) { r.splice(seg.x + 1, 0, stop, { id: r[seg.x].id, type: 'fix' }); return; }
                if (best > 0) {
                    const n = up(along[best].id || along[best].name);
                    for (let i = seg.a + 1; i < seg.x; i++) {
                        if (isPoint(r[i]) && up(r[i].id) === n) {          // already a bubble on the airway
                            r.splice(i + 1, 0, stop, { id: r[i].id, type: 'fix' }, { id: seg.name, type: 'awy' });
                            return;
                        }
                    }
                    let at = seg.x;                                       // before the first bubble past it
                    for (let i = seg.a + 1; i < seg.x; i++) {
                        if (isPoint(r[i]) && along.findIndex((p) => is(p, r[i].id)) > best) { at = i; break; }
                    }
                    r.splice(at, 0, { id: n, type: 'fix', airway: seg.name }, stop, { id: n, type: 'fix' }, { id: seg.name, type: 'awy' });
                    return;
                }
            }
        }
        // Off airways (or no airway data): just after the fix, before the destination at the latest.
        const own = r.findIndex((p) => isPoint(p) && p.id === afterFixId);
        const dest = this._destPillIndex();
        let at = own >= 0 ? own + 1 : dest;
        if (dest >= 0) at = Math.min(at, dest);
        if (at < 0) at = r.length;
        r.splice(at, 0, stop);
    }

    /**
     * The airway segment the leg after `afterFixId` is on, in pill indices:
     * { name, e: entry bubble, a: the airway pill, x: exit bubble }, or null.
     * Exit: the last point after the airway pill that still carries its tag
     * (planned routes tag interior fixes), or the first point after it.
     */
    _airwaySegment(afterFixId) {
        const r = this._route;
        const isPoint = (p) => p.type !== 'awy' && p.type !== 'direct';
        const wps = this._computed?.waypoints || [];
        const k = wps.findIndex((w) => w.id === afterFixId);
        const own = r.findIndex((p) => isPoint(p) && p.id === afterFixId);
        let name = k >= 0 ? (wps[k + 1]?.airway || null) : null;
        if (!name && own >= 0 && r[own + 1]?.type === 'awy') name = r[own + 1].id;
        if (!name) return null;
        // The pill index to search back from: the anchor bubble, or the next bubble after the anchor.
        let ref = own;
        if (ref < 0) {
            for (let j = k + 1; k >= 0 && j < wps.length && ref < 0; j++) ref = r.findIndex((p) => isPoint(p) && p.id === wps[j].id);
        }
        if (ref < 0) return null;
        let a = -1;
        if (r[ref + 1]?.type === 'awy' && r[ref + 1].id === name) a = ref + 1;
        else for (let i = ref; i >= 0; i--) if (r[i].type === 'awy' && r[i].id === name) { a = i; break; }
        if (a < 1 || !isPoint(r[a - 1])) return null;
        let x = -1;
        for (let i = a + 1; i < r.length; i++) {
            if (!isPoint(r[i])) break;
            if (x < 0 || r[i].airway === name) x = i; else break;
        }
        return x > a ? { name, e: a - 1, a, x } : null;
    }

    // ── Search ───────────────────────────────────────────────────────────────

    _onSearchInput() {
        if (this._searchTimer) clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => this._runSearch(), 250);
    }

    async _runSearch() {
        const q = this._searchInput.value.trim();
        const box = this._resultsEl;
        if (q.length < 2 || !this._nasrDb) { box.hidden = true; box.innerHTML = ''; return; }
        const seq = (this._searchSeq = (this._searchSeq || 0) + 1);
        const ref = this._searchRef();
        const rows = [];
        const nmTo = (x) => (ref && Number.isFinite(x?.lat) && Number.isFinite(x?.lon)) ? Math.round(RouteCheck._directNm(ref, x)) : null;
        for (const { a, nm } of await this._searchAirports(q, ref)) {
            rows.push({ id: a.icao, main: a.name || '', sub: [[a.city, a.state].filter(Boolean).join(', '), nm != null ? `${nm} nm` : ''].filter(Boolean).join(' · ') });
        }
        let r = null;
        try { r = await this._nasrDb.searchAllExtended?.(q, 6); } catch { r = null; }
        if (seq !== this._searchSeq) return;                   // a newer search is running
        const have = new Set(rows.map((x) => x.id));
        for (const n of r?.navaids || []) if (!have.has(n.id)) rows.push({ id: n.id, main: n.name || '', sub: [n.type || 'Navaid', nmTo(n) != null ? `${nmTo(n)} nm` : ''].filter(Boolean).join(' · ') });
        for (const f of r?.fixes || []) if (!have.has(f.id)) rows.push({ id: f.id, main: 'Fix', sub: nmTo(f) != null ? `${nmTo(f)} nm` : '' });
        box.innerHTML = '';
        if (!rows.length) box.innerHTML = '<div class="rp2-result-none">No match</div>';
        for (const row of rows.slice(0, 12)) {
            const b = document.createElement('button');
            b.className = 'rp2-result';
            b.innerHTML = '<span class="rp2-result-id"></span><span class="rp2-result-main"></span><span class="rp2-result-sub"></span>';
            b.children[0].textContent = row.id;
            b.children[1].textContent = row.main;
            b.children[2].textContent = row.sub;
            wireTap(b, () => this._pickSearchResult(row.id));
            box.appendChild(b);
        }
        box.hidden = false;
    }

    /**
     * Airports matching an identifier, name or city, best first: exact
     * identifier, then identifier prefix, then name/city -- each nearest first.
     * The whole airport list is searched (loaded once): NasrDB's own search
     * stops at the first N in alphabetical order, so "Camden" gave Camden NJ,
     * AL and Camdenton MO, never Camden SC.
     */
    async _searchAirports(q, ref) {
        if (!this._airportList) {
            try { this._airportList = (await this._nasrDb._getAll?.('airports')) || []; } catch { this._airportList = []; }
        }
        const Q = q.toUpperCase();
        const KQ = 'K' + Q;
        const out = [];
        for (const a of this._airportList) {
            const id = String(a.icao || '');
            let rank = -1;
            if (id === Q || id === KQ) rank = 0;
            else if (id.startsWith(Q) || id.startsWith(KQ)) rank = 1;
            // Name or city alike: KCDN is in Camden but named Woodward Fld.
            else if (String(a.name || '').toUpperCase().includes(Q) || String(a.city || '').toUpperCase().includes(Q)) rank = 2;
            if (rank < 0) continue;
            // Public airports (K + 3) with a paved runway before private strips
            // ("Aiken" gave 4SC7 Wexford Landing ahead of KAIK Aiken Rgnl).
            const tier = /^K[A-Z0-9]{3}$/.test(id) && a.has_paved_rwy !== false ? 0 : 1;
            const nm = ref && Number.isFinite(a.lat) && Number.isFinite(a.lon) ? RouteCheck._directNm(ref, a) : null;
            out.push({ a, rank, tier, nm: nm != null ? Math.round(nm) : null });
        }
        out.sort((x, y) => x.rank - y.rank || x.tier - y.tier || (x.nm ?? 1e9) - (y.nm ?? 1e9));
        return out.slice(0, 10);
    }

    /** Where "nearest" is measured from: own-ship if known, else the map centre. */
    _searchRef() {
        const s = typeof app !== 'undefined' ? app.stratuxClient?.situation : null;
        if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.lat && s.lon && !s._stale) return { lat: s.lat, lon: s.lon };
        const c = typeof app !== 'undefined' ? app.cockpitMap?.map?.getCenter?.() : null;
        return c ? { lat: c.lat, lon: c.lng } : null;
    }

    /** Add a search result to the route at the cursor. */
    async _pickSearchResult(id) {
        this._searchInput.value = '';
        this._resultsEl.hidden = true;
        this._resultsEl.innerHTML = '';
        this._searchInput.blur();
        await this._queueToken(id);
    }

    // ── Clearance ────────────────────────────────────────────────────────────

    /**
     * Route from a clearance: `limit` (C) becomes the destination, `route` (R)
     * the bubbles in between, in order; words that aren't places (DIRECT,
     * THEN, RADAR VECTORS...) are skipped. "AS FILED" keeps the route and only
     * changes the destination. The departure is kept. The route checks then
     * flag anything wrong; nothing is applied until Apply.
     */
    async loadClearance({ limit = '', route = '' }) {
        await this._commitTyped();
        const SKIP = new Set(['DIRECT', 'DCT', 'THEN', 'AS', 'FILED', 'RADAR', 'VECTORS', 'RV', 'TO', 'VIA',
            'CLEARED', 'MAINTAIN', 'EXPECT', 'CLIMB', 'DESCEND', 'AND', 'FLY', 'HEADING', 'THE']);
        const resolveApt = async (id) => {
            if (!id) return '';
            if (await this._isAirport(id)) return id;
            if (id.length === 3 && await this._isAirport('K' + id)) return 'K' + id;
            return id;
        };
        // The app fills C as "KCDN — WOODWARD FLD": the identifier is the first word.
        const dest = await resolveApt((String(limit).toUpperCase().match(/^[A-Z0-9]{2,5}/) || [''])[0]);
        const asFiled = /\bAS\s+FILED\b/.test(route);
        const dep = this._route.find((p) => p.type === 'dep');
        if (asFiled) {
            const d = this._destPillIndex();
            if (dest && d >= 0 && this._route[d].id !== dest) this._route[d] = { id: dest, type: 'dest' };
            else if (dest && d < 0) this._route.push({ id: dest, type: 'dest' });
            this._render();
            this._toast('Clearance: as filed' + (dest ? ` to ${dest}` : ''), 3000);
            return;
        }
        const keepDest = this._route[this._destPillIndex()]?.id;
        const destId = dest || keepDest || '';
        this._route = dep ? [{ ...dep }] : [];
        if (destId) this._route.push({ id: destId, type: 'dest' });
        this._cursorAtEnd = false;
        this._insertIndex = null;
        const tokens = String(route).toUpperCase().split(/[\s,]+/).filter(Boolean)
            .filter((t) => !SKIP.has(t) && t !== dep?.id && t !== destId && /^[A-Z0-9]{2,5}$/.test(t));
        for (const t of tokens) await this._queueToken(t);
        this._render();
        this._toast('Clearance loaded — check the route, then Apply', 3500);
    }

    // ── Procedures (destination) ─────────────────────────────────────────────

    /** "RNAV (GPS) 07 (R07)" for CIFP approach codes; anything unrecognised is shown as is. */
    static procLabel(name, type) {
        if (type !== 'APPROACH') return name;
        const m = /^([A-Z])(\d{2}[LRC]?)(?:-?([A-Z]))?$/.exec(name);
        const T = { I: 'ILS', L: 'LOC', R: 'RNAV (GPS)', H: 'RNAV (RNP)', V: 'VOR', D: 'VOR/DME', N: 'NDB',
                    B: 'LOC/BC', X: 'LDA', U: 'SDF', P: 'GPS', Q: 'NDB/DME' };
        if (!m || !T[m[1]]) return name;
        return `${T[m[1]]} ${m[2]}${m[3] ? ' ' + m[3] : ''} (${name})`;
    }

    async _openProcedures(i) {
        const icao = this._route[i]?.id;
        const ac = typeof app !== 'undefined' ? app.approachCharts : null;
        if (!icao || !ac?.proceduresFor) { this._toast('Procedures not available'); return; }
        const { key, loaded, procs } = await ac.proceduresFor(icao);
        if (!loaded) { this._toast('Procedure data (CIFP) is not on the tablet', 4000); return; }
        const apps = procs.filter((p) => p.type === 'APPROACH');
        const stars = procs.filter((p) => p.type === 'STAR');
        if (!apps.length && !stars.length) { this._toast(`No approaches or arrivals for ${icao}`, 3500); return; }
        const rows = [];
        if (apps.length) rows.push({ note: 'Approaches' });
        for (const p of apps) rows.push({ label: RoutePlannerV2.procLabel(p.name, p.type), primary: true, fn: () => this._pickTransition(key, p) });
        if (stars.length) rows.push({ note: 'Arrivals' });
        for (const p of stars) rows.push({ label: p.name, fn: () => this._pickTransition(key, p) });
        this._openSheet(`${icao} procedures`, rows);
    }

    _pickTransition(key, p) {
        const ac = app.approachCharts;
        const ts = (p.transitions || []).filter(Boolean);
        const rows = ts.map((t) => ({ label: t === 'ALL' ? 'Common route' : `Via ${t}`, primary: true, fn: () => ac.loadProcedure(key, p.name, t) }));
        if (p.type === 'APPROACH') rows.push({ label: 'Vectors (no transition)', fn: () => ac.loadProcedure(key, p.name, '') });
        if (rows.length === 1) { rows[0].fn(); return; }
        this._openSheet(RoutePlannerV2.procLabel(p.name, p.type), rows);
    }

    // ── Fuel stop where you choose ───────────────────────────────────────────

    /** "Fuel stop near here…": avgas airports within 30 nm of this bubble, then the usual re-check. */
    async _fuelStopNear(i) {
        const item = this._route[i];
        const aero = this._planner?._adapters?.aero;
        const c = item ? await this._aero().resolve(item.id) : null;
        if (!c || !aero?.nearestAirports) { this._toast('Can\'t look for airports near ' + (item?.id || 'here')); return; }
        const dep = this._route.find((p) => p.type === 'dep')?.id;
        const dest = this._route[this._destPillIndex()]?.id;
        const near = (await aero.nearestAirports(c.lat, c.lon, 30))
            .filter((a) => a.hasFuel && a.icao !== dep && a.icao !== dest && a.icao !== item.id)
            .map((a) => ({ icao: a.icao, name: a.name || a.icao, lat: a.lat, lon: a.lon, distNm: Math.round(RouteCheck._directNm(c, a) * 10) / 10 }))
            .sort((x, y) => x.distNm - y.distNm)
            .slice(0, 8);
        if (!near.length) { this._toast(`No airports with avgas within 30 nm of ${item.id}`, 3500); return; }
        const computed = await this._compute();
        this._computed = computed;
        let hrs = 0;
        const wps = computed?.waypoints || [];
        for (let k = 0; k < (computed?.legs || []).length; k++) { hrs += computed.legs[k].timeHrs || 0; if (wps[k + 1]?.id === item.id) break; }
        await this._processFuelStopCandidates({ fuelStopCandidates: [{ afterFixId: item.id, cumHrsAtStop: Math.round(hrs * 100) / 100, options: near }] });
    }

    // ── Checks ───────────────────────────────────────────────────────────────

    _scheduleCheck() {
        if (this._checkTimer) clearTimeout(this._checkTimer);
        this._checkTimer = setTimeout(() => { this._checkTimer = null; this._runChecks(); }, 300);
    }

    /** The plan Apply would compute for the current pills (same inputs as _doApply). */
    async _compute() {
        if (!this._planner) return null;
        const pts = this._route.filter((p) => p.type !== 'awy' && p.type !== 'direct');
        if (pts.length < 2) return null;
        this._quiet++;
        try {
            const wps = await this._pillsToWaypoints();
            if (wps.length < 2) return null;
            const destination = this._route[this._destPillIndex()]?.id;
            return this._planner.recomputeLegs({ waypoints: wps, destination }, this._profileForPower(this._pctPower), {
                departureTime: this._departureTime ?? new Date(),
                pctPower: this._pctPower,
                cruiseAltFt: this._cruiseAltFt ?? undefined,
                winds: this._lastWinds ?? undefined,
            });
        } catch (err) {
            console.warn('[RoutePlannerV2] compute failed:', err);
            return null;
        } finally {
            this._quiet--;
        }
    }

    async _runChecks() {
        const epoch = ++this._checkEpoch;
        const computed = await this._compute();
        let problems = [];
        if (typeof RouteCheck !== 'undefined') {
            problems = await RouteCheck.run({
                pills: this._route.map((p) => ({ ...p })),
                computed,
                settings: { routingMode: this._routingMode, maxLegHrs: this._maxLegHrs, reserveGal: this._reserveGal },
                aero: this._aero(),
            });
        }
        if (epoch !== this._checkEpoch) return problems;     // a newer check is running
        this._problems = problems;
        this._computed = computed;
        this._renderProblems();
        this._markBubbles();
        this._renderStats(computed);
        return problems;
    }

    _aero() {
        return {
            getAirway: (name) => this._getAirway(name),
            resolve: async (id) => {
                const c = this._coords[id] || this._coords[String(id).toUpperCase()];
                if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) return c;
                if (!this._nasrDb) return null;
                let r = await this._nasrDb.getAirport(id).catch(() => null);
                if (!r) r = await this._nasrDb.getNavaid(id).catch(() => null);
                if (!r) r = await this._nasrDb.getFix(id).catch(() => null);
                if (!Number.isFinite(r?.lat) || !Number.isFinite(r?.lon)) return null;
                this._coords[id] = { lat: r.lat, lon: r.lon };
                return this._coords[id];
            },
        };
    }

    async _getAirway(name) {
        const key = String(name).toUpperCase();
        if (this._airwayCache.has(key)) return this._airwayCache.get(key);
        let a = null;
        try { a = (await this._nasrDb?.getAirway?.(key)) || null; } catch { a = null; }
        this._airwayCache.set(key, a);
        return a;
    }

    _renderProblems() {
        const el = this._problemEl;
        if (!el) return;
        const ps = this._problems;
        if (!ps.length) { el.textContent = ''; el.className = 'rp2-problem'; return; }
        const first = ps[0];
        const more = ps.length > 1 ? ` · +${ps.length - 1} more` : '';
        el.textContent = `⚠ ${first.message}${first.fixes.length ? ' — tap to fix' : ''}${more}`;
        el.className = `rp2-problem rp2-problem-${first.severity}`;
    }

    _renderStats(c) {
        const el = this._statsStripEl;
        if (!el) return;
        const s = c?.summary;
        if (!s) { el.innerHTML = ''; if (this._flightsEl) this._flightsEl.innerHTML = ''; return; }
        const wps = c.waypoints || [];
        const destIdx = this._destWaypointIndex(wps);
        const legs = (c.legs || []).slice(0, destIdx);
        const hm = (hrs) => { const m = Math.round(hrs * 60); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`; };
        const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
        const etaMs = legs.length ? legs[legs.length - 1].eta : null;
        let wind = '—';
        const wl = legs.filter((l) => Number.isFinite(l.gsKt) && Number.isFinite(l.tasKt));
        if (wl.length) {
            const d = Math.round(wl.reduce((a, l) => a + (l.gsKt - l.tasKt), 0) / wl.length);
            wind = d >= 0 ? `${d} tail` : `${-d} head`;
        }
        const ground = s.groundHrs > 0 ? ` +${hm(s.groundHrs)} gnd` : '';
        const cell = (k, v) => `<div><span class="rp2-k">${k}</span><span class="rp2-v">${v}</span></div>`;
        el.innerHTML = cell('DIST', `${Math.round(s.totalDistNm)} nm`)
            + cell('ETE', `${hm(s.totalEteHrs)}${ground}`)
            + cell('ETA', Number.isFinite(etaMs) ? clock(etaMs) : '—')
            + cell('FUEL', `${s.totalFuelGal.toFixed(1)} g`)
            + cell('WIND', wind);

        // With fuel stops: one row per flight -- time, landing time, fuel left.
        const flights = RoutePlannerV2.flightsOf(c);
        if (!this._flightsEl) return;
        if (flights.length < 2) { this._flightsEl.innerHTML = ''; return; }
        this._flightsEl.innerHTML = flights.map((f, n) =>
            `<div class="rp2-flight"><span class="rp2-flight-n">${n + 1}</span>`
            + `<span class="rp2-flight-route">${f.from} → ${f.to}</span>`
            + `<span>${hm(f.hrs)}</span><span>land ${clock(f.landMs)}</span>`
            + `<span class="${f.landGal < this._reserveGal ? 'rp2-low' : ''}">${f.landGal.toFixed(1)} g left</span></div>`).join('');
    }

    /** The flights of a computed plan, split at fuel stops: [{ from, to, hrs, landMs, landGal }]. */
    static flightsOf(c) {
        const wps = c?.waypoints || [];
        let destIdx = wps.findIndex((w) => w.isDest);
        if (destIdx < 0) destIdx = wps.length - 1;
        const out = [];
        let start = 0, hrs = 0;
        for (let k = 0; k < Math.min((c?.legs || []).length, destIdx); k++) {
            const l = c.legs[k];
            hrs += l.timeHrs || 0;
            const to = wps[k + 1];
            if (to?.fuelStop || k + 1 === destIdx) {
                out.push({ from: wps[start].id, to: to.id, hrs, landMs: l.eta, landGal: l.fuelRemGal });
                start = k + 1;
                hrs = 0;
            }
        }
        return out;
    }

    /** The base stats bar isn't on this screen. */
    _updateStats() {}

    // ── Apply ────────────────────────────────────────────────────────────────

    async _onApplyKeepOpenTap() {
        await this._commitTyped();
        const problems = await this._runChecks();
        const red = problems.filter((p) => p.severity === 'red');
        if (red.length) {
            const ok = await this._askApplyAnyway(red);
            if (!ok) { this._openProblemSheet(); return; }
        }
        await super._onApplyKeepOpenTap();
        this._scheduleCheck();
    }

    _askApplyAnyway(red) {
        return new Promise((resolve) => {
            const n = red.length;
            this._openSheet(`Route has ${n} problem${n > 1 ? 's' : ''}`, [
                ...red.map((p) => ({ note: '⚠ ' + p.message, severity: 'red' })),
                { label: 'Fix it', primary: true, fn: () => resolve(false) },
                { label: 'Apply anyway', danger: true, fn: () => resolve(true) },
            ]);
            this._onSheetClose = () => resolve(false);   // ✕ = Fix it
        });
    }

    // ── Airways along the airway ─────────────────────────────────────────────

    /**
     * The base waypoints, with each airway leg (entry and exit both on the
     * airway) expanded into the airway's fixes between them, in NASR order. A
     * leg whose ends aren't on the airway stays straight (and is flagged red).
     */
    async _pillsToWaypoints() {
        const wps = await super._pillsToWaypoints();
        const out = [];
        for (const w of wps) {
            const prev = out[out.length - 1];
            if (prev && w.airway) {
                for (const f of await this._airwayBetween(w.airway, prev.id, w.id)) {
                    out.push({ id: f.id, icao: f.id, name: f.id, lat: f.lat, lon: f.lon, airway: w.airway });
                }
            }
            out.push(w);
        }
        return out;
    }

    async _airwayBetween(name, fromId, toId) {
        const a = await this._getAirway(name);
        if (!a?.waypoints?.length) return [];
        const pts = a.waypoints.slice().sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
        // Navaids carry an identifier and a name ({id:'CAE', name:'Columbia'}),
        // fixes only a name: match either, use the identifier.
        const up = (x) => String(x ?? '').toUpperCase();
        const is = (p, id) => up(p.id) === up(id) || up(p.name) === up(id);
        const key = (p) => up(p.id || p.name);
        const iA = pts.findIndex((p) => is(p, fromId));
        const iB = pts.findIndex((p) => is(p, toId));
        if (iA < 0 || iB < 0 || Math.abs(iA - iB) <= 1) return [];
        // Never along a gap or an unusable segment: leave the leg straight (the route check flags it).
        const unusable = new Set(a.unusable_from_seqs || []);
        for (let k = Math.min(iA, iB); k < Math.max(iA, iB); k++) if (unusable.has(pts[k].seq)) return [];
        const between = iA < iB ? pts.slice(iA + 1, iB) : pts.slice(iB + 1, iA).reverse();
        return between
            .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
            .map((p) => ({ id: key(p), lat: p.lat, lon: p.lon }));
    }
}

/** A fuel stop keeps its airway unless leaving it saves more than this (nm). */
RoutePlannerV2.KEEP_AIRWAY_NM = 10;
