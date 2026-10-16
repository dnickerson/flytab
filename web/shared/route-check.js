/**
 * FlyTab — Route checks for the Route Planner (redesign, see
 * docs/superpowers/specs/2026-10-15-route-planner-redesign-design.md §2).
 *
 * Pure: no DOM, no app state. Given the planner's pills and the plan Apply
 * would use, returns the problems to show, each with its reason and one-tap
 * fixes. Red problems make Apply ask first; amber ones are shown only.
 *
 *   RouteCheck.run({ pills, computed, settings, aero }) -> Promise<Problem[]>
 *     pills    RoutePlannerPanel._route: [{ id, type: dep|dest|fix|airport|fuel|awy|direct, airway? }]
 *     computed recomputeLegs() result (legs[].timeHrs, waypoints[].fuelStop/isDest,
 *              summary.totalDistNm/fuelRemGal), or null when not computed yet
 *     settings { routingMode, maxLegHrs, reserveGal }
 *     aero     { getAirway(name) -> {name, waypoints:[{name|id, lat, lon}]}|null,
 *                resolve(id) -> {lat, lon}|null }
 *   Problem = { severity: 'red'|'amber', code, pillIndexes: number[], message,
 *               fixes: [{ label, apply, arg }] }
 *   RouteCheck.applyFix(pills, fix) -> new pills (for the pill-changing fixes)
 */
