/**
 * E2E test: FIS-B NEXRAD via mock-stratux simulator — live canvas + radar loop.
 * mock-stratux emits synthetic Regional+CONUS blocks on /jsonio every 5s,
 * cells drifting east each frame. cockpit-config: simMode=true,
 * frameIntervalMinutes=0.05 (3s) so the loop gets frames quickly.
 */
const { chromium } = require('playwright-core');

const APP = 'http://localhost:8123/index.html';
let failures = 0;
const report = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
};

async function radarState(page) {
    return page.evaluate(() => {
        const app = window.app, cm = app.cockpitMap, rl = app.radarLoop, fn = app.fisbNexrad;
        const ctl = document.querySelector('.radar-loop-controls');
        const badge = document.querySelector('.radar-badge');
        const srcBadge = ctl?.querySelector('.radar-source-badge');
        const timeDisp = ctl?.querySelector('.radar-time-display');
        const scrub = ctl?.querySelector('.radar-scrubber');
        // Count painted pixels on the main FIS-B canvas (sampled)
        let painted = 0;
        const cv = fn?._canvas;
        if (cv && cv.width > 0) {
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
            for (let i = 3; i < d.length; i += 32) if (d[i] > 0) painted++;
        }
        return {
            simBanner: !!document.querySelector('.sim-mode-banner') ||
                       document.body.textContent.includes('SIM MODE'),
            blockCount: fn?._blocks?.size ?? -1,
            frameCount: fn?.frameHistory?.length ?? -1,
            dataAgeMs: fn?.getDataAgeMs?.('regional'),
            effective: cm?._radarSourceEffective,
            badgeText: badge?.textContent?.trim(),
            loopSource: rl?._nexrad?.sourceType,
            loopActive: rl?._active, playing: rl?._playing,
            frameIndex: rl?._frameIndex,
            ctlVisible: !!ctl && getComputedStyle(ctl).display !== 'none' &&
                        ctl.getClientRects().length > 0,
            srcBadgeText: srcBadge?.textContent,
            timeText: timeDisp?.textContent,
            scrubMax: scrub ? +scrub.max : -1,
            painted,
        };
    });
}

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!window.app, null, { timeout: 30000 });
    await page.waitForSelector('.tab-btn[data-tab="layers"]', { timeout: 30000 });
    await page.waitForSelector('.lp-toggle input[data-action="radar"]',
        { state: 'attached', timeout: 30000 });
    await page.waitForTimeout(2500);
    console.log('app booted:', await page.evaluate(() => FLYTAB_VERSION));

    // Sim mode + stratux connection
    const sim = await page.evaluate(() => ({
        simMode: CockpitConfig.get('simMode'),
        connected: window.app.stratuxClient?.connected ?? window.app.stratuxClient?._connected,
    }));
    report('simMode active', sim.simMode === true, JSON.stringify(sim));

    // Enable radar via layer panel toggle (real UI path)
    await page.evaluate(() => document.querySelector('.tab-btn[data-tab="layers"]').click());
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        const input = document.querySelector('.lp-toggle input[data-action="radar"]');
        if (!input.checked) {
            input.checked = true;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        window.app.layerPanel?.close?.();
    });

    // FIS-B blocks arrive from mock (/jsonio every 5s)
    await page.waitForFunction(() => window.app.fisbNexrad?._blocks?.size > 0,
        null, { timeout: 20000 });
    let s = await radarState(page);
    report('FIS-B blocks ingested', s.blockCount >= 5, `blocks=${s.blockCount}`);
    report('regional data age fresh', s.dataAgeMs !== null && s.dataAgeMs < 60000,
        `age=${s.dataAgeMs}ms`);

    // Source auto-selects FIS-B (fresh data beats INET preference resolution)
    await page.waitForFunction(() =>
        window.app.cockpitMap._radarSourceEffective === 'fisb', null, { timeout: 15000 });
    s = await radarState(page);
    report('effective source = fisb', s.effective === 'fisb', s.effective);
    report('radar badge shows FIS-B · Regional',
        /FIS-B · Regional/.test(s.badgeText || ''), s.badgeText);
    // While the loop is still in its INET bootstrap phase the FIS-B canvas is
    // intentionally blank (enterLoopMode cleared it) — painted check comes
    // after the loop switches to the FIS-B renderer below.

    // Loop accumulates ≥2 FIS-B frames (3s snapshot interval, 5s mock cadence)
    await page.waitForFunction(() => window.app.fisbNexrad.frameHistory.length >= 2,
        null, { timeout: 30000 });
    // …and the loop source flips from INET bootstrap to the FIS-B renderer
    await page.waitForFunction(() =>
        window.app.radarLoop._nexrad?.sourceType === 'fisb', null, { timeout: 15000 });
    s = await radarState(page);
    report('loop source = FIS-B renderer', s.loopSource === 'fisb', s.loopSource);
    await page.waitForTimeout(700); // let a loop frame draw
    s = await radarState(page);
    report('FIS-B canvas painted by loop frame', s.painted > 0, `sampled painted px=${s.painted}`);
    report('loop controls visible', s.ctlVisible === true, `visible=${s.ctlVisible}`);
    report('controls source badge FIS-B', s.srcBadgeText === 'FIS-B', s.srcBadgeText);
    report('loop playing', s.playing === true, `playing=${s.playing}`);
    report('time display is a Zulu time', /^\d{2}:\d{2}Z$/.test(s.timeText || ''), s.timeText);

    // Playback advances frames & canvas content changes between frames
    const idxA = (await radarState(page)).frameIndex;
    const paintedA = (await radarState(page)).painted;
    await page.waitForTimeout(1200); // playbackSpeedMs=500 → should advance
    const after = await radarState(page);
    report('frame index advances during playback', after.frameIndex !== idxA,
        `${idxA} → ${after.frameIndex}`);

    // Let a third+ frame accumulate, then verify scrubber max grows with history
    await page.waitForFunction(() => window.app.fisbNexrad.frameHistory.length >= 3,
        null, { timeout: 30000 });
    s = await radarState(page);
    report('scrubber max tracks frame count', s.scrubMax === s.frameCount - 1,
        `max=${s.scrubMax} frames=${s.frameCount}`);

    // Transport: pause, step prev/next deterministically
    await page.evaluate(() => document.querySelector('.radar-loop-controls .radar-play').click());
    await page.waitForTimeout(300);
    s = await radarState(page);
    report('pause works', s.playing === false, `playing=${s.playing}`);
    const i0 = s.frameIndex;
    await page.evaluate(() => document.querySelector('.radar-loop-controls .radar-prev').click());
    await page.waitForTimeout(200);
    const i1 = (await radarState(page)).frameIndex;
    await page.evaluate(() => document.querySelector('.radar-loop-controls .radar-next').click());
    await page.waitForTimeout(200);
    const i2 = (await radarState(page)).frameIndex;
    report('prev/next step frames', i1 !== i0 && i2 === i0, `${i0} → ${i1} → ${i2}`);

    // Frames differ visually: signature = count + positional sum of painted px.
    // Mock cells drift east each frame, so frame 0 and the latest frame must
    // paint at different positions.
    const sig = (frameIdx) => page.evaluate((fi) => {
        const rl = window.app.radarLoop;
        rl._goToFrame(fi < 0 ? rl._nexrad.frameHistory.length - 1 : fi);
        const cv = window.app.fisbNexrad._canvas;
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let n = 0, pos = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { n++; pos = (pos + i) % 1e12; }
        return { n, pos };
    }, frameIdx);
    const p1 = await sig(0);
    const p2 = await sig(-1);
    report('distinct frames render distinct radar (drifting cells)',
        p1.n > 0 && p2.n > 0 && p1.pos !== p2.pos,
        `frame0 px=${p1.n}/sig=${p1.pos}, last px=${p2.n}/sig=${p2.pos}`);
    await page.evaluate(() => window.app.radarLoop.play());

    // Overlay interplay under FIS-B loop (v9.87 fix regression check)
    await page.evaluate(() => document.querySelector('.tab-btn[data-tab="more"]').click());
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        const el = [...document.querySelectorAll('.more-drawer *')]
            .find(e => e.childElementCount === 0 && e.textContent.trim() === 'Fuel Entry');
        (el.closest('button') || el).click();
    });
    await page.waitForTimeout(400);
    s = await radarState(page);
    report('controls hidden under Fuel Entry (loop keeps playing)',
        s.ctlVisible === false && s.playing === true,
        `visible=${s.ctlVisible} playing=${s.playing}`);
    await page.evaluate(() => document.querySelector('#fo-close').click());
    await page.waitForTimeout(400);
    s = await radarState(page);
    report('controls restored after Fuel Entry ✕', s.ctlVisible === true, `visible=${s.ctlVisible}`);

    // Radar off: loop hidden, canvas cleared
    await page.evaluate(() => document.querySelector('.tab-btn[data-tab="layers"]').click());
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        const input = document.querySelector('.lp-toggle input[data-action="radar"]');
        input.checked = false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        window.app.layerPanel?.close?.();
    });
    await page.waitForTimeout(600);
    s = await radarState(page);
    report('radar off → controls gone + canvas cleared',
        s.ctlVisible === false && s.painted === 0,
        `visible=${s.ctlVisible} painted=${s.painted}`);

    const relevant = errors.filter(e => !/favicon|net::|Failed to fetch|NetworkError/i.test(e));
    report('no page JS errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));

    console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
    await page.close();
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST HARNESS ERROR:', e.message); process.exit(2); });
