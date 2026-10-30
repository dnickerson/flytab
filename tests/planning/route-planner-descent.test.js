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
import { iasToTas } from '../../web/shared/planning/math/route-math.js';

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
        // descent burn, raised by the never-below-level floor (see below)
        expect(des.gph).toBeGreaterThanOrEqual(DES_GPH);
        expect(crz.gph).toBe(CRZ_GPH);
        expect(des.dist).toBeLessThan(leg.distNm);
        expect(segDist(leg)).toBeCloseTo(leg.distNm, 1);
    });

    it('WITUR -> RW24 (final approach): one DES 2100->528 over the whole leg', () => {
        const leg = legOf(plan, 'WITUR', 'RW24');
        expect(shape(leg)).toEqual(['DES 2100->528']);
        expect(leg.segments[0].dist).toBeCloseTo(leg.distNm, 1);
        expect(leg.segments[0].gph).toBeGreaterThanOrEqual(DES_GPH);
        // time as modelled: the 1572 ft at the descent rate (longer than the leg at 173 kt)
        expect(leg.timeHrs * 60).toBeCloseTo(1572 / DES_FPM, 6);
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

// ── Fix round 1 (review of 7a683d8) ─────────────────────────────────────────
// Expected values: recomputeLegs at ee166a2 (before #190), run on a scratch copy
// of web/shared/planning from `git archive ee166a2` with the same inputs.
const before = JSON.parse(readFileSync(join(__dirname, '../fixtures/planning/pilot-alt-and-approach-before-190.json'), 'utf8'));

describe('#190 an altitude the pilot set on an airport governs the leg into it, as before', () => {
    const DEP  = { id: 'KLKR', lat: 34.722904, lon: -80.85459, type: 'APT' };
    const A    = { id: 'AAA', lat: 34.0, lon: -81.4 };
    const MIDA = { id: 'KMID', lat: 33.0, lon: -81.8, type: 'APT' };
    const DEST = { id: 'KDST', lat: 32.0, lon: -82.2, type: 'APT' };
    const opts = { departureTime, cruiseAltFt: 8500 };
    const run = (wps) => planner.recomputeLegs({ departure: 'KLKR', destination: 'KDST', waypoints: wps }, null, opts);

    it('DEP -> A -> DEST(alt 4500): the last leg at 4500, not 8500', () => {
        const r = run([DEP, A, { ...DEST, altFt: 4500, isDest: true }]);
        expect(r.legs[1].altFt).toBe(4500);
        expect(r.legs).toEqual(before.destAlt.legs);
        expect(r.summary).toEqual(before.destAlt.summary);
    });

    it('DEP -> A -> FUEL(alt 4500) -> DEST: the leg into the fuel stop at 4500', () => {
        const r = run([DEP, A, { ...MIDA, altFt: 4500, fuelStop: true }, DEST]);
        expect(r.legs[1].altFt).toBe(4500);
        expect(r.legs).toEqual(before.fuelAlt.legs);
        expect(r.summary).toEqual(before.fuelAlt.summary);
    });

    it('DEP -> A -> airport pass-over (alt 4500) -> DEST: level at 4500, as before', () => {
        const r = run([DEP, A, { ...MIDA, altFt: 4500 }, DEST]);
        expect(r.legs).toEqual(before.airportAlt.legs);
        expect(r.summary).toEqual(before.airportAlt.summary);
    });
});

describe('#190 approach fuel is never below the level (pre-#190) plan', () => {
    const plan = planner.recomputeLegs(approachPlan(), null, { departureTime });
    const old = (from, to) => before.approach.legs.find(l => l.from === from && l.to === to);

    it('WITUR -> RW24 burns at least what ee166a2 planned (0.290 gal)', () => {
        const leg = legOf(plan, 'WITUR', 'RW24');
        expect(old('WITUR', 'RW24').fuelGal).toBeCloseTo(0.290, 3);
        expect(leg.fuelGal).toBeGreaterThanOrEqual(old('WITUR', 'RW24').fuelGal);
    });

    it('every approach leg, and the total, at least the ee166a2 figure (2.864 gal)', () => {
        for (const leg of plan.legs) {
            expect(leg.fuelGal).toBeGreaterThanOrEqual(old(leg.from, leg.to).fuelGal - 1e-12);
        }
        expect(before.approach.summary.totalFuelGal).toBeCloseTo(2.864, 3);
        expect(plan.summary.totalFuelGal).toBeGreaterThanOrEqual(before.approach.summary.totalFuelGal - 1e-12);
    });

    it('the floor goes on the DES segment: segments still sum to the leg', () => {
        for (const leg of plan.legs.slice(1)) {
            expect(segFuel(leg)).toBeCloseTo(leg.fuelGal, 9);
            expect(segMin(leg)).toBeCloseTo(leg.timeHrs * 60, 9);
        }
    });
});

// ── Instrument approach speed (Dana, 2026-10-30) ───────────────────────────────
// "Approaches are timed and flown at 90 KIAS or 120 KIAS. This should be a
// configurable setting." A leg from an approach fix (proc 'APPROACH', or true
// from older plans) to an approach fix, or the landing leg (RW## -> airport),
// is flown at fuelPhases.approach.ias_kt (aircraft performance
// instrument_approach_ias_kt, default 90). The leg into the IAF is en route.
describe('#190 approach legs at the instrument approach speed', () => {
    const P = (w) => ({ ...w, proc: 'APPROACH' });
    const procPlan = (mark = P) => ({ departure: 'KCLT', destination: 'KLKR',
        waypoints: [KCLT, mark(SAPSE), mark(WITUR), mark(RW24), KLKR] });
    const plain = planner.recomputeLegs(approachPlan(), null, { departureTime });
    const at90  = planner.recomputeLegs(procPlan(), null, { departureTime });

    it('WITUR -> RW24 at 90 KIAS: DES TAS from 90 KIAS at the mid altitude, timed over the leg at that GS', () => {
        const leg = legOf(at90, 'WITUR', 'RW24');
        const tas = iasToTas(90, (2100 + 528) / 2);
        expect(shape(leg)).toEqual(['DES 2100->528']);
        expect(leg.segments[0].tas).toBe(Math.round(tas));
        // 4.86 nm at ~92 kt (3.2 min) is longer than 1572 ft at 700 fpm (2.25 min)
        expect(leg.timeHrs * 60).toBeCloseTo(leg.distNm / tas * 60, 6);
        expect(leg.timeHrs).toBeGreaterThan(legOf(plain, 'WITUR', 'RW24').timeHrs);
    });

    it('level and step-down parts of an approach leg use the approach speed too', () => {
        const leg = legOf(at90, 'SAPSE', 'WITUR');
        expect(shape(leg)).toEqual(['DES 2500->2100', 'CRZ 2100->2100']);
        expect(leg.segments[0].tas).toBe(Math.round(iasToTas(90, 2300)));
        expect(leg.segments[1].tas).toBe(Math.round(iasToTas(90, 2100)));
        expect(leg.tasKt).toBe(Math.round(iasToTas(90, 2100)));
        expect(segMin(leg)).toBeCloseTo(leg.timeHrs * 60, 9);
        expect(segFuel(leg)).toBeCloseTo(leg.fuelGal, 9);
    });

    it('the landing leg (RW24 -> KLKR) is at the approach speed', () => {
        const leg = legOf(at90, 'RW24', 'KLKR');
        expect(leg.segments[0].tas).toBe(Math.round(iasToTas(90, (528 + 486) / 2)));
    });

    it('the leg into the IAF stays at en-route speeds', () => {
        expect(legOf(at90, 'KCLT', 'SAPSE')).toEqual(legOf(plain, 'KCLT', 'SAPSE'));
    });

    it('120 KIAS: shorter than 90', () => {
        const fast = planner.recomputeLegs(procPlan(), RV9A_COPY(120), { departureTime });
        const slow = planner.recomputeLegs(procPlan(), RV9A_COPY(90), { departureTime });
        expect(slow.legs).toEqual(at90.legs);   // the fallback profile is 90 KIAS
        expect(legOf(fast, 'WITUR', 'RW24').timeHrs).toBeLessThan(legOf(at90, 'WITUR', 'RW24').timeHrs);
        expect(fast.summary.totalEteHrs).toBeLessThan(at90.summary.totalEteHrs);
    });

    it('STAR fixes (proc STAR) are not approach legs: unchanged', () => {
        const star = planner.recomputeLegs(procPlan((w) => ({ ...w, proc: 'STAR' })), null, { departureTime });
        expect(star.legs).toEqual(plain.legs);
    });

    it('proc: true (plans saved before the kind was recorded) counts as an approach', () => {
        const old = planner.recomputeLegs(procPlan((w) => ({ ...w, proc: true })), null, { departureTime });
        expect(old.legs).toEqual(at90.legs);
    });

    it('an approach speed above cruise is flown at cruise IAS (never less fuel than en route)', () => {
        const at160 = planner.recomputeLegs(procPlan(), RV9A_COPY(160), { departureTime });
        const at140 = planner.recomputeLegs(procPlan(), RV9A_COPY(140), { departureTime });
        expect(at160.legs).toEqual(at140.legs);
        expect(legOf(at160, 'SAPSE', 'WITUR').segments[1].tas).toBe(Math.round(iasToTas(140, 2100)));
        expect(at160.summary.totalFuelGal).toBeGreaterThanOrEqual(plain.summary.totalFuelGal - 1e-12);
    });

    it('a STAR loaded before the kind was recorded (proc: true) is timed at the approach speed (known; slower = more fuel)', () => {
        const KSTAR = planner.recomputeLegs({ departure: 'KCLT', destination: 'KLKR', waypoints: [
            KCLT, { id: 'STAR1', lat: 35.0, lon: -80.7, altFt: 4000, proc: true },
            { ...SAPSE, proc: true }, { ...WITUR, proc: 'APPROACH' }, { ...RW24, proc: 'APPROACH' }, KLKR] }, null, { departureTime });
        const leg = legOf(KSTAR, 'STAR1', 'SAPSE');
        expect(leg.tasKt).toBe(Math.round(iasToTas(90, 2500)));
    });

    it('fuel stays at least the pre-#190 figure (2.864 gal); more time at 90 KIAS', () => {
        expect(at90.summary.totalFuelGal).toBeGreaterThanOrEqual(before.approach.summary.totalFuelGal - 1e-12);
        expect(at90.summary.totalEteHrs).toBeGreaterThan(plain.summary.totalEteHrs);
    });
});

/** The RV9A fallback's figures (route-planner.js) with another approach speed. */
function RV9A_COPY(apprIas) {
    return {
        id: 'rv9a-test', model: 'RV-9A', cruise_ktas: 153, cruise_ias: 140, fuel_burn_gph: 8.4,
        fuel_capacity_gal: 36, reserve_gal: 10, climb_rate_fpm: 1500, service_ceiling_ft: 17500,
        taxi_burn_gal: 0.33, max_hp: 180, alt_power_loss_pct_per_kft: 3.0,
        fuelPhases: {
            climb:   { gph: 15,  ias_kt: 120, rate_fpm: 1500, percent_power: 100, rpm: 2700, mp: 28 },
            cruise:  { gph: 8.4, ias_kt: 140, percent_power: 65, rpm: 2400, mp: 22 },
            descent: { gph: 6.9, ias_kt: 170, rate_fpm: 700, percent_power: 50, rpm: 2400, mp: 14 },
            approach: { ias_kt: apprIas },
        },
    };
}
