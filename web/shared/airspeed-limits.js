/**
 * FlyTab - TAS-limited Vne math (web/shared/airspeed-limits.js).
 *
 * Pure computation: no DOM, no network, no storage. Used by cockpit/vne-panel.js and meant to
 * be reused by preflight planning and a future live D-180 feed (pressure altitude, OAT, IAS).
 *
 * The RV-9A's Vne is 210 mph = 182.5 kt, used here as 182 kt, and it applies to BOTH indicated
 * AND true airspeed, whichever is reached first, because flutter depends on true airspeed
 * (Van's Section 15 revision of 10/09/2023; Van's Airspeed Indicator Markings chart, Rev 1,
 * Dec 2023). The D-180's red line is a fixed indicated speed, so at altitude the TAS limit can
 * come first. vneIas() gives the true-airspeed-limited Vne as an indicated speed.
 *
 * Vno and Vfe are INDICATED limits and are only carried as static reference values. Va is an
 * indicated limit too; altitude does not change it, weight does: vaForWeight() scales the
 * 1,800 lb figure by sqrt(weight / gross) (maneuvering speed varies with the square root of
 * weight), never above it.
 *
 * Pressure altitude from the altimeter (pressureAltitudeFt): an altimeter set to A reads h_ind
 * where the static pressure is (A / 29.92) x the standard pressure at h_ind, so the pressure
 * altitude is the standard altitude of that pressure. Same constants as the rest of this module. The often-quoted
 * "indicated + 145,366 (1 - (A/29.92)^0.19)" drops the factor on h_ind and is off by up to
 * ~170 ft at 18,000 ft.
 *
 * Model (Dana's spec, 2026-11-12): compressible flow, ISA pressure at the pressure altitude,
 * actual OAT for the speed of sound / density.
 *   P(h)   = P0 * (1 - 6.8755856e-6 h)^5.2558797          h in ft (altimeter 29.92)
 *   ISA_T  = 15 - 0.0019812 h                             °C
 *   CAS→TAS: qc = P0((1+0.2(CAS/a0)^2)^3.5 - 1); M = sqrt(5((qc/P+1)^(2/7) - 1)); TAS = M a0 sqrt(T/T0)
 *   TAS→CAS: M = TAS/(a0 sqrt(T/T0)); qc = P((1+0.2M^2)^3.5 - 1); CAS = a0 sqrt(5((qc/P0+1)^(2/7) - 1))
 *   VneIAS = min(182, TAS→CAS(182))
 *   DA: rho = P/(287.05287 T); DA = (1 - (rho/1.225)^(1/4.2558797)) / 6.8755856e-6
 *
 * Position error: CAS = IAS + pecKt. DEFAULT_PEC_KT is 0 ("IAS ≈ CAS") until a Phase 1
 * calibration exists. A calibration TABLE (pec as a function of IAS) would need IAS = CAS - pec(IAS)
 * solved iteratively; this module only takes a single number today.
 *
 * Display rounding in evaluate() is always conservative: Vne here and equivalent KIAS DOWN,
 * TAS UP, density altitude UP to 10 ft, margin against the floored Vne. A 1e-9 kt tolerance
 * absorbs floating-point noise only (182 must not show as 181 at sea level standard).
 *
 * Exposes the global AirspeedLimits.
 */
