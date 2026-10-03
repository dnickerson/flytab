// tests/shared/stratux-link-health.test.js
//
// Link-health guarantees for StratuxClient (2026-10-02 reliability review):
//
// H1 — Stratux's /situation handler (main/managementinterface.go
//      handleSituationWS) only ever Write()s; it never Read()s, and
//      golang.org/x/net/websocket only answers a ping from inside Read(). So a
//      WebSocket ping on /situation is never ponged, and OkHttp 4.12 fails the
//      socket ("sent ping but didn't receive pong"). The situation channel must
//      therefore be opened WITHOUT protocol pings, and dead-connection
//      detection for it is a JS silence watchdog instead (Stratux pushes
//      situation at 10 Hz unconditionally).
//
// H2 — `connected` must mean data is actually arriving. Stratux keeps sending
//      GDL 90 heartbeats to a client it considers "sleeping" but drops all
//      ownship/traffic for it (main/network.go collectMessages), so a UDP
//      heartbeat alone must not mark the link connected.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const OPEN = 1, CLOSED = 3;

let sockets;
class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        sockets.push(this);
    }
    close() { this.readyState = CLOSED; }
    // test helpers
    _open() { this.readyState = OPEN; this.onopen?.({}); }
    _msg(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
    _drop(code = 1006) { this.readyState = CLOSED; this.onclose?.({ code, reason: 'test' }); }
}

global.WebSocket     = FakeWebSocket;
global.CockpitConfig = { raw: {} };
global.Settings      = { stratuxIp: '192.168.10.1', ownshipModeS: '000000' };
global.DiagLog       = { log: vi.fn() };

const src = readFileSync('web/shared/stratux-client.js', 'utf8');
const load = () => new Function(`${src}\nreturn StratuxClient;`)();

const byPath = (p) => sockets.filter(s => s.url.endsWith(p));
const latest = (p) => byPath(p).at(-1);
const SIT = { GPSLatitude: 34.7, GPSLongitude: -80.8, GPSFixQuality: 2, GPSSatellites: 11 };

beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
    global.fetch = vi.fn(() => Promise.reject(new Error('no network in test')));
});

afterEach(() => {
    vi.useRealTimers();
    delete global.fetch;
    delete global.Capacitor;
});

describe('H1 — situation WS silence watchdog', () => {
    it('does not replace a situation socket that keeps delivering messages', () => {
        const client = new (load())();
        client.connect();
        latest('/traffic')._open();
        const sit = latest('/situation');
        sit._open();
        for (let t = 0; t < 20; t++) { sit._msg(SIT); vi.advanceTimersByTime(500); }
        expect(byPath('/situation')).toHaveLength(1);
        client.disconnect();
    });

    it('replaces an OPEN situation socket that has gone silent (half-open TCP)', () => {
        const client = new (load())();
        client.connect();
        latest('/traffic')._open();
        const sit = latest('/situation');
        sit._open();
        sit._msg(SIT);
        vi.advanceTimersByTime(6000);  // no messages for 6 s; Stratux sends at 10 Hz
        expect(byPath('/situation').length).toBeGreaterThan(1);
        expect(sit.readyState).toBe(CLOSED);
        client.disconnect();
    });

    it('a replacement socket gets a fresh silence window (no reconnect storm while it opens)', () => {
        const client = new (load())();
        client.connect();
        latest('/traffic')._open();
        latest('/situation')._open();
        vi.advanceTimersByTime(6000);
        const replacement = latest('/situation');
        const count = byPath('/situation').length;
        replacement._open();
        for (let t = 0; t < 10; t++) { replacement._msg(SIT); vi.advanceTimersByTime(500); }
        expect(byPath('/situation')).toHaveLength(count);
        client.disconnect();
    });

    it('re-creates a CLOSED situation socket with no pending reconnect while the link is up', () => {
        const client = new (load())();
        client.connect();
        const traffic = latest('/traffic');
        traffic._open();
        const sit = latest('/situation');
        sit._open();
        // Situation drops at a moment the traffic WS isn't OPEN, so the onclose
        // gate schedules nothing; traffic then comes back without a
        // connected-state transition, so _setConnected(true) never rescues it.
        traffic.readyState = 0;
        sit._drop();
        traffic.readyState = OPEN;
        vi.advanceTimersByTime(3000);
        expect(byPath('/situation').length).toBeGreaterThan(1);
        client.disconnect();
    });

    it('disconnect() stops the watchdog — no sockets are created afterwards', () => {
        const client = new (load())();
        client.connect();
        latest('/traffic')._open();
        latest('/situation')._open();
        client.disconnect();
        const n = sockets.length;
        vi.advanceTimersByTime(20000);
        expect(sockets.length).toBe(n);
    });
});

