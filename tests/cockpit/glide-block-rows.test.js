/**
 * Engine-out glide block rows (web/cockpit/glide-panel.js GlidePanel._view), spec 2026-11-04 §3.
 *
 * Drives the REAL GlideModel with the golden KLKR inputs of tests/shared/glide-model.test.js (one 6,004 ft
 * runway through the reference point, landing true 233 / 053, field elevation 486, default settings,
 * one wind for glide and runway) and checks every displayed row equals the model output formatted
 * per spec:
 *   verdict     ✓ GLIDE OK · N ft high (direct / final, spare >= 0) | ✗ CANNOT REACH KLKR · N ft low |
 *               ✓ OVER RWY <runwayId> (no rows) |
 *               RUNWAY POSITION NOT KNOWN / NO SUITABLE RUNWAY · steer to the airport · N ft high (state on a
 *               sub line under a CANNOT REACH title when low); N = floor(spare) when >= 0, ceil(-spare) when < 0
 *               (spec 2026-11-06: no "FINAL POINT OUT OF REACH" any more)
 *   TO          RWY <endId> + "on final" | RWY <runwayId> + "nearest part" | the ICAO
 *   HEADING     hdg3(hdgTrue - MagVar.declination(ac)) + "°", turn cue from turnNow / onCourseDeg
 *   DISTANCE    legNm.toFixed(1) nm
 *   AIRSPEED    validated glide_ias_kt KIAS
 *   DESCENT     round(target) fpm; "now M fpm · X shallower|too steep" with X = |shown M - shown target|
 *               (v12.67: the two rounded numbers on screen, so the difference adds up; equal -> "on
 *               target"; v12.66: never targetNow); "now —"
 *   GLIDE PATH  +N ft / −N ft (U+2212)
 * The golden values themselves (spare, legNm, target, ...) are also compared with the reference table.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const GlideModel = new Function(read('web/shared/glide-model.js') + '\nreturn GlideModel;')();
const GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const MagVar = new Function(read('web/shared/mag-var.js') + '\nreturn MagVar;')();

const FT_PER_NM = 6076.12;
const rad = (d) => d * Math.PI / 180;
const fromPolar = (brg, nm) => ({ x: nm * Math.sin(rad(brg)), y: nm * Math.cos(rad(brg)) });
const ELEV = 486, RWY_LEN = 6004, RWY_TRUE = 233;
const KLKR_LL = { lat: 34.722904, lon: -80.85459 };

/** KLKR as the golden reference builds it (glide-model.test.js klkr()), with the real end / runway ids. */
function klkr({ ends = true } = {}) {
    const half = RWY_LEN / 2 / FT_PER_NM;
    const physA = fromPolar(RWY_TRUE, half), physB = fromPolar(RWY_TRUE + 180, half);
    const mk = (id, hdg, thr) => ({ id, runwayId: '06/24', thr, hdgTrue: hdg, rwyLenFt: RWY_LEN, mid: { x: 0, y: 0 }, rwy: { a: physA, b: physB } });
    return { elevFt: ELEV, ref: { x: 0, y: 0 }, ends: ends ? [mk('24', RWY_TRUE, physB), mk('06', (RWY_TRUE + 180) % 360, physA)] : [] };
}
const CASES = {
    A: { pos: fromPolar(0, 5), alt: 4500, trk: 160, gs: 145, vs: 0, wind: { from: 250, kt: 14 } },
    B: { pos: fromPolar(180, 6), alt: 5500, trk: 0, gs: 145, vs: 0, wind: { from: 250, kt: 14 } },
    C: { pos: fromPolar(45, 3), alt: 2500, trk: 45, gs: 140, vs: 0, wind: null },
    D: { pos: fromPolar(270, 9), alt: 3500, trk: 90, gs: 140, vs: -500, wind: { from: 250, kt: 14 } },
    E: { pos: fromPolar(0, 15), alt: 3000, trk: 180, gs: 140, vs: 0, wind: { from: 360, kt: 20 } },
    F: { pos: fromPolar(45, 6), alt: 4000, trk: 225, gs: 140, vs: 0, wind: { from: 60, kt: 15 } },
};
// The golden table (glide-model.test.js): [case, preferDirect (ignored), kind, spare, legNm, target]
const GOLDEN = {
    'B-direct': ['B', false, 'direct', 1248, 5.71, 1049],
    'A-planB': ['A', false, 'direct', 529, 4.69, 887],
    'F-planB': ['F', true, 'direct', 356, 5.51, 847],
    'C-cannot': ['C', false, 'direct', -389, 2.51, 585],
    'D-cannot': ['D', false, 'direct', -1886, 8.61, 448],
    'E-cannot': ['E', false, 'direct', -5052, 14.71, 233],
};

