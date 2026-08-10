// tests/shared/stratux-client.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { SITUATION, TRAFFIC_TARGET } = require('../fixtures/stratux-messages.js');

// ---------------------------------------------------------------------------
// Browser globals that stratux-client.js references at module evaluation time.
// The top-level IIFEs (_StratuxNativeBus, _StratuxUdpBus) both guard with
// `typeof Capacitor !== 'undefined'`, so leaving Capacitor undefined is safe.
// ---------------------------------------------------------------------------
global.WebSocket     = class { constructor() {} close() {} static OPEN = 1; };
global.CockpitConfig = { raw: {} };
global.Settings      = { stratuxIp: '127.0.0.1', ownshipModeS: '000000' };
global.DiagLog       = { log: vi.fn() };
global.TrafficDiag   = { wsEvent: vi.fn() };
// jsdom provides CustomEvent, but make sure the detail constructor option works
// (jsdom's CustomEvent is standard-compliant, so this is a no-op guard)
if (typeof global.CustomEvent === 'undefined') {
    global.CustomEvent = class CustomEvent extends Event {
        constructor(t, o) { super(t); this.detail = o?.detail; }
    };
}

// Load the source file into a Function scope and extract StratuxClient.
// class declarations are block-scoped so eval() won't expose them to the
// surrounding scope; new Function + explicit return is the correct pattern.
const src = readFileSync('web/shared/stratux-client.js', 'utf8');
const StratuxClient = new Function(`${src}\nreturn StratuxClient;`)();

