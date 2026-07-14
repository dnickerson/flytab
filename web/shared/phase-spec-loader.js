'use strict';

const REQUIRED_KEYS = ['version', 'phases', 'transitions', 'thresholds', 'dwell_seconds', 'descriptions'];

function validatePhaseSpec(spec) {
    for (const key of REQUIRED_KEYS) {
        if (!(key in spec)) {
            throw new Error(`phase_spec.json missing key: ${key}`);
        }
    }
    const phases = new Set(spec.phases);
    for (const phase of phases) {
        if (!(phase in spec.transitions)) {
            throw new Error(`phases missing a transitions entry: ${phase}`);
        }
        if (!(phase in spec.dwell_seconds)) {
            throw new Error(`phases missing a dwell_seconds entry: ${phase}`);
        }
        if (!(phase in spec.descriptions)) {
            throw new Error(`phases missing a descriptions entry: ${phase}`);
        }
        for (const target of spec.transitions[phase]) {
            if (!phases.has(target)) {
                throw new Error(`transitions['${phase}'] references unknown phase: ${target}`);
            }
        }
    }
    return spec;
}

async function loadPhaseSpec(fetchImpl) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) {
        throw new Error('loadPhaseSpec requires a fetch implementation (none injected and no global fetch)');
    }
    const res = await doFetch('phase_spec.json');
    if (!res.ok) {
        throw new Error(`Failed to load phase_spec.json: HTTP ${res.status}`);
    }
    const spec = await res.json();
    return validatePhaseSpec(spec);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { validatePhaseSpec, loadPhaseSpec };
}
if (typeof window !== 'undefined') {
    window.validatePhaseSpec = validatePhaseSpec;
    window.loadPhaseSpec = loadPhaseSpec;
}
