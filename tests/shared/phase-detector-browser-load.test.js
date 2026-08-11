/**
 * Regression test for a real production bug (found 2026-08-11, live on a
 * shipped build): phase-detector.js declared
 * `const { GpsDeltaWindow, RpmSlopeWindow, TrailingAltRate, FieldElevationEstimate } = helpers;`
 * at its top level -- colliding with the `class GpsDeltaWindow` etc. already
 * declared by phase-detector-helpers.js. Classic <script> tags (as used in
 * web/index.html, not ES modules) share ONE global lexical scope, so the
 * browser threw a SyntaxError parsing phase-detector.js and window.PhaseDetector
 * was never defined -- engine-ml.js's `new window.PhaseDetector(spec)` then threw,
 * silently falling back to a hardcoded 'cruise' phase for every sample, forever.
 *
 * Every other phase-detector*.test.js file loads these files via Node's
 * require()/import, which gives each file its OWN isolated module scope --
 * that isolation is exactly what hid this bug from the whole test suite for
 * as long as it shipped. This test instead concatenates the three source
 * files into ONE shared Function scope, the same way index.html's <script>
 * tags share one scope in a real browser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(join(__dirname, '../../', rel), 'utf8');

describe('phase-detector.js loads without a global-scope collision (browser <script> semantics)', () => {
    it('defines window.PhaseDetector when helpers.js, classify.js, and phase-detector.js share one scope, in index.html load order', () => {
        const helpersSrc = readSrc('web/shared/phase-detector-helpers.js');
        const classifySrc = readSrc('web/shared/phase-detector-classify.js');
        const detectorSrc = readSrc('web/shared/phase-detector.js');

        expect(() => {
            new Function(`${helpersSrc}\n${classifySrc}\n${detectorSrc}`)();
        }).not.toThrow();

        expect(typeof window.PhaseDetector).toBe('function');
    });
});
