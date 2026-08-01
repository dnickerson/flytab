/**
 * Engine Page — FUEL STATUS section (SDD Task 12).
 *
 * Covers three contracts:
 *  1. REMAINING / ENDURANCE / RANGE come from the canonical live fuel read
 *     (FuelState.getCurrentFuel) rather than whatever raw EDM field happens to
 *     be populated on the engine poll payload.
 *  2. USED (FLIGHT) reads the Pi fuel tracker's nested field (`data.fuel.flight_fuel_used`),
 *     which is where engine_monitor.get_status() actually puts it — there is no
 *     top-level `flight_fuel_used`.
 *  3. The fuel-bar caution/warning colouring honours the real cockpit-config schema
 *     keys (`enginePage.fuelCautionGal` / `fuelWarningGal`).
 *
 * Fuel-safety rule for this page: it must never present MORE fuel than is known to
 * exist. When the canonical read has no tracked tank state it reports full tank
 * capacity (`source: 'capacity'`) — that is a planning-side default, not a live
 * measurement, so this live-instrument page shows its "no data" placeholders instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));

// Real implementations — the point of these tests is the contract between
// engine-page.js and the canonical fuel modules, so nothing here is faked.
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const EnginePage = new Function(read('web/cockpit/engine-page.js') + '\nreturn EnginePage;')();

const CAPACITY_GAL = 36;   // web/aircraft-config.json performance.fuel_capacity_gal
const SENDER_LIMIT_GAL = 12; // web/aircraft-config.json performance.fuel_sender_accurate_below_gal

let page = null;

function setup({ tankL = null, tankR = null, manual = null, measurement = null,
                 enginePageCfg = null, capacityGal = CAPACITY_GAL,
                 senderLimitGal = SENDER_LIMIT_GAL, noAircraftConfig = false,
                 staleMinutes = 0 } = {}) {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;

    globalThis.Settings = { fuelManualOverride: manual, fuelMeasurement: measurement };
    globalThis.CockpitConfig = {
        get: (k) => (k === 'enginePage' ? enginePageCfg : null),
        aircraft: noAircraftConfig ? undefined : (path) => (
            path === 'performance.fuel_capacity_gal' ? capacityGal :
            path === 'performance.fuel_sender_accurate_below_gal' ? senderLimitGal : undefined),
    };

    if (tankL === null) {
        FuelTankState._loaded = true;      // loaded, but nothing ever initialised
    } else {
        FuelTankState.init(tankL, tankR, 'L');
        if (staleMinutes > 0) {
            // Age the last integrated sample past FuelTankState.STALE_MS so
            // needsConfirmation() flips — the >45 min gap this page must flag.
            FuelTankState._state.last_sample_at =
                new Date(Date.now() - staleMinutes * 60000).toISOString();
            FuelTankState._save();
        }
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    page = new EnginePage(host);
    page.show();                            // show() is what applies CockpitConfig
    return page;
}

/** Drive one engine-data sample through and read back the FUEL STATUS fields. */
function fuelFields(data) {
    page.update(data);
    const t = (id) => page._el.querySelector('#' + id).textContent;
    return {
        remaining: t('ep-fuel-rem'),
        used: t('ep-fuel-used'),
        endurance: t('ep-fuel-end'),
        range: t('ep-fuel-rng'),
        barLabel: t('ep-fuel-bar-label'),
        barClass: page._dom.fuelBar.className,
        barWidth: page._dom.fuelBar.style.width,
        remClass: page._dom.fuelRem.className,
        staleShown: page._dom.fuelStale.style.display !== 'none',
        tankLabels: [...page._el.querySelectorAll('.ep-tank-label')].map(e => e.textContent.trim()),
        tankLval: t('ep-tank-l-val'),
        tankRval: t('ep-tank-r-val'),
        tankLbarClass: page._el.querySelector('#ep-tank-l').className,
        tankLbarHeight: page._el.querySelector('#ep-tank-l').style.height,
        ticRowShown: page._dom.ticEdmRow.style.display !== 'none',
        edmTotal: page._dom.edmTotal.textContent,
    };
}

