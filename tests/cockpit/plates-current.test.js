/**
 * Expired plates (Dana, 2026-10-16: a KTMB chart dated March 2026). With the
 * master plate_index.json loaded -- this cycle's list of every airport and its
 * plates -- an airport it doesn't list has no current plates. The fallbacks
 * (an old per-airport index.json, the folder's file list, the geo index) are
 * for a tablet without a master index; with one, they listed expired charts:
 * KPBI is not in the FAA's cycle-2610 d-TPP, but the tablet still had 55 of its
 * plates and 299 old per-airport index.json files.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = globalThis.wireTap || ((el, fn) => el && el.addEventListener && el.addEventListener('click', fn));
const ApproachCharts = new Function(read('web/cockpit/approach-charts.js') + '\nreturn ApproachCharts;')();

const INDEX = { KTMB: { name: 'Miami Exec', cycle: '2610', plates: [
    { chart_code: 'STAR', chart_name: 'FROGZ FIVE (RNAV)', pdf_name: '00257FROGZ.PDF', cycle: '2610' },
] } };

function charts({ master }) {
    const c = Object.create(ApproachCharts.prototype);
    c._plateIndex = JSON.parse(JSON.stringify(INDEX));
    c._hasMasterIndex = master;
    c._loadPromise = null;
    c._pickerEl = document.createElement('div');
    c._viewerEl = document.createElement('div');
    c._showMessage = vi.fn();
    c._buildPicker = vi.fn();
    c._fetchSingleAirportIndex = vi.fn(async () => {});
    c._buildPlatesFromGeoIndex = vi.fn(() => ({ plates: [{ name: 'OLD' }] }));
    return c;
}

describe('plates: only this cycle\'s', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('master index loaded, airport not in it: "no current plates", no fallback to old files', async () => {
        const c = charts({ master: true });
        await c.showForAirport('KPBI');
        expect(c._fetchSingleAirportIndex).not.toHaveBeenCalled();
        expect(c._buildPlatesFromGeoIndex).not.toHaveBeenCalled();
        expect(c._buildPicker).not.toHaveBeenCalled();
        expect(c._showMessage.mock.calls.at(-1)[0]).toMatch(/No current plates for KPBI/);
    });

    it('master index loaded, airport in it: its plates', async () => {
        const c = charts({ master: true });
        await c.showForAirport('KTMB');
        expect(c._buildPicker).toHaveBeenCalled();
    });

    it('no master index (first start, nothing synced): the fallbacks are still tried', async () => {
        const c = charts({ master: false });
        await c.showForAirport('KPBI');
        expect(c._fetchSingleAirportIndex).toHaveBeenCalled();
    });

    it('the master index counts as loaded from the network and from the offline cache', async () => {
        const c = Object.create(ApproachCharts.prototype);
        c._routeAirports = [];
        globalThis._fetchWithTimeout = undefined;
        c._nasrDb = { getAppCache: vi.fn(async (k) => (k === 'plate_index' ? INDEX : null)), putAppCache: vi.fn(async () => {}) };
        c._refreshIndex = vi.fn(async () => {});
        await c.loadIndex();
        expect(c._hasMasterIndex).toBe(true);
        const src = read('web/cockpit/approach-charts.js');
        const refresh = src.slice(src.indexOf('    async _refreshIndex() {'), src.indexOf('    async _refreshIndex() {') + 900);
        expect(refresh).toMatch(/this\._plateIndex = data;\s*this\._hasMasterIndex = true;/);
    });
});
