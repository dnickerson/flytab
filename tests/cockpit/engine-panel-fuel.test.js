/**
 * EnginePanel FUEL readout (PR #214 finding 2). It reads FuelState.measuredGallons():
 * no measurement (capacity default only) shows the panel's '—' placeholder, never
 * a silent 0.0; a stale (UNCONFIRMED) tracked figure carries a trailing '?', the
 * marking the instrument strip and the fuel widget use. Endurance follows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync as readFileSyncFE } from 'fs';
// FuelEngine.formatHm is the shared h:mm helper (loaded before every cockpit module in index.html).
globalThis.FuelEngine = globalThis.FuelEngine || new Function(readFileSyncFE('web/shared/fuel-engine.js', 'utf8') + '\nreturn FuelEngine;')();

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

const EnginePanel = new Function(read('web/cockpit/engine-panel.js') + '\nreturn EnginePanel;')();
const RealFuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const setFuel = (f) => { RealFuelState.getCurrentFuel = () => f; globalThis.FuelState = RealFuelState; };

let panel;
const client = () => new EventTarget();

beforeEach(() => {
    delete globalThis.CockpitConfig;
    const host = document.createElement('div');
    document.body.appendChild(host);
    panel = new EnginePanel(host, client());
    panel.init();
});
afterEach(() => { panel?.destroy(); document.body.innerHTML = ''; delete globalThis.FuelState; });

const fuelText = () => panel._dom.fuel.textContent;
const endText = () => panel._dom.fuelEndurance.textContent;

describe('EnginePanel fuel readout', () => {
    it('tracked figure: gallons and endurance', () => {
        setFuel({ gallons: 18, source: 'tank_state', stale: false });
        panel._render({ Fuel_Flow: 9 });
        expect(fuelText()).toBe('18.0 gal');
        expect(endText()).toBe('2:00 endur');
    });

    it('stale tracked figure: marked with ?, endurance too', () => {
        setFuel({ gallons: 18, source: 'tank_state', stale: true });
        panel._render({ Fuel_Flow: 9 });
        expect(fuelText()).toBe('18.0? gal');
        expect(endText()).toBe('2:00? endur');
    });

    it('capacity only: — (unknown), not 0.0, and no endurance left over from before', () => {
        setFuel({ gallons: 18, source: 'tank_state', stale: false });
        panel._render({ Fuel_Flow: 9 });
        setFuel({ gallons: 36, source: 'capacity', stale: false });
        panel._render({ Fuel_Flow: 9 });
        expect(fuelText()).toBe('—');
        expect(endText()).toBe('');
    });

    it('reads through FuelState.measuredGallons() (no private copy)', () => {
        expect(read('web/cockpit/engine-panel.js')).toMatch(/FuelState\.measuredGallons\(\)/);
    });
});
