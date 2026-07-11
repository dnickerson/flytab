/**
 * E2E test: radar loop controls derived visibility (v9.87 fix).
 * Drives the real FlyTab UI in headless Chrome over CDP via playwright-core.
 */
const { chromium } = require('playwright-core');

const APP = 'http://localhost:8123/index.html';
let failures = 0;

function report(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
}

async function state(page) {
    return page.evaluate(() => {
        const el = document.querySelector('.radar-loop-controls');
        const cs = el ? getComputedStyle(el) : null;
        return {
            exists: !!el,
            visible: !!el && cs.display !== 'none' && el.getClientRects().length > 0,
            bodyClass: document.body.classList.contains('fs-overlay-open'),
        };
    });
}

async function expectControls(page, name, wantVisible, wantBodyClass) {
    // Give the MutationObserver a beat to run
    await page.waitForTimeout(250);
    const s = await state(page);
    report(name,
        s.visible === wantVisible && s.bodyClass === wantBodyClass,
        `visible=${s.visible} (want ${wantVisible}), fs-overlay-open=${s.bodyClass} (want ${wantBodyClass})`);
}

async function clickTab(page, tab) {
    await page.evaluate((t) => {
        document.querySelector(`.tab-btn[data-tab="${t}"]`).click();
    }, tab);
    await page.waitForTimeout(300);
}

async function clickDrawerItem(page, label) {
    const ok = await page.evaluate((lbl) => {
        const rows = [...document.querySelectorAll('.more-drawer *')];
        const el = rows.find(e => e.childElementCount === 0 && e.textContent.trim() === lbl)
            || rows.find(e => e.textContent.trim().endsWith(lbl) && e.querySelectorAll('*').length <= 2);
        if (!el) return false;
        (el.closest('button') || el.closest('[class*="row"]') || el).click();
        return true;
    }, label);
    if (!ok) throw new Error(`drawer item not found: ${label}`);
    await page.waitForTimeout(400);
}

async function clickIn(page, selector) {
    const ok = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
    }, selector);
    if (!ok) throw new Error(`element not found: ${selector}`);
    await page.waitForTimeout(300);
}

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.tab-btn[data-tab="layers"]', { timeout: 30000 });
    await page.waitForFunction(() => !!window.app, null, { timeout: 30000 });
    await page.waitForTimeout(2000); // let init settle
    console.log('app booted:', await page.evaluate(() => FLYTAB_VERSION));

    // ---- Enable radar via the layer panel toggle (real UI path) ----
    await clickTab(page, 'layers');
    const toggled = await page.evaluate(() => {
        const input = document.querySelector('.lp-toggle input[data-action="radar"]');
        if (!input) return 'missing';
        if (!input.checked) {
            input.checked = true;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return 'on';
    });
    report('radar toggle found+enabled', toggled === 'on', toggled);
    await page.waitForTimeout(1500); // loop show + INET frames
    await expectControls(page, 'controls visible with layer panel open', true, false);

    // Close layer panel (its ✕)
    await page.evaluate(() => window.app.layerPanel?.close?.() ??
        document.querySelector('.layer-panel .btn-close, .lp-close')?.click());
    await page.waitForTimeout(300);
    await expectControls(page, 'controls visible on map after closing layers', true, false);

    // ---- Core regression: MORE → Fuel Entry → close via its own ✕ ----
    await clickTab(page, 'more');
    await clickDrawerItem(page, 'Fuel Entry');
    await expectControls(page, 'controls hidden while Fuel Entry open', false, true);
    await clickIn(page, '#fo-close');
    await expectControls(page, 'controls RESTORED after Fuel Entry ✕ (the bug)', true, false);

    // ---- MORE → Weight & Balance → close via its ✕ ----
    await clickTab(page, 'more');
    await clickDrawerItem(page, 'Weight & Balance');
    await expectControls(page, 'controls hidden while W&B open', false, true);
    await clickIn(page, '.wb-overlay .btn-close');
    await expectControls(page, 'controls RESTORED after W&B ✕', true, false);

    // ---- MORE → Weather Briefing → close via its ✕ ----
    await clickTab(page, 'more');
    await clickDrawerItem(page, 'Weather Briefing');
    await expectControls(page, 'controls hidden while Wx Briefing open', false, true);
    await clickIn(page, '.wx-briefing-page .wx-close-btn');
    await expectControls(page, 'controls RESTORED after Wx Briefing ✕', true, false);

    // ---- ENG tab → back to MAP ----
    await clickTab(page, 'eng');
    await expectControls(page, 'controls hidden on ENG page', false, true);
    await clickTab(page, 'map');
    await expectControls(page, 'controls restored on MAP tab', true, false);

    // ---- SRC search overlay open/close ----
    await clickTab(page, 'src');
    await expectControls(page, 'controls hidden while search open', false, true);
    await clickIn(page, '.esearch-overlay .btn-close');
    await expectControls(page, 'controls RESTORED after search ✕', true, false);

    // ---- CHK tab then MAP ----
    await clickTab(page, 'chk');
    await expectControls(page, 'controls hidden on checklist', false, true);
    await clickTab(page, 'map');
    await expectControls(page, 'controls restored after checklist', true, false);

    // ---- User manual overlay (childList add/remove path) ----
    await clickTab(page, 'more');
    await clickDrawerItem(page, 'User Manual');
    await expectControls(page, 'controls hidden while manual open', false, true);
    await clickIn(page, '#_manualClose');
    await expectControls(page, 'controls RESTORED after manual close', true, false);

    // ---- Page errors ----
    const relevant = errors.filter(e => !/favicon|net::|Failed to fetch|NetworkError/i.test(e));
    report('no page JS errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));

    console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
    await page.close();
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST HARNESS ERROR:', e.message); process.exit(2); });
