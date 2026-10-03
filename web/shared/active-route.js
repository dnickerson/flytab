/**
 * FlyTab — ActiveRoute
 * Single source of truth for the active flight plan and current waypoint index.
 *
 * Problem solved: InstrumentStrip and RouteTable each tracked their own
 * _activeWpIndex / _activeIndex independently and advanced on different triggers
 * (1nm proximity only in InstrumentStrip; proximity + bearing in RouteTable).
 * They would drift out of sync mid-flight, causing NEXT/DIST/ETE to show
 * different waypoints in different parts of the UI.
 *
 * Solution: both components call ActiveRoute.advance() instead of incrementing
 * their own index. ActiveRoute emits 'activeroute:advance' so every subscriber
 * stays in lockstep.
 *
 * Events dispatched on window:
 *   activeroute:plan     { detail: { plan, index } }   — new plan loaded
 *   activeroute:advance  { detail: { index, waypoint } } — waypoint advanced
 */

const ActiveRoute = (() => {
    let _plan = null;       // normalized plan object (has .waypoints[])
    let _index = 0;         // active waypoint index
    let _destIndex = -1;    // index of destination airport waypoint

    // ── Internal helpers ────────────────────────────────────────────────────

    /**
     * Index of the last waypoint before a trailing run of missed-approach fixes
     * (isMissed, set when the route planner loads an approach), or -1 when the
     * route does not end in one — callers then apply their own fallback.
     * Shared by RouteTable and RoutePlannerPanel; the planning library keeps its
     * own copy (destinationIndex) because it must not depend on this script.
     */
    function arrivalIndex(wps) {
        if (!wps || wps.length < 2) return -1;
        let i = wps.length - 1;
        while (i > 0 && wps[i].isMissed) i--;
        return i < wps.length - 1 ? i : -1;
    }

    function _findDestIndex(wps) {
        if (!wps || !wps.length) return -1;
        const arr = arrivalIndex(wps);
        if (arr >= 0) return arr;
        // Otherwise the last waypoint typed APT is the destination; MAP fixes come after it.
        for (let i = wps.length - 1; i >= 0; i--) {
            if (wps[i].type === 'APT') return i;
        }
        return wps.length - 1;
    }

    function _emit(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Load a new plan. Resets index to 1 (first en-route waypoint).
     * Called by app._applyPlan() after normalisation.
     */
    function setPlan(plan) {
        _plan = plan;
        // Index 0 is the departure airport — pilot starts there, so NEXT = WP[1].
        _index = plan?.waypoints?.length > 1 ? 1 : 0;
        _destIndex = _findDestIndex(plan?.waypoints);
        _emit('activeroute:plan', { plan: _plan, index: _index });
    }

    /**
     * Advance to the next waypoint. No-op if already at the end.
     * Called by InstrumentStrip or RouteTable when the aircraft passes a WP.
     */
    function advance() {
        if (!_plan || _index >= _plan.waypoints.length - 1) return;
        _index++;
        _emit('activeroute:advance', { index: _index, waypoint: _plan.waypoints[_index] });
    }

    /**
     * Explicitly set the index (e.g. pilot taps a waypoint row to jump ahead).
     */
    function setIndex(i) {
        if (!_plan) return;
        const clamped = Math.max(0, Math.min(i, _plan.waypoints.length - 1));
        if (clamped === _index) return;
        _index = clamped;
        _emit('activeroute:advance', { index: _index, waypoint: _plan.waypoints[_index] });
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    function getPlan()      { return _plan; }
    function getIndex()     { return _index; }
    function getDestIndex() { return _destIndex; }
    function getWaypoints() { return _plan?.waypoints || []; }
    function getActiveWp()  { return _plan?.waypoints[_index] || null; }
    function getDestWp()    { return _destIndex >= 0 ? _plan?.waypoints[_destIndex] : null; }

    return { setPlan, advance, setIndex, getPlan, getIndex, getDestIndex, getWaypoints, getActiveWp, getDestWp, arrivalIndex };
})();
