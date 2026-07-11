/**
 * FlyPi — Cockpit Moving Map
 * Leaflet-based map with sectional tiles, own-ship, traffic, route, radar.
 */

/**
 * Internet NEXRAD radar source for RadarLoop.
 * Uses IEM (Iowa State Mesonet) fixed-offset composite products:
 *   nexrad-n0q-m55m … nexrad-n0q-m05m (past 55 min), nexrad-n0q-900913 (current)
 * One tile layer per frame, all added at opacity 0 so tiles preload immediately.
 * Implements the same interface as FisbNexrad so RadarLoop drives both transparently.
 */
class InetRadarSource {
    static PRODUCTS = [
        { offset: -55, product: 'nexrad-n0q-m55m' },
        { offset: -50, product: 'nexrad-n0q-m50m' },
        { offset: -45, product: 'nexrad-n0q-m45m' },
        { offset: -40, product: 'nexrad-n0q-m40m' },
        { offset: -35, product: 'nexrad-n0q-m35m' },
        { offset: -30, product: 'nexrad-n0q-m30m' },
        { offset: -25, product: 'nexrad-n0q-m25m' },
        { offset: -20, product: 'nexrad-n0q-m20m' },
        { offset: -15, product: 'nexrad-n0q-m15m' },
        { offset: -10, product: 'nexrad-n0q-m10m' },
        { offset:  -5, product: 'nexrad-n0q-m05m' },
        { offset:   0, product: 'nexrad-n0q-900913' },
    ];

    constructor(map, radarLayer, isOnline) {
        this._map = map;
        this._radarLayer = radarLayer;  // live current tile — hidden while loop plays
        this._isOnline = isOnline || null;  // () => bool; null = assume online
        this._frames = [];
        this._layers = [];
        this._loopActive = false;
        this._baseOpacity = Settings.radarOpacity || 0.5;
        this.sourceType = 'inet';
        this._buildLayers();
    }

    get isActive() { return true; }
    get hasData() { return this._frames.length > 0; }
    get blockCount() { return 0; }
    get frameHistory() { return this._frames; }
    getDataAgeMs() { return null; }

    addTo() {}  // no-op — map already stored in constructor

    drawLive() {
        if (!this._loopActive && this._radarLayer) {
            this._radarLayer.setOpacity(this._baseOpacity ?? Settings.radarOpacity ?? 0.5);
        }
    }

    enterLoopMode() {
        this._loopActive = true;
        if (this._radarLayer) this._radarLayer.setOpacity(0);
    }

    exitLoopMode() {
        this._loopActive = false;
        this._layers.forEach(l => l.setOpacity(0));
        if (this._radarLayer) this._radarLayer.setOpacity(this._baseOpacity ?? Settings.radarOpacity ?? 0.5);
    }

    drawFrame(index) {
        if (index < 0 || index >= this._layers.length) return;
        // _baseOpacity is 0 when FIS-B is the *display* source (live tile hidden).
        // But when the loop drives this source it is the only radar on screen —
        // loop frames must never inherit that 0 or playback is invisible.
        const opacity = this._baseOpacity > 0 ? this._baseOpacity : (Settings.radarOpacity || 0.5);
        this._layers.forEach((l, i) => l.setOpacity(i === index ? opacity : 0));
    }

    _buildLayers() {
        const now = Date.now();
        InetRadarSource.PRODUCTS.forEach(({ offset, product }) => {
            const url = `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${product}/{z}/{x}/{y}.png`;
            const layer = L.tileLayer(url, {
                opacity: 0,
                minNativeZoom: 6,   // IEM returns "Zoom Level Not Supported" below z6
                maxZoom: 14,
                zIndex: 195,        // above chart rasters (100/110), below live radar (200)
                updateWhenZooming: false,
                attribution: 'NEXRAD © Iowa State Mesonet',
            });
            layer.addTo(this._map);
            this._layers.push(layer);
            this._frames.push({ time: now + offset * 60 * 1000 });
        });
    }

    refresh() {
        // Offline (in flight): redraw() would discard loaded tiles and the refetch
        // would fail, blanking every frame. Keep what we have.
        if (this._isOnline && !this._isOnline()) return;
        const now = Date.now();
        this._layers.forEach(l => l.redraw());
        this._frames = InetRadarSource.PRODUCTS.map(({ offset }) => ({
            time: now + offset * 60 * 1000,
        }));
    }

    cleanup() {
        this._layers.forEach(l => { if (this._map?.hasLayer(l)) this._map.removeLayer(l); });
        this._layers = [];
        this._frames = [];
        this._radarLayer = null;
        this._map = null;
    }

