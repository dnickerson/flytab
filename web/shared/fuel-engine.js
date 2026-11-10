/**
 * FlyTab — Fuel Engine
 * Pure computation module for tic mark polynomial conversion,
 * fuel measurement creation, and accuracy grading.
 * Works fully offline — no network, no storage dependencies.
 */

class FuelEngine {
    /**
     * Default tic mark polynomial coefficients (calibrated for specific aircraft).
     * 5th-degree polynomial: gallons = a5*x^5 + a4*x^4 + a3*x^3 + a2*x^2 + a1*x + a0
     * Calibrated from fuel_tracking_app tank measurements.
     */
    static DEFAULT_COEFFICIENTS = {
        a5: 0.00073877,
        a4: -0.021782,
        a3: 0.22914,
        a2: -1.0819,
        a1: 3.7826,
        a0: 2.2368,
    };

    /**
     * Convert a tic mark reading to gallons using a 5th-degree polynomial.
     * @param {number} tic - Tic mark reading (0 to max_tic)
     * @param {object} coefficients - Polynomial coefficients { a5, a4, a3, a2, a1, a0 }
     * @returns {number} Gallons (clamped to >= 0)
     */
    static ticToGallons(tic, coefficients = FuelEngine.DEFAULT_COEFFICIENTS) {
        if (tic == null || isNaN(tic) || tic < 0) return 0;
        const { a5, a4, a3, a2, a1, a0 } = coefficients;
        const x = tic;
        const gallons = a5 * x**5 + a4 * x**4 + a3 * x**3 + a2 * x**2 + a1 * x + a0;
        return Math.max(0, gallons);
    }

    /**
     * Create a fuel measurement from left and right tank tic marks.
     *
     * Two call forms:
     *  - 4 arguments (legacy): `edmReading` is both stored as edm_gal and the figure
     *    the tic is graded against (when > 0).
     *  - 5 arguments: `referenceGal` is the grading figure (e.g. the tablet's tracked
     *    fuel) and `edmReading` is only stored, as edm_gal (null when absent or ≤ 0).
     *    Passing `referenceGal` explicitly (even null) selects this form.
     * Grading (variance_gal, variance_pct, accuracy) happens only against a figure > 0.
     * @param {number} leftTic - Left tank tic mark reading
     * @param {number} rightTic - Right tank tic mark reading
     * @param {object} coefficients - Polynomial coefficients
     * @param {number|null} edmReading - the D-180 EMS fuel figure in gallons (optional)
     * @param {number|null} [referenceGal] - figure to grade the tic against (optional)
     * @returns {object} Measurement with gallons per tank, total, variance
     */
    static createMeasurement(leftTic, rightTic, coefficients = FuelEngine.DEFAULT_COEFFICIENTS,
                             edmReading = null, referenceGal = undefined) {
        const leftGal = FuelEngine.ticToGallons(leftTic, coefficients);
        const rightGal = FuelEngine.ticToGallons(rightTic, coefficients);
        const totalGal = leftGal + rightGal;

        const measurement = {
            id: `fm-${Date.now()}`,
            measured_at: new Date().toISOString(),
            left_tic: leftTic,
            right_tic: rightTic,
            left_gal: Math.round(leftGal * 10) / 10,
            right_gal: Math.round(rightGal * 10) / 10,
            total_gal: Math.round(totalGal * 10) / 10,
        };

        const separate = referenceGal !== undefined;
        const ref = separate ? referenceGal : edmReading;
        if (separate) {
            measurement.edm_gal = (edmReading != null && edmReading > 0) ? edmReading : null;
        } else if (edmReading != null && edmReading > 0) {
            measurement.edm_gal = edmReading;
        }

        if (ref != null && ref > 0) {
            measurement.variance_gal = Math.round((totalGal - ref) * 10) / 10;
            measurement.variance_pct = Math.round(Math.abs(totalGal - ref) / ref * 1000) / 10;
            measurement.accuracy = FuelEngine.getAccuracyGrade(measurement.variance_pct);
        }

        return measurement;
    }

    /**
     * Grade measurement accuracy based on variance percentage.
     * @param {number} variancePercent - Absolute variance as percentage
     * @returns {string} 'excellent' | 'good' | 'check'
     */
    static getAccuracyGrade(variancePercent) {
        if (variancePercent < 5) return 'excellent';
        if (variancePercent <= 10) return 'good';
        return 'check';
    }