const RouteCheck = (() => {
    const R_NM = 3440.065;
    const DETOUR_AMBER = 1.25;          // route more than 25 % longer than direct
    const NEAREST = 3;                  // fix suggestions per airway problem
    const EPS_HRS = 1e-6;
    const ROUTING_LABEL = {
        'v-airways': 'V-airways', 't-airways': 'T-airways', 'any': 'Any airway',
        'gps-direct': 'GPS Direct', 'vors-direct': 'VORs Direct',
    };

    const rad = (d) => d * Math.PI / 180;
    function directNm(a, b) {
        const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
            + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
        return 2 * R_NM * Math.asin(Math.sqrt(h));
    }
    const up = (s) => String(s ?? '').toUpperCase();
    const isPoint = (p) => p.type !== 'awy' && p.type !== 'direct';
    const fmtHrs = (h) => {
        const m = Math.round(h * 60);
        return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
    };
    const fmtLimit = (h) => `${h}h`;

    /** The n airway fixes nearest `c`, as { name, nm }. */
    function nearestOn(airway, c, n) {
        return (airway.waypoints || [])
            .filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon))
            .map((w) => ({ name: up(w.name ?? w.id), nm: directNm(c, w) }))
            .sort((a, b) => a.nm - b.nm)
            .slice(0, n);
    }

    async function run({ pills, computed = null, settings = {}, aero }) {
        const problems = [];
        const red = (code, pillIndexes, message, fixes = []) => problems.push({ severity: 'red', code, pillIndexes, message, fixes });
        const amber = (code, pillIndexes, message, fixes = []) => problems.push({ severity: 'amber', code, pillIndexes, message, fixes });

        // Identifiers: every pill must be found; nothing is dropped.
        const coords = new Map();
        const airways = new Map();
        for (let i = 0; i < pills.length; i++) {
            const p = pills[i];
            if (p.type === 'direct') continue;
            if (p.type === 'awy') {
                const a = await aero.getAirway(up(p.id));
                if (a) airways.set(i, a);
                else red('unknown-id', [i], `Airway ${p.id} not found`);
                continue;
            }
            const c = await aero.resolve(p.id);
            coords.set(i, c);
            if (!c) red('unknown-id', [i], `${p.id} not found`);
        }

        // Airways: the point before an airway must be on it (entry), and the point after it (exit).
        const later = [];   // amber airway-type problems, after the airway reds
        for (const [i, awy] of airways) {
            const name = pills[i].id;
            const on = new Set((awy.waypoints || []).map((w) => up(w.name ?? w.id)));
            const prev = i - 1 >= 0 && isPoint(pills[i - 1]) ? i - 1 : -1;
            let next = -1;
            for (let k = i + 1; k < pills.length; k++) { if (isPoint(pills[k])) { next = k; break; } if (pills[k].type === 'awy') break; }
            const goDirect = { label: `Go direct (no ${name})`, apply: 'goDirect', arg: { awyIndex: i } };

            if (prev >= 0 && coords.get(prev) && !on.has(up(pills[prev].id))) {
                red('entry-not-on-airway', [prev, i], `${pills[prev].id} is not on ${name}`, [
                    ...nearestOn(awy, coords.get(prev), NEAREST).map((f) => ({
                        label: `Join ${name} at ${f.name} · ${f.nm.toFixed(1)} nm`, apply: 'joinAirwayAt', arg: { airway: name, fix: f.name, awyIndex: i },
                    })),
                    goDirect,
                ]);
            }
            if (next >= 0 && coords.get(next) && !on.has(up(pills[next].id))) {
                red('exit-not-on-airway', [i, next], `${name} needs an exit fix before ${pills[next].id}`, [
                    ...nearestOn(awy, coords.get(next), NEAREST).map((f) => ({
                        label: `Leave ${name} at ${f.name} · ${f.nm.toFixed(1)} nm`, apply: 'exitAirwayAt', arg: { airway: name, fix: f.name, awyIndex: i },
                    })),
                    goDirect,
                ]);
            }

            const mode = settings.routingMode;
            if (/^T/.test(up(name)) && mode === 'v-airways') {
                later.push(['airway-type', [i], `${name} is a T-route (Routing: ${ROUTING_LABEL[mode]})`,
                    [{ label: 'Switch Routing to T-airways', apply: 'setRouting', arg: { mode: 't-airways' } }]]);
            } else if (/^V/.test(up(name)) && mode === 't-airways') {
                later.push(['airway-type', [i], `${name} is a V-airway (Routing: ${ROUTING_LABEL[mode]})`,
                    [{ label: 'Switch Routing to V-airways', apply: 'setRouting', arg: { mode: 'v-airways' } }]]);
            }
        }

        // Fuel: no stretch between fuel stops longer than the limit (strictly
        // longer), wind-corrected -- the same computed plan Apply uses.
        const maxLeg = settings.maxLegHrs;
        if (computed?.legs?.length && Number.isFinite(maxLeg) && maxLeg > 0) {
            const wps = computed.waypoints || [];
            let destIdx = wps.findIndex((w) => w.isDest);
            if (destIdx < 0) destIdx = wps.length - 1;
            const stretches = [];
            let cur = 0;
            for (let k = 0; k < Math.min(computed.legs.length, destIdx); k++) {
                cur += computed.legs[k].timeHrs || 0;
                if (wps[k + 1]?.fuelStop) { stretches.push(cur); cur = 0; }
            }
            stretches.push(cur);
            const over = stretches.find((s) => s > maxLeg + EPS_HRS);
            if (over != null) {
                red('fuel-over-limit', [], `${fmtHrs(over)} without a fuel stop (limit ${fmtLimit(maxLeg)})`,
                    [{ label: 'Add fuel stop', apply: 'addFuelStop', arg: {} }]);
            }
        }

        // Reserve at the destination.
        const rem = computed?.summary?.fuelRemGal;
        if (Number.isFinite(rem) && Number.isFinite(settings.reserveGal) && rem < settings.reserveGal) {
            red('below-reserve', [], `Lands with ${rem.toFixed(1)} gal (reserve ${settings.reserveGal})`);
        }

        for (const args of later) amber(...args);

        // Detour vs direct departure -> destination.
        const depIdx = pills.findIndex(isPoint);
        let destPill = -1;
        for (let k = pills.length - 1; k >= 0; k--) if (pills[k].type === 'dest') { destPill = k; break; }
        const total = computed?.summary?.totalDistNm;
        const a = coords.get(depIdx), b = coords.get(destPill);
        if (a && b && Number.isFinite(total)) {
            const direct = directNm(a, b);
            if (direct > 1 && total > direct * DETOUR_AMBER) {
                amber('detour', [], `+${Math.round((total / direct - 1) * 100)}% longer than direct`);
            }
        }

        // Red first (stable within each severity).
        return problems.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'red' ? -1 : 1));
    }

    /** New pills with a pill-changing fix applied (setRouting / addFuelStop: unchanged). */
    function applyFix(pills, fix) {
        const out = pills.map((p) => ({ ...p }));
        const at = fix?.arg?.awyIndex;
        switch (fix?.apply) {
            case 'joinAirwayAt':   // MITVE T437 -> MITVE GREAT T437 (the cleared point is kept)
                out.splice(at, 0, { id: fix.arg.fix, type: 'fix' });
                break;
            case 'exitAirwayAt':   // T437 KAIK -> T437 CAYCE KAIK
                out.splice(at + 1, 0, { id: fix.arg.fix, type: 'fix', airway: fix.arg.airway });
                break;
            case 'goDirect':
                out.splice(at, 1);
                break;
            default:
                break;
        }
        return out;
    }

    return { run, applyFix, _directNm: directNm };
})();
