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
     * Index of the waypoint the route planner marked as the destination (isDest,
     * from its DEST pill — missed-approach fixes may follow it), or -1 when there
     * is none or it is stale (an airport was later moved after it). Callers then
     * apply their own fallback. Shared by RouteTable and RoutePlannerPanel; the
     * planning library keeps its own copy (destinationIndex) because it must not
     * depend on this script.
     */
    function markedDestIndex(wps) {
        if (!wps) return -1;
        for (let i = wps.length - 1; i > 0; i--) {
            if (!wps[i].isDest) continue;
            return wps.slice(i + 1).some(w => w.type === 'APT') ? -1 : i;
        }
        return -1;
    }

    /** The marked destination, else the last APT-typed waypoint, else the last. */
    function findDestIndex(wps) {
        if (!wps || !wps.length) return -1;
        const marked = markedDestIndex(wps);
        if (marked >= 0) return marked;
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
        _destIndex = findDestIndex(plan?.waypoints);
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

    return { setPlan, advance, setIndex, getPlan, getIndex, getDestIndex, getWaypoints, getActiveWp, getDestWp, markedDestIndex, findDestIndex };
})();