    setBaseOpacity(opacity) {
        this._baseOpacity = opacity;
        if (!this._loopActive && this._radarLayer) {
            this._radarLayer.setOpacity(opacity);
        }
    }
}

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
        this._radarSource = 'fisb';   // preference: 'fisb' | 'inet'; loaded from localStorage at radar enable
        this._radarSourceEffective = null;  // what is actually shown after availability failover
        this._inetOk = null;          // internet reachability from radar tile results
        this._inetErrCount = 0;
        this._inetRadarSource = null;
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
        this._enginePage = null;
        this._fuelOverlay = null;
        this._logbook = null;

        // PIREP markers (FIS-B pilot reports)
        this._pirepMarkers = new Map();  // key → L.marker
        this._pirepLayer = null;         // L.LayerGroup
        this._showPireps = false;        // off by default
        this._fisbClient = null;

        // TFR overlay — FIS-B (via setFisbClient) + NOTAM (via notam:tfrs event)
        this._tfrLayer = null;           // L.LayerGroup (FIS-B TFRs, created in setFisbClient)
        this._tfrShapes = new Map();     // raw → L.layer (FIS-B)
        this._notamTfrGroup = null;      // L.LayerGroup (NOTAM TFRs, created in init)
        this._notamTfrShapes = new Map(); // raw → L.layer (NOTAM)
        this._showTfrs = true;           // default ON

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
        this._trafficAltBypass = false;
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
            wheelPxPerZoomLevel: 120,  // default 60 causes 2-level jumps on standard mice; 120 = 1 level per tick
        });

        // Guard against Infinity zoom from Leaflet's touch-zoom handler:
        // when keyboard cover closes and fires two touch points at identical coordinates,
        // _startDist=0 → distance/0=NaN → getScaleZoom returns 1/0=Infinity.
        // During the switchBaseLayer('vector') init window, maxZoom=Infinity so
        // _limitZoom(Infinity)=Infinity and the map enters a permanently broken state.
        const _guardedSetZoom = this.map.setZoom.bind(this.map);
        this.map.setZoom = (zoom, opts) => {
            if (!isFinite(zoom)) return this.map;
            return _guardedSetZoom(zoom, opts);
        };
        const _guardedSetView = this.map.setView.bind(this.map);
        this.map.setView = (center, zoom, opts) => {
            if (zoom !== undefined && !isFinite(zoom)) zoom = 8;
            return _guardedSetView(center, zoom, opts);
        };

        // Tile layers
        this._setupLayers();

        // Corner buttons (auto-pan, D→)
        this._addCornerButtons();

        // Zoom level in header
        this._zoomBadgeHandler = () => this._updateZoomBadge();
        this.map.on('zoomend', this._zoomBadgeHandler);
        this._updateZoomBadge();

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

        // Hide ownship when Stratux disconnects or data goes stale — never show stale position
        const _hideOwnship = () => {
            if (this.ownshipMarker) this.ownshipMarker.setOpacity(0);
        };
        this.stratux.addEventListener('stratux:disconnect', _hideOwnship);
        this.stratux.addEventListener('stratux:stale', _hideOwnship);

        // Periodic traffic cleanup
        this._trafficTimer = setInterval(() => this._updateTraffic(), 2000);

        // Suppress synthetic clicks that follow a Leaflet popup close button tap.
        // The X button is inside the map container but outside wireTap, so _wireTapLastTouchAt
        // is never set. Track the last touchend on the map container; on popupclose, if a touch
        // happened within 500ms, brand _wireTapLastTouchAt to block the follow-on synthetic click.
        this._lastMapContainerTouchAt = 0;
        this.map.getContainer().addEventListener('touchend', () => {
            this._lastMapContainerTouchAt = Date.now();
        }, { passive: true, capture: true });
        this.map.on('popupclose', () => {
            if (Date.now() - this._lastMapContainerTouchAt < 500) {
                if (typeof _wireTapLastTouchAt !== 'undefined') _wireTapLastTouchAt = Date.now();
            }
        });

        // NOTAM TFR layer — independent of FIS-B
        this._notamTfrGroup = L.layerGroup();
        if (this._showTfrs) this._notamTfrGroup.addTo(this.map);
        this._onNotamTfrs = (e) => {
            if (!this._notamTfrGroup) return;
            if (e.type !== 'notam:tfrs-apt') {
                // En-route refresh: clear all and rebuild
                this._notamTfrShapes.clear();
                this._notamTfrGroup.clearLayers();
            }
            for (const shape of (e.detail?.shapes || [])) {
                this._addNotamTfrShape(shape);
            }
        };
        document.addEventListener('notam:tfrs', this._onNotamTfrs);
        document.addEventListener('notam:tfrs-apt', this._onNotamTfrs);
    }

    /** Provide a NasrDB instance for fix/navaid queries */
    setNasrDB(nasrDb) {
        this._nasr = nasrDb;
        // Only use legacy fix overlay if vector layers aren't active
        if (this._initialized && !this._vectorLayers) this._setupFixOverlay();
    }

    _updateZoomBadge() {
        if (!this.map) return;
        const el = document.getElementById('statusZoom');
        if (el) el.textContent = `Z${Math.round(this.map.getZoom())}`;
    }

    destroy() {
        if (this._onNotamTfrs) {
            document.removeEventListener('notam:tfrs', this._onNotamTfrs);
            document.removeEventListener('notam:tfrs-apt', this._onNotamTfrs);
            this._onNotamTfrs = null;
        }
        if (this._trafficTimer) { clearInterval(this._trafficTimer); this._trafficTimer = null; }
        if (this._fixUpdateTimer) { clearTimeout(this._fixUpdateTimer); this._fixUpdateTimer = null; }
        if (this._radarBadgeTimer) { clearInterval(this._radarBadgeTimer); this._radarBadgeTimer = null; }
        if (this._zoomBadgeHandler && this.map) { this.map.off('zoomend', this._zoomBadgeHandler); this._zoomBadgeHandler = null; }
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
        // On Android (Capacitor native), tiles are served from NanoHTTPD at localhost:9090.
        // In a browser (dev/desktop), fall back to the home server tiles if configured.
        const isNative = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform?.();
        const homeBase = typeof CockpitConfig !== 'undefined' ? CockpitConfig.homeBase : null;
        const tileBase = isNative ? 'http://localhost:9090/tiles'
                       : homeBase ? `${homeBase}/tiles`
                       : 'http://localhost:9090/tiles';
        console.log('[FlyTab] Tile base:', tileBase);

        // Tile z-index bands — stacking must NOT depend on addTo() order.
        // switchBaseLayer() re-adds chart layers at runtime; without explicit
        // zIndex a re-added chart lands after (above) the radar tile layers in
        // the tile pane and NEXRAD renders invisibly underneath the chart.
        // Bands: base charts 100, IFR area inset 110, radar loop frames 195,
        // live radar 200 (see toggleRadar / InetRadarSource).

        // FAA Sectional — 256px tiles, z5-11
        this._sectionalLayer = L.tileLayer(`${tileBase}/sectional/{z}/{x}/{y}.webp`, {
            minZoom: 5,
            minNativeZoom: 5,
            maxNativeZoom: 11,
            maxZoom: 14,
            zIndex: 100,
            tms: false,
            updateWhenZooming: false,
            keepBuffer: 1,
            attribution: 'FAA Sectional Charts',
            errorTileUrl: '',
        });

        // IFR Low Enroute — FAA GeoTIFF source (ENR_L series), 512px retina tiles z4-z10.
        // 512px images render at 256px CSS = 2x density on HiDPI displays.
        // updateWhenZooming: false — waits for zoom end before loading new tiles (no seam flash).
        this._ifrLayer = L.tileLayer(`${tileBase}/ifr-low/{z}/{x}/{y}.webp`, {
            minZoom: 4,
            minNativeZoom: 4,
            maxNativeZoom: 10,
            maxZoom: 14,
            zIndex: 100,
            tms: false,
            updateWhenZooming: false,
            keepBuffer: 1,
            attribution: 'FAA IFR Low Enroute',
            errorTileUrl: '',
        });

        // IFR Area Charts — FAA GeoTIFF source (ENR_A series), 512px retina z10-z12.
        // Terminal area detail near major airports. Separate from IFR Low Enroute layer.
        // minZoom:11 — avoids the jarring scale mismatch with IFR Low at zoom 10
        // (IFR Area source charts are printed at ~2x the scale of IFR Low).
        this._ifrAreaLayer = L.tileLayer(`${tileBase}/ifr-area/{z}/{x}/{y}.webp`, {
            minZoom: 11,
            minNativeZoom: 10,
            maxNativeZoom: 12,
            maxZoom: 14,
            zIndex: 110,
            tms: false,
            updateWhenZooming: false,
            keepBuffer: 1,
            attribution: 'FAA IFR Area Charts',
            errorTileUrl: '',
        });

        // Log tile errors for debugging
        const logTileError = (layer) => {
            layer.on('tileerror', (e) => {
                const { x, y, z } = e.coords || {};
                if (typeof DiagLog !== 'undefined') DiagLog.log('tiles', `404: ${layer._url?.replace('{z}',z).replace('{x}',x).replace('{y}',y) || '?'}`);
            });
        };
        // TAC (Terminal Area Charts) — higher detail around Class B airspace, VFR flyways
        this._tacLayer = L.tileLayer(`${tileBase}/tac/{z}/{x}/{y}.webp`, {
            minZoom: 8,
            minNativeZoom: 8,
            maxNativeZoom: 12,
            maxZoom: 14,
            zIndex: 100,
            tms: false,
            updateWhenZooming: false,
            keepBuffer: 1,
            attribution: 'FAA Terminal Area Charts',
            errorTileUrl: '',
        });

        logTileError(this._sectionalLayer);
        logTileError(this._ifrLayer);
        logTileError(this._tacLayer);
        logTileError(this._ifrAreaLayer);

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

    /** Wire FIS-B client for live PIREP and TFR overlays */
    setFisbClient(fisbClient) {
        if (this._fisbClient) return; // already wired
        this._fisbClient = fisbClient;

        // Layer groups
        this._pirepLayer = L.layerGroup();
        this._tfrLayer = L.layerGroup();
        if (this._showTfrs && this.map) this._tfrLayer.addTo(this.map);

        // New PIREP received
        this._onFisbPirep = (e) => {
            if (this._showPireps) this._addPirepMarker(e.detail);
        };
        fisbClient.addEventListener('fisb:pirep', this._onFisbPirep);

        // New NOTAM/TFR received
        this._onFisbNotam = (e) => {
            if (e.detail.is_tfr && this._showTfrs) this._addTfrShape(e.detail);
        };
        fisbClient.addEventListener('fisb:notam', this._onFisbNotam);

        // Periodic purge — remove markers for expired data
        this._pirepPurgeTimer = setInterval(() => {
            // PIREPs
            if (this._showPireps) {
                const activeRaws = new Set(fisbClient.pireps.map(p => p.raw));
                for (const [key, marker] of this._pirepMarkers) {
                    if (!activeRaws.has(key)) {
                        this._pirepLayer.removeLayer(marker);
                        this._pirepMarkers.delete(key);
                    }
                }
            }
            // TFRs
            if (this._showTfrs) {
                const activeRaws = new Set(fisbClient.notams.filter(n => n.is_tfr).map(n => n.raw));
                for (const [key, shape] of this._tfrShapes) {
                    if (!activeRaws.has(key)) {
                        this._tfrLayer.removeLayer(shape);
                        this._tfrShapes.delete(key);
                    }
                }
            }
        }, 30000);
    }

    togglePireps(on) {
        this._showPireps = on;
        if (!this._pirepLayer || !this.map) return;
        if (on) {
            this._pirepLayer.addTo(this.map);
            // Render any PIREPs already in memory
            if (this._fisbClient) {
                this._pirepMarkers.clear();
                this._pirepLayer.clearLayers();
                for (const p of this._fisbClient.pireps) this._addPirepMarker(p);
            }
        } else {
            this.map.removeLayer(this._pirepLayer);
        }
    }

    toggleTfrs(on) {
        this._showTfrs = on;
        if (!this.map) return;
        if (on) {
            if (this._tfrLayer) {
                this._tfrLayer.addTo(this.map);
                if (this._fisbClient) {
                    this._tfrShapes.clear();
                    this._tfrLayer.clearLayers();
                    for (const n of this._fisbClient.notams) {
                        if (n.is_tfr) this._addTfrShape(n);
                    }
                }
            }
            if (this._notamTfrGroup) this._notamTfrGroup.addTo(this.map);
        } else {
            if (this._tfrLayer) this.map.removeLayer(this._tfrLayer);
            if (this._notamTfrGroup) this.map.removeLayer(this._notamTfrGroup);
        }
    }

    toggleIfrArea(on) {
        if (!this._ifrAreaLayer || !this.map) return;
        if (on) {
            this._ifrAreaLayer.addTo(this.map);
        } else {
            this.map.removeLayer(this._ifrAreaLayer);
        }
    }

    _addNotamTfrShape(shape) {
        if (this._notamTfrShapes.has(shape.raw)) return;

        const fill   = 'rgba(220,38,38,0.15)';
        const stroke = '#dc2626';
        const weight = 2.5;

        let layer = null;

        if (shape.points?.length >= 3) {
            layer = L.polygon(shape.points, {
                color: stroke, fillColor: fill,
                weight, opacity: 1, fillOpacity: 0.2,
                dashArray: '6,4',
            });
        } else if (shape.radiusNm != null && shape.lat != null && shape.lon != null) {
            layer = L.circle([shape.lat, shape.lon], {
                radius: shape.radiusNm * 1852,
                color: stroke, fillColor: fill,
                weight, opacity: 1, fillOpacity: 0.2,
                dashArray: '6,4',
            });
        }

        if (!layer) return;

        const validStr = shape.validTo
            ? `Exp: ${new Date(shape.validTo).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} L`
            : '';
        const popupHtml = `
            <div style="max-width:280px;font-family:monospace">
                <div style="font-weight:700;font-size:13px;color:#dc2626;margin-bottom:4px">
                    ⛔ TFR <span style="font-size:10px;color:#888">${validStr}</span>
                </div>
                <div style="font-size:11px;color:#444;word-break:break-all;white-space:pre-wrap">${shape.summary}</div>
            </div>`;
        layer.bindPopup(popupHtml, { maxWidth: 300 });
        layer.addTo(this._notamTfrGroup);
        this._notamTfrShapes.set(shape.raw, layer);
    }

    _addTfrShape(notam) {
        if (this._tfrShapes.has(notam.raw)) return;  // already shown

        const fill   = 'rgba(220,38,38,0.15)';
        const stroke = '#dc2626';
        const weight = 2.5;

        let shape = null;

        // Polygon from Points array or parsed text
        if (notam.points && notam.points.length >= 3) {
            shape = L.polygon(notam.points, {
                color: stroke, fillColor: fill,
                weight, opacity: 1, fillOpacity: 0.2,
                dashArray: '6,4',
            });
        }
        // Circle from radius
        else if (notam.radius_nm && notam.lat && notam.lon) {
            shape = L.circle([notam.lat, notam.lon], {
                radius: notam.radius_nm * 1852, // nm → metres
                color: stroke, fillColor: fill,
                weight, opacity: 1, fillOpacity: 0.2,
                dashArray: '6,4',
            });
        }
        // Point marker (no geometry — just a flag at the location)
        else if (notam.lat && notam.lon) {
            const icon = L.divIcon({
                className: 'tfr-icon',
                html: `<div style="background:#dc2626;color:#fff;font-size:10px;font-weight:700;padding:2px 5px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.5)">TFR</div>`,
                iconAnchor: [15, 10],
            });
            shape = L.marker([notam.lat, notam.lon], { icon, zIndexOffset: 700 });
        }

        if (!shape) return;

        // Build popup
        const ageMin = Math.round((Date.now() - notam.received_at) / 60000);
        const ageStr = ageMin < 1 ? 'just now' : `${ageMin}m ago`;
        const icao   = notam.icao ? `<strong>${notam.icao}</strong> · ` : '';
        const expiry = notam.expires_at
            ? `Exp: ${new Date(notam.expires_at).toUTCString().slice(17, 22)}Z`
            : '';

        const popupHtml = `
            <div style="max-width:280px;font-family:monospace">
                <div style="font-weight:700;font-size:13px;color:#dc2626;margin-bottom:4px">
                    ⛔ TFR ${icao}<span style="font-size:10px;color:#888">${ageStr} ${expiry}</span>
                </div>
                <div style="font-size:11px;color:#444;word-break:break-all;white-space:pre-wrap">${notam.raw}</div>
            </div>`;

        shape.bindPopup(popupHtml, { maxWidth: 300 });
        shape.addTo(this._tfrLayer);
        this._tfrShapes.set(notam.raw, shape);
    }

    _addPirepMarker(pirep) {
        if (!pirep.lat || !pirep.lon) return;  // no position data
        if (this._pirepMarkers.has(pirep.raw)) return;  // already shown

        const COLORS = { turbulence: '#f97316', icing: '#60a5fa', other: '#facc15' };
        const color = pirep.is_urgent ? '#ef4444' : (COLORS[pirep.type] || COLORS.other);

        // Size 10–22px based on severity 0–4
        const size = 10 + Math.min(pirep.severity || 1, 4) * 3;

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
            <polygon points="12,2 22,12 12,22 2,12"
                fill="${color}" fill-opacity="0.85"
                stroke="${pirep.is_urgent ? '#fff' : color}" stroke-width="${pirep.is_urgent ? 2 : 0}"/>
        </svg>`;

        const icon = L.divIcon({
            className: 'pirep-icon',
            html: svg,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
        });

        const marker = L.marker([pirep.lat, pirep.lon], { icon, zIndexOffset: 400 });

        // Popup
        const typeLabel = pirep.type === 'turbulence' ? 'TURB'
                        : pirep.type === 'icing'       ? 'ICE'
                        : 'PIREP';
        const sevLabels = ['NEG', 'LGT', 'MOD', 'SVR', 'EXTRM'];
        const sevLabel  = sevLabels[Math.min(pirep.severity || 0, 4)] || '';
        const altLabel  = pirep.altitude ? `FL${Math.round(pirep.altitude / 100).toString().padStart(3,'0')}` : '';
        const ageMin    = Math.round((Date.now() - pirep.received_at) / 60000);
        const ageStr    = ageMin < 1 ? 'just now' : `${ageMin}m ago`;
        const urgent    = pirep.is_urgent ? '<span style="color:#ef4444;font-weight:700"> URGENT</span>' : '';

        const popupHtml = `
            <div style="max-width:260px;font-family:monospace">
                <div style="font-weight:700;font-size:13px;margin-bottom:4px">
                    ${typeLabel} ${sevLabel}${urgent} ${altLabel}
                    <span style="font-size:10px;color:#888;margin-left:6px">${ageStr}</span>
                </div>
                <div style="font-size:11px;color:#555;word-break:break-all;white-space:pre-wrap">${pirep.raw}</div>
            </div>`;

        marker.bindPopup(popupHtml, { maxWidth: 280 });
        marker.addTo(this._pirepLayer);
        this._pirepMarkers.set(pirep.raw, marker);
    }

    switchBaseLayer(name) {
        if (this.map.hasLayer(this._sectionalLayer)) this.map.removeLayer(this._sectionalLayer);
        if (this._ifrLayer && this.map.hasLayer(this._ifrLayer)) this.map.removeLayer(this._ifrLayer);
        if (this._tacLayer && this.map.hasLayer(this._tacLayer)) this.map.removeLayer(this._tacLayer);

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
            } else if (name === 'tac') {
                this._tacLayer.addTo(this.map);
            } else {
                this._sectionalLayer.addTo(this.map);
            }
        }
        this._activeBaseLayer = name;
    }

    toggleLightning(on) {
        if (!this._lightning) return;
        if (on) this._lightning.show(this.map);
        else this._lightning.hide();
    }

    // ========== NEXRAD Radar ==========

    toggleRadar(on) {
        if (on && !this.radarLayer) {
            // Load persisted source preference; default to FIS-B
            this._radarSource = localStorage.getItem('flytab_radar_source') || 'fisb';

            // Always attach FIS-B canvas to DOM so frame accumulation and CB building work
            // regardless of which source is currently displayed.
            if (this._fisbNexrad) this._fisbNexrad.addTo(this.map);

            // Internet tile — always added to map; opacity set by _applyRadarSource below
            this.radarLayer = L.tileLayer(
                'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
                {
                    opacity: 0,   // _applyRadarSource sets correct opacity immediately after
                    minNativeZoom: 6,
                    maxZoom: 14,
                    zIndex: 200,  // above chart rasters (100/110) — see _setupLayers
                    updateWhenZooming: false,
                    attribution: 'NEXRAD © Iowa State Mesonet',
                }
            );
            // Internet reachability from live tile results. navigator.onLine is useless
            // on Stratux WiFi (connected, but no route to the internet) — tile outcomes
            // are the only real signal. Drives automatic source failover.
            this._inetOk = null;   // null = unknown (optimistic), true, false
            this._inetErrCount = 0;
            this.radarLayer.on('tileload', () => {
                this._inetErrCount = 0;
                if (this._inetOk !== true) {
                    this._inetOk = true;
                    this._autoSelectRadarSource();
                }
            });
            this.radarLayer.on('tileerror', () => {
                if (++this._inetErrCount >= 3 && this._inetOk !== false) {
                    this._inetOk = false;
                    this._autoSelectRadarSource();
                }
            });
            this.radarLayer.addTo(this.map);

            // Tell FisbNexrad about the internet tile so CB building can sample it
            if (this._fisbNexrad) this._fisbNexrad.setCbInternetLayer(this.radarLayer);

            // Internet source — always created; preloads 12 IEM tile layers at opacity 0
            this._inetRadarSource = new InetRadarSource(this.map, this.radarLayer, () => this._inetOk !== false);

            // Start loop on internet (safe starting point — IEM always has 12 frames)
            if (this._radarLoop) this._radarLoop.setNexrad(this._inetRadarSource);

            // Apply the best available source immediately (sets opacities, switches loop)
            this._radarSourceEffective = null;
            this._autoSelectRadarSource();

            // Badge — show immediately; re-evaluate source + badge every 30 s
            this._updateRadarBadge();
            if (!this._radarBadgeTimer) {
                this._radarBadgeTimer = setInterval(() => {
                    this._autoSelectRadarSource();
                    this._updateRadarBadge();
                }, 30000);
            }
        } else if (!on && this.radarLayer) {
            if (this._fisbNexrad) {
                this._fisbNexrad.setCbInternetLayer(null);
                this._fisbNexrad.remove();
            }
            if (this._inetRadarSource) {
                this._inetRadarSource.cleanup();
                this._inetRadarSource = null;
            }
            this.map.removeLayer(this.radarLayer);
            this.radarLayer = null;
            this._radarSourceEffective = null;
            // Hide badge and stop refresh timer
            if (this._radarBadge) this._radarBadge.style.display = 'none';
            clearInterval(this._radarBadgeTimer); this._radarBadgeTimer = null;
        }
    }

    /**
     * Called by FisbNexrad when it receives its first live data block.
     * May flip the effective source to FIS-B if it is the preferred source.
     */
    onFisbNexradData() {
        if (!this.radarLayer) return;
        this._autoSelectRadarSource();
        this._updateRadarBadge();
    }

    /**
     * Called by FisbNexrad when it has accumulated 2+ historical frames —
     * enough for visible animation.  Switches the radar loop source from the
     * internet tile fallback to the FIS-B canvas renderer.
     */
    onFisbNexradLoopReady() {
        if ((this._radarSourceEffective ?? this._radarSource) !== 'fisb') return;
        if (this._radarLoop && this._fisbNexrad) {
            this._radarLoop.setNexrad(this._fisbNexrad);
        }
    }

    /** FIS-B radar considered usable when either product has data fresher than 20 min. */
    _fisbRadarAvailable() {
        if (!this._fisbNexrad) return false;
        const ages = [
            this._fisbNexrad.getDataAgeMs('regional'),
            this._fisbNexrad.getDataAgeMs('conus'),
        ].filter(a => a != null);
        return ages.length > 0 && Math.min(...ages) < 20 * 60000;
    }

    /**
     * Resolve which source can actually show radar right now.
     * The persisted preference wins when its data is available; otherwise fall
     * back to the other source if IT has data. Ground: FIS-B pref falls back to
     * internet (no towers on the ground). Air: internet pref falls back to FIS-B
     * (Stratux WiFi has no internet). Neither available → preference (blank until
     * data arrives, badge shows why).
     */
    _resolveRadarSource() {
        const fisbOk = this._fisbRadarAvailable();
        const inetOk = this._inetOk !== false;   // unknown = optimistic
        if (this._radarSource === 'fisb') return fisbOk ? 'fisb' : (inetOk ? 'inet' : 'fisb');
        return inetOk ? 'inet' : (fisbOk ? 'fisb' : 'inet');
    }

    /** Apply the resolved source if it changed. Idempotent; safe to call from timers. */
    _autoSelectRadarSource() {
        if (!this.radarLayer) return;   // radar off
        const eff = this._resolveRadarSource();
        if (eff === this._radarSourceEffective) return;
        this._radarSourceEffective = eff;
        if (typeof DiagLog !== 'undefined') DiagLog.log('radar', `source auto-select: pref=${this._radarSource} effective=${eff} inetOk=${this._inetOk} fisbOk=${this._fisbRadarAvailable()}`);
        this._applyRadarSource(eff);
        this._updateRadarBadge();
    }

    _updateRadarBadge() {
        if (!this._fisbNexrad) return;
        const el = this._radarBadge || (this._radarBadge = (() => {
            const d = document.createElement('div');
            d.className = 'radar-badge';
            this.container.appendChild(d);

            // Tap handler — standard project pattern (touchstart capture + touchend bubble)
            let _tapStart = null;
            d.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1)
                    _tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
                else _tapStart = null;
            }, { capture: true, passive: true });
            d.addEventListener('touchend', (e) => {
                if (!_tapStart || e.changedTouches.length !== 1) { _tapStart = null; return; }
                const s = _tapStart; _tapStart = null;
                const dx = e.changedTouches[0].clientX - s.x;
                const dy = e.changedTouches[0].clientY - s.y;
                if (dx * dx + dy * dy > 400) return;   // >20px = drag
                if (Date.now() - s.t > 500) return;     // >500ms = long-press
                this._toggleRadarSource();
            }, { passive: true });

            return d;
        })());

        el.style.display = 'block';   // always visible while radar is on

        // Show the EFFECTIVE source; mark auto-fallback when it differs from the preference.
        const pref = this._radarSource;
        const eff  = this._radarSourceEffective ?? pref;
        if (eff === 'inet') {
            el.textContent = (pref === 'fisb' ? 'FIS-B ✕ → ' : '') + 'Internet · NEXRAD  ⇄';
            return;
        }
        // FIS-B mode
        const ageMs = this._fisbNexrad.getDataAgeMs('regional');
        const age = ageMs == null ? '--' : Math.round(ageMs / 60000);
        el.textContent = (pref === 'inet' ? 'Internet ✕ → ' : '') + `FIS-B · Regional · ${age} min  ⇄`;
    }

    toggleCbBuilding(on) {
        this._fisbNexrad?.setCbBuilding(on);
    }

    _applyRadarSource(source) {
        if (source === 'fisb') {
            if (this._fisbNexrad) this._fisbNexrad.show();
            if (this._inetRadarSource) this._inetRadarSource.setBaseOpacity(0);
            if (this.radarLayer) this.radarLayer.setOpacity(0);
            // This inline check is load-bearing: once _loopReadyFired is true,
            // onFisbNexradLoopReady() never re-fires, so toggling back to FIS-B
            // after a session in internet mode must switch the loop source here.
            // Also switch when the internet is unreachable: blank INET frames are
            // useless in flight — FIS-B self-starts via setOnReady as frames arrive.
            if (this._radarLoop && this._fisbNexrad &&
                    ((this._fisbNexrad.frameHistory.length ?? 0) >= 2 || this._inetOk === false)) {
                this._radarLoop.setNexrad(this._fisbNexrad);
            }
            // else: loop stays on _inetRadarSource until onFisbNexradLoopReady() fires
        } else {
            if (this._fisbNexrad) this._fisbNexrad.hide();
            const opacity = Settings.radarOpacity || 0.5;
            if (this._inetRadarSource) this._inetRadarSource.setBaseOpacity(opacity);
            if (this.radarLayer) this.radarLayer.setOpacity(opacity);
            if (this._radarLoop && this._inetRadarSource) {
                this._radarLoop.setNexrad(this._inetRadarSource);
            }
        }
    }

    _toggleRadarSource() {
        this._radarSource = (this._radarSource === 'fisb') ? 'inet' : 'fisb';
        localStorage.setItem('flytab_radar_source', this._radarSource);
        // Re-resolve availability against the new preference (may still fall back)
        this._radarSourceEffective = null;
        this._autoSelectRadarSource();
        this._updateRadarBadge();
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

        // Track vector — 3-minute lookahead line, only when airborne
        if (sit.ground_speed >= 10 && sit.true_course != null) {
            const nm = sit.ground_speed * 3 / 60;
            const end = CockpitMap._destPoint(sit.lat, sit.lon, sit.true_course, nm);
            if (!this._trackVector) {
                this._trackVector = L.polyline([pos, end], {
                    color: '#ffffff', weight: 2, opacity: 0.6, interactive: false,
                }).addTo(this.map);
            } else {
                this._trackVector.setLatLngs([pos, end]);
                if (this._trackVector.options.opacity !== 0.6) this._trackVector.setStyle({ opacity: 0.6 });
            }
        } else if (this._trackVector) {
            this._trackVector.setStyle({ opacity: 0 });
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

        const trafficCfg = (typeof CockpitConfig !== 'undefined') ? (CockpitConfig.raw?.traffic || {}) : {};
        const maxAboveAlt = trafficCfg.maxAboveAlt ?? 5000;
        const maxBelowAlt = trafficCfg.maxBelowAlt ?? 5000;
        const showCallsign = trafficCfg.showCallsign !== false;

        let _nStale = 0, _nNoPos = 0, _nAltFilt = 0, _nShown = 0;
        for (const [icao, target] of this.stratux.traffic) {
            // Skip targets not seen in the last 60s — defence against stale entries
            // that survive a brief WS drop before the purge timer can evict them.
            if (now - target.last_seen > 60000) { _nStale++; continue; }
            if (!target.lat || !target.lon) { _nNoPos++; continue; }

            // Altitude filter — hide traffic outside the configured band (bypassed by layer-panel toggle)
            if (!this._trafficAltBypass && this.stratux.situation?.alt_msl != null && target.alt != null) {
                const altDiff = target.alt - this.stratux.situation.alt_msl;
                if (altDiff > maxAboveAlt || altDiff < -maxBelowAlt) {
                    if (!this._trafficFilterLogged) {
                        console.log(`[Traffic] Filtered ${target.hex}: altDiff=${Math.round(altDiff)}ft (band: -${maxBelowAlt}/+${maxAboveAlt}), ownAlt=${Math.round(this.stratux.situation.alt_msl)}, tgtAlt=${target.alt}`);
                    }
                    _nAltFilt++;
                    continue;
                }
            }

            // Only mark as "seen" once the target survives all filters. Filtered
            // targets fall through to the marker-removal pass below so they don't
            // get left frozen on the map.
            seen.add(icao);
            _nShown++;
            const color = this._trafficColor(target);
            let altLabel = '';
            if (this._showTrafficAlt && this.stratux.situation) {
                const dAlt = Math.round((target.alt || 0) - (this.stratux.situation.alt_msl || 0));
                altLabel = (dAlt >= 0 ? '+' : '') + dAlt;
            }
            const callsign = showCallsign ? (target.callsign || '').trim() : '';
            const svgHtml = CockpitMap._trafficSvg(target.track || 0, color, target.extrapolated);
            const hasLabel = altLabel || callsign;
            const iconHtml = hasLabel
                ? `<div class="traffic-icon-wrap">${svgHtml}${altLabel ? `<div class="traffic-alt" style="color:${color};">${altLabel}</div>` : ''}${callsign ? `<div class="traffic-cs" style="color:${color};">${callsign}</div>` : ''}</div>`
                : svgHtml;
            const icon = L.divIcon({
                className: 'traffic-icon',
                html: iconHtml,
                iconSize: hasLabel ? [56, 44] : [24, 24],
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
                m.on('click', () => {
                    if (typeof _wireTapLastTouchAt !== 'undefined' && Date.now() - _wireTapLastTouchAt < 500) return;
                    this._showTrafficPopup(this.stratux.traffic.get(icao) || target, m);
                });
                this.trafficMarkers.set(icao, m);
            }
        }

        // Throttle filter logging — log once per 30s
        if (!this._trafficFilterLogged) {
            this._trafficFilterLogged = true;
            setTimeout(() => { this._trafficFilterLogged = false; }, 30000);
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
        if (this._wpZoomHandler) { this.map.off('zoomend', this._wpZoomHandler); this._wpZoomHandler = null; }
        this._wpMarkers = [];
        this._legLines = [];
        this._activeWpIdx = 0;

        // Clear previous runway extensions
        this._clearRunwayExtensions();

        // Tell vector layers which airports are on the route (suppresses duplicate labels)
        if (this._vectorLayers) {
            const icaos = (waypoints || []).filter(wp => wp.icao).map(wp => wp.icao);
            this._vectorLayers.setRouteIcaos(icaos);
        }

        if (!waypoints || waypoints.length < 2) return;

        // Guard: drop any waypoint with non-finite coordinates before touching Leaflet.
        // NaN lat/lon causes L.polyline / L.circleMarker to throw and leaves the map blank.
        // _routeWaypoints is assigned after filtering so _updateActiveLeg never sees NaN coords.
        waypoints = waypoints.filter(wp => Number.isFinite(wp.lat) && Number.isFinite(wp.lon));
        if (waypoints.length < 2) return;
        this._routeWaypoints = waypoints;

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

        // Waypoint markers — larger radius, tappable for airport popup, labelled with ICAO
        this._wpMarkers = [];
        waypoints.forEach(wp => {
            const marker = L.circleMarker([wp.lat, wp.lon], {
                radius: 8, color: '#ff44ff', fillColor: '#ff44ff', fillOpacity: 0.8, weight: 2,
            }).addTo(this.routeLayer);

            const label = wp.icao || wp.name || '';
            if (label) {
                marker.bindTooltip(label, {
                    permanent: true, direction: 'top', offset: [0, -10],
                    className: 'apt-label apt-label-lg',
                });
            }

            marker.on('click', () => {
                if (typeof _wireTapLastTouchAt !== 'undefined' && Date.now() - _wireTapLastTouchAt < 500) return;
                if (wp.icao && this._airportPopup) {
                    this._airportPopup.showForAirport(wp.icao, [wp.lat, wp.lon]);
                }
            });
            this._wpMarkers.push(marker);
        });

        if (this._wpZoomHandler) { this.map.off('zoomend', this._wpZoomHandler); this._wpZoomHandler = null; }

        this.routeLayer.addTo(this.map);
        this.map.fitBounds(L.latLngBounds(latlngs).pad(0.1));

        // Draw runway extensions for departure and destination
        const dep = waypoints[0];
        const dest = waypoints[waypoints.length - 1];
        if (this._nasr && (dep?.icao || dest?.icao)) {
            this._drawRouteRunways(dep?.icao, dest?.icao);
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
        this._rwyExtAirports = [];
    }

    /**
     * Draw runway extensions for both departure and destination airports.
     */
    async _drawRouteRunways(depIcao, destIcao) {
        this._clearRunwayExtensions();
        this._rwyExtAirports = [];
        this._rwyExtLayer = L.layerGroup();
        if (this._rwyExtVisible) this._rwyExtLayer.addTo(this.map);

        const icaos = [depIcao, destIcao].filter(Boolean);
        const unique = [...new Set(icaos)];

        for (const icao of unique) {
            const apt = await this._fetchAirportRunways(icao);
            if (apt?.runways?.length) this._rwyExtAirports.push(apt);
        }

        if (this._rwyExtAirports.length) {
            this._renderRunwayExtensions();
            this._rwyExtZoomHandler = () => this._renderRunwayExtensions();
            this.map.on('zoomend', this._rwyExtZoomHandler);
        }
    }

    /** Kept for backward compatibility — draws only destination */
    async _drawDestRunways(icao) {
        await this._drawRouteRunways(null, icao);
    }

    async _fetchAirportRunways(icao) {
        const apt = await this._nasr?.getAirport(icao);
        if (!apt) return null;

        // Fetch runway data from AWC if not in NASR bundle
        if (!apt.runways?.length) {
            try {
                const resp = await fetch(
                    `https://aviationweather.gov/api/data/airport?ids=${encodeURIComponent(icao)}&format=json`,
                    { signal: AbortSignal.timeout(5000) }
                );
                if (resp.ok) {
                    const data = await resp.json();
                    const awcApt = Array.isArray(data) ? data[0] : data;
                    if (awcApt?.runways?.length) {
                        apt.runways = awcApt.runways.map(r => {
                            const [len, wid] = (r.dimension || '').split('x').map(Number);
                            return {
                                id: r.id,
                                length_ft: len || 0,
                                width_ft: wid || 0,
                                surface: r.surface || '',
                            };
                        });
                        if (this._nasr?.open) {
                            try {
                                const db = await this._nasr.open();
                                const tx = db.transaction('airports', 'readwrite');
                                tx.objectStore('airports').put(apt);
                            } catch { /* non-critical */ }
                        }
                    }
                }
            } catch { /* offline or timeout — no extensions */ }
        }

        return apt.runways?.length ? apt : null;
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
        if (!this._rwyExtLayer || !this._rwyExtAirports?.length) return;
        this._rwyExtLayer.clearLayers();

        for (const apt of this._rwyExtAirports) {
            this._renderAirportExtensions(apt);
        }
    }

    _renderAirportExtensions(apt) {
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
        wireTap(autoPanBtn, () => {
            this._autoPan = !this._autoPan;
            Settings.autoPan = this._autoPan;
            autoPanBtn.innerHTML = this._autoPan ? '&#x1F4CD;' : '&#x270B;';
            autoPanBtn.classList.toggle('active', this._autoPan);
        });
        L.DomEvent.disableClickPropagation(autoPanBtn);
        L.DomEvent.disableScrollPropagation(autoPanBtn);
        container.appendChild(autoPanBtn);
        this._autoPanBtn = autoPanBtn;

        // Direct-To
        const directToBtn = document.createElement('button');
        directToBtn.className = 'map-corner-btn direct-to-btn';
        directToBtn.title = 'Direct To';
        directToBtn.innerHTML = 'D&rarr;';
        wireTap(directToBtn, () => {
            // Direct-To via route planner not yet implemented (Stage 2)
            console.log('[FlyTab] Direct-To — Stage 2 feature');
        });
        L.DomEvent.disableClickPropagation(directToBtn);
        L.DomEvent.disableScrollPropagation(directToBtn);
        container.appendChild(directToBtn);
        this._directToBtn = directToBtn;
    }

    /** Toggle traffic altitude labels — called by layer panel */
    setShowTrafficAlt(enabled) {
        this._showTrafficAlt = enabled;
        this._updateTraffic();
    }

    /** Bypass altitude filter entirely — called by layer panel "All Altitudes" toggle */
    setTrafficAltBypass(enabled) {
        this._trafficAltBypass = enabled;
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

    static _destPoint(lat, lon, bearingDeg, nm) {
        const R = 3440.065;
        const brng = bearingDeg * Math.PI / 180;
        const lat2 = lat + (nm / R) * Math.cos(brng) * (180 / Math.PI);
        const lon2 = lon + (nm / R) * Math.sin(brng) * (180 / Math.PI) / Math.cos(lat * Math.PI / 180);
        return [lat2, lon2];
    }

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
