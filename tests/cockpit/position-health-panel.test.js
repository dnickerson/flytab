/**
 * GPS detail panel (cockpit/position-health-panel.js): opened from the GPS
 * badge or the position banner. Live while open; plain words, one row per link.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Times are shown in the tablet's local time; pin it so the test is machine-independent.
process.env.TZ = 'America/New_York';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const { wireIsolatedTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireIsolatedTap };')();
global.wireIsolatedTap = wireIsolatedTap;
const PositionHealthPanel = new Function(read('web/cockpit/position-health-panel.js') + '\nreturn PositionHealthPanel;')();

const T0 = new Date('2026-10-13T16:08:13Z').getTime();   // 12:08:13 EDT
const BASE = {
    ownship: 'live', holdRemainingS: 0, hadFix: true,
    cause: { code: 'ok', text: 'Position from Stratux GPS' }, severity: 'ok',
    stratux: { flowing: true, lostS: 0, hasFix: true, solution: '3D GPS + SBAS', sats: 11, accuracyM: 2.5, uptimeS: 2160, restartAt: null, restartRecent: false },
    link: { lastError: null }, engine: { ok: true, bridgeActive: false }, vpn: { active: false },
    episodeId: null, lastEnded: null, at: T0,
};

function touchTap(node) {
    const mk = (type) => { const e = new Event(type, { bubbles: true, cancelable: true }); const p = [{ clientX: 5, clientY: 5 }]; e.touches = type === 'touchend' ? [] : p; e.changedTouches = p; return e; };
    node.dispatchEvent(mk('touchstart')); node.dispatchEvent(mk('touchend'));
}

describe('PositionHealthPanel', () => {
    let monitor, panel, h;
    const emit = (st) => { monitor.state = st; monitor.dispatchEvent(new CustomEvent('change', { detail: st })); };
    const text = (sel) => panel.element.querySelector(sel)?.textContent ?? null;

    beforeEach(() => {
        vi.useFakeTimers(); vi.setSystemTime(T0);
        document.body.innerHTML = '<div id="statusBar"></div><main></main>';
        monitor = new EventTarget(); monitor.state = BASE; monitor.history = [];
        h = { onGpsSettings: vi.fn(), onFullLog: vi.fn(), openVpnSettings: vi.fn() };
        panel = new PositionHealthPanel(document.getElementById('statusBar'), monitor, h);
    });
    afterEach(() => { panel.destroy(); vi.useRealTimers(); });

    it('sits right after the status bar and starts closed', () => {
        expect(document.getElementById('statusBar').nextElementSibling).toBe(panel.element);
        expect(panel.visible).toBe(false);
    });

    it('all good: LIVE, Stratux GPS details, links OK, VPN off', () => {
        panel.show();
        expect(text('.php-status')).toBe('POSITION LIVE');
        expect(text('.php-cause')).toBe('Position from Stratux GPS');
        expect(text('[data-row="gps"] .php-val')).toBe('3D GPS + SBAS · 11 satellites · ±2.5 m · up 36 min');
        expect(text('[data-row="link"] .php-val')).toBe('OK');
        expect(text('[data-row="engine"] .php-val')).toBe('OK');
        expect(text('[data-row="vpn"] .php-val')).toBe('Off');
        expect(panel.element.querySelector('[data-act="vpn-settings"]').hidden).toBe(true);
    });

    it('dropout: HELD with countdown, link LOST with seconds and the last Android error', () => {
        panel.show();
        emit({ ...BASE, ownship: 'held', holdRemainingS: 9, severity: 'caution',
            cause: { code: 'link-tablet', text: 'No data from Stratux or the engine monitor for 6 s — tablet Wi-Fi problem' },
            stratux: { ...BASE.stratux, flowing: false, lostS: 6 }, engine: { ok: false, bridgeActive: false },
            link: { lastError: { channel: 'situation', message: 'Software caused connection abort', at: T0 } } });
        expect(text('.php-status')).toBe('POSITION HELD · 9 s');
        expect(text('[data-row="link"] .php-val')).toBe('LOST 6 s');
        expect(text('[data-row="link"] .php-note')).toBe('Last error 12:08:13: Software caused connection abort');
        expect(text('[data-row="engine"] .php-val')).toBe('LOST');
        expect(panel.element.querySelector('.php-status').classList.contains('php-status--caution')).toBe(true);
    });

    it('VPN on: red, and an OPEN VPN SETTINGS button that works', () => {
        panel.show();
        emit({ ...BASE, severity: 'danger', cause: { code: 'vpn', text: 'A VPN is on — it disrupts the Stratux link. Turn it off.' }, vpn: { active: true } });
        expect(text('[data-row="vpn"] .php-val')).toBe('A VPN IS ON');
        const btn = panel.element.querySelector('[data-act="vpn-settings"]');
        expect(btn.hidden).toBe(false);
        touchTap(btn);
        expect(h.openVpnSettings).toHaveBeenCalledTimes(1);
    });

    it('VPN not checkable (no plugin): says Unknown, not Off', () => {
        panel.show();
        emit({ ...BASE, vpn: { active: null } });
        expect(text('[data-row="vpn"] .php-val')).toBe('Unknown');
    });

    it('recent Stratux restart is called out', () => {
        panel.show();
        emit({ ...BASE, stratux: { ...BASE.stratux, uptimeS: 30, restartAt: T0 - 30000, restartRecent: true } });
        expect(text('[data-row="gps"] .php-note')).toBe('Stratux restarted at 12:07:43 — power interruption?');
    });

    it('dropout history, newest first, in local time', () => {
        monitor.history = [
            { start: T0 + 47000, end: T0 + 72000, durationS: 25, code: 'link-tablet', text: 'x', error: 'Software caused connection abort' },
            { start: T0, end: T0 + 25000, durationS: 25, code: 'link-tablet', text: 'x', error: null },
        ];
        panel.show();
        const rows = [...panel.element.querySelectorAll('.php-history li')].map(li => li.textContent);
        expect(rows).toEqual([
            '12:09:00 · 25 s · Tablet Wi-Fi (Stratux and engine monitor both lost) · Software caused connection abort',
            '12:08:13 · 25 s · Tablet Wi-Fi (Stratux and engine monitor both lost)',
        ]);
    });

    it('history labels the "engine state unknown" case without blaming a side', () => {
        monitor.history = [{ start: T0, end: T0 + 5000, durationS: 5, code: 'link', text: 'x', error: null }];
        panel.show();
        expect(panel.element.querySelector('.php-history li').textContent).toBe('12:08:13 · 5 s · No data from Stratux');
    });

    it('updates only while open', () => {
        emit({ ...BASE, ownship: 'held', holdRemainingS: 4 });
        expect(text('.php-status')).not.toBe('POSITION HELD · 4 s');
        panel.show();
        expect(text('.php-status')).toBe('POSITION HELD · 4 s');
    });

    it('GPS SETTINGS, FULL LOG and CLOSE do what they say', () => {
        panel.show();
        touchTap(panel.element.querySelector('[data-act="gps-settings"]'));
        expect(h.onGpsSettings).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1000);
        touchTap(panel.element.querySelector('[data-act="full-log"]'));
        expect(h.onFullLog).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1000);
        touchTap(panel.element.querySelector('[data-act="close"]'));
        expect(panel.visible).toBe(false);
    });
});
