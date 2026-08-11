import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

// Load the non-ESM classes into the jsdom environment.
// FuelEngine and FuelTankState are loaded for real (not stubbed) so the field-shape
// contract of extractEdmFuel and the tank-state shape stay honest.
globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));
globalThis.DiagLog = vi.fn();

globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
const FuelTanksDisplay = new Function(read('web/cockpit/fuel-tanks.js') + '\nreturn FuelTanksDisplay;')();

const CAPACITY_GAL = 36;   // matches web/aircraft-config.json
const THRESHOLD_GAL = 12;  // performance.fuel_sender_accurate_below_gal

function mockConfig(threshold = THRESHOLD_GAL, capacity = CAPACITY_GAL) {
    globalThis.CockpitConfig = {
        aircraft: (path) => {
            if (path === 'performance.fuel_capacity_gal') return capacity;
            if (path === 'performance.fuel_sender_accurate_below_gal') return threshold;
            return undefined;
        },
    };
}

let widget = null;

/**
 * Drive one scenario through the real engine-data path and read what the pilot
 * would actually see in the sender cross-check fields.
 * @param {number|null} trackedL - tracked tank level, or null for "no tracked state"
 */
function senderText(trackedL, trackedR, data, { threshold = THRESHOLD_GAL } = {}) {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    if (trackedL === null) {
        FuelTankState._loaded = true;   // loaded, but nothing tracked
    } else {
        FuelTankState.init(trackedL, trackedR, 'L');
    }

    mockConfig(threshold);
    const host = document.createElement('div');
    document.body.appendChild(host);
    widget = new FuelTanksDisplay(host);
    widget.init();

    widget._handleEngineData(data);
    return {
        L: widget._dom.senderL.textContent,
        R: widget._dom.senderR.textContent,
    };
}

const SUPPRESSED = 's:\u2014';   // "s:—"

beforeEach(() => { mockConfig(); });
afterEach(() => {
    try { widget && widget.destroy(); } catch (_) { /* not all paths build full DOM */ }
    widget = null;
    document.body.innerHTML = '';
});

describe('FuelTanksDisplay threshold configuration', () => {
    it('reads the sender-accuracy threshold from canonical aircraft config', () => {
        mockConfig(8, 40);
        const w = new FuelTanksDisplay(document.createElement('div'));
        w.init();
        expect(w._senderAccurateBelowGal).toBe(8);
        expect(w._tankCapacity).toBe(20);   // per side
        w.destroy();
    });

    it('falls back to 12 gal when the config key is absent', () => {
        globalThis.CockpitConfig = { aircraft: () => undefined };
        const w = new FuelTanksDisplay(document.createElement('div'));
        w.init();
        expect(w._senderAccurateBelowGal).toBe(12);
        w.destroy();
    });
});

describe('_updateSenderDisplay — suppression above the sender-accurate range', () => {
    it('suppresses both senders when both tanks are above the threshold', () => {
        const out = senderText(17, 17, { fuel_level_l: 16.4, fuel_level_r: 16.1, fuel_flow_gph: 9 });
        expect(out).toEqual({ L: SUPPRESSED, R: SUPPRESSED });
    });

    it('shows both senders when both tanks are below the threshold', () => {
        const out = senderText(8, 8, { fuel_level_l: 7.8, fuel_level_r: 7.6, fuel_flow_gph: 9 });
        expect(out).toEqual({ L: 's:7.8', R: 's:7.6' });
    });

    it('shows the sender at exactly the threshold (boundary is inclusive)', () => {
        const out = senderText(12, 12, { fuel_level_l: 11.9, fuel_level_r: 12.0, fuel_flow_gph: 9 });
        expect(out).toEqual({ L: 's:11.9', R: 's:12.0' });
    });

    it('suppresses just above the threshold', () => {
        const out = senderText(12.1, 12.1, { fuel_level_l: 12.0, fuel_level_r: 12.0, fuel_flow_gph: 9 });
        expect(out).toEqual({ L: SUPPRESSED, R: SUPPRESSED });
    });

    it('decides per tank — a low left tank still shows while a full right is suppressed', () => {
        const out = senderText(8, 17, { fuel_level_l: 7.9, fuel_level_r: 16.2, fuel_flow_gph: 9 });
        expect(out).toEqual({ L: 's:7.9', R: SUPPRESSED });
    });

    it('tracks a threshold change from config rather than a hardcoded 12', () => {
        // Same 12/12 tanks that are shown at threshold 12 must suppress at threshold 8.
        const out = senderText(12, 12, { fuel_level_l: 11.9, fuel_level_r: 12.0, fuel_flow_gph: 9 },
                               { threshold: 8 });
        expect(out).toEqual({ L: SUPPRESSED, R: SUPPRESSED });
    });
});

describe('_updateSenderDisplay — fuel-critical edge values', () => {
    it('shows a legitimate ZERO sender reading (must not be discarded as falsy)', () => {
        const out = senderText(6, 6, { fuel_level_l: 0, fuel_level_r: 0, fuel_flow_gph: 9 });
        expect(out).toEqual({ L: 's:0.0', R: 's:0.0' });
    });

    it('treats dry tracked tanks (0 gal) as in range, not as missing state', () => {
        const out = senderText(0, 0, { fuel_level_l: 0.4, fuel_level_r: 0.3, fuel_flow_gph: 9 });
        expect(out).toEqual({ L: 's:0.4', R: 's:0.3' });
    });

    it('fails open — shows raw senders when there is no tracked state at all', () => {
        const out = senderText(null, null, { fuel_level_l: 15.5, fuel_level_r: 15.2, fuel_flow_gph: 9 });
        expect(out).toEqual({ L: 's:15.5', R: 's:15.2' });
    });
});

describe('_updateSenderDisplay — fallback total path (no per-tank senders)', () => {
    // Field shape matters: FuelEngine.extractEdmFuel reads data.fuel.fuel_remaining /
    // fuel_remaining_gal / fuel_gal / gallons_rem / Gallons_Rem / Fuel_Remaining.
    // A bare `fuel_remaining` is NOT recognized.
    it('suppresses the combined total when tanks are above the threshold', () => {
        const out = senderText(17, 17, { fuel: { fuel_remaining: 33 }, fuel_flow_gph: 9 });
        expect(out.L).toBe(SUPPRESSED);
    });

    it('shows the combined total when tanks are below the threshold', () => {
        const out = senderText(8, 8, { fuel: { fuel_remaining: 16 }, fuel_flow_gph: 9 });
        expect(out.L).toBe('s:16');
    });

    it('accepts the flat fuel_remaining_gal variant', () => {
        const out = senderText(8, 8, { fuel_remaining_gal: 15, fuel_flow_gph: 9 });
        expect(out.L).toBe('s:15');
    });
});