const S = () => {
    // GlideInputs.validate(defaults) - the same settings GlidePanel gets from GlideInputs.settings()
    globalThis.GlideModel = GlideModel;
    globalThis.GpsFix = GpsFix;
    const GI = new Function(read('web/cockpit/glide-inputs.js') + '\nreturn GlideInputs;')();
    return GI.validate({});
};
function planFor(c, preferDirect, airport = klkr(), vs = CASES[c].vs, settings = S()) {
    const k = CASES[c];
    return GlideModel.plan({
        airport,
        ac: { pos: k.pos, altMsl: k.alt, gs: k.gs, trkTrue: k.trk, vs },
        glideWind: k.wind,
        runwayWind: k.wind ? { kind: 'metar', from: k.wind.from, kt: k.wind.kt, gustKt: null } : { kind: 'none' },
        preferDirect,
    }, settings);
}
/** The aircraft's lat/lon for the case (for MagVar), from the local position around KLKR. */
const sitFor = (c) => ({ ...GlideModel.fromLocal(KLKR_LL.lat, KLKR_LL.lon, CASES[c].pos) });

// ---- Expected text, written from the spec (not from glide-panel.js) ----
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const N = (spare) => (spare >= 0 ? Math.floor(spare) : Math.ceil(-spare)) || 0;
const hiLo = (spare) => `${fmt(N(spare))} ft ${spare >= 0 ? 'high' : 'low'}`;
const hdg3 = (d) => { const r = Math.round(((d % 360) + 360) % 360); return String(r === 0 ? 360 : r).padStart(3, '0'); };
const turnTxt = (t, on) => (Math.abs(t) <= on ? '↑ on course' : t > 0 ? `↱ turn right ${Math.round(t)}°` : `↰ turn left ${Math.round(-t)}°`);
function nowTxt(p) {
    if (!Number.isFinite(p.measured)) return 'now —';
    const m = Math.round(p.measured), t = Math.round(p.target), d = m - t;
    return d > 0 ? `now ${fmt(m)} fpm · ${fmt(d)} too steep`
        : d < 0 ? `now ${fmt(m)} fpm · ${fmt(-d)} shallower` : `now ${fmt(m)} fpm · on target`;
}
const pathTxt = (spare) => `${spare >= 0 ? '+' : '−'}${fmt(N(spare))} ft`;

let GlidePanel, host;
beforeEach(() => {
    globalThis.GlideModel = GlideModel;
    globalThis.GpsFix = GpsFix;
    globalThis.MagVar = MagVar;
    globalThis.GlideInputs = new Function(read('web/cockpit/glide-inputs.js') + '\nreturn GlideInputs;')();
    GlidePanel = new Function(read('web/cockpit/glide-panel.js') + '\nreturn GlidePanel;')();
    document.body.innerHTML = '<div id="h"></div>';
    host = document.getElementById('h');
});