const AirspeedLimits = (() => {
    'use strict';

    // ---- Physical constants ------------------------------------------------------------------
    const P0 = 101325;              // Pa, ISA sea-level pressure
    const T0 = 288.15;              // K, ISA sea-level temperature
    const A0_KT = 661.4788;         // kt, ISA sea-level speed of sound
    const R_AIR = 287.05287;        // J/(kg K)
    const RHO0 = 1.225;             // kg/m^3
    const K_FT = 6.8755856e-6;      // ISA lapse term, per ft
    const P_EXP = 5.2558797;
    const RHO_EXP = 4.2558797;
    const ISA_LAPSE_C_PER_FT = 0.0019812;
    const KELVIN = 273.15;
    const EPS = 1e-9;

    // ---- Aircraft limits (N194JT, RV-9A) -------------------------------------------------------
    const LIMITS = Object.freeze({
        vneTasKt: 182,  // flutter limit, TRUE airspeed (182.5 kt rounded down)
        vneIasKt: 182,  // INDICATED airspeed cap
        vnoKias: 156,   // indicated, reference only
        vaKias: 102,    // indicated, reference only
        vfeKias: 78,    // indicated (full flaps), reference only
    });

    const DEFAULT_PEC_KT = 0;
    const VA_GROSS_LB = 1800;       // weight the 102 KIAS Va applies to (max gross)

    // ---- Input ranges --------------------------------------------------------------------------
    const ALT_MIN_FT = -1000;
    const ALT_MAX_FT = 18000;
    const OAT_MIN_C = -60;
    const OAT_MAX_C = 50;
    const SPEED_MIN_KT = 1;
    const SPEED_MAX_KT = 300;
    const ALTIMETER_MIN_INHG = 27.5;
    const ALTIMETER_MAX_INHG = 31.5;
    const STD_ALTIMETER_INHG = 29.92;

    // ---- Atmosphere ----------------------------------------------------------------------------
    function pressurePa(hFt) {
        return P0 * Math.pow(1 - K_FT * hFt, P_EXP);
    }

    function isaTempC(hFt) {
        return 15 - ISA_LAPSE_C_PER_FT * hFt;
    }

    function tempRatio(oatC) {
        return (oatC + KELVIN) / T0;
    }

    function casToTas(casKt, hFt, oatC) {
        const qc = P0 * (Math.pow(1 + 0.2 * Math.pow(casKt / A0_KT, 2), 3.5) - 1);
        const p = pressurePa(hFt);
        const mach = Math.sqrt(5 * (Math.pow(qc / p + 1, 2 / 7) - 1));
        return mach * A0_KT * Math.sqrt(tempRatio(oatC));
    }

    function tasToCas(tasKt, hFt, oatC) {
        const mach = tasKt / (A0_KT * Math.sqrt(tempRatio(oatC)));
        const qc = pressurePa(hFt) * (Math.pow(1 + 0.2 * mach * mach, 3.5) - 1);
        return A0_KT * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
    }

    function densityAltitudeFt(hFt, oatC) {
        const rho = pressurePa(hFt) / (R_AIR * (oatC + KELVIN));
        return (1 - Math.pow(rho / RHO0, 1 / RHO_EXP)) / K_FT;
    }

    /**
     * Pressure altitude (ft) for an altimeter reading of indicatedFt with altimeterInHg set.
     * Pressure altitude is, by definition, what the altimeter reads set to 29.92, so the setting
     * is taken relative to 29.92 (not to 101,325 Pa = 29.9213 inHg, which would put 29.92 at
     * +1.2 ft and floor sea-level-standard Vne to 181).
     */
    function pressureAltitudeFt(indicatedFt, altimeterInHg) {
        const ratio = (altimeterInHg / STD_ALTIMETER_INHG) * Math.pow(1 - K_FT * indicatedFt, P_EXP);
        return (1 - Math.pow(ratio, 1 / P_EXP)) / K_FT;
    }

    function fToC(f) { return (f - 32) * 5 / 9; }
    function cToF(c) { return c * 9 / 5 + 32; }

    // ---- Limits --------------------------------------------------------------------------------
    /**
     * Vne (kt) to use: 182, or the aircraft config's vne_kt if it is a positive number (or numeric
     * string, e.g. from a hand edit) BELOW 182. It can only lower the limit, never raise it.
     */
    function limitKt(vneKt) {
        const n = typeof vneKt === 'string' ? parseNumber(vneKt) : vneKt;
        return (typeof n === 'number' && Number.isFinite(n) && n > 0)
            ? Math.min(LIMITS.vneTasKt, n) : LIMITS.vneTasKt;
    }

    function pecOf(pecKt) {
        return (typeof pecKt === 'number' && Number.isFinite(pecKt)) ? pecKt : DEFAULT_PEC_KT;
    }

    /**
     * Unrounded Vne as an indicated speed at this pressure altitude and OAT, and which limit
     * governs ('KTAS' or 'KIAS'). opts: { vneKt, pecKt }.
     */
    function vneDetail(hFt, oatC, opts = {}) {
        const lim = limitKt(opts.vneKt);
        const pec = pecOf(opts.pecKt);
        const tasLimitKias = tasToCas(lim, hFt, oatC) - pec;
        // Within float noise of the cap counts as the cap: the IAS limit governs.
        if (tasLimitKias >= lim - EPS) return { kias: lim, governs: 'KIAS', limitKt: lim, pecKt: pec };
        return { kias: tasLimitKias, governs: 'KTAS', limitKt: lim, pecKt: pec };
    }

    /**
     * Va (KIAS) at this weight, rounded DOWN: 102 x sqrt(W / gross), never above 102 (over gross
     * is flagged, not rewarded). The scaling is on calibrated airspeed, so the position error is
     * added before and taken off after. null for a weight that is not a positive number.
     * opts: { grossLb, pecKt }.
     */
    function vaForWeight(weightLb, opts = {}) {
        const w = toNum(weightLb);
        if (w === null || !(w > 0)) return null;
        const gross = (typeof opts.grossLb === 'number' && opts.grossLb > 0) ? opts.grossLb : VA_GROSS_LB;
        const pec = pecOf(opts.pecKt);
        const ratio = Math.min(1, w / gross);
        const kias = floorKt((LIMITS.vaKias + pec) * Math.sqrt(ratio) - pec);
        return { kias, overGross: w > gross + EPS };
    }

    /** VneIAS(h, OAT) = min(182, TAS→CAS(182, h, OAT)), unrounded. */
    function vneIas(hFt, oatC, opts) {
        return vneDetail(hFt, oatC, opts).kias;
    }

    // ---- Input parsing and validation ----------------------------------------------------------
    /**
     * Parse a typed number: optional sign (ASCII '-', '+' or U+2212 minus), digits, optional
     * decimal part; thousands commas and spaces ignored. Anything else (exponents, units, a lone
     * '-') is null. A finite number passes through.
     */
    function parseNumber(v) {
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        if (typeof v !== 'string') return null;
        const s = v.replace(/[\s,]/g, '').replace(/−/g, '-');
        if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    }

    function toNum(v) {
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        return parseNumber(v);
    }

    function checkRange(v, min, max) {
        if (v === null || v === undefined || !Number.isFinite(v)) return 'missing';
        if (v < min || v > max) return 'range';
        return null;
    }

    const checkAltitude = (ft) => checkRange(ft, ALT_MIN_FT, ALT_MAX_FT);
    const checkOat = (c) => checkRange(c, OAT_MIN_C, OAT_MAX_C);
    const checkSpeed = (kt) => checkRange(kt, SPEED_MIN_KT, SPEED_MAX_KT);
    const checkAltimeter = (inHg) => checkRange(inHg, ALTIMETER_MIN_INHG, ALTIMETER_MAX_INHG);

    function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

    /** Step a value by delta and clamp to [min, max]; an empty value starts from `start`. */
    function stepValue(cur, delta, min, max, start = 0) {
        const base = (typeof cur === 'number' && Number.isFinite(cur)) ? cur : start;
        return clamp(base + delta, min, max);
    }

    const stepAltitude = (cur, delta) => stepValue(cur, delta, ALT_MIN_FT, ALT_MAX_FT, 0);

    // ---- Display result ------------------------------------------------------------------------
    const floorKt = (x) => Math.floor(x + EPS);
    const ceilKt = (x) => Math.ceil(x - EPS);
    const noNegZero = (x) => (Object.is(x, -0) ? 0 : x);

    /**
     * Everything the panel shows, rounded conservatively. Inputs (numbers, typed strings, or empty):
     *   altitude: { pressureAltFt } or { indicatedAltFt, altimeterInHg } (altimeterInHg present
     *             selects the second form; the pressure altitude it gives must be in range)
     *   OAT:      { oatC } or { oatF } (oatF present selects °F)
     *   { kias, ktas } optional; { weightLb } optional, for Va.
     * opts: { vneKt, pecKt, grossLb }.
     *
     * ok is false when altitude or OAT is missing/out of range: then every number is null.
     * An out-of-range altitude is REJECTED, never clamped (a clamped 25,000 ft would show the
     * 18,000 ft Vne, which is higher than the real one). kias / ktas are optional; a bad one only
     * nulls its own outputs and adds an error. status: 'ok' | 'at' | 'over' | null, against the
     * floored Vne (KIAS at or above the shown value warns). Va (vaKias) needs only the weight and
     * is filled in whatever the altitude and OAT are. pressureAltFt in the result is rounded UP
     * to 10 ft for display; the math uses the unrounded value.
     */
    function evaluate(inputs = {}, opts = {}) {
        const errors = {};
        const fromAltimeter = inputs.altimeterInHg !== undefined;
        let h;
        let eAlt;
        if (fromAltimeter) {
            const ind = toNum(inputs.indicatedAltFt);
            const setting = toNum(inputs.altimeterInHg);
            const eSet = checkAltimeter(setting);
            if (eSet) errors.altimeter = eSet;
            h = null;
            eAlt = null;
            if (ind === null) eAlt = 'missing';
            else if (!eSet) {
                h = pressureAltitudeFt(ind, setting);
                // Far above the model's ceiling (≈145,000 ft) the formula has no answer: that is
                // an out-of-range entry, not a missing one.
                if (!Number.isFinite(h)) { h = null; eAlt = 'range'; } else eAlt = checkAltitude(h);
            }
            if (eAlt) errors.alt = eAlt;
            // No pressure altitude without a good setting: errors.altimeter says why.
            if (eSet) { h = null; eAlt = eAlt || eSet; }
        } else {
            h = toNum(inputs.pressureAltFt);
            eAlt = checkAltitude(h);
            if (eAlt) errors.alt = eAlt;
        }
        const fromF = inputs.oatF !== undefined;
        const oatRaw = toNum(fromF ? inputs.oatF : inputs.oatC);
        const oat = oatRaw === null ? null : (fromF ? fToC(oatRaw) : oatRaw);
        const kias = toNum(inputs.kias);
        const ktas = toNum(inputs.ktas);

        // °F is range-checked after conversion (−76…+122 °F = −60…+50 °C); EPS absorbs the
        // conversion's float noise at the ends.
        const eOat = checkRange(oat, OAT_MIN_C - EPS, OAT_MAX_C + EPS);
        if (eOat) errors.oat = eOat;
        if (kias !== null && checkSpeed(kias)) errors.kias = checkSpeed(kias);
        if (ktas !== null && checkSpeed(ktas)) errors.ktas = checkSpeed(ktas);

        const lim = limitKt(opts.vneKt);
        const pec = pecOf(opts.pecKt);
        const result = {
            ok: false, errors,
            vneKias: null, vneRawKias: null, governs: null, limitKt: lim, pecKt: pec,
            tasKt: null, marginKt: null, status: null, equivKias: null,
            densityAltFt: null, isaDevC: null, isaTempC: null,
            pressureAltFt: null, vaKias: null, overGross: false,
        };
        const va = vaForWeight(inputs.weightLb, { grossLb: opts.grossLb, pecKt: pec });
        if (va) { result.vaKias = va.kias; result.overGross = va.overGross; }
        if (h !== null && Number.isFinite(h)) result.pressureAltFt = noNegZero(Math.ceil(h / 10 - EPS) * 10);
        if (eAlt || eOat) return result;

        const d = vneDetail(h, oat, opts);
        const vneShown = floorKt(d.kias);
        result.ok = true;
        result.vneRawKias = d.kias;
        result.vneKias = vneShown;
        result.governs = d.governs;

        const isaT = isaTempC(h);
        result.isaTempC = isaT;
        result.isaDevC = noNegZero(Math.round((oat - isaT) * 10) / 10);
        result.densityAltFt = noNegZero(Math.ceil(densityAltitudeFt(h, oat) / 10) * 10);

        if (kias !== null && !errors.kias) {
            result.tasKt = ceilKt(casToTas(kias + pec, h, oat));
            result.marginKt = noNegZero(floorKt(vneShown - kias));
            result.status = kias > vneShown + EPS ? 'over' : (kias >= vneShown - EPS ? 'at' : 'ok');
        }
        if (ktas !== null && !errors.ktas) {
            result.equivKias = floorKt(tasToCas(ktas, h, oat) - pec);
        }
        return result;
    }

    return {
        LIMITS, DEFAULT_PEC_KT, VA_GROSS_LB,
        ALT_MIN_FT, ALT_MAX_FT, OAT_MIN_C, OAT_MAX_C, SPEED_MIN_KT, SPEED_MAX_KT,
        ALTIMETER_MIN_INHG, ALTIMETER_MAX_INHG, STD_ALTIMETER_INHG,
        pressurePa, isaTempC, casToTas, tasToCas, densityAltitudeFt, pressureAltitudeFt, fToC, cToF,
        vneIas, vneDetail, vaForWeight, parseNumber, checkAltitude, checkOat, checkSpeed, checkAltimeter,
        stepValue, stepAltitude, evaluate,
    };
})();

if (typeof window !== 'undefined') window.AirspeedLimits = AirspeedLimits;
