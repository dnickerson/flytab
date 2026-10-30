/**
 * ApproachCharts.runwayThreshold: an approach's RW## fix is placed at the
 * runway's landing threshold (displaced threshold where there is one), from the
 * NASR bundle v11 runway fields; null when the bundle has no usable position
 * (bundle v10, helipads, ends the FAA gave no coordinates) so the caller falls
 * back to the airport reference point.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const ApproachCharts = new Function(
    readFileSync('web/cockpit/approach-charts.js', 'utf8') + '\nreturn ApproachCharts;')();

// KLKR runway 06/24 (April 2026 NASR APT_RWY_END.csv): RW06 has a 105 ft displaced threshold.
const KLKR_RWY = {
    id: '06/24', length_ft: 6004, width_ft: 100, surface: 'ASPH-G',
    base_id: '06', base_lat: 34.71859708, base_lon: -80.8631085,
    base_thr_lat: 34.71874788, base_thr_lon: -80.86280972,
    base_true_hdg: 58.4, base_elev_ft: 459.3, base_displ_ft: 105, base_tch_ft: 41,
    recip_id: '24', recip_lat: 34.72721166, recip_lon: -80.84607163,
    recip_thr_lat: 34.72721166, recip_thr_lon: -80.84607163,
    recip_true_hdg: 238.4, recip_elev_ft: 485.7, recip_tch_ft: 39,
};
const KLKR = { icao: 'KLKR', runways: [KLKR_RWY] };

describe('ApproachCharts.runwayThreshold', () => {
    it('RW24 is the recip end threshold', () => {
        expect(ApproachCharts.runwayThreshold(KLKR, 'RW24')).toMatchObject({
            lat: 34.72721166, lon: -80.84607163, elevFt: 485.7, tchFt: 39,
        });
    });

    it('RW06 is the displaced threshold, not the physical end', () => {
        const t = ApproachCharts.runwayThreshold(KLKR, 'RW06');
        expect(t.lat).toBe(34.71874788);
        expect(t.lon).toBe(-80.86280972);
        expect(t).toMatchObject({ elevFt: 459.3, tchFt: 41 });
    });

    it('RW6 and RW06 are the same end', () => {
        expect(ApproachCharts.runwayThreshold(KLKR, 'RW6')).toEqual(ApproachCharts.runwayThreshold(KLKR, 'RW06'));
        expect(ApproachCharts.runwayThreshold(KLKR, 'RW6')).not.toBeNull();
    });

    it('matches case-insensitively and with L/R/C suffixes', () => {
        const apt = { runways: [{ id: '18L/36R', base_id: '18L', base_lat: 35, base_lon: -80,
            recip_id: '36R', recip_lat: 35.01, recip_lon: -80 }] };
        expect(ApproachCharts.runwayThreshold(apt, 'RW18L')).toMatchObject({ lat: 35, lon: -80 });
        expect(ApproachCharts.runwayThreshold(apt, 'rw36r')).toMatchObject({ lat: 35.01 });
        expect(ApproachCharts.runwayThreshold(apt, 'RW18')).toBeNull();
        expect(ApproachCharts.runwayThreshold(apt, 'RW18R')).toBeNull();
    });

    it('uses the physical end when the end has no threshold fields', () => {
        const apt = { runways: [{ id: '09/27', base_id: '09', base_lat: 35, base_lon: -80, recip_id: '27' }] };
        expect(ApproachCharts.runwayThreshold(apt, 'RW09')).toEqual({ lat: 35, lon: -80 });
    });

    it('uses the threshold when the physical end has no coordinates', () => {
        const apt = { runways: [{ id: '09/27', base_id: '09', base_thr_lat: 35, base_thr_lon: -80 }] };
        expect(ApproachCharts.runwayThreshold(apt, 'RW09')).toEqual({ lat: 35, lon: -80 });
    });

    it('returns null for bundle v10 runways (no coordinates)', () => {
        const apt = { runways: [{ id: '06/24', length_ft: 6004, width_ft: 100, surface: 'ASPH-G' }] };
        expect(ApproachCharts.runwayThreshold(apt, 'RW24')).toBeNull();
    });

    it('returns null, not half a position, for a latitude with no longitude', () => {
        const apt = { runways: [{ id: 'X', base_id: 'LOW', base_lat: 35.1 }] };
        expect(ApproachCharts.runwayThreshold(apt, 'RWLOW')).toBeNull();
        expect(ApproachCharts.runwayThreshold(apt, 'LOW')).toBeNull();
        const apt2 = { runways: [{ id: '06/24', base_id: '06', base_thr_lat: 35, recip_id: '24', recip_lon: -80 }] };
        expect(ApproachCharts.runwayThreshold(apt2, 'RW06')).toBeNull();
        expect(ApproachCharts.runwayThreshold(apt2, 'RW24')).toBeNull();
    });

    it('falls back to the physical end when the threshold pair is incomplete', () => {
        // threshold lat without lon: the pair is unusable, the physical end is the next best
        const apt = { runways: [{ id: '06/24', base_id: '06', base_thr_lat: 99,
            base_lat: 35, base_lon: -80 }] };
        expect(ApproachCharts.runwayThreshold(apt, 'RW06')).toEqual({ lat: 35, lon: -80 });
    });

    it('returns null for an id with an end id but no coordinates, and never 0,0', () => {
        const apt = { runways: [{ id: '06/24', base_id: '06', base_displ_ft: 105, base_lat: 0 }] };
        expect(ApproachCharts.runwayThreshold(apt, 'RW06')).toBeNull();
    });

    it('returns null with no runways, no airport, or no id', () => {
        expect(ApproachCharts.runwayThreshold({ icao: 'KXXX' }, 'RW24')).toBeNull();
        expect(ApproachCharts.runwayThreshold({ runways: [] }, 'RW24')).toBeNull();
        expect(ApproachCharts.runwayThreshold(null, 'RW24')).toBeNull();
        expect(ApproachCharts.runwayThreshold(undefined, 'RW24')).toBeNull();
        expect(ApproachCharts.runwayThreshold(KLKR, '')).toBeNull();
        expect(ApproachCharts.runwayThreshold(KLKR, undefined)).toBeNull();
    });

    it('returns null for a runway that is not at the airport', () => {
        expect(ApproachCharts.runwayThreshold(KLKR, 'RW13')).toBeNull();
    });
});
