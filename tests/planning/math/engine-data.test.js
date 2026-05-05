import { describe, it, expect } from 'vitest';
import { tasAtAltitude, gphAtPower, climbRateAtAltitude } from '../../../web/shared/planning/math/engine-data.js';

const RV9A = { cruise_ktas: 155, fuel_burn_gph: 8.0, service_ceiling_ft: 17500 };

describe('tasAtAltitude', () => {
    it('returns cruise_ktas at 8000 ft (default cruise)', () => {
        expect(tasAtAltitude(RV9A, 8000)).toBeCloseTo(155, 0);
    });
    it('drops at sea level for normally-aspirated engine', () => {
        expect(tasAtAltitude(RV9A, 0)).toBeLessThan(155);
    });
});

describe('gphAtPower', () => {
    it('returns base GPH at 75% power', () => {
        expect(gphAtPower(RV9A, 0.75)).toBeCloseTo(8.0, 1);
    });
    it('scales linearly down to 65%', () => {
        expect(gphAtPower(RV9A, 0.65)).toBeLessThan(gphAtPower(RV9A, 0.75));
    });
});

describe('climbRateAtAltitude', () => {
    it('500+ fpm at sea level for typical light single', () => {
        expect(climbRateAtAltitude(RV9A, 0)).toBeGreaterThanOrEqual(500);
    });
    it('approaches 0 fpm at the service ceiling', () => {
        expect(climbRateAtAltitude(RV9A, 17500)).toBeLessThan(150);
    });
});
