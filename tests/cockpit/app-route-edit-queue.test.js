/**
 * app.js — applyRouteEdit()'s latest-wins queue (#74)
 *
 * Multiple rapid edits share one in-flight _applyPlan() (NASR resolution takes
 * ~200ms-5s); only the latest queued edit survives, and mid-queue edits are
 * silently dropped. This covers that queue mechanic in isolation and the new
 * DiagLog breadcrumb that fires when a queued edit gets dropped.
 *
 * app.js self-instantiates FlyTabApp at the bottom of the file (`const app =
 * new FlyTabApp()`), which would run the full constructor as a side effect of
 * merely loading the class — infeasible to stub in a unit test. The source is
 * truncated at the class's closing brace (before the bootstrap section) before
 * evaluating, matching the classic-script loading pattern the other cockpit
 * tests use, just with the self-instantiating tail removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fullSrc = readFileSync(join(__dirname, '../../web/app.js'), 'utf8');
const classOnlySrc = fullSrc.slice(0, fullSrc.indexOf('// === Initialize on DOM ready'));
const FlyTabApp = new Function(classOnlySrc + '\nreturn FlyTabApp;')();

/** A deferred promise so a test can control exactly when a queued
 *  _applyPlan() "finishes its NASR resolution". */
function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

function makeApp() {
    const a = Object.create(FlyTabApp.prototype);
    a._pendingPlanEdit = null;
    a._applyingPlan = false;
    return a;
}

// DiagLog is a module-scoped `const` inside app.js itself, defined by an IIFE
// that reads/writes localStorage directly — the file's `window.DiagLog = DiagLog`
// export line is part of the excluded bootstrap tail, so app.js's own methods
// never see a `globalThis.DiagLog` stub; they close over the real one. Read its
// actual output back from localStorage instead of trying to spy on it.
function diagLogEntries() {
    try { return JSON.parse(localStorage.getItem('flypi_diag_log') || '[]'); }
    catch { return []; }
}

beforeEach(() => {
    localStorage.removeItem('flypi_diag_log');
});

describe('applyRouteEdit — latest-wins queue (#74)', () => {
    it('a single call runs _applyPlan once, immediately, with no drop logged', async () => {
        const app = makeApp();
        app._applyPlan = vi.fn().mockResolvedValue();
        await app.applyRouteEdit({ waypoints: [{ icao: 'KLKR' }, { icao: 'KFGX' }] });

        expect(app._applyPlan).toHaveBeenCalledTimes(1);
        expect(diagLogEntries()).toEqual([]);
    });

    it('a second call while the first is in flight gets queued and applied after', async () => {
        const app = makeApp();
        const first = deferred();
        const calls = [];
        app._applyPlan = vi.fn((plan) => {
            calls.push(plan.waypoints.length);
            return calls.length === 1 ? first.promise : Promise.resolve();
        });

        // First call starts _applyPlan and is still awaiting it (not resolved yet).
        const firstCallPromise = app.applyRouteEdit({ waypoints: [1, 2] });

        // Second call arrives while the first is still in flight — it must NOT
        // run _applyPlan yet, just queue.
        await app.applyRouteEdit({ waypoints: [1, 2, 3] });
        expect(app._applyPlan).toHaveBeenCalledTimes(1);

        // Let the first NASR resolution "finish" — the queued second plan should
        // now run through the same while() loop.
        first.resolve();
        await firstCallPromise;

        expect(app._applyPlan).toHaveBeenCalledTimes(2);
        expect(calls).toEqual([2, 3]);
    });

    it('a THIRD rapid call drops the second entirely — only first and third ever reach _applyPlan', async () => {
        const app = makeApp();
        const first = deferred();
        const calls = [];
        app._applyPlan = vi.fn((plan) => {
            calls.push(plan.waypoints.length);
            return calls.length === 1 ? first.promise : Promise.resolve();
        });

        const firstCallPromise = app.applyRouteEdit({ waypoints: [1, 2] });        // starts running
        await app.applyRouteEdit({ waypoints: [1, 2, 3] });                        // queued
        await app.applyRouteEdit({ waypoints: [1, 2, 3, 4] });                     // replaces the queued one — #74 the actual bug

        first.resolve();
        await firstCallPromise;

        // The middle edit (3 waypoints) never reaches _applyPlan at all.
        expect(calls).toEqual([2, 4]);
        expect(app._applyPlan).toHaveBeenCalledTimes(2);
    });

    it('logs a #74 breadcrumb exactly when a queued (not-yet-applied) edit is replaced', async () => {
        const app = makeApp();
        const first = deferred();
        app._applyPlan = vi.fn(() => first.promise);

        const firstCallPromise = app.applyRouteEdit({ waypoints: [1, 2] });
        expect(diagLogEntries()).toEqual([]); // nothing queued yet to drop

        await app.applyRouteEdit({ waypoints: [1, 2, 3] });
        expect(diagLogEntries()).toEqual([]); // this is the first thing queued, nothing dropped

        await app.applyRouteEdit({ waypoints: [1, 2, 3, 4] });
        const entries = diagLogEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].cat).toBe('route');
        expect(entries[0].msg).toMatch(/dropping queued edit \(3 wp\) for a newer one \(4 wp\)/);

        first.resolve();
        await firstCallPromise;
    });

    it('does not log when each edit completes before the next one arrives (no race)', async () => {
        const app = makeApp();
        app._applyPlan = vi.fn().mockResolvedValue();

        await app.applyRouteEdit({ waypoints: [1, 2] });
        await app.applyRouteEdit({ waypoints: [1, 2, 3] });
        await app.applyRouteEdit({ waypoints: [1, 2, 3, 4] });

        expect(app._applyPlan).toHaveBeenCalledTimes(3);
        expect(diagLogEntries()).toEqual([]);
    });

    it('stamps edited_at on every plan, including ones later dropped', async () => {
        const app = makeApp();
        const first = deferred();
        app._applyPlan = vi.fn(() => first.promise);

        const droppedPlan = { waypoints: [1, 2, 3] };
        const firstCallPromise = app.applyRouteEdit({ waypoints: [1, 2] });
        await app.applyRouteEdit(droppedPlan);
        await app.applyRouteEdit({ waypoints: [1, 2, 3, 4] });

        expect(droppedPlan.edited_at).toBeTruthy(); // stamped even though never applied

        first.resolve();
        await firstCallPromise;
    });
});
