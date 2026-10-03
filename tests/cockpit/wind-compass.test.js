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
            { label: '08L', hdg: 80, length_ft: 5000 },
            { label: '26R', hdg: 260, length_ft: 5000 },
        ]);
    });

    it('handles a runway with no L/R/C suffix', () => {
        const ends = WindCompass.parseRunwayEnds([{ id: '09/27', length_ft: 4000 }]);
        expect(ends).toEqual([
            { label: '09', hdg: 90, length_ft: 4000 },
            { label: '27', hdg: 270, length_ft: 4000 },
        ]);
    });

    it('handles a single-end-only runway id', () => {
        const ends = WindCompass.parseRunwayEnds([{ id: '18', length_ft: 3000 }]);
        expect(ends).toEqual([{ label: '18', hdg: 180, length_ft: 3000 }]);
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
        expect(container.querySelector('.wc-dir-value').textContent).toBe('90');
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

describe('WindCompass.clampHeading', () => {
    it('leaves an in-range heading unchanged', () => {
        expect(WindCompass.clampHeading(270)).toBe(270);
    });

    it('wraps 360 down to 0', () => {
        expect(WindCompass.clampHeading(360)).toBe(0);
    });

    it('wraps an out-of-range value (e.g. numpad-typed 999) via modulo, not a max clamp', () => {
        // Consistent with the 360->0 wrap above, rather than an arbitrary
        // clamp-to-359 -- the numpad UI shows the resulting heading back to
        // the pilot for confirmation before it's applied, so this only
        // needs to be a predictable rule, not a guess at what they meant.
        expect(WindCompass.clampHeading(999)).toBe(279);
    });

    it('treats null/undefined as no heading', () => {
        expect(WindCompass.clampHeading(null)).toBeNull();
        expect(WindCompass.clampHeading(undefined)).toBeNull();
    });
});
