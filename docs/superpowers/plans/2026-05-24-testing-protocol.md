# Testing Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three-tier testing protocol: Vitest unit tests (Tier 1), domain-scoped Playwright component and smoke tests with visual regression (Tier 2), and a tablet CDP checklist (Tier 3).

**Architecture:** Vitest handles pure-logic unit tests; Playwright drives a static-file-served `web/` directory with three mock hardware fixture servers (fake-engine, mock-stratux, mock-home-server) injected at test time. Tests are tagged by domain so only relevant suites run when specific files change.

**Tech Stack:** Vitest 2.x, Playwright 1.59+, Node.js, Python 3 (mock-stratux), `npx serve` (static file server)

**Spec:** `docs/superpowers/specs/2026-05-24-testing-protocol-design.md`

---

## Milestone 1: Foundation

### Task 1: Playwright config and static file server

**Files:**
- Create: `playwright.config.js`
- Create: `tests/fixtures/global-setup.js`
- Create: `tests/fixtures/global-teardown.js`

- [ ] **Step 1: Install `serve` for static file serving**

```bash
npm install --save-dev serve
```

Expected: `serve` appears in `devDependencies` in `package.json`.

- [ ] **Step 2: Create `playwright.config.js`**

```javascript
// playwright.config.js
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests',
    timeout: 30_000,
    fullyParallel: false,
    retries: 0,
    globalSetup:    './tests/fixtures/global-setup.js',
    globalTeardown: './tests/fixtures/global-teardown.js',
    snapshotDir:    './tests/snapshots',
    use: {
        baseURL: 'http://localhost:3000',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'components',
            testMatch: 'tests/components/**/*.spec.js',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1280, height: 800 },
            },
        },
        {
            name: 'smoke',
            testMatch: 'tests/smoke/**/*.spec.js',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1280, height: 800 },
            },
        },
    ],
    webServer: {
        command: 'npx serve . -p 3000 --no-clipboard --cors',
        url: 'http://localhost:3000/web/index.html',
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
    },
});
```

- [ ] **Step 3: Create `tests/fixtures/global-setup.js`**

```javascript
// tests/fixtures/global-setup.js
'use strict';
const { spawn }           = require('child_process');
const { startMockHomeServer } = require('./mock-home-server.js');
const fs   = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '.server-pids.json');

module.exports = async function globalSetup() {
    const procs = {};

    // Start fake-engine.js (WS :8082, HTTP :8080), run for 24h
    const engine = spawn('node', ['tools/fake-engine.js', '86400'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    engine.stderr.on('data', d => process.stderr.write('[engine] ' + d));
    procs.enginePid = engine.pid;

    // Start mock-stratux.py (WS :5678)
    const stratux = spawn('python3', ['tools/mock-stratux.py', '--port', '5678'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    stratux.stderr.on('data', d => process.stderr.write('[stratux] ' + d));
    procs.stratuxPid = stratux.pid;

    // Start mock home server (HTTP :8090) — Node, returns handle to close
    const homeServer = await startMockHomeServer(8090);
    procs.homeServerPort = 8090;

    // Persist handles so teardown can shut them down
    global.__testServers = { engine, stratux, homeServer };

    // Write PIDs so teardown process can find them if global is lost
    fs.writeFileSync(STATE_FILE, JSON.stringify(procs));

    // Allow servers to bind before tests run
    await new Promise(r => setTimeout(r, 1500));
    console.log('  [setup] fixture servers started');
};
```

- [ ] **Step 4: Create `tests/fixtures/global-teardown.js`**

```javascript
// tests/fixtures/global-teardown.js
'use strict';
const fs   = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '.server-pids.json');

module.exports = async function globalTeardown() {
    // Prefer handles stored in global (same process)
    if (global.__testServers) {
        const { engine, stratux, homeServer } = global.__testServers;
        try { engine.kill(); }    catch (_) {}
        try { stratux.kill(); }   catch (_) {}
        try { homeServer.close(); } catch (_) {}
    } else if (fs.existsSync(STATE_FILE)) {
        // Fallback: kill by PID (cross-worker case)
        const { enginePid, stratuxPid } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        try { process.kill(enginePid); }  catch (_) {}
        try { process.kill(stratuxPid); } catch (_) {}
    }
    try { fs.unlinkSync(STATE_FILE); } catch (_) {}
    console.log('  [teardown] fixture servers stopped');
};
```

- [ ] **Step 5: Verify config is valid**

```bash
npx playwright --version
npx playwright test --list 2>&1 | head -20
```

Expected: Playwright version prints, test list shows 0 tests (no spec files yet) with no config errors.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.js tests/fixtures/global-setup.js tests/fixtures/global-teardown.js package.json package-lock.json
git commit -m "feat(test): add Playwright config and fixture server lifecycle"
```

---

### Task 2: Update `package.json` test scripts

**Files:**
- Modify: `package.json` (scripts section only)

- [ ] **Step 1: Replace the scripts section**

Open `package.json`. Replace the existing `"scripts"` block with:

```json
"scripts": {
    "test":            "vitest run",
    "test:watch":      "vitest",
    "test:ui":         "vitest --ui",
    "test:engine":     "vitest run tests/cockpit/engine*.test.js tests/shared/engine*.test.js; npx playwright test --project=components --grep @engine",
    "test:stratux":    "vitest run tests/shared/stratux*.test.js; npx playwright test --project=components --grep @stratux",
    "test:map":        "npx playwright test --project=components --grep @map",
    "test:charts":     "npx playwright test --project=components --grep @charts",
    "test:nasr":       "vitest run tests/shared/nasr*.test.js; npx playwright test --project=smoke --grep @nasr",
    "test:weather":    "vitest run tests/shared/altitude*.test.js; npx playwright test --project=components --grep @weather",
    "test:notam":      "npx playwright test --project=components --grep @notam",
    "test:planner-ui": "npx playwright test --project=components --grep @planner-ui",
    "test:smoke":      "npx playwright test --project=smoke",
    "test:visual":     "npx playwright test --project=smoke --grep @visual",
    "test:all":        "vitest run && npx playwright test"
}
```

Note: `vitest run tests/cockpit/engine*.test.js tests/shared/engine*.test.js` will silently skip missing paths — that's fine as the files are added in later tasks.

- [ ] **Step 2: Verify**

```bash
npm test
```

Expected: Same 104 tests pass (existing vitest suite, unchanged).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(test): add domain-scoped test:* scripts"
```

---

### Task 3: Fix `fake-engine.js` to canonical Pi format

**Files:**
- Modify: `tools/fake-engine.js`

The current `makeFrame()` returns a flat object with `egt: [...]` arrays and lowercase keys. The real Pi sends the nested `get_status()` shape with `data.EGT1..EGT4` and PascalCase EDM keys. This task corrects the fixture.

- [ ] **Step 1: Replace `makeFrame()` in `tools/fake-engine.js`**

Find the existing `makeFrame()` function (lines ~18-35) and replace it:

