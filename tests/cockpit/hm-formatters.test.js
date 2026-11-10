/**
 * Fuel follow-up F3 sweep: every h:mm / "Xh Ym" formatter that split a fractional
 * minute count with floor(min / 60) and round(min % 60) could show 60 minutes
 * ("1:60", "60m", "1h 60m", "1 h 60 min"). Each now rounds the total first.
 *
 * Real classes (new Function(src + 'return Class')), no fakes of the formatter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

const InstrumentStrip     = new Function(read('web/cockpit/instrument-strip.js') + '\nreturn InstrumentStrip;')();
const PowerTradeoff       = new Function(read('web/cockpit/power-tradeoff.js') + '\nreturn PowerTradeoff;')();
const PositionHealthPanel = new Function(read('web/cockpit/position-health-panel.js') + '\nreturn PositionHealthPanel;')();
const RouteTable          = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();
const RoutePlannerPanel   = new Function(read('web/cockpit/route-planner-panel.js') + '\nreturn RoutePlannerPanel;')();

function extractMethod(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`method not found: ${signature}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
    }
    throw new Error('unbalanced braces');
}
const appSrc = read('web/app.js');
const fmtEteHm = (min) => new Function('min', extractMethod(appSrc, 'static fmtEteHm(min) {'))(min);

describe('h:mm formatters never show 60 minutes', () => {
    it('InstrumentStrip._formatEte (ETE)', () => {
        expect(InstrumentStrip._formatEte(119.6)).toBe('2:00');
        expect(InstrumentStrip._formatEte(59.6)).toBe('1:00');
        expect(InstrumentStrip._formatEte(119.4)).toBe('1:59');
        expect(InstrumentStrip._formatEte(42.2)).toBe('42m');
        expect(InstrumentStrip._formatEte(0.3)).toBe('0m');
    });

    it('PowerTradeoff._fmtTime (ETE column)', () => {
        expect(PowerTradeoff._fmtTime(119.6)).toBe('2:00');
        expect(PowerTradeoff._fmtTime(59.6)).toBe('1:00');
        expect(PowerTradeoff._fmtTime(75.2)).toBe('1:15');
        expect(PowerTradeoff._fmtTime(null)).toBe('—');
        expect(PowerTradeoff._fmtTime(-1)).toBe('—');
    });

    it('RouteTable._formatTime (route table ETE)', () => {
        const f = (m) => RouteTable.prototype._formatTime.call({}, m);
        expect(f(119.6)).toBe('2:00');
        expect(f(59.6)).toBe('1:00');
        expect(f(12.4)).toBe('12m');
        expect(f(0)).toBe('—');
    });

    it('RouteTable._formatEte (route summary ETE)', () => {
        expect(RouteTable._formatEte(119.6)).toBe('2:00');
        expect(RouteTable._formatEte(59.6)).toBe('1:00');
        expect(RouteTable._formatEte(0)).toBe('0m');
        expect(RouteTable._formatEte(90)).toBe('1:30');
    });

    it('PositionHealthPanel.duration (seconds)', () => {
        expect(PositionHealthPanel.duration(7170)).toBe('2 h 0 min');   // 1 h 59.5 min
        expect(PositionHealthPanel.duration(7140)).toBe('1 h 59 min');
        expect(PositionHealthPanel.duration(5400)).toBe('1 h 30 min');
        expect(PositionHealthPanel.duration(89)).toBe('89 s');
        expect(PositionHealthPanel.duration(600)).toBe('10 min');
    });

    it('FlyTabApp.fmtEteHm (fuel-stop overlay ETE)', () => {
        expect(fmtEteHm(119.6)).toBe('2h 0m');
        expect(fmtEteHm(59.6)).toBe('1h 0m');
        expect(fmtEteHm(42.4)).toBe('42m');
        expect(fmtEteHm(null)).toBe('—');
    });

    it('RoutePlannerPanel.fmtHrs: route summary ETE "Xh MMm" and fuel-stop picker "H:MM" (review I2)', () => {
        expect(RoutePlannerPanel.fmtHrs(1.995, 'hm')).toBe('2h 00m');
        expect(RoutePlannerPanel.fmtHrs(1.99, 'hm')).toBe('1h 59m');
        expect(RoutePlannerPanel.fmtHrs(0.5, 'hm')).toBe('0h 30m');
        expect(RoutePlannerPanel.fmtHrs(1.995, 'colon')).toBe('2:00');
        expect(RoutePlannerPanel.fmtHrs(3.25, 'colon')).toBe('3:15');
        expect(RoutePlannerPanel.fmtHrs(0.999, 'colon')).toBe('1:00');
    });

    it('no formatter left with a floor/round split (any shape) in web/', () => {
        const files = [];
        const walk = (d) => {
            for (const n of readdirSync(join(__dirname, '../../', d))) {
                const rel = d + '/' + n;
                if (rel === 'web/lib') continue;
                if (statSync(join(__dirname, '../../', rel)).isDirectory()) walk(rel);
                else if (n.endsWith('.js')) files.push(rel);
            }
        };
        walk('web');
        const bad = [];
        for (const p of files) {
            const src = read(p);
            // round(x % 60) / round((x % 3600) / 60) and round((x - h) * 60)
            if (/Math\.round\(\(?\s*[\w.]+\s*%\s*(60|3600)/.test(src)) bad.push(p + ' (% 60)');
            if (/Math\.round\(\(\s*[\w.]+\s*-\s*[\w.]+\s*\)\s*\*\s*60\)/.test(src)) bad.push(p + ' ((x - h) * 60)');
        }
        expect(bad).toEqual([]);
    });
});
