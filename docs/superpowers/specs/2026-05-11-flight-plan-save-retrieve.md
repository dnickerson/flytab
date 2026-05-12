# Flight Plan Save & Retrieve — Design Spec

**Date:** 2026-05-11  
**Status:** Approved for implementation

---

## Problem

The FAA does not allow a single IFR flight plan to cover two segments separated by a fuel stop. The pilot plans one route (e.g., KLUK → KBOS), the route planner inserts a fuel stop (e.g., KERI), and two separate IFR flight plans must be filed — one per leg. The app currently has no way to save a full trip with its two computed legs, retrieve it later, or surface the per-leg FAA route strings in the CLR (clearance) page.

---

## Goals

1. Save a full trip (one or two legs) with computed performance data as a snapshot.
2. Retrieve saved trips from both inside the route planner and the existing More drawer.
3. For two-leg trips, enable the pilot to copy a per-leg FAA field-15 route string and view it pre-filled on the CLR page.
4. Auto-select the correct leg on the CLR page based on GPS position, with a manual override toggle.

---

## Data Model

A trip is stored as one IDB record. Single-leg trips (no fuel stop) and two-leg trips (fuel stop) use the same shape — `legs[]` always has 1 or 2 entries.

```javascript
{
  id: string,           // crypto.randomUUID()
  name: string,         // "KLUK → KBOS · May 11" — auto-generated, pilot-renameable
  dep: string,          // "KLUK"
  dest: string,         // "KBOS"
  created_at: ISO,
  updated_at: ISO,
  legs: [
    {
      dep: string,      // e.g. "KLUK"
      dest: string,     // e.g. "KERI" (fuel stop) or "KBOS" (final)
      flight_plan: {
        departure: string,
        destination: string,
        route: string,          // FAA field-15 route string, pre-computed at save time
        altitude: number,       // cruise altitude in feet
        legs: [                 // recomputeLegs() output — CLB/CRZ/DES segments
          { from, to, distNm, altFt, tasKt, gsKt, windDir, windSpd,
            timeHrs, fuelGal, fuelRemGal, eta, airway, segments: [] }
        ],
      },
      waypoints: [              // resolved waypoints with lat/lon stamped
        { icao, name, lat, lon, elev_ft, altFt, type, ... }
      ],
      // weather_cache intentionally excluded — stale after a day; replan fetches fresh
    },
    // leg 2 if fuel stop present (same shape)
  ]
}
```

**Field-15 route string** is computed by `_buildField15String()` (already in `route-planner-panel.js`) at save time and stored in `leg.flight_plan.route`. This avoids recomputation at read time and keeps the saved snapshot self-contained for filing.

---

## Storage Layer — `TripStore`

**New file:** `web/shared/trip-store.js`  
**Loaded:** as a `<script>` tag in `index.html` after existing shared scripts.

Opens the existing `flypi-flights` IDB. Bumps the IDB version number (additive upgrade — existing `flypi_logbook` and NASR stores are untouched). Adds a `trips` object store keyed by `id` with a `created_at` index for ordered listing.

```javascript
// Public API — all methods return Promises
TripStore.save(trip)        // upsert by trip.id; sets updated_at; returns trip
TripStore.list()            // returns all trips ordered by created_at DESC
TripStore.get(id)           // returns one trip or null
TripStore.delete(id)        // removes trip by id
TripStore.rename(id, name)  // updates name + updated_at only
```

`TripStore` is a plain singleton (not a class), self-initializes on first call, and queues all operations until the IDB `onupgradeneeded` / `onsuccess` callback resolves. This matches the pattern used by `NasrDb`.

---

## Route Planner Panel Changes

### Save trigger 1 — toolbar "Save" button

A **Save** button is added to the planner toolbar (alongside Plan Route / Apply). It is enabled only when `this._lastPlan` exists (i.e., a route has been computed).

Tapping Save calls `_saveCurrentTrip()`.

### Save trigger 2 — auto-save on Apply

`_saveCurrentTrip()` is called inside the existing `_onApplyTap()` flow, after the plan is validated and before `app.applyRouteEdit()` is called. This means every applied plan is automatically saved.

### `_saveCurrentTrip()`

```
1. Read this._lastPlan (the computed plan in memory).
2. Split waypoints at any waypoint where fuelStop === true → legs[].
   If no fuel stop: legs = [{ dep, dest, flight_plan, waypoints }].
   If fuel stop at index i: legs = [leg_0_to_i, leg_i_to_end].
3. For each leg, call _buildField15String(legWaypoints) to compute route string.
4. Build trip record with auto-name "${dep} → ${dest} · ${monthDay}".
   If a trip with the same dep+dest already exists today, update it (upsert by id)
   rather than creating a duplicate.
5. Call TripStore.save(trip).
6. Show brief in-panel toast: "Plan saved."
```

### Load from the planner toolbar

A **Plans** button in the planner toolbar opens the same `PlanSync` overlay (described below) directly to the **Device** tab. This avoids building a separate picker UI inside the planner.

### Rename

Long-press on a saved trip in the Device tab → inline text field → `TripStore.rename(id, newName)`.

---

## `PlanSync` Changes

`PlanSync` currently shows one list of flywhere.app plans. It gains a **tab bar** at the top: `CLOUD` (existing behavior) and `DEVICE` (new).

### Device tab

