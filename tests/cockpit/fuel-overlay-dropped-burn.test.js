/**
 * FuelOverlay's dropped-burn correction control: the pilot can review/edit the
 * comms-gap burn estimate FuelTankState.onSample() tracks but never auto-applies,
 * then push a confirmed correction to both FlyTab's own tank state AND the Pi's
 * independent FuelTracker. The Pi sync must NOT fail silently — a correction the
 * pilot explicitly confirmed that never reaches the Pi would leave the two
 * displayed fuel numbers diverged with no indication.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const FuelOverlay = new Function(read('web/cockpit/fuel-overlay.js') + '\nreturn FuelOverlay;')();

function makeOverlay() {
    const overlay = Object.create(FuelOverlay.prototype);
    overlay._dom = {
        droppedBurnInput: document.createElement('input'),
        droppedBurnApply: document.createElement('button'),
        droppedBurnStatus: document.createElement('div'),
        droppedBurnVal: document.createElement('span'),
        droppedBurnRow: document.createElement('div'),
    };
    return overlay;
}

beforeEach(() => {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    FuelTankState.init(10, 12, 'L');
    FuelTankState._state.dropped_burn_estimate_gal = 2.14;
    FuelTankState._save();
});

afterEach(() => {
    delete window.engineClient;
    vi.restoreAllMocks();
});

describe('FuelOverlay._applyDroppedBurnCorrection', () => {
    it('rejects a non-positive amount without touching FuelTankState or the Pi', async () => {
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '0';
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/positive/i);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-error');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(FuelTankState.getState().left_gal).toBe(10);
    });

    it('applies to FlyTab locally and reports success when the Pi accepts it', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '1.7';
        vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

        await overlay._applyDroppedBurnCorrection();

        expect(FuelTankState.getState().left_gal).toBeCloseTo(8.3, 5);
        expect(FuelTankState.getState().dropped_burn_estimate_gal).toBeCloseTo(0.44, 5);
        expect(global.fetch).toHaveBeenCalledWith(
            'http://192.168.1.50:8080/api/fuel/apply_dropped_burn',
            expect.objectContaining({ method: 'POST' })
        );
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ gallons: 1.7 });
        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/both trackers/i);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-ok');
    });

    it('still applies locally but surfaces failure — does NOT swallow it — when the Pi is unreachable', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '1.7';
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

        await overlay._applyDroppedBurnCorrection();

        // Local correction still lands — the pilot's own gauge shouldn't be held
        // hostage by a Pi that isn't reachable.
        expect(FuelTankState.getState().left_gal).toBeCloseTo(8.3, 5);
        // But the failure is visible, not silently eaten like _syncFuelSetToEngine's
        // fire-and-forget .catch().
        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/NOT corrected/);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-error');
    });

    it('reports failure (not success) when engineClient is entirely unavailable', async () => {
        delete window.engineClient;
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '1.7';
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(FuelTankState.getState().left_gal).toBeCloseTo(8.3, 5);
        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/Pi unreachable/);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-error');
    });
});

describe('FuelOverlay._refreshDroppedBurnRow', () => {
    it('shows the row and pre-fills the input from the tracked estimate', () => {
        const overlay = makeOverlay();
        overlay._refreshDroppedBurnRow();
        expect(overlay._dom.droppedBurnRow.style.display).toBe('');
        expect(overlay._dom.droppedBurnVal.textContent).toBe('2.14');
        expect(overlay._dom.droppedBurnInput.value).toBe('2.1');
    });

    it('hides the row when the tracked estimate is negligible', () => {
        FuelTankState._state.dropped_burn_estimate_gal = 0.01;
        FuelTankState._save();
        const overlay = makeOverlay();
        overlay._refreshDroppedBurnRow();
        expect(overlay._dom.droppedBurnRow.style.display).toBe('none');
    });

    it('does not clobber a value the pilot is actively editing', () => {
        const overlay = makeOverlay();
        document.body.appendChild(overlay._dom.droppedBurnInput);
        overlay._dom.droppedBurnInput.value = '0.9';
        overlay._dom.droppedBurnInput.focus();

        overlay._refreshDroppedBurnRow();

        expect(overlay._dom.droppedBurnInput.value).toBe('0.9');
        overlay._dom.droppedBurnInput.remove();
    });
});
