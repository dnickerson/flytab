// tests/shared/engine-client.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ENGINE_FRAME, ENGINE_FRAME_NO_CONTRACT, ENGINE_FRAME_OLD_CONTRACT } = require('../fixtures/engine-messages.js');

// ---------------------------------------------------------------------------
// Browser globals that engine-client.js references at evaluation time.
// EngineClient extends EventTarget (native in jsdom) and uses CustomEvent
// (also native in jsdom). We stub WebSocket and fetch so connect() calls
// never reach the network.
// ---------------------------------------------------------------------------
global.WebSocket = class {
    constructor() {}
    close() {}
};

global.fetch = vi.fn().mockRejectedValue(new Error('no network'));

// Load the source into a Function scope and extract EngineClient.
// class declarations are block-scoped, so eval() won't expose them to the
// surrounding scope; new Function + explicit return is the correct pattern.
const src = readFileSync('web/shared/engine-client.js', 'utf8');
const EngineClient = new Function(`${src}\nreturn EngineClient;`)();

// ---------------------------------------------------------------------------
// _onData tests
// ---------------------------------------------------------------------------
describe('EngineClient._onData', () => {
    let client;
    const events = [];

    beforeEach(() => {
        vi.useFakeTimers();
        events.length = 0;
        client = new EngineClient('127.0.0.1', 8082);
        client.addEventListener('engine:data', e => events.push(e.detail));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('emits engine:data with the raw frame', () => {
        client._onData(ENGINE_FRAME);
        expect(events).toHaveLength(1);
        expect(events[0].version).toBe('3.4.0');
        expect(events[0].data.RPM).toBe(2200);
    });

    it('sets lastData', () => {
        client._onData(ENGINE_FRAME);
        expect(client.lastData).toStrictEqual(ENGINE_FRAME);
    });

    it('updates _lastDataTime', () => {
        expect(client.dataAge).toBe(Infinity);
        client._onData(ENGINE_FRAME);
        expect(client.dataAge).toBeGreaterThanOrEqual(0);
        expect(client.dataAge).toBeLessThan(100);
    });

    it('clears stale flag and emits engine:stale{stale:false} when recovering', () => {
        // Force stale state
        client._stale = true;
        const staleEvents = [];
        client.addEventListener('engine:stale', e => staleEvents.push(e.detail));

        client._onData(ENGINE_FRAME);

        expect(client.stale).toBe(false);
        expect(staleEvents).toHaveLength(1);
        expect(staleEvents[0].stale).toBe(false);
    });

    it('does not emit engine:stale when already not stale', () => {
        client._stale = false;
        const staleEvents = [];
        client.addEventListener('engine:stale', e => staleEvents.push(e.detail));

        client._onData(ENGINE_FRAME);

        expect(staleEvents).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Pi contract handshake (#113)
// ---------------------------------------------------------------------------
describe('EngineClient — Pi contract handshake (#113)', () => {
    let client;

    beforeEach(() => {
        vi.useFakeTimers();
        client = new EngineClient('127.0.0.1', 8082);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports 0 (not "unknown") before any data has ever been received', () => {
        expect(client.piContract).toBe(0);
        expect(client.piVersion).toBeNull();
        expect(client.piCapabilities).toEqual([]);
        // Not "old" — no live reading at all yet is a different, already-visible
        // failure mode ("offline"), not a version mismatch to warn about.
        expect(client.piContractOld).toBe(false);
    });

    it('a current-contract Pi reports ok — no mismatch', () => {
        client._onData(ENGINE_FRAME);
        client._connected = true; // _onData alone doesn't flip this; onopen does
        expect(client.piContract).toBe(2);
        expect(client.piVersion).toBe('3.4.0');
        expect(client.piCapabilities).toEqual(['fuel_tracker', 'sticky_valve', 'peak_egt']);
        expect(client.piContractOld).toBe(false);
    });

    it('a missing api_contract field is treated as contract 0 and flagged old, not silently accepted', () => {
        client._onData(ENGINE_FRAME_NO_CONTRACT);
        client._connected = true;
        expect(client.piContract).toBe(0);
        expect(client.piContractOld).toBe(true);
    });

    it('an explicit old contract number is flagged old', () => {
        client._onData(ENGINE_FRAME_OLD_CONTRACT);
        client._connected = true;
        expect(client.piContract).toBe(1);
        expect(client.piContractOld).toBe(true);
    });

    it('a contract newer than MIN_PI_CONTRACT is NOT flagged old — the Pi may legitimately be ahead', () => {
        client._onData({ ...ENGINE_FRAME, api_contract: 99 });
        client._connected = true;
        expect(client.piContractOld).toBe(false);
    });

    it('is never flagged old while disconnected, even with a stale old-contract reading cached', () => {
        // EnginePanel-style behavior: lastData survives a disconnect so gauges
        // don't flash dashes. The contract check must not piggyback on that
        // stale data while genuinely offline — that is "ENGINE MON. OFFLINE",
        // a different, already-visible problem.
        client._onData(ENGINE_FRAME_NO_CONTRACT);
        client._connected = true;
        expect(client.piContractOld).toBe(true);

        client._connected = false;
        expect(client.piContractOld).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Engine panel data-flatten tests (inline logic, no DOM required)
// ---------------------------------------------------------------------------
describe('EnginePanel data flatten', () => {
    it('merges nested data fields to top level', () => {
        const raw = ENGINE_FRAME;
        const flat = raw.data ? { ...raw, ...raw.data } : raw;

        // Top-level engine status fields survive
        expect(flat.percent_power).toBe(65.0);
        expect(flat.rop_lop_mode).toBe('RICH');
        expect(flat.version).toBe('3.4.0');

        // Nested EDM fields promoted to top level
        expect(flat.RPM).toBe(2200);
        expect(flat.EGT1).toBe(1350);
        expect(flat.CHT4).toBe(355);
        expect(flat.Gallons_Rem).toBe(24.9);
        expect(flat.Oil_Temp).toBe(180.0);
    });

    it('preserves the original nested data object', () => {
        const raw = ENGINE_FRAME;
        const flat = raw.data ? { ...raw, ...raw.data } : raw;
        // data key is still present (spread doesn't remove it)
        expect(flat.data).toBeDefined();
        expect(flat.data.RPM).toBe(2200);
    });

    it('handles flat raw (no nested data) gracefully', () => {
        const raw = { rpm: 2200, egt1: 1350 };
        const flat = raw.data ? { ...raw, ...raw.data } : raw;
        expect(flat.rpm).toBe(2200);
        expect(flat.egt1).toBe(1350);
    });

    it('flat raw has no spurious extra keys', () => {
        const raw = { rpm: 2200, egt1: 1350 };
        const flat = raw.data ? { ...raw, ...raw.data } : raw;
        expect(Object.keys(flat)).toEqual(['rpm', 'egt1']);
    });
});
