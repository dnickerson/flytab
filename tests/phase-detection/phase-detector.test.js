import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import phaseDetectorModule from '../../web/shared/phase-detector.js';

const { PhaseDetector } = phaseDetectorModule;

const SPEC = JSON.parse(readFileSync(join(__dirname, '../../web/phase_spec.json'), 'utf8'));

function sample(overrides) {
    return {
        rpm: 800, mp: 15, fuelFlow: 6, lat: 33.5, lon: -85.2, altitudeFt: 620, speedKts: 0,
        ...overrides,
    };
}

describe('PhaseDetector', () => {
    let det;
    beforeEach(() => { det = new PhaseDetector(SPEC); });

    it('starts in startup', () => {
        expect(det.classify(sample())).toBe('startup');
    });

    it('does not flicker into a candidate phase before its dwell time elapses', () => {
        // Feed 200 stationary low-RPM samples to lock field elevation and
        // exit startup into warmup (rpmSlope flattens immediately since RPM
        // is constant).
        let last;
        for (let i = 0; i < 205; i++) last = det.classify(sample());
        expect(last).toBe('warmup');

        // One single sample that would classify as runup must NOT
        // immediately flip the committed phase (dwell_seconds.runup = 15).
        const oneRunupSample = det.classify(sample({ rpm: 1800 }));
        expect(oneRunupSample).toBe('warmup');
    });

    it('commits to a new phase once its dwell time is satisfied', () => {
        for (let i = 0; i < 205; i++) det.classify(sample());
        let last;
        for (let i = 0; i < 16; i++) last = det.classify(sample({ rpm: 1800 }));
        expect(last).toBe('runup');
    });

    it('never emits a phase outside the 12-phase taxonomy', () => {
        const seen = new Set();
        for (let i = 0; i < 205; i++) seen.add(det.classify(sample()));
        for (let i = 0; i < 20; i++) seen.add(det.classify(sample({ rpm: 900, speedKts: 10, lon: -85.2 - i * 0.0001 })));
        for (const phase of seen) {
            expect(SPEC.phases).toContain(phase);
        }
    });

    it('does not deadlock in descent when a fast signal walk outpaces approach\'s own dwell time', () => {
        // Regression test for the legalityAnchor fix in classify(): a real fast
        // descent can walk descent -> approach -> landing faster than
        // 'approach' can satisfy its own dwell_seconds (10), and 'landing' is
        // only a legal transition target from 'approach' (never directly from
        // 'descent' -- see phase_spec.json's transitions table). Before the
        // fix, checking legality only against the committed phase meant the
        // FSM got stuck in 'descent' forever once this happened.

        // --- Warm up to an airborne 'descent' committed phase ---

        // startup -> warmup: 205 stationary low-RPM samples lock field
        // elevation (200 ground samples, locks @ 620ft) and flatten rpmSlope.
        for (let i = 0; i < 205; i++) det.classify(sample());

        // warmup -> runup: rpm 1600-2100, stationary; dwell_seconds.runup = 15.
        for (let i = 0; i < 16; i++) det.classify(sample({ rpm: 1800 }));

        // runup -> takeoff: rpm >= 2400, mp >= 25, moving (!stationary);
        // dwell_seconds.takeoff = 5. Once takeoff commits, hasTakenOff latches.
        for (let i = 0; i < 6; i++) {
            det.classify(sample({
                rpm: 2500, mp: 30, fuelFlow: 12, speedKts: 60,
                lon: -85.2 - (i + 1) * 0.01,
            }));
        }

        // takeoff -> climb: ramp altitude up 60ft/sample. speedKts stays >= 90
        // the whole time so classifyRow's near-field approach/landing branch
        // never fires while agl is still small. altRateFpm (30s trailing
        // window) crosses the climb threshold (350 fpm) a handful of samples
        // in; dwell_seconds.climb = 15.
        let altitudeFt = 620;
        let last;
        for (let i = 0; i < 40; i++) {
            altitudeFt += 60;
            last = det.classify(sample({ rpm: 2650, mp: 28, fuelFlow: 14, speedKts: 100, altitudeFt }));
        }
        expect(last).toBe('climb');

        // climb -> descent: reverse the ramp (-60ft/sample). The trailing
        // alt-rate window still contains climb history at first, so the rate
        // takes ~17 samples of descent to swing below the descent threshold
        // (-350 fpm); dwell_seconds.descent = 15.
        for (let i = 0; i < 35; i++) {
            altitudeFt -= 60;
            last = det.classify(sample({ rpm: 1500, mp: 20, fuelFlow: 8, speedKts: 100, altitudeFt }));
        }
        expect(last).toBe('descent');

        // --- The regression scenario itself: a fast descent -> approach ->
        // landing walk, faster than approach's own dwell time. ---

        // Drop below alt_approach_agl_ft (300) and feed only 2 samples at
        // 30-90kts, which classify as 'approach' -- fewer than
        // dwell_seconds.approach (10), so 'approach' never becomes the
        // committed phase, only the pending candidate.
        altitudeFt -= 60;
        for (let i = 0; i < 2; i++) {
            last = det.classify(sample({ rpm: 1500, mp: 15, fuelFlow: 8, speedKts: 50, altitudeFt }));
        }
        expect(last).toBe('descent'); // still descent; approach hasn't dwelled

        // Now switch straight to <30kts samples, which classify as 'landing',
        // for longer than dwell_seconds.landing (8). 'landing' is legal from
        // 'approach' but not from 'descent' -- before the fix this would
        // never validate and the FSM would stay stuck in 'descent' forever.
        for (let i = 0; i < 10; i++) {
            last = det.classify(sample({ rpm: 1500, mp: 15, fuelFlow: 8, speedKts: 10, altitudeFt }));
        }
        expect(last).toBe('landing');
    });

    it('reports climb as pending-or-committed before its dwell time elapses, via isPendingOrCommitted', () => {
        // Regression test for Task 17: engine-ml.js's CHT relaxed-limit check
        // needs to know when 'climb' is the pending (not-yet-committed)
        // candidate, not just when it has actually committed -- the FSM's own
        // dwell_seconds.climb (15) gate must NOT change, but the CHT check
        // should be able to relax its limit a few seconds earlier, during
        // exactly the highest-CHT-stress window of a real climb.

        // --- Warm up to a committed 'takeoff', same sequence as the
        // descent-deadlock test above. ---
        for (let i = 0; i < 205; i++) det.classify(sample());
        for (let i = 0; i < 16; i++) det.classify(sample({ rpm: 1800 }));
        for (let i = 0; i < 6; i++) {
            det.classify(sample({
                rpm: 2500, mp: 30, fuelFlow: 12, speedKts: 60,
                lon: -85.2 - (i + 1) * 0.01,
            }));
        }

        // Ramp altitude up 60ft/sample, same as the deadlock test's climb
        // approach. altRateFpm (30s trailing window) crosses the climb
        // threshold (350 fpm) at ramp sample 4 (confirmed by direct
        // simulation), making 'climb' the pending candidate from then on --
        // but dwell_seconds.climb (15) is not satisfied until ramp sample 18,
        // so the committed phase stays 'takeoff' throughout this loop.
        let altitudeFt = 620;
        let last;
        for (let i = 0; i < 11; i++) {
            altitudeFt += 60;
            last = det.classify(sample({ rpm: 2650, mp: 28, fuelFlow: 14, speedKts: 100, altitudeFt }));
        }

        // Proves isPendingOrCommitted returns true strictly earlier than a
        // plain committed-phase check would: the committed phase is still
        // 'takeoff' (climb has not dwelled long enough to commit), yet
        // isPendingOrCommitted('climb') is already true.
        expect(last).toBe('takeoff');
        expect(det.isPendingOrCommitted('climb')).toBe(true);
        // Sanity check on the method itself: the currently-committed phase
        // also reads as pending-or-committed...
        expect(det.isPendingOrCommitted('takeoff')).toBe(true);
        // ...but an unrelated phase that is neither committed nor pending
        // does not.
        expect(det.isPendingOrCommitted('cruise')).toBe(false);
    });

    it('commits to shutdown from a committed airborne phase on a genuine in-flight engine failure', () => {
        // Regression test for Task 14: phase_spec.json's transitions table had
        // no path from any airborne phase to 'shutdown', so classifyRow's
        // unconditional 'shutdown' candidate (rpm < rpm_shutdown &&
        // fuelFlow < ff_shutdown_max) was silently rejected by applyTransition
        // forever once airborne, freezing the committed phase at whatever it
        // was when the engine died -- even though this is exactly when a real
        // engine failure would produce those readings.

        // --- Warm up to a committed airborne phase (climb), reusing the same
        // sequence as the descent-deadlock test above. ---
        for (let i = 0; i < 205; i++) det.classify(sample());
        for (let i = 0; i < 16; i++) det.classify(sample({ rpm: 1800 }));
        for (let i = 0; i < 6; i++) {
            det.classify(sample({
                rpm: 2500, mp: 30, fuelFlow: 12, speedKts: 60,
                lon: -85.2 - (i + 1) * 0.01,
            }));
        }
        let altitudeFt = 620;
        let last;
        for (let i = 0; i < 40; i++) {
            altitudeFt += 60;
            last = det.classify(sample({ rpm: 2650, mp: 28, fuelFlow: 14, speedKts: 100, altitudeFt }));
        }
        expect(last).toBe('climb');

        // Simulate a genuine in-flight engine failure: rpm and fuel flow both
        // drop to zero while still airborne. Feed enough samples to satisfy
        // dwell_seconds.shutdown (5) and confirm the detector actually commits
        // to 'shutdown' instead of staying wedged in 'climb'.
        for (let i = 0; i < SPEC.dwell_seconds.shutdown; i++) {
            last = det.classify(sample({ rpm: 0, fuelFlow: 0, speedKts: 100, altitudeFt }));
        }
        expect(last).toBe('shutdown');
    });
});

