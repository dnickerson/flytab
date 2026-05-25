// tests/smoke/startup.spec.js
'use strict';
const { test, expect } = require('@playwright/test');
const { injectTestConfig } = require('./helpers.js');

// Relative to baseURL (http://localhost:3000)
const APP = '/web/index.html';

// Console errors that are expected/harmless when hardware is not present:
// - Stratux WebSocket failures (no real Stratux in test environment)
// - Engine WebSocket failures (engine client tries real Pi IP; WS is not mocked here)
// - favicon 404
// - net::ERR_* (network errors reaching external services)
// - AWC / weather endpoint failures (external services not mocked)
// - geo_context.json: optional geodata not served by home server in all environments
// - 404: various optional resources the app degrades gracefully without
const EXPECTED_ERROR_PATTERNS = [
    /favicon/i,
    /net::ERR/i,
    /stratux/i,
    /engine/i,
    /websocket/i,
    /failed to fetch/i,
    /load failed/i,
    /aborted/i,
    /avmet|airsigmet|metar|taf|pirep|notam|weather|gairmet|flywhere/i,
    /9090/,                         // NanoHTTPD not running in test env
    /192\.168/,                     // Real hardware IPs unreachable in test env
    /geo_context/i,                 // Optional geodata file; app degrades gracefully without it
    /file not found/i,              // serve returns this for 404 on missing optional assets
    /not found/i,                   // Generic 404 phrasing for optional resources
];

function isExpectedError(text) {
    return EXPECTED_ERROR_PATTERNS.some(p => p.test(text));
}

test.describe('app startup @smoke', () => {
    // Each test gets a fresh Playwright browser context (clean IDB, localStorage, cookies).
    // injectTestConfig() must be called before page.goto() — it installs a route handler.

    test('loads without unexpected console errors', async ({ page }) => {
        const errors = [];
        page.on('console', msg => {
            if (msg.type() === 'error') errors.push(msg.text());
        });
        // Track failed requests for diagnostic output (not asserted on)
        const failed404s = [];
        page.on('response', resp => {
            if (resp.status() === 404) failed404s.push(resp.url());
        });

        await injectTestConfig(page);
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // Give async init time to settle (NASR import, module init, etc.)
        await page.waitForTimeout(4000);

        const fatal = errors.filter(e => !isExpectedError(e));
        if (fatal.length > 0) {
            console.log('Unexpected console errors:', fatal);
            console.log('404 URLs:', failed404s.slice(0, 10));
        }
        expect(fatal).toHaveLength(0);
    });

    test('home server reachable — cycle_info.json returns valid structure', async ({ request }) => {
        // Use Playwright's API request context (not the browser page) to bypass
        // page.route handlers and check the real server endpoint.
        // In dev environment the real home server runs on 8090; in CI the mock does.
        let cycleInfo = null;
        try {
            const resp = await request.get('http://localhost:8090/nasr/cycle_info.json');
            if (resp.ok()) {
                cycleInfo = await resp.json();
            }
        } catch {
            // server not running — test will fail below
        }

        expect(cycleInfo).not.toBeNull();
        expect(typeof cycleInfo.effective_date).toBe('string');
        expect(typeof cycleInfo.bundle_version).toBe('number');
    });

    test('NasrDB class exists and app initializes cockpit', async ({ page }) => {
        await injectTestConfig(page);
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // Wait for app.init() to run (DOMContentLoaded handler) and settle
        await page.waitForTimeout(4000);

        // NasrDB class must be defined (loaded via <script> tag in index.html)
        const classExists = await page.evaluate(() => typeof NasrDB !== 'undefined');
        expect(classExists).toBe(true);

        // window.app is set synchronously (line 2103 in app.js) and _nasrDb is
        // assigned inside _initCockpit — check the app object exists
        const appExists = await page.evaluate(() => typeof window.app !== 'undefined');
        expect(appExists).toBe(true);

        // Use the app's existing NasrDB instance (avoids opening a second IDB connection
        // which can block if the first import transaction is still running)
        const nasrDbReady = await page.evaluate(() => {
            // _nasrDb is set synchronously at the start of _initCockpit
            return window.app?._nasrDb != null;
        });
        expect(nasrDbReady).toBe(true);
    });
});
