import { describe, it, expect } from 'vitest';
import classifyModule from '../../web/shared/phase-detector-classify.js';

const { classifyRow, applyTransition } = classifyModule;

const THR = {
    rpm_shutdown: 100, rpm_startup_max: 1400, rpm_runup_min: 1600, rpm_runup_max: 2100,
    rpm_takeoff_min: 2400, mp_full_power: 25.0, ff_shutdown_max: 0.5,
    alt_roc_climb_fpm: 350, alt_roc_descent_fpm: -350, alt_airborne_min_agl_ft: 200,
    alt_approach_agl_ft: 300, speed_approach_max_kts: 90, speed_landing_max_kts: 30,
    speed_taxi_max_kts: 20, startup_rpm_slope_flatten_rpm: 20,
};

const TRANSITIONS = {
    startup: ['warmup'], warmup: ['taxi_out', 'runup', 'shutdown'],
    taxi_out: ['runup', 'warmup', 'takeoff', 'shutdown'], runup: ['taxi_out', 'takeoff', 'warmup', 'shutdown'],
    takeoff: ['climb', 'taxi_out'], climb: ['cruise', 'descent', 'approach'],
    cruise: ['climb', 'descent', 'approach'], descent: ['cruise', 'climb', 'approach'],
    approach: ['landing', 'taxi_in', 'climb', 'cruise', 'descent'], landing: ['taxi_in', 'takeoff'],
    taxi_in: ['shutdown', 'warmup', 'takeoff'], shutdown: [],
};

function baseSignals(overrides) {
    return {
        rpm: 800, agl: 0, speedKts: 0, mp: 15, fuelFlow: 6, altRateFpm: 0,
        rpmSlope: 0, stationary: true, ...overrides,
    };
}
function baseState(overrides) {
    return { currentPhase: 'warmup', hasTakenOff: false, hasLeftRamp: false, ...overrides };
}

describe('classifyRow', () => {
    it('returns shutdown when RPM and fuel flow are both near zero', () => {
        const c = classifyRow(baseSignals({ rpm: 0, fuelFlow: 0 }), baseState(), THR);
        expect(c).toBe('shutdown');
    });

    it('stays in startup while RPM is still climbing (rpmSlope above flatten)', () => {
        const c = classifyRow(baseSignals({ rpm: 1000, rpmSlope: 50 }), baseState({ currentPhase: 'startup' }), THR);
        expect(c).toBe('startup');
    });

    it('exits startup to warmup once RPM slope flattens', () => {
        const c = classifyRow(baseSignals({ rpm: 1000, rpmSlope: 5 }), baseState({ currentPhase: 'startup' }), THR);
        expect(c).toBe('warmup');
    });

    it('classifies runup at elevated stationary RPM', () => {
        const c = classifyRow(baseSignals({ rpm: 1800, stationary: true }), baseState(), THR);
        expect(c).toBe('runup');
    });

    it('classifies takeoff at high power while moving on the ground', () => {
        const c = classifyRow(baseSignals({ rpm: 2500, mp: 27, stationary: false, agl: 0 }), baseState(), THR);
        expect(c).toBe('takeoff');
    });

    it('classifies taxi_out when moving, low RPM, before first takeoff', () => {
        const c = classifyRow(baseSignals({ rpm: 900, stationary: false }), baseState({ hasTakenOff: false }), THR);
        expect(c).toBe('taxi_out');
    });

    it('classifies taxi_in when moving, low RPM, after having taken off', () => {
        const c = classifyRow(baseSignals({ rpm: 900, stationary: false }), baseState({ hasTakenOff: true }), THR);
        expect(c).toBe('taxi_in');
    });

    it('classifies landing when moving fast on the ground after takeoff', () => {
        const c = classifyRow(baseSignals({ rpm: 900, stationary: false, speedKts: 25 }), baseState({ hasTakenOff: true }), THR);
        expect(c).toBe('landing');
    });

    it('warmup only reachable before has_left_ramp, per the ground-ops has_left_ramp latch', () => {
        const stationaryPostRamp = classifyRow(baseSignals({ rpm: 900, stationary: true }), baseState({ hasLeftRamp: true, hasTakenOff: false }), THR);
        expect(stationaryPostRamp).toBe('taxi_out');
        const stationaryPreRamp = classifyRow(baseSignals({ rpm: 900, stationary: true }), baseState({ hasLeftRamp: false, hasTakenOff: false }), THR);
        expect(stationaryPreRamp).toBe('warmup');
    });

    it('classifies climb/cruise/descent airborne by altitude rate', () => {
        const airborneState = baseState({ hasTakenOff: true });
        expect(classifyRow(baseSignals({ agl: 1000, altRateFpm: 500, speedKts: 100 }), airborneState, THR)).toBe('climb');
        expect(classifyRow(baseSignals({ agl: 1000, altRateFpm: 0, speedKts: 100 }), airborneState, THR)).toBe('cruise');
        expect(classifyRow(baseSignals({ agl: 1000, altRateFpm: -500, speedKts: 100 }), airborneState, THR)).toBe('descent');
    });

    it('classifies approach vs landing near the field by speed', () => {
        const airborneState = baseState({ hasTakenOff: true });
        expect(classifyRow(baseSignals({ agl: 200, speedKts: 60 }), airborneState, THR)).toBe('approach');
        expect(classifyRow(baseSignals({ agl: 200, speedKts: 20 }), airborneState, THR)).toBe('landing');
    });
});

describe('applyTransition', () => {
    it('accepts a candidate that is a legal transition from the current phase', () => {
        expect(applyTransition('taxi_out', 'warmup', TRANSITIONS)).toBe('taxi_out');
    });

    it('stays in the current phase when the candidate is not a legal transition', () => {
        expect(applyTransition('landing', 'warmup', TRANSITIONS)).toBe('warmup');
    });

    it('always accepts staying in the same phase', () => {
        expect(applyTransition('warmup', 'warmup', TRANSITIONS)).toBe('warmup');
    });

    it('shutdown has no legal outgoing transitions (terminal)', () => {
        expect(applyTransition('startup', 'shutdown', TRANSITIONS)).toBe('shutdown');
    });
});
