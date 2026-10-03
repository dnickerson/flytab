/**
 * plan-sync.js — "Replan with current winds".
 *
 * Replan opens the route planner on the trip and then taps Plan. open() resets
 * and rebuilds the planner's plan asynchronously, so Plan must run only after
 * open() has finished; a Plan racing it (the old 100 ms setTimeout) could be
 * overwritten by open()'s rebuild from the saved, wind-less waypoints.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PlanSync = new Function(
    readFileSync(join(__dirname, '../../web/cockpit/plan-sync.js'), 'utf8') + '\nreturn PlanSync;')();

afterEach(() => {
    delete window.app;
    document.body.innerHTML = '';
});

describe('PlanSync — Replan with current winds', () => {
    it('taps Plan only after the route planner has finished opening the trip', async () => {
        const order = [];
        let openFinished = null;
        const opened = new Promise(resolve => { openFinished = resolve; });
        window.app = {
            applyRouteEdit: async () => { order.push('apply'); },
            showToast: () => {},
            routePlannerPanel: {
                // open() resolves only when the test says so — well past 100 ms in a real tablet.
                open: async () => { order.push('open-start'); await opened; order.push('open-done'); },
                _onRecomputeTap: async () => { order.push('plan'); },
            },
        };

        const ps = Object.create(PlanSync.prototype);
        ps.hide = () => {};
        ps._showTripBottomSheet({
            name: 'KLKR → KLKR',
            legs: [{ dep: 'KLKR', dest: 'KLKR', waypoints: [], flight_plan: {} }],
        });
        document.querySelector('[data-action="replan"]').click();

        await new Promise(r => setTimeout(r, 150));     // longer than the old 100 ms timer
        expect(order).toEqual(['apply', 'open-start']);  // Plan has not run yet

        openFinished();
        await new Promise(r => setTimeout(r, 0));
        expect(order).toEqual(['apply', 'open-start', 'open-done', 'plan']);
    });
});
