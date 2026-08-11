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
    // Updated for the Critical #2 fix: a migrated device has NO recorded cycle_date
    // (seeded as {} — see the "no version — forces update check on next sync" comment
    // in _readOrMigrateDeviceManifest()), so cycle_date always mismatches the server's
    // and the layer must be flagged UPDATE AVAILABLE, not a guessed CURRENT. Before the
    // fix, tileUpdateAvail short-circuited on expiration_date and never looked at
    // cycle_date, so this case wrongly showed CURRENT — exactly the false-positive the
    // reviewer flagged.
    report('migrated device: badge is UPDATE AVAILABLE (unknown cycle must not be assumed current)',
        /UPDATE AVAILABLE/.test(scenarioC.badge), scenarioC.badge);

    // ---------- Scenario D: server rolled to a newer cycle, but the server's OWN
    // current cycle hasn't expired yet. Regression for the reviewer's Critical #2:
    // the old code only compared expiration_date and never noticed the device was
    // still sitting on the prior cycle, so it kept showing a false CURRENT badge. ----------
    const scenarioD = await page.evaluate(() => {
        const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
        // Server has rolled forward to a new cycle with plenty of days left before
        // ITS expiration — the old buggy code short-circuited on this and never
        // looked at cycle_date at all.
        const serverManifest = { tiles: { sectional: { cycle_date: '2026-08-06', expiration_date: addDays(45), built_at: '2026-08-07T00:00:00Z', tile_count: 1, size_mb: 1751 } } };
        // Device is still on the OLD cycle from before the server's rollover.
        const deviceManifest = { tiles: { sectional: { cycle_date: '2026-07-09', expiration_date: addDays(-2), built_at: '2026-07-10T00:00:00Z' } } };
        const mbt = [
            { layer: 'sectional', exists: true, size_mb: 1750 },
            { layer: 'ifr-low', exists: false }, { layer: 'ifr-area', exists: false }, { layer: 'tac', exists: false },
        ];
        window.app.dataStatus._resolvedBase = 'http://192.168.1.77:8090';
        window.app.dataStatus._render(serverManifest, deviceManifest, mbt);
        const body = window.app.dataStatus._el.querySelector('.data-status-body');
        const card = [...body.querySelectorAll('.ds-section-card')].find(c => c.querySelector('.ds-section-name')?.textContent.includes('Sectional'));
        return {
            badge: card?.querySelector('.ds-section-badge')?.textContent.trim(),
            actionText: card?.querySelector('.ds-inv-action button')?.textContent.trim() || null,
            actionHasUpdateClass: !!card?.querySelector('.ds-inv-action button.ds-update'),
            needsSync: window.app.dataStatus._needsSync,
        };
    });
    report('device-behind-server cycle: badge is NOT CURRENT (regression check for false CURRENT claim)',
        !/^●?\s*CURRENT/.test(scenarioD.badge) && !/CURRENT/.test(scenarioD.badge), scenarioD.badge);
    report('device-behind-server cycle: badge is UPDATE AVAILABLE',
        /UPDATE AVAILABLE/.test(scenarioD.badge), scenarioD.badge);
    report('device-behind-server cycle: RE-DOWNLOAD action (highlighted/update style)',
        scenarioD.actionText === 'RE-DOWNLOAD' && scenarioD.actionHasUpdateClass,
        JSON.stringify(scenarioD));
    report('device-behind-server cycle: needsSync true', scenarioD.needsSync === true, scenarioD.needsSync);

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

    const relevant = errors.filter(e => !/favicon|net::|Failed to fetch|NetworkError/i.test(e));
    report('no page JS errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));

    console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
    await page.close();
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST HARNESS ERROR:', e.message); process.exit(2); });
