# Cockpit Systems Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. auto accept worktree and git changes


**Goal:** Provide an actionable pre-flight health check of every in-cockpit data source — Stratux, engine monitor, GPS, and FIS-B weather — rendered inline in the Before Start checklist, with causes and suggestions when something is wrong.

**Architecture:** A new `SystemsMonitor` class passively listens to events from existing clients, maintains a live status map with cause/suggestions, and emits `'systems:changed'` on `document`. The Before Start checklist gains a `systems_check` item type that renders a live status table from `systemsMonitor.getStatus()`. The existing 5-second polling loop in `_startDeviceStatusMonitor()` is replaced by `systems:changed` event handlers. `EngineClient` is fixed to read `Settings.piIp` instead of hardcoding its IP.

**Tech Stack:** Vanilla JS, vitest (test), `EventTarget` events from StratuxClient/EngineClient/GpsSource/FisbClient, `document` custom events.

---

## File Map

| File | Change |
|---|---|
| `web/shared/systems-monitor.js` | New file — passive aggregator, emits `systems:changed` |
| `web/shared/engine-client.js` | Constructor reads `Settings.piIp ?? '192.168.10.1'` |
| `web/cockpit/checklist.js` | Accept `systemsMonitor` in constructor; render `systems_check` item type |
| `web/checklist.json` | Add `{ "title": "Systems Check", "type": "systems_check" }` after "Tailscale" |
| `web/app.js` | Instantiate SystemsMonitor after clients; replace `_startDeviceStatusMonitor` polling; pass monitor to checklist; replace DiagLog summary with `getStatus()` |
| `web/index.html` | Add `<script src="./shared/systems-monitor.js">` after `fisb-client.js`, before cockpit components |
| `tests/cockpit/systems-monitor.test.js` | New test file — status transitions, null IP, chain logic |

---

## Task 1: SystemsMonitor — skeleton and status shape

**Files:**
- Create: `web/shared/systems-monitor.js`
- Create: `tests/cockpit/systems-monitor.test.js`

- [ ] **Step 1.1: Write failing test — getStatus() default shape**

```javascript
// tests/cockpit/systems-monitor.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Minimal stubs ──────────────────────────────────────────────────────────
// SystemsMonitor reads Settings directly. Provide a module-level stub.
vi.stubGlobal('Settings', {
    stratuxIp: '192.168.10.1',
    piIp:      '192.168.10.1',
    get:       (k) => k === 'gps_source' ? 'auto' : null,
});

// Minimal EventTarget-based stubs
function makeClient() {
    const c = new EventTarget();
    c.connected = false;
    c._useHttpFallback = false;
    return c;
}

function makeMonitor(overrides = {}) {
    const stratux  = overrides.stratux  ?? makeClient();
    const engine   = overrides.engine   ?? makeClient();
    const gps      = overrides.gps      ?? makeClient();
    const fisb     = overrides.fisb     ?? makeClient();
    return new SystemsMonitor(stratux, engine, gps, fisb);
}

// Load the module under test — it is a plain class (no import/export),
// evaluated against the global stubs above.
const src = await import('fs').then(fs =>
    fs.readFileSync(new URL('../../web/shared/systems-monitor.js', import.meta.url), 'utf8'));
eval(src);

describe('SystemsMonitor — initial state', () => {
    it('getStatus() returns four keys each with status unknown', () => {
        const m = makeMonitor();
        const s = m.getStatus();
        expect(Object.keys(s)).toEqual(['stratux', 'engine', 'gps', 'weather']);
        for (const key of ['stratux', 'engine', 'gps', 'weather']) {
            expect(s[key].status).toBe('unknown');
            expect(s[key].cause).toBeNull();
            expect(Array.isArray(s[key].suggestions)).toBe(true);
        }
    });
});
```

- [ ] **Step 1.2: Run test — verify FAIL**

```bash
npm test tests/cockpit/systems-monitor.test.js
```

