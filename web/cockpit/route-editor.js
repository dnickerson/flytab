/**
 * FlyPi — Cockpit Route Editor
 * Slide-up panel for in-flight route editing, Direct-To, and divert.
 * Touch-friendly: 44px min targets, no drag-and-drop, tap-based reorder.
 */

class RouteEditor {
    constructor(container, nasrDb, stratuxClient, cockpitMap) {
        this.container = container;
        this.nasrDb = nasrDb;
        this.stratux = stratuxClient;
        this.cockpitMap = cockpitMap;

        this._el = null;
        this._directToEl = null;
        this._visible = false;
        this._waypoints = [];
        this._altitude = 3500;
        this._undoStack = [];
        this._insertIndex = -1; // -1 = append
        this._expandedIndex = -1;
        this._searchDebounce = null;
        this._mapTapMode = false;
        this._mapTapHandler = null;
        this._plan = null; // reference to loaded plan for metadata
        this._parseSeq = 0; // sequence counter to discard stale route parse results
    }

    init() {
        this._buildPanel();
        this._buildDirectToModal();
    }

    destroy() {
        this.hide();
        this._disableMapTapMode();
        if (this._el && this._el.parentNode) this._el.remove();
        if (this._directToEl && this._directToEl.parentNode) this._directToEl.remove();
    }

    show() {
        console.log('[RouteEditor] show() called, _visible=', this._visible);
        if (this._visible) return;
        this._visible = true;
        this._el.classList.add('route-editor-visible');
        this._renderWaypoints();
    }

    hide() {
        this._visible = false;
        this._el.classList.remove('route-editor-visible');
        this._disableMapTapMode();
        this._clearSearch();
    }

    isVisible() { return this._visible; }

    // ========== Load / State ==========

    loadRoute(plan) {
        this._plan = plan;
        const wps = plan.waypoints || plan.legs?.map(l => ({
            name: l.to || l.waypoint,
            icao: l.to || l.waypoint,
            lat: l.lat,
            lon: l.lon,
            alt: l.altitude || plan.cruise_altitude,
            gs: l.gs,
            gph: l.gph,
        })) || [];

        this._waypoints = wps.map(wp => ({ ...wp }));
        this._altitude = plan.cruise_altitude || plan.flight_plan?.cruise_altitude || 3500;
        this._undoStack = [];
        this._insertIndex = -1;
        this._expandedIndex = -1;

        if (this._altInput) this._altInput.value = this._altitude;
        if (this._visible) this._renderWaypoints();
    }

    // ========== New / Edit Route ==========

    async startNewRoute() {
        this._waypoints = [];
        this._plan = null;
        this._altitude = 3500;
        this._undoStack = [];
        this._insertIndex = -1;
        this._expandedIndex = -1;
        this._newRouteMode = true;

        // Pre-populate with nearest airport to current GPS position
        const sit = this.stratux?.situation;
        if (sit?.lat != null && sit?.lon != null && this.nasrDb) {
            try {
                const nearby = await this.nasrDb.getAirportsNear(sit.lat, sit.lon, 50);
                if (nearby?.length) {
                    const apt = nearby[0];
                    this._waypoints = [{
                        icao: apt.icao,
                        name: apt.name,
                        lat: apt.lat,
                        lon: apt.lon,
                        type: 'APT',
                        alt: 0,
                    }];
                }
            } catch {
                // NASR DB not ready — user can still add waypoints manually
            }
        }

        if (this._altInput) this._altInput.value = this._altitude;
        this.show();
    }

    startEditRoute() {
        console.log('[RouteEditor] startEditRoute called, _waypoints.length=', this._waypoints.length, '_visible=', this._visible);
        if (this._waypoints.length === 0) {
            if (typeof app !== 'undefined') app.showToast('No route loaded');
            return;
        }
        this._newRouteMode = false;
        this.show();
    }

    // ========== Undo ==========

    _pushUndo() {
        this._undoStack.push(JSON.parse(JSON.stringify(this._waypoints)));
        if (this._undoStack.length > 15) this._undoStack.shift();
        if (this._undoBtn) this._undoBtn.disabled = false;
    }

    _popUndo() {
        if (this._undoStack.length === 0) return;
        this._waypoints = this._undoStack.pop();
        this._expandedIndex = -1;
        this._renderWaypoints();
        if (this._undoBtn) this._undoBtn.disabled = this._undoStack.length === 0;
        this._applyRoute({ hide: false, toast: false });
    }

    // ========== Waypoint Operations ==========

    _addWaypoint(wp, index) {
        this._pushUndo();
        if (index < 0 || index > this._waypoints.length) {
            this._waypoints.push(wp);
        } else {
            this._waypoints.splice(index, 0, wp);
        }
        this._insertIndex = -1;
        this._renderWaypoints();
        this._applyRoute({ hide: false, toast: false });
    }

    _removeWaypoint(index) {
        if (index < 0 || index >= this._waypoints.length) return;
        this._pushUndo();
        this._waypoints.splice(index, 1);
        this._expandedIndex = -1;
        this._renderWaypoints();
        this._applyRoute({ hide: false, toast: false });
    }

    _moveWaypoint(fromIdx, toIdx) {
        if (fromIdx === toIdx) return;
        if (toIdx < 0 || toIdx >= this._waypoints.length) return;
        this._pushUndo();
        const [wp] = this._waypoints.splice(fromIdx, 1);
        this._waypoints.splice(toIdx, 0, wp);
        this._expandedIndex = toIdx;
        this._renderWaypoints();
        this._applyRoute({ hide: false, toast: false });
    }

