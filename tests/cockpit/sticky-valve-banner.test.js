/**
 * Sticky-valve verdict banners: one over the map, one on the ENG page, both
 * reading the shared StickyValveMonitor -- dismissing either hides both. Each
 * verdict's text and colour, DISMISS presence (NO-GO none until a seen stop,
 * CHECKING none), the gap latch, re-show on a rise, the in-flight block, and
 * that data reaches the DOM only as text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = vi.fn((el, fn) => el.addEventListener('click', fn));
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const sv = new Function(read('web/shared/sticky-valve.js') + '\nreturn { StickyValve, StickyValveMonitor };')();
globalThis.StickyValve = sv.StickyValve;
globalThis.StickyValveMonitor = sv.StickyValveMonitor;
const StickyValveBanner = new Function(read('web/cockpit/sticky-valve-banner.js') + '\nreturn StickyValveBanner;')();

const CFG = StickyValve.buildConfig(
    StickyValve.validateSpec(JSON.parse(read('web/sticky_valve_spec.json'))),
    JSON.parse(read('web/phase_spec.json')));
const REFS = 'Advisory — inspect per Lycoming SB 388C; see SI 1425A / SL L197A.';

const HOT = [1200, 1180, 1210, 1190];
const COLD3 = [1200, 1180, 300, 1190];
const COOL_CHT = [100, 100, 100, 100];
const HOT_CHT = [300, 300, 300, 300];
const frame = (rpm, egt, cht = COOL_CHT, mp = 12) => ({
    data: { RPM: rpm, MP: mp, EGT1: egt[0], EGT2: egt[1], EGT3: egt[2], EGT4: egt[3], CHT1: cht[0], CHT2: cht[1], CHT3: cht[2], CHT4: cht[3] },
});
const even = (v) => [v, v, v, v];

let clock, mon, mapArea, engSlot;
function feed(secs, rpm, egt, cht, mp) {
    for (let k = 0; k < secs; k++) {
        mon.feed(frame(typeof rpm === 'function' ? rpm(k) : rpm, typeof egt === 'function' ? egt(k) : egt,
            typeof cht === 'function' ? cht(k) : cht, mp));
        clock += 1;
    }
}
const noGo = () => { feed(40, 1000, COLD3); feed(1, 1700, COLD3); };
const seenStop = () => feed(CFG.run.stop_sec + 1, 0, HOT);
const egtRamp = (k) => even(300 + 5 * Math.min(k, 120));
const chtEven = (k) => even(70 + 0.75 * Math.min(k, 300));
const chtLag4 = (k) => [...even(70 + 0.75 * Math.min(k, 300)).slice(0, 3), 70 + 0.3 * Math.min(k, 300)];
const caution = () => { feed(200, 1000, egtRamp, chtLag4); feed(1, 1700, egtRamp(200), chtLag4(200)); };

beforeEach(() => {
    clock = 0;
    mon = new StickyValveMonitor(null, { now: () => clock * 1000, cfg: CFG });
    mapArea = document.createElement('div');
    engSlot = document.createElement('div');
    document.body.append(mapArea, engSlot);
});
afterEach(() => { document.body.innerHTML = ''; });

const outer = (root) => root.querySelector('.sv-banner');
const shown = (root) => outer(root).style.display !== 'none';
const block = (root, part = 'verdict') => root.querySelector(`.sv-banner-block[data-part="${part}"]`);
const visible = (el) => el.style.display !== 'none';
const title = (root, part) => block(root, part).querySelector('.sv-banner-title').textContent;
const lines = (root, part) => [...block(root, part).querySelectorAll('.sv-banner-lines > div')].map(d => [d.className, d.textContent]);
const hint = (root, part) => { const h = block(root, part).querySelector('.sv-banner-hint'); return visible(h) ? h.textContent : null; };
const btn = (root, part) => block(root, part).querySelector('.sv-banner-dismiss');
const hasDismiss = (root, part) => visible(btn(root, part));

describe('StickyValveBanner — verdicts', () => {
    it('is hidden before the verdict trigger', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        feed(40, 1000, COLD3);                          // NO-GO finding, verdict not issued yet
        expect(shown(mapArea)).toBe(false);
        expect(outer(mapArea).classList.contains('sv-banner--map')).toBe(true);
    });

    it('NO-GO: red, "Do not take off.", the finding, references, no DISMISS', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        noGo();
        expect(shown(mapArea)).toBe(true);
        expect(block(mapArea).classList.contains('sv-banner--nogo')).toBe(true);
        expect(title(mapArea)).toBe('STICKY VALVE — NO-GO');
        expect(lines(mapArea)).toEqual([
            ['sv-banner-action', 'Do not take off.'],
            ['sv-banner-cyl', 'CYL 3 EGT 300°F vs 1190°F others (cold cylinder)'],
        ]);
        expect(hint(mapArea)).toBe(REFS);
        expect(hasDismiss(mapArea)).toBe(false);
        expect(visible(block(mapArea, 'inflight'))).toBe(false);
    });

    it('NO-GO cannot be dismissed until a seen stop; then DISMISS hides both banners', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        new StickyValveBanner(engSlot, mon, 'inline');
        noGo();
        btn(engSlot).click();                           // hidden button: a tap is ignored
        mon.dismiss();
        expect(shown(mapArea) && shown(engSlot)).toBe(true);
        feed(120, 1700, HOT);                           // recovered: still NO-GO
        expect(title(mapArea)).toBe('STICKY VALVE — NO-GO');
        expect(hasDismiss(mapArea)).toBe(false);
        seenStop();
        expect(shown(mapArea)).toBe(true);
        expect(hasDismiss(mapArea) && hasDismiss(engSlot)).toBe(true);
        btn(engSlot).click();
        expect(shown(mapArea)).toBe(false);
        expect(shown(engSlot)).toBe(false);
    });

    it('a run ended by a data gap keeps the NO-GO, without DISMISS', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        noGo();
        clock += 60;
        feed(5, 2400, HOT, HOT_CHT);
        expect(title(mapArea)).toBe('STICKY VALVE — NO-GO');
        expect(lines(mapArea)[1][1]).toBe('CYL 3 EGT 300°F vs 1190°F others (cold cylinder)');
        expect(hasDismiss(mapArea)).toBe(false);
    });

    it('CAUTION: yellow, "Check before flight.", findings, references, DISMISS; a rise re-shows it', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        caution();
        expect(block(mapArea).classList.contains('sv-banner--caution')).toBe(true);
        expect(title(mapArea)).toBe('STICKY VALVE — CAUTION');
        expect(lines(mapArea)).toEqual([
            ['sv-banner-action', 'Check before flight.'],
            ['sv-banner-cyl', 'CYL 4 CHT rose 54°F vs 135°F others (CHT lag)'],
        ]);
        expect(hint(mapArea)).toBe(REFS);
        expect(hasDismiss(mapArea)).toBe(true);
        btn(mapArea).click();
        expect(shown(mapArea)).toBe(false);
        feed(31, 1000, COLD3);                          // cylinder 3 cold: NO-GO
        expect(shown(mapArea)).toBe(true);
        expect(title(mapArea)).toBe('STICKY VALVE — NO-GO');
        expect(hasDismiss(mapArea)).toBe(false);
    });

    it('VALVES OK: green single line, DISMISS, no references', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        feed(200, 1000, egtRamp, chtEven);
        feed(1, 1700, egtRamp(200), chtEven(200));
        expect(block(mapArea).classList.contains('sv-banner--ok')).toBe(true);
        expect(title(mapArea)).toBe('VALVES OK');
        expect(lines(mapArea)).toEqual([]);
        expect(hint(mapArea)).toBe(null);
        expect(hasDismiss(mapArea)).toBe(true);
    });

    it('PARTIAL: neutral, names the rules not run, DISMISS', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        feed(70, 1000, HOT, HOT_CHT);
        feed(1, 1700, HOT, HOT_CHT);
        expect(block(mapArea).classList.contains('sv-banner--neutral')).toBe(true);
        expect(title(mapArea)).toBe('VALVE CHECK PARTIAL — not run: slow EGT heat-up, CHT lag');
        expect(hint(mapArea)).toBe(null);
        expect(hasDismiss(mapArea)).toBe(true);
    });

    it('NOT CHECKED with no rule run: neutral, a rules-not-run summary, DISMISS', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        feed(1, 1700, HOT, HOT_CHT);
        expect(block(mapArea).classList.contains('sv-banner--neutral')).toBe(true);
        expect(title(mapArea)).toBe('VALVE CHECK NOT RUN — not enough engine data for: cold cylinder (EGT), slow EGT heat-up, CHT lag, roughness');
        expect(hasDismiss(mapArea)).toBe(true);
    });

    it('NOT CHECKED when the threshold file fails to load: the reason, DISMISS', async () => {
        const failed = new StickyValveMonitor(null, { specPromise: Promise.reject(new Error('Failed to load sticky_valve_spec.json: HTTP 404')) });
        new StickyValveBanner(mapArea, failed, 'map');
        await vi.waitFor(() => expect(shown(mapArea)).toBe(true));
        expect(title(mapArea)).toBe('VALVE CHECK NOT RUN — threshold file (sticky_valve_spec.json) failed to load: Failed to load sticky_valve_spec.json: HTTP 404');
        expect(hasDismiss(mapArea)).toBe(true);
        btn(mapArea).click();
        expect(shown(mapArea)).toBe(false);
    });

    it('CHECKING: neutral, no DISMISS, resolves by itself', () => {
        const stratux = new EventTarget();
        mon = new StickyValveMonitor(null, { now: () => clock * 1000, cfg: CFG, stratuxClient: stratux });
        new StickyValveBanner(mapArea, mon, 'map');
        feed(40, 1000, egtRamp, chtEven);
        stratux.dispatchEvent(new CustomEvent('stratux:situation', { detail: { ground_speed: 6, gps_fix_quality: 1 } }));
        feed(1, 1000, egtRamp(40), chtEven(40));
        expect(block(mapArea).classList.contains('sv-banner--neutral')).toBe(true);
        expect(title(mapArea)).toBe('VALVE CHECK… checking');
        expect(hasDismiss(mapArea)).toBe(false);
        feed(150, 1000, (k) => egtRamp(41 + k), (k) => chtEven(41 + k));
        expect(title(mapArea)).toBe('VALVES OK');
    });

    it('context notes are yellow advisory lines inside the verdict', () => {
        mon.setDaysSinceFlight(45);
        new StickyValveBanner(mapArea, mon, 'map');
        noGo();
        expect(lines(mapArea).at(-1)).toEqual(['sv-banner-note', '45 days since the last flight']);
        expect(title(mapArea)).toBe('STICKY VALVE — NO-GO');   // a note never sets the verdict
    });

    it('a banner created after the verdict (ENG page opened later) shows it at once', () => {
        noGo();
        new StickyValveBanner(engSlot, mon, 'inline');
        expect(shown(engSlot)).toBe(true);
        expect(outer(engSlot).classList.contains('sv-banner--inline')).toBe(true);
    });
});

describe('StickyValveBanner — in-flight block', () => {
    const CRUISE = even(1350);
    const split = CRUISE.map((v, i) => (i === 2 ? v - 250 : i === 0 ? v + 100 : v));
    function flight() {
        feed(1, 2500, CRUISE, HOT_CHT, 26);
        feed(19, 2400, CRUISE, HOT_CHT, 24);
        feed(2, 2300, CRUISE, HOT_CHT, 18);
        feed(5, 2300, split, HOT_CHT, 18);
    }

    it('amber, the cylinders and EGT changes, references, its own DISMISS', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        flight();
        const b = block(mapArea, 'inflight');
        expect(visible(b)).toBe(true);
        expect(b.classList.contains('sv-banner--inflight')).toBe(true);
        expect(title(mapArea, 'inflight')).toBe('IN-FLIGHT: CYL 3 EGT fell 250°F while CYL 1 rose 100°F after a power reduction');
        expect(hint(mapArea, 'inflight')).toBe(REFS);
        expect(hasDismiss(mapArea, 'inflight')).toBe(true);
        const verdictShown = visible(block(mapArea));
        btn(mapArea, 'inflight').click();
        expect(visible(block(mapArea, 'inflight'))).toBe(false);
        expect(visible(block(mapArea))).toBe(verdictShown);
    });
});

describe('StickyValveBanner — text only', () => {
    const EVIL = '<img src=x onerror="window.__svPwned=1">';

    it('a value with markup in it is shown as text, never parsed', async () => {
        const fake = new EventTarget();
        fake.dismiss = vi.fn();
        let st = {
            verdict: 'CAUTION', visible: true, verdictVisible: true, inflightVisible: true, dismissable: true,
            findings: [{ rule: EVIL, cyl: 2, level: 'CAUTION', detail: {} }],
            context: [{ note: EVIL, detail: {} }],
            inflight: [{ falling: [EVIL], rising: [1], deltas: [0, 0, 0, 0] }],
            rulesNotRun: [], reason: null, phase: 'ground',
        };
        Object.defineProperty(fake, 'state', { get: () => st });
        new StickyValveBanner(mapArea, fake, 'map');
        st = { ...st, verdict: 'NOT CHECKED', reason: EVIL, findings: [] };
        fake.dispatchEvent(new CustomEvent('change'));
        expect(mapArea.querySelector('img')).toBeNull();
        expect(title(mapArea)).toBe(`VALVE CHECK NOT RUN — ${EVIL}`);
        st = { ...st, verdict: 'CAUTION', reason: null, findings: [{ rule: EVIL, cyl: 2, level: 'CAUTION', detail: {} }] };
        fake.dispatchEvent(new CustomEvent('change'));
        expect(mapArea.querySelector('img')).toBeNull();
        expect(mapArea.textContent).toContain(`CYL 2 ${EVIL}`);
        expect(lines(mapArea).at(-1)).toEqual(['sv-banner-note', EVIL]);
        expect(title(mapArea, 'inflight')).toContain(EVIL);
        await Promise.resolve();
        expect(window.__svPwned).toBeUndefined();
    });

    it('the banner source never assigns innerHTML', () => {
        expect(read('web/cockpit/sticky-valve-banner.js')).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    });
});

describe('StickyValveBanner — CSS', () => {
    const css = read('web/style.css');
    const svCss = css.slice(css.indexOf('/* ========== Sticky valve verdict'), css.indexOf('/* ========== Engine Page'));

    it('the DISMISS button is a full touch target', () => {
        const rule = css.slice(css.indexOf('.sv-banner-dismiss {'), css.indexOf('}', css.indexOf('.sv-banner-dismiss {')));
        expect(rule).toContain('min-height: var(--touch-min, 56px)');
    });

    it('each verdict colour is an existing banner token; no new hex colours', () => {
        expect(svCss).toMatch(/\.sv-banner--nogo\s*\{[^}]*var\(--color-danger\)/);
        expect(svCss).toMatch(/\.sv-banner--caution\s*\{[^}]*var\(--color-caution\)/);
        expect(svCss).toMatch(/\.sv-banner--ok\s*\{[^}]*var\(--color-success\)/);
        expect(svCss).toMatch(/\.sv-banner--neutral\s*\{/);
        expect(svCss).toMatch(/\.sv-banner--inflight\s*\{[^}]*var\(--status-warning\)/);
        expect([...new Set(svCss.match(/#[0-9a-fA-F]{3,8}\b/g) || [])]).toEqual(['#000']);
    });
});