/** Render _view for a plan the way render() does, and read the rows back. */
function show(plan, c, { settings = S(), noSuitable = false, icao = 'KLKR', gw = { wind: CASES[c].wind, label: 'x' } } = {}) {
    const panel = new GlidePanel(host, { icao });
    panel._S = settings;
    panel._apt = { noSuitable };
    panel._rwy = { wind: { kind: 'none' }, label: '' };
    host.innerHTML = panel._view(plan, sitFor(c), gw).html;
    const rows = {};
    for (const lbl of host.querySelectorAll('.glide-lbl')) {
        rows[lbl.textContent] = [...lbl.nextElementSibling.children].map((e) => e.textContent);
    }
    return {
        verdict: host.querySelector('.glide-verdict').textContent,
        sub: host.querySelector('.glide-sub')?.textContent ?? null,
        tone: ['ok', 'caution', 'danger'].find((t) => host.querySelector('.glide-block').classList.contains(`glide-${t}`)),
        unknown: host.querySelector('.glide-block').classList.contains('glide-unknown'),
        rows,
    };
}
/** The rows every plan shares (HEADING, DISTANCE, AIRSPEED, DESCENT, GLIDE PATH). */
function expectCommonRows(v, p, c, settings = S()) {
    const ac = sitFor(c);
    expect(Object.keys(v.rows)).toEqual(['TO', 'HEADING', 'DISTANCE', 'AIRSPEED', 'DESCENT', 'GLIDE PATH']);
    expect(v.rows.HEADING).toEqual([`${hdg3(p.hdgTrue - MagVar.declination(ac.lat, ac.lon))}°`, turnTxt(p.turnNow, settings.pilot.onCourseDeg)]);
    expect(v.rows.DISTANCE).toEqual([`${p.legNm.toFixed(1)} nm`]);
    expect(v.rows.AIRSPEED).toEqual([`${fmt(settings.aircraft.glide_ias_kt)} KIAS`]);
    expect(v.rows.DESCENT).toEqual([`${fmt(p.target)} fpm`, nowTxt(p)]);
    expect(v.rows['GLIDE PATH']).toEqual([pathTxt(p.spare)]);
}

