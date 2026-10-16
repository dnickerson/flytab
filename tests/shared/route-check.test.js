/**
 * RouteCheck: the Route Planner redesign's route checks (spec
 * docs/superpowers/specs/2026-10-15-route-planner-redesign-design.md §2).
 *
 * Fixture: real records from the 2026-10-01 NASR bundle (T437, V37, MITVE,
 * GREAT, RICHE, ZUKUR, CAYCE, KLKR, KAIK, ...). The reroute Dana was given on
 * 2026-10-15: KLKR, join T437 at MITVE, T437 to CAYCE, direct KAIK. MITVE is
 * not on T437 in NASR; the nearest T437 fixes to it are GREAT 5.7 nm, RICHE
 * 8.9 nm, ZUKUR 13.2 nm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const RouteCheck = new Function(readFileSync('web/shared/route-check.js', 'utf8') + '\nreturn RouteCheck;')();
const nasr = JSON.parse(readFileSync('tests/fixtures/route-check/nasr-subset.json', 'utf8'));

const aero = {
    async getAirway(name) { return nasr.airways.find((a) => a.name === name) || null; },
    async resolve(id) {
        const u = id.toUpperCase();
        const r = nasr.airports.find((a) => a.icao === u) || nasr.navaids.find((n) => n.id === u) || nasr.fixes.find((f) => f.id === u);
        return r ? { lat: r.lat, lon: r.lon } : null;
    },
};

/** 'KLKR MITVE T437 CAYCE KAIK' -> pills (first dep, last dest, V/T-number awy). */
const pills = (str) => str.split(/\s+/).map((id, i, all) => ({
    id,
    type: i === 0 ? 'dep' : i === all.length - 1 ? 'dest' : /^[VTJQ]\d/.test(id) ? 'awy' : 'fix',
}));
const settings = (over = {}) => ({ routingMode: 't-airways', maxLegHrs: 2, reserveGal: 10, ...over });
const run = (str, over = {}) => RouteCheck.run({ pills: pills(str), computed: over.computed || null, settings: settings(over.settings), aero });
const codes = (ps) => ps.map((p) => `${p.severity}:${p.code}`);

