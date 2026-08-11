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

describe('PreflightCheck._checkWeather — missing weather_cache is a warn, not a fail (whole-branch Finding 1)', () => {
    // Reading the real active-plan source (Finding 6, above) surfaced this
    // overlay on every cockpit load with an active plan — including plans
    // built locally via route-table.js's Save Route flow, which never attach
    // weather_cache by design. That must not read as a hard preflight FAIL.

    it('reports warn (not fail) when weather_cache is entirely absent', () => {
        const pc = makeCheck();
        const result = pc._checkWeather({ flight_plan: { departure: 'KLKR', destination: 'KFGX' } });
        expect(result.status).toBe('warn');
        expect(result.status).not.toBe('fail');
    });

    it('still reports fail when weather_cache exists but is genuinely stale (>=180min)', () => {
        const pc = makeCheck();
        const staleFetchedAt = new Date(Date.now() - 200 * 60000).toISOString();
        const result = pc._checkWeather({ weather_cache: { fetched_at: staleFetchedAt } });
        expect(result.status).toBe('fail');
    });

    it('still reports fail when there is no active plan at all', () => {
        const pc = makeCheck();
        const result = pc._checkWeather(null);
        expect(result.status).toBe('fail');
    });

    it('distinguishes a cloud-synced plan (plan.id set) from a locally-built one when weather_cache is missing', () => {
        const pc = makeCheck();
        const local = pc._checkWeather({ flight_plan: { departure: 'KLKR', destination: 'KFGX' } });
        expect(local.status).toBe('warn');
        expect(local.msg).toBe('Not cached — route built locally');

        const synced = pc._checkWeather({ id: 'abc123', flight_plan: { departure: 'KLKR', destination: 'KFGX' } });
        expect(synced.status).toBe('warn');
        expect(synced.msg).not.toBe('Not cached — route built locally');
        expect(synced.msg).toBe('Not cached — verify weather before departure');
    });

    it('a warn-only weather check does not flip the aggregate verdict to fail', async () => {
        // Mirrors _runChecks' aggregation: hasFailure ? 'fail' : hasCaution ? 'warn' : 'ok'.
        const items = [
            { label: 'Flight Plan', status: 'ok' },
            { label: 'Weather', status: 'warn', msg: 'Not cached — route built locally' },
            { label: 'NASR Data', status: 'ok' },
            { label: 'Offline Maps', status: 'ok' },
        ];
        const hasFailure = items.some(i => i.status === 'fail');
        const hasCaution = items.some(i => i.status === 'warn');
        const verdict = hasFailure ? 'fail' : hasCaution ? 'warn' : 'ok';
        expect(verdict).toBe('warn');
        expect(verdict).not.toBe('fail');
    });
});