beforeEach(() => {
    // Stop the 1 Hz self-scheduling render loop: the callback is never invoked.
    vi.stubGlobal('requestAnimationFrame', () => 0);
});

afterEach(() => {
    page = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
});

describe('EnginePage FUEL STATUS — canonical remaining fuel', () => {
    it('shows tracked tank state, not the EDM totalizer field on the poll payload', () => {
        setup({ tankL: 10, tankR: 8 });
        // Fuel_Remaining is the EDM's own field-12 totalizer; it must not win.
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 0 });
        expect(out.remaining).toBe('18.0');
    });

    it('derives ENDURANCE and RANGE from the canonical remaining figure', () => {
        setup({ tankL: 9, tankR: 9 });
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 9, speed_kts: 135 });
        expect(out.endurance).toBe('2:00');   // 18 gal / 9 gph
        expect(out.range).toBe('270');        // 18 gal * 15 nm/gal
    });

    it('honours a manual fuel override ahead of tank state and EDM', () => {
        setup({ tankL: 10, tankR: 8, manual: 22 });
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 0 });
        expect(out.remaining).toBe('22.0');
    });

    it('never presents full tank capacity as a live reading when nothing is tracked', () => {
        setup({ tankL: null });
        // FuelState.getCurrentFuel() reports { gallons: 36, source: 'capacity' } here.
        // Showing 36.0 on the live gauge would tell the pilot there is more fuel than
        // is actually known — the unacceptable error direction.
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 9, speed_kts: 135 });
        expect(out.remaining).toBe('--.-');
        expect(out.endurance).toBe('-:--');
        expect(out.range).toBe('---');
        expect(out.remaining).not.toBe(String(CAPACITY_GAL.toFixed(1)));
    });

    it('renders the SAME no-data story in every fuel sink when nothing is tracked', () => {
        // Regression: the bar label and bar class used to gate on `gallonsRem > 0`,
        // so the untracked sentinel 0 leaked out as a real reading — "0.0 gal" next to
        // a red critical bar, beside a REMAINING of "--.-". Three stories, one panel,
        // and it is the DEFAULT state of every flight until fuel is entered.
        setup({ tankL: null });
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 9, speed_kts: 135 });
        expect(out.barLabel).toBe(`--% (--.-/${CAPACITY_GAL} gal)`);
        expect(out.barLabel).not.toContain('0.0');
        expect(out.barClass).toBe('ep-fuel-bar');       // NOT ' critical'
        expect(out.barWidth).toBe('0%');
    });
});

describe('EnginePage FUEL STATUS — dry tanks vs nothing tracked', () => {
    // The edge that matters most on a fuel instrument: "we are out of fuel" and
    // "we are not tracking fuel" must never render identically.
    const engine = { Fuel_Remaining: 30, fuel_flow: 9, speed_kts: 135 };

    it('renders genuinely dry tracked tanks as a real zero with a critical bar', () => {
        setup({ tankL: 0, tankR: 0 });
        const out = fuelFields(engine);
        expect(out.remaining).toBe('0.0');
        expect(out.barLabel).toBe(`0% (0.0/${CAPACITY_GAL} gal)`);
        expect(out.barClass).toBe('ep-fuel-bar critical');
        expect(out.endurance).toBe('0:00');
        expect(out.range).toBe('0');
    });

    it('does not render dry tanks the same as nothing tracked', () => {
        setup({ tankL: 0, tankR: 0 });
        const dry = fuelFields(engine);
        document.body.innerHTML = '';
        setup({ tankL: null });
        const untracked = fuelFields(engine);

        expect(dry.remaining).not.toBe(untracked.remaining);
        expect(dry.barLabel).not.toBe(untracked.barLabel);
        expect(dry.barClass).not.toBe(untracked.barClass);
    });
});