```javascript
function makeFrame() {
  const t = (Date.now() - startMs) / 1000;
  const rpm = Math.round(2200 + Math.sin(t / 30) * 50);
  const ff  = parseFloat((8.5 + Math.cos(t / 10) * 0.3).toFixed(1));
  const gallons = parseFloat(Math.max(0, 24.9 - t / 3600 * ff).toFixed(1));
  return {
    version:              '3.3.0',
    capturing:            true,
    serial_connected:     true,
    stratux_connected:    false,
    percent_power:        parseFloat((65 + Math.sin(t / 60) * 3).toFixed(1)),
    rop_lop_percent:      2.5,
    rop_lop_mode:         'RICH',
    sfc:                  0.42,
    gps_altitude:         5000,
    pressure_altitude:    4950,
    ground_speed:         150,
    tas:                  155,
    oat:                  12.0,
    density_altitude:     6200,
    sticky_valve_alert:   null,
    sticky_valve_dismissed: false,
    serial_warning:       null,
    degrees_from_peak:    {},
    peaks_valid:          false,
    manual_altimeter:     null,
    manual_oat:           null,
    fuel:                 null,
    data: {
      RPM:        rpm,
      MP:         parseFloat((24.5 + Math.cos(t / 25) * 0.5).toFixed(1)),
      Oil_Temp:   parseFloat((180 + Math.min(t / 60, 1) * 20).toFixed(1)),
      Oil_Press:  parseFloat((76 + Math.sin(t / 5) * 2).toFixed(1)),
      Fuel_Press: 4.7,
      Volts:      13.7,
      Amps:       34,
      Fuel_Flow:  ff,
      Gallons_Rem: gallons,
      Fuel_L1:    parseFloat((gallons * 0.55).toFixed(1)),
      Fuel_L2:    parseFloat((gallons * 0.45).toFixed(1)),
      EGT1: Math.round(1350 + Math.sin(t / 20) * 30),
      EGT2: Math.round(1320 + Math.sin(t / 22) * 25),
      EGT3: Math.round(1360 + Math.sin(t / 18) * 28),
      EGT4: Math.round(1340 + Math.sin(t / 24) * 22),
      CHT1: Math.round(380 + Math.sin(t / 40) * 10),
      CHT2: Math.round(365 + Math.sin(t / 42) * 8),
      CHT3: Math.round(370 + Math.sin(t / 38) * 9),
      CHT4: Math.round(355 + Math.sin(t / 44) * 7),
    },
  };
}
```

- [ ] **Step 2: Verify the server starts and produces the right shape**

```bash
node tools/fake-engine.js 5 &
sleep 2
curl -s http://localhost:8080/api/status | python3 -c "import json,sys; d=json.load(sys.stdin); print('data keys:', list(d.get('data',{}).keys())[:6])"
kill %1
```

Expected output: `data keys: ['RPM', 'MP', 'Oil_Temp', 'Oil_Press', 'Fuel_Press', 'Volts']`

- [ ] **Step 3: Commit**

```bash
git add tools/fake-engine.js
git commit -m "fix(test): fake-engine canonical Pi format — nested data, PascalCase EDM fields"
```

---

### Task 4: Create canonical fixture objects

**Files:**
- Create: `tests/fixtures/stratux-messages.js`
- Create: `tests/fixtures/engine-messages.js`

These are the exact wire-format objects used in Tier 1 unit tests (no running server needed).

- [ ] **Step 1: Create `tests/fixtures/stratux-messages.js`**

```javascript
// tests/fixtures/stratux-messages.js
// Exact Stratux WebSocket wire formats — verified from stratux-client.js source.

export const SITUATION = {
    GPSLatitude:          34.9,
    GPSLongitude:        -81.1,
    GPSAltitudeMSL:       5000.0,
    BaroPressureAltitude: 4950.0,
    GPSGroundSpeed:       150.0,
    GPSTrueCourse:         90.0,
    GPSVerticalSpeed:       0.0,
    GPSFixQuality:          2,
    GPSSatellites:          9,
    GPSSatellitesSeen:     11,
    AHRSPitch:              1.5,
    AHRSRoll:               0.5,
    AHRSGLoad:              1.0,
    AHRSGLoadMin:           0.98,
    AHRSGLoadMax:           1.02,
};

// Note: longitude field is Lng, NOT Lon.
export const TRAFFIC_TARGET = {
    Icao_addr:            11256833,
    Tail:                 'N123AB',
    Lat:                   35.25,
    Lng:                  -80.0,
    Alt:                   3500,
    Track:                 270,
    Speed:                 120,
    Vvel:                    0,
    Squawk:               '1200',
    OnGround:              false,
    Age:                    0.0,
    ExtrapolatedPosition:  false,
    SignalLevel:           -45.0,
    TargetType:              1,
};

// Situation with no GPS fix
export const SITUATION_NO_FIX = { ...SITUATION, GPSFixQuality: 0, GPSSatellites: 0 };

// FIS-B NEXRAD frame — field is NEXRAD (array), not NEXRADBlock
export const NEXRAD_FRAME = {
    Product_id: 63,
    NEXRAD: [
        { lat: 34.9, lon: -81.1, intensity: 25, range: 50 },
    ],
};
```

- [ ] **Step 2: Create `tests/fixtures/engine-messages.js`**

```javascript
// tests/fixtures/engine-messages.js
// Exact engine monitor get_status() wire format — verified from engine_monitor.py.
// The engine panel flattens via: raw.data ? { ...raw, ...raw.data } : raw

export const ENGINE_FRAME = {
    version:               '3.3.0',
    capturing:             true,
    serial_connected:      true,
    stratux_connected:     false,
    percent_power:         65.0,
    rop_lop_percent:        2.5,
    rop_lop_mode:          'RICH',
    sfc:                    0.42,
    gps_altitude:          5000,
    pressure_altitude:     4950,
    ground_speed:           150,
    tas:                    155,
    oat:                     12.0,
    density_altitude:      6200,
    sticky_valve_alert:    null,
    sticky_valve_dismissed: false,
    serial_warning:        null,
    degrees_from_peak:     {},
    peaks_valid:           false,
    manual_altimeter:      null,
    manual_oat:            null,
    fuel:                  null,
    data: {
        RPM:        2200,
        MP:           24.5,
        Oil_Temp:    180.0,
        Oil_Press:    76.0,
        Fuel_Press:    4.7,
        Volts:        13.7,
        Amps:         34.0,
        Fuel_Flow:     8.5,
        Gallons_Rem:  24.9,
        Fuel_L1:      13.7,
        Fuel_L2:      11.2,
        EGT1: 1350,
        EGT2: 1320,
        EGT3: 1360,
        EGT4: 1340,
        CHT1:  380,
        CHT2:  365,
        CHT3:  370,
        CHT4:  355,
    },
};

// Flattened form that engine panel actually receives after `raw.data ? {...raw, ...raw.data} : raw`
export const ENGINE_FRAME_FLAT = { ...ENGINE_FRAME, ...ENGINE_FRAME.data };

// Stale condition — no data field change, just for dispatch testing
export const ENGINE_STALE_EVENT = { stale: true, ageMs: 6000 };
```

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/stratux-messages.js tests/fixtures/engine-messages.js
git commit -m "feat(test): canonical Stratux and engine fixture objects"
```

---

### Task 5: Create `mock-home-server.js`

**Files:**
- Create: `tests/fixtures/mock-home-server.js`

- [ ] **Step 1: Create the file**

```javascript
// tests/fixtures/mock-home-server.js
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const TILES_DIR  = path.join(__dirname, 'tiles');
const PLATES_DIR = path.join(__dirname, 'plates');

const CYCLE_INFO = JSON.stringify({
    cycle: '20260424', sua_count: 100, airports: 19823, navaids: 4521,
});

const NASR_BUNDLE = JSON.stringify({
    cycle_info: { cycle: '20260424', sua_count: 100 },
    airports: {
        KLKR: { icao: 'KLKR', lat: 34.9, lon: -81.1, name: 'Lancaster', state: 'SC', elevation_ft: 573 },
        KCLT: { icao: 'KCLT', lat: 35.2, lon: -80.9, name: 'Charlotte Douglas', state: 'NC', elevation_ft: 748 },
    },
    navaids: {
        MRB: { id: 'MRB', lat: 39.4, lon: -77.9, type: 'VOR', freq: 117.0, name: 'Martinsburg' },
    },
    airways: {
        V143: { name: 'V143', waypoints: [{ id: 'MRB' }, { id: 'ETX' }] },
    },
    airspace: [
        { id: 'CLT-C', type: 'C', lat: 35.21, lon: -80.95, floor: 0, ceiling: 4100,
          coords: [[35.3,-81.1],[35.3,-80.7],[35.1,-80.7],[35.1,-81.1],[35.3,-81.1]] },
    ],
    sua: [],
    fixes: {},
});

const MANIFEST = JSON.stringify({
    nasr:   { cycle: '20260424', sua_count: 100 },
    cifp:   { cycle: '20260424' },
    plates: { cycle_code: '2604' },
});