    // ========== Build DOM ==========

    _buildPanel() {
        this._el = document.createElement('div');
        this._el.className = 'route-editor';
        this._el.innerHTML = `
            <div class="route-editor-header">
                <span class="route-editor-title">ROUTE EDITOR</span>
                <button class="btn-close route-editor-close" title="Close">✕</button>
            </div>
            <div class="route-editor-search-row">
                <input type="text" class="input route-editor-search" placeholder="Search or paste route..." autocomplete="off" autocorrect="off" spellcheck="false">
                <button class="btn btn-primary route-editor-go-btn" title="Parse route or search">GO</button>
                <button class="btn btn-secondary route-editor-nearby-btn" title="Nearby airports">NEARBY</button>
                <button class="btn btn-secondary route-editor-maptap-btn" title="Tap map to add">MAP+</button>
            </div>
            <div class="route-editor-results" hidden></div>
            <div class="route-editor-controls">
                <div class="route-editor-alt-row">
                    <label class="input-label">ALT</label>
                    <input type="number" class="input route-editor-alt" value="3500" step="500" min="0" max="45000">
                    <span class="route-editor-alt-unit">ft</span>
                </div>
                <div class="route-editor-actions">
                    <button class="btn btn-secondary route-editor-undo" disabled>UNDO</button>
                </div>
            </div>
            <div class="route-editor-waypoints"></div>
            <div class="route-editor-bottom-bar">
                <button class="btn btn-secondary re-new-btn">NEW</button>
                <button class="btn btn-secondary re-rev-btn">REV</button>
                <button class="btn btn-secondary re-load-btn">LOAD</button>
                <button class="btn btn-secondary re-upload-btn">UPLOAD</button>
                <button class="btn btn-primary re-save-btn">SAVE</button>
            </div>
        `;
        this.container.appendChild(this._el);

        // Cache refs
        this._searchInput = this._el.querySelector('.route-editor-search');
        this._resultsDiv = this._el.querySelector('.route-editor-results');
        this._waypointsDiv = this._el.querySelector('.route-editor-waypoints');
        this._altInput = this._el.querySelector('.route-editor-alt');
        this._undoBtn = this._el.querySelector('.route-editor-undo');

        // Events — use _wireTap for iPad touch reliability
        this._wireTap(this._el.querySelector('.route-editor-close'), () => this.hide());
        this._searchInput.addEventListener('input', () => this._onSearchInput());
        this._searchInput.addEventListener('keyup', () => this._onSearchInput());
        this._searchInput.addEventListener('paste', () => setTimeout(() => this._onSearchInput(), 50));
        // GO button: explicit trigger for Android paste (events unreliable)
        this._wireTap(this._el.querySelector('.route-editor-go-btn'), () => this._onSearchInput());
        this._wireTap(this._el.querySelector('.route-editor-nearby-btn'), () => this._showNearby());
        this._wireTap(this._el.querySelector('.route-editor-maptap-btn'), () => this._toggleMapTapMode());
        this._wireTap(this._undoBtn, () => this._popUndo());
        this._altInput.addEventListener('change', () => {
            this._altitude = parseInt(this._altInput.value) || 3500;
            // Push unlocked waypoints to the new cruise altitude immediately
            for (const wp of this._waypoints) {
                if (!wp.altLocked) wp.alt = this._altitude;
            }
            this._applyRoute({ hide: false, toast: false });
        });

        // Bottom bar: SAVE, LOAD, NEW, REV, UPLOAD — route management buttons
        this._wireTap(this._el.querySelector('.re-new-btn'), () => {
            if (typeof app !== 'undefined' && app.routeTable) app.routeTable._confirmNewRoute();
        });
        this._wireTap(this._el.querySelector('.re-rev-btn'), () => {
            if (typeof app !== 'undefined' && app.routeTable) app.routeTable._reverseRoute();
        });
        this._wireTap(this._el.querySelector('.re-load-btn'), () => {
            if (typeof app !== 'undefined' && app.routeTable) app.routeTable._showPlanPicker();
        });
        this._wireTap(this._el.querySelector('.re-upload-btn'), () => {
            if (typeof app !== 'undefined' && app.routeTable) app.routeTable._showUploadModal();
        });
        this._wireTap(this._el.querySelector('.re-save-btn'), () => {
            if (typeof app !== 'undefined' && app.routeTable) app.routeTable._saveRoute();
        });
    }

    _buildDirectToModal() {
        this._directToEl = document.createElement('div');
        this._directToEl.className = 'direct-to-modal';
        this._directToEl.hidden = true;
        this._directToEl.innerHTML = `
            <div class="direct-to-card">
                <div class="direct-to-header">
                    <span class="direct-to-title">DIRECT TO</span>
                    <button class="btn-close direct-to-close">✕</button>
                </div>
                <input type="text" class="input direct-to-search" placeholder="Search ICAO or name..." autocomplete="off" autocorrect="off" spellcheck="false">
                <div class="direct-to-results"></div>
            </div>
        `;
        document.body.appendChild(this._directToEl);

        this._directToSearch = this._directToEl.querySelector('.direct-to-search');
        this._directToResults = this._directToEl.querySelector('.direct-to-results');

        this._wireTap(this._directToEl.querySelector('.direct-to-close'), () => this.hideDirectTo());
        this._wireTap(this._directToEl, (e) => {
            if (e.target === this._directToEl) this.hideDirectTo();
        });
        this._directToSearch.addEventListener('input', () => this._onDirectToSearch());
    }

