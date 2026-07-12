# Offline Maps → Aeronautical Database Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four Offline Maps cards (Sectional, IFR Low Enroute, IFR Area, TAC) on the Data & Maps page show cycle date / expiration date / traffic-light badge exactly like the Aeronautical Database card, and fix a page-wide font-weight/size violation of this repo's Design Token Standards.

**Architecture:** `web/cockpit/data-status.js`'s `_render()` method builds the whole Data & Maps page from three already-fetched inputs (`serverManifest`, `deviceManifest`, `mbtStatus`); the four-layer `.map()` block that builds "Offline Maps" cards is rewritten to read `serverManifest.tiles[layer]` / `deviceManifest.tiles[layer]` the same way the existing Aeronautical Database code reads `serverManifest.nasr` / `deviceManifest.nasr`, reusing the existing `_section()` card builder and `_cycleStatus()` badge helper unchanged. `needsSync` is derived from the same per-layer computation instead of a separate, narrower check. Typography changes are pure CSS token edits in `web/style.css`, shared by every section on the page.

**Tech Stack:** Vanilla JS (no framework, no bundler — `<script>` tag load order per `web/index.html`), plain CSS custom properties, Playwright-over-CDP for E2E verification (`tools/*.e2e.js`, existing pattern in this repo).

## Global Constraints

- No changes to `flytab-pipeline` (`build_mbtiles.py`, `config.py`) or the home server — `cycle_date`/`expiration_date`/`built_at`/`size_mb` are already produced and already served in `manifest.json`.
- No changes to `_downloadMbtiles()`, `_wireDataSections()`'s `.ds-mbt-dl-btn` wiring, or the `/mbtiles/status` and `/fetch-mbtiles` NanoHTTPD endpoints — buttons keep the same class and `data-layer` attribute regardless of label text.
- No changes to Aeronautical Database, Terrain, or Plates card *content* logic — only the shared CSS tokens they render with.
- Per CLAUDE.md Build Policy: increment `FLYTAB_VERSION` in `web/app.js` and run `bash build.sh` after the code change is complete.
- Per CLAUDE.md: this file has no unit test harness (`web/shared/planning/` is the only directory with `npm test` coverage) — verification here is deterministic E2E via Playwright-over-CDP calling `_render()` directly with fixture data, plus a manual live-browser pass against the real home server.

---

### Task 1: Tile card content, badges, and needsSync

**Files:**
- Modify: `web/cockpit/data-status.js` (the `mbtilesHtml` block, currently lines 325–376)
- Create: `tools/test-data-status-cycles.e2e.js`

**Interfaces:**
- Consumes: `DataStatus._render(serverManifest, deviceManifest, mbtStatus)` (existing public-ish method, already called from `_refresh()`); `DataStatus._section(title, serverVal, deviceVal, badge, primaryBtn, secondaryBtn='', multilineDevice=false)` (existing, unchanged); `DataStatus._cycleStatus(expDate, now)` (existing, unchanged); `DataStatus._badge(text, color)` (existing, unchanged).
- Produces: `DataStatus._needsSync` (boolean, already an existing property read by `_wireDataSections()` — this task changes what feeds it, not its name or type). No new public methods.

- [ ] **Step 1: Write the failing E2E test**

Create `tools/test-data-status-cycles.e2e.js`:

```js
/**
 * E2E test: Offline Maps cards follow the Aeronautical Database cycle/
 * expiration/badge framework. Calls DataStatus._render() directly with
 * constructed fixtures — deterministic, no live home server required.
 */
const { chromium } = require('playwright-core');

const APP = 'http://localhost:8123/index.html';
let failures = 0;
const report = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
};

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
    const page = await browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!window.app?.dataStatus, null, { timeout: 30000 });
    console.log('app booted:', await page.evaluate(() => FLYTAB_VERSION));

    // ---------- Scenario A: all four badge states in one render ----------
    const scenarioA = await page.evaluate(() => {
        const addDays = (n) => {
            const d = new Date();
            d.setDate(d.getDate() + n);
            return d.toISOString().slice(0, 10);
        };
        const serverManifest = {
            tiles: {
                sectional: { cycle_date: '2026-07-09', expiration_date: addDays(49), built_at: '2026-07-10T00:00:00Z', tile_count: 100, size_mb: 1750.5 },
                'ifr-low': { cycle_date: '2026-07-09', expiration_date: addDays(49), built_at: '2026-07-10T00:00:00Z', tile_count: 50, size_mb: 590 },
                'ifr-area': { cycle_date: '2026-07-09', expiration_date: addDays(2), built_at: '2026-07-10T00:00:00Z', tile_count: 20, size_mb: 140 },
                tac: { cycle_date: '2026-07-09', expiration_date: addDays(-3), built_at: '2026-07-10T00:00:00Z', tile_count: 30, size_mb: 245 },
            },
        };
        const deviceManifest = {
            tiles: {
                // sectional intentionally absent — NOT DOWNLOADED
                'ifr-low': { cycle_date: '2026-07-09', expiration_date: addDays(49), built_at: '2026-07-10T00:00:00Z' },
                'ifr-area': { cycle_date: '2026-07-09', expiration_date: addDays(2), built_at: '2026-07-10T00:00:00Z' },
                tac: { cycle_date: '2026-07-09', expiration_date: addDays(-3), built_at: '2026-07-10T00:00:00Z' },
            },
        };
        const mbt = [
            { layer: 'sectional', exists: false },
            { layer: 'ifr-low', exists: true, size_mb: 588 },
            { layer: 'ifr-area', exists: true, size_mb: 139 },
            { layer: 'tac', exists: true, size_mb: 245 },
        ];

        window.app.dataStatus._resolvedBase = 'http://192.168.1.77:8090'; // base truthy → server lines render
        window.app.dataStatus._render(serverManifest, deviceManifest, mbt);

        const body = window.app.dataStatus._el.querySelector('.data-status-body');
        const cardByTitle = (needle) => [...body.querySelectorAll('.ds-section-card')]
            .find(c => c.querySelector('.ds-section-name')?.textContent.includes(needle));

        const describe = (card) => card ? {
            badge: card.querySelector('.ds-section-badge')?.textContent.trim(),
            server: card.querySelectorAll('.ds-inv-row')[0]?.textContent.trim(),
            tablet: card.querySelectorAll('.ds-inv-row')[1]?.textContent.trim(),
            actionText: card.querySelector('.ds-inv-action button')?.textContent.trim() || null,
            actionHasUpdateClass: !!card.querySelector('.ds-inv-action button.ds-update'),
        } : null;

        return {
            sectional: describe(cardByTitle('Sectional')),
            ifrLow: describe(cardByTitle('IFR Low')),
            ifrArea: describe(cardByTitle('IFR Area')),
            tac: describe(cardByTitle('Terminal Area')),
            needsSync: window.app.dataStatus._needsSync,
        };
    });

    report('sectional: NOT DOWNLOADED badge', /NOT DOWNLOADED/.test(scenarioA.sectional?.badge), scenarioA.sectional?.badge);
    report('sectional: server line shows cycle+exp+real size (1,750.5, not estimate 1,800)',
        /Cycle 2026-07-09/.test(scenarioA.sectional?.server) && /exp/.test(scenarioA.sectional?.server) && /1,750\.5/.test(scenarioA.sectional?.server),
        scenarioA.sectional?.server);
    report('sectional: DOWNLOAD action shown', /DOWNLOAD/.test(scenarioA.sectional?.actionText), scenarioA.sectional?.actionText);

    report('ifr-low: CURRENT badge with days-left', /CURRENT \(\d+d left\)/.test(scenarioA.ifrLow?.badge), scenarioA.ifrLow?.badge);
    report('ifr-low: tablet line shows cycle + real on-device size (588, not manifest 590)',
        /Cycle 2026-07-09/.test(scenarioA.ifrLow?.tablet) && /588/.test(scenarioA.ifrLow?.tablet),
        scenarioA.ifrLow?.tablet);
    report('ifr-low: SYNC action (secondary, not highlighted)',
        scenarioA.ifrLow?.actionText === 'SYNC' && !scenarioA.ifrLow?.actionHasUpdateClass,
        JSON.stringify(scenarioA.ifrLow));

    report('ifr-area: EXPIRING badge (2 days left)', /EXPIRING \(\d+d\)/.test(scenarioA.ifrArea?.badge), scenarioA.ifrArea?.badge);
    report('ifr-area: SYNC action (still just expiring, not yet "update available")',
        scenarioA.ifrArea?.actionText === 'SYNC', scenarioA.ifrArea?.actionText);

    report('tac: UPDATE AVAILABLE badge (expiration in the past)', /UPDATE AVAILABLE/.test(scenarioA.tac?.badge), scenarioA.tac?.badge);
    report('tac: RE-DOWNLOAD action (highlighted/update style)',
        scenarioA.tac?.actionText === 'RE-DOWNLOAD' && scenarioA.tac?.actionHasUpdateClass,
        JSON.stringify(scenarioA.tac));

    report('needsSync true (sectional missing + tac expired)', scenarioA.needsSync === true, scenarioA.needsSync);

    // ---------- Scenario B: regression check — a layer OTHER than sectional/ifr-low missing ----------
    // must still trip needsSync. The old code only checked sectional/ifr-low existence.
    const scenarioB = await page.evaluate(() => {
        const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
        const current = { cycle_date: '2026-07-09', expiration_date: addDays(49), built_at: '2026-07-10T00:00:00Z' };
        const serverManifest = { tiles: { sectional: { ...current, tile_count: 1, size_mb: 1750 }, 'ifr-low': { ...current, tile_count: 1, size_mb: 588 }, 'ifr-area': { ...current, tile_count: 1, size_mb: 139 }, tac: { ...current, tile_count: 1, size_mb: 245 } } };
        const deviceManifest = { tiles: { sectional: current, 'ifr-low': current, 'ifr-area': current } }; // tac deliberately omitted
        const mbt = [
            { layer: 'sectional', exists: true, size_mb: 1750 },
            { layer: 'ifr-low', exists: true, size_mb: 588 },
            { layer: 'ifr-area', exists: true, size_mb: 139 },
            { layer: 'tac', exists: false }, // ← the layer the OLD needsSync check ignored entirely
        ];
        window.app.dataStatus._resolvedBase = 'http://192.168.1.77:8090';
        window.app.dataStatus._render(serverManifest, deviceManifest, mbt);
        return { needsSync: window.app.dataStatus._needsSync };
    });
    report('needsSync true when ONLY tac is missing (regression: old code ignored tac/ifr-area entirely)',
        scenarioB.needsSync === true, scenarioB.needsSync);

    // ---------- Scenario C: migrated device (no cycle info stored) must not fabricate a cycle date ----------
    const scenarioC = await page.evaluate(() => {
        const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
        const serverManifest = { tiles: { sectional: { cycle_date: '2026-07-09', expiration_date: addDays(49), built_at: '2026-07-10T00:00:00Z', tile_count: 1, size_mb: 1750 } } };
        const deviceManifest = { tiles: { sectional: {} } }; // migrated device — _readOrMigrateDeviceManifest seeds {} with no cycle info
        const mbt = [
            { layer: 'sectional', exists: true, size_mb: 1740 },
            { layer: 'ifr-low', exists: false }, { layer: 'ifr-area', exists: false }, { layer: 'tac', exists: false },
        ];
        window.app.dataStatus._resolvedBase = 'http://192.168.1.77:8090';
        window.app.dataStatus._render(serverManifest, deviceManifest, mbt);
        const body = window.app.dataStatus._el.querySelector('.data-status-body');
        const card = [...body.querySelectorAll('.ds-section-card')].find(c => c.querySelector('.ds-section-name')?.textContent.includes('Sectional'));
        return {
            badge: card?.querySelector('.ds-section-badge')?.textContent.trim(),
            tablet: card?.querySelectorAll('.ds-inv-row')[1]?.textContent.trim(),
        };
    });
    report('migrated device: tablet line says "On tablet", no fabricated cycle date',
        /On tablet/.test(scenarioC.tablet) && !/Cycle undefined/.test(scenarioC.tablet),
        scenarioC.tablet);
    report('migrated device: badge still CURRENT (server has the expiration data even though device manifest does not)',
        /CURRENT/.test(scenarioC.badge), scenarioC.badge);

    // Leave the page rendered with sectional NOT DOWNLOADED (a plain, unmodified
    // .ds-action-btn with neither .ds-secondary nor .ds-update) so Task 2's
    // typography check has an unambiguous "base button" element to inspect.
    await page.evaluate(() => {
        const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
        const serverManifest = { tiles: { sectional: { cycle_date: '2026-07-09', expiration_date: addDays(49), built_at: '2026-07-10T00:00:00Z', tile_count: 100, size_mb: 1750.5 } } };
        const deviceManifest = { tiles: {} };
        const mbt = [{ layer: 'sectional', exists: false }, { layer: 'ifr-low', exists: false }, { layer: 'ifr-area', exists: false }, { layer: 'tac', exists: false }];
        window.app.dataStatus._render(serverManifest, deviceManifest, mbt);
    });

    const relevant = errors.filter(e => !/favicon|net::|Failed to fetch|NetworkError/i.test(e));
    report('no page JS errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));

    console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
    await page.close();
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST HARNESS ERROR:', e.message); process.exit(2); });
```