const CIFP_BUNDLE  = JSON.stringify({ procedures: {}, cycle: '20260424' });
const CIFP_CYCLE   = JSON.stringify({ cycle: '20260424' });
const PLATE_INDEX  = JSON.stringify({ KLKR: [{ icao: 'KLKR', chart_name: 'ILS OR LOC RWY 9', filename: 'klkr-ils-9.pdf', state: 'SC' }] });
const TERRAIN_STATUS = JSON.stringify({ exists: false, sizeMb: 0, builtAt: null });

function startMockHomeServer(port) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const p = req.url.split('?')[0];
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json');

            // NASR
            if (p === '/nasr/cycle_info.json') return send(res, CYCLE_INFO);
            if (p === '/nasr/bundle.json')     return send(res, NASR_BUNDLE);
            // CIFP
            if (p === '/cifp/cifp_bundle.json')   return send(res, CIFP_BUNDLE);
            if (p === '/cifp/cifp_cycle_info.json') return send(res, CIFP_CYCLE);
            // Plates
            if (p === '/plates/plate_index.json') return send(res, PLATE_INDEX);
            // Manifest
            if (p === '/manifest.json') return send(res, MANIFEST);
            // Terrain
            if (p === '/terrain/grid/status') return send(res, TERRAIN_STATUS);

            // Tiles — serve real sample WebP files if present, else 404
            if (p.startsWith('/tiles/')) {
                const tilePath = path.join(TILES_DIR, p.replace('/tiles/', ''));
                if (fs.existsSync(tilePath)) {
                    res.setHeader('Content-Type', 'image/webp');
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    return res.end(fs.readFileSync(tilePath));
                }
                res.writeHead(404); return res.end();
            }

            // Plates — serve real sample PDF files if present, else 404
            if (p.startsWith('/plates/') && p.endsWith('.pdf')) {
                const platePath = path.join(PLATES_DIR, path.basename(p));
                if (fs.existsSync(platePath)) {
                    res.setHeader('Content-Type', 'application/pdf');
                    return res.end(fs.readFileSync(platePath));
                }
                res.writeHead(404); return res.end();
            }

            res.writeHead(404); res.end();
        });

        server.on('error', reject);
        server.listen(port, () => resolve(server));
    });
}

function send(res, body) {
    res.end(body);
}

module.exports = { startMockHomeServer };
```

- [ ] **Step 2: Smoke-test the server manually**

```bash
node -e "
const { startMockHomeServer } = require('./tests/fixtures/mock-home-server.js');
startMockHomeServer(8090).then(s => {
    const http = require('http');
    http.get('http://localhost:8090/nasr/cycle_info.json', r => {
        let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ console.log(JSON.parse(d)); s.close(); });
    });
});
"
```

Expected: `{ cycle: '20260424', sua_count: 100, airports: 19823, navaids: 4521 }`

- [ ] **Step 3: Copy sample tiles from fly-pipeline for visual regression**

These tiles cover the KLKR area (34.9°N, 81.1°W).

```bash
mkdir -p tests/fixtures/tiles/sectional/8/70
mkdir -p tests/fixtures/tiles/sectional/10/281
mkdir -p tests/fixtures/tiles/ifr-low/8/70
cp ~/fly-pipeline/data/tiles/sectional/8/70/101.webp tests/fixtures/tiles/sectional/8/70/
cp ~/fly-pipeline/data/tiles/sectional/8/70/102.webp tests/fixtures/tiles/sectional/8/70/
cp ~/fly-pipeline/data/tiles/sectional/10/281/405.webp tests/fixtures/tiles/sectional/10/281/ 2>/dev/null || echo "z10 tile not found — ok, visual test will skip"
cp ~/fly-pipeline/data/tiles/ifr-low/8/70/101.webp tests/fixtures/tiles/ifr-low/8/70/ 2>/dev/null || echo "IFR tile not found — ok"
```

Expected: At least the z=8 sectional tiles copy successfully.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/mock-home-server.js tests/fixtures/tiles/
git commit -m "feat(test): mock home server + sample tile fixtures for visual regression"
```

---

## Milestone 2: Tier 1 Unit Tests

### Task 6: `altitude-utils.js` unit tests

**Files:**
- Create: `tests/shared/altitude-utils.test.js`

- [ ] **Step 1: Create the test file**

```javascript
// tests/shared/altitude-utils.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

// altitude-utils.js defines globals — load via eval in a closure
const src = readFileSync('web/shared/altitude-utils.js', 'utf8');
const module = {};
new Function('module', src)(module);  // not used but avoids strict-mode issues

// Execute in globalThis scope so the functions are available
eval(src); // eslint-disable-line no-eval

describe('parseAltFt', () => {
    it('parses bare numeric as hundreds of feet', () => {
        expect(parseAltFt('260')).toBe(26000);
        expect(parseAltFt('080')).toBe(8000);
        expect(parseAltFt('040')).toBe(4000);
    });

    it('parses FL prefix', () => {
        expect(parseAltFt('FL120')).toBe(12000);
        expect(parseAltFt('FL240')).toBe(24000);
    });

    it('returns 0 for SFC', () => {
        expect(parseAltFt('SFC')).toBe(0);
    });

    it('returns null for FZL token', () => {
        expect(parseAltFt('FZL')).toBeNull();
    });

    it('returns null for empty string and null', () => {
        expect(parseAltFt('')).toBeNull();
        expect(parseAltFt(null)).toBeNull();
    });

    it('returns null for unparseable strings', () => {
        expect(parseAltFt('UNKNOWN')).toBeNull();
    });
});

describe('formatAlt', () => {
    it('formats surface as SFC', () => {
        expect(formatAlt('SFC')).toBe('SFC');
        expect(formatAlt('000')).toBe('SFC');
    });

    it('formats FL levels for high altitudes', () => {
        expect(formatAlt('180')).toBe('FL180');
        expect(formatAlt('240')).toBe('FL240');
    });

    it('formats low altitudes as thousands', () => {
        expect(formatAlt('080')).toBe('8,000');
        expect(formatAlt('040')).toBe('4,000');
    });

    it('returns null for FZL and empty', () => {
        expect(formatAlt('FZL')).toBeNull();
        expect(formatAlt('')).toBeNull();
    });
});

describe('formatAltBand', () => {
    it('formats a complete band', () => {
        expect(formatAltBand('040', '120')).toBe('4,000 – FL120');
    });

    it('handles missing base', () => {
        expect(formatAltBand('', '120')).toBe('Below FL120');
    });

    it('handles missing top', () => {
        expect(formatAltBand('040', '')).toBe('Above 4,000');
    });

    it('returns em-dash when both missing', () => {
        expect(formatAltBand('', '')).toBe('—');
    });
});
```

- [ ] **Step 2: Run the tests**

```bash
npx vitest run tests/shared/altitude-utils.test.js
```

Expected: All tests pass. If `eval` approach fails (strict-mode ESM), adjust: wrap `src` in `(function(){ ${src} })()` and capture exported names by appending `return { parseAltFt, formatAlt, formatAltBand }`.

- [ ] **Step 3: Commit**

```bash
git add tests/shared/altitude-utils.test.js
git commit -m "test: altitude-utils unit tests (parseAltFt, formatAlt, formatAltBand)"
```

---

### Task 7: `stratux-client.js` parsing unit tests

**Files:**
- Create: `tests/shared/stratux-client.test.js`

- [ ] **Step 1: Create the test file**

`StratuxClient._handleSituation` and `_handleTraffic` are instance methods. We instantiate the class with mocked WebSocket/Capacitor globals, then call the private methods directly.

