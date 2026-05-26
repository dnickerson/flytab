# Add-Via-Waypoint Design

**Date:** 2026-05-26  
**Feature:** Tap-to-add via waypoint with full end-to-end A* re-route  
**Contexts:** Cockpit route table (in-flight) + ground planning panel (pre-flight)

---

## Problem

The existing `addWaypointSmart()` splices a new waypoint into the route using minimum-detour geometry but does not re-run A*. The surrounding airway segments are unchanged. Pilots who want to route through a specific fix get a direct leg to/from it instead of proper airway routing.

---

## Goal

When a pilot taps a fix on the map and confirms "Add to Route," the entire route re-plans end-to-end via A* with all previously-added intermediate waypoints and the new fix treated as hard pins. The result is airway-optimal routing through all required points.

---

## Section 1: Planning Library — `planVia()`

### New method on `RoutePlanner` (`web/shared/planning/planner/route-planner.js`)

```javascript
async planVia(pins, opts = {})
```

**Parameters:**
- `pins`: `Array<{id: string, lat: number, lon: number}>` — ordered list of required waypoints. First element is departure, last is destination, intermediates are via fixes. All must be pre-resolved (caller provides lat/lon); no adapter airport lookup required.
- `opts`: same shape as `plan()` — `routingMode`, `cruiseAltFt`, `reserveGal`, `maxLegHrs`, `winds`, `avoidance`, `selfServeOnly`.

**Algorithm:**

For each consecutive pin pair `[A, B]`:
1. Load graph for `opts.routingMode` (cached across calls).
2. Fan-out: call `graph.nearestFixes(A.lat, A.lon, 60, 5)` and `graph.nearestFixes(B.lat, B.lon, 60, 5)`, add temporary direct edges for each candidate using `graph.addDirectEdge()`.
3. Run `_aStar(graph, A.id, B.id, penaltyFn, exclusions)` — same penalty/exclusion logic as `plan()`.
4. Collect sub-path (array of `{id, airway}`).
5. Call `graph.clearDirectEdges()`.

After all pairs, concatenate sub-paths — remove the duplicated junction waypoint at each seam (last node of segment N equals first node of segment N+1).

Resolve coordinates for all nodes in the merged path from `graph.coords`, build the `waypoints` array, then call:
- `recomputeLegs(mergedPlan, profile, { winds: opts.winds })` 
- `_insertFuelStops(computed, profile)`

**Return value:** A `FlightPlan` structurally identical to `plan()` output — `waypoints`, `legs`, `summary`, `fuelStopCandidates`. All downstream consumers work unchanged.

**Why non-airports work:** Caller passes pre-resolved `{id, lat, lon}` — no `getAirport()` call needed. VORs, named fixes, and GPS points all work.

**Fallback:** If any sub-segment A* returns null, throw `DestinationUnreachableError` identifying the failing pin pair (e.g., `"No route from CLT to GANTS"`). Caller handles this without mutating the existing plan.

### Testing

Each sub-segment A* call is independently testable. The merge/dedup logic is pure array manipulation. Add unit tests in `tests/` covering:
- Two-pin case (equivalent to `plan()`)
- Three-pin case with airway junction at intermediate fix
- Sub-segment returning null → error thrown, other segments not affected

---

## Section 2: Map Tap Interaction

### Cockpit (in-flight)

Existing airport/navaid/fix tap popups already work. When a route is active in `route-table.js`, the tap popup gains an **"Add to Route"** button appended at the bottom. No existing popup content changes.

The button is only rendered when `app.hasActiveRoute()` returns true.

### Ground Planning Panel

`app.js` currently guards all three tap handlers with:
```javascript
if (this.routeEditor?.isVisible()) return;
```

This guard is modified (not removed) to intercept when a plan exists:
```javascript
if (this.routeEditor?.isVisible()) {
    if (this._currentPlan) this._offerAddViaWaypoint(fix);
    return;
}
```

Normal info popups still never open during ground planning. The only new behavior is the add-via confirmation when a plan exists.

### Confirmation Popup

A compact overlay anchored near the tapped fix on the map (not a full-screen modal):

