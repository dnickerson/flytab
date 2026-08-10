/**
 * route-table.js's plan picker wrote localStorage['flypi_active_plan'] directly
 * and called app._applyPlan(plan) directly, bypassing applyRouteEdit()'s
 * latest-wins queue (app.js's _pendingPlanEdit mechanism, #74). Confirmed safe
 * to redirect: the same full plan object reaches _applyPlan either way — unlike
 * doSave() a few hundred lines away, which is NOT touched by this fix (see
 * Task 16 / Appendix A in the plan doc).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const ROUTE_TABLE_SRC = readFileSync('web/cockpit/route-table.js', 'utf8');

describe('_showPlanPicker loads through applyRouteEdit, not a direct write (Finding 5 partial)', () => {
    // Anchor on the *selector string* `.plan-picker-item` (with the leading dot, as
    // used in `querySelectorAll('.plan-picker-item')`), not the bare class name —
    // the bare name also matches earlier in this file inside the button template's
    // `class="plan-picker-item"`, which would anchor the slice hundreds of
    // characters too early and miss the applyRouteEdit call entirely.
    it('the plan-picker item handler calls app.applyRouteEdit', () => {
        const pickerIdx = ROUTE_TABLE_SRC.indexOf('.plan-picker-item');
        const handlerBlock = ROUTE_TABLE_SRC.slice(pickerIdx, pickerIdx + 800);
        expect(handlerBlock).toMatch(/app\.applyRouteEdit\(/);
    });

    it('the plan-picker item handler no longer writes flypi_active_plan directly', () => {
        const pickerIdx = ROUTE_TABLE_SRC.indexOf('.plan-picker-item');
        const handlerBlock = ROUTE_TABLE_SRC.slice(pickerIdx, pickerIdx + 800);
        expect(handlerBlock).not.toMatch(/localStorage\.setItem\(\s*['"]flypi_active_plan['"]/);
    });

    it('doSave() is untouched by this fix — still its own bare-bones write (Appendix A, not this task)', () => {
        const saveIdx = ROUTE_TABLE_SRC.indexOf('const doSave');
        // Window sized generously (measured 1189 chars between the doSave closure and
        // its localStorage.setItem in the version this was checked against — 1500
        // leaves real headroom) — do not shrink without re-measuring the actual gap.
        const saveBlock = ROUTE_TABLE_SRC.slice(saveIdx, saveIdx + 1500);
        expect(saveBlock).toMatch(/localStorage\.setItem\(\s*['"]flypi_active_plan['"]/);
    });
});
