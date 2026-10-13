/**
 * PositionHealthMonitor — what the pilot is told about own-ship, and why.
 * See web/shared/position-health.js for the 2026-10-13 background.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
global.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const PositionHealthMonitor = new Function(read('web/shared/position-health.js') + '\nreturn PositionHealthMonitor;')();

const FIX = { lat: 34.7, lon: -80.8, gps_fix_quality: 2, gps_sats: 11 };

function memStorage() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

function setup({ vpnActive = false, ownship = 'live' } = {}) {
    const stratux = new EventTarget();
    Object.assign(stratux, { connected: true, stale: false, situation: { ...FIX },
        deviceStatus: { GPS_solution: '3D GPS + SBAS', GPS_satellites_locked: 11, GPS_position_accuracy: 2.5, Uptime: 600000 } });
    const engine = { stale: false };
    const bridge = { active: false };
    const map = { ownshipState: { state: ownship, holdRemainingMs: 0 } };
    const vpn = { query: vi.fn(async () => ({ vpnActive, installed: true, enabled: true })) };
    const storage = memStorage();
    const mon = new PositionHealthMonitor({ stratux, engine, bridge, map, vpn, storage });
    return { stratux, engine, bridge, map, vpn, storage, mon };
}

/** Stratux data stops: stale fires, sockets error out. */
function dropLink(t, { engineToo }) {
    t.stratux.stale = true; t.stratux.connected = false;
    if (engineToo) t.engine.stale = true;
    t.map.ownshipState = { state: 'held', holdRemainingMs: 10000 };
    t.stratux.dispatchEvent(new Event('stratux:stale'));
}

function restore(t) {
    t.stratux.stale = false; t.stratux.connected = true; t.engine.stale = false;
    t.map.ownshipState = { state: 'live', holdRemainingMs: 0 };
    t.stratux.dispatchEvent(new CustomEvent('stratux:situation', { detail: t.stratux.situation }));
}

