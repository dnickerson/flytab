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

    it.each([
        [50, ''],
        [38, 'caution'],
        [30, 'danger'],
    ])('%i°F -> %s (config warnBelow 40, dangerBelow 32)', (t, cls) => {
        const client = makeClient();
        new EngineOverlay(container, client);
        client.emit('engine:data', piStatus({ Carb_Temp: t }));
        expect(value().className.trim()).toBe(('engine-overlay-value ' + cls).trim());
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
