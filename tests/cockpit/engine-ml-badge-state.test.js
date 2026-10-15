/**
 * A8: the ML badge must not look healthy when ML inference isn't running.
 *
 * EngineMLPlugin now reports mlState: ok | busy | timeout | error | disabled.
 * disabled = a TFLite run never returned, so InferenceGate turned inference off
 * for the session. Before, a result with no score fell through to the green
 * "ML:<phase>" branch of _updateDisplay, so ML that had stopped looked fine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const EngineMLBridge = new Function(readFileSync('web/cockpit/engine-ml.js', 'utf8') + '\nreturn EngineMLBridge;')();

describe('ML badge vs mlState', () => {
    let b, badge;
    beforeEach(() => {
        globalThis.DiagLog = { log: vi.fn() };
        delete globalThis.window.Capacitor;
        b = new EngineMLBridge();
        badge = document.createElement('span');
        b._badgeEl = badge;
    });

    it('scored normally: green phase', () => {
        b._updateDisplay({ windowReady: true, phase: 'cruise', mlState: 'ok', score: 0.01, anomaly: false });
        expect(badge.textContent).toBe('ML:cruise');
        expect(badge.style.color).toBe('var(--status-ok)');
    });

    it('inference turned off: ML:OFF, not green, logged once', () => {
        const r = { windowReady: true, phase: 'cruise', mlState: 'disabled' };
        b._updateDisplay(r);
        b._updateDisplay(r);
        expect(badge.textContent).toBe('ML:OFF');
        expect(badge.style.color).not.toBe('var(--status-ok)');
        expect(DiagLog.log).toHaveBeenCalledTimes(1);
        expect(DiagLog.log).toHaveBeenCalledWith('error', expect.stringMatching(/ML inference.*off/i));
    });

    it('a sample skipped because the previous run is still going: badge unchanged', () => {
        b._updateDisplay({ windowReady: true, phase: 'climb', mlState: 'ok', score: 0.01, anomaly: false });
        b._updateDisplay({ windowReady: true, phase: 'climb', mlState: 'busy' });
        expect(badge.textContent).toBe('ML:climb');
        expect(DiagLog.log).not.toHaveBeenCalled();
    });

    it('an anomaly still shows ML:ALERT', () => {
        b._updateDisplay({ windowReady: true, phase: 'cruise', mlState: 'ok', score: 0.9, anomaly: true });
        expect(badge.textContent).toBe('ML:ALERT');
    });

    // PR A review: only a real score may paint the badge green.
    it('an ML:ALERT is not wiped out by the samples skipped or timed out after it', () => {
        b._updateDisplay({ windowReady: true, phase: 'cruise', mlState: 'ok', score: 0.9, anomaly: true });
        b._updateDisplay({ windowReady: true, phase: 'cruise', mlState: 'busy' });
        b._updateDisplay({ windowReady: true, phase: 'cruise', mlState: 'timeout' });
        expect(badge.textContent).toBe('ML:ALERT');
    });

    it('inference failing every sample: ML:ERR after a few, cleared by the next real score', () => {
        b._updateDisplay({ windowReady: true, phase: 'cruise', mlState: 'ok', score: 0.01, anomaly: false });
        b._updateDisplay({ windowReady: true, phase: 'cruise', mlState: 'error' });
        expect(badge.textContent).toBe('ML:cruise');            // one error: not yet
        for (let i = 1; i < EngineMLBridge.ERROR_BADGE_AFTER; i++) b._updateDisplay({ windowReady: true, phase: 'cruise', mlState: 'error' });
        expect(badge.textContent).toBe('ML:ERR');
        expect(badge.style.color).not.toBe('var(--status-ok)');
        b._updateDisplay({ windowReady: true, phase: 'cruise', mlState: 'ok', score: 0.01, anomaly: false });
        expect(badge.textContent).toBe('ML:cruise');
    });

    it('every result is still passed on (engineml:result), scored or not', () => {
        const seen = [];
        const on = (e) => seen.push(e.detail.mlState);
        document.addEventListener('engineml:result', on);
        for (const mlState of ['ok', 'busy', 'timeout', 'error', 'disabled']) b._updateDisplay({ windowReady: true, phase: 'cruise', mlState, score: mlState === 'ok' ? 0.01 : undefined });
        document.removeEventListener('engineml:result', on);
        expect(seen).toEqual(['ok', 'busy', 'timeout', 'error', 'disabled']);
    });
});
