'use strict';

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000.0;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const dphi = toRad(lat2 - lat1);
    const dlmb = toRad(lon2 - lon1);
    const a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Mirrors _gps_delta_series: distance between the current sample and the
// sample `windowSamples` pushes ago (clamped at the buffer start). Already
// causal in the Python original — direct port.
class GpsDeltaWindow {
    constructor(windowSamples) {
        this._windowSamples = windowSamples;
        this._buf = []; // [{lat, lon}, ...], oldest first
    }
    push(lat, lon) {
        this._buf.push({ lat, lon });
        if (this._buf.length > this._windowSamples + 1) this._buf.shift();
        const oldest = this._buf[0];
        return haversineMeters(oldest.lat, oldest.lon, lat, lon);
    }
}

// Mirrors _rpm_slope_batch: rpm[i] - rpm[i - windowSamples], returning
// +Infinity until the trailing window is full (not enough history to judge
// whether RPM has flattened yet). Already causal — direct port.
class RpmSlopeWindow {
    constructor(windowSamples) {
        this._windowSamples = windowSamples;
        this._buf = []; // rpm values, oldest first
    }
    push(rpm) {
        this._buf.push(rpm);
        if (this._buf.length > this._windowSamples + 1) this._buf.shift();
        if (this._buf.length <= this._windowSamples) return Infinity;
        return rpm - this._buf[0];
    }
}

// Translates _rate_of_climb_batch's CENTERED +-30-sample window to a
// TRAILING windowSamples-sample window (design spec §5 causal-translation
// table: "Centered +-window alt-rate -> Trailing window alt-rate"). Returns
// null until windowSamples of history exist (a real detection lag versus
// the batch version, called out explicitly in the design spec). Assumes
// ~1Hz samples, matching the offline detector's assumption.
class TrailingAltRate {
    constructor(windowSamples) {
        this._windowSamples = windowSamples;
        this._buf = []; // altitude_ft, oldest first
    }
    push(altitudeFt) {
        this._buf.push(altitudeFt);
        if (this._buf.length > this._windowSamples + 1) this._buf.shift();
        if (this._buf.length <= this._windowSamples) return null;
        const deltaFt = altitudeFt - this._buf[0];
        return (deltaFt / this._windowSamples) * 60.0; // ft/sample -> ft/min at ~1Hz
    }
}

// Translates detect_phases()'s one-shot "median of the first 300 ground
// rows" field-elevation baseline to a running estimate that locks once a
// stable pre-flight ground sample count is reached, then freezes (design
// spec §5: "Running estimate (already implemented in engine-ml.js)" —
// this supersedes the old _computeGPSPhase's inline version so there is a
// single implementation). All three thresholds are required constructor
// arguments sourced from phase_spec.json — no in-file defaults, per this
// plan's "single numeric source of truth" constraint. The `stationary`
// argument to push() (the same GPS-delta-window boolean the caller
// already computes for classifyRow) latches an internal "has ever moved"
// flag: once true, this forces an early lock using whatever ground
// samples were seen so far (even under lockSamples), rather than letting
// a post-movement ground stop (a later taxi, a stop-and-go at a different
// field) silently keep accumulating into what should be a strictly
// pre-first-movement baseline.
class FieldElevationEstimate {
    constructor(lockSamples, stationarySpeedKts, maxIdleRpm) {
        this._lockSamples = lockSamples;
        this._stationarySpeedKts = stationarySpeedKts;
        this._maxIdleRpm = maxIdleRpm;
        this._groundSamples = [];
        this._locked = null;
        this._everMoved = false;
    }
    push(altitudeFt, speedKts, rpm, stationary) {
        if (this._locked !== null) return this._locked;
        if (!stationary) this._everMoved = true;
        if (speedKts < this._stationarySpeedKts && rpm < this._maxIdleRpm) {
            this._groundSamples.push(altitudeFt);
        }
        const reachedLockCount = this._groundSamples.length >= this._lockSamples;
        const shouldLockOnMovement = this._everMoved && this._groundSamples.length > 0;
        if (reachedLockCount || shouldLockOnMovement) {
            const sorted = [...this._groundSamples].sort((a, b) => a - b);
            this._locked = sorted[Math.floor(sorted.length / 2)];
        }
        return this._locked ?? altitudeFt;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { haversineMeters, GpsDeltaWindow, RpmSlopeWindow, TrailingAltRate, FieldElevationEstimate };
}
if (typeof window !== 'undefined') {
    window.haversineMeters = haversineMeters;
    window.GpsDeltaWindow = GpsDeltaWindow;
    window.RpmSlopeWindow = RpmSlopeWindow;
    window.TrailingAltRate = TrailingAltRate;
    window.FieldElevationEstimate = FieldElevationEstimate;
}
