import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { gphForPowerPct } from '../../web/shared/planning/index.js';
import { decomposeLeg } from '../../web/shared/planning/math/fuel-phases.js';

// ---------------------------------------------------------------------------
// Fuel constants live in FOUR hand-maintained places and nothing syncs them.
//
//   1. web/aircraft-config.json          performance.*  (+ power_settings[])
//   2. web/shared/planning/planner/route-planner.js      RV9A_FALLBACK
//   3. web/shared/planning-adapters/idb-profile.js       RV9A_DEFAULT
//   4. web/cockpit/route-planner-panel.js                _profileForPower()
//
// Verified 2026-07-31: there is NO automatic config->profile sync. The only
// aircraft-config writer is app.js `_syncAircraftToPi()`, which writes
// localStorage + CockpitConfig and never touches the `aircraft_profiles` object
// store. Both profile literals carry a "KEEP IN SYNC, BY HAND" comment; this
// file is the machine check that the hand-sync actually happened.
//
// aircraft-config.json is the MOST LIVE copy for what the pilot sees in the
// route table: route-planner-panel.js always calls `recomputeLegs(...)` with
// `_profileForPower(...)`, which is built field-by-field out of
// `CockpitConfig.aircraftRaw.performance`. RV9A_FALLBACK only fires when no
// profile is supplied at all. So the config copy is pinned here too.
//
// ERROR DIRECTION for every constant below: too LOW a phase GPH, or too LOW a
// reserve, under-plans fuel burn and therefore OVER-states fuel remaining. That
// is the direction that runs tanks dry, and it is the direction these pins
// exist to catch. Agreement alone is not enough — three copies of a wrong
// number agree just as well as three copies of the right one — so each value is
// pinned to its known-correct measured figure as well as cross-checked.
// ---------------------------------------------------------------------------

/**
 * Pull a top-level `const NAME = { ... };` object literal out of ES module
 * source and evaluate it. Both profile literals are deliberately module-private
 * (see the "KEEP IN SYNC, BY HAND" comments above each), and RV9A_DEFAULT sits
 * behind IdbProfileStore, which needs a real IndexedDB this project has no fake
 * for. So we read them off disk exactly like a human doing the hand-sync check.
 *
 * Scans with string/comment awareness rather than a flat regex, so a brace
 * inside a string or comment cannot silently truncate the match.
 */
