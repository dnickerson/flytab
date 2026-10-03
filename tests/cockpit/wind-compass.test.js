/**
 * WindCompass — pure computational units backing the Wind tab in
 * airport-popup.js (compass rose + runway headwind/crosswind + manual
 * wind entry). DOM/SVG wiring is verified in-browser, not here — these
 * tests cover only the parts that are pure functions of their inputs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.wireTap = new Function(read('web/shared/tap-utils.js') + '\nreturn wireTap;')();
const { WindCompass, WindNumpad } = new Function(read('web/cockpit/wind-compass.js') + '\nreturn { WindCompass, WindNumpad };')();

describe('WindCompass.headingToXY', () => {
    const cx = 150, cy = 150, r = 100;

    it('places North (0) at the top', () => {
        const p = WindCompass.headingToXY(0, r, cx, cy);
        expect(p.x).toBeCloseTo(150);
        expect(p.y).toBeCloseTo(50);
    });

    it('places East (90) at the right', () => {
        const p = WindCompass.headingToXY(90, r, cx, cy);
        expect(p.x).toBeCloseTo(250);
        expect(p.y).toBeCloseTo(150);
    });

    it('places South (180) at the bottom', () => {
        const p = WindCompass.headingToXY(180, r, cx, cy);
        expect(p.x).toBeCloseTo(150);
        expect(p.y).toBeCloseTo(250);
    });

    it('places West (270) at the left', () => {
        const p = WindCompass.headingToXY(270, r, cx, cy);
        expect(p.x).toBeCloseTo(50);
        expect(p.y).toBeCloseTo(150);
    });

    it('wraps 360 to the same point as 0', () => {
        const p0 = WindCompass.headingToXY(0, r, cx, cy);
        const p360 = WindCompass.headingToXY(360, r, cx, cy);
        expect(p360.x).toBeCloseTo(p0.x);
        expect(p360.y).toBeCloseTo(p0.y);
    });
});

describe('WindCompass.parseRunwayEnds', () => {
    it('splits a dual-end runway id into two ends with headings', () => {
        const ends = WindCompass.parseRunwayEnds([{ id: '08L/26R', length_ft: 5000 }]);
        expect(ends).toEqual([
            { label: '08L', hdg: 80, length_ft: 5000, fromNumber: true },
            { label: '26R', hdg: 260, length_ft: 5000, fromNumber: true },
        ]);
    });

    it('handles a runway with no L/R/C suffix', () => {
        const ends = WindCompass.parseRunwayEnds([{ id: '09/27', length_ft: 4000 }]);
        expect(ends).toEqual([
            { label: '09', hdg: 90, length_ft: 4000, fromNumber: true },
            { label: '27', hdg: 270, length_ft: 4000, fromNumber: true },
        ]);
    });

    it('handles a single-end-only runway id', () => {
        const ends = WindCompass.parseRunwayEnds([{ id: '18', length_ft: 3000 }]);
        expect(ends).toEqual([{ label: '18', hdg: 180, length_ft: 3000, fromNumber: true }]);
    });

    it('skips a malformed runway id instead of throwing', () => {
        const ends = WindCompass.parseRunwayEnds([{ id: 'HELIPAD', length_ft: 100 }]);
        expect(ends).toEqual([]);
    });

    it('combines ends from multiple runways', () => {
        const ends = WindCompass.parseRunwayEnds([
            { id: '08L/26R', length_ft: 5000 },
            { id: '13/31', length_ft: 3500 },
        ]);
        expect(ends.map(e => e.label)).toEqual(['08L', '26R', '13', '31']);
    });

    it('returns an empty array for no runways', () => {
        expect(WindCompass.parseRunwayEnds([])).toEqual([]);
        expect(WindCompass.parseRunwayEnds(undefined)).toEqual([]);
    });
});

describe('WindCompass.computeWindComponents', () => {
    it('is pure headwind when wind blows straight down the runway heading', () => {
        const [end] = WindCompass.computeWindComponents(
            [{ label: '08', hdg: 80 }], 80, 15, 15);
        expect(end.headwind).toBe(15);
        expect(end.crosswind).toBe(0);
    });

    it('is pure crosswind when wind is 90 degrees off the runway heading', () => {
        const [end] = WindCompass.computeWindComponents(
            [{ label: '08', hdg: 80 }], 170, 15, 15);
        expect(end.headwind).toBe(0);
        expect(end.crosswind).toBe(15);
    });

    it('is a negative (tailwind) headwind when wind is opposite the runway heading', () => {
        const [end] = WindCompass.computeWindComponents(
            [{ label: '08', hdg: 80 }], 260, 15, 15);
        expect(end.headwind).toBe(-15);
        expect(end.crosswind).toBe(0);
    });

    it('computes gust crosswind from gustSpd separately from steady crosswind', () => {
        const [end] = WindCompass.computeWindComponents(
            [{ label: '08', hdg: 80 }], 170, 10, 20);
        expect(end.crosswind).toBe(10);
        expect(end.gustXwind).toBe(20);
    });

    it('defaults gust to the steady speed when no gust is reported', () => {
        const [end] = WindCompass.computeWindComponents(
            [{ label: '08', hdg: 80 }], 170, 10, null);
        expect(end.gustXwind).toBe(10);
    });

    it('marks the end with the highest headwind as best and sorts it first', () => {
        const ends = WindCompass.computeWindComponents(
            [{ label: '08', hdg: 80 }, { label: '26', hdg: 260 }], 260, 15, 15);
        expect(ends[0].label).toBe('26');
        expect(ends[0].isBest).toBe(true);
        expect(ends[1].isBest).toBe(false);
    });
});

describe('WindNumpad', () => {
    it('accumulates pressed digits into a string', () => {
        const np = new WindNumpad(3);
        np.press('2'); np.press('7'); np.press('0');
        expect(np.digits).toBe('270');
    });

    it('ignores presses beyond maxLen', () => {
        const np = new WindNumpad(3);
        np.press('2'); np.press('7'); np.press('0'); np.press('9');
        expect(np.digits).toBe('270');
    });

    it('backspace removes the last digit', () => {
        const np = new WindNumpad(3);
        np.press('2'); np.press('7');
        np.backspace();
        expect(np.digits).toBe('2');
    });

    it('backspace on empty digits stays empty, not an error', () => {
        const np = new WindNumpad(3);
        expect(() => np.backspace()).not.toThrow();
        expect(np.digits).toBe('');
    });

    it('value is null when no digits have been entered', () => {
        const np = new WindNumpad(3);
        expect(np.value).toBeNull();
    });

    it('value is the parsed integer once digits exist', () => {
        const np = new WindNumpad(3);
        np.press('2'); np.press('7'); np.press('0');
        expect(np.value).toBe(270);
    });

    it('clear resets digits back to empty', () => {
        const np = new WindNumpad(3);
        np.press('9'); np.press('9');
        np.clear();
        expect(np.digits).toBe('');
        expect(np.value).toBeNull();
    });
});

describe('WindCompass instance render()', () => {
    const runways = [{ id: '08L/26R', length_ft: 5000 }, { id: '13/31', length_ft: 3000 }];
    const wxWithWind = { metar: { decoded: { wind_dir: 260, wind_speed: 12, wind_gust: 18, wind_variable: false } } };
    const wxCalm = { metar: { decoded: { wind_dir: null, wind_speed: null, wind_variable: false } } };

    it('draws one line per runway (not per end)', () => {
        const container = document.createElement('div');
        new WindCompass().render(container, runways, wxWithWind);
        expect(container.querySelectorAll('svg .wc-runway-line').length).toBe(2);
    });

    it('draws a wind arrow when METAR has a definite wind', () => {
        const container = document.createElement('div');
        new WindCompass().render(container, runways, wxWithWind);
        expect(container.querySelectorAll('svg .wc-wind-arrow').length).toBe(1);
    });

    it('omits the wind arrow and shows a no-wind note when METAR wind is calm/missing', () => {
        const container = document.createElement('div');
        new WindCompass().render(container, runways, wxCalm);
        expect(container.querySelectorAll('svg .wc-wind-arrow').length).toBe(0);
        expect(container.querySelector('.wc-no-wind')).not.toBeNull();
    });

    it('labels the best runway end distinctly from the others', () => {
        const container = document.createElement('div');
        new WindCompass().render(container, runways, wxWithWind);
        expect(container.querySelectorAll('.wc-end-label.wc-best').length).toBe(1);
    });

    it('shows a no-runway-data message instead of an empty rose when there are no runways', () => {
        const container = document.createElement('div');
        new WindCompass().render(container, [], wxWithWind);
        expect(container.querySelector('svg')).toBeNull();
        expect(container.querySelector('.wc-no-runways')).not.toBeNull();
    });
});

describe('WindCompass instance manual override', () => {
    const runways = [{ id: '08L/26R', length_ft: 5000 }];
    const wxWithWind = { metar: { decoded: { wind_dir: 260, wind_speed: 12, wind_gust: 18, wind_variable: false } } };

    it('starts in METAR mode, not manual', () => {
        const container = document.createElement('div');
        const wc = new WindCompass();
        wc.render(container, runways, wxWithWind);
        expect(container.querySelector('.wc-mode-metar.active')).not.toBeNull();
        expect(container.querySelector('.wc-mode-manual.active')).toBeNull();
    });

    it('tapping Manual reveals the direction/speed numpad triggers', () => {
        const container = document.createElement('div');
        const wc = new WindCompass();
        wc.render(container, runways, wxWithWind);
        container.querySelector('.wc-mode-manual').click();
        expect(container.querySelector('.wc-manual-controls').hidden).toBe(false);
    });

    it('seeds manual direction/speed from the current METAR reading when first toggled on', () => {
        const container = document.createElement('div');
        const wc = new WindCompass();
        wc.render(container, runways, wxWithWind);
        container.querySelector('.wc-mode-manual').click();
        expect(container.querySelector('.wc-dir-value').textContent).toBe('260');
        expect(container.querySelector('.wc-spd-value').textContent).toBe('12');
    });

    it('typing on the direction numpad and pressing DONE applies the new heading', () => {
        const container = document.createElement('div');
        const wc = new WindCompass();
        wc.render(container, runways, wxWithWind);
        container.querySelector('.wc-mode-manual').click();
        container.querySelector('.wc-dir-value').click(); // opens numpad for direction
        container.querySelector('[data-digit="0"]').click();
        container.querySelector('[data-digit="9"]').click();
        container.querySelector('[data-digit="0"]').click();
        container.querySelector('.wc-numpad-done').click();
        expect(container.querySelector('.wc-dir-value').textContent).toBe('090');
    });

    it('does not render the direction/speed fields in METAR mode (they would be inert)', () => {
        const container = document.createElement('div');
        new WindCompass().render(container, runways, wxWithWind);
        expect(container.querySelector('.wc-manual-controls')).toBeNull();
        expect(container.querySelector('.wc-dir-value')).toBeNull();
    });

    it('rejects an out-of-range direction (370) and keeps the numpad open', () => {
        const container = document.createElement('div');
        const wc = new WindCompass();
        wc.render(container, runways, wxWithWind);
        container.querySelector('.wc-mode-manual').click();
        container.querySelector('.wc-dir-value').click();
        ['3', '7', '0'].forEach(d => container.querySelector(`[data-digit="${d}"]`).click());
        container.querySelector('.wc-numpad-done').click();
        expect(container.querySelector('.wc-numpad-sheet').style.display).toBe('');
        expect(container.querySelector('.wc-dir-value').textContent).toBe('260');
    });

    it('manual speed 0 shows CALM and no arrow', () => {
        const container = document.createElement('div');
        const wc = new WindCompass();
        wc.render(container, runways, wxWithWind);
        container.querySelector('.wc-mode-manual').click();
        container.querySelector('.wc-spd-value').click();
        container.querySelector('[data-digit="0"]').click();
        container.querySelector('.wc-numpad-done').click();
        expect(container.querySelectorAll('svg .wc-wind-arrow').length).toBe(0);
        expect(container.querySelector('.wc-no-wind').textContent).toBe('CALM');
    });

    it('switching back to METAR after a manual entry restores the live METAR value', () => {
        const container = document.createElement('div');
        const wc = new WindCompass();
        wc.render(container, runways, wxWithWind);
        container.querySelector('.wc-mode-manual').click();
        container.querySelector('.wc-dir-value').click();
        container.querySelector('[data-digit="9"]').click();
        container.querySelector('.wc-numpad-done').click();
        container.querySelector('.wc-mode-metar').click();
        expect(container.querySelectorAll('svg .wc-wind-arrow').length).toBe(1);
        expect(container.querySelector('.wc-mode-metar.active')).not.toBeNull();
    });
});

describe('WindCompass.validHeading / validSpeed', () => {
    it('accepts 1-360 unchanged and treats 0 as 360', () => {
        expect(WindCompass.validHeading(270)).toBe(270);
        expect(WindCompass.validHeading(360)).toBe(360);
        expect(WindCompass.validHeading(0)).toBe(360);
    });

    it('rejects out-of-range directions instead of wrapping them (370 is a slip for 270, not 010)', () => {
        expect(WindCompass.validHeading(370)).toBeNull();
        expect(WindCompass.validHeading(999)).toBeNull();
    });

    it('treats null/undefined as no heading', () => {
        expect(WindCompass.validHeading(null)).toBeNull();
        expect(WindCompass.validHeading(undefined)).toBeNull();
    });

    it('accepts 0-150 kt and rejects higher speeds', () => {
        expect(WindCompass.validSpeed(0)).toBe(0);
        expect(WindCompass.validSpeed(150)).toBe(150);
        expect(WindCompass.validSpeed(151)).toBeNull();
    });
});

describe('WindCompass best-end selection', () => {
    it('breaks a rounded-headwind tie on the unrounded headwind (140 wind: 14 beats 13)', () => {
        const ends = WindCompass.parseRunwayEnds([{ id: '13/31' }, { id: '14/32' }]);
        const out = WindCompass.computeWindComponents(ends, 140, 15, null);
        expect(out[0].label).toBe('14');
        expect(out[0].isBest).toBe(true);
    });

    it('never marks a tailwind end as best', () => {
        const ends = WindCompass.parseRunwayEnds([{ id: '18' }]);
        const out = WindCompass.computeWindComponents(ends, 360, 15, null);
        expect(out[0].headwind).toBe(-15);
        expect(out[0].isBest).toBe(false);
    });
});

describe('WindCompass METAR states', () => {
    const runways = [{ id: '08/26', length_ft: 5000 }];
    const render = (wx) => {
        const container = document.createElement('div');
        const wc = new WindCompass();
        wc.render(container, runways, wx);
        return { container, wc };
    };

    it('shows variable wind with its speed and gust, not "no wind"', () => {
        const { container } = render({ metar: { decoded: { wind_dir: null, wind_speed: 12, wind_gust: 22, wind_variable: true } } });
        const text = container.querySelector('.wc-no-wind').textContent;
        expect(text).toContain('VRB 12G22');
        expect(text).toContain('22 kt');
    });

    it('shows CALM for a 00000KT METAR', () => {
        const { container } = render({ metar: { decoded: { wind_dir: 0, wind_speed: 0, wind_variable: false } } });
        expect(container.querySelector('.wc-no-wind').textContent).toBe('CALM');
    });

    it('shows the gust crosswind next to the steady crosswind', () => {
        const { container } = render({ metar: { decoded: { wind_dir: 300, wind_speed: 10, wind_gust: 20, wind_variable: false } } });
        const cells = [...container.querySelectorAll('.wc-col-xw')].map(e => e.textContent);
        expect(cells.some(t => /^\d+G\d+ [LR]$/.test(t))).toBe(true);
    });

    it('shows the METAR source and age, flagged STALE when older than 75 min', () => {
        const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        const { container } = render({ source: 'fisb', metar: { decoded: { wind_dir: 260, wind_speed: 8, observed_at: old } } });
        const el = container.querySelector('.wc-metar-age');
        expect(el.textContent).toContain('FISB METAR');
        expect(el.textContent).toContain('STALE');
    });

    it('explains, rather than drawing an empty rose, when no runway id has a heading', () => {
        const container = document.createElement('div');
        new WindCompass().render(container, [{ id: 'H1' }], { metar: { decoded: { wind_dir: 260, wind_speed: 8 } } });
        expect(container.querySelector('svg')).toBeNull();
        expect(container.querySelector('.wc-no-runways')).not.toBeNull();
    });
});

describe('WindCompass.updateWx (live METAR while the popup is open)', () => {
    const runways = [{ id: '08/26' }];
    const noWx = { metar: null };
    const newWx = { metar: { decoded: { wind_dir: 260, wind_speed: 14 } } };

    it('redraws in METAR mode when a METAR arrives after open', () => {
        const container = document.createElement('div');
        const wc = new WindCompass();
        wc.render(container, runways, noWx);
        expect(container.querySelectorAll('svg .wc-wind-arrow').length).toBe(0);
        wc.updateWx(newWx);
        expect(container.querySelectorAll('svg .wc-wind-arrow').length).toBe(1);
    });

    it('leaves a manual entry on screen, and uses the new METAR on switching back', () => {
        const container = document.createElement('div');
        const wc = new WindCompass();
        wc.render(container, runways, { metar: { decoded: { wind_dir: 80, wind_speed: 5 } } });
        container.querySelector('.wc-mode-manual').click();
        wc.updateWx(newWx);
        expect(container.querySelector('.wc-dir-value').textContent).toBe('080');
        container.querySelector('.wc-mode-metar').click();
        expect(container.querySelector('.wc-end-label.wc-best .wc-end-id').textContent).toBe('26');
    });
});

// ---- true vs magnetic, threshold-coordinate headings, label layout ----

/** A point `distM` metres from (lat, lon) on true bearing `brg` (spherical earth). */
function offset(lat, lon, brg, distM) {
    const R = 6371000, d = distM / R, t = brg * Math.PI / 180;
    const p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 * 180 / Math.PI, l2 * 180 / Math.PI];
}
/** A NASR-shaped runway whose base end points along true bearing `trueHdg`. */
function nasrRunway(id, baseId, recipId, trueHdg, lat = 34.72, lon = -80.85) {
    const [rlat, rlon] = offset(lat, lon, trueHdg, 1800);
    return { id, length_ft: 6000, base_id: baseId, base_lat: lat, base_lon: lon, recip_id: recipId, recip_lat: rlat, recip_lon: rlon };
}

