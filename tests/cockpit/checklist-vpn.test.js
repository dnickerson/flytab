/**
 * Checklist "ExpressVPN" item shows live VPN status and an OPEN button.
 *
 * 2026-10-13: ExpressVPN on the cockpit tablet switched its underlying network
 * every ~47.5 s on the Stratux Wi-Fi (no internet) and broke every Stratux
 * connection each time -- own-ship faded in and out for the whole flight. The
 * pilot wants the Before Start item to say whether a VPN is on, and a button
 * that opens ExpressVPN so they can stop it.
 *
 * Android only says THAT a VPN is up (NetworkCapabilities.TRANSPORT_VPN), not
 * which app owns it, so "VPN ON" means any VPN.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const VpnStatus = new Function(read('web/shared/vpn-status.js') + '\nreturn VpnStatus;')();
global.VpnStatus = VpnStatus;
const Checklist = new Function(read('web/cockpit/checklist.js') + '\nreturn Checklist;')();

const PKG = 'com.expressvpn.vpn';
const DATA = {
    metadata: { tailNumber: 'N194JT' },
    groups: [{ type: 'normal', sections: [{ name: 'VFR', checklists: [{
        name: 'Before Start',
        items: [
            { title: 'Master', response: 'ON' },
            { title: 'ExpressVPN', response: 'OFF', statusSource: 'vpn', app: PKG },
        ],
    }] }] }],
};

describe('VpnStatus.describe — what the item says', () => {
    it.each([
        ['VPN up, ExpressVPN installed+enabled', { vpnActive: true, installed: true, enabled: true }, 'VPN ON ✗', 'bad', true],
        ['VPN up, ExpressVPN disabled (another VPN)', { vpnActive: true, installed: true, enabled: false }, 'VPN ON ✗', 'bad', false],
        ['no VPN, ExpressVPN installed+enabled', { vpnActive: false, installed: true, enabled: true }, 'OFF ✓', 'ok', true],
        ['no VPN, ExpressVPN disabled', { vpnActive: false, installed: true, enabled: false }, 'DISABLED ✓', 'ok', false],
        ['no VPN, not installed', { vpnActive: false, installed: false, enabled: false }, 'NOT INSTALLED ✓', 'ok', false],
    ])('%s', (_n, st, text, state, canOpen) => {
        expect(VpnStatus.describe(st)).toEqual({ text, state, canOpen });
    });

    it('no answer (plugin missing or failed) is never shown as OK', () => {
        expect(VpnStatus.describe(null)).toEqual({ text: 'UNKNOWN', state: 'unknown', canOpen: false });
    });
});

describe('VpnStatus — plugin calls are limited to allowed apps', () => {
    afterEach(() => { delete global.Capacitor; });

    it('query/open do nothing for a package not on the allowlist', async () => {
        const status = vi.fn(), openApp = vi.fn();
        global.Capacitor = { Plugins: { VpnStatus: { status, openApp } } };
        expect(await VpnStatus.query('com.evil.app')).toBeNull();
        expect(await VpnStatus.open('com.evil.app')).toBe(false);
        expect(status).not.toHaveBeenCalled();
        expect(openApp).not.toHaveBeenCalled();
    });

    it('without the native plugin (browser) query returns null', async () => {
        expect(await VpnStatus.query(PKG)).toBeNull();
    });
});

describe('Checklist ExpressVPN item', () => {
    let status, openApp, cl, resumeCb;

    async function build(st) {
        status = vi.fn(async () => st);
        openApp = vi.fn(async () => ({}));
        global.Capacitor = { Plugins: {
            VpnStatus: { status, openApp },
            App: { addListener: (ev, cb) => { if (ev === 'resume') resumeCb = cb; } },
        } };
        global.fetch = vi.fn(async () => ({ ok: true, json: async () => DATA }));
        cl = new Checklist(document.body);
        await vi.waitFor(() => expect(cl._bodyEl.querySelector('[data-vpn-app]')).not.toBeNull());
    }
    const badge = () => cl._bodyEl.querySelector('.checklist-item-response[data-vpn-app]');
    const openBtn = () => cl._bodyEl.querySelector('.checklist-vpn-open');
    const vpnItem = () => cl._bodyEl.querySelector('.checklist-item[data-idx="1"]');

    beforeEach(() => { document.body.innerHTML = ''; resumeCb = null; });
    afterEach(() => { cl?.hide(); delete global.Capacitor; delete global.fetch; vi.useRealTimers(); });

    it('shows CHECKING… before the first answer, then the live state once shown', async () => {
        await build({ vpnActive: true, installed: true, enabled: true });
        expect(badge().textContent).toBe('CHECKING…');
        cl.show();
        await vi.waitFor(() => expect(badge().textContent).toBe('VPN ON ✗'));
        expect(badge().classList.contains('checklist-vpn-badge--bad')).toBe(true);
        expect(openBtn().hidden).toBe(false);
        expect(status).toHaveBeenCalledWith({ package: PKG });
    });

    it('ExpressVPN disabled: DISABLED ✓, green, no OPEN button', async () => {
        await build({ vpnActive: false, installed: true, enabled: false });
        cl.show();
        await vi.waitFor(() => expect(badge().textContent).toBe('DISABLED ✓'));
        expect(badge().classList.contains('checklist-vpn-badge--ok')).toBe(true);
        expect(openBtn().hidden).toBe(true);
    });

    it('OPEN (tap) launches ExpressVPN and does NOT check or uncheck the item', async () => {
        await build({ vpnActive: true, installed: true, enabled: true });
        cl.show();
        await vi.waitFor(() => expect(openBtn().hidden).toBe(false));
        const btn = openBtn();
        const t = (type, x = 10, y = 10) => {
            const e = new Event(type, { bubbles: true, cancelable: true });
            const pt = [{ clientX: x, clientY: y }];
            e.touches = type === 'touchend' ? [] : pt; e.changedTouches = pt;
            return e;
        };
        btn.dispatchEvent(t('touchstart'));
        const end = t('touchend');
        btn.dispatchEvent(end);
        expect(end.defaultPrevented).toBe(true);          // cancels the synthetic click
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(openApp).toHaveBeenCalledTimes(1));
        expect(openApp).toHaveBeenCalledWith({ package: PKG });
        expect(vpnItem().classList.contains('checked')).toBe(false);
        expect(Object.values(cl._checked).some(Boolean)).toBe(false);
    });

    it('a drag that starts on OPEN does not launch anything', async () => {
        await build({ vpnActive: true, installed: true, enabled: true });
        cl.show();
        await vi.waitFor(() => expect(openBtn().hidden).toBe(false));
        const btn = openBtn();
        const s = new Event('touchstart', { bubbles: true, cancelable: true });
        s.touches = s.changedTouches = [{ clientX: 10, clientY: 10 }];
        const e = new Event('touchend', { bubbles: true, cancelable: true });
        e.touches = []; e.changedTouches = [{ clientX: 10, clientY: 80 }];
        btn.dispatchEvent(s); btn.dispatchEvent(e);
        await new Promise(r => setTimeout(r, 20));
        expect(openApp).not.toHaveBeenCalled();
        expect(vpnItem().classList.contains('checked')).toBe(false);
    });

    it('tapping the item row still checks it (OPEN did not break normal checking)', async () => {
        await build({ vpnActive: false, installed: true, enabled: true });
        cl.show();
        vpnItem().querySelector('.checklist-item-title').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(cl._bodyEl.querySelector('.checklist-item[data-idx="1"]').classList.contains('checked')).toBe(true);
    });

    it('re-checks every 2 s while open, stops when closed', async () => {
        vi.useFakeTimers();
        await build({ vpnActive: false, installed: true, enabled: true });
        cl.show();
        await vi.advanceTimersByTimeAsync(0);
        const n = status.mock.calls.length;
        await vi.advanceTimersByTimeAsync(4000);
        expect(status.mock.calls.length).toBe(n + 2);
        cl.hide();
        await vi.advanceTimersByTimeAsync(10000);
        expect(status.mock.calls.length).toBe(n + 2);
    });

    it('turns green as soon as the pilot comes back from ExpressVPN (app resume)', async () => {
        vi.useFakeTimers();
        await build({ vpnActive: true, installed: true, enabled: true });
        cl.show();
        await vi.advanceTimersByTimeAsync(0);
        expect(badge().textContent).toBe('VPN ON ✗');
        status.mockImplementation(async () => ({ vpnActive: false, installed: true, enabled: true }));
        resumeCb();
        await vi.advanceTimersByTimeAsync(0);         // well before the next 2 s tick
        expect(badge().textContent).toBe('OFF ✓');
    });

    it('checklist.json marks the ExpressVPN item as a live VPN item', () => {
        const data = JSON.parse(read('web/checklist.json'));
        const items = data.groups.flatMap(g => g.sections.flatMap(s => s.checklists.flatMap(c => c.items)));
        const vpn = items.filter(i => i.title === 'ExpressVPN');
        expect(vpn.length).toBeGreaterThan(0);
        for (const i of vpn) { expect(i.statusSource).toBe('vpn'); expect(i.app).toBe(PKG); }
    });
});
