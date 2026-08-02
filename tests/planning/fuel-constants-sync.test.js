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
// The one field `_profileForPower()` does NOT take from the config is cruise
// gph at the configured cruise power: every `power_settings[].gph` is a MEDIAN
// (build_power_curve.py writes `round(gph_med, 1)`), and planning uses the p85.
// Copy 4 therefore carries its own constant,
// `RoutePlannerPanel.CRUISE_GPH_AT_CONFIGURED_POWER`, and it is pinned below by
// EXECUTING `_profileForPower()` — a value that is present but wired to the
// wrong field still fails. The active profile is not reachable from that
// function (IdbProfileStore.getActive() is async and IndexedDB-backed;
// `_profileForPower()` is called synchronously from render paths), which is why
// there is a fourth hand-maintained copy at all.
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

/**
 * Pull the `getActive()` staleness predicate out of idb-profile.js and return it
 * as a callable `(rv9a, RV9A_DEFAULT) => boolean`.
 *
 * The predicate is the only thing that re-seeds an already-provisioned tablet.
 * It lives inline inside a method on a class that needs a real IndexedDB, so it
 * is read off disk and evaluated — same approach as the profile literals above,
 * for the same reason. Evaluating it (rather than string-matching the source)
 * means a comparison that is present but wired to the wrong field still fails.
 */
function extractMigrationPredicate(src, label) {
    const anchor = src.indexOf("const rv9a = all.find(");
    if (anchor === -1) throw new Error(`rv9a lookup not found in ${label}`);
    const ifAt = src.indexOf('if (', anchor);
    if (ifAt === -1) throw new Error(`migration if() not found in ${label}`);
    const open = src.indexOf('(', ifAt);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new Error(`unbalanced parens reading migration predicate from ${label}`);
    const cond = src.slice(open + 1, i);
    return new Function('rv9a', 'RV9A_DEFAULT', `return !!(${cond});`);
}

const config   = JSON.parse(readFileSync('web/aircraft-config.json', 'utf8'));
const perf     = config.performance;
const fallback = extractObjectLiteral(
    readFileSync('web/shared/planning/planner/route-planner.js', 'utf8'),
    'RV9A_FALLBACK', 'route-planner.js');
const idbSrc   = readFileSync('web/shared/planning-adapters/idb-profile.js', 'utf8');
const dflt     = extractObjectLiteral(idbSrc, 'RV9A_DEFAULT', 'idb-profile.js');
const isStale  = extractMigrationPredicate(idbSrc, 'idb-profile.js');

// Copy 4. Loaded the same way tests/cockpit/*.test.js load classic-script
// cockpit classes — this file has no bundler path to it. `_profileForPower()`
// touches nothing but the `CockpitConfig` global, so it runs on a bare receiver.
const RoutePlannerPanel = new Function(
    readFileSync('web/cockpit/route-planner-panel.js', 'utf8') + '\nreturn RoutePlannerPanel;')();