- Calls `TripStore.list()` on open, renders trips newest-first.
- Each row: trip name, `DEP → DEST`, date, and a "2 legs" badge if `trip.legs.length > 1`.
- **On tap (single-leg trip):** shows a bottom sheet with **Load as-is** | **Replan with current winds** | **Cancel**. Both load options call `app.applyRouteEdit({ waypoints: leg.waypoints, flight_plan: leg.flight_plan })`. "Replan" additionally triggers `routePlannerPanel._onPlanRouteTap()` after loading.
- **On tap (two-leg trip):** shows a bottom sheet:
  - **Load Leg 1** (`${leg1.dep} → ${leg1.dest}`)
  - **Load Leg 2** (`${leg2.dep} → ${leg2.dest}`)
  - **Cancel**
  - Selecting a leg calls `app.applyRouteEdit({ waypoints: leg.waypoints, flight_plan: leg.flight_plan })`.
  - A secondary "Replan with current winds" option is available after leg selection (same flow as single-leg).
- **Long-press:** shows rename / delete options.

### "Save Plan" in More drawer

A **Save Plan** item is added to the More drawer immediately above the existing **Load Plan** item. Tapping it calls `app.saveCurrentPlan()`:

```
app.saveCurrentPlan():
  if routePlannerPanel._lastPlan is set:
    → delegate to routePlannerPanel._saveCurrentTrip()
  else if _currentTrip is set:
    → build trip record directly from _currentTrip (same split-at-fuelStop logic)
    → call TripStore.save(trip)
  else:
    → show toast "No plan to save"
```

This handles the common case where the pilot loads a plan from the Cloud tab and wants to pin it to Device storage without reopening the planner.

---

## CLR Page Changes

### New state

```javascript
this._activeLegIdx = 0;   // 0 = leg 1, 1 = leg 2
// this._flightPlan now holds the full trip object (all legs), not just one plan
```

### Leg toggle UI

When the active trip has `legs.length > 1`, a **Leg 1 | Leg 2** segmented toggle is shown in the CLR header (between the DEP/APCH tabs and the close button). Hidden for single-leg trips.

### Auto-selection on `show()`

`show()` gains an optional third parameter: `show(flightPlan, departureAirport, currentPos)` where `currentPos = { lat, lon }`. The caller in `tab-bar.js` passes `c.stratuxClient?.situation` (which has `{ lat, lon }` or is null when GPS is not available).

```
1. If trip has only 1 leg → _activeLegIdx = 0, no toggle shown.
2. If trip has 2 legs:
   a. currentPos = show()'s third argument (app.stratuxClient?.situation).
   b. If currentPos is null or GPS fix quality < 1 → default to leg 1 (_activeLegIdx = 0).
   c. Compute distance from currentPos to leg1.dest airport lat/lon
      (leg1.dest airport coords stored in leg1.waypoints, last entry).
   d. If distance ≤ 5 nm → _activeLegIdx = 1 (pilot is at the fuel stop, leg 2 next).
   e. Else → _activeLegIdx = 0.
   f. Pilot can override with the toggle at any time.
```

If GPS is unavailable, default to leg 1.

### `_getActiveLeg()`

```javascript
_getActiveLeg() {
    const fp = this._flightPlan;
    if (!fp) return null;
    if (fp.legs) return fp.legs[this._activeLegIdx] || fp.legs[0]; // trip object
    return fp; // legacy single-plan object — unchanged behavior
}
```

### `_prefillDep()` change

Reads from `this._getActiveLeg()` instead of `this._flightPlan` directly:
- **C** (clearance limit): `leg.dest`
- **R** (route): `leg.flight_plan.route` (the pre-computed field-15 string)
- **A** (altitude): `leg.flight_plan.altitude`

"AS FILED" button (`_fillAsFiledRoute`) reads `leg.flight_plan.route` from the active leg.

### `app.js` change

In `_applyPlan()`, when setting `ifrClearance._flightPlan`, pass the full trip object (if it came from a `TripStore` load) rather than the single normalized plan. The CLR page's `_getActiveLeg()` handles both shapes — legacy single-plan objects continue to work unchanged.

---

## File Changelist

| File | Change |
|------|--------|
| `web/shared/trip-store.js` | **New** — IDB trip store singleton |
| `web/index.html` | Add `<script>` for `trip-store.js`; bump IDB version if needed |
| `web/cockpit/route-planner-panel.js` | Add Save button to toolbar; add `_saveCurrentTrip()`; call it on Apply; add Plans button that opens PlanSync Device tab |
| `web/cockpit/plan-sync.js` | Add CLOUD/DEVICE tab bar; render Device tab from `TripStore`; two-leg bottom sheet picker |
| `web/cockpit/tab-bar.js` | Add "Save Plan" item to More drawer above "Load Plan" |
| `web/cockpit/ifr-clearance.js` | Add `_activeLegIdx` state; leg toggle UI; `_getActiveLeg()`; auto-select by GPS; update `_prefillDep()` and `_fillAsFiledRoute()` |
| `web/app.js` | Add `saveCurrentPlan()` method; pass full trip to `ifrClearance._flightPlan` on plan load |
| `web/style.css` | Styles for Device tab, two-leg badge, leg toggle in CLR header |

---

## Out of Scope

- Cloud sync of device-saved trips to flywhere.app (future phase)
- Direct FAA IFR filing integration (user files manually via phone/DUATS)
- More than two legs (FAA allows only one fuel stop on a single IFR flight plan pair)