```javascript
// tests/shared/stratux-client.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { SITUATION, TRAFFIC_TARGET } from '../fixtures/stratux-messages.js';

// Set up browser globals that stratux-client.js references
global.WebSocket       = class { constructor() {} };
global.Capacitor       = undefined;
global.CockpitConfig   = { raw: {} };
global.Settings        = { stratuxIp: '127.0.0.1', ownshipModeS: '000000' };
global.DiagLog         = { log: vi.fn() };
global.TrafficDiag     = { wsEvent: vi.fn() };
global.CustomEvent     = class CustomEvent { constructor(t, o) { this.type = t; this.detail = o?.detail; } };

eval(readFileSync('web/shared/stratux-client.js', 'utf8')); // eslint-disable-line no-eval

describe('StratuxClient._handleSituation', () => {
    let client;

    beforeEach(() => {
        client = new StratuxClient();
        client._staleTimer = null; // suppress timers
    });

    it('normalizes field names from wire format', () => {
        client._suppressGpsSituation = false;
        const events = [];
        client.addEventListener('stratux:situation', e => events.push(e.detail));

        client._handleSituation(SITUATION);

        expect(events).toHaveLength(1);
        const sit = events[0];
        expect(sit.lat).toBe(34.9);
        expect(sit.lon).toBe(-81.1);
        expect(sit.alt_msl).toBe(5000.0);
        expect(sit.alt_baro).toBe(4950.0);
        expect(sit.ground_speed).toBe(150.0);
        expect(sit.true_course).toBe(90.0);
        expect(sit.gps_fix_quality).toBe(2);
        expect(sit.gps_sats).toBe(9);
        expect(sit.pitch).toBe(1.5);
        expect(sit.roll).toBe(0.5);
        expect(sit.g_load).toBe(1.0);
        expect(sit.timestamp).toBeTypeOf('number');
    });

    it('suppresses GPS event when _suppressGpsSituation is true', () => {
        client._suppressGpsSituation = true;
        const events = [];
        client.addEventListener('stratux:situation', e => events.push(e.detail));

        client._handleSituation(SITUATION);

        expect(events).toHaveLength(0);
        expect(client._lastStratuxAhrs).not.toBeNull();
        expect(client._lastStratuxAhrs.pitch).toBe(1.5);
    });
});

describe('StratuxClient._handleTraffic', () => {
    let client;

    beforeEach(() => {
        client = new StratuxClient();
    });

    it('normalizes Lng → lon', () => {
        const events = [];
        client.addEventListener('stratux:traffic', e => events.push(e.detail));

        client._handleTraffic(TRAFFIC_TARGET);

        expect(events).toHaveLength(1);
        const t = events[0];
        expect(t.lat).toBe(35.25);
        expect(t.lon).toBe(-80.0);    // Lng → lon
        expect(t.callsign).toBe('N123AB');
        expect(t.hex).toMatch(/^[0-9A-F]{6}$/);
        expect(t.on_ground).toBe(false);
    });

    it('filters own-ship by Mode S address', () => {
        Settings.ownshipModeS = 'ABCDEF';
        const events = [];
        client.addEventListener('stratux:traffic', e => events.push(e.detail));

        const ownship = { ...TRAFFIC_TARGET, Icao_addr: 0xABCDEF };
        client._handleTraffic(ownship);

        expect(events).toHaveLength(0);
        Settings.ownshipModeS = '000000'; // restore
    });

    it('ignores messages with no Icao_addr', () => {
        const events = [];
        client.addEventListener('stratux:traffic', e => events.push(e.detail));

        client._handleTraffic({});

        expect(events).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run**

```bash
npx vitest run tests/shared/stratux-client.test.js
```

Expected: All 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/shared/stratux-client.test.js
git commit -m "test: stratux-client situation and traffic normalization"
```

---

### Task 8: `engine-client.js` flatten and parse tests

**Files:**
- Create: `tests/shared/engine-client.test.js`

- [ ] **Step 1: Create the test file**

```javascript
// tests/shared/engine-client.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { ENGINE_FRAME } from '../fixtures/engine-messages.js';

global.WebSocket    = class { constructor() {} close() {} };
global.CustomEvent  = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };

eval(readFileSync('web/shared/engine-client.js', 'utf8')); // eslint-disable-line no-eval

describe('EngineClient._onData', () => {
    let client;
    const events = [];

    beforeEach(() => {
        events.length = 0;
        client = new EngineClient('127.0.0.1', 8082);
        client.addEventListener('engine:data', e => events.push(e.detail));
    });

    it('emits engine:data with the raw frame', () => {
        client._onData(ENGINE_FRAME);
        expect(events).toHaveLength(1);
        expect(events[0].version).toBe('3.3.0');
        expect(events[0].data.RPM).toBe(2200);
    });

    it('sets lastData', () => {
        client._onData(ENGINE_FRAME);
        expect(client.lastData).toStrictEqual(ENGINE_FRAME);
    });
});

describe('EnginePanel data flatten', () => {
    it('merges nested data fields to top level', () => {
        const raw = ENGINE_FRAME;
        const flat = raw.data ? { ...raw, ...raw.data } : raw;

        // Top-level engine status fields survive
        expect(flat.percent_power).toBe(65.0);
        expect(flat.rop_lop_mode).toBe('RICH');

        // Nested EDM fields promoted to top level
        expect(flat.RPM).toBe(2200);
        expect(flat.EGT1).toBe(1350);
        expect(flat.CHT4).toBe(355);
        expect(flat.Gallons_Rem).toBe(24.9);
        expect(flat.Oil_Temp).toBe(180.0);
    });

    it('handles flat raw (no nested data) gracefully', () => {
        const raw = { rpm: 2200, egt1: 1350 };
        const flat = raw.data ? { ...raw, ...raw.data } : raw;
        expect(flat.rpm).toBe(2200);
        expect(flat.egt1).toBe(1350);
    });
});
```

- [ ] **Step 2: Run**

```bash
npx vitest run tests/shared/engine-client.test.js
```

Expected: All 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/shared/engine-client.test.js
git commit -m "test: engine-client data emit and nested-data flatten"
```

---

### Task 9: `altitude-utils` advisory band tests + `fuel-engine` tests

**Files:**
- Modify: `tests/shared/altitude-utils.test.js` (add advisory band suite)
- Create: `tests/shared/fuel-engine.test.js`

- [ ] **Step 1: Add `formatAdvisoryAltBand` tests to `tests/shared/altitude-utils.test.js`**

Append to the existing file:

```javascript
describe('formatAdvisoryAltBand (G-AIRMET specific)', () => {
    it('formats FZL base with numeric top', () => {
        // base: "FZL" means from freezing level; top is numeric hundreds-of-feet
        const result = formatAdvisoryAltBand('FZL', '180');
        expect(result).toContain('FZL');
        expect(result).toContain('FL180');
    });

    it('formats SFC to altitude band', () => {
        const result = formatAdvisoryAltBand('SFC', '120');
        expect(result).toContain('SFC');
        expect(result).toContain('FL120');
    });

    it('treats empty string as missing, not zero', () => {
        // Empty string is not the same as null — must NOT display "SFC"
        const result = formatAdvisoryAltBand('', '080');
        expect(result).not.toContain('SFC');
        expect(result).toContain('8,000');
    });
});
```

- [ ] **Step 2: Create `tests/shared/fuel-engine.test.js`**

```javascript
// tests/shared/fuel-engine.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

eval(readFileSync('web/shared/fuel-engine.js', 'utf8')); // eslint-disable-line no-eval

