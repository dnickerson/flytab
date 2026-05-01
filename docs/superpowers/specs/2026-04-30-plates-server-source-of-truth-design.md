# Spec: Approach Plates — Server as Source of Truth

**Date:** 2026-04-30  
**File affected:** `web/cockpit/data-status.js`

---

## Problem

The Data & Maps page does not detect when the home server has approach plate states that aren't on the tablet. When new states are added to the pipeline, the tablet shows a green CURRENT badge and "Sync All Outdated" stays disabled — because the comparison is driven by `configuredStates` (a static list from the tablet's local `cockpit-config.json`), not by what the server actually has.

**Root cause:** Two functions both read `CockpitConfig.raw?.plateStates` as the reference for what should be on the device. When the pipeline produces more states than that list, those states are invisible to the comparison.

- `_render()` line ~355: `configuredStates.every(s => syncedStates.includes(s))`
- `_syncAll()` line ~1390: `statesToSync = statesResp.filter(s => configuredStates.includes(s.state))`
- `needsSync` calculation line ~397: same `configuredStates` filter

---

## Solution: Server States as Source of Truth

The home server's `plates_cycle_info.json` → `state_sizes` is already fetched on every refresh as `sPlates.states`. Use that list — not the tablet's local config — as the reference for what should be on the device.

**Mental model:** whatever the pipeline built on the home server is what belongs on the tablet. If you don't want a state, don't build it.

---

## Changes

### `_render()` — plates section (~lines 309–365)

Replace the `configuredStates` variable with `serverStates` derived from `sPlates.states`:

```
serverStates = (sPlates?.states || []).map(s => s.state)
```

- **State chips:** render all `serverStates`, marking each as on-device (✓ green) or missing (○ gray). States in `syncedStates` but no longer on the server get a dimmed "(removed from server)" note.
- **allSynced:** `serverStates.every(s => syncedStates.includes(s))`
- **Server line:** `${serverStates.length} states available` (drop the `N/M configured` framing)
- **Badge logic:** unchanged — UPDATE AVAILABLE if !allSynced or cycle mismatch; CURRENT otherwise.

### `_syncAll()` — plates section (~lines 1388–1450)

Remove `configuredStates` filter:

```
statesToSync = statesResp   // all server states, no filter
allStatesSynced = statesResp.every(s => syncedStates.includes(s.state))
```

Skip message becomes: `No plate states available on server` (no longer references configured states).

### `needsSync` calculation (~line 397)

Replace:
```
(plateSCode && (!cycleOkForStates || !configuredStates.every(s => syncedStates.includes(s))))
```
With:
```
(plateSCode && (!cycleOkForStates || serverStates.some(s => !syncedStates.includes(s))))
```

---

## Behavior After Fix

| Scenario | Before | After |
|---|---|---|
| Server adds FL, pipeline had NC/SC/VA | CURRENT (FL invisible) | UPDATE AVAILABLE — FL shows as ○ missing |
| All server states on device, cycle current | CURRENT | CURRENT (unchanged) |
| Cycle rolls, some states outdated | UPDATE AVAILABLE | UPDATE AVAILABLE (unchanged) |
| State removed from pipeline | shown as missing | shown dimmed as "(removed from server)" |

---

## Out of Scope

- No change to how NASR, CIFP, terrain, or MBTiles work — their probes already use the server directly.
- `CockpitConfig.raw?.plateStates` can remain in the config file; it simply stops being the comparison reference for this page. It is not referenced anywhere else in the codebase (verify before removing).
