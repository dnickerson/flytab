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
            if (e.key === 'Enter') { e.preventDefault(); this._commitTyped(); }
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

        // Toolbar
        const tb = document.createElement('div');
        tb.className = 'rp2-toolbar';
        const mk = (label, fn, cls = '') => {
            const b = document.createElement('button');
            b.className = 'rp2-tbtn' + (cls ? ' ' + cls : '');
            b.textContent = label;
            wireTap(b, async () => { await this._commitTyped(); fn(); });
            tb.appendChild(b);
            return b;
        };
        mk('Plan route', () => { this._syncFieldsFromPills(); this._onPlanRouteTap(); });
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
            for (const { item, originalIdx } of view) {
                const b = this._buildBubble(item, originalIdx);
                if (originalIdx < at) this._bubblesEl.insertBefore(b, this._inputEl);
                else this._bubblesEl.appendChild(b);
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
        wireTap(b, async () => { await this._commitTyped(); this._openBubbleSheet(idx); });
        return b;
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
        wireTap(x, () => this._closeSheet());
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
            wireTap(b, async () => { this._onSheetClose = null; this._closeSheet(); await r.fn(); });
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

    async _addFuelStop() {
        if (!this._planner) { this._toast('Route engine still loading — try again in a moment'); return; }
        const computed = this._computed || await this._compute();
        if (!computed) { this._toast('Route not complete'); return; }
        const dep = this._route.find((p) => p.type === 'dep')?.id;
        const dest = this._route[this._destPillIndex()]?.id;
        const result = await this._planner.insertFuelStops({
            ...computed, departure: dep, destination: dest,
            options: { maxLegHrs: this._maxLegHrs, selfServeOnly: this._selfServeOnly },
        });
        if (!result.fuelStopCandidates?.length) { this._toast('No airports with fuel found near where the limit is reached', 4000); return; }
        await this._processFuelStopCandidates(result);
        this._render();
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
        if (!s) { el.innerHTML = ''; return; }
        const destIdx = this._destWaypointIndex(c.waypoints || []);
        const legs = (c.legs || []).slice(0, destIdx);
        const ete = s.totalEteHrs;
        const h = Math.floor(ete), m = Math.round((ete - h) * 60);
        const dep = this._departureTime ?? new Date();
        const eta = new Date(dep.getTime() + ete * 3600000);
        let wind = '—';
        const wl = legs.filter((l) => Number.isFinite(l.gsKt) && Number.isFinite(l.tasKt));
        if (wl.length) {
            const d = Math.round(wl.reduce((a, l) => a + (l.gsKt - l.tasKt), 0) / wl.length);
            wind = d >= 0 ? `${d} tail` : `${-d} head`;
        }
        const cell = (k, v) => `<div><span class="rp2-k">${k}</span><span class="rp2-v">${v}</span></div>`;
        el.innerHTML = cell('DIST', `${Math.round(s.totalDistNm)} nm`)
            + cell('ETE', `${h}h${String(m).padStart(2, '0')}m`)
            + cell('ETA', eta.toTimeString().slice(0, 5))
            + cell('FUEL', `${s.totalFuelGal.toFixed(1)} g`)
            + cell('WIND', wind);
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
        const key = (p) => String(p.name ?? p.id ?? '').toUpperCase();
        const iA = pts.findIndex((p) => key(p) === String(fromId).toUpperCase());
        const iB = pts.findIndex((p) => key(p) === String(toId).toUpperCase());
        if (iA < 0 || iB < 0 || Math.abs(iA - iB) <= 1) return [];
        const between = iA < iB ? pts.slice(iA + 1, iB) : pts.slice(iB + 1, iA).reverse();
        return between
            .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
            .map((p) => ({ id: key(p), lat: p.lat, lon: p.lon }));
    }
}
