/**
 * PR #214 review finding 1: frozen EMS → REMAINING reads high unmarked.
 *
 * Burn integration stops when the frame is not current (EngineClient.edmCurrent
 * false) or no frames arrive (engine:stale {stale:true} / engine:disconnect). If the
 * engine was running (the last CURRENT frame had GPH > 0), the tracked figure stops
 * falling while fuel is still burning, so it must be marked UNCONFIRMED at once — not
 * 45 min later (FuelTankState.STALE_MS) — and the mark must clear on the next current
 * sample with flow. Engine off on the ground (last current GPH 0) must not mark it.
 *
 * Finding 7: on stale / disconnect the s: sender readouts blank to s:— (same as a
 * frozen frame).
 *
 * Real FuelTanksDisplay, FuelTankState, FuelState, FuelEngine and EngineClient.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));
globalThis.DiagLog = vi.fn();
globalThis.Settings      = new Function(read('web/shared/settings.js') + '\nreturn Settings;')();
globalThis.FuelEngine    = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState     = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
globalThis.EngineClient  = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const FuelTanksDisplay   = new Function(read('web/cockpit/fuel-tanks.js') + '\nreturn FuelTanksDisplay;')();

let widget = null;
let client = null;
let NOW = 0;
const at = (ms) => { NOW = ms; vi.setSystemTime(NOW); };

function mount() {
    client = new EventTarget();
    window.engineClient = client;
    widget = new FuelTanksDisplay(document.body);
    widget.init();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(Date.UTC(2026, 10, 9, 15, 0));
    localStorage.clear();
    Settings.fuelManualOverride = null;
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (p) => (p === 'performance.fuel_capacity_gal' ? 36
            : p === 'performance.fuel_sender_accurate_below_gal' ? 12 : undefined),
    };
    FuelTankState.init(10, 8, 'L');
    mount();
});

afterEach(() => {
    try { widget && widget.destroy(); } catch (_) { /* */ }
    widget = null;
    delete window.engineClient;
    document.body.innerHTML = '';
    vi.useRealTimers();
});

const current = (gph, extra = {}) => new CustomEvent('engine:data', {
    detail: { serial_connected: true, data: { Fuel_Flow: gph, RPM: gph > 0 ? 2400 : 0, Fuel_Left: 5.2, Fuel_Right: 4.1, ...extra } },
});
const frozen = (gph) => new CustomEvent('engine:data', {
    detail: { serial_connected: true, serial_warning: 'No EDM data for 6s',
              data: { Fuel_Flow: gph, RPM: 2400, Fuel_Left: 5.2, Fuel_Right: 4.1 } },
});
const cruise = () => { for (let i = 0; i < 3; i++) { at(NOW + 1000); client.dispatchEvent(current(9)); } };
const stale = () => FuelState.getCurrentFuel().stale;

