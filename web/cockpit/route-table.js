/**
 * FlyPi — Route Table (Bottom Sheet)
 * Collapsible bottom sheet showing enroute nav data with live updates.
 * Includes inline edit mode: delete, reorder, and smart waypoint insertion.
 */

class RouteTable {
    constructor(container, map) {
        this._container = container;
        this._map = map;
        this._waypoints = [];
        this._activeIndex = -1;
        this._expanded = false;
        this._dragging = false;
        this._editMode = false;

        this._el = null;
        this._handleEl = null;
        this._bodyEl = null;
        this._tableEl = null;
        this._searchRowEl = null;
        this._searchInput = null;
        this._resultsEl = null;

        this._lastSituation = null;
        this._routeEditor = null; // for Direct-To modal
        this._nasrDb = null;
        this._undoStack = [];
        this._searchDebounce = null;
        this._onRouteChanged = null; // callback when route is edited
        this._cruisePower = null; // user-selected cruise power override (%)
        this._powerPresets = [55, 65, 75]; // cycle through these
        this._flightRules = Settings.get('flight_rules') ?? 'VFR'; // VFR or IFR
        this._emitting = false; // re-entrancy guard for _emitRouteChange

        this._buildDOM();
    }

    /** Wire up route editor so Direct-To still works */
    setRouteEditor(editor) {
        this._routeEditor = editor;
    }

    /** Wire EngineMLBridge so the status card stays in sync */
    setEngineML(engineML) {
        this._engineML = engineML;
        if (!engineML) return;
        this._onEngineMLResult = (e) => this._updateEngineStatusCard(e.detail);
        document.addEventListener('engineml:result', this._onEngineMLResult);
    }

    /** Set NasrDB reference for search */
    setNasrDb(db) {
        this._nasrDb = db;
    }

    /** Set callback for when route is edited */
    onRouteChanged(callback) {
        this._onRouteChanged = callback;
    }

    /** Recompute and re-render (e.g. after fuel source change) */
    refresh() {
        const gs = this._lastSituation?.ground_speed || 0;
        this._computeEnroute(gs);
        this._updateSummary();
        this._renderTable();
    }

    /** Set FIS-B client for winds aloft updates */
    setFisbClient(fisbClient) {
        // Remove old listener if switching clients
        if (this._fisbClient && this._fisbWindsHandler) {
            this._fisbClient.removeEventListener('fisb:winds', this._fisbWindsHandler);
        }
        this._fisbClient = fisbClient;
        if (fisbClient) {
            this._fisbWindsHandler = () => this._applyFisbWinds();
            fisbClient.addEventListener('fisb:winds', this._fisbWindsHandler);
        }
    }

    /** Apply FIS-B winds aloft to waypoints if fresher than plan data */
    _applyFisbWinds() {
        if (!this._fisbClient || this._waypoints.length === 0) return;
        let changed = false;

        for (let i = 1; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            if (!wp.lat || !wp.lon) continue;
            const alt = wp.alt || 5000;
            const fisbWind = this._fisbClient.getNearestWind(wp.lat, wp.lon, alt);
            if (fisbWind && fisbWind.dir != null && fisbWind.spd != null) {
                // Override if no plan wind, or existing wind was already from FIS-B (safe to update)
                const planWind = wp.wind;
                if (!planWind || planWind._fisbApplied) {
                    wp.wind = { dir: fisbWind.dir, spd: fisbWind.spd, _fisbApplied: true };
                    wp._wind = wp.wind;
                    changed = true;
                }
            }
        }

        if (changed) {
            this._computeEnroute();
            if (!this._editMode) {
                this._renderTable();
            }
        }
    }

    /**
     * Load waypoints from a flight plan.
     */
    loadPlan(plan) {
        if (!plan || !plan.waypoints) {
            this._waypoints = [];
            this._activeIndex = -1;
            this._updateSummary();
            this._renderTable();
            return;
        }

        this._plan = plan;
        const rawLegs = plan.flight_plan?.legs || plan.legs || [];
        // Only use legs if they align with waypoints (legs.length === wps.length - 1).
        // After in-cockpit edits, the plan may have updated waypoints but stale legs
        // from the original route — using them would map wrong segments to wrong waypoints.
        const legs = rawLegs.length === plan.waypoints.length - 1 ? rawLegs : [];

        // Restore persisted cruise power override
        try {
            const saved = localStorage.getItem('flypi_cruise_power');
            if (saved) this._cruisePower = parseFloat(saved);
        } catch {}

        const planDep  = plan.flight_plan?.departure  || plan.waypoints[0]?.icao;
        const planDest = plan.flight_plan?.destination || plan.waypoints[plan.waypoints.length - 1]?.icao;

        this._waypoints = plan.waypoints.map((wp, i) => {
            // Map leg performance data onto waypoints.
            // Legs array: leg[0] is dep→wp[1], so wp[i] uses leg[i-1].
            const leg = i > 0 ? (legs[i - 1] || {}) : {};
            // Preserve ALL segments for phase-aware computation
            const segments = wp._segments || leg.segments || [];
            // Use cruise segment for default rpm/mp/pwr display
            const cruiseSeg = segments.find(s => s.phase === 'CRZ')
                           || segments[segments.length - 1]
                           || {};
            // Wind is at leg level as windDir/windSpd
            const wind = (leg.windDir != null && leg.windSpd != null)
                ? { dir: leg.windDir, spd: leg.windSpd } : (wp.wind || null);

            // Departure/destination: use field elevation, not cruise altitude
            let wpAlt = wp.alt;
            if (i === 0) {
                // Departure has no inbound leg — look at the first outbound leg for CLB altFrom
                const depSegs = legs[0]?.segments || [];
                const clbSeg = depSegs.find(s => s.phase === 'CLB');
                wpAlt = wp.elev_ft ?? clbSeg?.altFrom ?? null;
            } else if (i === plan.waypoints.length - 1) {
                // Destination: show user-set cruise altitude, not field elevation
                const desSeg = segments.find(s => s.phase === 'DES');
                wpAlt = wp.alt || desSeg?.altFrom || wp.elev_ft || null;
            }

            const isApt = wp.type === 'APT' || wp.icao === planDep || wp.icao === planDest;
            return {
                ...wp,
                type: isApt ? 'APT' : (wp.type || undefined),
                alt: wpAlt,
                index: i,
                active: false,
                passed: false,
                wind,
                _segments: segments,
                percent_power: wp.percent_power ?? cruiseSeg.percent_power ?? null,
                rpm: wp.rpm ?? cruiseSeg.rpm ?? null,
                mp: wp.mp ?? cruiseSeg.mp ?? null,
                tas: wp.tas ?? leg.tas ?? null,
                gs: wp.gs ?? leg.gs ?? null,
                gph: wp.gph ?? cruiseSeg.gph ?? leg.gph ?? null,
            };
        });

        // Pre-compute leg distances between consecutive waypoints
        for (let i = 1; i < this._waypoints.length; i++) {
            const prev = this._waypoints[i - 1];
            const wp = this._waypoints[i];
            if (prev.lat != null && prev.lon != null && wp.lat != null && wp.lon != null) {
                wp._legDist = NasrDB.haversineNm(prev.lat, prev.lon, wp.lat, wp.lon);
            } else {
                wp._legDist = 0;
            }
        }

        // Generate segments for waypoints that don't already have them
        this._buildMissingSegments();

        this._activeIndex = 0;
        if (this._waypoints.length > 0) this._waypoints[0].active = true;

        this._computeEnroute();
        this._updateSummary();
        this._renderTable();
    }

    /**
     * Update live data (GS, position) from Stratux situation.
     */
    updateLive(situation) {
        if (!situation || this._waypoints.length === 0) return;
        this._lastSituation = situation;

        const lat = situation.lat;
        const lon = situation.lon;
        const gs = situation.ground_speed || 0;

        // Check waypoint proximity — advance if within 1nm
        if (this._activeIndex >= 0 && this._activeIndex < this._waypoints.length) {
            const wp = this._waypoints[this._activeIndex];
            if (wp.lat && wp.lon && lat && lon) {
                const dist = NasrDB.haversineNm(lat, lon, wp.lat, wp.lon);
                if (dist < 1.0 && this._activeIndex < this._waypoints.length - 1) {
                    this._advanceWaypoint();
                }
            }
        }

        // Compute live nav data for active leg
        const active = this._waypoints[this._activeIndex];
        if (active && active.lat && active.lon && lat && lon) {
            active._liveDist = NasrDB.haversineNm(lat, lon, active.lat, active.lon);
            active._liveHdg = this._bearing(lat, lon, active.lat, active.lon);
        }

        // Recompute all enroute data with current GS
        this._computeEnroute(gs);
        this._updateSummary();
        // Skip full DOM rebuild while editing — live updates would destroy
        // the edit-mode button event listeners mid-interaction (issue #30)
        if (!this._editMode) {
            this._renderTable();
        }
    }