    /**
     * Extract the Dynon D-180 EMS's own fuel-remaining figure (EMS serial field 12,
     * forwarded by the Pi as data.Fuel_Remaining). This is an instrument reading.
     * The Pi's own tracker (data.fuel.*) is deliberately NOT read: fuel on board is
     * tracked on the tablet (FuelTankState). Fuel_Remaining is the only name the Pi
     * emits (engine_monitor.py parse); the old aliases were never sent by it.
     * @param {object} data - Engine poll data
     * @returns {number} Fuel remaining in gallons (0 if unavailable)
     */
    static extractEdmFuel(data) {
        if (!data) return 0;
        const v = Number(data.Fuel_Remaining);
        return Number.isFinite(v) ? v : 0;
    }

    /**
     * Calculate fuel endurance from gallons and burn rate.
     * @param {number} gallons - Fuel quantity
     * @param {number} gph - Burn rate in gallons per hour
     * Total minutes are rounded first and then split, so hours × 60 + minutes is
     * always totalMin and minutes is 0-59 (119.6 min → 2:00, never 1:60).
     * @returns {{ hours: number, minutes: number, totalMin: number }}
     */
    static endurance(gallons, gph) {
        if (!gallons || !gph || gph <= 0) return { hours: 0, minutes: 0, totalMin: 0 };
        const { h, m, totalMin } = FuelEngine.splitHm((gallons / gph) * 60, 'min');
        return { hours: h, minutes: m, totalMin };
    }

    /**
     * The one h:mm splitter. Rounds the TOTAL to whole minutes first, then splits,
     * so minutes is always 0-59 and h × 60 + m = totalMin (119.6 min → 2:00; the old
     * floor(h) / round(rest) split showed "1:60").
     * @param {number} value - the duration
     * @param {'min'|'hr'|'s'} [unit='min']
     * @returns {{h: number, m: number, totalMin: number}}
     */
    static splitHm(value, unit = 'min') {
        const perMin = unit === 'hr' ? 60 : unit === 's' ? 1 / 60 : 1;
        const totalMin = Math.round(value * perMin);
        return { h: Math.floor(totalMin / 60), m: totalMin % 60, totalMin };
    }

    /**
     * Format a duration with splitHm(). Styles (each byte-identical to the
     * formatter it replaced):
     *   'colon'    "H:MM"                          (ENG page / ENG panel endurance,
     *                                               route planner altitude ETE, fuel-stop picker)
     *   'colonOrM' "H:MM", or "Mm" under an hour   (instrument strip / route table /
     *                                               power tradeoff ETE)
     *   'hm'       "Hh MMm"                        (route planner summary ETE)
     *   'hThinM'   "Hh Mm" (thin space), or "Mm"   (fuel-stop overlay ETE)
     *   'hMin'     "H h M min"                     (position health durations)
     * @param {number} value
     * @param {'min'|'hr'|'s'} unit
     * @param {string} style
     * @returns {string}
     */
    static formatHm(value, unit, style) {
        const { h, m } = FuelEngine.splitHm(value, unit);
        const mm = String(m).padStart(2, '0');
        switch (style) {
            case 'colonOrM': return h > 0 ? `${h}:${mm}` : `${m}m`;
            case 'hm':       return `${h}h ${mm}m`;
            case 'hThinM':   return h > 0 ? `${h}h\u2009${m}m` : `${m}m`;
            case 'hMin':     return `${h} h ${m} min`;
            case 'colon':
            default:         return `${h}:${mm}`;
        }
    }

    /**
     * Calculate fuel burn for a distance at a given burn rate and ground speed.
     * @param {number} distNm - Distance in nautical miles
     * @param {number} gsKt - Ground speed in knots
     * @param {number} gph - Fuel burn rate in gallons per hour
     * @returns {number} Fuel burned in gallons
     */
    static fuelForDistance(distNm, gsKt, gph) {
        if (!distNm || !gsKt || gsKt <= 0 || !gph) return 0;
        const timeHrs = distNm / gsKt;
        return timeHrs * gph;
    }
}