    // ========== Direct-To ==========

    showDirectTo() {
        this._directToEl.hidden = false;
        this._directToSearch.value = '';
        this._directToSearch.focus();
        this._loadDirectToNearby();
    }

    hideDirectTo() {
        this._directToEl.hidden = true;
        this._directToResults.innerHTML = '';
    }

    async _loadDirectToNearby() {
        const sit = this.stratux?.situation;
        if (!sit || !sit.lat) {
            this._directToResults.innerHTML = '<div class="route-search-empty">No GPS position</div>';
            return;
        }
        try {
            const airports = await this.nasrDb.getAirportsNear(sit.lat, sit.lon, 30);
            airports.sort((a, b) => {
                const dA = CockpitMap._distNm(sit.lat, sit.lon, a.lat, a.lon);
                const dB = CockpitMap._distNm(sit.lat, sit.lon, b.lat, b.lon);
                return dA - dB;
            });
            this._renderDirectToResults(airports.slice(0, 5));
        } catch (err) {
            console.warn('Direct-To nearby error:', err);
            this._directToResults.innerHTML = '<div class="route-search-empty">Airport database not available</div>';
        }
    }

    _onDirectToSearch() {
        clearTimeout(this._directToDebounce);
        const q = this._directToSearch.value.trim();
        if (q.length < 2) {
            this._loadDirectToNearby();
            return;
        }
        this._directToDebounce = setTimeout(async () => {
            try {
                const results = await this.nasrDb.searchAll(q);
                this._renderDirectToResults(results.airports || [], results.navaids || [], results.fixes || [], q);
            } catch (err) {
                console.warn('Direct-To search error:', err);
                this._directToResults.innerHTML = '<div class="route-search-empty">Airport database not available</div>';
            }
        }, 200);
    }

    _renderDirectToResults(airports, navaids, fixes, query = '') {
        const q = (query || '').toUpperCase();
        const sit = this.stratux?.situation;
        const results = [];

        for (const a of airports) {
            const dist = sit?.lat ? CockpitMap._distNm(sit.lat, sit.lon, a.lat, a.lon) : null;
            const brg = sit?.lat ? Math.round(CockpitMap._bearing(sit.lat, sit.lon, a.lat, a.lon)) : null;
            results.push({ type: 'APT', id: a.icao, name: a.name, lat: a.lat, lon: a.lon, dist, brg });
        }
        for (const n of navaids) {
            const dist = sit?.lat ? CockpitMap._distNm(sit.lat, sit.lon, n.lat, n.lon) : null;
            const brg = sit?.lat ? Math.round(CockpitMap._bearing(sit.lat, sit.lon, n.lat, n.lon)) : null;
            results.push({ type: n.type || 'NAV', id: n.id, name: n.name, lat: n.lat, lon: n.lon, dist, brg });
        }
        for (const f of fixes) {
            const dist = sit?.lat ? CockpitMap._distNm(sit.lat, sit.lon, f.lat, f.lon) : null;
            const brg = sit?.lat ? Math.round(CockpitMap._bearing(sit.lat, sit.lon, f.lat, f.lon)) : null;
            results.push({ type: 'FIX', id: f.id, name: '', lat: f.lat, lon: f.lon, dist, brg });
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

        const limited = results.slice(0, 10);
        this._directToResults.innerHTML = limited.map(r => {
            const distStr = r.dist != null ? r.dist.toFixed(0) + 'nm ' + r.brg + '\u00b0' : '—';
            return `<button class="route-search-result" data-icao="${r.id}" data-name="${r.name || r.id}" data-lat="${r.lat}" data-lon="${r.lon}" data-type="${r.type}">
                <span class="result-type">${r.type}</span>
                <span class="result-id">${r.id}</span>
                <span class="result-dist">${distStr}</span>
                <span class="result-name">${r.name || ''}</span>
            </button>`;
        }).join('');

        this._directToResults.querySelectorAll('.route-search-result').forEach(btn => {
            this._wireTap(btn, () => {
                this._executeDirectTo({
                    icao: btn.dataset.icao,
                    name: btn.dataset.name || btn.dataset.icao,
                    lat: parseFloat(btn.dataset.lat),
                    lon: parseFloat(btn.dataset.lon),
                    type: btn.dataset.type,
                });
            });
        });
    }

    _executeDirectTo(apt) {
        this._pushUndo();
        const sit = this.stratux?.situation;

        const directWp = {
            icao: apt.icao,
            name: apt.name || apt.icao,
            lat: apt.lat,
            lon: apt.lon,
            alt: this._altitude,
            type: apt.type || 'APT',
        };

        // Direct-To always overrides the current route: PPOS → destination.
        this._waypoints = [];
        if (sit && sit.lat) {
            this._waypoints.push({
                icao: 'PPOS',
                name: 'Present Pos',
                lat: sit.lat,
                lon: sit.lon,
                alt: sit.alt_msl || this._altitude,
            });
        }
        this._waypoints.push(directWp);

        this.hideDirectTo();
        this._applyRoute();

        if (typeof app !== 'undefined') {
            const toast = app.showToast(`Direct \u2192 ${apt.icao}`, [
                { id: 'undo', label: 'UNDO', callback: () => this._popUndo() }
            ]);
            setTimeout(() => toast.remove(), 8000);
        }
    }

    /**
     * Find the best index to insert a Direct-To waypoint.
     * Returns the index in _waypoints where the Direct-To target should go.
     *
     * Strategy: determine which leg we're currently on (closest leg midpoint
     * to our GPS position), then insert the D→ target after the "from" end
     * of that leg so the route becomes: ...→ currentLegFrom → D→target → nextWp → ...
     * Falls back to inserting before the destination.
     */
    _findDirectToInsertIndex(sit, apt) {
        const wps = this._waypoints.filter(w => w.icao !== 'PPOS');
        if (wps.length === 0) return 0;

        // If the target is already in the route, return its index
        const existingIdx = this._waypoints.findIndex(w => w.icao === apt.icao && w.icao !== 'PPOS');
        if (existingIdx >= 0) return existingIdx;

        if (sit && sit.lat && wps.length >= 2) {
            // Find which leg we're closest to (perpendicular distance to leg segment)
            let bestLegIdx = 0;
            let bestDist = Infinity;
            for (let i = 0; i < this._waypoints.length - 1; i++) {
                const a = this._waypoints[i];
                const b = this._waypoints[i + 1];
                if (a.icao === 'PPOS' || b.icao === 'PPOS') continue;
                if (!a.lat || !b.lat) continue;
                const d = this._distToSegment(sit.lat, sit.lon, a.lat, a.lon, b.lat, b.lon);
                if (d < bestDist) {
                    bestDist = d;
                    bestLegIdx = i;
                }
            }
            // Insert after the "from" waypoint of the current leg
            return bestLegIdx + 1;
        }

        // Fallback: insert before the last waypoint (destination)
        const lastReal = this._waypoints.length - 1;
        return lastReal >= 0 ? lastReal : 0;
    }

    /**
     * Approximate distance (nm) from point P to line segment AB.
     */
    _distToSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
        const dx = bLon - aLon, dy = bLat - aLat;
        if (dx === 0 && dy === 0) {
            return CockpitMap._distNm(pLat, pLon, aLat, aLon);
        }
        let t = ((pLon - aLon) * dx + (pLat - aLat) * dy) / (dx * dx + dy * dy);
        t = Math.max(0, Math.min(1, t));
        const projLat = aLat + t * dy;
        const projLon = aLon + t * dx;
        return CockpitMap._distNm(pLat, pLon, projLat, projLon);
    }

