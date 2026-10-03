/**
 * FlyTab — EngineLimits: engine-value color rules shared by every display, so
 * the ENG page and the map's engine box can't disagree about the same reading.
 *
 * Classic script (loaded before cockpit components); levels are
 * 'danger' | 'caution' | 'normal'.
 */
const EngineLimits = {
    /** Carb temp, °F: at or below freezing is the danger band. */
    CARB_DANGER_MAX_F: 32,
    /** Carb temp, °F: above freezing up to here is still carb-ice range. */
    CARB_CAUTION_MAX_F: 70,

    /**
     * Carb ice risk from carburetor temperature (°F):
     *   danger  0 < t <= 32   at or below freezing
     *   caution 32 < t <= 70  icing range
     *   normal  otherwise.
     * A reading of 0 or below is treated as no probe (the Pi reports 0 for an
     * empty EDM field), so it is not colored. This is the rule the ENG page has
     * always used; the map box now uses it too.
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
};