describe('H1 — situation channel is opened without protocol pings (native transport)', () => {
    it('passes ping:false for situation and ping:true for traffic/weather/jsonio', () => {
        const open = vi.fn();
        global.Capacitor = { Plugins: { StratuxWS: { addListener: vi.fn(), open, close: vi.fn() } } };
        const client = new (load())();
        client.connect();
        const byChannel = Object.fromEntries(open.mock.calls.map(([a]) => [a.channel, a]));
        expect(byChannel.situation.ping).toBe(false);
        expect(byChannel.traffic.ping).toBe(true);
        expect(byChannel.weather.ping).toBe(true);
        expect(byChannel.jsonio.ping).toBe(true);
        client.disconnect();
    });
});

describe('H2 — connected reflects data actually arriving', () => {
    function udpStub() {
        const listeners = {};
        global.Capacitor = { Plugins: { StratuxUDP: {
            addListener: (name, cb) => { listeners[name] = cb; },
            start: vi.fn(() => Promise.resolve()),
            stop: vi.fn(() => Promise.resolve()),
        } } };
        return listeners;
    }

    it('a UDP heartbeat alone (Stratux treating us as sleeping) does not mark the link connected', () => {
        const udp = udpStub();
        const client = new (load())();
        client.connect();
        udp.heartbeat({ gps_valid: true });
        expect(client.connected).toBe(false);
        client.disconnect();
    });

    it('UDP ownship/situation data marks the link connected', () => {
        const udp = udpStub();
        const client = new (load())();
        const events = [];
        client.addEventListener('stratux:connect', () => events.push('connect'));
        client.connect();
        udp.situation(SIT);
        expect(client.connected).toBe(true);
        expect(events).toEqual(['connect']);
        client.disconnect();
    });

    it('UDP traffic data marks the link connected', () => {
        const udp = udpStub();
        const client = new (load())();
        client.connect();
        udp.traffic({ Icao_addr: 0xABCDEF, Lat: 34, Lng: -80 });
        expect(client.connected).toBe(true);
        client.disconnect();
    });

    it('a traffic WS drop does not fire stratux:disconnect while UDP data is still flowing', () => {
        const udp = udpStub();
        const client = new (load())();
        const events = [];
        client.addEventListener('stratux:disconnect', () => events.push('disconnect'));
        client.connect();
        latest('/traffic')._open();
        udp.situation(SIT);
        latest('/traffic')._drop();
        expect(client.connected).toBe(true);
        expect(events).toEqual([]);
        client.disconnect();
    });

    it('goes disconnected once UDP data stops and the traffic WS is not open', () => {
        const udp = udpStub();
        const client = new (load())();
        const events = [];
        client.addEventListener('stratux:disconnect', () => events.push('disconnect'));
        client.connect();
        udp.situation(SIT);
        expect(client.connected).toBe(true);
        for (let t = 0; t < 6; t++) { udp.heartbeat({ gps_valid: true }); vi.advanceTimersByTime(1000); }
        expect(client.connected).toBe(false);
        expect(events).toEqual(['disconnect']);
        client.disconnect();
    });

    it('stays connected while the traffic WS is open even with no UDP data', () => {
        udpStub();
        const client = new (load())();
        client.connect();
        latest('/traffic')._open();
        vi.advanceTimersByTime(10000);
        expect(client.connected).toBe(true);
        client.disconnect();
    });
});

