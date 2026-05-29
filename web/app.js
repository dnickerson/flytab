/**
 * FlyTab — Application Orchestrator v1
 * Android Capacitor cockpit app. All data local. Pi for live telemetry only.
 */

const FLYTAB_VERSION = 'v9.31';

// === Diagnostic Logger (ring buffer in localStorage) ==========
const DiagLog = (() => {
    const KEY = 'flypi_diag_log';
    const MAX = 200; // max log entries

    function _read() {
        try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
        catch { return []; }
    }

    function _write(entries) {
        try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch {}
    }

    return {
        log(category, message, data) {
            const entries = _read();
            entries.push({
                t: new Date().toISOString(),
                cat: category,
                msg: message,
                ...(data !== undefined ? { d: data } : {}),
            });
            if (entries.length > MAX) entries.splice(0, entries.length - MAX);
            _write(entries);
        },
        get entries() { return _read(); },
        clear() { localStorage.removeItem(KEY); },
    };
})();

// Global error handlers — write all uncaught exceptions and unhandled rejections to DiagLog.
// The 'error' category renders red in the DiagLog overlay (long-press version badge).
window.onerror = (msg, src, line, col, err) => {
    DiagLog.log('error', `Uncaught: ${msg}`, { src, line, col, stack: err?.stack?.slice(0, 200) });
};
window.addEventListener('unhandledrejection', (e) => {
    DiagLog.log('error', `UnhandledRejection: ${e.reason?.message || e.reason}`, { stack: e.reason?.stack?.slice(0, 200) });
});

const GPS_SOLUTION_LABELS = { 1: 'GPS', 2: 'DGPS', 3: 'PPS', 4: 'RTK', 5: 'FRTK', 6: 'EST', 8: 'SIM' };

class FlyTabApp {
    constructor() {
        // Cockpit components
        this.stratuxClient = null;
        this.engineGpsBridge = null;
        this._gpsDiagPanel = null;
        this.cockpitMap = null;
        this.radarPage = null;
        this.enginePanel = null;
        this.trackLog = null;
        this.deviceStatus = null;
        this.rangeCalc = null;
        this.routePlannerPanel = null;

        // Cockpit redesign components
        this.vectorLayers = null;
        this.airportPopup = null;
        this.routeTable = null;
        this.engineOverlay = null;
        this.enginePage = null;
        this.flightSync = null;
        this.logbook = null;
        this.flightUpload = null;
        this.radarLoop = null;
        this.approachCharts = null;
        this.ifrClearance = null;
        this.wxBriefing = null;
        this.fisbClient = null;
        this.fisbNexrad = null;
        this.fisbWeather = null;

        // v5 UI components
        this.instrumentStrip = null;
        this.layerPanel = null;
        this.tabBar = null;
        this.everywhereSearch = null;

        this.thermalMonitor = null;
        this.engineML = null;
        this.convectiveEngine = null;
        this._cockpitInitialized = false;
        this._currentTrip = null;     // trip — top-level plan object (was _currentPlan)
        this._applyingPlan = false;   // re-entrancy guard for applyRouteEdit
        this._pendingPlanEdit = null; // latest-wins queuing for rapid calls
        this._shownFuelStopOverlays = new Set(); // tracks shown overlays by "ICAO_index" key

        // DOM references
        this.dom = {
            statusBar: document.getElementById('statusBar'),
            statusRec: document.getElementById('statusRec'),
            statusSync: document.getElementById('statusSync'),
            statusWeather: document.getElementById('statusWeather'),
            statusTime: document.getElementById('statusTime'),
            statusTimeLocal: document.getElementById('statusTimeLocal'),
            statusGps: document.getElementById('statusGps'),
            statusFisb: document.getElementById('statusFisb'),
            statusNasr: document.getElementById('statusNasr'),
            mainContent: document.getElementById('mainContent'),
            cockpitView: document.getElementById('cockpitView'),
        };

        this._initGpsDiagPanel();

        this._clockInterval = null;
        this._recorderInterval = null;
        this._piConnected = false;

        // FIS-B badge opens FIS-B status page
        if (this.dom.statusFisb) {
            this.dom.statusFisb.style.cursor = 'pointer';
            this.dom.statusFisb.addEventListener('click', () => {
                if (this.fisbStatus) this.fisbStatus.show();
            });
        }
    }

    /**
     * Build planning library adapters. Dynamic imports allow app.js to remain
     * a plain script. The planning lib lands on window.FlyTabPlanning asynchronously;
     * route-planner-panel.js waits for the 'flytab-planning:ready' event.
     */
    async _buildPlanningAdapters() {
        const [aero, plan, profile, fisb, fly, router] = await Promise.all([
            import('./shared/planning-adapters/idb-aero.js'),
            import('./shared/planning-adapters/idb-plan.js'),
            import('./shared/planning-adapters/idb-profile.js'),
            import('./shared/planning-adapters/fisb-weather.js'),
            import('./shared/planning-adapters/flywhere-weather.js'),
            import('./shared/planning-adapters/weather-router.js'),
        ]);

        const inFlight = new fisb.FisbWeather(this.fisbClient);
        const online   = new fly.FlywhereWeather('https://flywhere.app/api/wx');

        return {
            aero:     new aero.IdbAeroData(this._nasrDb),
            weather:  new router.WeatherRouter(this.networkMode, { inFlight, online }),
            plans:    new plan.IdbPlanStore(),
            profiles: new profile.IdbProfileStore(),
            network:  this.networkMode,
            clock:    { now: () => Date.now() },
        };
    }

