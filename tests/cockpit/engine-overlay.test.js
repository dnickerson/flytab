/**
 * EngineOverlay — the CARB TEMP box on the map under D->.
 *
 * It showed a greyed "CARB --°F" forever: it looked up `carb_temp` while the Pi
 * sends the EDM row nested as data.Carb_Temp, and it only refreshed on Stratux
 * situation events. These tests feed it the real Pi payload shape
 * (engine_monitor.py get_status(): { ..., data: { Carb_Temp, RPM, ... } }).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.EngineLimits = new Function(read('web/shared/engine-limits.js') + '\nreturn EngineLimits;')();
const EngineOverlay = new Function(read('web/cockpit/engine-overlay.js') + '\nreturn EngineOverlay;')();

const BUNDLE_FIELD = JSON.parse(read('web/cockpit-config.json')).engineOverlay.fields[0];

function setConfig(fields) {
    globalThis.CockpitConfig = { get: (p) => (p === 'engineOverlay' ? { enabled: true, position: 'top-right', fields } : undefined) };
}
/** What engine-client.js dispatches as engine:data -- the Pi's /api/status. */
const piStatus = (row) => ({ api_contract: 2, connected: true, data: { RPM: 2400, Oil_Temp: 180, ...row } });

function makeClient() {
    const c = new EventTarget();
    c.lastData = null; c.connected = true; c.stale = false;
    c.emit = (type, detail) => c.dispatchEvent(new CustomEvent(type, { detail }));
    return c;
}

let container;
beforeEach(() => {
    container = document.createElement('div');
    setConfig([BUNDLE_FIELD]);
});

const label = () => container.querySelector('.engine-overlay-label').textContent;
const value = () => container.querySelector('.engine-overlay-value');
const row = () => container.querySelector('.engine-overlay-field');

describe('EngineOverlay — CARB TEMP', () => {
    it('is labelled CARB TEMP', () => {
        new EngineOverlay(container);
        expect(label()).toBe('CARB TEMP');
    });

    it('a tablet with the old saved label "CARB" still shows CARB TEMP', () => {
        setConfig([{ ...BUNDLE_FIELD, label: 'CARB' }]);
        new EngineOverlay(container);
        expect(label()).toBe('CARB TEMP');
    });

    it('shows the Pi\'s nested data.Carb_Temp (the configured key is carb_temp)', () => {
        const client = makeClient();
        new EngineOverlay(container, client);
        client.emit('engine:data', piStatus({ Carb_Temp: 117 }));
        expect(value().textContent).toBe('117°F');
        expect(row().classList.contains('stale')).toBe(false);
    });

    it('updates from engine data alone -- no Stratux needed', () => {
        const client = makeClient();
        new EngineOverlay(container, client);
        client.emit('engine:data', piStatus({ Carb_Temp: 60 }));
        client.emit('engine:data', piStatus({ Carb_Temp: 61 }));
        expect(value().textContent).toBe('61°F');
    });

    it('picks up data that arrived before the overlay was created', () => {
        const client = makeClient();
        client.lastData = piStatus({ Carb_Temp: 88 });
        new EngineOverlay(container, client);
        expect(value().textContent).toBe('88°F');
    });

    it('blanks to "--" when engine data goes stale or disconnects, never keeps an old reading', () => {
        const client = makeClient();
        new EngineOverlay(container, client);
        client.emit('engine:data', piStatus({ Carb_Temp: 75 }));
        client.emit('engine:stale', { stale: true, ageMs: 6000 });
        expect(value().textContent).toBe('--°F');
        expect(row().classList.contains('stale')).toBe(true);
        client.emit('engine:data', piStatus({ Carb_Temp: 76 }));
        expect(value().textContent).toBe('76°F');
        client.emit('engine:disconnect', {});
        expect(value().textContent).toBe('--°F');
    });

    it('a stale:false recovery event alone does not blank it', () => {
        const client = makeClient();
        new EngineOverlay(container, client);
        client.emit('engine:data', piStatus({ Carb_Temp: 75 }));
        client.emit('engine:stale', { stale: false });
        expect(value().textContent).toBe('75°F');
    });

    // Same rule as the ENG page (EngineLimits.carbTempLevel): danger 0 < t <= 32,
    // caution 32 < t <= 70, otherwise normal (0 or below = no probe).
    it.each([
        [75, ''],
        [71, ''],
        [70, 'caution'],
        [50, 'caution'],
        [33, 'caution'],
        [32, 'danger'],
        [10, 'danger'],
        [0, ''],
        [-5, ''],
    ])('%i°F -> %s', (t, cls) => {
        const client = makeClient();
        new EngineOverlay(container, client);
        client.emit('engine:data', piStatus({ Carb_Temp: t }));
        expect(value().className.trim()).toBe(('engine-overlay-value ' + cls).trim());
    });

    it('ignores the old 40/32 thresholds a saved config may still hold', () => {
        setConfig([{ key: 'carb_temp', label: 'CARB', unit: '°F', warnBelow: 40, dangerBelow: 32 }]);
        const client = makeClient();
        new EngineOverlay(container, client);
        client.emit('engine:data', piStatus({ Carb_Temp: 60 }));   // old rule: green; ENG page: amber
        expect(value().className).toContain('caution');
        expect(label()).toBe('CARB TEMP');
    });

    it('a hand-added non-catalog field keeps its own warnBelow/dangerBelow', () => {
        setConfig([{ key: 'GP2', label: 'GP2', unit: '', warnBelow: 10, dangerBelow: 5 }]);
        const client = makeClient();
        new EngineOverlay(container, client);
        client.emit('engine:data', piStatus({ GP2: 7 }));
        expect(value().className).toContain('caution');
    });

    it('destroy() unsubscribes', () => {
        const client = makeClient();
        const ov = new EngineOverlay(container, client);
        ov.destroy();
        expect(() => client.emit('engine:data', piStatus({ Carb_Temp: 70 }))).not.toThrow();
        expect(container.querySelector('.engine-overlay')).toBeNull();
    });
});