describe('PhaseDetector reset on a new engine-start after shutdown', () => {
    it('recovers into startup instead of staying stuck in shutdown forever', () => {
        const det = new PhaseDetector(SPEC);

        // Drive the detector all the way to a committed 'shutdown' (engine off).
        for (let i = 0; i < 205; i++) det.classify(sample()); // -> warmup (per Task 4's existing test)
        let last;
        for (let i = 0; i < 10; i++) {
            last = det.classify(sample({ rpm: 0, fuelFlow: 0 })); // dwell_seconds.shutdown = 5
        }
        expect(last).toBe('shutdown');

        // A single noisy sample above the shutdown thresholds must NOT reset by
        // itself -- shutdown_restart_debounce_samples (3) requires consecutive
        // restart-condition samples, guarding against a sensor blip wedging the
        // detector at 'startup' for the rest of a genuine ground stop.
        expect(det.classify(sample({ rpm: 800, fuelFlow: 6 }))).toBe('shutdown');
        expect(det.classify(sample({ rpm: 800, fuelFlow: 6 }))).toBe('shutdown');

        // If the noise stops before the debounce completes, the count resets --
        // a genuinely-off sample after two "noisy" ones must not carry over
        // partial progress toward a reset.
        expect(det.classify(sample({ rpm: 0, fuelFlow: 0 }))).toBe('shutdown');
        expect(det.classify(sample({ rpm: 800, fuelFlow: 6 }))).toBe('shutdown'); // debounce count = 1 again
        expect(det.classify(sample({ rpm: 800, fuelFlow: 6 }))).toBe('shutdown'); // debounce count = 2

        // Third consecutive genuine restart sample confirms it -- resets and
        // classifies this same sample fresh.
        const afterRestart = det.classify(sample({ rpm: 800, fuelFlow: 6 })); // debounce count = 3
        expect(afterRestart).toBe('startup');

        // The detector must behave like a genuinely fresh instance from here --
        // confirm it can reach warmup again via the same path Task 4's own test uses,
        // not remain wedged in some half-reset state.
        let last2;
        for (let i = 0; i < 205; i++) last2 = det.classify(sample({ rpm: 800, fuelFlow: 6 }));
        expect(last2).toBe('warmup');
    });
});