- [ ] **Step 2: Start test infrastructure and run the test to verify it fails**

```bash
cd ~/flytab/web && python3 -m http.server 8123 &
google-chrome --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/ds-test-profile --no-first-run --disable-gpu about:blank &
sleep 4
cd ~/flytab && NODE_PATH=~/flytab/node_modules node tools/test-data-status-cycles.e2e.js
```

Expected: multiple `FAIL` lines — at minimum "sectional: server line shows cycle+exp+real size" (current code shows `~1,800 MB available`, no cycle text at all), "ifr-low: CURRENT badge with days-left" (current code shows static `ON DEVICE`, no day count), "needsSync true when ONLY tac is missing" (current code's needsSync only checks sectional/ifr-low, so it will be `false`). Confirm the failures are these specific, expected ones — not a crash or an unrelated error.

- [ ] **Step 3: Implement the card content, badge, and needsSync changes**

In `web/cockpit/data-status.js`, replace the block from `// ── MBTiles sections ──` through the `needsSync` declaration (currently lines 325–376) with:

```js
        // ── MBTiles sections ──────────────────────────────────────────────────
        const TILE_LAYERS = [
            { layer: 'sectional', label: 'Sectional Charts (z5–11)',               approxMb: 1800 },
            { layer: 'ifr-low',   label: 'IFR Low Enroute (z4–10, 512px retina)',  approxMb: 600  },
            { layer: 'ifr-area',  label: 'IFR Area Charts (z10–12)',               approxMb: 150  },
            { layer: 'tac',       label: 'Terminal Area Charts (z8–12) — VFR Flyways', approxMb: 250 },
        ];
        const tileStates = []; // captured per-layer so "Sync All" can reuse it below without recomputing
        const mbtilesHtml = TILE_LAYERS.map(({ layer, label, approxMb }) => {
            const entry = mbt.find(l => l.layer === layer);
            const sTile = serverManifest?.tiles?.[layer] || null;
            const dTile = deviceManifest?.tiles?.[layer] || null;
            const tileUpdateAvail = (() => {
                if (!entry?.exists || !sTile || !dTile) return false;
                // Sectional/TAC/IFR tiles run a 56-day cycle; NASR runs 28-day.
                // When expiration_date is present use it — avoids false positives
                // after a NASR-only refresh where cycle_date legitimately differs.
                if (sTile.expiration_date) {
                    const today = new Date().toISOString().slice(0, 10);
                    return today > sTile.expiration_date;
                }
                return sTile.cycle_date !== dTile.cycle_date || sTile.built_at !== dTile.built_at;
            })();
            tileStates.push({ layer, exists: !!entry?.exists, updateAvail: tileUpdateAvail });

            const sizeMb = sTile?.size_mb ?? approxMb;
            let serverLine, devLine, badge, action = '';

            if (!base) {
                serverLine = '<span class="ds-muted">Server not reachable</span>';
            } else if (sTile?.cycle_date) {
                const expStr = sTile.expiration_date ? ` &rarr; exp ${sTile.expiration_date}` : '';
                serverLine = `Cycle ${sTile.cycle_date}${expStr}<br><span class="ds-muted">~${sizeMb.toLocaleString()} MB</span>`;
            } else {
                serverLine = '<span class="ds-muted">Unavailable</span>';
            }

            if (entry?.exists) {
                const cycleStr = dTile?.cycle_date ? `Cycle ${dTile.cycle_date}` : 'On tablet';
                const builtStr = dTile?.built_at ? ` (built ${dTile.built_at.slice(0, 10)})` : '';
                devLine = `${cycleStr}${builtStr}<br><span class="ds-muted">${(entry.size_mb || 0).toLocaleString()} MB on tablet</span>`;

                if (tileUpdateAvail) {
                    badge  = this._badge('UPDATE AVAILABLE', 'yellow');
                    action = base ? `<button class="ds-action-btn ds-update ds-mbt-dl-btn" data-layer="${layer}">RE-DOWNLOAD</button>` : '';
                } else {
                    const expDate = sTile?.expiration_date ? new Date(sTile.expiration_date)
                                  : dTile?.expiration_date ? new Date(dTile.expiration_date) : null;
                    badge  = expDate ? this._cycleStatus(expDate, now) : this._badge('ON DEVICE', 'green');
                    action = base ? `<button class="ds-action-btn ds-secondary ds-mbt-dl-btn" data-layer="${layer}">SYNC</button>` : '';
                }
            } else {
                devLine = '<span class="ds-muted">Not downloaded</span>';
                badge   = this._badge('NOT DOWNLOADED', 'gray');
                if (base) action = `<button class="ds-action-btn ds-mbt-dl-btn" data-layer="${layer}">DOWNLOAD (~${sizeMb.toLocaleString()} MB)</button>`;
            }

            return this._section(label, serverLine, devLine, badge, action, '', true);
        }).join('');

        // ── Need Sync? ────────────────────────────────────────────────────────
        const needsSync = !!base && (
            aeroUpdateAvail ||
            (serverHasPlates && (!cycleOkForStates || serverStates.some(s => !syncedStates.includes(s)))) ||
            tileStates.some(t => !t.exists || t.updateAvail)
        );
```

Note: `_section()`'s 7th parameter (`multilineDevice`) is now passed as `true` — the tablet line contains a `<br>` (cycle+built on one line, size on the next), the same multi-line treatment Plates already uses for its state chips.

- [ ] **Step 4: Run the test again to verify it passes**

```bash
cd ~/flytab && NODE_PATH=~/flytab/node_modules node tools/test-data-status-cycles.e2e.js
```

Expected: `ALL TESTS PASSED` (typography assertions don't exist yet in this file — they're added in Task 2 — so every assertion currently in the file should pass).

- [ ] **Step 5: Commit**

```bash
cd ~/flytab
git add web/cockpit/data-status.js tools/test-data-status-cycles.e2e.js
git commit -m "$(cat <<'EOF'
feat(data-status): Offline Maps cards show cycle/expiration like Aeronautical Database

Sectional/IFR-Low/IFR-Area/TAC cards previously showed only file size with a
static ON DEVICE badge. flytab-pipeline's build_mbtiles.py already writes
cycle_date/expiration_date/built_at per layer into manifest.json, and this
file already read those fields internally for update detection — they were
just never displayed. Cards now show Cycle/expiration on the primary line
(size as a secondary detail) and use the same _cycleStatus() traffic-light
badge as Aeronautical Database and Plates.

"Sync All Outdated" previously only checked existence of sectional/ifr-low,
silently ignoring ifr-area/tac and ignoring expiration entirely. It now
derives from the same per-layer tileUpdateAvail computation already run
while building the cards, so the two checks cannot drift out of sync.

Verified with tools/test-data-status-cycles.e2e.js: all four badge states
(not-downloaded/current/expiring/update-available) across the four layers,
the needsSync regression this fixes (a missing tac/ifr-area layer previously
did not trigger Sync All), and the migrated-device fallback (no fabricated
cycle date when the device manifest predates this feature).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Typography token bump

**Files:**
- Modify: `web/style.css` (the `.ds-*` rules, currently around lines 3080–3370)
- Modify: `web/cockpit/data-status.js:304` (remove the one-off inline `font-size:10px`)
- Modify: `tools/test-data-status-cycles.e2e.js` (append typography assertions)

**Interfaces:**
- Consumes: the DOM structure and class names Task 1 already produces (`.ds-section-card`, `.ds-section-name`, `.ds-section-badge`, `.ds-badge`, `.ds-inv-label`, `.ds-row-value`, `.ds-muted`, `.ds-action-btn`, `.ds-action-btn.ds-secondary`, `.ds-section-title`, `.ds-state-chip`) — no new classes introduced.
- Produces: nothing consumed by a later task — this is the last task's CSS half.

- [ ] **Step 1: Write the failing typography assertions**

Append to `tools/test-data-status-cycles.e2e.js`, immediately before the `const relevant = errors.filter(...)` line (the page is already showing Task 1's final `_render()` call — the single-sectional-card state — from the end of the previous section):

```js
    // ---------- Typography: page-wide token bump (CLAUDE.md Design Token Standards) ----------
    const typo = await page.evaluate(() => {
        const body = window.app.dataStatus._el.querySelector('.data-status-body');
        // _render() draws Aeronautical Database/Terrain/Plates cards too (from the same
        // call, with mostly-empty fixture data) — the first .ds-section-card in the DOM
        // is Aeronautical Database, not Sectional. Select by title, same as Task 1.
        const card = [...body.querySelectorAll('.ds-section-card')]
            .find(c => c.querySelector('.ds-section-name')?.textContent.includes('Sectional'));
        const cs = (el) => el ? getComputedStyle(el) : null;
        const nameEl   = card.querySelector('.ds-section-name');
        const badgeEl  = card.querySelector('.ds-section-badge .ds-badge');
        const labelEl  = card.querySelector('.ds-inv-label');
        const valueEl  = card.querySelector('.ds-inv-row .ds-row-value'); // the primary "Cycle ..." line's span
        const mutedEl  = card.querySelector('.ds-row-value .ds-muted');  // the "~MB" subline
        const primaryBtn = card.querySelector('.ds-action-btn:not(.ds-secondary)');
        return {
            name:  { size: cs(nameEl).fontSize,  weight: cs(nameEl).fontWeight },
            badge: { size: cs(badgeEl).fontSize, weight: cs(badgeEl).fontWeight },
            label: { size: cs(labelEl).fontSize, weight: cs(labelEl).fontWeight },
            value: { size: cs(valueEl).fontSize, weight: cs(valueEl).fontWeight },
            muted: { size: cs(mutedEl).fontSize, weight: cs(mutedEl).fontWeight },
            primaryBtn: primaryBtn ? { size: cs(primaryBtn).fontSize, weight: cs(primaryBtn).fontWeight } : null,
        };
    });

    report('.ds-section-name is 17px / weight>=800', typo.name.size === '17px' && parseInt(typo.name.weight) >= 800, JSON.stringify(typo.name));
    report('.ds-badge is weight>=700 (inherits 15px from .ds-section-badge)', typo.badge.size === '15px' && parseInt(typo.badge.weight) >= 700, JSON.stringify(typo.badge));
    report('.ds-inv-label is 13px / weight>=700', typo.label.size === '13px' && parseInt(typo.label.weight) >= 700, JSON.stringify(typo.label));
    report('.ds-row-value is 15px / weight>=700 (was unset/400 — the CLAUDE.md violation)', typo.value.size === '15px' && parseInt(typo.value.weight) >= 700, JSON.stringify(typo.value));
    report('.ds-muted subline is 13px / weight>=600', typo.muted.size === '13px' && parseInt(typo.muted.weight) >= 600, JSON.stringify(typo.muted));
    report('.ds-action-btn (primary) is 15px / weight>=700', typo.primaryBtn?.size === '15px' && parseInt(typo.primaryBtn?.weight) >= 700, JSON.stringify(typo.primaryBtn));
```

- [ ] **Step 2: Run the test to verify the new assertions fail**

```bash
cd ~/flytab && NODE_PATH=~/flytab/node_modules node tools/test-data-status-cycles.e2e.js
```

Expected: all previously-passing assertions from Task 1 still `PASS`; the six new typography assertions `FAIL` (current sizes are 15px/13px/11px/13px/12px/13px, current `.ds-row-value` weight is `400`).

- [ ] **Step 3: Implement the CSS token changes**

In `web/style.css`:

```css
/* was: .ds-section-name { font-weight: 600; font-size: 15px; } */
.ds-section-name {
    font-weight: 800;
    font-size: 17px;
}
/* was: .ds-section-badge { font-size: 13px; font-weight: 600; ... } */
.ds-section-badge {
    font-size: 15px;
    font-weight: 700;
    flex-shrink: 0;
    margin-left: 8px;
    text-align: right;
}
/* was: .ds-badge { font-weight: 600; } */
.ds-badge {
    font-weight: 700;
}
/* was: .ds-inv-row { ... font-size: 13px; ... } */
.ds-inv-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 0;
    font-size: 15px;
    border-top: 1px solid var(--border-light);
}
/* was: .ds-inv-label { ... font-size: 11px; font-weight: 700; ... } */
.ds-inv-label {
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    width: 44px;
    flex-shrink: 0;
    padding-top: 2px;
}
/* was: .ds-row-value { flex: 1; color: var(--text-secondary); line-height: 1.4; }  — no explicit weight, defaulted to 400 */
.ds-row-value {
    flex: 1;
    color: var(--text-secondary);
    line-height: 1.4;
    font-weight: 700;
}
/* was: .ds-muted { color: var(--text-muted); } */
.ds-muted {
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 600;
}
/* was: .ds-action-btn { ... font-size: 13px; font-weight: 700; ... } */
.ds-action-btn {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
}
/* was: .ds-action-btn.ds-secondary { ... font-weight: 600; font-size: 12px; ... } */
.ds-action-btn.ds-secondary {
    background: transparent;
    color: var(--accent);
    font-weight: 700;
    font-size: 14px;
    padding: 6px 10px;
}
/* was: .ds-section-title { font-size: 11px; font-weight: 700; ... } */
.ds-section-title {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 16px 0 8px;
}
/* was: .ds-state-chip { ... font-size: 12px; font-weight: 600; ... } */
.ds-state-chip {
    display: inline-block;
    font-size: 13px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    margin: 2px 2px 2px 0;
    background: var(--bg-surface-raised);
}
```

`.ds-muted` gaining an explicit `font-size: 13px` means the one remaining inline override is now redundant. In `web/cockpit/data-status.js`, find (around line 304):

```js
const platesIncludesNote = '<span class="ds-muted" style="font-size:10px">Includes: IAP &middot; DP &middot; STAR &middot; Airport Diagrams (DIAG) &middot; Airport Info (A/FD)</span>';
```

Replace with:

```js
const platesIncludesNote = '<span class="ds-muted">Includes: IAP &middot; DP &middot; STAR &middot; Airport Diagrams (DIAG) &middot; Airport Info (A/FD)</span>';
```

- [ ] **Step 4: Run the test to verify everything passes**

```bash
cd ~/flytab && NODE_PATH=~/flytab/node_modules node tools/test-data-status-cycles.e2e.js
```

Expected: `ALL TESTS PASSED` — every assertion from both Task 1 and Task 2.

- [ ] **Step 5: Commit**

```bash
cd ~/flytab
git add web/style.css web/cockpit/data-status.js tools/test-data-status-cycles.e2e.js
git commit -m "$(cat <<'EOF'
fix(data-status): bump Data & Maps typography — .ds-row-value had no font-weight at all

