// tests/shared/app-restart-report.test.js
//
// After FlyTab restarts itself because the WebView renderer died (MainActivity
// handleRendererGone -> AppHealth), the next launch logs what happened and
// tells the pilot in one toast, together with what became of the recording.
// Exercises the REAL _recoverAfterRestart / restartMessage bodies from web/app.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

function extractMethod(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`method not found: ${signature}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
    }
    throw new Error('unbalanced braces');
}

const appSrc = readFileSync('web/app.js', 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const recoverAfterRestart = new AsyncFunction(extractMethod(appSrc, 'async _recoverAfterRestart() {'));
const restartMessage = new Function('lastEvent', 'recovery', extractMethod(appSrc, 'static restartMessage(lastEvent, recovery) {'));
const describeEvent = new Function('e', extractMethod(appSrc, 'static describeRendererEvent(e) {'));
process.env.TZ = 'America/New_York';

const CRASH = { at: Date.parse('2026-10-14T16:11:53Z'), didCrash: true, priority: 2, action: 'RESTART' };

describe('restart report', () => {
    let app;
    beforeEach(() => {
        global.DiagLog = { log: vi.fn() };
        global.FlyTabApp = { restartMessage, describeRendererEvent: describeEvent };
        app = {
            showToast: vi.fn(),
            flightRecorder: { recoverUnfinished: vi.fn(async () => 'resumed') },
        };
        window.Capacitor = { Plugins: { AppHealth: { takeRendererEvents: vi.fn(async () => ({ events: [CRASH] })) } } };
    });

    it('10-14 replay: logs the crash and tells the pilot, with the recording resumed', async () => {
        await recoverAfterRestart.call(app);
        expect(DiagLog.log).toHaveBeenCalledWith('error', expect.stringMatching(/renderer crashed at 12:11:53.*restarted itself/i), { priority: 2 });
        expect(app.showToast).toHaveBeenCalledTimes(1);
        expect(app.showToast.mock.calls[0][0]).toMatch(/restarted itself.*12:11.*Recording resumed/i);
    });

    it('a renderer killed by Android (memory) in the background is described as such', () => {
        const e = { ...CRASH, didCrash: false, action: 'CLOSE_IN_BACKGROUND' };
        expect(describeEvent(e)).toMatch(/closed by Android.*background/i);
        expect(restartMessage(e, null)).toMatch(/closed/i);
    });

    it('a crash loop says FlyTab stopped restarting itself', () => {
        expect(describeEvent({ ...CRASH, action: 'GIVE_UP' })).toMatch(/stopped restarting/i);
        expect(restartMessage({ ...CRASH, action: 'GIVE_UP' }, 'resumed')).toMatch(/kept crashing.*stopped restarting.*Recording resumed/i);
    });

    it('no renderer event, recording resumed (e.g. Android ended FlyTab): toast about the recording only', async () => {
        window.Capacitor.Plugins.AppHealth.takeRendererEvents = vi.fn(async () => ({ events: [] }));
        await recoverAfterRestart.call(app);
        expect(app.showToast.mock.calls[0][0]).toMatch(/^Recording resumed/);
    });

    it('closed out an old recording: says so', () => {
        expect(restartMessage(null, 'closed')).toMatch(/previous recording.*logbook/i);
    });

    it('nothing to report: no toast', async () => {
        window.Capacitor.Plugins.AppHealth.takeRendererEvents = vi.fn(async () => ({ events: [] }));
        app.flightRecorder.recoverUnfinished = vi.fn(async () => null);
        await recoverAfterRestart.call(app);
        expect(app.showToast).not.toHaveBeenCalled();
    });

    it('no AppHealth plugin (browser) or a failing one: recording recovery still runs', async () => {
        window.Capacitor = undefined;
        await recoverAfterRestart.call(app);
        expect(app.flightRecorder.recoverUnfinished).toHaveBeenCalled();
        window.Capacitor = { Plugins: { AppHealth: { takeRendererEvents: vi.fn(async () => { throw new Error('boom'); }) } } };
        await recoverAfterRestart.call(app);
        expect(DiagLog.log).toHaveBeenCalledWith('error', expect.stringMatching(/AppHealth.*boom/));
        expect(app.showToast).toHaveBeenLastCalledWith(expect.stringMatching(/^Recording resumed/));
    });
});
