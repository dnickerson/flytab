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
        expect(client._situationReconnectTimer).toBeFalsy();
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
