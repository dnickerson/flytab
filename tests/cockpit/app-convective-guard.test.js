/**
 * app.js's _initCockpit() gates ~40 module instantiations behind
 * `typeof X !== 'undefined'` so a missing/typo'd <script> tag degrades
 * silently. ConvectiveDisplay/ConvectiveAlerts were the one exception —
 * instantiated unguarded inside a block that otherwise guards
 * ConvectiveIntelligenceEngine/HRRRPreflightStore.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const APP_SRC = readFileSync('web/app.js', 'utf8');

describe('Convective classes are guarded like every other module in _initCockpit (Finding 9 stopgap)', () => {
    it('ConvectiveDisplay/ConvectiveAlerts are instantiated inside a typeof guard', () => {
        const block = APP_SRC.slice(
            APP_SRC.indexOf('typeof ConvectiveIntelligenceEngine'),
            APP_SRC.indexOf('this.convectiveEngine.loadPreflight()')
        );
        expect(block).toMatch(/typeof ConvectiveDisplay !== 'undefined'/);
        expect(block).toMatch(/typeof ConvectiveAlerts !== 'undefined'/);
        // The guard must wrap the instantiation, not just appear somewhere in the block.
        const guardIdx = block.indexOf("typeof ConvectiveDisplay !== 'undefined'");
        const newDisplayIdx = block.indexOf('new ConvectiveDisplay(');
        expect(guardIdx).toBeGreaterThan(-1);
        expect(guardIdx).toBeLessThan(newDisplayIdx);
    });
});
