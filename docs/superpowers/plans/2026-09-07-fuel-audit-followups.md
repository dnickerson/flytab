# Fuel Tracking Audit Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six remaining issues from the fuel-tracking code-review audit (the audit that also produced PR #143's dropped-burn correction): a tank-switch burn-misattribution safety bug, two fire-and-forget Pi syncs, an unvalidated tic-mark reading, an unsurfaced Pi K-factor calibration, a `||`/`??` bug in the flight recorder, and dead code in `FuelTankState`.

**Architecture:** Six independent, sequential tasks, each its own branch/PR per this repo's usual granularity (see PR #142/#143). No task depends on another task in this plan; all depend on PR #143 being merged to `main` first (see Global Constraints).

**Tech Stack:** Vanilla JS (`web/`), Python stdlib HTTP server (`engine-monitor/engine_monitor.py`), vitest (`tests/`), Python `unittest` (`engine-monitor/test_fuel_tracker.py`).

**Spec:** This plan's own research (no separate spec doc) — the six items originate from a code-review audit of PR #143, given directly by the user as:

| # | Finding | Severity |
|---|---|---|
| 1 (audit #3) | Tank-switch mid-interval misattributes burn to the tank you just left | Safety |
| 2 (audit #2b) | Fuel-stop/tic-entry sync to the Pi is fire-and-forget (`_syncFuelSetToEngine`/`_syncFuelAddToEngine`) — same silent-divergence risk fixed for dropped-burn in PR #143, but not for these | Safety |
| 3 (audit #4) | Tic-mark polynomial shows physically impossible numbers live (109gal at tic=17) with no validation before Apply | Accuracy |
| 4 (audit #5) | K-factor calibration fully computed on the Pi, never surfaced in FlyTab | Accuracy |
| 5 (audit —) | `flight-recorder.js:289` uses `\|\|` instead of `??`, mishandles an exact-zero fuel reading | Accuracy (minor) |
| 6 (audit —) | `FuelTankState.topOff()` dead code | Cleanup |

Every code snippet below was checked against the actual current source (`web/shared/fuel-tank-state.js`, `web/cockpit/fuel-overlay.js`, `web/shared/fuel-engine.js`, `web/shared/fuel-state.js`, `web/cockpit/flight-recorder.js`, `engine-monitor/engine_monitor.py`) on branch `worktree-fix+fuel-dropped-burn-correction` (PR #143) as of 2026-09-07 — not guessed.

## Global Constraints

- This plan assumes PR #143 (`fix: apply dropped-burn correction on both fuel trackers`) is merged to `main` first. Task 1 modifies the post-#143 `_debitActiveTank()`/`onSample()`. Tasks 2 and 4 build on the `_syncDroppedBurnToPi()` pattern, `_engineBaseUrl()` helper, and `_setStatus()` shared status-setter it introduces. If #143 has not merged yet when a task starts, branch from `worktree-fix+fuel-dropped-burn-correction` instead of `main`.
- Each task is its own branch (`fix/<task-slug>`) and PR, independently reviewable, matching this repo's existing granularity (see PR #142/#143 descriptions, which explicitly split unrelated fixes from the same investigation into separate PRs).
- Flight-safety-relevant tasks (1, 2, 3) touch code whose file header states "Flight-safety critical: errors cause fuel exhaustion risk" (`fuel-tank-state.js`) — no shortcuts on test coverage.
- Design Token Standards apply to any new UI. Task 4's PI K-FACTOR panel reuses only existing `.fo-kfactor-panel`/`.fo-kfactor-row`/`.fo-kfactor-item`/`.fo-kfactor-guidance`/`.fo-manual-btn`/`.fo-set-btn`/`.fo-add-status` classes already defined in `web/style.css` — no new CSS is added by this plan.
- `docs/user-manual.md` and `web/user-manual.md` are kept byte-identical in this repo (confirmed: PR #143 edited both with the same diff) and must be updated in the **same commit** as any user-visible behavior change. Task 2 changes user-visible behavior (the overlay no longer auto-closes after APPLY/RECORD when the Pi sync fails) and Task 4 adds a new visible panel — both need a manual update in their own commit. Tasks 1, 3, 5, 6 are bug fixes restoring correct behavior or internal cleanup with no new pilot-visible workflow step, so per CLAUDE.md's own carve-out ("Bug fixes that restore previously correct behavior... do not need a manual update") they do not require one — **except** Task 3's new refusal message, which IS a new workflow step (a reading the pilot could previously apply can now be refused) and needs one line added.
- Run `npm test` after every task. Run `bash build.sh` (after bumping `FLYTAB_VERSION` in `web/app.js`) once per task before considering it done, per Build Policy.
- All new/changed JS status text must go through the file's existing `_setStatus()`/`_setAddStatus()`/`_setApplyStatus()` helpers — do not hand-roll new status DOM.

---

## File Structure

| File | Responsibility | Tasks touching it |
|---|---|---|
| `web/shared/fuel-tank-state.js` | Per-tank burn integration, tank switching, dropped-burn tracking | 1, 3 (shared capacity helper), 6 |
| `web/cockpit/fuel-overlay.js` | Tic-mark entry UI, Pi sync, K-factor display | 2, 3, 4 |
| `web/cockpit/flight-recorder.js` | 1Hz CSV row logging | 5 |
| `engine-monitor/engine_monitor.py` | Pi-side fuel tracking, K-factor calibration endpoints | none (Task 4 only *consumes* existing endpoints — see research below, both `/api/fuel/calibration` GET and `/api/fuel/calibration/applied` POST already exist and are already correct) |
| `tests/shared/fuel-tank-state.test.js` | Tests for `fuel-tank-state.js` | 1, 6 |
| `tests/cockpit/fuel-overlay-*.test.js` | Tests for `fuel-overlay.js` (new files per concern, matching existing `fuel-overlay-dropped-burn.test.js` pattern) | 2, 3, 4 |
| `tests/cockpit/flight-recorder-fuel-remaining.test.js` (new) | Tests for `flight-recorder.js` | 5 |
| `docs/user-manual.md`, `web/user-manual.md` | Pilot-facing manual | 2, 3, 4 |

**Confirmed during research, not part of this plan's scope:** `engine_monitor.py` already exposes `GET /api/fuel/calibration` (returns `KFactorCalibration.get_calibration_status()`) and `POST /api/fuel/calibration/applied` (records an applied K-factor). Both are fully implemented and already tested Pi-side — Task 4 is JS-only, consuming these existing endpoints.

---

## Task 1: Fix tank-switch mid-interval burn misattribution (audit #3, Safety)

**Files:**
- Modify: `web/shared/fuel-tank-state.js:100-179` (`onSample()`, `_debitActiveTank()`, `switchTank()`)
- Test: `tests/shared/fuel-tank-state.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FuelTankState._debitTank(tank, gallons)` (new, used internally by `_debitActiveTank()`). No public API changes — `onSample(gph, nowMs)` and `switchTank(tank)` keep their existing signatures.

### Root cause

`onSample()` computes the burn for the whole capped interval `[last_sample_at, now]` and calls `_debitActiveTank(burned)`, which debits whichever tank `active_tank` currently is. `switchTank(tank)` updates `active_tank` **immediately** when called. So if the pilot switches tanks between two `onSample()` calls, the entire interval's burn — including the portion that was actually drawn from the tank they just left — gets attributed to the tank they just switched to. The tank just left is never debited for fuel it actually burned; its gauge reads high.

### Fix

Record which tank was active *before* a switch and when the switch happened. On the next `onSample()`, if a switch occurred inside `[last_sample_at, now]`, split the interval's burn proportionally at the switch point instead of crediting all of it to the currently-active tank.

- [ ] **Step 1: Write the failing tests**

Add to `tests/shared/fuel-tank-state.test.js`, inside a new `describe('mid-interval tank switch')` block (after the existing `describe('dropped_burn_estimate_gal', ...)` block):

```javascript
    describe('mid-interval tank switch', () => {
        it('splits burn across a mid-interval tank switch between the tank left and the tank switched to', () => {
            const FuelTankState = freshFuelTankState();
            delete global.CockpitConfig;
            FuelTankState.init(18, 18, 'L');
            const t0 = new Date(FuelTankState.getState().last_sample_at).getTime();

            // First sample: 2s @ 10 GPH burned from L before any switch.
            FuelTankState.onSample(10, t0 + 2000);
            const afterFirst = FuelTankState.getState();

            // Pilot switches to R 3s after that sample. Write the switch directly to
            // storage (mirrors switchTank()'s own writes) so the test can control the
            // exact timestamp instead of racing Date.now().
            const switchAt = t0 + 2000 + 3000;
            const switched = {
                ...afterFirst,
                active_tank: 'R',
                pre_switch_tank: 'L',
                tank_switched_at: new Date(switchAt).toISOString(),
            };
            localStorage.setItem(FuelTankState.STORAGE_KEY, JSON.stringify(switched));
            FuelTankState._loaded = false;

            // Next telemetry sample arrives 7s after the switch (10s after the last real sample).
            FuelTankState.onSample(10, switchAt + 7000);
            const finalState = FuelTankState.getState();

            // Of the 10s interval since the last sample, 3s was pre-switch (still fed
            // from L) and 7s was post-switch (fed from R) — burn must split accordingly,
            // not be credited entirely to R just because R is active by the time the
            // sample lands.
            expect(finalState.left_gal).toBeCloseTo(afterFirst.left_gal - 10 * (3 / 3600), 4);
            expect(finalState.right_gal).toBeCloseTo(18 - 10 * (7 / 3600), 4);
            expect(finalState.pre_switch_tank == null).toBe(true); // consumed
        });

        it('does not split burn when no tank switch occurred since the last sample', () => {
            const FuelTankState = freshFuelTankState();
            delete global.CockpitConfig;
            FuelTankState.init(18, 18, 'L');
            const t0 = new Date(FuelTankState.getState().last_sample_at).getTime();
            FuelTankState.onSample(10, t0 + 5000);
            const state = FuelTankState.getState();
            expect(state.left_gal).toBeCloseTo(18 - 10 * (5 / 3600), 4);
            expect(state.right_gal).toBe(18);
        });

        it('switchTank() records pre_switch_tank and tank_switched_at only when the tank actually changes', () => {
            const FuelTankState = freshFuelTankState();
            delete global.CockpitConfig;
            FuelTankState.init(18, 18, 'L');
            FuelTankState.switchTank('L'); // no-op — already on L
            expect(FuelTankState.getState().pre_switch_tank == null).toBe(true);
            FuelTankState.switchTank('R');
            const state = FuelTankState.getState();
            expect(state.pre_switch_tank).toBe('L');
            expect(state.active_tank).toBe('R');
        });
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fuel-tank-state`
Expected: FAIL — `finalState.left_gal`/`right_gal` don't match (all burn currently lands on whichever tank is active at sample time), and `pre_switch_tank` is `undefined` on the state object entirely (field doesn't exist yet).

- [ ] **Step 3: Implement the fix**

In `web/shared/fuel-tank-state.js`, replace the existing `onSample()` body (starting `static onSample(gph, nowMs) {`) through the end of `_debitActiveTank()` with:

```javascript
    static onSample(gph, nowMs) {
        FuelTankState._load();
        if (!FuelTankState._state || FuelTankState._state.requires_confirm) return;
        if (!gph || gph <= 0) return;

        const lastMs = FuelTankState._state.last_sample_at
            ? new Date(FuelTankState._state.last_sample_at).getTime()
            : nowMs;
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

        // If the pilot switched tanks since the last sample, split this interval's
        // burn at the switch point instead of crediting it all to whichever tank is
        // active now — otherwise burn actually drawn from the tank just left, before
        // the switch, is never subtracted from it.
        const switchMs = FuelTankState._state.tank_switched_at
            ? new Date(FuelTankState._state.tank_switched_at).getTime()
            : null;
        const preSwitchTank = FuelTankState._state.pre_switch_tank;
        FuelTankState._state.pre_switch_tank = null; // consume regardless of outcome below

        if (preSwitchTank && switchMs !== null && switchMs > lastMs && switchMs < nowMs) {
            const preFraction = (switchMs - lastMs) / rawDtMs;
            const burnedPre = burned * preFraction;
            const burnedPost = burned - burnedPre;
            if (!FuelTankState._debitTank(preSwitchTank, burnedPre)) return;
            if (!FuelTankState._debitActiveTank(burnedPost)) return;
        } else {
            if (!FuelTankState._debitActiveTank(burned)) return;
        }

        FuelTankState._state.last_sample_at = new Date(nowMs).toISOString();

        const diff = Math.abs(FuelTankState._state.left_gal - FuelTankState._state.right_gal);
        FuelTankState._state.imbalance = (
            diff > FuelTankState.IMBALANCE_GAL &&
            FuelTankState._state.left_gal > 2 &&
            FuelTankState._state.right_gal > 2
        );

        FuelTankState._save();
        FuelTankState._fire();

        // Periodic confirmation prompt while engine is running
        if ((nowMs - FuelTankState._lastConfirmPromptAt) > FuelTankState.CONFIRM_INTERVAL_MS) {
            FuelTankState._lastConfirmPromptAt = nowMs;
            window.dispatchEvent(new CustomEvent('fueltankstate:confirm_prompt', {
                detail: { active_tank: FuelTankState._state.active_tank }
            }));
        }
    }

    /**
     * Debit `gallons` from a specific tank ('L' or 'R'). An invalid tank (legacy
     * 'BOTH' state, or corruption) tells us nothing about which tank is draining;
     * splitting the burn would understate the feeding tank, so this stops and
     * flags requires_confirm instead of guessing.
     * @param {'L'|'R'} tank
     * @param {number} gallons
     * @returns {boolean} true if the debit was applied
     */
    static _debitTank(tank, gallons) {
        if (tank === 'L') {
            FuelTankState._state.left_gal = Math.max(0, FuelTankState._state.left_gal - gallons);
            return true;
        } else if (tank === 'R') {
            FuelTankState._state.right_gal = Math.max(0, FuelTankState._state.right_gal - gallons);
            return true;
        }
        FuelTankState._state.requires_confirm = true;
        FuelTankState._save();
        FuelTankState._fire();
        return false;
    }

    /**
     * Debit `gallons` from whichever tank is active. Shared by onSample() and
     * applyDroppedBurn() so the two burn-accounting paths can't drift apart.
     * @param {number} gallons
     * @returns {boolean} true if the debit was applied
     */
    static _debitActiveTank(gallons) {
        return FuelTankState._debitTank(FuelTankState._state.active_tank, gallons);
    }
```

Then update `switchTank()` to record the pre-switch tank and timestamp only on a real change:

```javascript
    /**
     * Switch the active fuel tank.
     * @param {'L'|'R'} tank - this airframe has no BOTH selector position
     */
    static switchTank(tank) {
        FuelTankState._load();
        if (!FuelTankState._state) return;
        if (tank !== 'L' && tank !== 'R') return;   // no BOTH on this aircraft
        const prevTank = FuelTankState._state.active_tank;
        if ((prevTank === 'L' || prevTank === 'R') && prevTank !== tank) {
            FuelTankState._state.pre_switch_tank = prevTank;
            FuelTankState._state.tank_switched_at = new Date().toISOString();
        }
        FuelTankState._state.active_tank = tank;
        FuelTankState._save();
        FuelTankState._fire();
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fuel-tank-state`
Expected: PASS — all three new tests, plus every pre-existing test in the file (the no-switch path is unchanged behavior).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions (nothing else calls `_debitActiveTank`'s old inline form directly — `applyDroppedBurn()` in the same file already calls `_debitActiveTank()` by name and is unaffected).

- [ ] **Step 6: Bump version and build**

Edit `web/app.js`: bump `FLYTAB_VERSION` (e.g. `v10.47` → `v10.48`).
Run: `bash build.sh`
Expected: clean build.

- [ ] **Step 7: Commit**

```bash
git add web/shared/fuel-tank-state.js tests/shared/fuel-tank-state.test.js web/app.js
git commit -m "fix: split burn across a mid-interval tank switch instead of misattributing it"
```

---

## Task 2: Report Pi-sync outcome for fuel-stop and tic-measurement syncs (audit #2b, Safety)

**Files:**
- Modify: `web/cockpit/fuel-overlay.js` (`_applyMeasurement()`, `_recordFuelStop()`, `_syncFuelSetToEngine()`, `_syncFuelAddToEngine()`)
- Test: `tests/cockpit/fuel-overlay-set-add-sync.test.js` (new)
- Docs: `docs/user-manual.md`, `web/user-manual.md`

**Interfaces:**
- Consumes: `this._engineBaseUrl()`, `this._setApplyStatus()`, `this._setAddStatus()` (all pre-existing).
- Produces: `_syncFuelSetToEngine(gallons, reason)` and `_syncFuelAddToEngine(gallons, airport, price)` now return `Promise<{ok: boolean, message: string}>` instead of `void` (breaking change to their return type — both are private, only called from within this file).

### Behavior change (user-visible — needs manual update)

Currently, `_applyMeasurement()` calls `this.hide()` immediately after firing the Pi sync, regardless of outcome — a failed Pi sync is silently swallowed (`.catch(() => {})`) and the pilot sees the overlay close as if everything succeeded. Same for `_recordFuelStop()`, which always shows a success message. After this fix: **the overlay stays open and shows an error status when the Pi sync fails**, exactly mirroring how `_applyDroppedBurnCorrection()` already behaves (fixed in PR #143). The local FlyTab-side write still always succeeds and is never rolled back — only the Pi notification step is now visible on failure.

- [ ] **Step 1: Write the failing tests**

Create `tests/cockpit/fuel-overlay-set-add-sync.test.js`:

```javascript
/**
 * FuelOverlay's Pi syncs for a preflight tic measurement (_syncFuelSetToEngine,
 * via _applyMeasurement) and a fuel stop (_syncFuelAddToEngine, via
 * _recordFuelStop) must not swallow a failed sync — same silent-divergence
 * risk the dropped-burn correction's Pi sync was fixed for in PR #143, applied
 * here to the two other Pi-sync call sites the same audit flagged as still
 * fire-and-forget.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const FuelOverlay = new Function(read('web/cockpit/fuel-overlay.js') + '\nreturn FuelOverlay;')();

function makeOverlay() {
    const overlay = Object.create(FuelOverlay.prototype);
    overlay._dom = {
        applyStatus: document.createElement('div'),
        addStatus: document.createElement('div'),
    };
    return overlay;
}

afterEach(() => {
    delete window.engineClient;
    vi.restoreAllMocks();
});

describe('FuelOverlay._syncFuelSetToEngine', () => {
    it('reports ok:true on a successful sync', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

        const result = await overlay._syncFuelSetToEngine(24.5, 'Preflight tic mark measurement');

        expect(result.ok).toBe(true);
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://192.168.1.50:8080/api/fuel/set');
        expect(JSON.parse(opts.body)).toEqual({ fuel_remaining: 24.5, reason: 'Preflight tic mark measurement' });
    });

    it('reports ok:false with a message when the Pi is unreachable', async () => {
        delete window.engineClient;
        const overlay = makeOverlay();
        const fetchSpy = vi.spyOn(global, 'fetch');

        const result = await overlay._syncFuelSetToEngine(24.5, 'reason');

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/Pi unreachable/);
    });

    it('reports ok:false with a message when the fetch rejects', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

        const result = await overlay._syncFuelSetToEngine(24.5, 'reason');

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/Pi sync failed/);
    });

    it('reports ok:false when the Pi returns a non-2xx status', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 });

        const result = await overlay._syncFuelSetToEngine(24.5, 'reason');

        expect(result.ok).toBe(false);
    });
});

describe('FuelOverlay._syncFuelAddToEngine', () => {
    it('reports ok:true and posts the fuel-stop fields', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

        const result = await overlay._syncFuelAddToEngine(10, 'KPAO', 5.99);

        expect(result.ok).toBe(true);
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://192.168.1.50:8080/api/fuel/add');
        expect(JSON.parse(opts.body)).toEqual({ gallons: 10, airport: 'KPAO', price_per_gallon: 5.99 });
    });

    it('reports ok:false with a message when the Pi is unreachable', async () => {
        delete window.engineClient;
        const overlay = makeOverlay();

        const result = await overlay._syncFuelAddToEngine(10, 'KPAO', null);

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/Pi unreachable/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fuel-overlay-set-add-sync`
Expected: FAIL — `_syncFuelSetToEngine`/`_syncFuelAddToEngine` currently return `undefined` (fire-and-forget), not a `{ok, message}` object.

- [ ] **Step 3: Implement the fix**

In `web/cockpit/fuel-overlay.js`, replace `_syncFuelSetToEngine()` and `_syncFuelAddToEngine()`:

```javascript
    /**
     * Push the pilot-confirmed tic measurement to the Pi as its new authoritative
     * fuel_remaining. Returns {ok, message} instead of swallowing the outcome — a
     * failed sync here leaves the Pi's own fuel total silently diverged from what
     * FlyTab now shows, the same risk fixed for the dropped-burn correction's Pi
     * sync in PR #143.
     * @returns {Promise<{ok: boolean, message: string}>}
     */
    async _syncFuelSetToEngine(gallons, reason = '') {
        const base = this._engineBaseUrl();
        if (!base) {
            return { ok: false, message: 'Measurement saved locally — Pi unreachable, engine-side total NOT updated. Retry when back in range.' };
        }
        try {
            const resp = await fetch(`${base}/api/fuel/set`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fuel_remaining: gallons, reason }),
                signal: AbortSignal.timeout(4000),
            });
            if (!resp.ok) throw new Error(`Pi returned ${resp.status}`);
            return { ok: true, message: '' };
        } catch (err) {
            return { ok: false, message: `Measurement saved locally — Pi sync failed (${err.message}). Retry when back in range.` };
        }
    }

    /**
     * Push a recorded fuel stop to the Pi's own fuel-addition log. Returns
     * {ok, message} — same rationale as _syncFuelSetToEngine().
     * @returns {Promise<{ok: boolean, message: string}>}
     */
    async _syncFuelAddToEngine(gallons, airport = '', price = null) {
        const base = this._engineBaseUrl();
        if (!base) {
            return { ok: false, message: 'Fuel stop saved locally — Pi unreachable, engine-side total NOT updated. Retry when back in range.' };
        }
        const body = { gallons };
        if (airport) body.airport = airport;
        if (price != null) body.price_per_gallon = price;
        try {
            const resp = await fetch(`${base}/api/fuel/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(4000),
            });
            if (!resp.ok) throw new Error(`Pi returned ${resp.status}`);
            return { ok: true, message: '' };
        } catch (err) {
            return { ok: false, message: `Fuel stop saved locally — Pi sync failed (${err.message}). Retry when back in range.` };
        }
    }
```

Then update `_applyMeasurement()`'s `.then()` body — replace the final four lines (`this._syncFuelSetToEngine(...)` through `this.hide();`) with:

```javascript
            // Sync authoritative tic measurement to Pi so both systems agree. Reported
            // to the pilot instead of swallowed — a failed sync here means the Pi's own
            // fuel total silently diverges from what FlyTab now shows (PR #143 audit).
            const synced = await this._syncFuelSetToEngine(m.total_gal, 'Preflight tic mark measurement');
            if (synced.ok) {
                this.hide();
            } else {
                this._setApplyStatus(synced.message, 'error');
            }
```

(This requires the enclosing arrow function passed to `.then()` to be `async` — change `this._resolveEdmFuel().then(edmFuel => {` to `this._resolveEdmFuel().then(async edmFuel => {`.)

Then update `_recordFuelStop()`: change `_recordFuelStop() {` to `async _recordFuelStop() {`, and replace the block from `// Sync fuel stop to Pi` through the `_setAddStatus` success call with:

```javascript
            // Sync fuel stop to Pi — reported instead of swallowed (see _syncFuelSetToEngine).
            const synced = await this._syncFuelAddToEngine(gallons, airport, price);

            // The reading has been consumed. A second RECORD tap must be backed by its own
            // fresh measurement, not this one — otherwise a double tap (or a second stop
            // on the same ramp) re-writes these gallons and re-stamps initialized_at.
            this._ticsTouchedSinceShow = false;

            // Clear inputs and show success
            this._dom.addGal.value = '';
            this._dom.addPrice.value = '';
            if (this._dom.addGalL) this._dom.addGalL.value = '';
            if (this._dom.addGalR) this._dom.addGalR.value = '';

            if (synced.ok) {
                this._setAddStatus(`Recorded: +${gallons.toFixed(1)} gal at ${airport || '—'} → ${newTotal.toFixed(1)} gal total`, 'ok');
            } else {
                this._setAddStatus(`Recorded locally: +${gallons.toFixed(1)} gal → ${newTotal.toFixed(1)} gal total. ${synced.message}`, 'error');
            }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fuel-overlay-set-add-sync`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. In particular check `tests/cockpit/fuel-overlay-apply-guard.test.js` and `tests/cockpit/fuel-overlay-fuelstop-guard.test.js` (the existing guard tests for these two functions) still pass — they test the early-refusal paths, which are unchanged; only the success tail changed.

- [ ] **Step 6: Update the user manual**

In both `docs/user-manual.md` and `web/user-manual.md`, find the section documenting the APPLY TIC MEASUREMENT / RECORD FUEL STOP buttons (near the dropped-burn paragraph edited by PR #143) and add, after the existing description of what each button does on success:

```markdown
If the Pi cannot be reached when you tap APPLY TIC MEASUREMENT or RECORD FUEL STOP, the reading is still saved on the tablet, but the overlay stays open and shows a message telling you the Pi's own fuel total was NOT updated — retry once you're back in range of the Pi's WiFi. This keeps the two displayed fuel totals from silently drifting apart the way a swallowed sync failure used to allow.
```

- [ ] **Step 7: Bump version and build**

Edit `web/app.js`: bump `FLYTAB_VERSION`.
Run: `bash build.sh`

- [ ] **Step 8: Commit**

```bash
git add web/cockpit/fuel-overlay.js tests/cockpit/fuel-overlay-set-add-sync.test.js docs/user-manual.md web/user-manual.md web/app.js
git commit -m "fix: report Pi-sync failures for tic measurements and fuel stops instead of swallowing them"
```

---

## Task 3: Refuse a physically implausible tic-mark reading before Apply/Record (audit #4, Accuracy)

**Files:**
- Modify: `web/shared/fuel-tank-state.js` (new shared `perSideCapGal()`), `web/cockpit/fuel-overlay.js` (`_updateDisplay()`, `_applyMeasurement()`, `_recordFuelStop()`, `_droppedBurnMaxGal()`), `web/style.css` (one new rule)
- Test: `tests/cockpit/fuel-overlay-implausible-tic.test.js` (new), `tests/shared/fuel-tank-state.test.js`
- Docs: `docs/user-manual.md`, `web/user-manual.md`

**Interfaces:**
- Consumes: `FuelEngine.ticToGallons()`, `CockpitConfig.aircraft()` (pre-existing).
- Produces: `FuelTankState.perSideCapGal(fallback)` (new static method — the single place that reads `performance.fuel_capacity_gal` and halves it; used by `init()`, `fuel-overlay.js`'s `_droppedBurnMaxGal()`, and this task's new validation, replacing three previously independent copies of the same lookup).

### Verified root cause

`FuelEngine.ticToGallons(17, FuelEngine.DEFAULT_COEFFICIENTS)` evaluates to **≈109.3 gal** (hand-computed and confirmed against the 5th-degree polynomial in `web/shared/fuel-engine.js:14-21`) — for an aircraft whose configured `performance.fuel_capacity_gal` is 36 (18/side). Nothing in `_updateDisplay()`, `_applyMeasurement()`, or `_recordFuelStop()` checks the computed gallons against tank capacity before displaying or writing them.

### Fix

1. Extract the duplicated "read `performance.fuel_capacity_gal`, halve it, fall back if unavailable" logic (currently inline in `FuelTankState.init()` and separately in `FuelOverlay._droppedBurnMaxGal()`) into one shared `FuelTankState.perSideCapGal(fallback)`.
2. Highlight an implausible per-tank reading live in `_updateDisplay()`.
3. Refuse to apply/record while either tank's computed gallons exceeds the cap, in both `_applyMeasurement()` and `_recordFuelStop()` — both write canonical `FuelTankState` from the same tic-to-gallons conversion, so both need the guard; leaving either unguarded lets an implausible number reach the tank state anyway.

- [ ] **Step 1: Write the failing tests**

Add to `tests/shared/fuel-tank-state.test.js`, inside a new top-level `describe('perSideCapGal')` block:

```javascript
describe('FuelTankState.perSideCapGal', () => {
    it('returns configured capacity / 2 when CockpitConfig is available', () => {
        const FuelTankState = freshFuelTankState();
        global.CockpitConfig = { aircraft: (k) => k === 'performance.fuel_capacity_gal' ? 36 : null };
        expect(FuelTankState.perSideCapGal(18)).toBe(18);
    });

    it('returns the caller-supplied fallback when CockpitConfig is unavailable', () => {
        const FuelTankState = freshFuelTankState();
        delete global.CockpitConfig;
        expect(FuelTankState.perSideCapGal(Infinity)).toBe(Infinity);
        expect(FuelTankState.perSideCapGal(18)).toBe(18);
    });
});
```

Create `tests/cockpit/fuel-overlay-implausible-tic.test.js`:

```javascript
/**
 * The tic-mark polynomial can evaluate to physically impossible gallons for a
 * reading near max tic (e.g. ~109 gal at tic=17 for a 36gal aircraft) — nothing
 * previously stopped that number from being displayed or applied.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const FuelOverlay = new Function(read('web/cockpit/fuel-overlay.js') + '\nreturn FuelOverlay;')();

function makeOverlay() {
    const overlay = Object.create(FuelOverlay.prototype);
    overlay._leftTic = 0;
    overlay._rightTic = 0;
    overlay._coefficients = FuelEngine.DEFAULT_COEFFICIENTS;
    overlay._ticsTouchedSinceShow = true;
    overlay._requireFreshTics = false;
    overlay._shownAt = 0;
    overlay._applying = false;
    overlay._dom = {
        applyStatus: document.createElement('div'),
        addStatus: document.createElement('div'),
        addGal: Object.assign(document.createElement('input'), { value: '10' }),
        addAirport: document.createElement('input'),
        addDate: document.createElement('input'),
        addTime: document.createElement('input'),
        addPrice: document.createElement('input'),
        addGalL: document.createElement('input'),
        addGalR: document.createElement('input'),
    };
    return overlay;
}

beforeEach(() => {
    localStorage.clear();
    global.CockpitConfig = { aircraft: (k) => k === 'performance.fuel_capacity_gal' ? 36 : null };
});

describe('FuelOverlay implausible tic-mark guard', () => {
    it('_applyMeasurement refuses a reading that implies more fuel than the tank holds', async () => {
        const overlay = makeOverlay();
        overlay._leftTic = 17; // ≈109 gal via the default polynomial, cap is 18/side
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._applyMeasurement();

        expect(overlay._dom.applyStatus.textContent).toMatch(/more than it can hold/i);
        expect(overlay._dom.applyStatus.className).toContain('fo-add-status-error');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('_recordFuelStop refuses the same implausible reading', async () => {
        const overlay = makeOverlay();
        overlay._rightTic = 17;

        await overlay._recordFuelStop();

        expect(overlay._dom.addStatus.textContent).toMatch(/more than it can hold/i);
        expect(overlay._dom.addStatus.className).toContain('fo-add-status-error');
    });

    it('a plausible reading is not refused by the new guard', async () => {
        const overlay = makeOverlay();
        overlay._leftTic = 8; // well within an 18gal/side cap
        overlay._rightTic = 8;
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('offline')); // resolveEdmFuel path, irrelevant here
        await overlay._applyMeasurement();
        expect(overlay._dom.applyStatus.textContent).not.toMatch(/more than it can hold/i);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fuel-tank-state fuel-overlay-implausible-tic`
Expected: FAIL — `FuelTankState.perSideCapGal` is not a function; the implausible-reading tests fail because nothing currently refuses tic=17.

- [ ] **Step 3: Implement the fix**

In `web/shared/fuel-tank-state.js`, add a new static method (place it right before `init()`):

```javascript
    /**
     * Configured per-tank capacity from aircraft-config.json (via CockpitConfig),
     * or `fallback` if unavailable/invalid. Single source for this lookup — shared
     * by init()'s clamp and any caller needing a fat-finger/plausibility ceiling —
     * so a future change to the capacity config path updates every caller at once.
     * @param {number} fallback - value to use when config is unavailable
     */
    static perSideCapGal(fallback) {
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) return cap / 2;
            }
        } catch (_) { /* fall through to caller's fallback */ }
        return fallback;
    }
```

Then in `init()`, replace the existing inline block:

```javascript
        let perSideCap = Infinity;
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) perSideCap = cap / 2;
            }
        } catch (_) { /* no config available — no clamp */ }
```

with:

```javascript
        const perSideCap = FuelTankState.perSideCapGal(Infinity);
```

In `web/cockpit/fuel-overlay.js`, replace `_droppedBurnMaxGal()`'s body:

```javascript
    _droppedBurnMaxGal() {
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) return cap / 2;
            }
        } catch (_) { /* fall through to default */ }
        return 18;
    }
```

with:

```javascript
    _droppedBurnMaxGal() {
        return (typeof FuelTankState !== 'undefined') ? FuelTankState.perSideCapGal(18) : 18;
    }
```

Then update `_updateDisplay()` to flag an implausible reading live:

```javascript
    _updateDisplay() {
        const leftGal = FuelEngine.ticToGallons(this._leftTic, this._coefficients);
        const rightGal = FuelEngine.ticToGallons(this._rightTic, this._coefficients);
        const total = leftGal + rightGal;
        const cap = (typeof FuelTankState !== 'undefined') ? FuelTankState.perSideCapGal(18) : 18;

        this._dom.leftGal.textContent = leftGal.toFixed(1) + ' gal';
        this._dom.leftGal.classList.toggle('fo-gal-implausible', leftGal > cap);
        this._dom.rightGal.textContent = rightGal.toFixed(1) + ' gal';
        this._dom.rightGal.classList.toggle('fo-gal-implausible', rightGal > cap);
        this._dom.totalGal.textContent = total.toFixed(1);

        // EDM comparison
        this._updateEdmComparison(total);
    }
```

Add to `web/style.css` (near the other `.fo-` rules):

```css
.fo-gal-implausible {
    color: var(--color-danger-on-light);
    font-weight: 900;
}
```

Add the refusal guard to `_applyMeasurement()`, immediately after the existing `_requireFreshTics` guard block (before `this._applying = true;`):

```javascript
        const leftGal = FuelEngine.ticToGallons(this._leftTic, this._coefficients);
        const rightGal = FuelEngine.ticToGallons(this._rightTic, this._coefficients);
        const cap = (typeof FuelTankState !== 'undefined') ? FuelTankState.perSideCapGal(18) : 18;
        if (leftGal > cap || rightGal > cap) {
            this._setApplyStatus(
                `Tic reading implies ${Math.max(leftGal, rightGal).toFixed(1)} gal in one tank, more than it can hold (${cap.toFixed(0)} gal) — check the tic reading before applying`,
                'error');
            return;
        }
```

Add the same guard to `_recordFuelStop()`, immediately after the existing `this._leftTic === 0 && this._rightTic === 0` guard block (before `const airport = ...`):

```javascript
        const leftGalCheck = FuelEngine.ticToGallons(this._leftTic, this._coefficients);
        const rightGalCheck = FuelEngine.ticToGallons(this._rightTic, this._coefficients);
        const capCheck = (typeof FuelTankState !== 'undefined') ? FuelTankState.perSideCapGal(18) : 18;
        if (leftGalCheck > capCheck || rightGalCheck > capCheck) {
            this._setAddStatus(
                `Tic reading implies ${Math.max(leftGalCheck, rightGalCheck).toFixed(1)} gal in one tank, more than it can hold (${capCheck.toFixed(0)} gal) — check the tic reading before recording`,
                'error');
            return;
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fuel-tank-state fuel-overlay-implausible-tic`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. Check `tests/shared/fuel-tank-state.test.js`'s existing `init() capacity clamp` tests still pass unchanged (the extracted `perSideCapGal(Infinity)` preserves the "no clamp when config unavailable" behavior exactly).

- [ ] **Step 6: Update the user manual**

In both `docs/user-manual.md` and `web/user-manual.md`, in the tic-mark entry section, add:

```markdown
If a tic-mark reading would imply more fuel than a tank actually holds, FlyTab highlights the affected tank's gallons figure and refuses APPLY TIC MEASUREMENT or RECORD FUEL STOP until the reading is corrected — this catches a mis-set slider or fat-fingered tic value before it overwrites tracked fuel with an impossible number.
```

- [ ] **Step 7: Bump version and build**

Edit `web/app.js`: bump `FLYTAB_VERSION`.
Run: `bash build.sh`

- [ ] **Step 8: Commit**

```bash
git add web/shared/fuel-tank-state.js web/cockpit/fuel-overlay.js web/style.css tests/shared/fuel-tank-state.test.js tests/cockpit/fuel-overlay-implausible-tic.test.js docs/user-manual.md web/user-manual.md web/app.js
git commit -m "fix: refuse a tic-mark reading that implies more fuel than a tank holds"
```

---

## Task 4: Surface the Pi's K-factor calibration in FlyTab (audit #5, Accuracy)

**Files:**
- Modify: `web/cockpit/fuel-overlay.js` (`_buildDOM()`, `show()`, new methods)
- Test: `tests/cockpit/fuel-overlay-pi-kfactor.test.js` (new)
- Docs: `docs/user-manual.md`, `web/user-manual.md`

**Interfaces:**
- Consumes: `GET {base}/api/fuel/calibration` → `{ready: false, message, current_k_factor, period_start, fuel_added, computed_used}` or `{ready: true, current_k_factor, period_start, fuel_added, computed_used, k_factor_ratio, variance_percent, suggested_k_factor, recommendation}` (both shapes confirmed verbatim against `engine-monitor/engine_monitor.py`'s `KFactorCalibration.get_calibration_status()`, lines 175-201). `POST {base}/api/fuel/calibration/applied` with body `{new_k_factor: <int>}` → `{success: true, message}` on success, `{error: <str>}` (HTTP 400) on `new_k_factor <= 0` or malformed JSON (confirmed against the handler at `engine_monitor.py:2541-2557`).
- Produces: `_fetchPiCalibration()`, `_renderPiKFactor(status)`, `_applyPiKFactor()` (all new, private).

### Verified state before this task

FlyTab's existing `_renderKFactor()` (unchanged by this task) computes its own ratio locally from `localStorage` fuel-stop and tic/EDM history — a legitimate independent cross-check, but it never reads the Pi's actual `current_k_factor` (the value presently programmed into the physical EI FT-60 Red Cube sensor) nor the Pi's own `suggested_k_factor`/`recommendation`, both already computed correctly by `KFactorCalibration.get_calibration_status()` and already exposed at `GET /api/fuel/calibration` — just never called from `web/`.

### Fix

Add a "PI K-FACTOR (LIVE)" panel below the existing K-FACTOR CALCULATOR section, reusing its existing CSS classes. On `show()`, best-effort fetch the Pi's calibration status (a passive read — matches the existing non-blocking `_resolveEdmFuel().then(...)` pattern already in `show()`; failure just leaves the panel hidden, no misleading data shown). When the Pi has enough data (`ready: true`), show an APPLY TO PI button that records the suggested K-factor as applied.

- [ ] **Step 1: Write the failing tests**

Create `tests/cockpit/fuel-overlay-pi-kfactor.test.js`:

```javascript
/**
 * The Pi already computes and exposes its own K-factor calibration status
 * (GET /api/fuel/calibration) and an endpoint to record an applied value
 * (POST /api/fuel/calibration/applied) — engine_monitor.py's KFactorCalibration
 * class. Nothing in web/ read either before this task; FlyTab's own K-FACTOR
 * CALCULATOR panel is a separate, locally-computed ratio and stays unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const FuelOverlay = new Function(read('web/cockpit/fuel-overlay.js') + '\nreturn FuelOverlay;')();

function makeOverlay() {
    const overlay = Object.create(FuelOverlay.prototype);
    overlay._dom = {
        kfPiSection: document.createElement('div'),
        kfPiCurrent: document.createElement('div'),
        kfPiSuggested: document.createElement('div'),
        kfPiRecommendation: document.createElement('div'),
        kfPiApply: document.createElement('button'),
        kfPiStatus: document.createElement('div'),
    };
    return overlay;
}

afterEach(() => {
    delete window.engineClient;
    vi.restoreAllMocks();
});

describe('FuelOverlay._fetchPiCalibration / _renderPiKFactor', () => {
    it('hides the PI K-FACTOR section when the Pi is unreachable', async () => {
        delete window.engineClient;
        const overlay = makeOverlay();
        await overlay._fetchPiCalibration();
        expect(overlay._dom.kfPiSection.style.display).toBe('none');
    });

    it('shows current-only, no APPLY button, when the Pi does not have enough data yet', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                ready: false, message: 'Need more data: 4.0 gal added, recommend 30+ gal',
                current_k_factor: 68000, period_start: '2026-09-01T00:00:00', fuel_added: 4.0, computed_used: 3.9,
            }),
        });

        await overlay._fetchPiCalibration();

        expect(overlay._dom.kfPiSection.style.display).toBe('');
        expect(overlay._dom.kfPiCurrent.textContent).toBe('68000');
        expect(overlay._dom.kfPiSuggested.textContent).toBe('--');
        expect(overlay._dom.kfPiRecommendation.textContent).toMatch(/Need more data/);
        expect(overlay._dom.kfPiApply.style.display).toBe('none');
    });

    it('shows the suggested value and APPLY button when the Pi has enough calibration data', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                ready: true, current_k_factor: 68000, suggested_k_factor: 68680,
                k_factor_ratio: 1.01, variance_percent: 1.0,
                recommendation: 'Sensor reads 1.0% HIGH. Increase K-factor.',
            }),
        });

        await overlay._fetchPiCalibration();

        expect(overlay._dom.kfPiCurrent.textContent).toBe('68000');
        expect(overlay._dom.kfPiSuggested.textContent).toBe('68680');
        expect(overlay._dom.kfPiRecommendation.textContent).toMatch(/1.0% HIGH/);
        expect(overlay._dom.kfPiApply.style.display).toBe('');
    });
});

describe('FuelOverlay._applyPiKFactor', () => {
    function readyOverlay() {
        const overlay = makeOverlay();
        overlay._piCalibration = { ready: true, current_k_factor: 68000, suggested_k_factor: 68680 };
        return overlay;
    }

    it('does nothing if the Pi calibration is not ready', async () => {
        const overlay = makeOverlay();
        overlay._piCalibration = { ready: false };
        const fetchSpy = vi.spyOn(global, 'fetch');
        await overlay._applyPiKFactor();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('POSTs the suggested K-factor and reports success', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = readyOverlay();
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            if (String(url).includes('/calibration/applied')) {
                return Promise.resolve({ ok: true, json: async () => ({ success: true, message: 'K-factor 68680 recorded as applied' }) });
            }
            return Promise.resolve({ ok: true, json: async () => ({ ready: false, current_k_factor: 68680, message: 'reset' }) });
        });

        await overlay._applyPiKFactor();

        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://192.168.1.50:8080/api/fuel/calibration/applied');
        expect(JSON.parse(opts.body)).toEqual({ new_k_factor: 68680 });
        expect(overlay._dom.kfPiStatus.textContent).toMatch(/recorded as applied/);
        expect(overlay._dom.kfPiStatus.className).toContain('fo-add-status-ok');
    });

    it('reports a Pi-side rejection', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = readyOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: false, status: 400, json: async () => ({ error: 'Invalid K-factor' }),
        });

        await overlay._applyPiKFactor();

        expect(overlay._dom.kfPiStatus.textContent).toBe('Invalid K-factor');
        expect(overlay._dom.kfPiStatus.className).toContain('fo-add-status-error');
    });

    it('reports a network failure', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = readyOverlay();
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

        await overlay._applyPiKFactor();

        expect(overlay._dom.kfPiStatus.textContent).toMatch(/Pi sync failed/);
        expect(overlay._dom.kfPiStatus.className).toContain('fo-add-status-error');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fuel-overlay-pi-kfactor`
Expected: FAIL — `_fetchPiCalibration`/`_renderPiKFactor`/`_applyPiKFactor` don't exist yet.

- [ ] **Step 3: Implement the fix**

In `web/cockpit/fuel-overlay.js`'s `_buildDOM()`, add a new panel immediately after the closing `</div>` of the existing `<!-- G) K-FACTOR CALCULATOR -->` section's `fo-kfactor-panel` div (i.e. right before the final `</div>` that closes `.fo-container`):

```html
            <!-- H) PI K-FACTOR (LIVE) -->
            <div class="fo-kfactor-panel" id="fo-kfactor-pi" style="display:none;">
                <div class="fo-section-title">PI K-FACTOR (LIVE)</div>
                <div class="fo-kfactor-row">
                    <div class="fo-kfactor-item">
                        <div class="fo-kfactor-label">CURRENT (PI)</div>
                        <div class="fo-kfactor-val" id="fo-kf-pi-current">--</div>
                    </div>
                    <div class="fo-kfactor-item">
                        <div class="fo-kfactor-label">SUGGESTED (PI)</div>
                        <div class="fo-kfactor-val" id="fo-kf-pi-suggested">--</div>
                    </div>
                </div>
                <div class="fo-kfactor-guidance" id="fo-kf-pi-recommendation"></div>
                <button class="fo-manual-btn fo-set-btn" id="fo-kf-pi-apply" style="display:none;">APPLY TO PI</button>
                <div class="fo-add-status" id="fo-kf-pi-status"></div>
            </div>
```

Add to the `_dom` cache object in `_buildDOM()` (near the other `kf*` entries):

```javascript
            kfPiSection: this._el.querySelector('#fo-kfactor-pi'),
            kfPiCurrent: this._el.querySelector('#fo-kf-pi-current'),
            kfPiSuggested: this._el.querySelector('#fo-kf-pi-suggested'),
            kfPiRecommendation: this._el.querySelector('#fo-kf-pi-recommendation'),
            kfPiApply: this._el.querySelector('#fo-kf-pi-apply'),
            kfPiStatus: this._el.querySelector('#fo-kf-pi-status'),
```

Wire the button, near the other `wireTap` calls in `_buildDOM()`:

```javascript
        wireTap(this._el.querySelector('#fo-kf-pi-apply'), () => {
            this._applyPiKFactor();
        });
```

In `show()`, add a call alongside the existing `this._renderKFactor();` line:

```javascript
        this._renderKFactor();
        this._fetchPiCalibration();
```

Add three new methods (place after `_renderKFactor()`):

```javascript
    /** Best-effort read of the Pi's own K-factor calibration status. Passive
     *  display refresh, same non-blocking pattern as _resolveEdmFuel() in
     *  show() — on failure, leaves the panel hidden rather than showing stale
     *  or fabricated numbers. */
    async _fetchPiCalibration() {
        const base = this._engineBaseUrl();
        if (!base || !this._dom.kfPiSection) { if (this._dom.kfPiSection) this._dom.kfPiSection.style.display = 'none'; return; }
        try {
            const resp = await fetch(`${base}/api/fuel/calibration`, { signal: AbortSignal.timeout(4000) });
            if (!resp.ok) throw new Error(`Pi returned ${resp.status}`);
            const status = await resp.json();
            this._renderPiKFactor(status);
        } catch (_) {
            this._dom.kfPiSection.style.display = 'none';
        }
    }

    _renderPiKFactor(status) {
        this._piCalibration = status;
        this._dom.kfPiSection.style.display = '';
        this._dom.kfPiCurrent.textContent = status.current_k_factor != null ? String(status.current_k_factor) : '--';
        if (status.ready) {
            this._dom.kfPiSuggested.textContent = String(status.suggested_k_factor);
            this._dom.kfPiRecommendation.textContent = status.recommendation || '';
            this._dom.kfPiApply.style.display = '';
        } else {
            this._dom.kfPiSuggested.textContent = '--';
            this._dom.kfPiRecommendation.textContent = status.message || '';
            this._dom.kfPiApply.style.display = 'none';
        }
    }

    /** Record the Pi's own suggested K-factor as applied (POST — the Pi does
     *  not re-program the physical sensor; this is a log entry the pilot
     *  confirms after manually setting the new K-factor on the Dynon EMS). */
    async _applyPiKFactor() {
        if (!this._piCalibration?.ready) return;
        const newK = this._piCalibration.suggested_k_factor;
        const base = this._engineBaseUrl();
        if (!base) {
            this._setStatus(this._dom.kfPiStatus, 'Pi unreachable — cannot record applied K-factor', 'error');
            return;
        }
        this._dom.kfPiApply.disabled = true;
        try {
            const resp = await fetch(`${base}/api/fuel/calibration/applied`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ new_k_factor: newK }),
                signal: AbortSignal.timeout(4000),
            });
            const result = await resp.json().catch(() => ({}));
            if (resp.ok && result.success) {
                this._setStatus(this._dom.kfPiStatus, result.message || `K-factor ${newK} recorded as applied`, 'ok');
                await this._fetchPiCalibration();
            } else {
                this._setStatus(this._dom.kfPiStatus, result.error || `Pi returned ${resp.status}`, 'error');
            }
        } catch (err) {
            this._setStatus(this._dom.kfPiStatus, `Pi sync failed (${err.message})`, 'error');
        } finally {
            this._dom.kfPiApply.disabled = false;
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fuel-overlay-pi-kfactor`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Update the user manual**

In both `docs/user-manual.md` and `web/user-manual.md`, in the K-FACTOR CALCULATOR section, add:

```markdown
Below the calculator, a PI K-FACTOR (LIVE) panel shows the K-factor currently programmed into the Pi's own tracker, and — once the Pi has logged at least 30 gal of fuel additions — a suggested new value with a recommendation. Tapping APPLY TO PI only records that you applied the suggested value to the physical Dynon EMS; it does not reprogram the sensor itself, which must still be set manually on the EMS per its own calibration procedure.
```

- [ ] **Step 7: Bump version and build**

Edit `web/app.js`: bump `FLYTAB_VERSION`.
Run: `bash build.sh`

- [ ] **Step 8: Commit**

```bash
git add web/cockpit/fuel-overlay.js tests/cockpit/fuel-overlay-pi-kfactor.test.js docs/user-manual.md web/user-manual.md web/app.js
git commit -m "feat: surface the Pi's live K-factor calibration status in the fuel overlay"
```

---

## Task 5: Fix `||` vs `??` for fuel_remaining in the flight recorder (audit —, Accuracy minor)

**Files:**
- Modify: `web/cockpit/flight-recorder.js:289`
- Test: `tests/cockpit/flight-recorder-fuel-remaining.test.js` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — pure bugfix, no signature change.

### Verified root cause

`web/cockpit/flight-recorder.js:289`: `(eng?.fuel?.fuel_remaining || d.Fuel_Remaining || 0)`. When `eng.fuel.fuel_remaining` is exactly `0` — a legitimate, safety-relevant reading (tank empty) — `||` treats it as falsy and silently substitutes `d.Fuel_Remaining` instead, mislogging the CSV row.

- [ ] **Step 1: Write the failing test**

Create `tests/cockpit/flight-recorder-fuel-remaining.test.js`:

```javascript
/**
 * flight-recorder.js's per-row fuel_remaining field used `||` instead of `??`,
 * so an exact-zero reading (tank empty — a real, safety-relevant value) was
 * silently discarded in favor of a fallback field instead of being logged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();

function makeRecorder(fuelRemaining) {
    const rec = Object.create(FlightRecorder.prototype);
    rec._csvBuffer = [];
    rec._rowCount = 0;
    rec._gapTimer = null;
    rec._firstGps = null;
    rec._lastGps = null;
    rec._engine = {
        dataAge: 0,
        lastData: {
            data: { RPM: 2400, Fuel_Flow: 9.5, Fuel_Remaining: 99 }, // decoy fallback value
            fuel: { fuel_remaining: fuelRemaining },
        },
    };
    rec._stratux = { situation: null };
    return rec;
}

describe('FlightRecorder._recordRow fuel_remaining', () => {
    it('logs an exact-zero fuel_remaining instead of falling back', () => {
        const rec = makeRecorder(0);
        rec._recordRow();
        const cols = rec._csvBuffer[0].split(',');
        expect(cols[9]).toBe('0'); // column index 9 = Gallons Remaining, per CSV_HEADER
    });

    it('still falls back to Fuel_Remaining when fuel_remaining is genuinely absent', () => {
        const rec = makeRecorder(undefined);
        rec._recordRow();
        const cols = rec._csvBuffer[0].split(',');
        expect(cols[9]).toBe('99');
    });

    it('uses a real positive fuel_remaining over the fallback', () => {
        const rec = makeRecorder(12.5);
        rec._recordRow();
        const cols = rec._csvBuffer[0].split(',');
        expect(cols[9]).toBe('12.5');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- flight-recorder-fuel-remaining`
Expected: FAIL on the first test — `cols[9]` is `'99'` (the decoy), not `'0'`.

- [ ] **Step 3: Implement the fix**

In `web/cockpit/flight-recorder.js:289`, change:

```javascript
            rpm, d.Fuel_Flow||0, (eng?.fuel?.fuel_remaining || d.Fuel_Remaining || 0),
```

to:

```javascript
            rpm, d.Fuel_Flow||0, (eng?.fuel?.fuel_remaining ?? d.Fuel_Remaining ?? 0),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- flight-recorder-fuel-remaining`
Expected: PASS, all three cases.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Bump version and build**

Edit `web/app.js`: bump `FLYTAB_VERSION`.
Run: `bash build.sh`

- [ ] **Step 7: Commit**

```bash
git add web/cockpit/flight-recorder.js tests/cockpit/flight-recorder-fuel-remaining.test.js web/app.js
git commit -m "fix: log an exact-zero fuel_remaining instead of silently falling back"
```

---

## Task 6: Remove dead `FuelTankState.topOff()` (audit —, Cleanup)

**Files:**
- Modify: `web/shared/fuel-tank-state.js` (delete `topOff()`)
- Modify: `tests/cockpit/instrument-strip-fuel.test.js:152` (swap its trigger call)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — removes a public static method with no production caller.

### Verified: confirmed dead, and how the one test caller is used

`grep -rn "topOff"` across `web/` and `tests/` finds exactly two hits: the definition (`web/shared/fuel-tank-state.js:214`) and one test call (`tests/cockpit/instrument-strip-fuel.test.js:152`), which uses it only as a convenient way to change tank gallons and fire `fueltankstate:changed` — it is not testing `topOff()` itself. `topOff()` also does not reset `dropped_burn_estimate_gal` the way `init()`/`applyDroppedBurn()` do (verified: PR #143 added that reset to `init()` only), so if it were ever wired into a real per-tank fuel-stop flow it would double-subtract a correction the pilot already accounted for via a top-off. Since it has no production caller, delete it rather than fix it (YAGNI) — a real per-tank top-off flow can be built with the correct invariants when it's actually needed.

- [ ] **Step 1: Update the one test caller (no new test needed — this is a removal, not new behavior)**

In `tests/cockpit/instrument-strip-fuel.test.js`, in the test `'updates on fueltankstate:changed without an engine poll'`, replace:

```javascript
        FuelTankState.topOff('L', 4);       // fires fueltankstate:changed
        expect(value()).toBe('22.0');
```

with:

```javascript
        FuelTankState.init(13, 9, 'L');     // fires fueltankstate:changed
        expect(value()).toBe('22.0');
```

- [ ] **Step 2: Run the test to verify it still passes with the new trigger**

Run: `npm test -- instrument-strip-fuel`
Expected: PASS (13 + 9 = 22.0, same assertion as before).

- [ ] **Step 3: Delete `topOff()`**

In `web/shared/fuel-tank-state.js`, delete the entire method (including its docstring):

```javascript
    /**
     * Add fuel to a specific tank (fuel stop).
     * @param {'L'|'R'} tank
     * @param {number} gallons
     */
    static topOff(tank, gallons) {
        FuelTankState._load();
        if (!FuelTankState._state || gallons <= 0) return;
        if (tank === 'L') {
            FuelTankState._state.left_gal = Math.max(0, FuelTankState._state.left_gal + gallons);
        } else if (tank === 'R') {
            FuelTankState._state.right_gal = Math.max(0, FuelTankState._state.right_gal + gallons);
        }
        FuelTankState._save();
        FuelTankState._fire();
    }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — no remaining references to `topOff`.

Run: `grep -rn "topOff" web/ tests/ android/app/src/main/assets/public/ 2>/dev/null`
Expected: no output.

- [ ] **Step 5: Bump version and build**

Edit `web/app.js`: bump `FLYTAB_VERSION`.
Run: `bash build.sh`

- [ ] **Step 6: Commit**

```bash
git add web/shared/fuel-tank-state.js tests/cockpit/instrument-strip-fuel.test.js web/app.js
git commit -m "chore: remove dead FuelTankState.topOff()"
```

---

## Self-Review

**1. Spec coverage:** All six audit items (1–6 / audit #3, #2b, #4, #5, and the two unnumbered ones) each map to exactly one task. No gaps.

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" patterns — every step has real, verified code or an exact grep/test command.

**3. Type consistency:** `FuelTankState.perSideCapGal(fallback)` (Task 3) is used identically in `init()`, `_droppedBurnMaxGal()`, and the new `_updateDisplay()`/`_applyMeasurement()`/`_recordFuelStop()` guards. `_debitTank(tank, gallons)` / `_debitActiveTank(gallons)` (Task 1) names and signatures match between definition and call sites. `_syncFuelSetToEngine()`/`_syncFuelAddToEngine()` (Task 2) consistently return `Promise<{ok, message}>` at every call site. `_fetchPiCalibration()`/`_renderPiKFactor(status)`/`_applyPiKFactor()` (Task 4) field names (`current_k_factor`, `suggested_k_factor`, `recommendation`, `ready`) match `KFactorCalibration.get_calibration_status()`'s actual Python dict keys, verified by reading the source, not inferred.