describe('PhaseDetector#getFieldElevationFt', () => {
    it('is null before any samples have been classified', () => {
        const det = new PhaseDetector(SPEC);
        expect(det.getFieldElevationFt()).toBeNull();
    });

    it('is a numeric estimate after enough ground samples lock it', () => {
        const det = new PhaseDetector(SPEC);
        for (let i = 0; i < 205; i++) det.classify(sample());
        expect(det.getFieldElevationFt()).toBe(620);
    });

    it('resets to null after a confirmed shutdown->restart, before re-locking on the new leg', () => {
        const det = new PhaseDetector(SPEC);

        // Drive to a locked field elevation and committed 'shutdown', same
        // path as the reset test above.
        for (let i = 0; i < 205; i++) det.classify(sample()); // -> warmup, field elev locks @ 620ft
        expect(det.getFieldElevationFt()).toBe(620);

        let last;
        for (let i = 0; i < 10; i++) {
            last = det.classify(sample({ rpm: 0, fuelFlow: 0 })); // dwell_seconds.shutdown = 5
        }
        expect(last).toBe('shutdown');
        expect(det.getFieldElevationFt()).toBe(620); // still locked from leg 1 -- shutdown alone doesn't reset

        // Confirm restart (shutdown_restart_debounce_samples = 3 consecutive
        // above-threshold samples), matching the pattern in the reset test above.
        for (let i = 0; i < 2; i++) det.classify(sample({ rpm: 800, fuelFlow: 6 }));
        const afterRestart = det.classify(sample({ rpm: 800, fuelFlow: 6 }));
        expect(afterRestart).toBe('startup');

        // Confirmed restart must clear the stale leg-1 estimate immediately --
        // before any new-leg ground samples have re-locked it -- so a
        // higher/lower-elevation leg-2 airport doesn't inherit leg 1's value.
        expect(det.getFieldElevationFt()).toBeNull();

        // Re-locks on the new leg's own ground samples, at a different
        // altitude, proving it's a fresh estimate and not leg 1's.
        for (let i = 0; i < 205; i++) det.classify(sample({ rpm: 800, fuelFlow: 6, altitudeFt: 900 }));
        expect(det.getFieldElevationFt()).toBe(900);
    });
});
