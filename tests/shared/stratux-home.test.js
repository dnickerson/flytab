/**
 * "Use the home Stratux" (MORE -> Configuration). The backup Stratux sits on the
 * home WiFi at 192.168.1.212; FlyTab's Stratux IP is the in-flight 192.168.10.1.
 * The switch is for this session only (every start is in-flight), and left on in
 * the aircraft it must not cost GPS/traffic/FIS-B: with the home Stratux silent
 * for 15 s and 192.168.10.1 answering, FlyTab uses 192.168.10.1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const HOME = '192.168.1.212', AIR = '192.168.10.1';

let sockets;
class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    close() { this.readyState = 3; }
    _open() { this.readyState = 1; this.onopen?.({}); }
}

let StratuxClient;
beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
    localStorage.clear();
    global.WebSocket = FakeWebSocket;
    global.CockpitConfig = { raw: {} };
    global.DiagLog = { log: vi.fn() };
    global.Settings = { stratuxIp: AIR, homeStratuxIp: HOME, useHomeStratux: false, ownshipModeS: '000000' };
    global.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    StratuxClient = new Function(read('web/shared/stratux-client.js') + '\nreturn StratuxClient;')();
});
afterEach(() => { vi.useRealTimers(); delete global.fetch; });

const answers = (ip) => vi.fn(async (url) => {
    if (url.startsWith(`http://${ip}/`)) return { ok: true, status: 200, json: async () => ({}) };
    throw new TypeError('Failed to fetch');
});
const hosts = () => [...new Set(sockets.map(s => new URL(s.url).hostname))];

describe('Use the home Stratux', () => {
    it('off (the default): the in-flight Stratux IP', () => {
        const c = new StratuxClient();
        expect(c.homeMode).toBe('off');
        expect(c.ip).toBe(AIR);
    });

    it('on: the home Stratux, for every channel', () => {
        Settings.useHomeStratux = true;
        const c = new StratuxClient();
        expect(c.homeMode).toBe('home');
        expect(c.ip).toBe(HOME);
        c.connect();
        expect(hosts()).toEqual([HOME]);
        c.disconnect();
    });

    it('left on in the aircraft: home silent 15 s, 192.168.10.1 answers -> uses it, logged', async () => {
        Settings.useHomeStratux = true;
        global.fetch = answers(AIR);
        const c = new StratuxClient();
        c.connect();
        await vi.advanceTimersByTimeAsync(21_000);
        expect(c.homeMode).toBe('fallback');
        expect(c.ip).toBe(AIR);
        expect(sockets.filter(s => s.readyState !== 3).map(s => new URL(s.url).hostname)).toEqual([AIR, AIR, AIR, AIR]);
        expect(DiagLog.log).toHaveBeenCalledWith('stratux', expect.stringMatching(/Home Stratux 192\.168\.1\.212 silent \d+ s; 192\.168\.10\.1 answers/));
        c.disconnect();
    });

    it('left on in the aircraft with GDL 90 flowing (UDP takes any sender): still falls back', async () => {
        // Review 2026-10-29: GDL 90 from the aircraft Stratux kept "connected"
        // true, so FIS-B / status / towers stayed on the home address all flight.
        Settings.useHomeStratux = true;
        global.fetch = answers(AIR);
        const c = new StratuxClient();
        c.connect();
        for (let i = 0; i < 21; i++) { c._noteData('GDL 90'); await vi.advanceTimersByTimeAsync(1000); }
        expect(c.homeMode).toBe('fallback');
        expect(c.ip).toBe(AIR);
        c.disconnect();
    });

    it('home Stratux answering /getStatus only: no fallback', async () => {
        Settings.useHomeStratux = true;
        global.fetch = vi.fn(async (url) => {
            if (url.startsWith(`http://${HOME}/`) || url.startsWith(`http://${AIR}/`)) return { ok: true, status: 200, json: async () => ({}) };
            throw new TypeError('Failed to fetch');
        });
        const c = new StratuxClient();
        c.connect();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(c.homeMode).toBe('home');
        c.disconnect();
    });

    it('home Stratux delivering: never probes 192.168.10.1', async () => {
        Settings.useHomeStratux = true;
        global.fetch = answers(AIR);
        const c = new StratuxClient();
        c.connect();
        sockets.find(s => s.url.endsWith('/traffic'))._open();   // home Stratux answered
        await vi.advanceTimersByTimeAsync(60_000);
        expect(c.homeMode).toBe('home');
        expect(global.fetch.mock.calls.some(([u]) => u.startsWith(`http://${AIR}/`))).toBe(false);
        c.disconnect();
    });

    it('neither answers: stays on the home Stratux and keeps checking', async () => {
        Settings.useHomeStratux = true;
        const c = new StratuxClient();
        c.connect();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(c.homeMode).toBe('home');
        expect(global.fetch.mock.calls.filter(([u]) => u === `http://${AIR}/getStatus`).length).toBeGreaterThan(1);
        c.disconnect();
    });

    it('resetHomeFallback (switched on again / new home address) tries the home Stratux again', async () => {
        Settings.useHomeStratux = true;
        global.fetch = answers(AIR);
        const c = new StratuxClient();
        c.connect();
        await vi.advanceTimersByTimeAsync(21_000);
        expect(c.homeMode).toBe('fallback');
        c.resetHomeFallback();
        expect(c.ip).toBe(HOME);
        c.disconnect();
    });

    it('no home address: the switch does nothing', () => {
        Settings.useHomeStratux = true;
        Settings.homeStratuxIp = '  ';
        const c = new StratuxClient();
        expect(c.homeMode).toBe('off');
        expect(c.ip).toBe(AIR);
    });
});

describe('Settings.useHomeStratux: this session only', () => {
    it('off at every start, and never written to storage', () => {
        const S = new Function(read('web/shared/settings.js') + '\nreturn Settings;')();
        expect(S.useHomeStratux).toBe(false);
        S.useHomeStratux = true;
        expect(S.useHomeStratux).toBe(true);
        expect(Object.keys(localStorage).some(k => /home_stratux$|use_home/.test(k))).toBe(false);
        const S2 = new Function(read('web/shared/settings.js') + '\nreturn Settings;')();   // next start
        expect(S2.useHomeStratux).toBe(false);
    });
});
