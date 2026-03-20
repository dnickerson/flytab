/**
 * FlyPi — Cockpit Moving Map
 * Leaflet-based map with sectional tiles, own-ship, traffic, route, radar.
 */

class CockpitMap {
    constructor(container, stratuxClient) {
        this.container = container;
        this.stratux = stratuxClient;
        this.map = null;
        this.ownshipMarker = null;
        this._ownshipSvgG = null;
        this.trafficMarkers = new Map(); // icao → L.marker
        this._trafficPopup = null;
        this.routeLayer = null;
        this.rangeRings = null;
        this.radarLayer = null;
        this.trackLogLine = null;
        this._autoPan = Settings.autoPan;
        this._initialized = false;

        // Route leg lines and active tracking
        this._routeWaypoints = [];
        this._activeWpIdx = 0;
        this._activeLegLine = null;
        this._legLines = [];  // per-leg polylines

        // Vector layers (new cockpit redesign)
        this._vectorLayers = null;
        this._airportPopup = null;
        this._radarLoop = null;
        this._lightning = null;
        this._takeoffAlerts = null;
        this._enginePage = null;
        this._fuelOverlay = null;
        this._logbook = null;

        // Runway extension centerlines
        this._rwyExtLayer = null;
        this._destAirport = null;
        this._rwyExtZoomHandler = null;
        this._rwyExtVisible = true;

        // Legacy fix/navaid overlay state (kept for backward compat, removed in vector mode)
        this._canvasRenderer = null;
        this._navaidLayer = null;
        this._fixLayer = null;
        this._navaidMarkers = new Map();
        this._fixMarkers = new Map();
        this._showNavaids = Settings.showNavaids;
        this._showFixes = Settings.showFixes;
        this._showAirports = Settings.showAirports;
        this._showAirways = Settings.showAirways;
        this._showTrafficAlt = false;
        this._fixUpdateTimer = null;
        this._nasr = null;
    }

    init() {
        if (this._initialized) return;
        this._initialized = true;

        // Create map container div
        const mapDiv = document.createElement('div');
        mapDiv.id = 'cockpit-map';
        mapDiv.style.cssText = 'width:100%;height:100%;';
        this.container.appendChild(mapDiv);

        // Initialize Leaflet
        this.map = L.map(mapDiv, {
            center: [35.0, -80.0], // Default: Charlotte area
            zoom: 8,
            zoomControl: false,
            attributionControl: false,
            zoomSnap: 0.25,
            zoomDelta: 0.5,
            wheelDebounceTime: 80,
        });

        // Tile layers
        this._setupLayers();

        // Corner buttons (auto-pan, D→)
        this._addCornerButtons();

        // Resize map when virtual keyboard opens/closes (iPad)
        if (window.visualViewport) {
            this._viewportResizeHandler = () => {
                if (this.map) this.map.invalidateSize();
            };
            window.visualViewport.addEventListener('resize', this._viewportResizeHandler);
        }

        // Listen for stratux events
        this.stratux.addEventListener('stratux:situation', (e) => this._updateOwnship(e.detail));
        this.stratux.addEventListener('stratux:traffic', () => this._updateTraffic());

        // Periodic traffic cleanup
        this._trafficTimer = setInterval(() => this._updateTraffic(), 2000);
    }

    /** Provide a NasrDB instance for fix/navaid queries */
    setNasrDB(nasrDb) {
        this._nasr = nasrDb;
        // Only use legacy fix overlay if vector layers aren't active
        if (this._initialized && !this._vectorLayers) this._setupFixOverlay();
    }

    destroy() {
        if (this._trafficTimer) { clearInterval(this._trafficTimer); this._trafficTimer = null; }
        if (this._fixUpdateTimer) { clearTimeout(this._fixUpdateTimer); this._fixUpdateTimer = null; }
        if (this._viewportResizeHandler && window.visualViewport) {
            window.visualViewport.removeEventListener('resize', this._viewportResizeHandler);
            this._viewportResizeHandler = null;
        }
        if (this.map) {
            this.map.remove();
            this.map = null;
        }
        this.ownshipMarker = null;
        this._ownshipSvgG = null;
        this._initialized = false;
    }

    resize() {
        if (this.map) this.map.invalidateSize();
    }

    // ========== Tile Layers ==========