describe('RouteCheck: airways', () => {
    it("Dana's reroute: MITVE is not on T437; join at GREAT, RICHE or ZUKUR, or go direct", async () => {
        const ps = await run('KLKR MITVE T437 CAYCE KAIK');
        expect(codes(ps)).toEqual(['red:entry-not-on-airway']);
        const p = ps[0];
        expect(p.message).toBe('MITVE is not on T437');
        expect(p.pillIndexes).toEqual([1, 2]);
        expect(p.fixes.map((f) => f.label)).toEqual(['Join T437 at GREAT · 5.7 nm', 'Join T437 at RICHE · 8.9 nm', 'Join T437 at ZUKUR · 13.2 nm', 'Go direct (no T437)']);
    });

    it('the order found on the tablet: entry and exit both flagged', async () => {
        const ps = await run('KLKR CAYCE MITVE T437 KAIK');
        expect(codes(ps)).toEqual(['red:entry-not-on-airway', 'red:exit-not-on-airway']);
        expect(ps[1].message).toBe('T437 needs an exit fix before KAIK');
        expect(ps[1].pillIndexes).toEqual([3, 4]);
        expect(ps[1].fixes[0].apply).toBe('exitAirwayAt');
    });

    it('one tap "Join T437 at GREAT": MITVE kept (as cleared), GREAT inserted, then no problems', async () => {
        const [p] = await run('KLKR MITVE T437 CAYCE KAIK');
        const fixed = RouteCheck.applyFix(pills('KLKR MITVE T437 CAYCE KAIK'), p.fixes[0]);
        expect(fixed.map((x) => `${x.id}:${x.type}`).join(' ')).toBe('KLKR:dep MITVE:fix GREAT:fix T437:awy CAYCE:fix KAIK:dest');
        const again = await RouteCheck.run({ pills: fixed, computed: null, settings: settings(), aero });
        expect(again).toEqual([]);
    });

    it('"Go direct" removes the airway', async () => {
        const [p] = await run('KLKR MITVE T437 CAYCE KAIK');
        const fixed = RouteCheck.applyFix(pills('KLKR MITVE T437 CAYCE KAIK'), p.fixes[3]);
        expect(fixed.map((x) => x.id).join(' ')).toBe('KLKR MITVE CAYCE KAIK');
    });

    it('an exit fix suggestion is inserted after the airway', async () => {
        const ps = await run('KLKR CAYCE MITVE T437 KAIK');
        const fixed = RouteCheck.applyFix(pills('KLKR CAYCE MITVE T437 KAIK'), ps[1].fixes[0]);
        const ids = fixed.map((x) => x.id);
        expect(ids.indexOf('T437')).toBe(3);
        expect(ids[4]).toBe(ps[1].fixes[0].arg.fix);
        expect(ids[5]).toBe('KAIK');
    });

    it('entry and exit both on the airway: nothing to report', async () => {
        expect(await run('KLKR GREAT T437 CAYCE KAIK')).toEqual([]);
    });

    it('VORs on an airway are matched by identifier (V37 lists CAE as "Columbia")', async () => {
        expect(await run('KLKR CAE V37 CLT KAIK', { settings: { routingMode: 'v-airways' } })).toEqual([]);
        const ps = await run('KLKR MITVE V37 CLT KAIK', { settings: { routingMode: 'v-airways' } });
        expect(ps[0].code).toBe('entry-not-on-airway');
        // suggestions name VORs by identifier, not by name
        expect(ps[0].fixes.map((f) => f.arg?.fix).filter(Boolean).every((id) => !/[a-z]/.test(id) && id !== 'COLUMBIA' && id !== 'CHARLOTTE')).toBe(true);
    });

    it('an airway gap is red: V157 does not run from LAL to DHP (FAA gap flag, bundle v11)', async () => {
        const ps = await run('KLKR LAL V157 DHP KTMB', { settings: { routingMode: 'v-airways' } });
        const gap = ps.find((p) => p.code === 'airway-gap');
        expect(gap.severity).toBe('red');
        expect(gap.message).toBe('V157 is not usable between DHP and LAL');
        expect(gap.pillIndexes).toEqual([1, 2, 3]);
        expect(gap.fixes.map((f) => f.apply)).toEqual(['goDirect']);
    });

    it('a V157 leg that does not cross a gap is fine', async () => {
        // LAL -> URIVE: consecutive, same side of the gap
        const ps = await run('KLKR LAL V157 URIVE KTMB', { settings: { routingMode: 'v-airways' } });
        expect(ps.map((p) => p.code)).not.toContain('airway-gap');
    });

    it('a zero typed for the letter O: "did you mean" with a one-tap fix (BRAD0 on the tablet, 2026-10-16)', async () => {
        const ps = await run('KLKR BL0TS CAYCE KAIK');
        const p = ps.find((x) => x.code === 'unknown-id');
        expect(p.message).toBe('BL0TS not found — did you mean BLOTS?');
        expect(p.fixes[0]).toMatchObject({ label: 'Use BLOTS', apply: 'replaceId', arg: { index: 1, id: 'BLOTS' } });
        const fixed = RouteCheck.applyFix(pills('KLKR BL0TS CAYCE KAIK'), p.fixes[0]);
        expect(fixed.map((x) => x.id).join(' ')).toBe('KLKR BLOTS CAYCE KAIK');
        expect(await RouteCheck.run({ pills: fixed, computed: null, settings: settings(), aero })).toEqual([]);
    });

    it('a one typed for the letter I is caught the same way; nothing similar: no suggestion', async () => {
        const p = (await run('KLKR R1CHE KAIK')).find((x) => x.code === 'unknown-id');
        expect(p.message).toBe('R1CHE not found — did you mean RICHE?');
        const none = (await run('KLKR SP4 KAIK')).find((x) => x.code === 'unknown-id');
        expect(none.message).toBe('SP4 not found');
        expect(none.fixes).toEqual([]);
    });

    it('unknown identifiers and airways are red, never dropped', async () => {
        const ps = await run('KLKR MITVF T999 CAYCE KAIK');
        expect(codes(ps)).toEqual(['red:unknown-id', 'red:unknown-id']);
        expect(ps.map((p) => p.message)).toEqual(['MITVF not found', 'Airway T999 not found']);
        expect(ps.map((p) => p.pillIndexes)).toEqual([[1], [2]]);
    });

    it('airway type vs the Routing setting is amber, with a one-tap switch', async () => {
        const ps = await run('KLKR GREAT T437 CAYCE KAIK', { settings: { routingMode: 'v-airways' } });
        expect(codes(ps)).toEqual(['amber:airway-type']);
        expect(ps[0].message).toBe('T437 is a T-route (Routing: V-airways)');
        expect(ps[0].fixes[0]).toMatchObject({ apply: 'setRouting', arg: { mode: 't-airways' } });
        expect(await run('KLKR GREAT T437 CAYCE KAIK', { settings: { routingMode: 'any' } })).toEqual([]);
    });
});

