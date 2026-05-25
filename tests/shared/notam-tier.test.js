// tests/shared/notam-tier.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// wx-briefing.js is a single class declaration with no top-level code outside
// the class body.  All globals (document, localStorage, wireTap, Settings…)
// are only referenced inside methods, so no stubs are needed for the Function
// constructor to parse and return the class.
const src = readFileSync('web/cockpit/wx-briefing.js', 'utf8');
const WxBriefing = new Function(`${src}\nreturn WxBriefing;`)();

// ---------------------------------------------------------------------------
// Helper: build a minimal WxBriefing instance with controlled notam state.
// We bypass the constructor entirely with Object.create so no DOM/localStorage
// references fire.  Only the properties read by _notamTier / _sortedNotams
// need to be present.
// ---------------------------------------------------------------------------
function makeWx(notams = [], enrouteNotams = []) {
    const wx = Object.create(WxBriefing.prototype);
    wx._notams          = notams;
    wx._enrouteNotams   = enrouteNotams;
    wx._notamSearch     = '';
    wx._getStationList  = () => ['KLKR', 'KCLT'];
    // Pass-through so temporal filtering is a no-op in unit tests
    wx._filterByFlightWindow = arr => arr;
    return wx;
}

// ---------------------------------------------------------------------------
// _notamTier
// ---------------------------------------------------------------------------
describe('WxBriefing._notamTier', () => {
    let wx;
    beforeEach(() => { wx = makeWx(); });

    it('tier 0: TFR, RWY, APCH, GPS, FISB, MEA, RESTR', () => {
        for (const type of ['TFR', 'RWY', 'APCH', 'GPS', 'FISB', 'MEA', 'RESTR']) {
            expect(wx._notamTier({ type })).toBe(0);
        }
    });

    it('tier 1: generic airport NOTAM', () => {
        expect(wx._notamTier({ type: 'NAV', airport: 'KLKR' })).toBe(1);
    });

    it('tier 2: enroute NOTAM', () => {
        expect(wx._notamTier({ type: 'NAV', isEnroute: true })).toBe(2);
    });

    it('tier 3: obstruction light', () => {
        expect(wx._notamTier({ type: 'OBST_LGT' })).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// _sortedNotams
// ---------------------------------------------------------------------------
describe('WxBriefing._sortedNotams', () => {
    it('critical NOTAMs sort before airport NOTAMs', () => {
        const notams = [
            { type: 'NAV', airport: 'KLKR' },
            { type: 'TFR', airport: 'KLKR' },
        ];
        const wx = makeWx(notams);
        const sorted = wx._sortedNotams();
        expect(sorted[0].type).toBe('TFR');
        expect(sorted[1].type).toBe('NAV');
    });

    it('airport NOTAMs ordered by station index', () => {
        const notams = [
            { type: 'NAV', airport: 'KCLT' },
            { type: 'NAV', airport: 'KLKR' },
        ];
        const wx = makeWx(notams);
        const sorted = wx._sortedNotams();
        // KLKR is index 0 in the station list, KCLT is index 1
        expect(sorted[0].airport).toBe('KLKR');
        expect(sorted[1].airport).toBe('KCLT');
    });

    it('enroute NOTAMs sort after tier-1 airport NOTAMs', () => {
        const apt = [{ type: 'NAV', airport: 'KLKR' }];
        const enr = [{ type: 'NAV', isEnroute: true }];
        const wx = makeWx(apt, enr);
        const sorted = wx._sortedNotams();
        expect(sorted[0].isEnroute).toBeFalsy();
        expect(sorted[1].isEnroute).toBe(true);
    });
});
