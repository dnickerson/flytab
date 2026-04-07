/**
 * FlyPi — Vector Map Layers
 * Renders NASR data + geographic context on a dark background.
 * Manages airspace, airports, navaids, fixes, airways as togglable layer groups.
 */

class VectorMapLayers {
    constructor(map, nasrDb) {
        this._map = map;
        this._nasr = nasrDb;
        this._geoData = null;
        this._updateTimer = null;

        // Layer groups
        this._geoLayer = L.layerGroup();           // static geographic context
        this._airspaceLayer = L.layerGroup();
        this._suaLayer = L.layerGroup();           // special use airspace (R/P/W/A/MOA)
        this._airportLayer = L.layerGroup();
        this._navaidLayer = L.layerGroup();
        this._fixLayer = L.layerGroup();
        this._airwayLayer = L.layerGroup();
        this._wxDotsLayer = L.layerGroup();        // flight category solid dots — on top of airport icons
        this._wxLabelLayer = L.layerGroup();       // weather text labels (ceil/vis/wind)

        // Canvas renderer for circle markers (performance)
        this._canvasRenderer = L.canvas({ padding: 0.5 });

        // Track current markers for diffing
        this._airspacePolygons = new Map();
        this._suaPolygons = new Map();
        this._wxDotMarkers = new Map();    // icao → wx dot marker
        this._wxLabelMarkers = new Map();  // icao → wx label marker
        this._aptPositions = new Map();    // icao → {lat, lon, tower} — drives wx dots, independent of airport layer
        this._airportMarkers = new Map();
        this._navaidMarkers = new Map();
        this._fixMarkers = new Map();
        this._airwayLines = new Map();

        // Click callbacks
        this._onAirportClick = null;
        this._onNavaidClick = null;
        this._onFixClick = null;
        this._onTrafficTap = null; // fallback for traffic markers (from CockpitMap)

        // FIS-B client (for wx dots/labels)
        this._fisbClient = null;

        // Internet-sourced METARs (pre-flight, when online). Same shape as fisbClient.metars entries.
        // FIS-B always takes priority over internet data when both are present.
        this._internetMetars = new Map();
        this._internetFetchedAt = 0;       // ms timestamp of last successful fetch
        this._internetFetchBounds = null;  // {south,west,north,east} of last fetch
        this._onInternetMetar = null;      // callback(icao, entry) — used by airport popup live refresh
        this._onInternetMetarsFetched = null; // callback() — fired after each successful batch fetch

        // Clear the fetch cache when internet reconnects so weather refreshes immediately
        window.addEventListener('online', () => { this._internetFetchedAt = 0; });

        // Refresh internet METARs every 10 minutes even when map is stationary
        setInterval(() => { this._internetFetchedAt = 0; this._scheduleUpdate(); }, 10 * 60 * 1000);

        // Route waypoint ICAOs — suppress duplicate airport labels for these
        this._routeIcaos = new Set();

        // Weather label visibility flags
        this._showCeil = false;
        this._showVis  = false;
        this._showWind = false;
        this._showTemp = false;

        // Debounced update on map movement
        this._map.on('moveend zoomend', () => this._scheduleUpdate());

        // Mouse click: use Leaflet's map click (reliable on desktop)
        this._map.on('click', (e) => this._onMapClick(e));

        // Touch tap: bypass Leaflet entirely. Leaflet's drag handler eats
        // most single-finger taps on iPad (finger jitter > draggable threshold).
        // We track touchstart/touchend ourselves and fire a synthetic tap
        // if the finger didn't move more than TAP_TOLERANCE pixels.
        //
        // IMPORTANT: use { capture: true } on touchstart so we record the tap position
        // in the capture phase, before Leaflet's disableClickPropagation (added to SVG
        // airport/navaid markers via bubblingMouseEvents:false) calls stopPropagation
        // on the bubble phase and prevents _tapStart from ever being set.
        this._tapStart = null;
        const container = this._map.getContainer();
        container.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                this._tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
            } else {
                this._tapStart = null; // multi-finger = pinch/zoom, not tap
            }
        }, { capture: true, passive: true });
        container.addEventListener('touchend', (e) => {
            if (!this._tapStart) return;
            const ts = this._tapStart;
            this._tapStart = null;
            if (e.changedTouches.length !== 1) return;
            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const dx = endX - ts.x, dy = endY - ts.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const elapsed = Date.now() - ts.t;
            if (dist < 20 && elapsed < 500) {
                const rect = container.getBoundingClientRect();
                const pt = L.point(endX - rect.left, endY - rect.top);
                const latlng = this._map.containerPointToLatLng(pt);
                this._onMapClick({ latlng });
            }
        }, { passive: true });
    }

    /**
     * Initialize: load geo context and add default layers.
     */
    init() {
        // Synchronously add all layer groups to map — map renders immediately
        const overlays = CockpitConfig.get('map.overlays');
        if (overlays.airspace?.enabled !== false) this._airspaceLayer.addTo(this._map);
        // For airports/navaids/airways: use persisted setting if the user has explicitly toggled it,
        // otherwise fall back to CockpitConfig overlay defaults.
        // Settings.get() returns the stored value OR the DEFAULTS entry — using raw localStorage
        // so we can distinguish "never set" (null) from an explicit false.
        const aptUserSet = localStorage.getItem('flypi_show_airports');
        const aptEnabled = aptUserSet !== null ? JSON.parse(aptUserSet) : (overlays.airports?.enabled !== false);
        if (aptEnabled) this._airportLayer.addTo(this._map);
        // Wx dots and labels added AFTER airport layer — render on top of airport circles.
        // Always add unconditionally; toggleWxDots() handles hide/show during the session.
        this._wxDotsLayer.addTo(this._map);
        this._wxLabelLayer.addTo(this._map);
        const navUserSet = localStorage.getItem('flypi_show_navaids');
        const navEnabled = navUserSet !== null ? JSON.parse(navUserSet) : (overlays.navaids?.enabled !== false);
        if (navEnabled) this._navaidLayer.addTo(this._map);
        if (overlays.fixes?.enabled) this._fixLayer.addTo(this._map);
        // Airways: use persisted setting if user has toggled, otherwise cockpit-config default
        const awyUserSet = localStorage.getItem('flypi_show_airways');
        if (awyUserSet !== null ? JSON.parse(awyUserSet) : overlays.airways?.enabled) this._airwayLayer.addTo(this._map);
        // SUA (Restricted/MOA): default off — pilot opts in
        const suaUserSet = localStorage.getItem('flypi_show_sua');
        if (suaUserSet !== null ? JSON.parse(suaUserSet) : overlays.sua?.enabled) this._suaLayer.addTo(this._map);
        this._geoLayer.addTo(this._map);

        // Load data in background — does NOT block cockpit render
        this._loadGeoContext()
            .then(() => this._renderGeoContext())
            .catch(() => {});
        this._updateDynamicLayers().catch(() => {});
    }

    /**
     * Set vector-mode background (warm cream for sunlight readability).
     */
    enableDarkBackground() {
        this._map.getContainer().style.background = '#F0EBD8';
    }

    /**
     * Remove vector background (when switching to sectional tiles).
     */
    disableDarkBackground() {
        this._map.getContainer().style.background = '';
    }

    /**
     * Force-clear airport markers so the next map move re-renders with current filters.
     * Called by LayerPanel when airportFilter config changes.
     */
    _forceAirportRefresh() {
        this._clearLayer(this._airportLayer, this._airportMarkers);
        this._clearLayer(this._wxDotsLayer, this._wxDotMarkers);
        this._clearLayer(this._wxLabelLayer, this._wxLabelMarkers);
        // Trigger a re-render by firing the existing update pipeline
        if (this._lastBounds) {
            const { south, west, north, east, zoom, overlays } = this._lastBounds;
            this._updateAirports(south, west, north, east, zoom, overlays);
        }
    }

    /**
     * Set callback for airport marker clicks.
     */
    onAirportClick(callback) {
        this._onAirportClick = callback;
    }

    /**
     * Set callback for navaid marker clicks.
     */
    onNavaidClick(callback) {
        this._onNavaidClick = callback;
    }

    /**
     * Set callback for fix marker clicks.
     */
    onFixClick(callback) {
        this._onFixClick = callback;
    }

    /**
     * Set route waypoint ICAOs so airport labels are suppressed for route waypoints
     * (the route layer already draws its own labels).
     */
    setRouteIcaos(icaos) {
        this._routeIcaos = new Set(icaos);
        this._scheduleUpdate();
    }

    /**
     * Wire up FIS-B client for flight category dot overlay.
     * Called from app.js after fisbClient is initialized.
     */
    setFisbClient(client) {
        this._fisbClient = client;
        client.addEventListener('fisb:metar', (e) => {
            const { icao, decoded } = e.detail;
            this._upsertWxDot(icao, decoded?.flight_category);
            this._upsertWxLabel(icao);
        });
    }

    /**
     * Refresh all wx dots from fisbClient.metars or a weather cache object.
     * @param {Object} [wxCache] — optional {[icao]: {decoded: {flight_category}}}
     */
    refreshWeatherColors(wxCache) {
        for (const [icao] of this._aptPositions) {
            const cat = this._getMetarEntry(icao)?.decoded?.flight_category
                     || wxCache?.[icao]?.decoded?.flight_category;
            this._upsertWxDot(icao, cat);
        }
    }

    /** Show/hide/toggle the flight category dot overlay. */
    showWxDots()   { if (!this._map.hasLayer(this._wxDotsLayer)) this._wxDotsLayer.addTo(this._map); }
    hideWxDots()   { if (this._map.hasLayer(this._wxDotsLayer)) this._map.removeLayer(this._wxDotsLayer); }
    toggleWxDots() {
        if (this._map.hasLayer(this._wxDotsLayer)) { this._map.removeLayer(this._wxDotsLayer); return false; }
        this._wxDotsLayer.addTo(this._map); return true;
    }
    get wxDotsVisible() { return this._map.hasLayer(this._wxDotsLayer); }

    /**
     * Unified METAR entry lookup: FIS-B takes priority (live), internet is fallback (cached).
     * Returns an object with { raw, decoded: { flight_category, visibility_sm, ceiling_ft,
     * wind_dir, wind_speed, wind_gust, temperature_c, dewpoint_c } } or null.
     */
    _getMetarEntry(icao) {
        return this._fisbClient?.metars.get(icao) || this._internetMetars.get(icao) || null;
    }

    /**
     * Fetch METARs from the Pi's internet proxy for the current viewport bounds.
     * No-ops if data is < 15 min old for the same approximate area, or if offline.
     * Stores results in _internetMetars and updates all visible dots.
     */
    async fetchInternetMetars(south, west, north, east) {
        if (!navigator.onLine) return;
        const AGE_MS = 15 * 60 * 1000;
        const now = Date.now();
        // Skip if last fetch was recent and covers roughly the same area
        if (now - this._internetFetchedAt < AGE_MS && this._internetFetchBounds) {
            const b = this._internetFetchBounds;
            if (south >= b.south - 1 && north <= b.north + 1 &&
                west >= b.west - 1 && east <= b.east + 1) return;
        }
        try {
            const bbox = `${south.toFixed(2)},${west.toFixed(2)},${north.toFixed(2)},${east.toFixed(2)}`;
            // Proxy through flywhere.app (Vercel) to bypass CORS on aviationweather.gov
            const url = `https://www.flywhere.app/api/weather?type=metar&bbox=${bbox}&format=json&hours=2`;
            const r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) return;
            const data = await r.json();
            const catMap = { VFR: 'VFR', MVFR: 'MVFR', IFR: 'IFR', LIFR: 'LIFR' };
            for (const obs of (Array.isArray(data) ? data : [])) {
                const icao = (obs.icaoId || obs.stationId || '').toUpperCase();
                if (!icao) continue;
                // fltCat (capital C), ceiling from lowest BKN/OVC layer in feet (FEW/SCT are not ceiling)
                const flight_category = catMap[(obs.fltCat || '').toUpperCase()] || null;
                const ceilCloud = obs.clouds?.find(c => c.cover === 'BKN' || c.cover === 'OVC');
                const ceiling_ft = ceilCloud?.base ?? null;
                // obs.obsTime is Unix seconds from AWC API — convert to ISO for age display
                const observed_at = obs.obsTime ? new Date(obs.obsTime * 1000).toISOString() : null;
                this._internetMetars.set(icao, {
                    raw: obs.rawOb || '',
                    decoded: {
                        flight_category,
                        visibility_sm: obs.visib,
                        ceiling_ft,
                        wind_dir: (obs.wdir === 'VRB' || obs.wdir == null) ? null : obs.wdir,
                        wind_variable: obs.wdir === 'VRB',
                        wind_speed: obs.wspd,
                        wind_gust: obs.wgst,
                        temperature_c: obs.temp,
                        dewpoint_c: obs.dewp,
                        altimeter: obs.altim,
                        observed_at,  // actual observation time, not fetch time
                    },
                    received_at: now,
                    source: 'internet',
                });
                // Update dot if position is known for this airport
                if (this._aptPositions.has(icao)) {
                    const cat = this._fisbClient?.metars.get(icao)?.decoded?.flight_category
                             || flight_category;
                    this._upsertWxDot(icao, cat);
                    this._upsertWxLabel(icao);
                }
                // Notify open popup so it can live-refresh if FIS-B isn't active
                if (this._onInternetMetar) this._onInternetMetar(icao, this._internetMetars.get(icao));
                // Persist to IndexedDB so data-status weather cache can show them
                if (this._nasr) {
                    const entry = this._internetMetars.get(icao);
                    this._nasr.putWeather(icao, {
                        metar: { raw: entry.raw, decoded: entry.decoded, fetched_at: new Date(now).toISOString() },
                        taf: null,
                        fetched_at: new Date(now).toISOString(),
                        source: 'internet',
                    }).catch(() => {});
                }
            }
            this._internetFetchedAt = now;
            this._internetFetchBounds = { south, west, north, east };
            if (this._onInternetMetarsFetched) this._onInternetMetarsFetched();
        } catch { /* offline — silently skip */ }
    }

    /** Add or update a solid flight category dot on top of the airport circle. */
    _upsertWxDot(icao, cat) {
        const color = this._catColor(cat);
        const pos = this._aptPositions.get(icao);

        const existing = this._wxDotMarkers.get(icao);
        if (existing) { this._wxDotsLayer.removeLayer(existing); this._wxDotMarkers.delete(icao); }

        if (!color || !pos) return;

        const dot = L.circleMarker([pos.lat, pos.lon], {
            radius: pos.tower ? 7 : 5,
            color: '#000',
            weight: 1,
            fillColor: color,
            fillOpacity: 1.0,
            interactive: false,  // clicks fall through to airport marker
        });
        dot.addTo(this._wxDotsLayer);
        this._wxDotMarkers.set(icao, dot);
    }

    /** Map flight category to hex color. */
    _catColor(cat) {
        switch (cat) {
            case 'VFR':  return '#00ff88';
            case 'MVFR': return '#00aaff';
            case 'IFR':  return '#ff4444';
            case 'LIFR': return '#ff44ff';
            default:     return null;
        }
    }

    // ── Weather Text Labels (ceil / vis / wind) ────────────────────────────────

    /** Toggle ceiling+sky label layer. Returns new state (true=visible). */
    toggleCeil() { this._showCeil = !this._showCeil; this._refreshWxLabels(); return this._showCeil; }
    /** Toggle visibility label layer. Returns new state. */
    toggleVis()  { this._showVis  = !this._showVis;  this._refreshWxLabels(); return this._showVis; }
    /** Toggle surface wind label layer. Returns new state. */
    toggleWind() { this._showWind = !this._showWind; this._refreshWxLabels(); return this._showWind; }
    /** Toggle temperature/dewpoint label layer. Returns new state. */
    toggleTemp() { this._showTemp = !this._showTemp; this._refreshWxLabels(); return this._showTemp; }

    get ceilVisible() { return this._showCeil; }
    get visVisible()  { return this._showVis; }
    get windVisible() { return this._showWind; }
    get tempVisible() { return this._showTemp; }

    /** Re-render all wx label markers (called when a label layer is toggled). */
    _refreshWxLabels() {
        for (const [icao] of this._aptPositions) {
            this._upsertWxLabel(icao);
        }
    }

    /**
     * Build or remove the stacked weather text label for an airport.
     * Only renders rows that are both enabled (flag) and have data.
     */
    _upsertWxLabel(icao) {
        // Remove existing label
        const existing = this._wxLabelMarkers.get(icao);
        if (existing) { this._wxLabelLayer.removeLayer(existing); this._wxLabelMarkers.delete(icao); }

        if (!this._showCeil && !this._showVis && !this._showWind && !this._showTemp) return;

        const pos = this._aptPositions.get(icao);
        if (!pos) return;

        const entry = this._getMetarEntry(icao);
        if (!entry) return;

        const { decoded, raw } = entry;
        let html = '';

        if (this._showCeil) {
            const skyLabel = this._parseSkyLabel(raw);
            if (skyLabel) {
                const cat = decoded?.flight_category;
                const color = this._catColor(cat) || '#ffffff';
                html += `<div class="wx-lbl-ceil" style="color:${color}">${skyLabel}</div>`;
            }
        }

        const visSm = decoded?.visibility_sm ?? decoded?.visibility ?? null;
        if (this._showVis && visSm != null) {
            const txt = decoded.visibility_plus ? `>${visSm}SM` : `${visSm}SM`;
            html += `<div class="wx-lbl-vis">${txt}</div>`;
        }

        if (this._showWind && decoded?.wind_speed != null) {
            const dir = decoded.wind_dir != null ? String(decoded.wind_dir).padStart(3, '0') : 'VRB';
            const spd = String(decoded.wind_speed).padStart(2, '0');
            const gust = decoded.wind_gust ? `G${decoded.wind_gust}` : '';
            html += `<div class="wx-lbl-wind">${dir}/${spd}${gust}</div>`;
        }

        if (this._showTemp) {
            const t = decoded?.temp_c ?? decoded?.temperature_c ?? decoded?.temperature ?? null;
            const dew = decoded?.dewpoint_c ?? decoded?.dewpoint ?? null;
            if (t != null) {
                const dewStr = dew != null ? `/${Math.round(dew)}` : '';
                html += `<div class="wx-lbl-temp">${Math.round(t)}${dewStr}°C</div>`;
            }
        }

        if (!html) return;

        const icon = L.divIcon({
            className: 'wx-label-stack',
            html,
            iconAnchor: [0, 8],   // left edge at airport, vertically centered
        });

        const marker = L.marker([pos.lat, pos.lon], { icon, interactive: false, zIndexOffset: 50 });
        marker.addTo(this._wxLabelLayer);
        this._wxLabelMarkers.set(icao, marker);
    }

    /**
     * Parse raw METAR for the lowest sky layer.
     * Returns e.g. "BKN030", "OVC004", "SCT025", or null for SKC/CLR.
     */
    _parseSkyLabel(raw) {
        if (!raw) return null;
        const layers = [...raw.matchAll(/\b(FEW|SCT|BKN|OVC|VV)(\d{3})\b/g)];
        if (!layers.length) return null;
        // Find lowest altitude layer
        let lowestHt = Infinity, lowestLabel = null;
        for (const m of layers) {
            const ht = parseInt(m[2]) * 100;
            if (ht < lowestHt) { lowestHt = ht; lowestLabel = m[1] + m[2]; }
        }
        return lowestLabel;
    }

    _getLayerMap() {
        return {
            airspace: this._airspaceLayer,
            sua: this._suaLayer,
            airports: this._airportLayer,
            navaids: this._navaidLayer,
            fixes: this._fixLayer,
            airways: this._airwayLayer,
            geo: this._geoLayer,
        };
    }

    /** Show a named layer (add to map if not already visible). */
    show(layerName) {
        const layer = this._getLayerMap()[layerName];
        if (!layer) return;
        if (!this._map.hasLayer(layer)) {
            layer.addTo(this._map);
            this._scheduleUpdate();
        }
    }

    /** Hide a named layer (remove from map). */
    hide(layerName) {
        const layer = this._getLayerMap()[layerName];
        if (!layer) return;
        if (this._map.hasLayer(layer)) {
            this._map.removeLayer(layer);
        }
    }

    /**
     * Toggle a layer group on/off.
     */
    toggle(layerName) {
        const layer = this._getLayerMap()[layerName];
        if (!layer) return;

        if (this._map.hasLayer(layer)) {
            this._map.removeLayer(layer);
        } else {
            layer.addTo(this._map);
            this._scheduleUpdate();
        }
    }

    /**
     * Check if a layer is currently visible.
     */
    isVisible(layerName) {
        return this._map.hasLayer(this._getLayerMap()[layerName]);
    }

    /**
     * Show layers respecting current Settings, plus geo context always.
     */
    showAll() {
        if (!this._map.hasLayer(this._geoLayer)) this._geoLayer.addTo(this._map);
        if (Settings.showAirports && !this._map.hasLayer(this._airportLayer)) this._airportLayer.addTo(this._map);
        if (Settings.showNavaids && !this._map.hasLayer(this._navaidLayer)) this._navaidLayer.addTo(this._map);
        if (Settings.showFixes && !this._map.hasLayer(this._fixLayer)) this._fixLayer.addTo(this._map);
        if (Settings.showAirways && !this._map.hasLayer(this._airwayLayer)) this._airwayLayer.addTo(this._map);
        // Airspace follows Settings if set, otherwise CockpitConfig default
        const overlays = CockpitConfig.get('map.overlays');
        if (overlays.airspace?.enabled !== false && !this._map.hasLayer(this._airspaceLayer)) {
            this._airspaceLayer.addTo(this._map);
        }
        this._scheduleUpdate();
    }

    hideAll() {
        const removeIfPresent = (layer, markerMap) => {
            if (this._map.hasLayer(layer)) {
                this._map.removeLayer(layer);
            }
            if (markerMap) {
                layer.clearLayers();
                markerMap.clear();
            }
        };
        removeIfPresent(this._geoLayer);
        removeIfPresent(this._airspaceLayer, this._airspacePolygons);
        removeIfPresent(this._airportLayer, this._airportMarkers);
        removeIfPresent(this._navaidLayer, this._navaidMarkers);
        removeIfPresent(this._fixLayer, this._fixMarkers);
        removeIfPresent(this._airwayLayer, this._airwayLines);
    }

    // ========== Internal ==========

    async _loadGeoContext() {
        // Offline-first: try IndexedDB cache, then background-refresh from network
        try {
            const cached = await this._nasr.getAppCache('geo_context');
            if (cached) {
                this._geoData = cached;
                // Background refresh — don't await
                this._refreshGeoContext();
                return;
            }
        } catch { /* IDB not ready */ }

        // No cache — fetch from network
        await this._refreshGeoContext();
    }

    async _refreshGeoContext() {
        try {
            let data = null;
            try {
                const resp = await fetch('http://localhost:9090/nasr/geo_context.json', { signal: AbortSignal.timeout(3000) });
                if (resp.ok) data = await resp.json();
            } catch { /* NanoHTTPD unavailable, try fallback */ }
            if (!data) {
                // Fall back to home server
                const homeBase = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.homeBase : null;
                if (!homeBase) return;
                const resp2 = await fetch(`${homeBase}/nasr/geo_context.json`, { signal: AbortSignal.timeout(3000) });
                if (resp2.ok) data = await resp2.json();
            }
            if (data) {
                const changed = !this._geoData;
                this._geoData = data;
                this._nasr.putAppCache('geo_context', data).catch(() => {});
                if (changed) this._renderGeoContext();
            }
        } catch {
            if (!this._geoData) console.warn('VectorMapLayers: could not load geo_context.json');
        }
    }

    _renderGeoContext() {
        if (!this._geoData) return;
        const styles = CockpitConfig.get('geoStyles');

        // State boundaries
        if (this._geoData.state_boundaries) {
            for (const line of this._geoData.state_boundaries) {
                L.polyline(line, {
                    color: styles.stateBoundaries?.color || '#8B8378',
                    weight: styles.stateBoundaries?.weight || 1,
                    opacity: styles.stateBoundaries?.opacity || 0.5,
                }).addTo(this._geoLayer);
            }
        }

        // Coastlines
        if (this._geoData.coastlines) {
            for (const line of this._geoData.coastlines) {
                L.polyline(line, {
                    color: styles.coastlines?.color || '#5B7B8A',
                    weight: styles.coastlines?.weight || 1.5,
                }).addTo(this._geoLayer);
            }
        }

        // Lakes/water
        if (this._geoData.lakes) {
            for (const lake of this._geoData.lakes) {
                if (lake.boundary && lake.boundary.length >= 3) {
                    L.polygon(lake.boundary, {
                        fillColor: styles.water?.fillColor || '#B8D4E8',
                        fillOpacity: styles.water?.fillOpacity || 0.6,
                        color: styles.coastlines?.color || '#5B7B8A',
                        weight: 0.5,
                    }).addTo(this._geoLayer);
                }
            }
        }
    }

    _scheduleUpdate() {
        if (this._updateTimer) clearTimeout(this._updateTimer);
        this._updateTimer = setTimeout(() => this._updateDynamicLayers(), 300);
    }

    async _updateDynamicLayers() {
        // Guard against concurrent runs: if a previous update is still in-flight,
        // schedule another pass so the latest map position is always rendered.
        if (this._updatingLayers) {
            this._scheduleUpdate();
            return;
        }
        this._updatingLayers = true;
        try {
            const zoom = this._map.getZoom();
            const bounds = this._map.getBounds();
            const south = bounds.getSouth();
            const west = bounds.getWest();
            const north = bounds.getNorth();
            const east = bounds.getEast();

            const overlays = CockpitConfig.get('map.overlays');

            // Cache bounds for _forceAirportRefresh
            this._lastBounds = { south, west, north, east, zoom, overlays };

            // Run updates in parallel
            await Promise.all([
                this._updateAirspace(south, west, north, east, zoom, overlays),
                this._updateSua(south, west, north, east, zoom),
                this._updateAirports(south, west, north, east, zoom, overlays),
                this._updateWxDots(south, west, north, east, zoom, overlays),
                this._updateNavaids(south, west, north, east, zoom, overlays),
                this._updateFixes(south, west, north, east, zoom, overlays),
                this._updateAirways(south, west, north, east, zoom, overlays),
            ]);
        } finally {
            this._updatingLayers = false;
        }
    }

    async _updateAirspace(south, west, north, east, zoom, overlays) {
        if (!this._map.hasLayer(this._airspaceLayer)) return;
        const minZoom = overlays.airspace?.minZoom || 6;
        if (zoom < minZoom) {
            this._clearLayer(this._airspaceLayer, this._airspacePolygons);
            return;
        }

        try {
            const airspaces = await this._nasr.getAirspaceInBounds(south, west, north, east);
            const currentIds = new Set();
            const styles = CockpitConfig.get('airspaceStyles');

            // Group Class B rings by airport name to find each airport's center
            const bravoGroups = new Map(); // name → [{as, latlngs}]
            for (const as of airspaces) {
                if (as.class === 'B') {
                    const name = (as.name || '').replace(/\s*Class\s*B\s*/i, '').trim();
                    if (!bravoGroups.has(name)) bravoGroups.set(name, []);
                    bravoGroups.get(name).push(as);
                }
            }

            // Find airport center for each Class B group (centroid of lowest-floor ring)
            const bravoCenters = new Map(); // name → [lat, lon]
            for (const [name, rings] of bravoGroups) {
                const sfc = rings.reduce((a, b) =>
                    (a.lower_ft ?? a.lower ?? 99999) < (b.lower_ft ?? b.lower ?? 99999) ? a : b
                );
                const boundary = sfc.boundary || sfc.points || [];
                const latlngs = boundary.map(pt => [pt[0] ?? pt.lat, pt[1] ?? pt.lon]);
                bravoCenters.set(name, VectorMapLayers._polygonCentroid(latlngs));
            }

            for (const as of airspaces) {
                currentIds.add(as.id);
                if (this._airspacePolygons.has(as.id)) continue;

                const boundary = as.boundary || as.points || [];
                if (boundary.length < 3) continue;

                const style = styles[as.class] || styles.E || {};
                const latlngs = boundary.map(pt => [pt[0] ?? pt.lat, pt[1] ?? pt.lon]);

                const polygon = L.polygon(latlngs, {
                    color: style.color || '#ff44ff',
                    weight: style.weight || 1,
                    fillOpacity: style.fillOpacity || 0.04,
                    dashArray: style.dashArray || null,
                });

                const label = `${as.name || ''} Class ${as.class || ''}`;
                const upper = as.upper_ft ?? as.upper;
                const lower = as.lower_ft ?? as.lower;
                const upperStr = (upper != null && upper <= -1000) ? 'UNL' : upper;
                const lowerStr = (lower === 0 || lower == null) ? 'SFC' : lower;
                const altRange = upper != null ? `${upperStr} - ${lowerStr} ft` : '';
                // No tooltip — sticky tooltips interfere with touch interactions on iPad

                polygon.addTo(this._airspaceLayer);

                // Sectional-style altitude label at polygon center: B: 100 / 60
                if ((as.class === 'B' || as.class === 'C' || as.class === 'D') && upper != null) {
                    const ceil = lower === 0 || lower == null
                        ? 'SFC'
                        : (lower >= 1000 ? Math.round(lower / 100) : lower);
                    const top = (upper != null && upper <= -1000) ? 'UNL'
                        : (upper >= 1000 ? Math.round(upper / 100) : upper);
                    const altHtml = `${top}<br><span class="as-alt-floor">${ceil}</span>`;

                    let labelPos;
                    if (as.class === 'B') {
                        const name = (as.name || '').replace(/\s*Class\s*B\s*/i, '').trim();
                        const aptCenter = bravoCenters.get(name) || VectorMapLayers._polygonCentroid(latlngs);
                        labelPos = VectorMapLayers._shelfLabelPosition(latlngs, aptCenter);
                    } else {
                        labelPos = VectorMapLayers._polygonCentroid(latlngs);
                    }

                    const altLabel = L.marker(labelPos, {
                        icon: L.divIcon({
                            className: `as-alt-label as-alt-${as.class.toLowerCase()}`,
                            html: altHtml,
                            iconSize: [40, 30],
                            iconAnchor: [20, 15],
                        }),
                        interactive: false,
                        zIndexOffset: -100,
                    });
                    altLabel.addTo(this._airspaceLayer);
                    this._airspacePolygons.set(as.id + '_alt', altLabel);
                }

                this._airspacePolygons.set(as.id, polygon);
            }

            // Remove out-of-view
            for (const [id, poly] of this._airspacePolygons) {
                const baseId = id.endsWith('_alt') ? id.slice(0, -4) : id;
                if (!currentIds.has(baseId)) {
                    this._airspaceLayer.removeLayer(poly);
                    this._airspacePolygons.delete(id);
                }
            }
        } catch (err) {
            console.warn('VectorMapLayers: airspace query failed', err);
        }
    }

    // SUA type → base (inactive) style
    static SUA_STYLES = {
        R:   { color: '#ff2222', fillColor: '#ff2222', fillOpacity: 0.07, weight: 1.5, dashArray: '6 3' },
        P:   { color: '#cc00cc', fillColor: '#cc00cc', fillOpacity: 0.10, weight: 2 },
        W:   { color: '#ffaa00', fillColor: '#ffaa00', fillOpacity: 0.07, weight: 1.5, dashArray: '6 3' },
        A:   { color: '#aaaaaa', fillColor: '#aaaaaa', fillOpacity: 0.06, weight: 1, dashArray: '4 4' },
        MOA: { color: '#2288ff', fillColor: '#2288ff', fillOpacity: 0.06, weight: 1.5, dashArray: '8 4' },
    };

    // Active (NOTAM-confirmed) style overrides — solid fill, no dash, heavier border
    static SUA_ACTIVE_OVERRIDES = {
        fillOpacity: 0.25,
        weight:      2.5,
        dashArray:   null,
    };

    async _updateSua(south, west, north, east, zoom) {
        if (!this._map.hasLayer(this._suaLayer)) return;
        // Only show SUA from z6 up — below that, polygons are too small to be useful
        if (zoom < 6) {
            this._clearLayer(this._suaLayer, this._suaPolygons);
            return;
        }

        // Fetch NOTAM status (cached, silent on error)
        const suaNotams = window.SuaNotams;
        if (suaNotams) {
            suaNotams.fetchForBounds(south, west, north, east).catch(() => {});
        }

        try {
            const areas = await this._nasr.getSuaInBounds(south, west, north, east);
            const currentIds = new Set();

            for (const sua of areas) {
                currentIds.add(sua.id);
                const isActive = suaNotams ? suaNotams.hasActiveNotam(sua) : false;
                const existingPoly = this._suaPolygons.get(sua.id);

                if (existingPoly) {
                    // Update style in-place if activation state changed
                    const wasActive = existingPoly._suaActive === true;
                    if (isActive !== wasActive) {
                        const base = VectorMapLayers.SUA_STYLES[sua.type] || VectorMapLayers.SUA_STYLES.MOA;
                        existingPoly.setStyle(isActive
                            ? { ...base, ...VectorMapLayers.SUA_ACTIVE_OVERRIDES }
                            : base);
                        existingPoly._suaActive = isActive;
                        // Redraw "ACT" badge label
                        this._updateSuaActLabel(sua, isActive, center => center);
                    }
                    continue;
                }

                const boundary = sua.boundary || [];
                if (boundary.length < 3) continue;

                const base = VectorMapLayers.SUA_STYLES[sua.type] || VectorMapLayers.SUA_STYLES.MOA;
                const style = isActive ? { ...base, ...VectorMapLayers.SUA_ACTIVE_OVERRIDES } : base;
                const latlngs = boundary.map(pt => [pt[0], pt[1]]);

                const polygon = L.polygon(latlngs, { ...style, interactive: true });
                polygon._suaActive = isActive;

                // Tap popup: name, type, altitudes, NOTAM status
                const notam = suaNotams ? suaNotams.getNotam(sua) : null;
                const lowerStr = sua.lower_ft === 0 ? 'SFC' : (sua.lower_ft >= 1000 ? `${Math.round(sua.lower_ft / 100) * 100} ft` : `${sua.lower_ft} ft`);
                const upperStr = sua.upper_ft != null ? (sua.upper_ft >= 1000 ? `${Math.round(sua.upper_ft / 100) * 100} ft` : `${sua.upper_ft} ft`) : '?';
                const notamHtml = notam
                    ? `<div class="sua-popup-notam sua-popup-active">⚠ ACTIVE per NOTAM<br><small>${notam.text?.slice(0, 120) ?? ''}</small></div>`
                    : `<div class="sua-popup-notam sua-popup-inactive">No active NOTAM found</div>`;
                const popupHtml = `<div class="sua-popup">
                    <b>${sua.name ?? sua.id}</b> <span class="sua-popup-type">${sua.type}</span><br>
                    <span class="sua-popup-alt">${lowerStr} – ${upperStr}</span>
                    ${notamHtml}
                </div>`;
                polygon.bindPopup(popupHtml, { maxWidth: 280, className: 'sua-popup-container' });

                polygon.addTo(this._suaLayer);
                this._suaPolygons.set(sua.id, polygon);

                // Altitude label at centroid
                const center = VectorMapLayers._polygonCentroid(latlngs);
                const altLower = sua.lower_ft === 0 ? 'SFC' : (sua.lower_ft >= 1000 ? `${Math.round(sua.lower_ft / 100)}` : sua.lower_ft);
                const altUpper = sua.upper_ft != null ? (sua.upper_ft >= 1000 ? `${Math.round(sua.upper_ft / 100)}` : sua.upper_ft) : '?';
                const actBadge = isActive ? '<span class="sua-act-badge">ACT</span>' : '';
                const altHtml  = `${altUpper}<br><span class="as-alt-floor">${altLower}</span>${actBadge}`;
                const typeClass = `sua-lbl-${(sua.type || 'moa').toLowerCase()}`;
                const label = L.marker(center, {
                    icon: L.divIcon({
                        className: `as-alt-label ${typeClass}${isActive ? ' sua-lbl-active' : ''}`,
                        html: altHtml,
                        iconSize: [44, 34],
                        iconAnchor: [22, 17],
                    }),
                    interactive: false,
                    zIndexOffset: -150,
                });
                label.addTo(this._suaLayer);
                this._suaPolygons.set(sua.id + '_lbl', label);
            }

            // Remove out-of-view
            for (const [id, poly] of this._suaPolygons) {
                const baseId = id.endsWith('_lbl') ? id.slice(0, -4) : id;
                if (!currentIds.has(baseId)) {
                    this._suaLayer.removeLayer(poly);
                    this._suaPolygons.delete(id);
                }
            }
        } catch (err) {
            console.warn('VectorMapLayers: SUA query failed', err);
        }
    }

    _updateSuaActLabel(sua, isActive, _getCenterFn) {
        // Re-render the label marker when activation state flips mid-session
        const lblKey = sua.id + '_lbl';
        const existing = this._suaPolygons.get(lblKey);
        if (!existing) return;
        const el = existing.getElement?.();
        if (!el) return;
        if (isActive) {
            el.classList.add('sua-lbl-active');
            // Add ACT badge if not present
            if (!el.querySelector('.sua-act-badge')) {
                const badge = document.createElement('span');
                badge.className = 'sua-act-badge';
                badge.textContent = 'ACT';
                el.appendChild(badge);
            }
        } else {
            el.classList.remove('sua-lbl-active');
            el.querySelector('.sua-act-badge')?.remove();
        }
    }

    async _updateAirports(south, west, north, east, zoom, overlays) {
        if (!this._map.hasLayer(this._airportLayer)) return;
        const minZoom = overlays.airports?.minZoom || 7;
        const labelsMinZoom = overlays.airports?.labelsMinZoom || 8;
        if (zoom < minZoom) {
            this._clearLayer(this._airportLayer, this._airportMarkers);
            return;
        }

        try {
            const airports = await this._nasr.getAirportsInBounds(south, west, north, east);
            const currentIds = new Set();
            const showLabels = zoom >= labelsMinZoom;

            // Airport display filter — read from CockpitConfig (user-adjustable)
            const aptFilter = (typeof CockpitConfig !== 'undefined')
                ? (CockpitConfig.get('airportFilter') || {})
                : {};
            const showHeliports    = aptFilter.showHeliports    ?? false;
            const showSeaplaneBases = aptFilter.showSeaplaneBases ?? false;
            const showUltralight   = aptFilter.showUltralight   ?? false;
            const showGliderports  = aptFilter.showGliderports  ?? false;
            const minRunwayFt      = aptFilter.minRunwayFt      ?? 0;
            const pavedOnly        = aptFilter.pavedOnly        ?? false;

            for (const apt of airports) {
                if (apt.lat == null || apt.lon == null) continue;

                // Apply facility type filter
                const fac = (apt.fac_type || 'AIRPORT').toUpperCase();
                if (fac === 'HELIPORT'     && !showHeliports)     continue;
                if (fac === 'SEAPLANE BASE' && !showSeaplaneBases) continue;
                if (fac === 'ULTRALIGHT'   && !showUltralight)    continue;
                if (fac === 'GLIDERPORT'   && !showGliderports)   continue;
                if (fac === 'BALLOONPORT'                         ) continue; // never show

                // Apply runway length filter (0 = unknown/grass strip, still shown unless minRunwayFt set)
                if (minRunwayFt > 0 && apt.longest_rwy_ft > 0 && apt.longest_rwy_ft < minRunwayFt) continue;

                // Paved-only filter
                if (pavedOnly && apt.longest_rwy_ft > 0 && !apt.has_paved_rwy) continue;
                currentIds.add(apt.icao);

                // Suppress permanent label for route waypoints (route layer draws its own)
                const onRoute = this._routeIcaos.has(apt.icao);
                const labelVisible = showLabels && !onRoute;

                if (this._airportMarkers.has(apt.icao)) {
                    // Update tooltip permanence if zoom crossed the label threshold
                    const m = this._airportMarkers.get(apt.icao);
                    const tip = m.getTooltip();
                    if (tip && tip.options.permanent !== labelVisible) {
                        const towered2 = m._aptData?.tower;
                        m.unbindTooltip();
                        m.bindTooltip(apt.icao, {
                            permanent: labelVisible,
                            direction: 'right',
                            offset: [8, 0],
                            className: towered2 ? 'apt-label apt-label-towered' : 'apt-label apt-label-nontowered',
                        });
                    }
                    continue;
                }

                const towered = apt.tower;
                // Neutral white/gray base — flight category dot overlays with category color.
                // Size (7 vs 5) distinguishes towered from non-towered when no weather is known.
                const baseColor = towered ? '#ffffff' : '#aaaaaa';
                const radius = towered ? 7 : 5;

                // Use default SVG renderer (not canvas) so click events work reliably
                const marker = L.circleMarker([apt.lat, apt.lon], {
                    radius,
                    color: '#333333',
                    fillColor: baseColor,
                    fillOpacity: 0.9,
                    weight: 1,
                    interactive: true,
                    bubblingMouseEvents: false,
                });

                marker.bindTooltip(apt.icao, {
                    permanent: labelVisible,
                    direction: 'right',
                    offset: [8, 0],
                    className: towered ? 'apt-label apt-label-towered' : 'apt-label apt-label-nontowered',
                });

                marker.on('click', () => {
                    if (this._onAirportClick) this._onAirportClick(apt);
                });

                marker._aptData = apt;
                marker.addTo(this._airportLayer);
                this._airportMarkers.set(apt.icao, marker);
            }

            for (const [id, marker] of this._airportMarkers) {
                if (!currentIds.has(id)) {
                    this._airportLayer.removeLayer(marker);
                    this._airportMarkers.delete(id);
                }
            }
        } catch (err) {
            console.warn('VectorMapLayers: airport query failed', err);
        }

        // Opportunistically fetch internet METARs when online (15-min TTL, silent on failure)
        this.fetchInternetMetars(south, west, north, east);

        // Draw dots from cached internet METARs for airports now in viewport that didn't
        // get a dot during the fetch (e.g. map moved after last fetch, TTL not yet expired)
        for (const [icao, entry] of this._internetMetars) {
            if (!this._aptPositions.has(icao)) continue;
            if (this._wxDotMarkers.has(icao)) continue; // already has a dot (FIS-B or existing)
            const cat = this._fisbClient?.metars.get(icao)?.decoded?.flight_category
                     || entry.decoded?.flight_category;
            if (cat) {
                this._upsertWxDot(icao, cat);
                this._upsertWxLabel(icao);
            }
        }
    }

    /**
     * Update wx dot positions independently of the airport layer.
     * Runs unconditionally so flight category dots appear even when the airport
     * circle layer is toggled off. Populates _aptPositions and draws wx dots.
     */
    async _updateWxDots(south, west, north, east, zoom, overlays) {
        const minZoom = overlays.airports?.minZoom || 7;
        if (zoom < minZoom) {
            this._clearLayer(this._wxDotsLayer, this._wxDotMarkers);
            this._clearLayer(this._wxLabelLayer, this._wxLabelMarkers);
            this._aptPositions.clear();
            return;
        }
        try {
            const airports = await this._nasr.getAirportsInBounds(south, west, north, east);
            const currentIds = new Set();
            for (const apt of airports) {
                if (apt.lat == null || apt.lon == null) continue;
                currentIds.add(apt.icao);
                this._aptPositions.set(apt.icao, { lat: apt.lat, lon: apt.lon, tower: apt.tower });
                const cat = this._getMetarEntry(apt.icao)?.decoded?.flight_category;
                if (cat) this._upsertWxDot(apt.icao, cat);
                this._upsertWxLabel(apt.icao);
            }
            // Remove stale positions and dots for airports that scrolled out of view
            for (const [id] of this._aptPositions) {
                if (!currentIds.has(id)) {
                    this._aptPositions.delete(id);
                    const dot = this._wxDotMarkers.get(id);
                    if (dot) { this._wxDotsLayer.removeLayer(dot); this._wxDotMarkers.delete(id); }
                    const lbl = this._wxLabelMarkers.get(id);
                    if (lbl) { this._wxLabelLayer.removeLayer(lbl); this._wxLabelMarkers.delete(id); }
                }
            }
        } catch (err) {
            console.warn('VectorMapLayers: wx dots query failed', err);
        }
    }

    async _updateNavaids(south, west, north, east, zoom, overlays) {
        if (!this._map.hasLayer(this._navaidLayer)) return;
        const minZoom = overlays.navaids?.minZoom || 7;
        const labelsMinZoom = overlays.navaids?.labelsMinZoom || 9;
        if (zoom < minZoom) {
            this._clearLayer(this._navaidLayer, this._navaidMarkers);
            return;
        }

        const vorOnly = zoom < 9;
        const showLabels = zoom >= labelsMinZoom;

        try {
            const navaids = await this._nasr.getNavaidsinBounds(south, west, north, east);
            const currentIds = new Set();

            for (const nav of navaids) {
                if (nav.lat == null || nav.lon == null) continue;

                if (vorOnly) {
                    const t = (nav.type || '').toUpperCase();
                    if (t !== 'VOR' && t !== 'VORTAC' && t !== 'VOR/DME') continue;
                }

                currentIds.add(nav.id);
                if (this._navaidMarkers.has(nav.id)) {
                    const m = this._navaidMarkers.get(nav.id);
                    const tip = m.getTooltip();
                    if (tip && tip.options.permanent !== showLabels) {
                        m.unbindTooltip();
                        m.bindTooltip(nav.id, {
                            permanent: showLabels, direction: 'right',
                            offset: [8, 0], className: 'nav-label',
                        });
                    }
                    continue;
                }

                const style = VectorMapLayers._navaidStyle(nav.type);
                const m = L.circleMarker([nav.lat, nav.lon], {
                    radius: style.radius,
                    color: style.color,
                    fillColor: style.color,
                    fillOpacity: 0.9,
                    weight: 1,
                    interactive: true,
                    bubblingMouseEvents: false,
                });
                m.bindTooltip(nav.id, {
                    permanent: showLabels, direction: 'right',
                    offset: [8, 0], className: 'nav-label',
                });
                m.on('click', () => {
                    if (this._onNavaidClick) this._onNavaidClick(nav);
                });
                m._navData = nav;
                m.addTo(this._navaidLayer);
                this._navaidMarkers.set(nav.id, m);
            }

            for (const [id, marker] of this._navaidMarkers) {
                if (!currentIds.has(id)) {
                    this._navaidLayer.removeLayer(marker);
                    this._navaidMarkers.delete(id);
                }
            }
        } catch (err) {
            console.warn('VectorMapLayers: navaid query failed', err);
        }
    }

    async _updateFixes(south, west, north, east, zoom, overlays) {
        if (!this._map.hasLayer(this._fixLayer)) return;
        const minZoom = overlays.fixes?.minZoom || 10;
        if (zoom < minZoom) {
            this._clearLayer(this._fixLayer, this._fixMarkers);
            return;
        }

        try {
            const fixes = await this._nasr.getFixesInBounds(south, west, north, east, overlays.fixes?.maxViewport || 500);
            const currentIds = new Set();
            const showLabels = zoom >= (overlays.fixes?.labelsMinZoom || 10);

            for (const fix of fixes) {
                if (fix.lat == null || fix.lon == null) continue;
                currentIds.add(fix.id);
                if (this._fixMarkers.has(fix.id)) {
                    // Update tooltip permanence if zoom changed
                    const m = this._fixMarkers.get(fix.id);
                    const tip = m.getTooltip();
                    if (tip && tip.options.permanent !== showLabels) {
                        m.unbindTooltip();
                        m.bindTooltip(fix.id, {
                            permanent: showLabels,
                            direction: 'right',
                            offset: [6, 0],
                            className: 'fix-label',
                        });
                    }
                    continue;
                }

                const m = L.circleMarker([fix.lat, fix.lon], {
                    radius: 3,
                    color: '#555555',
                    fillColor: '#555555',
                    fillOpacity: 0.8,
                    weight: 1,
                    interactive: true,
                    bubblingMouseEvents: false,
                });
                m.bindTooltip(fix.id, {
                    permanent: showLabels, direction: 'right',
                    offset: [6, 0], className: 'fix-label',
                });
                m.on('click', () => {
                    if (this._onFixClick) this._onFixClick(fix);
                });
                m._fixData = fix;
                m.addTo(this._fixLayer);
                this._fixMarkers.set(fix.id, m);
            }

            for (const [id, marker] of this._fixMarkers) {
                if (!currentIds.has(id)) {
                    this._fixLayer.removeLayer(marker);
                    this._fixMarkers.delete(id);
                }
            }
        } catch (err) {
            console.warn('VectorMapLayers: fix query failed', err);
        }
    }

    async _updateAirways(south, west, north, east, zoom, overlays) {
        if (!this._map.hasLayer(this._airwayLayer)) return;
        const minZoom = overlays.airways?.minZoom || 8;
        if (zoom < minZoom) {
            this._clearLayer(this._airwayLayer, this._airwayLines);
            return;
        }

        try {
            const airways = await this._nasr.getAirwaysInBounds(south, west, north, east);
            const currentIds = new Set();

            for (const awy of airways) {
                currentIds.add(awy.name);
                if (this._airwayLines.has(awy.name)) continue;

                const waypoints = awy.waypoints || awy.fixes || [];
                const latlngs = waypoints
                    .filter(wp => wp.lat != null && wp.lon != null)
                    .map(wp => [wp.lat, wp.lon]);

                if (latlngs.length < 2) continue;

                const AWY_COLORS = { V: '#4477aa', J: '#aa4422', T: '#449955', Q: '#8855aa' };
                const line = L.polyline(latlngs, {
                    color: AWY_COLORS[awy.type] || '#777777',
                    weight: 1.5,
                    opacity: 0.6,
                    dashArray: '6,4',
                });

                line.bindTooltip(awy.name, {
                    permanent: true,
                    direction: 'center',
                    className: 'airway-label',
                });

                line.addTo(this._airwayLayer);
                this._airwayLines.set(awy.name, line);
            }

            for (const [id, line] of this._airwayLines) {
                if (!currentIds.has(id)) {
                    this._airwayLayer.removeLayer(line);
                    this._airwayLines.delete(id);
                }
            }
        } catch (err) {
            console.warn('VectorMapLayers: airway query failed', err);
        }
    }

    _clearLayer(layerGroup, markerMap) {
        layerGroup.clearLayers();
        markerMap.clear();
    }

    static _navaidStyle(type) {
        const t = (type || '').toUpperCase();
        if (t === 'VOR' || t === 'VORTAC' || t === 'VOR/DME') return { color: '#4488ff', radius: 6 };
        if (t === 'NDB' || t === 'NDB/DME') return { color: '#ff44ff', radius: 5 };
        if (t === 'DME' || t === 'TACAN') return { color: '#44aaff', radius: 4 };
        return { color: '#4488ff', radius: 5 };
    }

    /**
     * Find the label position for a Class B shelf polygon.
     * Places the label in the outer visible area — the part away from the airport center.
     * Finds the boundary point furthest from the airport center, then positions
     * the label 60% of the way from the polygon centroid toward that far point.
     */
    static _shelfLabelPosition(latlngs, aptCenter) {
        const centroid = VectorMapLayers._polygonCentroid(latlngs);

        // Find boundary point furthest from airport center
        let maxDist = 0, farPt = centroid;
        for (const pt of latlngs) {
            const dlat = pt[0] - aptCenter[0];
            const dlon = pt[1] - aptCenter[1];
            const d = dlat * dlat + dlon * dlon;
            if (d > maxDist) { maxDist = d; farPt = pt; }
        }

        // Place label 60% from centroid toward the far point
        const t = 0.6;
        return [
            centroid[0] + (farPt[0] - centroid[0]) * t,
            centroid[1] + (farPt[1] - centroid[1]) * t,
        ];
    }

    /**
     * Handle map click: find nearest marker within pixel threshold.
     * Uses Leaflet's map click event which fires reliably on both
     * mouse and touch (unlike individual circleMarker click events).
     */
    _onMapClick(e) {
        const HIT_PX = 30; // generous tap target for fingers
        const pt = this._map.latLngToContainerPoint(e.latlng);
        const hit = this._findNearestMarker(pt, HIT_PX);

        if (hit) {
            if (hit.type === 'airport' && this._onAirportClick) {
                this._onAirportClick(hit.data);
            } else if (hit.type === 'navaid' && this._onNavaidClick) {
                this._onNavaidClick(hit.data);
            } else if (hit.type === 'fix' && this._onFixClick) {
                this._onFixClick(hit.data);
            }
            return;
        }

        // No aviation marker hit — check traffic markers
        if (this._onTrafficTap) {
            this._onTrafficTap(pt);
        }
    }

    /**
     * Find nearest marker to a container point within a pixel threshold.
     * Checks airports first (priority), then navaids, then fixes.
     */
    _findNearestMarker(containerPt, maxPx) {
        let best = null;
        let bestDist = maxPx;

        // Helper: check a markers map
        const check = (markersMap, type, dataFn) => {
            for (const [id, marker] of markersMap) {
                const markerPt = this._map.latLngToContainerPoint(marker.getLatLng());
                const dist = containerPt.distanceTo(markerPt);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = { type, data: dataFn ? dataFn(id, marker) : null, marker };
                }
            }
        };

        // We need the original data objects. Store them on the markers.
        // Check airports (highest priority, check first)
        for (const [id, marker] of this._airportMarkers) {
            const markerPt = this._map.latLngToContainerPoint(marker.getLatLng());
            const dist = containerPt.distanceTo(markerPt);
            if (dist < bestDist) {
                bestDist = dist;
                best = { type: 'airport', data: marker._aptData, marker, dist };
            }
        }

        // Check navaids
        for (const [id, marker] of this._navaidMarkers) {
            const markerPt = this._map.latLngToContainerPoint(marker.getLatLng());
            const dist = containerPt.distanceTo(markerPt);
            if (dist < bestDist) {
                bestDist = dist;
                best = { type: 'navaid', data: marker._navData, marker, dist };
            }
        }

        // Check fixes
        for (const [id, marker] of this._fixMarkers) {
            const markerPt = this._map.latLngToContainerPoint(marker.getLatLng());
            const dist = containerPt.distanceTo(markerPt);
            if (dist < bestDist) {
                bestDist = dist;
                best = { type: 'fix', data: marker._fixData, marker, dist };
            }
        }

        return best;
    }

    /** Compute the visual centroid of a polygon (works for concave/crescent shapes). */
    static _polygonCentroid(latlngs) {
        let area = 0, cx = 0, cy = 0;
        const n = latlngs.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = latlngs[i][1], yi = latlngs[i][0];
            const xj = latlngs[j][1], yj = latlngs[j][0];
            const cross = xi * yj - xj * yi;
            area += cross;
            cx += (xi + xj) * cross;
            cy += (yi + yj) * cross;
        }
        area *= 0.5;
        if (Math.abs(area) < 1e-10) {
            // Degenerate — fall back to average
            const avgLat = latlngs.reduce((s, p) => s + p[0], 0) / n;
            const avgLon = latlngs.reduce((s, p) => s + p[1], 0) / n;
            return [avgLat, avgLon];
        }
        const f = 1 / (6 * area);
        return [cy * f, cx * f];
    }
}
