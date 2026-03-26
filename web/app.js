/**
 * FlyTab — Application Orchestrator v1
 * Android Capacitor cockpit app. All data local. Pi for live telemetry only.
 */

const FLYTAB_VERSION = 'v4.21';

// ========== Diagnostic Logger (ring buffer in localStorage) ==========
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
        this.cockpitMap = null;
        this.enginePanel = null;
        this.trackLog = null;
        this.deviceStatus = null;
        this.rangeCalc = null;
        this.routeEditor = null;

        // Cockpit redesign components
        this.vectorLayers = null;
        this.airportPopup = null;
        this.routeTable = null;
        this.engineOverlay = null;
        this.enginePage = null;
        this.flightSync = null;
        this.logbook = null;
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

        this.thermalMonitor = null;
        this.engineML = null;
        this._cockpitInitialized = false;
        this._currentPlan = null;
        this._applyingPlan = false;   // re-entrancy guard for applyRouteEdit
        this._pendingPlanEdit = null; // latest-wins queuing for rapid calls

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

        this._clockInterval = null;
        this._recorderInterval = null;
        this._piConnected = false;
    }

    async init() {
        // Load cockpit config
        if (typeof CockpitConfig !== 'undefined') {
            await CockpitConfig.load();
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

        // Update NASR age badge after data is loaded
        this._updateNasrBadge();

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
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:var(--bg-primary);display:flex;flex-direction:column;';

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
        const src = this.gpsSource?.source || '?';
        const stxConnected = this.stratuxClient?._connected ? 'YES' : 'NO';
        const fixQ = sit?.gps_fix_quality ?? 'null';
        const lat = sit?.lat?.toFixed(4) ?? 'null';
        const lon = sit?.lon?.toFixed(4) ?? 'null';
        const sats = sit?.gps_sats ?? 'null';
        const acc = sit?._accuracy != null ? `${Math.round(sit._accuracy)}m` : 'n/a';
        summary.innerHTML = [
            `<b>GPS Source:</b> ${src} | <b>Stratux connected:</b> ${stxConnected} | <b>Stratux IP:</b> ${this.stratuxClient?.ip || '?'}`,
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
                const data = e.d ? ` <span style="color:var(--text-muted)">${e.d}</span>` : '';
                return `<div style="margin:2px 0;line-height:1.5"><span style="color:var(--text-muted)">${time}</span> <span style="color:${color};font-weight:600">[${e.cat}]</span> ${e.msg}${data}</div>`;
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
    }

    // ========== Cockpit Init ==========

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
                const wps = this._currentPlan?.waypoints;
                if (!wps?.length) return {};
                return { departure: wps[0], destination: wps[wps.length - 1] };
            });

            if (this.vectorLayers) {
                this.airportPopup.setVectorLayers(this.vectorLayers);
                this.vectorLayers._onInternetMetarsFetched = () => this._updateWeatherAge(this._currentPlan);
                this.vectorLayers.onAirportClick((apt) => {
                    if (this.routeTable?.isEditing()) {
                        this.routeTable.addWaypointSmart({
                            icao: apt.icao, name: apt.name || apt.icao,
                            lat: apt.lat, lon: apt.lon,
                        });
                    } else {
                        this.airportPopup.show(apt);
                    }
                });

                this.vectorLayers.onNavaidClick((nav) => {
                    if (this.routeTable?.isEditing()) {
                        this.routeTable.addWaypointSmart({
                            icao: nav.id, name: nav.name || nav.id,
                            lat: nav.lat, lon: nav.lon,
                        });
                    } else {
                        this.airportPopup.showNavaid(nav);
                    }
                });

                this.vectorLayers.onFixClick((fix) => {
                    if (this.routeTable?.isEditing()) {
                        this.routeTable.addWaypointSmart({
                            icao: fix.id, name: fix.id,
                            lat: fix.lat, lon: fix.lon,
                        });
                    }
                });

                // Traffic tap fallback — when no aviation marker is hit
                this.vectorLayers._onTrafficTap = (containerPt) => {
                    this.cockpitMap._onTrafficTap(containerPt);
                };
            }
        }

        // Engine client (WebSocket to Pi engine monitor)
        this.engineClient = new EngineClient();
        this.engineClient.connect();

        // Engine panel (receives data via WebSocket push)
        this.enginePanel = new EnginePanel(document.createElement('div'), this.engineClient);
        this.enginePanel.init();
        window.enginePanel = this.enginePanel;

        // Engine ML (anomaly detection + advisories)
        if (typeof EngineMLBridge !== 'undefined') {
            this.engineML = new EngineMLBridge();
            this.engineML.init().then(() => {
                this.engineML.setDisplayElements(
                    document.getElementById('statusML')
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
        }

        // PlanSync — fetches flight plans from flywhere.app
        if (typeof PlanSync !== 'undefined') {
            this.planSync = new PlanSync();
        }

        // Fuel overlay (tic mark entry + EDM comparison + priority chain)
        if (typeof FuelOverlay !== 'undefined') {
            this.fuelOverlay = new FuelOverlay(document.body);
            this.cockpitMap.setFuelOverlay(this.fuelOverlay);
            window.addEventListener('fuelstate:changed', () => {
                if (this.routeTable) this.routeTable.refresh();
            });
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

        // FIS-B NEXRAD renderer (canvas overlay on map)
        if (typeof FisbNexrad !== 'undefined' && this.fisbClient) {
            this.fisbNexrad = new FisbNexrad(this.fisbClient);
            this.cockpitMap.setFisbNexrad(this.fisbNexrad);
        }

        // Radar loop (animated NEXRAD — uses FIS-B frames)
        if (typeof RadarLoop !== 'undefined') {
            this.radarLoop = new RadarLoop();
            if (this.fisbNexrad) {
                this.radarLoop.setNexrad(this.fisbNexrad);
            }
            this.cockpitMap.setRadarLoop(this.radarLoop);
        }

        // FIS-B weather display (PIREPs, SIGMETs, weather strip)
        if (typeof FisbWeatherDisplay !== 'undefined' && this.fisbClient) {
            this.fisbWeather = new FisbWeatherDisplay(this.fisbClient, this.cockpitMap.map);
            this.fisbWeather.init();
            this.cockpitMap.setFisbWeather(this.fisbWeather);
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
                const { insertBefore = [], insertAfter = [], airportWp } = e.detail;
                if (!this.routeEditor) return;

                // Empty route: seed the airport as destination first
                if (this.routeEditor._waypoints.length === 0 && airportWp) {
                    this.routeEditor._addWaypoint(airportWp, 0);
                }

                // Insert IAF, FAF, RW before the destination (last waypoint)
                if (insertBefore.length) {
                    const destIdx = Math.max(this.routeEditor._waypoints.length - 1, 0);
                    for (let i = 0; i < insertBefore.length; i++) {
                        this.routeEditor._addWaypoint(insertBefore[i], destIdx + i);
                    }
                }

                // Append MAP after destination
                for (const wp of insertAfter) {
                    this.routeEditor._addWaypoint(wp, this.routeEditor._waypoints.length);
                }

                this.routeEditor._applyRoute();
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
            this.wxBriefing = new WxBriefing(nasrDb);
            this.wxBriefing.init();
        }

        // Track log
        this.trackLog = new TrackLog(this.stratuxClient, this.cockpitMap);
        this.trackLog.init();

        // Route editor (NasrDB lazy-opens on first query)
        this.routeEditor = new RouteEditor(
            document.body, nasrDb, this.stratuxClient, this.cockpitMap
        );
        this.routeEditor.init();

        // Wire route table EDIT button to route editor
        if (this.routeTable) {
            this.routeTable.setRouteEditor(this.routeEditor);
        }

        // Wire airport popup Direct-To to route editor
        if (this.airportPopup && this.routeEditor) {
            this.airportPopup.onDirectTo((apt) => {
                this.routeEditor._executeDirectTo(apt);
            });
        }

        // Device status (headless — only shown on demand)
        this.deviceStatus = new DeviceStatus(
            document.createElement('div'), this.stratuxClient, this.enginePanel
        );
        this.deviceStatus.init();

        // Range calculator
        this.rangeCalc = new RangeCalc(this.stratuxClient, this.enginePanel, this.cockpitMap);
        this.rangeCalc.init();

        // ── v5 UI: Instrument Strip ──────────────────────────────────────────
        if (typeof InstrumentStrip !== 'undefined') {
            this.instrumentStrip = new InstrumentStrip(this.stratuxClient, this.engineClient);
            if (this.fuelOverlay) this.instrumentStrip.setFuelOverlay(this.fuelOverlay);
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
                configEditor: this.configEditor,
                ifrClearance: this.ifrClearance,
                wxBriefing: this.wxBriefing,
                trackLog: this.trackLog,
                airportPopup: this.airportPopup,
                stratuxIp: Settings.stratuxIp || '192.168.10.1',
                planSync: this.planSync,
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

    /** Build left rail icon buttons */
    _buildLeftRail() {
        const rail = document.getElementById('leftRail');
        if (!rail) return;

        // Helper: create a rail button with _fastTap
        const makeBtn = (icon, title, handler, activeDefault = false) => {
            const btn = document.createElement('button');
            btn.className = 'left-rail-btn' + (activeDefault ? ' active' : '');
            btn.title = title;
            btn.innerHTML = icon;
            let touchFired = false;
            btn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                e.stopPropagation();
                touchFired = true;
                handler(btn, e);
            }, { passive: false });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (touchFired) { touchFired = false; return; }
                handler(btn, e);
            });
            return btn;
        };

        const sep = () => {
            const s = document.createElement('div');
            s.className = 'left-rail-sep';
            return s;
        };

        // ≡ Layers
        rail.appendChild(makeBtn('&#x2630;', 'Layer panel', () => {
            if (this.layerPanel) this.layerPanel.toggle();
        }));

        rail.appendChild(sep());

        // 🔍 Zoom in / out — use map zoom buttons
        rail.appendChild(makeBtn('+', 'Zoom in', () => {
            if (this.cockpitMap?.map) this.cockpitMap.map.zoomIn();
        }));
        rail.appendChild(makeBtn('−', 'Zoom out', () => {
            if (this.cockpitMap?.map) this.cockpitMap.map.zoomOut();
        }));

        rail.appendChild(sep());

        // Route table toggle
        rail.appendChild(makeBtn('&#x2261;', 'Route table', () => {
            if (this.routeTable) this.routeTable.toggle();
        }));

        // Spacer to push version to bottom
        const spacer = document.createElement('div');
        spacer.className = 'left-rail-spacer';
        rail.appendChild(spacer);

        // Version label
        const ver = document.createElement('div');
        ver.className = 'left-rail-version';
        ver.textContent = FLYTAB_VERSION;
        rail.appendChild(ver);
    }

    async _ensureNasrData(nasrDb) {
        // Compare NanoHTTPD cycle_info against IndexedDB — re-import if cycle changed
        try {
            const [localFile, dbCycle, testApt] = await Promise.all([
                fetch('http://localhost:9090/nasr/cycle_info.json', { signal: AbortSignal.timeout(2000) })
                    .then(r => r.ok ? r.json() : null).catch(() => null),
                nasrDb.getCycleInfo().catch(() => null),
                nasrDb.getAirport('KJFK').catch(() => null),
            ]);
            const fileDate    = localFile?.effective_date;
            const dbDate      = dbCycle?.effective_date;
            const fileSuaCnt  = localFile?.sua_count ?? null;
            const dbSuaCnt    = dbCycle?.sua_count    ?? null;
            const dateMatch   = fileDate && fileDate === dbDate;
            // suaMatch: if file advertises sua_count, DB must have same value
            const suaMatch    = fileSuaCnt === null || (dbSuaCnt !== null && fileSuaCnt === dbSuaCnt);
            if (testApt && dateMatch && suaMatch) return; // DB is current
            if (testApt && !fileDate) return; // NanoHTTPD not ready; DB exists, keep it
        } catch { /* fall through to import */ }

        DiagLog.log('nasr', 'NASR DB empty or stale — importing from NanoHTTPD');
        console.log('[FlyTab] NASR DB empty or stale — trying to import...');

        try {
            // FlyTab: try local NanoHTTPD first (pre-downloaded), then home server
            let bundle;
            try {
                const localResp = await fetch('http://localhost:9090/nasr/bundle.json', {
                    signal: AbortSignal.timeout(15000),
                });
                if (localResp.ok) bundle = await localResp.json();
            } catch { /* local not available */ }
            if (!bundle) {
                // Fall back to home server — try primary, then Tailscale fallback
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

    // ========== Route Bbox (for Cache Tiles) ==========

    /** Returns bounding box for the current route + ~1° buffer, or null if no plan loaded. */
    _getRouteBbox() {
        const wps = this._currentPlan?.waypoints;
        if (!wps?.length) return null;
        const lats = wps.map(w => w.lat).filter(v => v != null);
        const lons = wps.map(w => w.lon).filter(v => v != null);
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

    // ========== Plan Loading ==========

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
                try { localStorage.setItem('flypi_active_plan', JSON.stringify(p)); } catch {}
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
            // Map leg performance data onto waypoints (leg[i] → wp[i+1])
            if (fp.legs?.length && wps.length > 0) {
                for (let i = 0; i < fp.legs.length; i++) {
                    const leg = fp.legs[i];
                    const wp = wps[i + 1];
                    if (!wp) continue;
                    wp.alt = leg.altitude || fp.altitude;
                    wp.gs = leg.gs;
                    wp.tas = leg.tas;
                    wp.gph = leg.gph;
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
                        wp.lat = wp.lat ?? apt.lat;
                        wp.lon = wp.lon ?? apt.lon;
                        wp.elev_ft = wp.elev_ft ?? apt.elev_ft ?? null;
                        wp.name = wp.name || apt.name;
                        wp.type = 'APT'; // authoritative — NASR confirmed this is an airport
                    } else if (wp.lat == null || wp.lon == null) {
                        // Coords missing — try navaid then fix
                        let found = await nasr.getNavaid(wp.icao);
                        if (!found) found = await nasr.getFix(wp.icao);
                        if (found) {
                            wp.lat = wp.lat ?? found.lat;
                            wp.lon = wp.lon ?? found.lon;
                            wp.elev_ft = wp.elev_ft ?? found.elev_ft ?? null;
                            wp.name = wp.name || found.name;
                        } else {
                            console.warn(`_applyPlan: could not resolve waypoint "${wp.icao}"`);
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
        wps = wps.filter(w => w.lat != null && w.lon != null);

        const normalized = { ...plan, waypoints: wps };
        this._currentPlan = normalized;

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
        if (this.routeEditor) this.routeEditor.loadRoute(normalized);

        if (this.approachCharts) {
            const icaoList = wps.map(wp => wp.icao).filter(Boolean);
            this.approachCharts.setRouteAirports(icaoList);
        }

        // Update FIS-B weather strip with route airports
        if (this.fisbWeather) {
            const icaoList = wps.map(wp => wp.icao).filter(Boolean);
            this.fisbWeather.setRouteAirports(icaoList);
        }


        if (this.ifrClearance) {
            this.ifrClearance._flightPlan = normalized;
        }

        if (this.wxBriefing) {
            this.wxBriefing.setFlightPlan(normalized);
        }

        this._updateWeatherAge(plan);

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

    // ========== Wake Lock ==========

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

    // ========== Thermal Monitor ==========

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

    // ========== Clock ==========

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

    // ========== Aircraft Config Sync ==========

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

    // ========== GPS & FIS-B Status ==========

    _startDeviceStatusMonitor() {
        const update = () => {
            const connected = this.stratuxClient?.connected;
            const stale = this.stratuxClient?.stale;
            // Only use situation/deviceStatus when Stratux is live — never show
            // stale last-session values as if they were current data.
            const sit = (connected && !stale) ? this.stratuxClient?.situation : null;
            const status = connected ? this.stratuxClient?.deviceStatus : null;

            // GPS: green if fix (quality >= 1), show solution type + source
            if (this.dom.statusGps) {
                const src = this.gpsSource?.source === 'internal' ? 'INT' : 'STX';
                const q = sit?.gps_fix_quality ?? 0;
                const gpsOk = q >= 1;
                this.dom.statusGps.classList.toggle('active', gpsOk);
                if (gpsOk) {
                    const sats = sit.gps_sats != null ? `${sit.gps_sats}sv` : '';
                    const sol = GPS_SOLUTION_LABELS[q] || 'FIX';
                    const acc = sit._accuracy != null ? `±${Math.round(sit._accuracy)}m` : '';
                    this.dom.statusGps.textContent = `${src} ${sol} ${sats || acc}`.trim();
                } else {
                    this.dom.statusGps.textContent = `${src} GPS`;
                }
            }

            // FIS-B: green when UAT radio is connected OR when messages are actively flowing.
            // UAT_connected is a hardware-presence flag and may be false on some Stratux
            // firmware versions even when towers are in range and data is being received.
            // Fall back to message count as the authoritative signal.
            // Guard: only show counts when Stratux is connected — never bleed prior session data.
            if (this.dom.statusFisb) {
                const uatConnected = !!(status?.UAT_connected || status?.UATRadio_connected);
                const receiving = (status?.UAT_messages_last_minute > 0) || (status?.UAT_messages_max > 0);
                this.dom.statusFisb.classList.toggle('active', uatConnected || receiving);
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

    // ========== Connectivity Monitor ==========

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

    // ========== NASR Age Badge ==========

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

    // ========== Alerts ==========

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

    // ========== Toast Notifications ==========

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

// ========== Initialize on DOM ready ==========

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
