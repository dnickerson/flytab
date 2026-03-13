/**
 * FlyPi — Weight & Balance Calculator
 * Pure computation functions, no UI. Used by wb-step.js.
 */

class WbCalculator {
    /**
     * Calculate weight, CG, and moment for an aircraft loading.
     * @param {object} profile - Aircraft profile with empty_weight, empty_cg, stations[], fuel
     * @param {object} stationWeights - { index: weight } for non-fuel stations
     * @param {number} fuelGallons - Fuel load in gallons
     * @returns {object} { totalWeight, totalMoment, cg, stations[], inEnvelope }
     */
    static calculate(profile, stationWeights, fuelGallons) {
        const stations = [];

        // Empty aircraft
        const emptyWeight = profile.empty_weight || 0;
        const emptyCg = profile.empty_cg || 0;
        const emptyMoment = emptyWeight * emptyCg;

        stations.push({
            name: 'Empty Aircraft',
            weight: emptyWeight,
            arm: emptyCg,
            moment: emptyMoment,
        });

        // Non-fuel stations
        const nonFuelStations = (profile.stations || []).filter(s => !s.fuel);
        let payloadWeight = 0;
        let payloadMoment = 0;

        nonFuelStations.forEach((s, i) => {
            const weight = parseFloat(stationWeights[i]) || 0;
            const arm = s.arm || 0;
            const moment = weight * arm;
            payloadWeight += weight;
            payloadMoment += moment;
            stations.push({
                name: s.name,
                weight,
                arm,
                moment,
            });
        });

        // Fuel station
        const fuelStation = (profile.stations || []).find(s => s.fuel);
        let fuelWeight = 0;
        let fuelMoment = 0;
        if (fuelStation) {
            const galToLbs = fuelStation.gal_to_lbs || 6;
            fuelWeight = fuelGallons * galToLbs;
            const fuelArm = fuelStation.arm || 0;
            fuelMoment = fuelWeight * fuelArm;
            stations.push({
                name: 'Fuel',
                weight: fuelWeight,
                arm: fuelArm,
                moment: fuelMoment,
                gallons: fuelGallons,
            });
        }

        // Totals
        const totalWeight = emptyWeight + payloadWeight + fuelWeight;
        const totalMoment = emptyMoment + payloadMoment + fuelMoment;
        const cg = totalWeight > 0 ? totalMoment / totalWeight : 0;

        // Envelope check
        const envelope = profile.cg_envelope || profile.envelope;
        const inEnvelope = envelope
            ? WbCalculator.isInEnvelope(totalWeight, cg, envelope)
            : { ok: true, reason: 'No envelope data' };

        return {
            totalWeight: Math.round(totalWeight * 10) / 10,
            totalMoment: Math.round(totalMoment * 10) / 10,
            cg: Math.round(cg * 100) / 100,
            stations,
            inEnvelope: inEnvelope.ok,
            envelopeReason: inEnvelope.reason || null,
            overGross: totalWeight > (profile.max_gross_weight || Infinity),
        };
    }

    /**
     * Check if a weight/CG point is within the CG envelope.
     * Envelope is an array of { weight, fwd_cg, aft_cg } points defining limits.
     * Uses linear interpolation between envelope points.
     * @returns {{ ok: boolean, reason?: string }}
     */
    static isInEnvelope(weight, cg, envelope) {
        if (!envelope || !Array.isArray(envelope) || envelope.length < 2) {
            return { ok: true, reason: 'No envelope data' };
        }

        // Sort envelope points by weight
        const sorted = [...envelope].sort((a, b) => a.weight - b.weight);

        // Check if weight is within envelope weight range
        if (weight < sorted[0].weight) {
            return { ok: false, reason: `Below minimum weight (${sorted[0].weight} lb)` };
        }
        if (weight > sorted[sorted.length - 1].weight) {
            return { ok: false, reason: `Over max weight (${sorted[sorted.length - 1].weight} lb)` };
        }

        // Interpolate forward and aft CG limits at this weight
        const { fwdLimit, aftLimit } = WbCalculator._interpolateLimits(weight, sorted);

        if (cg < fwdLimit) {
            return { ok: false, reason: `CG too far forward (${cg.toFixed(2)}" < ${fwdLimit.toFixed(2)}" fwd limit)` };
        }
        if (cg > aftLimit) {
            return { ok: false, reason: `CG too far aft (${cg.toFixed(2)}" > ${aftLimit.toFixed(2)}" aft limit)` };
        }

        return { ok: true };
    }