    /**
     * Smart waypoint insertion: add a waypoint at the optimal position.
     * Calculates minimum route deviation for each existing leg.
     */
    addWaypointSmart(wp) {
        if (this._waypoints.length < 2) {
            // Less than 2 waypoints: just append
            this._pushUndo();
            this._waypoints.push(wp);
            this._reindex();
            this._onEdited();
            return;
        }

        // For each leg A→B, compute detour: dist(A,NEW) + dist(NEW,B) - dist(A,B)
        let bestIdx = this._waypoints.length; // default: append
        let bestDetour = Infinity;

        for (let i = 0; i < this._waypoints.length - 1; i++) {
            const a = this._waypoints[i];
            const b = this._waypoints[i + 1];
            if (!a.lat || !a.lon || !b.lat || !b.lon) continue;

            const directDist = NasrDB.haversineNm(a.lat, a.lon, b.lat, b.lon);
            const viaNew = NasrDB.haversineNm(a.lat, a.lon, wp.lat, wp.lon)
                         + NasrDB.haversineNm(wp.lat, wp.lon, b.lat, b.lon);
            const detour = viaNew - directDist;

            if (detour < bestDetour) {
                bestDetour = detour;
                bestIdx = i + 1; // insert after waypoint i
            }
        }

        this._pushUndo();
        this._waypoints.splice(bestIdx, 0, wp);
        this._reindex();
        this._onEdited();

        // Flash feedback
        if (typeof app !== 'undefined') {
            const id = wp.icao || wp.name || '?';
            const toast = app.showToast(`Added ${id} at position ${bestIdx + 1}`);
            setTimeout(() => toast?.remove(), 3000);
        }
    }

    /** Whether edit mode is active */
    isEditing() {
        return this._editMode;
    }

    // ========== Edit Mode ==========

    _toggleEditMode() {
        this._editMode = !this._editMode;
        this._el.classList.toggle('route-table-editing', this._editMode);

        if (this._editMode) {
            // Auto-expand when entering edit mode
            if (!this._expanded) this.toggle();
            this._searchRowEl.hidden = false;
        } else {
            this._searchRowEl.hidden = true;
            this._clearSearch();
            this._hideAltPicker();
        }
        this._updateSummary();
        this._renderTable();
    }

    _pushUndo() {
        this._undoStack.push(JSON.parse(JSON.stringify(this._waypoints)));
        if (this._undoStack.length > 5) this._undoStack.shift();
    }

    _popUndo() {
        if (this._undoStack.length === 0) return;
        this._waypoints = this._undoStack.pop();
        this._reindex();
        this._onEdited();
    }

    _removeWaypoint(index) {
        if (index < 0 || index >= this._waypoints.length) return;
        this._pushUndo();
        this._waypoints.splice(index, 1);
        this._reindex();
        this._onEdited();
    }

    _setWaypointAlt(index, alt) {
        if (index < 0 || index >= this._waypoints.length) return;
        this._pushUndo();
        this._waypoints[index].alt = alt;
        this._waypoints[index].altitude = alt;
        this._onEdited();
    }