const panelProfileForPower = (pct, performance = perf) => {
    globalThis.CockpitConfig = { aircraftRaw: { performance } };
    return RoutePlannerPanel.prototype._profileForPower.call({}, pct);
};

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

    // cruise: p85 of cruise-phase rows binned by recorded %power, 65-69% band
    // (n=7,879; median 8.10, p85 8.40). Dana's direct instruction 2026-07-31 —
    // "use 8.4 for the cruise gal/hr" — superseding commit 96d62f3, which had
    // recorded the opposite.
    //
    // The profile constant and the power_settings band value are now
    // DELIBERATELY DIFFERENT NUMBERS and both are pinned here so neither gets
    // "tidied" into the other:
    //   - profiles carry 8.4, the p85. build_power_curve.py:352 writes
    //     `"gph": round(gph_med, 1)`, so every band value is a MEDIAN, and a
    //     median is exactly the statistic the "plan more consumption rather
    //     than less" principle excludes.
    //   - power_settings 61-65 stays 8.1, its measured median. That table is
    //     measured data; editing it to match the profile would corrupt it.
    it('cruise is 8.4 gph in RV9A_FALLBACK and RV9A_DEFAULT — the 61-65 band keeps its 8.1 median', () => {
        expect(fallback.fuelPhases.cruise.gph).toBe(8.4);
        expect(dflt.fuelPhases.cruise.gph).toBe(8.4);
        expect(fallback.fuel_burn_gph).toBe(8.4);
        expect(dflt.fuel_burn_gph).toBe(8.4);

        const band = perf.power_settings.find(s => s.band === '61-65');
        expect(band, 'aircraft-config.json 61-65 power band').toBeDefined();
        expect(band.gph).toBe(8.1);
    });

    // The raw band lookup for the configured cruise power. It must still
    // resolve to the 61-65 band's measured median, and that median must sit
    // BELOW the profile cruise constant — that gap is the whole reason
    // `_profileForPower()` may not use the band value at cruise power. If the
    // band table is edited, this fails even if 8.4 is still written everywhere.
    it('gphForPowerPct(power_settings, cruise_pwr_pct) returns the 8.1 band median, below the 8.4 profile cruise', () => {
        expect(perf.cruise_pwr_pct).toBe(65);
        expect(gphForPowerPct(perf.power_settings, perf.cruise_pwr_pct)).toBe(8.1);
        expect(gphForPowerPct(perf.power_settings, perf.cruise_pwr_pct))
            .toBeLessThan(fallback.fuelPhases.cruise.gph);
    });

    // Copy 4 — the profile the pilot's route table is ACTUALLY built from.
    // Executed, not string-matched. Before 2026-07-31 this returned the 8.1
    // band median while both profile literals said 8.4, so Dana's decision was
    // cosmetic: ~0.93 gal MORE fuel shown remaining over a three-hour cruise.
    it('route-planner-panel _profileForPower(cruise_pwr_pct) agrees with the 8.4 profile cruise constant', () => {
        const p = panelProfileForPower(perf.cruise_pwr_pct);
        expect(p.fuelPhases.cruise.gph).toBe(fallback.fuelPhases.cruise.gph);
        expect(p.fuelPhases.cruise.gph).toBe(dflt.fuelPhases.cruise.gph);
        expect(p.fuel_burn_gph).toBe(fallback.fuel_burn_gph);
        expect(p.fuelPhases.cruise.gph).toBe(8.4);
        expect(RoutePlannerPanel.CRUISE_GPH_AT_CONFIGURED_POWER)
            .toBe(fallback.fuelPhases.cruise.gph);
    });

    // Climb and descent still come straight from the config in copy 4, so a
    // config edit that lowers either must not slip past this file.
    it('route-planner-panel climb/descent match aircraft-config.json', () => {
        const p = panelProfileForPower(perf.cruise_pwr_pct);
        expect(p.fuelPhases.climb.gph).toBe(perf.climb_gph);
        expect(p.fuelPhases.descent.gph).toBe(perf.descent_gph);
        expect(p.fuel_capacity_gal).toBe(perf.fuel_capacity_gal);
    });

    // Every stale hardcoded default inside `_profileForPower()`, exercised by
    // stripping the config key it shadows. `descent_gph` used to default to 4 —
    // ~2.9 gph below the measured p85, the tank-drying direction.
    it('route-planner-panel phase fallbacks are the measured p85s, not book guesses', () => {
        const stripped = { ...perf };
        delete stripped.climb_gph;
        delete stripped.descent_gph;
        const p = panelProfileForPower(perf.cruise_pwr_pct, stripped);
        expect(p.fuelPhases.descent.gph, 'descent fallback').toBeGreaterThanOrEqual(6.9);
        expect(p.fuelPhases.climb.gph,   'climb fallback').toBeGreaterThanOrEqual(15);
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
    // (`cfgGph`). It is deliberately 9, ABOVE the 8.4 profile cruise constant
    // and above the 8.1 band median — over-planning, i.e. the safe side. Dana
    // said leave it there. Pinned so it is never "tidied" down to match the
    // profile literals.
    it('performance.cruise_gph stays at 9 — above the 8.4 profile cruise and the 8.1 band median', () => {
        expect(perf.cruise_gph).toBe(9);
        expect(perf.cruise_gph).toBeGreaterThan(fallback.fuelPhases.cruise.gph);
    });
});