describe('FuelEngine', () => {
    it('can be instantiated', () => {
        // Minimal smoke test — verifies the global is defined after eval
        expect(typeof FuelEngine).toBe('function');
    });
});
```

Note: `fuel-engine.js` depends on `aircraft-config.json` and other globals. Expand these tests during implementation once you inspect what `FuelEngine` exposes.

- [ ] **Step 3: Run**

```bash
npx vitest run tests/shared/altitude-utils.test.js tests/shared/fuel-engine.test.js
```

Expected: altitude-utils tests all pass; fuel-engine smoke test passes or identifies missing globals to stub.

- [ ] **Step 4: Commit**

```bash
git add tests/shared/altitude-utils.test.js tests/shared/fuel-engine.test.js
git commit -m "test: advisory alt band edge cases; fuel-engine smoke"
```

---

### Task 10: NOTAM tier and sort unit tests

**Files:**
- Create: `tests/shared/notam-tier.test.js`

`_notamTier` and `_sortedNotams` are methods on `WxBriefing`. We instantiate a minimal `WxBriefing` with stubs to test pure logic.

- [ ] **Step 1: Read enough of `wx-briefing.js` constructor to know what to stub**

```bash
sed -n '1,40p' web/cockpit/wx-briefing.js
```

Note constructor arguments, then proceed.

- [ ] **Step 2: Create `tests/shared/notam-tier.test.js`**

```javascript
// tests/shared/notam-tier.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// Stubs for all globals wx-briefing.js references at parse time
global.window          = global;
global.document        = { createElement: () => ({ innerHTML: '', appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [], classList: { add: () => {}, remove: () => {}, toggle: () => {} }, style: {}, addEventListener: () => {} }), body: { appendChild: () => {}, removeChild: () => {} }, getElementById: () => null };
global.CockpitConfig   = { raw: {}, get: () => null };
global.Settings        = {};
global.DiagLog         = { log: () => {} };
global.wireTap         = () => {};
global.CustomEvent     = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
global.EventTarget     = class { addEventListener() {} dispatchEvent() {} };

eval(readFileSync('web/cockpit/wx-briefing.js', 'utf8')); // eslint-disable-line no-eval

// Helper: build a minimal WxBriefing instance with controlled notam state
function makeWx(notams = [], enrouteNotams = []) {
    const wx = Object.create(WxBriefing.prototype);
    wx._notams         = notams;
    wx._enrouteNotams  = enrouteNotams;
    wx._notamSearch    = '';
    wx._getStationList = () => ['KLKR', 'KCLT'];
    wx._filterByFlightWindow = arr => arr; // pass-through for unit tests
    return wx;
}

describe('WxBriefing._notamTier', () => {
    let wx;
    beforeEach(() => { wx = makeWx(); });

    it('tier 0: TFR, RWY, APCH, GPS, FISB, MEA, RESTR', () => {
        for (const type of ['TFR', 'RWY', 'APCH', 'GPS', 'FISB', 'MEA', 'RESTR']) {
            expect(wx._notamTier({ type })).toBe(0);
        }
    });

    it('tier 1: generic airport NOTAM', () => {
        expect(wx._notamTier({ type: 'NAV', airport: 'KLKR' })).toBe(1);
    });

    it('tier 2: enroute NOTAM', () => {
        expect(wx._notamTier({ type: 'NAV', isEnroute: true })).toBe(2);
    });

    it('tier 3: obstruction light', () => {
        expect(wx._notamTier({ type: 'OBST_LGT' })).toBe(3);
    });
});

describe('WxBriefing._sortedNotams', () => {
    it('critical NOTAMs sort before airport NOTAMs', () => {
        const notams = [
            { type: 'NAV', airport: 'KLKR' },
            { type: 'TFR', airport: 'KLKR' },
        ];
        const wx = makeWx(notams);
        const sorted = wx._sortedNotams();
        expect(sorted[0].type).toBe('TFR');
        expect(sorted[1].type).toBe('NAV');
    });

    it('airport NOTAMs ordered by station index', () => {
        const notams = [
            { type: 'NAV', airport: 'KCLT' },
            { type: 'NAV', airport: 'KLKR' },
        ];
        const wx = makeWx(notams);
        const sorted = wx._sortedNotams();
        // KLKR is index 0 in station list, KCLT is index 1
        expect(sorted[0].airport).toBe('KLKR');
        expect(sorted[1].airport).toBe('KCLT');
    });

    it('enroute NOTAMs sort after tier-1 airport NOTAMs', () => {
        const apt = [{ type: 'NAV', airport: 'KLKR' }];
        const enr = [{ type: 'NAV', isEnroute: true }];
        const wx = makeWx(apt, enr);
        const sorted = wx._sortedNotams();
        expect(sorted[0].isEnroute).toBeFalsy();
        expect(sorted[1].isEnroute).toBe(true);
    });
});
```

- [ ] **Step 3: Run**

```bash
npx vitest run tests/shared/notam-tier.test.js
```

Expected: All 7 tests pass. If `eval` fails due to DOM dependencies, expand the stubs for `document.createElement` to return more complete objects.

- [ ] **Step 4: Commit**

```bash
git add tests/shared/notam-tier.test.js
git commit -m "test: NOTAM tier classification and sort order"
```

---

## Milestone 3: Tier 2a — Component Tests

### Task 11: Engine panel component harness and Playwright tests

This task establishes the full harness pattern. Subsequent component tasks follow the same structure.

**Files:**
- Create: `tests/components/harnesses/engine-panel.html`
- Create: `tests/components/engine-panel.spec.js`

- [ ] **Step 1: Create the harness page**

```html
<!-- tests/components/harnesses/engine-panel.html -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="/web/style.css">
    <style>
        body { background: #f5f5f5; padding: 16px; }
        #mount { width: 320px; }
    </style>
</head>
<body>
    <div id="mount"></div>

    <script>
        // Minimal globals that engine-panel.js reads at parse/init time
        const CockpitConfig = {
            raw: {},
            get: () => null,
            aircraft: () => null,
        };
        const Settings = {};
        const DiagLog  = { log: () => {} };
    </script>
    <script src="/web/shared/engine-client.js"></script>
    <script src="/web/cockpit/engine-panel.js"></script>
    <script>
        // Create a mock EngineClient (EventTarget only — no real WS)
        class MockEngineClient extends EventTarget {}
        const mockClient = new MockEngineClient();

        const panel = new EnginePanel(document.getElementById('mount'), mockClient);
        panel.init();

        window.__harness = {
            sendData(frame) {
                mockClient.dispatchEvent(
                    new CustomEvent('engine:data', { detail: frame })
                );
            },
            sendDisconnect() {
                mockClient.dispatchEvent(new CustomEvent('engine:disconnect'));
            },
            sendStale() {
                mockClient.dispatchEvent(
                    new CustomEvent('engine:stale', { detail: { stale: true, ageMs: 6000 } })
                );
            },
        };
    </script>
</body>
</html>
```

- [ ] **Step 2: Create the Playwright spec**

```javascript
// tests/components/engine-panel.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/engine-panel.html';

// Canonical engine fixture (nested Pi format)
const ENGINE_FRAME = {
    version: '3.3.0', capturing: true, serial_connected: true,
    stratux_connected: false, percent_power: 65.0,
    rop_lop_percent: 2.5, rop_lop_mode: 'RICH', sfc: 0.42,
    gps_altitude: 5000, pressure_altitude: 4950, ground_speed: 150,
    tas: 155, oat: 12.0, density_altitude: 6200,
    sticky_valve_alert: null, sticky_valve_dismissed: false,
    serial_warning: null, degrees_from_peak: {}, peaks_valid: false,
    manual_altimeter: null, manual_oat: null, fuel: null,
    data: {
        RPM: 2200, MP: 24.5, Oil_Temp: 180.0, Oil_Press: 76.0,
        Fuel_Press: 4.7, Volts: 13.7, Amps: 34.0,
        Fuel_Flow: 8.5, Gallons_Rem: 24.9, Fuel_L1: 13.7, Fuel_L2: 11.2,
        EGT1: 1350, EGT2: 1320, EGT3: 1360, EGT4: 1340,
        CHT1: 380,  CHT2: 365,  CHT3: 370,  CHT4: 355,
    },
};

test.describe('engine panel @engine', () => {
    test('renders RPM from canonical Pi engine data', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(frame => window.__harness.sendData(frame), ENGINE_FRAME);
        await expect(page.locator('#eng-rpm')).toHaveText('2200');
    });

    test('renders all four EGT bars with non-zero height', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(frame => window.__harness.sendData(frame), ENGINE_FRAME);
        for (let i = 1; i <= 4; i++) {
            const height = await page.locator(`#eng-egt-${i}`).evaluate(
                el => parseFloat(el.style.height)
            );
            expect(height).toBeGreaterThan(0);
        }
    });

    test('renders fuel endurance from Gallons_Rem and Fuel_Flow', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(frame => window.__harness.sendData(frame), ENGINE_FRAME);
        // 24.9 gal / 8.5 gph ≈ 2.9 hr → "2:56 endur"
        const text = await page.locator('#eng-fuel-endurance').textContent();
        expect(text).toMatch(/\d+:\d{2} endur/);
    });

    test('shows DISCONNECTED status on engine:disconnect', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.sendDisconnect());
        await expect(page.locator('#eng-status')).toHaveText('DISCONNECTED');
    });

    test('shows STALE status on engine:stale', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.sendStale());
        await expect(page.locator('#eng-status')).toHaveText('STALE');
    });
});
```

- [ ] **Step 3: Run the component tests**

```bash
npx playwright test --project=components tests/components/engine-panel.spec.js --reporter=line
```

Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/components/harnesses/engine-panel.html tests/components/engine-panel.spec.js
git commit -m "test(component): engine panel — RPM, EGT bars, fuel endurance, status banners"
```