    // ========== Map Tap Mode ==========

    _toggleMapTapMode() {
        if (this._mapTapMode) {
            this._disableMapTapMode();
        } else {
            this._enableMapTapMode();
        }
    }

    _enableMapTapMode() {
        if (!this.cockpitMap || !this.cockpitMap.map) return;
        this._mapTapMode = true;
        const btn = this._el.querySelector('.route-editor-maptap-btn');
        if (btn) btn.classList.add('active');
        this.cockpitMap.map.getContainer().style.cursor = 'crosshair';

        this._mapTapHandler = async (e) => {
            const { lat, lng } = e.latlng;
            // Find nearest airport within 5nm
            try {
                const nearby = await this.nasrDb.getAirportsNear(lat, lng, 5);
                if (nearby.length > 0) {
                    nearby.sort((a, b) =>
                        CockpitMap._distNm(lat, lng, a.lat, a.lon) -
                        CockpitMap._distNm(lat, lng, b.lat, b.lon)
                    );
                    const apt = nearby[0];
                    const idx = this._insertIndex >= 0 ? this._insertIndex : this._waypoints.length;
                    this._addWaypoint({
                        icao: apt.icao, name: apt.name || apt.icao,
                        lat: apt.lat, lon: apt.lon, alt: this._altitude,
                        type: 'APT',
                    }, idx);
                } else {
                    // Add as lat/lon waypoint
                    const idx = this._insertIndex >= 0 ? this._insertIndex : this._waypoints.length;
                    this._addWaypoint({
                        icao: `${lat.toFixed(2)}/${lng.toFixed(2)}`,
                        name: `${lat.toFixed(2)}/${lng.toFixed(2)}`,
                        lat, lon: lng, alt: this._altitude,
                        type: 'GPS',
                    }, idx);
                }
            } catch {
                // Fallback: add as lat/lon
                const idx = this._insertIndex >= 0 ? this._insertIndex : this._waypoints.length;
                this._addWaypoint({
                    icao: `${lat.toFixed(2)}/${lng.toFixed(2)}`,
                    name: `${lat.toFixed(2)}/${lng.toFixed(2)}`,
                    lat, lon: lng, alt: this._altitude,
                    type: 'GPS',
                }, idx);
            }
            this._disableMapTapMode();
        };

        this.cockpitMap.map.once('click', this._mapTapHandler);
    }

    _disableMapTapMode() {
        this._mapTapMode = false;
        const btn = this._el?.querySelector('.route-editor-maptap-btn');
        if (btn) btn.classList.remove('active');
        if (this.cockpitMap?.map) {
            this.cockpitMap.map.getContainer().style.cursor = '';
            if (this._mapTapHandler) {
                this.cockpitMap.map.off('click', this._mapTapHandler);
                this._mapTapHandler = null;
            }
        }
    }

    // ========== Render Waypoints ==========