// ---------------------------------------------------------------------------
// Review fixes (PR #150 critical review)
// ---------------------------------------------------------------------------

describe('Review #1 — situation WS data counts as link data', () => {
    function udpStub() {
        const listeners = {};
        global.Capacitor = { Plugins: { StratuxUDP: {
            addListener: (name, cb) => { listeners[name] = cb; },
            start: vi.fn(() => Promise.resolve()),
            stop: vi.fn(() => Promise.resolve()),
        } } };
        return listeners;
    }

    it('stays connected when the traffic WS drops and UDP sends only heartbeats, while /situation keeps streaming', () => {
        const udp = udpStub();
        const client = new (load())();
        const events = [];
        client.addEventListener('stratux:disconnect', () => events.push('disconnect'));
        client.connect();
        latest('/traffic')._open();
        const sit = latest('/situation');
        sit._open();
        sit._msg(SIT);
        latest('/traffic')._drop();
        for (let t = 0; t < 20; t++) { udp.heartbeat({ gps_valid: true }); sit._msg(SIT); vi.advanceTimersByTime(500); }
        expect(client.connected).toBe(true);
        expect(events).toEqual([]);
        client.disconnect();
    });

    it('situation WS data alone marks the link connected', () => {
        const client = new (load())();
        client.connect();
        const sit = latest('/situation');
        sit._open();
        expect(client.connected).toBe(false);   // open alone is not data
        sit._msg(SIT);
        expect(client.connected).toBe(true);
        client.disconnect();
    });

    it('goes disconnected once situation data stops, traffic WS is closed and there is no UDP', () => {
        const client = new (load())();
        client.connect();
        latest('/traffic')._open();
        const sit = latest('/situation');
        sit._open();
        sit._msg(SIT);
        latest('/traffic')._drop();
        expect(client.connected).toBe(true);
        vi.advanceTimersByTime(5000);
        expect(client.connected).toBe(false);
        client.disconnect();
    });
});

describe('Review #3 — sockets stuck in CONNECTING are replaced', () => {
    for (const path of ['/traffic', '/situation', '/weather', '/jsonio']) {
        it(`${path}: a socket still CONNECTING after 15 s is replaced`, () => {
            const client = new (load())();
            client.connect();
            const stuck = latest(path);
            vi.advanceTimersByTime(10000);
            expect(latest(path)).toBe(stuck);          // not before the timeout
            vi.advanceTimersByTime(7000);
            expect(latest(path)).not.toBe(stuck);
            expect(stuck.readyState).toBe(CLOSED);
            client.disconnect();
        });
    }
});

describe('Review #4 — companion channels reconnect on their own, with backoff', () => {
    for (const path of ['/situation', '/weather', '/jsonio']) {
        it(`${path}: reconnects after a drop even when the traffic WS is not open (no UDP)`, () => {
            const client = new (load())();
            client.connect();
            const s = latest(path);
            s._open();
            s._drop();
            vi.advanceTimersByTime(6000);
            expect(latest(path)).not.toBe(s);
            client.disconnect();
        });
    }

    it('repeated failures back off (capped) and a successful open resets the delay', () => {
        const client = new (load())();
        client.connect();
        const times = [];
        let s = latest('/situation');
        let t0 = Date.now();
        for (let i = 0; i < 6; i++) {
            s._drop();
            const before = s;
            let waited = 0;
            while (latest('/situation') === before) { vi.advanceTimersByTime(100); waited += 100; if (waited > 60000) break; }
            times.push(waited);
            s = latest('/situation');
        }
        // strictly non-decreasing and capped at 30 s
        for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
        expect(Math.max(...times)).toBeLessThanOrEqual(30100);
        expect(times.at(-1)).toBeGreaterThan(times[0]);
        // success resets
        s._open();
        s._drop();
        let waited = 0;
        const before = s;
        while (latest('/situation') === before) { vi.advanceTimersByTime(100); waited += 100; }
        expect(waited).toBeLessThanOrEqual(times[0]);
        client.disconnect();
    });

    it('after disconnect() no companion channel reconnects', () => {
        const client = new (load())();
        client.connect();
        const subs = ['/situation', '/weather', '/jsonio'].map(latest);
        subs.forEach(s => s._open());
        client.disconnect();
        subs.forEach(s => s._drop());
        const n = sockets.length;
        vi.advanceTimersByTime(60000);
        expect(sockets.length).toBe(n);
    });
});