describe('RouteCheck: fuel, reserve, detour', () => {
    const computed = (legHrs, { fuelStopAt = -1, fuelRemGal = 20, totalDistNm = null } = {}) => ({
        legs: legHrs.map((h) => ({ timeHrs: h, distNm: h * 140 })),
        waypoints: [...Array(legHrs.length + 1)].map((_, i) => ({ id: `W${i}`, ...(i === fuelStopAt ? { fuelStop: true } : {}), ...(i === legHrs.length ? { isDest: true } : {}) })),
        summary: { totalEteHrs: legHrs.reduce((a, b) => a + b, 0), totalDistNm: totalDistNm ?? legHrs.reduce((a, b) => a + b, 0) * 140, fuelRemGal },
    });

    it('over the limit: red, with "Add fuel stop"', async () => {
        const ps = await run('KLKR KMDT', { computed: computed([1.5, 0.8]) });
        expect(codes(ps)).toContain('red:fuel-over-limit');
        const p = ps.find((x) => x.code === 'fuel-over-limit');
        expect(p.message).toBe('2h18m without a fuel stop (limit 2h)');
        expect(p.fixes[0].apply).toBe('addFuelStop');
    });

    it('exactly at the limit, and under it: no problem', async () => {
        expect(codes(await run('KLKR KMDT', { computed: computed([1.2, 0.8]) }))).not.toContain('red:fuel-over-limit');
        expect(codes(await run('KLKR KMDT', { computed: computed([1.0, 0.5]) }))).not.toContain('red:fuel-over-limit');
    });

    it('a fuel stop splits the time', async () => {
        expect(codes(await run('KLKR KMDT', { computed: computed([1.5, 0.8], { fuelStopAt: 1 }) }))).not.toContain('red:fuel-over-limit');
    });

    it('limit 2.5h is written 2.5h', async () => {
        const ps = await run('KLKR KMDT', { computed: computed([1.5, 1.5]), settings: { maxLegHrs: 2.5 } });
        expect(ps.find((x) => x.code === 'fuel-over-limit').message).toBe('3h00m without a fuel stop (limit 2.5h)');
    });

    it('landing below the reserve is red', async () => {
        const ps = await run('KLKR KMDT', { computed: computed([1.0], { fuelRemGal: 6.24 }) });
        expect(ps.find((x) => x.code === 'below-reserve').message).toBe('Lands with 6.2 gal (reserve 10)');
    });

    it('reserve is checked on the engine\'s fuel remaining (which refuels at stops)', async () => {
        // 36 gal tanks; legs burn 20 + 12 gal with a stop between them: the engine reports 24 left.
        const c = {
            legs: [{ timeHrs: 1.5, fuelGal: 20, fuelRemGal: 16 }, { timeHrs: 1.0, fuelGal: 12, fuelRemGal: 24 }],
            waypoints: [{ id: 'A' }, { id: 'F', fuelStop: true }, { id: 'B', isDest: true }],
            summary: { totalEteHrs: 2.5, totalDistNm: 300, totalFuelGal: 32, fuelRemGal: 24 },
        };
        const ps = await RouteCheck.run({ pills: pills('KLKR KMDT'), computed: c, settings: settings(), aero });
        expect(ps.map((p) => p.code)).not.toContain('below-reserve');
        const c2 = { ...c, summary: { ...c.summary, fuelRemGal: 4 } };
        const ps2 = await RouteCheck.run({ pills: pills('KLKR KMDT'), computed: c2, settings: settings(), aero });
        expect(ps2.find((p) => p.code === 'below-reserve').message).toBe('Lands with 4.0 gal (reserve 10)');
    });

    it('detour: amber over 25% longer than direct, nothing at 24%', async () => {
        const direct = 76.5;   // KLKR-KAIK great circle, nm (checked below)
        const at = (pct) => run('KLKR CAYCE KAIK', { computed: computed([0.5], { totalDistNm: direct * (1 + pct / 100) }) });
        expect(codes(await at(24))).not.toContain('amber:detour');
        const ps = await at(107);
        expect(ps.find((x) => x.code === 'detour').message).toBe('+107% longer than direct');
        expect(RouteCheck._directNm(await aero.resolve('KLKR'), await aero.resolve('KAIK'))).toBeCloseTo(direct, 0);
    });

    it('red problems come before amber ones', async () => {
        const ps = await run('KLKR MITVE T437 CAYCE KAIK', { computed: computed([0.5], { totalDistNm: 200 }), settings: { routingMode: 'v-airways' } });
        expect(ps.map((p) => p.severity)).toEqual(['red', 'amber', 'amber']);
    });
});