    _setupLayers() {
        // FlyTab: tiles served from NanoHTTPD at localhost:9090 (Android filesystem).
        // Tiles are downloaded from home server via Layer Panel / Data & Maps and
        // stored to Documents/FlyTab/tiles/ where NanoHTTPD serves them.
        const tileBase = 'http://localhost:9090/tiles';
        console.log('[FlyTab] Tile base:', tileBase);

        // FAA Sectional — 256px tiles, z5-11
        this._sectionalLayer = L.tileLayer(`${tileBase}/sectional/{z}/{x}/{y}.webp`, {
            minZoom: 5,
            minNativeZoom: 5,
            maxNativeZoom: 11,
            maxZoom: 14,
            tms: false,
            updateWhenZooming: false,
            attribution: 'FAA Sectional Charts',
            errorTileUrl: '',
        });

        // IFR Low Enroute — 512px retina tiles (stored at standard z/x/y coords, 2× pixel density)
        // tileSize stays 256 — Leaflet positions tiles by z/x/y grid, 512px images scale crisper on retina.
        // updateWhenZooming: false — prevents zoom-transition seam where CSS-scaled old tiles and
        // newly-loading tiles appear at different scales. Leaflet waits until zoom ends to load.
        this._ifrLayer = L.tileLayer(`${tileBase}/ifr-low/{z}/{x}/{y}.webp`, {
            minZoom: 7,
            minNativeZoom: 7,
            maxNativeZoom: 11,
            maxZoom: 14,
            tms: false,
            updateWhenZooming: false,
            attribution: 'FAA IFR Low Enroute',
            errorTileUrl: '',
        });

        // Log tile errors for debugging
        const logTileError = (layer) => {
            layer.on('tileerror', (e) => {
                const { x, y, z } = e.coords || {};
                if (typeof DiagLog !== 'undefined') DiagLog.log('tiles', `404: ${layer._url?.replace('{z}',z).replace('{x}',x).replace('{y}',y) || '?'}`);
            });
        };
        logTileError(this._sectionalLayer);
        logTileError(this._ifrLayer);

        // Start with sectional
        this._sectionalLayer.addTo(this.map);
        this._activeBaseLayer = 'sectional';

        // Canvas renderer for fix/navaid overlays (single <canvas>, no DOM per point)
        this._canvasRenderer = L.canvas({ padding: 0.5 });
        this._navaidLayer = L.layerGroup();
        this._fixLayer = L.layerGroup();

        if (this._showNavaids) this._navaidLayer.addTo(this.map);
        if (this._showFixes) this._fixLayer.addTo(this.map);
    }

    /** Wire up VectorMapLayers for the new cockpit redesign */
    setVectorLayers(vectorLayers) {
        this._vectorLayers = vectorLayers;
        // Remove legacy navaid/fix layers — vector layers handle these now
        if (this._navaidLayer && this.map.hasLayer(this._navaidLayer)) {
            this.map.removeLayer(this._navaidLayer);
        }
        if (this._fixLayer && this.map.hasLayer(this._fixLayer)) {
            this.map.removeLayer(this._fixLayer);
        }
    }

    /** Wire up AirportPopup */
    setAirportPopup(popup) {
        this._airportPopup = popup;
    }

    /** Wire up RadarLoop */
    setRadarLoop(radar) {
        this._radarLoop = radar;
    }

    /** Wire up FisbNexrad renderer */
    setFisbNexrad(nexrad) {
        this._fisbNexrad = nexrad;
    }

    /** Wire up FisbWeatherDisplay */
    setFisbWeather(weather) {
        this._fisbWeather = weather;
    }

    /** Wire up LightningLayer */
    setLightning(lightning) {
        this._lightning = lightning;
    }

    /** Wire up TakeoffAlerts */
    setTakeoffAlerts(alerts) {
        this._takeoffAlerts = alerts;
    }

    /** Wire up EnginePage */
    setEnginePage(enginePage) {
        this._enginePage = enginePage;
    }

    /** Wire up FuelOverlay */
    setFuelOverlay(overlay) {
        this._fuelOverlay = overlay;
    }

    /** Wire up DataStatus */
    setDataStatus(dataStatus) {
        this._dataStatus = dataStatus;
    }

    setConfigEditor(configEditor) {
        this._configEditor = configEditor;
    }

    setChecklist(checklist) {
        this._checklist = checklist;
    }

    setLogbook(logbook) {
        this._logbook = logbook;
    }

    setIfrClearance(ifrClearance) {
        this._ifrClearance = ifrClearance;
    }

    switchBaseLayer(name) {
        if (this.map.hasLayer(this._sectionalLayer)) this.map.removeLayer(this._sectionalLayer);
        if (this._ifrLayer && this.map.hasLayer(this._ifrLayer)) this.map.removeLayer(this._ifrLayer);

        if (name === 'vector') {
            // Dark background + NASR vectors
            if (this._vectorLayers) {
                this._vectorLayers.enableDarkBackground();
                this._vectorLayers.showAll();
            }
        } else {
            if (this._vectorLayers) this._vectorLayers.disableDarkBackground();
            if (name === 'ifr') {
                this._ifrLayer.addTo(this.map);
            } else {
                this._sectionalLayer.addTo(this.map);
            }
        }
        this._activeBaseLayer = name;
    }

    // ========== NEXRAD Radar ==========