    _renderWaypoints() {
        if (!this._waypointsDiv) return;
        const sit = this.stratux?.situation;
        const plan = this._plan || {};
        const startFuel = this._getStartFuel();
        const cruiseGph = plan.cruise_gph || 7;
        const cruiseGs = plan.cruise_gs || 120;

        let fuelRemaining = startFuel;

        if (this._waypoints.length === 0) {
            this._waypointsDiv.innerHTML = '<div class="route-wp-empty">No waypoints. Search or tap NEARBY.</div>';
            return;
        }

        let html = '';
        for (let i = 0; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            const prev = i > 0 ? this._waypoints[i - 1] : null;

            let legInfo = '';
            let legDist = 0;
            if (prev) {
                legDist = CockpitMap._distNm(prev.lat, prev.lon, wp.lat, wp.lon);
                const brg = Math.round(CockpitMap._bearing(prev.lat, prev.lon, wp.lat, wp.lon));
                legInfo = `${legDist.toFixed(0)}nm ${brg}\u00b0`;

                // Fuel burn for this leg
                const gph = wp.gph || cruiseGph;
                const gs = wp.gs || cruiseGs;
                fuelRemaining -= (legDist / gs) * gph;
            }

            // Find index of last APT waypoint — that is the destination.
            // Anything after it (approach fixes, MAP point) is labeled APCH.
            let destIdx = -1;
            for (let j = this._waypoints.length - 1; j >= 0; j--) {
                if (this._waypoints[j].type === 'APT') { destIdx = j; break; }
            }
            if (destIdx < 0) destIdx = this._waypoints.length - 1;
            const roleLabel = i === 0 ? 'DEP' : i === destIdx ? 'DEST' : i > destIdx ? 'APCH' : '';
            const fuelClass = this._fuelColorClass(fuelRemaining, cruiseGph);
            const isExpanded = (i === this._expandedIndex);

            html += `
                <div class="route-wp-row${isExpanded ? ' expanded' : ''}" data-idx="${i}">
                    <div class="route-wp-main">
                        <span class="route-wp-num">${i + 1}.</span>
                        <span class="route-wp-id">${wp.icao || wp.name || '?'}</span>
                        <span class="route-wp-name">${wp.name && wp.name !== wp.icao ? wp.name : ''}</span>
                        <span class="route-wp-leg">${roleLabel || legInfo}</span>
                        <span class="route-wp-fuel ${fuelClass}">${i > 0 ? fuelRemaining.toFixed(1) + ' gal' : startFuel.toFixed(1) + ' gal'}</span>
                        <button class="route-wp-remove" data-idx="${i}" title="Remove">&times;</button>
                    </div>
                    ${isExpanded ? `
                    <div class="route-wp-actions">
                        <button class="btn btn-secondary route-wp-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>&#9650; Up</button>
                        <button class="btn btn-secondary route-wp-down" data-idx="${i}" ${i === this._waypoints.length - 1 ? 'disabled' : ''}>&#9660; Down</button>
                    </div>
                    <div class="route-wp-alt-row">
                        <label class="route-wp-alt-label">ALT</label>
                        <input type="number" class="route-wp-alt-input" data-idx="${i}"
                            value="${wp.altLocked ? wp.alt : this._altitude}"
                            placeholder="${this._altitude}" step="500" min="0" max="45000">
                        <span class="route-wp-alt-unit">ft</span>
                        ${wp.altLocked ? `<button class="route-wp-alt-unlock" data-idx="${i}" title="Use cruise altitude">&#128274;</button>` : ''}
                    </div>
                    <div class="route-wp-crossing-row">
                        <label class="route-wp-alt-label">MIN</label>
                        <input type="number" class="route-wp-alt-min" data-idx="${i}"
                            value="${wp.alt_min || ''}" placeholder="—" step="500" min="0" max="45000">
                        <span class="route-wp-alt-unit">ft</span>
                        <label class="route-wp-alt-label" style="margin-left:8px">MAX</label>
                        <input type="number" class="route-wp-alt-max" data-idx="${i}"
                            value="${wp.alt_max || ''}" placeholder="—" step="500" min="0" max="45000">
                        <span class="route-wp-alt-unit">ft</span>
                    </div>` : ''}
                    <button class="route-wp-insert" data-idx="${i + 1}">+ insert waypoint</button>
                </div>
            `;
        }

        // Reserve time at destination
        if (this._waypoints.length > 1 && fuelRemaining > 0) {
            const reserveHours = fuelRemaining / cruiseGph;
            const reserveH = Math.floor(reserveHours);
            const reserveM = Math.round((reserveHours - reserveH) * 60);
            const fuelClass = this._fuelColorClass(fuelRemaining, cruiseGph);
            html += `<div class="route-wp-reserve ${fuelClass}">Reserve: ${reserveH}:${String(reserveM).padStart(2, '0')}</div>`;
        }

        this._waypointsDiv.innerHTML = html;

        // Attach events — use _wireTap for iPad touch reliability
        this._waypointsDiv.querySelectorAll('.route-wp-main').forEach(row => {
            this._wireTap(row, (e) => {
                if (e.target?.classList?.contains('route-wp-remove')) return;
                const idx = parseInt(row.parentElement.dataset.idx);
                this._expandedIndex = (this._expandedIndex === idx) ? -1 : idx;
                this._renderWaypoints();
            });
        });

        this._waypointsDiv.querySelectorAll('.route-wp-remove').forEach(btn => {
            this._wireTap(btn, () => {
                this._removeWaypoint(parseInt(btn.dataset.idx));
            });
        });

        this._waypointsDiv.querySelectorAll('.route-wp-up').forEach(btn => {
            this._wireTap(btn, () => {
                const idx = parseInt(btn.dataset.idx);
                this._moveWaypoint(idx, idx - 1);
            });
        });

        this._waypointsDiv.querySelectorAll('.route-wp-down').forEach(btn => {
            this._wireTap(btn, () => {
                const idx = parseInt(btn.dataset.idx);
                this._moveWaypoint(idx, idx + 1);
            });
        });

        this._waypointsDiv.querySelectorAll('.route-wp-insert').forEach(btn => {
            this._wireTap(btn, () => {
                this._insertIndex = parseInt(btn.dataset.idx);
                this._searchInput.focus();
                this._searchInput.placeholder = `Insert at position ${this._insertIndex + 1}...`;
            });
        });

        // Per-waypoint altitude — locks the waypoint to a specific altitude
        this._waypointsDiv.querySelectorAll('.route-wp-alt-input').forEach(input => {
            input.addEventListener('change', () => {
                const idx = parseInt(input.dataset.idx);
                const val = parseInt(input.value);
                if (!isNaN(val) && val >= 0) {
                    this._waypoints[idx].alt = val;
                    this._waypoints[idx].altLocked = true;
                    this._applyRoute({ hide: false, toast: false });
                }
            });
        });

        this._waypointsDiv.querySelectorAll('.route-wp-alt-unlock').forEach(btn => {
            this._wireTap(btn, () => {
                const idx = parseInt(btn.dataset.idx);
                this._waypoints[idx].altLocked = false;
                this._waypoints[idx].alt = this._altitude;
                this._applyRoute({ hide: false, toast: false });
            });
        });

        // Min/max crossing altitudes
        this._waypointsDiv.querySelectorAll('.route-wp-alt-min').forEach(input => {
            input.addEventListener('change', () => {
                const idx = parseInt(input.dataset.idx);
                const val = parseInt(input.value);
                this._waypoints[idx].alt_min = (!isNaN(val) && val > 0) ? val : null;
                this._applyRoute({ hide: false, toast: false });
            });
        });

        this._waypointsDiv.querySelectorAll('.route-wp-alt-max').forEach(input => {
            input.addEventListener('change', () => {
                const idx = parseInt(input.dataset.idx);
                const val = parseInt(input.value);
                this._waypoints[idx].alt_max = (!isNaN(val) && val > 0) ? val : null;
                this._applyRoute({ hide: false, toast: false });
            });
        });
    }

