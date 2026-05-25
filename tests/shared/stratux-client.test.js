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
global.WebSocket     = class { constructor() {} static OPEN = 1; };
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