    toggleRadar(on) {
        if (on && !this.radarLayer) {
            this.radarLayer = L.tileLayer(
                'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
                { opacity: Settings.radarOpacity, maxZoom: 14 }
            );
            this.radarLayer.addTo(this.map);
        } else if (!on && this.radarLayer) {
            this.map.removeLayer(this.radarLayer);
            this.radarLayer = null;
        }
    }

    // ========== Own-ship ==========

    _updateOwnship(sit) {
        if (!sit || sit.gps_fix_quality === 0) {
            if (this.ownshipMarker) this.ownshipMarker.setOpacity(0.3);
            return;
        }

        const pos = [sit.lat, sit.lon];
        const isFirstFix = !this.ownshipMarker;

        if (isFirstFix) {
            const icon = L.divIcon({
                className: 'ownship-icon',
                html: CockpitMap._ownshipSvg(0),
                iconSize: [48, 48],
                iconAnchor: [24, 24],
            });
            this.ownshipMarker = L.marker(pos, { icon, zIndexOffset: 1000 }).addTo(this.map);
            // Cache the SVG <g> element to avoid querySelector on every 1Hz update.
            this._ownshipSvgG = this.ownshipMarker.getElement()?.querySelector('svg g') || null;
        } else {
            this.ownshipMarker.setLatLng(pos);
            this.ownshipMarker.setOpacity(1);
        }
        // Rotate via SVG transform with explicit center (24,24) — avoids WebView
        // transform-origin default (0,0) that offsets the marker.
        if (this._ownshipSvgG) this._ownshipSvgG.setAttribute('transform', `rotate(${sit.true_course || 0}, 24, 24)`);

        // Always pan to first GPS fix so pilot can find ownship on startup.
        // Continue panning on subsequent updates only if auto-pan is enabled.
        if (isFirstFix || this._autoPan) {
            this.map.panTo(pos, { animate: !isFirstFix, duration: 0.5 });
        }

        // Range rings
        this._updateRangeRings(pos);

        // Active leg line
        this._updateActiveLeg(pos);
    }

    _updateActiveLeg(pos) {
        const wps = this._routeWaypoints;
        if (!wps || wps.length < 2) return;

        const prevIdx = this._activeWpIdx;

        // Advance active waypoint if we're within ~1nm of it
        while (this._activeWpIdx < wps.length - 1) {
            const wp = wps[this._activeWpIdx];
            const dist = this._distNm(pos[0], pos[1], wp.lat, wp.lon);
            if (dist < 1.0) {
                this._activeWpIdx++;
            } else {
                break;
            }
        }

        // Restyle leg lines if active waypoint changed
        if (prevIdx !== this._activeWpIdx || !this._activeLegLine) {
            this._restyleLegLines();
        }

        const nextWp = wps[this._activeWpIdx];
        if (!nextWp) return;

        // Active leg: solid magenta from ownship to next waypoint
        const latlngs = [pos, [nextWp.lat, nextWp.lon]];
        if (this._activeLegLine) {
            this._activeLegLine.setLatLngs(latlngs);
        } else {
            this._activeLegLine = L.polyline(latlngs, {
                color: '#ff44ff', weight: 4, opacity: 1,
            }).addTo(this.map);
        }
    }

    _restyleLegLines() {
        for (let i = 0; i < this._legLines.length; i++) {
            const line = this._legLines[i];
            if (i < this._activeWpIdx) {
                // Past legs: dim
                line.setStyle({ color: '#883388', weight: 2, opacity: 0.4, dashArray: null });
            } else {
                // Future legs: dashed
                line.setStyle({ color: '#ff44ff', weight: 3, opacity: 0.8, dashArray: '8,6' });
            }
        }
    }

