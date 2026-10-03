/**
 * Sticky valve warning banners: one over the map, one on the ENG page, both
 * reading the shared StickyValveMonitor -- dismissing either hides both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = vi.fn((el, fn) => el.addEventListener('click', fn));
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
globalThis.StickyValveMonitor = new Function(read('web/shared/sticky-valve.js') + '\nreturn StickyValveMonitor;')();
const StickyValveBanner = new Function(read('web/cockpit/sticky-valve-banner.js') + '\nreturn StickyValveBanner;')();

const frame = (rpm, egt) => ({ data: { RPM: rpm, EGT1: egt[0], EGT2: egt[1], EGT3: egt[2], EGT4: egt[3] } });

let clock, mon, mapArea, engSlot;
function feed(secs, rpm, egt) {
    for (let t = 0; t < secs; t++) { mon.feed(frame(rpm, egt)); clock += 1; }
}

beforeEach(() => {
    clock = 0;
    mon = new StickyValveMonitor(null, { now: () => clock * 1000 });
    mapArea = document.createElement('div');
    engSlot = document.createElement('div');
    document.body.append(mapArea, engSlot);
});
afterEach(() => { document.body.innerHTML = ''; });

const shown = (root) => root.querySelector('.sv-banner').style.display !== 'none';

describe('StickyValveBanner', () => {
    it('is hidden until the monitor alerts, then names the cylinder and both EGTs', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        expect(shown(mapArea)).toBe(false);
        feed(1, 1000, [80, 80, 80, 80]);
        feed(31, 1000, [1200, 1180, 300, 1190]);
        expect(shown(mapArea)).toBe(true);
        expect(mapArea.querySelector('.sv-banner').classList.contains('sv-banner--map')).toBe(true);
        expect(mapArea.querySelector('.sv-banner-title').textContent).toBe('STICKY VALVE WARNING');
        expect(mapArea.querySelector('.sv-banner-cyl').textContent).toBe('CYL 3 EGT 300°F vs 1190°F others');
    });

    it('DISMISS on either banner hides both', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        new StickyValveBanner(engSlot, mon, 'inline');
        feed(1, 1000, [80, 80, 80, 80]);
        feed(31, 1000, [1200, 1180, 300, 1190]);
        expect(shown(mapArea) && shown(engSlot)).toBe(true);
        engSlot.querySelector('.sv-banner-dismiss').click();
        expect(shown(mapArea)).toBe(false);
        expect(shown(engSlot)).toBe(false);
    });

    it('a banner created after the alert (ENG page opened later) shows it at once', () => {
        feed(1, 1000, [80, 80, 80, 80]);
        feed(31, 1000, [1200, 1180, 300, 1190]);
        new StickyValveBanner(engSlot, mon, 'inline');
        expect(shown(engSlot)).toBe(true);
    });

    it('a recovered cylinder stays listed, marked recovered', () => {
        new StickyValveBanner(mapArea, mon, 'map');
        feed(1, 1000, [80, 80, 80, 80]);
        feed(31, 1000, [1200, 1180, 300, 1190]);
        feed(3, 1000, [1200, 1180, 1150, 1190]);
        const cyl = mapArea.querySelector('.sv-banner-cyl');
        expect(cyl.classList.contains('sv-banner-cyl--recovered')).toBe(true);
        expect(cyl.textContent).toMatch(/now recovered/);
        expect(shown(mapArea)).toBe(true);
    });

    it('the DISMISS button is a full touch target', () => {
        const css = read('web/style.css');
        const rule = css.slice(css.indexOf('.sv-banner-dismiss {'), css.indexOf('}', css.indexOf('.sv-banner-dismiss {')));
        expect(rule).toContain('min-height: var(--touch-min, 56px)');
    });
});
