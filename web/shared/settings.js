/**
 * FlyTab — Settings Manager
 * Persistent settings via localStorage with defaults.
 */

class Settings {
    static DEFAULTS = {
        stratux_ip: '192.168.10.1',
        pi_ip: '192.168.10.1',
        worker_base: 'https://www.flywhere.app/api',
        night_mode: false,
        units: 'imperial',
        ownship_mode_s: 'A177E1',
        auto_pan: true,
        show_range_rings: true,
        show_track_log: true,
        radar_opacity: 0.5,
        show_navaids: false,
        show_fixes: false,
        show_airports: true,
        show_airways: false,
        fuel_measurement: null,
        fuel_manual_override: false,
        gps_source: 'auto',  // 'auto' (Stratux primary, device GPS fallback) | 'stratux' | 'internal'
        flytab_api_key: 'flytab2025',
    };

    // 'flypi' is a legacy prefix from the deprecated FlyPi/iPad predecessor
    // product (see CLAUDE.md) — NOT evidence of a current iPad or FlyPi system.
    // This single line produces ~18 real, currently-used localStorage keys
    // (Stratux/Pi IP, API key, every toggle in DEFAULTS above). Changing it
    // would silently revert every existing installed tablet's settings to
    // factory defaults on next launch — do not change without a migration
    // that copies old keys forward first. vector-map-layers.js also hardcodes
    // several of these keys directly rather than going through Settings.get(),
    // so a migration must update those literals too or layer visibility
    // toggles will silently desync.
    static _key(name) { return `flypi_${name}`; }

    static get(name) {
        const raw = localStorage.getItem(Settings._key(name));
        if (raw === null) return Settings.DEFAULTS[name];
        try { return JSON.parse(raw); } catch { return raw; }
    }

    static set(name, value) {
        localStorage.setItem(Settings._key(name), JSON.stringify(value));
    }

    static get stratuxIp() { return Settings.get('stratux_ip'); }
    static set stratuxIp(v) { Settings.set('stratux_ip', v); }

    static get piIp() { return Settings.get('pi_ip'); }
    static set piIp(v) { Settings.set('pi_ip', v); }

    static get workerBase() { return Settings.get('worker_base'); }
    static set workerBase(v) { Settings.set('worker_base', v); }

    static get apiKey() { return Settings.get('flytab_api_key'); }
    static set apiKey(v) { Settings.set('flytab_api_key', v); }

    /** Standard headers for authenticated API calls to flywhere.app */
    static get apiHeaders() {
        const h = { 'Content-Type': 'application/json' };
        const key = Settings.apiKey;
        if (key) h['x-api-key'] = key;
        return h;
    }

    static get nightMode() { return Settings.get('night_mode'); }
    static set nightMode(v) { Settings.set('night_mode', v); }

    static get units() { return Settings.get('units'); }
    static set units(v) { Settings.set('units', v); }

    static get ownshipModeS() { return Settings.get('ownship_mode_s'); }
    static set ownshipModeS(v) { Settings.set('ownship_mode_s', v); }

    static get autoPan() { return Settings.get('auto_pan'); }
    static set autoPan(v) { Settings.set('auto_pan', v); }

    static get showRangeRings() { return Settings.get('show_range_rings'); }
    static set showRangeRings(v) { Settings.set('show_range_rings', v); }

    static get showTrackLog() { return Settings.get('show_track_log'); }
    static set showTrackLog(v) { Settings.set('show_track_log', v); }

    static get radarOpacity() { return Settings.get('radar_opacity'); }
    static set radarOpacity(v) { Settings.set('radar_opacity', v); }

    static get showNavaids() { return Settings.get('show_navaids'); }
    static set showNavaids(v) { Settings.set('show_navaids', v); }

    static get showFixes() { return Settings.get('show_fixes'); }
    static set showFixes(v) { Settings.set('show_fixes', v); }

    static get showAirports() { return Settings.get('show_airports'); }
    static set showAirports(v) { Settings.set('show_airports', v); }

    static get showAirways() { return Settings.get('show_airways'); }
    static set showAirways(v) { Settings.set('show_airways', v); }

    static get fuelMeasurement() { return Settings.get('fuel_measurement'); }
    static set fuelMeasurement(v) { Settings.set('fuel_measurement', v); }

    static get fuelManualOverride() { return Settings.get('fuel_manual_override'); }
    static set fuelManualOverride(v) { Settings.set('fuel_manual_override', v); }
}