function extractObjectLiteral(src, constName, label) {
    const start = src.search(new RegExp(`const\\s+${constName}\\s*=\\s*\\{`));
    if (start === -1) throw new Error(`const ${constName} not found in ${label}`);
    const open = src.indexOf('{', start);

    let depth = 0, i = open;
    let inS = null, inLine = false, inBlock = false;
    for (; i < src.length; i++) {
        const c = src[i], n = src[i + 1];
        if (inLine)        { if (c === '\n') inLine = false; continue; }
        if (inBlock)       { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
        if (inS)           { if (c === '\\') { i++; } else if (c === inS) inS = null; continue; }
        if (c === '/' && n === '/') { inLine = true;  i++; continue; }
        if (c === '/' && n === '*') { inBlock = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new Error(`unbalanced braces reading ${constName} from ${label}`);

    const text = src.slice(open, i + 1);
    let obj;
    try {
        obj = new Function(`return (${text});`)();
    } catch (e) {
        throw new Error(`could not evaluate ${constName} from ${label}: ${e.message}`);
    }
    if (!obj || typeof obj !== 'object')
        throw new Error(`${constName} in ${label} did not evaluate to an object`);
    return obj;
}

const config   = JSON.parse(readFileSync('web/aircraft-config.json', 'utf8'));
const perf     = config.performance;
const fallback = extractObjectLiteral(
    readFileSync('web/shared/planning/planner/route-planner.js', 'utf8'),
    'RV9A_FALLBACK', 'route-planner.js');
const dflt     = extractObjectLiteral(
    readFileSync('web/shared/planning-adapters/idb-profile.js', 'utf8'),
    'RV9A_DEFAULT', 'idb-profile.js');

describe('fuel constants — extraction sanity', () => {
    // If the extractor silently returned junk, every assertion below would be
    // vacuous. Prove it actually parsed real profiles first.
    it('parsed both module-private profile literals with their fuelPhases intact', () => {
        for (const [label, p] of [['RV9A_FALLBACK', fallback], ['RV9A_DEFAULT', dflt]]) {
            expect(p.id, label).toBe('rv9a-default');
            expect(p.fuelPhases, label).toBeDefined();
            for (const phase of ['climb', 'cruise', 'descent'])
                expect(typeof p.fuelPhases[phase]?.gph, `${label}.${phase}.gph`).toBe('number');
        }
    });
});

describe('fuel constants — measured values pinned in every copy', () => {
    // climb: p85 of EDM fuel flow, 53 ml_phase-labelled logs (n=9642, p85=15.1).
    it('climb is 15 gph in aircraft-config.json, RV9A_FALLBACK and RV9A_DEFAULT', () => {
        expect(perf.climb_gph).toBe(15);
        expect(fallback.fuelPhases.climb.gph).toBe(15);
        expect(dflt.fuelPhases.climb.gph).toBe(15);
    });

    // descent: p85 over the same logs (n=11819, p85=6.9). NOT the old 4.0 book
    // guess, which under-planned descent burn by ~2.9 gph.
    it('descent is 6.9 gph in aircraft-config.json, RV9A_FALLBACK and RV9A_DEFAULT', () => {
        expect(perf.descent_gph).toBe(6.9);
        expect(fallback.fuelPhases.descent.gph).toBe(6.9);
        expect(dflt.fuelPhases.descent.gph).toBe(6.9);
    });

    // cruise: the measured power_settings band nearest cruise_pwr_pct (65 ->
    // the 61-65 band, pct_mid 63, n=1120). Deliberately NOT the pooled cruise
    // p85 of 8.3 — see the resolution recorded in the Task 11 plan: 8.1 is
    // conditioned on the aircraft's actual configured cruise power, 8.3 pools
    // every cruise sample regardless of power setting.
    it('cruise is 8.1 gph in RV9A_FALLBACK, RV9A_DEFAULT, and the 61-65 power band', () => {
        expect(fallback.fuelPhases.cruise.gph).toBe(8.1);
        expect(dflt.fuelPhases.cruise.gph).toBe(8.1);
        expect(fallback.fuel_burn_gph).toBe(8.1);
        expect(dflt.fuel_burn_gph).toBe(8.1);

        const band = perf.power_settings.find(s => s.band === '61-65');
        expect(band, 'aircraft-config.json 61-65 power band').toBeDefined();
        expect(band.gph).toBe(8.1);
    });

    // The stated derivation of the cruise constant, executed rather than
    // asserted: this is exactly what _profileForPower() does for the route
    // table. If the band table is edited, this fails even if 8.1 is still
    // written in both profile literals.
    it('gphForPowerPct(power_settings, cruise_pwr_pct) reproduces the profile cruise gph', () => {
        expect(perf.cruise_pwr_pct).toBe(65);
        expect(gphForPowerPct(perf.power_settings, perf.cruise_pwr_pct))
            .toBe(fallback.fuelPhases.cruise.gph);
    });

    it('reserve is 10 gal in aircraft-config.json, RV9A_FALLBACK and RV9A_DEFAULT', () => {
        expect(perf.reserve_gal).toBe(10);
        expect(fallback.reserve_gal).toBe(10);
        expect(dflt.reserve_gal).toBe(10);
    });

    it('fuel capacity is 36 gal and max_hp is 180 in all three copies', () => {
        expect(perf.fuel_capacity_gal).toBe(36);
        expect(fallback.fuel_capacity_gal).toBe(36);
        expect(dflt.fuel_capacity_gal).toBe(36);
        expect(perf.max_hp).toBe(180);
        expect(fallback.max_hp).toBe(180);
        expect(dflt.max_hp).toBe(180);
    });

    // performance.cruise_gph is route-table.js's self-generated-segment figure
    // (`cfgGph`). It is deliberately 9, ABOVE both 8.1 and the pooled cruise p85
    // of 8.3 — over-planning, i.e. the safe side. Pinned so it is never "tidied"
    // down to match the profile literals.
    it('performance.cruise_gph stays at 9 — above both 8.1 and the pooled p85 8.3', () => {
        expect(perf.cruise_gph).toBe(9);
        expect(perf.cruise_gph).toBeGreaterThan(fallback.fuelPhases.cruise.gph);
    });
});

describe('fuel constants — no phase rate may drop below its measured p85', () => {
    // Direction-of-error guard, independent of the exact pinned numbers above:
    // whatever these become, they may only ever move UP.
    const MEASURED_P85 = { climb: 15.1, cruise: 8.3, descent: 6.9 };

    for (const [phase, p85] of Object.entries(MEASURED_P85)) {
        it(`${phase}: config + both profiles stay within tolerance of the measured p85 ${p85}`, () => {
            const configGph = { climb: perf.climb_gph, cruise: perf.cruise_gph, descent: perf.descent_gph }[phase];
            // cruise is intentionally conditioned on the 65% band (8.1) rather
            // than the pooled p85 (8.3); allow that documented 0.2 gph gap and
            // nothing more. climb/descent must meet or exceed their p85.
            const floor = phase === 'cruise' ? 8.1 : p85 - 0.1;
            for (const [label, gph] of [
                ['aircraft-config.json', configGph],
                ['RV9A_FALLBACK',        fallback.fuelPhases[phase].gph],
                ['RV9A_DEFAULT',         dflt.fuelPhases[phase].gph],
            ]) expect(gph, `${label} ${phase}`).toBeGreaterThanOrEqual(floor);
        });
    }
});

// ---------------------------------------------------------------------------
// Descent fallback floor (Task 11 fix round 1, fix 5).
//
// `decomposeLeg` falls back to an SFC estimate when a profile carries no
// measured `fuelPhases.descent.gph`. That estimate has two branches and one of
// them was unsafe: without `max_hp`, gphAtPower degrades to
// `fuel_burn_gph * (0.55/0.75)` = 5.94 gph for an 8.1 gph cruise profile —
// below the measured descent p85 of 6.9, so it under-plans burn and over-states
// fuel remaining. It is now floored at the profile's cruise burn.
// ---------------------------------------------------------------------------
describe('decomposeLeg descent fallback never plans below the measured descent p85', () => {
    const MEASURED_DESCENT_P85 = 6.9;
    const base = { cruise_ktas: 153, cruise_ias: 140, climb_rate_fpm: 1500,
                   taxi_burn_gal: 0.33, fuel_burn_gph: 8.1 };
    const leg  = { distNm: 200, altFt: 6500, departingFromGround: true, endingAtGround: true };

    function fallbackDescentGph(profile) {
        const d = decomposeLeg(profile, leg);
        return d.phases.descent.fuelGal / d.phases.descent.timeHrs;
    }

    it('profile WITHOUT max_hp (the branch that used to yield 5.94 gph)', () => {
        expect(fallbackDescentGph({ ...base })).toBeGreaterThanOrEqual(MEASURED_DESCENT_P85);
    });

    it('profile WITH max_hp keeps its already-conservative 9.21 gph estimate', () => {
        // Math.max, not a replacement — flooring at cruise burn must not LOWER
        // this branch from 9.21 to 8.1.
        const gph = fallbackDescentGph({ ...base, max_hp: 180, alt_power_loss_pct_per_kft: 3.0 });
        expect(gph).toBeGreaterThanOrEqual(MEASURED_DESCENT_P85);
        expect(gph).toBeCloseTo(9.207, 2);
    });

    it('a measured fuelPhases.descent.gph still wins over the fallback', () => {
        const gph = fallbackDescentGph({
            ...base, max_hp: 180, alt_power_loss_pct_per_kft: 3.0,
            fuelPhases: {
                climb:   { gph: 15,  ias_kt: 120, rate_fpm: 1500 },
                cruise:  { gph: 8.1, ias_kt: 140 },
                descent: { gph: 6.9, ias_kt: 170, rate_fpm: 700 },
            },
        });
        expect(gph).toBeCloseTo(6.9, 6);
    });
});