- **Header:** "Add [FIX_ID] to route?"
- **Subtext:** "Between CIBOB and GSO" — derived from minimum-detour insertion position
- **Two full-width buttons** sized for fat-finger use: **Cancel** | **Add**
- Auto-dismisses on map pan or tap outside

### Insertion Position

The minimum-detour formula from `addWaypointSmart()` is reused to determine which consecutive pin pair to insert the new fix between:

```
detour(i) = dist(pin[i] → fix) + dist(fix → pin[i+1]) - dist(pin[i] → pin[i+1])
```

The index with minimum detour is the insertion point. The confirmation popup subtext names `pin[i]` and `pin[i+1]`.

---

## Section 3: Route Table / Planner Panel Integration

### Shared Orchestrator — `app.js`

```javascript
async _addViaAndReplan(fix) {
    const currentPins = this._getCurrentPins();
    const insertIdx   = this._minDetourIdx(currentPins, fix);
    const newPins     = [...currentPins];
    newPins.splice(insertIdx, 0, fix);

    let plan;
    try {
        plan = await this._planner.planVia(newPins, this._currentPlanOpts());
    } catch (e) {
        this._toast(`No airway path through ${fix.id} — try a different fix`);
        return;   // existing plan unchanged
    }

    this.routeTable.loadPlan(plan);
    this.routeEditor?._applyPlan(plan);
    this._updateMapRoute(plan);
    this._toast(`${fix.id} added — route updated`);
}
```

### `_getCurrentPins()`

Extracts only explicitly-pinned waypoints from the active plan — departure, destination, and any intermediate fixes the pilot added. Interior A* airway hops are excluded.

**Pin identification rule:** A waypoint is a pilot-added pin if it is in `_pinnedIds: Set<string>` maintained on the app instance.

`_pinnedIds` is populated from two sources:
1. **Route-planner-panel:** When a plan is applied via `_applyPlan()`, the panel passes its explicit waypoint list (the pills the pilot typed or selected) alongside the computed FlightPlan. These IDs are written into `_pinnedIds` at load time. Interior A* hops between those pills are not included.
2. **Map tap:** Every `_addViaAndReplan()` call adds the new fix ID to `_pinnedIds` before calling `planVia()`.

Departure and destination are always treated as pins regardless of `_pinnedIds`.

### `_currentPlanOpts()`

Forwards `winds`, `cruiseAltFt`, `routingMode`, and `avoidance` from the current active plan options so the re-route is consistent with existing plan parameters.

### Loading State

Both `route-table.js` and the ground planning panel show a spinner/overlay on the route display from the moment the pilot taps "Add" until `planVia()` resolves (~50–200 ms for 2–4 sub-segments on a typical route). The map route overlay is not cleared during this window — the old route remains visible until the new one is ready.

### After `planVia()` resolves

- `routeTable.loadPlan(plan)` — cockpit table re-renders
- `routeEditor?._applyPlan(plan)` — ground panel re-renders if open
- `_updateMapRoute(plan)` — route polyline on map redraws
- Toast: "`[FIX_ID]` added — route updated"

### Failure Path

If `planVia()` throws `DestinationUnreachableError`:
- Toast: "No airway path through [FIX_ID] — try a different fix"
- Existing plan and `_pinnedIds` unchanged
- No UI update

---

## Files Changed

| File | Change |
|------|--------|
| `web/shared/planning/planner/route-planner.js` | Add `planVia()` method (~80 lines) |
| `web/app.js` | Add `_addViaAndReplan()`, `_getCurrentPins()`, `_currentPlanOpts()`, `_offerAddViaWaypoint()`; modify 3 tap-handler guards |
| `web/cockpit/route-table.js` | Add "Add to Route" button to tap popups when route active |
| `web/cockpit/route-planner-panel.js` | Add `_applyPlan()` method; show spinner during re-plan |
| `tests/planning/` | Unit tests for `planVia()` — 2-pin, 3-pin, and failure cases |

---

## Out of Scope

- Removing a via waypoint (separate feature — requires identifying which waypoints are pins and re-planning without the removed one)
- Drag-to-move a waypoint on the map
- Changing the insertion position manually (pilot sees computed position in confirmation; no picker)