describe('PositionHealthMonitor', () => {
    let t;
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T15:46:00Z')); DiagLog.log.mockClear(); });
    afterEach(() => { t?.mon.stop(); vi.useRealTimers(); });

    it('all good: Stratux data flowing with a 3D fix', async () => {
        t = setup(); t.mon.start(); await vi.advanceTimersByTimeAsync(0);
        const s = t.mon.tick();
        expect(s.cause.code).toBe('ok');
        expect(s.ownship).toBe('live');
        expect(s.severity).toBe('ok');
        expect(s.stratux).toMatchObject({ flowing: true, hasFix: true, solution: '3D GPS + SBAS', sats: 11, accuracyM: 2.5, uptimeS: 600 });
        expect(s.hadFix).toBe(true);
    });

    it('a VPN is reported first, as danger, even with a good fix', async () => {
        t = setup({ vpnActive: true }); t.mon.start();
        await vi.advanceTimersByTimeAsync(1000);
        expect(t.mon.state.cause.code).toBe('vpn');
        expect(t.mon.state.severity).toBe('danger');
        expect(t.mon.state.vpn.active).toBe(true);
    });

    it('checks the VPN every 5 s, not every tick', async () => {
        t = setup(); t.mon.start();
        await vi.advanceTimersByTimeAsync(9900);
        expect(t.vpn.query).toHaveBeenCalledTimes(2);   // t=0 and t=5 s
    });

    it('data flowing but no fix: says so with the satellite count', () => {
        t = setup(); t.mon.start();
        t.stratux.situation = { ...FIX, gps_fix_quality: 0, gps_sats: 4 };
        t.map.ownshipState = { state: 'hidden', holdRemainingMs: 0 };
        const s = t.mon.tick();
        expect(s.cause.code).toBe('gps-nofix');
        expect(s.cause.text).toBe('Stratux GPS has no fix (4 satellites)');
        expect(s.severity).toBe('danger');               // own-ship hidden
    });

    it('dead reckoning is named as such', () => {
        t = setup(); t.mon.start();
        t.stratux.situation = { ...FIX, gps_fix_quality: 6 };
        expect(t.mon.tick().cause.text).toMatch(/dead reckoning/);
    });

    it('no Stratux data, engine monitor feeding position: engine-gps', () => {
        t = setup(); t.mon.start();
        dropLink(t, { engineToo: false }); t.bridge.active = true;
        t.map.ownshipState = { state: 'live', holdRemainingMs: 0 };
        expect(t.mon.tick().cause.code).toBe('engine-gps');
    });

    it('no Stratux AND no engine data: blames the tablet Wi-Fi, counting seconds', async () => {
        t = setup(); t.mon.start();
        dropLink(t, { engineToo: true });
        await vi.advanceTimersByTimeAsync(12000);
        const s = t.mon.state;
        expect(s.cause.code).toBe('link-tablet');
        expect(s.cause.text).toBe('No data from Stratux or the engine monitor for 12 s — tablet Wi-Fi problem');
        expect(s.ownship).toBe('held');
        expect(s.holdRemainingS).toBe(10);
        expect(s.severity).toBe('caution');
    });

    it('no Stratux data while the engine monitor is fine: blames the Stratux side', () => {
        t = setup(); t.mon.start();
        dropLink(t, { engineToo: false });
        expect(t.mon.tick().cause.code).toBe('link-stratux');
    });

    it('replay of 11:46 (VPN case): one episode, 25 s, with the Android error, persisted', async () => {
        t = setup(); t.mon.start(); await vi.advanceTimersByTimeAsync(1000);
        dropLink(t, { engineToo: true });
        window.dispatchEvent(new CustomEvent('stratux:link-error', { detail: { channel: 'situation', message: 'Software caused connection abort' } }));
        await vi.advanceTimersByTimeAsync(25000);
        restore(t);
        await vi.advanceTimersByTimeAsync(1000);
        const h = t.mon.history;
        expect(h).toHaveLength(1);
        expect(h[0]).toMatchObject({ code: 'link-tablet', durationS: 25, error: 'Software caused connection abort' });
        expect(t.mon.state.lastEnded).toMatchObject({ durationS: 25 });
        expect(JSON.parse(t.storage.getItem('flytab_position_events'))).toHaveLength(1);
        const lines = DiagLog.log.mock.calls.map(c => c[1]);
        expect(lines.some(l => l.startsWith('Problem: No data from Stratux or the engine monitor'))).toBe(true);
        expect(lines).toContain('Restored after 25 s (link-tablet) — Software caused connection abort');
    });

    it('startup before the first fix is not a dropout (nothing recorded)', async () => {
        t = setup({ ownship: 'none' });
        t.stratux.stale = true; t.stratux.connected = false; t.engine.stale = true;
        t.mon.start();
        await vi.advanceTimersByTimeAsync(20000);
        restore(t);
        await vi.advanceTimersByTimeAsync(1000);
        expect(t.mon.history).toHaveLength(0);
    });

    it('a VPN is recorded even before the first fix', async () => {
        t = setup({ vpnActive: true, ownship: 'none' });
        t.mon.start();
        await vi.advanceTimersByTimeAsync(3000);
        t.vpn.query.mockImplementation(async () => ({ vpnActive: false, installed: true, enabled: true }));
        await vi.advanceTimersByTimeAsync(6000);
        expect(t.mon.history.map(h => h.code)).toEqual(['vpn']);
    });

    it('history survives a restart of the app and is capped at 50', async () => {
        t = setup(); t.mon.start();
        for (let i = 0; i < 55; i++) {
            dropLink(t, { engineToo: true }); await vi.advanceTimersByTimeAsync(2000);
            restore(t); await vi.advanceTimersByTimeAsync(1000);
        }
        expect(t.mon.history).toHaveLength(50);
        const again = new PositionHealthMonitor({ stratux: t.stratux, engine: t.engine, storage: t.storage });
        expect(again.history).toHaveLength(50);
    });

    it('detects a Stratux restart from its uptime going backwards', async () => {
        t = setup(); t.mon.start();
        t.stratux.deviceStatus = { ...t.stratux.deviceStatus, Uptime: 2_000_000 };
        t.mon.tick();
        t.stratux.deviceStatus = { ...t.stratux.deviceStatus, Uptime: 30_000 };
        const s = t.mon.tick();
        expect(s.stratux.restartRecent).toBe(true);
        expect(s.stratux.restartAt).toBe(Date.now() - 30_000);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
        expect(t.mon.state.stratux.restartRecent).toBe(false);
    });

    it('normal uptime growth (and poll jitter) is not a restart', () => {
        t = setup(); t.mon.start();
        t.stratux.deviceStatus = { ...t.stratux.deviceStatus, Uptime: 600_000 }; t.mon.tick();
        t.stratux.deviceStatus = { ...t.stratux.deviceStatus, Uptime: 597_000 }; // 3 s "backwards" jitter
        const s = t.mon.tick();
        expect(s.stratux.restartAt).toBeNull();
        expect(s.stratux.restartRecent).toBe(false);
    });

    it('starts before the engine monitor exists; engine and bridge can be attached later', () => {
        const stratux = new EventTarget();
        Object.assign(stratux, { connected: false, stale: true, situation: null, deviceStatus: null });
        const mon = new PositionHealthMonitor({ stratux, map: { ownshipState: { state: 'none', holdRemainingMs: 0 } }, storage: memStorage() });
        mon.start();
        expect(mon.state.engine.ok).toBeNull();               // unknown, not "lost"
        // Engine state unknown: don't claim it's connected or blame either side.
        expect(mon.state.cause.code).toBe('link');
        expect(mon.state.cause.text).toMatch(/^No data from Stratux for \d+ s$/);
        const engine = { stale: true }, bridge = { active: false };
        mon.setSources({ engine, bridge });
        expect(mon.tick().cause.code).toBe('link-tablet');
        bridge.active = true;
        expect(mon.tick().cause.code).toBe('engine-gps');
        mon.stop();
    });

    it('without the VPN plugin (browser) the VPN state is unknown, never "off"', async () => {
        t = setup(); t.vpn.query = vi.fn(async () => null); t.mon.start();
        await vi.advanceTimersByTimeAsync(1000);
        expect(t.mon.state.vpn.active).toBeNull();
        expect(t.mon.state.cause.code).toBe('ok');
    });
});
