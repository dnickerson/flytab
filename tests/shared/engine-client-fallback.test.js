/**
 * EngineClient WS -> HTTP fallback (11-2026). The primary Pi lost its websockets
 * library at every power-up (installed only in the Stratux RAM overlay), so every
 * flight ran on the HTTP poll. Each failed 60 s WS retry then fired
 * engine:disconnect although poll data kept arriving: fuel-tanks marked the fuel
 * figure UNCONFIRMED and the recorder blanked Gallons Remaining every 30-60 s
 * (20261114_KLKR-KSVH.csv: 95 blank cells). A disconnect must mean the Pi is gone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const src = readFileSync('web/shared/engine-client.js', 'utf8');

/** Browser-like WebSocket double. `mode`: 'refuse' fails each connect after 20 ms
 *  (Pi port 8082 closed); 'accept' opens after 20 ms. close() on a live socket
 *  fires close asynchronously to whatever handler is attached then, like a browser. */
let sockets, mode;
class FakeWS {
    constructor(url) {
        this.url = url; this.readyState = 0;
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        sockets.push(this);
        setTimeout(() => {
            if (this.readyState !== 0) return;
            if (mode === 'refuse') this._fail();
            else { this.readyState = 1; this.onopen && this.onopen({}); }
        }, 20);
    }
    _fail() {
        this.readyState = 3;
        this.onerror && this.onerror({});
        this.onclose && this.onclose({ code: 1006 });
    }
    close() {
        if (this.readyState >= 2) return;
        this.readyState = 3;
        queueMicrotask(() => this.onclose && this.onclose({ code: 1000 }));
    }
}

let pollOk;
const FRAME = { api_contract: 3, data_count: 1, data: { RPM: 2400, Fuel_Flow: 8.1 } };

function makeClient() {
    const EngineClient = new Function(`${src}\nreturn EngineClient;`)();
    const ec = new EngineClient('192.168.10.1', 8082, 8080);
    const log = [];
    for (const t of ['engine:connect', 'engine:disconnect', 'engine:data']) {
        ec.addEventListener(t, () => log.push([Date.now(), t]));
    }
    return { ec, log, count: (t, from = 0) => log.filter(([at, e]) => e === t && at >= from).length };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    sockets = []; mode = 'refuse'; pollOk = true;
    global.WebSocket = FakeWS;
    global.fetch = vi.fn(async () => {
        if (!pollOk) throw new Error('timeout');
        return { ok: true, json: async () => ({ ...FRAME }) };
    });
});
afterEach(() => { vi.useRealTimers(); });

describe('Pi without its WS endpoint, HTTP answering', () => {
    it('poll data flowing: no engine:disconnect for an hour of failed WS retries', async () => {
        const { ec, count } = makeClient();
        ec.connect();
        await vi.advanceTimersByTimeAsync(60_000);          // three WS failures -> HTTP fallback
        expect(ec._useHttpFallback || ec._pollTimer).toBeTruthy();
        expect(ec.connected).toBe(true);
        const from = Date.now();
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(sockets.length).toBeGreaterThan(60);        // the 60 s WS retry kept trying
        expect(count('engine:disconnect', from)).toBe(0);
        expect(count('engine:data', from)).toBeGreaterThan(1700);   // a poll every 2 s
        expect(ec.connected).toBe(true);
        ec.disconnect();
    });

    it('a failed poll is still a disconnect, and the next good poll reconnects', async () => {
        const { ec, count } = makeClient();
        ec.connect();
        await vi.advanceTimersByTimeAsync(60_000);
        const from = Date.now();
        pollOk = false;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(count('engine:disconnect', from)).toBe(1);
        expect(ec.connected).toBe(false);
        pollOk = true;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(ec.connected).toBe(true);
        expect(count('engine:connect', from)).toBe(1);
        ec.disconnect();
    });
});

describe('WS comes back while in HTTP fallback', () => {
    it('the poll and the 60 s retry stop; the healthy socket is not closed again', async () => {
        const { ec, count } = makeClient();
        ec.connect();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(ec._pollTimer).toBeTruthy();
        mode = 'accept';                                     // Pi WS endpoint back
        await vi.advanceTimersByTimeAsync(61_000);           // next 60 s retry opens it
        const live = sockets[sockets.length - 1];
        expect(live.readyState).toBe(1);
        expect(ec._pollTimer).toBeNull();
        expect(ec._wsRetryTimer).toBeNull();
        const from = Date.now(), n = sockets.length;
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(live.readyState).toBe(1);                     // never torn down by a retry
        expect(sockets.length).toBe(n);
        expect(count('engine:disconnect', from)).toBe(0);
        ec.disconnect();
    });
});

describe('replacing a live socket', () => {
    it('connect() while open: the old socket\'s close is not a failure or a disconnect', async () => {
        mode = 'accept';
        const { ec, count } = makeClient();
        ec.connect();
        await vi.advanceTimersByTimeAsync(100);
        expect(ec.connected).toBe(true);
        const from = Date.now();
        ec.connect();                                        // e.g. a settings change reconnects
        await vi.advanceTimersByTimeAsync(100);
        expect(count('engine:disconnect', from)).toBe(0);
        expect(ec._wsFailCount).toBe(0);
        expect(ec.connected).toBe(true);
        expect(sockets[0].readyState).toBe(3);
        expect(sockets[1].readyState).toBe(1);
        ec.disconnect();
    });

    it('a WS that drops with no HTTP poll running is still a disconnect', async () => {
        mode = 'accept';
        const { ec, count } = makeClient();
        ec.connect();
        await vi.advanceTimersByTimeAsync(100);
        const from = Date.now();
        mode = 'refuse';
        sockets[0]._fail();                                  // Pi went away
        expect(count('engine:disconnect', from)).toBe(1);
        expect(ec.connected).toBe(false);
        ec.disconnect();
    });
});