describe('WindCompass runway headings are TRUE', () => {
    it('takes each end\'s heading from the threshold coordinates (base -> recip)', () => {
        const ends = WindCompass.parseRunwayEnds([nasrRunway('06/24', '06', '24', 52.4)]);
        expect(ends.map(e => e.label)).toEqual(['06', '24']);
        expect(ends[0].hdg).toBeCloseTo(52.4, 1);
        expect(ends[1].hdg).toBeCloseTo(232.4, 1);
        expect(ends.some(e => e.approx || e.fromNumber)).toBe(false);
    });

    it('handles ids with no number when the thresholds are known (N/S)', () => {
        const ends = WindCompass.parseRunwayEnds([nasrRunway('N/S', 'N', 'S', 2)]);
        expect(ends.map(e => e.label)).toEqual(['N', 'S']);
        expect(ends[0].hdg).toBeCloseTo(2, 1);
    });

    it('pads a one-digit threshold id ("6" -> "06")', () => {
        const ends = WindCompass.parseRunwayEnds([nasrRunway('6/24', '6', '24', 52)]);
        expect(ends[0].label).toBe('06');
    });

    it('without thresholds, adds the declination to number x 10 and marks the end approximate', () => {
        const ends = WindCompass.parseRunwayEnds([{ id: '06/24', length_ft: 6000 }], -8);
        expect(ends[0]).toMatchObject({ label: '06', hdg: 52, approx: true });
        expect(ends[1]).toMatchObject({ label: '24', hdg: 232, approx: true });
    });

    it('reports the crosswind side: wind from the right of the runway heading is R', () => {
        const [end] = WindCompass.computeWindComponents([{ label: '36', hdg: 360 }], 90, 10, null);
        expect(end.xwSide).toBe('R');
        const [end2] = WindCompass.computeWindComponents([{ label: '36', hdg: 360 }], 270, 10, null);
        expect(end2.xwSide).toBe('L');
    });
});

