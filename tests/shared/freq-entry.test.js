/**
 * Radio frequency tool: the pilot types a controller's frequency without the
 * leading "1", and FlyTab keeps a history of what was entered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const { FreqEntry, FreqHistory } = new Function(
    readFileSync('web/shared/freq-entry.js', 'utf8') + '\nreturn { FreqEntry, FreqHistory };')();

describe('FreqEntry: the leading "1" is assumed', () => {
    it.each([
        ['3575', '135.750'],
        ['35725', '135.725'],
        ['21725', '121.725'],
        ['215', '121.500'],
        ['18', null],            // no decimal yet
        ['1800', '118.000'],
        ['36975', '136.975'],
    ])('%s -> %s', (typed, want) => {
        const r = FreqEntry.parse(typed);
        if (want == null) expect(r.ok).toBe(false);
        else expect(r).toEqual({ ok: true, khz: Number(want.replace('.', '')), mhz: want });
    });

    it('outside the COM band or off the 25 kHz grid is refused, with the reason', () => {
        expect(FreqEntry.parse('0800')).toEqual({ ok: false, reason: 'Not a COM frequency (118.000–136.975)' });   // 108.00 NAV
        expect(FreqEntry.parse('3700')).toEqual({ ok: false, reason: 'Not a COM frequency (118.000–136.975)' });
        expect(FreqEntry.parse('35730')).toEqual({ ok: false, reason: 'Not on a 25 kHz channel' });
        expect(FreqEntry.parse('357255')).toEqual({ ok: false, reason: 'Too many digits' });
    });

    it('display while typing', () => {
        expect(FreqEntry.display('')).toBe('1');
        expect(FreqEntry.display('3')).toBe('13');
        expect(FreqEntry.display('35')).toBe('135');
        expect(FreqEntry.display('357')).toBe('135.7');
        expect(FreqEntry.display('35725')).toBe('135.725');
        expect(FreqEntry.display('357259')).toBe('135.725');
    });
});

describe('FreqHistory', () => {
    beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });

    it('newest first; re-entering moves it to the top; context kept', () => {
        FreqHistory.add('135.750', { altFt: 5512.4, lat: 34.89349, lon: -80.84258 });
        FreqHistory.add('121.725');
        FreqHistory.add('135.750', { label: 'ATL Center' });
        const l = FreqHistory.list();
        expect(l.map((e) => e.mhz)).toEqual(['135.750', '121.725']);
        expect(l[0].label).toBe('ATL Center');
    });

    it('keeps the last 20', () => {
        for (let i = 0; i < 25; i++) FreqHistory.add(FreqEntry.format(118000 + i * 25));
        const l = FreqHistory.list();
        expect(l).toHaveLength(20);
        expect(l[0].mhz).toBe('118.600');
    });

    it('damaged storage reads as empty; bad entries are dropped', () => {
        localStorage.setItem(FreqHistory.KEY, '{not json');
        expect(FreqHistory.list()).toEqual([]);
        localStorage.setItem(FreqHistory.KEY, JSON.stringify([{ mhz: '<b>', at: 'x' }, { mhz: '135.750', at: '2026-10-28T20:00:00Z' }]));
        expect(FreqHistory.list().map((e) => e.mhz)).toEqual(['135.750']);
    });

    it('remove and clear', () => {
        FreqHistory.add('135.750'); FreqHistory.add('121.725');
        FreqHistory.remove('135.750');
        expect(FreqHistory.list().map((e) => e.mhz)).toEqual(['121.725']);
        FreqHistory.clear();
        expect(FreqHistory.list()).toEqual([]);
    });
});
