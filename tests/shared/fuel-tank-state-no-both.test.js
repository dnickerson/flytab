import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../../web/shared/fuel-tank-state.js'), 'utf8');
const FuelTankState = new Function(src + '\nreturn FuelTankState;')();

// N194JT (RV-9A) has no BOTH position on the fuel selector — fuel is drawn from the
// left tank or the right tank, never both. Integrating a burn against "BOTH" splits it
// evenly, which understates the tank actually feeding the engine: that tank can run dry
// while the gauge still shows fuel. These tests lock that behavior out.

function freshState() {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
}

/** Burn `minutes` at `gph`, stepping at 10s to stay under MAX_SAMPLE_DT_MS. */
function burn(minutes, gph, startMs) {
    let t = startMs;
    for (let i = 0; i < Math.round(minutes * 60 / 10); i++) {
        t += 10000;
        FuelTankState.onSample(gph, t);
    }
    return t;
}
const anchor = () => new Date(FuelTankState.getState().last_sample_at).getTime();

beforeEach(freshState);

describe('no BOTH selector position', () => {
    it('init() refuses a BOTH tank, falls back to L and demands confirmation', () => {
        FuelTankState.init(17, 17, 'BOTH');
        const st = FuelTankState.getState();
        expect(st.active_tank).toBe('L');
        expect(st.requires_confirm).toBe(true);
    });

    it('init() accepts L and R normally without demanding confirmation', () => {
        FuelTankState.init(17, 17, 'R');
        expect(FuelTankState.getState().active_tank).toBe('R');
        expect(FuelTankState.getState().requires_confirm).toBe(false);
    });

    it('switchTank() ignores BOTH and leaves the active tank unchanged', () => {
        FuelTankState.init(17, 17, 'L');
        FuelTankState.switchTank('BOTH');
        expect(FuelTankState.getState().active_tank).toBe('L');
        FuelTankState.switchTank('R');
        expect(FuelTankState.getState().active_tank).toBe('R');
    });
});

describe('onSample fails safe on an unusable active_tank', () => {
    it('does NOT split the burn across both tanks for legacy persisted BOTH state', () => {
        // Simulate a tablet that still has BOTH in localStorage from an older build.
        FuelTankState.init(17, 17, 'L');
        const persisted = JSON.parse(localStorage.getItem(FuelTankState.STORAGE_KEY));
        persisted.active_tank = 'BOTH';
        localStorage.setItem(FuelTankState.STORAGE_KEY, JSON.stringify(persisted));
        FuelTankState._state = null;
        FuelTankState._loaded = false;

        const start = new Date(persisted.last_sample_at).getTime();
        burn(120, 9, start);   // 2 hours at 9 gph

        const st = FuelTankState.getState();
        // The old behavior produced 8.0 / 8.0 here — an even split that understated
        // whichever tank was really feeding by 9 gal.
        expect(st.left_gal).toBe(17);
        expect(st.right_gal).toBe(17);
        expect(st.requires_confirm).toBe(true);
    });

    it('stops integrating and demands confirmation on a corrupt active_tank', () => {
        FuelTankState.init(17, 17, 'L');
        FuelTankState._state.active_tank = undefined;
        const before = FuelTankState.getState();
        FuelTankState.onSample(9, anchor() + 10000);
        const after = FuelTankState.getState();
        expect(after.left_gal).toBe(before.left_gal);
        expect(after.right_gal).toBe(before.right_gal);
        expect(after.requires_confirm).toBe(true);
    });

    it('resumes normal single-tank integration once a real tank is selected', () => {
        FuelTankState.init(17, 17, 'L');
        FuelTankState._state.active_tank = 'BOTH';
        FuelTankState.onSample(9, anchor() + 10000);
        expect(FuelTankState.getState().requires_confirm).toBe(true);

        FuelTankState.switchTank('R');
        FuelTankState.markConfirmed();
        const t = burn(60, 9, anchor());   // 1 hour at 9 gph on the RIGHT tank

        const st = FuelTankState.getState();
        expect(st.left_gal).toBe(17);                 // left untouched
        expect(st.right_gal).toBeCloseTo(8, 1);       // right down 9 gal
        expect(t).toBeGreaterThan(0);
    });
});
