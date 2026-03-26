/**
 * FlyPi — Cockpit Config Loader
 * Fetches cockpit-config.json and aircraft-config.json once,
 * provides dot-path access with hardcoded defaults.
 */

class CockpitConfig {
    static _config = null;
    static _aircraft = null;
    static _loaded = false;

    static DEFAULTS = {
        // Simulation mode — set in cockpit-config.json to use X-Plane bridge
        simMode:      false,
        simBridgeIp:  '127.0.0.1',
        simBridgePort: 5678,

        map: {
            defaultBaseLayer: 'vector',
            defaultCenter: [35.0, -80.0],
            defaultZoom: 8,
            overlays: {
                airspace: { enabled: true, minZoom: 6 },
                airports: { enabled: true, minZoom: 7, labelsMinZoom: 8 },
                navaids: { enabled: true, minZoom: 7, labelsMinZoom: 9 },
                fixes: { enabled: false, minZoom: 10 },
                airways: { enabled: false, minZoom: 8 },
            },
        },
        // Airport display filter — persisted per-device, user-adjustable via layer panel
        airportFilter: {
            showHeliports:     false,
            showSeaplaneBases: false,
            showUltralight:    false,
            showGliderports:   false,
            minRunwayFt:       2500,   // default: hide short grass strips
            pavedOnly:         false,
        },
        routeTable: {
            defaultHeight: '30vh',
            columns: [
                { key: 'wpt', label: 'WPT', width: 'auto' },
                { key: 'alt', label: 'ALT', width: '55px' },
                { key: 'hdg', label: 'HDG', width: '50px' },
                { key: 'dist', label: 'DIST', width: '50px' },
                { key: 'gs', label: 'GS', width: '45px' },
                { key: 'ete', label: 'ETE', width: '55px' },
                { key: 'fuel_rem', label: 'FUEL', width: '55px' },
            ],
        },
        engineOverlay: {
            enabled: true,
            position: 'top-right',
            fields: [
                { key: 'carb_temp', label: 'CARB', unit: '°F', warnBelow: 40, dangerBelow: 32 },
            ],
        },
        enginePage: {
            trendChartMinutes: 30,
            fuelCautionGal: 8,
            fuelWarningGal: 4,
            stickyValveThresholdPct: 50,
            stickyValveWindowMinutes: 10,
            egtChartEnabled: true,
            showBsfc: true,
            showPeakDelta: true,
        },
        flightRecording: {
            autoRecord: true,
            rpmStartThreshold: 500,
            rpmStopThreshold: 100,
            stopDelaySeconds: 60,
            maxFlightsIdb: 5,
            autoSyncWhenOnline: true,
        },
        logbook: {
            autoCreate: true,
            defaultConditions: 'VFR',
            trackHobbs: true,
            hobbsSource: 'engine_hours',
        },
        radar: {
            loopDurationHours: 2,
            frameIntervalMinutes: 10,
            playbackSpeedMs: 500,
            opacity: 0.5,
            autoLoop: true,
            cacheHours: 3,
        },
        approachCharts: {
            georefEnabled: true,
            ownshipIconSize: 24,
            autoRotateTrackUp: false,
            preloadRoutePlates: true,
        },
        takeoffAlerts: {
            showDmms: true,
            dmmsDisplayUntilAglFt: 1000,
            dmmsFlashWhenBelow: true,
            lowAltitudeMessages: [],
        },
        ifr: {
            showCdPhone: true,
            defaultCdPhone: '1-888-766-8267',
            showCraft: true,
            cdPhones: {},
        },
        fisb: {
            enableWeather: true,
            enableNexrad: true,
            nexradOpacity: 0.5,
            showPireps: true,
            showSigmets: true,
            showAirmets: true,
            showWeatherStrip: true,
            alertSoundEnabled: false,
            pirepMaxAgeMin: 60,
            nexradMaxAgeMin: 15,
            metarMaxAgeMin: 90,
            sigmetAlertRadiusNm: 50,
        },
        airspaceStyles: {
            B: { color: '#0088ff', weight: 2, fillOpacity: 0.08 },
            C: { color: '#ff44ff', weight: 1.5, fillOpacity: 0.06 },
            D: { color: '#0088ff', weight: 1, dashArray: '6,4', fillOpacity: 0.04 },
            E: { color: '#ff44ff', weight: 1, dashArray: '4,4', fillOpacity: 0.02 },
        },
        geoStyles: {
            stateBoundaries: { color: '#334466', weight: 1, opacity: 0.5 },
            coastlines: { color: '#446688', weight: 1.5 },
            water: { fillColor: '#1a2a44', fillOpacity: 0.6 },
        },
    };