describe('finding 1: flow lost while the engine runs → UNCONFIRMED at once', () => {
    it('a frozen frame in cruise marks the tracked figure stale immediately', () => {
        cruise();
        expect(stale()).toBe(false);
        at(NOW + 1000);
        client.dispatchEvent(frozen(9));
        expect(stale()).toBe(true);
        expect(FuelTankState.needsConfirmation()).toBe(true);
        expect(FuelTankState.isFlowLost()).toBe(true);
        // The widget shows it marked (same '?' as the 45-min case).
        expect(widget._dom.total.textContent).toMatch(/\?$/);
        expect(widget._dom.total.classList.contains('ftw-unconfirmed')).toBe(true);
    });

    it('the next current frame with flow clears it, and the gap burn is recorded as a dropped-burn estimate', () => {
        cruise();
        at(NOW + 1000);
        client.dispatchEvent(frozen(9));
        expect(stale()).toBe(true);
        at(NOW + 60000);                         // one minute frozen
        client.dispatchEvent(current(9));
        expect(stale()).toBe(false);
        expect(FuelTankState.isFlowLost()).toBe(false);
        expect(FuelTankState.getState().dropped_burn_estimate_gal).toBeGreaterThan(0.1);
        expect(widget._dom.total.textContent).not.toMatch(/\?$/);
    });

    it('engine:stale {stale:true} after cruise marks it; engine:disconnect too', () => {
        cruise();
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true, ageMs: 6000 } }));
        expect(stale()).toBe(true);
        at(NOW + 1000);
        client.dispatchEvent(current(9));
        expect(stale()).toBe(false);
        client.dispatchEvent(new CustomEvent('engine:disconnect'));
        expect(stale()).toBe(true);
    });

    it('a current frame with GPH 0 does not clear it (gap burn unknown; the pilot confirms)', () => {
        cruise();
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        at(NOW + 5 * 60000);
        client.dispatchEvent(current(0));
        expect(stale()).toBe(true);
        // A fresh fuel entry (widget SET / recovery CONFIRM / tic) clears it.
        FuelTankState.init(9, 7, 'L');
        expect(stale()).toBe(false);
    });

    it('persists across an app restart (localStorage)', () => {
        cruise();
        at(NOW + 1000);
        client.dispatchEvent(frozen(9));
        FuelTankState._state = null;
        FuelTankState._loaded = false;
        expect(stale()).toBe(true);
    });

    it('a tank switch still works from the badges while flow is lost', () => {
        cruise();
        at(NOW + 1000);
        client.dispatchEvent(frozen(9));
        widget._onBadgeTap('R');
        expect(FuelTankState.getState().active_tank).toBe('R');
        expect(widget._dom.initPanel.style.display).not.toBe('flex');
    });
});

describe('finding 1: engine off on the ground is not marked', () => {
    it('current GPH 0 then frozen frames: not stale', () => {
        at(NOW + 1000);
        client.dispatchEvent(current(0));
        at(NOW + 1000);
        client.dispatchEvent(frozen(0));
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        client.dispatchEvent(new CustomEvent('engine:disconnect'));
        expect(stale()).toBe(false);
    });

    it('no current frame seen this session and no recent burn: not stale', () => {
        at(NOW + 10 * 60000);                    // tablet on, Pi resending an old row
        client.dispatchEvent(frozen(9));
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        expect(stale()).toBe(false);
    });

    it('app restarted in flight (burn integrated < 2 min ago), first frame frozen: marked', () => {
        cruise();
        widget.destroy();
        FuelTankState._state = null;
        FuelTankState._loaded = false;
        at(NOW + 30000);
        mount();
        client.dispatchEvent(frozen(9));
        expect(stale()).toBe(true);
    });

    it('init() just now (no burn integrated yet) and a frozen frame: not marked', () => {
        at(NOW + 1000);
        client.dispatchEvent(frozen(9));
        expect(stale()).toBe(false);
    });
});

describe('finding 7: stale / disconnect blank the s: sender readouts', () => {
    it('engine:stale {stale:true} → s:—', () => {
        client.dispatchEvent(current(9));
        expect(widget._dom.senderL.textContent).toBe('s:5.2');
        expect(widget._dom.senderR.textContent).toBe('s:4.1');
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        expect(widget._dom.senderL.textContent).toBe('s:\u2014');
        expect(widget._dom.senderR.textContent).toBe('s:\u2014');
    });

    it('engine:disconnect → s:—; the next current frame shows them again', () => {
        client.dispatchEvent(current(9));
        client.dispatchEvent(new CustomEvent('engine:disconnect'));
        expect(widget._dom.senderL.textContent).toBe('s:\u2014');
        expect(widget._dom.senderR.textContent).toBe('s:\u2014');
        client.dispatchEvent(current(9, { Fuel_Left: 6.0 }));
        expect(widget._dom.senderL.textContent).toBe('s:6.0');
    });

    it('a sender never shown stays empty', () => {
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        expect(widget._dom.senderL.textContent).toBe('');
        expect(widget._dom.senderR.textContent).toBe('');
    });
});

