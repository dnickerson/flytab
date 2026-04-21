/**
 * EverywhereSearch — plain-language search across airports, navaids, fixes,
 * airways, and CIFP procedures. Runs entirely offline.
 */
class EverywhereSearch {
    constructor(nasrDb, stratuxClient) {
        this._nasrDb = nasrDb;
        this._stratuxClient = stratuxClient;
        this._approachCharts = null;
        this._routeEditor = null;
        this._routeTable = null;
        this._airportPopup = null;
        this._cockpitMap = null;
        this._getActiveTrip = null;

        this._overlay = null;
        this._input = null;
        this._resultsList = null;
        this._debounceTimer = null;
        this._lastQuery = '';

        this._RECENT_KEY = 'flypi_search_recent';
        this._RECENT_MAX = 10;
    }

    setApproachCharts(ac)   { this._approachCharts = ac; }
    setRouteEditor(re)      { this._routeEditor = re; }
    setRouteTable(rt)       { this._routeTable = rt; }
    setAirportPopup(ap)     { this._airportPopup = ap; }
    setCockpitMap(cm)       { this._cockpitMap = cm; }
    setGetActiveTrip(fn)    { this._getActiveTrip = fn; }

    show() {
        if (!this._overlay) this._buildOverlay();
        this._overlay.style.display = 'flex';
        setTimeout(() => this._input?.focus(), 100);
        this._renderRecents();
    }

    hide() {
        if (this._overlay) this._overlay.style.display = 'none';
        if (this._input) this._input.value = '';
        this._lastQuery = '';
        clearTimeout(this._debounceTimer);
    }

    toggle() {
        if (this._overlay && this._overlay.style.display !== 'none') {
            this.hide();
        } else {
            this.show();
        }
    }

    // ── Overlay construction ─────────────────────────────────────────────────

    _buildOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'esearch-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99990;background:var(--bg-primary);display:none;flex-direction:column;';

        // Header row: close + input
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;padding:8px 10px;gap:8px;border-bottom:2px solid var(--border-strong);flex-shrink:0;';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'esearch-close btn-close';
        closeBtn.innerHTML = '&#x2715;';
        closeBtn.style.cssText = 'min-width:var(--touch-min,56px);min-height:var(--touch-min,56px);font-size:24px;font-weight:700;background:transparent;border:none;color:var(--text-primary);flex-shrink:0;cursor:pointer;';
        this._fastTap(closeBtn, () => this.hide());

        const input = document.createElement('input');
        input.type = 'search';
        input.placeholder = 'Airport, navaid, fix, airway, or procedure…';
        input.autocomplete = 'off';
        input.autocorrect = 'off';
        input.autocapitalize = 'characters';
        input.spellcheck = false;
        input.style.cssText = 'flex:1;font-size:22px;font-weight:600;padding:10px 12px;border:2px solid var(--border-strong);border-radius:8px;background:var(--bg-surface);color:var(--text-primary);min-height:var(--touch-min,56px);outline:none;';
        input.addEventListener('input', () => this._onInput(input.value));
        input.addEventListener('focus', () => {
            if (!input.value.trim()) this._renderRecents();
        });
        this._input = input;

        header.appendChild(closeBtn);
        header.appendChild(input);
        overlay.appendChild(header);

        // Results list
        const list = document.createElement('div');
        list.style.cssText = 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;';
        this._resultsList = list;
        overlay.appendChild(list);

