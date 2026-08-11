/**
 * power-tradeoff.js — estimated (samples: 0) power bands.
 *
 * aircraft-config.json's performance.power_settings[] carries `samples`, the count
 * of real logged flight points behind each band. Two bands — 40-45 and 46-50 —
 * have `samples: 0`: their tas_kt and gph are interpolated/extrapolated estimates,
 * not measurements. No caller checked the field, so the panel rendered them
 * identically to measured rows, and the footer's "Based on 47+ actual flight data
 * points" (computed by skipping the falsy `samples: 0`) claimed measured data for
 * the whole table. The 42% row is the bottom row — the one consulted when
 * stretching fuel — and carries the longest endurance and best FUEL@DEST on
 * screen.
 *
 * The rows are kept (they are real power settings the pilot can fly) and the
 * config values are untouched (they are pinned by tests/planning). Only the
 * presentation changes: `~`, an EST tag, a row class, and a footer that scopes its
 * claim to the rows it is true of.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

// The REAL aircraft config, not a fixture — the whole defect is about what the
// shipped power_settings table actually contains.
const AC = JSON.parse(read('web/aircraft-config.json'));
const POWER = AC.performance.power_settings;

globalThis.CockpitConfig = {
    aircraft: (p) => p === 'performance.power_settings' ? POWER : undefined,
    get: (p) => ({
        'enginePage.fuelCautionGal': 8,
        'enginePage.fuelWarningGal': 4,
        'enginePage.fuelAdvisoryGal': 12,
    })[p],
};

const PowerTradeoff = new Function(read('web/cockpit/power-tradeoff.js') + '\nreturn PowerTradeoff;')();

const LEG = {
    destDistNm: 200, activeWind: { dir: 270, spd: 10 }, hdg: 90,
    fuelRemaining: 30, fuelRemainingStale: false, destEteMin: 80,
    livePctPower: 65, liveGph: 8.2,
};

/** Render the panel and read back what the pilot would see. */
function render(detail = LEG) {
    const pt = new PowerTradeoff();
    pt.init();
    pt._legData = detail;
    pt._render();
    const rows = [...pt._el.querySelectorAll('.pt-body tbody tr')].map((tr) => ({
        cls: tr.className,
        pwr: tr.cells[0].textContent.trim(),
        gs: tr.cells[1].textContent,
        gph: tr.cells[2].textContent,
        fuel: tr.cells[4].textContent,
        estTag: !!tr.querySelector('.pt-est-tag'),
    }));
    const footer = pt._el.querySelector('.pt-footer').textContent;
    pt.destroy();
    return { rows, footer };
}

describe('power_settings estimate flag', () => {
    it('exactly two shipped bands have no flight data behind them', () => {
        expect(POWER.filter((p) => !(p.samples > 0)).map((p) => p.band))
            .toEqual(['40-45', '46-50']);
    });
});

describe('PowerTradeoff — estimated rows', () => {
    it('renders every band; no row is dropped', () => {
        expect(render().rows.length).toBe(POWER.length);
    });

    it('marks the two estimated rows with ~ and an EST tag', () => {
        const est = render().rows.filter((r) => r.estTag);
        expect(est.length).toBe(2);
        expect(est.map((r) => r.pwr)).toEqual(['~48% EST', '~42% EST']);
    });

    it('gives estimated rows the pt-row-est class', () => {
        render().rows.filter((r) => r.estTag)
            .forEach((r) => expect(r.cls).toContain('pt-row-est'));
    });

    it('leaves measured rows completely unmarked', () => {
        const measured = render().rows.filter((r) => !r.estTag);
        expect(measured.length).toBe(5);
        measured.forEach((r) => {
            expect(r.cls).not.toContain('pt-row-est');
            expect(r.pwr).not.toContain('~');
            expect(r.pwr).not.toContain('EST');
        });
    });

    it('keeps the current-power highlight on an estimated row', () => {
        const cur = render({ ...LEG, livePctPower: 42, liveGph: 5.0 })
            .rows.find((r) => r.cls.includes('pt-row-current'));
        expect(cur.cls).toContain('pt-row-est');
        expect(cur.pwr).toBe('▶ ~42% EST');
    });
});

describe('PowerTradeoff — footer data-confidence claim', () => {
    it('no longer claims the whole table is built from measured data', () => {
        expect(render().footer).not.toContain('Based on 47+ actual flight data points');
    });

    it('scopes the sample count to the measured rows', () => {
        expect(render().footer).toContain('Measured rows: 47+ actual flight data points');
    });

    it('names the estimated rows explicitly', () => {
        const f = render().footer;
        expect(f).toContain('ESTIMATES');
        expect(f).toContain('~');
    });
});

describe('PowerTradeoff — the config data itself is untouched', () => {
    it('rendering mutates no power_settings entry', () => {
        const before = JSON.stringify(POWER);
        render();
        expect(JSON.stringify(POWER)).toBe(before);
    });

    it('the 42% band still carries its shipped (estimated) values', () => {
        const row = POWER.find((p) => p.pct === 42);
        expect(row.gph).toBe(5);
        expect(row.tas_kt).toBe(97);
        expect(row.samples).toBe(0);
    });
});