describe('EnginePage FUEL STATUS — stale tracked state is marked, not silently shown', () => {
    // Decision (2026-07-31): keep the number — blanking discards the pilot's last
    // known-good quantity — but flag it, because a >45-minute-old integrated figure
    // reads HIGH by whatever was burned during the gap.
    const engine = { Fuel_Remaining: 30, fuel_flow: 9, speed_kts: 135 };

    it('still shows the figure but flags it unconfirmed when FuelTankState is stale', () => {
        setup({ tankL: 9, tankR: 9, staleMinutes: 60 });
        expect(FuelTankState.needsConfirmation()).toBe(true);
        const out = fuelFields(engine);
        expect(out.remaining).toBe('18.0');                     // information kept
        expect(out.staleShown).toBe(true);                      // but marked
        expect(out.remClass).toBe('ep-gauge-value ep-unconfirmed');
    });

    it('shows no unconfirmed marking for a fresh tracked state', () => {
        setup({ tankL: 9, tankR: 9 });
        expect(FuelTankState.needsConfirmation()).toBe(false);
        const out = fuelFields(engine);
        expect(out.remaining).toBe('18.0');
        expect(out.staleShown).toBe(false);
        expect(out.remClass).toBe('ep-gauge-value');
    });

    it('shows no unconfirmed marking for a manual override', () => {
        // A manual override is not a tracked-and-aged figure; it is what the pilot
        // just typed in. Staleness is a FuelTankState property only.
        setup({ tankL: 9, tankR: 9, manual: 22, staleMinutes: 60 });
        const out = fuelFields(engine);
        expect(out.remaining).toBe('22.0');
        expect(out.staleShown).toBe(false);
    });
});

describe('EnginePage FUEL STATUS — LEFT/RIGHT bars are labelled EDM senders', () => {
    const engine = { Fuel_L1: 7.5, Fuel_L2: 6.5, fuel_flow: 0 };

    it('labels the per-tank bars as the EDM sender source', () => {
        setup({ tankL: 5, tankR: 5 });
        const out = fuelFields(engine);
        // They read a different (less trustworthy) source than REMAINING above and
        // can legitimately disagree with it — the label is what makes that legible.
        expect(out.tankLabels).toEqual(['LEFT (EDM SENDER)', 'RIGHT (EDM SENDER)']);
    });

    it('shows sender values while the tracked level is inside the accurate range', () => {
        setup({ tankL: 5, tankR: 5 });               // 5 gal/side, below the 12 gal limit
        const out = fuelFields(engine);
        expect(out.tankLval).toBe('7.5 gal');
        expect(out.tankRval).toBe('6.5 gal');
    });

    it('suppresses sender values above the configured accurate-below level', () => {
        // Same rule as fuel-tanks.js _updateSenderDisplay (Task 4): above this level
        // the sender reads a flat/invalid value and must not look like a cross-check.
        setup({ tankL: 16, tankR: 16 });             // 16 gal/side, above the 12 gal limit
        const out = fuelFields(engine);
        expect(out.tankLval).toBe('—');
        expect(out.tankRval).toBe('—');
        expect(out.tankLbarHeight).toBe('0%');
        expect(out.tankLbarClass).toBe('ep-tank-bar');   // suppressed, NOT 'critical'
    });
});

describe('EnginePage FUEL STATUS — capacity comes from aircraft-config, not a literal', () => {
    it('uses performance.fuel_capacity_gal as the bar denominator', () => {
        setup({ tankL: 9, tankR: 9 });
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barLabel).toBe(`50% (18.0/${CAPACITY_GAL} gal)`);
        expect(page._cfg.fuelCapacity).toBe(CAPACITY_GAL);
    });

    it('tracks a different aircraft-config capacity rather than any hardcoded value', () => {
        setup({ tankL: 10, tankR: 10, capacityGal: 40 });
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barLabel).toBe('50% (20.0/40 gal)');
        expect(page._cfg.fuelCapacity).toBe(40);
    });

    it('falls back to 36 gal (2 x 18), never the deprecated 34, with no aircraft config', () => {
        setup({ tankL: 9, tankR: 9, noAircraftConfig: true });
        const out = fuelFields({ fuel_flow: 0 });
        expect(page._cfg.fuelCapacity).toBe(36);
        expect(out.barLabel).toBe('50% (18.0/36 gal)');
    });
});

