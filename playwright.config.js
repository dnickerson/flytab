// playwright.config.js
const { defineConfig, devices } = require('@playwright/test');

// The test server's own port. It was 3000 with reuseExistingServer: on the dev
// machine 3000 is Open WebUI (docker), which answers 200 for every path, so
// Playwright silently ran the whole suite against Open WebUI: 51/53 "failed"
// with every harness global undefined (found 2026-10-15). A dedicated port, and
// never reusing a server we didn't start: a busy port now fails loudly instead.
const PORT = Number(process.env.FLYTAB_TEST_PORT) || 3117;

module.exports = defineConfig({
    testDir: './tests',
    timeout: 30_000,
    fullyParallel: false,
    retries: 0,
    globalSetup:    './tests/fixtures/global-setup.js',
    globalTeardown: './tests/fixtures/global-teardown.js',
    snapshotDir:    './tests/snapshots',
    use: {
        baseURL: `http://localhost:${PORT}`,
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
                // Map the Pi's real IP to localhost so EngineClient's hardcoded
                // 192.168.10.1:8082 resolves to fake-engine.js on 127.0.0.1:8082.
                launchOptions: {
                    args: ['--host-rules=MAP 192.168.10.1 127.0.0.1'],
                },
            },
        },
    ],
    webServer: {
        command: `npx serve . -p ${PORT} --no-clipboard --cors`,
        url: `http://localhost:${PORT}/web/index.html`,
        reuseExistingServer: false,
        timeout: 15_000,
    },
});
