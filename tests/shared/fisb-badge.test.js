/**
 * The FIS-B badge stayed red the whole 10-27 KTBR-KLKR flight while FlyTab
 * received FIS-B every minute (12,177 METARs, 10,646 NEXRAD frames in its
 * weather log). It went by the Stratux /getStatus counters alone, and a reply
 * was never aged: one from the ground (UAT 0) could stand for the whole flight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
const FisbClient = new Function(read('web/shared/fisb-client.js') + '\nreturn FisbClient;')();

const NOW = Date.parse('2026-10-27T21:20:00Z');
const inFlight = { UATRadio_connected: true, UAT_messages_last_minute: 412 };
const onGround = { UATRadio_connected: true, UAT_messages_last_minute: 0 };

describe('FisbClient.isReceiving (FIS-B badge)', () => {
    const at = (o) => FisbClient.isReceiving({ now: NOW, lastRxAt: 0, connected: true, status: null, statusAt: 0, ...o });

    it('replay of 10-27: FIS-B arriving, /getStatus last answered on the ground -> green', () => {
        expect(at({ lastRxAt: NOW - 20_000, status: onGround, statusAt: NOW - 50 * 60_000 })).toBe(true);
    });

    it('nothing from FlyTab for 2 min and only an old /getStatus -> red', () => {
        expect(at({ lastRxAt: NOW - 121_000, status: inFlight, statusAt: NOW - 31_000 })).toBe(false);
    });

    it('fresh /getStatus with UAT messages -> green, SDR dongle (no UATRadio board) too', () => {
        expect(at({ status: inFlight, statusAt: NOW - 5_000 })).toBe(true);
        expect(at({ status: { UATRadio_connected: false, UAT_messages_last_minute: 90 }, statusAt: NOW - 5_000 })).toBe(true);
    });

    it('fresh /getStatus with no UAT messages (home, on the ground) -> red', () => {
        expect(at({ status: onGround, statusAt: NOW - 5_000 })).toBe(false);
    });

    it('Stratux link down: its /getStatus counts no more; FIS-B FlyTab just received still does', () => {
        expect(at({ connected: false, status: inFlight, statusAt: NOW - 5_000 })).toBe(false);
        expect(at({ connected: false, lastRxAt: NOW - 5_000 })).toBe(true);
    });

    it('never received anything -> red; a clock step backwards does not count as fresh', () => {
        expect(at({})).toBe(false);
        expect(at({ lastRxAt: NOW + 60_000 })).toBe(false);
    });
});

describe('FisbClient notes when FIS-B arrives', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
    afterEach(() => vi.useRealTimers());
    const client = () => new FisbClient(new EventTarget(), null);

    it('a weather report, a NEXRAD frame and another FIS-B frame each set lastRxAt', async () => {
        let c = client();
        expect(c.lastRxAt).toBe(0);
        await c._handleWeather({ Type: 'METAR', Location: 'KTBR', Data: 'METAR KTBR 272055Z 24008KT 10SM CLR 24/09 A3005' });
        expect(c.lastRxAt).toBe(NOW);

        c = client();
        c._handleNexrad({ NEXRAD: [] });
        expect(c.lastRxAt).toBe(NOW);

        c = client();
        c._handleFisbFrame({ Product_id: 413, FISB_data: [] });
        expect(c.lastRxAt).toBe(NOW);
    });

    it('an empty weather message is not reception', async () => {
        const c = client();
        await c._handleWeather({});
        expect(c.lastRxAt).toBe(0);
    });
});

describe('StratuxClient /getStatus poll: aged and diagnosed', () => {
    let StratuxClient;
    beforeEach(() => {
        vi.useFakeTimers(); vi.setSystemTime(NOW);
        global.CockpitConfig = { raw: {} };
        global.Settings = { stratuxIp: '192.168.10.1', ownshipModeS: '000000' };
        DiagLog.log.mockClear();
        StratuxClient = new Function(read('web/shared/stratux-client.js') + '\nreturn StratuxClient;')();
    });
    afterEach(() => { vi.useRealTimers(); delete global.fetch; });

    it('a good reply records when it came; failing is logged once, and answering again', async () => {
        let mode = 'ok';
        global.fetch = vi.fn(async () => {
            if (mode === 'down') throw new TypeError('Failed to fetch');
            return { ok: true, status: 200, json: async () => inFlight };
        });
        const c = new StratuxClient();
        c._pollStatus();
        await vi.advanceTimersByTimeAsync(0);
        expect(c.deviceStatus).toEqual(inFlight);
        expect(c.deviceStatusAt).toBe(NOW);

        mode = 'down';
        await vi.advanceTimersByTimeAsync(30_000);              // three failed polls
        expect(c.deviceStatusAt).toBe(NOW);                     // the old reply keeps its time
        const failing = DiagLog.log.mock.calls.filter(([, m]) => /getStatus failing/.test(m));
        expect(failing).toHaveLength(1);
        expect(failing[0][1]).toContain('Failed to fetch');

        mode = 'ok';
        await vi.advanceTimersByTimeAsync(10_000);
        expect(DiagLog.log.mock.calls.filter(([, m]) => /getStatus answering again/.test(m))).toHaveLength(1);
        expect(c.deviceStatusAt).toBe(NOW + 40_000);
        clearInterval(c._statusTimer);
    });

    it('an HTTP error is a failure too, and keeps the last good reply', async () => {
        global.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
        const c = new StratuxClient();
        c._pollStatus();
        await vi.advanceTimersByTimeAsync(0);
        expect(c.deviceStatus).toBeNull();
        expect(c.deviceStatusAt).toBe(0);
        expect(DiagLog.log).toHaveBeenCalledWith('stratux', 'getStatus failing: HTTP 503');
        clearInterval(c._statusTimer);
    });
});
