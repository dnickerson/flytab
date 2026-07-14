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

        // classify() below anchors transition legality on _pendingCandidate
        // when one is in progress, not always on _committedPhase -- this
        // fixes a real deadlock (a fast multi-hop signal walk that outpaces
        // an intermediate phase's own dwell time; see the comment in
        // classify()). Accepted tradeoff, confirmed by Dana: a noisy
        // telemetry sequence could in theory walk through several single-row
        // hops, each validated only against the immediately preceding
        // ephemeral candidate rather than the last confirmed phase, before a
        // final phase's own dwell requirement gates the actual commit. This
        // mirrors the Python original's own non-dwell-gated hop-by-hop
        // `current` variable, and committing a final phase still requires
        // that phase's full dwell of consistent signal, which bounds the
        // practical risk. Do not add chain-validation against the last
        // committed phase without care -- that was explicitly declined as
        // introducing more design risk than it resolves, and could
        // reintroduce the deadlock if done carelessly.
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
        // Legality is checked against the pending (not-yet-committed)
        // candidate when one is in progress, falling back to the committed
        // phase otherwise. Without this, a fast multi-hop signal walk (e.g.
        // a steep descent crossing descent -> approach -> landing in under
        // approach's own dwell_seconds) permanently deadlocks the FSM: the
        // batch detect_phases() commits each graph hop immediately (no
        // per-hop dwell gate) and only prunes short segments in a
        // non-causal post-hoc pass, so 'landing' becomes reachable the
        // instant 'current' has already advanced to 'approach'. This causal
        // port has no such immediate-commit step, so 'approach' can still
        // be mid-dwell (not yet committedPhase) when the raw signal moves
        // on to 'landing' -- checking legality against the pending
        // candidate as well recognizes that hop as already "in flight" and
        // lets the FSM continue advancing instead of being stuck rejecting
        // every future candidate against a stale committedPhase forever.
        const legalityAnchor = this._pendingCandidate ?? this._committedPhase;
        const validated = applyTransition(candidate, legalityAnchor, this._transitions);

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
