import { describe, it, expect } from 'vitest';
import { tasAtAltitude, gphAtPower, climbRateAtAltitude, maxPowerAtAltitude } from '../../../web/shared/planning/math/engine-data.js';

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

const RV9A_FULL = {
    cruise_ktas: 155, cruise_ias: 148, fuel_burn_gph: 8.0,
    service_ceiling_ft: 17500, max_hp: 180, alt_power_loss_pct_per_kft: 3.0,
};

describe('maxPowerAtAltitude', () => {
    it('returns ~100% at sea level', () => {
        expect(maxPowerAtAltitude(RV9A_FULL, 0)).toBeCloseTo(100, 0);
    });
    it('returns ~70% at 10000 ft (3% per 1000 ft loss)', () => {
        expect(maxPowerAtAltitude(RV9A_FULL, 10000)).toBeCloseTo(70, 0);
    });
    it('clamps to 0 at or above ceiling', () => {
        expect(maxPowerAtAltitude(RV9A_FULL, 40000)).toBe(0);
    });
});

describe('gphAtPower (extended)', () => {
    it('LOP at 65% power, 8000 ft: ~7.8 gal/hr for 180 HP engine', () => {
        // 0.65 * 180 * 0.067 = 7.839
        const gph = gphAtPower(RV9A_FULL, 0.65, 8000, 'LOP');
        expect(gph).toBeCloseTo(7.8, 0);
    });
    it('ROP burns more than LOP at same power', () => {
        const lop = gphAtPower(RV9A_FULL, 0.65, 8000, 'LOP');
        const rop = gphAtPower(RV9A_FULL, 0.65, 8000, 'ROP');
        expect(rop).toBeGreaterThan(lop);
    });
    it('power is capped at altitude maximum', () => {
        // At 10000 ft, max is 70%; requesting 90% should give same as 70%
        const capped = gphAtPower(RV9A_FULL, 0.90, 10000, 'LOP');
        const atMax  = gphAtPower(RV9A_FULL, 0.70, 10000, 'LOP');
        expect(capped).toBeCloseTo(atMax, 1);
    });
    it('falls back to linear scaling for profiles without max_hp', () => {
        const simple = { cruise_ktas: 120, fuel_burn_gph: 8.0 };
        expect(gphAtPower(simple, 0.75)).toBeCloseTo(8.0, 1);
        expect(gphAtPower(simple, 0.65)).toBeCloseTo(8.0 * (0.65 / 0.75), 1);
    });
});
