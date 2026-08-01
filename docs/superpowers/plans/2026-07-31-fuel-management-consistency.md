# Fuel Management Consistency & Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `FuelTankState` the single canonical source of live fuel-on-board data across the FlyTab cockpit app, replace additive fuel-stop arithmetic with fresh tic-based re-measurement, and fix every consistency/correctness bug the audit found downstream of that fragmentation.

**Architecture:** Per `docs/superpowers/specs/2026-07-31-fuel-management-consistency-design.md`. `FuelTankState` (per-tank, continuously burn-integrated) becomes canonical; `FuelState` becomes a thin override/delegation layer over it; every consumer screen migrates to read through `FuelState.getCurrentFuel()`; fuel stops become fresh `FuelTankState.init()` calls from tic measurements instead of additive top-off math; a canonical %power→GPH band table in `aircraft-config.json` replaces three duplicated hardcoded profile objects.

**Tech Stack:** Vanilla JS, classic `<script>`-tag modules (no bundler, no ES module `import`/`export` in `web/cockpit/` or `web/shared/fuel-*.js`), vitest for `web/shared/planning/` and select `web/shared/*.js` modules (see `tests/shared/fuel-engine.test.js` for the extraction pattern used to test non-module classes).

## Global Constraints

- Increment `FLYTAB_VERSION` in `web/app.js` before running `bash build.sh` (per project CLAUDE.md Build Policy). Do this once, in the final task, not per-task.
- If a task touches any file under `web/shared/planning/`, run `npm test` and fix failures before considering that task done (project CLAUDE.md).
- Never hardcode hex colors, sub-700 font weights, or raw px touch targets in any new/modified UI — use the design tokens documented in the project CLAUDE.md (`var(--color-*)`, `var(--font-instrument)`, `var(--touch-min, 56px)`, etc.).
- `web/cockpit/*.js` and `web/shared/fuel-state.js`/`fuel-tank-state.js`/`fuel-engine.js` are classic scripts — no `import`/`export`, no `class X {}` outside the single top-level class per file, referenced globally by class name (e.g. `FuelTankState.init(...)`).
- Any change to `onAirportClick`/`onNavaidClick`/`onFixClick` in `app.js` requires manual verification that the airport popup still opens on tap (project CLAUDE.md Tap Handler Regression Rule) — no task in this plan touches those handlers; confirm this stays true.
- Update `docs/user-manual.md` in the same commit as any task that changes pilot-visible behavior (new fields, changed button behavior, new warnings) — flagged per-task below where it applies.

---

## File Structure

| File | Role in this plan |
|---|---|
| `web/aircraft-config.json` | Data: new `fuel_sender_accurate_below_gal`, `reserve_gal`, extended `power_settings[]` bands |
| `web/cockpit/config-editor.js` | UI: expose the new config fields for editing |
| `web/shared/fuel-tank-state.js` | Canonical live per-tank fuel state — capacity clamp, dropped-burn tracking, timing fixes |
| `web/shared/fuel-state.js` | Override/delegation layer — new `getCurrentFuel()`, fixed capacity fallback |
| `web/shared/settings.js` | Fix malformed `fuel_measurement` default |
| `web/cockpit/fuel-tanks.js` | Sender-display suppression, open-panel sync gap fixes |
| `web/cockpit/fuel-overlay.js` | Fuel-stop reset via tic measurement instead of additive math; dropped-burn display |
| `web/app.js` | In-flight fuel-stop overlay opens `fuel-overlay.js` instead of its own gallons-added prompt |
| `web/cockpit/route-table.js` | Active-flight live-source fix, reset-ordering fix, DEST reserve fuel-stop awareness, destination lookup consistency, passed-leg staleness, `_emitLegUpdate()` canonical read |
| `web/shared/planning/planner/route-planner.js`, `web/shared/planning-adapters/idb-profile.js` | Read canonical %power/GPH table instead of hardcoded duplicates |
| `web/cockpit/engine-page.js` | Migrate to canonical fuel read, fix config keys, fix used-gauge field |
| `web/cockpit/range-calc.js` | Migrate to canonical fuel read (fixes always-blank display) |
| `web/cockpit/route-nav-strip.js`, `web/cockpit/power-tradeoff.js` | Consume the fixed `_emitLegUpdate()` payload (no direct code change expected — verified in Task 14) |
| `web/cockpit/wb-overlay.js` | Add `FuelTankState.needsConfirmation()` staleness check |

---

### Task 1: Canonical config data — aircraft-config.json + config-editor.js

**Files:**
- Modify: `web/aircraft-config.json`
- Modify: `web/cockpit/config-editor.js`
- Test: manual (no test harness covers JSON config or `config-editor.js`)

**Interfaces:**
- Produces: `aircraft-config.json`'s `performance.fuel_sender_accurate_below_gal` (number, gallons per side), `performance.reserve_gal` (number, gallons), `performance.power_settings[]` extended with 5%-wide band entries `{ band: string, pct_mid: number, gph: number, samples: number }` in addition to the existing single-`pct` entries (kept for backward compat with any reader still using `pct`).

- [ ] **Step 1: Add the two new scalar fields**

Edit `web/aircraft-config.json`, inside the `performance` object, add after `"lop_sfc": 0.067,`:

```json
    "lop_sfc": 0.067,
    "reserve_gal": 10,
    "fuel_sender_accurate_below_gal": 12,
```

- [ ] **Step 2: Extend `power_settings[]` with 5%-wide bands**

The aircraft has real EDM+GPS-derived samples only at 55/60/65/70/75%. Replace the `power_settings` array with band-shaped entries — the existing 5 populated points become 5%-wide bands centered on their sampled value; unsampled bands below 55% and above 75% are filled by linear interpolation from the two nearest populated bands (or extrapolation from the single nearest one at the ends) with `samples: 0` so callers can tell real data from an estimate:

```json
    "power_settings": [
      { "band": "40-45", "pct_mid": 42, "gph": 5.0, "samples": 0 },
      { "band": "46-50", "pct_mid": 48, "gph": 5.7, "samples": 0 },
      { "band": "51-55", "pct_mid": 53, "gph": 6.5, "samples": 149 },
      { "band": "56-60", "pct_mid": 58, "gph": 7.3, "samples": 329 },
      { "band": "61-65", "pct_mid": 63, "gph": 8.1, "samples": 1120 },
      { "band": "66-70", "pct_mid": 68, "gph": 8.7, "samples": 359 },
      { "band": "71-75", "pct_mid": 73, "gph": 8.9, "samples": 47 }
    ],
```

Keep the original `rpm`/`mp`/`tas_kt`/`gph_std` fields on the 3 bands that map 1:1 to old entries (51-55→old 55, 61-65→old 65, 71-75→old 75) is NOT required — Task 11's lookup only needs `pct_mid`/`gph`/`samples`; dropping the extra fields here is intentional simplification, since no current consumer reads `rpm`/`mp`/`tas_kt`/`gph_std` from `power_settings[]` (verify with `grep -rn "power_settings\[" web/` before deleting — if any consumer does read those fields, keep them on the bands that have real data instead of dropping).

- [ ] **Step 3: Verify JSON validity**

Run: `node -e "JSON.parse(require('fs').readFileSync('web/aircraft-config.json', 'utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 4: Expose new fields in config-editor.js**

Find the section of `web/cockpit/config-editor.js` that renders `performance.cruise_gph` (the audit found this is currently the only `performance.*` field exposed there). Read that section fully first (`grep -n "cruise_gph" web/cockpit/config-editor.js` to locate it), then add two sibling rows for `reserve_gal` and `fuel_sender_accurate_below_gal` following the exact same pattern (same input type, same save-on-change wiring) as the existing `cruise_gph` row — do not invent a new UI pattern for these two fields.

- [ ] **Step 5: Manual verification**

Open the config editor screen in the running app, confirm both new fields appear, are editable, and persist (edit one, close, reopen, confirm the edit stuck).

- [ ] **Step 6: Commit**

```bash
git add web/aircraft-config.json web/cockpit/config-editor.js
git commit -m "feat(fuel): add reserve_gal, fuel_sender_accurate_below_gal, banded power_settings"
```

---

### Task 2: FuelTankState — capacity clamp, dropped-burn tracking, timing fixes

**Files:**
- Modify: `web/shared/fuel-tank-state.js`
- Test: Create `tests/shared/fuel-tank-state.test.js` (new — none exists today; follow the `new Function()` extraction pattern from `tests/shared/fuel-engine.test.js` since this is a classic-script class)

**Interfaces:**
- Consumes: `CockpitConfig.aircraft('performance.fuel_capacity_gal')` (existing, already used elsewhere)
- Produces: `FuelTankState.init(leftGal, rightGal, activeTank)` now clamps each side to `capacity/2` (reads `fuel_capacity_gal` internally, same source `fuel-tanks.js` already uses); `FuelTankState.getState()` now includes `dropped_burn_estimate_gal: number` in its returned object; `FuelTankState._lastConfirmPromptAt` no longer starts at epoch-0; the 45-min staleness check runs on every `getState()` call, not just once per page load.

- [ ] **Step 1: Write failing tests for the four fixes**

Create `tests/shared/fuel-tank-state.test.js`:

```js
// tests/shared/fuel-tank-state.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const src = readFileSync('web/shared/fuel-tank-state.js', 'utf8');

function freshFuelTankState() {
    // Fresh localStorage + fresh class statics for each test
    localStorage.clear();
    const FuelTankState = new Function(`${src}\nreturn FuelTankState;`)();
    return FuelTankState;
}

