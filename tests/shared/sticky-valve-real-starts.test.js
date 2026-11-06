/**
 * The sticky-valve check against real engine starts recorded on this airframe
 * (tests/fixtures/sticky-valve/, 1 Hz from 30 s before RPM first exceeds 500;
 * see README.md and REPORT.md there -- 56 recorded starts, none alerted under
 * the Pi rule, the lowest cylinder ratio seen was 0.787 against the 0.50
 * threshold). The fixtures carry RPM and EGT only: no MP, CHT or ground speed,
 * so R2/R3 (need CHT) and R4 (needs MP) cannot run and a start at best reads
 * PARTIAL. What matters here is that no start gives a NO-GO.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const { StickyValve, StickyValveMonitor } = new Function(
    read('web/shared/sticky-valve.js') + '\nreturn { StickyValve, StickyValveMonitor };')();

const CFG = StickyValve.buildConfig(
    StickyValve.validateSpec(JSON.parse(read('web/sticky_valve_spec.json'))),
    JSON.parse(read('web/phase_spec.json')));

function loadStart(n) {
    const [header, ...rows] = read(`tests/fixtures/sticky-valve/sticky-valve-start-${n}.csv`).trim().split('\n');
    expect(header).toBe('t_sec,rpm,egt1,egt2,egt3,egt4');
    return rows.map(r => {
        const [t, rpm, ...egt] = r.split(',').map(Number);
        return { t, rpm, egt };
    });
}

/** Replay rows through a monitor; mutate(row) may alter the EGTs. */
function replay(rows, mutate = (r) => r.egt) {
    let clock = 0;
    const mon = new StickyValveMonitor(null, { now: () => clock * 1000, cfg: CFG });
    const findings = [];
    mon.addEventListener('finding', (e) => findings.push({ ...e.detail, at: clock }));
    for (const r of rows) {
        clock = r.t;
        const egt = mutate(r);
        mon.feed({ data: { RPM: r.rpm, EGT1: egt[0], EGT2: egt[1], EGT3: egt[2], EGT4: egt[3] } });
    }
    return { mon, findings };
}

const STARTS = {
    1: 'coldest recorded start (EGTs ~70°F)',
    2: 'typical start',
    3: 'closest to alerting, with a failed first start attempt',
};

describe('real engine starts on N194JT', () => {
    for (const [n, what] of Object.entries(STARTS)) {
        it(`start ${n} (${what}) gives no NO-GO`, () => {
            const rows = loadStart(n);
            const { mon, findings } = replay(rows);
            const st = mon.state;
            // Recorded in the test output: each start's final verdict.
            console.log(`[sticky-valve real start ${n}] final verdict: ${st.verdict}; `
                + `rules not run: ${st.rulesNotRun.join(', ') || 'none'}; findings: ${findings.length}`);
            expect(findings.filter(f => f.level === 'NO-GO')).toEqual([]);
            expect(st.verdict).not.toBe('NO-GO');
            // The check did arm and look: it saw the engine start and gave a verdict.
            expect(rows.some(r => r.rpm > CFG.run.start_rpm)).toBe(true);
            expect(st.verdict).not.toBeNull();
        });
    }

    it('start 2 with cylinder 3 held at 40% of the others gives NO-GO, persist_sec after the run settles', () => {
        const rows = loadStart(2);
        const { mon, findings } = replay(rows, (r) => {
            const others = (r.egt[0] + r.egt[1] + r.egt[3]) / 3;
            return r.rpm > 500 ? [r.egt[0], r.egt[1], Math.round(others * 0.4), r.egt[3]] : r.egt;
        });
        expect(findings.map(f => [f.rule, f.level, f.cyl])).toEqual([['cold_cylinder', 'NO-GO', 3]]);
        // The fixture starts 30 s before the start, so the run is not settled at
        // once: the rules run from settle_sec after RPM first exceeds start_rpm
        // (t=30 -> 40; the others are already past 200°F), and R1 fires persist_sec
        // later. (The Pi rule judged from the start itself: t=60.)
        const startT = rows.find(r => r.rpm > CFG.run.start_rpm).t;
        const expected = startT + CFG.run.settle_sec + CFG.cold_cylinder.persist_sec;
        expect(expected).toBe(70);
        expect(findings[0].at).toBe(expected);
        expect(mon.state.verdict).toBe('NO-GO');
    });

    it('start 2 with cylinder 2 going cold 10 minutes in still gives NO-GO: the ground watch runs to takeoff power', () => {
        // The Pi rule stopped looking 10 minutes after start; the new check watches
        // until takeoff power (design: "It now applies through run-up").
        const rows = loadStart(2);
        const coldFrom = 30 + 10 * 60 + 5;
        const { mon, findings } = replay(rows, (r) => (r.t > coldFrom ? [r.egt[0], 300, r.egt[2], r.egt[3]] : r.egt));
        expect(findings.map(f => [f.rule, f.level, f.cyl])).toEqual([['cold_cylinder', 'NO-GO', 2]]);
        expect(findings[0].at).toBeGreaterThan(coldFrom);
        expect(mon.state.verdict).toBe('NO-GO');
    });
});
