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
     * @returns {{ hours: number, minutes: number, totalMin: number }}
     */
    static endurance(gallons, gph) {
        if (!gallons || !gph || gph <= 0) return { hours: 0, minutes: 0, totalMin: 0 };
        const totalMin = (gallons / gph) * 60;
        return {
            hours: Math.floor(totalMin / 60),
            minutes: Math.round(totalMin % 60),
            totalMin: Math.round(totalMin),
        };
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