describe('revealTankControl (checklist FlyTab Tank → SET)', () => {
    it('shows a hidden widget and highlights the L / R badges', () => {
        widget.hide();
        expect(widget._el.style.display).toBe('none');
        widget.revealTankControl();
        expect(widget._el.style.display).toBe('');
        expect(widget._dom.badgeL.classList.contains('ftw-badge-attn')).toBe(true);
        expect(widget._dom.badgeR.classList.contains('ftw-badge-attn')).toBe(true);
        // A badge tap sets the tank as before.
        widget._onBadgeTap('R');
        expect(FuelTankState.getState().active_tank).toBe('R');
    });
});

describe('re-review M1: "running" also needs RPM > 300 on the last current frame', () => {
    it('last current frame RPM 0 / fuel flow 0.7 (shutdown residual), then data lost: not marked', () => {
        cruise();
        at(NOW + 1000);
        client.dispatchEvent(current(0.7, { RPM: 0 }));
        at(NOW + 1000);
        client.dispatchEvent(frozen(0.7));
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        expect(stale()).toBe(false);
    });

    it('a current frame with no RPM field does not count as running', () => {
        at(NOW + 1000);
        client.dispatchEvent(new CustomEvent('engine:data', {
            detail: { serial_connected: true, data: { Fuel_Flow: 9 } } }));
        client.dispatchEvent(new CustomEvent('engine:disconnect'));
        expect(stale()).toBe(false);
    });
});

describe('re-review I1: badge taps while the checklist reveal is active never open the quantity dialog', () => {
    const dialogOpen = () => widget._dom.initPanel.style.display === 'flex';
    const status = () => widget._dom.revealStatus.textContent;

    it('already-active badge: confirms in place, no dialog, tank unchanged', () => {
        widget.revealTankControl();
        widget._onBadgeTap('L');
        expect(dialogOpen()).toBe(false);
        expect(status()).toBe('LEFT already set');
        expect(widget._dom.revealStatus.style.display).toBe('');
        expect(FuelTankState.getState().active_tank).toBe('L');
    });

    it('the other badge: switches, no dialog', () => {
        widget.revealTankControl();
        widget._onBadgeTap('R');
        expect(dialogOpen()).toBe(false);
        expect(FuelTankState.getState().active_tank).toBe('R');
        expect(status()).toBe('Switched to RIGHT');
    });

    it('requires_confirm (45+ min without a sample): no dialog, no switch, the reason points to the FUEL screen', () => {
        FuelTankState._state.last_sample_at = new Date(NOW - 50 * 60000).toISOString();
        FuelTankState._save();
        expect(FuelTankState.getState().requires_confirm).toBe(true);
        widget.revealTankControl();
        for (const t of ['L', 'R']) {
            widget._onBadgeTap(t);
            expect(dialogOpen()).toBe(false);
            expect(status()).toMatch(/FUEL/);
            expect(status()).toMatch(/tic/i);
        }
        expect(FuelTankState.getState().active_tank).toBe('L');
        expect(FuelTankState.getState().requires_confirm).toBe(true);   // not confirmed by a tap
    });

    it('no fuel entered at all: no dialog, reason shown', () => {
        FuelTankState._state = null; localStorage.clear(); FuelTankState._loaded = true;
        widget.revealTankControl();
        widget._onBadgeTap('L');
        expect(dialogOpen()).toBe(false);
        expect(status()).toMatch(/FUEL/);
    });

    it('outside reveal mode the existing behaviour is unchanged', () => {
        widget._onBadgeTap('L');                 // active badge → quantity dialog
        expect(dialogOpen()).toBe(true);
        widget._dom.initPanel.style.display = 'none';
        widget._onBadgeTap('R');                 // other badge → switch
        expect(FuelTankState.getState().active_tank).toBe('R');
        FuelTankState._state.last_sample_at = new Date(NOW - 50 * 60000).toISOString();
        FuelTankState._save();
        widget._onBadgeTap('L');                 // requires_confirm → dialog
        expect(dialogOpen()).toBe(true);
    });

    it('reveal mode ends after REVEAL_MS; the status line clears', () => {
        widget.revealTankControl();
        widget._onBadgeTap('L');
        at(NOW + FuelTanksDisplay.REVEAL_MS + 1000);
        widget._onBadgeTap('L');
        expect(dialogOpen()).toBe(true);
        expect(widget._dom.revealStatus.style.display).toBe('none');
    });
});