describe('EngineOverlay — other engine fields from config', () => {
    it('matches Pi field names regardless of case/underscores (oil_temp -> Oil_Temp, rpm -> RPM)', () => {
        setConfig([
            { key: 'oil_temp', label: 'OIL', unit: '°F' },
            { key: 'rpm', label: 'RPM', unit: '' },
        ]);
        const client = makeClient();
        new EngineOverlay(container, client);
        client.emit('engine:data', piStatus({ Carb_Temp: 70 }));
        const vals = [...container.querySelectorAll('.engine-overlay-value')].map(v => v.textContent);
        expect(vals).toEqual(['180°F', '2400']);
    });
});

describe('app.js wiring', () => {
    it('creates the overlay with the engine client, not on Stratux situation events', () => {
        const app = read('web/app.js');
        expect(app).toMatch(/new EngineOverlay\(primaryView, this\.engineClient\)/);
        expect(app).not.toMatch(/engineOverlay\.update\(this\.enginePanel\.lastData\)/);
    });
});

describe('EngineOverlay picker support', () => {
    function liveConfig(fields) {
        const cfg = { engineOverlay: { enabled: true, position: 'top-right', fields } };
        globalThis.CockpitConfig = {
            get: (p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg),
            patch: (p, v) => { const ks = p.split('.'); let o = cfg; for (const k of ks.slice(0, -1)) o = o[k]; o[ks[ks.length - 1]] = v; },
        };
        return cfg;
    }

    it('every catalog key resolves against the real Pi payload', () => {
        const d = EngineOverlay.flatten({ percent_power: 65, data: { Carb_Temp: 72, RPM: 2420, MP: 23.4, Fuel_Flow: 8.2,
            Oil_Temp: 185, Oil_Press: 78, Volts: 14.1, CHT1: 340, CHT2: 362, CHT3: 0, CHT4: 355, EGT1: 1290, EGT2: 1312, EGT3: 1301, EGT4: 1288 } });
        const got = Object.fromEntries(EngineOverlay.CATALOG.map(c => [c.key, EngineOverlay.valueFor(d, c.key)]));
        expect(got).toEqual({ carb_temp: 72, rpm: 2420, mp: 23.4, fuel_flow: 8.2, percent_power: 65, oil_temp: 185,
            oil_press: 78, cht_max: 362, egt_max: 1312, volts: 14.1 });
    });

    it('CHT/EGT max ignore an unfitted probe reading 0, and are null with no readings', () => {
        expect(EngineOverlay.valueFor({ CHT1: 0, CHT2: 0, CHT3: 0, CHT4: 0 }, 'cht_max')).toBeNull();
        expect(EngineOverlay.valueFor({ CHT1: 0, CHT2: 300 }, 'cht_max')).toBe(300);
    });

    it('shows decimals where the catalog asks (MP 23.4", FF 8.2 gph)', () => {
        const cfg = liveConfig([]);
        EngineOverlay.setSelectedKeys(['mp', 'fuel_flow']);
        // Only which values are on is saved -- not catalog presentation.
        expect(cfg.engineOverlay.fields[0]).toEqual({ key: 'mp', label: 'MP', unit: '"' });
        const container = document.createElement('div');
        const ov = new EngineOverlay(container);
        ov.update({ MP: 23.44, Fuel_Flow: 8.21 });
        expect([...container.querySelectorAll('.engine-overlay-value')].map(v => v.textContent)).toEqual(['23.4"', '8.2 gph']);
        expect(cfg.engineOverlay.fields.map(f => f.key)).toEqual(['mp', 'fuel_flow']);
    });

    it('saves in catalog order, caps at MAX_FIELDS, and keeps hand-added non-catalog fields', () => {
        const cfg = liveConfig([{ key: 'carb_temp', label: 'CARB TEMP', unit: '°F' }, { key: 'GP2', label: 'GP2', unit: '' }]);
        EngineOverlay.setSelectedKeys(['volts', 'carb_temp', 'rpm']);
        expect(cfg.engineOverlay.fields.map(f => f.key)).toEqual(['carb_temp', 'rpm', 'volts', 'GP2']);
        expect(EngineOverlay.selectedKeys()).toEqual(['carb_temp', 'rpm', 'volts']);
        EngineOverlay.setSelectedKeys(EngineOverlay.CATALOG.map(c => c.key));
        expect(cfg.engineOverlay.fields.length).toBe(EngineOverlay.MAX_FIELDS);
    });

    it('a live overlay rebuilds on engineoverlay:fieldschanged and keeps the last values', () => {
        liveConfig([{ key: 'carb_temp', label: 'CARB TEMP', unit: '°F' }]);
        const container = document.createElement('div');
        const ov = new EngineOverlay(container);
        ov.update({ Carb_Temp: 70, RPM: 2300 });
        EngineOverlay.setSelectedKeys(['carb_temp', 'rpm']);
        expect([...container.querySelectorAll('.engine-overlay-value')].map(v => v.textContent)).toEqual(['70°F', '2300']);
        ov.destroy();
    });
});
