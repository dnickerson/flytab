# Code Review Followup Cleanup (Issues #128, #129, #130) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate three pieces of verbatim/near-verbatim code duplication (and one dead-code fallback) that `/code-review high 127` flagged as low-effort, non-blocking findings 4–6, filed as GitHub issues #128, #129, #130.

**Architecture:** Each task is a pure refactor with zero intended behavior change — extract one existing duplicated block to a single shared definition, point every prior call site at it, and keep every existing test passing unmodified except the one test (#130) whose assertion literally matches the string being deleted. No new features, no new UI, no new config.

**Tech Stack:** Vanilla JS (no bundler, `<script>` tag load order in `web/index.html` matters), Vitest for tests (jsdom environment, `globals: false` — every test file explicitly imports from `vitest`).

## Global Constraints

- Base branch: `main` at `a65fc1c` (PR #127 merge). All line numbers and code snippets in this plan were re-verified against `origin/main` at that commit — not the stale `feat/route-cloud-display` branch, which is 68 commits behind and has different file contents.
- Zero behavior change. Every task is a dedup/dead-code-removal — the constructed URLs, dispatched events, and timing values must be bit-for-bit identical before and after.
- `npm test` must pass after every task, with no existing test's *assertions* changed except the one in Task 3 (its regex matches a string this task deletes, so the regex itself must change to match the new source).
- Classic `<script>` tags share one global scope — no `import`/`export`. New shared files follow the existing `web/shared/altitude-utils.js` pattern: plain `function`/`const` declarations, loaded via a `<script src="...">` line in `web/index.html` positioned *before* every file that calls them.
- Vitest test files load source via `readFileSync` + `new Function(src + '\nreturn {...}')()` (see `tests/shared/altitude-utils.test.js`, `tests/shared/engine-gps-bridge.test.js`) — there is no module system, so a test for file B that now calls a function defined in new file A must concatenate both sources into the same `new Function` scope, or it'll throw `ReferenceError` at test time even though it works fine in the browser (all scripts share one global `<script>` scope there).
- Per `CLAUDE.md` Build Policy: bump `FLYTAB_VERSION` in `web/app.js` before running `bash build.sh`. Current version is `v10.29` (verified `origin/main`) — per project memory, never add a third digit after the decimal (`v10.290` is invalid), so the next version is `v10.30`.
- Per `CLAUDE.md`: this plan's tasks touch `web/shared/`, `web/cockpit/` — none of them touch `web/shared/planning/`, so the "run `npm test` before building" extra gate doesn't add new scope beyond the normal test run already required above.

---

### Task 1: Shared `EngineClient.baseUrl()` helper (issue #128)

**Files:**
- Modify: `web/shared/engine-client.js:57` (insert static method after the `piContractOld` getter, before `connect()`)
- Modify: `web/cockpit/fuel-overlay.js:696-700` (`_engineBaseUrl()` body)
- Modify: `web/cockpit/engine-page.js:1066-1070` (`_engineBaseUrl()` body, including the now-stale comment above it)
- Test: `tests/shared/engine-client.test.js` (add a describe block for the new static method)
- No changes needed to `tests/cockpit/fuel-overlay-engine-base-url.test.js` or `tests/cockpit/engine-page-flight-data.test.js` (lines 206-215) — they test the public `_engineBaseUrl()` instance methods, whose behavior does not change.

**Interfaces:**
- Produces: `EngineClient.baseUrl()` — static method, no arguments, returns `` `http://${ip}:8080` `` when `window.engineClient?.ip` is set, else `null`. Callable as soon as `engine-client.js` has loaded (it's a static method, not an instance call — no `EngineClient` instance needs to exist).
- Consumes (Task's own): `window.engineClient?.ip` (assigned synchronously at `app.js:518`, per the existing comments in both call sites).

- [ ] **Step 1: Write the failing test for the new static method**

Add to `tests/shared/engine-client.test.js`, after the existing `describe` blocks (the file already defines `EngineClient` via `new Function` at the top — reuse that binding):

```javascript
describe('EngineClient.baseUrl (static, issue #128)', () => {
    afterEach(() => { delete window.engineClient; });

    it('returns null, not a guessed IP, when window.engineClient is unavailable', () => {
        delete window.engineClient;
        expect(EngineClient.baseUrl()).toBeNull();
    });

    it('builds the URL from window.engineClient.ip when available', () => {
        window.engineClient = { ip: '192.168.1.50' };
        expect(EngineClient.baseUrl()).toBe('http://192.168.1.50:8080');
    });
});
```

Check the top of `tests/shared/engine-client.test.js` — if `afterEach` is not already imported from `'vitest'` in its top-line `import { ... } from 'vitest'`, add it there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/engine-client.test.js -t "EngineClient.baseUrl"`
Expected: FAIL — `EngineClient.baseUrl is not a function`.

- [ ] **Step 3: Add the static method to `EngineClient`**

In `web/shared/engine-client.js`, insert immediately after the `piContractOld` getter (the block ending at line 57, `}`) and before `connect() {` (line 59):

```javascript

    /** Pi engine-monitor base URL built from window.engineClient.ip, or null
     *  if unavailable. window.engineClient is assigned synchronously at
     *  app.js:518, before any UI that calls this can construct — a missing
     *  ip here means something is genuinely wrong, so this returns null
     *  rather than guessing a fallback IP. Single source for what was two
     *  verbatim copies (fuel-overlay.js, engine-page.js — issue #128). */
    static baseUrl() {
        const ip = window.engineClient?.ip;
        return ip ? `http://${ip}:8080` : null;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/engine-client.test.js -t "EngineClient.baseUrl"`
Expected: PASS (2 tests).

- [ ] **Step 5: Point `fuel-overlay.js` at the shared helper**

In `web/cockpit/fuel-overlay.js`, replace lines 696-700:

```javascript
    _engineBaseUrl() {
        // No fallback IP: window.engineClient is assigned at app.js:518, before
        // FuelOverlay can be constructed or shown, so a missing ip here means
        // something is genuinely wrong — guessing an address is worse than skipping.
        const ip = window.engineClient?.ip;
        return ip ? `http://${ip}:8080` : null;
    }
```

with:

```javascript
    _engineBaseUrl() {
        return EngineClient.baseUrl();
    }
```

Leave `_syncFuelSetToEngine` / `_syncFuelAddToEngine` (their `if (!base) { console.warn(...); return; }` null-handling) untouched — only the body of `_engineBaseUrl()` changes.

- [ ] **Step 6: Point `engine-page.js` at the shared helper**

In `web/cockpit/engine-page.js`, replace lines 1063-1070 (the comment block plus the method body):

```javascript
    // No fallback IP: window.engineClient is assigned at app.js:518, before
    // this page can be constructed or shown, so a missing ip here means
    // something is genuinely wrong — guessing an address is worse than
    // skipping. Matches fuel-overlay.js's _engineBaseUrl() (same fix, #Finding 7b).
    _engineBaseUrl() {
        const ip = window.engineClient?.ip;
        return ip ? `http://${ip}:8080` : null;
    }
```

with:

```javascript
    // Shared with fuel-overlay.js via EngineClient.baseUrl() (issue #128) —
    // do not reintroduce a per-file copy of this logic.
    _engineBaseUrl() {
        return EngineClient.baseUrl();
    }
```

Leave `_stopCapture()`'s `if (!base) throw new Error(...)` and `_setAtis()`'s `if (!base) { this._atisStatusError(...); return; }` untouched — only the body of `_engineBaseUrl()` changes.

- [ ] **Step 7: Run the full existing test suites for both call sites plus the new test, to confirm no behavior change**

Run: `npx vitest run tests/shared/engine-client.test.js tests/cockpit/fuel-overlay-engine-base-url.test.js tests/cockpit/engine-page-flight-data.test.js`
Expected: PASS, all tests — the two pre-existing files pin the exact same `null` / `http://<ip>:8080` behavior this task preserves.

- [ ] **Step 8: Confirm script load order still puts `engine-client.js` before both callers**

Run: `grep -n 'shared/engine-client.js\|cockpit/fuel-overlay.js\|cockpit/engine-page.js' web/index.html`
Expected: `shared/engine-client.js` at line 75, `cockpit/engine-page.js` at line 114, `cockpit/fuel-overlay.js` at line 115 — `engine-client.js` already loads first, no `index.html` change needed for this task. (If line numbers differ because an earlier task in this plan already edited `index.html`, confirm the relative order instead: `engine-client.js` before both.)

- [ ] **Step 9: Commit**

```bash
git add web/shared/engine-client.js web/cockpit/fuel-overlay.js web/cockpit/engine-page.js tests/shared/engine-client.test.js
git commit -m "fix(engine): dedupe _engineBaseUrl() into EngineClient.baseUrl() (#128)"
```

---

### Task 2: Shared GPS staleness-degrade helper (issue #129)

**Files:**
- Create: `web/shared/gps-staleness.js`
- Modify: `web/index.html` (add one `<script>` line)
- Modify: `web/shared/gps-source.js:234-247` (`_resetStaleTimer()` body)
- Modify: `web/shared/engine-gps-bridge.js` (`_degradeSituation()` and `_resetStaleTimer()` bodies)
- Modify: `tests/shared/engine-gps-bridge.test.js` (source-loading block, to pull in the new shared file)
- Test: `tests/shared/gps-staleness.test.js` (new)

**Interfaces:**
- Produces: `GPS_STALE_TIMEOUT_MS` (const, `15000`) and `degradeGpsSituation(stratuxTarget)` (function — reads `stratuxTarget.situation`, no-ops if falsy, else sets `stratuxTarget.situation = {...lastSit, gps_fix_quality: 0}` and dispatches `new CustomEvent('stratux:situation', { detail: staleSit })` on `stratuxTarget`). Both are plain global declarations (no `window.` prefix needed — matches `altitude-utils.js`'s convention), available to any script loaded after `gps-staleness.js`.
- Consumes (Task's own): none beyond native `CustomEvent`/`EventTarget`, already used identically at both existing call sites.

- [ ] **Step 1: Write the failing test for the new shared module**

Create `tests/shared/gps-staleness.test.js`:

```javascript
/**
 * Shared degrade-and-dispatch logic pulled out of gps-source.js and
 * engine-gps-bridge.js, which had hand-copied the same 15s staleness
 * watchdog shape (issue #129).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

if (typeof global.CustomEvent === 'undefined') {
    global.CustomEvent = class CustomEvent extends Event {
        constructor(t, o) { super(t); this.detail = o?.detail; }
    };
}

const src = readFileSync('web/shared/gps-staleness.js', 'utf8');
const { degradeGpsSituation, GPS_STALE_TIMEOUT_MS } = new Function(
    `${src}\nreturn { degradeGpsSituation, GPS_STALE_TIMEOUT_MS };`
)();

function makeTarget(initialSituation) {
    const target = new EventTarget();
    target.situation = initialSituation;
    return target;
}

describe('GPS_STALE_TIMEOUT_MS', () => {
    it('is 15000 — the 15s watchdog both gps-source.js and engine-gps-bridge.js document', () => {
        expect(GPS_STALE_TIMEOUT_MS).toBe(15000);
    });
});

describe('degradeGpsSituation', () => {
    it('is a no-op when there is no prior situation', () => {
        const target = makeTarget(null);
        const events = [];
        target.addEventListener('stratux:situation', e => events.push(e.detail));
        degradeGpsSituation(target);
        expect(target.situation).toBeNull();
        expect(events).toHaveLength(0);
    });

    it('sets gps_fix_quality to 0, preserves other fields, and dispatches stratux:situation', () => {
        const target = makeTarget({ lat: 35.1, lon: -80.2, gps_fix_quality: 1 });
        const events = [];
        target.addEventListener('stratux:situation', e => events.push(e.detail));
        degradeGpsSituation(target);
        expect(target.situation.gps_fix_quality).toBe(0);
        expect(target.situation.lat).toBe(35.1);
        expect(target.situation.lon).toBe(-80.2);
        expect(events).toHaveLength(1);
        expect(events[0]).toBe(target.situation);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/gps-staleness.test.js`
Expected: FAIL — `web/shared/gps-staleness.js` does not exist (`ENOENT`).

- [ ] **Step 3: Create the shared module**

Create `web/shared/gps-staleness.js`:

```javascript
/**
 * Shared staleness-watchdog degrade logic for GPS position sources.
 * gps-source.js (internal/device GPS) and engine-gps-bridge.js (engine-GPS
 * fallback) both dim the ownship marker the same way when their respective
 * position feed goes stale — this is the one place that shape is defined
 * (issue #129; previously two independently hand-copied implementations).
 */

const GPS_STALE_TIMEOUT_MS = 15000;

/**
 * Degrade stratuxTarget.situation to zero fix quality and dispatch
 * 'stratux:situation' with it. No-op if there's no prior situation to degrade.
 */
function degradeGpsSituation(stratuxTarget) {
    const lastSit = stratuxTarget.situation;
    if (!lastSit) return;
    const staleSit = { ...lastSit, gps_fix_quality: 0 };
    stratuxTarget.situation = staleSit;
    stratuxTarget.dispatchEvent(new CustomEvent('stratux:situation', { detail: staleSit }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/gps-staleness.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Load the new script before its two consumers**

In `web/index.html`, the current relevant lines are:

```html
    <script src="./shared/engine-client.js"></script>
    <script src="./shared/engine-gps-bridge.js"></script>
    <script src="./shared/gps-source.js"></script>
```

Insert the new script between the first two lines:

```html
    <script src="./shared/engine-client.js"></script>
    <script src="./shared/gps-staleness.js"></script>
    <script src="./shared/engine-gps-bridge.js"></script>
    <script src="./shared/gps-source.js"></script>
```

- [ ] **Step 6: Point `gps-source.js` at the shared helper**

In `web/shared/gps-source.js`, replace the body of `_resetStaleTimer()` (lines 234-247):

```javascript
    /** Reset the staleness watchdog — if no fix arrives within 15s, dim the marker */
    _resetStaleTimer() {
        if (this._staleTimer) clearTimeout(this._staleTimer);
        this._staleTimer = setTimeout(() => {
            if (this._source !== 'internal') return;
            if (typeof DiagLog !== 'undefined') DiagLog.log('gps', 'Internal GPS stale — no fix for 15s');
            // Dispatch a zero-quality situation so the map dims the ownship marker
            const lastSit = this._stratux.situation;
            if (lastSit) {
                const staleSit = { ...lastSit, gps_fix_quality: 0 };
                this._stratux.situation = staleSit;
                this._stratux.dispatchEvent(new CustomEvent('stratux:situation', { detail: staleSit }));
            }
        }, 15000);
    }
```

with:

```javascript
    /** Reset the staleness watchdog — if no fix arrives within 15s, dim the marker.
     *  Degrade logic shared with engine-gps-bridge.js via gps-staleness.js (issue #129). */
    _resetStaleTimer() {
        if (this._staleTimer) clearTimeout(this._staleTimer);
        this._staleTimer = setTimeout(() => {
            if (this._source !== 'internal') return;
            if (typeof DiagLog !== 'undefined') DiagLog.log('gps', 'Internal GPS stale — no fix for 15s');
            degradeGpsSituation(this._stratux);
        }, GPS_STALE_TIMEOUT_MS);
    }
```

- [ ] **Step 7: Point `engine-gps-bridge.js` at the shared helper**

In `web/shared/engine-gps-bridge.js`, replace the `_degradeSituation()` method body:

```javascript
    /** Degrade the last-written situation to zero fix quality and dispatch it —
     * mirrors gps-source.js's _resetStaleTimer() degradation logic. */
    _degradeSituation() {
        const lastSit = this._stratux.situation;
        if (!lastSit) return;
        const staleSit = { ...lastSit, gps_fix_quality: 0 };
        this._stratux.situation = staleSit;
        this._stratux.dispatchEvent(new CustomEvent('stratux:situation', { detail: staleSit }));
    }
```

with:

```javascript
    /** Degrade the last-written situation to zero fix quality and dispatch it.
     * Shared with gps-source.js via gps-staleness.js (issue #129). */
    _degradeSituation() {
        degradeGpsSituation(this._stratux);
    }
```

And replace the `_resetStaleTimer()` method body:

```javascript
    /** Reset the 15s staleness watchdog — mirrors gps-source.js's _resetStaleTimer(). */
    _resetStaleTimer() {
        if (this._staleTimer) clearTimeout(this._staleTimer);
        this._staleTimer = setTimeout(() => {
            if (!this._active) return;
            if (typeof DiagLog !== 'undefined')
                DiagLog.log('gps', 'Engine GPS bridge stale — no engine data for 15s');
            this._degradeSituation();
            this._active = false;
        }, 15000);
    }
```

with (only the `15000` → `GPS_STALE_TIMEOUT_MS` change and comment update):

```javascript
    /** Reset the 15s staleness watchdog. Timeout shared with gps-source.js via gps-staleness.js (issue #129). */
    _resetStaleTimer() {
        if (this._staleTimer) clearTimeout(this._staleTimer);
        this._staleTimer = setTimeout(() => {
            if (!this._active) return;
            if (typeof DiagLog !== 'undefined')
                DiagLog.log('gps', 'Engine GPS bridge stale — no engine data for 15s');
            this._degradeSituation();
            this._active = false;
        }, GPS_STALE_TIMEOUT_MS);
    }
```

- [ ] **Step 8: Update `tests/shared/engine-gps-bridge.test.js` to load the new shared module in the same scope**

This test file loads `engine-gps-bridge.js` in isolation via `new Function`. Now that `_degradeSituation`/`_resetStaleTimer` call the global `degradeGpsSituation`/`GPS_STALE_TIMEOUT_MS`, the test must provide them in the same function scope (classic `<script>` tags share scope in the browser; `new Function` does not, unless sources are concatenated).

Find the current source-loading lines near the top of the file:

```javascript
const src = readFileSync('web/shared/engine-gps-bridge.js', 'utf8');
const EngineGpsBridge = new Function(`${src}\nreturn EngineGpsBridge;`)();
```

Replace with:

```javascript
const staleSrc = readFileSync('web/shared/gps-staleness.js', 'utf8');
const src = readFileSync('web/shared/engine-gps-bridge.js', 'utf8');
const EngineGpsBridge = new Function(`${staleSrc}\n${src}\nreturn EngineGpsBridge;`)();
```

Do not change any assertions in this file — the existing `vi.advanceTimersByTime(15000)` calls stay `15000` (a literal, matching `GPS_STALE_TIMEOUT_MS`'s value); they test observed behavior, not the constant's name.

- [ ] **Step 9: Run the full existing test suite for this area, plus the new test, to confirm no behavior change**

Run: `npx vitest run tests/shared/gps-staleness.test.js tests/shared/engine-gps-bridge.test.js`
Expected: PASS, all tests in both files — in particular the pre-existing "degrades via the 15s watchdog when engine:data stops firing entirely" and "watchdog does not fire after stop() clears the timer" tests, which exercise exactly the code this task changed.

- [ ] **Step 10: Commit**

```bash
git add web/shared/gps-staleness.js web/index.html web/shared/gps-source.js web/shared/engine-gps-bridge.js tests/shared/engine-gps-bridge.test.js tests/shared/gps-staleness.test.js
git commit -m "fix(gps): dedupe staleness-degrade logic into gps-staleness.js (#129)"
```

---

### Task 3: Drop the dead `|| '192.168.10.1'` fallback (issue #130)

**Files:**
- Modify: `web/shared/network-mode.js:49`
- Modify: `web/cockpit/device-status.js:116`
- Test: `tests/shared/network-mode-stratux-ip.test.js` (update both regex assertions — they currently match the exact string this task deletes)

**Interfaces:**
- Consumes: `Settings.stratuxIp` (getter, `web/shared/settings.js:40`) — already guaranteed non-falsy by `Settings.get()`'s own `DEFAULTS` fallback (`web/shared/settings.js:30-34`, `DEFAULTS.stratux_ip = '192.168.10.1'`). No new interface produced — this task only removes an unreachable branch.

- [ ] **Step 1: Update the (currently passing) test to assert the fallback is gone — this makes it fail first**

In `tests/shared/network-mode-stratux-ip.test.js`, both `it` blocks currently assert:

```javascript
    it('network-mode.js builds the probe URL from Settings.stratuxIp', () => {
        const src = read('web/shared/network-mode.js');
        expect(src).toMatch(/fetch\(`http:\/\/\$\{Settings\.stratuxIp \|\| '192\.168\.10\.1'\}\/getStatus`/);
    });

    it('device-status.js builds the probe URL from Settings.stratuxIp', () => {
        const src = read('web/cockpit/device-status.js');
        expect(src).toMatch(/fetch\(`http:\/\/\$\{Settings\.stratuxIp \|\| '192\.168\.10\.1'\}\/getStatus`/);
    });
```

Change both regexes to match the URL *without* the fallback:

```javascript
    it('network-mode.js builds the probe URL from Settings.stratuxIp, with no redundant hardcoded-IP fallback', () => {
        const src = read('web/shared/network-mode.js');
        expect(src).toMatch(/fetch\(`http:\/\/\$\{Settings\.stratuxIp\}\/getStatus`/);
        expect(src).not.toMatch(/Settings\.stratuxIp \|\| '192\.168\.10\.1'/);
    });

    it('device-status.js builds the probe URL from Settings.stratuxIp, with no redundant hardcoded-IP fallback', () => {
        const src = read('web/cockpit/device-status.js');
        expect(src).toMatch(/fetch\(`http:\/\/\$\{Settings\.stratuxIp\}\/getStatus`/);
        expect(src).not.toMatch(/Settings\.stratuxIp \|\| '192\.168\.10\.1'/);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/network-mode-stratux-ip.test.js`
Expected: FAIL — both `toMatch` assertions fail (the source still has the `|| '192.168.10.1'` fallback, which the first regex no longer matches).

- [ ] **Step 3: Remove the fallback in `network-mode.js`**

In `web/shared/network-mode.js:49`, change:

```javascript
            const r = await fetch(`http://${Settings.stratuxIp || '192.168.10.1'}/getStatus`, {
```

to:

```javascript
            const r = await fetch(`http://${Settings.stratuxIp}/getStatus`, {
```

- [ ] **Step 4: Remove the fallback in `device-status.js`**

In `web/cockpit/device-status.js:116`, change:

```javascript
            const r = await fetch(`http://${Settings.stratuxIp || '192.168.10.1'}/getStatus`, {
```

to:

```javascript
            const r = await fetch(`http://${Settings.stratuxIp}/getStatus`, {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/shared/network-mode-stratux-ip.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add web/shared/network-mode.js web/cockpit/device-status.js tests/shared/network-mode-stratux-ip.test.js
git commit -m "fix(network): drop unreachable hardcoded-IP fallback, Settings.get() already defaults it (#130)"
```

---

### Task 4: Version bump and build

**Files:**
- Modify: `web/app.js:6` (`FLYTAB_VERSION`)

**Interfaces:**
- Consumes: nothing from Tasks 1-3 beyond "they're done and tests pass."
- Produces: nothing further downstream — this is the plan's final task.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, every file — including the 3 new/modified test files from Tasks 1-3, with no regressions elsewhere.

- [ ] **Step 2: Bump `FLYTAB_VERSION`**

In `web/app.js:6`, change:

```javascript
const FLYTAB_VERSION = 'v10.29';
```

to:

```javascript
const FLYTAB_VERSION = 'v10.30';
```

(Not `v10.291` or similar — per project convention, versions never carry a third digit after the decimal.)

- [ ] **Step 3: Commit the version bump**

```bash
git add web/app.js
git commit -m "chore(app): bump FLYTAB_VERSION to v10.30 for the followup-cleanup branch"
```

- [ ] **Step 4: Build**

Run: `bash build.sh`
Expected: build succeeds, APK copied to `data/`, `versionCode`/`versionName` in `android/app/build.gradle` reflect `v10.30` → `1030`.

