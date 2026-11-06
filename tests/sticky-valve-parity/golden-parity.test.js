/**
 * Golden parity: the JS StickyValveDetector (web/shared/sticky-valve.js) must
 * reproduce, event for event, what the Python reference
 * (~/engine_analysis/sticky_valve.py) produced for the same samples.
 * Fixtures are frozen by tools/freeze_sticky_valve_parity_fixture.py (see
 * fixtures/README.md). A mismatch is a port bug: fix the JS, never the fixture.
 *
 * Comparison (ruling R-11): structure and key sets exactly; strings, booleans
 * and null exactly; numbers with |a - b| <= 1e-6, treating -0 as 0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';

const ROOT = join(__dirname, '../..');
const FIXTURES = join(__dirname, 'fixtures');
const read = (p) => readFileSync(p, 'utf8');
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const { StickyValve, StickyValveDetector } = new Function(
    read(join(ROOT, 'web/shared/sticky-valve.js')) + '\nreturn { StickyValve, StickyValveDetector };')();

const SPEC_PATH = join(ROOT, 'web/sticky_valve_spec.json');
const PHASE_SPEC_PATH = join(ROOT, 'web/phase_spec.json');
const SPEC = JSON.parse(read(SPEC_PATH));
const PHASE_SPEC = JSON.parse(read(PHASE_SPEC_PATH));

const NAMES = [
    '20261101_KLKR-KLKR', '2025-07-02_KLKR-KLKR', 'cold_flight',
    'stuck_cyl3', 'cht_lag_cyl4', 'inflight_divergence',
    'nan_dropouts', 'holes_and_clock', 'no_gps', 'hot_start', 'rough_idle',
];
const TOL = 1e-6;

/** Recursive comparator: returns a list of "path: reason" differences (first N). */
function diff(actual, expected, path = '', out = []) {
    if (out.length >= 10) return out;
    const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    const ta = typeOf(actual), te = typeOf(expected);
    if (ta !== te) { out.push(`${path}: type ${ta} (js=${JSON.stringify(actual)}) vs ${te} (py=${JSON.stringify(expected)})`); return out; }
    if (ta === 'number') {
        if (Number.isNaN(actual) || Number.isNaN(expected)) {
            if (!(Number.isNaN(actual) && Number.isNaN(expected))) out.push(`${path}: js=${actual} py=${expected}`);
        } else if (Math.abs(actual - expected) > TOL) {   // -0 and 0 differ by 0
            out.push(`${path}: js=${actual} py=${expected}`);
        }
    } else if (ta === 'array') {
        if (actual.length !== expected.length) out.push(`${path}: length js=${actual.length} py=${expected.length}`);
        for (let i = 0; i < Math.min(actual.length, expected.length); i++) diff(actual[i], expected[i], `${path}[${i}]`, out);
    } else if (ta === 'object') {
        const ka = Object.keys(actual).sort(), ke = Object.keys(expected).sort();
        for (const k of ke) if (!(k in actual)) out.push(`${path}.${k}: missing in js`);
        for (const k of ka) if (!(k in expected)) out.push(`${path}.${k}: unexpected in js`);
        for (const k of ke) if (k in actual) diff(actual[k], expected[k], `${path}.${k}`, out);
    } else if (actual !== expected) {
        out.push(`${path}: js=${JSON.stringify(actual)} py=${JSON.stringify(expected)}`);
    }
    return out;
}

/** Event-level diff whose messages name the event index (and the type). */
function diffEvents(actual, expected) {
    const out = [];
    if (actual.length !== expected.length) {
        out.push(`event count: js=${actual.length} py=${expected.length}`);
    }
    for (let i = 0; i < Math.min(actual.length, expected.length) && out.length < 10; i++) {
        for (const d of diff(actual[i], expected[i], `events[${i}] (${expected[i].type})`)) out.push(d);
    }
    return out.slice(0, 10);
}

// An empty CSV cell is a missing value (NaN), never 0: csv-parse is used without
// `cast`, and the conversion is explicit here.
const num = (s) => (s === '' ? NaN : Number(s));

