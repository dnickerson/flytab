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