    _distNm(lat1, lon1, lat2, lon2) {
        const R = 3440.065; // Earth radius in nm
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    static _ownshipSvg(heading) {
        return `<svg width="48" height="48" viewBox="0 0 48 48">
            <g transform="rotate(${heading}, 24, 24)" fill="#ff0000" stroke="none" stroke-linejoin="round">
                <!-- fuselage -->
                <path d="M24,2 L28,16 L27,38 L24,44 L21,38 L20,16 Z"/>
                <!-- wings -->
                <path d="M20,17 L3,27 L3,31 L20,24 Z"/>
                <path d="M28,17 L45,27 L45,31 L28,24 Z"/>
                <!-- tail -->
                <path d="M21,36 L12,42 L12,44 L21,40 Z"/>
                <path d="M27,36 L36,42 L36,44 L27,40 Z"/>
            </g>
        </svg>`;
    }

    // ========== Traffic ==========

    _updateTraffic() {
        const now = Date.now();
        const seen = new Set();

        for (const [icao, target] of this.stratux.traffic) {
            seen.add(icao);
            if (!target.lat || !target.lon) continue;

            const color = this._trafficColor(target);
            let altLabel = '';
            if (this._showTrafficAlt && this.stratux.situation) {
                const dAlt = Math.round((target.alt || 0) - (this.stratux.situation.alt_msl || 0));
                altLabel = (dAlt >= 0 ? '+' : '') + dAlt;
            }
            const svgHtml = CockpitMap._trafficSvg(target.track || 0, color, target.extrapolated);
            const iconHtml = altLabel
                ? `<div class="traffic-icon-wrap">${svgHtml}<div class="traffic-alt" style="color:${color};">${altLabel}</div></div>`
                : svgHtml;
            const icon = L.divIcon({
                className: 'traffic-icon',
                html: iconHtml,
                iconSize: altLabel ? [44, 38] : [24, 24],
                iconAnchor: [12, 12],
            });

            if (this.trafficMarkers.has(icao)) {
                const m = this.trafficMarkers.get(icao);
                m.setLatLng([target.lat, target.lon]);
                m.setIcon(icon);
            } else {
                const m = L.marker([target.lat, target.lon], { icon, zIndexOffset: 500 })
                    .addTo(this.map);
                // Always fetch current target at click time — stale closure causes popup offset
                m.on('click', () => this._showTrafficPopup(this.stratux.traffic.get(icao) || target, m));
                this.trafficMarkers.set(icao, m);
            }
        }

        // Remove stale markers
        for (const [icao, marker] of this.trafficMarkers) {
            if (!seen.has(icao)) {
                this.map.removeLayer(marker);
                this.trafficMarkers.delete(icao);
            }
        }
    }

    _trafficColor(target) {
        if (!this.stratux.situation) return '#ffffff';
        const sit = this.stratux.situation;
        const dist = CockpitMap._distNm(sit.lat, sit.lon, target.lat, target.lon);
        const dAlt = Math.abs((target.alt || 0) - (sit.alt_msl || 0));

        if (dist <= 1 && dAlt <= 500) return '#ff4444';   // red — proximate
        if (dist <= 3 && dAlt <= 1000) return '#ffaa00';   // yellow — caution
        return '#ffffff';                                    // white — normal
    }

    static _trafficSvg(heading, color, extrapolated) {
        const dash = extrapolated ? 'stroke-dasharray="3,2"' : '';
        return `<svg width="24" height="24" viewBox="0 0 24 24" style="transform:rotate(${heading}deg)">
            <polygon points="12,2 20,20 12,16 4,20" fill="${color}" stroke="#000" stroke-width="1" ${dash}/>
        </svg>`;
    }

    /**
     * Called by vector-map-layers when a tap doesn't hit any airport/navaid/fix.
     * Checks if the tap is near a traffic marker.
     */
    _onTrafficTap(containerPt) {
        const HIT_PX = 40;
        let bestDist = HIT_PX;
        let bestIcao = null;
        for (const [icao, marker] of this.trafficMarkers) {
            const mPt = this.map.latLngToContainerPoint(marker.getLatLng());
            const dx = mPt.x - containerPt.x, dy = mPt.y - containerPt.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestDist) {
                bestDist = d;
                bestIcao = icao;
            }
        }
        if (bestIcao == null) return false;
        const target = this.stratux.traffic.get(bestIcao);
        const marker = this.trafficMarkers.get(bestIcao);
        if (target && marker) {
            this._showTrafficPopup(target, marker);
            return true;
        }
        return false;
    }

