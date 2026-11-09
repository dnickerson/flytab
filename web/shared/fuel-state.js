/**
 * FlyTab — Fuel State Manager
 * Priority chain for fuel on board (FuelState.getCurrentFuel):
 *   manual override > tracked per-tank state (FuelTankState) > capacity
 *
 * The tablet is the single source of fuel. The Pi/EDM fuel figure is never a
 * source of fuel on board (the Pi supplies fuel flow only, which FuelTankState
 * integrates into the tracked state).
 */

class FuelState {
    /**
     * Save a tic mark measurement to localStorage.
     * @param {object} m - Measurement from FuelEngine.createMeasurement()
     */
    static saveMeasurement(m) {
        Settings.fuelMeasurement = m;
    }

    /**
     * Set a manual fuel override (gallons).
     * @param {number} gal
     */
    static setManualOverride(gal) {
        Settings.fuelManualOverride = (gal != null && gal > 0) ? gal : null;
    }

    /**
     * Clear the manual override — reverts to next priority source.
     */
    static clearManualOverride() {
        Settings.fuelManualOverride = null;
    }

    /**
     * Get current fuel on board using the canonical live-fuel priority chain:
     * manual override > FuelTankState (canonical live per-tank tracker) > capacity fallback.
     *
     * `stale` is the single shared answer to "can this number be trusted as a live
     * measurement?". It is true only for a tracked `tank_state` figure that
     * FuelTankState considers unconfirmed (>45 min without an integrated sample —
     * an in-flight tablet reboot, Pi dropout or app kill). The burn during that gap
     * was never subtracted, so a stale figure always reads HIGH; every display that
     * shows it must mark it rather than present it as a measurement.
     *
     * It lives here rather than in each consumer because three instruments
     * (engine-page.js, instrument-strip.js, route-table.js) plus the
     * activeroute:legupdate payload all need the same answer, and they must never
     * disagree about whether a figure is trustworthy. A manual override is the
     * pilot's own entry and never goes stale; the capacity fallback is a planning
     * default with nothing tracked behind it, so staleness does not apply there
     * either (consumers gate that case on `source === 'capacity'` instead).
     *
     * @returns {{ gallons: number, source: 'manual'|'tank_state'|'capacity', stale: boolean }}
     */
    static getCurrentFuel() {
        const manual = Settings.fuelManualOverride;
        if (manual != null && manual > 0) {
            return { gallons: manual, source: 'manual', stale: false };
        }
        try {
            if (typeof FuelTankState !== 'undefined') {
                const state = FuelTankState.getState();
                if (state) {
                    // Nested try: a throw out of needsConfirmation() must not drop the
                    // caller through to the capacity fallback, which would silently
                    // replace a real tracked reading with full tanks.
                    let stale = false;
                    try { stale = !!FuelTankState.needsConfirmation(); } catch (_) { stale = false; }
                    return { gallons: state.left_gal + state.right_gal, source: 'tank_state', stale };
                }
            }
        } catch (_) { /* FuelTankState unavailable */ }
        return { gallons: FuelState._capacityFallback(), source: 'capacity', stale: false };
    }

    /** Shared capacity fallback — must match fuel-tanks.js's own 18gal/side * 2 default. */
    static _capacityFallback() {
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) return cap;
            }
        } catch (_) { /* use default */ }
        return 36; // matches fuel-tanks.js's hardcoded 18gal/side fallback, not the old 50gal guess
    }
}