describe('FuelTankState', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    describe('init() capacity clamp', () => {
        it('clamps leftGal/rightGal to half of configured capacity', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: (key) => key === 'performance.fuel_capacity_gal' ? 36 : null };
            FuelTankState.init(30, 5, 'L'); // 30 exceeds 36/2=18 per side
            const state = FuelTankState.getState();
            expect(state.left_gal).toBe(18);
            expect(state.right_gal).toBe(5);
        });

        it('does not clamp when CockpitConfig is unavailable (no crash, no clamp)', () => {
            const FuelTankState = freshFuelTankState();
            delete global.CockpitConfig;
            FuelTankState.init(30, 5, 'L');
            const state = FuelTankState.getState();
            expect(state.left_gal).toBe(30);
        });
    });

    describe('dropped_burn_estimate_gal', () => {
        it('accumulates the discarded portion of a long gap', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(18, 18, 'L');
            const state1 = FuelTankState.getState();
            const t0 = new Date(state1.last_sample_at).getTime();
            // Simulate a 60s gap (way over the 10s cap) at 10 GPH
            FuelTankState.onSample(10, t0 + 60000);
            const state2 = FuelTankState.getState();
            // Only 10s of burn should be applied: 10 gph * (10/3600) = 0.02778 gal
            expect(state2.left_gal).toBeCloseTo(18 - 10 * (10 / 3600), 4);
            // The other 50s should be tracked as dropped: 10 gph * (50/3600) = 0.1389 gal
            expect(state2.dropped_burn_estimate_gal).toBeCloseTo(10 * (50 / 3600), 4);
        });

        it('does not accumulate dropped burn for normal (<=10s) gaps', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(18, 18, 'L');
            const t0 = new Date(FuelTankState.getState().last_sample_at).getTime();
            FuelTankState.onSample(10, t0 + 5000); // 5s gap, under the cap
            expect(FuelTankState.getState().dropped_burn_estimate_gal).toBe(0);
        });
    });

    describe('confirm-prompt timing', () => {
        it('does not fire the confirm prompt immediately after init', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            const handler = vi.fn();
            window.addEventListener('fueltankstate:confirm_prompt', handler);
            FuelTankState.init(18, 18, 'L');
            const t0 = new Date(FuelTankState.getState().last_sample_at).getTime();
            FuelTankState.onSample(10, t0 + 1000); // 1s after init — must NOT fire
            expect(handler).not.toHaveBeenCalled();
            window.removeEventListener('fueltankstate:confirm_prompt', handler);
        });

        it('fires the confirm prompt after CONFIRM_INTERVAL_MS has elapsed since init', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            const handler = vi.fn();
            window.addEventListener('fueltankstate:confirm_prompt', handler);
            FuelTankState.init(18, 18, 'L');
            const t0 = new Date(FuelTankState.getState().last_sample_at).getTime();
            // Feed samples in <=10s steps so burn integration isn't gap-capped, crossing the 30-min mark
            let t = t0;
            for (let i = 0; i < 190; i++) { // 190 * 10s = 1900s > 1800s (30 min)
                t += 10000;
                FuelTankState.onSample(10, t);
            }
            expect(handler).toHaveBeenCalled();
            window.removeEventListener('fueltankstate:confirm_prompt', handler);
        });
    });

    describe('continuous staleness re-evaluation', () => {
        it('flags requires_confirm on getState() when last_sample_at is stale, even mid-session', () => {
            const FuelTankState = freshFuelTankState();
            global.CockpitConfig = { aircraft: () => 36 };
            FuelTankState.init(18, 18, 'L');
            // Force last_sample_at far in the past without going through onSample
            const raw = JSON.parse(localStorage.getItem(FuelTankState.STORAGE_KEY));
            raw.last_sample_at = new Date(Date.now() - 46 * 60 * 1000).toISOString(); // 46 min ago
            localStorage.setItem(FuelTankState.STORAGE_KEY, JSON.stringify(raw));
            // getState() alone (no onSample) must re-evaluate staleness
            expect(FuelTankState.needsConfirmation()).toBe(true);
        });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/shared/fuel-tank-state.test.js`
Expected: multiple FAIL — `dropped_burn_estimate_gal` undefined, capacity not clamped, confirm prompt fires immediately, staleness not re-evaluated.

- [ ] **Step 3: Implement the capacity clamp in `init()`**

In `web/shared/fuel-tank-state.js`, replace:

```js
    static init(leftGal, rightGal, activeTank = 'L') {
        const now = new Date().toISOString();
        FuelTankState._state = {
            left_gal: Math.max(0, leftGal),
            right_gal: Math.max(0, rightGal),
```

with:

```js
    static init(leftGal, rightGal, activeTank = 'L') {
        const now = new Date().toISOString();
        let perSideCap = Infinity;
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) perSideCap = cap / 2;
            }
        } catch (_) { /* no config available — no clamp */ }
        FuelTankState._state = {
            left_gal: Math.min(perSideCap, Math.max(0, leftGal)),
            right_gal: Math.min(perSideCap, Math.max(0, rightGal)),
```

- [ ] **Step 4: Implement `dropped_burn_estimate_gal`**

Replace:

```js
        const dtMs = Math.min(nowMs - lastMs, FuelTankState.MAX_SAMPLE_DT_MS);
        if (dtMs <= 0) return;

        const burned = gph * (dtMs / 1000) / 3600;
```

with:

```js
        const rawDtMs = nowMs - lastMs;
        const dtMs = Math.min(rawDtMs, FuelTankState.MAX_SAMPLE_DT_MS);
        if (dtMs <= 0) return;

        const droppedMs = rawDtMs - dtMs;
        if (droppedMs > 0) {
            const droppedGal = gph * (droppedMs / 1000) / 3600;
            FuelTankState._state.dropped_burn_estimate_gal =
                (FuelTankState._state.dropped_burn_estimate_gal || 0) + droppedGal;
        }

        const burned = gph * (dtMs / 1000) / 3600;
```

Also add `dropped_burn_estimate_gal: 0,` to the state object literal in `init()` (in the same object as `imbalance: false,`) so a fresh init resets the counter.

- [ ] **Step 5: Implement confirm-prompt timing fix**

Replace:

```js
    static init(leftGal, rightGal, activeTank = 'L') {
        const now = new Date().toISOString();
```

with (adding one line):

```js
    static init(leftGal, rightGal, activeTank = 'L') {
        const now = new Date().toISOString();
        FuelTankState._lastConfirmPromptAt = Date.now();
```

(Placed here rather than after `_state` is built — order doesn't matter since it's an independent static field.)

- [ ] **Step 6: Implement continuous staleness re-evaluation**

Extract the staleness check from `_load()` into a shared method, and call it from both `_load()` and `getState()`. Replace:

```js
    static _load() {
        if (FuelTankState._loaded) return;
        FuelTankState._loaded = true;
        try {
            const raw = localStorage.getItem(FuelTankState.STORAGE_KEY);
            FuelTankState._state = raw ? JSON.parse(raw) : null;
        } catch (_) {
            FuelTankState._state = null;
        }
        // Mark stale if app restarted mid-flight
        if (FuelTankState._state && !FuelTankState._state.requires_confirm) {
            const lastMs = FuelTankState._state.last_sample_at
                ? new Date(FuelTankState._state.last_sample_at).getTime()
                : 0;
            if (lastMs && (Date.now() - lastMs) > FuelTankState.STALE_MS) {
                FuelTankState._state.requires_confirm = true;
                FuelTankState._save();
            }
        }
    }
```

with:

```js
    static _load() {
        if (FuelTankState._loaded) return;
        FuelTankState._loaded = true;
        try {
            const raw = localStorage.getItem(FuelTankState.STORAGE_KEY);
            FuelTankState._state = raw ? JSON.parse(raw) : null;
        } catch (_) {
            FuelTankState._state = null;
        }
        FuelTankState._checkStaleness();
    }

    /** Re-evaluate staleness against the current clock. Called on every getState()/needsConfirmation(),
     *  not just once per page load, so a silent mid-session data gap is caught. */
    static _checkStaleness() {
        if (FuelTankState._state && !FuelTankState._state.requires_confirm) {
            const lastMs = FuelTankState._state.last_sample_at
                ? new Date(FuelTankState._state.last_sample_at).getTime()
                : 0;
            if (lastMs && (Date.now() - lastMs) > FuelTankState.STALE_MS) {
                FuelTankState._state.requires_confirm = true;
                FuelTankState._save();
            }
        }
    }
```

Then update `getState()` and `needsConfirmation()` to call `_checkStaleness()` after `_load()`:

```js
    static getState() {
        FuelTankState._load();
        FuelTankState._checkStaleness();
        return FuelTankState._state ? { ...FuelTankState._state } : null;
    }
```

```js
    static needsConfirmation() {
        FuelTankState._load();
        FuelTankState._checkStaleness();
        if (!FuelTankState._state) return true;
        return !!FuelTankState._state.requires_confirm;
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/shared/fuel-tank-state.test.js`
Expected: all PASS

- [ ] **Step 8: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS (no regressions in existing suites)

- [ ] **Step 9: Commit**

```bash
git add web/shared/fuel-tank-state.js tests/shared/fuel-tank-state.test.js
git commit -m "fix(fuel): capacity clamp, dropped-burn tracking, confirm-prompt and staleness timing in FuelTankState"
```

---

### Task 3: FuelState becomes the override layer

**Files:**
- Modify: `web/shared/fuel-state.js`
- Modify: `web/shared/settings.js`
- Test: Create `tests/shared/fuel-state.test.js` (new)

**Interfaces:**
- Consumes: `FuelTankState.getState()` (from Task 2, returns `{left_gal, right_gal, ...}` or `null`), `Settings.fuelManualOverride`, `CockpitConfig.aircraft('performance.fuel_capacity_gal')`
- Produces: `FuelState.getCurrentFuel()` → `{ gallons: number, source: 'manual'|'tank_state'|'capacity' }`. `FuelState.getStartFuel()` keeps its existing signature/return shape (`{gallons, source}` with `source` one of `'manual'|'edm'|'tic'|'capacity'`).
- **These are two distinct APIs — `getStartFuel()` does NOT delegate to `getCurrentFuel()` and never returns `source: 'tank_state'`.** Use `getStartFuel()` for pre-flight/planning reads (what was in the tanks at engine start) and `getCurrentFuel()` for live in-flight reads (what is in the tanks now, per `FuelTankState`). The `'edm'`/`'tic'` branches in `getStartFuel()` are the correct source for the pre-flight, engine-off case. Tasks 8, 9, 12, and 13 depend on this separation — do not collapse the two.

- [ ] **Step 1: Write failing tests**

Create `tests/shared/fuel-state.test.js`:

```js
// tests/shared/fuel-state.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const fuelStateSrc = readFileSync('web/shared/fuel-state.js', 'utf8');

function freshFuelState({ tankState = null, manualOverride = null, capacity = 36 } = {}) {
    global.window = global.window || {};
    global.Settings = {
        fuelManualOverride: manualOverride,
        fuelMeasurement: null,
    };
    global.CockpitConfig = { aircraft: (key) => key === 'performance.fuel_capacity_gal' ? capacity : null };
    global.FuelTankState = { getState: () => tankState };
    global.FuelEngine = { extractEdmFuel: () => 0 };
    return new Function(`${fuelStateSrc}\nreturn FuelState;`)();
}

describe('FuelState.getCurrentFuel()', () => {
    it('returns manual override when set, highest priority', () => {
        const FuelState = freshFuelState({
            manualOverride: 22,
            tankState: { left_gal: 5, right_gal: 5 },
        });
        const result = FuelState.getCurrentFuel();
        expect(result).toEqual({ gallons: 22, source: 'manual' });
    });

    it('falls back to FuelTankState total when no override', () => {
        const FuelState = freshFuelState({
            tankState: { left_gal: 8.5, right_gal: 7.2 },
        });
        const result = FuelState.getCurrentFuel();
        expect(result.gallons).toBeCloseTo(15.7, 5);
        expect(result.source).toBe('tank_state');
    });

    it('falls back to capacity when neither override nor tank state exist', () => {
        const FuelState = freshFuelState({ capacity: 36 });
        const result = FuelState.getCurrentFuel();
        expect(result).toEqual({ gallons: 36, source: 'capacity' });
    });
});

describe('FuelState capacity fallback', () => {
    it('matches fuel-tanks.js\'s own fallback derivation when config is unavailable', () => {
        global.window = global.window || {};
        global.Settings = { fuelManualOverride: null, fuelMeasurement: null };
        global.CockpitConfig = undefined; // simulate unavailable config
        global.FuelTankState = { getState: () => null };
        global.FuelEngine = { extractEdmFuel: () => 0 };
        const FuelState = new Function(`${fuelStateSrc}\nreturn FuelState;`)();
        // fuel-tanks.js's own hardcoded fallback is 18/side = 36 total — must match, not the old 50
        expect(FuelState.getCurrentFuel().gallons).toBe(36);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/shared/fuel-state.test.js`
Expected: FAIL — `getCurrentFuel` is not a function; capacity fallback test fails (currently 50, must be 36)

- [ ] **Step 3: Implement `getCurrentFuel()` and fix the capacity fallback**

In `web/shared/fuel-state.js`, add the new method and a shared capacity helper. Replace the class body's closing (after `clearManualOverride()`) — insert before the final `}`:

```js
    /**
     * Get current fuel on board using the canonical live-fuel priority chain:
     * manual override > FuelTankState (canonical live per-tank tracker) > capacity fallback.
     * @returns {{ gallons: number, source: 'manual'|'tank_state'|'capacity' }}
     */
    static getCurrentFuel() {
        const manual = Settings.fuelManualOverride;
        if (manual != null && manual > 0) {
            return { gallons: manual, source: 'manual' };
        }
        try {
            if (typeof FuelTankState !== 'undefined') {
                const state = FuelTankState.getState();
                if (state) {
                    return { gallons: state.left_gal + state.right_gal, source: 'tank_state' };
                }
            }
        } catch (_) { /* FuelTankState unavailable */ }
        return { gallons: FuelState._capacityFallback(), source: 'capacity' };
    }

    /** Shared capacity fallback — must match fuel-tanks.js's own 18gal/side * 2 default. */
    static _capacityFallback() {
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) return cap;
            }
        } catch (_) { /* use default */ }
        return 36; // matches fuel-tanks.js's hardcoded 18gal/side fallback, not the old 50gal guess
    }
```

Then simplify `getStartFuel()`'s final fallback to reuse the same helper — replace:

```js
        // 4. Full capacity (lowest priority)
        let cap = 50;
        try {
            if (typeof CockpitConfig !== 'undefined') {
                cap = CockpitConfig.aircraft('performance.fuel_capacity_gal') ?? 50;
            }
        } catch (_) { /* use default */ }

        return { gallons: cap, source: 'capacity' };
```

with:

```js
        // 4. Full capacity (lowest priority)
        return { gallons: FuelState._capacityFallback(), source: 'capacity' };
```

- [ ] **Step 4: Fix `Settings.fuelMeasurement`'s malformed default**

Read `web/shared/settings.js` around its `DEFAULTS` object (`grep -n "fuel_measurement" web/shared/settings.js`) to confirm the exact current line, then change:

```js
    fuel_measurement: 'gallons',
```

to:

```js
    fuel_measurement: null,
```

Then verify every read site's guard already handles `null` correctly (they do — `fuel-state.js:53-54`'s `measurement && measurement.total_gal > 0` and `fuel-tanks.js:257`'s `m && typeof m === 'object'` both already treat `null` as "no measurement," so no other file needs to change).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/shared/fuel-state.test.js`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/shared/fuel-state.js web/shared/settings.js tests/shared/fuel-state.test.js
git commit -m "feat(fuel): FuelState.getCurrentFuel() delegates to canonical FuelTankState; fix capacity fallback and measurement default"
```

---

### Task 4: fuel-tanks.js — sender-display suppression above the accurate threshold

**Files:**
- Modify: `web/cockpit/fuel-tanks.js`
- Test: manual (no test harness for `web/cockpit/*.js`)

**Interfaces:**
- Consumes: `CockpitConfig.aircraft('performance.fuel_sender_accurate_below_gal')` (from Task 1), `FuelTankState.getState()` per-tank levels

- [ ] **Step 1: Load the threshold in `init()`**

In `web/cockpit/fuel-tanks.js`'s `init()` method, alongside the existing capacity read:

```js
    init() {
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) this._tankCapacity = cap / 2;
                this._senderAccurateBelowGal = CockpitConfig.aircraft('performance.fuel_sender_accurate_below_gal') ?? 12;
            }
        } catch (_) {}
```

Add `this._senderAccurateBelowGal = 12;` to the constructor's field initializers (alongside `this._tankCapacity = 18;`) as the default before `init()` runs.

- [ ] **Step 2: Suppress the sender display above the threshold**

Replace `_updateSenderDisplay()`:

```js
    _updateSenderDisplay(data) {
        // Raw EDM sender values — secondary reference only, kept visible as sanity check
        const senderL = data.fuel_level_l ?? data.left_fuel ?? null;
        const senderR = data.fuel_level_r ?? data.right_fuel ?? null;
        if (senderL != null) {
            this._dom.senderL.textContent = 's:' + senderL.toFixed(1);
        } else if (senderL == null && senderR == null) {
            const total = FuelEngine.extractEdmFuel(data);
            if (total > 0) this._dom.senderL.textContent = `s:${total.toFixed(0)}`;
        }
        if (senderR != null) this._dom.senderR.textContent = 's:' + senderR.toFixed(1);
    }
```

with:

```js
    _updateSenderDisplay(data) {
        // Raw EDM sender values — secondary reference only. Only meaningful (per this
        // aircraft's sender hardware) once tracked tank level drops to the configured
        // threshold; above it the sender reads an invalid/flat value and must not be
        // shown as if it were a real cross-check.
        const senderL = data.fuel_level_l ?? data.left_fuel ?? null;
        const senderR = data.fuel_level_r ?? data.right_fuel ?? null;
        const trackedState = (typeof FuelTankState !== 'undefined') ? FuelTankState.getState() : null;
        const threshold = this._senderAccurateBelowGal ?? 12;

        const leftInRange = !trackedState || trackedState.left_gal <= threshold;
        const rightInRange = !trackedState || trackedState.right_gal <= threshold;

        if (senderL != null) {
            this._dom.senderL.textContent = leftInRange ? 's:' + senderL.toFixed(1) : 's:\u2014';
        } else if (senderL == null && senderR == null) {
            const total = FuelEngine.extractEdmFuel(data);
            if (total > 0) this._dom.senderL.textContent = leftInRange ? `s:${total.toFixed(0)}` : 's:\u2014';
        }
        if (senderR != null) {
            this._dom.senderR.textContent = rightInRange ? 's:' + senderR.toFixed(1) : 's:\u2014';
        }
    }
```

- [ ] **Step 3: Manual verification**

With the app running against real or simulated engine data (`tools/mock-stratux.py` or the data simulator), confirm: with tracked tank level above 12 gal, the sender readout shows `s:—`; once it drops to ≤12 gal, the real sender number appears. Verify independently per tank (e.g. force an imbalance so one tank is below threshold and the other isn't).

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/fuel-tanks.js
git commit -m "fix(fuel): suppress sender cross-check display above its known-accurate range"
```

---

### Task 5: fuel-tanks.js — open-panel sync gaps

**Files:**
- Modify: `web/cockpit/fuel-tanks.js`
- Test: manual

**Interfaces:**
- Consumes: `fuelstate:changed` event (dispatched by `FuelState.setManualOverride()`/`clearManualOverride()`, already exists), `fueltankstate:changed` event (already consumed)

- [ ] **Step 1: Listen for `fuelstate:changed` too**

In `init()`, alongside the existing `fueltankstate:changed` listener:

```js
        this._onStateChanged = () => { this._render(); this._refreshOpenPanel(); };
        window.addEventListener('fueltankstate:changed', this._onStateChanged);
```

add:

```js
        this._onFuelStateChanged = () => this._refreshOpenPanel();
        window.addEventListener('fuelstate:changed', this._onFuelStateChanged);
```

And in `destroy()`, alongside the existing removal:

```js
        if (this._onStateChanged) window.removeEventListener('fueltankstate:changed', this._onStateChanged);
```

add:

```js
        if (this._onFuelStateChanged) window.removeEventListener('fuelstate:changed', this._onFuelStateChanged);
```

- [ ] **Step 2: Add a dirty-since-open guard to prevent clobbering in-progress edits**

Add `this._initPanelDirty = false;` to the constructor's field initializers, alongside `this._initPanelMode = null;`.

In `_buildDOM()`, after the existing input wiring, add change listeners that set the dirty flag — find where `initL`/`initR` are created (in the DOM refs cache, `this._dom.initL = ...`) and add after `wireTap(this._dom.initOk, ...)`:

```js
        this._dom.initL.addEventListener('input', () => { this._initPanelDirty = true; });
        this._dom.initR.addEventListener('input', () => { this._initPanelDirty = true; });
```

Clear the flag whenever the panel is freshly opened or closed — in `_openInitDialog()`, `_showRecoveryModal()`, `_applyInit()`, and the cancel handler, add `this._initPanelDirty = false;`. Concretely:
- `_openInitDialog()`: add `this._initPanelDirty = false;` right before `this._initPanelMode = 'preflight';`
- `_showRecoveryModal()`: add `this._initPanelDirty = false;` right before `this._initPanelMode = 'recovery';`
- `_applyInit()`: add `this._initPanelDirty = false;` right before `this._initPanelMode = null;`
- The cancel handler (`wireTap(this._dom.initCancel, ...)`): change `() => { this._dom.initPanel.style.display = 'none'; this._initPanelMode = null; }` to also reset `this._initPanelDirty = false;`

Then guard `_refreshOpenPanel()` — replace:

```js
    _refreshOpenPanel() {
        if (!this._initPanelMode || this._dom.initPanel.style.display !== 'flex') return;
```

with:

```js
    _refreshOpenPanel() {
        if (!this._initPanelMode || this._dom.initPanel.style.display !== 'flex') return;
        if (this._initPanelDirty) return; // pilot is mid-edit — don't overwrite with a live value
```

(Recovery-mode panels don't need special handling here — `FuelTankState.onSample()` already no-ops while `requires_confirm` is true, so `fueltankstate:changed` never fires from routine burn integration while a recovery panel is open; the dirty guard is a no-op safety net for that mode, harmless either way.)

- [ ] **Step 2: Manual verification**

1. Open the preflight init dialog, start typing a new value in the L field, and (via the simulator or by waiting for a live sample) trigger a `fueltankstate:changed` event — confirm the field you're editing does NOT get overwritten.
2. With the panel open and untouched, apply a manual override via `fuel-overlay.js` — confirm the init panel's fields update to reflect it.

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/fuel-tanks.js
git commit -m "fix(fuel): open init/recovery panel now syncs on manual override and never clobbers in-progress edits"
```

---

### Task 6: fuel-overlay.js — fuel-stop reset via tic measurement

**Files:**
- Modify: `web/cockpit/fuel-overlay.js`
- Test: manual

**Interfaces:**
- Consumes: `this._leftTic`/`this._rightTic` (existing instance fields, already populated by the tic sliders in §A of the same screen), `FuelEngine.ticToGallons()`, `FuelTankState.init()` (from Task 2, now capacity-clamped), `FuelTankState.getState().dropped_burn_estimate_gal` (from Task 2)
- Produces: `_recordFuelStop()` no longer calls `FuelTankState.topOff()`

- [ ] **Step 1: Replace the additive top-off with a tic-based `init()`**

In `_recordFuelStop()`, replace:

```js
            // Update current fuel total: previous fuel + gallons added
            const { gallons: currentFuel } = FuelState.getStartFuel();
            const newTotal = currentFuel + gallons;
            FuelState.saveMeasurement({ total_gal: newTotal, source: 'tic' });

            // Update synthetic per-tank state if available
            if (typeof FuelTankState !== 'undefined') {
                const galL = parseFloat(this._dom.addGalL?.value);
                const galR = parseFloat(this._dom.addGalR?.value);
                if (galL > 0) FuelTankState.topOff('L', galL);
                if (galR > 0) FuelTankState.topOff('R', galR);
                if (!(galL > 0) && !(galR > 0)) {
                    // No per-tank split given — divide evenly
                    FuelTankState.topOff('L', gallons / 2);
                    FuelTankState.topOff('R', gallons / 2);
                }
            }
```

with:

```js
            // Reset tracked fuel from the tic-mark reading already entered above (§A),
            // exactly like _applyMeasurement() does — a fuel stop is always grounded in
            // a fresh physical measurement, never computed from "previous + added."
            const leftGal = FuelEngine.ticToGallons(this._leftTic, this._coefficients);
            const rightGal = FuelEngine.ticToGallons(this._rightTic, this._coefficients);
            if (leftGal <= 0 && rightGal <= 0) {
                this._setAddStatus('Enter a tic-mark reading above before recording a fuel stop', 'error');
                return;
            }
            const existingTank = (typeof FuelTankState !== 'undefined') ? FuelTankState.getState() : null;
            if (typeof FuelTankState !== 'undefined') {
                FuelTankState.init(leftGal, rightGal, existingTank?.active_tank ?? 'L');
            }
            const m = FuelEngine.createMeasurement(this._leftTic, this._rightTic, this._coefficients);
            FuelState.saveMeasurement(m);
            const newTotal = m.total_gal;
```

(`newTotal` is kept as a variable since the existing success-status line below references it: `` `Recorded: +${gallons.toFixed(1)} gal at ${airport || '—'} → ${newTotal.toFixed(1)} gal total` `` — no change needed there, it now reflects the real post-measurement total instead of a computed estimate.)

- [ ] **Step 2: Surface the dropped-burn estimate near the tic fields**

Add a small status element to the DOM (near the tic total row) and populate it whenever nonzero. In the `_buildDOM()` template, after the `fo-total-row` div:

```html
            <div class="fo-total-row">
                TOTAL: <span id="fo-total-gal" class="fo-total-val">0.0</span> gal
            </div>
```

add:

```html
            <div class="fo-dropped-burn-row" id="fo-dropped-burn-row" style="display:none;">
                Possible under-tracked burn during a comms gap: <span id="fo-dropped-burn-val">0.0</span> gal
            </div>
```

Cache the refs in the `_dom` object (`droppedBurnRow: this._el.querySelector('#fo-dropped-burn-row')`, `droppedBurnVal: this._el.querySelector('#fo-dropped-burn-val')`), and populate them in `show()` (where the overlay is opened) — add after the existing manual-override restore block:

```js
        // Surface any dropped-burn estimate from FuelTankState (comms-gap tracking)
        try {
            const tankState = (typeof FuelTankState !== 'undefined') ? FuelTankState.getState() : null;
            const dropped = tankState?.dropped_burn_estimate_gal ?? 0;
            if (dropped > 0.05) {
                this._dom.droppedBurnVal.textContent = dropped.toFixed(2);
                this._dom.droppedBurnRow.style.display = '';
            } else {
                this._dom.droppedBurnRow.style.display = 'none';
            }
        } catch (_) { /* FuelTankState unavailable */ }
```

Style `.fo-dropped-burn-row` in `web/style.css` using existing design tokens — `color: var(--color-caution); font-weight: 700;` — matching the caution-badge pattern documented in the project CLAUDE.md, not a hardcoded color.

- [ ] **Step 3: Manual verification**

1. Enter a tic reading in §A, tap "RECORD FUEL STOP" in §E without filling "Total gal added" — confirm it's rejected with the new status message (since gallons-added is still required as before for the K-factor input, but the reset itself now depends on the tic fields, not the gallons field).
2. Enter both a tic reading and a gallons-added figure, tap "RECORD FUEL STOP" — confirm `FuelTankState.getState()` afterward exactly matches the tic-derived gallons (not `previous + added`).
3. Confirm the K-Factor Calculator (§G) still populates correctly afterward — `flytab_fuel_stops` and `flypi_fuel_history` should be unaffected by this change (verify by checking `_renderKFactor()`'s displayed ratio didn't reset/break).
4. Force a `dropped_burn_estimate_gal` > 0 (simulate a >10s gap between engine-data samples) and confirm the new row appears with the right value; confirm it's hidden when zero.

- [ ] **Step 4: Update the user manual**

Per project CLAUDE.md, this changes pilot-visible behavior (fuel-stop recording is now tic-based, and a new dropped-burn indicator can appear). Add a short note to `docs/user-manual.md`'s fuel section describing that recording a fuel stop now requires a fresh tic-mark entry, and what the dropped-burn indicator means.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/fuel-overlay.js web/style.css docs/user-manual.md
git commit -m "fix(fuel): fuel-stop recording resets FuelTankState from a fresh tic measurement, not additive arithmetic"
```

---

### Task 7: app.js — in-flight fuel-stop overlay opens fuel-overlay.js

**Files:**
- Modify: `web/app.js`
- Test: manual

**Interfaces:**
- Consumes: `this.fuelOverlay.show()` (existing instance, `web/app.js:577`), `FuelTankState.getState()?.initialized_at` (from Task 2/existing field) to detect a fresh measurement was applied since the fuel-stop overlay opened

- [ ] **Step 1: Replace the inline gallons-added input with a "Measure Fuel" action**

In `_showFuelStopOverlay()`, replace the "Fuel" card block:

```js
                <div style="background:var(--bg-surface);border-radius:8px;padding:12px;margin-bottom:12px;">
                    <div style="font-size:12px;color:var(--text-label);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Fuel</div>
                    ${hasPreset
                        ? `<div style="font-size:16px;color:var(--text-primary);">Add <strong>${presetGal.toFixed(1)}\u2009gal</strong> \u2014 fill to <strong>${fillToGal}\u2009gal</strong></div>`
                        : `<div style="display:flex;align-items:center;gap:8px;">
                               <label for="fso-fuel-input" style="font-size:14px;color:var(--text-secondary);">Gallons added:</label>
                               <input id="fso-fuel-input" type="number" min="0" max="${fuelCap}" step="0.5"
                                   style="width:80px;padding:6px 8px;background:var(--bg-surface-raised);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;font-size:16px;text-align:right;">
                           </div>`
                    }
                </div>
```

with:

```js
                <div style="background:var(--bg-surface);border-radius:8px;padding:12px;margin-bottom:12px;">
                    <div style="font-size:12px;color:var(--text-label);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Fuel</div>
                    ${hasPreset
                        ? `<div style="font-size:14px;color:var(--text-secondary);margin-bottom:8px;">Planned refuel: ~${presetGal.toFixed(1)}\u2009gal (fill to ~${fillToGal}\u2009gal) \u2014 measure actual tic marks below</div>`
                        : ''
                    }
                    <div id="fso-measure-status" style="font-size:14px;color:var(--color-danger);font-weight:700;margin-bottom:8px;">Not yet measured</div>
                    <button id="fso-measure-btn"
                        style="width:100%;min-height:var(--touch-min, 56px);padding:12px;background:var(--accent);color:var(--text-on-dark);border:none;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;">
                        \u270f Measure &amp; Record Fuel
                    </button>
                </div>
```

- [ ] **Step 2: Wire the measure button and gate "Continue" on a fresh measurement**

Replace the `#fso-continue-btn` click handler:

```js
        overlay.querySelector('#fso-continue-btn').addEventListener('click', () => {
            let gallonsAdded = 0;
            if (hasPreset) {
                gallonsAdded = presetGal;
            } else {
                const input = overlay.querySelector('#fso-fuel-input');
                gallonsAdded = parseFloat(input?.value) || 0;
            }

            if (typeof FuelState !== 'undefined') {
                const currentFuel = (fuelAtStop != null && fuelAtStop > 0)
                    ? fuelAtStop
                    : FuelState.getStartFuel().gallons;
                const newTotal = Math.min(currentFuel + gallonsAdded, fuelCap);
                FuelState.saveMeasurement({ total_gal: newTotal, source: 'tic' });
                window.dispatchEvent(new CustomEvent('fuelstate:changed'));
            }

            overlay.remove();
            this.showToast(`Flight ${nextNum} active \u2014 ${nextDest} ${nextDistS}nm`);
        });
```

with:

```js
        const overlayShownAt = Date.now();
        const measureStatusEl = overlay.querySelector('#fso-measure-status');
        const refreshMeasureStatus = () => {
            const state = (typeof FuelTankState !== 'undefined') ? FuelTankState.getState() : null;
            const measuredSinceOpen = state?.initialized_at &&
                new Date(state.initialized_at).getTime() >= overlayShownAt;
            if (measuredSinceOpen) {
                measureStatusEl.textContent = `Measured: ${(state.left_gal + state.right_gal).toFixed(1)} gal`;
                measureStatusEl.style.color = 'var(--color-success)';
            } else {
                measureStatusEl.textContent = 'Not yet measured';
                measureStatusEl.style.color = 'var(--color-danger)';
            }
            return measuredSinceOpen;
        };
        refreshMeasureStatus();
        const onTankStateChanged = () => refreshMeasureStatus();
        window.addEventListener('fueltankstate:changed', onTankStateChanged);

        overlay.querySelector('#fso-measure-btn').addEventListener('click', () => {
            this.fuelOverlay.show();
        });

        overlay.querySelector('#fso-continue-btn').addEventListener('click', () => {
            if (!refreshMeasureStatus()) {
                measureStatusEl.textContent = 'Measure fuel before continuing';
                return;
            }
            window.removeEventListener('fueltankstate:changed', onTankStateChanged);
            overlay.remove();
            this.showToast(`Flight ${nextNum} active \u2014 ${nextDest} ${nextDistS}nm`);
        });

        overlay.querySelector('#fso-close-btn').addEventListener('click', () => {
            window.removeEventListener('fueltankstate:changed', onTankStateChanged);
        }, { once: false }); // in addition to the existing close-btn listener already registered above
```

(The existing `#fso-close-btn` listener that clears `_shownFuelStopOverlays` and removes the overlay stays as-is; this adds a second listener on the same button purely to clean up the new `fueltankstate:changed` subscription — both listeners fire on the same click, order doesn't matter here.)

- [ ] **Step 3: Manual verification**

1. Trigger the fuel-stop overlay (fly within 10nm of a fuel-stop waypoint in a test route, or call `_showFuelStopOverlay` directly via console for testing).
2. Confirm "Continue" does nothing but show "Measure fuel before continuing" when tapped before measuring.
3. Tap "Measure & Record Fuel", apply a tic measurement in the overlay that opens, close it, confirm the fuel-stop overlay's status now shows "Measured: X gal" in green.
4. Tap "Continue" — confirm it now proceeds and shows the toast.

- [ ] **Step 4: Update the user manual**

This is a pilot-visible workflow change (fuel-stop confirmation now requires an explicit measurement step instead of a quick gallons-added entry). Update `docs/user-manual.md`'s fuel-stop section accordingly.

- [ ] **Step 5: Commit**

```bash
git add web/app.js docs/user-manual.md
git commit -m "fix(fuel): in-flight fuel-stop flow requires a fresh tic measurement before continuing"
```

---

### Task 8: route-table.js — active-flight live source + reset-ordering fix

**Files:**
- Modify: `web/cockpit/route-table.js`
- Test: manual (no automated coverage for this file per project CLAUDE.md)

**Interfaces:**
- Consumes: `FuelState.getCurrentFuel()` (from Task 3)

- [ ] **Step 1: Re-read the current `_computeEnroute()` before editing**

Run `grep -n "_computeEnroute\|activeFlightNum\|_plannedStartFuel\|fuelResetIndices" web/cockpit/route-table.js` to get current exact line numbers (this file may have shifted slightly since the audit) before making the edit below — do not apply the diff blind to stale line numbers.

- [ ] **Step 2: Make active-flight fuel use the live source regardless of flight index**

Locate the block (originally around line 1310-1320):

```js
        const activeFlightNum = this._waypoints[this._activeIndex]?._flightIndex ?? 0;
        let startFuel = (activeFlightNum === 0)
            ? ((typeof FuelState !== 'undefined') ? FuelState.getStartFuel().gallons : fuelCap)
            : (this._flights[activeFlightNum]?._plannedStartFuel ?? fuelCap);
```

Replace with:

```js
        const activeFlightNum = this._waypoints[this._activeIndex]?._flightIndex ?? 0;
        // The flight currently being flown always uses the live canonical fuel source —
        // not just flight 0. A flight becomes "active" the moment the pilot's active
        // waypoint enters its range; before that, its start fuel is a forward-looking
        // projection only (see the projection block below).
        let startFuel = (typeof FuelState !== 'undefined')
            ? FuelState.getCurrentFuel().gallons
            : fuelCap;
```

- [ ] **Step 3: Remove the now-dead `_plannedStartFuel` back-fill**

Locate the back-fill block near the end of `_computeEnroute()` (originally around line 1596-1601):

```js
        // Back-fill _plannedStartFuel for Flight N+1 now that _totFuel is known.
        // Used by the next _computeEnroute call so Flight 2+ show correct pre-stop fuel numbers.
        const depFuel0 = (typeof FuelState !== 'undefined') ? FuelState.getStartFuel().gallons : fuelCap;
        let rollingFuel = depFuel0;
        for (let fi = 0; fi < this._flights.length; fi++) {
            this._flights[fi]._plannedStartFuel = rollingFuel;
```

Read the full loop body (a few more lines past what's quoted here) before removing it — it's superseded by the projection logic in Step 4, but confirm nothing else in the file reads `_plannedStartFuel` first (`grep -n "_plannedStartFuel" web/cockpit/route-table.js` — after this task, it should have zero remaining references once Step 4 is also done). Replace this whole loop with the projection computation from Step 4 instead of just deleting it — see Step 4 for the replacement code.

- [ ] **Step 4: Implement the forward-looking projection for not-yet-reached flights**

> **CORRECTED 2026-07-31 — the original code in this step computed wrong fuel numbers and was
> deliberately NOT implemented in Task 8.** Two defects: (1) it seeded `projectedFuel` from
> `startFuel`, which by that point every in-loop fuel-stop reset has already advanced to the *last*
> flight's value, not the active flight's; (2) it never subtracted each flight's burn (`_totFuel`),
> which the back-fill loop it replaces did do. Verified on a 3-flight trip (30 gal aboard, 40 gal
> capacity, 10 gal burned per leg, explicit `fuel_add_gal: 5`): the old code produced
> `_projectedStartFuel = [—, 25, 30]` where the true per-flight start fuel is `[30, 25, 20]` — a
> **10 gal over-report** on the last flight, i.e. showing MORE fuel than exists, which is the exact
> error class this plan exists to eliminate. Use the corrected code below.
>
> This step remains UNIMPLEMENTED. `_projectedStartFuel` and `_isProjection` have zero consumers,
> so nothing is user-visible today; implement it in whichever future task first renders a projected
> figure, and give it tests at that point.

Replace the loop identified in Step 3 with:

```js
        // Forward-looking projection for flights not yet reached (planning estimate only,
        // never the live/authoritative figure — that's Step 2 above once a flight is active).
        // Seed from the ACTIVE flight's start fuel, then for each subsequent flight subtract the
        // preceding flight's burn before adding fuel at the stop. Both halves matter: seeding from
        // the post-loop `startFuel` or skipping the burn subtraction over-reports fuel.
        let projectedFuel = startFuel;
        for (let fi = activeFlightNum + 1; fi < this._flights.length; fi++) {
            const flight = this._flights[fi];
            const prevBurn = this._flights[fi - 1]?._totFuel ?? 0;
            const remAtStop = Math.max(0, projectedFuel - prevBurn);
            const stopWp = this._waypoints[flight.depWpIndex];
            const addGal = stopWp?.fuel_add_gal;
            projectedFuel = (addGal != null)
                ? Math.min(fuelCap, remAtStop + addGal)
                : fuelCap; // no explicit fuel_add_gal declared — assume fill to capacity
            flight._projectedStartFuel = projectedFuel;
            flight._isProjection = true; // UI hook: render distinctly from a live figure
        }
```

Seed `projectedFuel` from the active flight's start fuel (the live `FuelState.getCurrentFuel()`
value from Step 2), **not** from a `startFuel` variable the per-waypoint loop has already mutated.
When implementing, assert the 3-flight partial-fill case above yields `[30, 25, 20]`.

- [ ] **Step 5: Fix the reset-ordering bug for the projection path**

Locate the fuel-reset block inside the main per-waypoint loop (originally around line 1400-1410):

```js
            if (fuelResetIndices.has(i) && i > this._activeIndex) {
                const fuelRemAtStop = startFuel - fuelBurned;
                const fuelAdded = wp.fuel_add_gal != null
                    ? Math.min(wp.fuel_add_gal, fuelCap - fuelRemAtStop)  // explicit: add only what was pumped
                    : (fuelCap - fuelRemAtStop);                           // default: fill to capacity
                wp._fuelAdded = fuelAdded;   // stash for "Fuel added" row in _renderTable
                fuelBurned = 0;
                startFuel  = fuelRemAtStop + fuelAdded;
            }

            // If we have segment data, use it for phase, fuel, and time
            if (segs.length > 0 && i > 0) {
```

The bug: this reset fires *before* the segment loop below it (which computes and subtracts this same waypoint's own arrival-leg burn from `fuelBurned`) has run for waypoint `i`. Move the reset to fire *after* the segment loop instead. Replace the block above with just:

```js
            // If we have segment data, use it for phase, fuel, and time
            if (segs.length > 0 && i > 0) {
```

(i.e. delete the `if (fuelResetIndices.has(i) ...)` block from its current position — it's being relocated, not removed)

Then find the end of the segment-processing `if (segs.length > 0 && i > 0) { ... }` block for this same waypoint (it ends before the next waypoint's iteration begins — locate the closing brace via `grep -n` around the code the audit quoted at route-table.js:1456-1459 `thisSegFuel`/`segFuel`/`segTime`, then read forward to find where that block closes), and insert the reset there instead, now using the *post-burn* `fuelBurned`:

```js
            } // end of "if (segs.length > 0 && i > 0)"

            // Fuel-stop reset — now runs AFTER this waypoint's own arrival-leg burn (above)
            // has been subtracted, so fuelRemAtStop reflects fuel actually remaining on
            // arrival, not a pre-arrival snapshot. This is a PROJECTION only (see Step 4) —
            // it does not drive the live figure for the flight that's actually being flown.
            if (fuelResetIndices.has(i) && i > this._activeIndex) {
                const fuelRemAtStop = startFuel - fuelBurned;
                const fuelAdded = wp.fuel_add_gal != null
                    ? Math.min(wp.fuel_add_gal, fuelCap - fuelRemAtStop)
                    : (fuelCap - fuelRemAtStop);
                wp._fuelAdded = fuelAdded;
                fuelBurned = 0;
                startFuel  = fuelRemAtStop + fuelAdded;
            }
```

Confirm by reading the surrounding code that this insertion point is genuinely after the segment loop closes and before the next waypoint's iteration starts, not inside a nested block — if the exact brace structure differs from this description once you re-read the live file, adapt the insertion point accordingly but preserve the ordering invariant: **segment burn must be subtracted from `fuelBurned` before the reset reads `fuelBurned`.**

- [ ] **Step 6: Manual verification**

1. Reproduce the original bug scenario: a route with a fuel stop (e.g. the KLKR→GSO→KFGX→KLWA route from the original bug report). Confirm REM now decreases monotonically approaching the fuel-stop waypoint instead of jumping upward.
2. Fly (or simulate) past the fuel stop into flight 2. Confirm flight 2's fuel figures now come from `FuelTankState`'s live reading (matching whatever was set via Task 6/7's tic-based reset), not a full-tank assumption — test specifically with a partial fill to confirm it's NOT showing full capacity.
3. Confirm a flight not yet reached still shows a reasonable forward projection, visually distinguished (check whatever rendering hook consumes `flight._isProjection` — if none exists yet, note this as a follow-up UI task rather than blocking this fix, since the data-layer fix is the safety-critical part).

- [ ] **Step 7: Commit**

```bash
git add web/cockpit/route-table.js
git commit -m "fix(fuel): active flight uses live FuelTankState fuel regardless of flight index; fix fuel-stop reset ordering"
```

---

### Task 9: route-table.js — DEST reserve fuel-stop awareness + destination lookup consistency

**Files:**
- Modify: `web/cockpit/route-table.js`
- Test: manual

**Interfaces:**
- Consumes: `this._flights` (existing), `FuelState.getCurrentFuel()` (from Task 3)

- [ ] **Step 1: Re-read current line numbers**

Run `grep -n "_updateSummary\|_emitRouteChange\|destWp\b" web/cockpit/route-table.js` before editing.

- [ ] **Step 2: Fix the live-data DEST reserve branch to be fuel-stop-aware**

Locate (originally around line 2618-2630):

```js
        // Fuel at destination — live engine GPH if available, else planned
        const engData = window.enginePanel?.lastData;
        const currentFuel = engData?.fuel_remaining_gal ?? engData?.fuel_gal ?? null;
        const liveGph = engData?.fuel_flow_gph ?? engData?.gph ?? null;
        const plannedGph = CockpitConfig.aircraft('performance.cruise_gph') ?? 9.0;
        const destWp = this._waypoints[this._waypoints.length - 1];
        let fuelAtDest = null;
        if (currentFuel != null && remainDist > 0 && cruiseSpeed > 0) {
            const gph = liveGph ?? plannedGph;
            fuelAtDest = currentFuel - (remainDist / cruiseSpeed) * gph;
        } else if (destWp?._fuelRem != null) {
            fuelAtDest = destWp._fuelRem;
        }
```

Replace with:

```js
        // Fuel at destination — live canonical fuel if available, else planned figure.
        // Fuel-stop-aware: uses the ACTIVE FLIGHT's remaining distance to its own
        // destination (which may be a fuel stop, not the trip's final destination),
        // not the whole remaining trip distance.
        const currentFuel = (typeof FuelState !== 'undefined') ? FuelState.getCurrentFuel().gallons : null;
        const engData = window.enginePanel?.lastData;
        const liveGph = engData?.fuel_flow_gph ?? engData?.gph ?? engData?.Fuel_Flow ?? null;
        const plannedGph = CockpitConfig.aircraft('performance.cruise_gph') ?? 9.0;
        const activeFlightNum = this._waypoints[this._activeIndex]?._flightIndex ?? 0;
        const activeFlight = this._flights[activeFlightNum];
        // Distance remaining to the ACTIVE flight's own destination (fuel stop or final),
        // not the trip's overall remaining distance — remainDist as computed above already
        // sums to the final waypoint, so recompute scoped to the active flight's end index.
        let remainDistToActiveFlightDest = 0;
        if (activeFlight) {
            for (let i = this._activeIndex; i <= activeFlight.destWpIndex; i++) {
                remainDistToActiveFlightDest += (i === this._activeIndex)
                    ? (this._waypoints[i]._liveDist ?? this._waypoints[i]._legDist ?? 0)
                    : (this._waypoints[i]._legDist ?? 0);
            }
        } else {
            remainDistToActiveFlightDest = remainDist; // no flight-split data — fall back to trip-wide
        }
        const destWp = [...this._waypoints].reverse().find(wp => wp.type === 'APT')
                    || this._waypoints[this._waypoints.length - 1];
        let fuelAtDest = null;
        if (currentFuel != null && remainDistToActiveFlightDest > 0 && cruiseSpeed > 0) {
            const gph = liveGph ?? plannedGph;
            fuelAtDest = currentFuel - (remainDistToActiveFlightDest / cruiseSpeed) * gph;
        } else if (destWp?._fuelRem != null) {
            fuelAtDest = destWp._fuelRem;
        }
```

- [ ] **Step 3: Fix `_emitRouteChange()`'s destination lookup**

Locate (originally around line 802):

```js
                destination: this._waypoints[this._waypoints.length - 1]?.icao || '',
```

Replace with:

```js
                destination: ([...this._waypoints].reverse().find(wp => wp.type === 'APT')
                    || this._waypoints[this._waypoints.length - 1])?.icao || '',
```

- [ ] **Step 4: Manual verification**

1. Build a route with a fuel stop and confirm the DEST reserve figure (header "DEST:X.X") now reflects distance to the *active flight's* endpoint while flying the first leg, not the whole trip, when live engine data is present.
2. Build a route with trailing missed-approach/hold fixes after the destination airport, make an in-cockpit edit that triggers a save, and confirm `flight_plan.destination` in the saved plan is the real airport ICAO, not the trailing fix.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/route-table.js
git commit -m "fix(fuel): DEST reserve figure is fuel-stop-aware; destination lookup uses APT-aware walk-back consistently"
```

---

### Task 10: route-table.js — passed-leg segment staleness clearing

**Files:**
- Modify: `web/cockpit/route-table.js`
- Test: manual

- [ ] **Step 1: Re-read current line numbers**

Run `grep -n "Mark passed waypoints" web/cockpit/route-table.js`.

- [ ] **Step 2: Clear segment-level fields alongside waypoint-level fields**

Locate (originally around line 1554-1563):

```js
        // Mark passed waypoints
        for (let i = 0; i < this._activeIndex; i++) {
            this._waypoints[i]._dist = null;
            this._waypoints[i]._ete = null;
            this._waypoints[i]._fuel = null;
            this._waypoints[i]._fuelRem = null;
            this._waypoints[i]._brg = null;
            this._waypoints[i]._hdg = null;
            this._waypoints[i]._phase = '\u2014';
        }
```

Replace with:

```js
        // Mark passed waypoints — clear both waypoint-level fields and their segments'
        // fields, since multi-segment (CLB/CRZ/DES) legs are rendered from wp._segments,
        // not the waypoint-level fields, and were previously left showing stale numbers.
        for (let i = 0; i < this._activeIndex; i++) {
            this._waypoints[i]._dist = null;
            this._waypoints[i]._ete = null;
            this._waypoints[i]._fuel = null;
            this._waypoints[i]._fuelRem = null;
            this._waypoints[i]._brg = null;
            this._waypoints[i]._hdg = null;
            this._waypoints[i]._phase = '\u2014';
            if (this._waypoints[i]._segments) {
                for (const seg of this._waypoints[i]._segments) {
                    seg._fuel = null;
                    seg._fuelRem = null;
                    seg._tas = null;
                    seg._pwr = null;
                }
            }
        }
```

- [ ] **Step 3: Confirm the renderer treats null the same as the waypoint-level case**

Read `_getCellValue`'s `seg` branch (`grep -n "case 'fuel':" web/cockpit/route-table.js` to locate it) and confirm it already renders `—` for `seg._fuel == null` / `seg._fuelRem == null` (the audit confirmed this: `seg._fuel != null ? seg._fuel.toFixed(1) : '—'`) — no renderer change needed, only the clearing was missing.

- [ ] **Step 4: Manual verification**

Build a multi-leg route with at least one departure leg that has a climb segment (CLB+CRZ, i.e. a multi-segment leg), fly past it (or simulate active-index advancement), and confirm its FUEL/REM columns now show `—` instead of stale numbers. Confirm the trip/flight footer total still matches the sum of visible (non-dashed) rows.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/route-table.js
git commit -m "fix(fuel): clear segment-level fuel fields on passed multi-segment legs, not just waypoint-level fields"
```

---

### Task 11: Canonical %power → GPH table in the planning library

> **SCOPE ADDITION 2026-07-31 (Dana's decision) — measured phase GPH belongs in this task.**
>
> **Governing principle, from Dana:** *"We want to be approximately correct but not precisely
> wrong. There are many variables that can change the fuel flow and we want to be on the side of
> planning more consumption rather than less."* Derive planning constants from a **conservative
> upper percentile (p85), never the median or mean** — a median under-plans burn on half of all
> flights, and under-planned burn over-states fuel remaining, the direction that runs tanks dry.
>
> **1. Fix `descent_gph`.** `aircraft-config.json` has `descent_gph: 4`. Measured p85 across
> 11,819 phase-labelled samples is **6.9 gph** — the config under-plans descent burn by ~2.9 gph,
> the one constant genuinely wrong in the unsafe direction. Roughly 0.7 gal per 15-min descent,
> ~2 gal across a three-leg day, and it bites nearest reserves. This is user-visible (route fuel
> numbers change) — update `docs/user-manual.md` in the same commit.
>
> **2. Leave `climb_gph: 15` alone.** It looks 40% high against a 10.7 gph median, but p85 is
> **15.1** — the value is already correct under the principle above. Do NOT "correct" it downward.
> Use **one** measured `climb_gph`; Dana explicitly does not want climb split into full-power vs
> cruise-climb sub-phases. `cruise_gph: 9` vs p85 8.3 is likewise already conservative — leave it.
>
> **3. Derive from `ml_phase`, not RPM heuristics.** `web/cockpit/flight-recorder.js` writes an
> `ml_phase` column (53 of 82 CSVs carry it) from the 12-phase detector, so takeoff/climb/cruise/
> descent rows can be selected directly. `~/engine_analysis/build_power_curve.py` currently finds
> cruise with RPM/stability heuristics (`MIN_CRUISE_RPM 2000`, stable alt/speed 3+ min, GS>80,
> roll<15°) and never uses `ml_phase`. Measured p85 reference values: takeoff 17.5, climb 15.1,
> cruise 8.3, descent 6.9.
>
> **4. The %power label semantics are inconsistent — state which definition wins.** Dana flies
> **50°F lean of peak**; the Lycoming charts these formulas come from are **50°F rich of peak**.
> When LOP, *power is determined by fuel flow, not by MP* (`HP = GPH × 14.9` for the 8.5:1 O-360).
> `engine_monitor.py` already does this correctly — it uses fuel flow for power when LEAN and
> RPM/MP when RICH. But `build_power_curve.py`'s `estimate_pct_power()` falls back to
> `(RPM/2700) × (MAP/29.92) × 100`, the chart/MP formula, so the `pct` labels on the bands are
> MP-derived while their `gph` values are measured. That is why 8.1 gph (67% by LOP physics) sits
> in the band labelled 65%. The measured `gph` is ground truth; make the table authoritative and
> document which definition the `pct` label carries so planning and the engine page agree.
>
> Note `route-table.js`'s `lop_sfc = 0.067` is **not** a wrong constant — it equals 14.93 HP/gph,
> matching the Pi's LOP factor. The defect is feeding an MP-derived label into a fuel-derived
> equation, not the equation itself.
>
> **5. RESOLVED 2026-07-31 (Dana's decision) — the planning library's cruise constant stays at
> 8.1 gph; do not raise it to the measured cruise p85 of 8.3.** A review of the first fix round
> flagged this as a possible gap under the "plan more consumption, not less" principle. Two
> things resolve it:
>
> - **8.1 and 8.3 are not measuring the same thing.** 8.1 gph is the measured value for the
>   61-65% power band specifically (1,120 samples) — i.e. conditioned on the aircraft's actual
>   configured cruise power setting (`cruise_pwr_pct: 65`). 8.3 is the p85 across *all*
>   cruise-phase samples pooled regardless of power setting — i.e. unconditioned, blending
>   flights at 55%, 60%, 65%, 70%, etc. For the specific question "what does 65% cruise power
>   burn," 8.1 is the more correct figure, not merely an acceptable-but-lower one.
> - **On this carbureted engine, a 0.2 gph delta is within normal fuel-flow variance (~0.5
>   gph) and is noise, not signal.** Chasing it would imply a precision the airframe doesn't
>   support — exactly what "approximately correct but not precisely wrong" warns against.
>
> Also verified and worth recording: this engine runs LOP, where fuel flow determines power
> directly (`HP = GPH × 14.9`) rather than RPM/MP. Checked against Dana's real climb-phase data,
> binned by matched %power band across altitude (2,000-8,000 ft): fuel flow is flat across
> altitude for a given %power band (e.g. 60-65% power: 7.5 gph at both 2-4K ft, n=946, and 4-6K
> ft, n=903 — effectively identical). This is the LOP-physics prediction, not just theory, and it
> is why a single measured `climb_gph` (no altitude split, no sub-phase split) is the right model.

**Files:**
- Modify: `web/shared/planning/planner/route-planner.js`
- Modify: `web/shared/planning-adapters/idb-profile.js`
- Test: `tests/planning/planner/route-planner.test.js` (existing — add cases), `tests/planning/math/engine-data.test.js` (existing — verify no regression)

**Interfaces:**
- Consumes: `aircraft-config.json`'s `performance.power_settings[]` (from Task 1, band-shaped: `{band, pct_mid, gph, samples}`)
- Produces: a new exported helper `gphForPowerPct(powerSettings, pct)` in `web/shared/planning/math/engine-data.js` — `(powerSettings: Array<{pct_mid:number, gph:number}>, pct: number) => number`, picks the closest `pct_mid` band by absolute distance.

- [ ] **Step 1: Read the current files before editing**

Read `web/shared/planning/planner/route-planner.js`'s `RV9A_FALLBACK` definition and `web/shared/planning-adapters/idb-profile.js`'s `RV9A_DEFAULT` definition in full, and `web/shared/planning/math/engine-data.js` in full, before making any change — confirm the exact current shape of `fuelPhases.cruise.gph`/`fuel_burn_gph` before replacing it.

- [ ] **Step 2: Write a failing test for the new lookup helper**

Add to `tests/planning/math/engine-data.test.js`:

```js
describe('gphForPowerPct', () => {
    const bands = [
        { band: '51-55', pct_mid: 53, gph: 6.5, samples: 149 },
        { band: '56-60', pct_mid: 58, gph: 7.3, samples: 329 },
        { band: '61-65', pct_mid: 63, gph: 8.1, samples: 1120 },
    ];

    it('picks the exact band when pct matches pct_mid', () => {
        expect(gphForPowerPct(bands, 63)).toBe(8.1);
    });

    it('picks the nearest band when pct falls between two bands', () => {
        // pct=60 is 2 away from band 58 (56-60) and 3 away from band 63 (61-65) -> nearest is 58's 7.3
        expect(gphForPowerPct(bands, 60)).toBe(7.3);
    });

    it('returns null for an empty table', () => {
        expect(gphForPowerPct([], 65)).toBeNull();
    });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/planning/math/engine-data.test.js`
Expected: FAIL — `gphForPowerPct is not defined`

- [ ] **Step 4: Implement `gphForPowerPct`**

Add to `web/shared/planning/math/engine-data.js` (as a named export, matching the file's existing export style — check whether it uses `export function` — the planning library, unlike `web/cockpit/`, does use ES modules):

```js
/**
 * Look up GPH for a given %power from a banded power-settings table.
 * @param {Array<{pct_mid:number, gph:number}>} powerSettings
 * @param {number} pct
 * @returns {number|null}
 */
export function gphForPowerPct(powerSettings, pct) {
    if (!powerSettings || powerSettings.length === 0) return null;
    let best = powerSettings[0];
    let bestDist = Math.abs(pct - best.pct_mid);
    for (const band of powerSettings) {
        const dist = Math.abs(pct - band.pct_mid);
        if (dist < bestDist) {
            best = band;
            bestDist = dist;
        }
    }
    return best.gph;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/planning/math/engine-data.test.js`
Expected: PASS

- [ ] **Step 6: Wire `route-planner.js` and `idb-profile.js` to the canonical table**

In `route-planner.js`'s `RV9A_FALLBACK` object, replace the hardcoded `fuel_burn_gph: 8.1` and `fuelPhases.cruise.gph: 8.1` with a lookup against `aircraft-config.json`'s `performance.power_settings[]` at `performance.cruise_pwr_pct` (65 for this aircraft), using `gphForPowerPct`. Since `RV9A_FALLBACK` is a static object literal evaluated once (not a function), and the actual config value needs a runtime read, refactor it to a function `buildRv9aFallback()` that reads `CockpitConfig.aircraft(...)` (matching the pattern already used elsewhere in this file — confirm `CockpitConfig` is accessible from this module before assuming; if not, this becomes a required parameter passed in from the caller instead — read how this file is invoked from `web/cockpit/route-planner-panel.js` before choosing between these two approaches, since the planning library is designed to be host-environment-agnostic and may not have direct `CockpitConfig` access).

Given the planning library's environment-agnostic design (confirmed by its adapter pattern — `planning-adapters/`), the correct approach is: **do not reach into `CockpitConfig` from `route-planner.js` directly.** Instead, `idb-profile.js`'s `RV9A_DEFAULT` (which already represents the per-aircraft profile persisted to IndexedDB — the proper place for this data in this architecture) becomes the single source, and it should be seeded from `aircraft-config.json`'s `power_settings[]` at whatever point the profile store syncs from config (locate this sync point — likely in `app.js` or wherever `IdbProfileStore` is initialized — via `grep -rn "RV9A_DEFAULT\|IdbProfileStore" web/`). Update `RV9A_DEFAULT`'s `fuel_burn_gph`/`fuelPhases.cruise.gph` to `8.1` (the value the current `power_settings[cruise_pwr_pct]` band already resolves to, hardcoded here as the seed default — this still hardcodes ONE number, but it's now a documented seed/default rather than a second independent source of truth, since the profile is meant to be refreshed from config at sync time, not maintained as a permanently-separate value).

Then make `route-planner.js`'s `RV9A_FALLBACK` (the in-file fallback used only when no `profiles` adapter is available at all) match `RV9A_DEFAULT`'s corrected `8.1` value exactly, with a comment noting both must be kept in sync until a future change makes the fallback read from the same config sync path.

- [ ] **Step 7: Move `reserve_gal` into both profile objects from config**

Add `reserve_gal: 10` (matching Task 1's new `aircraft-config.json` value) to both `RV9A_FALLBACK` and `RV9A_DEFAULT`, replacing whatever value (if any) they currently have, with a comment noting the value must match `aircraft-config.json`'s `performance.reserve_gal` until the same config-sync unification happens for this field.

- [ ] **Step 8: Run the full planning-library test suite**

Run: `npm test`
Expected: PASS — check specifically that `tests/planning/planner/route-planner.test.js` and `tests/planning/planner/optimizer.test.js` still pass with the corrected `8.1` GPH value (they may have assertions baked in against the old `8.1` already, in which case no change needed there; if any test asserted a different hardcoded value, update it to match).

- [ ] **Step 9: Commit**

```bash
git add web/shared/planning/math/engine-data.js web/shared/planning/planner/route-planner.js web/shared/planning-adapters/idb-profile.js tests/planning/math/engine-data.test.js
git commit -m "fix(fuel): add gphForPowerPct band lookup; reconcile planning-library GPH/reserve with real EDM-derived data"
```

---

### Task 12: engine-page.js migration

**Files:**
- Modify: `web/cockpit/engine-page.js`
- Test: manual

**Interfaces:**
- Consumes: `FuelState.getCurrentFuel()` (from Task 3)

- [ ] **Step 1: Re-read current line numbers**

Run `grep -n "gallonsRem\|flight_fuel_used\|fuelLowGal\|fuelCriticalGal\|fuelCautionGal\|fuelWarningGal" web/cockpit/engine-page.js`.

- [ ] **Step 2: Replace the inline EDM fallback chain with the canonical read**

Locate the line matching (originally line 426):

```js
const gallonsRem = d.gallons_rem ?? d.fuel_remaining_gal ?? d.Gallons_Rem ?? d.Fuel_Remaining ?? d.fuel_remaining ?? 0;
```

Replace with:

```js
const gallonsRem = (typeof FuelState !== 'undefined') ? FuelState.getCurrentFuel().gallons : 0;
```

(This changes the source from "whatever raw EDM field happens to be populated" to the canonical `FuelTankState`-backed value — verify this doesn't break the surrounding code's expectations by reading a few lines of context before and after this line first, since `d` may still be needed for other fields on the same line/block.)

- [ ] **Step 3: Fix the "used" gauge field**

Locate (originally line 427):

```js
const fuelUsed = d.flight_fuel_used ?? 0;
```

Replace with:

```js
const fuelUsed = d.fuel?.flight_fuel_used ?? 0;
```

- [ ] **Step 4: Fix the config keys**

Locate (originally lines 54-55):

```js
fuelLowGal: 8,
fuelCriticalGal: 4,
```

Rename throughout the file to match the real schema — replace every occurrence of `fuelLowGal` with `fuelCautionGal` and `fuelCriticalGal` with `fuelWarningGal` (run `grep -n "fuelLowGal\|fuelCriticalGal" web/cockpit/engine-page.js` to find every occurrence — expect the defaults at ~54-55 and the usage at ~560-561; rename both).

- [ ] **Step 5: Manual verification**

1. Confirm the Engine Page's REMAINING/ENDURANCE/RANGE fields still show real numbers (not blank/zero) with live or simulated engine data.
2. Confirm "USED (FLIGHT)" now shows a real number instead of the placeholder.
3. In the config editor, change `enginePage.fuelCautionGal`/`fuelWarningGal` to custom values, confirm the Engine Page fuel-bar coloring now responds to the change (it previously didn't).

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/engine-page.js
git commit -m "fix(fuel): engine-page.js reads canonical fuel state and correct config keys"
```

---

### Task 13: range-calc.js migration

**Files:**
- Modify: `web/cockpit/range-calc.js`
- Test: manual

**Interfaces:**
- Consumes: `FuelState.getCurrentFuel()` (from Task 3)

- [ ] **Step 1: Re-read current line numbers**

Run `grep -n "fuelRemaining\|engData" web/cockpit/range-calc.js`.

- [ ] **Step 2: Replace the broken fallback chain**

Locate (originally line 36-37):

```js
const fuelRemaining = engData ? (engData.fuel_remaining_gal || engData.fuel_gal || engData.Gallons_Rem || 0) : 0;
```

Replace with:

```js
const fuelRemaining = (typeof FuelState !== 'undefined') ? FuelState.getCurrentFuel().gallons : 0;
```

Read the surrounding function to confirm `engData` isn't needed for anything else on that line (GPH is read separately per the audit — `engData.fuel_flow_gph || engData.gph || engData.Fuel_Flow || 0` stays as the live GPH source, unrelated to this fix, unless Task 14 unifies GPH sourcing too — it doesn't, GPH stays sourced from live engine data everywhere per the design's Non-goals section preserving the live-GPH-override capability).

- [ ] **Step 3: Manual verification**

With live or simulated fuel/engine data, confirm the nav-strip's RANGE, FUEL, and ENDURANCE fields now show real values instead of permanently `—`, and the map's range ring now renders.

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/range-calc.js
git commit -m "fix(fuel): range-calc.js reads canonical fuel state — fixes always-blank RANGE/FUEL/ENDURANCE display"
```

---

### Task 14: route-table.js `_emitLegUpdate()` canonical read

> **SCOPE ADDITION 2026-07-31 (Dana's decision) — three items folded in here.**
>
> **1. Stale tracked fuel must not render as a live figure.** `FuelState.getCurrentFuel()` returns
> tank gallons even when `FuelTankState.needsConfirmation()` is true — i.e. the fuel stream broke for
> >45 min (in-flight tablet reboot, Pi dropout, app killed) and the burn during that gap was never
> subtracted, so the figure reads **HIGH**. The route table's REM column, the DEST badge and
> `_emitLegUpdate`'s `fuelRemaining` all present it with no staleness indication. Task 12 fixed this
> on the engine page by keeping the number visible but explicitly marking it unconfirmed — Dana's
> stated preference, since blanking removes a figure the pilot may want in the air while an unmarked
> stale number is the actual hazard. **Apply the same treatment here, consistently with the engine
> page's marker** (read that implementation first). Prefer surfacing staleness through
> `getCurrentFuel()`'s return (e.g. an added field) over each consumer calling
> `FuelTankState.needsConfirmation()` independently — but note that changing that shared API affects
> every consumer, so enumerate them and state the effect on each before changing it.
>
> **2. Adopt `_emitLegUpdate`'s containment lookup in `_updateSummary`** (deferred from Task 9's
> review). `_updateSummary` resolves the active flight via `_flightIndex` while `_emitLegUpdate` uses
> containment (`f => activeIndex >= f.depWpIndex && activeIndex <= f.destWpIndex`). Because
> `_buildFlights` gives a fuel-stop waypoint the DEPARTING flight's index, flying the final leg INTO
> a fuel stop makes the badge read 15.0 where arrival fuel is 25.0 — and simultaneously the route
> strip shows 15.0 while `route-nav-strip.js`'s `_calcFuelAtDest` shows ~25.0. Two fuel-at-destination
> numbers on screen at once, 10 gal apart. The containment lookup closes both.
>
> **3. Gate the planned fallback on `getCurrentFuel().source !== 'capacity'`** (also deferred from
> Task 9). When scoped distance is 0 but trip distance is not, the badge falls through to
> `destWp._fuelRem` — a planned POST-REFUEL figure decoupled from actual tanks — measured reading
> 30.0 with 10 gal aboard. That is the over-reporting direction.
>
> **4. Include the nav strip in the staleness surface** (found by Task 13). `range-calc.js` feeds the
> nav strip's FUEL / RANGE / ENDURANCE fields from the same canonical read and is likewise blind to
> `needsConfirmation()` — a mutation forcing that flag true breaks an engine-page test but nothing in
> range-calc. Whatever staleness treatment this task lands must cover the nav strip too, or the two
> instruments will disagree about whether the same number is trustworthy.
>
> **5. Nav strip conflates dry tanks with no data** (also from Task 13). A genuinely dry tracked state
> (0.0 gal) renders identically to "nothing tracked" — both `—`. Task 12 eliminated exactly this
> conflation on the engine page; the nav strip still has it. Under-reporting so not a hazard, but the
> two instruments are now inconsistent on the edge that matters most.
>
> **Testability note:** `web/cockpit/route-table.js` is script-tag loaded with no importable-ESM path,
> so it has NO unit coverage — every route-table change in Tasks 8-11 was verified by scratch
> harnesses instead. Expect the same here; verify by harness and say plainly what is not covered.

**Files:**
- Modify: `web/cockpit/route-table.js`
- Test: manual

**Interfaces:**
- Consumes: `FuelState.getCurrentFuel()` (from Task 3)
- Produces: `activeroute:legupdate` event's `fuelRemaining` field now reflects manual overrides — consumed unchanged by `route-nav-strip.js` and `power-tradeoff.js` (no code change expected in those two files; Step 3 below verifies this)

- [ ] **Step 1: Re-read current line numbers**

Run `grep -n "_emitLegUpdate\|fuelRem\s*=" web/cockpit/route-table.js`.

- [ ] **Step 2: Replace the raw EDM read**

Locate (originally line 1640-1643):

```js
        const engData = window.enginePanel?.lastData;
        const liveGph = engData?.fuel_flow_gph ?? engData?.gph ?? engData?.Fuel_Flow ?? null;
        const fuelRem = engData?.fuel_remaining_gal ?? engData?.fuel_gal ?? engData?.Gallons_Rem ?? engData?.Fuel_Remaining ?? null;
```

Replace with:

```js
        const engData = window.enginePanel?.lastData;
        const liveGph = engData?.fuel_flow_gph ?? engData?.gph ?? engData?.Fuel_Flow ?? null; // GPH stays live-EDM-sourced (preserves the documented live-override capability)
        const fuelRem = (typeof FuelState !== 'undefined') ? FuelState.getCurrentFuel().gallons : null;
```

- [ ] **Step 3: Verify `route-nav-strip.js`/`power-tradeoff.js` need no code change**

Read both files' consumption of the `activeroute:legupdate` event's `fuelRemaining` field (`grep -n "fuelRemaining" web/cockpit/route-nav-strip.js web/cockpit/power-tradeoff.js`) and confirm they only read `d.fuelRemaining`/`legData.fuelRemaining` as an opaque number — if either file independently re-derives fuel from `engData` directly (bypassing the event payload), that would need its own fix; the audit did not find this, but verify before assuming.

- [ ] **Step 4: Manual verification**

1. In flight (or simulated), set a manual fuel override via `fuel-overlay.js`.
2. Confirm `route-nav-strip.js`'s FUEL@DEST and `power-tradeoff.js`'s table now reflect the override immediately, where previously they kept showing the raw EDM value.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/route-table.js
git commit -m "fix(fuel): _emitLegUpdate() uses canonical fuel state — manual override now reaches live nav-strip/power-tradeoff displays"
```

---

### Task 15: wb-overlay.js staleness check

**Files:**
- Modify: `web/cockpit/wb-overlay.js`
- Test: manual

**Interfaces:**
- Consumes: `FuelTankState.needsConfirmation()` (existing method)

- [ ] **Step 1: Re-read current line numbers**

Run `grep -n "_syncFuelFromState" web/cockpit/wb-overlay.js`.

- [ ] **Step 2: Add the staleness check**

Locate (originally lines 167-176):

```js
    _syncFuelFromState() {
        if (!this._fuelInput) return;
        if (this._fuelInput.value) return;  // user already typed a value — keep it
        try {
            const fuel = FuelState.getStartFuel();
            if (fuel && fuel.gallons > 0) {
                this._fuelInput.value = Math.round(fuel.gallons * 10) / 10;
            }
        } catch (_) {}
    }
```

Replace with:

```js
    _syncFuelFromState() {
        if (!this._fuelInput) return;
        if (this._fuelInput.value) return;  // user already typed a value — keep it
        try {
            const fuel = FuelState.getStartFuel();
            if (fuel && fuel.gallons > 0) {
                this._fuelInput.value = Math.round(fuel.gallons * 10) / 10;
                const stale = (typeof FuelTankState !== 'undefined') && FuelTankState.needsConfirmation();
                this._showFuelStalenessWarning(stale);
            }
        } catch (_) {}
    }

    /** Show/hide a warning that the pre-filled fuel figure hasn't been confirmed. */
    _showFuelStalenessWarning(show) {
        if (!this._fuelStaleWarningEl) return;
        this._fuelStaleWarningEl.style.display = show ? '' : 'none';
    }
```

Add the warning element to the overlay's DOM template (find where `_fuelInput` itself is created, add a sibling element right after it) and cache the ref:

```html
<div class="wb-fuel-stale-warning" id="wb-fuel-stale-warning" style="display:none;">
    ⚠ Fuel quantity unconfirmed — verify before using this weight
</div>
```

```js
this._fuelStaleWarningEl = this._el.querySelector('#wb-fuel-stale-warning');
```

Style `.wb-fuel-stale-warning` using the project's caution-badge token pattern: `background: var(--color-caution); color: #000; font-weight: 700; padding: 8px; border-radius: 4px; margin-top: 4px;` in `web/style.css`.

- [ ] **Step 3: Manual verification**

1. With `FuelTankState` in a confirmed (fresh) state, open the W&B overlay — confirm no warning appears.
2. Force `FuelTankState.needsConfirmation()` to return true (e.g. simulate a stale restart), open the W&B overlay — confirm the warning appears alongside the pre-filled value.

- [ ] **Step 4: Update the user manual**

This is a new pilot-visible warning indicator (not a bug fix restoring prior behavior — this UI element didn't exist before). Per the project CLAUDE.md's User Manual policy, add a short note to `docs/user-manual.md`'s W&B section describing when the "Fuel quantity unconfirmed" warning appears and what it means.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/wb-overlay.js web/style.css docs/user-manual.md
git commit -m "fix(fuel): W&B overlay warns when the pre-filled fuel figure is unconfirmed/stale"
```

---

### Task 16: Version bump, full build, and final verification

**Files:**
- Modify: `web/app.js` (version bump only)

**Interfaces:** none — integration task

- [ ] **Step 1: Run the full test suite one more time**

Run: `npm test`
Expected: PASS, all suites

- [ ] **Step 2: Bump `FLYTAB_VERSION`**

In `web/app.js`, increment `FLYTAB_VERSION` per the project's version format rules (no three digits after the decimal — e.g. `v9.98` → `v9.99`, not `v9.100`).

- [ ] **Step 3: Build**

Run: `bash build.sh`
Expected: build succeeds, APK produced in `data/`

- [ ] **Step 4: Full manual regression pass**

Re-run every "Manual verification" step from Tasks 4-15 in sequence on the built APK (device or emulator), plus the two scenarios from the design doc's Testing section not already covered per-task:
- The original KFGX-style scenario end-to-end (Task 8's verification covers this, re-confirm on-device)
- Confirm no regression in the airport-popup tap handler (per project CLAUDE.md's Tap Handler Regression Rule) — tap an airport on the map, confirm the popup still opens normally, even though no task in this plan touched the tap handlers directly.

- [ ] **Step 5: Commit the version bump**

```bash
git add web/app.js android/app/build.gradle
git commit -m "chore: bump version to vX.XX for fuel management consistency release"
```

---

## Self-Review Notes

- **Spec coverage:** All 9 architecture sections and all 25 appendix findings from the design doc map to a task above (Tasks 1-15 cover Sections 1-9; Task 16 is integration). The two corrections made during pre-implementation reading (K-Factor Calculator extension instead of new mechanism; gallons-added field retained for record-keeping) are reflected in Tasks 5-6.
- **Line numbers will drift.** Every task modifying `route-table.js`, `engine-page.js`, `range-calc.js`, `fuel-overlay.js` etc. includes a "re-read current line numbers" step precisely because these files may shift between when this plan was written and when each task executes (especially since tasks are sequential and earlier tasks in this same plan modify some of these files). Treat quoted line numbers as locators via the quoted code snippet, not as guaranteed-accurate coordinates.
- **Task 11 has more uncertainty than the others** (whether `CockpitConfig` is reachable from the planning library, exact profile-sync location) — flagged explicitly in-task rather than guessed at, since the planning library's environment-agnostic adapter design means the answer depends on code this plan's author did not have time to fully trace. Whoever executes Task 11 should budget extra investigation time there.