        document.body.appendChild(overlay);
        this._overlay = overlay;
    }

    _onInput(value) {
        clearTimeout(this._debounceTimer);
        const q = value.trim();
        if (!q) { this._renderRecents(); return; }
        this._debounceTimer = setTimeout(() => this._runSearch(q), 150);
    }

    // ── Search execution ─────────────────────────────────────────────────────

    async _runSearch(query) {
        if (query === this._lastQuery) return;
        this._lastQuery = query;

        const q = query.toUpperCase();
        const procQuery = this._parseProcedureQuery(q);

        const [dbResults, procResults] = await Promise.all([
            this._nasrDb.searchAllExtended(query, 20).catch(() => ({ airports: [], navaids: [], fixes: [], airways: [] })),
            procQuery ? this._searchProcedures(procQuery) : [],
        ]);

        const ownPos = this._getOwnPos();
        const ranked = this._rankResults(dbResults, q, ownPos);
        const all = [...procResults, ...ranked];

        if (query !== this._lastQuery) return; // superseded
        this._renderResults(all, query);
    }

    _getOwnPos() {
        const sit = this._stratuxClient?.situation;
        if (sit?.GPSLatitude && sit?.GPSLongitude && sit.GPSFixQuality > 0) {
            return { lat: sit.GPSLatitude, lon: sit.GPSLongitude };
        }
        return null;
    }

    // ── Ranking ──────────────────────────────────────────────────────────────

    _rankResults({ airports = [], navaids = [], fixes = [], airways = [] }, q, ownPos) {
        const score = (entity, type) => {
            const id   = (entity.icao || entity.id || entity.name || '').toUpperCase();
            const name = (entity.name || '').toUpperCase();
            const city = (entity.city || '').toUpperCase();

            let tier;
            if (id === q || 'K' + q === id) {
                tier = 0;
            } else if (id.startsWith(q) || id.startsWith('K' + q)) {
                tier = 1;
            } else if (name.startsWith(q)) {
                tier = 2;
            } else if (city && city.startsWith(q)) {
                tier = 3;
            } else {
                tier = 4;
            }

            const typePriority = type === 'APT' ? 0 : type === 'NAV' ? 1 : type === 'FIX' ? 2 : 3;

            let distPenalty = 0;
            if (ownPos && entity.lat != null && entity.lon != null) {
                distPenalty = this._distNm(ownPos.lat, ownPos.lon, entity.lat, entity.lon) / 10000;
            }

            return tier + typePriority * 0.0001 + distPenalty;
        };

        const rows = [
            ...airports.map(e => ({ entity: e, type: 'APT',  score: score(e, 'APT') })),
            ...navaids.map(e =>  ({ entity: e, type: 'NAV',  score: score(e, 'NAV') })),
            ...fixes.map(e =>    ({ entity: e, type: 'FIX',  score: score(e, 'FIX') })),
            ...airways.map(e =>  ({ entity: e, type: 'AWY',  score: score(e, 'AWY') })),
        ];
        rows.sort((a, b) => a.score - b.score);
        return rows.slice(0, 30);
    }

    _distNm(lat1, lon1, lat2, lon2) {
        const dlat = (lat2 - lat1) * 60;
        const dlon = (lon2 - lon1) * 60 * Math.cos(lat1 * Math.PI / 180);
        return Math.sqrt(dlat * dlat + dlon * dlon);
    }

    // ── Procedure search ─────────────────────────────────────────────────────

    _parseProcedureQuery(q) {
        const upper = q.trim().toUpperCase();
        const PROC_TYPES = 'ILS|RNAV|VOR|NDB|LDA|LOC|GLS|GPS|TACAN';
        const RWY = '(\\d{1,2}[LRC]?)';
        const ICAO = '([A-Z][A-Z0-9]{2,3})';

        // Pattern: TYPE [GPS] [RWY] NN[LRC]? ICAO
        let m = upper.match(new RegExp(`(?:${PROC_TYPES})(?:\\s+GPS)?(?:\\s+(?:RWY|RY))?\\s*${RWY}\\s+${ICAO}$`, 'i'));
        if (m) {
            const typeMatch = upper.match(new RegExp(PROC_TYPES, 'i'));
            return { icao: m[2], procType: typeMatch?.[0] || '', runway: m[1] };
        }

        // Pattern: ICAO TYPE [RWY] NN[LRC]?
        m = upper.match(new RegExp(`^${ICAO}\\s+(?:${PROC_TYPES})(?:\\s+(?:RWY|RY))?\\s*${RWY}$`, 'i'));
        if (m) {
            const typeMatch = upper.match(new RegExp(PROC_TYPES, 'i'));
            return { icao: m[1], procType: typeMatch?.[0] || '', runway: m[2] };
        }

        // Short codes: I06 KHXD, R23L KHXD, V12 KHXD
        m = upper.match(new RegExp(`^([RIVNL])(\\d{1,2}[LRC]?)\\s+${ICAO}$`, 'i'));
        if (m) {
            const typeMap = { I: 'ILS', R: 'RNAV', V: 'VOR', N: 'NDB', L: 'LDA' };
            return { icao: m[3], procType: typeMap[m[1].toUpperCase()] || '', runway: m[2] };
        }

        return null;
    }

    _searchProcedures({ icao, procType, runway }) {
        if (!this._approachCharts?._cifpBundle) return [];
        const bundle = this._approachCharts._cifpBundle[icao.toUpperCase()];
        if (!bundle?.procedures) return [];

        const rwNum = runway.replace(/[LRC]$/i, '').padStart(2, '0');
        const rwSuffix = runway.match(/[LRC]$/i)?.[0]?.toUpperCase() || '';

        const procs = bundle.procedures.map(p => ({
            proc_name: p.name || p.proc_name || '',
            proc_type: p.proc_type || 'APPROACH',
            transitions: p.transitions || [],
        }));

        const matches = procs.filter(p => {
            const pn = p.proc_name.toUpperCase();
            const hasRwy = pn.includes(rwNum) || pn.includes(parseInt(rwNum, 10).toString());
            const hasType = !procType || pn.includes(procType.toUpperCase());
            const hasSuffix = !rwSuffix || pn.includes(rwSuffix);
            return hasRwy && hasType && hasSuffix;
        });

        return matches.slice(0, 5).map(p => ({
            entity: { icao: icao.toUpperCase(), proc_name: p.proc_name, transitions: p.transitions, lat: null, lon: null },
            type: 'PROC',
            score: -1,
        }));
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    _renderResults(rows, query) {
        const list = this._resultsList;
        list.innerHTML = '';

        if (!rows.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:32px 16px;text-align:center;color:var(--text-label);font-size:16px;font-weight:600;';
            empty.textContent = 'No results for "' + query + '"';
            list.appendChild(empty);
            return;
        }

        for (const row of rows) {
            list.appendChild(this._buildRow(row));
        }
    }

    _renderRecents() {
        const recents = this._loadRecent();
        const list = this._resultsList;
        list.innerHTML = '';

        if (!recents.length) {
            const hint = document.createElement('div');
            hint.style.cssText = 'padding:32px 16px;text-align:center;color:var(--text-label);font-size:15px;font-weight:600;';
            hint.textContent = 'Search airports, navaids, fixes, airways, or procedures';
            list.appendChild(hint);
            return;
        }

        const hdr = document.createElement('div');
        hdr.style.cssText = 'padding:8px 16px 4px;font-size:12px;font-weight:700;color:var(--text-label);letter-spacing:0.08em;';
        hdr.textContent = 'RECENT';
        list.appendChild(hdr);

        const ownPos = this._getOwnPos();
        for (const r of recents) {
            const row = r.type === 'PROC'
                ? { entity: r, type: 'PROC', score: 0 }
                : { entity: r, type: r.type || 'APT', score: 0 };
            if (ownPos && r.lat != null) {
                row._dist = this._distNm(ownPos.lat, ownPos.lon, r.lat, r.lon);
            }
            list.appendChild(this._buildRow(row));
        }
    }

    _buildRow({ entity, type, score, _dist }) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-direction:column;padding:10px 14px;border-bottom:1px solid var(--border-light);gap:4px;min-height:64px;justify-content:center;cursor:pointer;';

        // Top line: badge + identifier + name
        const topLine = document.createElement('div');
        topLine.style.cssText = 'display:flex;align-items:center;gap:8px;';

        const badge = document.createElement('span');
        badge.textContent = type;
        badge.style.cssText = 'font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--accent);color:var(--text-on-accent);letter-spacing:0.06em;flex-shrink:0;';

        const ident = document.createElement('span');
        ident.textContent = entity.icao || entity.id || entity.name || entity.proc_name || '';
        ident.style.cssText = 'font-size:18px;font-weight:700;color:var(--text-primary);';

        const name = document.createElement('span');
        name.textContent = type === 'PROC' ? entity.proc_name : (entity.name || '');
        name.style.cssText = 'font-size:14px;font-weight:600;color:var(--text-secondary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

        topLine.appendChild(badge);
        topLine.appendChild(ident);
        if (name.textContent && name.textContent !== ident.textContent) topLine.appendChild(name);
        row.appendChild(topLine);

        // Bottom line: city/state + distance + action buttons
        const bottomLine = document.createElement('div');
        bottomLine.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

        if (entity.city) {
            const city = document.createElement('span');
            city.textContent = entity.city + (entity.state ? ', ' + entity.state : '');
            city.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-label);flex:1;';
            bottomLine.appendChild(city);
        }

        const ownPosForDist = this._getOwnPos();
        const distVal = _dist != null ? _dist : (entity.lat != null && ownPosForDist ? this._distNm(ownPosForDist.lat, ownPosForDist.lon, entity.lat, entity.lon) : null);
        if (distVal != null) {
            const dist = document.createElement('span');
            dist.textContent = Math.round(distVal) + ' nm';
            dist.style.cssText = 'font-size:13px;font-weight:700;color:var(--text-label);';
            bottomLine.appendChild(dist);
        }

        // Action buttons
        const actions = this._buildActions(entity, type);
        for (const btn of actions) bottomLine.appendChild(btn);

        row.appendChild(bottomLine);

        // Scroll-safe tap on the row itself (fallback for simple tap)
        this._scrollSafeTap(row, () => {
            if (actions.length === 1) actions[0].click();
        });

        return row;
    }

    _buildActions(entity, type) {
        if (type === 'PROC') {
            return [this._makeActionBtn('LOAD', () => {
                this._saveRecent({ ...entity, type: 'PROC' });
                this.hide();
                if (this._approachCharts) {
                    this._approachCharts.showForAirport(entity.icao);
                }
            })];
        }

        const routeActive = this._isRouteActive();
        const wp = {
            icao: entity.icao || entity.id,
            id:   entity.icao || entity.id,
            lat:  entity.lat,
            lon:  entity.lon,
            name: entity.name || entity.id || entity.icao,
            type: type,
        };

        const buttons = [];

        if (type === 'AWY') {
            buttons.push(this._makeActionBtn('SHOW ON MAP', () => {
                this._saveRecent({ ...entity, type });
                this.hide();
                this._showOnMap(entity);
            }));
        } else if (routeActive) {
            buttons.push(this._makeActionBtn('ADD', () => {
                this._saveRecent({ ...entity, type });
                this.hide();
                if (this._routeTable) this._routeTable.addWaypointSmart(wp);
            }));
            buttons.push(this._makeActionBtn('DIRECT', () => {
                this._saveRecent({ ...entity, type });
                this.hide();
                if (this._routeEditor) this._routeEditor._executeDirectTo(entity);
            }));
        } else {
            buttons.push(this._makeActionBtn('SHOW', () => {
                this._saveRecent({ ...entity, type });
                this.hide();
                this._showOnMap(entity, type);
            }));
        }

        return buttons;
    }

    _makeActionBtn(label, handler) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = 'font-size:13px;font-weight:700;padding:6px 12px;min-height:44px;border-radius:6px;border:2px solid var(--accent);background:transparent;color:var(--accent);letter-spacing:0.05em;cursor:pointer;flex-shrink:0;';
        this._fastTap(btn, handler);
        return btn;
    }

    _showOnMap(entity, type) {
        if (!this._cockpitMap?.map) return;
        if (entity.lat == null) return;

        this._cockpitMap.map.setView([entity.lat, entity.lon], 11);

        if ((type === 'APT') && this._airportPopup) {
            setTimeout(() => this._airportPopup.show(entity), 300);
        } else if ((type === 'NAV') && this._airportPopup?.showNavaid) {
            setTimeout(() => this._airportPopup.showNavaid(entity), 300);
        }
    }

    // ── Recent searches ──────────────────────────────────────────────────────

    _loadRecent() {
        try { return JSON.parse(localStorage.getItem(this._RECENT_KEY) || '[]'); }
        catch { return []; }
    }

    _saveRecent(result) {
        const key = result.icao || result.id || result.name || result.proc_name;
        const recents = this._loadRecent().filter(r => (r.icao || r.id || r.name || r.proc_name) !== key);
        recents.unshift(result);
        try { localStorage.setItem(this._RECENT_KEY, JSON.stringify(recents.slice(0, this._RECENT_MAX))); }
        catch {}
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    _isRouteActive() {
        if (this._getActiveTrip) {
            const trip = this._getActiveTrip();
            return !!(trip?.waypoints?.length >= 2);
        }
        return false;
    }

    _fastTap(btn, handler) {
        let fired = false;
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            fired = true;
            handler(e);
        }, { passive: false });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (fired) { fired = false; return; }
            handler(e);
        });
    }

    _scrollSafeTap(el, handler) {
        let startY = null;
        let touchHandled = false;
        el.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            touchHandled = false;
        }, { passive: true });
        el.addEventListener('touchend', (e) => {
            if (startY === null) return;
            const dy = Math.abs(e.changedTouches[0].clientY - startY);
            startY = null;
            if (dy < 8) { touchHandled = true; handler(e); }
        }, { passive: true });
        el.addEventListener('click', (e) => {
            if (touchHandled) { touchHandled = false; return; }
            handler(e);
        });
    }
}