    static AIRCRAFT_DEFAULTS = {
        id: 'unknown',
        tail: 'N00000',
        type: 'Unknown',
        performance: {
            cruise_speed_kt: 120,
            cruise_gph: 9.0,
            climb_speed_kt: 85,
            climb_fpm: 600,
            descent_speed_kt: 110,
            descent_fpm: 500,
            pattern_speed_kt: 90,
            approach_speed_kt: 75,
            vso_kt: 55,
            vs1_kt: 55,
            dmms_factor: 1.404,
            fuel_capacity_gal: 50,
            min_runway_ft: 2500,
        },
    };

    /**
     * Load both config files. Call once at app init.
     * Falls back to defaults if fetch fails (offline, missing file, etc.)
     */
    static async load() {
        if (CockpitConfig._loaded) return;

        const [config, aircraft] = await Promise.all([
            CockpitConfig._fetchJson('cockpit-config.json'),
            CockpitConfig._fetchJson('aircraft-config.json'),
        ]);

        CockpitConfig._config = config || {};
        CockpitConfig._aircraft = aircraft || {};
        CockpitConfig._loaded = true;
    }

    /**
     * Reload aircraft config from API (after plan sync updates it).
     */
    static async loadAircraft() {
        // Try local aircraft-config.json first (bundled with app), fall back to server
        const local = await CockpitConfig._fetchJson('aircraft-config.json');
        if (local) { CockpitConfig._aircraft = local; return; }
        // No Pi fallback in FlyTab — aircraft config is bundled locally
        console.warn('CockpitConfig: aircraft-config.json not found locally');
        CockpitConfig._aircraft = {};
    }

    static async _fetchJson(url) {
        const cacheKey = 'flypi_cfg_' + url.replace(/[^a-z0-9]/gi, '_');
        try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            // Cache to localStorage for offline fallback
            try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch {}
            return data;
        } catch {
            // Try localStorage before returning null
            try {
                const cached = localStorage.getItem(cacheKey);
                if (cached) return JSON.parse(cached);
            } catch {}
            return null;
        }
    }

    /**
     * Dot-path access into cockpit config with defaults fallback.
     * e.g. CockpitConfig.get('map.overlays.airspace.minZoom') → 6
     */
    static get(path) {
        return CockpitConfig._resolve(path, CockpitConfig._config, CockpitConfig.DEFAULTS);
    }

    /**
     * Dot-path access into aircraft config with defaults fallback.
     * e.g. CockpitConfig.aircraft('performance.vs1_kt') → 55
     */
    static aircraft(path) {
        return CockpitConfig._resolve(path, CockpitConfig._aircraft, CockpitConfig.AIRCRAFT_DEFAULTS);
    }

    /**
     * Computed DMMS speed from aircraft config.
     */
    static get dmmsKt() {
        const vs1 = CockpitConfig.aircraft('performance.vs1_kt');
        const factor = CockpitConfig.aircraft('performance.dmms_factor');
        return Math.round(vs1 * factor);
    }

    /**
     * Patch a dot-path in the live config and persist to localStorage.
     * Used for in-app edits that should survive a reload without re-editing the JSON.
     * e.g. CockpitConfig.patch('navStrip.fields', ['next','dest','gs'])
     */
    static patch(path, value) {
        if (!CockpitConfig._config) CockpitConfig._config = {};
        const keys = path.split('.');
        let obj = CockpitConfig._config;
        for (let i = 0; i < keys.length - 1; i++) {
            if (obj[keys[i]] == null || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
            obj = obj[keys[i]];
        }
        obj[keys[keys.length - 1]] = value;
        try {
            localStorage.setItem('flypi_cfg_cockpit_config_json', JSON.stringify(CockpitConfig._config));
        } catch { /* quota */ }
    }

    /**
     * Get the full cockpit config object (for iteration).
     */
    static get raw() {
        return CockpitConfig._config || {};
    }

    /**
     * Get the full aircraft config object.
     */
    static get aircraftRaw() {
        return CockpitConfig._aircraft || {};
    }

    // ========== Internal ==========

    static _resolve(path, obj, defaults) {
        const keys = path.split('.');
        let val = obj;
        let def = defaults;

        for (const key of keys) {
            if (val != null && typeof val === 'object' && key in val) {
                val = val[key];
            } else {
                val = undefined;
            }
            if (def != null && typeof def === 'object' && key in def) {
                def = def[key];
            } else {
                def = undefined;
            }
        }

        return val !== undefined ? val : def;
    }
}