describe('EnginePage FUEL STATUS — USED (FLIGHT)', () => {
    it('reads the Pi fuel tracker nested field', () => {
        setup({ tankL: 10, tankR: 8 });
        const out = fuelFields({ fuel: { flight_fuel_used: 4.3 }, fuel_flow: 0 });
        expect(out.used).toBe('4.3');
    });

    it('falls back to the placeholder when the tracker block is absent', () => {
        setup({ tankL: 10, tankR: 8 });
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.used).toBe('--.-');
    });
});

describe('EnginePage FUEL STATUS — configured caution/warning thresholds', () => {
    const cfg = { fuelCautionGal: 15, fuelWarningGal: 7 };

    it('marks the bar low below the configured caution threshold', () => {
        setup({ tankL: 6, tankR: 6, enginePageCfg: cfg });   // 12 gal: below 15, above 7
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barClass).toBe('ep-fuel-bar low');
    });

    it('marks the bar critical below the configured warning threshold', () => {
        setup({ tankL: 3, tankR: 3, enginePageCfg: cfg });   // 6 gal: below 7
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barClass).toBe('ep-fuel-bar critical');
    });

    // Boundary: the comparisons are `<=`, so EXACTLY at a threshold must already
    // alert. Testing only strictly-inside values leaves `<=` vs `<` untested, and
    // `<` is the direction that delays a fuel alert.
    it('marks the bar low EXACTLY at the configured caution threshold', () => {
        setup({ tankL: 7.5, tankR: 7.5, enginePageCfg: cfg });   // exactly 15 gal
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.remaining).toBe('15.0');
        expect(out.barClass).toBe('ep-fuel-bar low');
    });

    it('marks the bar critical EXACTLY at the configured warning threshold', () => {
        setup({ tankL: 3.5, tankR: 3.5, enginePageCfg: cfg });   // exactly 7 gal
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.remaining).toBe('7.0');
        expect(out.barClass).toBe('ep-fuel-bar critical');
    });

    it('marks the bar low just above the configured warning threshold', () => {
        setup({ tankL: 3.55, tankR: 3.55, enginePageCfg: cfg });  // 7.1 gal
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barClass).toBe('ep-fuel-bar low');
    });

    it('leaves the bar unstyled above the configured caution threshold', () => {
        setup({ tankL: 9, tankR: 9, enginePageCfg: cfg });   // 18 gal: above 15
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barClass).toBe('ep-fuel-bar');
    });

    it('uses the built-in defaults when no enginePage config block exists', () => {
        setup({ tankL: 3, tankR: 3 });                        // 6 gal vs default caution 8
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barClass).toBe('ep-fuel-bar low');
    });
});

describe('EnginePage TIC vs EDM row — still compares against the EDM, not tank state', () => {
    it('shows the EDM totalizer figure in the EDM column', () => {
        // Tank state is 18.0; the EDM reports 30.0. The row exists to expose that
        // disagreement, so it must keep reading the EDM value.
        setup({ tankL: 10, tankR: 8, measurement: { total_gal: 29.0 } });
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 0 });
        expect(out.ticRowShown).toBe(true);
        expect(out.edmTotal).toBe('30.0');
    });

    it('hides the row when the EDM reports no fuel figure', () => {
        setup({ tankL: 10, tankR: 8, measurement: { total_gal: 29.0 } });
        const out = fuelFields({ Fuel_Remaining: 0, fuel_flow: 0 });
        expect(out.ticRowShown).toBe(false);
    });
});