    async init() {
        // Load cockpit config
        if (typeof CockpitConfig !== 'undefined') {
            await CockpitConfig.load();
        }

        // Android status bar — keep it visible so pilot can see WiFi/battery/time.
        // @capacitor/status-bar must be installed; overlaysWebView:false reserves space.
        const StatusBar = window.Capacitor?.Plugins?.StatusBar;
        if (StatusBar) {
            StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
            StatusBar.setBackgroundColor({ color: '#000000' }).catch(() => {});
            StatusBar.setStyle({ style: 'LIGHT' }).catch(() => {}); // LIGHT = white icons on dark bg
        }

        // Warn loudly if sim mode is active
        if (typeof CockpitConfig !== 'undefined' && CockpitConfig.raw?.simMode) {
            document.getElementById('simBanner').hidden = false;
        }

        // Keep screen on
        this._acquireWakeLock();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this._acquireWakeLock();
        });

        // Network mode detection
        this.networkMode = new NetworkMode();
        this.networkMode.addEventListener('mode:changed', (e) => {
            console.log(`[FlyTab] Network mode: ${e.detail.previous} → ${e.detail.mode}`);
            this._onModeChanged(e.detail.mode, e.detail.previous);
        });
        this.networkMode.startMonitoring();

        // Start clock, device status, and connectivity monitors
        this._startClock();
        this._startDeviceStatusMonitor();
        this._startConnectivityMonitor();

        // Start thermal monitor
        this._initThermalMonitor();

        // Initialize cockpit
        await this._initCockpit();

        // Load terrain grid in background — non-blocking, works offline
        window.terrainGrid?.load();

        // Update NASR age badge after data is loaded
        this._updateNasrBadge();

        // Startup data readiness check — runs in background, shows banner if data is missing/expired
        setTimeout(() => this._checkDataReadiness(), 3000);

        // Long-press version badge to show diagnostic log
        const verBadge = document.getElementById('statusVersion');
        if (verBadge) {
            let longPressTimer = null;
            verBadge.addEventListener('touchstart', () => {
                longPressTimer = setTimeout(() => this._showDiagLog(), 800);
            });
            verBadge.addEventListener('touchend', () => clearTimeout(longPressTimer));
            verBadge.addEventListener('touchcancel', () => clearTimeout(longPressTimer));
        }

        DiagLog.log('init', `FlyTab ${FLYTAB_VERSION} initialized`);
        console.log(`FlyTab ${FLYTAB_VERSION} initialized`);

        this._startWatchdog();
        window.addEventListener('resize', () => {
            if (document.getElementById('cockpitContainer')?.classList.contains('route-editing')) {
                this._updateOrientation();
                setTimeout(() => this.cockpitMap?.map?.invalidateSize(), 300);
            }
        });
        this._initDeepLink();
    }

    _initDeepLink() {
        const App = window.Capacitor?.Plugins?.App;
        if (!App) return;
        App.addListener('appUrlOpen', async (event) => {
            try {
                const url = new URL(event.url);
                if (url.hostname === 'plan') {
                    const planId = url.pathname.replace(/^\//, '');
                    if (planId) await this._loadPlanById(planId);
                }
            } catch (err) {
                console.warn('[DeepLink] Failed to handle URL:', event.url, err.message);
                this.showToast('Could not load plan from link.');
            }
        });
    }

    async _loadPlanById(planId) {
        this.showToast('Loading plan…');
        try {
            const plan = await this.planSync?.fetchPlanById(planId);
            if (!plan) {
                this.showToast('Plan not found or failed to load.');
                return;
            }
            await this.applyRouteEdit(plan);
            this.tabBar?.selectTab('map');
        } catch (err) {
            console.error('[DeepLink] _loadPlanById error:', err.message);
            this.showToast(`Failed to load plan: ${err.message}`);
        }
    }

    /**
     * requestAnimationFrame-based hang watchdog.
     * If the JS event loop stalls while the app is visible (e.g., blocking IDB operation),
     * rAF stops firing. The setInterval checker detects this and:
     *   >3s stall  → logs to DiagLog (silent, pilot unaware)
     *   >10s stall → turns version badge red so the pilot sees something is wrong
     * Suppressed when document is hidden (backgrounded) — rAF naturally stops then.
     */
    _startWatchdog() {
        let lastFrame = Date.now();
        const tick = () => {
            lastFrame = Date.now();
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);

        // Wake-from-suspend isn't a hang — when the WebView resumes after the
        // screen has been off, rAF was paused and lastFrame is stale. Reset on
        // visibility transition so the first post-wake check doesn't log the
        // entire sleep duration as a stall.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') lastFrame = Date.now();
        });

        setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            const age = Date.now() - lastFrame;
            if (age > 3000) {
                DiagLog.log('error', `JS hang: rAF stalled ${age}ms`);
            }
            if (age > 10000) {
                const verEl = document.getElementById('statusVersion');
                if (verEl) verEl.style.background = 'var(--status-danger)';
            }
        }, 3000);
    }

    /** Show diagnostic log overlay */
    _showDiagLog() {
        // Remove existing
        document.getElementById('diagLogOverlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'diagLogOverlay';
        overlay.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);left:0;right:0;bottom:env(safe-area-inset-bottom,0px);z-index:9999;background:var(--bg-primary);display:flex;flex-direction:column;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0;';
        header.innerHTML = '<span style="font-weight:700;font-size:18px;color:var(--text-primary)">Diagnostic Log</span>';
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;';

        const refreshBtn = document.createElement('button');
        refreshBtn.textContent = 'Refresh';
        refreshBtn.style.cssText = 'padding:6px 14px;background:var(--accent);color:var(--text-on-dark);border:none;border-radius:4px;font-size:14px;';
        refreshBtn.addEventListener('click', () => { logBody.innerHTML = renderEntries(); logBody.scrollTop = logBody.scrollHeight; });

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText = 'padding:6px 14px;background:var(--status-danger);color:var(--text-on-dark);border:none;border-radius:4px;font-size:14px;';
        clearBtn.addEventListener('click', () => { DiagLog.clear(); logBody.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Log cleared</div>'; });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.style.cssText = 'padding:6px 14px;background:var(--bg-surface);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;font-size:14px;';
        closeBtn.addEventListener('click', () => overlay.remove());

        btns.appendChild(refreshBtn);
        btns.appendChild(clearBtn);
        btns.appendChild(closeBtn);
        header.appendChild(btns);
        overlay.appendChild(header);

        // GPS status summary
        const summary = document.createElement('div');
        summary.style.cssText = 'padding:8px 16px;background:var(--bg-surface);border-bottom:1px solid var(--border);font-size:13px;flex-shrink:0;font-family:monospace;';
        const sit = this.stratuxClient?.situation;
        const src = this.gpsSource?.label ?? this.gpsSource?.source ?? '?';
        const cfgSrc = this.gpsSource?._configuredSource ?? '?';
        const stxConnected = this.stratuxClient?._connected ? 'YES' : 'NO';
        const fixQ = sit?.gps_fix_quality ?? 'null';
        const lat = sit?.lat?.toFixed(4) ?? 'null';
        const lon = sit?.lon?.toFixed(4) ?? 'null';
        const sats = sit?.gps_sats ?? 'null';
        const acc = sit?._accuracy != null ? `${Math.round(sit._accuracy)}m` : 'n/a';
        summary.innerHTML = [
            `<b>GPS Source:</b> ${src} (configured: ${cfgSrc}) | <b>Stratux connected:</b> ${stxConnected} | <b>Stratux IP:</b> ${this.stratuxClient?.ip || '?'}`,
            `<b>Fix quality:</b> ${fixQ} | <b>Lat:</b> ${lat} | <b>Lon:</b> ${lon} | <b>Sats:</b> ${sats} | <b>Accuracy:</b> ${acc}`,
            `<b>Geolocation API:</b> ${'geolocation' in navigator ? 'available' : 'NOT available'} | <b>watchId:</b> ${this.gpsSource?._watchId ?? 'null'}`,
        ].join('<br>');
        overlay.appendChild(summary);

        const logBody = document.createElement('div');
        logBody.style.cssText = 'flex:1;overflow-y:auto;padding:8px 16px;font-size:12px;font-family:monospace;';

        const CAT_COLORS = { gps: '#44ff44', stratux: '#44aaff', init: '#ffaa44', nasr: '#aa88ff', error: '#ff4444' };
        const renderEntries = () => {
            const entries = DiagLog.entries;
            if (!entries.length) return '<div style="color:var(--text-muted)">No log entries</div>';
            return entries.map(e => {
                const time = e.t.slice(11, 19);
                const color = CAT_COLORS[e.cat] || 'var(--text-secondary)';
                const escStr = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                const data = e.d ? ` <span style="color:var(--text-muted)">${escStr(typeof e.d === 'object' ? JSON.stringify(e.d) : e.d)}</span>` : '';
                return `<div style="margin:2px 0;line-height:1.5"><span style="color:var(--text-muted)">${time}</span> <span style="color:${color};font-weight:600">[${escStr(e.cat)}]</span> ${escStr(e.msg)}${data}</div>`;
            }).join('');
        };

        logBody.innerHTML = renderEntries();
        overlay.appendChild(logBody);
        document.body.appendChild(overlay);
        logBody.scrollTop = logBody.scrollHeight;
    }

    /** Handle network mode transitions */
    _onModeChanged(mode, previous) {
        if (mode === 'flight') {
            // Connect to Stratux + engine on Pi hotspot
            if (this.stratuxClient && !this.stratuxClient.connected) {
                this.stratuxClient.connect();
            }
            if (this.engineClient && !this.engineClient.connected) {
                this.engineClient.connect();
            }
        } else if (previous === 'flight') {
            // Left flight mode — disconnect live telemetry
            if (this.stratuxClient) this.stratuxClient.disconnect();
            if (this.engineClient) this.engineClient.disconnect();
        }

        // Trigger immediate internet METAR refresh whenever we gain internet access
        if ((mode === 'internet' || mode === 'home') && previous === 'offline') {
            if (this.vectorLayers) {
                this.vectorLayers._internetFetchedAt = 0;
                this.vectorLayers._scheduleUpdate();
            }
            // Also refresh advisories now that we have connectivity
            this._fetchAdvisories();
        }
    }

    // === Cockpit Init ==========

    async _initCockpit() {
        if (this._cockpitInitialized) {
            if (this.cockpitMap) setTimeout(() => this.cockpitMap.resize(), 100);
            return;
        }
        this._cockpitInitialized = true;

        const primaryView = document.getElementById('primaryView');
        const nasrDb = new NasrDB();
        this._nasrDb = nasrDb;

        // Initialize Stratux client
        this.stratuxClient = new StratuxClient();
        this.stratuxClient.connect();

        // GPS source manager — selectable between internal (Android) and Stratux (Pi)
        this.gpsSource = new GpsSource(this.stratuxClient);
        this.gpsSource.start();

        // Map (fills primaryView inside .map-area)
        this.cockpitMap = new CockpitMap(primaryView, this.stratuxClient);
        this.cockpitMap.init();
        this.cockpitMap.setNasrDB(nasrDb);

        // Vector map layers — init synchronously (non-blocking), data loads in background
        if (typeof VectorMapLayers !== 'undefined') {
            this.vectorLayers = new VectorMapLayers(this.cockpitMap.map, nasrDb);
            this.cockpitMap.setVectorLayers(this.vectorLayers);
            this.vectorLayers.init();
            this.cockpitMap.switchBaseLayer('vector');
        }

        // NASR data import — must complete before plan load so _applyPlan() can stamp type:'APT'
        await this._ensureNasrData(nasrDb);

        // Airport info panel (right-side sliding panel — v5)
        if (typeof AirportPopup !== 'undefined') {
            this.airportPopup = new AirportPopup(this.cockpitMap.map, nasrDb);
            // Init panel inside .map-area so it stays within the map bounds
            const mapAreaEl = document.querySelector('.map-area');
            if (mapAreaEl && this.airportPopup.initPanel) {
                this.airportPopup.initPanel(mapAreaEl);
            }
            this.cockpitMap.setAirportPopup(this.airportPopup);
            this.airportPopup.setGetRouteAirports(() => {
                const wps = this._currentTrip?.waypoints;
                if (!wps?.length) return {};
                return { departure: wps[0], destination: wps[wps.length - 1] };
            });

            this.airportPopup.onDirectTo((apt) => {
                this.openRoutePlanner();
                this.routePlannerPanel?.setDirectTo(apt);
                this.airportPopup.close();
            });

            if (this.vectorLayers) {
                this.airportPopup.setVectorLayers(this.vectorLayers);
                this.vectorLayers._onInternetMetarsFetched = () => this._updateWeatherAge(this._currentTrip);
                this.vectorLayers.onAirportClick((apt) => {
                    if (typeof _wireTapLastTouchAt !== 'undefined' && Date.now() - _wireTapLastTouchAt < 500) return;
                    if (this.routeTable?.isEditing()) {
                        this.routeTable.addWaypointSmart({ icao: apt.icao, name: apt.name || apt.icao, lat: apt.lat, lon: apt.lon });
                        return;
                    }
                    this.airportPopup.show(apt);
                });

                this.vectorLayers.onNavaidClick((nav) => {
                    if (typeof _wireTapLastTouchAt !== 'undefined' && Date.now() - _wireTapLastTouchAt < 500) return;
                    if (this.routeTable?.isEditing()) {
                        this.routeTable.addWaypointSmart({ icao: nav.id, name: nav.name || nav.id, lat: nav.lat, lon: nav.lon });
                        return;
                    }
                    this.airportPopup.showNavaid(nav);
                });

                this.vectorLayers.onFixClick((fix) => {
                    if (typeof _wireTapLastTouchAt !== 'undefined' && Date.now() - _wireTapLastTouchAt < 500) return;
                    if (this.routeTable?.isEditing()) {
                        this.routeTable.addWaypointSmart({ icao: fix.id, name: fix.id, lat: fix.lat, lon: fix.lon });
                    }
                });

                // Traffic tap fallback — when no aviation marker is hit
                this.vectorLayers._onTrafficTap = (containerPt) => {
                    this.cockpitMap._onTrafficTap(containerPt);
                };
            }
        }

        // Engine client (WebSocket to Pi engine monitor)
        const _engCfg = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.raw : {};
        this.engineClient = new EngineClient(
            _engCfg.engineIp       ?? '192.168.10.1',
            _engCfg.engineWsPort   ?? 8082,
            _engCfg.engineHttpPort ?? 8080,
        );
        this.engineClient.connect();
        window.engineClient = this.engineClient;

        // Engine GPS bridge — injects engine GPS when Stratux situation WS is unavailable
        if (typeof EngineGpsBridge !== 'undefined') {
            this.engineGpsBridge = new EngineGpsBridge(this.stratuxClient, this.engineClient);
            this.engineGpsBridge.start();
        }

        // Engine panel (receives data via WebSocket push)
        this.enginePanel = new EnginePanel(document.createElement('div'), this.engineClient);
        this.enginePanel.init();
        window.enginePanel = this.enginePanel;

        // Emergency Glide Calculator (must init before EngineML so trigger() is available)
        if (typeof EmergencyGlide !== 'undefined') {
            this.emergencyGlide = new EmergencyGlide();
        }

        // Engine ML (anomaly detection + advisories)
        if (typeof EngineMLBridge !== 'undefined') {
            this.engineML = new EngineMLBridge();
            this.engineML.init().then(() => {
                this.engineML.setDisplayElements(
                    document.getElementById('statusML'),
                    document.getElementById('engineAdvisory')
                );
                this.engineML.start(this.engineClient, this.stratuxClient);
            });
        }

        // Wire flight recording events to ML logging
        window.addEventListener('flightsync:started', () => {
            window.engineML?.startLogging();
        });
        window.addEventListener('flightsync:stopped', () => {
            window.engineML?.stopLogging();
        });

        // Engine overlay (reads from EnginePanel, floats on map)
        if (typeof EngineOverlay !== 'undefined') {
            this.engineOverlay = new EngineOverlay(primaryView);
            this.stratuxClient.addEventListener('stratux:situation', () => {
                if (this.engineOverlay && this.enginePanel) {
                    this.engineOverlay.update(this.enginePanel.lastData);
                }
            });
        }

        // Engine page (full-screen overlay, accessed via [ENG] button)
        if (typeof EnginePage !== 'undefined') {
            this.enginePage = new EnginePage(document.body, this.enginePanel);
            this.cockpitMap.setEnginePage(this.enginePage);
            // Wire close callback so tab bar returns to map when ✕ is tapped
            this.enginePage.onClose = () => this.tabBar?.selectTab('map');
        }

        // PlanSync — fetches flight plans from flywhere.app
        if (typeof PlanSync !== 'undefined') {
            this.planSync = new PlanSync();
        }

        // PreflightBrief — full-screen preflight brief overlay
        if (typeof PreflightBrief !== 'undefined') {
            this.preflightBrief = new PreflightBrief();
            window.preflightBrief = this.preflightBrief;
        }

        // Fuel overlay (tic mark entry + EDM comparison + priority chain)
        if (typeof FuelOverlay !== 'undefined') {
            this.fuelOverlay = new FuelOverlay(document.body);
            this.cockpitMap.setFuelOverlay(this.fuelOverlay);
            window.addEventListener('fuelstate:changed', () => {
                if (this.routeTable) this.routeTable.refresh();
            });
        }
        if (typeof WbOverlay !== 'undefined') {
            this.wbOverlay = new WbOverlay(document.body);
        }

        // Synthetic per-tank fuel gauges — mounted inside map-area so position:absolute
        // is relative to the map, not the viewport (avoids overlapping top rail)
        if (typeof FuelTanksDisplay !== 'undefined') {
            const mapArea = document.querySelector('.map-area') || document.body;
            this.fuelTanksDisplay = new FuelTanksDisplay(mapArea);
            this.fuelTanksDisplay.init();
        }

        // Flight recorder (records engine + GPS to Savvy CSV on device)
        if (typeof FlightRecorder !== 'undefined') {
            this.flightRecorder = new FlightRecorder(this.engineClient, this.stratuxClient, nasrDb);
            this.flightRecorder.init();
            window.flightRecorder = this.flightRecorder;
            // Update REC badge from flight recorder
            this.flightRecorder.onStatusChange = (status) => {
                const recEl = this.dom.statusRec;
                if (recEl) {
                    if (status.recording) {
                        recEl.textContent = `● REC ${status.rowCount}`;
                        recEl.hidden = false;
                    } else {
                        recEl.hidden = true;
                    }
                }
            };
            // Also update REC badge every 2s while recording
            setInterval(() => {
                const recEl = this.dom.statusRec;
                if (recEl && this.flightRecorder.recording) {
                    recEl.textContent = `● REC ${this.flightRecorder.rowCount}`;
                    recEl.hidden = false;
                } else if (recEl && !this.flightRecorder.recording) {
                    recEl.hidden = true;
                }
            }, 2000);
        }

        // Flight sync (monitors capture_v5 recording, syncs CSVs to iPad — legacy)
        if (typeof FlightSync !== 'undefined' && typeof FlightRecorder === 'undefined') {
            this.flightSync = new FlightSync();
            window.flightSync = this.flightSync;
            setInterval(() => {
                if (!this.flightSync) return;
                const engineData = this.enginePanel?.lastData || null;
                this.flightSync.update(engineData);
            }, 2000);
        }

        // Logbook (auto-creates entries from FlightSync)
        if (typeof Logbook !== 'undefined') {
            this.logbook = new Logbook(nasrDb);
            this.cockpitMap.setLogbook(this.logbook);
        }

        // Flight Upload panel
        if (typeof FlightUpload !== 'undefined') {
            this.flightUpload = new FlightUpload();
        }

        // Route table (bottom sheet, replaces navlog)
        if (typeof RouteTable !== 'undefined') {
            this.routeTable = new RouteTable(primaryView, this.cockpitMap.map);
            this.routeTable.setNasrDb(nasrDb);
            this.routeTable.onRouteChanged((plan) => {
                this.applyRouteEdit(plan, { fromRouteTable: true });
            });
            this.stratuxClient.addEventListener('stratux:situation', (e) => {
                if (this.routeTable) {
                    this.routeTable.updateLive(e.detail);
                    this._checkFuelStopProximity(e.detail);
                }
            });
        }

        // FIS-B weather client (METARs, TAFs, PIREPs, SIGMETs, winds aloft)
        if (typeof FisbClient !== 'undefined') {
            this.fisbClient = new FisbClient(this.stratuxClient, nasrDb);
            this.fisbClient.start();

            // Wire FIS-B to airport popup for live weather
            if (this.airportPopup) {
                this.airportPopup.setFisbClient(this.fisbClient);
            }

            // Wire FIS-B winds to route table
            if (this.routeTable) {
                this.routeTable.setFisbClient(this.fisbClient);
            }

            // Wire Engine ML to route table status card
            if (this.routeTable && this.engineML) {
                this.routeTable.setEngineML(this.engineML);
            }

            // Wire FIS-B METARs to airport weather colors on map
            if (this.vectorLayers) {
                this.vectorLayers.setFisbClient(this.fisbClient);
            }
        }

        // Wire FIS-B client to map for PIREP overlay
        if (this.fisbClient && this.cockpitMap?.setFisbClient) {
            this.cockpitMap.setFisbClient(this.fisbClient);
        }

        // FIS-B NEXRAD renderer (canvas overlay on map)
        if (typeof FisbNexrad !== 'undefined' && this.fisbClient) {
            this.fisbNexrad = new FisbNexrad(this.fisbClient);
            this.cockpitMap.setFisbNexrad(this.fisbNexrad);

            // Dedicated full-screen CONUS radar page (own map). Drawer entry wired in a later task.
            if (typeof RadarPage !== 'undefined') {
                this.radarPage = new RadarPage(this.fisbNexrad, this.stratuxClient);
            }
        }

        // Convective Intelligence Engine — must be after fisbClient and fisbNexrad are assigned
        if (typeof ConvectiveIntelligenceEngine !== 'undefined' &&
            typeof HRRRPreflightStore !== 'undefined' &&
            this.fisbNexrad && this.fisbClient) {
            const preflightStore = new HRRRPreflightStore();
            this.convectiveEngine = new ConvectiveIntelligenceEngine({
                fisbNexrad: this.fisbNexrad,
                fisbClient: this.fisbClient,
                engineClient: this.engineClient,
                stratuxClient: this.stratuxClient,
                preflightStore,
            });
            const convDisplay = new ConvectiveDisplay(this.cockpitMap?.map);
            const convAlerts  = new ConvectiveAlerts();
            this.convectiveEngine.init(convDisplay, convAlerts);
            if (this.cockpitMap?.map) {
                convAlerts.mount(this.cockpitMap.map.getContainer());
            }
            this.convectiveEngine.loadPreflight().catch(e => DiagLog.log('convective', `Preflight load error: ${e.message}`));
            if (CockpitConfig.get('convective.enabled')) {
                this.convectiveEngine.setActive(true);
            }
        }

        // Radar loop (animated NEXRAD — uses FIS-B frames)
        if (typeof RadarLoop !== 'undefined') {
            this.radarLoop = new RadarLoop();
            if (this.fisbNexrad) {
                this.radarLoop.setNexrad(this.fisbNexrad);
                this.radarLoop.setFisbRenderer(this.fisbNexrad);
            }
            this.cockpitMap.setRadarLoop(this.radarLoop);
        }

        // FIS-B weather display (PIREPs, SIGMETs, weather strip)
        if (typeof FisbWeatherDisplay !== 'undefined' && this.fisbClient) {
            this.fisbWeather = new FisbWeatherDisplay(this.fisbClient, this.cockpitMap.map);
            this.fisbWeather.init();
            this.cockpitMap.setFisbWeather(this.fisbWeather);
            this._startAdvisoryRefresh();
        }

        // FIS-B Status overlay (reception health, tower list, product grid)
        if (typeof FisbStatus !== 'undefined' && this.fisbClient) {
            this.fisbStatus = new FisbStatus(this.stratuxClient, this.fisbClient);
        }

        // Lightning strikes (Blitzortung WebSocket)
        if (typeof LightningLayer !== 'undefined') {
            this.lightning = new LightningLayer();
            this.cockpitMap.setLightning(this.lightning);
        }

        // Approach charts (georeferenced plate viewer + map overlay)
        if (typeof ApproachCharts !== 'undefined') {
            this.approachCharts = new ApproachCharts(document.body);
            this.approachCharts.setNasrDb(nasrDb);
            this.approachCharts._loadPromise = this.approachCharts.loadIndex();
            this.approachCharts.setMap(this.cockpitMap.map);
            if (this.airportPopup) {
                this.airportPopup.setApproachCharts(this.approachCharts);
            }
            this.stratuxClient.addEventListener('stratux:situation', (e) => {
                if (this.approachCharts && e.detail) {
                    this.approachCharts.updateOwnship(
                        e.detail.lat, e.detail.lon, e.detail.true_course
                    );
                }
            });
            document.addEventListener('cifp:load-procedure', (e) => {
                if (!this.routePlannerPanel || !e.detail) return;
                // Open BEFORE inserting — openRoutePlanner calls _loadPlan which resets _route,
                // so the approach fixes must be spliced in after the plan is loaded.
                if (!document.getElementById('cockpitContainer')?.classList.contains('route-editing')) {
                    this.openRoutePlanner();
                }
                this.routePlannerPanel.insertApproach(e.detail);
                this.approachCharts?.hide();
            });
        }


        // IFR clearance (CD phone + CRAFT readback)
        if (typeof IfrClearance !== 'undefined') {
            this.ifrClearance = new IfrClearance(document.body, nasrDb);
            if (this.airportPopup) {
                this.airportPopup.setIfrClearance(this.ifrClearance);
            }
            if (this.cockpitMap) {
                this.cockpitMap.setIfrClearance(this.ifrClearance);
            }
        }

        // Data status (chart cycle verification)
        if (typeof DataStatus !== 'undefined') {
            this.dataStatus = new DataStatus(document.body);
            this.cockpitMap.setDataStatus(this.dataStatus);
        }

        // Checklist
        if (typeof Checklist !== 'undefined') {
            this.checklist = new Checklist(document.body);
            this.cockpitMap.setChecklist(this.checklist);
        }

        // Config editor
        if (typeof ConfigEditor !== 'undefined') {
            this.configEditor = new ConfigEditor(document.body);
            this.cockpitMap.setConfigEditor(this.configEditor);
        }

        // Weather briefing (MOS timeline)
        if (typeof WxBriefing !== 'undefined') {
            const wxCfg = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.raw : {};
            this.wxBriefing = new WxBriefing(nasrDb, wxCfg);
            this.wxBriefing.init();
            document.addEventListener('notam:goto', (e) => {
                const { lat, lon, zoom } = e.detail;
                this.wxBriefing?.hide();
                this.cockpitMap?.map?.flyTo([lat, lon], zoom ?? 9, { animate: true, duration: 0.8 });
            });
        }

        // Track log
        this.trackLog = new TrackLog(this.stratuxClient, this.cockpitMap);
        this.trackLog.init();

        // Build planning adapters. The lib's window namespace lands asynchronously;
        // route-planner-panel.js waits on the 'flytab-planning:ready' event before
        // instantiating the planner.
        this._planningAdapters = await this._buildPlanningAdapters();

        // Route planner panel
        if (typeof RoutePlannerPanel !== 'undefined') {
            this.routePlannerPanel = new RoutePlannerPanel(
                document.getElementById('routePlannerPanel'),
                nasrDb,
                this._planningAdapters,
            );
            this.routePlannerPanel.init();
        }

        // Device status (headless — only shown on demand)
        this.deviceStatus = new DeviceStatus(
            document.createElement('div'), this.stratuxClient, this.enginePanel
        );
        this.deviceStatus.init();

        // Range calculator
        this.rangeCalc = new RangeCalc(this.stratuxClient, this.enginePanel, this.cockpitMap);
        this.rangeCalc.init();

        // ── Power Tradeoff Panel ─────────────────────────────────────────────
        if (typeof PowerTradeoff !== 'undefined') {
            this.powerTradeoff = new PowerTradeoff();
            this.powerTradeoff.init();
        }

        // ── v5 UI: Instrument Strip ──────────────────────────────────────────
        if (typeof InstrumentStrip !== 'undefined') {
            this.instrumentStrip = new InstrumentStrip(this.stratuxClient, this.engineClient);
            if (this.fuelOverlay) this.instrumentStrip.setFuelOverlay(this.fuelOverlay);
            if (this.powerTradeoff) this.instrumentStrip.setPowerTradeoff(this.powerTradeoff);
            if (this.vectorLayers) this.instrumentStrip.setVectorLayers(this.vectorLayers);
            const stripEl = this.instrumentStrip.init();
            // Place instrument strip inside route-table-sheet (after handle) so they stack together
            const rtSheet = document.querySelector('.route-table-sheet');
            const stripContainer = rtSheet || document.getElementById('instrumentStrip');
            if (stripContainer && stripEl) {
                const wrapper = document.getElementById('instrumentStrip');
                if (rtSheet && wrapper) {
                    // Move the instrumentStrip div inside the route-table-sheet
                    rtSheet.appendChild(wrapper);
                }
                wrapper.appendChild(stripEl);
            }
        }

        // ── Everywhere Search ────────────────────────────────────────────────
        if (typeof EverywhereSearch !== 'undefined') {
            this.everywhereSearch = new EverywhereSearch(nasrDb, this.stratuxClient);
            if (this.approachCharts) this.everywhereSearch.setApproachCharts(this.approachCharts);
            if (this.routeTable)     this.everywhereSearch.setRouteTable(this.routeTable);
            if (this.airportPopup)   this.everywhereSearch.setAirportPopup(this.airportPopup);
            if (this.cockpitMap)     this.everywhereSearch.setCockpitMap(this.cockpitMap);
            this.everywhereSearch.setGetActiveTrip(() => this._currentTrip);
        }

        // ── v5 UI: Left Rail ─────────────────────────────────────────────────
        this._buildLeftRail();

        // ── v5 UI: Layer Panel ───────────────────────────────────────────────
        if (typeof LayerPanel !== 'undefined') {
            this.layerPanel = new LayerPanel(
                this.cockpitMap.map,
                this.vectorLayers,
                this.cockpitMap
            );
            this.layerPanel.init();
            this.layerPanel.setGetRouteBbox(() => this._getRouteBbox());
        }

        // ── v5 UI: Tab Bar ───────────────────────────────────────────────────
        if (typeof TabBar !== 'undefined') {
            this.tabBar = new TabBar({
                enginePage: this.enginePage,
                checklist: this.checklist,
                logbook: this.logbook,
                approachCharts: this.approachCharts,
                fuelOverlay: this.fuelOverlay,
                dataStatus: this.dataStatus,
                fisbStatus: this.fisbStatus,
                configEditor: this.configEditor,
                ifrClearance: this.ifrClearance,
                wxBriefing: this.wxBriefing,
                trackLog: this.trackLog,
                airportPopup: this.airportPopup,
                stratuxIp: Settings.stratuxIp || '192.168.10.1',
                planSync: this.planSync,
                radarLoop: this.radarLoop,
                radarPage: this.radarPage,
                flightUpload: this.flightUpload,
                routeTable: this.routeTable,
                layerPanel: this.layerPanel,
                everywhereSearch: this.everywhereSearch,
                wbOverlay: this.wbOverlay,
            });
            this.tabBar.init();
        }

        // Pre-flight data readiness check (auto-triggers if active plan exists)
        if (typeof PreflightCheck !== 'undefined') {
            this.preflightCheck = new PreflightCheck(nasrDb);
            // Expose on window.app so DataStatus "Details" button can reach it
            window.app = this;
            // Delay slightly so cockpit UI settles before the overlay appears
            setTimeout(() => this.preflightCheck.autoTrigger(), 1500);
        }

        // Load active plan
        await this._loadActivePlan();

        // Resize map after layout settles
        setTimeout(() => this.cockpitMap.resize(), 200);
    }

    /** Left rail removed — controls now in tab bar */
    _buildLeftRail() {}

    async _ensureNasrData(nasrDb) {
        // NanoHTTPD (localhost:9090) is the sole local data source.
        // Re-import only if NanoHTTPD has a newer cycle than the DB.
        // Never downgrade: if NanoHTTPD is older than DB, keep DB.
        try {
            const [localFile, dbCycle, testApt] = await Promise.all([
                fetch('http://localhost:9090/nasr/cycle_info.json', { signal: AbortSignal.timeout(2000) })
                    .then(r => r.ok ? r.json() : null).catch(() => null),
                nasrDb.getCycleInfo().catch(() => null),
                nasrDb.getAirport('KJFK').catch(() => null),
            ]);
            const fileDate   = localFile?.effective_date;
            const dbDate     = dbCycle?.effective_date;
            const fileSuaCnt    = localFile?.sua_count ?? null;
            const dbSuaCnt      = dbCycle?.sua_count ?? null;
            const fileBundleVer = localFile?.bundle_version ?? null;
            const dbBundleVer   = dbCycle?.bundle_version ?? null;
            const dateMatch     = fileDate && fileDate === dbDate;
            const suaMatch      = fileSuaCnt === null || (dbSuaCnt !== null && fileSuaCnt === dbSuaCnt);
            const bundleMatch   = fileBundleVer === null || (dbBundleVer !== null && fileBundleVer <= dbBundleVer);
            if (testApt && dateMatch && suaMatch && bundleMatch) return; // DB is current
            if (testApt && !fileDate) return;                           // NanoHTTPD not ready; keep DB
            if (testApt && fileDate && dbDate && fileDate < dbDate) return; // NanoHTTPD older than DB; don't downgrade
        } catch { /* fall through to import */ }

        DiagLog.log('nasr', 'NASR DB empty or stale — importing');
        console.log('[FlyTab] NASR DB empty or stale — trying to import...');

        try {
            // Import from NanoHTTPD (the locally synced bundle)
            let bundle;
            try {
                const localResp = await fetch('http://localhost:9090/nasr/bundle.json', {
                    signal: AbortSignal.timeout(60000),
                });
                if (localResp.ok) bundle = await localResp.json();
            } catch { /* local not available */ }
            if (!bundle) {
                // NanoHTTPD unavailable — fall back to home server
                const bases = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.homeBases : [];
                if (!bases.length) throw new Error('No home server configured');

                let resp = null;
                for (const base of bases) {
                    try {
                        resp = await fetch(`${base}/nasr/bundle.json`, {
                            cache: 'no-store',
                            signal: AbortSignal.timeout(60000),
                        });
                        if (resp.ok) break;
                    } catch { resp = null; }
                }
                if (!resp?.ok) throw new Error('Home server not reachable');
                bundle = await resp.json();
            }

            const count = await nasrDb.importNasrBundle(bundle);
            DiagLog.log('nasr', `NASR imported: ${count} records`);
            console.log(`[FlyTab] NASR imported: ${count} records`);
            if (this.vectorLayers) {
                this.vectorLayers._updateDynamicLayers();
            }
            this._updateNasrBadge();
        } catch (err) {
            DiagLog.log('error', 'NASR import failed — data must be synced from home server', err?.message || String(err));
            console.warn('[FlyTab] NASR import failed:', err?.message);
        }
    }

    // === Route Bbox (for Cache Tiles) ==========

    /** Returns bounding box for the current route + ~1° buffer, or null if no plan loaded. */
    _getRouteBbox() {
        const wps = this._currentTrip?.waypoints;
        if (!wps?.length) return null;
        const lats = wps.map(w => w.lat).filter(v => Number.isFinite(v));
        const lons = wps.map(w => w.lon).filter(v => Number.isFinite(v));
        if (!lats.length) return null;
        const PAD = 1.0; // ~60 nm buffer
        const latMin = Math.min(...lats) - PAD;
        const latMax = Math.max(...lats) + PAD;
        const lonMin = Math.min(...lons) - PAD;
        const lonMax = Math.max(...lons) + PAD;
        const dep = wps[0].icao || wps[0].name || '';
        const dest = wps[wps.length - 1].icao || wps[wps.length - 1].name || '';
        const label = dep && dest ? `${dep} → ${dest}` : 'Route';
        return { latMin, latMax, lonMin, lonMax, label, id: 'route', sub: label };
    }

    // === Plan Loading ==========

    async _loadActivePlan() {
        // FlyTab: plans are stored locally — load from localStorage
        // Phase 2 will add Capacitor Filesystem + flywhere.app sync
        try {
            const raw = localStorage.getItem('flypi_active_plan');
            if (raw) {
                await this._applyPlan(JSON.parse(raw));
                DiagLog.log('plan', 'Plan loaded from local storage');
                return;
            }
        } catch { /* no local plan */ }

        // No plan found — show load button
        DiagLog.log('plan', 'No plan found — showing Load Package button');
        const loadBtn = document.getElementById('cockpitLoadBtn');
        if (loadBtn) loadBtn.style.display = '';
    }

    _updateOrientation() {
        document.getElementById('cockpitContainer')
            ?.classList.toggle('landscape', window.innerWidth > window.innerHeight);
    }

    openRoutePlanner(plan) {
        document.getElementById('cockpitContainer')?.classList.add('route-editing');
        document.body.classList.add('route-editing-mode');
        this._updateOrientation();
        this.routePlannerPanel?.open(plan || this._currentTrip);
        setTimeout(() => this.cockpitMap?.map?.invalidateSize(), 300);
    }

    closeRoutePlanner() {
        document.getElementById('cockpitContainer')?.classList.remove('route-editing', 'landscape');
        document.body.classList.remove('route-editing-mode');
        this.routePlannerPanel?.close();
        setTimeout(() => this.cockpitMap?.map?.invalidateSize(), 300);
    }

    async applyRouteEdit(plan, { fromRouteTable = false } = {}) {
        if (!plan) return;
        plan.edited_at = new Date().toISOString();

        // Latest-wins guard: if a plan apply is already in progress, store the latest
        // request and return — the running loop will pick it up when done.
        this._pendingPlanEdit = { plan, opts: { fromRouteTable } };
        if (this._applyingPlan) return;

        this._applyingPlan = true;
        try {
            while (this._pendingPlanEdit) {
                const { plan: p, opts: o } = this._pendingPlanEdit;
                this._pendingPlanEdit = null;
                await this._applyPlan(p, { skipRouteTable: o.fromRouteTable });
            }
        } finally {
            this._applyingPlan = false;
        }
    }

    async _applyPlan(plan, { skipRouteTable = false } = {}) {
        if (!plan) return;

        // Normalize waypoints from route or legs
        let wps = plan.waypoints || [];
        if (wps.length === 0 && plan.flight_plan) {
            const fp = plan.flight_plan;
            // Build from route array (ICAO strings)
            if (fp.route?.length) {
                wps = fp.route.map(icao => ({ icao, name: icao }));
            } else if (fp.legs?.length) {
                // Build from legs: departure + all "to" waypoints
                const ids = [fp.legs[0].from, ...fp.legs.map(l => l.to)].filter(Boolean);
                wps = ids.map(icao => ({ icao, name: icao }));
            }
            // Map leg performance data onto waypoints by matching leg.to → wp.icao
            // (positional mapping breaks if any waypoint fails to resolve and gets filtered out)
            if (fp.legs?.length && wps.length > 0) {
                const legByDest = {};
                for (const leg of fp.legs) {
                    if (leg.to) legByDest[leg.to.toUpperCase()] = leg;
                }
                for (const wp of wps) {
                    const leg = legByDest[wp.icao?.toUpperCase()];
                    if (!leg) continue;
                    wp.alt = leg.altitude || fp.altitude;
                    wp.gs = leg.gsKt;
                    wp.tas = leg.tasKt;
                    // Preserve full segments array for route table phase computation
                    wp._segments = leg.segments || [];
                    // Wind
                    if (leg.windDir != null && leg.windSpd != null) {
                        wp.wind = { dir: leg.windDir, spd: leg.windSpd };
                    }
                    // Engine data from cruise segment (for backwards compat)
                    const cruiseSeg = (leg.segments || []).find(s => s.phase === 'CRZ')
                                   || (leg.segments || [])[leg.segments?.length - 1];
                    if (cruiseSeg) {
                        wp.rpm = cruiseSeg.rpm;
                        wp.mp = cruiseSeg.mp;
                        wp.percent_power = cruiseSeg.percent_power;
                        wp.gph = wp.gph || cruiseSeg.gph;
                    }
                }
            }
        }

        // Resolve lat/lon and elev_ft from NASR database (airports → navaids → fixes).
        // Always look up elev_ft even when lat/lon already exist — cockpit-edited plans
        // may have coordinates but no field elevation, which is needed for CLB/DES segments.
        // Parallelized with Promise.all + 5-second timeout guard. On timeout the app
        // continues with existing waypoint coords — route is still rendered, just without
        // freshly-resolved elevations or type stamps.
        if (this._nasrDb) {
            const nasr = this._nasrDb;
            const resolveAll = Promise.all(wps.map(async (wp) => {
                if (!wp.icao) return;
                try {
                    // Always check airport first to set type='APT' — even if coords are
                    // already resolved, the type may be missing on pre-existing waypoints.
                    const apt = await nasr.getAirport(wp.icao);
                    if (apt) {
                        if (!Number.isFinite(wp.lat)) wp.lat = apt.lat;
                        if (!Number.isFinite(wp.lon)) wp.lon = apt.lon;
                        wp.elev_ft = wp.elev_ft ?? apt.elev_ft ?? null;
                        wp.name = wp.name || apt.name;
                        wp.type = 'APT'; // authoritative — NASR confirmed this is an airport
                    } else if (!Number.isFinite(wp.lat) || !Number.isFinite(wp.lon)) {
                        // Coords missing or non-finite — try navaid then fix in local NASR
                        let found = await nasr.getNavaid(wp.icao);
                        if (!found) found = await nasr.getFix(wp.icao);
                        if (found) {
                            if (!Number.isFinite(wp.lat)) wp.lat = found.lat;
                            if (!Number.isFinite(wp.lon)) wp.lon = found.lon;
                            wp.elev_ft = wp.elev_ft ?? found.elev_ft ?? null;
                            wp.name = wp.name || found.name;
                        } else {
                            // Last resort: try AWC navaid API (handles navaids/fixes not in local NASR bundle)
                            try {
                                const awcResp = await fetch(`https://aviationweather.gov/api/data/navaid?ids=${encodeURIComponent(wp.icao)}&format=json`,
                                    { signal: AbortSignal.timeout(5000) });
                                if (awcResp.ok) {
                                    const awcData = await awcResp.json();
                                    const awcNav = Array.isArray(awcData) ? awcData[0] : awcData;
                                    if (Number.isFinite(awcNav?.lat) && Number.isFinite(awcNav?.lon)) {
                                        wp.lat = awcNav.lat;
                                        wp.lon = awcNav.lon;
                                        wp.elev_ft = awcNav.elev ?? null;
                                        wp.name = wp.name || awcNav.name || wp.icao;
                                        console.log(`_applyPlan: resolved "${wp.icao}" via AWC navaid API`);
                                    } else {
                                        console.warn(`_applyPlan: could not resolve waypoint "${wp.icao}" (not in NASR or AWC)`);
                                    }
                                }
                            } catch { /* offline or timeout — waypoint will be filtered */ }
                        }
                    }
                } catch { /* NASR not ready yet */ }
            }));
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('NASR lookup timeout after 5s')), 5000)
            );
            try {
                await Promise.race([resolveAll, timeout]);
            } catch (err) {
                DiagLog.log('error', `_applyPlan: ${err.message}`);
                // Continue with whatever coords are already on the waypoints
            }
        }

        // Filter out unresolved waypoints so the route polyline doesn't break
        const _wpsBeforeFilter = wps;
        wps = wps.filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lon));

        // Warn if any waypoints were dropped (unresolved)
        const droppedCount = _wpsBeforeFilter.length - wps.length;
        if (droppedCount > 0) {
            const resolvedIcaos = new Set(wps.map(w => w.icao));
            const dropped = _wpsBeforeFilter
                .filter(w => !resolvedIcaos.has(w.icao))
                .map(w => w.icao)
                .join(', ');
            this.showToast(`⚠ ${droppedCount} waypoint${droppedCount > 1 ? 's' : ''} not found: ${dropped}`);
        }

        // trip — normalized top-level plan object with resolved waypoints
        const normalized = { ...plan, waypoints: wps };
        this._currentTrip = normalized;
        this._shownFuelStopOverlays = new Set(); // reset on new plan — stops may differ

        // Sync embedded aircraft profile to Pi config (merge, don't overwrite Pi-only fields)
        if (plan.aircraft && plan.aircraft.id) {
            this._syncAircraftToPi(plan.aircraft);
        }

        // Hide load button once a plan is loaded
        const loadBtn = document.getElementById('cockpitLoadBtn');
        if (loadBtn) loadBtn.style.display = 'none';

        // Persist route bbox for cache.html
        const bbox = this._getRouteBbox();
        if (bbox) localStorage.setItem('flypi_route_bbox', JSON.stringify(bbox));
        else localStorage.removeItem('flypi_route_bbox');
        const routeBtn = document.getElementById('lpRouteCacheBtn');
        const routeSub = document.getElementById('lpRouteCacheSub');
        if (routeBtn) routeBtn.disabled = !bbox;
        if (routeSub && bbox) routeSub.textContent = `${bbox.label} +60 nm buffer`;

        // Update components (filter out waypoints with no coordinates)
        if (this.instrumentStrip) this.instrumentStrip.setActivePlan(normalized);
        if (this.routeTable && !skipRouteTable) this.routeTable.loadPlan(normalized);
        if (this.cockpitMap && wps.length >= 2) this.cockpitMap.setRoute(wps);
        if (this.rangeCalc) this.rangeCalc.setPlan(normalized);
        // routePlannerPanel syncs via open() when the pilot explicitly opens it;
        // no live-sync needed while the panel is closed.

        if (this.approachCharts) {
            const icaoList = wps.map(wp => wp.icao).filter(Boolean);
            this.approachCharts.setRouteAirports(icaoList);
        }

        // Update FIS-B weather strip and status page with route airports
        if (this.fisbWeather || this.fisbStatus) {
            const icaoList = wps.map(wp => wp.icao).filter(Boolean);
            if (this.fisbWeather) this.fisbWeather.setRouteAirports(icaoList);
            if (this.fisbStatus) this.fisbStatus.setRouteAirports(icaoList);
        }


        if (this.ifrClearance) {
            this.ifrClearance._flightPlan = normalized;
        }

        if (this.wxBriefing) {
            this.wxBriefing.setFlightPlan(normalized);
        }

        if (this.convectiveEngine && normalized?.waypoints) {
            this.convectiveEngine.setRoute(normalized.waypoints);
        }

        this._updateWeatherAge(plan);

        // Save the resolved plan (with lat/lon stamped on all waypoints) to localStorage.
        // This replaces the pre-resolution save in applyRouteEdit so a round-trip load
        // does not need to re-resolve NASR (faster boot, survives offline/timeout).
        try { localStorage.setItem('flypi_active_plan', JSON.stringify(normalized)); } catch {}

        // Seed IndexedDB weather cache from plan's weather_cache so airport popups can look it up
        const wc = plan.weather_cache || plan.weather;
        if (wc?.metars && this._nasrDb) {
            for (const [icao, metar] of Object.entries(wc.metars)) {
                this._nasrDb.putWeather(icao, {
                    metar,
                    taf: wc.tafs?.[icao] || null,
                    fetched_at: metar.fetched_at || wc.fetched_at,
                    source: 'plan',
                }).catch(() => {});
            }

            // Color airport markers from plan weather (visible airports already on map)
            if (this.vectorLayers) {
                this.vectorLayers.refreshWeatherColors(wc.metars);
            }
        }
    }

    _updateWeatherAge(plan) {
        const wc = plan?.weather_cache || plan?.weather;
        const planMs = wc?.fetched_at ? new Date(wc.fetched_at).getTime() : 0;
        const internetMs = this.vectorLayers?._internetFetchedAt || 0;
        const mostRecentMs = Math.max(planMs, internetMs);
        if (!mostRecentMs) return;

        const age = Date.now() - mostRecentMs;
        const ageMin = Math.round(age / 60000);
        let ageStr, className;

        if (ageMin < 60) {
            ageStr = `WX ${ageMin}m`;
            className = 'wx-fresh';
        } else if (ageMin < 180) {
            ageStr = `WX ${Math.round(ageMin / 60)}h`;
            className = 'wx-aging';
        } else {
            ageStr = `WX ${Math.round(ageMin / 60)}h old`;
            className = 'wx-stale';
        }

        this.dom.statusWeather.textContent = ageStr;
        this.dom.statusWeather.className = `status-item ${className}`;
    }

    // === Wake Lock ==========

    async _acquireWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            this._wakeLock = await navigator.wakeLock.request('screen');
        } catch { /* denied or not supported — silently ignore */ }
    }

    _releaseWakeLock() {
        if (this._wakeLock) {
            this._wakeLock.release().catch(() => {});
            this._wakeLock = null;
        }
    }

    // === Thermal Monitor ==========

    _initThermalMonitor() {
        if (typeof ThermalMonitor === 'undefined') return;
        this.thermalMonitor = new ThermalMonitor();
        const badge = document.getElementById('statusThermal');
        if (badge) this.thermalMonitor.start(badge);

        // When thermal warning fires, release wake lock so pilot can turn screen off
        this._thermalWakeLockReleased = false;
        const origUpdate = this.thermalMonitor._updateWarning.bind(this.thermalMonitor);
        this.thermalMonitor._updateWarning = (data) => {
            origUpdate(data);
            const hot = data.surfaceTemp >= 50;
            if (hot && !this._thermalWakeLockReleased) {
                this._releaseWakeLock();
                this._thermalWakeLockReleased = true;
                DiagLog.log('thermal', 'Wake lock released — tablet hot, screen can turn off');
            } else if (!hot && this._thermalWakeLockReleased) {
                this._acquireWakeLock();
                this._thermalWakeLockReleased = false;
                DiagLog.log('thermal', 'Wake lock re-acquired — tablet cooled');
            }
        };
    }

    // === Clock ==========

    _startClock() {
        // Create local time element if the HTML doesn't have it yet
        if (!this.dom.statusTimeLocal && this.dom.statusTime) {
            const el = document.createElement('span');
            el.id = 'statusTimeLocal';
            el.className = 'status-item status-time-local';
            this.dom.statusTime.insertAdjacentElement('afterend', el);
            this.dom.statusTimeLocal = el;
        }

        const updateClock = () => {
            const now = new Date();
            if (this.dom.statusTime)
                this.dom.statusTime.textContent = now.toISOString().slice(11, 16) + 'Z';
            if (this.dom.statusTimeLocal) {
                const hh = String(now.getHours()).padStart(2, '0');
                const mm = String(now.getMinutes()).padStart(2, '0');
                this.dom.statusTimeLocal.textContent = hh + ':' + mm + 'L';
            }
        };
        updateClock();
        this._clockInterval = setInterval(updateClock, 10000);
        window.addEventListener('beforeunload', () => clearInterval(this._clockInterval));
    }

    // === Aircraft Config Sync ==========

    /**
     * Map Supabase aircraft profile to Pi format and merge with existing config.
     * Preserves Pi-only fields (V-speeds, phase power, DMMS) that Supabase doesn't have.
     */
    async _syncAircraftToPi(profile) {
        try {
            // Fetch existing Pi config to preserve Pi-only fields
            // FlyTab: read existing config from local storage
            let existing = {};
            try {
                const cached = localStorage.getItem('flypi_cfg_aircraft_config_json');
                if (cached) existing = JSON.parse(cached);
            } catch { /* no existing config */ }

            const existingPerf = existing.performance || {};

            // Map Supabase fields to Pi format, merge with existing
            // Supabase performance JSONB → Pi performance fields
            const supaPerf = profile.performance || {};
            const merged = {
                ...existing,
                id: profile.id,
                tail: profile.tail_number || existing.tail,
                type: profile.type_code || existing.type,
                engine_type: profile.engine_type || existing.engine_type,
                engine_model: profile.engine_model || existing.engine_model,
                synced_from_supabase_at: new Date().toISOString(),
                performance: {
                    ...existingPerf,
                    cruise_speed_kt: profile.cruise_ias ?? existingPerf.cruise_speed_kt,
                    cruise_gph: profile.fuel_burn_gph ?? existingPerf.cruise_gph,
                    fuel_capacity_gal: profile.fuel?.capacity_gal ?? existingPerf.fuel_capacity_gal,
                    // V-speeds, climb, descent, power from Supabase performance JSONB
                    ...(supaPerf.vs0_kt != null && { vs0_kt: supaPerf.vs0_kt }),
                    ...(supaPerf.vs1_kt != null && { vs1_kt: supaPerf.vs1_kt }),
                    ...(supaPerf.vfe_kt != null && { vfe_kt: supaPerf.vfe_kt }),
                    ...(supaPerf.vno_kt != null && { vno_kt: supaPerf.vno_kt }),
                    ...(supaPerf.vne_kt != null && { vne_kt: supaPerf.vne_kt }),
                    ...(supaPerf.cruise_pwr_pct != null && { cruise_pwr_pct: supaPerf.cruise_pwr_pct }),
                    ...(supaPerf.cruise_rpm != null && { cruise_rpm: supaPerf.cruise_rpm }),
                    ...(supaPerf.cruise_mp != null && { cruise_mp: supaPerf.cruise_mp }),
                    ...(supaPerf.max_hp != null && { max_hp: supaPerf.max_hp }),
                    ...(supaPerf.climb_speed_kt != null && { climb_speed_kt: supaPerf.climb_speed_kt }),
                    ...(supaPerf.climb_fpm != null && { climb_fpm: supaPerf.climb_fpm }),
                    ...(supaPerf.climb_gph != null && { climb_gph: supaPerf.climb_gph }),
                    ...(supaPerf.climb_pwr_pct != null && { climb_pwr_pct: supaPerf.climb_pwr_pct }),
                    ...(supaPerf.climb_rpm != null && { climb_rpm: supaPerf.climb_rpm }),
                    ...(supaPerf.climb_mp != null && { climb_mp: supaPerf.climb_mp }),
                    ...(supaPerf.descent_speed_kt != null && { descent_speed_kt: supaPerf.descent_speed_kt }),
                    ...(supaPerf.descent_fpm != null && { descent_fpm: supaPerf.descent_fpm }),
                    ...(supaPerf.descent_gph != null && { descent_gph: supaPerf.descent_gph }),
                    ...(supaPerf.descent_pwr_pct != null && { descent_pwr_pct: supaPerf.descent_pwr_pct }),
                    ...(supaPerf.descent_rpm != null && { descent_rpm: supaPerf.descent_rpm }),
                    ...(supaPerf.descent_mp != null && { descent_mp: supaPerf.descent_mp }),
                    ...(supaPerf.pattern_speed_kt != null && { pattern_speed_kt: supaPerf.pattern_speed_kt }),
                    ...(supaPerf.approach_speed_kt != null && { approach_speed_kt: supaPerf.approach_speed_kt }),
                    ...(supaPerf.dmms_factor != null && { dmms_factor: supaPerf.dmms_factor }),
                    ...(supaPerf.min_runway_ft != null && { min_runway_ft: supaPerf.min_runway_ft }),
                },
            };

            // FlyTab: save merged config to localStorage
            try {
                localStorage.setItem('flypi_cfg_aircraft_config_json', JSON.stringify(merged));
            } catch { /* storage full */ }

            // Refresh in-memory config
            if (typeof CockpitConfig !== 'undefined') {
                CockpitConfig._aircraft = merged;
            }
        } catch (err) {
            console.warn('Aircraft config merge failed:', err);
        }
    }

    // === GPS & FIS-B Status ==========

    _startDeviceStatusMonitor() {
        const update = () => {
            const connected = this.stratuxClient?.connected;
            const stale = this.stratuxClient?.stale;
            // Only use situation/deviceStatus when Stratux is live — never show
            // stale last-session values as if they were current data.
            const sit = (connected && !stale) ? this.stratuxClient?.situation : null;
            const status = connected ? this.stratuxClient?.deviceStatus : null;

            // GPS: green if fix (quality >= 1), amber if engine bridge active, show solution type + source
            if (this.dom.statusGps) {
                const bridgeActive = this.engineGpsBridge?.active === true;
                const src = bridgeActive ? 'ENG'
                    : (this.gpsSource?.label ?? (this.gpsSource?.source === 'internal' ? 'INT' : 'STX'));
                const q = sit?.gps_fix_quality ?? 0;
                const gpsOk = !bridgeActive && q >= 1;
                this.dom.statusGps.classList.toggle('active', gpsOk);
                this.dom.statusGps.classList.toggle('active-degraded', bridgeActive);
                if (gpsOk) {
                    const sats = sit.gps_sats != null ? `${sit.gps_sats}sv` : '';
                    const sol = GPS_SOLUTION_LABELS[q] || 'FIX';
                    const acc = sit._accuracy != null ? `±${Math.round(sit._accuracy)}m` : '';
                    this.dom.statusGps.textContent = `${src} ${sol} ${sats || acc}`.trim();
                } else if (bridgeActive) {
                    this.dom.statusGps.textContent = 'ENG GPS';
                } else {
                    this.dom.statusGps.textContent = `${src} GPS`;
                }
                // Auto-dismiss diag panel when GPS resolves
                if (gpsOk && this._gpsDiagPanel?.classList.contains('visible')) {
                    this._gpsDiagPanel.classList.remove('visible');
                }
            }

            // FIS-B: green when the 978 MHz UAT radio is present and receiving UAT messages.
            // UATRadio_connected = hardware detected; UAT_messages_last_minute = data flowing.
            // Guard: only evaluate when Stratux is connected.
            if (this.dom.statusFisb) {
                const uatRadio = !!status?.UATRadio_connected;
                const receiving = uatRadio && (status?.UAT_messages_last_minute > 0);
                this.dom.statusFisb.classList.toggle('active', receiving);
                if (receiving && this.fisbClient) {
                    const mc = this.fisbClient.metarCount;
                    const tc = this.fisbClient.tafCount;
                    this.dom.statusFisb.textContent = `FIS-B ${mc}M ${tc}T`;
                } else if (receiving) {
                    const metars = status.UAT_METAR_total || 0;
                    this.dom.statusFisb.textContent = `FIS-B ${metars}`;
                } else {
                    this.dom.statusFisb.textContent = 'FIS-B';
                }
            }
        };
        update();
        this._deviceStatusInterval = setInterval(update, 5000);
    }

    // === GPS Diag Panel ==========

    _initGpsDiagPanel() {
        const panel = document.createElement('div');
        panel.id = 'gps-diag-panel';
        const statusBar = document.getElementById('statusBar');
        if (statusBar) statusBar.insertAdjacentElement('afterend', panel);
        this._gpsDiagPanel = panel;
        this.dom.statusGps?.addEventListener('click', () => this._toggleGpsDiagPanel());
    }

    _toggleGpsDiagPanel() {
        if (!this._gpsDiagPanel) return;
        const nowVisible = this._gpsDiagPanel.classList.toggle('visible');
        if (nowVisible) this._renderGpsDiagPanel();
    }

    _renderGpsDiagPanel() {
        const panel = this._gpsDiagPanel;
        if (!panel) return;

        const bridgeActive = this.engineGpsBridge?.active === true;
        const stale = this.stratuxClient?.stale;
        const sit = this.stratuxClient?.situation;
        const q = sit?.gps_fix_quality ?? 0;

        let statusLine;
        if (bridgeActive) {
            statusLine = 'Situation WS unavailable — position from engine monitor. Stratux reconnecting.';
        } else if (stale) {
            statusLine = 'Situation WS closed — engine GPS also unavailable';
        } else if (q === 0) {
            statusLine = 'Stratux connected — no GPS fix';
        } else {
            statusLine = 'GPS nominal';
        }

        const entries = DiagLog.entries
            .filter(e => e.cat === 'gps' || e.cat === 'stratux')
            .slice(-10)
            .reverse();
        const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const logHtml = entries.length
            ? entries.map(e =>
                `<div>${esc(e.t.slice(11, 19))} [${esc(e.cat)}] ${esc(e.msg)}</div>`
              ).join('')
            : '<div>No GPS log entries yet</div>';

        const cfgSrc = this.gpsSource?._configuredSource;
        const inFallback = this.gpsSource?._inFallback;
        let fixLabel, fixAction;
        if (cfgSrc === 'internal' && q >= 1) {
            fixLabel = 'USE STRATUX GPS';
            fixAction = () => this.gpsSource.setSource('stratux');
        } else if (cfgSrc === 'auto' && inFallback) {
            fixLabel = 'RESET GPS SOURCE';
            fixAction = () => this.gpsSource.setSource('auto');
        } else {
            fixLabel = 'GPS SETTINGS';
            fixAction = () => this.configEditor?.show();
        }

        panel.innerHTML = `
            <div class="gps-diag-status">${statusLine}</div>
            <div class="gps-diag-log">${logHtml}</div>
            <div class="gps-diag-actions">
                <button class="gps-diag-fix-btn" id="gpsDiagFixBtn">${fixLabel}</button>
                <button class="gps-diag-sec-btn" id="gpsDiagSettingsBtn">GPS SETTINGS</button>
            </div>
        `;

        document.getElementById('gpsDiagFixBtn')?.addEventListener('click', fixAction);
        document.getElementById('gpsDiagSettingsBtn')?.addEventListener('click', () => this.configEditor?.show());
    }

    // === Connectivity Monitor ==========

    _startConnectivityMonitor() {
        const el = this.dom.statusSync;
        if (!el) return;

        // On startup: detect if page was served from cache (transferSize=0 means no bytes from network)
        const navEntry = performance.getEntriesByType('navigation')[0];
        this._servedFromCache = navEntry ? navEntry.transferSize === 0 : false;
        this._updateVersionBadge();

        // FlyTab: use NetworkMode for connectivity detection instead of polling Pi
        let wasConnected = null;
        const check = async () => {
            // Check if we have any network via NetworkMode (already running)
            const mode = this.networkMode?.mode ?? 'offline';
            this._piConnected = (mode === 'flight' || mode === 'home');
            const hasNetwork = mode !== 'offline';

            if (wasConnected !== hasNetwork) {
                DiagLog.log('net', `Network mode: ${mode}`);
                wasConnected = hasNetwork;
                this._updateVersionBadge();
            }
            el.textContent = mode === 'flight' ? 'FLT' :
                             mode === 'home' ? 'HOME' :
                             mode === 'internet' ? 'NET' : 'OFFL';
            // Only show active (green) when Pi/Stratux is reachable — not for generic internet
            el.classList.toggle('active', mode === 'flight' || mode === 'home');
            el.classList.toggle('status-sync-internet', mode === 'internet');
        };

        // Instant check on online/offline events
        window.addEventListener('online', () => { DiagLog.log('net', 'Browser online event'); check(); });
        window.addEventListener('offline', () => {
            DiagLog.log('net', 'Browser offline event');
            this._piConnected = false;
            wasConnected = false;
            el.textContent = 'OFFL';
            el.classList.remove('active');
            this._updateVersionBadge();
        });

        check();
        this._connectivityInterval = setInterval(check, 10000);
    }

    _updateVersionBadge() {
        const el = document.getElementById('statusVersion');
        if (!el) return;
        if (this._piConnected) {
            el.textContent = FLYTAB_VERSION + ' LIVE';
            el.className = 'status-item status-version version-live';
        } else {
            el.textContent = FLYTAB_VERSION;
            el.className = 'status-item status-version';
        }
    }

    async _uploadDiagnostics() {
        // FlyTab: diagnostics stored locally only — no Pi upload
        // Phase 3 will add post-flight sync to home computer
        try {
            const entries = DiagLog.entries;
            if (!entries.length) return;
            // Store in localStorage for now
            try {
                localStorage.setItem('flytab_diag_latest', JSON.stringify({
                    uploaded_at: new Date().toISOString(),
                    app_version: FLYTAB_VERSION,
                    entries,
                }));
            } catch { /* storage full */ }
        } catch (err) {
            DiagLog.log('error', 'Diag save failed', err?.message);
        }
    }

    // === NASR Age Badge ==========

    async _updateNasrBadge() {
        const el = this.dom.statusNasr;
        if (!el || !this._nasrDb) return;

        try {
            const cycleInfo = await this._nasrDb.getCycleInfo();
            if (!cycleInfo || !cycleInfo.effective_date) {
                el.textContent = 'NASR ??';
                el.className = 'status-item status-nasr nasr-expired';
                return;
            }

            // Compute days until expiration (NASR cycles are 28 days)
            const effective = new Date(cycleInfo.effective_date);
            const expiration = cycleInfo.expiration_date
                ? new Date(cycleInfo.expiration_date)
                : new Date(effective.getTime() + 28 * 86400000);
            const now = new Date();
            const daysLeft = Math.ceil((expiration - now) / 86400000);

            let text, cls;
            if (daysLeft < 0) {
                text = 'NASR EXP';
                cls = 'nasr-expired';
            } else if (daysLeft <= 7) {
                text = `NASR ${daysLeft}d`;
                cls = 'nasr-aging';
            } else {
                text = `NASR ${daysLeft}d`;
                cls = 'nasr-fresh';
            }
            el.textContent = text;
            el.className = `status-item status-nasr ${cls}`;
        } catch {
            el.textContent = 'NASR ??';
            el.className = 'status-item status-nasr nasr-expired';
        }
    }

    // === Alerts ==========

    showAlert(message, severity = 'blue', duration = null) {
        const banner = document.createElement('div');
        banner.className = `alert-banner alert-${severity}`;
        banner.textContent = message;
        banner.addEventListener('click', () => banner.remove());
        document.body.appendChild(banner);

        if (duration || severity === 'blue') {
            setTimeout(() => banner.remove(), duration || 10000);
        }
    }

    /**
     * Load cached advisories immediately, then schedule 5-minute refresh.
     * _fetchAdvisories() is also called by _onModeChanged when coming back online.
     */
    _startAdvisoryRefresh() {
        if (typeof WeatherClient === 'undefined') return;
        this._advisoryClient = new WeatherClient(null);

        // Serve stale cache instantly (works offline)
        const cached = this._advisoryClient.loadCachedAdvisories();
        if (cached) {
            this.fisbWeather?.injectAdvisories(cached.sigmets, cached.airmets);
        }

        this._fetchAdvisories();
        setInterval(() => this._fetchAdvisories(), 5 * 60000);
    }

    /** Fetch fresh SIGMETs/AIRMETs from the internet and inject into the weather display. */
    async _fetchAdvisories() {
        if (!this.fisbWeather || !this._advisoryClient) return;
        try {
            const fresh = await this._advisoryClient.fetchAndCacheAdvisories();
            this.fisbWeather.injectAdvisories(fresh.sigmets, fresh.airmets);
        } catch (e) {
            console.warn(`[Advisory] Fetch failed: ${e.message}`);
        }
    }

    // === Fuel Stop Proximity ==========

    /** Check if the aircraft is within 10nm of any fuel stop waypoint. */
    _checkFuelStopProximity(situation) {
        if (!situation || !this._currentTrip?.waypoints) return;
        const lat = situation.lat;
        const lon = situation.lon;
        if (!lat || !lon) return;

        const wps = this._currentTrip.waypoints;
        for (let i = 1; i < wps.length - 1; i++) {
            const wp = wps[i];
            if (wp.type !== 'APT') continue;
            if (!wp.lat || !wp.lon) continue;
            const key = `${wp.icao || wp.name}_${i}`;
            if (this._shownFuelStopOverlays.has(key)) continue;
            const dist = NasrDB.haversineNm(lat, lon, wp.lat, wp.lon);
            if (dist <= 10) {
                this._shownFuelStopOverlays.add(key);
                this._showFuelStopOverlay(wp, i);
                break; // one overlay at a time
            }
        }
    }

    /**
     * Show the full-screen fuel stop overlay.
     * @param {object} wp        - The fuel stop waypoint (from this._currentTrip.waypoints)
     * @param {number} wpIndex   - Index of wp in the waypoints array
     */
    _showFuelStopOverlay(wp, wpIndex) {
        document.getElementById('fuelStopOverlay')?.remove();

        // Route table computes _flights and per-waypoint fuel data during updateLive().
        // _flightIndex on a fuel stop waypoint = index of the Flight departing from it.
        const flights    = this.routeTable?._flights || [];
        const nextFlight = flights[wp._flightIndex ?? 1];
        const prevFlight = nextFlight ? flights[nextFlight.index - 1] : null;

        const fuelCap  = CockpitConfig.aircraft('performance.fuel_capacity_gal') ?? 50;
        const fuelAtStop = (wp._fuelRem != null && wp._fuelRem > 0) ? wp._fuelRem : null;

        const icao    = wp.icao || wp.name || '?';
        const aptName = (wp.name && wp.name !== icao) ? wp.name : null;

        const hasPreset = wp.fuel_add_gal != null;
        const presetGal = hasPreset ? (wp._fuelAdded ?? wp.fuel_add_gal) : null;

        const fmtEte = (min) => {
            if (min == null) return '\u2014';
            const h = Math.floor(min / 60);
            const m = Math.round(min % 60);
            return h > 0 ? `${h}h\u2009${m}m` : `${m}m`;
        };
        const fmtDist = (nm) => (nm != null ? `${nm}` : '\u2014');

        const nextDest  = nextFlight?.dest  ?? '\u2014';
        const nextDistS = fmtDist(nextFlight?._totDist);
        const nextEteS  = fmtEte(nextFlight?._totEte);
        const nextFuelS = nextFlight?._totFuel != null ? nextFlight._totFuel.toFixed(1) : '\u2014';
        const nextNum   = nextFlight ? nextFlight.index + 1 : 2;

        const fillToGal = (fuelAtStop != null && hasPreset)
            ? (fuelAtStop + presetGal).toFixed(1)
            : fuelCap.toFixed(1);

        const cellStyle = 'text-align:center;';
        const valStyle  = 'font-size:22px;font-weight:700;color:var(--instrument-value);';
        const lblStyle  = 'font-size:11px;color:var(--text-label);margin-top:2px;';

        const flightCard = (f, label) => `
            <div style="background:var(--bg-surface);border-radius:8px;padding:12px;margin-bottom:12px;">
                <div style="font-size:12px;color:var(--text-label);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">${label}</div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
                    <div style="${cellStyle}"><div style="${valStyle}">${fmtDist(f._totDist)}</div><div style="${lblStyle}">nm</div></div>
                    <div style="${cellStyle}"><div style="${valStyle}">${fmtEte(f._totEte)}</div><div style="${lblStyle}">ETE</div></div>
                    <div style="${cellStyle}"><div style="${valStyle}">${f._totFuel.toFixed(1)}</div><div style="${lblStyle}">gal est</div></div>
                </div>
            </div>`;

        const overlay = document.createElement('div');
        overlay.id = 'fuelStopOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9998;background:var(--bg-primary);display:flex;flex-direction:column;overflow-y:auto;';

        overlay.innerHTML = `
            <div style="padding:16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;background:var(--bg-surface);flex-shrink:0;">
                <span style="font-size:28px;">\u26fd</span>
                <div>
                    <div style="font-size:20px;font-weight:700;color:var(--text-primary);">Fuel Stop \u2014 ${icao}</div>
                    ${aptName ? `<div style="font-size:14px;color:var(--text-secondary);">${aptName}</div>` : ''}
                </div>
            </div>
            <div style="padding:16px;flex:1;">
                ${prevFlight ? flightCard(prevFlight, `Flight ${prevFlight.index + 1} \u2014 ${prevFlight.dep} \u2192 ${prevFlight.dest}`) : ''}
                <div style="background:var(--bg-surface);border-radius:8px;padding:12px;margin-bottom:12px;">
                    <div style="font-size:12px;color:var(--text-label);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Fuel</div>
                    ${hasPreset
                        ? `<div style="font-size:16px;color:var(--text-primary);">Add <strong>${presetGal.toFixed(1)}\u2009gal</strong> \u2014 fill to <strong>${fillToGal}\u2009gal</strong></div>`
                        : `<div style="display:flex;align-items:center;gap:8px;">
                               <label for="fso-fuel-input" style="font-size:14px;color:var(--text-secondary);">Gallons added:</label>
                               <input id="fso-fuel-input" type="number" min="0" max="${fuelCap}" step="0.5"
                                   style="width:80px;padding:6px 8px;background:var(--bg-surface-raised);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;font-size:16px;text-align:right;">
                           </div>`
                    }
                </div>
                ${nextFlight ? flightCard(nextFlight, `Flight ${nextNum} \u2014 ${icao} \u2192 ${nextDest}`) : ''}
                <button id="fso-continue-btn"
                    style="width:100%;padding:16px;background:var(--accent);color:var(--text-on-dark);border:none;border-radius:8px;font-size:18px;font-weight:700;cursor:pointer;margin-top:4px;">
                    Start Flight ${nextNum} \u2014 Continue to ${nextDest}
                </button>
            </div>
        `;

        document.body.appendChild(overlay);

        overlay.querySelector('#fso-continue-btn').addEventListener('click', () => {
            let gallonsAdded = 0;
            if (hasPreset) {
                gallonsAdded = presetGal;
            } else {
                const input = overlay.querySelector('#fso-fuel-input');
                gallonsAdded = parseFloat(input?.value) || 0;
            }

            if (typeof FuelState !== 'undefined') {
                const currentFuel = (fuelAtStop != null && fuelAtStop > 0)
                    ? fuelAtStop
                    : FuelState.getStartFuel().gallons;
                const newTotal = Math.min(currentFuel + gallonsAdded, fuelCap);
                FuelState.saveMeasurement({ total_gal: newTotal, source: 'tic' });
                window.dispatchEvent(new CustomEvent('fuelstate:changed'));
            }

            overlay.remove();
            this.showToast(`Flight ${nextNum} active \u2014 ${nextDest} ${nextDistS}nm`);
        });
    }

    // === Toast Notifications ==========

    async _checkDataReadiness() {
        const LOCAL = 'http://localhost:9090';
        const issues = [];

        const fetchJson = async (url) => {
            try {
                const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
                return r.ok ? r.json() : null;
            } catch { return null; }
        };

        const [nasr, cifp] = await Promise.all([
            fetchJson(`${LOCAL}/nasr/cycle_info.json`),
            fetchJson(`${LOCAL}/cifp/cifp_cycle_info.json`),
        ]);

        if (!nasr) {
            issues.push({ severity: 'critical', text: 'NASR aeronautical data not on tablet' });
        } else {
            const exp = nasr.expiration_date ? new Date(nasr.expiration_date)
                : new Date(new Date(nasr.effective_date).getTime() + 28 * 86400000);
            const daysLeft = Math.ceil((exp - Date.now()) / 86400000);
            if (daysLeft < 0) {
                issues.push({ severity: 'critical', text: `NASR data expired ${Math.abs(daysLeft)}d ago (cycle ${nasr.effective_date})` });
            } else if (daysLeft <= 7) {
                issues.push({ severity: 'warn', text: `NASR data expires in ${daysLeft}d (cycle ${nasr.effective_date})` });
            }
        }

        if (!cifp) {
            issues.push({ severity: 'warn', text: 'CIFP approach procedures not on tablet' });
        }

        if (issues.length === 0) return;

        const hasCritical = issues.some(i => i.severity === 'critical');
        const banner = document.createElement('div');
        banner.id = 'dataReadinessBanner';
        banner.style.cssText = `
            background:${hasCritical ? '#b91c1c' : '#92400e'};
            color:#fff; font-size:13px; font-weight:600;
            padding:6px 12px; display:flex; align-items:center; gap:8px;
            width:100%; box-sizing:border-box;
        `;
        banner.innerHTML = `
            <span style="flex:1">⚠ ${issues.map(i => i.text).join(' · ')}</span>
            <button style="background:rgba(255,255,255,0.2);border:none;color:#fff;padding:4px 10px;border-radius:4px;font-weight:700;font-size:13px;cursor:pointer;touch-action:manipulation" id="_drFixBtn">Fix Now</button>
            <button style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:0 4px;touch-action:manipulation" id="_drDismissBtn">✕</button>
        `;

        // Insert into the flex column after the engine advisory (below status bar, above map)
        const advisory = document.getElementById('engineAdvisory');
        const mainContent = document.getElementById('mainContent');
        if (advisory) {
            advisory.parentNode.insertBefore(banner, advisory.nextSibling);
        } else if (mainContent) {
            mainContent.parentNode.insertBefore(banner, mainContent);
        } else {
            document.body.appendChild(banner);
        }

        banner.querySelector('#_drFixBtn').addEventListener('click', () => {
            banner.remove();
            if (this.dataStatus) this.dataStatus.show();
        });
        banner.querySelector('#_drDismissBtn').addEventListener('click', () => banner.remove());
    }

    showToast(message, actions = []) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `
            <span>${message}</span>
            <div class="toast-actions">
                ${actions.map((a, i) => `<button class="toast-btn btn-primary" data-action="${i}">${a.label}</button>`).join('')}
                <button class="toast-btn" data-action="dismiss">✕</button>
            </div>
        `;

        actions.forEach((action, i) => {
            const btn = toast.querySelector(`[data-action="${i}"]`);
            if (btn) btn.addEventListener('click', () => {
                action.action();
                toast.remove();
            });
        });
        toast.querySelector('[data-action="dismiss"]').addEventListener('click', () => toast.remove());

        document.body.appendChild(toast);
        return toast;
    }
}

