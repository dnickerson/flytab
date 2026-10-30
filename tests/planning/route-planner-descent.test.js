// #190 -- recomputeLegs plans the altitude changes BETWEEN fixes (the plate
// profile), not only the climb out of the departure and the descent into the
// destination.
//
// Before: a leg between two fixes was flown level at the to-fix's altitude, so
// KCLT -> SAPSE(2500) -> WITUR(2100) -> RW24(528) -> KLKR planned WITUR->RW24 as
// CRZ at 528 ft for the whole final approach, and SAPSE->WITUR as CRZ 2100 with
// no descent from 2500.
//
// Rules (Dana, 2026-10-30):
//   - a leg starts at the altitude the previous leg ended at (departure: ground)
//   - step-down: DES at the start of the leg at the profile's descent rate, then
//     level (CRZ) at the target; the whole leg is DES if the drop does not fit
//   - step-up: CLB at the start, then level; whole leg if it does not fit
//   - final approach (leg ending at an RW## fix): one DES over the whole leg
//   - leg into the destination: descends to the field elevation when the
//     waypoint carries one, else 0 (as before)
//   - a plain route (no per-fix altitudes) is unchanged -- pinned against the
//     legs the pre-#190 code produced.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { RoutePlanner } from '../../web/shared/planning/planner/route-planner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const planner = new RoutePlanner({ aero: {}, plans: {}, profiles: {}, weather: {}, network: {}, clock: {} });
const departureTime = new Date('2026-10-30T15:00:00Z');

// RV9A_FALLBACK (route-planner.js) phase figures the expectations rely on.
const DES_GPH = 6.9, DES_FPM = 700, CLB_GPH = 15, CLB_FPM = 1500, CRZ_GPH = 8.4;

// KLKR RNAV (GPS) RWY 24. SAPSE / WITUR / KLKR from the NASR bundle
// (flytab-pipeline/data/nasr/bundle.json, cycle of 2026-10-30); RW24 is the
// runway-24 threshold (v12.27). Approach altitudes are the CIFP values the
// approach loader stamps as altFt.
const KCLT  = { id: 'KCLT',  lat: 35.2140,     lon: -80.9431,     type: 'APT' };
const SAPSE = { id: 'SAPSE', lat: 34.822697,   lon: -80.656681,   altFt: 2500 };
const WITUR = { id: 'WITUR', lat: 34.769633,   lon: -80.762056,   altFt: 2100 };
const RW24  = { id: 'RW24',  lat: 34.72721166, lon: -80.84607163, altFt: 528 };
const KLKR  = { id: 'KLKR',  lat: 34.7229,     lon: -80.8546,     type: 'APT', isDest: true, elev_ft: 486 };

function approachPlan(dest = KLKR) {
    return { departure: 'KCLT', destination: 'KLKR', waypoints: [KCLT, SAPSE, WITUR, RW24, dest] };
}

const legOf = (plan, from, to) => plan.legs.find(l => l.from === from && l.to === to);
const shape = (leg) => leg.segments.map(s => `${s.phase} ${s.altFrom}->${s.altTo}`);
const segMin = (leg) => leg.segments.reduce((s, x) => s + x.ete_min, 0);
const segFuel = (leg) => leg.segments.reduce((s, x) => s + x.gph * x.ete_min / 60, 0);
const segDist = (leg) => leg.segments.reduce((s, x) => s + x.dist, 0);