describe('WindCompass true/magnetic wind (variation 8 deg W)', () => {
    // Runway 06/24 with true alignment 052/232 -- magnetic 060/240 at 8W.
    const runways = [nasrRunway('06/24', '06', '24', 52)];
    const site = { lat: 34.72, lon: -80.85 };
    const realMagVar = globalThis.MagVar;
    const withVar = (fn) => {
        globalThis.MagVar = { declination: () => -8 };
        try { fn(); } finally { globalThis.MagVar = realMagVar; }
    };

    it('METAR (true) wind straight down the true runway reads all headwind', () => {
        withVar(() => {
            const container = document.createElement('div');
            new WindCompass().render(container, runways, { metar: { decoded: { wind_dir: 52, wind_speed: 15 } } }, site);
            const best = container.querySelector('.wc-best-row');
            expect(best.querySelector('.wc-col-rwy').textContent).toBe('\u25b6 06');
            expect(best.querySelector('.wc-col-head').textContent).toBe('15 HW');
            expect(best.querySelector('.wc-col-xw').textContent).toBe('0');
        });
    });

    it('the old number x 10 method would have shown a crosswind for that same wind', () => {
        const [end] = WindCompass.computeWindComponents([{ label: '06', hdg: 60 }], 52, 15, null);
        expect(end.crosswind).toBe(2);
    });

    it('a MANUAL (ATIS, magnetic) 060 wind is converted to 052 true and reads all headwind', () => {
        withVar(() => {
            const container = document.createElement('div');
            const wc = new WindCompass();
            wc.render(container, runways, { metar: null }, site);
            container.querySelector('.wc-mode-manual').click();
            container.querySelector('.wc-dir-value').click();
            ['0', '6', '0'].forEach(d => container.querySelector(`[data-digit="${d}"]`).click());
            container.querySelector('.wc-numpad-done').click();
            container.querySelector('.wc-spd-value').click();
            ['1', '5'].forEach(d => container.querySelector(`[data-digit="${d}"]`).click());
            container.querySelector('.wc-numpad-done').click();
            expect(container.querySelector('.wc-wind-line').textContent).toContain('060\u00b0M = 052\u00b0T');
            const best = container.querySelector('.wc-best-row');
            expect(best.querySelector('.wc-col-head').textContent).toBe('15 HW');
            expect(best.querySelector('.wc-col-xw').textContent).toBe('0');
        });
    });

    it('seeds MANUAL from the METAR converted to magnetic', () => {
        withVar(() => {
            const container = document.createElement('div');
            new WindCompass().render(container, runways, { metar: { decoded: { wind_dir: 260, wind_speed: 12 } } }, site);
            container.querySelector('.wc-mode-manual').click();
            expect(container.querySelector('.wc-dir-value').textContent).toBe('268');
            expect(container.querySelector('.wc-field-label').textContent).toContain('\u00b0M');
        });
    });

    it('shows the wind in true and magnetic, and the variation', () => {
        withVar(() => {
            const container = document.createElement('div');
            new WindCompass().render(container, runways, { metar: { decoded: { wind_dir: 260, wind_speed: 12, wind_gust: 20 } } }, site);
            expect(container.querySelector('.wc-wind-line').textContent).toBe('METAR 260\u00b0T = 268\u00b0M \u00b7 12G20 KT');
            expect(container.querySelector('.wc-source-note').textContent).toContain('VAR 8.0\u00b0W');
        });
    });

    it('uses the real WMM when MagVar is loaded', () => {
        const MagVar = new Function(read('web/shared/mag-var.js') + '\nreturn MagVar;')();
        globalThis.MagVar = MagVar;
        try {
            const d = WindCompass.declinationAt(site);
            expect(d).toBeLessThan(-7);
            expect(d).toBeGreaterThan(-9);
        } finally { globalThis.MagVar = realMagVar; }
    });

    it('without a position or MagVar, treats MANUAL as entered and says the variation is unknown', () => {
        const container = document.createElement('div');
        new WindCompass().render(container, [{ id: '06/24', length_ft: 6000 }], { metar: { decoded: { wind_dir: 60, wind_speed: 10 } } });
        expect(WindCompass.declinationAt(undefined)).toBeNull();
        expect(container.querySelector('.wc-source-note').textContent).toContain('variation unknown');
    });
});

