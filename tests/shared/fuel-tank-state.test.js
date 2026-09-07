// tests/shared/fuel-tank-state.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const src = readFileSync('web/shared/fuel-tank-state.js', 'utf8');

function freshFuelTankState() {
    // Fresh localStorage + fresh class statics for each test
    localStorage.clear();
    const FuelTankState = new Function(`${src}\nreturn FuelTankState;`)();
    return FuelTankState;
}

describe('FuelTankState', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    describe('init() capacity clamp', () => {
        it('clamps leftGal/rightGal to half of configured capacity', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: (key) => key === 'performance.fuel_capacity_gal' ? 36 : null };
            FuelTankState.init(30, 5, 'L'); // 30 exceeds 36/2=18 per side
            const state = FuelTankState.getState();
            expect(state.left_gal).toBe(18);
            expect(state.right_gal).toBe(5);
        });

        it('does not clamp when CockpitConfig is unavailable (no crash, no clamp)', () => {
            const FuelTankState = freshFuelTankState();
            delete global.CockpitConfig;
            FuelTankState.init(30, 5, 'L');
            const state = FuelTankState.getState();
            expect(state.left_gal).toBe(30);
        });
    });

    describe('dropped_burn_estimate_gal', () => {
        it('accumulates the discarded portion of a long gap', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(18, 18, 'L');
            const state1 = FuelTankState.getState();
            const t0 = new Date(state1.last_sample_at).getTime();
            // Simulate a 60s gap (way over the 10s cap) at 10 GPH
            FuelTankState.onSample(10, t0 + 60000);
            const state2 = FuelTankState.getState();
            // Only 10s of burn should be applied: 10 gph * (10/3600) = 0.02778 gal
            expect(state2.left_gal).toBeCloseTo(18 - 10 * (10 / 3600), 4);
            // The other 50s should be tracked as dropped: 10 gph * (50/3600) = 0.1389 gal
            expect(state2.dropped_burn_estimate_gal).toBeCloseTo(10 * (50 / 3600), 4);
        });

        it('does not accumulate dropped burn for normal (<=10s) gaps', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(18, 18, 'L');
            const t0 = new Date(FuelTankState.getState().last_sample_at).getTime();
            FuelTankState.onSample(10, t0 + 5000); // 5s gap, under the cap
            expect(FuelTankState.getState().dropped_burn_estimate_gal).toBe(0);
        });
    });

    describe('applyDroppedBurn', () => {
        it('subtracts from the active tank and reduces the outstanding estimate by the same amount', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(10, 12, 'L');
            FuelTankState._state.dropped_burn_estimate_gal = 2.14;
            FuelTankState._save();

            const applied = FuelTankState.applyDroppedBurn(1.7); // pilot edited 2.14 down to 1.7

            expect(applied).toBe(true);
            const state = FuelTankState.getState();
            expect(state.left_gal).toBeCloseTo(8.3, 5);
            expect(state.right_gal).toBe(12); // inactive tank untouched
            expect(state.dropped_burn_estimate_gal).toBeCloseTo(0.44, 5);
        });

        it('charges the right tank instead when it is active', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(10, 12, 'L');
            FuelTankState.switchTank('R');
            FuelTankState._state.dropped_burn_estimate_gal = 1.0;
            FuelTankState._save();

            FuelTankState.applyDroppedBurn(1.0);

            const state = FuelTankState.getState();
            expect(state.left_gal).toBe(10);
            expect(state.right_gal).toBe(11);
        });

        it('floors both the tank and the outstanding estimate at 0 on an over-apply', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(1, 12, 'L');
            FuelTankState._state.dropped_burn_estimate_gal = 0.5;
            FuelTankState._save();

            FuelTankState.applyDroppedBurn(5.0); // far more than the 1 gal in the tank

            const state = FuelTankState.getState();
            expect(state.left_gal).toBe(0);
            expect(state.dropped_burn_estimate_gal).toBe(0);
        });

        it('is a no-op for zero, negative, or missing state', () => {
            const FuelTankState = freshFuelTankState();
            // No init() call — no state exists yet.
            expect(() => FuelTankState.applyDroppedBurn(2)).not.toThrow();
            expect(FuelTankState.getState()).toBeNull();

            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(10, 12, 'L');
            FuelTankState._state.dropped_burn_estimate_gal = 1.0;
            FuelTankState._save();
            expect(FuelTankState.applyDroppedBurn(0)).toBe(false);
            expect(FuelTankState.applyDroppedBurn(-3)).toBe(false);
            const state = FuelTankState.getState();
            expect(state.left_gal).toBe(10);
            expect(state.dropped_burn_estimate_gal).toBe(1.0);
        });

        it('refuses while requires_confirm is set, same as onSample()', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(10, 12, 'L');
            FuelTankState._state.dropped_burn_estimate_gal = 2.0;
            FuelTankState._state.requires_confirm = true;
            FuelTankState._save();

            const applied = FuelTankState.applyDroppedBurn(1.5);

            expect(applied).toBe(false);
            const state = FuelTankState.getState();
            expect(state.left_gal).toBe(10);
            expect(state.dropped_burn_estimate_gal).toBe(2.0);
        });

        it('flags requires_confirm instead of guessing when active_tank is invalid (e.g. legacy BOTH), and returns false', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(10, 12, 'L');
            FuelTankState._state.active_tank = 'BOTH'; // simulate legacy/corrupt state
            FuelTankState._state.dropped_burn_estimate_gal = 1.0;
            FuelTankState._save();

            const applied = FuelTankState.applyDroppedBurn(1.0);

            expect(applied).toBe(false); // caller must not treat this as success
            const state = FuelTankState.getState();
            expect(state.left_gal).toBe(10);   // untouched — didn't guess which tank
            expect(state.right_gal).toBe(12);
            expect(state.dropped_burn_estimate_gal).toBe(1.0); // correction not consumed
            expect(state.requires_confirm).toBe(true);
        });
    });

    describe('confirm-prompt timing', () => {
        it('does not fire the confirm prompt immediately after init', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            const handler = vi.fn();
            window.addEventListener('fueltankstate:confirm_prompt', handler);
            FuelTankState.init(18, 18, 'L');
            const t0 = new Date(FuelTankState.getState().last_sample_at).getTime();
            FuelTankState.onSample(10, t0 + 1000); // 1s after init — must NOT fire
            expect(handler).not.toHaveBeenCalled();
            window.removeEventListener('fueltankstate:confirm_prompt', handler);
        });

        it('fires the confirm prompt after CONFIRM_INTERVAL_MS has elapsed since init', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            const handler = vi.fn();
            window.addEventListener('fueltankstate:confirm_prompt', handler);
            FuelTankState.init(18, 18, 'L');
            const t0 = new Date(FuelTankState.getState().last_sample_at).getTime();
            // Feed samples in <=10s steps so burn integration isn't gap-capped, crossing the 30-min mark
            let t = t0;
            for (let i = 0; i < 190; i++) { // 190 * 10s = 1900s > 1800s (30 min)
                t += 10000;
                FuelTankState.onSample(10, t);
            }
            expect(handler).toHaveBeenCalled();
            window.removeEventListener('fueltankstate:confirm_prompt', handler);
        });
    });

    describe('continuous staleness re-evaluation', () => {
        it('flags requires_confirm on getState() when last_sample_at is stale, even mid-session', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };

            // Write a stale state to localStorage BEFORE the first _load() / needsConfirmation() call
            // This simulates state that was loaded on a prior app session and has since become stale
            const staleState = {
                left_gal: 18,
                right_gal: 18,
                active_tank: 'L',
                tank_switched_at: new Date().toISOString(),
                last_sample_at: new Date(Date.now() - 46 * 60 * 1000).toISOString(), // 46 min ago
                requires_confirm: false,
                initialized_at: new Date().toISOString(),
                imbalance: false,
                dropped_burn_estimate_gal: 0,
            };
            localStorage.setItem(FuelTankState.STORAGE_KEY, JSON.stringify(staleState));

            // needsConfirmation() will _load() the stale state from localStorage and _checkStaleness()
            // should detect that last_sample_at is > 45 min in the past
            expect(FuelTankState.needsConfirmation()).toBe(true);
        });
    });

    describe('mid-interval tank switch', () => {
        it('splits burn across a mid-interval tank switch between the tank left and the tank switched to', () => {
            const FuelTankState = freshFuelTankState();
            delete global.CockpitConfig;
            FuelTankState.init(18, 18, 'L');
            const t0 = new Date(FuelTankState.getState().last_sample_at).getTime();

            // First sample: 2s @ 10 GPH burned from L before any switch.
            FuelTankState.onSample(10, t0 + 2000);
            const afterFirst = FuelTankState.getState();

            // Pilot switches to R 3s after that sample. Write the switch directly to
            // storage (mirrors switchTank()'s own writes) so the test can control the
            // exact timestamp instead of racing Date.now().
            const switchAt = t0 + 2000 + 3000;
            const switched = {
                ...afterFirst,
                active_tank: 'R',
                pre_switch_tank: 'L',
                tank_switched_at: new Date(switchAt).toISOString(),
            };
            localStorage.setItem(FuelTankState.STORAGE_KEY, JSON.stringify(switched));
            FuelTankState._loaded = false;

            // Next telemetry sample arrives 7s after the switch (10s after the last real sample).
            FuelTankState.onSample(10, switchAt + 7000);
            const finalState = FuelTankState.getState();

            // Of the 10s interval since the last sample, 3s was pre-switch (still fed
            // from L) and 7s was post-switch (fed from R) — burn must split accordingly,
            // not be credited entirely to R just because R is active by the time the
            // sample lands.
            expect(finalState.left_gal).toBeCloseTo(afterFirst.left_gal - 10 * (3 / 3600), 4);
            expect(finalState.right_gal).toBeCloseTo(18 - 10 * (7 / 3600), 4);
            expect(finalState.pre_switch_tank == null).toBe(true); // consumed
        });

        it('does not split burn when no tank switch occurred since the last sample', () => {
            const FuelTankState = freshFuelTankState();
            delete global.CockpitConfig;
            FuelTankState.init(18, 18, 'L');
            const t0 = new Date(FuelTankState.getState().last_sample_at).getTime();
            FuelTankState.onSample(10, t0 + 5000);
            const state = FuelTankState.getState();
            expect(state.left_gal).toBeCloseTo(18 - 10 * (5 / 3600), 4);
            expect(state.right_gal).toBe(18);
        });

        it('switchTank() records pre_switch_tank and tank_switched_at only when the tank actually changes', () => {
            const FuelTankState = freshFuelTankState();
            delete global.CockpitConfig;
            FuelTankState.init(18, 18, 'L');
            FuelTankState.switchTank('L'); // no-op — already on L
            expect(FuelTankState.getState().pre_switch_tank == null).toBe(true);
            FuelTankState.switchTank('R');
            const state = FuelTankState.getState();
            expect(state.pre_switch_tank).toBe('L');
            expect(state.active_tank).toBe('R');
        });
    });
});

describe('FuelTankState.perSideCapGal', () => {
    it('returns configured capacity / 2 when CockpitConfig is available', () => {
        const FuelTankState = freshFuelTankState();
        global.CockpitConfig = { aircraft: (k) => k === 'performance.fuel_capacity_gal' ? 36 : null };
        expect(FuelTankState.perSideCapGal(18)).toBe(18);
    });

    it('returns the caller-supplied fallback when CockpitConfig is unavailable', () => {
        const FuelTankState = freshFuelTankState();
        delete global.CockpitConfig;
        expect(FuelTankState.perSideCapGal(Infinity)).toBe(Infinity);
        expect(FuelTankState.perSideCapGal(18)).toBe(18);
    });
});
