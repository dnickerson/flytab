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
});
