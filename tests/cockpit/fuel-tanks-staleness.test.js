/**
 * fuel-tanks.js — unconfirmed (stale) tracked tank state.
 *
 * The widget used to fall through to _renderEmpty() whenever
 * FuelTankState.needsConfirmation() was true, blanking both tanks, the total, the
 * flow and the endurance to '--'. That was survivable while staleness was only
 * evaluated at page load; FuelTankState._checkStaleness() now runs on every
 * getState(), so 45 minutes after the last integrated sample the most prominent
 * per-tank display in the cockpit went blank mid-flight while every other fuel
 * display (engine page, instrument strip, route table REM, W&B, PowerTradeoff)
 * kept showing the last figure marked unconfirmed.
 *
 * These tests pin the agreed convention: SHOW the figure, MARK it (trailing '?'
 * plus the caution colour, the same two signals instrument-strip.js uses), and
 * never let the bars sit in the plain in-limits style while the state is
 * unconfirmed — a stale figure always reads HIGH.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));
globalThis.DiagLog = vi.fn();
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
const FuelTanksDisplay = new Function(read('web/cockpit/fuel-tanks.js') + '\nreturn FuelTanksDisplay;')();

globalThis.CockpitConfig = {
    aircraft: (p) => p === 'performance.fuel_capacity_gal' ? 36
                   : p === 'performance.fuel_sender_accurate_below_gal' ? 12
                   : undefined,
    get: (p) => ({ 'enginePage.fuelCautionGal': 8, 'enginePage.fuelWarningGal': 4 })[p],
};

let widget = null;

/**
 * Build the widget over a tank state of a chosen age.
 * @param {object} o
 * @param {boolean} o.tracked      false = nothing has ever been tracked
 * @param {number}  o.staleMinutes age of last_sample_at; >45 trips needsConfirmation()
 */
function build({ tracked = true, staleMinutes = 0, gph = 0, L = 15, R = 14 } = {}) {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    if (!tracked) {
        FuelTankState._loaded = true;          // loaded, but nothing tracked
    } else {
        FuelTankState.init(L, R, 'L');
        if (staleMinutes) {
            FuelTankState._state.last_sample_at =
                new Date(Date.now() - staleMinutes * 60000).toISOString();
            FuelTankState._state.requires_confirm = false;   // let _checkStaleness decide
        }
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    widget = new FuelTanksDisplay(host);
    widget.init();
    if (gph) widget._lastGph = gph;
    widget._render();
    return widget;
}

/** What the pilot actually sees. */
const snap = (w) => ({
    L: w._dom.galL.textContent,
    R: w._dom.galR.textContent,
    total: w._dom.total.textContent,
    end: w._dom.end.textContent,
    flow: w._dom.flow.textContent,
    barL: w._dom.barL.className,
    barTotal: w._dom.barTotal.className,
    unconfL: w._dom.galL.classList.contains('ftw-unconfirmed'),
    unconfR: w._dom.galR.classList.contains('ftw-unconfirmed'),
    unconfTotal: w._dom.total.classList.contains('ftw-unconfirmed'),
    unconfEnd: w._dom.end.classList.contains('ftw-unconfirmed'),
});

afterEach(() => {
    if (widget) { try { widget.destroy(); } catch (_) {} widget = null; }
    document.body.innerHTML = '';
});

describe('fuel-tanks widget — fresh tracked state', () => {
    it('renders the figures with no unconfirmed marking', () => {
        const s = snap(build({ staleMinutes: 0, gph: 8 }));
        expect(s.L).toBe('15.0');
        expect(s.R).toBe('14.0');
        expect(s.total).toBe('29.0g');
        expect(s.unconfL).toBe(false);
        expect(s.unconfR).toBe(false);
        expect(s.unconfTotal).toBe(false);
        expect(s.unconfEnd).toBe(false);
    });

    it('leaves the bars in the plain in-limits style', () => {
        const s = snap(build({ staleMinutes: 0, gph: 8 }));
        expect(s.barL).toBe('ftw-bar-fill');
        expect(s.barTotal).toBe('ftw-bar-fill');
    });

    it('shows an unmarked endurance', () => {
        const s = snap(build({ staleMinutes: 0, gph: 8 }));
        expect(s.end).toBe('3:38');
        expect(s.end).not.toContain('?');
    });
});

describe('fuel-tanks widget — unconfirmed tracked state', () => {
    it('still shows both tank quantities instead of blanking to --', () => {
        const s = snap(build({ staleMinutes: 60, gph: 8 }));
        expect(s.L).toBe('15.0?');
        expect(s.R).toBe('14.0?');
        expect(s.L).not.toBe('--');
    });

    it('still shows the total, marked', () => {
        const s = snap(build({ staleMinutes: 60, gph: 8 }));
        expect(s.total).toBe('29.0g?');
        expect(s.unconfTotal).toBe(true);
    });

    it('carries both signals on the tank values: trailing ? and the caution class', () => {
        const s = snap(build({ staleMinutes: 60, gph: 8 }));
        expect(s.unconfL).toBe(true);
        expect(s.unconfR).toBe(true);
    });

    it('marks the endurance, which inherits the stale total and reads LONG', () => {
        const s = snap(build({ staleMinutes: 60, gph: 8 }));
        expect(s.end).toBe('3:38?');
        expect(s.unconfEnd).toBe(true);
    });

    it('does not mark GPH — that is a live engine read, not a tank-state figure', () => {
        const s = snap(build({ staleMinutes: 60, gph: 8 }));
        expect(s.flow).toBe('8.0');
    });

    it('STALE-NEVER-PLAIN: comfortable quantities still lose the in-limits bar style', () => {
        const s = snap(build({ staleMinutes: 60, L: 15, R: 14, gph: 8 }));
        expect(s.barL).toContain('ftw-bar-caution');
        expect(s.barTotal).toContain('ftw-bar-caution');
    });

    it('does not downgrade a genuine low-fuel warning bar to caution', () => {
        const s = snap(build({ staleMinutes: 60, L: 2, R: 1, gph: 8 }));
        expect(s.barL).toContain('ftw-bar-warn');
        expect(s.L).toBe('2.0?');
    });
});

describe('fuel-tanks widget — no tracked state at all', () => {
    it('still renders empty: there is no last known-good quantity to preserve', () => {
        const s = snap(build({ tracked: false }));
        expect(s.L).toBe('--');
        expect(s.R).toBe('--');
        expect(s.total).toBe('--');
        expect(s.end).toBe('--');
    });

    it('carries no unconfirmed marking', () => {
        const s = snap(build({ tracked: false }));
        expect(s.unconfL).toBe(false);
        expect(s.unconfTotal).toBe(false);
    });
});

describe('fuel-tanks widget — staleness has no event to render on', () => {
    it('the periodic tick repaints, so the marking appears without a state change', () => {
        vi.useFakeTimers();
        try {
            const w = build({ staleMinutes: 0, gph: 8 });
            expect(w._dom.galL.textContent).toBe('15.0');

            // Age the state past the 45-min line. FuelTankState._checkStaleness()
            // calls _save() but NOT _fire(), so no 'fueltankstate:changed' is emitted —
            // nothing but the widget's own tick will ever notice.
            FuelTankState._state.last_sample_at =
                new Date(Date.now() - 60 * 60000).toISOString();

            vi.advanceTimersByTime(10000);

            expect(w._dom.galL.textContent).toBe('15.0?');
            expect(w._dom.galL.classList.contains('ftw-unconfirmed')).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