    _getStartFuel() {
        // Try live engine data first (only if fresh)
        const _engFuel = app?.enginePanel?.lastData;
        const _fuelVal = _engFuel?.fuel_remaining_gal ?? _engFuel?.Gallons_Rem;
        if (_fuelVal && _fuelVal > 0) {
            const age = Date.now() - (app.enginePanel.lastPollTime || 0);
            if (age < 10000) return _fuelVal;
        }
        // Fall back to FuelState (tic marks, manual override, etc.)
        if (typeof FuelState !== 'undefined') {
            const fs = FuelState.getStartFuel();
            if (fs && fs.gallons > 0) return fs.gallons;
        }
        // Fall back to plan
        return this._plan?.fuel_gal || 36;
    }

    _fuelColorClass(fuelRemaining, gph) {
        if (!gph || gph <= 0) return 'fuel-green'; // no burn rate data — don't alarm
        const hoursRemaining = fuelRemaining / gph;
        if (hoursRemaining < 0.5) return 'fuel-red';
        if (hoursRemaining < 1.0) return 'fuel-yellow';
        return 'fuel-green';
    }

    // ========== Search ==========

    _onSearchInput() {
        clearTimeout(this._searchDebounce);
        const q = this._searchInput.value.trim();
        if (q.length < 2) {
            this._resultsDiv.hidden = true;
            this._resultsDiv.innerHTML = '';
            return;
        }
        // Route string mode: space-separated tokens (e.g. "KLKR V54 GSP KMEB")
        if (q.includes(' ')) {
            this._searchDebounce = setTimeout(() => this._parseRouteString(q), 300);
            return;
        }
        this._searchDebounce = setTimeout(() => this._doSearch(q), 200);
    }

    _isAirwayToken(token) {
        // Victor, Jet, RNAV T/Q airways: V54, J80, T295, Q900, V23A, etc.
        if (/^[VJTQ]\d+[A-Z]?$/i.test(token)) return true;
        // Routing keywords used in filed plans (not waypoints)
        const SKIP = new Set(['DCT', 'DIRECT', 'IFR', 'VFR', 'SID', 'STAR']);
        return SKIP.has(token.toUpperCase());
    }