describe('Review #5 — Stratux HTTP polls have a timeout', () => {
    it('getStatus and getTowers fetches carry an abort signal', () => {
        const client = new (load())();
        client.connect();
        const calls = global.fetch.mock.calls;
        for (const ep of ['/getStatus', '/getTowers']) {
            const call = calls.find(([url]) => url.endsWith(ep));
            expect(call, ep).toBeTruthy();
            expect(call[1]?.signal, ep).toBeInstanceOf(AbortSignal);
        }
        client.disconnect();
    });
});

// ---------------------------------------------------------------------------
// Second review (PR #150)
// ---------------------------------------------------------------------------

describe('Review 2 #2 — watchdog tolerates WebView timer suspension', () => {
    function connectedBySituation() {
        const client = new (load())();
        client.connect();
        const sit = latest('/situation');
        sit._open();
        sit._msg(SIT);
        expect(client.connected).toBe(true);
        return { client, sit };
    }

    it('a resume after a 30 s suspension does not declare the link down or replace the situation socket', () => {
        const { client, sit } = connectedBySituation();
        const events = [];
        client.addEventListener('stratux:disconnect', () => events.push('disconnect'));
        vi.advanceTimersByTime(1000);
        vi.setSystemTime(Date.now() + 30000);   // JS frozen: wall clock moves, no ticks ran
        vi.advanceTimersByTime(1000);           // first tick after resume
        sit._msg(SIT);                          // queued native messages now delivered
        expect(events).toEqual([]);
        expect(latest('/situation')).toBe(sit);
        client.disconnect();
    });

    it('still detects real silence after a resume', () => {
        const { client, sit } = connectedBySituation();
        vi.advanceTimersByTime(1000);
        vi.setSystemTime(Date.now() + 30000);
        vi.advanceTimersByTime(8000);           // resumed, but no data ever arrives
        expect(client.connected).toBe(false);
        expect(latest('/situation')).not.toBe(sit);
        client.disconnect();
    });

    it('a suspension does not count toward a CONNECTING socket’s timeout', () => {
        const client = new (load())();
        client.connect();
        const stuck = latest('/weather');
        vi.advanceTimersByTime(1000);
        vi.setSystemTime(Date.now() + 60000);
        vi.advanceTimersByTime(1000);
        expect(latest('/weather')).toBe(stuck);
        client.disconnect();
    });
});

describe('Review 2 #4 — connect() resets reconnect backoff', () => {
    it('after disconnect()+connect(), dropped traffic and situation retry at the base delay', () => {
        const client = new (load())();
        client.connect();
        client._reconnectDelay = 30000;
        client._channelDelay.situation = 30000;
        client.disconnect();
        client.connect();

        const traffic = latest('/traffic');
        const sit = latest('/situation');
        traffic._drop();
        sit._drop();
        vi.advanceTimersByTime(2100);
        expect(latest('/traffic')).not.toBe(traffic);
        expect(latest('/situation')).not.toBe(sit);
        client.disconnect();
    });
});

// ---------------------------------------------------------------------------
// Third review (PR #150)
// ---------------------------------------------------------------------------