    /**
     * Interpolate forward/aft CG limits at a given weight.
     */
    static _interpolateLimits(weight, sortedEnvelope) {
        let lower = sortedEnvelope[0];
        let upper = sortedEnvelope[sortedEnvelope.length - 1];

        for (let i = 0; i < sortedEnvelope.length - 1; i++) {
            if (weight >= sortedEnvelope[i].weight && weight <= sortedEnvelope[i + 1].weight) {
                lower = sortedEnvelope[i];
                upper = sortedEnvelope[i + 1];
                break;
            }
        }

        const range = upper.weight - lower.weight;
        const t = range > 0 ? (weight - lower.weight) / range : 0;

        return {
            fwdLimit: lower.fwd_cg + t * (upper.fwd_cg - lower.fwd_cg),
            aftLimit: lower.aft_cg + t * (upper.aft_cg - lower.aft_cg),
        };
    }

    /**
     * Get CG envelope polygon as Chart.js-compatible dataset.
     * Returns array of {x: cg, y: weight} points tracing the envelope boundary.
     */
    static getEnvelopePoints(envelope) {
        if (!envelope || !Array.isArray(envelope) || envelope.length < 2) return [];

        const sorted = [...envelope].sort((a, b) => a.weight - b.weight);

        // Forward CG line (bottom to top)
        const fwdLine = sorted.map(p => ({ x: p.fwd_cg, y: p.weight }));
        // Aft CG line (top to bottom) to close the polygon
        const aftLine = [...sorted].reverse().map(p => ({ x: p.aft_cg, y: p.weight }));

        return [...fwdLine, ...aftLine];
    }

    /**
     * Estimate landing weight and CG after fuel burn.
     * @param {object} takeoffResult - Result from calculate()
     * @param {number} fuelBurnGal - Gallons burned during flight
     * @param {object} profile - Aircraft profile
     * @returns {object} { landingWeight, landingCg, inEnvelope }
     */
    static estimateLandingWeight(takeoffResult, fuelBurnGal, profile) {
        const fuelStation = (profile.stations || []).find(s => s.fuel);
        if (!fuelStation) {
            return {
                landingWeight: takeoffResult.totalWeight,
                landingCg: takeoffResult.cg,
                inEnvelope: takeoffResult.inEnvelope,
            };
        }

        const galToLbs = fuelStation.gal_to_lbs || 6;
        const fuelBurnWeight = fuelBurnGal * galToLbs;
        const fuelArm = fuelStation.arm || 0;
        const fuelBurnMoment = fuelBurnWeight * fuelArm;

        const landingWeight = takeoffResult.totalWeight - fuelBurnWeight;
        const landingMoment = takeoffResult.totalMoment - fuelBurnMoment;
        const landingCg = landingWeight > 0 ? landingMoment / landingWeight : 0;

        const envelope = profile.cg_envelope || profile.envelope;
        const inEnvelope = envelope
            ? WbCalculator.isInEnvelope(landingWeight, landingCg, envelope)
            : { ok: true };

        return {
            landingWeight: Math.round(landingWeight * 10) / 10,
            landingCg: Math.round(landingCg * 100) / 100,
            inEnvelope: inEnvelope.ok,
            envelopeReason: inEnvelope.reason || null,
        };
    }
}