describe('golden KLKR cases -> displayed rows', () => {
    it('the golden numbers still come out of the real model (spare / legNm / target within the reference tolerance)', () => {
        for (const [c, pd, kind, spare, leg, target] of Object.values(GOLDEN)) {
            const p = planFor(c, pd);
            expect(p.kind).toBe(kind);
            expect(Math.abs(p.spare - spare)).toBeLessThanOrEqual(1);
            expect(Math.abs(p.legNm - leg)).toBeLessThanOrEqual(0.01);
            expect(Math.abs(p.target - target)).toBeLessThanOrEqual(1);
        }
    });

    it.each([['B-direct'], ['A-planB'], ['F-planB']])('GLIDE OK (golden %s, the nearest part of the runway): every row, green', (key) => {
        const [c, pd, , spare, leg] = GOLDEN[key];
        const p = planFor(c, pd);
        const v = show(p, c);
        expect(p.kind).toBe('direct');
        expect(p.spare).toBeGreaterThanOrEqual(0);
        expect(v.tone).toBe('ok');
        expect(v.verdict).toBe(`✓ GLIDE OK · ${hiLo(p.spare)}`);
        expect(Math.abs(N(p.spare) - spare)).toBeLessThanOrEqual(1);
        expect(v.sub).toBeNull();
        expect(v.rows.TO).toEqual(['RWY 06/24', 'nearest part']);
        expect(v.rows.DISTANCE).toEqual([`${leg.toFixed(1)} nm`]);
        expectCommonRows(v, p, c);
    });

    it('on final (kind final): GLIDE OK / CANNOT REACH, TO "RWY 24" + "on final", every row', () => {
        // 0.5 nm before the 24 end on its extended centreline, tracking 233
        const half = RWY_LEN / 2 / FT_PER_NM, back = fromPolar(53, half + 0.5);
        CASES.FIN = { pos: back, alt: 900, trk: 233, gs: 70, vs: -400, wind: null };
        try {
            const p = planFor('FIN', false);
            expect(p.kind).toBe('final');
            const v = show(p, 'FIN');
            expect(v.tone).toBe('ok');
            expect(v.verdict).toBe(`✓ GLIDE OK · ${hiLo(p.spare)}`);
            expect(v.rows.TO).toEqual(['RWY 24', 'on final']);
            expectCommonRows(v, p, 'FIN');
            CASES.FIN.alt = ELEV + 20;
            const lo = planFor('FIN', false);
            expect(lo.kind).toBe('final');
            const vl = show(lo, 'FIN');
            expect(vl.tone).toBe('danger');
            expect(vl.verdict).toBe(`✗ CANNOT REACH KLKR · ${hiLo(lo.spare)}`);
            expect(vl.rows.TO).toEqual(['RWY 24', 'on final']);
        } finally {
            delete CASES.FIN;
        }
    });

    it('over the runway (kind over): "✓ OVER RWY 06/24", green, no rows, no height', () => {
        CASES.OVR = { pos: { x: 0, y: 0 }, alt: ELEV + 30, trk: 233, gs: 40, vs: 0, wind: null };
        try {
            const p = planFor('OVR', false);
            expect(p.kind).toBe('over');
            const v = show(p, 'OVR');
            expect(v.tone).toBe('ok');
            expect(v.verdict).toBe('✓ OVER RWY 06/24');
            expect(v.sub).toBeNull();
            expect(v.rows).toEqual({});
            expect(host.querySelector('.glide-grid')).toBeNull();
            // no runway id: plain "OVER RUNWAY"
            expect(show({ ...p, runwayId: null }, 'OVR').verdict).toBe('✓ OVER RUNWAY');
        } finally {
            delete CASES.OVR;
        }
    });

    it('the glide wind text is amber only when the headwind is assumed', () => {
        const p = planFor('A', false);
        show(p, 'A', { gw: { wind: { headKt: 4 }, label: 'METAR KLKR VRB/04 (8 min) · surface', assumed: false } });
        expect(host.querySelector('.glide-wind .glide-amber')).toBeNull();
        expect(host.querySelector('.glide-wind').textContent).toBe('Glide: METAR KLKR VRB/04 (8 min) · surface');
        show(p, 'A', { gw: { wind: null, label: 'NO CURRENT WINDS ALOFT · 10 kt headwind assumed', assumed: true } });
        expect(host.querySelector('.glide-wind .glide-amber').textContent).toBe('Glide: NO CURRENT WINDS ALOFT · 10 kt headwind assumed');
    });

    it.each([['C-cannot'], ['D-cannot'], ['E-cannot']])('CANNOT REACH (golden %s): every row, GLIDE PATH negative and red', (key) => {
        const [c, pd, , spare] = GOLDEN[key];
        const p = planFor(c, pd);
        const v = show(p, c);
        expect(p.spare).toBeLessThan(0);
        expect(v.tone).toBe('danger');
        expect(v.verdict).toBe(`✗ CANNOT REACH KLKR · ${hiLo(p.spare)}`);
        expect(Math.abs(N(p.spare) - -spare)).toBeLessThanOrEqual(1);
        expect(v.rows.TO).toEqual(['RWY 06/24', 'nearest part']);
        expect(v.rows['GLIDE PATH'][0].startsWith('−')).toBe(true);
        expect(host.querySelector('.glide-path').classList.contains('glide-neg')).toBe(true);
        expectCommonRows(v, p, c);
    });

    it('golden D (vs -500): measured 500 fpm against the shown target 448 -> red "52 too steep"; B at 300 fpm -> "shallower"', () => {
        const p = planFor('D', false);
        expect(p.measured).toBe(500);
        expect(Math.abs(p.target - 448)).toBeLessThanOrEqual(1);              // golden
        let v = show(p, 'D');
        expect(v.rows.DESCENT[0]).toBe(`${fmt(p.target)} fpm`);
        expect(v.rows.DESCENT[1]).toBe(`now 500 fpm · ${fmt(500 - Math.round(p.target))} too steep`);
        expect(host.querySelector('.glide-now').classList.contains('glide-now-steep')).toBe(true);
        // the comparison uses the number shown above it, never targetNow
        expect(Math.round(p.targetNow)).not.toBe(Math.round(p.target));
        const p2 = planFor('B', false, klkr(), -300);
        expect(p2.measured).toBe(300);
        v = show(p2, 'B');
        expect(v.rows.DESCENT[1]).toBe(`now 300 fpm · ${fmt(Math.round(p2.target) - 300)} shallower`);
        expect(host.querySelector('.glide-now').classList.contains('glide-now-steep')).toBe(false);
    });

    it('the X in "now M fpm · X …" is M minus the DESCENT number shown (Dana\'s board: 820 / now 760 · 60 shallower)', () => {
        const fake = { kind: 'final', endId: '24', runwayId: '06/24', spare: 240, hdgTrue: 249, legNm: 4.7, target: 820,
            targetNow: 1199, measured: 760, turnNow: -32, tailwindKt: 0 };
        const v = show(fake, 'B');
        expect(v.rows.DESCENT).toEqual(['820 fpm', 'now 760 fpm · 60 shallower']);
        const steep = show({ ...fake, target: 450, targetNow: 100, measured: 750 }, 'B');
        expect(steep.rows.DESCENT).toEqual(['450 fpm', 'now 750 fpm · 300 too steep']);
    });

    it('no measured rate (vs unknown) -> "now —"', () => {
        const p = planFor('B', false, klkr(), null);
        expect(p.measured).toBeNull();
        expect(show(p, 'B').rows.DESCENT).toEqual([`${fmt(p.target)} fpm`, 'now —']);
    });

    it('AIRSPEED follows the validated setting (72 KIAS); an out-of-range one shows the default 65', () => {
        const GI = globalThis.GlideInputs;
        const s72 = GI.validate({ aircraft: { glide_ias_kt: 72 } });
        expect(show(planFor('B', false, klkr(), 0, s72), 'B', { settings: s72 }).rows.AIRSPEED).toEqual(['72 KIAS']);
        const sBad = GI.validate({ aircraft: { glide_ias_kt: 500 } });
        expect(show(planFor('B', false, klkr(), 0, sBad), 'B', { settings: sBad }).rows.AIRSPEED).toEqual(['65 KIAS']);
    });
});