describe('#190 plain route (no per-fix altitudes) is unchanged', () => {
    // Captured from recomputeLegs at ee166a2 (before #190) with the same inputs.
    const golden = JSON.parse(readFileSync(join(__dirname, '../fixtures/planning/plain-route-legs-before-190.json'), 'utf8'));
    const KLKRp = { id: 'KLKR', lat: 34.722904, lon: -80.85459, type: 'APT' };
    const KCLW  = { id: 'KCLW', lat: 27.977214, lon: -82.759057, type: 'APT' };

    it('KLKR -> KCLW direct: legs and summary identical', () => {
        const r = planner.recomputeLegs({ departure: 'KLKR', destination: 'KCLW', waypoints: [KLKRp, KCLW] }, null, { departureTime });
        expect(r.legs).toEqual(golden.direct.legs);
        expect(r.summary).toEqual(golden.direct.summary);
    });

    it('KLKR -> MID -> fuel stop -> MID2 -> KCLW with winds: legs and summary identical', () => {
        const r = planner.recomputeLegs({
            departure: 'KLKR', destination: 'KCLW', cruiseAltFt: 8500, waypoints: [
                KLKRp,
                { id: 'MID', lat: 32.5, lon: -81.6 },
                { id: 'KFUEL', lat: 30.4, lon: -81.9, type: 'APT', fuelStop: true },
                { id: 'MID2', lat: 29.0, lon: -82.3 },
                KCLW,
            ],
        }, null, {
            departureTime, pctPower: 75,
            winds: {
                CAE: { 3000: { dir: 240, spd: 15, temp: 12 }, 6000: { dir: 250, spd: 22, temp: 6 }, 9000: { dir: 260, spd: 30, temp: 0 } },
                JAX: { 3000: { dir: 200, spd: 10, temp: 16 }, 6000: { dir: 210, spd: 18, temp: 10 }, 9000: { dir: 220, spd: 25, temp: 4 } },
            },
            fdLocs: { CAE: [33.94, -81.12], JAX: [30.44, -81.56] },
        });
        expect(r.legs).toEqual(golden.viaFuelStopWinds.legs);
        expect(r.summary).toEqual(golden.viaFuelStopWinds.summary);
    });
});

describe('#190 KLKR RNAV 24: plate profile', () => {
    const plan = planner.recomputeLegs(approachPlan(), null, { departureTime });

    it('departure leg unchanged: climb from the ground, level at SAPSE altitude', () => {
        expect(shape(legOf(plan, 'KCLT', 'SAPSE'))).toEqual(['CLB 0->2500', 'CRZ 2500->2500']);
    });

    it('SAPSE -> WITUR: DES 2500->2100 at the start, then level at 2100', () => {
        const leg = legOf(plan, 'SAPSE', 'WITUR');
        expect(shape(leg)).toEqual(['DES 2500->2100', 'CRZ 2100->2100']);
        const [des, crz] = leg.segments;
        // the drop at the profile's descent rate
        expect(des.ete_min).toBeCloseTo(400 / DES_FPM, 6);
        expect(des.gph).toBe(DES_GPH);
        expect(crz.gph).toBe(CRZ_GPH);
        expect(des.dist).toBeLessThan(leg.distNm);
        expect(segDist(leg)).toBeCloseTo(leg.distNm, 1);
    });

    it('WITUR -> RW24 (final approach): one DES 2100->528 over the whole leg', () => {
        const leg = legOf(plan, 'WITUR', 'RW24');
        expect(shape(leg)).toEqual(['DES 2100->528']);
        expect(leg.segments[0].dist).toBeCloseTo(leg.distNm, 1);
        expect(leg.segments[0].gph).toBe(DES_GPH);
    });

    it('RW24 -> KLKR: DES 528 -> field elevation', () => {
        const leg = legOf(plan, 'RW24', 'KLKR');
        expect(shape(leg)).toEqual(['DES 528->486']);
        expect(leg.segments[0].dist).toBeCloseTo(leg.distNm, 1);
    });

    it('RW24 -> KLKR: DES 528 -> 0 when the destination carries no elevation (as before)', () => {
        const { elev_ft, ...noElev } = KLKR;
        const p = planner.recomputeLegs(approachPlan(noElev), null, { departureTime });
        expect(shape(legOf(p, 'RW24', 'KLKR'))).toEqual(['DES 528->0']);
    });

    it('every leg: time and fuel equal the sum of its segments (no taxi after the departure)', () => {
        for (const leg of plan.legs.slice(1)) {
            expect(segMin(leg)).toBeCloseTo(leg.timeHrs * 60, 6);
            expect(segFuel(leg)).toBeCloseTo(leg.fuelGal, 6);
        }
    });

    it('summary is the sum of the legs', () => {
        expect(plan.summary.totalEteHrs).toBeCloseTo(plan.legs.reduce((s, l) => s + l.timeHrs, 0), 9);
        expect(plan.summary.totalFuelGal).toBeCloseTo(plan.legs.reduce((s, l) => s + l.fuelGal, 0), 9);
    });
});