    _showAltPicker(wpIndex, anchorEl) {
        if (wpIndex < 0 || wpIndex >= this._waypoints.length) {
            this._hideAltPicker();
            return;
        }
        const wp = this._waypoints[wpIndex];
        if (!wp) return;
        const currentAlt = wp.alt ?? wp.altitude ?? 0;

        // Determine heading to pick E/W hemisphere altitude rules
        // 0-179° = eastbound (odd thousands), 180-359° = westbound (even)
        const hdg = wp._hdg ?? 0;
        const isEast = hdg >= 0 && hdg < 180;
        const isVfr = this._flightRules === 'VFR';
        const vfrOffset = isVfr ? 500 : 0;

        // Build altitude presets: 5 altitudes for the heading + rules combo
        const alts = [];
        for (let a = isEast ? 3000 : 2000; a <= 12000; a += 2000) {
            alts.push(a + vfrOffset);
        }

        const dir = isEast ? 'E odd' : 'W even';
        let html = `<div class="rt-alt-picker-header">${this._flightRules} · ${dir} · ${Math.round(hdg)}\u00b0</div>`;
        html += '<div class="rt-alt-picker-row">';
        for (const alt of alts) {
            const sel = alt === currentAlt ? ' rt-alt-selected' : '';
            const label = isVfr ? (alt / 1000).toFixed(1) : (alt / 1000).toFixed(0);
            html += `<button class="rt-alt-option${sel}" data-alt="${alt}">${label}</button>`;
        }
        html += '</div>';
        html += `<div class="rt-alt-custom">
            <input type="number" class="rt-alt-input" value="${currentAlt || ''}" placeholder="Custom" step="500" min="0" max="45000">
            <button class="rt-alt-set-btn">SET</button>
        </div>`;

        this._altPicker.innerHTML = html;
        this._altPicker.hidden = false;
        this._altPickerIndex = wpIndex;

        // Position: prefer below anchor, flip above if it would go off screen
        const rect = anchorEl.getBoundingClientRect();
        const containerRect = this._container.getBoundingClientRect();
        const pickerH = 120; // compact height
        const spaceBelow = containerRect.bottom - rect.bottom;
        if (spaceBelow < pickerH) {
            this._altPicker.style.top = '';
            this._altPicker.style.bottom = (containerRect.bottom - rect.top + 4) + 'px';
        } else {
            this._altPicker.style.bottom = '';
            this._altPicker.style.top = (rect.bottom - containerRect.top + 4) + 'px';
        }
        this._altPicker.style.left = Math.max(0, rect.left - containerRect.left - 40) + 'px';

        // Wire Enter key on custom input (delegation handles click on SET/presets)
        const input = this._altPicker.querySelector('.rt-alt-input');
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = parseInt(input.value);
                    if (!isNaN(val) && val > 0) {
                        this._setWaypointAlt(this._altPickerIndex, val);
                        this._hideAltPicker();
                    }
                }
            });
        }
    }

    _hideAltPicker() {
        this._altPicker.hidden = true;
        this._altPickerIndex = -1;
    }

    _moveWaypoint(fromIdx, toIdx) {
        if (fromIdx === toIdx) return;
        if (toIdx < 0 || toIdx >= this._waypoints.length) return;
        this._pushUndo();
        const [wp] = this._waypoints.splice(fromIdx, 1);
        this._waypoints.splice(toIdx, 0, wp);
        this._reindex();
        this._onEdited();
    }

    _reindex() {
        for (let i = 0; i < this._waypoints.length; i++) {
            this._waypoints[i].index = i;
        }
        // Recompute leg distances
        for (let i = 1; i < this._waypoints.length; i++) {
            const prev = this._waypoints[i - 1];
            const wp = this._waypoints[i];
            if (prev.lat != null && prev.lon != null && wp.lat != null && wp.lon != null) {
                wp._legDist = NasrDB.haversineNm(prev.lat, prev.lon, wp.lat, wp.lon);
            } else {
                wp._legDist = 0;
            }
        }
        if (this._waypoints.length > 0 && this._waypoints[0]) {
            this._waypoints[0]._legDist = 0;
        }
    }

    /** Called after any edit — recompute, re-render, notify parent */
    _onEdited() {
        // Clear all segments and rebuild — leg distances changed so old
        // plan segments (CLB/CRZ/DES splits) are no longer valid.
        for (let i = 1; i < this._waypoints.length; i++) {
            this._waypoints[i]._segments = [];
        }
        this._buildMissingSegments();
        this._computeEnroute();
        this._updateSummary();
        this._renderTable();
        this._emitRouteChange();
    }

    _emitRouteChange() {
        if (!this._onRouteChanged) return;
        if (this._emitting) return;
        this._emitting = true;
        const plan = {
            ...(this._plan || {}),
            waypoints: this._waypoints.map(wp => ({
                icao: wp.icao,
                name: wp.name,
                lat: wp.lat,
                lon: wp.lon,
                alt: wp.alt ?? wp.altitude,
            })),
            flight_plan: {
                ...(this._plan?.flight_plan || {}),
                departure: this._waypoints[0]?.icao || '',
                destination: this._waypoints[this._waypoints.length - 1]?.icao || '',
                // Clear stale legs — they were for the original route, not the edited one
                legs: [],
                route: this._waypoints.map(wp => wp.icao).filter(Boolean),
            },
        };
        try {
            this._onRouteChanged(plan);
        } finally {
            this._emitting = false;
        }
    }

    // ========== Search ==========

    _onSearchInput() {
        clearTimeout(this._searchDebounce);
        const q = this._searchInput.value.trim();
        if (q.length < 2) {
            this._resultsEl.hidden = true;
            this._resultsEl.innerHTML = '';
            return;
        }
        // Route string mode: space-separated tokens (e.g. "KLKR V54 GSP KMEB")
        if (q.includes(' ')) {
            clearTimeout(this._searchDebounce);
            this._parseRouteString(q);
            return;
        }
        this._searchDebounce = setTimeout(() => this._doSearch(q), 200);
    }

    _isAirwayToken(token) {
        if (/^[VJTQ]\d+[A-Z]?$/i.test(token)) return true;
        const SKIP = new Set(['DCT', 'DIRECT', 'IFR', 'VFR', 'SID', 'STAR']);
        return SKIP.has(token.toUpperCase());
    }

    _dbLookup(promise) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('idb timeout')), 2000)),
        ]);
    }

    async _resolveToken(token) {
        const t = token.toUpperCase();
        try {
            // 1. Exact 4-char ICAO airport (KLKR, KMEB — user typed full ICAO)
            if (t.length >= 4) {
                const apt = await this._dbLookup(this._nasrDb.getAirport(t));
                if (apt) return { icao: apt.icao, name: apt.name, lat: apt.lat, lon: apt.lon, type: 'APT' };
            }
        } catch {}
        try {
            // 2. Navaid before K-prefix — 3-char tokens like SAV/ORF are VORTACs in route strings
            const nav = await this._dbLookup(this._nasrDb.getNavaid(t));
            if (nav) return { icao: nav.id, name: nav.name, lat: nav.lat, lon: nav.lon, type: nav.type || 'VOR' };
        } catch {}
        try {
            // 3. Fix
            const fix = await this._dbLookup(this._nasrDb.getFix(t));
            if (fix) return { icao: fix.id, name: fix.id, lat: fix.lat, lon: fix.lon, type: 'FIX' };
        } catch {}
        try {
            // 4. K-prefixed airport fallback (LKR → KLKR, MMT → KMMT)
            if (t.length <= 3 && !t.startsWith('K')) {
                const apt = await this._dbLookup(this._nasrDb.getAirport('K' + t));
                if (apt) return { icao: apt.icao, name: apt.name, lat: apt.lat, lon: apt.lon, type: 'APT' };
            }
        } catch {}
        try {
            // 5. Exact airport last resort
            const apt = await this._dbLookup(this._nasrDb.getAirport(t));
            if (apt) return { icao: apt.icao, name: apt.name, lat: apt.lat, lon: apt.lon, type: 'APT' };
        } catch {}
        return null;
    }

    async _parseRouteString(str) {
        const tokens = str.trim().split(/\s+/);
        this._resultsEl.hidden = false;
        this._resultsEl.innerHTML = '<div class="route-search-empty">Parsing route...</div>';

        const wayTokens = tokens.map(t => this._isAirwayToken(t) ? null : t.toUpperCase());

        const doResolve = async () => {
            const results = await Promise.all(
                wayTokens.map(t => t ? this._resolveToken(t) : Promise.resolve(null))
            );
            const resolved = [], unresolved = [];
            for (let i = 0; i < tokens.length; i++) {
                if (wayTokens[i] === null) continue;
                if (results[i]) resolved.push(results[i]);
                else unresolved.push(tokens[i].toUpperCase());
            }
            return { resolved, unresolved };
        };

        let { resolved, unresolved } = await doResolve();

        if (resolved.length === 0 && unresolved.length > 0) {
            this._resultsEl.innerHTML = '<div class="route-search-empty">Retrying...</div>';
            await new Promise(r => setTimeout(r, 1500));
            ({ resolved, unresolved } = await doResolve());
        }

        const chips = resolved.map(wp =>
            `<span class="route-token-ok">${wp.icao}</span>`
        ).join('<span class="route-token-arrow">→</span>');

        const warnHtml = unresolved.length > 0
            ? `<div class="route-token-warn">Not found: ${unresolved.map(t => `<span class="route-token-bad">${t}</span>`).join(' ')}</div>`
            : '';

        this._resultsEl.innerHTML = `
            <div class="route-parse-preview">
                <div class="route-parse-chips">${chips || '<span class="route-search-empty">Nothing resolved</span>'}</div>
                ${warnHtml}
                ${resolved.length > 0 ? `<button class="btn btn-primary route-parse-apply">LOAD ${resolved.length} WAYPOINTS</button>` : ''}
            </div>
        `;

        const applyBtn = this._resultsEl.querySelector('.route-parse-apply');
        if (applyBtn) {
            applyBtn.addEventListener('click', () => {
                this._pushUndo();
                this._waypoints = resolved.map(wp => ({ ...wp, alt: wp.alt || 3500 }));
                this._reindex();
                this._onEdited();
                this._clearSearch();
            });
        }
    }

    async _doSearch(query) {
        if (!this._nasrDb) return;
        try {
            const results = await this._nasrDb.searchAll(query);
            this._renderSearchResults(results.airports || [], results.navaids || [], results.fixes || [], query);
        } catch (err) {
            console.warn('[RouteTable] Search error:', err);
        }
    }

    _renderSearchResults(airports, navaids, fixes, query = '') {
        const q = query.toUpperCase();
        const sit = this._lastSituation;
        const results = [];

        for (const a of airports) {
            const dist = sit?.lat ? NasrDB.haversineNm(sit.lat, sit.lon, a.lat, a.lon) : null;
            results.push({ type: 'APT', id: a.icao, name: a.name, lat: a.lat, lon: a.lon, dist });
        }
        for (const n of navaids) {
            const dist = sit?.lat ? NasrDB.haversineNm(sit.lat, sit.lon, n.lat, n.lon) : null;
            results.push({ type: n.type || 'NAV', id: n.id, name: n.name, lat: n.lat, lon: n.lon, dist });
        }
        for (const f of fixes) {
            const dist = sit?.lat ? NasrDB.haversineNm(sit.lat, sit.lon, f.lat, f.lon) : null;
            results.push({ type: 'FIX', id: f.id, name: '', lat: f.lat, lon: f.lon, dist });
        }

        // Sort: ID matches first (airports → navaids → fixes), then name matches
        const isIdMatch = r => r.id.startsWith(q) || r.id === 'K' + q || r.id.startsWith('K' + q);
        const typeRank = r => r.type === 'APT' ? 0 : r.type === 'FIX' ? 2 : 1;
        results.sort((a, b) => {
            const aId = isIdMatch(a) ? 0 : 1;
            const bId = isIdMatch(b) ? 0 : 1;
            if (aId !== bId) return aId - bId;
            const aExact = (a.id === q || a.id === 'K' + q) ? 0 : 1;
            const bExact = (b.id === q || b.id === 'K' + q) ? 0 : 1;
            if (aExact !== bExact) return aExact - bExact;
            const tDiff = typeRank(a) - typeRank(b);
            if (tDiff !== 0) return tDiff;
            if (a.dist != null && b.dist != null) return a.dist - b.dist;
            return 0;
        });

        const limited = results.slice(0, 15);
        this._resultsEl.hidden = limited.length === 0;
        this._resultsEl.innerHTML = limited.map(r => `
            <button class="route-search-result" data-lat="${r.lat}" data-lon="${r.lon}" data-id="${r.id}" data-name="${r.name || r.id}" data-type="${r.type}">
                <span class="result-type">${r.type}</span>
                <span class="result-id">${r.id}</span>
                <span class="result-name">${r.name || ''}</span>
                <span class="result-dist">${r.dist != null ? r.dist.toFixed(0) + 'nm' : ''}</span>
            </button>
        `).join('');

        this._resultsEl.querySelectorAll('.route-search-result').forEach(btn => {
            btn.addEventListener('click', () => {
                const wp = {
                    icao: btn.dataset.id,
                    name: btn.dataset.name || btn.dataset.id,
                    lat: parseFloat(btn.dataset.lat),
                    lon: parseFloat(btn.dataset.lon),
                    type: btn.dataset.type || undefined,
                };
                this.addWaypointSmart(wp);
                this._clearSearch();
            });
        });
    }

    _clearSearch() {
        if (this._searchInput) this._searchInput.value = '';
        if (this._resultsEl) {
            this._resultsEl.hidden = true;
            this._resultsEl.innerHTML = '';
        }
    }

    // ========== Segment Generation ==========

    /**
     * Build CLB/CRZ/DES segments for waypoints that don't already have them.
     * Uses departure/destination elevation, cruise altitude, and aircraft performance config.
     * This allows plans without pre-computed legs (e.g. saved from cockpit) to show multi-segment rows.
     */
    _buildMissingSegments() {
        // Skip if all waypoints with index > 0 already have segments
        const needsSegments = this._waypoints.some((wp, i) => i > 0 && (!wp._segments || wp._segments.length === 0));
        if (!needsSegments) return;

        const cruiseAlt = this._plan?.cruise_altitude
            || this._plan?.flight_plan?.altitude
            || this._plan?.flight_plan?.cruise_altitude
            || null;

        const cfgCruiseSpeed = CockpitConfig.aircraft('performance.cruise_speed_kt') ?? 120;
        const cfgGph = CockpitConfig.aircraft('performance.cruise_gph') ?? 9.0;
        const cfgCruiseRpm = CockpitConfig.aircraft('performance.cruise_rpm') ?? null;
        const cfgCruiseMp = CockpitConfig.aircraft('performance.cruise_mp') ?? null;
        const cfgCruisePwr = CockpitConfig.aircraft('performance.cruise_pwr_pct') ?? null;
        const climbRate = CockpitConfig.aircraft('performance.climb_fpm') ?? 500;
        const descentRate = CockpitConfig.aircraft('performance.descent_fpm') ?? 500;
        const climbSpeed = CockpitConfig.aircraft('performance.climb_speed_kt') ?? cfgCruiseSpeed * 0.85;
        const climbGph = CockpitConfig.aircraft('performance.climb_gph') ?? cfgGph * 1.3;
        const climbRpm = CockpitConfig.aircraft('performance.climb_rpm') ?? cfgCruiseRpm;
        const climbMp = CockpitConfig.aircraft('performance.climb_mp') ?? cfgCruiseMp;
        const climbPwr = CockpitConfig.aircraft('performance.climb_pwr_pct') ?? 100;
        const descentSpeed = CockpitConfig.aircraft('performance.descent_speed_kt') ?? cfgCruiseSpeed;
        const descentGph = CockpitConfig.aircraft('performance.descent_gph') ?? cfgGph * 0.6;
        const descentRpm = CockpitConfig.aircraft('performance.descent_rpm') ?? cfgCruiseRpm;
        const descentMp = CockpitConfig.aircraft('performance.descent_mp') ?? cfgCruiseMp;
        const descentPwr = CockpitConfig.aircraft('performance.descent_pwr_pct') ?? 50;

        // Use departure waypoint's alt or elev_ft as starting altitude
        let prevAlt = this._waypoints[0]?.elev_ft ?? this._waypoints[0]?.alt ?? 0;

        for (let i = 1; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            if (wp._segments && wp._segments.length > 0) {
                // Already has segments from plan data
                prevAlt = wp._segments[wp._segments.length - 1].altTo ?? prevAlt;
                continue;
            }

            const isLast = i === this._waypoints.length - 1;
            const legDist = wp._legDist || 0;
            // For the last waypoint (destination): cruise altitude is wp.alt or cruiseAlt,
            // field elevation (elev_ft) is the descent target — handled by deferred descent below.
            // For intermediate waypoints: use wp.alt (user-set) or cruiseAlt.
            const wpAlt = isLast
                ? (wp.alt || cruiseAlt || wp.elev_ft || prevAlt)
                : (wp.alt || cruiseAlt || prevAlt);
            const segments = [];
            let remainingDist = legDist;

            // Altitude difference between previous waypoint and this one
            const altDiff = wpAlt - prevAlt;

            // Climb segment: if we need to go up
            if (altDiff > 0) {
                const climbTimeMin = altDiff / climbRate;
                const climbDist = Math.min((climbSpeed / 60) * climbTimeMin, remainingDist);
                const actualTime = climbDist > 0 ? climbTimeMin * (climbDist / ((climbSpeed / 60) * climbTimeMin)) : 0;
                const cFuel = (climbGph / 60) * actualTime;
                segments.push({
                    phase: 'CLB', altFrom: prevAlt, altTo: wpAlt,
                    dist: parseFloat(climbDist.toFixed(1)),
                    tas: Math.round(climbSpeed), gs: Math.round(climbSpeed),
                    ete_min: actualTime, gph: parseFloat(climbGph.toFixed(1)),
                    fuel: parseFloat(cFuel.toFixed(1)),
                    fuelRemaining: 0,
                    percent_power: climbPwr, rpm: climbRpm, mp: climbMp,
                });
                remainingDist -= climbDist;
            }

            // Descent segment: if we need to go down
            let deferredDescent = null;
            if (altDiff < 0) {
                const drop = Math.abs(altDiff);
                const dMin = drop / descentRate;
                const dDist = Math.min((descentSpeed / 60) * dMin, remainingDist);
                const actualTime = dDist > 0 ? dMin * (dDist / ((descentSpeed / 60) * dMin)) : 0;
                const dFuel = (descentGph / 60) * actualTime;
                const desSeg = {
                    phase: 'DES',
                    altFrom: prevAlt,
                    altTo: wpAlt,
                    dist: parseFloat(dDist.toFixed(1)),
                    tas: Math.round(descentSpeed), gs: Math.round(descentSpeed),
                    ete_min: actualTime, gph: parseFloat(descentGph.toFixed(1)),
                    fuel: parseFloat(dFuel.toFixed(1)),
                    fuelRemaining: 0,
                    percent_power: descentPwr, rpm: descentRpm, mp: descentMp,
                };
                if (isLast) {
                    deferredDescent = desSeg;
                } else {
                    segments.push(desSeg);
                }
                remainingDist -= dDist;
            }

            // Last leg: always descend from cruise to field elevation
            if (isLast && wp.elev_ft != null && wpAlt > wp.elev_ft) {
                const drop = wpAlt - wp.elev_ft;
                const dMin = drop / descentRate;
                const dDist = Math.min((descentSpeed / 60) * dMin, remainingDist);
                const actualTime = dDist > 0 ? dMin * (dDist / ((descentSpeed / 60) * dMin)) : 0;
                const dFuel = (descentGph / 60) * actualTime;
                deferredDescent = {
                    phase: 'DES',
                    altFrom: wpAlt,
                    altTo: wp.elev_ft,
                    dist: parseFloat(dDist.toFixed(1)),
                    tas: Math.round(descentSpeed), gs: Math.round(descentSpeed),
                    ete_min: actualTime, gph: parseFloat(descentGph.toFixed(1)),
                    fuel: parseFloat(dFuel.toFixed(1)),
                    fuelRemaining: 0,
                    percent_power: descentPwr, rpm: descentRpm, mp: descentMp,
                };
                remainingDist -= dDist;
            }

            // Cruise segment (whatever distance remains)
            if (remainingDist > 0) {
                const crzAlt = deferredDescent ? Math.max(prevAlt, wpAlt) : wpAlt;
                const cruiseTime = cfgCruiseSpeed > 0 ? (remainingDist / cfgCruiseSpeed) * 60 : 0;
                const cFuel = (cfgGph / 60) * cruiseTime;
                segments.push({
                    phase: 'CRZ', altFrom: crzAlt, altTo: crzAlt,
                    dist: parseFloat(remainingDist.toFixed(1)),
                    tas: Math.round(cfgCruiseSpeed), gs: Math.round(cfgCruiseSpeed),
                    ete_min: cruiseTime, gph: parseFloat(cfgGph.toFixed(1)),
                    fuel: parseFloat(cFuel.toFixed(1)),
                    fuelRemaining: 0,
                    rpm: cfgCruiseRpm, mp: cfgCruiseMp, percent_power: cfgCruisePwr,
                });
            }

            // Append deferred descent after cruise
            if (deferredDescent) {
                segments.push(deferredDescent);
            }

            if (segments.length > 0) {
                wp._segments = segments;
            }

            prevAlt = wpAlt;
        }
    }

    // ========== Enroute Computation ==========

    /**
     * Compute enroute data for all waypoints: dist, ETE, fuel remaining.
     * Uses per-segment data (CLB/CRZ/DES) when available from flight plan.
     */
    /** Calculate manifold pressure from power%, RPM, and max RPM */
    _mpFromPower(pwr, rpm, maxRpm) {
        if (pwr == null || rpm == null || maxRpm == null) return null;
        return Math.round(((pwr / 100) * 29.92 * (maxRpm / rpm)) * 10) / 10;
    }

    _computeEnroute(gs) {
        const cfgCruiseSpeed = CockpitConfig.aircraft('performance.cruise_speed_kt') ?? 120;
        const cfgGph = CockpitConfig.aircraft('performance.cruise_gph') ?? 9.0;
        const fuelCap = CockpitConfig.aircraft('performance.fuel_capacity_gal') ?? 50;
        const startFuel = (typeof FuelState !== 'undefined')
            ? FuelState.getStartFuel().gallons : fuelCap;
        const cfgCruiseRpm = CockpitConfig.aircraft('performance.cruise_rpm') ?? null;
        const cfgCruiseMp = CockpitConfig.aircraft('performance.cruise_mp') ?? null;
        const cfgCruisePwr = CockpitConfig.aircraft('performance.cruise_pwr_pct') ?? null;
        const maxHp = CockpitConfig.aircraft('performance.max_hp') ?? 180;
        const maxRpm = CockpitConfig.aircraft('performance.max_rpm') ?? 2700;
        const lopSfc = CockpitConfig.aircraft('performance.lop_sfc') ?? 0.067;

        // Phase-specific config — hoisted out of the per-segment inner loop so
        // these are read once per _computeEnroute call, not once per segment.
        const cfgClbSpeed = CockpitConfig.aircraft('performance.climb_speed_kt') ?? cfgCruiseSpeed * 0.85;
        const cfgClbGph   = CockpitConfig.aircraft('performance.climb_gph') ?? cfgGph * 1.3;
        const cfgClbPwr   = CockpitConfig.aircraft('performance.climb_pwr_pct') ?? 100;
        const cfgClbRpm   = CockpitConfig.aircraft('performance.climb_rpm') ?? cfgCruiseRpm;
        const cfgClbMp    = CockpitConfig.aircraft('performance.climb_mp') ?? cfgCruiseMp;
        const cfgDesSpeed = CockpitConfig.aircraft('performance.descent_speed_kt') ?? cfgCruiseSpeed;
        const cfgDesGph   = CockpitConfig.aircraft('performance.descent_gph') ?? cfgGph * 0.6;
        const cfgDesPwr   = CockpitConfig.aircraft('performance.descent_pwr_pct') ?? 50;
        const cfgDesRpm   = CockpitConfig.aircraft('performance.descent_rpm') ?? cfgCruiseRpm;
        const cfgDesMp    = CockpitConfig.aircraft('performance.descent_mp') ?? cfgCruiseMp;

        // Cruise power override from user selection
        const cruisePwrOverride = this._cruisePower;

        let cumulativeDistRemaining = 0;

        // First pass: sum total remaining distance from active waypoint
        for (let i = this._activeIndex; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            if (i === this._activeIndex) {
                cumulativeDistRemaining += wp._liveDist || 0;
            } else {
                cumulativeDistRemaining += wp._legDist || 0;
            }
        }

        // Second pass: compute per-waypoint values
        let fuelBurned = 0;
        for (let i = this._activeIndex; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            const segs = wp._segments || [];

            let legDist;
            if (i === this._activeIndex) {
                legDist = wp._liveDist || 0;
            } else {
                legDist = wp._legDist || 0;
            }

            // Heading
            if (i > this._activeIndex && i > 0) {
                const prev = this._waypoints[i - 1];
                if (prev.lat != null && prev.lon != null && wp.lat != null && wp.lon != null) {
                    wp._hdg = this._bearing(prev.lat, prev.lon, wp.lat, wp.lon);
                }
            } else if (i === this._activeIndex) {
                wp._hdg = wp._liveHdg;
            }

            wp._wind = wp.wind || null;

            // If we have segment data, use it for phase, fuel, and time
            if (segs.length > 0 && i > 0) {
                // Determine dominant phase: CLB > DES > CRZ
                const hasClb = segs.some(s => s.phase === 'CLB');
                const hasDes = segs.some(s => s.phase === 'DES');
                wp._phase = hasClb ? 'CLB' : hasDes ? 'DES' : 'CRZ';

                // Sum fuel and time from all segments, writing computed values back
                let segFuel = 0;
                let segTime = 0;
                let segFuelBurnedSoFar = fuelBurned; // track running total within this leg
                for (const seg of segs) {
                    // Use phase-appropriate config fallbacks (all values hoisted above the loop)
                    const isClb = seg.phase === 'CLB';
                    const isDes = seg.phase === 'DES';
                    const phaseFallbackSpeed = isClb ? cfgClbSpeed : isDes ? cfgDesSpeed : cfgCruiseSpeed;
                    const phaseFallbackGph   = isClb ? cfgClbGph   : isDes ? cfgDesGph   : cfgGph;
                    const phaseFallbackPwr   = isClb ? cfgClbPwr   : isDes ? cfgDesPwr   : cfgCruisePwr;
                    const phaseFallbackRpm   = isClb ? cfgClbRpm   : isDes ? cfgDesRpm   : cfgCruiseRpm;
                    const phaseFallbackMp    = isClb ? cfgClbMp    : isDes ? cfgDesMp    : cfgCruiseMp;

                    let segGph = seg.gph || phaseFallbackGph;
                    let segEte = seg.ete_min || 0;
                    let segTas = seg.tas || phaseFallbackSpeed;
                    let segGs = seg.gs || phaseFallbackSpeed;
                    let segPwr = seg.percent_power || phaseFallbackPwr;
                    let segRpm = seg.rpm || phaseFallbackRpm;
                    let segMp = seg.mp || phaseFallbackMp;

                    // Apply cruise power override to CRZ segments
                    if (seg.phase === 'CRZ' && cruisePwrOverride) {
                        segGph = (cruisePwrOverride / 100) * maxHp * lopSfc;
                        const origPwr = seg.percent_power || cfgCruisePwr || 65;
                        const tasRatio = Math.sqrt(cruisePwrOverride / origPwr);
                        segTas = (seg.tas || cfgCruiseSpeed) * tasRatio;
                        segGs = segTas + ((seg.gs || 0) - (seg.tas || cfgCruiseSpeed));
                        segPwr = cruisePwrOverride;
                        segRpm = cfgCruiseRpm;
                        segMp = this._mpFromPower(cruisePwrOverride, cfgCruiseRpm, maxRpm) || cfgCruiseMp;
                        if (segGs > 0 && seg.dist > 0) {
                            segEte = (seg.dist / segGs) * 60;
                        }
                    }

                    const thisSegFuel = (segGph / 60) * segEte;
                    segFuel += thisSegFuel;
                    segTime += segEte;

                    // Write computed values back to segment for _getCellValue
                    seg._fuel = thisSegFuel;
                    seg._ete = segEte;
                    seg._tas = Math.round(segTas);
                    seg._gs = Math.round(segGs);
                    seg._pwr = segPwr;
                    seg._rpm = segRpm;
                    seg._mp = segMp;
                    seg._fuelRem = startFuel - (segFuelBurnedSoFar + thisSegFuel);
                    segFuelBurnedSoFar += thisSegFuel;
                }

                fuelBurned += segFuel;

                // Display values: show the dominant segment's engine data
                const displaySeg = segs.find(s => s.phase === wp._phase)
                                || segs[segs.length - 1];

                if (wp._phase === 'CRZ' && cruisePwrOverride) {
                    wp._pwr = cruisePwrOverride;
                    wp._rpm = cfgCruiseRpm;
                    wp._mp = this._mpFromPower(cruisePwrOverride, cfgCruiseRpm, maxRpm) || cfgCruiseMp;
                    const overrideGph = (cruisePwrOverride / 100) * maxHp * lopSfc;
                    const origPwr = displaySeg.percent_power || cfgCruisePwr || 65;
                    const tasRatio = Math.sqrt(cruisePwrOverride / origPwr);
                    wp._tas = Math.round((displaySeg.tas || cfgCruiseSpeed) * tasRatio);
                    wp._gs = (wp.active && gs > 30) ? gs : Math.round(wp._tas + ((displaySeg.gs || 0) - (displaySeg.tas || cfgCruiseSpeed)));
                } else {
                    wp._pwr = displaySeg.percent_power || wp.percent_power || cfgCruisePwr;
                    wp._rpm = displaySeg.rpm || wp.rpm || cfgCruiseRpm;
                    wp._mp = displaySeg.mp || wp.mp || cfgCruiseMp;
                    wp._tas = displaySeg.tas || wp.tas || cfgCruiseSpeed;
                    wp._gs = (wp.active && gs > 30) ? gs : (displaySeg.gs || wp.gs || cfgCruiseSpeed);
                }

                wp._dist = Math.round(legDist);
                wp._ete = segTime;
                wp._fuel = segFuel;
                wp._fuelRem = startFuel - fuelBurned;
            } else if (i === 0) {
                // Departure waypoint: no leg data to compute — show starting fuel only
                wp._phase = null;
                wp._dist = null;
                wp._ete = null;
                wp._fuel = null;
                wp._fuelRem = startFuel;
                wp._tas = null;
                wp._gs = null;
                wp._rpm = null;
                wp._mp = null;
                wp._pwr = null;
            } else {
                // No segments (manually added intermediate or destination): fallback logic
                if (i === this._waypoints.length - 1) {
                    wp._phase = 'ARR';
                } else {
                    wp._phase = 'CRZ';
                }

                const fallbackGph = cruisePwrOverride
                    ? (cruisePwrOverride / 100) * maxHp * lopSfc
                    : cfgGph;
                const fallbackSpeed = gs > 30 ? gs : cfgCruiseSpeed;

                wp._tas = wp.tas || cfgCruiseSpeed;
                wp._gs = (wp.active && gs > 30) ? gs : (wp.gs || fallbackSpeed);
                wp._rpm = wp.rpm || cfgCruiseRpm;
                wp._mp = cruisePwrOverride
                    ? (this._mpFromPower(cruisePwrOverride, wp.rpm || cfgCruiseRpm, maxRpm) || cfgCruiseMp)
                    : (wp.mp || cfgCruiseMp);
                wp._pwr = cruisePwrOverride || wp.percent_power || cfgCruisePwr;

                const legSpeed = wp._gs > 0 ? wp._gs : fallbackSpeed;
                const legTimeHrs = legSpeed > 0 ? legDist / legSpeed : 0;
                const legFuel = legTimeHrs * fallbackGph;
                fuelBurned += legFuel;

                wp._dist = Math.round(legDist);
                wp._ete = legTimeHrs * 60;
                wp._fuel = legFuel;
                wp._fuelRem = startFuel - fuelBurned;
            }

            wp._distRemaining = Math.round(cumulativeDistRemaining);
            cumulativeDistRemaining -= legDist;
        }

        // Mark passed waypoints
        for (let i = 0; i < this._activeIndex; i++) {
            this._waypoints[i]._dist = null;
            this._waypoints[i]._ete = null;
            this._waypoints[i]._fuel = null;
            this._waypoints[i]._fuelRem = null;
            this._waypoints[i]._hdg = null;
            this._waypoints[i]._phase = '\u2014';
        }

        // Compute cumulative dist/ete from the aircraft's current position forward.
        // Each row shows total remaining distance/time to reach that waypoint, so all
        // rows shrink as the aircraft moves — not just the active leg.
        // Totals footer continues to sum per-leg _dist/_ete (unchanged).
        let cumDist = 0, cumEte = 0;
        for (let i = this._activeIndex; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            cumDist += wp._dist || 0;
            cumEte  += wp._ete  || 0;
            wp._cumDist = cumDist > 0 ? Math.round(cumDist) : null;
            wp._cumEte  = cumEte  > 0 ? cumEte : null;
        }
    }

    /** Toggle flight rules between VFR and IFR */
    _toggleFlightRules() {
        this._flightRules = this._flightRules === 'IFR' ? 'VFR' : 'IFR';
        Settings.set('flight_rules', this._flightRules);
        this._renderTable();
    }

    /**
     * Set cruise power override. Recalculates all CRZ segment fuel/time.
     * @param {number|null} pct - Power percentage (55, 65, 75, etc.) or null to clear
     */
    _setCruisePower(pct) {
        this._cruisePower = pct;
        try {
            if (pct != null) {
                localStorage.setItem('flypi_cruise_power', String(pct));
            } else {
                localStorage.removeItem('flypi_cruise_power');
            }
        } catch {}
        this._computeEnroute();
        this._updateSummary();
        this._renderTable();
    }

    /** Cycle through cruise power presets (tap %PWR header) */
    _cycleCruisePower() {
        const presets = this._powerPresets;
        if (this._cruisePower == null) {
            // First tap: use first preset
            this._setCruisePower(presets[0]);
        } else {
            const idx = presets.indexOf(this._cruisePower);
            if (idx >= 0 && idx < presets.length - 1) {
                this._setCruisePower(presets[idx + 1]);
            } else {
                // Past last preset: clear override (back to plan values)
                this._setCruisePower(null);
            }
        }
    }

    /**
     * Expand or collapse the bottom sheet.
     */
    toggle() {
        this._expanded = !this._expanded;
        this._el.classList.toggle('route-table-expanded', this._expanded);
        if (this._expanded) {
            const height = CockpitConfig.get('routeTable.defaultHeight') || '30vh';
            this._bodyEl.style.maxHeight = height;
        } else {
            this._bodyEl.style.maxHeight = '0';
            // Exit edit mode on collapse
            if (this._editMode) {
                this._editMode = false;
                this._el.classList.remove('route-table-editing');
                this._searchRowEl.hidden = true;
                this._clearSearch();
                this._hideAltPicker();
                this._updateSummary();
            }
        }
        setTimeout(() => this._map?.invalidateSize(), 300);
    }

    // ========== Save Route ==========

    async _saveRoute() {
        if (!this._waypoints || this._waypoints.length < 2) return;

        const dep = this._waypoints[0]?.icao || '?';
        const dest = this._waypoints[this._waypoints.length - 1]?.icao || '?';
        const defaultName = `${dep}-${dest}`;

        // Build a simple name prompt overlay
        const overlay = document.createElement('div');
        overlay.className = 'plan-picker-overlay';
        overlay.innerHTML = `
            <div class="plan-picker" style="max-width:320px">
                <div class="plan-picker-header">
                    <span>Save Route</span>
                    <button class="plan-picker-close">\u2715</button>
                </div>
                <div style="padding:16px">
                    <label style="font-size:16px;color:var(--text-secondary)">Route name</label>
                    <input type="text" class="input rt-save-name" value="${defaultName}"
                        style="width:100%;margin:8px 0;padding:8px;background:var(--bg-surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;font-size:16px"
                        autocomplete="off" autocorrect="off" spellcheck="false">
                    <button class="rt-save-confirm" style="width:100%;padding:10px;margin-top:8px;background:#0088ff;color:#fff;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:16px">SAVE</button>
                </div>
            </div>`;

        overlay.querySelector('.plan-picker-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const nameInput = overlay.querySelector('.rt-save-name');
        const confirmBtn = overlay.querySelector('.rt-save-confirm');

        const doSave = async () => {
            const name = nameInput.value.trim() || defaultName;
            // Build plan object from current waypoints
            const plan = {
                name,
                flight_plan: { departure: dep, destination: dest },
                waypoints: this._waypoints.map(w => ({
                    icao: w.icao, name: w.name, lat: w.lat, lon: w.lon,
                    alt: w.alt, elev_ft: w.elev_ft,
                })),
                edited_at: new Date().toISOString(),
            };

            confirmBtn.textContent = 'Saving...';
            confirmBtn.disabled = true;
            try {
                // Save to localStorage (FlyTab stores plans locally, not on Pi)
                const savedPlans = JSON.parse(localStorage.getItem('flypi_saved_plans') || '[]');
                // Replace existing plan with same name, or append
                const existingIdx = savedPlans.findIndex(p => p.name === name);
                if (existingIdx >= 0) savedPlans[existingIdx] = plan;
                else savedPlans.unshift(plan);
                localStorage.setItem('flypi_saved_plans', JSON.stringify(savedPlans));
                localStorage.setItem('flypi_active_plan', JSON.stringify(plan));
                overlay.remove();
                if (typeof app !== 'undefined' && app.showToast) app.showToast(`Route saved: ${name}`);
            } catch (err) {
                console.warn('Save route failed:', err);
                confirmBtn.textContent = 'SAVE';
                confirmBtn.disabled = false;
            }
        };

        confirmBtn.addEventListener('click', doSave);
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });

        document.body.appendChild(overlay);
        setTimeout(() => nameInput.select(), 100);
    }

    // ========== Plan Picker ==========

    async _showPlanPicker() {
        // Load saved plans from localStorage (FlyTab stores plans locally)
        let plans = [];
        try {
            plans = JSON.parse(localStorage.getItem('flypi_saved_plans') || '[]');
        } catch (err) {
            console.warn('Failed to read saved plans:', err);
        }

        // Build overlay
        const overlay = document.createElement('div');
        overlay.className = 'plan-picker-overlay';
        overlay.innerHTML = `
            <div class="plan-picker">
                <div class="plan-picker-header">
                    <span>Saved Flight Plans</span>
                    <button class="plan-picker-close">\u2715</button>
                </div>
                <div class="plan-picker-list">
                    ${plans.length === 0 ? '<div class="plan-picker-empty">No saved plans.<br>Create a plan on flywhere.app</div>' : ''}
                    ${plans.map((p, idx) => {
                        const fp = p.flight_plan || {};
                        const route = [fp.departure, fp.destination].filter(Boolean).join(' \u2192 ') || 'Unknown route';
                        const label = p.name || route;
                        const date = p.edited_at ? new Date(p.edited_at).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
                        }) : '';
                        return `<button class="plan-picker-item" data-idx="${idx}">
                            <span class="plan-picker-route">${label}</span>
                            ${p.name ? `<span class="plan-picker-route-sub" style="font-size:14px;color:var(--text-secondary)">${route}</span>` : ''}
                            <span class="plan-picker-date">${date}</span>
                        </button>`;
                    }).join('')}
                </div>
                <div class="plan-picker-footer"></div>
            </div>`;

        this._wireButton(overlay.querySelector('.plan-picker-close'), () => overlay.remove());
        // Dismiss on tap outside modal
        const dismissOverlay = (e) => { if (e.target === overlay) overlay.remove(); };
        overlay.addEventListener('click', dismissOverlay);
        overlay.addEventListener('touchend', dismissOverlay);

        // Plan items — load from localStorage by index
        overlay.querySelectorAll('.plan-picker-item').forEach(btn => {
            this._wireButton(btn, async () => {
                try {
                    const idx = parseInt(btn.dataset.idx);
                    const plan = plans[idx];
                    if (plan) {
                        localStorage.setItem('flypi_active_plan', JSON.stringify(plan));
                        overlay.remove();
                        if (typeof app !== 'undefined' && app._applyPlan) {
                            await app._applyPlan(plan);
                            app.showToast('Plan loaded');
                        }
                    }
                } catch (err) {
                    console.warn('Failed to load plan:', err);
                }
            });
        });

        document.body.appendChild(overlay);
    }

    // ========== DOM ==========

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'route-table-sheet';

        // Handle bar
        this._handleEl = document.createElement('div');
        this._handleEl.className = 'route-table-handle';
        this._handleEl.innerHTML = `
            <span class="handle-grip">\u2261</span>
            <span class="handle-summary"></span>
            <button class="rt-save-btn" style="display:none">SAVE</button>
            <button class="rt-load-btn">LOAD</button>
            <button class="rt-upload-btn">UPLOAD</button>
            <button class="route-table-edit-btn">EDIT</button>
        `;
        // Toggle on tap — use both click and touchend for iPad.
        // Track touch movement to distinguish taps from drags.
        let touchStartY = 0;
        this._handleEl.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
        }, { passive: true });
        this._handleEl.addEventListener('touchend', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
            if (dy < 10) { // tap, not drag
                e.preventDefault();
                this.toggle();
            }
        });
        this._handleEl.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            this.toggle();
        });

        // Wire buttons with both click and touchend for iPad reliability.
        // iPad WebKit can suppress click events on elements inside a container
        // with a passive touchstart listener (the drag handler). Using touchend
        // ensures the action fires even when click synthesis fails.
        this._editBtn = this._handleEl.querySelector('.route-table-edit-btn');
        this._wireButton(this._editBtn, () => this._toggleEditMode());

        this._saveBtn = this._handleEl.querySelector('.rt-save-btn');
        this._wireButton(this._saveBtn, () => this._saveRoute());

        this._loadBtn2 = this._handleEl.querySelector('.rt-load-btn');
        this._wireButton(this._loadBtn2, () => this._showPlanPicker());

        this._uploadBtn = this._handleEl.querySelector('.rt-upload-btn');
        this._wireButton(this._uploadBtn, () => { location.href = './upload.html'; });

        this._setupDrag();

        // Search row (hidden until edit mode)
        this._searchRowEl = document.createElement('div');
        this._searchRowEl.className = 'rt-search-row';
        this._searchRowEl.hidden = true;
        this._searchRowEl.innerHTML = `
            <input type="text" class="input rt-search-input" placeholder="Search or paste route..." autocomplete="off" autocorrect="off" spellcheck="false">
            <button class="btn btn-primary rt-go-btn">GO</button>
            <button class="rt-undo-btn" title="Undo">UNDO</button>
        `;
        this._searchInput = this._searchRowEl.querySelector('.rt-search-input');
        this._searchInput.addEventListener('input', () => this._onSearchInput());
        this._searchInput.addEventListener('keyup', () => this._onSearchInput());
        this._searchInput.addEventListener('paste', () => setTimeout(() => this._onSearchInput(), 50));
        this._searchRowEl.querySelector('.rt-go-btn').addEventListener('click', () => this._onSearchInput());

        this._searchRowEl.querySelector('.rt-undo-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this._popUndo();
        });

        // Results
        this._resultsEl = document.createElement('div');
        this._resultsEl.className = 'rt-search-results';
        this._resultsEl.hidden = true;

        // Body
        this._bodyEl = document.createElement('div');
        this._bodyEl.className = 'route-table-body';
        this._bodyEl.style.maxHeight = '0';

        this._tableEl = document.createElement('table');
        this._tableEl.className = 'route-table-content';

        // Delegated event listeners for all interactive table elements.
        // Delegation survives DOM rebuilds from live Stratux updates (issue #30).
        this._tableEl.addEventListener('click', (e) => {
            const del = e.target.closest('.rt-delete-btn');
            if (del) { e.stopPropagation(); this._removeWaypoint(parseInt(del.dataset.idx)); return; }
            const up = e.target.closest('.rt-up-btn');
            if (up) { e.stopPropagation(); this._moveWaypoint(parseInt(up.dataset.idx), parseInt(up.dataset.idx) - 1); return; }
            const down = e.target.closest('.rt-down-btn');
            if (down) { e.stopPropagation(); this._moveWaypoint(parseInt(down.dataset.idx), parseInt(down.dataset.idx) + 1); return; }
            // Altitude cell opens picker in edit mode
            const altCell = e.target.closest('.rt-alt-cell');
            if (altCell && this._editMode) { e.stopPropagation(); this._showAltPicker(parseInt(altCell.dataset.idx), altCell); return; }
            // Power header cycles cruise power
            const pwr = e.target.closest('.rt-pwr-header');
            if (pwr) { e.stopPropagation(); this._cycleCruisePower(); return; }
            // ALT header toggles IFR/VFR
            const rules = e.target.closest('.rt-rules-header');
            if (rules) { e.stopPropagation(); this._toggleFlightRules(); return; }
            // Row click pans map to waypoint
            const row = e.target.closest('.rt-row');
            if (row && !this._editMode) {
                const idx = parseInt(row.dataset.idx);
                const wp = this._waypoints[idx];
                if (wp && wp.lat && wp.lon && this._map) {
                    this._map.panTo([wp.lat, wp.lon]);
                }
            }
        });
        // Touchend delegation for iPad reliability on power/rules headers
        this._tableEl.addEventListener('touchend', (e) => {
            const pwr = e.target.closest('.rt-pwr-header');
            if (pwr) { e.preventDefault(); e.stopPropagation(); this._cycleCruisePower(); }
            const rules = e.target.closest('.rt-rules-header');
            if (rules) { e.preventDefault(); e.stopPropagation(); this._toggleFlightRules(); }
        });

        // Altitude picker overlay (reused, hidden by default)
        this._altPicker = document.createElement('div');
        this._altPicker.className = 'rt-alt-picker';
        this._altPicker.hidden = true;
        this._altPickerIndex = -1;
        // Delegated click handler for picker buttons (survives innerHTML rebuilds)
        this._altPicker.addEventListener('click', (e) => {
            const optBtn = e.target.closest('.rt-alt-option');
            if (optBtn) {
                e.stopPropagation();
                this._setWaypointAlt(this._altPickerIndex, parseInt(optBtn.dataset.alt));
                this._hideAltPicker();
                return;
            }
            const setBtn = e.target.closest('.rt-alt-set-btn');
            if (setBtn) {
                e.stopPropagation();
                const input = this._altPicker.querySelector('.rt-alt-input');
                const val = parseInt(input?.value);
                if (!isNaN(val) && val > 0) {
                    this._setWaypointAlt(this._altPickerIndex, val);
                    this._hideAltPicker();
                }
                return;
            }
        });
        // Close picker on outside click (scoped to container, not document)
        this._container.addEventListener('click', (e) => {
            if (!this._altPicker.hidden && !this._altPicker.contains(e.target) && !e.target.closest('.rt-alt-cell')) {
                this._hideAltPicker();
            }
        });

        this._bodyEl.appendChild(this._searchRowEl);
        this._bodyEl.appendChild(this._resultsEl);
        this._bodyEl.appendChild(this._tableEl);

        this._el.appendChild(this._handleEl);
        this._el.appendChild(this._bodyEl);
        this._container.appendChild(this._el);
        // Append altitude picker to container (needs to float above table)
        this._container.appendChild(this._altPicker);

        this._buildEngineStatusCard();
    }

    /**
     * Wire a button with touchstart + click fallback for iPad/Leaflet reliability.
     * touchstart fires before Leaflet's drag handler can cancel the touch sequence.
     */
    _wireButton(btn, action) {
        let touchFired = false;
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            touchFired = true;
            action();
        }, { passive: false });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (touchFired) { touchFired = false; return; }
            action();
        });
    }

    _setupDrag() {
        let startY = 0;
        let startH = 0;

        const onMove = (e) => {
            if (!this._dragging) return;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const delta = startY - clientY;
            const newH = Math.max(0, Math.min(window.innerHeight * 0.6, startH + delta));
            this._bodyEl.style.maxHeight = newH + 'px';
        };

        const onEnd = () => {
            this._dragging = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchend', onEnd);

            const h = parseInt(this._bodyEl.style.maxHeight);
            this._expanded = h > 20;
            this._el.classList.toggle('route-table-expanded', this._expanded);
            this._map?.invalidateSize();
        };

        const grip = this._handleEl;
        const startDrag = (e) => {
            // Don't start drag on buttons — let their click handlers work
            if (e.target.tagName === 'BUTTON') return;
            this._dragging = true;
            startY = e.touches ? e.touches[0].clientY : e.clientY;
            startH = this._bodyEl.offsetHeight;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('touchmove', onMove);
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchend', onEnd);
        };

        grip.addEventListener('mousedown', startDrag);
        grip.addEventListener('touchstart', startDrag, { passive: true });
    }

    _updateSummary() {
        const summaryEl = this._handleEl.querySelector('.handle-summary');
        if (!summaryEl) return;

        // Update edit button text
        if (this._editBtn) {
            this._editBtn.textContent = this._editMode ? 'DONE' : 'EDIT';
            this._editBtn.classList.toggle('rt-edit-active', this._editMode);
        }

        // Show/hide save button based on route state
        if (this._saveBtn) this._saveBtn.style.display = this._waypoints.length >= 2 ? '' : 'none';

        if (this._waypoints.length === 0) {
            summaryEl.textContent = 'NO ROUTE';
            return;
        }

        const dep = this._waypoints[0];
        // Use last airport waypoint as destination (not MAP or other appended fixes)
        const dest = [...this._waypoints].reverse().find(wp => wp.type === 'APT')
                  || this._waypoints[this._waypoints.length - 1];
        const active = this._waypoints[this._activeIndex];

        let remainDist = 0;
        for (let i = this._activeIndex; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            if (i === this._activeIndex) {
                remainDist += wp._liveDist || wp._legDist || 0;
            } else {
                remainDist += wp._legDist || 0;
            }
        }

        const gs = this._lastSituation?.ground_speed || 0;
        const cruiseSpeed = gs > 30 ? gs : (CockpitConfig.aircraft('performance.cruise_speed_kt') || 120);
        const remainEte = cruiseSpeed > 0 ? (remainDist / cruiseSpeed * 60) : 0;

        summaryEl.innerHTML =
            `<span style="color:var(--accent)">${dep.icao || '?'}\u2192${dest.icao || '?'}</span>`;
    }

    _renderTable() {
        const columns = CockpitConfig.get('routeTable.columns') || [];

        let html = '<thead><tr>';
        if (this._editMode) {
            html += '<th style="width:32px"></th>'; // reorder
        }
        for (const col of columns) {
            if (col.key === 'pwr') {
                // Make %PWR header tappable to cycle cruise power
                const pwrLabel = this._cruisePower
                    ? `${col.label} <span class="rt-pwr-badge">${this._cruisePower}%</span>`
                    : col.label;
                html += `<th style="width:${col.width || 'auto'};cursor:pointer" class="rt-pwr-header">${pwrLabel}</th>`;
            } else if (col.key === 'alt') {
                // Make ALT header tappable to toggle IFR/VFR
                const rulesLabel = `${col.label} <span class="rt-rules-badge">${this._flightRules}</span>`;
                html += `<th style="width:${col.width || 'auto'};cursor:pointer" class="rt-rules-header">${rulesLabel}</th>`;
            } else {
                html += `<th style="width:${col.width || 'auto'}">${col.label}</th>`;
            }
        }
        if (this._editMode) {
            html += '<th style="width:32px"></th>'; // delete
        }
        html += '</tr></thead><tbody>';

        // Build flat display rows: one per segment for multi-segment legs
        const displayRows = [];
        for (const wp of this._waypoints) {
            const segs = wp._segments || [];
            if (segs.length > 1 && wp.index > 0) {
                for (let si = 0; si < segs.length; si++) {
                    displayRows.push({ wp, seg: segs[si], segIndex: si, segCount: segs.length });
                }
            } else {
                displayRows.push({ wp, seg: null, segIndex: 0, segCount: 1 });
            }
        }

        for (const row of displayRows) {
            const { wp, seg, segIndex, segCount } = row;
            const cls = wp.active ? 'active' : (wp.passed ? 'passed' : '');
            const segCls = segIndex > 0 ? ' rt-seg-row' : '';
            html += `<tr class="rt-row${segCls} ${cls}" data-idx="${wp.index}">`;

            if (this._editMode) {
                if (segIndex === 0) {
                    const rs = segCount > 1 ? ` rowspan="${segCount}"` : '';
                    html += `<td class="rt-reorder-cell"${rs}>
                        <button class="rt-up-btn" data-idx="${wp.index}" ${wp.index === 0 ? 'disabled' : ''}>\u25B2</button>
                        <button class="rt-down-btn" data-idx="${wp.index}" ${wp.index === this._waypoints.length - 1 ? 'disabled' : ''}>\u25BC</button>
                    </td>`;
                }
                // segIndex > 0: skip reorder cell (covered by rowspan)
            }

            for (const col of columns) {
                // For multi-segment rows, use rowspan on wpt/hdg/wind cells
                if (seg && segCount > 1 && (col.key === 'wpt' || col.key === 'hdg' || col.key === 'wind')) {
                    if (segIndex === 0) {
                        const val = this._getCellValue(wp, col.key, seg, 0);
                        html += `<td rowspan="${segCount}">${val}</td>`;
                    }
                    // segIndex > 0: skip (covered by rowspan)
                } else if (col.key === 'alt' && this._editMode && segIndex === 0) {
                    // Tappable altitude cell in edit mode (issue #31)
                    const altVal = wp.alt ?? wp.altitude ?? '\u2014';
                    const display = typeof altVal === 'number' ? (altVal >= 1000 ? altVal.toLocaleString() : altVal) : altVal;
                    const rs = segCount > 1 ? ` rowspan="${segCount}"` : '';
                    html += `<td class="rt-alt-cell" data-idx="${wp.index}"${rs}>${display} <span class="rt-alt-edit-icon">\u25BE</span></td>`;
                } else if (col.key === 'alt' && this._editMode && segIndex > 0) {
                    // skip — covered by rowspan from segIndex===0
                } else {
                    const val = seg ? this._getCellValue(wp, col.key, seg, segIndex) : this._getCellValue(wp, col.key);
                    html += `<td>${val}</td>`;
                }
            }

            if (this._editMode) {
                if (segIndex === 0) {
                    const rs = segCount > 1 ? ` rowspan="${segCount}"` : '';
                    html += `<td${rs}><button class="rt-delete-btn" data-idx="${wp.index}">\u00d7</button></td>`;
                }
            }

            html += '</tr>';
        }
        html += '</tbody>';

        // Totals footer — dist, ete, fuel
        if (this._waypoints.length >= 2) {
            let totDist = 0, totEte = 0, totFuel = 0;
            for (const wp of this._waypoints) {
                totDist += wp._dist || 0;
                totEte  += wp._ete  || 0;
                totFuel += wp._fuel || 0;
            }
            html += '<tfoot><tr class="rt-totals-row">';
            if (this._editMode) html += '<td></td>';
            for (const col of columns) {
                switch (col.key) {
                    case 'wpt':  html += `<td class="rt-totals-label">TOTAL</td>`; break;
                    case 'dist': html += `<td>${Math.round(totDist)}nm</td>`; break;
                    case 'ete':  html += `<td>${this._formatTime(totEte)}</td>`; break;
                    case 'fuel': html += `<td>${totFuel.toFixed(1)}</td>`; break;
                    default:     html += `<td></td>`; break;
                }
            }
            if (this._editMode) html += '<td></td>';
            html += '</tr></tfoot>';
        }

        this._tableEl.innerHTML = html;

        // All interactive events (edit buttons, power header, row clicks) handled
        // by delegated listeners on _tableEl set up in _buildDOM().
    }

    _getCellValue(wp, key, seg = null, segIndex = 0) {
        // When seg is provided, use segment-specific computed values
        if (seg) {
            switch (key) {
                case 'wpt': return segIndex === 0 ? (wp.icao || wp.name || '?') : '';
                case 'phase': return seg.phase || '\u2014';
                case 'alt': return this._formatSegAlt(seg);
                case 'hdg':
                    return segIndex === 0 ? (wp._hdg != null ? Math.round(wp._hdg) + '\u00b0' : '\u2014') : '';
                case 'dist':
                    return seg.dist != null ? Math.round(seg.dist) : '\u2014';
                case 'ete':
                    return seg._ete != null ? this._formatTime(seg._ete) : '\u2014';
                case 'fuel':
                    return seg._fuel != null ? seg._fuel.toFixed(1) : '\u2014';
                case 'fuel_rem': {
                    if (seg._fuelRem == null) return '\u2014';
                    const cautionGal = CockpitConfig.get('enginePage.fuelCautionGal') || 8;
                    const warnGal = CockpitConfig.get('enginePage.fuelWarningGal') || 4;
                    const val = seg._fuelRem.toFixed(1);
                    if (seg._fuelRem <= warnGal) return `<span class="fuel-red">${val}</span>`;
                    if (seg._fuelRem <= cautionGal) return `<span class="fuel-yellow">${val}</span>`;
                    return val;
                }
                case 'tas':
                    return seg._tas != null ? Math.round(seg._tas) : '\u2014';
                case 'gs': {
                    if (wp.active && segIndex === 0 && this._lastSituation?.ground_speed > 30) {
                        return Math.round(this._lastSituation.ground_speed);
                    }
                    return seg._gs != null ? Math.round(seg._gs) : '\u2014';
                }
                case 'wind':
                    if (segIndex === 0 && wp._wind) {
                        const dir = Math.round(wp._wind.dir || 0);
                        const spd = Math.round(wp._wind.spd || 0);
                        return `${String(dir).padStart(3, '0')}/${spd}`;
                    }
                    return segIndex === 0 ? '\u2014' : '';
                case 'pwr':
                    return seg._pwr != null ? Math.round(seg._pwr) + '%' : '\u2014';
                case 'rpm':
                    return seg._rpm != null ? seg._rpm : '\u2014';
                case 'mp':
                    return seg._mp != null ? seg._mp : '\u2014';
                default: return segIndex === 0 ? (wp[key] || '\u2014') : '';
            }
        }

        // Original wp-level fallback (single segment or no segments)
        switch (key) {
            case 'wpt': return wp.icao || wp.name || '?';
            case 'phase': return wp._phase || '\u2014';
            case 'alt': return wp.alt ?? wp.altitude ?? '\u2014';
            case 'hdg':
                return wp._hdg != null ? Math.round(wp._hdg) + '\u00b0' : '\u2014';
            case 'dist':
                return wp._cumDist != null ? wp._cumDist : '\u2014';
            case 'ete':
                return wp._cumEte != null ? this._formatTime(wp._cumEte) : '\u2014';
            case 'fuel':
                return wp._fuel != null ? wp._fuel.toFixed(1) : '\u2014';
            case 'fuel_rem': {
                if (wp._fuelRem == null) return '\u2014';
                const cautionGal = CockpitConfig.get('enginePage.fuelCautionGal') || 8;
                const warnGal = CockpitConfig.get('enginePage.fuelWarningGal') || 4;
                const val = wp._fuelRem.toFixed(1);
                if (wp._fuelRem <= warnGal) return `<span class="fuel-red">${val}</span>`;
                if (wp._fuelRem <= cautionGal) return `<span class="fuel-yellow">${val}</span>`;
                return val;
            }
            case 'tas':
                return wp._tas != null ? Math.round(wp._tas) : '\u2014';
            case 'gs': {
                if (wp.active && this._lastSituation?.ground_speed > 30) {
                    return Math.round(this._lastSituation.ground_speed);
                }
                return wp._gs != null ? Math.round(wp._gs) : '\u2014';
            }
            case 'wind':
                if (wp._wind) {
                    const dir = Math.round(wp._wind.dir || 0);
                    const spd = Math.round(wp._wind.spd || 0);
                    return `${String(dir).padStart(3, '0')}/${spd}`;
                }
                return '\u2014';
            case 'pwr':
                return wp._pwr != null ? Math.round(wp._pwr) + '%' : '\u2014';
            case 'rpm':
                return wp._rpm != null ? wp._rpm : '\u2014';
            case 'mp':
                return wp._mp != null ? wp._mp : '\u2014';
            default: return wp[key] || '\u2014';
        }
    }

    _advanceWaypoint() {
        if (this._activeIndex >= 0) {
            this._waypoints[this._activeIndex].active = false;
            this._waypoints[this._activeIndex].passed = true;
        }
        this._activeIndex++;
        if (this._activeIndex < this._waypoints.length) {
            this._waypoints[this._activeIndex].active = true;
        }
    }

    _formatTime(minutes) {
        if (!minutes || minutes <= 0) return '\u2014';
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`;
    }

    /** Format altitude for a segment: "486→8,500" for CLB/DES, "8,500" for level */
    _formatSegAlt(seg) {
        if (!seg) return '\u2014';
        const fmtAlt = (v) => {
            if (v == null) return '?';
            return v >= 1000 ? v.toLocaleString() : String(v);
        };
        if (seg.altFrom != null && seg.altTo != null && seg.altFrom !== seg.altTo) {
            return `${fmtAlt(seg.altFrom)}\u2192${fmtAlt(seg.altTo)}`;
        }
        return fmtAlt(seg.altTo ?? seg.altFrom ?? seg.alt);
    }

    _bearing(lat1, lon1, lat2, lon2) {
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const rLat1 = lat1 * Math.PI / 180;
        const rLat2 = lat2 * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(rLat2);
        const x = Math.cos(rLat1) * Math.sin(rLat2) - Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
        return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    }

    _buildEngineStatusCard() {
        const card = document.createElement('div');
        card.id = 'engineStatusCard';
        card.className = 'engine-status-card engine-status-card--waiting';
        card.innerHTML = `
            <span class="esc-phase">ML: warming up</span>
            <span class="esc-score"></span>
        `;
        this._engineCardEl = card;
        this._engineCardPhaseEl = card.querySelector('.esc-phase');
        this._engineCardScoreEl = card.querySelector('.esc-score');
        // Insert as first child of the sheet so it sits above the handle bar
        this._el.insertBefore(card, this._el.firstChild);
    }

    _updateEngineStatusCard(result) {
        if (!this._engineCardEl || !result) return;
        const { phase, score, anomaly, windowReady } = result;

        this._engineCardEl.className = 'engine-status-card';
        if (!windowReady) {
            this._engineCardEl.classList.add('engine-status-card--waiting');
            this._engineCardPhaseEl.textContent = `ML: warming up`;
            this._engineCardScoreEl.textContent = '';
        } else if (anomaly) {
            this._engineCardEl.classList.add('engine-status-card--alert');
            this._engineCardPhaseEl.textContent = `\u26a0 ${(phase || 'ALERT').toUpperCase()}`;
            this._engineCardScoreEl.textContent = score != null ? `${Math.round(score * 100)}%` : '';
        } else {
            this._engineCardEl.classList.add('engine-status-card--ok');
            this._engineCardPhaseEl.textContent = (phase || 'OK').toUpperCase();
            this._engineCardScoreEl.textContent = score != null ? `${Math.round(score * 100)}%` : '';
        }
    }
}
