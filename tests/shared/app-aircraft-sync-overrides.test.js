// tests/shared/app-aircraft-sync-overrides.test.js
//
// _syncAircraftToPi (web/app.js; runs when a plan carrying an `aircraft` is
// applied, including _loadActivePlan at start) rebuilt CockpitConfig._aircraft
// from the cached bundle + the flywhere profile and dropped the pilot's
// Configuration overrides (flypi_user_aircraft) until restart: a saved
// Instrument Approach Speed of 120 read 90 after a plan sync, and every saved
// burn (cruise_gph, climb_gph, descent_gph ...) reverted the same way.
//
// Exercises the REAL _syncAircraftToPi body extracted from web/app.js, with the
// real CockpitConfig.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

function extractMethod(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`method not found: ${signature}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
    }
    throw new Error('unbalanced braces');
}

const appSrc = readFileSync('web/app.js', 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const syncAircraft = new AsyncFunction('profile', extractMethod(appSrc, 'async _syncAircraftToPi(profile) {'));
const BUNDLE = JSON.parse(readFileSync('web/aircraft-config.json', 'utf8'));

// A flywhere aircraft profile as plan sync embeds it.
const SUPA = {
    id: 'n194jt', tail_number: 'N194JT', type_code: 'RV9A',
    cruise_ias: 140, fuel_burn_gph: 9,
    performance: { descent_gph: 6.9, climb_gph: 15, vs0_kt: 47 },
};

describe('_syncAircraftToPi keeps the pilot\'s Configuration overrides', () => {
    beforeEach(() => {
        localStorage.clear();
        globalThis.CockpitConfig = new Function(readFileSync('web/shared/cockpit-config.js', 'utf8') + '\nreturn CockpitConfig;')();
        localStorage.setItem('flypi_cfg_aircraft_config_json', JSON.stringify(BUNDLE));
        globalThis.CockpitConfig._aircraft = JSON.parse(JSON.stringify(BUNDLE));
        localStorage.setItem('flypi_user_aircraft', JSON.stringify({ performance: { instrument_approach_ias_kt: 120, descent_gph: 7.5 } }));
    });

    it('after a plan sync: the saved 120 KIAS and 7.5 gph descent still apply', async () => {
        await syncAircraft.call({}, SUPA);
        expect(CockpitConfig.aircraft('performance.instrument_approach_ias_kt')).toBe(120);
        expect(CockpitConfig.aircraft('performance.descent_gph')).toBe(7.5);
    });

    it('a flywhere field the pilot did not override still comes through', async () => {
        await syncAircraft.call({}, SUPA);
        expect(CockpitConfig.aircraft('performance.vs0_kt')).toBe(47);
        expect(CockpitConfig.aircraft('performance.cruise_gph')).toBe(9);
        expect(CockpitConfig.aircraft('tail')).toBe('N194JT');
    });

    it('the cache keeps the synced config without the overrides; the stored overrides are not rewritten', async () => {
        await syncAircraft.call({}, SUPA);
        const cached = JSON.parse(localStorage.getItem('flypi_cfg_aircraft_config_json'));
        expect(cached.performance.descent_gph).toBe(6.9);
        expect(cached.performance.instrument_approach_ias_kt).toBe(90);
        expect(JSON.parse(localStorage.getItem('flypi_user_aircraft')))
            .toEqual({ performance: { instrument_approach_ias_kt: 120, descent_gph: 7.5 } });
    });

    it('a saved override equal to the flywhere value is kept in storage (not shrunk away)', async () => {
        localStorage.setItem('flypi_user_aircraft', JSON.stringify({ performance: { climb_gph: 15 } }));
        await syncAircraft.call({}, SUPA);
        expect(JSON.parse(localStorage.getItem('flypi_user_aircraft'))).toEqual({ performance: { climb_gph: 15 } });
    });
});
