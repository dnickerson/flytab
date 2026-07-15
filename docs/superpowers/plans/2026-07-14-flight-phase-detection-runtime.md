# Flight Phase Detection — Runtime (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tablet's 8-phase, 3-signal (RPM/altitude/ground-speed) `PhaseDetector.java` with a causal, six-signal (RPM, MP, Fuel Flow, GPS lat/lon, altitude, velocity) 12-phase JS finite-state machine shared with the offline detector via a single `phase_spec.json`, close the "cosmetic phase override doesn't actually gate the anomaly threshold" bug, and add a phase-gated sticky-valve advisory.

**Architecture:** A new plain-global-script module, `web/shared/phase-detector.js`, implements the causal FSM — a direct port of the just-merged `~/engine_analysis/train_anomaly_model.py`'s `_classify_row_batch` + transition enforcement + `has_taken_off`/`has_left_ramp` latches, with its two look-ahead constructs (centered altitude-rate window, whole-array dwell smoothing) translated to trailing-window and forward-only dwell-commit equivalents. It is loaded via a classic `<script>` tag (not `type="module"`) because `engine-ml.js` and `app.js` are also classic scripts, loaded synchronously in document order — converting only `engine-ml.js` to an ES module would defer its execution until after `app.js` runs, breaking `app.js`'s `typeof EngineMLBridge !== 'undefined'` instantiation check (verified: `app.js` is a plain script at `index.html:151`, after `engine-ml.js` at `index.html:141`, with no `defer`/`async`/`module` on either). The module also exports via `module.exports` for Node so vitest can import it for unit tests and a golden-parity test. `engine-ml.js` calls the new module once per 1 Hz sample and sends the resulting `phase` string as a new field on the Capacitor `processSample` payload. `EngineMLPlugin.java` reads `phase` off that payload (defaulting to `"cruise"` if missing) instead of calling `PhaseDetector.java`, which is deleted.

**Tech Stack:** Vanilla JS (ES2020, classic scripts + dual CommonJS export), Java 11 (Capacitor Android plugin), vitest (jsdom environment, already configured), Python 3 (one-off, to freeze the golden-parity fixture — no new runtime Python dependency).

## Global Constraints

- `phase_spec.json` is the single numeric source of truth. No threshold, transition, or dwell value may be hardcoded as a JS literal outside the loaded spec object.
- `PhaseDetector.java` is deleted, not deprecated in place, in the same task that lands the JS module and the bridge change — no dead-code interim (design spec §5.2).
- The `engine-ml.js:295` cosmetic phase override and its supporting `_computeGPSPhase`/`_derivePhase` functions are deleted in the same task — nothing is left to override once `result.phase` just echoes what was computed and sent.
- `phase` becomes an INPUT field on the JS→native `processSample` payload. `EngineMLPlugin.java` no longer computes phase itself.
- A missing/unparseable `phase` on the Java side defaults to `"cruise"` (least alarm-prone bucket) — a malformed sample must degrade gracefully, never silently drop anomaly coverage (design spec §5.2).
- `InferenceEngine.java`'s dtype-detection logic (`interpreter.getInputTensor(0).dataType()`, lines 139-151) is not touched by any task in this plan.
- The golden-parity test (Task 5) is not optional — it is part of this plan's Definition of Done, not a stretch goal (design spec §5, §7).
- Run `bash build.sh` after the runtime code is complete (Task 7 onward); increment `FLYTAB_VERSION` in `web/app.js` before building (project CLAUDE.md rule).
- Run `npm test` (vitest) before building — this plan adds new files under `web/shared/`, and CLAUDE.md's existing rule ("If the change touches any file under `web/shared/planning/`, run `npm test` first") is extended here to the new `web/shared/phase-detector*.js` files by the same logic (shared, tested library code).
- After deploying, the on-device CDP test (existing procedure — `~/flytab/CLAUDE.md → EngineML Plugin → Deploying a New Model`) must be run before flying. This plan cannot automate that step; Task 7 calls it out explicitly as a manual follow-up, not part of this plan's automated Definition of Done.
- There is no existing JUnit/Robolectric test harness for the `engineml` Java package (verified: no `*Test.java` files anywhere under `android/`). Java tasks in this plan are verified by `bash build.sh` compiling cleanly plus the existing manual on-device CDP procedure — this plan does not introduce a new Java test framework (out of scope; YAGNI for a phase-detection change).

## Out of scope for this plan

- The standalone `engine-ml-test/` harness (separate Capacitor-less test app, package `app.flywhere.engineml`, its own copy of `PhaseDetector.java`) is untouched. It is not wired into the real plugin and updating it is a separate follow-up decision, not part of this rollout.
- Expanding `EngineAdvisor.java`'s `getNormalMessage()` switch (lines 504-514) to add tailored messages for the 4 newly-reachable phase strings (`taxi_out`, `taxi_in`, `approach`, `shutdown` as a live runtime phase rather than an end state). Verified: the switch already has a `default` case, so new phase strings fall through safely — no crash, just a generic message. Tailoring those messages is a UX follow-up, not required for correctness.
- The `worktree-feat+flight-plan-save-retrieve` git worktree, which touches `EngineMLPlugin.java`/`EngineAdvisor.java`/`InferenceEngine.java` but is confirmed 0 commits ahead / 331 behind `main` (verified via `git rev-list --left-right --count`) — it carries no unique work and poses no merge-conflict risk to this plan. Worth pruning at some point, but that's routine housekeeping, not part of this plan.
- The exact numeric sticky-valve EGT-lag threshold (Task 9) — see that task for why this is deliberately left as a flagged, conservative placeholder rather than an invented number.
- `engine_anomaly_detector_v2.py` — confirmed rule-based and independent of `detect_phases()` (design spec §9 step 6). Not touched by this plan.

---

### Task 1: Copy `phase_spec.json` into flytab and add a validating loader

**Files:**
- Create: `web/phase_spec.json` (byte-for-byte copy of `~/engine_analysis/phase_spec.json`)
- Create: `web/shared/phase-spec-loader.js`
- Test: `tests/phase-detection/phase-spec-loader.test.js`

**Interfaces:**
- Produces: `validatePhaseSpec(spec)` — throws `Error` on structural problems, returns `spec` unchanged otherwise. `loadPhaseSpec(fetchImpl)` — async, fetches `phase_spec.json` (relative path, matching the existing `fetch('cockpit-config.json', ...)` pattern in `web/cockpit/config-editor.js:44`), parses, validates, returns the spec object. Both are consumed by Task 3's `PhaseDetector` constructor.

- [ ] **Step 1: Copy the spec file**

```bash
cp ~/engine_analysis/phase_spec.json ~/flytab/web/phase_spec.json
```

- [ ] **Step 2: Write the failing test**

Create `tests/phase-detection/phase-spec-loader.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import phaseSpecLoaderModule from '../../web/shared/phase-spec-loader.js';

const { validatePhaseSpec, loadPhaseSpec } = phaseSpecLoaderModule;

describe('validatePhaseSpec', () => {
    it('accepts the real checked-in phase_spec.json', () => {
        const spec = JSON.parse(readFileSync(join(__dirname, '../../web/phase_spec.json'), 'utf8'));
        expect(() => validatePhaseSpec(spec)).not.toThrow();
        expect(spec.phases).toHaveLength(12);
        expect(spec.phases).toContain('startup');
        expect(spec.transitions.shutdown).toEqual([]);
    });

    it('rejects a spec missing a required top-level key', () => {
        const spec = { version: 1, phases: ['a'], transitions: {}, thresholds: {}, dwell_seconds: {} };
        expect(() => validatePhaseSpec(spec)).toThrow(/missing key: descriptions/);
    });

    it('rejects a transition pointing to an unknown phase', () => {
        const spec = {
            version: 1, phases: ['a', 'b'],
            transitions: { a: ['c'], b: [] },
            thresholds: {}, dwell_seconds: { a: 1, b: 1 }, descriptions: { a: 'x', b: 'y' },
        };
        expect(() => validatePhaseSpec(spec)).toThrow(/unknown phase: c/);
    });

    it('rejects a phase missing a dwell_seconds entry', () => {
        const spec = {
            version: 1, phases: ['a', 'b'],
            transitions: { a: [], b: [] },
            thresholds: {}, dwell_seconds: { a: 1 }, descriptions: { a: 'x', b: 'y' },
        };
        expect(() => validatePhaseSpec(spec)).toThrow(/missing a dwell_seconds entry: b/);
    });
});

describe('loadPhaseSpec', () => {
    it('fetches, parses, and validates via an injected fetch', async () => {
        const spec = JSON.parse(readFileSync(join(__dirname, '../../web/phase_spec.json'), 'utf8'));
        const fakeFetch = async (url) => {
            expect(url).toBe('phase_spec.json');
            return { ok: true, json: async () => spec };
        };
        const result = await loadPhaseSpec(fakeFetch);
        expect(result.phases).toHaveLength(12);
    });

    it('throws with a clear message on a non-ok response', async () => {
        const fakeFetch = async () => ({ ok: false, status: 404 });
        await expect(loadPhaseSpec(fakeFetch)).rejects.toThrow(/404/);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/phase-detection/phase-spec-loader.test.js`
Expected: FAIL — `Cannot find module '../../web/shared/phase-spec-loader.js'`

- [ ] **Step 4: Write the implementation**

Create `web/shared/phase-spec-loader.js`:

```js
'use strict';

const REQUIRED_KEYS = ['version', 'phases', 'transitions', 'thresholds', 'dwell_seconds', 'descriptions'];

function validatePhaseSpec(spec) {
    for (const key of REQUIRED_KEYS) {
        if (!(key in spec)) {
            throw new Error(`phase_spec.json missing key: ${key}`);
        }
    }
    const phases = new Set(spec.phases);
    for (const phase of phases) {
        if (!(phase in spec.transitions)) {
            throw new Error(`phases missing a transitions entry: ${phase}`);
        }
        if (!(phase in spec.dwell_seconds)) {
            throw new Error(`phases missing a dwell_seconds entry: ${phase}`);
        }
        if (!(phase in spec.descriptions)) {
            throw new Error(`phases missing a descriptions entry: ${phase}`);
        }
        for (const target of spec.transitions[phase]) {
            if (!phases.has(target)) {
                throw new Error(`transitions['${phase}'] references unknown phase: ${target}`);
            }
        }
    }
    return spec;
}

async function loadPhaseSpec(fetchImpl) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) {
        throw new Error('loadPhaseSpec requires a fetch implementation (none injected and no global fetch)');
    }
    const res = await doFetch('phase_spec.json');
    if (!res.ok) {
        throw new Error(`Failed to load phase_spec.json: HTTP ${res.status}`);
    }
    const spec = await res.json();
    return validatePhaseSpec(spec);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { validatePhaseSpec, loadPhaseSpec };
}
if (typeof window !== 'undefined') {
    window.validatePhaseSpec = validatePhaseSpec;
    window.loadPhaseSpec = loadPhaseSpec;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/phase-detection/phase-spec-loader.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add web/phase_spec.json web/shared/phase-spec-loader.js tests/phase-detection/phase-spec-loader.test.js
git commit -m "feat: copy phase_spec.json from engine_analysis, add validating loader"
```