.ds-row-value (the actual cycle/expiration/size text pilots read on every
card across Aeronautical Database, Terrain, Plates, and Offline Maps) had no
explicit font-weight, defaulting to 400 — violating this repo's own CLAUDE.md
Design Token Standards ("never use font-weight: 600 or lower in cockpit
UI") and the sunlight-readability requirement (weight >=600 for data).
Bumped the whole .ds-* typography scale used by this page: card titles to
17px/800, badges to 15px/700, body text to 15px/700, labels to 13px/700,
buttons to 15px/700 (secondary 14px/700). Since every section on the page
shares these classes, this fixes all four sections at once, not just
Offline Maps.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Version bump, build, and live verification

**Files:**
- Modify: `web/app.js` (FLYTAB_VERSION)
- No other files — this task runs `build.sh` (which syncs `android/app/build.gradle` automatically) and performs a manual live-browser check.

**Interfaces:**
- Consumes: nothing new — this task verifies Tasks 1–2's output against the real home server rather than fixtures.
- Produces: nothing consumed by a later task (terminal task).

- [ ] **Step 1: Bump FLYTAB_VERSION**

Read `web/app.js` line 6 to get the current value, then increment the patch number by 1 (e.g. `v9.89` → `v9.90` — check the actual current value first, don't assume; CLAUDE.md's `feedback_android_version_format` note: no three digits after the decimal, e.g. never `v9.100` — go to `v10.0` before that point).

- [ ] **Step 2: Start test infrastructure and confirm the real home server is reachable**

```bash
curl -s -m 3 http://192.168.1.77:8090/manifest.json | python3 -c "import json,sys; m=json.load(sys.stdin); print('tiles:', list(m.get('tiles',{}).keys()))"
```

Expected: `tiles: ['sectional', 'ifr-low', 'tac', 'ifr-area']` (or a subset, if the pipeline hasn't rebuilt all four recently — that's fine, it's real production data, not a test failure).

- [ ] **Step 3: Live verification via claude-in-chrome (real taps, not headless)**

Use the claude-in-chrome MCP tools (per this repo's established pattern this session — real clicks catch bugs headless `.click()` misses, e.g. `pointer-events: none`). Navigate to `http://localhost:8123/index.html` (start `python3 -m http.server 8123` from `web/` if not already running), open MORE → Data Status, and confirm:

1. The "Aviation Data" section's Aeronautical Database, Terrain, and Approach Plates & A/FD cards still render correctly (unchanged) and are visibly larger/bolder than before.
2. The "Offline Maps" section shows all four layers with cycle date + expiration date on the Server line, and (for any layer already downloaded to this dev machine, if any) cycle date + built date on the Tablet line.
3. Whatever real badge state the live manifest is currently in (most likely CURRENT, since the pipeline just ran) renders with the correct color and day count.
4. Take a full-page screenshot and visually confirm no text overflows or wraps awkwardly at the tablet's typical viewport width — the typography bump increased every size on this page simultaneously.
5. Tap into "Supplemental & Advanced" and confirm the Plates "Includes: IAP · DP · STAR..." note (the one inline `font-size:10px` override removed in Task 2) now renders at the new `.ds-muted` size, not still-tiny leftover text.

- [ ] **Step 4: Build**

```bash
cd ~/flytab && bash build.sh
```

Expected: `BUILD SUCCESSFUL`, and `android/app/build.gradle`'s `versionCode`/`versionName` match the new `FLYTAB_VERSION` from Step 1.

- [ ] **Step 5: Commit**

```bash
cd ~/flytab
git add web/app.js android/app/build.gradle
git commit -m "$(cat <<'EOF'
chore(build): version bump for Offline Maps cycle-framework parity release

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Design §1 (per-layer card content, server/tablet lines, size preference, migrated-device fallback) → Task 1.
- Design §2 (Sync All existence+expiration for all 4 layers) → Task 1 (`tileStates` derivation).
- Design §3 (no separate secondary RE-DOWNLOAD button) → Task 1 implementation (only one `action` variable per branch, never both primary+secondary).
- Design §4 (typography token table) → Task 2, every row in the table has a corresponding CSS rule and assertion.
- Design "Out of scope" (no pipeline changes, no download-handler changes) → respected; Task 1's diff never touches `_downloadMbtiles`, `_wireDataSections`, or anything under `flytab-pipeline`.
- Design testing plan items 1, 2, 4 → Task 1's three scenarios. Item 3 (button still triggers `_downloadMbtiles`) is out of scope for new testing since that handler is unchanged (`.ds-mbt-dl-btn` class-based, doesn't branch on label). Item 5 (visual check) → Task 3 Step 3.

**Placeholder scan:** No TBD/TODO. Every code step has complete, runnable code. Task 3 Step 1 asks the implementer to read a live value rather than hardcoding a version number that would go stale by the time this task runs — that's a deliberate "read current state" instruction, not a placeholder.

**Type consistency:** `_render(serverManifest, deviceManifest, mbtStatus)` signature used identically in Task 1's test and in the existing `_refresh()` caller. `_section(title, serverVal, deviceVal, badge, primaryBtn, secondaryBtn, multilineDevice)` — Task 1 passes all 7 positional args matching the existing declared signature. `tileStates` (array of `{layer, exists, updateAvail}`) is defined and consumed entirely within Task 1 — no cross-task dependency on its shape. CSS class names in Task 2's assertions (`.ds-section-name`, `.ds-section-badge`, `.ds-badge`, `.ds-inv-label`, `.ds-row-value`, `.ds-muted`, `.ds-action-btn`) match the classes Task 1's `_section()` calls actually emit (unchanged from the existing `_section()` template).
