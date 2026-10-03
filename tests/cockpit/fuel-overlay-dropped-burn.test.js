/**
 * FuelOverlay's dropped-burn correction control: the pilot can review/edit the
 * comms-gap burn estimate FuelTankState.onSample() tracks but never auto-applies,
 * then push a confirmed correction to both FlyTab's own tank state AND the Pi's
 * independent FuelTracker. The Pi sync must NOT fail silently — a correction the
 * pilot explicitly confirmed that never reaches the Pi would leave the two
 * displayed fuel numbers diverged with no indication. The Pi self-applies its
 * OWN tracked estimate (never a client-supplied amount — see engine_monitor.py's
 * /api/fuel/apply_dropped_burn handler), since FlyTab's estimate comes from a
 * different sample stream and can legitimately differ from the Pi's.
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
    overlay._piSyncFailed = false;
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

    it('rejects a fat-fingered amount exceeding a full tank without touching FuelTankState or the Pi', async () => {
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '170'; // meant "1.70", 36gal capacity -> 18gal/side cap
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/exceeds a full tank/i);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(FuelTankState.getState().left_gal).toBe(10);
    });

    it('refuses while the tank state needs confirmation, without touching FuelTankState or the Pi', async () => {
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

    it('refuses while a mid-gap tank switch makes the correction ambiguous, without touching FuelTankState or the Pi', async () => {
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

    it('does not report success or sync to the Pi when applyDroppedBurn() silently refuses (invalid active_tank)', async () => {
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

        expect(fetchSpy).not.toHaveBeenCalled(); // never reached the Pi sync step
        expect(overlay._dom.droppedBurnStatus.textContent).not.toMatch(/applied/i);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-error');
        const state = FuelTankState.getState();
        expect(state.left_gal).toBe(10);   // nothing actually subtracted
        expect(state.right_gal).toBe(12);
        expect(state.dropped_burn_estimate_gal).toBe(2.14); // correction not consumed
        expect(state.requires_confirm).toBe(true);
    });

    it('applies to FlyTab locally, sends no body, and reports the Pi\'s own applied amount', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '1.7';
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true, status: 200, json: async () => ({ applied_gal: 2.14 }),
        });

        await overlay._applyDroppedBurnCorrection();

        // Local FlyTab correction uses the pilot-edited amount.
        expect(FuelTankState.getState().left_gal).toBeCloseTo(8.3, 5);
        expect(FuelTankState.getState().dropped_burn_estimate_gal).toBeCloseTo(0.44, 5);
        // Pi call carries no body/amount — the Pi decides what to apply itself.
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://192.168.1.50:8080/api/fuel/apply_dropped_burn');
        expect(opts.method).toBe('POST');
        expect(opts.body).toBeUndefined();
        // Status surfaces the Pi's own (possibly different) applied amount.
        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/Pi applied its own 2\.1 gal/);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-ok');
        expect(overlay._piSyncFailed).toBe(false);
    });

    it('does not report a confident success when the Pi returns 200 but an unparseable body', async () => {
        // The endpoint ran (200 OK) and applies atomically under one lock, so the
        // correction almost certainly landed — but the amount is unknown, and this
        // must not collapse into the same reassuring "Applied to both trackers"
        // wording a verified success gets (PR #143 third review pass).
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '1.7';
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
        });

        await overlay._applyDroppedBurnCorrection();

        expect(FuelTankState.getState().left_gal).toBeCloseTo(8.3, 5); // local still applied
        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/could not be read/i);
        expect(overlay._dom.droppedBurnStatus.textContent).not.toMatch(/applied to both trackers/i);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-error');
        expect(overlay._piSyncFailed).toBe(true);
    });

    it('still applies locally, sets _piSyncFailed, and surfaces the failure when the Pi is unreachable', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '2.14'; // the full tracked estimate -> local goes to ~0
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

        await overlay._applyDroppedBurnCorrection();

        expect(FuelTankState.getState().left_gal).toBeCloseTo(7.86, 5);
        expect(FuelTankState.getState().dropped_burn_estimate_gal).toBeCloseTo(0, 5);
        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/Pi sync failed/);
        expect(overlay._dom.droppedBurnStatus.className).toContain('fo-add-status-error');
        expect(overlay._piSyncFailed).toBe(true);
        // Row stays up as a retry affordance even though the local estimate is now ~0.
        expect(overlay._dom.droppedBurnRow.style.display).toBe('');
        expect(overlay._dom.droppedBurnApply.textContent).toBe('RETRY PI SYNC');
    });

    it('reports failure and sets _piSyncFailed when engineClient is entirely unavailable', async () => {
        delete window.engineClient;
        const overlay = makeOverlay();
        overlay._dom.droppedBurnInput.value = '1.7';
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyDroppedBurnCorrection();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(FuelTankState.getState().left_gal).toBeCloseTo(8.3, 5);
        expect(overlay._dom.droppedBurnStatus.textContent).toMatch(/Pi unreachable/);
        expect(overlay._piSyncFailed).toBe(true);
    });
});

describe('FuelOverlay._retryPiDroppedBurnSync', () => {
    it('retries only the Pi sync, without touching FuelTankState again', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        // Simulate: local correction already landed (estimate near zero), prior Pi sync failed.
        FuelTankState._state.dropped_burn_estimate_gal = 0.0;
        FuelTankState._save();
        const overlay = makeOverlay();
        overlay._piSyncFailed = true;
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true, status: 200, json: async () => ({ applied_gal: 1.7 }),
        });
        const leftBefore = FuelTankState.getState().left_gal;

        await overlay._retryPiDroppedBurnSync();

        expect(FuelTankState.getState().left_gal).toBe(leftBefore); // untouched — no double-subtract
        expect(overlay._piSyncFailed).toBe(false);
        expect(overlay._dom.droppedBurnRow.style.display).toBe('none'); // nothing left pending either side
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

    it('keeps the row up in retry mode when only the Pi sync is pending', () => {
        FuelTankState._state.dropped_burn_estimate_gal = 0.01;
        FuelTankState._save();
        const overlay = makeOverlay();
        overlay._piSyncFailed = true;
        overlay._refreshDroppedBurnRow();
        expect(overlay._dom.droppedBurnRow.style.display).toBe('');
        expect(overlay._dom.droppedBurnInput.disabled).toBe(true);
        expect(overlay._dom.droppedBurnApply.textContent).toBe('RETRY PI SYNC');
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
