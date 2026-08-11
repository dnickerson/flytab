import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import phaseSpecLoaderModule from '../../web/shared/phase-spec-loader.js';

const { validatePhaseSpec, loadPhaseSpec } = phaseSpecLoaderModule;

describe('validatePhaseSpec', () => {
    it('accepts the real checked-in phase_spec.json', () => {
        const spec = JSON.parse(readFileSync(join(__dirname, '../../web/phase_spec.json'), 'utf8'));
        expect(() => validatePhaseSpec(spec)).not.toThrow();
        expect(spec.phases).toHaveLength(12);
        expect(spec.phases).toContain('startup');
        expect(spec.transitions.shutdown).toEqual([]);
    });

    it('rejects a spec missing a required top-level key', () => {
        const spec = { version: 1, phases: ['a'], transitions: {}, thresholds: {}, dwell_seconds: {} };
        expect(() => validatePhaseSpec(spec)).toThrow(/missing key: descriptions/);
    });

    it('rejects a transition pointing to an unknown phase', () => {
        const spec = {
            version: 1, phases: ['a', 'b'],
            transitions: { a: ['c'], b: [] },
            thresholds: {}, dwell_seconds: { a: 1, b: 1 }, descriptions: { a: 'x', b: 'y' },
        };
        expect(() => validatePhaseSpec(spec)).toThrow(/unknown phase: c/);
    });

    it('rejects a phase missing a dwell_seconds entry', () => {
        const spec = {
            version: 1, phases: ['a', 'b'],
            transitions: { a: [], b: [] },
            thresholds: {}, dwell_seconds: { a: 1 }, descriptions: { a: 'x', b: 'y' },
        };
        expect(() => validatePhaseSpec(spec)).toThrow(/missing a dwell_seconds entry: b/);
    });
});

describe('loadPhaseSpec', () => {
    it('fetches, parses, and validates via an injected fetch', async () => {
        const spec = JSON.parse(readFileSync(join(__dirname, '../../web/phase_spec.json'), 'utf8'));
        const fakeFetch = async (url) => {
            expect(url).toBe('phase_spec.json');
            return { ok: true, json: async () => spec };
        };
        const result = await loadPhaseSpec(fakeFetch);
        expect(result.phases).toHaveLength(12);
    });

    it('throws with a clear message on a non-ok response', async () => {
        const fakeFetch = async () => ({ ok: false, status: 404 });
        await expect(loadPhaseSpec(fakeFetch)).rejects.toThrow(/404/);
    });
});