describe('reference-point states (no runway ends known / no suitable runway)', () => {
    it('RUNWAY POSITION NOT KNOWN, high (golden A position, no ends): grey frame, "· N ft high", TO = ICAO, no sub line', () => {
        const p = planFor('A', false, klkr({ ends: false }));
        expect(p.kind).toBe('ref');
        expect(p.spare).toBeGreaterThanOrEqual(0);
        const v = show(p, 'A');
        expect(v.unknown).toBe(true);
        expect(v.tone).toBe('caution');
        expect(v.verdict).toBe(`RUNWAY POSITION NOT KNOWN · steer to the airport · ${hiLo(p.spare)}`);
        expect(v.sub).toBeNull();
        expect(v.rows.TO).toEqual(['KLKR']);
        expectCommonRows(v, p, 'A');
    });

    it('RUNWAY POSITION NOT KNOWN, low (golden E position): "✗ CANNOT REACH KLKR · N ft low", the state on the sub line', () => {
        const p = planFor('E', false, klkr({ ends: false }));
        expect(p.spare).toBeLessThan(0);
        const v = show(p, 'E');
        expect(v.unknown).toBe(true);
        expect(v.tone).toBe('danger');
        expect(v.verdict).toBe(`✗ CANNOT REACH KLKR · ${hiLo(p.spare)}`);
        expect(v.sub).toBe('RUNWAY POSITION NOT KNOWN · steer to the airport');
        expect(v.rows.TO).toEqual(['KLKR']);
        expectCommonRows(v, p, 'E');
    });

    it('NO SUITABLE RUNWAY: same, with that state', () => {
        const hi = planFor('A', false, klkr({ ends: false }));
        let v = show(hi, 'A', { noSuitable: true });
        expect(v.verdict).toBe(`NO SUITABLE RUNWAY · steer to the airport · ${hiLo(hi.spare)}`);
        expect(v.sub).toBeNull();
        const lo = planFor('E', false, klkr({ ends: false }));
        v = show(lo, 'E', { noSuitable: true });
        expect(v.verdict).toBe(`✗ CANNOT REACH KLKR · ${hiLo(lo.spare)}`);
        expect(v.sub).toBe('NO SUITABLE RUNWAY · steer to the airport');
    });
});