describe('WindCompass runway-end label layout', () => {
    const at = (label, hdg) => ({ label, hdg });

    it('merges parallel runway ends into one label (26L + 26R -> 26L/R)', () => {
        const labels = WindCompass.layoutEndLabels([at('26L', 260), at('26R', 260.4), at('08R', 80), at('08L', 80.4)]);
        expect(labels.map(l => l.text).sort()).toEqual(['08R/L', '26L/R']);
    });

    it('keeps near-parallel labels (13 and 14) at least 34 units apart', () => {
        const labels = WindCompass.layoutEndLabels([at('13', 130), at('31', 310), at('14', 140), at('32', 320)]);
        for (let i = 0; i < labels.length; i++) {
            for (let j = i + 1; j < labels.length; j++) {
                expect(Math.hypot(labels[i].x - labels[j].x, labels[i].y - labels[j].y)).toBeGreaterThanOrEqual(34);
            }
        }
    });

    it('puts the numbers in a table, not in the rose', () => {
        const container = document.createElement('div');
        new WindCompass().render(container, [{ id: '08/26' }], { metar: { decoded: { wind_dir: 260, wind_speed: 12 } } });
        expect(container.querySelectorAll('svg .wc-end-wind').length).toBe(0);
        expect(container.querySelectorAll('.wc-table tbody tr').length).toBe(2);
        expect(container.querySelectorAll('.wc-best-row').length).toBe(1);
        expect(container.querySelector('.wc-best-row .wc-col-rwy').textContent).toBe('\u25b6 26');
    });
});
