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
            FuelTankState.init(18, 18, 'L');
            // Force last_sample_at far in the past without going through onSample
            const raw = JSON.parse(localStorage.getItem(FuelTankState.STORAGE_KEY));
            raw.last_sample_at = new Date(Date.now() - 46 * 60 * 1000).toISOString(); // 46 min ago
            localStorage.setItem(FuelTankState.STORAGE_KEY, JSON.stringify(raw));
            // getState() alone (no onSample) must re-evaluate staleness
            expect(FuelTankState.needsConfirmation()).toBe(true);
        });
    });
});