describe('Review 3 #1 — a silent situation socket recycles every channel', () => {
    it('replaces traffic, weather and jsonio too, not just situation', () => {
        const client = new (load())();
        client.connect();
        const before = {};
        for (const p of ['/traffic', '/situation', '/weather', '/jsonio']) { before[p] = latest(p); before[p]._open(); }
        before['/situation']._msg(SIT);
        vi.advanceTimersByTime(6000);            // whole link dead: situation silent at 10 Hz
        for (const p of ['/traffic', '/situation', '/weather', '/jsonio']) {
            expect(latest(p), p).not.toBe(before[p]);
            expect(before[p].readyState, p).toBe(CLOSED);
        }
        client.disconnect();
    });

    it('a direct _connectTraffic() while a traffic reconnect is pending does not strand traffic', () => {
        const client = new (load())();
        client.connect();
        const t1 = latest('/traffic');
        t1._open();
        t1._drop();                               // schedules a 2 s traffic reconnect
        client._connectTraffic();                 // e.g. the recycle path, before that timer fires
        const t2 = latest('/traffic');
        t2._drop();                               // new socket drops before the old timer fires
        vi.advanceTimersByTime(10000);
        expect(latest('/traffic')).not.toBe(t2);  // it must still be reconnected
        client.disconnect();
    });
});

describe('Review 3 #2 — staleness is suspension-aware', () => {
    it('still fires stratux:stale ~5 s after situation data stops', () => {
        const client = new (load())();
        const stale = [];
        client.addEventListener('stratux:stale', () => stale.push(Date.now()));
        client.connect();
        const sit = latest('/situation');
        sit._open();
        sit._msg(SIT);
        vi.advanceTimersByTime(4000);
        expect(stale).toHaveLength(0);
        vi.advanceTimersByTime(2500);
        expect(stale).toHaveLength(1);
        client.disconnect();
    });

    it('fires stratux:stale when Stratux never answers (device-GPS fallback trigger)', () => {
        const client = new (load())();
        const stale = [];
        client.addEventListener('stratux:stale', () => stale.push(1));
        client.connect();
        vi.advanceTimersByTime(6500);
        expect(stale).toHaveLength(1);
        client.disconnect();
    });

    it('a resume after a 30 s suspension does not fire stratux:stale before queued data is delivered', () => {
        // Fake timers only make a timeout "overdue" on resume if it was already
        // close to due when JS froze — freeze 0.5 s before the old 5 s stale
        // deadline, then let the overdue work run, then deliver the queued message.
        const client = new (load())();
        const stale = [];
        client.addEventListener('stratux:stale', () => stale.push(1));
        client.connect();
        vi.advanceTimersByTime(500);
        const sit = latest('/situation');
        sit._open();
        sit._msg(SIT);                           // t = 0.5 s
        vi.advanceTimersByTime(4500);            // t = 5.0 s, normal ticks, data still fresh-ish
        vi.setSystemTime(Date.now() + 30000);    // JS frozen 30 s
        vi.advanceTimersByTime(600);             // resume: overdue timers run first
        sit._msg(SIT);                           // then the queued native message
        vi.advanceTimersByTime(500);
        expect(stale).toEqual([]);
        client.disconnect();
    });

    it('after a resume with no data at all, stale still fires', () => {
        const client = new (load())();
        const stale = [];
        client.addEventListener('stratux:stale', () => stale.push(1));
        client.connect();
        const sit = latest('/situation');
        sit._open();
        sit._msg(SIT);
        vi.advanceTimersByTime(1000);
        vi.setSystemTime(Date.now() + 30000);
        vi.advanceTimersByTime(8000);
        expect(stale).toHaveLength(1);
        client.disconnect();
    });

    it('disconnect() stops stale detection', () => {
        const client = new (load())();
        const stale = [];
        client.addEventListener('stratux:stale', () => stale.push(1));
        client.connect();
        client.disconnect();
        vi.advanceTimersByTime(20000);
        expect(stale).toEqual([]);
    });
});