    _showTrafficPopup(target, marker) {
        // Close any existing traffic popup
        if (this._trafficPopup) {
            this.map.closePopup(this._trafficPopup);
            this._trafficPopup = null;
        }

        const sit = this.stratux.situation;
        let dist = '—', bearing = '—', dAlt = '—';
        if (sit && sit.lat) {
            dist = CockpitMap._distNm(sit.lat, sit.lon, target.lat, target.lon).toFixed(1) + ' NM';
            bearing = Math.round(CockpitMap._bearing(sit.lat, sit.lon, target.lat, target.lon)) + '\u00b0';
            dAlt = (target.alt != null && sit.alt_msl != null)
                ? (target.alt - sit.alt_msl > 0 ? '+' : '') + Math.round(target.alt - sit.alt_msl) + ' ft'
                : '—';
        }

        const html = `<div class="traffic-popup">
            <strong>${target.callsign || target.hex}</strong><br>
            Alt: ${target.alt ? Math.round(target.alt) + ' ft' : '—'} (${dAlt})<br>
            GS: ${target.speed ? Math.round(target.speed) + ' kt' : '—'}
            VS: ${target.vvel != null ? (target.vvel > 0 ? '+' : '') + target.vvel + ' fpm' : '—'}<br>
            Brg: ${bearing} Dist: ${dist}<br>
            <span class="text-sm text-muted">Age: ${Math.round((Date.now() - target.last_seen) / 1000)}s</span>
            <div class="popup-actions" style="margin-top:6px;">
                <button class="popup-btn popup-close-btn traffic-close-btn" style="width:100%;font-size:14px;padding:6px;min-height:32px;background:#442222;color:#ff8888;border:1px solid #663333;border-radius:5px;font-weight:700;">CLOSE</button>
            </div>
        </div>`;

        this._trafficPopup = L.popup({
            className: 'traffic-popup-container',
            closeButton: false,
            autoPan: false,
            maxWidth: 260,
        })
            .setLatLng(marker.getLatLng())
            .setContent(html);

        this._trafficPopup.on('add', () => {
            const el = this._trafficPopup.getElement();
            if (!el) return;
            const closeBtn = el.querySelector('.traffic-close-btn');
            if (closeBtn) {
                let touchFired = false;
                closeBtn.addEventListener('touchstart', (e) => {
                    e.stopPropagation();
                    touchFired = true;
                    this.map.closePopup(this._trafficPopup);
                    this._trafficPopup = null;
                    setTimeout(() => { touchFired = false; }, 400);
                });
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (touchFired) { touchFired = false; return; }
                    this.map.closePopup(this._trafficPopup);
                    this._trafficPopup = null;
                });
            }
        });

        this._trafficPopup.openOn(this.map);
    }

    // ========== Range Rings ==========

    _updateRangeRings(pos) {
        if (!Settings.showRangeRings) {
            if (this.rangeRings) { this.rangeRings.forEach(c => this.map.removeLayer(c)); this.rangeRings = null; }
            return;
        }
        if (this.rangeRings) {
            // Reuse existing circles — just move them
            this.rangeRings.forEach(c => c.setLatLng(pos));
            return;
        }

        const nmToMeters = 1852;
        this.rangeRings = [1, 3, 5].map(nm =>
            L.circle(pos, {
                radius: nm * nmToMeters,
                color: '#00d4ff',
                weight: 1,
                opacity: 0.3,
                fill: false,
                dashArray: '4,4',
            }).addTo(this.map)
        );
    }

    // ========== Route Overlay ==========

    setRoute(waypoints) {
        if (this.routeLayer && this.map.hasLayer(this.routeLayer)) { this.map.removeLayer(this.routeLayer); }
        if (this._activeLegLine && this.map.hasLayer(this._activeLegLine)) { this.map.removeLayer(this._activeLegLine); this._activeLegLine = null; }
        this._legLines = [];
        this._routeWaypoints = waypoints || [];
        this._activeWpIdx = 0;

        // Clear previous runway extensions
        this._clearRunwayExtensions();

        // Tell vector layers which airports are on the route (suppresses duplicate labels)
        if (this._vectorLayers) {
            const icaos = (waypoints || []).filter(wp => wp.icao).map(wp => wp.icao);
            this._vectorLayers.setRouteIcaos(icaos);
        }

        if (!waypoints || waypoints.length < 2) return;

        const latlngs = waypoints.map(wp => [wp.lat, wp.lon]);
        this.routeLayer = L.layerGroup();

        // Per-leg polylines — all start as future (dashed)
        for (let i = 0; i < waypoints.length - 1; i++) {
            const line = L.polyline(
                [[waypoints[i].lat, waypoints[i].lon], [waypoints[i + 1].lat, waypoints[i + 1].lon]],
                { color: '#ff44ff', weight: 3, opacity: 0.8, dashArray: '8,6' }
            ).addTo(this.routeLayer);
            this._legLines.push(line);
        }

        // Waypoint markers — larger radius, tappable for airport popup
        waypoints.forEach(wp => {
            const marker = L.circleMarker([wp.lat, wp.lon], {
                radius: 8, color: '#ff44ff', fillColor: '#ff44ff', fillOpacity: 0.8, weight: 2,
            }).bindTooltip(wp.icao || wp.name || '', { permanent: true, direction: 'top', className: 'wp-label' })
              .addTo(this.routeLayer);

            marker.on('click', () => {
                if (wp.icao && this._airportPopup) {
                    this._airportPopup.showForAirport(wp.icao, [wp.lat, wp.lon]);
                }
            });
        });

        this.routeLayer.addTo(this.map);
        this.map.fitBounds(L.latLngBounds(latlngs).pad(0.1));

        // Draw runway extensions for destination
        const dest = waypoints[waypoints.length - 1];
        if (dest.icao && this._nasr) {
            this._drawDestRunways(dest.icao);
        }
    }

    // ========== Runway Extension Centerlines ==========

    _clearRunwayExtensions() {
        if (this._rwyExtLayer) {
            this.map.removeLayer(this._rwyExtLayer);
            this._rwyExtLayer = null;
        }
        if (this._rwyExtZoomHandler) {
            this.map.off('zoomend', this._rwyExtZoomHandler);
            this._rwyExtZoomHandler = null;
        }
        this._destAirport = null;
    }

    async _drawDestRunways(icao) {
        const apt = await this._nasr.getAirport(icao);
        if (!apt?.runways?.length) return;
        this._destAirport = apt;
        this._rwyExtLayer = L.layerGroup();
        if (this._rwyExtVisible) this._rwyExtLayer.addTo(this.map);
        this._renderRunwayExtensions();
        this._rwyExtZoomHandler = () => this._renderRunwayExtensions();
        this.map.on('zoomend', this._rwyExtZoomHandler);
    }

    setRwyExtVisible(visible) {
        this._rwyExtVisible = visible;
        if (!this._rwyExtLayer) return;
        if (visible) {
            if (!this.map.hasLayer(this._rwyExtLayer)) this._rwyExtLayer.addTo(this.map);
        } else {
            if (this.map.hasLayer(this._rwyExtLayer)) this.map.removeLayer(this._rwyExtLayer);
        }
    }

    _renderRunwayExtensions() {
        if (!this._rwyExtLayer || !this._destAirport) return;
        this._rwyExtLayer.clearLayers();

        const apt = this._destAirport;
        const aptLat = apt.lat;
        const aptLon = apt.lon;
        const zoom = this.map.getZoom();

        // Extension = 120px in ground distance at current zoom + latitude
        const metersPerPx = (40075016.686 * Math.abs(Math.cos(aptLat * Math.PI / 180)))
                            / Math.pow(2, zoom + 8);
        const extNm = (120 * metersPerPx) / 1852;
        const cosLat = Math.cos(aptLat * Math.PI / 180);

        for (const rwy of apt.runways) {
            for (const part of (rwy.id || '').split('/')) {
                const match = part.trim().match(/^(\d{1,2})(L|R|C)?$/i);
                if (!match) continue;

                const hdgDeg = parseInt(match[1]) * 10;
                const hdgRad = hdgDeg * Math.PI / 180;
                const label = String(match[1]).padStart(2, '0') + (match[2] || '').toUpperCase();

                // Runway half-length from airport reference point (approximate threshold)
                const halfNm = (rwy.length_ft || 3000) / 6076 / 2;

                // Approach threshold: opposite end from the runway heading direction.
                // Runway 18 (hdg=180°) is landed heading south, so the approach end
                // is at the NORTH end of the runway — negate the heading vector.
                const tLat = aptLat - (halfNm / 60) * Math.cos(hdgRad);
                const tLon = aptLon - (halfNm / 60 / cosLat) * Math.sin(hdgRad);

                // Extension continues outbound from threshold (same reciprocal direction)
                const eLat = tLat - (extNm / 60) * Math.cos(hdgRad);
                const eLon = tLon - (extNm / 60 / cosLat) * Math.sin(hdgRad);

                L.polyline([[tLat, tLon], [eLat, eLon]], {
                    color: '#00e5ff',
                    weight: 1.5,
                    opacity: 0.85,
                    dashArray: '5,5',
                    interactive: false,
                }).addTo(this._rwyExtLayer);

                L.marker([eLat, eLon], {
                    icon: L.divIcon({
                        html: `<span class="rwy-ext-inner">${label}</span>`,
                        className: 'rwy-ext-label',
                        iconAnchor: [0, 0],
                        iconSize: [0, 0],
                    }),
                    interactive: false,
                }).addTo(this._rwyExtLayer);
            }
        }
    }

    // ========== Track Log Overlay ==========

    setTrackLog(points) {
        if (this.trackLogLine && this.map.hasLayer(this.trackLogLine)) { this.map.removeLayer(this.trackLogLine); this.trackLogLine = null; }
        if (!points || points.length < 2 || !Settings.showTrackLog) return;

        const latlngs = points.map(p => [p.lat, p.lon]);
        this.trackLogLine = L.polyline(latlngs, {
            color: '#888888', weight: 2, opacity: 0.5, dashArray: '2,4',
        }).addTo(this.map);
    }

    // ========== Map Controls ==========

    /**
     * Wire a button for instant tap response on touch devices.
     * Uses touchend (fires immediately, no 300ms delay) with click fallback for desktop.
     */
    _fastTap(btn, handler) {
        let touchFired = false;
        // Use touchstart (not touchend) — on iOS/iPad, Leaflet's drag handler can
        // cancel the touch sequence before touchend fires, swallowing the event.
        // touchstart fires immediately when the finger goes down, before any drag
        // logic can interfere. preventDefault() suppresses the subsequent click.
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            touchFired = true;
            handler(e);
        }, { passive: false });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (touchFired) { touchFired = false; return; } // already handled by touchstart
            handler(e);
        });
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.disableScrollPropagation(btn);
    }

    _addCornerButtons() {
        // 3 corner buttons in #mapCornerBtns (outside Leaflet, wired by app.js)
        // Expose references so app.js can wire them after init
        const container = document.getElementById('mapCornerBtns');
        if (!container) return;

        // Auto-pan
        const autoPanBtn = document.createElement('button');
        autoPanBtn.className = 'map-corner-btn auto-pan-btn';
        autoPanBtn.title = 'Toggle auto-pan';
        autoPanBtn.innerHTML = this._autoPan ? '&#x1F4CD;' : '&#x270B;';
        autoPanBtn.classList.toggle('active', this._autoPan);
        this._fastTap(autoPanBtn, () => {
            this._autoPan = !this._autoPan;
            Settings.autoPan = this._autoPan;
            autoPanBtn.innerHTML = this._autoPan ? '&#x1F4CD;' : '&#x270B;';
            autoPanBtn.classList.toggle('active', this._autoPan);
        });
        container.appendChild(autoPanBtn);
        this._autoPanBtn = autoPanBtn;

        // Direct-To
        const directToBtn = document.createElement('button');
        directToBtn.className = 'map-corner-btn direct-to-btn';
        directToBtn.title = 'Direct To';
        directToBtn.innerHTML = 'D&rarr;';
        this._fastTap(directToBtn, () => {
            if (typeof app !== 'undefined' && app.routeEditor) {
                app.routeEditor.showDirectTo();
            }
        });
        container.appendChild(directToBtn);
        this._directToBtn = directToBtn;
    }

    /** Toggle traffic altitude labels — called by layer panel */
    setShowTrafficAlt(enabled) {
        this._showTrafficAlt = enabled;
        this._updateTraffic();
    }

    // ========== Stratux Web UI Overlay ==========

    _toggleStratuxOverlay() {
        if (this._stxOverlay) {
            this._stxOverlay.remove();
            this._stxOverlay = null;
            return;
        }
        const ip = Settings.stratuxIp || '192.168.10.1';
        const overlay = document.createElement('div');
        overlay.className = 'stx-overlay';
        overlay.innerHTML = `
            <div class="stx-overlay-bar">
                <span class="stx-overlay-title">Stratux · ${ip}</span>
                <button class="stx-overlay-close">\u2715 BACK</button>
            </div>
            <iframe class="stx-overlay-frame" src="http://${ip}/" allowfullscreen></iframe>
        `;
        const closeBtn = overlay.querySelector('.stx-overlay-close');
        const closeFn = () => { overlay.remove(); this._stxOverlay = null; };
        closeBtn.addEventListener('click', closeFn);
        closeBtn.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); closeFn(); }, { passive: false });
        document.body.appendChild(overlay);
        this._stxOverlay = overlay;
    }

    // ========== Fix/Navaid Overlay ==========

    _setupFixOverlay() {
        if (!this.map || !this._nasr) return;
        // Bind map movement to overlay updates
        this.map.on('moveend zoomend', () => this._scheduleFixUpdate());
        // Initial render
        this._updateFixOverlay();
    }

    _scheduleFixUpdate() {
        if (this._fixUpdateTimer) clearTimeout(this._fixUpdateTimer);
        this._fixUpdateTimer = setTimeout(() => this._updateFixOverlay(), 300);
    }

    async _updateFixOverlay() {
        if (!this._nasr || !this.map) return;

        const zoom = this.map.getZoom();
        const bounds = this.map.getBounds();
        const south = bounds.getSouth();
        const west = bounds.getWest();
        const north = bounds.getNorth();
        const east = bounds.getEast();

        // Zoom visibility rules
        const showNavaids = this._showNavaids && zoom >= 7;
        const showFixes = this._showFixes && zoom >= 10;
        const showNavaidLabels = zoom >= 9;
        const showFixLabels = zoom >= 10;
        const navaidVorOnly = zoom < 9; // zoom 7-8: VOR/VORTAC only

        // --- Navaids ---
        if (showNavaids) {
            try {
                const navaids = await this._nasr.getNavaidsinBounds(south, west, north, east);
                const currentIds = new Set();

                for (const nav of navaids) {
                    if (!nav.lat || !nav.lon) continue;

                    // At zoom 7-8, only show VOR/VORTAC
                    if (navaidVorOnly) {
                        const t = (nav.type || '').toUpperCase();
                        if (t !== 'VOR' && t !== 'VORTAC' && t !== 'VOR/DME') continue;
                    }

                    currentIds.add(nav.id);
                    const style = CockpitMap._navaidStyle(nav.type);

                    if (this._navaidMarkers.has(nav.id)) {
                        // Update existing marker position
                        const m = this._navaidMarkers.get(nav.id);
                        m.setLatLng([nav.lat, nav.lon]);
                    } else {
                        // Create new marker
                        const m = L.circleMarker([nav.lat, nav.lon], {
                            renderer: this._canvasRenderer,
                            radius: style.radius,
                            color: style.color,
                            fillColor: style.color,
                            fillOpacity: 0.9,
                            weight: 1,
                        });
                        m.bindTooltip(nav.id, {
                            permanent: showNavaidLabels,
                            direction: 'right',
                            offset: [8, 0],
                            className: 'nav-label',
                        });
                        m.addTo(this._navaidLayer);
                        this._navaidMarkers.set(nav.id, m);
                    }

                    // Update tooltip permanence based on zoom
                    const m = this._navaidMarkers.get(nav.id);
                    const tip = m.getTooltip();
                    if (tip && tip.options.permanent !== showNavaidLabels) {
                        m.unbindTooltip();
                        m.bindTooltip(nav.id, {
                            permanent: showNavaidLabels,
                            direction: 'right',
                            offset: [8, 0],
                            className: 'nav-label',
                        });
                    }
                }

                // Remove markers no longer in viewport
                for (const [id, marker] of this._navaidMarkers) {
                    if (!currentIds.has(id)) {
                        this._navaidLayer.removeLayer(marker);
                        this._navaidMarkers.delete(id);
                    }
                }
            } catch (err) {
                console.warn('Fix overlay: navaid query failed', err);
            }
        } else {
            // Clear all navaid markers when hidden
            for (const [id, marker] of this._navaidMarkers) {
                this._navaidLayer.removeLayer(marker);
            }
            this._navaidMarkers.clear();
        }

        // --- Fixes ---
        if (showFixes) {
            try {
                const fixes = await this._nasr.getFixesInBounds(south, west, north, east);
                const currentIds = new Set();

                for (const fix of fixes) {
                    if (!fix.lat || !fix.lon) continue;
                    currentIds.add(fix.id);

                    if (this._fixMarkers.has(fix.id)) {
                        const m = this._fixMarkers.get(fix.id);
                        m.setLatLng([fix.lat, fix.lon]);
                    } else {
                        const m = L.circleMarker([fix.lat, fix.lon], {
                            renderer: this._canvasRenderer,
                            radius: 3,
                            color: '#ffffff',
                            fillColor: '#ffffff',
                            fillOpacity: 0.8,
                            weight: 1,
                        });
                        m.bindTooltip(fix.id, {
                            permanent: showFixLabels,
                            direction: 'right',
                            offset: [6, 0],
                            className: 'fix-label',
                        });
                        m.addTo(this._fixLayer);
                        this._fixMarkers.set(fix.id, m);
                    }
                }

                // Remove markers no longer in viewport
                for (const [id, marker] of this._fixMarkers) {
                    if (!currentIds.has(id)) {
                        this._fixLayer.removeLayer(marker);
                        this._fixMarkers.delete(id);
                    }
                }
            } catch (err) {
                console.warn('Fix overlay: fix query failed', err);
            }
        } else {
            for (const [id, marker] of this._fixMarkers) {
                this._fixLayer.removeLayer(marker);
            }
            this._fixMarkers.clear();
        }
    }

    /** Style lookup for navaid types */
    static _navaidStyle(type) {
        const t = (type || '').toUpperCase();
        if (t === 'VOR' || t === 'VORTAC' || t === 'VOR/DME') {
            return { color: '#4488ff', radius: 6 };
        }
        if (t === 'NDB' || t === 'NDB/DME') {
            return { color: '#ff44ff', radius: 5 };
        }
        if (t === 'DME' || t === 'TACAN') {
            return { color: '#44aaff', radius: 4 };
        }
        return { color: '#4488ff', radius: 5 }; // fallback
    }

    toggleNavaids(on) {
        this._showNavaids = on;
        Settings.showNavaids = on;
        if (on) {
            this._navaidLayer.addTo(this.map);
        } else {
            this.map.removeLayer(this._navaidLayer);
            // Clear markers to free memory
            for (const [, marker] of this._navaidMarkers) this._navaidLayer.removeLayer(marker);
            this._navaidMarkers.clear();
        }
        this._scheduleFixUpdate();
    }

    toggleFixes(on) {
        this._showFixes = on;
        Settings.showFixes = on;
        if (on) {
            this._fixLayer.addTo(this.map);
        } else {
            this.map.removeLayer(this._fixLayer);
            for (const [, marker] of this._fixMarkers) this._fixLayer.removeLayer(marker);
            this._fixMarkers.clear();
        }
        this._scheduleFixUpdate();
    }

    // ========== Geo Utilities ==========

    static _distNm(lat1, lon1, lat2, lon2) {
        const R = 3440.065; // NM
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    static _bearing(lat1, lon1, lat2, lon2) {
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const rLat1 = lat1 * Math.PI / 180;
        const rLat2 = lat2 * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(rLat2);
        const x = Math.cos(rLat1) * Math.sin(rLat2) - Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
        return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    }
}