function samplesFrom(name) {
    const rows = parse(read(join(FIXTURES, `${name}.csv`)), { columns: true });
    return rows.map((r) => ({
        t: num(r.t), rpm: num(r.rpm), mp: num(r.mp), ff: num(r.ff),
        egt: [num(r.egt1), num(r.egt2), num(r.egt3), num(r.egt4)],
        cht: [num(r.cht1), num(r.cht2), num(r.cht3), num(r.cht4)],
        carb: num(r.carb), gs: num(r.gs),
    }));
}

function runJs(samples) {
    const cfg = StickyValve.buildConfig(SPEC, PHASE_SPEC);
    const det = new StickyValveDetector(cfg, { daysSinceFlight: null });
    const events = [];
    for (const s of samples) events.push(...det.sample(s));
    events.push(...det.finish(samples[samples.length - 1].t));
    return events;
}

describe('comparator (guards against a vacuous parity test)', () => {
    it('accepts -0 vs 0 and sub-tolerance numeric noise', () => {
        expect(diff({ a: -0, b: 1 }, { a: 0, b: 1 + 1e-9 })).toEqual([]);
    });
    it('reports a number change with its key path and event index', () => {
        const a = [{ type: 'finding', detail: { ratio: 0.5 } }];
        const e = [{ type: 'finding', detail: { ratio: 0.5 + 1e-3 } }];
        const d = diffEvents(a, e);
        expect(d).toHaveLength(1);
        expect(d[0]).toMatch(/^events\[0\] \(finding\)\.detail\.ratio: js=0\.5 py=0\.501$/);
    });
    it('reports key-set, type, string and length differences', () => {
        expect(diff({ a: 1 }, { a: 1, b: 2 })).toEqual(['.b: missing in js']);
        expect(diff({ a: 1, c: 1 }, { a: 1 })).toEqual(['.c: unexpected in js']);
        expect(diff({ a: null }, { a: 0 })[0]).toMatch(/type null/);
        expect(diff({ a: 'x' }, { a: 'y' })[0]).toMatch(/^\.a:/);
        expect(diff([1], [1, 2])[0]).toMatch(/length/);
    });
});

describe('missing-value path (guards against fixtures that silently lose their NaNs)', () => {
    const nanCount = (name) => samplesFrom(name).reduce((n, s) =>
        n + [s.t, s.rpm, s.mp, s.ff, s.carb, s.gs, ...s.egt, ...s.cht].filter(Number.isNaN).length, 0);
    it('nan_dropouts: empty cells parse to NaN (1 EGT + 12 CHT + 1 RPM + 1 MP)', () => {
        expect(nanCount('nan_dropouts')).toBe(15);
        expect(num('')).toBeNaN();
    });
    it('no_gps: gs is NaN on every row', () => {
        const s = samplesFrom('no_gps');
        expect(s.every((x) => Number.isNaN(x.gs))).toBe(true);
    });
    it('real flights keep no NaN in t/rpm', () => {
        for (const n of ['cold_flight']) expect(samplesFrom(n).every((x) => !Number.isNaN(x.t) && !Number.isNaN(x.rpm))).toBe(true);
    });
});

describe('golden parity: JS StickyValveDetector vs frozen Python reference', () => {
    for (const name of NAMES) {
        describe(name, () => {
            const golden = JSON.parse(read(join(FIXTURES, `${name}.json`)));

            it('spec files match the ones Python used (sha256)', () => {
                expect(sha256(SPEC_PATH), 'web/sticky_valve_spec.json drifted from engine_analysis').toBe(golden.spec_sha256);
                expect(sha256(PHASE_SPEC_PATH), 'web/phase_spec.json drifted from engine_analysis').toBe(golden.phase_spec_sha256);
            });

            it('pins the Python detector it was frozen from (detector_sha256)', () => {
                // engine_analysis tests/test_sticky_valve_parity_pin.py compares this
                // with sticky_valve.py: a Python-only change fails there until refrozen.
                expect(golden.detector_sha256).toMatch(/^[0-9a-f]{64}$/);
            });

            it('produces exactly the Python event list', () => {
                const samples = samplesFrom(name);
                expect(samples.length).toBeGreaterThan(0);
                const events = runJs(samples);
                const diffs = diffEvents(events, golden.events);
                expect(diffs, `${name}: JS differs from Python:\n  ${diffs.join('\n  ')}`).toEqual([]);
            });
        });
    }
});