describe('rounding edges', () => {
    const fake = (over) => ({
        kind: 'final', endId: '24', runwayId: '06/24', spare: 0, hdgTrue: 90, legNm: 4.75, target: 800,
        targetNow: 1234, measured: null, turnNow: 0, tailwindKt: 0, ...over,
    });
    it('spare 0.9 / -0 -> "0 ft high" / "+0 ft" (never rounded up, never "-0"); -0.1 -> "1 ft low" / "−1 ft"', () => {
        let v = show(fake({ spare: -0 }), 'B');
        expect(v.verdict).toBe('✓ GLIDE OK · 0 ft high');
        expect(v.rows['GLIDE PATH']).toEqual(['+0 ft']);
        v = show(fake({ spare: 0.9 }), 'B');
        expect(v.verdict).toBe('✓ GLIDE OK · 0 ft high');
        expect(v.rows['GLIDE PATH']).toEqual(['+0 ft']);
        v = show(fake({ kind: 'direct', spare: -0.1 }), 'B');
        expect(v.verdict).toBe('✗ CANNOT REACH KLKR · 1 ft low');
        expect(v.rows['GLIDE PATH']).toEqual(['−1 ft']);
    });
    it('thousands separators; heading 360 not 000; distance one decimal', () => {
        const ac = sitFor('B');
        const decl = MagVar.declination(ac.lat, ac.lon);
        const v = show(fake({ kind: 'direct', spare: -5051.2, hdgTrue: decl, legNm: 14.705 }), 'B');
        expect(v.verdict).toBe('✗ CANNOT REACH KLKR · 5,052 ft low');
        expect(v.rows.HEADING[0]).toBe('360°');
        expect(v.rows.DISTANCE).toEqual(['14.7 nm']);
    });
    it('equal shown numbers -> "now 800 fpm · on target" (no X, not red) - also when the raw rates differ by < 0.5', () => {
        for (const [measured, target] of [[800, 800], [800.2, 800], [799.6, 800.4]]) {
            const v = show(fake({ measured, target }), 'B');
            expect(v.rows.DESCENT).toEqual(['800 fpm', 'now 800 fpm · on target']);
            expect(host.querySelector('.glide-now').classList.contains('glide-now-steep')).toBe(false);
        }
    });
    it('X is the difference of the two numbers ON SCREEN (reviewer cases: 839 / 588 -> 251, 802 / 600 -> 202)', () => {
        // raw 838.6 / 588.4 shows 839 / 588: 251 (the raw difference 250.2 floored gave "250")
        let v = show(fake({ target: 838.6, measured: 588.4 }), 'B');
        expect(v.rows.DESCENT).toEqual(['839 fpm', 'now 588 fpm · 251 shallower']);
        // raw 801.6 / 600.4 shows 802 / 600: 202 (not "201")
        v = show(fake({ target: 801.6, measured: 600.4 }), 'B');
        expect(v.rows.DESCENT).toEqual(['802 fpm', 'now 600 fpm · 202 shallower']);
        // too steep iff the shown M is above the shown target: 450.4 / 750.6 shows 450 / 751 -> 301
        v = show(fake({ target: 450.4, measured: 750.6 }), 'B');
        expect(v.rows.DESCENT).toEqual(['450 fpm', 'now 751 fpm · 301 too steep']);
        expect(host.querySelector('.glide-now').classList.contains('glide-now-steep')).toBe(true);
        // thousands
        v = show(fake({ target: 448.3, measured: 1500.2 }), 'B');
        expect(v.rows.DESCENT).toEqual(['448 fpm', 'now 1,500 fpm · 1,052 too steep']);
        // every shown line adds up: |M - T| = X
        for (let i = 0; i < 200; i++) {
            const target = 100 + i * 7.37, measured = 50 + ((i * 53.91) % 1500);
            const [tTxt, nTxt] = show(fake({ target, measured }), 'B').rows.DESCENT;
            const T = Number(tTxt.replace(/[^\d]/g, ''));
            const m = /^now ([\d,]+) fpm · (?:([\d,]+) (shallower|too steep)|on target)$/.exec(nTxt);
            const M = Number(m[1].replace(/,/g, ''));
            if (M === T) { expect(m[2]).toBeUndefined(); continue; }
            expect(Number(m[2].replace(/,/g, ''))).toBe(Math.abs(M - T));
            expect(m[3]).toBe(M > T ? 'too steep' : 'shallower');
        }
    });
});
