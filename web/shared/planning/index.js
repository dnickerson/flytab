// @ts-check
'use strict';

// Augment window type to include FlyTabPlanning (JSDoc limitation)
if (typeof window !== 'undefined') {
    // @ts-ignore
    window.FlyTabPlanning = {};  // eslint-disable-line no-undef
}

export { RoutePlanner } from './planner/route-planner.js';
export { Optimizer }    from './planner/optimizer.js';
export { AirwayGraph }  from './planner/airway-graph.js';
export { parseRouteString } from './planner/parser.js';
export {
    PlanError, NoRouteFoundError, DestinationUnreachableError, TimeoutError,
} from './planner/route-planner-errors.js';
export {
    UnknownWaypointError, UnknownAirwayError, AmbiguousIdentifierError, RoutingModeViolationError,
} from './planner/parser.js';
export { buildAvoidancePenalty, segmentIntersectsPolygon } from './planner/avoidance.js';
export { haversine, bearing, intermediatePoint, crossTrackDistanceNm, formatTime, windCorrectedMagHdg, iasToTas, groundSpeed, vfrAltitude } from './math/route-math.js';
export { tasAtAltitude, gphAtPower, climbRateAtAltitude, maxPowerAtAltitude } from './math/engine-data.js';
export { decomposeLeg } from './math/fuel-phases.js';
export { fetchWinds, getWindAtAlt, findNearestFdStation, selectFdCycle } from './planner/winds-interpolator.js';

export const VERSION = '0.1.0';

if (typeof window !== 'undefined') {
    Promise.all([
        import('./planner/route-planner.js'),
        import('./planner/optimizer.js'),
        import('./planner/airway-graph.js'),
        import('./planner/parser.js'),
        import('./planner/route-planner-errors.js'),
        import('./planner/avoidance.js'),
        import('./math/route-math.js'),
        import('./math/engine-data.js'),
        import('./math/fuel-phases.js'),
    ]).then(([rp, op, ag, ps, errs, av, rm, ed, fp]) => {
        // @ts-ignore - augment window
        window.FlyTabPlanning = {
            VERSION,
            RoutePlanner: rp.RoutePlanner,
            Optimizer:    op.Optimizer,
            AirwayGraph:  ag.AirwayGraph,
            parseRouteString: ps.parseRouteString,
            ...errs, ...av, ...rm, ...ed, ...fp,
        };
        document.dispatchEvent(new CustomEvent('flytab-planning:ready'));
    });
}
