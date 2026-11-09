/**
 * FuelOverlay's dropped-burn correction control: the pilot can review/edit the
 * comms-gap burn estimate FuelTankState.onSample() tracks but never auto-applies,
 * then apply a confirmed correction to FlyTab's own FuelTankState. The tablet is
 * the only fuel record: nothing is sent to the Pi.
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
    global.CockpitConfig = { aircraft: (k) => k === 'performance.fuel_capacity_gal' ? 36 : null };
    FuelTankState.init(10, 12, 'L');
    FuelTankState._state.dropped_burn_estimate_gal = 2.14;
    FuelTankState._save();
});

afterEach(() => {
    delete window.engineClient;
    vi.restoreAllMocks();
});

describe('FuelOverlay._applyDroppedBurnCorrection', () => {
    it('rejects a non-positive amount without touching FuelTankState or sending anything', async () => {
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '0';
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/positive/i);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-error');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(FuelTankState.getState().left_gal).toBe(10);
    });

    it('rejects a fat-fingered amount exceeding a full tank without touching FuelTankState or sending anything', async () => {
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '170'; // meant "1.70", 36gal capacity -> 18gal/side cap
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/exceeds a full tank/i);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(FuelTankState.getState().left_gal).toBe(10);
    });

    it('refuses while the tank state needs confirmation, without touching FuelTankState or sending anything', async () => {
        FuelTankState._state.requires_confirm = true;
        FuelTankState._save();
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '1.7';
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/needs confirmation/i);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(FuelTankState.getState().left_gal).toBe(10);
    });

    it('refuses while a mid-gap tank switch makes the correction ambiguous, without touching FuelTankState or sending anything', async () => {
        // beforeEach leaves dropped_burn_estimate_gal at 2.14 (L active) — switching
        // tanks now means the correction can no longer be safely attributed to one.
        FuelTankState.switchTank('R');
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '1.7';
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/switched tanks/i);
        expect(fetchSpy).not.toHaveBeenCalled();
        const state = FuelTankState.getState();
        expect(state.right_gal).toBe(12); // active (post-switch) tank untouched
        expect(state.dropped_burn_estimate_gal).toBe(2.14); // not consumed
    });

    it('does not report success when applyDroppedBurn() silently refuses (invalid active_tank)', async () => {
        // The precondition check passes going in (requires_confirm is false), but
        // applyDroppedBurn() itself flags requires_confirm as a SIDE EFFECT because
        // active_tank is neither 'L' nor 'R' — the overlay must catch this via the
        // return value, not assume "didn't throw" means "was applied" (PR #143 review).
        FuelTankState._state.active_tank = 'BOTH';
        FuelTankState._save();
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '1.7';
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(overlay._dom.droppedBurnStatus.textContent).not.toMatch(/applied/i);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-error');
        const state = FuelTankState.getState();
        expect(state.left_gal).toBe(10);   // nothing actually subtracted
        expect(state.right_gal).toBe(12);
        expect(state.dropped_burn_estimate_gal).toBe(2.14); // correction not consumed
        expect(state.requires_confirm).toBe(true);
    });

    it('applies on the tablet only: FuelTankState updated, no fetch, no Pi wording', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '1.7';
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(FuelTankState.getState().left_gal).toBeCloseTo(8.3, 5);
        expect(FuelTankState.getState().dropped_burn_estimate_gal).toBeCloseTo(0.44, 5);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/Applied 1\.7 gal/);
        expect(overlay._dom.droppedBurnStatus.textContent).not.toMatch(/pi/i);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-ok');
        expect(overlay._dom.droppedBurnApply.disabled).toBe(false);
    });

    it('hides the row once the full estimate has been applied (no retry state)', async () => {
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '2.14';
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(FuelTankState.getState().dropped_burn_estimate_gal).toBeCloseTo(0, 5);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(overlay._dom.droppedBurnRow.style.display).toBe('none');
    });
});

describe('FuelOverlay._refreshDroppedBurnRow', () => {
    it('shows the row and pre-fills the input from the tracked estimate', () => {
        const overlay = makeOverlay();
        overlay._refreshDroppedBurnRow();
        expect(overlay._dom.droppedBurnRow.style.display).toBe('');
        expect(overlay._dom.droppedBurnVal.textContent).toBe('2.14');
        expect(overlay._dom.droppedBurnInput.value).toBe('2.1');
        expect(overlay._dom.droppedBurnApply.textContent).toBe('APPLY CORRECTION');
    });

    it('hides the row when nothing is pending on either tracker', () => {
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
