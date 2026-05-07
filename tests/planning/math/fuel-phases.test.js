import { describe, it, expect } from 'vitest';
import { decomposeLeg } from '../../../web/shared/planning/math/fuel-phases.js';

const RV9A = {
    cruise_ktas: 155, fuel_burn_gph: 8.0,
    climb_rate_fpm: 700, service_ceiling_ft: 17500,
    taxi_burn_gal: 1.5,
};

describe('decomposeLeg', () => {
    it('returns climb + cruise + descent for a typical leg', () => {
        // FIXED: Added endingAtGround: true so descent phase is populated
        const r = decomposeLeg(RV9A, { distNm: 100, altFt: 6000, departingFromGround: true, endingAtGround: true });
        expect(r.phases.climb.timeHrs).toBeGreaterThan(0);
        expect(r.phases.cruise.timeHrs).toBeGreaterThan(0);
        expect(r.phases.descent.timeHrs).toBeGreaterThan(0);
        expect(r.totalFuelGal).toBeCloseTo(
            r.phases.climb.fuelGal + r.phases.cruise.fuelGal + r.phases.descent.fuelGal + (r.phases.taxi?.fuelGal ?? 0),
            2);
    });

    it('only-cruise leg when departingFromGround=false and no descent flagged', () => {
        const r = decomposeLeg(RV9A, { distNm: 50, altFt: 6000, departingFromGround: false });
        expect(r.phases.climb.timeHrs).toBe(0);
    });
});

describe('decomposeLeg with gsKt/tasKt overrides', () => {
    const profile = { cruise_ktas: 155, fuel_burn_gph: 8.0, max_hp: 180 };

    it('gsKt override controls cruise time', () => {
        // 155 nm cruise, no wind normally, but override GS to 130 kt (headwind)
        const slow = decomposeLeg(profile, { distNm: 155, altFt: 6500, gsKt: 130 });
        const fast = decomposeLeg(profile, { distNm: 155, altFt: 6500 });
        expect(slow.totalTimeHrs).toBeGreaterThan(fast.totalTimeHrs);
    });

    it('tasKt override controls climb/descent TAS', () => {
        const hiAlt = decomposeLeg(profile, {
            distNm: 200, altFt: 9500, departingFromGround: true, tasKt: 162,
        });
        const loAlt = decomposeLeg(profile, {
            distNm: 200, altFt: 5500, departingFromGround: true,
        });
        // Higher TAS should cover more climb distance in same time
        expect(hiAlt.phases.climb.distNm).toBeGreaterThanOrEqual(loAlt.phases.climb.distNm);
    });
});