// ---------------------------------------------------------------------------
// getActive()'s migration predicate (widened 2026-07-31 with the 8.1 -> 8.4
// cruise change).
//
// A tablet that has already seeded `rv9a-default` into IndexedDB NEVER re-reads
// the RV9A_DEFAULT literal again — the only thing that refreshes it is this
// predicate. Any fuel-planning field missing from the comparison list keeps its
// old stored value forever. For a burn rate or a reserve that means the app
// plans LESS fuel than the shipped constants say and over-states fuel
// remaining: the direction that runs tanks dry. Before this change the
// predicate compared only climb_rate_fpm, taxi_burn_gal, climb.rate_fpm and
// descent.gph — so cruise 8.4 would never have reached Dana's tablet.
//
// Each field is perturbed DOWNWARD (the stale/unsafe direction) on a clone.
// ---------------------------------------------------------------------------
describe('idb-profile getActive() migration re-seeds every fuel-planning field', () => {
    const set = (obj, path, v) => {
        const keys = path.split('.');
        let o = obj;
        for (const k of keys.slice(0, -1)) o = o[k];
        o[keys.at(-1)] = v;
    };

    it('is a real predicate: false for an identical profile, true for an obviously stale one', () => {
        expect(isStale(structuredClone(dflt), dflt)).toBe(false);
        expect(isStale({ ...structuredClone(dflt), taxi_burn_gal: 0.1 }, dflt)).toBe(true);
    });

    const STALE = {
        'fuel_burn_gph':              8.1,   // the pre-2026-07-31 cruise value
        'reserve_gal':                5,
        'climb_rate_fpm':             500,
        'taxi_burn_gal':              0.1,
        'fuelPhases.cruise.gph':      8.1,   // the pre-2026-07-31 cruise value
        'fuelPhases.climb.gph':       10.7,
        'fuelPhases.climb.rate_fpm':  500,
        'fuelPhases.descent.gph':     4.0,   // the old book guess
    };

    for (const [path, staleValue] of Object.entries(STALE)) {
        it(`fires when a seeded profile still carries a stale ${path}`, () => {
            const stored = structuredClone(dflt);
            set(stored, path, staleValue);
            expect(stored, `${path} fixture must actually differ from the shipped default`)
                .not.toEqual(dflt);
            expect(isStale(stored, dflt), `${path} is not compared by the migration predicate`)
                .toBe(true);
        });
    }
});

describe('fuel constants — no phase rate may drop below its measured p85', () => {
    // Direction-of-error guard, independent of the exact pinned numbers above:
    // whatever these become, they may only ever move UP.
    // cruise 8.4 is the p85 of the 65-69% power band (n=7,879), i.e. conditioned
    // on the aircraft's configured cruise power — not the 8.3 pooled across all
    // cruise samples regardless of power setting, and not the 8.1 band median.
    const MEASURED_P85 = { climb: 15.1, cruise: 8.4, descent: 6.9 };

    for (const [phase, p85] of Object.entries(MEASURED_P85)) {
        it(`${phase}: config + both profiles stay within tolerance of the measured p85 ${p85}`, () => {
            const configGph = { climb: perf.climb_gph, cruise: perf.cruise_gph, descent: perf.descent_gph }[phase];
            // Only climb gets a tolerance: its p85 is 15.1 but it is carried as
            // a round 15.0. cruise and descent are carried at exactly their p85,
            // so they must meet it with no slack.
            const floor = phase === 'climb' ? p85 - 0.1 : p85;
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
// `fuel_burn_gph * (0.55/0.75)` = 6.16 gph for the RV-9A's 8.4 gph cruise
// profile (5.94 back when cruise was 8.1) — below the measured descent p85 of
// 6.9 either way, so it under-plans burn and over-states fuel remaining. It is
// now floored at the profile's cruise burn.
// ---------------------------------------------------------------------------
describe('decomposeLeg descent fallback never plans below the measured descent p85', () => {
    const MEASURED_DESCENT_P85 = 6.9;
    const base = { cruise_ktas: 153, cruise_ias: 140, climb_rate_fpm: 1500,
                   taxi_burn_gal: 0.33, fuel_burn_gph: 8.4 };
    const leg  = { distNm: 200, altFt: 6500, departingFromGround: true, endingAtGround: true };

    function fallbackDescentGph(profile) {
        const d = decomposeLeg(profile, leg);
        return d.phases.descent.fuelGal / d.phases.descent.timeHrs;
    }

    it('profile WITHOUT max_hp (the branch that yields 6.16 gph unfloored)', () => {
        expect(fallbackDescentGph({ ...base })).toBeGreaterThanOrEqual(MEASURED_DESCENT_P85);
    });

    it('profile WITH max_hp keeps its already-conservative 9.21 gph estimate', () => {
        // Math.max, not a replacement — flooring at cruise burn must not LOWER
        // this branch from 9.21 to 8.4.
        const gph = fallbackDescentGph({ ...base, max_hp: 180, alt_power_loss_pct_per_kft: 3.0 });
        expect(gph).toBeGreaterThanOrEqual(MEASURED_DESCENT_P85);
        expect(gph).toBeCloseTo(9.207, 2);
    });

    it('a measured fuelPhases.descent.gph still wins over the fallback', () => {
        const gph = fallbackDescentGph({
            ...base, max_hp: 180, alt_power_loss_pct_per_kft: 3.0,
            fuelPhases: {
                climb:   { gph: 15,  ias_kt: 120, rate_fpm: 1500 },
                cruise:  { gph: 8.4, ias_kt: 140 },
                descent: { gph: 6.9, ias_kt: 170, rate_fpm: 700 },
            },
        });
        expect(gph).toBeCloseTo(6.9, 6);
    });
});