    _dbLookup(promise) {
        // Wrap a nasrDb call with a 2s timeout so a blocked IDB transaction
        // fails fast rather than hanging the entire route parse.
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('idb timeout')), 2000)),
        ]);
    }

    async _resolveToken(token) {
        const t = token.toUpperCase();
        try {
            // 1. Exact 4-char ICAO airport (KLKR, KMEB, KSAV — user typed full ICAO)
            if (t.length === 4 || t.length > 4) {
                const apt = await this._dbLookup(this.nasrDb.getAirport(t));
                if (apt) return { icao: apt.icao, name: apt.name, lat: apt.lat, lon: apt.lon, type: 'APT' };
            }
        } catch {}
        try {
            // 2. Navaid before K-prefix airport — 3-char tokens like SAV/ORF/SGJ are
            //    almost always VORTACs in a route string, not airports
            const nav = await this._dbLookup(this.nasrDb.getNavaid(t));
            if (nav) return { icao: nav.id, name: nav.name, lat: nav.lat, lon: nav.lon, type: nav.type || 'VOR' };
        } catch {}
        try {
            // 3. Fix
            const fix = await this._dbLookup(this.nasrDb.getFix(t));
            if (fix) return { icao: fix.id, name: fix.id, lat: fix.lat, lon: fix.lon, type: 'FIX' };
        } catch {}
        try {
            // 4. K-prefixed airport fallback (LKR → KLKR, MMT → KMMT)
            if (t.length <= 3 && !t.startsWith('K')) {
                const apt = await this._dbLookup(this.nasrDb.getAirport('K' + t));
                if (apt) return { icao: apt.icao, name: apt.name, lat: apt.lat, lon: apt.lon, type: 'APT' };
            }
        } catch {}
        try {
            // 5. Exact airport (any length, last resort)
            const apt = await this._dbLookup(this.nasrDb.getAirport(t));
            if (apt) return { icao: apt.icao, name: apt.name, lat: apt.lat, lon: apt.lon, type: 'APT' };
        } catch {}
        return null;
    }

    async _parseRouteString(str) {
        const seq = ++this._parseSeq;
        const tokens = str.trim().split(/\s+/);

        // Show "Parsing..." immediately so user knows something is happening
        this._resultsDiv.hidden = false;
        this._resultsDiv.innerHTML = '<div class="route-search-empty">Parsing route...</div>';

        // Separate airway tokens from waypoint tokens (preserve order)
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
        if (seq !== this._parseSeq) return; // newer parse superseded this one

        // If nothing resolved (DB was likely blocked), wait and retry once
        if (resolved.length === 0 && unresolved.length > 0) {
            this._resultsDiv.innerHTML = '<div class="route-search-empty">Retrying...</div>';
            await new Promise(r => setTimeout(r, 1500));
            if (seq !== this._parseSeq) return;
            ({ resolved, unresolved } = await doResolve());
            if (seq !== this._parseSeq) return;
        }

        this._showRoutePreview(resolved, unresolved);
    }

    _showRoutePreview(resolved, unresolved) {
        this._resultsDiv.hidden = false;

        const chips = resolved.map(wp =>
            `<span class="route-token-ok">${wp.icao}</span>`
        ).join('<span class="route-token-arrow">→</span>');

        const warnHtml = unresolved.length > 0
            ? `<div class="route-token-warn">Not found: ${unresolved.map(t => `<span class="route-token-bad">${t}</span>`).join(' ')}</div>`
            : '';

        this._resultsDiv.innerHTML = `
            <div class="route-parse-preview">
                <div class="route-parse-chips">${chips || '<span class="route-search-empty">Nothing resolved</span>'}</div>
                ${warnHtml}
                ${resolved.length > 0 ? `<button class="btn btn-primary route-parse-apply">LOAD ${resolved.length} WAYPOINTS</button>` : ''}
            </div>
        `;

        const applyBtn = this._resultsDiv.querySelector('.route-parse-apply');
        if (applyBtn) {
            this._wireTap(applyBtn, () => {
                this._pushUndo();
                this._waypoints = resolved.map(wp => ({ ...wp, alt: this._altitude }));
                this._insertIndex = -1;
                this._expandedIndex = -1;
                this._renderWaypoints();
                this._clearSearch();
                this._applyRoute();
            });
        }
    }

    async _doSearch(query) {
        if (!this.nasrDb) return;
        try {
            const results = await this.nasrDb.searchAll(query);
            this._renderSearchResults(results.airports || [], results.navaids || [], results.fixes || [], query);
        } catch (err) {
            console.warn('[RouteEditor] Search error:', err);
            this._resultsDiv.hidden = false;
            this._resultsDiv.innerHTML = '<div class="route-search-empty">Airport database not available</div>';
        }
    }

    _renderSearchResults(airports, navaids, fixes, query = '') {
        const q = query.toUpperCase();
        const sit = this.stratux?.situation;
        const results = [];

        for (const a of airports) {
            const dist = sit?.lat ? CockpitMap._distNm(sit.lat, sit.lon, a.lat, a.lon) : null;
            results.push({ type: 'APT', id: a.icao, name: a.name, lat: a.lat, lon: a.lon, dist });
        }
        for (const n of navaids) {
            const dist = sit?.lat ? CockpitMap._distNm(sit.lat, sit.lon, n.lat, n.lon) : null;
            results.push({ type: n.type || 'NAV', id: n.id, name: n.name, lat: n.lat, lon: n.lon, dist });
        }
        for (const f of fixes) {
            const dist = sit?.lat ? CockpitMap._distNm(sit.lat, sit.lon, f.lat, f.lon) : null;
            results.push({ type: 'FIX', id: f.id, name: '', lat: f.lat, lon: f.lon, dist });
        }

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

        const limited = results.slice(0, 10);
        this._resultsDiv.hidden = limited.length === 0;
        this._resultsDiv.innerHTML = limited.map(r => `
            <button class="route-search-result" data-lat="${r.lat}" data-lon="${r.lon}" data-id="${r.id}" data-name="${r.name || r.id}" data-type="${r.type}">
                <span class="result-type">${r.type}</span>
                <span class="result-id">${r.id}</span>
                <span class="result-name">${r.name || ''}</span>
                <span class="result-dist">${r.dist != null ? r.dist.toFixed(0) + 'nm' : ''}</span>
            </button>
        `).join('');

        this._resultsDiv.querySelectorAll('.route-search-result').forEach(btn => {
            this._wireTap(btn, () => {
                const idx = this._insertIndex >= 0 ? this._insertIndex : this._waypoints.length;
                this._addWaypoint({
                    icao: btn.dataset.id,
                    name: btn.dataset.name || btn.dataset.id,
                    lat: parseFloat(btn.dataset.lat),
                    lon: parseFloat(btn.dataset.lon),
                    type: btn.dataset.type || undefined,
                }, idx);
                this._clearSearch();
            });
        });
    }

    _clearSearch() {
        if (this._searchInput) this._searchInput.value = '';
        if (this._resultsDiv) {
            this._resultsDiv.hidden = true;
            this._resultsDiv.innerHTML = '';
        }
        this._insertIndex = -1;
        if (this._searchInput) this._searchInput.placeholder = 'Search ICAO or name...';
    }

    async _showNearby() {
        const sit = this.stratux?.situation;
        if (!sit?.lat) {
            this._resultsDiv.hidden = false;
            this._resultsDiv.innerHTML = '<div class="route-search-empty">No GPS position</div>';
            return;
        }
        try {
            const airports = await this.nasrDb.getAirportsNear(sit.lat, sit.lon, 30);
            airports.sort((a, b) =>
                CockpitMap._distNm(sit.lat, sit.lon, a.lat, a.lon) -
                CockpitMap._distNm(sit.lat, sit.lon, b.lat, b.lon)
            );
            this._renderSearchResults(airports.slice(0, 10), [], [], '');
        } catch (err) {
            console.warn('[RouteEditor] Nearby error:', err);
            this._resultsDiv.hidden = false;
            this._resultsDiv.innerHTML = '<div class="route-search-empty">Airport database not available</div>';
        }
    }

    /** Wire touchstart + click with debounce for iPad reliability */
    _wireTap(el, handler) {
        if (!el) return;
        let startX = 0, startY = 0, isTap = false, touchUsed = false;
        el.addEventListener('touchstart', (e) => {
            const t = e.touches[0];
            startX = t.clientX;
            startY = t.clientY;
            isTap = true;
        }, { passive: true });
        el.addEventListener('touchmove', (e) => {
            if (!isTap) return;
            const t = e.touches[0];
            if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
                isTap = false;
            }
        }, { passive: true });
        el.addEventListener('touchend', (e) => {
            if (isTap) {
                e.stopPropagation();
                touchUsed = true;
                handler(e);
                setTimeout(() => { touchUsed = false; }, 400);
            }
            isTap = false;
        });
        el.addEventListener('click', (e) => {
            if (!touchUsed) handler(e);
        });
    }

    // ========== Apply / Persist ==========

    async _applyRoute({ hide = true, toast = true } = {}) {
        if (this._waypoints.length === 0) {
            if (typeof app !== 'undefined') app.showToast('Add at least one waypoint', 'amber');
            return;
        }

        // Build legs with course/distance
        const wps = this._waypoints.map((wp, i) => {
            const result = { ...wp, alt: wp.altLocked ? wp.alt : this._altitude };
            if (i > 0) {
                const prev = this._waypoints[i - 1];
                result._legDist = CockpitMap._distNm(prev.lat, prev.lon, wp.lat, wp.lon);
                result._legCourse = Math.round(CockpitMap._bearing(prev.lat, prev.lon, wp.lat, wp.lon));
            }
            return result;
        });

        // Determine destination airport: last waypoint with type='APT'.
        // type is set authoritatively by _applyPlan via NASR lookup, so all airport
        // waypoints carry it regardless of their ICAO format (KLKR, 28A, 7A5, etc.).
        let destIcao = '';
        for (let i = wps.length - 1; i >= 0; i--) {
            if (wps[i].type === 'APT') { destIcao = wps[i].icao; break; }
        }
        if (!destIcao) destIcao = wps[wps.length - 1]?.icao || '';

        // Build updated plan — rebuild route/legs cleanly to avoid stale leg data
        const plan = {
            ...(this._plan || {}),
            departure: wps[0]?.icao || '',
            destination: destIcao,
            cruise_altitude: this._altitude,
            waypoints: wps,
            flight_plan: {
                ...(this._plan?.flight_plan || {}),
                departure: wps[0]?.icao || '',
                destination: destIcao,
                cruise_altitude: this._altitude,
                route: wps.map(w => w.icao || w.name).filter(Boolean),
                legs: [],  // cleared — route-table will rebuild via _buildMissingSegments + FIS-B winds
            },
        };

        // Apply to app
        if (typeof app !== 'undefined') {
            app.applyRouteEdit(plan);
        }

        // Toast
        if (toast) {
            const routeStr = wps.map(w => w.icao || w.name).join(' \u2192 ');
            if (typeof app !== 'undefined') {
                app.showToast(`Route updated: ${routeStr}`);
            }
        }

        if (hide) this.hide();
    }
}
