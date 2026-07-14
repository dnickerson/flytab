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
});