describe('#190 step-downs and step-ups between fixes', () => {
    // Two fixes on a parallel, ~25 nm apart; start at A's altitude.
    const DEP = { id: 'KDEP', lat: 35.0, lon: -81.5, type: 'APT' };
    const A   = { id: 'A', lat: 35.0, lon: -81.0 };
    const B   = { id: 'B', lat: 35.0, lon: -80.5 };
    const C   = { id: 'C', lat: 35.0, lon: -80.48 };   // ~1 nm past B
    const DST = { id: 'KDST', lat: 35.0, lon: -80.0, type: 'APT' };
    const run = (wps) => planner.recomputeLegs({ departure: 'KDEP', destination: 'KDST', waypoints: wps }, null, { departureTime });

    it('step-up: CLB at the start of the leg, then level', () => {
        const p = run([DEP, { ...A, altFt: 3000 }, { ...B, altFt: 5000 }, DST]);
        const leg = legOf(p, 'A', 'B');
        expect(shape(leg)).toEqual(['CLB 3000->5000', 'CRZ 5000->5000']);
        expect(leg.segments[0].ete_min).toBeCloseTo(2000 / CLB_FPM, 6);
        expect(leg.segments[0].gph).toBe(CLB_GPH);
        expect(segMin(leg)).toBeCloseTo(leg.timeHrs * 60, 6);
        expect(segFuel(leg)).toBeCloseTo(leg.fuelGal, 6);
    });

    it('step-up that does not fit: the whole leg is CLB, timed at the climb rate', () => {
        const p = run([DEP, { ...B, altFt: 3000 }, { ...C, altFt: 9000 }, DST]);
        const leg = legOf(p, 'B', 'C');
        expect(shape(leg)).toEqual(['CLB 3000->9000']);
        expect(leg.segments[0].dist).toBeCloseTo(leg.distNm, 1);
        expect(leg.timeHrs * 60).toBeCloseTo(6000 / CLB_FPM, 6);
    });

    it('step-down that does not fit: the whole leg is DES, timed at the descent rate', () => {
        const p = run([DEP, { ...B, altFt: 9000 }, { ...C, altFt: 3000 }, DST]);
        const leg = legOf(p, 'B', 'C');
        expect(shape(leg)).toEqual(['DES 9000->3000']);
        expect(leg.timeHrs * 60).toBeCloseTo(6000 / DES_FPM, 6);
        expect(segFuel(leg)).toBeCloseTo(leg.fuelGal, 6);
    });

    it('the next leg starts where the previous one ended (carried altitude, no override)', () => {
        const p = run([DEP, { ...A, altFt: 3000 }, { ...B, altFt: 5000 }, C, DST]);
        expect(shape(legOf(p, 'B', 'C'))).toEqual(['CRZ 5000->5000']);
        // destination leg descends from 5000, where the route left it
        expect(shape(legOf(p, 'C', 'KDST'))).toEqual(['CRZ 5000->5000', 'DES 5000->0']);
    });

    it('missed approach: the leg after the destination climbs from the field', () => {
        const MA = { id: 'MAFIX', lat: 34.65, lon: -80.95, altFt: 2500 };
        const p = planner.recomputeLegs({ departure: 'KCLT', destination: 'KLKR',
            waypoints: [KCLT, SAPSE, WITUR, RW24, KLKR, MA] }, null, { departureTime });
        expect(shape(legOf(p, 'KLKR', 'MAFIX'))[0]).toBe('CLB 486->2500');
        // totals still stop at the destination
        const toDest = p.legs.slice(0, 4);
        expect(p.summary.totalFuelGal).toBeCloseTo(toDest.reduce((s, l) => s + l.fuelGal, 0), 9);
    });
});
