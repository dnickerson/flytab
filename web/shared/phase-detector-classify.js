'use strict';

// Direct port of train_anomaly_model.py's _classify_row_batch (engine_analysis,
// commit fcec247). `signals.stationary` is the GPS-delta-window boolean
// (delta < thresholds.gps_delta_stationary_m), computed by the caller.
function classifyRow(signals, state, thresholds) {
    const { rpm, agl, speedKts, mp, fuelFlow, altRateFpm, rpmSlope, stationary } = signals;
    const { currentPhase, hasTakenOff, hasLeftRamp } = state;
    const thr = thresholds;

    if (rpm < thr.rpm_shutdown && fuelFlow < thr.ff_shutdown_max) {
        return 'shutdown';
    }

    if (currentPhase === 'startup') {
        if (rpm >= thr.rpm_startup_max || !stationary) return 'warmup';
        if (rpmSlope < thr.startup_rpm_slope_flatten_rpm) return 'warmup';
        return 'startup';
    }

    const airborne = hasTakenOff && agl >= thr.alt_airborne_min_agl_ft;

    if (!airborne) {
        if (rpm >= thr.rpm_takeoff_min && mp >= thr.mp_full_power && !stationary) return 'takeoff';
        if (rpm >= thr.rpm_runup_min && rpm <= thr.rpm_runup_max && stationary) return 'runup';
        if (!stationary) {
            if (hasTakenOff && speedKts > thr.speed_taxi_max_kts) return 'landing';
            return hasTakenOff ? 'taxi_in' : 'taxi_out';
        }
        if (hasLeftRamp) return hasTakenOff ? 'taxi_in' : 'taxi_out';
        return 'warmup';
    }

    const nearField = agl < thr.alt_approach_agl_ft;
    if (nearField && speedKts < thr.speed_approach_max_kts) {
        return speedKts < thr.speed_landing_max_kts ? 'landing' : 'approach';
    }
    if (altRateFpm > thr.alt_roc_climb_fpm) return 'climb';
    if (altRateFpm < thr.alt_roc_descent_fpm) return 'descent';
    return 'cruise';
}

// Direct port of detect_phases()'s line-281 inline transition check: accept
// the candidate only if it equals the current phase or is a legal
// transition target; otherwise stay in the current phase.
function applyTransition(candidate, currentPhase, transitions) {
    if (candidate === currentPhase) return currentPhase;
    const legal = transitions[currentPhase] || [];
    return legal.includes(candidate) ? candidate : currentPhase;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyRow, applyTransition };
}
if (typeof window !== 'undefined') {
    window.classifyRow = classifyRow;
    window.applyTransition = applyTransition;
}
