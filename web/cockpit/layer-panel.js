/**
 * FlyPi v5 — Layer Panel
 * Right-side slide-in drawer for base chart selection and overlay toggles.
 * Triggered by LAYERS tab in the tab bar.
 */

class LayerPanel {
    // Predefined CONUS regions — bounds verified against actual Pi tile set
    // mb values are precomputed (SEC z5-11 + IFR z7-11) to avoid runtime counting
    static REGIONS = [
        { id: 'southeast',     label: 'Southeast',     sub: 'FL GA SC NC TN(e) VA(s)', latMin: 24.0, latMax: 36.5, lonMin: -88.5, lonMax: -74.5, mb: 188 },
        { id: 'midatlantic',   label: 'Mid-Atlantic',  sub: 'VA MD DC DE NJ NY',       latMin: 36.5, latMax: 42.5, lonMin: -82.0, lonMax: -71.0, mb: 120 },
        { id: 'northeast',     label: 'Northeast',     sub: 'NY CT RI MA VT NH ME',    latMin: 41.0, latMax: 47.5, lonMin: -80.0, lonMax: -66.0, mb: 124 },
        { id: 'gulfcoast',     label: 'Gulf Coast',    sub: 'LA MS AL TX coast',       latMin: 25.0, latMax: 33.0, lonMin: -97.5, lonMax: -83.0, mb: 122 },
        { id: 'southcentral',  label: 'South Central', sub: 'TX OK AR LA TN(w) KY(w)', latMin: 29.0, latMax: 37.0, lonMin: -97.5, lonMax: -88.5, mb: 120 },
        { id: 'midwest',       label: 'Midwest',       sub: 'OH IN IL MI WI MN IA MO KY(e)', latMin: 36.0, latMax: 49.5, lonMin: -98.0, lonMax: -80.0, mb: 346 },
        { id: 'greatplains',   label: 'Great Plains',  sub: 'ND SD NE KS CO east',    latMin: 36.0, latMax: 49.5, lonMin: -111.0, lonMax: -96.0, mb: 259 },
        { id: 'mountain',      label: 'Mountain',      sub: 'MT ID WY UT CO NV',      latMin: 36.0, latMax: 49.5, lonMin: -117.5, lonMax: -109.0, mb: 171 },
        { id: 'southwest',     label: 'Southwest',     sub: 'CA south AZ NM',         latMin: 31.0, latMax: 37.5, lonMin: -121.0, lonMax: -108.0, mb: 117 },
        { id: 'pacificnw',     label: 'Pacific NW',    sub: 'WA OR CA north',         latMin: 37.0, latMax: 49.5, lonMin: -125.5, lonMax: -116.0, mb: 150 },
        { id: 'alaska',        label: 'Alaska',        sub: 'AK',                     latMin: 54.0, latMax: 72.0, lonMin: -169.0, lonMax: -130.0, mb: 407 },
    ];

    // Zoom levels stored on Pi for each layer type
    static SEC_ZOOMS      = [5, 6, 7, 8, 9, 10, 11];
    static IFR_ZOOMS      = [4, 5, 6, 7, 8, 9, 10];
    static IFR_AREA_ZOOMS = [11, 12];
    static TILE_CONCURRENCY = 6;  // max concurrent fetches (home server is threaded but keep moderate)

    static _lon2tile(lon, z) {
        return Math.floor((lon + 180) / 360 * Math.pow(2, z));
    }
    static _lat2tile(lat, z) {
        const r = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
    }

    constructor(map, vectorLayers, cockpitMap) {
        this._map = map;
        this._vectorLayers = vectorLayers;
        this._cockpitMap = cockpitMap;
        this._panel = null;
        this._backdrop = null;
        this._cancelPrefetch = false;
        this._prefetchRunning = false;
        this._getRouteBbox = null; // set by app.js: () => { latMin, latMax, lonMin, lonMax, label }
    }

    /** Called by app.js after plan load to wire up route bbox for "Cache Route Area" button. */
    setGetRouteBbox(fn) {
        this._getRouteBbox = fn;
    }

