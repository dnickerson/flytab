import { describe, it, expect } from 'vitest';

function getBeamHeightFt(distanceNm, elevDeg = 0.5) {
    const distM = distanceNm * 1852;
    const Re = 6371000 * (4 / 3);
    const elevRad = elevDeg * Math.PI / 180;
    const heightM = Math.sqrt(distM ** 2 + Re ** 2 + 2 * distM * Re * Math.sin(elevRad)) - Re;
    return heightM * 3.28084;
}

describe('getBeamHeightFt', () => {
    it('returns ~4300 ft at 50nm (low-angle, standard atmosphere)', () => {
        const h = getBeamHeightFt(50, 0.5);
        expect(h).toBeGreaterThan(3500);
        expect(h).toBeLessThan(5500);
    });

    it('returns ~12000 ft at 100nm', () => {
        const h = getBeamHeightFt(100, 0.5);
        expect(h).toBeGreaterThan(9000);
        expect(h).toBeLessThan(15000);
    });

    it('returns ~37000 ft at 200nm', () => {
        const h = getBeamHeightFt(200, 0.5);
        expect(h).toBeGreaterThan(28000);
        expect(h).toBeLessThan(45000);
    });

    it('height increases with elevation angle', () => {
        expect(getBeamHeightFt(100, 2.0)).toBeGreaterThan(getBeamHeightFt(100, 0.5));
    });
});