---

### Task 2: Causal helper functions (GPS-delta window, RPM-slope window, trailing altitude-rate, field-elevation estimate)

**Files:**
- Create: `web/shared/phase-detector-helpers.js`
- Test: `tests/phase-detection/phase-detector-helpers.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `haversineMeters(lat1, lon1, lat2, lon2)`, `class GpsDeltaWindow { constructor(windowSamples); push(lat, lon) -> deltaMeters }`, `class RpmSlopeWindow { constructor(windowSamples); push(rpm) -> slopeOrInfinity }`, `class TrailingAltRate { constructor(windowSamples); push(altitudeFt) -> fpmOrNull }`, `class FieldElevationEstimate { constructor(lockSamples, stationarySpeedKts, maxIdleRpm); push(altitudeFt, speedKts, rpm, stationary) -> currentEstimateFt }`. All four threshold arguments are required (no defaults) — every numeric constant this module needs comes from the caller's loaded `phase_spec.json`, per the plan's "single numeric source of truth" constraint; `phase_spec.json` gained two new `thresholds` keys for this — `field_elev_lock_samples: 200` and `field_elev_max_idle_rpm: 2000` (already landed in both repos: `~/engine_analysis` commit `e179db1`, copied into this repo's `web/phase_spec.json`); `stationarySpeedKts` reuses the existing `speed_taxi_max_kts: 20` key rather than adding a duplicate. All consumed by Task 3's `classifyRow` and Task 4's `PhaseDetector`.

These mirror `_gps_delta_series`, `_rpm_slope_batch` (both already causal in Python — ported near-verbatim), and translate `_rate_of_climb_batch` (centered ±30-row window) and the `detect_phases()` field-elevation baseline (median of first 300 rows) to trailing/running equivalents, per the design spec's §5 causal-translation table.

- [ ] **Step 1: Write the failing test**

Create `tests/phase-detection/phase-detector-helpers.test.js`:

```js
import { describe, it, expect } from 'vitest';
import helpersModule from '../../web/shared/phase-detector-helpers.js';

const { haversineMeters, GpsDeltaWindow, RpmSlopeWindow, TrailingAltRate, FieldElevationEstimate } = helpersModule;

describe('haversineMeters', () => {
    it('computes ~111,195m for 1 degree of latitude', () => {
        const d = haversineMeters(0, 0, 1, 0);
        expect(d).toBeCloseTo(111195, -2); // within ~100m (matches Python's 1% tolerance)
    });

    it('returns 0 for the same point', () => {
        expect(haversineMeters(33.5, -85.2, 33.5, -85.2)).toBe(0);
    });
});

describe('GpsDeltaWindow', () => {
    it('reports near-zero delta for a stationary aircraft', () => {
        const win = new GpsDeltaWindow(7);
        let last = 0;
        for (let i = 0; i < 20; i++) {
            last = win.push(33.5, -85.2);
        }
        expect(last).toBeLessThan(1.0);
    });

    it('reports a growing delta once the aircraft starts moving', () => {
        const win = new GpsDeltaWindow(7);
        let lat = 33.5;
        let last = 0;
        for (let i = 0; i < 16; i++) {
            last = win.push(lat, -85.2);
            lat += 0.00008; // ~9m/sample drift, matching the Python fixture's synthetic case
        }
        expect(last).toBeGreaterThan(15.0);
    });
});

describe('RpmSlopeWindow', () => {
    it('returns Infinity until the trailing window is full', () => {
        const win = new RpmSlopeWindow(15);
        let last;
        for (let i = 0; i < 14; i++) last = win.push(800);
        expect(last).toBe(Infinity);
    });

    it('returns rpm[i] - rpm[i-window] once full, matching flattened RPM', () => {
        const win = new RpmSlopeWindow(3);
        win.push(800); win.push(900); win.push(1000);
        const slope = win.push(1000); // window now full: 1000 - 800 = 200
        expect(slope).toBe(200);
    });

    it('reports near-zero slope once RPM has flattened', () => {
        const win = new RpmSlopeWindow(3);
        for (const v of [800, 900, 1000, 1000, 1000, 1000]) win.push(v);
        const slope = win.push(1000);
        expect(slope).toBe(0);
    });
});

describe('TrailingAltRate', () => {
    it('returns null until enough history exists', () => {
        const rate = new TrailingAltRate(30);
        let last;
        for (let i = 0; i < 29; i++) last = rate.push(1000);
        expect(last).toBeNull();
    });

    it('reports ~0 fpm for constant altitude', () => {
        const rate = new TrailingAltRate(10);
        let last;
        for (let i = 0; i < 15; i++) last = rate.push(1000);
        expect(Math.abs(last)).toBeLessThan(5);
    });

    it('reports a positive climb rate for steadily increasing altitude', () => {
        const rate = new TrailingAltRate(10);
        let last;
        for (let i = 0; i < 15; i++) last = rate.push(1000 + i * 10); // 10 ft/s = 600 fpm
        expect(last).toBeGreaterThan(400);
    });
});

