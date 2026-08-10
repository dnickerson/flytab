/**
 * PreflightCheck reads NasrDB.getActiveFlightPlan(), which reads the `flypi`
 * IDB's flight_plans store — but nothing in the app ever writes that store
 * (NasrDB.saveFlightPlan has zero callers). The real active plan lives in
 * localStorage['flypi_active_plan'], written by app.js/_applyPlan and
 * route-table.js, and already read that way by four other files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
const PreflightCheck = new Function(read('web/cockpit/preflight-check.js') + '\nreturn PreflightCheck;')();

function makeCheck() {
    // db is only used for NASR/tiles checks (getCycleInfo/getAirport), unrelated
    // to the active-plan question — a stub is fine here.
    return Object.create(PreflightCheck.prototype, {
        db: { value: { open: async () => {}, getCycleInfo: async () => null, getAirport: async () => null } },
    });
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('PreflightCheck._getActivePlan reads the real active-plan source (Finding 6)', () => {
    it('reads flypi_active_plan from localStorage, not the dead flypi IDB store', () => {
        const plan = { flight_plan: { departure: 'KLKR', destination: 'KFGX' }, waypoints: [] };
        localStorage.setItem('flypi_active_plan', JSON.stringify(plan));
        const pc = makeCheck();
        expect(pc._getActivePlan()).toEqual(plan);
    });

    it('returns null when no plan has ever been saved', () => {
        const pc = makeCheck();
        expect(pc._getActivePlan()).toBeNull();
    });

    it('returns null (not a throw) on malformed JSON', () => {
        localStorage.setItem('flypi_active_plan', '{not valid json');
        const pc = makeCheck();
        expect(() => pc._getActivePlan()).not.toThrow();
        expect(pc._getActivePlan()).toBeNull();
    });
});