// === Initialize on DOM ready ==========

const app = new FlyTabApp();
window.app = app;
window.DiagLog = DiagLog;
document.addEventListener('DOMContentLoaded', () => {
    app.init().catch(err => {
        console.error('[FlyTab] Init failed:', err);
        DiagLog.log('error', 'Init failed', err?.message || String(err));
        const view = document.getElementById('cockpitView');
        if (view) {
            view.style.display = 'flex';
            view.style.alignItems = 'center';
            view.style.justifyContent = 'center';
            view.style.flexDirection = 'column';
            view.style.padding = '40px 24px';
            view.style.color = 'var(--status-danger)';
            view.innerHTML = `
                <div style="font-size:22px;font-weight:700;margin-bottom:12px;">FlyTab — Init Error</div>
                <div style="font-size:14px;color:var(--text-secondary);max-width:320px;text-align:center;margin-bottom:20px;">${err?.message || String(err)}</div>
                <div style="font-size:13px;color:var(--text-muted);max-width:320px;text-align:center;margin-bottom:24px;">Diagnostic log available in console: <code>DiagLog.entries</code></div>
                <button onclick="location.reload()" style="padding:12px 28px;background:var(--bg-surface);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;font-size:16px;cursor:pointer;">Reload</button>`;
        }
    });
});