describe('FieldElevationEstimate', () => {
    it('locks onto the median ground altitude once lockSamples pre-flight samples accumulate', () => {
        const est = new FieldElevationEstimate(200, 20, 2000);
        let last;
        for (let i = 0; i < 250; i++) {
            last = est.push(620 + (i % 3), 2, 800, true); // stationary (true = not moving), low RPM, altitude ~620ft
        }
        expect(last).toBeCloseTo(621, 0);
    });

    it('locks early on first movement if fewer than lockSamples ground samples were seen (does not drift into a later stop at a different field)', () => {
        const est = new FieldElevationEstimate(200, 20, 2000);
        for (let i = 0; i < 30; i++) est.push(620, 2, 800, true); // only 30 pre-flight ground samples
        const lockedOnMove = est.push(620, 25, 1200, false); // stationary=false: movement detected — must lock now, not wait for 200
        expect(lockedOnMove).toBeCloseTo(620, 0);
        for (let i = 0; i < 50; i++) est.push(450, 2, 800, false); // later ground stop at a DIFFERENT field
        expect(est.push(450, 2, 800, false)).toBeCloseTo(lockedOnMove, 0);
    });

    it('stops updating once locked, even with more pre-flight-looking ground samples fed in', () => {
        const est = new FieldElevationEstimate(200, 20, 2000);
        for (let i = 0; i < 250; i++) est.push(620, 2, 800, true);
        const locked = est.push(620, 2, 800, true);
        for (let i = 0; i < 50; i++) est.push(450, 2, 800, true);
        expect(est.push(450, 2, 800, true)).toBeCloseTo(locked, 0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/phase-detection/phase-detector-helpers.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `web/shared/phase-detector-helpers.js`:

```js
'use strict';

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000.0;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const dphi = toRad(lat2 - lat1);
    const dlmb = toRad(lon2 - lon1);
    const a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Mirrors _gps_delta_series: distance between the current sample and the
// sample `windowSamples` pushes ago (clamped at the buffer start). Already
// causal in the Python original — direct port.
class GpsDeltaWindow {
    constructor(windowSamples) {
        this._windowSamples = windowSamples;
        this._buf = []; // [{lat, lon}, ...], oldest first
    }
    push(lat, lon) {
        this._buf.push({ lat, lon });
        if (this._buf.length > this._windowSamples + 1) this._buf.shift();
        const oldest = this._buf[0];
        return haversineMeters(oldest.lat, oldest.lon, lat, lon);
    }
}

// Mirrors _rpm_slope_batch: rpm[i] - rpm[i - windowSamples], returning
// +Infinity until the trailing window is full (not enough history to judge
// whether RPM has flattened yet). Already causal — direct port.
class RpmSlopeWindow {
    constructor(windowSamples) {
        this._windowSamples = windowSamples;
        this._buf = []; // rpm values, oldest first
    }
    push(rpm) {
        this._buf.push(rpm);
        if (this._buf.length > this._windowSamples + 1) this._buf.shift();
        if (this._buf.length <= this._windowSamples) return Infinity;
        return rpm - this._buf[0];
    }
}

// Translates _rate_of_climb_batch's CENTERED +-30-sample window to a
// TRAILING windowSamples-sample window (design spec §5 causal-translation
// table: "Centered +-window alt-rate -> Trailing window alt-rate"). Returns
// null until windowSamples of history exist (a real detection lag versus
// the batch version, called out explicitly in the design spec). Assumes
// ~1Hz samples, matching the offline detector's assumption.
class TrailingAltRate {
    constructor(windowSamples) {
        this._windowSamples = windowSamples;
        this._buf = []; // altitude_ft, oldest first
    }
    push(altitudeFt) {
        this._buf.push(altitudeFt);
        if (this._buf.length > this._windowSamples + 1) this._buf.shift();
        if (this._buf.length <= this._windowSamples) return null;
        const deltaFt = altitudeFt - this._buf[0];
        return (deltaFt / this._windowSamples) * 60.0; // ft/sample -> ft/min at ~1Hz
    }
}

// Translates detect_phases()'s one-shot "median of the first 300 ground
// rows" field-elevation baseline to a running estimate that locks once a
// stable pre-flight ground sample count is reached, then freezes (design
// spec §5: "Running estimate (already implemented in engine-ml.js)" —
// this supersedes the old _computeGPSPhase's inline version so there is a
// single implementation). All three thresholds are required constructor
// arguments sourced from phase_spec.json — no in-file defaults, per this
// plan's "single numeric source of truth" constraint. The `stationary`
// argument to push() (the same GPS-delta-window boolean the caller
// already computes for classifyRow) latches an internal "has ever moved"
// flag: once true, this forces an early lock using whatever ground
// samples were seen so far (even under lockSamples), rather than letting
// a post-movement ground stop (a later taxi, a stop-and-go at a different
// field) silently keep accumulating into what should be a strictly
// pre-first-movement baseline.
class FieldElevationEstimate {
    constructor(lockSamples, stationarySpeedKts, maxIdleRpm) {
        this._lockSamples = lockSamples;
        this._stationarySpeedKts = stationarySpeedKts;
        this._maxIdleRpm = maxIdleRpm;
        this._groundSamples = [];
        this._locked = null;
        this._everMoved = false;
    }
    push(altitudeFt, speedKts, rpm, stationary) {
        if (this._locked !== null) return this._locked;
        if (!stationary) this._everMoved = true;
        if (speedKts < this._stationarySpeedKts && rpm < this._maxIdleRpm) {
            this._groundSamples.push(altitudeFt);
        }
        const reachedLockCount = this._groundSamples.length >= this._lockSamples;
        const shouldLockOnMovement = this._everMoved && this._groundSamples.length > 0;
        if (reachedLockCount || shouldLockOnMovement) {
            const sorted = [...this._groundSamples].sort((a, b) => a - b);
            this._locked = sorted[Math.floor(sorted.length / 2)];
        }
        return this._locked ?? altitudeFt;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { haversineMeters, GpsDeltaWindow, RpmSlopeWindow, TrailingAltRate, FieldElevationEstimate };
}
if (typeof window !== 'undefined') {
    window.haversineMeters = haversineMeters;
    window.GpsDeltaWindow = GpsDeltaWindow;
    window.RpmSlopeWindow = RpmSlopeWindow;
    window.TrailingAltRate = TrailingAltRate;
    window.FieldElevationEstimate = FieldElevationEstimate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/phase-detection/phase-detector-helpers.test.js`
Expected: PASS (12 tests). If `FieldElevationEstimate`'s lock value is off by more than the `toBeCloseTo(621, 0)` tolerance, adjust `lockSamples`/rounding — do not loosen the test tolerance to force a pass.

- [ ] **Step 5: Commit**

```bash
git add web/shared/phase-detector-helpers.js tests/phase-detection/phase-detector-helpers.test.js
git commit -m "feat: add causal GPS-delta, RPM-slope, trailing alt-rate, field-elevation helpers"
```

---

### Task 3: Row classifier + transition enforcement + latches

**Files:**
- Create: `web/shared/phase-detector-classify.js`
- Test: `tests/phase-detection/phase-detector-classify.test.js`

**Interfaces:**
- Consumes: `spec.transitions`, `spec.thresholds` (Task 1's validated spec shape).
- Produces: `classifyRow(signals, state, thresholds) -> candidatePhase` (pure function, direct port of `_classify_row_batch`) and `applyTransition(candidate, currentPhase, transitions) -> nextPhase` (port of `detect_phases()` line 281's inline ternary). Consumed by Task 4's `PhaseDetector.classify()`.

`signals` shape: `{ rpm, agl, speedKts, mp, fuelFlow, altRateFpm, rpmSlope, stationary }`. `state` shape: `{ currentPhase, hasTakenOff, hasLeftRamp }`.

- [ ] **Step 1: Write the failing test**

Create `tests/phase-detection/phase-detector-classify.test.js`:

```js
import { describe, it, expect } from 'vitest';
import classifyModule from '../../web/shared/phase-detector-classify.js';

const { classifyRow, applyTransition } = classifyModule;

const THR = {
    rpm_shutdown: 100, rpm_startup_max: 1400, rpm_runup_min: 1600, rpm_runup_max: 2100,
    rpm_takeoff_min: 2400, mp_full_power: 25.0, ff_shutdown_max: 0.5,
    alt_roc_climb_fpm: 350, alt_roc_descent_fpm: -350, alt_airborne_min_agl_ft: 200,
    alt_approach_agl_ft: 300, speed_approach_max_kts: 90, speed_landing_max_kts: 30,
    speed_taxi_max_kts: 20, startup_rpm_slope_flatten_rpm: 20,
};

const TRANSITIONS = {
    startup: ['warmup'], warmup: ['taxi_out', 'runup', 'shutdown'],
    taxi_out: ['runup', 'warmup', 'takeoff', 'shutdown'], runup: ['taxi_out', 'takeoff', 'warmup', 'shutdown'],
    takeoff: ['climb', 'taxi_out'], climb: ['cruise', 'descent', 'approach'],
    cruise: ['climb', 'descent', 'approach'], descent: ['cruise', 'climb', 'approach'],
    approach: ['landing', 'taxi_in', 'climb', 'cruise', 'descent'], landing: ['taxi_in', 'takeoff'],
    taxi_in: ['shutdown', 'warmup', 'takeoff'], shutdown: [],
};

function baseSignals(overrides) {
    return {
        rpm: 800, agl: 0, speedKts: 0, mp: 15, fuelFlow: 6, altRateFpm: 0,
        rpmSlope: 0, stationary: true, ...overrides,
    };
}
function baseState(overrides) {
    return { currentPhase: 'warmup', hasTakenOff: false, hasLeftRamp: false, ...overrides };
}

describe('classifyRow', () => {
    it('returns shutdown when RPM and fuel flow are both near zero', () => {
        const c = classifyRow(baseSignals({ rpm: 0, fuelFlow: 0 }), baseState(), THR);
        expect(c).toBe('shutdown');
    });

    it('stays in startup while RPM is still climbing (rpmSlope above flatten)', () => {
        const c = classifyRow(baseSignals({ rpm: 1000, rpmSlope: 50 }), baseState({ currentPhase: 'startup' }), THR);
        expect(c).toBe('startup');
    });

    it('exits startup to warmup once RPM slope flattens', () => {
        const c = classifyRow(baseSignals({ rpm: 1000, rpmSlope: 5 }), baseState({ currentPhase: 'startup' }), THR);
        expect(c).toBe('warmup');
    });

    it('classifies runup at elevated stationary RPM', () => {
        const c = classifyRow(baseSignals({ rpm: 1800, stationary: true }), baseState(), THR);
        expect(c).toBe('runup');
    });

    it('classifies takeoff at high power while moving on the ground', () => {
        const c = classifyRow(baseSignals({ rpm: 2500, mp: 27, stationary: false, agl: 0 }), baseState(), THR);
        expect(c).toBe('takeoff');
    });

    it('classifies taxi_out when moving, low RPM, before first takeoff', () => {
        const c = classifyRow(baseSignals({ rpm: 900, stationary: false }), baseState({ hasTakenOff: false }), THR);
        expect(c).toBe('taxi_out');
    });

    it('classifies taxi_in when moving, low RPM, after having taken off', () => {
        const c = classifyRow(baseSignals({ rpm: 900, stationary: false }), baseState({ hasTakenOff: true }), THR);
        expect(c).toBe('taxi_in');
    });

    it('classifies landing when moving fast on the ground after takeoff', () => {
        const c = classifyRow(baseSignals({ rpm: 900, stationary: false, speedKts: 25 }), baseState({ hasTakenOff: true }), THR);
        expect(c).toBe('landing');
    });

    it('warmup only reachable before has_left_ramp, per the ground-ops has_left_ramp latch', () => {
        const stationaryPostRamp = classifyRow(baseSignals({ rpm: 900, stationary: true }), baseState({ hasLeftRamp: true, hasTakenOff: false }), THR);
        expect(stationaryPostRamp).toBe('taxi_out');
        const stationaryPreRamp = classifyRow(baseSignals({ rpm: 900, stationary: true }), baseState({ hasLeftRamp: false, hasTakenOff: false }), THR);
        expect(stationaryPreRamp).toBe('warmup');
    });

    it('classifies climb/cruise/descent airborne by altitude rate', () => {
        const airborneState = baseState({ hasTakenOff: true });
        expect(classifyRow(baseSignals({ agl: 1000, altRateFpm: 500, speedKts: 100 }), airborneState, THR)).toBe('climb');
        expect(classifyRow(baseSignals({ agl: 1000, altRateFpm: 0, speedKts: 100 }), airborneState, THR)).toBe('cruise');
        expect(classifyRow(baseSignals({ agl: 1000, altRateFpm: -500, speedKts: 100 }), airborneState, THR)).toBe('descent');
    });

    it('classifies approach vs landing near the field by speed', () => {
        const airborneState = baseState({ hasTakenOff: true });
        expect(classifyRow(baseSignals({ agl: 250, speedKts: 60 }), airborneState, THR)).toBe('approach');
        expect(classifyRow(baseSignals({ agl: 250, speedKts: 20 }), airborneState, THR)).toBe('landing');
    });
});

describe('applyTransition', () => {
    it('accepts a candidate that is a legal transition from the current phase', () => {
        expect(applyTransition('taxi_out', 'warmup', TRANSITIONS)).toBe('taxi_out');
    });

    it('stays in the current phase when the candidate is not a legal transition', () => {
        expect(applyTransition('landing', 'warmup', TRANSITIONS)).toBe('warmup');
    });

    it('always accepts staying in the same phase', () => {
        expect(applyTransition('warmup', 'warmup', TRANSITIONS)).toBe('warmup');
    });

    it('shutdown has no legal outgoing transitions (terminal)', () => {
        expect(applyTransition('startup', 'shutdown', TRANSITIONS)).toBe('shutdown');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/phase-detection/phase-detector-classify.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `web/shared/phase-detector-classify.js`:

```js
'use strict';

// Direct port of train_anomaly_model.py's _classify_row_batch (engine_analysis,
// commit fcec247). `signals.stationary` is the GPS-delta-window boolean
// (delta < thresholds.gps_delta_stationary_m), computed by the caller.
function classifyRow(signals, state, thresholds) {
    const { rpm, agl, speedKts, mp, fuelFlow, altRateFpm, rpmSlope, stationary } = signals;
    const { currentPhase, hasTakenOff, hasLeftRamp } = state;
    const thr = thresholds;

    if (rpm < thr.rpm_shutdown && fuelFlow < thr.ff_shutdown_max) {
        return 'shutdown';
    }

    if (currentPhase === 'startup') {
        if (rpm >= thr.rpm_startup_max || !stationary) return 'warmup';
        if (rpmSlope < thr.startup_rpm_slope_flatten_rpm) return 'warmup';
        return 'startup';
    }

    const airborne = hasTakenOff && agl > thr.alt_airborne_min_agl_ft;

    if (!airborne) {
        if (rpm >= thr.rpm_takeoff_min && mp >= thr.mp_full_power && !stationary) return 'takeoff';
        if (rpm >= thr.rpm_runup_min && rpm <= thr.rpm_runup_max && stationary) return 'runup';
        if (!stationary) {
            if (hasTakenOff && speedKts > thr.speed_taxi_max_kts) return 'landing';
            return hasTakenOff ? 'taxi_in' : 'taxi_out';
        }
        if (hasLeftRamp) return hasTakenOff ? 'taxi_in' : 'taxi_out';
        return 'warmup';
    }

    const nearField = agl < thr.alt_approach_agl_ft;
    if (nearField && speedKts < thr.speed_approach_max_kts) {
        return speedKts < thr.speed_landing_max_kts ? 'landing' : 'approach';
    }
    if (altRateFpm > thr.alt_roc_climb_fpm) return 'climb';
    if (altRateFpm < thr.alt_roc_descent_fpm) return 'descent';
    return 'cruise';
}

// Direct port of detect_phases()'s line-281 inline transition check: accept
// the candidate only if it equals the current phase or is a legal
// transition target; otherwise stay in the current phase.
function applyTransition(candidate, currentPhase, transitions) {
    if (candidate === currentPhase) return currentPhase;
    const legal = transitions[currentPhase] || [];
    return legal.includes(candidate) ? candidate : currentPhase;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyRow, applyTransition };
}
if (typeof window !== 'undefined') {
    window.classifyRow = classifyRow;
    window.applyTransition = applyTransition;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/phase-detection/phase-detector-classify.test.js`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add web/shared/phase-detector-classify.js tests/phase-detection/phase-detector-classify.test.js
git commit -m "feat: port classify_row_batch and transition enforcement to JS"
```

---

### Task 4: Stateful `PhaseDetector` class — dwell-time commit buffer + public API

**Files:**
- Create: `web/shared/phase-detector.js`
- Test: `tests/phase-detection/phase-detector.test.js`

**Interfaces:**
- Consumes: `spec` (Task 1's shape), `haversineMeters`/`GpsDeltaWindow`/`RpmSlopeWindow`/`TrailingAltRate`/`FieldElevationEstimate` (Task 2), `classifyRow`/`applyTransition` (Task 3).
- Produces: `class PhaseDetector { constructor(spec); classify({ rpm, mp, fuelFlow, lat, lon, altitudeFt, speedKts }) -> phaseString }`. This is the public API `engine-ml.js` (Task 7) instantiates and calls once per sample.

Translates `_apply_min_duration_batch`'s whole-array retroactive smoothing to a forward-only dwell-commit buffer: a candidate phase must be classified for `dwell_seconds[candidate]` consecutive seconds before it replaces the committed phase. `classify()` always returns the committed phase, never the pending candidate — this is the causal analog the design spec calls for (§5's causal-translation table row "Min-duration smoothing (look-ahead) → Dwell time: require N seconds in a candidate before committing; minimum-hold on current phase").

- [ ] **Step 1: Write the failing test**

Create `tests/phase-detection/phase-detector.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import phaseDetectorModule from '../../web/shared/phase-detector.js';

const { PhaseDetector } = phaseDetectorModule;

const SPEC = JSON.parse(readFileSync(join(__dirname, '../../web/phase_spec.json'), 'utf8'));

function sample(overrides) {
    return {
        rpm: 800, mp: 15, fuelFlow: 6, lat: 33.5, lon: -85.2, altitudeFt: 620, speedKts: 0,
        ...overrides,
    };
}

describe('PhaseDetector', () => {
    let det;
    beforeEach(() => { det = new PhaseDetector(SPEC); });

    it('starts in startup', () => {
        expect(det.classify(sample())).toBe('startup');
    });

    it('does not flicker into a candidate phase before its dwell time elapses', () => {
        // Feed 200 stationary low-RPM samples to lock field elevation and
        // exit startup into warmup (rpmSlope flattens immediately since RPM
        // is constant).
        let last;
        for (let i = 0; i < 205; i++) last = det.classify(sample());
        expect(last).toBe('warmup');

        // One single sample that would classify as runup must NOT
        // immediately flip the committed phase (dwell_seconds.runup = 15).
        const oneRunupSample = det.classify(sample({ rpm: 1800 }));
        expect(oneRunupSample).toBe('warmup');
    });

    it('commits to a new phase once its dwell time is satisfied', () => {
        for (let i = 0; i < 205; i++) det.classify(sample());
        let last;
        for (let i = 0; i < 16; i++) last = det.classify(sample({ rpm: 1800 }));
        expect(last).toBe('runup');
    });

    it('never emits a phase outside the 12-phase taxonomy', () => {
        const seen = new Set();
        for (let i = 0; i < 205; i++) seen.add(det.classify(sample()));
        for (let i = 0; i < 20; i++) seen.add(det.classify(sample({ rpm: 900, speedKts: 10, lon: -85.2 - i * 0.0001 })));
        for (const phase of seen) {
            expect(SPEC.phases).toContain(phase);
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/phase-detection/phase-detector.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `web/shared/phase-detector.js`:

```js
'use strict';

const helpers = (typeof require !== 'undefined')
    ? require('./phase-detector-helpers.js')
    : { GpsDeltaWindow: window.GpsDeltaWindow, RpmSlopeWindow: window.RpmSlopeWindow, TrailingAltRate: window.TrailingAltRate, FieldElevationEstimate: window.FieldElevationEstimate };
const classify = (typeof require !== 'undefined')
    ? require('./phase-detector-classify.js')
    : { classifyRow: window.classifyRow, applyTransition: window.applyTransition };

const { GpsDeltaWindow, RpmSlopeWindow, TrailingAltRate, FieldElevationEstimate } = helpers;
const { classifyRow, applyTransition } = classify;

const AIRBORNE_PHASES = new Set(['takeoff', 'climb', 'cruise', 'descent', 'approach']);

class PhaseDetector {
    constructor(spec) {
        this._spec = spec;
        this._thr = spec.thresholds;
        this._dwellSeconds = spec.dwell_seconds;
        this._transitions = spec.transitions;

        this._gpsDelta = new GpsDeltaWindow(this._thr.gps_delta_window_s);
        this._rpmSlope = new RpmSlopeWindow(this._thr.startup_rpm_slope_window_s);
        this._altRate = new TrailingAltRate(this._thr.alt_rate_window_s);
        this._fieldElev = new FieldElevationEstimate(
            this._thr.field_elev_lock_samples,
            this._thr.speed_taxi_max_kts,
            this._thr.field_elev_max_idle_rpm,
        );

        this._committedPhase = 'startup';
        this._hasTakenOff = false;
        this._hasLeftRamp = false;

        this._pendingCandidate = null;
        this._pendingSeconds = 0;
    }

    classify({ rpm, mp, fuelFlow, lat, lon, altitudeFt, speedKts }) {
        const gpsDeltaM = this._gpsDelta.push(lat, lon);
        const stationary = gpsDeltaM < this._thr.gps_delta_stationary_m;
        const rpmSlope = this._rpmSlope.push(rpm);
        const fieldElevFt = this._fieldElev.push(altitudeFt, speedKts, rpm, stationary);
        const agl = altitudeFt - fieldElevFt;
        const altRateFpm = this._altRate.push(altitudeFt) ?? 0;

        const candidate = classifyRow(
            { rpm, agl, speedKts, mp, fuelFlow, altRateFpm, rpmSlope, stationary },
            { currentPhase: this._committedPhase, hasTakenOff: this._hasTakenOff, hasLeftRamp: this._hasLeftRamp },
            this._thr,
        );
        const validated = applyTransition(candidate, this._committedPhase, this._transitions);

        if (validated === this._committedPhase) {
            this._pendingCandidate = null;
            this._pendingSeconds = 0;
        } else if (validated === this._pendingCandidate) {
            this._pendingSeconds += 1;
            const requiredSeconds = this._dwellSeconds[validated] ?? 10;
            if (this._pendingSeconds >= requiredSeconds) {
                this._committedPhase = validated;
                this._pendingCandidate = null;
                this._pendingSeconds = 0;
            }
        } else {
            this._pendingCandidate = validated;
            this._pendingSeconds = 1;
        }

        if (AIRBORNE_PHASES.has(this._committedPhase)) this._hasTakenOff = true;
        if (this._committedPhase === 'taxi_out') this._hasLeftRamp = true;

        return this._committedPhase;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PhaseDetector };
}
if (typeof window !== 'undefined') {
    window.PhaseDetector = PhaseDetector;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/phase-detection/phase-detector.test.js`
Expected: PASS (4 tests). If the dwell-commit timing is off by a sample or two versus the test's exact counts, adjust the test's sample counts to match the intended semantics (dwell timer starts counting from the first candidate sample, inclusive) — do not change the 1-second-per-`rpmSlope`-sample assumption, since Task 5's golden parity test depends on this module's sample-count semantics matching the Python's row-count semantics under the shared 1Hz assumption.

- [ ] **Step 5: Commit**

```bash
git add web/shared/phase-detector.js tests/phase-detection/phase-detector.test.js
git commit -m "feat: add stateful PhaseDetector with dwell-time commit buffer"
```

---

### Task 5: Golden-parity test against the offline Python detector

**Files:**
- Create: `tools/freeze_phase_parity_fixture.py` (one-off generator script, run manually, not part of CI)
- Create: `tests/phase-detection/fixtures/20260710_KLKR-KLKR_parity.json` (frozen output, checked in)
- Create: `tests/phase-detection/fixtures/20260710_KLKR-KLKR_parity.csv` (the six raw input signals, checked in, copied from the engine_analysis curated fixture)
- Test: `tests/phase-detection/golden-parity.test.js`

**Interfaces:**
- Consumes: `PhaseDetector` (Task 4).
- Produces: nothing consumed by later tasks — this is a standalone regression gate, run by `npm test` like every other suite.

Design spec §7: *"Golden parity test — runs the same fixture through both the Python detector and a Node-invokable build of the JS FSM module; asserts matching phase sequences within tolerance."* Rather than shelling out to Python at test time (adds a Python runtime dependency to `npm test` and cross-language subprocess flakiness), this freezes the Python detector's output once into a checked-in JSON fixture; the vitest test only needs Node. Regenerate the frozen fixture whenever `phase_spec.json` or `detect_phases()` changes in `~/engine_analysis` — the generator script step below documents exactly how.

- [ ] **Step 1: Extract the six raw signal columns needed by the JS detector**

```bash
cd ~/engine_analysis
python3 -c "
import pandas as pd
df = pd.read_csv('tests/fixtures/20260710_KLKR-KLKR_curated.csv')
df = df.drop_duplicates(subset='Zulu_Time', keep='first').reset_index(drop=True)
cols = ['RPM', 'MP', 'Fuel Flow', 'latitude', 'longitude', 'altitude_ft', 'speed_kts']
df[cols].to_csv('/tmp/parity_signals.csv', index=False)
print(len(df), 'rows written')
"
cp /tmp/parity_signals.csv ~/flytab/tests/phase-detection/fixtures/20260710_KLKR-KLKR_parity.csv
```

- [ ] **Step 2: Write the fixture-freezing script**

Create `~/flytab/tools/freeze_phase_parity_fixture.py`:

```python
#!/usr/bin/env python3
"""One-off generator: run the offline detect_phases() over the shared
parity fixture and freeze its output as JSON for the JS golden-parity
test. Re-run and re-commit the output whenever phase_spec.json or
detect_phases() changes in ~/engine_analysis.

Usage: python3 tools/freeze_phase_parity_fixture.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / 'engine_analysis'))
import pandas as pd
from train_anomaly_model import detect_phases

FIXTURE = Path(__file__).parent.parent / 'tests/phase-detection/fixtures/20260710_KLKR-KLKR_parity.csv'
OUTPUT = Path(__file__).parent.parent / 'tests/phase-detection/fixtures/20260710_KLKR-KLKR_parity.json'

df = pd.read_csv(FIXTURE)
phases = detect_phases(df).tolist()

OUTPUT.write_text(json.dumps({'phases': phases}, indent=2))
print(f"Wrote {len(phases)} phase labels to {OUTPUT}")
```

Run it:

```bash
cd ~/flytab
python3 tools/freeze_phase_parity_fixture.py
```

Expected: `Wrote <N> phase labels to .../20260710_KLKR-KLKR_parity.json`

- [ ] **Step 3: Write the failing test**

Create `tests/phase-detection/golden-parity.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import phaseDetectorModule from '../../web/shared/phase-detector.js';

const { PhaseDetector } = phaseDetectorModule;

const SPEC = JSON.parse(readFileSync(join(__dirname, '../../web/phase_spec.json'), 'utf8'));
const SIGNALS_CSV = readFileSync(join(__dirname, 'fixtures/20260710_KLKR-KLKR_parity.csv'), 'utf8');
const PYTHON_PHASES = JSON.parse(readFileSync(join(__dirname, 'fixtures/20260710_KLKR-KLKR_parity.json'), 'utf8')).phases;

const rows = parse(SIGNALS_CSV, { columns: true, cast: true });

describe('golden parity: JS PhaseDetector vs frozen Python detect_phases() output', () => {
    it('agrees with the Python detector on at least 85% of rows', () => {
        const det = new PhaseDetector(SPEC);
        let agree = 0;
        const jsPhases = [];
        for (const row of rows) {
            const phase = det.classify({
                rpm: row.RPM, mp: row.MP, fuelFlow: row['Fuel Flow'],
                lat: row.latitude, lon: row.longitude, altitudeFt: row.altitude_ft, speedKts: row.speed_kts,
            });
            jsPhases.push(phase);
        }
        for (let i = 0; i < rows.length; i++) {
            if (jsPhases[i] === PYTHON_PHASES[i]) agree++;
        }
        const agreement = agree / rows.length;
        // eslint-disable-next-line no-console
        console.log(`JS/Python phase agreement: ${(agreement * 100).toFixed(1)}% (${agree}/${rows.length})`);
        expect(agreement).toBeGreaterThanOrEqual(0.85);
    });
});
```

Add the `csv-parse` dev dependency:

```bash
cd ~/flytab
npm install --save-dev csv-parse
```

- [ ] **Step 4: Run test, expect it to fail or pass below target — treat as a real measurement, not a given**

Run: `npm test -- tests/phase-detection/golden-parity.test.js`

The Python offline detector's own golden-fixture test (`~/engine_analysis/tests/test_detect_phases.py`) asserts ≥90% against curated human labels, using centered/look-ahead smoothing. This JS port is deliberately causal (trailing-only), so some disagreement against the *Python's own output* (not the human labels) is expected near phase boundaries — 85% is the threshold to start at. **If the run reports below 85%:** inspect the printed disagreement rows (add a `console.log` of the first 20 mismatched indices with both phases if needed), identify whether the gap is a systematic bug (e.g. dwell timing off by a constant offset) versus expected boundary lag, fix genuine bugs in Tasks 2-4, and only adjust the 85% threshold itself if the disagreement is provably boundary-lag from the causal-vs-batch translation (document the reasoning in the commit message if so, mirroring how Plan 1's Task 4 handled its own known-ambiguous-rows exception).

- [ ] **Step 5: Once passing, commit**

```bash
git add tools/freeze_phase_parity_fixture.py tests/phase-detection/fixtures/ tests/phase-detection/golden-parity.test.js package.json package-lock.json
git commit -m "test: add golden-parity test against frozen Python detect_phases() output"
```

---

### Task 6: Deploy the already-retrained `anomaly_v2` model to FlyTab assets

**Files:**
- Modify (copy): `android/app/src/main/assets/anomaly_v2.tflite` ← `~/engine_analysis/models/anomaly_v2_float32.tflite`
- Modify (copy): `android/app/src/main/assets/anomaly_v2_metadata.json` ← `~/engine_analysis/models/anomaly_v2_metadata.json`

**Why this task exists:** Plan 1 (`~/engine_analysis`) retrained `anomaly_v2` on the new 12-phase labels and merged it to master, but design spec §9 step 4 (copy the retrained model to FlyTab assets, verify, on-device CDP test) was never executed — the tablet is still running the model trained on the old 8-phase labels. This is independent of the JS/Java phase-detector work in the rest of this plan, but genuinely "seamless" operation requires both: the runtime phase detector (this plan's other tasks) and the model actually trained on that taxonomy's per-phase thresholds. This lands before Task 7's build so the rebuilt APK ships both changes together in one version bump rather than two.

- [ ] **Step 1: Copy the model and metadata**

```bash
cp ~/engine_analysis/models/anomaly_v2_float32.tflite ~/flytab/android/app/src/main/assets/anomaly_v2.tflite
cp ~/engine_analysis/models/anomaly_v2_metadata.json ~/flytab/android/app/src/main/assets/anomaly_v2_metadata.json
```

- [ ] **Step 2: Verify the copied model matches what FlyTab expects, per the existing CLAUDE.md checklist**

```bash
cd ~/flytab
python3 -c "
import tensorflow as tf, json
interp = tf.lite.Interpreter('android/app/src/main/assets/anomaly_v2.tflite')
interp.allocate_tensors()
inp = interp.get_input_details()[0]
print(inp['dtype'])   # must be float32
print(inp['shape'])   # must be [1, 60, 12]
with open('android/app/src/main/assets/anomaly_v2_metadata.json') as f:
    meta = json.load(f)
print(meta['n_features'])      # must be 12
print(meta['quantization'])    # should be FLOAT32
print(len(meta['normalization']['mean']))  # must be 12
print(meta['phases'])          # should list all 12 new phases
"
```

Expected: `<class 'numpy.float32'>`, `[1 60 12]`, `12`, `FLOAT32`, `12`, and a 12-entry phase list including `taxi_out`, `approach`, `taxi_in`, `shutdown`. If any of these don't match, stop — do not proceed to Task 7's build with a mismatched model; re-check that Step 1's copy actually pulled from the post-merge `~/engine_analysis/models/` files.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/assets/anomaly_v2.tflite android/app/src/main/assets/anomaly_v2_metadata.json
git commit -m "feat: deploy anomaly_v2 model retrained on the 12-phase taxonomy"
```

---

### Task 7: Wire `PhaseDetector` into `engine-ml.js`, delete the cosmetic GPS override

**Files:**
- Modify: `web/cockpit/engine-ml.js:79-81` (constructor/`start()`), `:247-295` (`_onEngineData`), `:568-616` (delete `_computeGPSPhase`), `:627-652` (delete `_derivePhase`)
- Modify: `web/index.html:141` (add a script tag for the new module, before `engine-ml.js`)
- Modify: `web/shared/stratux-client.js` — no change needed (confirmed `situation.lat`/`.lon` already exist on the object; `engine-ml.js` just needs to start reading them).

**Interfaces:**
- Consumes: `PhaseDetector`, `loadPhaseSpec` (global, from Tasks 1 and 4 — loaded via classic `<script>` tags, so available as `window.PhaseDetector`/`window.loadPhaseSpec`).
- Produces: the Capacitor `processSample` payload now includes a `phase` field, consumed by Task 8's `EngineMLPlugin.java`.

- [ ] **Step 1: Add the new script tags to `index.html`, before `engine-ml.js`**

In `web/index.html`, replace line 141:

```html
    <script src="./cockpit/engine-ml.js"></script>
```

with:

```html
    <script src="./shared/phase-spec-loader.js"></script>
    <script src="./shared/phase-detector-helpers.js"></script>
    <script src="./shared/phase-detector-classify.js"></script>
    <script src="./shared/phase-detector.js"></script>
    <script src="./cockpit/engine-ml.js"></script>
```

- [ ] **Step 2: Load the spec and instantiate `PhaseDetector` in `engine-ml.js`'s `start()`**

In `web/cockpit/engine-ml.js`, modify the `start()` method (currently lines 79-81):

```js
start(engineClient, stratuxClient) {
    this._engineClient = engineClient;
    this._stratuxClient = stratuxClient;
    this._phaseDetectorReady = window.loadPhaseSpec()
        .then((spec) => { this._phaseDetector = new window.PhaseDetector(spec); })
        .catch((err) => {
            DiagLog?.error?.('EngineML', `Failed to load phase_spec.json: ${err.message}`);
            this._phaseDetector = null; // _onEngineData falls back to a fixed phase below
        });
    ...
```

(Keep whatever else `start()` already does after the existing `this._stratuxClient = stratuxClient;` line — this only adds the phase-spec load, it does not remove existing behavior.)

- [ ] **Step 3: Compute `phase` before the plugin call in `_onEngineData`, delete the post-hoc override**

In `web/cockpit/engine-ml.js`, within `_onEngineData` (currently lines 247-295): the existing flow is `_computeGPSPhase` (line 260) → `_derivePhase`/baseline update (line 263) → plugin call (lines 273-292) → override `result.phase` (line 295). Replace that whole block with:

```js
const sit = this._stratuxClient?.situation;
let phase = 'cruise'; // graceful default if the spec hasn't loaded yet or GPS is unavailable
if (this._phaseDetector && sit?.lat != null && sit?.lon != null) {
    phase = this._phaseDetector.classify({
        rpm: d.rpm ?? d.RPM ?? 0,
        mp: d.manifold_pressure ?? d.mp ?? d.MAP ?? 0,
        fuelFlow: d.fuel_flow_gph ?? d.gph ?? d.Fuel_Flow ?? 0,
        lat: sit.lat,
        lon: sit.lon,
        altitudeFt: sit.alt_msl ?? d.altitude_ft ?? 0,
        speedKts: sit.ground_speed ?? d.speed_kts ?? 0,
    });
}

this._updateBaseline(d);
// (existing physics rules, unchanged)

const result = await this._plugin.processSample({
    rpm, egt1, egt2, egt3, egt4, cht1, cht2, cht3, cht4,
    oil_temp, oil_press, fuel_flow, altitude, mp, carb_temp,
    fuel_remaining, ground_speed, distance_nm,
    phase,
});
// no post-hoc override — result.phase now just echoes what was computed and sent
```

Delete `_computeGPSPhase` (lines 568-616) and `_derivePhase` (lines 627-652) entirely — nothing else in the file calls them once this change lands (confirmed by the investigation: `_derivePhase`'s only caller was the deleted line-263 call).

- [ ] **Step 4: Run the vitest suite to confirm nothing else in the repo referenced the deleted functions**

Run: `npm test`
Expected: PASS, no new failures. (There is no existing vitest coverage of `engine-ml.js` itself — this step is a regression check on the rest of the suite, not new coverage of this file.)

- [ ] **Step 5: Bump `FLYTAB_VERSION` and build**

In `web/app.js`, increment the version constant at the top of the file per its existing `vX.YY` convention. Then:

```bash
cd ~/flytab
bash build.sh
```

Expected: build succeeds with no compile errors.

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/cockpit/engine-ml.js web/app.js
git commit -m "feat: wire causal PhaseDetector into engine-ml.js, delete cosmetic GPS phase override"
```

**Manual follow-up (not automatable by this plan):** after Task 8 also lands and the APK is rebuilt/installed, run the on-device CDP test per `~/flytab/CLAUDE.md → EngineML Plugin → Deploying a New Model` to confirm `phase` in the plugin result matches what the JS module computed, before flying.

---

### Task 8: `EngineMLPlugin.java` reads `phase` from the payload; delete `PhaseDetector.java`

**Files:**
- Modify: `android/app/src/main/java/app/flywhere/flytab/engineml/EngineMLPlugin.java:32` (remove the `phaseDetector` field), `:56` (remove instantiation), `:130` (replace the `detect()` call with a payload read)
- Delete: `android/app/src/main/java/app/flywhere/flytab/engineml/PhaseDetector.java`

**Interfaces:**
- Consumes: the `phase` field on the payload from Task 7's `processSample` call.
- Produces: nothing new — `thresholdAdapter.getThreshold(phase)` (line 150) and `engineAdvisor.advise(...)` (lines 159-160) are unchanged downstream consumers, confirmed to work with arbitrary phase strings with zero code changes (`ThresholdAdapter` is a pure map lookup; `EngineAdvisor`'s switch has a `default` case).

- [ ] **Step 1: Remove the `phaseDetector` field and its instantiation**

In `EngineMLPlugin.java`, delete line 32 (the `phaseDetector` field declaration) and line 56 (`phaseDetector = new PhaseDetector();` inside `initialize()`).

- [ ] **Step 2: Replace the `detect()` call at line 130 with a payload read, defaulting to `"cruise"`**

Replace:

```java
String phase = phaseDetector.detect(rpm, altitude, groundSpeed);
```

with:

```java
String phase = call.getString("phase", "cruise");
if (phase == null || phase.isEmpty()) {
    phase = "cruise";
}
```

- [ ] **Step 3: Delete `PhaseDetector.java`**

```bash
cd ~/flytab
git rm android/app/src/main/java/app/flywhere/flytab/engineml/PhaseDetector.java
```

- [ ] **Step 4: Build to confirm no remaining references**

```bash
bash build.sh
```

Expected: build succeeds. If it fails with an unresolved `PhaseDetector` reference anywhere else in the `android/app/` tree (not `engine-ml-test/`, which is explicitly out of scope per this plan's header), grep for it and remove that reference too before re-running — do not leave a dangling import.

- [ ] **Step 5: Commit**

```bash
git add -A android/app/src/main/java/app/flywhere/flytab/engineml/EngineMLPlugin.java
git commit -m "feat: read phase from processSample payload, delete PhaseDetector.java"
```

**Manual follow-up:** install the rebuilt APK and run the on-device CDP test (see Task 7's follow-up note) before flying.

---

### Task 9: Sticky-valve advisory, gated on `phase == STARTUP` — plumbing only, threshold flagged unvalidated

**Files:**
- Modify: `android/app/src/main/java/app/flywhere/flytab/engineml/EngineAdvisor.java` — add per-cylinder EGT-at-startup-entry tracking to `addSample(...)` (line 95) and a new advisory check in `advise(...)` (lines 118-120).
- Modify: `docs/user-manual.md` — document the new advisory (this is a new message the pilot will see, so it belongs in the same commit per CLAUDE.md's user-manual rule).

**Why the threshold is a flagged placeholder, not a real number:** the design spec (§8) specifies *what* this check compares (per-cylinder EGT rise across the startup window, flagging a cylinder that lags significantly) but gives no numeric "lags significantly" threshold — none of the design/investigation sessions that produced this plan referenced real flight data with a confirmed sticky-valve event to calibrate against. Inventing a specific °F/second threshold here would be exactly the kind of unvalidated guess the project's standing instructions rule out ("I want code that works the first time," "don't guess"). Plan 1 hit the same shape of gap (no `approach`/`takeoff` training windows) and the resolution there was: ship the mechanism, flag the gap explicitly, deploy as-is, tune later against real data — this task follows that same precedent.

**Interfaces:**
- Consumes: `phase` (already a parameter of `advise(...)`), the four EGT values already passed into `addSample`'s `float[] features` (indices 1-4 per the 12-feature layout: `RPM, EGT1-4, CHT1-4, OilTemp, OilPress, FuelFlow`).
- Produces: a new `Advisory` (same type `advise()` already returns a `List<Advisory>` of) with a fixed message format, gated on phase transitioning into `startup`.

- [ ] **Step 1: Add per-cylinder startup-entry EGT tracking**

In `EngineAdvisor.java`, add fields near the existing history buffers (constructor area, line 86):

```java
private float[] startupEntryEgt = null; // EGT1-4 at the moment phase first became "startup" this cycle
private String lastPhase = null;
```

- [ ] **Step 2: Latch the entry EGT values when phase first becomes `startup`, in `addSample(...)`**

In `addSample(float[] features, float mp, float carbTemp, float fuelRemaining, float altitude)` (line 95), add — this method doesn't currently receive `phase`, so thread it through: change the signature to `addSample(float[] features, String phase, float mp, float carbTemp, float fuelRemaining, float altitude)` and update its call site in `EngineMLPlugin.java` to pass `phase` (the same variable Task 8 introduced). Then, inside `addSample`:

```java
if ("startup".equals(phase) && !"startup".equals(lastPhase)) {
    startupEntryEgt = new float[]{features[1], features[2], features[3], features[4]};
}
lastPhase = phase;
```

- [ ] **Step 3: Add the sticky-valve check to `advise(...)`**

In `advise(...)` (lines 118-120), add, guarded on `"startup".equals(phase)` and `startupEntryEgt != null`:

```java
// Sticky/stuck-valve check: a cylinder whose EGT hasn't risen with the
// others during startup is the cold-cylinder signature (design spec
// 2026-06-21-flight-phase-detection-redesign.md §8). THRESHOLD BELOW IS
// AN UNVALIDATED PLACEHOLDER — no real sticky-valve flight data has been
// used to calibrate it. Do not treat an alert from this check as
// confirmed until validated against a known-good vs known-sticky
// comparison flight.
if ("startup".equals(phase) && startupEntryEgt != null) {
    float[] currentEgt = {features[1], features[2], features[3], features[4]};
    float maxRise = 0f;
    for (int i = 0; i < 4; i++) {
        maxRise = Math.max(maxRise, currentEgt[i] - startupEntryEgt[i]);
    }
    float STICKY_VALVE_LAG_THRESHOLD_F = 150f; // PLACEHOLDER — see comment above
    for (int i = 0; i < 4; i++) {
        float rise = currentEgt[i] - startupEntryEgt[i];
        if (maxRise > 100f && (maxRise - rise) > STICKY_VALVE_LAG_THRESHOLD_F) {
            advisories.add(new Advisory(
                Advisory.Level.CAUTION,
                String.format("Cylinder %d EGT rise lagging others during startup (possible sticky valve) — UNVALIDATED CHECK, confirm on ground", i + 1)
            ));
        }
    }
}
```

(Insert this into whatever local `List<Advisory> advisories` the existing method already builds and returns — match the existing variable name/pattern in the surrounding code rather than introducing a second list.)

- [ ] **Step 4: Update the call site in `EngineMLPlugin.java`**

Update the `addSample(...)` call to pass `phase` (Task 8 already computed it earlier in the same method):

```java
engineAdvisor.addSample(features, phase, mp, carbTemp, fuelRemaining, altitude);
```

- [ ] **Step 5: Build**

```bash
cd ~/flytab
bash build.sh
```

Expected: build succeeds.

- [ ] **Step 6: Document the new advisory in the user manual**

In `docs/user-manual.md`, add a short entry under whatever section documents existing engine advisories, noting: the new "Cylinder N EGT rise lagging" caution message during startup, and explicitly that its threshold is unvalidated pending real flight data (don't let this caveat live only in the code comment — the pilot-facing doc should say the same thing plainly, e.g. "this check is new and its sensitivity has not yet been tuned against a confirmed sticky-valve event — treat an alert as a prompt to inspect on the ground, not a confirmed diagnosis").

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/app/flywhere/flytab/engineml/EngineAdvisor.java android/app/src/main/java/app/flywhere/flytab/engineml/EngineMLPlugin.java docs/user-manual.md
git commit -m "feat: add phase-gated sticky-valve EGT-lag advisory (threshold unvalidated, flagged)"
```

**Follow-up needed from Dana, not part of this plan's automated steps:** calibrate `STICKY_VALVE_LAG_THRESHOLD_F` against real startup data — ideally one normal-startup flight and one flight with a confirmed sticky/stuck valve, following the same empirical-derivation approach Plan 1 used for `speed_taxi_max_kts` (derived from a real flight's own curated speed distribution, not guessed).

---

### Task 10: Audit offline consumers for hardcoded 8-phase assumptions (verification only)

**Files:** none modified — this task's deliverable is a documented verification, per design spec §9 step 5.

- [ ] **Step 1: Confirm `run_ml_inference.py` has no hardcoded phase enumeration**

```bash
cd ~/engine_analysis
grep -n "phase" run_ml_inference.py | grep -v "detect_phases\|ml_phase\|_phase'" | head -20
```

Expected finding (already confirmed during this plan's investigation): phases are read from `meta['phases']` (model metadata, not a literal) and `detect_phases()`'s output — no hardcoded 8-item list. No code change needed.

- [ ] **Step 2: Confirm `compare_departures.py` has no hardcoded phase enumeration**

```bash
grep -n "phase" compare_departures.py
```

Expected finding: single string comparisons (`df['phase'] == 'takeoff'`), no enumeration. No code change needed.

- [ ] **Step 3: Confirm `cam_analysis.py`'s relationship to phase detection**

```bash
grep -n "phase\|detect_phases" cam_analysis.py
```

Expected finding: zero hits — `cam_analysis.py` does not import `detect_phases()` at all; it runs its own independent, phase-agnostic cruise/runup segment extraction. This means design spec §9 step 5's "audit for hardcoded 8-phase assumptions" finding for this file is: there is no stale hardcoded list to fix, because this file never consumed the phase taxonomy in the first place. Document this finding in the plan's execution notes (or a follow-up ticket) rather than silently closing it — if `cam_analysis.py` is ever meant to become phase-aware, that is new code, not a fix to existing code, and is out of scope for this plan.

- [ ] **Step 4: No commit needed** — this task produces no file changes, matching Plan 1's precedent for its own verification-only Task 7.

---

### Task 11: Update both CLAUDE.md files

**Files:**
- Modify: `~/flytab/CLAUDE.md` (EngineML Plugin section, lines 238-297)
- Modify: `~/engine_analysis/CLAUDE.md` (Shared Phase Detection section)

- [ ] **Step 1: Update `~/flytab/CLAUDE.md`'s EngineML Plugin section**

In the "Files" table (around line 244-252), remove the row for `PhaseDetector.java` (deleted by Task 8) and add rows for the new files:

```markdown
| `web/phase_spec.json` | Shared 12-phase taxonomy, thresholds, transitions, dwell times — copied verbatim from `~/engine_analysis/phase_spec.json`. Single source of truth for both repos; do not hand-edit divergently. |
| `web/shared/phase-detector.js` | Causal 12-phase FSM — computes `phase` before the Capacitor `processSample` call. Loaded as a classic script (not `type="module"`), same as `engine-ml.js`. |
| `web/shared/phase-detector-classify.js`, `web/shared/phase-detector-helpers.js`, `web/shared/phase-spec-loader.js` | Supporting modules for the above — row classifier, causal signal-window helpers, spec loader/validator. |
```

Add a short paragraph after the Feature Array section explaining the phase bridge change:

```markdown
### Phase Detection — Bridge Change (2026-07)

`phase` is computed in JS (`web/shared/phase-detector.js`, a causal port of `~/engine_analysis/train_anomaly_model.detect_phases()`) and sent as an INPUT field on the `processSample` payload. `EngineMLPlugin.java` no longer computes phase — it reads `call.getString("phase", "cruise")` and defaults to `"cruise"` on anything missing/unparseable. `PhaseDetector.java` was deleted in this change; do not re-add Java-side phase computation — see `docs/superpowers/specs/2026-06-21-flight-phase-detection-redesign.md` for the full design rationale, and `docs/superpowers/plans/2026-07-14-flight-phase-detection-runtime.md` for what shipped.

The 12-phase taxonomy (`startup, warmup, taxi_out, runup, takeoff, climb, cruise, descent, approach, landing, taxi_in, shutdown`) replaces the old 8-phase one. `phase_spec.json` (checked into both repos) is the only place any threshold/transition/dwell value should live — never hardcode a phase threshold in JS or Python again.
```

- [ ] **Step 2: Update `~/engine_analysis/CLAUDE.md`'s Shared Phase Detection section**

Replace the existing paragraph:

```markdown
### Shared Phase Detection

`train_anomaly_model.detect_phases()` is the canonical flight phase detector, imported by `run_ml_inference.py`, `compare_departures.py`. Do not duplicate phase logic elsewhere. Phases: `startup → warmup → runup → takeoff → climb → cruise → descent → landing`.
```

with:

```markdown
### Shared Phase Detection

`train_anomaly_model.detect_phases()` is the canonical **offline batch** flight phase detector, imported by `run_ml_inference.py` and `compare_departures.py` (`cam_analysis.py` has its own independent, phase-agnostic cruise/runup detection and does not import it). Do not duplicate phase logic elsewhere.

12 phases (not 8, as of 2026-07): `startup → warmup → taxi_out → runup → takeoff → climb → cruise → descent → approach → landing → taxi_in → shutdown`. Every threshold, legal transition, and dwell time lives in `phase_spec.json` — loaded via `phase_spec.py`, validated at import time. `phase_spec.json` is duplicated verbatim in `~/flytab/web/phase_spec.json` for the runtime (causal) detector, `~/flytab/web/shared/phase-detector.js` — see `~/flytab/docs/superpowers/specs/2026-06-21-flight-phase-detection-redesign.md` for why two implementations exist (batch look-ahead vs. runtime causal) instead of one shared codebase, and `~/flytab/tests/phase-detection/golden-parity.test.js` for the test that keeps them from silently drifting apart. Update both `phase_spec.json` copies together, and re-run `python3 tools/freeze_phase_parity_fixture.py` (in `~/flytab`) to refresh the golden-parity fixture whenever this file's spec values or `detect_phases()`'s algorithm change.
```

- [ ] **Step 3: Commit each repo separately**

```bash
cd ~/flytab
git add CLAUDE.md
git commit -m "docs: document the phase-detection bridge change and new shared files"

cd ~/engine_analysis
git add CLAUDE.md
git commit -m "docs: document the 12-phase taxonomy and flytab parity requirement"
```

---

### Task 12: Reset the runtime detector's state on a new engine-start after `shutdown`

**Why this task exists:** The final whole-branch review (2026-07-14) found and Dana confirmed observing in practice: `PhaseDetector` is instantiated exactly once in `engine-ml.js`'s `start()` and runs for the app's entire session. `phase_spec.json` makes `shutdown` a terminal state (`transitions.shutdown: []`) — correct for the offline batch detector, which processes one flight's CSV at a time, but wrong for a tablet app that stays open across a multi-leg flying day (land, taxi back, shut down, refuel, restart, fly again). Once the detector commits `shutdown`, `applyTransition` can never legally leave it, so every subsequent leg in the same app session reports `phase='shutdown'` forever — silently gating ML anomaly detection with the engine-off threshold and suppressing every in-flight `EngineAdvisor` message for that entire leg. This is a direct violation of this plan's own Global Constraint ("a malformed sample must degrade gracefully, never silently drop anomaly coverage") — not from a malformed sample, but from a real, previously-untested multi-flight session. The design spec's own §2 anticipated the *concept* ("A later `startup` begins a fresh engine-start cycle rather than a transition out of `shutdown`") but that reset semantics was never ported to the runtime FSM — only the offline batch detector gets a fresh start "for free" because it's invoked once per CSV file.

**Files:**
- Modify: `web/shared/phase-detector.js` (add `reset()`, detect the shutdown→restart edge in `classify()`)
- Modify: `android/app/src/main/java/app/flywhere/flytab/engineml/EngineAdvisor.java` (call its existing, currently-unused `reset()` on the same edge)
- Test: `tests/phase-detection/phase-detector.test.js` (new integration test: full flight into `shutdown`, then a second engine-start, assert recovery)

**Interfaces:**
- Produces: `PhaseDetector.prototype.reset()` — public method, no arguments, reinitializes all detector state (committed phase back to `'startup'`, latches cleared, helper windows re-created fresh). Called internally by `classify()`; also usable directly by a caller if ever needed (e.g. a future explicit "new flight" UI action), though this task does not add such a caller.

- [ ] **Step 1: Write the failing test**

Add to `tests/phase-detection/phase-detector.test.js` (same file Task 4 created — read it first to match its exact `sample()` helper and `SPEC` loading pattern before adding this):

```js
describe('PhaseDetector reset on a new engine-start after shutdown', () => {
    it('recovers into startup instead of staying stuck in shutdown forever', () => {
        const det = new PhaseDetector(SPEC);

        // Drive the detector all the way to a committed 'shutdown' (engine off).
        for (let i = 0; i < 205; i++) det.classify(sample()); // -> warmup (per Task 4's existing test)
        let last;
        for (let i = 0; i < 10; i++) {
            last = det.classify(sample({ rpm: 0, fuelFlow: 0 })); // dwell_seconds.shutdown = 5
        }
        expect(last).toBe('shutdown');

        // A single noisy sample above the shutdown thresholds must NOT reset by
        // itself -- shutdown_restart_debounce_samples (3) requires consecutive
        // restart-condition samples, guarding against a sensor blip wedging the
        // detector at 'startup' for the rest of a genuine ground stop.
        expect(det.classify(sample({ rpm: 800, fuelFlow: 6 }))).toBe('shutdown');
        expect(det.classify(sample({ rpm: 800, fuelFlow: 6 }))).toBe('shutdown');

        // If the noise stops before the debounce completes, the count resets --
        // a genuinely-off sample after two "noisy" ones must not carry over
        // partial progress toward a reset.
        expect(det.classify(sample({ rpm: 0, fuelFlow: 0 }))).toBe('shutdown');
        expect(det.classify(sample({ rpm: 800, fuelFlow: 6 }))).toBe('shutdown'); // debounce count = 1 again
        expect(det.classify(sample({ rpm: 800, fuelFlow: 6 }))).toBe('shutdown'); // debounce count = 2

        // Third consecutive genuine restart sample confirms it -- resets and
        // classifies this same sample fresh.
        const afterRestart = det.classify(sample({ rpm: 800, fuelFlow: 6 })); // debounce count = 3
        expect(afterRestart).toBe('startup');

        // The detector must behave like a genuinely fresh instance from here --
        // confirm it can reach warmup again via the same path Task 4's own test uses,
        // not remain wedged in some half-reset state.
        let last2;
        for (let i = 0; i < 205; i++) last2 = det.classify(sample({ rpm: 800, fuelFlow: 6 }));
        expect(last2).toBe('warmup');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/phase-detection/phase-detector.test.js`
Expected: FAIL — `expect(afterRestart).toBe('startup')` fails, actual `'shutdown'` (the pre-fix detector stays wedged).

- [ ] **Step 3: Implement `reset()` and the shutdown→restart detection**

In `web/shared/phase-detector.js`, refactor the constructor to delegate its state initialization to a new `reset()` method (DRY — both need the identical initial state), and add the shutdown→restart check at the top of `classify()`:

```js
class PhaseDetector {
    constructor(spec) {
        this._spec = spec;
        this._thr = spec.thresholds;
        this._dwellSeconds = spec.dwell_seconds;
        this._transitions = spec.transitions;
        this.reset();
    }

    // Re-initializes all per-flight state, including the accumulated causal
    // helper windows (a stale GPS-delta/RPM-slope/altitude-rate/field-elevation
    // history from the flight that just ended must not leak into the new one).
    // Called by the constructor, and internally by classify() when it detects
    // a fresh engine-start after a committed 'shutdown' -- phase_spec.json makes
    // 'shutdown' terminal for the offline batch detector (correct: one CSV per
    // flight), but this runtime detector runs continuously across an entire
    // app session, so without this reset a second flight leg in the same
    // session would report 'shutdown' forever. See the Task 12 note in the
    // implementation plan for the full incident.
    reset() {
        this._gpsDelta = new GpsDeltaWindow(this._thr.gps_delta_window_s);
        this._rpmSlope = new RpmSlopeWindow(this._thr.startup_rpm_slope_window_s);
        this._altRate = new TrailingAltRate(this._thr.alt_rate_window_s);
        this._fieldElev = new FieldElevationEstimate(
            this._thr.field_elev_lock_samples,
            this._thr.speed_taxi_max_kts,
            this._thr.field_elev_max_idle_rpm,
        );
        this._committedPhase = 'startup';
        this._hasTakenOff = false;
        this._hasLeftRamp = false;
        this._pendingCandidate = null;
        this._pendingSeconds = 0;
        this._restartDebounceCount = 0;
    }

    classify({ rpm, mp, fuelFlow, lat, lon, altitudeFt, speedKts }) {
        // A committed 'shutdown' is terminal in phase_spec.json's transition
        // graph, but this detector runs across an entire app session, not one
        // flight -- detect a genuine restart (the same rpm/fuelFlow condition
        // classifyRow itself uses to decide "shutdown") and reset before doing
        // anything else with this sample, so every downstream computation
        // (GPS-delta, RPM-slope, field-elevation, the classifier itself) sees
        // fresh state for the new flight rather than mixing in the old one's
        // history. Debounced over shutdown_restart_debounce_samples consecutive
        // samples (not a single one): reset() commits _committedPhase back to
        // 'startup', and phase_spec.json's transitions.startup only permits
        // 'warmup' -- if a single noisy RPM/fuel-flow sample fired the reset
        // while the aircraft is genuinely still parked and off, every following
        // genuinely-off sample's classifyRow candidate ('shutdown') would be an
        // illegal transition from 'startup' and get silently rejected, wedging
        // the detector reporting 'startup' for the rest of that ground stop
        // instead of correctly reporting 'shutdown' again. Requiring the
        // restart condition to persist for N samples (matching real engine-start
        // RPM rise, not a transient sensor blip) closes that without
        // reintroducing the original stuck-in-shutdown bug this task exists to
        // fix. Found and fixed during this task's own review, not guessed
        // upfront -- see the Task 12 fix note in the implementation plan.
        if (this._committedPhase === 'shutdown') {
            const stillShutdown = rpm < this._thr.rpm_shutdown && fuelFlow < this._thr.ff_shutdown_max;
            if (stillShutdown) {
                this._restartDebounceCount = 0;
                return this._committedPhase;
            }
            this._restartDebounceCount += 1;
            if (this._restartDebounceCount < this._thr.shutdown_restart_debounce_samples) {
                return this._committedPhase; // not yet confirmed -- stay shutdown
            }
            this.reset(); // confirmed restart -- fall through and classify this sample fresh
        }

        const gpsDeltaM = this._gpsDelta.push(lat, lon);
        const stationary = gpsDeltaM < this._thr.gps_delta_stationary_m;
        const rpmSlope = this._rpmSlope.push(rpm);
        const fieldElevFt = this._fieldElev.push(altitudeFt, speedKts, rpm, stationary);
        const agl = altitudeFt - fieldElevFt;
        const altRateFpm = this._altRate.push(altitudeFt) ?? 0;

        const candidate = classifyRow(
            { rpm, agl, speedKts, mp, fuelFlow, altRateFpm, rpmSlope, stationary },
            { currentPhase: this._committedPhase, hasTakenOff: this._hasTakenOff, hasLeftRamp: this._hasLeftRamp },
            this._thr,
        );
        const legalityAnchor = this._pendingCandidate ?? this._committedPhase;
        const validated = applyTransition(candidate, legalityAnchor, this._transitions);

        if (validated === this._committedPhase) {
            this._pendingCandidate = null;
            this._pendingSeconds = 0;
        } else if (validated === this._pendingCandidate) {
            this._pendingSeconds += 1;
            const requiredSeconds = this._dwellSeconds[validated] ?? 10;
            if (this._pendingSeconds >= requiredSeconds) {
                this._committedPhase = validated;
                this._pendingCandidate = null;
                this._pendingSeconds = 0;
            }
        } else {
            this._pendingCandidate = validated;
            this._pendingSeconds = 1;
        }

        if (AIRBORNE_PHASES.has(this._committedPhase)) this._hasTakenOff = true;
        if (this._committedPhase === 'taxi_out') this._hasLeftRamp = true;

        return this._committedPhase;
    }
}
```

(Everything else in the file — the `require`/`window` dual export, `AIRBORNE_PHASES`, the existing deadlock-fix comment block on `_pendingCandidate` — is unchanged; only the constructor/`classify()` shown above and the new `reset()` method change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/phase-detection/phase-detector.test.js`
Expected: PASS (all tests in the file, including the 5 from Task 4 and the new reset test)

- [ ] **Step 5: Wire the same reset on the Java side**

`EngineAdvisor.java` already has a `reset()` method (added inertly by Task 9, never called) that clears `historyCount`, `historyHead`, `currentMP`, `currentCarbTemp`, `currentFuelRemaining`, `startupEntryEgt`, and `lastPhase` — exactly the per-flight state a new leg needs cleared (trend history buffers, the sticky-valve EGT baseline). Call it at the top of `addSample(...)`, detecting the same shutdown→non-shutdown edge via the existing `lastPhase` field (already tracked for the sticky-valve latch), before that sample's data is recorded:

```java
public void addSample(float[] features, String phase, float mp, float carbTemp, float fuelRemaining, float altitude) {
    if ("shutdown".equals(lastPhase) && !"shutdown".equals(phase)) {
        reset();
    }
    System.arraycopy(features, 0, history[historyHead], 0, Math.min(features.length, 12));
    mpHistory[historyHead] = mp;
    carbTempHistory[historyHead] = carbTemp;
    historyHead = (historyHead + 1) % HISTORY_SIZE;
    if (historyCount < HISTORY_SIZE) historyCount++;

    currentMP = mp;
    currentCarbTemp = carbTemp;
    currentFuelRemaining = fuelRemaining;
    currentAltitude = altitude;

    if ("startup".equals(phase) && !"startup".equals(lastPhase)) {
        startupEntryEgt = new float[4];
        for (int i = 0; i < 4; i++) {
            startupEntryEgt[i] = features[IDX_EGT1 + i];
        }
    }
    lastPhase = phase;
}
```

`reset()` sets `lastPhase = null`, so the very next line's `!"startup".equals(lastPhase)` still correctly re-latches `startupEntryEgt` on this same call if `phase` is `"startup"` — no double-tracking variable needed, this reuses the existing latch logic as-is.

- [ ] **Step 6: Build**

```bash
cd ~/flytab/.worktrees/flight-phase-detection-runtime
bash build.sh
```

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/shared/phase-detector.js tests/phase-detection/phase-detector.test.js android/app/src/main/java/app/flywhere/flytab/engineml/EngineAdvisor.java
git commit -m "fix: reset runtime PhaseDetector and EngineAdvisor state on a new engine-start after shutdown"
```

---

## Definition of Done

- All of Tasks 1-5's automated tests pass: `npm test` (flytab) green, including the golden-parity test at ≥85% agreement against the frozen Python output.
- Task 6's model files are deployed and pass the CLAUDE.md verification checklist (dtype float32, shape `[1,60,12]`, 12 features, `quantization: FLOAT32`, 12-phase list).
- `bash build.sh` succeeds after Tasks 7-9.
- `PhaseDetector.java` is deleted; no remaining reference to it in `android/app/`.
- Both CLAUDE.md files updated (Task 11).
- Task 12's reset test passes: a `PhaseDetector` driven to `shutdown` and then a fresh engine-start recovers into `startup` rather than staying wedged.
- **Not part of this plan's automated Definition of Done, required before flying:** the on-device CDP test (Task 7/8's manual follow-up note) confirming a real `phase` value round-trips correctly through the rebuilt APK, and Dana's empirical calibration of the sticky-valve threshold (Task 9's follow-up note) before that specific advisory is trusted operationally.