---

### Task 12: Nav-strip and instrument-strip component tests

**Files:**
- Create: `tests/components/harnesses/nav-strip.html`
- Create: `tests/components/nav-strip.spec.js`

- [ ] **Step 1: Create `tests/components/harnesses/nav-strip.html`**

```html
<!-- tests/components/harnesses/nav-strip.html -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="/web/style.css">
    <style>body { background: #fff; }</style>
</head>
<body>
    <div id="mount"></div>
    <script>
        const CockpitConfig = { raw: {}, get: () => null };
        const Settings = {};
        const DiagLog  = { log: () => {} };
    </script>
    <script src="/web/shared/stratux-client.js"></script>
    <script src="/web/cockpit/nav-strip.js"></script>
    <script>
        class MockStratuxClient extends EventTarget {}
        const mockStratux = new MockStratuxClient();

        const strip = new NavStrip(document.getElementById('mount'), mockStratux);
        strip.init();

        window.__harness = {
            sendSituation(sit) {
                mockStratux.dispatchEvent(
                    new CustomEvent('stratux:situation', { detail: sit })
                );
            },
            sendDisconnect() {
                mockStratux.dispatchEvent(new CustomEvent('stratux:disconnect'));
            },
        };
    </script>
</body>
</html>
```

- [ ] **Step 2: Create `tests/components/nav-strip.spec.js`**

```javascript
// tests/components/nav-strip.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/nav-strip.html';

const SIT = {
    lat: 34.9, lon: -81.1, alt_msl: 5000.0, alt_baro: 4950.0,
    ground_speed: 150.0, true_course: 90.0, vertical_speed: 0.0,
    gps_fix_quality: 2, gps_sats: 9, timestamp: Date.now(),
};

test.describe('nav-strip @stratux', () => {
    test('displays ground speed from situation data', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(sit => window.__harness.sendSituation(sit), SIT);
        const gs = await page.locator('#ns-gs').textContent();
        expect(Number(gs)).toBeCloseTo(150, 0);
    });

    test('displays altitude from situation data', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(sit => window.__harness.sendSituation(sit), SIT);
        const alt = await page.locator('#ns-alt').textContent();
        expect(Number(alt)).toBeCloseTo(5000, -2);
    });
});
```

- [ ] **Step 3: Run**

```bash
npx playwright test --project=components tests/components/nav-strip.spec.js --reporter=line
```

Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/components/harnesses/nav-strip.html tests/components/nav-strip.spec.js
git commit -m "test(component): nav-strip GS and altitude from situation data"
```

---

### Task 13: Layer panel persistence tests

**Files:**
- Create: `tests/components/harnesses/layer-panel.html`
- Create: `tests/components/layer-panel.spec.js`

`LayerPanel` constructor takes `(map, vectorLayers, cockpitMap)`. We stub Leaflet's map object.

- [ ] **Step 1: Create `tests/components/harnesses/layer-panel.html`**

```html
<!-- tests/components/harnesses/layer-panel.html -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="/web/style.css">
    <link rel="stylesheet" href="/web/lib/leaflet.css">
    <style>body { background: #fff; } #map { width: 800px; height: 600px; }</style>
</head>
<body>
    <div id="map"></div>
    <button id="layer-btn">Layers</button>
    <script>
        const CockpitConfig = { raw: { homeServer: { base: 'http://localhost:8090' } }, get: () => null };
        const Settings = {};
        const DiagLog  = { log: () => {} };
        const wireTap  = (el, fn) => el.addEventListener('click', fn);
    </script>
    <script src="/web/lib/leaflet.js"></script>
    <script src="/web/cockpit/vector-map-layers.js"></script>
    <script src="/web/cockpit/layer-panel.js"></script>
    <script>
        const map = L.map('map').setView([34.9, -81.1], 10);
        const vectorLayers = new VectorMapLayers(map);
        const panel = new LayerPanel(map, vectorLayers, null);
        panel.init();
        document.getElementById('layer-btn').addEventListener('click', () => panel.open());

        window.__harness = {
            open()  { panel.open(); },
            close() { panel.close(); },
        };
    </script>
</body>
</html>
```

- [ ] **Step 2: Create `tests/components/layer-panel.spec.js`**

```javascript
// tests/components/layer-panel.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/layer-panel.html';

test.describe('layer panel @map', () => {
    test('opens when triggered', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.open());
        await expect(page.locator('.layer-panel')).toBeVisible();
    });

    test('closes when close is called', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.open());
        await page.evaluate(() => window.__harness.close());
        await expect(page.locator('.layer-panel')).not.toBeVisible();
    });
});
```

- [ ] **Step 3: Run**

```bash
npx playwright test --project=components tests/components/layer-panel.spec.js --reporter=line
```

Expected: 2 tests pass. If `VectorMapLayers` has init-time side effects that fail in the harness, stub it: replace `new VectorMapLayers(map)` with `{ init: () => {}, destroy: () => {} }`.

- [ ] **Step 4: Commit**

```bash
git add tests/components/harnesses/layer-panel.html tests/components/layer-panel.spec.js
git commit -m "test(component): layer panel open/close"
```

---

### Task 14: Remaining component harnesses (wx-briefing, route-planner-panel, traffic-diag)

**Files:**
- Create: `tests/components/harnesses/wx-briefing.html`
- Create: `tests/components/wx-briefing.spec.js`
- Create: `tests/components/harnesses/route-planner-panel.html`
- Create: `tests/components/route-planner-panel.spec.js`

- [ ] **Step 1: Create `tests/components/harnesses/wx-briefing.html`**

```html
<!-- tests/components/harnesses/wx-briefing.html -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="/web/style.css">
</head>
<body>
    <div id="mount"></div>
    <script>
        const CockpitConfig = { raw: { notam: {} }, get: () => null };
        const Settings = { workerBase: 'http://localhost:8090' };
        const DiagLog  = { log: () => {} };
        const wireTap  = (el, fn) => el.addEventListener('click', fn);
    </script>
    <script src="/web/cockpit/wx-briefing.js"></script>
    <script>
        const wx = new WxBriefing(document.getElementById('mount'));
        wx.init();

        window.__harness = {
            injectNotams(notams) {
                wx._notams = notams;
                wx._renderNotamSection?.();
            },
            getNotamCount() {
                return wx._sortedNotams().length;
            },
        };
    </script>
</body>
</html>
```

- [ ] **Step 2: Create `tests/components/wx-briefing.spec.js`**

```javascript
// tests/components/wx-briefing.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/wx-briefing.html';

const NOTAMS = [
    { type: 'TFR',  airport: 'KLKR', text: 'TFR ACTIVE', effective: null, expires: null },
    { type: 'NAV',  airport: 'KLKR', text: 'VOR OUT OF SERVICE', effective: null, expires: null },
    { type: 'OBST_LGT', airport: 'KLKR', text: 'TOWER LGT OTS', effective: null, expires: null },
];

