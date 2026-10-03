/**
 * The sticky-valve rule against real engine starts recorded on this airframe
 * (tests/fixtures/sticky-valve/, 1 Hz from 30 s before RPM first exceeds 500;
 * see README.md and REPORT.md there -- 56 recorded starts, none alerted, the
 * lowest cylinder ratio seen was 0.787 against the 0.50 threshold).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const { StickyValveMonitor } = new Function(
    read('web/shared/sticky-valve.js') + '\nreturn { StickyValveMonitor };')();

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
    const mon = new StickyValveMonitor(null, { now: () => clock * 1000 });
    const alerts = [];
    mon.addEventListener('alert', (e) => alerts.push({ ...e.detail, t: clock }));
    for (const r of rows) {
        clock = r.t;
        const egt = mutate(r);
        mon.feed({ data: { RPM: r.rpm, EGT1: egt[0], EGT2: egt[1], EGT3: egt[2], EGT4: egt[3] } });
    }
    return { mon, alerts };
}

const STARTS = {
    1: 'coldest recorded start (EGTs ~70°F)',
    2: 'typical start',
    3: 'closest to alerting, with a failed first start attempt',
};

describe('real engine starts on N194JT', () => {
    for (const [n, what] of Object.entries(STARTS)) {
        it(`start ${n} (${what}) does not alert`, () => {
            const rows = loadStart(n);
            const { mon, alerts } = replay(rows);
            expect(alerts).toEqual([]);
            expect(mon.state.visible).toBe(false);
            // The rule did arm and look: it saw the engine start.
            expect(rows.some(r => r.rpm > 500)).toBe(true);
        });
    }

    it('start 2 with cylinder 3 held at 40% of the others alerts, 30 s after the others pass 200°F', () => {
        const rows = loadStart(2);
        const { alerts } = replay(rows, (r) => {
            const others = (r.egt[0] + r.egt[1] + r.egt[3]) / 3;
            return r.rpm > 500 ? [r.egt[0], r.egt[1], Math.round(others * 0.4), r.egt[3]] : r.egt;
        });
        expect(alerts.map(a => a.cyl)).toEqual([3]);
        // Others pass 200°F about 1 s after start (t=31); the alert follows 30 s later.
        expect(alerts[0].t).toBeGreaterThanOrEqual(60);
        expect(alerts[0].t).toBeLessThanOrEqual(65);
    });

    it('start 2 with cylinder 2 going cold only 12 minutes in (after the window) does not alert', () => {
        const rows = loadStart(2);
        const { alerts } = replay(rows, (r) => (r.t > 30 + 10 * 60 + 5 ? [r.egt[0], 300, r.egt[2], r.egt[3]] : r.egt));
        expect(alerts).toEqual([]);
    });
});
