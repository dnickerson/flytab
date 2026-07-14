'use strict';

const helpers = (typeof require !== 'undefined')
    ? require('./phase-detector-helpers.js')
    : { GpsDeltaWindow: window.GpsDeltaWindow, RpmSlopeWindow: window.RpmSlopeWindow, TrailingAltRate: window.TrailingAltRate, FieldElevationEstimate: window.FieldElevationEstimate };
const classify = (typeof require !== 'undefined')
    ? require('./phase-detector-classify.js')
    : { classifyRow: window.classifyRow, applyTransition: window.applyTransition };

const { GpsDeltaWindow, RpmSlopeWindow, TrailingAltRate, FieldElevationEstimate } = helpers;
const { classifyRow, applyTransition } = classify;

const AIRBORNE_PHASES = new Set(['takeoff', 'climb', 'cruise', 'descent', 'approach']);

class PhaseDetector {
    constructor(spec) {
        this._spec = spec;
        this._thr = spec.thresholds;
        this._dwellSeconds = spec.dwell_seconds;
        this._transitions = spec.transitions;

        this._gpsDelta = new GpsDeltaWindow(this._thr.gps_delta_window_s);
        this._rpmSlope = new RpmSlopeWindow(this._thr.startup_rpm_slope_window_s);
        this._altRate = new TrailingAltRate(this._thr.alt_rate_window_s);
        this._fieldElev = new FieldElevationEstimate(
            this._thr.field_elev_lock_samples,
            this._thr.speed_taxi_max_kts,
            this._thr.field_elev_max_idle_rpm,
        );

        this._committedPhase = 'startup';
        this._hasTakenOff = false;
        this._hasLeftRamp = false;

        this._pendingCandidate = null;
        this._pendingSeconds = 0;
    }

    classify({ rpm, mp, fuelFlow, lat, lon, altitudeFt, speedKts }) {
        const gpsDeltaM = this._gpsDelta.push(lat, lon);
        const stationary = gpsDeltaM < this._thr.gps_delta_stationary_m;
        const rpmSlope = this._rpmSlope.push(rpm);
        const fieldElevFt = this._fieldElev.push(altitudeFt, speedKts, rpm, stationary);
        const agl = altitudeFt - fieldElevFt;
        const altRateFpm = this._altRate.push(altitudeFt) ?? 0;

        const candidate = classifyRow(
            { rpm, agl, speedKts, mp, fuelFlow, altRateFpm, rpmSlope, stationary },
            { currentPhase: this._committedPhase, hasTakenOff: this._hasTakenOff, hasLeftRamp: this._hasLeftRamp },
            this._thr,
        );
        const validated = applyTransition(candidate, this._committedPhase, this._transitions);

        if (validated === this._committedPhase) {
            this._pendingCandidate = null;
            this._pendingSeconds = 0;
        } else if (validated === this._pendingCandidate) {
            this._pendingSeconds += 1;
            const requiredSeconds = this._dwellSeconds[validated] ?? 10;
            if (this._pendingSeconds >= requiredSeconds) {
                this._committedPhase = validated;
                this._pendingCandidate = null;
                this._pendingSeconds = 0;
            }
        } else {
            this._pendingCandidate = validated;
            this._pendingSeconds = 1;
        }

        if (AIRBORNE_PHASES.has(this._committedPhase)) this._hasTakenOff = true;
        if (this._committedPhase === 'taxi_out') this._hasLeftRamp = true;

        return this._committedPhase;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PhaseDetector };
}
if (typeof window !== 'undefined') {
    window.PhaseDetector = PhaseDetector;
}