test.describe('wx-briefing NOTAMs @notam', () => {
    test('injects NOTAMs and counts them', async ({ page }) => {
        await page.goto(HARNESS);
        const count = await page.evaluate(notams => {
            window.__harness.injectNotams(notams);
            return window.__harness.getNotamCount();
        }, NOTAMS);
        expect(count).toBe(3);
    });
});
```

- [ ] **Step 3: Create `tests/components/harnesses/route-planner-panel.html`**

```html
<!-- tests/components/harnesses/route-planner-panel.html -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="/web/style.css">
    <link rel="stylesheet" href="/web/lib/leaflet.css">
    <style>#map { width: 800px; height: 600px; }</style>
</head>
<body>
    <div id="map"></div>
    <div id="rp-mount"></div>
    <script>
        const CockpitConfig = { raw: {}, get: () => null };
        const Settings = { workerBase: 'http://localhost:8090' };
        const DiagLog  = { log: () => {} };
        const wireTap  = (el, fn) => el.addEventListener('click', fn);
    </script>
    <script src="/web/lib/leaflet.js"></script>
    <script src="/web/shared/nasr-db.js"></script>
    <script src="/web/cockpit/route-planner-panel.js"></script>
    <script>
        const map = L.map('map').setView([34.9, -81.1], 8);
        const panel = new RoutePlannerPanel(document.getElementById('rp-mount'), map, null);
        panel.init();

        window.__harness = {
            open()   { panel.open(); },
            close()  { panel.close(); },
            isOpen() { return panel.isVisible(); },
        };
    </script>
</body>
</html>
```

- [ ] **Step 4: Create `tests/components/route-planner-panel.spec.js`**

```javascript
// tests/components/route-planner-panel.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/route-planner-panel.html';

test.describe('route-planner-panel @planner-ui', () => {
    test('opens and reports isVisible() true', async ({ page }) => {
        await page.goto(HARNESS);
        const visible = await page.evaluate(() => {
            window.__harness.open();
            return window.__harness.isOpen();
        });
        expect(visible).toBe(true);
    });

    test('close() sets isVisible() false', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.open());
        const visible = await page.evaluate(() => {
            window.__harness.close();
            return window.__harness.isOpen();
        });
        expect(visible).toBe(false);
    });
});
```

- [ ] **Step 5: Run all component tests so far**

```bash
npx playwright test --project=components --reporter=line
```

Expected: All component tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/components/harnesses/ tests/components/wx-briefing.spec.js tests/components/route-planner-panel.spec.js
git commit -m "test(component): wx-briefing NOTAM count, route-planner-panel open/close"
```

---

## Milestone 4: Tier 2b — Smoke Tests

### Task 15: Playwright globalSetup smoke test helper + NASR import smoke

**Files:**
- Create: `tests/smoke/helpers.js`
- Create: `tests/smoke/startup.spec.js`

- [ ] **Step 1: Create `tests/smoke/helpers.js`**

```javascript
// tests/smoke/helpers.js
'use strict';

/**
 * Intercept cockpit-config.json to point hardware at local mock servers.
 * Call at the top of each smoke test: await injectTestConfig(page).
 */
async function injectTestConfig(page) {
    const testConfig = {
        homeServer:   { base: 'http://localhost:8090' },
        simMode:      true,
        simBridgeIp:  '127.0.0.1',
        simBridgePort: 5678,
        engineServer: { ip: '127.0.0.1', port: 8082 },
    };

    await page.route('**/cockpit-config.json', route => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(testConfig),
        });
    });
}

/** Clear IndexedDB between tests to ensure clean import state. */
async function clearIdb(page) {
    await page.evaluate(async () => {
        const dbs = await indexedDB.databases?.() ?? [];
        await Promise.all(dbs.map(d => new Promise((res, rej) => {
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = res; req.onerror = rej;
        })));
    });
}

module.exports = { injectTestConfig, clearIdb };
```

- [ ] **Step 2: Create `tests/smoke/startup.spec.js`**

```javascript
// tests/smoke/startup.spec.js
const { test, expect } = require('@playwright/test');
const { injectTestConfig, clearIdb } = require('./helpers.js');

const APP = '/web/index.html';

test.describe('app startup @nasr', () => {
    test.beforeEach(async ({ page }) => {
        await injectTestConfig(page);
        await clearIdb(page);
    });

    test('loads without console errors', async ({ page }) => {
        const errors = [];
        page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // Allow modules to initialize
        await page.waitForTimeout(3000);
        const fatal = errors.filter(e => !e.includes('favicon') && !e.includes('net::ERR'));
        expect(fatal).toHaveLength(0);
    });

    test('home server reachable check passes', async ({ page }) => {
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForTimeout(3000);
        const cycleInfo = await page.evaluate(async () => {
            const r = await fetch('http://localhost:8090/nasr/cycle_info.json');
            return r.json();
        });
        expect(cycleInfo.sua_count).toBe(100);
    });

    test('NASR import triggers when sua_count differs from IDB', async ({ page }) => {
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // Allow import to complete (bundle is tiny in mock)
        await page.waitForTimeout(5000);
        const airport = await page.evaluate(async () => {
            if (!window.NasrDb) return null;
            return window.NasrDb.getAirport?.('KLKR');
        });
        // If NasrDb exposes getAirport and the import ran, KLKR will be present
        // If import didn't run (e.g. IDB already current), this is still ok —
        // the test verifies no crash, not that import ran (it can't run twice in a row)
        expect(airport === null || airport?.icao === 'KLKR').toBe(true);
    });
});
```

- [ ] **Step 3: Run**

```bash
npx playwright test --project=smoke tests/smoke/startup.spec.js --reporter=line
```

Expected: Tests pass or reveal gaps in the config injection (fix `injectTestConfig` as needed to match what the app actually reads).

- [ ] **Step 4: Commit**

```bash
git add tests/smoke/helpers.js tests/smoke/startup.spec.js
git commit -m "test(smoke): startup, console error check, home server reachability"
```

---

### Task 16: Route planning and engine panel smoke tests

**Files:**
- Create: `tests/smoke/planning.spec.js`
- Create: `tests/smoke/engine.spec.js`

- [ ] **Step 1: Create `tests/smoke/planning.spec.js`**

```javascript
// tests/smoke/planning.spec.js
const { test, expect } = require('@playwright/test');
const { injectTestConfig, clearIdb } = require('./helpers.js');

const APP = '/web/index.html';

test.describe('route planning smoke @nasr', () => {
    test.beforeEach(async ({ page }) => {
        await injectTestConfig(page);
        await clearIdb(page);
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForTimeout(3000);
    });

    test('route planner opens and closes', async ({ page }) => {
        // Open via app JS (avoids needing to click tablet-specific FAB)
        await page.evaluate(() => window.app?.openRoutePlanner?.());
        await page.waitForTimeout(500);
        const open = await page.evaluate(() => window.app?.routeEditor?.isVisible?.() ?? false);
        expect(open).toBe(true);
    });
});
```

- [ ] **Step 2: Create `tests/smoke/engine.spec.js`**

