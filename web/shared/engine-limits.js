/**
 * FlyTab — EngineLimits: engine-value color rules shared by every display, so
 * the ENG page and the map's engine box can't disagree about the same reading.
 *
 * Classic script (loaded before cockpit components); levels are
 * 'danger' | 'caution' | 'normal'.
 */
const EngineLimits = {
    /**
     * Engine limits (°F, psi). These are the ENG page's numbers, moved here so
     * there is one copy. cockpit-config.json `enginePage` may override any of them
     * (the ENG page merges that block over these in _loadConfig; limits() does the
     * same for everyone else).
     */
    DEFAULTS: {
        egtCaution: 1500,
        egtDanger: 1650,
        chtCaution: 380,
        chtDanger: 435,
        oilTempCaution: 220,
        oilTempDanger: 245,
        oilPressLow: 25,          // red below — Lycoming minimum
        oilPressCautionLow: 55,   // yellow below — approaching minimum
        oilPressCautionHigh: 95,  // yellow above — approaching redline
        oilPressDanger: 100,      // red above — Lycoming redline
    },

    /** Carb temp, °F: at or below freezing is the danger band. */
    CARB_DANGER_MAX_F: 32,
    /** Carb temp, °F: above freezing up to here is still carb-ice range. */
    CARB_CAUTION_MAX_F: 70,

    /** DEFAULTS with any cockpit-config.json `enginePage` overrides applied. */
    limits() {
        let over = null;
        try {
            over = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get) ? CockpitConfig.get('enginePage') : null;
        } catch (_) { /* defaults */ }
        return { ...EngineLimits.DEFAULTS, ...(over || {}) };
    },

    /**
     * Carb ice risk from carburetor temperature (°F):
     *   danger  0 < t <= 32   at or below freezing
     *   caution 32 < t <= 70  icing range
     *   normal  otherwise.
     * A reading of 0 or below is treated as no probe (the Pi reports 0 for an
     * empty EDM field), so it is not colored. This is the rule the ENG page has
     * always used.
     * @param {number|null|undefined} tempF
     * @returns {'danger'|'caution'|'normal'}
     */
    carbTempLevel(tempF) {
        const t = Number(tempF);
        if (!Number.isFinite(t) || t <= 0) return 'normal';
        if (t <= EngineLimits.CARB_DANGER_MAX_F) return 'danger';
        if (t <= EngineLimits.CARB_CAUTION_MAX_F) return 'caution';
        return 'normal';
    },

    /** Oil temp, °F. */
    oilTempLevel(v, L = EngineLimits.limits()) {
        return EngineLimits._above(v, L.oilTempCaution, L.oilTempDanger);
    },

    /** Oil pressure, psi: red at or below the minimum or at or above the redline. */
    oilPressLevel(v, L = EngineLimits.limits()) {
        const p = Number(v);
        if (!Number.isFinite(p)) return 'normal';
        if (p <= L.oilPressLow || p >= L.oilPressDanger) return 'danger';
        if (p <= L.oilPressCautionLow || p >= L.oilPressCautionHigh) return 'caution';
        return 'normal';
    },

    /** CHT, °F (one cylinder, or the hottest). */
    chtLevel(v, L = EngineLimits.limits()) {
        return EngineLimits._above(v, L.chtCaution, L.chtDanger);
    },

    /** EGT, °F (one cylinder, or the hottest). */
    egtLevel(v, L = EngineLimits.limits()) {
        return EngineLimits._above(v, L.egtCaution, L.egtDanger);
    },

    _above(v, caution, danger) {
        const x = Number(v);
        if (!Number.isFinite(x)) return 'normal';
        if (x >= danger) return 'danger';
        if (x >= caution) return 'caution';
        return 'normal';
    },
};