// ---------------------------------------------------------------------------
// _handleSituation tests
// ---------------------------------------------------------------------------
describe('StratuxClient._handleSituation', () => {
    let client;

    beforeEach(() => {
        vi.useFakeTimers();
        client = new StratuxClient();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('normalizes PascalCase wire fields to snake_case event fields', () => {
        client._suppressGpsSituation = false;
        const events = [];
        client.addEventListener('stratux:situation', e => events.push(e.detail));

        client._handleSituation(SITUATION);

        expect(events).toHaveLength(1);
        const sit = events[0];
        expect(sit.lat).toBe(34.9);
        expect(sit.lon).toBe(-81.1);
        expect(sit.alt_msl).toBe(5000.0);
        expect(sit.alt_baro).toBe(4950.0);
        expect(sit.ground_speed).toBe(150.0);
        expect(sit.true_course).toBe(90.0);
        expect(sit.gps_fix_quality).toBe(2);
        expect(sit.gps_sats).toBe(9);
        expect(sit.pitch).toBe(1.5);
        expect(sit.roll).toBe(0.5);
        expect(sit.g_load).toBe(1.0);
        expect(sit.timestamp).toBeTypeOf('number');
    });

    it('stores the normalized object in client.situation', () => {
        client._suppressGpsSituation = false;

        client._handleSituation(SITUATION);

        expect(client.situation).not.toBeNull();
        expect(client.situation.lat).toBe(34.9);
        expect(client.situation.lon).toBe(-81.1);
    });

    it('suppresses GPS event when _suppressGpsSituation is true', () => {
        client._suppressGpsSituation = true;
        const events = [];
        client.addEventListener('stratux:situation', e => events.push(e.detail));

        client._handleSituation(SITUATION);

        expect(events).toHaveLength(0);
    });

    it('stores AHRS data in _lastStratuxAhrs when GPS is suppressed', () => {
        client._suppressGpsSituation = true;

        client._handleSituation(SITUATION);

        expect(client._lastStratuxAhrs).not.toBeNull();
        expect(client._lastStratuxAhrs.pitch).toBe(1.5);
        expect(client._lastStratuxAhrs.roll).toBe(0.5);
        expect(client._lastStratuxAhrs.g_load).toBe(1.0);
        expect(client._lastStratuxAhrs.alt_baro).toBe(4950.0);
    });

    it('does not update client.situation when GPS is suppressed', () => {
        client._suppressGpsSituation = true;

        client._handleSituation(SITUATION);

        expect(client.situation).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// _handleTraffic tests
// ---------------------------------------------------------------------------
describe('StratuxClient._handleTraffic', () => {
    let client;

    beforeEach(() => {
        // Reset ownshipModeS to a non-matching value before each test
        Settings.ownshipModeS = '000000';
        client = new StratuxClient();
    });

    it('normalizes Lng → lon and maps all wire fields', () => {
        const events = [];
        client.addEventListener('stratux:traffic', e => events.push(e.detail));

        client._handleTraffic(TRAFFIC_TARGET);

        expect(events).toHaveLength(1);
        const t = events[0];
        expect(t.lat).toBe(35.25);
        expect(t.lon).toBe(-80.0);          // Lng → lon
        expect(t.callsign).toBe('N123AB');   // Tail → callsign (trimmed)
        expect(t.on_ground).toBe(false);     // OnGround → on_ground
        expect(t.icao_addr).toBe(11256833);
    });

    it('formats hex as 6-character uppercase string', () => {
        const events = [];
        client.addEventListener('stratux:traffic', e => events.push(e.detail));

        client._handleTraffic(TRAFFIC_TARGET);

        expect(events[0].hex).toMatch(/^[0-9A-F]{6}$/);
        // TRAFFIC_TARGET.Icao_addr = 11256833 = 0xABC401
        expect(events[0].hex).toBe('ABC401');
    });

    it('stores the target in the traffic Map by ICAO address', () => {
        client._handleTraffic(TRAFFIC_TARGET);

        expect(client.traffic.has(TRAFFIC_TARGET.Icao_addr)).toBe(true);
        expect(client.traffic.get(TRAFFIC_TARGET.Icao_addr).callsign).toBe('N123AB');
    });

    it('filters own-ship by Mode S address (case-insensitive)', () => {
        // 11256833 = 0xABC401
        Settings.ownshipModeS = 'abc401';
        const events = [];
        client.addEventListener('stratux:traffic', e => events.push(e.detail));

        client._handleTraffic(TRAFFIC_TARGET);

        expect(events).toHaveLength(0);
    });

    it('ignores messages with no Icao_addr', () => {
        const events = [];
        client.addEventListener('stratux:traffic', e => events.push(e.detail));

        client._handleTraffic({});

        expect(events).toHaveLength(0);
    });

    it('ignores messages with falsy Icao_addr (zero)', () => {
        const events = [];
        client.addEventListener('stratux:traffic', e => events.push(e.detail));

        client._handleTraffic({ ...TRAFFIC_TARGET, Icao_addr: 0 });

        expect(events).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// disconnect() cancels all pending reconnect timers (Finding 10)
// ---------------------------------------------------------------------------
describe('StratuxClient.disconnect — cancels pending reconnect timers', () => {
    let client;

    beforeEach(() => {
        vi.useFakeTimers();
        client = new StratuxClient();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('a situation-WS reconnect scheduled before disconnect() never fires after it', () => {
        // Exercises the REAL _connectSituation()/onclose handler (spied, not
        // reimplemented) — priming call runs for real via the WebSocket stub at
        // the top of this file, so the assertion below is against Step 6's
        // actual code, not a hand-copied stand-in that could silently drift
        // from it.
        client._trafficWs = { readyState: WebSocket.OPEN, close() {} }; // satisfies the reconnect guard; close() needed because disconnect() calls it unconditionally
        const spy = vi.spyOn(client, '_connectSituation');
        client._connectSituation(); // priming call — installs the real onclose on a stub WS
        spy.mockClear();

        client._situationWs.onclose({ code: 1006, reason: 'test' }); // simulate the WS actually closing
        // toBeTruthy(), not not.toBeNull() — the latter also passes if the field is
        // simply undefined (i.e. doesn't exist yet on unfixed code), which would let
        // this assertion pass even before Step 3 adds the field.
        expect(client._situationReconnectTimer).toBeTruthy();

        client.disconnect();
        vi.advanceTimersByTime(5000);

        expect(spy).not.toHaveBeenCalled();
    });

    it('a weather-WS reconnect scheduled before disconnect() never fires, even when the UDP plugin makes udpMode permanently true', () => {
        // udpMode is a getter with no setter (`get udpMode() { return !!_StratuxUdpBus
        // && !this._simMode; }`, confirmed directly in source) — `client.udpMode = true`
        // throws (class bodies are strict mode). _StratuxUdpBus is a module-level
        // constant fixed at source-evaluation time, so reproducing udpMode===true (the
        // actual "fires unconditionally on real hardware" case from Finding 10, not a
        // timing race) requires re-evaluating the source with Capacitor.Plugins.StratuxUDP
        // present — mirroring how the class itself detects the native plugin.
        global.Capacitor = { Plugins: { StratuxUDP: { addListener: vi.fn(), start: vi.fn(), stop: vi.fn() } } };
        try {
            const freshSrc = readFileSync('web/shared/stratux-client.js', 'utf8');
            const StratuxClientUdp = new Function(`${freshSrc}\nreturn StratuxClient;`)();
            const udpClient = new StratuxClientUdp();
            expect(udpClient.udpMode).toBe(true); // sanity check the stub actually engaged udpMode

            const spy = vi.spyOn(udpClient, '_connectWeather');
            udpClient._connectWeather();
            spy.mockClear();

            udpClient._weatherWs.onclose({ code: 1006, reason: 'test' });
            expect(udpClient._weatherReconnectTimer).toBeTruthy();

            udpClient.disconnect();
            vi.advanceTimersByTime(10000);

            expect(spy).not.toHaveBeenCalled();
        } finally {
            delete global.Capacitor; // don't leak into other tests, even on assertion failure
        }
    });

    it('disconnect() clears the timer fields themselves, not just skipping the callback', () => {
        client._situationReconnectTimer = setTimeout(() => {}, 2000);
        client._weatherReconnectTimer = setTimeout(() => {}, 5000);
        client._jsonioReconnectTimer = setTimeout(() => {}, 5000);

        client.disconnect();

        expect(client._situationReconnectTimer).toBeNull();
        expect(client._weatherReconnectTimer).toBeNull();
        expect(client._jsonioReconnectTimer).toBeNull();
    });

    it('connect() resets _disconnected — reconnecting after a settings-driven IP change still works', () => {
        // config-editor.js calls disconnect() immediately followed by connect() on every
        // Stratux-IP settings edit. If _disconnected didn't reset here, every reconnect
        // scheduled after the FIRST IP edit would be permanently suppressed.
        client.disconnect();
        expect(client._disconnected).toBe(true);
        client.connect();
        expect(client._disconnected).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Code-review follow-up (Finding 10 re-review): weather/jsonio reconnect-timer
// SCHEDULING must be gated by _disconnected at the setTimeout() call site
// itself, not just inside the timeout callback body.
//
// _createStratuxWs's close() (web/shared/stratux-client.js ~line 88) defers
// firing the closed socket's onclose via queueMicrotask. config-editor.js's
// Stratux-IP-change handler calls disconnect() immediately followed by
// connect(), synchronously, with no await between them — so that deferred
// microtask fires the STALE onclose (still closing over the same `this`
// client instance) only AFTER connect() has already run and reset
// _disconnected back to false and stood up a brand-new weatherWs/jsonioWs.
// If only the callback body checked _disconnected, the (previously
// unconditional) setTimeout() call would still fire at that moment, scheduling
// a spurious reconnect that tears down the connection connect() just
// established ~5s later. Gating the outer setTimeout() call with
// !this._disconnected (mirroring the existing situation-WS pattern) closes
// this for the common case, where _trafficWs is not yet readyState OPEN
// immediately after a fresh connect() — see caveat in task-10-report.md about
// the udpMode-permanently-true sub-case.
// ---------------------------------------------------------------------------
describe('StratuxClient — weather/jsonio reconnect scheduling gated at schedule time (not just callback)', () => {
    let client;

    beforeEach(() => {
        vi.useFakeTimers();
        client = new StratuxClient();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('a weather-WS onclose deferred past a disconnect()+connect() cycle does not schedule a reconnect timer', () => {
        client._connectWeather(); // primes the real onclose on weatherWs #1
        // Capture the handler BEFORE disconnect() nulls _weatherWs — this mirrors
        // what a queueMicrotask-deferred close callback from the OLD socket would
        // still hold a reference to in production.
        const staleOnclose = client._weatherWs.onclose;

        client.disconnect(); // _disconnected = true, _weatherWs nulled
        client.connect();    // _disconnected = false, brand-new weatherWs created —
        // synchronous, no await, matching config-editor.js's IP-change handler exactly.

        // Simulate the deferred microtask firing the STALE handler late, after
        // connect() has already run (this is what queueMicrotask does in the real
        // _createStratuxWs.close()).
        staleOnclose({ code: 1000, reason: 'client_close' });

        expect(client._weatherReconnectTimer).toBeNull();
    });

    it('a jsonio-WS onclose deferred past a disconnect()+connect() cycle does not schedule a reconnect timer', () => {
        client._connectJsonio();
        const staleOnclose = client._jsonioWs.onclose;

        client.disconnect();
        client.connect();

        staleOnclose({ code: 1000, reason: 'client_close' });

        expect(client._jsonioReconnectTimer).toBeNull();
    });
});
