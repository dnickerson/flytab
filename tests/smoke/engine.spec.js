// tests/smoke/engine.spec.js
'use strict';
const { test, expect } = require('@playwright/test');
const { injectTestConfig } = require('./helpers.js');

const APP = '/web/index.html';

test.describe('engine WebSocket smoke @smoke', () => {
    test('engine client connects to fake-engine and receives data', async ({ page }) => {
        // The smoke project's launchOptions map 192.168.10.1 → 127.0.0.1 via --host-rules
        // so EngineClient's hardcoded IP connects to fake-engine.js on localhost.
        // fake-engine.js is started by global-setup.js with ENG_WS_PORT=8082.
        await injectTestConfig(page);
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });

        // Wait for app to initialize and expose window.engineClient
        await page.waitForFunction(() => window.engineClient != null, { timeout: 10_000 });

        // Allow up to 8 seconds for the WS to connect and receive at least one frame.
        // fake-engine emits at 5Hz so the first frame should arrive within 200ms of connection.
        await page.waitForFunction(
            () => window.engineClient?.lastData != null,
            { timeout: 8_000 },
        );

        const lastData = await page.evaluate(() => window.engineClient.lastData);
        expect(lastData).not.toBeNull();
        // Verify canonical Pi engine-monitor frame shape (v3.3.0 — nested data object)
        expect(lastData.version).toBe('3.3.0');
        expect(lastData.capturing).toBe(true);
        expect(typeof lastData.data?.RPM).toBe('number');
        expect(lastData.data.RPM).toBeGreaterThan(0);
    });
});
