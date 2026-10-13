/**
 * Position banner over the map (cockpit/position-health-banner.js).
 *
 * Pilot's two hard requirements:
 *  1. touching the banner can never activate anything underneath it (the map);
 *  2. the pilot can make it go away (DISMISS), for the current problem.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const { wireIsolatedTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireIsolatedTap };')();
global.wireIsolatedTap = wireIsolatedTap;
const PositionHealthBanner = new Function(read('web/cockpit/position-health-banner.js') + '\nreturn PositionHealthBanner;')();

const OK = { ownship: 'live', holdRemainingS: 0, hadFix: true, cause: { code: 'ok', text: 'Position from Stratux GPS' }, severity: 'ok', episodeId: null, lastEnded: null };
const HELD = { ...OK, ownship: 'held', holdRemainingS: 9, cause: { code: 'link-tablet', text: 'No data from Stratux or the engine monitor for 6 s — tablet Wi-Fi problem' }, severity: 'caution', episodeId: 1 };
const LOST = { ...HELD, ownship: 'hidden', severity: 'danger' };
const VPN = { ...OK, cause: { code: 'vpn', text: 'A VPN is on — it disrupts the Stratux link. Turn it off.' }, severity: 'danger', episodeId: 2 };
const ENG = { ...OK, cause: { code: 'engine-gps', text: 'No data from Stratux — position from the engine monitor' }, severity: 'caution', episodeId: 3 };

function touch(type, x = 10, y = 10) {
    const e = new Event(type, { bubbles: true, cancelable: true });
    const pt = [{ clientX: x, clientY: y }];
    e.touches = type === 'touchend' ? [] : pt; e.changedTouches = pt;
    return e;
}

describe('PositionHealthBanner', () => {
    let container, monitor, banner, onOpenDetails, under;
    const emit = (st) => { monitor.state = st; monitor.dispatchEvent(new CustomEvent('change', { detail: st })); };
    const el = () => container.querySelector('.ph-banner');
    const shown = () => el().style.display !== 'none';

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="mapContainer"><div id="primaryView"></div></div>';
        container = document.getElementById('mapContainer');
        // Anything listening on the map area (the map's own touch pipeline, like
        // map.js's capture-phase touchstart) must never see a banner touch.
        under = vi.fn();
        for (const t of ['touchstart', 'touchend', 'click', 'pointerdown', 'mousedown']) {
            container.addEventListener(t, under);
            document.addEventListener(t, under);
        }
        monitor = new EventTarget(); monitor.state = OK;
        onOpenDetails = vi.fn();
        banner = new PositionHealthBanner(container, monitor, { onOpenDetails });
    });
    afterEach(() => { banner.destroy(); vi.useRealTimers(); });

    it('hidden while all is well', () => {
        emit(OK);
        expect(shown()).toBe(false);
    });

    it('position held: amber, title counts down, plain-language cause', () => {
        emit(HELD);
        expect(shown()).toBe(true);
        expect(el().classList.contains('ph-banner--caution')).toBe(true);
        expect(el().querySelector('.ph-banner-title').textContent).toBe('POSITION HELD · 9 s');
        expect(el().querySelector('.ph-banner-detail').textContent).toBe(HELD.cause.text);
    });

    it('position lost: red', () => {
        emit(LOST);
        expect(el().classList.contains('ph-banner--danger')).toBe(true);
        expect(el().querySelector('.ph-banner-title').textContent).toBe('POSITION LOST');
    });

    it('a VPN shows even before any fix (on the ground)', () => {
        emit({ ...VPN, hadFix: false, ownship: 'none' });
        expect(shown()).toBe(true);
        expect(el().querySelector('.ph-banner-title').textContent).toBe('A VPN IS ON');
        expect(el().classList.contains('ph-banner--danger')).toBe(true);
    });

    it('engine-monitor position in use: amber notice even though own-ship is live', () => {
        emit(ENG);
        expect(shown()).toBe(true);
        expect(el().querySelector('.ph-banner-title').textContent).toBe('POSITION FROM ENGINE MONITOR');
    });

    it('no nagging at startup: no fix yet and no VPN -> nothing shown', () => {
        emit({ ...HELD, hadFix: false, ownship: 'none' });
        expect(shown()).toBe(false);
    });

    it('DISMISS hides it for the current problem; a NEW problem shows it again', () => {
        emit(HELD);
        const btn = el().querySelector('.ph-banner-dismiss');
        btn.dispatchEvent(touch('touchstart')); btn.dispatchEvent(touch('touchend'));
        expect(shown()).toBe(false);
        emit({ ...HELD, holdRemainingS: 5 });              // same episode, next tick
        expect(shown()).toBe(false);
        emit(OK);                                          // recovered
        emit({ ...HELD, episodeId: 7 });                   // a new dropout
        expect(shown()).toBe(true);
    });

    it('review: a dismissed amber problem that gets WORSE (lost) shows again, red', () => {
        emit(HELD);
        const btn = el().querySelector('.ph-banner-dismiss');
        btn.dispatchEvent(touch('touchstart')); btn.dispatchEvent(touch('touchend'));
        expect(shown()).toBe(false);
        emit(LOST);                                        // same episode, escalated
        expect(shown()).toBe(true);
        expect(el().querySelector('.ph-banner-title').textContent).toBe('POSITION LOST');
    });

    it('review: a dismissed red problem stays dismissed if it eases to amber', () => {
        emit(LOST);
        const btn = el().querySelector('.ph-banner-dismiss');
        btn.dispatchEvent(touch('touchstart')); btn.dispatchEvent(touch('touchend'));
        emit({ ...HELD });
        expect(shown()).toBe(false);
    });

    it('recovery: brief green "restored" with the dropout length, then gone', () => {
        emit(HELD);
        emit({ ...OK, lastEnded: { id: 1, durationS: 14 } });
        expect(shown()).toBe(true);
        expect(el().classList.contains('ph-banner--ok')).toBe(true);
        expect(el().querySelector('.ph-banner-title').textContent).toBe('POSITION RESTORED · dropout 14 s');
        vi.advanceTimersByTime(5000);
        expect(shown()).toBe(false);
    });

    it('no "restored" notice for a problem the pilot dismissed', () => {
        emit(HELD);
        const btn = el().querySelector('.ph-banner-dismiss');
        btn.dispatchEvent(touch('touchstart')); btn.dispatchEvent(touch('touchend'));
        expect(shown()).toBe(false);
        emit({ ...OK, lastEnded: { id: 1, durationS: 14 } });
        expect(shown()).toBe(false);
    });

    it('tapping the body opens the details', () => {
        emit(HELD);
        const body = el().querySelector('.ph-banner-body');
        body.dispatchEvent(touch('touchstart')); body.dispatchEvent(touch('touchend'));
        expect(onOpenDetails).toHaveBeenCalledTimes(1);
    });

    it('NO touch, pointer, mouse or click on the banner reaches the map underneath', () => {
        emit(HELD);
        for (const target of [el().querySelector('.ph-banner-body'), el().querySelector('.ph-banner-dismiss')]) {
            emit(HELD);  // dismiss may have hidden it; keep it on screen for the body tap
            const s = touch('touchstart'), e = touch('touchend');
            target.dispatchEvent(s); target.dispatchEvent(e);
            expect(e.defaultPrevented).toBe(true);          // synthetic click cancelled
            target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
        expect(under).not.toHaveBeenCalled();
    });

    it('lives in the map area but not inside the Leaflet map element', () => {
        expect(el().parentElement).toBe(container);
        expect(document.getElementById('primaryView').contains(el())).toBe(false);
    });
});
