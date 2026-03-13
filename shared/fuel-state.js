/**
 * FlyPi — Fuel State Manager
 * Priority chain for determining start fuel:
 *   manual override
 *   > engine stopped (RPM=0): tic measurement > EDM live > capacity
 *   > engine running (RPM>0): EDM live > tic measurement > capacity
 *
 * Rationale: before engine start the pilot has just measured fuel with tic marks,
 * so the physical measurement beats the EDM (which may show stale/inaccurate data).
 * Once the engine is running the EDM is actively tracking consumption and wins.
 */

class FuelState {
    /** EDM data is considered fresh if polled within this many ms */
    static EDM_FRESHNESS_MS = 10000;
    /** RPM above which the engine is considered running */
    static ENGINE_RUNNING_RPM = 200;

    /**
     * Get start fuel for route computation using priority chain.
     * @returns {{ gallons: number, source: 'manual'|'edm'|'tic'|'capacity' }}
     */
    static getStartFuel() {
        // 1. Manual override (highest priority)
        const manual = Settings.fuelManualOverride;
        if (manual != null && manual > 0) {
            return { gallons: manual, source: 'manual' };
        }

        // Gather EDM state (fresh reading + RPM)
        let edmFuel = 0;
        let edmFresh = false;
        try {
            const panel = window.enginePanel;
            if (panel && panel.lastData && panel.lastPollTime) {
                const age = Date.now() - panel.lastPollTime;
                if (age < FuelState.EDM_FRESHNESS_MS) {
                    edmFresh = true;
                    edmFuel = FuelEngine.extractEdmFuel(panel.lastData) ?? 0;
                }
            }
        } catch (_) { /* no engine panel */ }

        const rpm = (() => {
            try {
                const d = window.enginePanel?.lastData;
                return d ? (d.rpm ?? d.RPM ?? 0) : 0;
            } catch (_) { return 0; }
        })();
        const engineRunning = rpm > FuelState.ENGINE_RUNNING_RPM;

        // Tic measurement
        const measurement = Settings.fuelMeasurement;
        const ticFuel = (measurement && measurement.total_gal > 0) ? measurement.total_gal : 0;

        // 2. Engine stopped: tic beats EDM
        if (!engineRunning) {
            if (ticFuel > 0) return { gallons: ticFuel, source: 'tic' };
            if (edmFresh && edmFuel > 0) return { gallons: edmFuel, source: 'edm' };
        }

        // 3. Engine running: EDM beats tic
        if (engineRunning) {
            if (edmFresh && edmFuel > 0) return { gallons: edmFuel, source: 'edm' };
            if (ticFuel > 0) return { gallons: ticFuel, source: 'tic' };
        }

        // 4. Full capacity (lowest priority)
        let cap = 50;
        try {
            if (typeof CockpitConfig !== 'undefined') {
                cap = CockpitConfig.aircraft('performance.fuel_capacity_gal') ?? 50;
            }
        } catch (_) { /* use default */ }

        return { gallons: cap, source: 'capacity' };
    }

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
}