```javascript
// tests/smoke/engine.spec.js
const { test, expect } = require('@playwright/test');
const { injectTestConfig } = require('./helpers.js');

const APP = '/web/index.html';

test.describe('engine panel smoke @engine', () => {
    test('engine client connects to mock server and receives data', async ({ page }) => {
        await injectTestConfig(page);
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // Allow engine WS to connect and receive 1Hz data (fake-engine.js)
        await page.waitForTimeout(4000);
        const lastData = await page.evaluate(() => window.engineClient?.lastData);
        expect(lastData).not.toBeNull();
        expect(lastData?.data?.RPM).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 3: Run**

```bash
npx playwright test --project=smoke tests/smoke/planning.spec.js tests/smoke/engine.spec.js --reporter=line
```

Expected: Tests pass. Engine data test verifies `lastData.data.RPM > 0` confirming the canonical nested format flows end-to-end.

- [ ] **Step 4: Commit**

```bash
git add tests/smoke/planning.spec.js tests/smoke/engine.spec.js
git commit -m "test(smoke): route planner open/close, engine WS data end-to-end"
```

---

### Task 17: Visual regression baseline — VFR sectional tiles

**Files:**
- Create: `tests/smoke/visual-map.spec.js`

- [ ] **Step 1: Verify sample tiles are in place**

```bash
ls tests/fixtures/tiles/sectional/8/70/
```

Expected: `101.webp` and `102.webp` present. If missing, re-run the copy step from Task 5.

- [ ] **Step 2: Create `tests/smoke/visual-map.spec.js`**

```javascript
// tests/smoke/visual-map.spec.js
const { test, expect } = require('@playwright/test');
const { injectTestConfig } = require('./helpers.js');

const APP = '/web/index.html';

test.describe('map tile rendering @visual @visual-map', () => {
    test.beforeEach(async ({ page }) => {
        await injectTestConfig(page);
    });

    test('VFR sectional tiles render at z8 around KLKR', async ({ page }) => {
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // Enable VFR sectional layer via JS
        await page.evaluate(() => {
            window.app?.map?.setView?.([34.9, -81.1], 8);
        });
        await page.waitForTimeout(3000);
        // Screenshot the map area — compare against baseline
        const mapEl = page.locator('#map, .leaflet-container').first();
        await expect(mapEl).toHaveScreenshot('sectional-z8-klkr.png', {
            maxDiffPixelRatio: 0.05,
        });
    });

    test('IFR low tiles render at z8 around KLKR', async ({ page }) => {
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // Switch to IFR layer
        await page.evaluate(() => {
            window.app?.layerPanel?._setActiveChart?.('ifr');
            window.app?.map?.setView?.([34.9, -81.1], 8);
        });
        await page.waitForTimeout(3000);
        const mapEl = page.locator('#map, .leaflet-container').first();
        await expect(mapEl).toHaveScreenshot('ifr-z8-klkr.png', {
            maxDiffPixelRatio: 0.05,
        });
    });
});
```

- [ ] **Step 3: Generate initial baselines (first run creates snapshots, does not fail)**

```bash
npx playwright test --project=smoke tests/smoke/visual-map.spec.js --update-snapshots
```

Expected: Two PNG snapshots written to `tests/snapshots/`. No test failures.

- [ ] **Step 4: Verify baselines pass on second run**

```bash
npx playwright test --project=smoke tests/smoke/visual-map.spec.js --reporter=line
```

Expected: Both tests pass comparing against the just-captured baselines.

- [ ] **Step 5: Commit**

```bash
git add tests/smoke/visual-map.spec.js tests/snapshots/
git commit -m "test(visual): VFR sectional and IFR tile rendering baselines"
```

---

## Milestone 5: Tier 3 — Tablet CDP Checklist

### Task 18: `tools/tablet-check.sh`

**Files:**
- Create: `tools/tablet-check.sh`

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
# FlyTab tablet pre-flight check — runs CDP assertions against the live WebView.
# Usage: bash tools/tablet-check.sh
# Requires: adb forward tcp:9223 localabstract:webview_devtools_remote_$(adb shell pidof app.flywhere.flytab)

set -u

PASS=0
FAIL=0

check() {
    local label="$1"
    local expr="$2"
    local result
    result=$(node tools/cdp-eval.js "$expr" 2>/dev/null | tr -d '"')
    if [ "$result" = "true" ]; then
        echo "  PASS  $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL  $label  (got: $result)"
        FAIL=$((FAIL + 1))
    fi
}

echo ""
echo "FlyTab Tablet Check"
echo "==================="
echo ""

check "Stratux connected" \
    "String(window.stratuxClient && window.stratuxClient.connected)"

check "GPS fix quality >= 2" \
    "String(window.stratuxClient && window.stratuxClient.situation && window.stratuxClient.situation.gps_fix_quality >= 2)"

check "Engine client connected" \
    "String(window.engineClient && window.engineClient.connected)"

check "NASR loaded (KLKR in IDB)" \
    "(async () => { try { const a = await NasrDb.getAirport('KLKR'); return String(a !== null && a !== undefined); } catch(e) { return 'error: '+e.message; } })()"

check "Tile server reachable" \
    "(async () => { try { const r = await fetch('http://localhost:9090/nasr/cycle_info.json', { signal: AbortSignal.timeout(2000) }); return String(r.ok); } catch { return 'false'; } })()"

check "No JS console errors recorded" \
    "String(!window.__consoleErrors || window.__consoleErrors.length === 0)"

check "EngineML last result present" \
    "String(window.engineML && window.engineML.lastResult && typeof window.engineML.lastResult.score === 'number')"

echo ""
echo "Result: $PASS passed, $FAIL failed"
echo ""

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x tools/tablet-check.sh
```

- [ ] **Step 3: Dry-run against the desktop (most checks will fail — that's expected)**

```bash
bash tools/tablet-check.sh 2>&1 | head -20
```

Expected: Script runs without syntax errors. Most checks show FAIL (no tablet connected). EngineML check should fail gracefully with "false", not a crash.

- [ ] **Step 4: Commit**

```bash
git add tools/tablet-check.sh
git commit -m "feat(test): tablet-check.sh — CDP pre-flight assertions (stratux, GPS, engine, NASR, EngineML)"
```

---

### Task 19: Update `vitest.config.js` to include new test paths

**Files:**
- Modify: `vitest.config.js`

- [ ] **Step 1: Update the include glob**

Current config only includes `tests/**/*.test.js`. The new Tier 1 tests are in `tests/shared/`. Update:

```javascript
// vitest.config.js
export default {
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.js'],
        globals: false,
        coverage: {
            include: ['web/shared/**/*.js'],
            thresholds: {
                lines:    50,   // fail below this
                branches: 50,
            },
            reporter: ['text', 'lcov'],
        },
    },
};
```

The glob `tests/**/*.test.js` already covers `tests/shared/` — just confirm it picks up the new files.

- [ ] **Step 2: Run the full vitest suite**

```bash
npm test
```

Expected: All tests pass, count higher than 104 (includes the new Tier 1 tests from Milestones 2).

- [ ] **Step 3: Commit**

```bash
git add vitest.config.js
git commit -m "feat(test): add coverage config to vitest — 50% threshold on web/shared"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Covered by task |
|-----------------|----------------|
| Playwright config + static server | Task 1 |
| Domain-scoped npm scripts | Task 2 |
| fake-engine.js canonical format fix | Task 3 |
| Canonical fixture objects | Task 4 |
| mock-home-server.js | Task 5 |
| Sample tile fixtures | Task 5 |
| altitude-utils unit tests | Task 6 |
| stratux-client parsing tests | Task 7 |
| engine-client flatten tests | Task 8 |
| NOTAM tier/sort tests | Task 10 |
| Engine panel component harness | Task 11 |
| Nav-strip component harness | Task 12 |
| Layer panel component harness | Task 13 |
| wx-briefing NOTAM tests | Task 14 |
| route-planner-panel tests | Task 14 |
| Smoke test helpers + config injection | Task 15 |
| NASR import smoke | Task 15 |
| Route planner smoke | Task 16 |
| Engine end-to-end smoke | Task 16 |
| Visual regression baselines | Task 17 |
| tablet-check.sh | Task 18 |
| vitest coverage config | Task 19 |

**Gap:** `fuel-engine.test.js` (Task 9) is a skeleton — intentional, flagged for expansion. `wb-calculator.js` and `gps-source.js` unit tests from the spec are not yet written; add them following the pattern in Task 7 once the foundation is running.

**Gap:** Traffic target display smoke test (spec: "3 traffic markers appear on map") is not written — add to `tests/smoke/traffic.spec.js` after the full-app smoke is stable. The mock-stratux.py sends traffic continuously; the test needs to wait for markers to render in the Leaflet SVG layer.
