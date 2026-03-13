/**
 * FlyTab — Flight Sync (stub)
 *
 * FlyTab architecture: Pi is data relay only (Stratux WS + engine WS).
 * Flight data recording will be implemented in Phase 3 using Capacitor
 * Filesystem — no HTTP polling to Pi, no stored data from Pi.
 *
 * This stub preserves the public API so other modules that reference
 * FlightSync get empty/safe results without errors.
 */

class FlightSync {
    constructor() {
        this._capturing = false;
        this._lastCsvFilename = null;
    }

    // ========== Public API ==========

    /** Whether a flight is currently being recorded. */
    get isRecording() { return this._capturing; }

    /** Filename of the last completed CSV (after stop). */
    get lastCsvFilename() { return this._lastCsvFilename; }

    /**
     * Called every ~2s from app.js with the latest engine status data.
     * Stub: tracks recording state only, no sync.
     */
    update(engineData) {
        if (!engineData) {
            this._capturing = false;
            return;
        }

        const wasCapturing = this._capturing;
        this._capturing = engineData.capturing === true;

        if (!wasCapturing && this._capturing) {
            console.log('[FlightSync] Capture started (stub — no local recording yet)');
            window.dispatchEvent(new CustomEvent('flightsync:started'));
        }

        if (wasCapturing && !this._capturing) {
            console.log('[FlightSync] Capture stopped (stub — no local recording yet)');
            window.dispatchEvent(new CustomEvent('flightsync:stopped', {
                detail: { csvFilename: null },
            }));
        }
    }

    /**
     * Download a flight CSV. Stub: always returns false.
     * Phase 3 will use Capacitor Filesystem for local storage.
     * @param {string} _filename
     * @returns {Promise<boolean>}
     */
    async downloadToiPad(_filename) {
        console.warn('[FlightSync] downloadToiPad not implemented — Phase 3');
        return false;
    }

    /**
     * Get list of cached flight CSVs. Stub: always returns empty array.
     * @returns {Promise<Array<{filename, size, cached_at}>>}
     */
    async getCachedFlights() {
        return [];
    }
}