Expected: `ReferenceError: SystemsMonitor is not defined` (file doesn't exist yet).

- [ ] **Step 1.3: Create SystemsMonitor skeleton**

```javascript
// web/shared/systems-monitor.js
/**
 * SystemsMonitor — passive aggregator of in-cockpit data source health.
 * Listens to events from StratuxClient, EngineClient, GpsSource, FisbClient.
 * Emits 'systems:changed' on document when any status changes.
 * Replaces the 5s polling loop in _startDeviceStatusMonitor().
 */
class SystemsMonitor {
    constructor(stratuxClient, engineClient, gpsSource, fisbClient) {
        this._stratux  = stratuxClient;
        this._engine   = engineClient;
        this._gps      = gpsSource;
        this._fisb     = fisbClient;   // may be null

        this._status = {
            stratux: { status: 'unknown', cause: null, suggestions: [] },
            engine:  { status: 'unknown', cause: null, suggestions: [] },
            gps:     { status: 'unknown', cause: null, suggestions: [] },
            weather: { status: 'unknown', cause: null, suggestions: [] },
        };

        this._startTime      = 0;
        this._stratuxConnectedAt = 0;
        this._stratuxSituationAt = 0;
        this._engineConnectedAt  = 0;
        this._engineDataAt       = 0;
        this._gpsFix             = false;
        this._fisbFrame          = false;
        this._listeners          = [];
    }

    getStatus() {
        // Return deep copy so callers cannot mutate internal state
        return {
            stratux: { ...this._status.stratux, suggestions: [...this._status.stratux.suggestions] },
            engine:  { ...this._status.engine,  suggestions: [...this._status.engine.suggestions]  },
            gps:     { ...this._status.gps,     suggestions: [...this._status.gps.suggestions]     },
            weather: { ...this._status.weather, suggestions: [...this._status.weather.suggestions] },
        };
    }

    start() {
        this._startTime = Date.now();
        this._attachListeners();
        this._evalStratux();
    }

    stop() {
        for (const { target, type, fn } of this._listeners) {
            target.removeEventListener(type, fn);
        }
        this._listeners = [];
    }

    // ── internals ──────────────────────────────────────────────────────────

    _on(target, type, fn) {
        target.addEventListener(type, fn);
        this._listeners.push({ target, type, fn });
    }

    _attachListeners() {
        if (this._stratux) {
            this._on(this._stratux, 'stratux:connect',    () => this._onStratuxConnect());
            this._on(this._stratux, 'stratux:disconnect', () => this._onStratuxDisconnect());
            this._on(this._stratux, 'stratux:stale',      () => this._onStratuxStale());
            this._on(this._stratux, 'stratux:situation',  () => { this._stratuxSituationAt = Date.now(); this._evalStratux(); });
        }
        if (this._engine) {
            this._on(this._engine, 'engine:connect',    () => this._onEngineConnect());
            this._on(this._engine, 'engine:disconnect', () => this._onEngineDisconnect());
            this._on(this._engine, 'engine:stale',      (e) => this._onEngineStale(e));
            this._on(this._engine, 'engine:data',       () => { this._engineDataAt = Date.now(); this._evalEngine(); });
        }
        if (this._gps) {
            this._on(this._gps._stratux ?? this._gps, 'gpssource:changed', () => this._onGpsChanged());
        }
        if (this._fisb) {
            this._on(this._fisb, 'fisb:metar', () => this._onFisbFrame());
            this._on(this._fisb, 'fisb:winds', () => this._onFisbFrame());
        }
    }

    _set(key, status, cause, suggestions) {
        const prev = this._status[key];
        if (prev.status === status && prev.cause === cause) return;
        this._status[key] = { status, cause: cause ?? null, suggestions: suggestions ?? [] };
        document.dispatchEvent(new CustomEvent('systems:changed', { detail: this.getStatus() }));
    }

    // ── Stratux ──────────────────────────────────────────────────────────

    _onStratuxConnect() {
        this._stratuxConnectedAt = Date.now();
        this._evalStratux();
    }
    _onStratuxDisconnect() {
        this._stratuxConnectedAt = 0;
        this._stratuxSituationAt = 0;
        this._evalStratux();
    }
    _onStratuxStale() {
        this._evalStratux();
    }

    _evalStratux() {
        const ip = Settings.stratuxIp;
        if (!ip) {
            this._set('stratux', 'degraded',
                'Stratux IP was cleared from Settings',
                ['Open Settings and verify Stratux IP is set to 192.168.10.1.']);
            this._evalGps();
            this._evalWeather();
            return;
        }

        const elapsed = Date.now() - this._startTime;
        const connected = this._stratux?.connected;

        if (!connected) {
            if (elapsed < 15000) {
                this._set('stratux', 'unknown', null, []);
            } else {
                this._set('stratux', 'degraded',
                    `Stratux not reachable at ${ip}`,
                    [
                        'Disable ExpressVPN and Tailscale — both can block Stratux.',
                        'Verify tablet WiFi is connected to the Stratux network.',
                        'Check Stratux has power — blue and green LEDs.',
                    ]);
            }
            this._evalGps();
            this._evalWeather();
            return;
        }

        // Connected — check for situation data
        if (!this._stratuxSituationAt) {
            const connectedElapsed = Date.now() - (this._stratuxConnectedAt || this._startTime);
            if (connectedElapsed < 30000) {
                this._set('stratux', 'unknown', null, []);
            } else {
                this._set('stratux', 'degraded',
                    'Stratux connected — waiting for GPS lock',
                    ['Normal on first power-up. Wait 2–3 minutes outdoors.']);
            }
        } else {
            this._set('stratux', 'ok', null, []);
        }

        this._evalGps();
        this._evalWeather();
    }

    // ── Engine ──────────────────────────────────────────────────────────

    _onEngineConnect() {
        this._engineConnectedAt = Date.now();
        this._evalEngine();
    }
    _onEngineDisconnect() {
        this._engineConnectedAt = 0;
        this._evalEngine();
    }
    _onEngineStale(e) {
        this._evalEngine();
    }

    _evalEngine() {
        const elapsed = Date.now() - this._startTime;

        if (this._engine?._useHttpFallback) {
            this._set('engine', 'degraded',
                'Engine monitor in HTTP fallback mode',
                [
                    'Engine data is available but WebSocket is down.',
                    'Check Pi network stability or restart engine monitor.',
                ]);
            return;
        }

        if (!this._engineConnectedAt) {
            if (elapsed < 15000) {
                this._set('engine', 'unknown', null, []);
            } else {
                const ip = Settings.piIp ?? '192.168.10.1';
                this._set('engine', 'degraded',
                    `Engine monitor not reachable at ${ip}:8082`,
                    [
                        'Check Pi is powered.',
                        'Disable ExpressVPN or Tailscale — port 8082 may be blocked.',
                    ]);
            }
            return;
        }

        if (this._engineDataAt) {
            this._set('engine', 'ok', null, []);
        } else {
            // Connected but no data yet — still settling
            this._set('engine', 'unknown', null, []);
        }
    }

    // ── GPS ──────────────────────────────────────────────────────────────

    _onGpsChanged() {
        this._evalGps();
    }

    _evalGps() {
        const stratuxStatus = this._status.stratux.status;
        const configuredSource = this._gps?._configuredSource ?? Settings.get('gps_source') ?? 'auto';

        // If configured to use stratux (or auto which defaults to stratux), chain to Stratux status
        if (configuredSource !== 'internal' && stratuxStatus === 'degraded') {
            this._set('gps', 'degraded',
                'GPS source is Stratux — unavailable until Stratux connects',
                ['Fix Stratux first, or switch GPS source to Internal in Settings.']);
            return;
        }

        const sit = this._stratux?.situation;
        const fixQuality = sit?.gps_fix_quality ?? 0;
        const hasFix = fixQuality >= 1;

        if (hasFix) {
            this._gpsFix = true;
            this._set('gps', 'ok', null, []);
            return;
        }

        if (configuredSource === 'internal') {
            const elapsed = Date.now() - this._startTime;
            if (elapsed < 30000) {
                this._set('gps', 'unknown', null, []);
            } else {
                this._set('gps', 'degraded',
                    'Device GPS has not acquired a fix',
                    [
                        'Move to open sky.',
                        'GPS lock may take 1–2 minutes.',
                    ]);
            }
            return;
        }

        this._set('gps', 'unknown', null, []);
    }

    // ── FIS-B Weather ────────────────────────────────────────────────────

    _onFisbFrame() {
        this._fisbFrame = true;
        this._evalWeather();
    }

    _evalWeather() {
        const stratuxStatus = this._status.stratux.status;

        if (stratuxStatus === 'degraded') {
            this._set('weather', 'degraded',
                'FIS-B weather requires Stratux connection',
                ['Fix Stratux connection first.']);
            return;
        }

        if (this._fisbFrame) {
            this._set('weather', 'ok', null, []);
            return;
        }

        if (!this._stratux?.connected) {
            this._set('weather', 'unknown', null, []);
            return;
        }

        const deviceStatus = this._stratux?.deviceStatus;
        const towers = deviceStatus?.UAT_Towers ?? -1;
        const elapsed = Date.now() - (this._stratuxConnectedAt || this._startTime);

        if (towers === 0 && elapsed >= 60000) {
            this._set('weather', 'degraded',
                'No UAT towers in range',
                [
                    'FIS-B requires UAT ground stations.',
                    'Check Stratux UAT receiver — yellow LED should be lit.',
                    'Weather will become available as you approach an airport.',
                ]);
            return;
        }

        this._set('weather', 'unknown', null, []);
    }
}
```

- [ ] **Step 1.4: Run test — verify PASS**

```bash
npm test tests/cockpit/systems-monitor.test.js
```

Expected: PASS (1 test).

- [ ] **Step 1.5: Commit**

```bash
git add web/shared/systems-monitor.js tests/cockpit/systems-monitor.test.js
git commit -m "feat(systems-monitor): SystemsMonitor skeleton with status shape"
```

---

## Task 2: SystemsMonitor — Stratux status transitions

**Files:**
- Modify: `tests/cockpit/systems-monitor.test.js`
- No production change (skeleton already handles all Stratux cases)

- [ ] **Step 2.1: Add Stratux tests**

Add inside `tests/cockpit/systems-monitor.test.js` after the existing describe block:

```javascript
describe('SystemsMonitor — Stratux', () => {
    it('immediately degraded when stratuxIp is null', () => {
        Settings.stratuxIp = null;
        const m = makeMonitor();
        m.start();
        const s = m.getStatus();
        expect(s.stratux.status).toBe('degraded');
        expect(s.stratux.cause).toBe('Stratux IP was cleared from Settings');
        expect(s.stratux.suggestions).toHaveLength(1);
        Settings.stratuxIp = '192.168.10.1'; // restore
    });

    it('remains unknown during first 15s when not connected', () => {
        const m = makeMonitor();
        // _startTime just set — elapsed ~0ms
        m.start();
        expect(m.getStatus().stratux.status).toBe('unknown');
    });

    it('becomes ok when stratux:connect fires and situation arrives', () => {
        const stratux = makeClient();
        stratux.connected = false;
        stratux.situation = null;
        const m = makeMonitor({ stratux });
        m.start();

        // Simulate connect
        stratux.connected = true;
        stratux.dispatchEvent(new CustomEvent('stratux:connect'));

        // Simulate situation data arriving
        stratux.situation = { gps_fix_quality: 2, lat: 35.0, lon: -81.0 };
        stratux.dispatchEvent(new CustomEvent('stratux:situation'));

        expect(m.getStatus().stratux.status).toBe('ok');
    });

    it('emits systems:changed on document when status transitions', () => {
        const stratux = makeClient();
        stratux.connected = false;
        const m = makeMonitor({ stratux });
        m.start();

        let fired = false;
        document.addEventListener('systems:changed', () => { fired = true; }, { once: true });

        // Force degraded by clearing IP then re-evaluating
        Settings.stratuxIp = null;
        m._evalStratux();
        Settings.stratuxIp = '192.168.10.1';

        expect(fired).toBe(true);
    });
});
```

- [ ] **Step 2.2: Run test — verify PASS**

```bash
npm test tests/cockpit/systems-monitor.test.js
```

Expected: PASS (5 tests).

- [ ] **Step 2.3: Commit**

```bash
git add tests/cockpit/systems-monitor.test.js
git commit -m "test(systems-monitor): Stratux status transition coverage"
```

---

## Task 3: SystemsMonitor — Engine, GPS, Weather chain tests

**Files:**
- Modify: `tests/cockpit/systems-monitor.test.js`

- [ ] **Step 3.1: Add Engine, GPS, Weather tests**

Append to `tests/cockpit/systems-monitor.test.js`:

```javascript
describe('SystemsMonitor — Engine', () => {
    it('becomes ok when engine:connect then engine:data fires', () => {
        const engine = makeClient();
        engine.connected = false;
        engine._useHttpFallback = false;
        const m = makeMonitor({ engine });
        m.start();

        engine.connected = true;
        engine.dispatchEvent(new CustomEvent('engine:connect'));
        engine.dispatchEvent(new CustomEvent('engine:data'));

        expect(m.getStatus().engine.status).toBe('ok');
    });

    it('degraded when _useHttpFallback is true', () => {
        const engine = makeClient();
        engine.connected = true;
        engine._useHttpFallback = true;
        const m = makeMonitor({ engine });
        m.start();
        engine.dispatchEvent(new CustomEvent('engine:connect'));
        m._evalEngine();
        expect(m.getStatus().engine.status).toBe('degraded');
        expect(m.getStatus().engine.cause).toContain('HTTP fallback');
    });
});

describe('SystemsMonitor — GPS chains to Stratux', () => {
    it('gps degraded when stratux is degraded and source is auto', () => {
        Settings.stratuxIp = null; // forces Stratux degraded
        Settings.get = (k) => k === 'gps_source' ? 'auto' : null;
        const m = makeMonitor();
        m.start();
        Settings.stratuxIp = '192.168.10.1';
        Settings.get = (k) => k === 'gps_source' ? 'auto' : null;

        const s = m.getStatus();
        expect(s.gps.status).toBe('degraded');
        expect(s.gps.cause).toContain('GPS source is Stratux');
    });

    it('gps ok when fix received', () => {
        const stratux = makeClient();
        stratux.connected = true;
        stratux.situation = { gps_fix_quality: 2 };
        const m = makeMonitor({ stratux });
        m.start();
        stratux.dispatchEvent(new CustomEvent('stratux:connect'));
        stratux.dispatchEvent(new CustomEvent('stratux:situation'));
        expect(m.getStatus().gps.status).toBe('ok');
    });
});

describe('SystemsMonitor — Weather', () => {
    it('weather degraded when stratux is degraded', () => {
        Settings.stratuxIp = null;
        const m = makeMonitor();
        m.start();
        Settings.stratuxIp = '192.168.10.1';
        expect(m.getStatus().weather.status).toBe('degraded');
        expect(m.getStatus().weather.cause).toContain('Stratux connection');
    });

    it('weather ok when fisb:metar fires', () => {
        const stratux = makeClient();
        stratux.connected = true;
        const fisb = makeClient();
        const m = makeMonitor({ stratux, fisb });
        m.start();
        stratux.connected = true;
        stratux.dispatchEvent(new CustomEvent('stratux:connect'));
        stratux.situation = { gps_fix_quality: 2 };
        stratux.dispatchEvent(new CustomEvent('stratux:situation'));
        fisb.dispatchEvent(new CustomEvent('fisb:metar'));
        expect(m.getStatus().weather.status).toBe('ok');
    });

    it('null fisbClient keeps weather unknown (not crash)', () => {
        const m = makeMonitor({ fisb: null });
        m.start();
        expect(() => m.getStatus()).not.toThrow();
        expect(m.getStatus().weather.status).toBe('unknown');
    });
});
```

- [ ] **Step 3.2: Run test — verify PASS**

```bash
npm test tests/cockpit/systems-monitor.test.js
```

Expected: PASS (all tests).

- [ ] **Step 3.3: Run full suite**

```bash
npm test
```

Expected: all existing tests still pass.

- [ ] **Step 3.4: Commit**

```bash
git add tests/cockpit/systems-monitor.test.js
git commit -m "test(systems-monitor): engine, GPS, weather chain coverage"
```

---

## Task 4: EngineClient constructor fix

**Files:**
- Modify: `web/shared/engine-client.js`

- [ ] **Step 4.1: Change the constructor**

In `web/shared/engine-client.js`, line 10, change:

```javascript
    constructor(ip = '192.168.10.1', port = 8082) {
```

to:

```javascript
    constructor(ip = (typeof Settings !== 'undefined' ? (Settings.piIp ?? '192.168.10.1') : '192.168.10.1'), port = 8082) {
```

- [ ] **Step 4.2: Also update the JSDoc comment on line 3**

```javascript
 * Connects to engine monitor at ws://<Settings.piIp>:8082/
```

- [ ] **Step 4.3: Run full test suite**

```bash
npm test
```

Expected: all tests pass (engine-client has no vitest tests; change is behaviorally safe — `Settings.piIp` default is still `192.168.10.1`).

- [ ] **Step 4.4: Commit**

```bash
git add web/shared/engine-client.js
git commit -m "fix(engine-client): read Settings.piIp instead of hardcoded 192.168.10.1"
```

---

## Task 5: checklist.json — add Systems Check item

**Files:**
- Modify: `web/checklist.json`

- [ ] **Step 5.1: Add the item**

In `web/checklist.json`, in the "Before Start" checklist, after the `"Tailscale"` item (line 30), insert:

```json
                { "title": "Systems Check", "type": "systems_check" },
```

The Before Start items block should read:

```json
                { "title": "ExpressVPN", "response": "OFF" },
                { "title": "Tailscale", "response": "OFF" },
                { "title": "Systems Check", "type": "systems_check" },
                { "title": "Tablet WIFI", "response": "CONNECTED", "statusSource": "connectivity", "note": "Connect to Stratux hotspot" },
```

- [ ] **Step 5.2: Commit**

```bash
git add web/checklist.json
git commit -m "feat(checklist): add Systems Check item to Before Start"
```

---

## Task 6: checklist.js — render systems_check item type

**Files:**
- Modify: `web/cockpit/checklist.js`

- [ ] **Step 6.1: Accept systemsMonitor in constructor**

In `web/cockpit/checklist.js`, change the constructor signature and add an instance property:

```javascript
    constructor(parentEl, systemsMonitor = null) {
        this._parentEl = parentEl;
        this._systemsMonitor = systemsMonitor;
```

(All other constructor lines remain unchanged.)

- [ ] **Step 6.2: Subscribe to systems:changed in constructor**

Add after `this._buildDOM()` and before `this._load()`:

```javascript
        // Live status updates for the systems_check item
        this._onSystemsChanged = () => { if (this._visible) this._renderItems(); };
        document.addEventListener('systems:changed', this._onSystemsChanged);
```

- [ ] **Step 6.3: Add destroy() to remove the listener**

After the existing `_wire` helper (search for `_wire(el, fn)`), add:

```javascript
    destroy() {
        document.removeEventListener('systems:changed', this._onSystemsChanged);
    }
```

- [ ] **Step 6.4: Add systems_check rendering inside _renderItems()**

In `_renderItems()`, find the `cl.items.forEach((item, i) => {` loop. After the block:

```javascript
            if (item.statusSource === 'connectivity') {
                ...
            }
```

Add a branch for `systems_check` items — they render as a standalone block replacing the normal row:

```javascript
            // systems_check renders as a live status table, not a checkbox row
            if (item.type === 'systems_check') {
                html += this._renderSystemsCheckItem(item, i);
                return;
            }
```

(This `return` exits the forEach callback for this item, skipping the normal row HTML.)

- [ ] **Step 6.5: Add _renderSystemsCheckItem() method**

Add after `_renderItems()`:

```javascript
    _renderSystemsCheckItem(item, idx) {
        const s = this._systemsMonitor ? this._systemsMonitor.getStatus() : null;
        if (!s) {
            return `<div class="checklist-item info-item" data-idx="${idx}">
                <div class="checklist-item-main">
                    <span class="checklist-item-title">${this._esc(item.title)}</span>
                    <span class="checklist-item-dots"></span>
                    <span class="checklist-item-response" style="color:var(--text-muted)">Unavailable</span>
                </div>
            </div>`;
        }

        const DOT_OK      = '<span style="color:var(--status-ok);font-size:18px;line-height:1;">●</span>';
        const DOT_UNKNOWN = '<span style="color:var(--status-warn,#f59e0b);font-size:18px;line-height:1;">●</span>';
        const DOT_BAD     = '<span style="color:var(--status-danger);font-size:18px;line-height:1;">●</span>';

        const dot = (status) =>
            status === 'ok' ? DOT_OK : status === 'unknown' ? DOT_UNKNOWN : DOT_BAD;

        const sources = [
            { key: 'stratux', label: 'Stratux',   desc: 'Traffic and ADS-B' },
            { key: 'engine',  label: 'Engine',    desc: 'Engine monitor' },
            { key: 'gps',     label: 'GPS',       desc: 'Position' },
            { key: 'weather', label: 'FIS-B Wx',  desc: 'FIS-B weather' },
        ];

        let issueCount = 0;
        let rows = '';
        for (const src of sources) {
            const item = s[src.key];
            if (item.status === 'degraded') issueCount++;
            const causeText = item.cause ? this._esc(item.cause) : `${src.desc} — OK`;
            const causeColor = item.status === 'ok'
                ? 'color:var(--text-secondary)'
                : item.status === 'unknown'
                    ? 'color:var(--text-muted)'
                    : 'color:var(--text-primary);font-weight:600';

            let sugRows = '';
            if (item.suggestions?.length) {
                sugRows = item.suggestions.map(s =>
                    `<div style="padding-left:88px;font-size:13px;color:var(--text-secondary);line-height:1.5;">· ${this._esc(s)}</div>`
                ).join('');
            }

            rows += `<div style="display:flex;align-items:baseline;padding:4px 0;gap:8px;">
                ${dot(item.status)}
                <span style="font-size:15px;font-weight:600;min-width:72px;">${this._esc(src.label)}</span>
                <span style="font-size:14px;${causeColor}">${causeText}</span>
            </div>${sugRows}`;
        }

        const summary = issueCount === 0
            ? `<div style="padding:6px 0 0;font-size:14px;color:var(--status-ok);font-weight:600;">All systems nominal</div>`
            : `<div style="padding:6px 0 0;font-size:14px;color:var(--status-danger);font-weight:600;">${issueCount} issue${issueCount > 1 ? 's' : ''} — review before departure</div>`;

        return `<div class="checklist-item info-item" data-idx="${idx}" style="flex-direction:column;align-items:stretch;">
            <div class="checklist-item-main" style="cursor:default;">
                <span class="checklist-item-title" style="font-weight:700;">${this._esc(item.title)}</span>
            </div>
            <div style="padding:4px 12px 8px;">
                ${rows}
                ${summary}
            </div>
        </div>`;
    }
```

- [ ] **Step 6.6: Run test suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6.7: Commit**

```bash
git add web/cockpit/checklist.js
git commit -m "feat(checklist): render systems_check item with live status table"
```

---

## Task 7: app.js — wire SystemsMonitor, replace polling, update DiagLog

**Files:**
- Modify: `web/app.js`

- [ ] **Step 7.1: Instantiate SystemsMonitor after clients are ready**

In `app.js`, find the `_startDeviceStatusMonitor()` call (line 187):

```javascript
        this._startDeviceStatusMonitor();
```

Replace it with:

```javascript
        this._startDeviceStatusMonitor();  // will be removed in next step
```

Then find where `fisbClient` is assigned (line 649, inside the NASR-ready callback):

```javascript
            this.fisbClient = new FisbClient(this.stratuxClient, nasrDb);
            this.fisbClient.start();
```

After `this.fisbClient.start()`, add:

```javascript
            // Instantiate and start SystemsMonitor once fisbClient is ready
            if (typeof SystemsMonitor !== 'undefined') {
                this.systemsMonitor = new SystemsMonitor(
                    this.stratuxClient,
                    this.engineClient,
                    this.gpsSource,
                    this.fisbClient,
                );
                this.systemsMonitor.start();
            }
```

- [ ] **Step 7.2: Replace _startDeviceStatusMonitor() polling with event-driven updates**

Replace the entire `_startDeviceStatusMonitor()` method (lines 1488–1544) with:

```javascript
    _startDeviceStatusMonitor() {
        // Update status bar badges from systems:changed events.
        // SystemsMonitor fires this whenever any source status changes.
        document.addEventListener('systems:changed', () => this._updateStatusBadges());
        // Also run once at startup (SystemsMonitor not yet started when this is called,
        // so read clients directly the first time)
        this._updateStatusBadges();
        // Fallback poll: 5s in case SystemsMonitor hasn't started yet (e.g. NASR slow)
        this._deviceStatusInterval = setInterval(() => this._updateStatusBadges(), 5000);
    }

    _updateStatusBadges() {
        const connected = this.stratuxClient?.connected;
        const stale = this.stratuxClient?.stale;
        const sit = (connected && !stale) ? this.stratuxClient?.situation : null;
        const status = connected ? this.stratuxClient?.deviceStatus : null;

        // GPS badge
        if (this.dom.statusGps) {
            const bridgeActive = this.engineGpsBridge?.active === true;
            const src = bridgeActive ? 'ENG'
                : (this.gpsSource?.label ?? (this.gpsSource?.source === 'internal' ? 'INT' : 'STX'));
            const q = sit?.gps_fix_quality ?? 0;
            const gpsOk = !bridgeActive && q >= 1;
            this.dom.statusGps.classList.toggle('active', gpsOk);
            this.dom.statusGps.classList.toggle('active-degraded', bridgeActive);
            if (gpsOk) {
                const sats = sit.gps_sats != null ? `${sit.gps_sats}sv` : '';
                const sol = GPS_SOLUTION_LABELS[q] || 'FIX';
                const acc = sit._accuracy != null ? `±${Math.round(sit._accuracy)}m` : '';
                this.dom.statusGps.textContent = `${src} ${sol} ${sats || acc}`.trim();
            } else if (bridgeActive) {
                this.dom.statusGps.textContent = 'ENG GPS';
            } else {
                this.dom.statusGps.textContent = `${src} GPS`;
            }
            if (gpsOk && this._gpsDiagPanel?.classList.contains('visible')) {
                this._gpsDiagPanel.classList.remove('visible');
            }
        }

        // FIS-B badge
        if (this.dom.statusFisb) {
            const towers = (status?.UAT_Towers ?? 0) > 0;
            const receiving = (status?.UAT_messages_last_minute > 0) && towers;
            this.dom.statusFisb.classList.toggle('active', receiving);
            if (receiving && this.fisbClient) {
                const mc = this.fisbClient.metarCount;
                const tc = this.fisbClient.tafCount;
                this.dom.statusFisb.textContent = `FIS-B ${mc}M ${tc}T`;
            } else if (receiving) {
                const metars = status.UAT_METAR_total || 0;
                this.dom.statusFisb.textContent = `FIS-B ${metars}`;
            } else {
                this.dom.statusFisb.textContent = 'FIS-B';
            }
        }
    }
```

- [ ] **Step 7.3: Pass systemsMonitor to Checklist**

Find (line ~754):

```javascript
            this.checklist = new Checklist(document.body);
```

Replace with:

```javascript
            this.checklist = new Checklist(document.body, this.systemsMonitor ?? null);
```

- [ ] **Step 7.4: Update DiagLog summary section to use getStatus()**

In `_showDiagLog()`, find the GPS status summary block (lines 335–352):

```javascript
        // GPS status summary
        const summary = document.createElement('div');
        summary.style.cssText = 'padding:8px 16px;background:var(--bg-surface);border-bottom:1px solid var(--border);font-size:13px;flex-shrink:0;font-family:monospace;';
        const sit = this.stratuxClient?.situation;
        const src = this.gpsSource?.label ?? this.gpsSource?.source ?? '?';
        const cfgSrc = this.gpsSource?._configuredSource ?? '?';
        const stxConnected = this.stratuxClient?._connected ? 'YES' : 'NO';
        const fixQ = sit?.gps_fix_quality ?? 'null';
        const lat = sit?.lat?.toFixed(4) ?? 'null';
        const lon = sit?.lon?.toFixed(4) ?? 'null';
        const sats = sit?.gps_sats ?? 'null';
        const acc = sit?._accuracy != null ? `${Math.round(sit._accuracy)}m` : 'n/a';
        summary.innerHTML = [
            `<b>GPS Source:</b> ${src} (configured: ${cfgSrc}) | <b>Stratux connected:</b> ${stxConnected} | <b>Stratux IP:</b> ${this.stratuxClient?.ip || '?'}`,
            `<b>Fix quality:</b> ${fixQ} | <b>Lat:</b> ${lat} | <b>Lon:</b> ${lon} | <b>Sats:</b> ${sats} | <b>Accuracy:</b> ${acc}`,
            `<b>Geolocation API:</b> ${'geolocation' in navigator ? 'available' : 'NOT available'} | <b>watchId:</b> ${this.gpsSource?._watchId ?? 'null'}`,
        ].join('<br>');
        overlay.appendChild(summary);
```

Replace the `summary.innerHTML` lines (keep `const summary = ...` and `overlay.appendChild(summary)`) with:

```javascript
        // GPS status summary + SystemsMonitor status
        const summary = document.createElement('div');
        summary.style.cssText = 'padding:8px 16px;background:var(--bg-surface);border-bottom:1px solid var(--border);font-size:13px;flex-shrink:0;font-family:monospace;';
        const sit = this.stratuxClient?.situation;
        const src = this.gpsSource?.label ?? this.gpsSource?.source ?? '?';
        const cfgSrc = this.gpsSource?._configuredSource ?? '?';
        const stxConnected = this.stratuxClient?._connected ? 'YES' : 'NO';
        const fixQ = sit?.gps_fix_quality ?? 'null';
        const lat = sit?.lat?.toFixed(4) ?? 'null';
        const lon = sit?.lon?.toFixed(4) ?? 'null';
        const sats = sit?.gps_sats ?? 'null';
        const acc = sit?._accuracy != null ? `${Math.round(sit._accuracy)}m` : 'n/a';
        const lines = [
            `<b>GPS Source:</b> ${src} (configured: ${cfgSrc}) | <b>Stratux connected:</b> ${stxConnected} | <b>Stratux IP:</b> ${this.stratuxClient?.ip || '?'}`,
            `<b>Fix quality:</b> ${fixQ} | <b>Lat:</b> ${lat} | <b>Lon:</b> ${lon} | <b>Sats:</b> ${sats} | <b>Accuracy:</b> ${acc}`,
            `<b>Geolocation API:</b> ${'geolocation' in navigator ? 'available' : 'NOT available'} | <b>watchId:</b> ${this.gpsSource?._watchId ?? 'null'}`,
        ];
        if (this.systemsMonitor) {
            const sm = this.systemsMonitor.getStatus();
            const fmt = (key, s) => `<b>${key}:</b> ${s.status}${s.cause ? ` — ${s.cause}` : ''}`;
            lines.push(`<b>Systems:</b> ${['stratux','engine','gps','weather'].map(k => fmt(k, sm[k])).join(' | ')}`);
        }
        summary.innerHTML = lines.join('<br>');
        overlay.appendChild(summary);
```

- [ ] **Step 7.5: Run test suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7.6: Commit**

```bash
git add web/app.js
git commit -m "feat(app): wire SystemsMonitor, replace polling loop, update DiagLog summary"
```

---

## Task 8: index.html — add script tag

**Files:**
- Modify: `web/index.html`

- [ ] **Step 8.1: Add the script tag**

In `web/index.html`, find the line (line 92):

```html
    <script src="./shared/fisb-client.js"></script>
```

Add after it:

```html
    <script src="./shared/systems-monitor.js"></script>
```

The block should read:

```html
    <script src="./shared/cockpit-config.js"></script>
    <script src="./shared/fisb-client.js"></script>
    <script src="./shared/systems-monitor.js"></script>

    <script src="./cockpit/map.js"></script>
```

- [ ] **Step 8.2: Commit**

```bash
git add web/index.html
git commit -m "feat(index): load systems-monitor.js"
```

---

## Task 9: Build and version bump

**Files:**
- Modify: `web/app.js` (version only)

- [ ] **Step 9.1: Bump FLYTAB_VERSION**

In `web/app.js`, find `const FLYTAB_VERSION = 'v...'` and increment the patch version.

- [ ] **Step 9.2: Run full test suite one final time**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 9.3: Build**

```bash
bash build.sh
```

Expected: BUILD SUCCESSFUL, APK written to `data/`.

- [ ] **Step 9.4: Commit**

```bash
git add web/app.js
git commit -m "chore: bump version for systems diagnostic release"
```

---

## Task 10: Diagnostic Logging — Centralize and Claude Export

**Goal:** Make all subsystem logs flow through `DiagLog` (no silent console.log duplicates), add connection lifecycle logging to `engine-client` and `fisb-client`, add a `_transport` tag to GPS situation data so each fix is traceable to its delivery path, and add a "Copy for Claude" button to the DiagLog overlay so the pilot can paste a structured diagnostic report into a Claude conversation.

**Files:**
- Modify: `web/shared/gps-source.js`
- Modify: `web/shared/engine-client.js`
- Modify: `web/shared/fisb-client.js`
- Modify: `web/shared/weather-client.js`
- Modify: `web/shared/stratux-client.js`
- Modify: `web/app.js` (DiagLog overlay only)

**Key constraint:** `DiagLog` is defined in `app.js` and exposed as `window.DiagLog`. Shared modules loaded before `app.js` must use `window.DiagLog?.log(...)` — the optional chain is the no-op guard during vitest tests.

---

### Background: three GPS data paths and why it matters for diagnostics

The app has three paths that all write `this.situation` and fire `stratux:situation`:

| Path | Transport | Source |
|---|---|---|
| GDL90 UDP | `StratuxUDP` Capacitor plugin, port 4000 | `_StratuxUdpBus.onSituation → _handleSituation()` |
| WebSocket `/situation` | `StratuxWS` plugin or browser WS | `_situationWs.onmessage → _handleSituation()` |
| Internal device GPS | `navigator.geolocation.watchPosition()` | `GpsSource._onInternalPosition()` injects synthetic situation |

**Why GDL90 UDP is the primary path:** GDL90 is the ARINC 436/DO-282B industry standard used by every EFB application (ForeFlight, Garmin Pilot, FlyQ, WingX). It is connectionless — no TCP handshake, no half-close ambiguity, no `readyState=OPEN` lie after a network glitch. Stratux broadcasts it continuously regardless of whether any client is connected. The WS `/situation` path is Stratux-specific and relies on the half-close detection problem that drove the `StratuxWS` native plugin to be written in the first place.

**The double-fire problem:** When UDP mode is active (`udpMode === true`), both the GDL90 path and the WS `/situation` path call `_handleSituation()` on the same 1 Hz Stratux update cycle. `this.situation` is written twice and `stratux:situation` fires twice per update. All downstream consumers (map, instrument strip, SystemsMonitor, route table) re-render on every event. This is wasted work but not data corruption — both paths deliver the same data from the same Stratux device.

**The diagnostic gap:** Neither call to `_handleSituation()` tags the situation object with its transport. When GPS goes wrong in flight, the DiagLog cannot show whether the bad data came from GDL90 or the WS path.

**Desired end state (this task):** Tag every situation object with `_transport: 'gdl90'`, `_transport: 'ws'`, or `_transport: 'internal'`. Log the first situation from each transport so the DiagLog shows which paths are actually delivering data. Include the active transport in the "Copy for Claude" report.

**Follow-on work (not in this task):** When UDP mode is active, suppress the WS `/situation` channel entirely — disconnect `_situationWs` and stop reconnecting it while `udpMode` is true. This eliminates the double-fire, makes the WS AHRS-only data available via the existing `_suppressGpsSituation` AHRS extraction path, and matches what every other EFB does (GDL90 for ownship, WS only for FIS-B pre-parse). Do not implement this in Task 10 — it requires careful reconnect-guard changes and its own test pass.

---

### Step 10.0: Tag situation objects with transport in stratux-client.js

Add `_transport` to every situation object written by `_handleSituation()`, and log the first situation from each transport path. The GDL90 and WS paths both call the same method — distinguish them by the call site, not inside the method.

- [ ] **Step 10.0a: Add a `_transport` parameter to `_handleSituation()`**

Change the signature and add the field to the situation object:

```javascript
// BEFORE (line 340):
    _handleSituation(msg) {

// AFTER:
    _handleSituation(msg, transport = 'ws') {
```

Inside `_handleSituation`, add `_transport` to the situation object (after `timestamp: Date.now()`):

```javascript
            timestamp: Date.now(),
            _transport: transport,
```

- [ ] **Step 10.0b: Pass `'gdl90'` at the UDP call site**

In `connect()`, change:

```javascript
// BEFORE (line 159):
                onSituation: (msg) => this._handleSituation(msg),

// AFTER:
                onSituation: (msg) => this._handleSituation(msg, 'gdl90'),
```

- [ ] **Step 10.0c: Log first situation per transport**

Replace the existing first-situation DiagLog block (lines 375–381) with one that distinguishes transports:

```javascript
        // Log first situation per transport path, and fix quality changes
        if (typeof DiagLog !== 'undefined') {
            const key = `_firstSitLogged_${transport}`;
            if (!this[key]) {
                this[key] = true;
                DiagLog.log('stratux', `First situation (${transport}): fix=${msg.GPSFixQuality} lat=${msg.GPSLatitude?.toFixed(4)} lon=${msg.GPSLongitude?.toFixed(4)} sats=${msg.GPSSatellites}/${msg.GPSSatellitesSeen}`);
            } else if (this.situation && prevQuality !== msg.GPSFixQuality) {
                DiagLog.log('stratux', `GPS fix changed (${transport}): ${prevQuality} → ${msg.GPSFixQuality} sats=${msg.GPSSatellites}`);
            }
        }
```

- [ ] **Step 10.0d: Confirm `_onInternalPosition` already tags `_transport: 'internal'`**

`gps-source.js` line 291 already sets `_source: 'internal'` on the synthetic situation. Rename that field to `_transport` for consistency:

```javascript
// BEFORE (gps-source.js ~line 291):
            _source: 'internal',

// AFTER:
            _transport: 'internal',
```

Update `_buildDiagReport()` in `app.js` to include the active transport in the GPS STATE section:

```javascript
        const transport = sit?._transport ?? 'unknown';
        lines.push(`Fix: quality=${fixQ} | Lat: ${lat} | Lon: ${lon} | Sats: ${sats} | Accuracy: ${acc} | Transport: ${transport}`);
```

---

### Step 10.1: Remove redundant console.log/warn from gps-source.js

`gps-source.js` has 6 places where `console.log/warn('[GpsSource]', msg)` fires immediately before or after a `DiagLog.log('gps', msg)` call with the same message. Remove the console calls — DiagLog is the single record. One additional `console.log` (GPS stopped) has no DiagLog counterpart; replace it.

In `web/shared/gps-source.js` make these targeted removals and one replacement:

**Remove** (line 122): `console.log('[GpsSource]', msg);` (paired with DiagLog on 123)

**Remove** (line 137): `console.log('[GpsSource]', msg);` (paired with DiagLog on 138)

**Remove** (line 148): `console.warn('[GpsSource]', msg);` (paired with DiagLog on 149)

**Remove** (line 169): `console.warn('[GpsSource]', msg);` (paired with DiagLog on 170)

**Replace** (line 190): `console.log('[GpsSource] Internal GPS watchPosition started');`
→ remove it (DiagLog on line 191 logs `'watchPosition registered, waiting for fix…'` which is equivalent)

**Replace** (line 199): `console.warn('[GpsSource]', msg);` (paired with DiagLog on 200) — remove

**Replace** (line 220): `console.log('[GpsSource] Internal GPS stopped');`
→ `if (typeof DiagLog !== 'undefined') DiagLog.log('gps', 'Internal GPS watchPosition stopped');`

- [ ] **Step 10.1: Edit gps-source.js — remove redundant console calls**

```javascript
// BEFORE (line 121–123):
        const msg = `Auto GPS: Stratux ${reason} — activating device GPS fallback`;
        console.log('[GpsSource]', msg);
        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', msg);

// AFTER:
        const msg = `Auto GPS: Stratux ${reason} — activating device GPS fallback`;
        if (typeof DiagLog !== 'undefined') DiagLog.log('gps', msg);
```

Apply the same console-removal pattern to lines 136–138, 146–149, 167–170, 189–191, 197–200.

For line 220 (no existing DiagLog pair):

```javascript
// BEFORE:
            console.log('[GpsSource] Internal GPS stopped');

// AFTER:
            if (typeof DiagLog !== 'undefined') DiagLog.log('gps', 'Internal GPS watchPosition stopped');
```

---

### Step 10.2: Add DiagLog to engine-client.js

`engine-client.js` has no logging at all. Add `window.DiagLog?.log(...)` at the four meaningful lifecycle events. The `_setConnected` method is the DRY hub for connect/disconnect; the `onopen`/`onclose` handlers cover WS-specific events.

- [ ] **Step 10.2: Edit engine-client.js**

In `_ws.onopen` (after line 93 `this._setConnected(true);`):

```javascript
        this._ws.onopen = () => {
            this._reconnectDelay = 2000;
            this._wsFailCount = 0;
            if (this._useHttpFallback) {
                this._useHttpFallback = false;
                if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
                if (this._wsRetryTimer) { clearInterval(this._wsRetryTimer); this._wsRetryTimer = null; }
                window.DiagLog?.log('engine', 'WebSocket recovered from HTTP fallback');
            }
            this._setConnected(true);
            this._startStaleCheck();
        };
```

In `_ws.onclose` (after `this._useHttpFallback = true;`, line 107):

```javascript
        this._ws.onclose = () => {
            this._wsFailCount++;
            if (this._wsFailCount >= 3) {
                this._useHttpFallback = true;
                window.DiagLog?.log('engine', `WebSocket failed ${this._wsFailCount}× — switching to HTTP fallback`);
                this._startHttpPolling();
                if (!this._wsRetryTimer) {
                    this._wsRetryTimer = setInterval(() => {
                        this._useHttpFallback = false;
                        this._wsFailCount = 0;
                        this._doConnect();
                    }, 60000);
                }
            } else {
                this._scheduleReconnect();
            }
        };
```

In `_setConnected` (after the event dispatch on line 186):

```javascript
    _setConnected(state) {
        if (this._connected === state) return;
        this._connected = state;
        if (!state) {
            if (this._staleTimer) { clearInterval(this._staleTimer); this._staleTimer = null; }
            this._stale = false;
        }
        const event = state ? 'engine:connect' : 'engine:disconnect';
        this.dispatchEvent(new CustomEvent(event));
        window.DiagLog?.log('engine', state ? `Connected at ${this._ip}:${this._port}` : 'Disconnected');
    }
```

In `_startStaleCheck` (inside the interval, after `this.dispatchEvent` for stale):

```javascript
            if (age > 5000 && !this._stale) {
                this._stale = true;
                this.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true, ageMs: age } }));
                window.DiagLog?.log('engine', `Data stale — no frame for ${Math.round(age/1000)}s`);
            }
```

---

### Step 10.3: Add first-frame logging to fisb-client.js

Log when each data type is first received — useful to confirm UAT reception in flight. Use a `Set` to avoid repeat entries after the first frame.

- [ ] **Step 10.3: Edit fisb-client.js — add _firstFrameLogged Set and milestone calls**

In the `constructor`, add after existing property initializations:

```javascript
        this._firstFrameLogged = new Set();   // tracks which frame types have been logged once
```

Add a private helper method:

```javascript
    _logFirstFrame(type, detail) {
        if (this._firstFrameLogged.has(type)) return;
        this._firstFrameLogged.add(type);
        window.DiagLog?.log('fisb', `First ${type} received`, detail);
    }
```

Call it at the appropriate dispatch sites:

```javascript
// In _processMetar, after this.dispatchEvent('fisb:metar'):
        this._logFirstFrame('METAR', { icao, metarCount: this.metarCount });

// In _processWinds, after this.dispatchEvent('fisb:winds'):
        this._logFirstFrame('winds', { count: this.winds.size });

// In _processNexrad (or wherever 'fisb:nexrad' is dispatched):
        this._logFirstFrame('NEXRAD', {});

// In _processPirep (first PIREP):
        this._logFirstFrame('PIREP', {});
```

Also add a decode-error guard in `_onFisbFrame` (or wherever the frame dispatch occurs) — if `JSON.parse` or frame decode throws, log it:

```javascript
        } catch (err) {
            window.DiagLog?.log('fisb', `Frame decode error: ${err.message}`);
        }
```

---

### Step 10.4: Route weather-client.js console.log → DiagLog

One `console.log` in `weather-client.js` line 139:

```javascript
// BEFORE:
                console.log(`Winds aloft: using FD station ${nearest} for ${stationUpper}`);

// AFTER:
                window.DiagLog?.log('weather', `Winds aloft FD fallback: ${nearest} for ${stationUpper}`);
```

- [ ] **Step 10.4: Edit weather-client.js line 139**

---

### Step 10.5: Add "Copy for Claude" button to DiagLog overlay

The DiagLog overlay (`_showDiagLog()` in `app.js`) currently has Refresh, Clear, and Close buttons. Add a "Copy for Claude" button that generates a structured plain-text report — the pilot taps it, then pastes into a Claude conversation for remote diagnosis.

Report format:

```
FlyTab Diagnostic Report — <version> — <ISO timestamp>

=== SYSTEM STATUS ===
Stratux: ok
Engine: degraded — Engine monitor not reachable at 192.168.10.1:8082
  · Check Pi is powered.
  · Disable ExpressVPN or Tailscale — port 8082 may be blocked.
GPS: ok
FIS-B Wx: unknown

=== GPS STATE ===
Source: STX (configured: auto) | Stratux: YES | IP: 192.168.10.212
Fix: quality=2 | Lat: 38.1234 | Lon: -81.4567 | Sats: 8 | Accuracy: 4m
Geolocation: available | watchId: 3

=== RECENT LOG (last 100 entries) ===
14:30:01 [init] FlyTab v7.73 initialized
14:30:02 [stratux] Connected to ws://192.168.10.212:4000/traffic
...
```

- [ ] **Step 10.5: Add copyBtn to _showDiagLog()**

Add alongside `refreshBtn`/`clearBtn`/`closeBtn` in the button bar:

```javascript
        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy for Claude';
        copyBtn.style.cssText = 'padding:6px 14px;background:var(--accent);color:var(--text-on-dark);border:none;border-radius:4px;font-size:14px;';
        copyBtn.addEventListener('click', () => {
            const text = this._buildDiagReport();
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy for Claude'; }, 2000);
            }).catch(() => {
                // Fallback: show in a textarea the pilot can manually copy
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;top:10%;left:5%;width:90%;height:80%;z-index:10000;font-size:12px;font-family:monospace;';
                document.body.appendChild(ta);
                ta.select();
                ta.addEventListener('blur', () => ta.remove());
            });
        });
        btns.insertBefore(copyBtn, clearBtn);
```

Add a new method `_buildDiagReport()` on `FlyTabApp`:

```javascript
    _buildDiagReport() {
        const lines = [];
        lines.push(`FlyTab Diagnostic Report — ${FLYTAB_VERSION} — ${new Date().toISOString()}`);
        lines.push('');

        // Systems status
        lines.push('=== SYSTEM STATUS ===');
        if (this.systemsMonitor) {
            const sm = this.systemsMonitor.getStatus();
            for (const [key, label] of [['stratux','Stratux'],['engine','Engine'],['gps','GPS'],['weather','FIS-B Wx']]) {
                const s = sm[key];
                lines.push(`${label}: ${s.status}${s.cause ? ` — ${s.cause}` : ''}`);
                for (const sug of (s.suggestions ?? [])) lines.push(`  · ${sug}`);
            }
        } else {
            lines.push('SystemsMonitor not yet initialized');
        }
        lines.push('');

        // GPS state
        lines.push('=== GPS STATE ===');
        const sit = this.stratuxClient?.situation;
        const src = this.gpsSource?.label ?? this.gpsSource?.source ?? '?';
        const cfgSrc = this.gpsSource?._configuredSource ?? '?';
        const stxConnected = this.stratuxClient?._connected ? 'YES' : 'NO';
        const fixQ = sit?.gps_fix_quality ?? 'null';
        const lat = sit?.lat?.toFixed(4) ?? 'null';
        const lon = sit?.lon?.toFixed(4) ?? 'null';
        const sats = sit?.gps_sats ?? 'null';
        const acc = sit?._accuracy != null ? `${Math.round(sit._accuracy)}m` : 'n/a';
        lines.push(`Source: ${src} (configured: ${cfgSrc}) | Stratux: ${stxConnected} | IP: ${this.stratuxClient?.ip || '?'}`);
        lines.push(`Fix: quality=${fixQ} | Lat: ${lat} | Lon: ${lon} | Sats: ${sats} | Accuracy: ${acc}`);
        lines.push(`Geolocation: ${'geolocation' in navigator ? 'available' : 'NOT available'} | watchId: ${this.gpsSource?._watchId ?? 'null'}`);
        lines.push('');

        // DiagLog entries
        const entries = DiagLog.entries;
        const recent = entries.slice(-100);
        lines.push(`=== RECENT LOG (${recent.length} of ${entries.length} entries) ===`);
        for (const e of recent) {
            const time = e.t.slice(11, 19);
            const data = e.d ? ` ${typeof e.d === 'object' ? JSON.stringify(e.d) : e.d}` : '';
            lines.push(`${time} [${e.cat}] ${e.msg}${data}`);
        }

        return lines.join('\n');
    }
```

---

### Step 10.6: Commit

- [ ] **Step 10.6: Run test suite, then commit all Task 10 changes**

```bash
npm test
git add web/shared/gps-source.js web/shared/engine-client.js web/shared/fisb-client.js web/shared/weather-client.js web/app.js
git commit -m "feat(diag): centralize logging, add engine/fisb/weather DiagLog, Copy-for-Claude report"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| SystemsMonitor new file with start/stop/getStatus | Task 1 |
| Stratux: null IP → degraded immediately | Tasks 1–2 |
| Stratux: 15s timeout → degraded with VPN/WiFi suggestions | Tasks 1–2 |
| Stratux: connected, no situation 30s → GPS lock suggestion | Tasks 1–2 |
| Stratux: situation arriving → ok | Task 2 |
| Engine: 15s timeout → degraded | Task 3 |
| Engine: HTTP fallback active → degraded | Task 3 |
| Engine: data flowing → ok | Task 3 |
| GPS chains to Stratux when source is auto/stratux | Task 3 |
| GPS: internal, no fix 30s → degraded | Task 3 |
| GPS: fix received → ok | Task 3 |
| Weather: Stratux degraded → chained | Task 3 |
| Weather: UAT_Towers === 0 after 60s → no towers | Task 3 |
| Weather: fisb:metar or fisb:winds → ok | Task 3 |
| null fisbClient → weather stays unknown, no crash | Task 3 |
| EngineClient reads Settings.piIp | Task 4 |
| checklist.json Systems Check item after Tailscale | Task 5 |
| checklist.js renders systems_check item type | Task 6 |
| checklist.js accepts systemsMonitor in constructor | Task 6 |
| systems:changed re-renders checklist when visible | Task 6 |
| app.js instantiates SystemsMonitor after fisbClient ready | Task 7 |
| _startDeviceStatusMonitor replaced with event-driven | Task 7 |
| Checklist receives systemsMonitor | Task 7 |
| DiagLog summary includes systems status | Task 7 |
| index.html script tag | Task 8 |
| situation._transport tag added ('gdl90', 'ws', 'internal') | Task 10.0 |
| first situation per transport logged separately | Task 10.0 |
| _source: 'internal' renamed to _transport: 'internal' in gps-source.js | Task 10.0 |
| _buildDiagReport() shows active transport in GPS STATE | Task 10.0 |
| gps-source.js console.log removed, DiagLog only | Task 10.1 |
| engine-client.js WS connect/disconnect/fallback/stale logged | Task 10.2 |
| fisb-client.js first METAR/winds/NEXRAD/PIREP logged | Task 10.3 |
| weather-client.js console.log → DiagLog | Task 10.4 |
| DiagLog overlay "Copy for Claude" button | Task 10.5 |
| _buildDiagReport() includes system status + GPS state + last 100 log entries | Task 10.5 |

### Placeholder scan

No TBD, TODO, or vague steps found. All code blocks show exact content.

### Type consistency

- `SystemsMonitor` constructor matches usage in Task 7: `new SystemsMonitor(stratuxClient, engineClient, gpsSource, fisbClient)`
- `getStatus()` return keys `stratux/engine/gps/weather` match checklist renderer in Task 6
- `systems:changed` event name consistent across Tasks 1, 6, 7
- `_updateStatusBadges()` replaces the inline `update()` function body from the old `_startDeviceStatusMonitor()` — same logic preserved
- `window.DiagLog?.log(...)` used in all shared modules (safe when DiagLog not yet defined at test time)
- `_buildDiagReport()` references `DiagLog` (no `window.` prefix) — valid inside `app.js` where DiagLog is in scope
- `_firstFrameLogged` Set in `FisbClient` — initialized in constructor, safe if `start()` never called
- `_transport` field: `'gdl90'` | `'ws'` | `'internal'` — consistent across `_handleSituation` parameter default, UDP call site override, and `gps-source.js` synthetic situation
- `_firstSitLogged_gdl90` / `_firstSitLogged_ws` are instance properties set dynamically on `StratuxClient` — no constructor change needed, safe to add lazily in `_handleSituation`

### Follow-on: suppress WS /situation when UDP is active

**Not in this plan.** When `udpMode === true`, `_situationWs` delivers duplicate data and causes double-fire of `stratux:situation`. The right fix is to not call `_connectSituation()` when UDP is active, and to call it only for AHRS extraction (using `_suppressGpsSituation = true`). This is its own task — it touches reconnect guards, the traffic-WS rescue logic that currently starts `_connectSituation()` as a side effect, and needs a test that confirms `stratux:situation` fires exactly once per Stratux cycle when UDP is running.