    init() {
        // Backdrop
        this._backdrop = document.createElement('div');
        this._backdrop.className = 'layer-panel-backdrop';
        document.body.appendChild(this._backdrop);

        // Panel
        this._panel = document.createElement('div');
        this._panel.className = 'layer-panel';
        this._panel.innerHTML = this._buildHtml();
        document.body.appendChild(this._panel);

        let saved = null;
        try { saved = JSON.parse(localStorage.getItem('flypi_layer_defaults') || 'null'); } catch { /* ignore corrupt data */ }

        // Wire backdrop close
        this._backdrop.addEventListener('click', () => this.close());
        this._backdrop.addEventListener('touchstart', (e) => { e.preventDefault(); this.close(); }, { passive: false });

        // Wire accordion headers
        this._panel.querySelectorAll('.lp-accordion-header[data-acc]').forEach(btn => {
            wireTap(btn, () => {
                const acc = this._panel.querySelector(`#${btn.dataset.acc}`);
                if (!acc) return;
                const open = acc.classList.toggle('open');
                btn.querySelector('.lp-acc-arrow').innerHTML = open ? '&#9660;' : '&#9654;';
            });
        });

        // Wire close button
        const closeBtn = this._panel.querySelector('.layer-panel-close');
        if (closeBtn) {
            wireTap(closeBtn, () => this.close());
        }

        // Wire base chart radio buttons
        this._panel.querySelectorAll('.lp-radio-btn[data-layer]').forEach(btn => {
            wireTap(btn, () => {
                const layer = btn.dataset.layer;
                this._cockpitMap.switchBaseLayer(layer);
                this._panel.querySelectorAll('.lp-radio-btn[data-layer]').forEach(b => {
                    b.classList.toggle('active', b === btn);
                });
            });
        });

        // Apply saved or current base layer
        const baseLayerToApply = saved?.baseLayer || this._cockpitMap._activeBaseLayer || 'vector';
        if (saved?.baseLayer) this._cockpitMap.switchBaseLayer(saved.baseLayer);
        this._panel.querySelectorAll('.lp-radio-btn[data-layer]').forEach(b => {
            b.classList.toggle('active', b.dataset.layer === baseLayerToApply);
        });

        // Wire overlay toggles
        this._panel.querySelectorAll('.lp-toggle input[data-overlay]').forEach(input => {
            input.addEventListener('change', () => {
                const overlay = input.dataset.overlay;
                this._toggleOverlay(overlay, input.checked);
            });
        });

        // Wire traffic altitude filter bypass toggle
        const taltBypassInput = this._panel.querySelector('.lp-toggle input[data-action="traffic-alt-bypass"]');
        if (taltBypassInput) {
            taltBypassInput.checked = saved?.actions?.['traffic-alt-bypass'] ?? this._cockpitMap._trafficAltBypass ?? false;
            taltBypassInput.addEventListener('change', () => {
                this._cockpitMap.setTrafficAltBypass?.(taltBypassInput.checked);
            });
        }

        // Wire traffic alt toggle
        const taltInput = this._panel.querySelector('.lp-toggle input[data-action="traffic-alt"]');
        if (taltInput) {
            taltInput.checked = saved?.actions?.['traffic-alt'] ?? this._cockpitMap._showTrafficAlt ?? false;
            taltInput.addEventListener('change', () => {
                if (this._cockpitMap.setShowTrafficAlt) {
                    this._cockpitMap.setShowTrafficAlt(taltInput.checked);
                }
            });
        }

        // Wire rwy extensions toggle
        const rwyExtInput = this._panel.querySelector('.lp-toggle input[data-action="rwy-ext"]');
        if (rwyExtInput) {
            rwyExtInput.checked = saved?.actions?.['rwy-ext'] ?? true;
            rwyExtInput.addEventListener('change', () => {
                if (this._cockpitMap?.setRwyExtVisible) {
                    this._cockpitMap.setRwyExtVisible(rwyExtInput.checked);
                }
            });
        }

        // Wire radar toggle
        const radarInput = this._panel.querySelector('.lp-toggle input[data-action="radar"]');
        if (radarInput) {
            radarInput.checked = saved?.actions?.['radar'] ?? false;
            radarInput.addEventListener('change', () => {
                this._toggleRadar(radarInput.checked);
            });
        }

        // Wire CB building toggle
        const cbBuildInput = this._panel.querySelector('.lp-toggle input[data-action="cb-building"]');
        if (cbBuildInput) {
            cbBuildInput.checked = saved?.actions?.['cb-building'] ?? false;
            cbBuildInput.addEventListener('change', () => {
                window.app?.cockpitMap?.toggleCbBuilding(cbBuildInput.checked);
            });
        }

        // Wire Conv Intel toggle
        const convIntelInput = this._panel.querySelector('.lp-toggle input[data-action="conv-intel"]');
        if (convIntelInput) {
            convIntelInput.checked = saved?.actions?.['conv-intel'] ?? CockpitConfig.get('convective.enabled') ?? false;
            convIntelInput.addEventListener('change', () => {
                const on = convIntelInput.checked;
                CockpitConfig.set('convective.enabled', on);
                window.app?.convectiveEngine?.setActive(on);
            });
        }

        // Wire CB/TCU report markers toggle
        const cbTcuInput = this._panel.querySelector('.lp-toggle input[data-action="cb-tcu"]');
        if (cbTcuInput) {
            cbTcuInput.checked = saved?.actions?.['cb-tcu'] ?? this._vectorLayers?.cbTcuVisible ?? false;
            cbTcuInput.addEventListener('change', () => {
                this._vectorLayers?.toggleCbTcu();
            });
        }

        // Wire flight category dots toggle
        const wxDotsInput = this._panel.querySelector('.lp-toggle input[data-action="wx-dots"]');
        if (wxDotsInput) {
            wxDotsInput.checked = saved?.actions?.['wx-dots'] ?? this._vectorLayers?.wxDotsVisible ?? true;
            wxDotsInput.addEventListener('change', () => {
                this._vectorLayers?.toggleWxDots();
            });
        }

        // Wire Voronoi flight category areas toggle
        const voronoiInput = this._panel.querySelector('.lp-toggle input[data-action="wx-voronoi"]');
        if (voronoiInput) {
            voronoiInput.checked = saved?.actions?.['wx-voronoi'] ?? this._vectorLayers?.voronoiVisible ?? false;
            voronoiInput.addEventListener('change', () => {
                this._vectorLayers?.toggleVoronoi();
            });
        }

        // Wire winds aloft toggle
        const windsInput = this._panel.querySelector('.lp-toggle input[data-action="winds-aloft"]');
        if (windsInput) {
            windsInput.checked = saved?.actions?.['winds-aloft'] ?? window.app?.fisbWeather?.windsVisible ?? false;
            windsInput.addEventListener('change', () => {
                window.app?.fisbWeather?.toggleWinds();
            });
        }

        // Wire PIREP toggle — controlled by FisbWeatherDisplay layer
        const pirepInput = this._panel.querySelector('.lp-toggle input[data-action="pireps"]');
        if (pirepInput) {
            pirepInput.checked = saved?.actions?.['pireps'] ?? false;
            pirepInput.addEventListener('change', () => {
                if (pirepInput.checked) window.app?.fisbWeather?.showPireps();
                else window.app?.fisbWeather?.hidePireps();
            });
        }

        // Wire SIGMET toggle
        const sigmetInput = this._panel.querySelector('.lp-toggle input[data-action="sigmets"]');
        if (sigmetInput) {
            sigmetInput.checked = saved?.actions?.['sigmets'] ?? true;
            sigmetInput.addEventListener('change', () => {
                if (sigmetInput.checked) window.app?.fisbWeather?.showSigmets();
                else window.app?.fisbWeather?.hideSigmets();
            });
        }

        // Wire per-type AIRMET toggles
        const airmetTypes = [
            { action: 'airmets-tango',  show: 'showAirmetTango',  hide: 'hideAirmetTango'  },
            { action: 'airmets-zulu',   show: 'showAirmetZulu',   hide: 'hideAirmetZulu'   },
            { action: 'airmets-sierra', show: 'showAirmetSierra', hide: 'hideAirmetSierra' },
            { action: 'airmets-other',  show: 'showAirmetOther',  hide: 'hideAirmetOther'  },
        ];
        for (const { action, show, hide } of airmetTypes) {
            const input = this._panel.querySelector(`.lp-toggle input[data-action="${action}"]`);
            if (input) {
                input.checked = saved?.actions?.[action] ?? true;
                input.addEventListener('change', () => {
                    if (input.checked) window.app?.fisbWeather?.[show]?.();
                    else               window.app?.fisbWeather?.[hide]?.();
                });
            }
        }

        // Wire IFR Area Charts toggle
        const ifrAreaInput = this._panel.querySelector('.lp-toggle input[data-action="ifr-area"]');
        if (ifrAreaInput) {
            ifrAreaInput.checked = saved?.actions?.['ifr-area'] ?? false;
            ifrAreaInput.addEventListener('change', () => {
                this._cockpitMap.toggleIfrArea(ifrAreaInput.checked);
            });
        }

        // Wire TFR toggle
        const tfrInput = this._panel.querySelector('.lp-toggle input[data-action="tfrs"]');
        if (tfrInput) {
            tfrInput.checked = saved?.actions?.['tfrs'] ?? true;
            tfrInput.addEventListener('change', () => {
                window.app?.cockpitMap?.toggleTfrs(tfrInput.checked);
            });
        }

        // Wire lightning toggle
        const lightningInput = this._panel.querySelector('.lp-toggle input[data-action="lightning"]');
        if (lightningInput) {
            lightningInput.checked = saved?.actions?.['lightning'] ?? false;
            lightningInput.addEventListener('change', () => {
                window.app?.cockpitMap?.toggleLightning(lightningInput.checked);
            });
        }

        const fuelGaugesInput = this._panel.querySelector('.lp-toggle input[data-action="fuel-gauges"]');
        if (fuelGaugesInput) {
            fuelGaugesInput.checked = saved?.actions?.['fuel-gauges'] ?? localStorage.getItem('flypi_fuel_widget_visible') !== 'false';
            fuelGaugesInput.addEventListener('change', () => {
                if (fuelGaugesInput.checked) window.app?.fuelTanksDisplay?.show();
                else                         window.app?.fuelTanksDisplay?.hide();
            });
        }

        // Wire ceiling/sky toggle
        const ceilInput = this._panel.querySelector('.lp-toggle input[data-action="wx-ceil"]');
        if (ceilInput) {
            ceilInput.checked = saved?.actions?.['wx-ceil'] ?? this._vectorLayers?.ceilVisible ?? false;
            ceilInput.addEventListener('change', () => { this._vectorLayers?.toggleCeil(); });
        }

        // Wire visibility toggle
        const visInput = this._panel.querySelector('.lp-toggle input[data-action="wx-vis"]');
        if (visInput) {
            visInput.checked = saved?.actions?.['wx-vis'] ?? this._vectorLayers?.visVisible ?? false;
            visInput.addEventListener('change', () => { this._vectorLayers?.toggleVis(); });
        }

        // Wire surface wind toggle
        const windInput = this._panel.querySelector('.lp-toggle input[data-action="wx-wind"]');
        if (windInput) {
            windInput.checked = saved?.actions?.['wx-wind'] ?? this._vectorLayers?.windVisible ?? false;
            windInput.addEventListener('change', () => { this._vectorLayers?.toggleWind(); });
        }

        // Wire temp/dew toggle
        const tempInput = this._panel.querySelector('.lp-toggle input[data-action="wx-temp"]');
        if (tempInput) {
            tempInput.checked = saved?.actions?.['wx-temp'] ?? this._vectorLayers?.tempVisible ?? false;
            tempInput.addEventListener('change', () => { this._vectorLayers?.toggleTemp(); });
        }

        // Wire airport filter controls
        this._panel.querySelectorAll('[data-aptfilter]').forEach(el => {
            const key = el.dataset.aptfilter;
            const cfg = (typeof CockpitConfig !== 'undefined') ? (CockpitConfig.get('airportFilter') || {}) : {};
            const savedKey = 'aptfilter-' + key;
            // Initialize from saved defaults if present, else CockpitConfig
            if (el.type === 'checkbox') {
                el.checked = (saved?.actions && savedKey in saved.actions) ? saved.actions[savedKey] : (cfg[key] ?? false);
            } else if (el.tagName === 'SELECT') {
                el.value = String((saved?.actions && savedKey in saved.actions) ? saved.actions[savedKey] : (cfg[key] ?? 0));
            }
            el.addEventListener('change', () => {
                const patch = {};
                if (el.type === 'checkbox') patch[key] = el.checked;
                else patch[key] = parseInt(el.value, 10);
                if (typeof CockpitConfig !== 'undefined') {
                    CockpitConfig.patch(`airportFilter.${key}`, patch[key]);
                }
                // Force map to re-render airports with new filter
                this._vectorLayers?._forceAirportRefresh?.();
            });
        });

        // Wire cancel button
        const cancelBtn = this._panel.querySelector('#lpCancelDownload');
        if (cancelBtn) {
            wireTap(cancelBtn, () => { this._cancelPrefetch = true; });
        }

        // Wire region Cache buttons
        this._panel.querySelectorAll('.lp-cache-btn[data-region]').forEach(btn => {
            wireTap(btn, () => {
                const region = LayerPanel.REGIONS.find(r => r.id === btn.dataset.region);
                if (region && !this._prefetchRunning) this._cacheRegion(region, btn);
            });
        });

        // Wire Route Area cache button
        const routeBtn = this._panel.querySelector('#lpRouteCacheBtn');
        if (routeBtn) {
            wireTap(routeBtn, () => {
                if (this._prefetchRunning) return;
                const bbox = this._getRouteBbox?.();
                if (!bbox) return;
                this._cacheRegion(bbox, routeBtn);
            });
        }

        // Wire ZIP import button (from Files app)
        const zipInput = this._panel.querySelector('#lpZipInput');
        const importBtn = this._panel.querySelector('#lpImportZipBtn');
        if (importBtn && zipInput) {
            wireTap(importBtn, () => zipInput.click());
            zipInput.addEventListener('change', () => {
                if (zipInput.files && zipInput.files[0]) {
                    this._importZip(zipInput.files[0]);
                    zipInput.value = '';
                }
            });
        }

        // Wire "Load from Server" button — fetches /api/offline-maps, lists ZIPs from Pi
        const dlZipsBtn = this._panel.querySelector('#lpDownloadZipsBtn');
        const serverZipsEl = this._panel.querySelector('#lpServerZips');
        if (dlZipsBtn && serverZipsEl) {
            wireTap(dlZipsBtn, async () => {
                dlZipsBtn.disabled = true;
                dlZipsBtn.textContent = 'Checking server…';
                serverZipsEl.style.display = 'none';
                serverZipsEl.innerHTML = '';
                try {
                    const hs = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.raw?.homeServer : null;
                    const base = hs?.tileBase?.replace(/\/tiles\/?$/, '') || 'http://localhost:9090';
                    const r = await fetch(base + '/offline-maps/index.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
                    if (!r.ok) throw new Error(`Server error ${r.status}`);
                    const pkgs = await r.json();
                    if (!pkgs.length) {
                        serverZipsEl.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:13px">No ZIPs on server — run build_offline_zip.py</div>';
                    } else {
                        serverZipsEl.innerHTML = pkgs.map(p => `
                            <div class="lp-package-row" style="padding:8px 0">
                                <span class="lp-package-info">
                                    <span class="lp-package-name">${p.id}</span>
                                    <span class="lp-region-sub">${p.size_mb} MB</span>
                                </span>
                                <button class="lp-cache-btn" data-zip-url="${base + p.url}" data-zip-id="${p.id}">Import</button>
                            </div>`).join('');
                        serverZipsEl.querySelectorAll('.lp-cache-btn[data-zip-url]').forEach(btn => {
                            wireTap(btn, async () => {
                                if (this._prefetchRunning) return;
                                btn.disabled = true;
                                btn.textContent = 'Downloading…';
                                try {
                                    const resp = await fetch(btn.dataset.zipUrl);
                                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                                    const blob = await resp.blob();
                                    const file = new File([blob], btn.dataset.zipId + '.zip', { type: 'application/zip' });
                                    this._importZip(file);
                                } catch (err) {
                                    btn.disabled = false;
                                    btn.textContent = 'Retry';
                                    const text = this._panel.querySelector('#lpProgressText');
                                    if (text) text.textContent = 'Download failed: ' + err.message;
                                    this._panel.querySelector('#lpProgressRow')?.classList.add('active');
                                }
                            });
                        });
                    }
                    serverZipsEl.style.display = '';
                    dlZipsBtn.textContent = '\u21BB Load from Server';
                } catch (err) {
                    serverZipsEl.innerHTML = `<div style="padding:8px;color:var(--status-warning);font-size:13px">Not reachable: ${err.message}</div>`;
                    serverZipsEl.style.display = '';
                    dlZipsBtn.textContent = '\u21BB Load from Server';
                } finally {
                    dlZipsBtn.disabled = false;
                }
            });
        }

        // Wire Save as Defaults button
        const saveDefaultsBtn = this._panel.querySelector('#lpSaveDefaults');
        if (saveDefaultsBtn) {
            wireTap(saveDefaultsBtn, () => this._saveAsDefaults());
        }

        // Wire Reset to Defaults button
        const resetDefaultsBtn = this._panel.querySelector('#lpResetDefaults');
        if (resetDefaultsBtn) {
            wireTap(resetDefaultsBtn, () => this._resetToDefaults());
        }

        // Grey out Reset button if no defaults saved yet
        this._updateResetBtnState();

        // Sync overlay states from config / vector layers
        this._syncOverlayStates(saved);

        // If saved defaults exist, apply live layer state (idempotent for already-correct layers)
        if (saved) this._resetToDefaults();
    }

    _buildHtml() {
        return `
        <div class="layer-panel-header">
            <span class="layer-panel-title">Layers</span>
            <button class="layer-panel-close btn-close" aria-label="Close">✕</button>
        </div>
        <div class="layer-panel-body">

            <div class="lp-section-header">Base Chart</div>
            <div class="lp-radio-group">
                <button class="lp-radio-btn" data-layer="vector">VEC</button>
                <button class="lp-radio-btn" data-layer="sectional">SEC</button>
                <button class="lp-radio-btn" data-layer="ifr">IFR</button>
                <button class="lp-radio-btn" data-layer="tac">TAC</button>
            </div>

            <div class="lp-accordion open" id="lp-acc-overlays">
                <button class="lp-accordion-header" data-acc="lp-acc-overlays">
                    <span>Overlays</span><span class="lp-acc-arrow">&#9660;</span>
                </button>
                <div class="lp-accordion-body">
                    <div class="lp-row">
                        <span class="lp-row-label">Airports</span>
                        <label class="lp-toggle"><input type="checkbox" data-overlay="airports"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row lp-row-sub">
                        <span class="lp-row-label lp-sub-label">Min runway (ft)</span>
                        <select class="lp-select" data-aptfilter="minRunwayFt">
                            <option value="0">Any</option>
                            <option value="1500">1,500</option>
                            <option value="2000">2,000</option>
                            <option value="2500">2,500</option>
                            <option value="3000">3,000</option>
                            <option value="4000">4,000</option>
                        </select>
                    </div>
                    <div class="lp-row lp-row-sub">
                        <span class="lp-row-label lp-sub-label">Paved only</span>
                        <label class="lp-toggle"><input type="checkbox" data-aptfilter="pavedOnly"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row lp-row-sub">
                        <span class="lp-row-label lp-sub-label">Show heliports</span>
                        <label class="lp-toggle"><input type="checkbox" data-aptfilter="showHeliports"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row lp-row-sub">
                        <span class="lp-row-label lp-sub-label">Show seaplane bases</span>
                        <label class="lp-toggle"><input type="checkbox" data-aptfilter="showSeaplaneBases"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row lp-row-sub">
                        <span class="lp-row-label lp-sub-label">Show ultralights</span>
                        <label class="lp-toggle"><input type="checkbox" data-aptfilter="showUltralight"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Navaids</span>
                        <label class="lp-toggle"><input type="checkbox" data-overlay="navaids"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Fixes</span>
                        <label class="lp-toggle"><input type="checkbox" data-overlay="fixes"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Airways</span>
                        <label class="lp-toggle"><input type="checkbox" data-overlay="airways"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Airspace</span>
                        <label class="lp-toggle"><input type="checkbox" data-overlay="airspace"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Restricted/MOA</span>
                        <label class="lp-toggle"><input type="checkbox" data-overlay="sua"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">IFR Area Charts</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="ifr-area"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">TFR</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="tfrs"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Rwy Extensions</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="rwy-ext"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">All Altitudes</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="traffic-alt-bypass"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Show ±ALT</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="traffic-alt"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Fuel Gauges</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="fuel-gauges" checked><span class="lp-toggle-track"></span></label>
                    </div>
                </div>
            </div>

            <div class="lp-accordion open" id="lp-acc-weather">
                <button class="lp-accordion-header" data-acc="lp-acc-weather">
                    <span>Weather</span><span class="lp-acc-arrow">&#9660;</span>
                </button>
                <div class="lp-accordion-body">
                    <div class="lp-row">
                        <span class="lp-row-label">NEXRAD / FIS-B</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="radar"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">CB Building</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="cb-building"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Conv Intel</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="conv-intel"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">CB / TCU Reports</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="cb-tcu"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Flight Category</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="wx-dots" checked><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Category Areas</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="wx-voronoi"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Ceiling / Sky</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="wx-ceil"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Visibility</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="wx-vis"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Surface Wind</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="wx-wind"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Temp / Dew</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="wx-temp"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Winds Aloft</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="winds-aloft"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">PIREPs (FIS-B)</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="pireps"><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">SIGMETs</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="sigmets" checked><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">AIRMET Tango (Turb)</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="airmets-tango" checked><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">AIRMET Zulu (Icing)</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="airmets-zulu" checked><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">AIRMET Sierra (IFR)</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="airmets-sierra" checked><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">AIRMET Other</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="airmets-other" checked><span class="lp-toggle-track"></span></label>
                    </div>
                    <div class="lp-row">
                        <span class="lp-row-label">Lightning Strikes</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="lightning"><span class="lp-toggle-track"></span></label>
                    </div>
                </div>
            </div>

            <div class="lp-defaults-row">
                <button class="lp-defaults-save" id="lpSaveDefaults">Save as Defaults</button>
                <button class="lp-defaults-reset" id="lpResetDefaults">Reset to Defaults</button>
            </div>
            <div class="lp-defaults-confirm" id="lpDefaultsConfirm"></div>

        </div>`;
    }

    _syncOverlayStates(saved) {
        const overlays = (typeof CockpitConfig !== 'undefined')
            ? (CockpitConfig.get('map.overlays') || {})
            : {};

        const hardcoded = {
            airports: true,
            navaids: true,
            fixes: false,
            airways: true,
            airspace: true,
            sua: false,
        };

        this._panel.querySelectorAll('.lp-toggle input[data-overlay]').forEach(input => {
            const key = input.dataset.overlay;
            let enabled;
            if (saved?.overlays && key in saved.overlays) {
                enabled = saved.overlays[key];
            } else {
                enabled = overlays[key]?.enabled ?? hardcoded[key] ?? true;
            }
            input.checked = enabled;
            this._toggleOverlay(key, enabled);
        });
    }

    _toggleOverlay(name, enabled) {
        if (this._vectorLayers) {
            if (enabled) {
                this._vectorLayers.show(name);
            } else {
                this._vectorLayers.hide(name);
            }
        }
        // Sync settings
        if (typeof Settings !== 'undefined') {
            const key = 'show' + name.charAt(0).toUpperCase() + name.slice(1);
            Settings[key] = enabled;
        }
    }

    _toggleRadar(enabled) {
        const cm = this._cockpitMap;
        if (!cm) return;
        if (enabled) {
            cm.toggleRadar(true); // activates FIS-B canvas + internet tile + InetRadarSource
            if (cm._radarLoop) cm._radarLoop.show(cm.map);
        } else {
            if (cm._radarLoop) cm._radarLoop.hide();
            cm.toggleRadar(false); // deactivates FIS-B canvas + internet tile
        }
    }

    _updateResetBtnState() {
        const btn = this._panel?.querySelector('#lpResetDefaults');
        if (!btn) return;
        const hasSaved = !!localStorage.getItem('flypi_layer_defaults');
        btn.classList.toggle('lp-defaults-reset--no-saved', !hasSaved);
    }

    _saveAsDefaults() {
        const snapshot = {
            baseLayer: this._cockpitMap._activeBaseLayer || 'vector',
            overlays: {},
            actions: {}
        };

        this._panel.querySelectorAll('input[data-overlay]').forEach(input => {
            snapshot.overlays[input.dataset.overlay] = input.checked;
        });

        this._panel.querySelectorAll('input[data-action]').forEach(input => {
            snapshot.actions[input.dataset.action] = input.checked;
        });

        this._panel.querySelectorAll('[data-aptfilter]').forEach(el => {
            const key = 'aptfilter-' + el.dataset.aptfilter;
            if (el.type === 'checkbox') snapshot.actions[key] = el.checked;
            else snapshot.actions[key] = parseInt(el.value, 10) || 0;
        });

        localStorage.setItem('flypi_layer_defaults', JSON.stringify(snapshot));

        const confirmEl = this._panel.querySelector('#lpDefaultsConfirm');
        if (confirmEl) {
            confirmEl.textContent = 'Defaults saved';
            confirmEl.classList.add('lp-defaults-confirm--visible');
            setTimeout(() => confirmEl.classList.remove('lp-defaults-confirm--visible'), 2000);
        }

        this._updateResetBtnState();
    }

    _resetToDefaults() {
        const raw = localStorage.getItem('flypi_layer_defaults');
        if (!raw) return;
        let saved;
        try { saved = JSON.parse(raw); } catch { return; }
        const act = saved.actions || {};

        // Base layer
        if (saved.baseLayer) {
            this._cockpitMap.switchBaseLayer(saved.baseLayer);
            this._panel.querySelectorAll('.lp-radio-btn[data-layer]').forEach(b => {
                b.classList.toggle('active', b.dataset.layer === saved.baseLayer);
            });
        }

        // Overlay layers (airports, navaids, fixes, airways, airspace, sua)
        this._panel.querySelectorAll('input[data-overlay]').forEach(input => {
            const key = input.dataset.overlay;
            if (key in (saved.overlays || {})) {
                input.checked = saved.overlays[key];
                this._toggleOverlay(key, saved.overlays[key]);
            }
        });

        // Actions whose handlers read input.checked — dispatch change to reuse existing logic
        const dispatchable = [
            'traffic-alt-bypass', 'traffic-alt', 'rwy-ext', 'radar',
            'cb-building', 'conv-intel', 'pireps', 'sigmets',
            'airmets-tango', 'airmets-zulu', 'airmets-sierra', 'airmets-other',
            'ifr-area', 'tfrs', 'lightning', 'fuel-gauges'
        ];
        for (const key of dispatchable) {
            if (key in act) {
                const input = this._panel.querySelector(`input[data-action="${key}"]`);
                if (input) {
                    input.checked = act[key];
                    input.dispatchEvent(new Event('change'));
                }
            }
        }

        // Toggle-style layers — only call toggle if current state differs from desired
        const toggleLayers = [
            { key: 'cb-tcu',     getV: () => this._vectorLayers?.cbTcuVisible ?? false,         toggle: () => this._vectorLayers?.toggleCbTcu()          },
            { key: 'wx-dots',    getV: () => this._vectorLayers?.wxDotsVisible ?? true,          toggle: () => this._vectorLayers?.toggleWxDots()          },
            { key: 'wx-voronoi', getV: () => this._vectorLayers?.voronoiVisible ?? false,        toggle: () => this._vectorLayers?.toggleVoronoi()         },
            { key: 'wx-ceil',    getV: () => this._vectorLayers?.ceilVisible ?? false,           toggle: () => this._vectorLayers?.toggleCeil()            },
            { key: 'wx-vis',     getV: () => this._vectorLayers?.visVisible ?? false,            toggle: () => this._vectorLayers?.toggleVis()             },
            { key: 'wx-wind',    getV: () => this._vectorLayers?.windVisible ?? false,           toggle: () => this._vectorLayers?.toggleWind()            },
            { key: 'wx-temp',    getV: () => this._vectorLayers?.tempVisible ?? false,           toggle: () => this._vectorLayers?.toggleTemp()            },
            { key: 'winds-aloft',getV: () => window.app?.fisbWeather?.windsVisible ?? false,    toggle: () => window.app?.fisbWeather?.toggleWinds()      },
        ];
        for (const { key, getV, toggle } of toggleLayers) {
            if (key in act) {
                const input = this._panel.querySelector(`input[data-action="${key}"]`);
                const desired = act[key];
                if (input) input.checked = desired;
                if (getV() !== desired) toggle();
            }
        }

        // Airport filters
        this._panel.querySelectorAll('[data-aptfilter]').forEach(el => {
            const key = 'aptfilter-' + el.dataset.aptfilter;
            if (key in act) {
                if (el.type === 'checkbox') el.checked = act[key];
                else el.value = String(act[key]);
                el.dispatchEvent(new Event('change'));
            }
        });

        const confirmEl = this._panel.querySelector('#lpDefaultsConfirm');
        if (confirmEl) {
            confirmEl.textContent = 'Defaults applied';
            confirmEl.classList.add('lp-defaults-confirm--visible');
            setTimeout(() => confirmEl.classList.remove('lp-defaults-confirm--visible'), 2000);
        }
    }

    open() {
        if (this._panel.classList.contains('open')) return;
        // Sync base layer button to current state
        const currentLayer = this._cockpitMap._activeBaseLayer || 'vector';
        this._panel.querySelectorAll('.lp-radio-btn[data-layer]').forEach(b => {
            b.classList.toggle('active', b.dataset.layer === currentLayer);
        });
        this._panel.classList.add('open');
        this._backdrop.classList.add('open');
    }

    close() {
        if (!this._panel.classList.contains('open')) return;
        this._panel.classList.remove('open');
        this._backdrop.classList.remove('open');
        if (typeof this.onClose === 'function') this.onClose();
    }

    toggle() {
        this._panel.classList.contains('open') ? this.close() : this.open();
    }

    /**
     * Get the home server tile base URL from config.
     */
    _getHomeServerTileBase() {
        const hs = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.raw?.homeServer : null;
        const base = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.homeBase : null;
        return hs?.tileBase || (base ? `${base}/tiles` : null);
    }

    /**
     * Download tiles from home server and save to Android filesystem via NanoHTTPD PUT.
     * Tiles are saved to Documents/FlyTab/tiles/ where NanoHTTPD serves them offline.
     */
    async _cacheRegion(region, triggerBtn) {
        if (this._prefetchRunning) return;

        const progressRow = this._panel.querySelector('#lpProgressRow');
        const fill        = this._panel.querySelector('#lpProgressFill');
        const text        = this._panel.querySelector('#lpProgressText');
        const cancelBtn   = this._panel.querySelector('#lpCancelDownload');

        const homeBase = this._getHomeServerTileBase();
        const localBase = 'http://localhost:9090';

        // Build tile sub-paths (relative to tile base, e.g. /sectional/7/34/26.webp)
        const paths = [];
        const addLayer = (prefix, zooms) => {
            for (const z of zooms) {
                const xMin = LayerPanel._lon2tile(region.lonMin, z);
                const xMax = LayerPanel._lon2tile(region.lonMax, z);
                const yMin = LayerPanel._lat2tile(region.latMax, z); // lat inverted
                const yMax = LayerPanel._lat2tile(region.latMin, z);
                for (let x = xMin; x <= xMax; x++) {
                    for (let y = yMin; y <= yMax; y++) {
                        paths.push(`/${prefix}/${z}/${x}/${y}.webp`);
                    }
                }
            }
        };
        addLayer('sectional', LayerPanel.SEC_ZOOMS);
        addLayer('ifr-low',   LayerPanel.IFR_ZOOMS);
        addLayer('ifr-area',  LayerPanel.IFR_AREA_ZOOMS);

        const total = paths.length;
        this._prefetchRunning = true;
        this._cancelPrefetch  = false;
        progressRow.classList.add('active');
        cancelBtn.style.display = '';
        fill.style.width = '0%';
        text.textContent = `0 / ${total.toLocaleString()} tiles — downloading from server`;
        if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = 'Caching…'; }

        let done = 0;
        let cached = 0;
        let missing = 0;  // 404 — tile not in FAA dataset (ocean, edge areas) — expected
        let failed = 0;   // network error or save failure
        try {
            // Sliding-window concurrent fetcher
            const concurrency = LayerPanel.TILE_CONCURRENCY;
            let nextIdx = 0;
            const fetchAndSave = async () => {
                while (nextIdx < total && !this._cancelPrefetch) {
                    const tilePath = paths[nextIdx++];
                    try {
                        // Download from home server (homeBase = .../tiles, tilePath = /sectional/z/x/y.webp)
                        const r = await fetch(homeBase + tilePath);
                        if (r.ok) {
                            const blob = await r.blob();
                            // Save to Android filesystem via NanoHTTPD PUT (needs /tiles prefix)
                            const putResp = await fetch(localBase + '/tiles' + tilePath, {
                                method: 'PUT',
                                body: blob,
                            });
                            if (putResp.ok) cached++;
                            else failed++;
                        } else if (r.status === 404) {
                            missing++;
                        } else {
                            failed++;
                        }
                    } catch { failed++; }
                    done++;
                    if (done % 20 === 0 || done === total) {
                        fill.style.width = Math.round(done / total * 100) + '%';
                        text.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} tiles`;
                    }
                }
            };
            const workers = [];
            for (let w = 0; w < Math.min(concurrency, total); w++) {
                workers.push(fetchAndSave());
            }
            await Promise.all(workers);

            if (this._cancelPrefetch) {
                text.textContent = `Cancelled — ${cached.toLocaleString()} saved`;
                if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = 'Cache'; }
            } else if (failed > 0) {
                fill.style.width = '100%';
                text.textContent = `${cached.toLocaleString()} saved, ${failed.toLocaleString()} failed — home server reachable?`;
                cancelBtn.style.display = 'none';
                if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = 'Retry'; }
            } else {
                fill.style.width = '100%';
                const missingNote = missing > 0 ? ` (${missing.toLocaleString()} ocean/edge tiles skipped)` : '';
                text.textContent = `✓ ${cached.toLocaleString()} tiles saved${missingNote}`;
                cancelBtn.style.display = 'none';
                if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = 'Refresh'; }
            }
        } catch (err) {
            text.textContent = `Error: ${err.message}`;
            if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = 'Cache'; }
        } finally {
            this._prefetchRunning = false;
        }
    }

    /**
     * Import a region ZIP into the Android filesystem via NanoHTTPD PUT.
     * ZIP structure: sectional/{z}/{x}/{y}.webp  and  ifr-low/{z}/{x}/{y}.webp
     * Tiles are saved to Documents/FlyTab/tiles/ for offline serving.
     */
    async _importZip(file) {
        if (this._prefetchRunning) return;

        const progressRow = this._panel.querySelector('#lpProgressRow');
        const fill        = this._panel.querySelector('#lpProgressFill');
        const text        = this._panel.querySelector('#lpProgressText');
        const cancelBtn   = this._panel.querySelector('#lpCancelDownload');
        const importBtn   = this._panel.querySelector('#lpImportZipBtn');
        const localBase   = 'http://localhost:9090';

        this._prefetchRunning = true;
        this._cancelPrefetch  = false;
        progressRow.classList.add('active');
        cancelBtn.style.display = '';
        fill.style.width = '0%';
        text.textContent = 'Reading ZIP…';
        if (importBtn) importBtn.disabled = true;

        try {
            if (typeof JSZip === 'undefined') {
                text.textContent = 'Error: JSZip not loaded';
                return;
            }

            const zip = await JSZip.loadAsync(file);

            // Collect tile entries (skip directories)
            const entries = [];
            zip.forEach((path, entry) => {
                if (!entry.dir && (path.endsWith('.webp') || path.endsWith('.png'))) {
                    entries.push({ path, entry });
                }
            });

            if (entries.length === 0) {
                text.textContent = 'No tiles found in ZIP';
                return;
            }

            const total = entries.length;
            text.textContent = `0 / ${total.toLocaleString()} tiles`;
            fill.style.width = '0%';

            let done = 0;
            let stored = 0;

            for (const { path, entry } of entries) {
                if (this._cancelPrefetch) break;

                try {
                    const blob = await entry.async('blob');
                    // ZIP path is e.g. "sectional/8/45/100.webp" → PUT to /tiles/sectional/8/45/100.webp
                    const putResp = await fetch(localBase + '/tiles/' + path, {
                        method: 'PUT',
                        body: blob,
                    });
                    if (putResp.ok) stored++;
                } catch { /* skip bad entry */ }

                done++;
                if (done % 50 === 0 || done === total) {
                    fill.style.width = Math.round(done / total * 100) + '%';
                    text.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} tiles`;
                }
            }

            fill.style.width = '100%';
            cancelBtn.style.display = 'none';
            if (this._cancelPrefetch) {
                text.textContent = `Cancelled — ${stored.toLocaleString()} tiles imported`;
            } else {
                text.textContent = `✓ ${stored.toLocaleString()} tiles imported from ZIP`;
            }
        } catch (err) {
            text.textContent = `ZIP error: ${err.message}`;
        } finally {
            this._prefetchRunning = false;
            if (importBtn) importBtn.disabled = false;
        }
    }

}
