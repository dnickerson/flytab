# Route Planner redesign: type the clearance, see every setting, never apply a quietly wrong route

**Date:** 2026-10-15 · **Status:** design approved in conversation, spec awaiting review
**Builds on:** branch `fix/route-reverse` (v11.29: REV + UNDO, DEP/DEST commit fix)

## Why

Dana flew KLKR → KAIK on 2026-10-15 and was given a reroute: *join T437 at MITVE, T437 to CAYCE, direct KAIK*. Entering it in the Route Planner went wrong in several ways:

- The pills ended up **KLKR, CAYCE, MITVE, T437, KAIK**. The tablet's state showed the route had been through REV, Plan route or Paste before the Adds. Plain Add in clearance order works; tested in Chromium.
- Nothing flagged it. The only hint was "+82 nm (+107%)" in the stats line.
- **MITVE is not on T437** in FAA NASR (July and October 2026 cycles; T437 runs …SALLY, CAYCE, BEFTY, BLOTS, GREAT, RICHE, ZUKUR…). The nearest T437 fixes to MITVE are GREAT 5.7 nm, RICHE 8.9 nm, ZUKUR 13.2 nm and BLOTS 16.1 nm. The planner accepted `MITVE T437 CAYCE`, and Apply drew a straight line from MITVE to CAYCE labelled T437.
- Paste can't take a T-route at all. `parseRoute` picks its routing mode from the aircraft profile (V-airways by default), not from the planner's Routing setting. With T-routes allowed it correctly rejects the clearance: "Entry fix MITVE not on airway T437".
- Routing and every other setting are behind the Flight Settings popup.
- **Fuel stops never fired when over the limit** (Dana). Confirmed: with a 2 h limit, KLKR → KMDT (2h07m–2h44m with winds) applied with no prompt and no warning, by typing + Apply, by Plan, and by Add + Apply. The check (`_recheckFuelStops`) runs only from the 2h/2.5h/3h buttons and Settings → Plan Route.
  - When it does run, it computes times at `_altitude` (the A* default, 5,500 ft) and possibly before winds have loaded, so it disagrees with Apply, which uses `_cruiseAltFt` and the loaded winds.
  - It labels the stop "Near <the route point before it>", e.g. "Near KLKR" for airports around Frederick, MD.
  - The library's own test is correct: a stop only when the total ETE is strictly greater than `maxLegHrs`.
- Dragging pills was liked but unreliable.

ForeFlight (Dana's reference screenshots in `screenshots/foreflight/`, iPad) shows the patterns we borrow. They are interaction patterns only: FlyTab is portrait Android, so the layout is our own.
- the route as one editable line of bubbles;
- REV and Clear next to it;
- settings visible beside it;
- tap a bubble for actions;
- Recents and Favorites;
- a stats strip.

## Goals

1. Enter or change a route, an ATC reroute especially, in clearance order, in about 20 s, one-handed.
2. A wrong route can't reach the map unnoticed: every problem is shown with its reason and a one-tap fix, and Apply asks before applying a route with a red problem.
3. Every flight setting is visible and one tap away while the planner is open.
4. Fuel stops are checked on every route change, with the same altitude, power and winds as Apply.
5. Airways are drawn along the airway.

**Non-goals (later items):** an aviation shortcut-key row; holds and along-track offsets; MEA checks; correct airway labels after reloading a reversed route; drag-to-reorder.

## Layout (portrait; approved option A)

```
┌──────────────── map (shrinks when the keyboard is up; OK) ───────────────┐
├──────────────────────────────────────────────────────────────────────────┤
│ ROUTE PLANNER                                                        ✕   │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ (KLKR) (MITVE) (T437) (CAYCE) (KAIK) |                               │ │
│ │                                                    [⇄ REV] [Clear]   │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│ ⚠ MITVE is not on T437: tap MITVE or T437 to fix                         │
│ ┌ALTITUDE─────┐ ┌POWER────────┐ ┌ROUTING──────┐                          │
│ │ 3,000 ▾     │ │ 65% LOP ▾   │ │ T-airways ▾ │                          │
│ ┌DEPART───────┐ ┌RESERVE──────┐ ┌FUEL STOP────┐                          │
│ │ Now ▾       │ │ 10 gal ▾    │ │ 2h ▾        │                          │
│ DIST 88 nm · ETE 0h34m · ETA 19:06 · FUEL 5.4 g · WIND 3 hd · +15%       │
│ [Plan route] [Routes] [Save] [⋯] [      Apply      ]                     │
└──────────────────────────────────────────────────────────────────────────┘
```

Mockups: `.superpowers/brainstorm/planner-tokens.png` (local, not committed). Design tokens, light theme, `font-weight` ≥ 700, touch targets `var(--touch-min, 56px)` (CLAUDE.md).

## Components

### 1. Route field (replaces the DEP/DEST boxes, the Add row and the pill list)

A view over the existing pill model, which stays the single source of truth:

`RoutePlannerPanel._route: Array<{ id: string, type: 'dep'|'dest'|'fix'|'airport'|'fuel'|'awy'|'direct', airway?: string, altFt?: number, proc?: true }>`

Apply (`_doApply` → `_pillsToWaypoints` → `app.applyRouteEdit(plan)`), REV, UNDO, saved plans and the route table keep using it unchanged.

- **Bubbles.** One per pill, in `_route` order. Colours: airport blue, fix purple, airway green, fuel stop amber outline. A bubble with a red problem gets a red outline. Compact view (hiding interior airway fixes) stays the default.
- **Typing.**
  - A tap on the field focuses one `<input>`, the **cursor**. A space, Enter or Done commits the typed token.
  - **Where the cursor sits.** By default it is just *before* the destination bubble, so typed fixes land before the destination, which is how reroutes are entered. A tap on the empty space *after* the destination bubble moves it there; a token committed there becomes the new destination, and the old one becomes a fix. The cursor is drawn as a visible gap with a caret, so it is clear where the text goes.
  - **Pasting several tokens** commits them all, through the Paste path below.
  - **Committing a token** inserts a pill at the cursor. Its type comes from the same lookup the Add button uses today (airway `/^[VTJQ]\d/`, else airport → navaid → fix in NASR). An unknown id is still added, marked `unknown`, so the check shows it red. Typing never silently drops anything.
  - **DEP/DEST:** if the route is empty, the first token becomes the dep pill. While the route has only a dep pill, the next token becomes the dest pill. Replacing either is done from its bubble actions ("Make departure" / "Make destination").
- **Paste / whole-route entry** (the ⋯ menu, or pasting into the field) uses `this._planner.parseRoute(str, { routingMode: this._routingMode })`, then `_waypointsToPills`. Today the routing mode isn't passed; that is a bug fix. If parsing fails, the tokens are added one by one and the check shows the problem, instead of today's toast-and-discard.
- **Bubble actions.** A tap opens an action sheet with buttons of `--touch-preferred` height:
  - Direct To · Insert before… · Insert after… · Fuel stop (toggles `type 'fuel'`) · Altitude… · Make departure · Make destination · Remove;
  - for a bubble with a problem, the problem's fixes come first.
  - **Insert before/after** sets `_insertIndex` and focuses the field input; the next committed token goes there, then `_insertIndex` resets to `null`, as today.
- **⇄ REV and Clear** sit inside the field. REV is today's `_onReverseTap` with UNDO. Clear keeps its confirm and its dep/dest-preserving behaviour.
- **Removed:** the DEP/DEST inputs (`_depInput`, `_destInput`, `_wireFieldEdits`, `_commitFieldEdits`, `_syncFieldsFromPills`), the Add row (`_addInput`, `_addSel`, `+ Add`) and pill dragging. The touchend-before-blur problem the commit fix solved disappears with them: the field commits on space/Enter/Done, and every toolbar action first commits any half-typed token (same rule as today's `_commitFieldEdits`).

### 2. Route check (new, pure)

`RouteCheck.run(input) → Problem[]`, a new pure module `web/shared/route-check.js` with no DOM. Tested in vitest against real NASR records.

- **input:**
  - `pills` (`_route`);
  - `waypoints` (from `_pillsToWaypoints`, or the expanded waypoints, see §4);
  - `computed` (the `recomputeLegs` result Apply would use: same `cruiseAltFt` = `_cruiseAltFt`, `pctPower`, `winds` = `_lastWinds`, `departureTime`);
  - `settings` (`{ routingMode, maxLegHrs, reserveGal }`);
  - `aero`, an adapter with `getAirway(name) → { name, waypoints:[{name|id, lat, lon, seq}] }` and the airport/navaid/fix lookups.
- **Problem:** `{ severity: 'red'|'amber', code: string, pillIndex: number|null, message: string, fixes: Array<{ label: string, apply: 'joinAirwayAt'|'exitAirwayAt'|'goDirect'|'addFuelStop'|'setRouting', arg: any }> }`

| code | severity | rule | message (example) | fixes |
|---|---|---|---|---|
| `unknown-id` | red | pill id not found as airport/navaid/fix/airway | "MITVF not found" | none |
| `entry-not-on-airway` | red | the point before an AWY pill is not on that airway | "MITVE is not on T437" | `joinAirwayAt` the 3 airway fixes nearest that point (name + nm); `goDirect` |
| `exit-not-on-airway` | red | the point after an AWY pill (dest included) is not on that airway | "T437 needs an exit fix before KAIK" | `exitAirwayAt` the 3 airway fixes nearest the next point; `goDirect` |
| `fuel-over-limit` | red | a stretch between fuel stops has ETE > `maxLegHrs` (strictly greater, wind-corrected, from `computed.legs`) | "2h44m without a fuel stop (limit 2h)" | `addFuelStop` (opens the picker, §3) |
| `below-reserve` | red | fuel at the destination < `reserveGal` (from `computed.summary`) | "Lands with 6.2 gal (reserve 10)" | none |
| `detour` | amber | route distance > 125% of direct dep→dest | "+107% longer than direct" | none |
| `airway-type` | amber | an airway's type isn't allowed by `routingMode` (V vs T) | "T437 is a T-route (Routing: V-airways)" | `setRouting` |

- **What each fix does to the pills:**
  - **`joinAirwayAt X`** inserts `X` between the off-airway point and the AWY pill. The point is kept, as the clearance named it: `MITVE T437` → `MITVE GREAT T437`.
  - **`exitAirwayAt X`** inserts `X` between the AWY pill and the next point: `T437 KAIK` → `T437 CAYCE KAIK`.
  - **`goDirect`** removes the AWY pill.
  - **`addFuelStop`** opens the picker (§3).
  - **`setRouting`** sets `_routingMode` and saves it.
  - Each fix re-runs the check.
- **When it runs** (trigger conditions): ~300 ms after any of
  - a token commit;
  - a bubble action;
  - REV / UNDO;
  - a settings change;
  - a route loaded from Routes;
  - `open(plan)`;
  - a fuel stop added or removed.

  Not on each keystroke inside an uncommitted token.
- **State:** `_problems` (last result) and `_checkEpoch` (incremented per run; a result whose epoch is stale is dropped). `_problems` is replaced on every run and is never applied to the map.
- **Display.** The problem line shows the first red problem (else the first amber), and "+N more" opens the full list. The bubble at `pillIndex` gets the red/amber outline. Tapping the problem line or the bubble opens that bubble's action sheet with its fixes first.
- **Apply with red problems** shows a confirm: "Route has N problem(s): <first message>. Apply anyway?" [Apply anyway] [Fix it]. Amber never blocks.
- **NASR not loaded:** the problem line reads "Checks waiting for navigation data", and Apply is allowed without a confirm. This is today's behaviour; we don't block on missing data.

### 3. Fuel stops

- The check is the `fuel-over-limit` rule above. It runs on every route change, not only from the 2h/2.5h/3h buttons and Plan route.
- **`addFuelStop`** calls `this._planner.insertFuelStops(computed)` with the *same* `computed` the check used (fixing the altitude and winds mismatch), then shows the existing picker for each candidate.
- **Picker heading:** "Fuel stop near <the airport nearest the stop point>, at <h:mm> (<nm> nm along route)" instead of "Near <afterFixId>". The library keeps its 85%-of-leg cap on where to search.
- The 2h/2.5h/3h choice becomes the **FUEL STOP** box in the settings grid. Changing it re-runs the check; it does not open the picker by itself.
- Plan route keeps offering stops right after planning, as today.

### 4. Airways drawn along the airway

At Apply, each `entry AWY exit` triple whose entry and exit are both on the airway is expanded into the airway's fixes between them, using the `seq` order from `getAirway`. The expanded fixes are inserted as `fix` pills tagged `airway`. This is the same output `parseRoute` gives Paste today, so the route table, the map line, legs and ETE follow the airway. Compact view keeps the field showing entry · airway · exit. A triple with a red airway problem is left unexpanded: straight, as today, and flagged.

### 5. Settings grid (replaces the Flight Settings popup)

Six labelled boxes, two rows of three, each a native `<select>` (Android shows a full-screen list with large rows):

| Box | Field | Values |
|---|---|---|
| ALTITUDE | `_cruiseAltFt` (null = Auto) | today's `_altSel` options |
| POWER | `_pctPower` | 55–75% LOP |
| ROUTING | `_routingMode` | V-airways, T-airways, Any airway, GPS Direct, VORs Direct |
| DEPART | `_departureTime` | Now, then today's `_depTimeSel` choices |
| RESERVE | `_reserveGal` | 5–20 gal in 1 gal steps (today a free number input; same field) |
| FUEL STOP | `_maxLegHrs` | 2h, 2.5h, 3h |

Each change calls `_saveOpts()` (same localStorage key and shape as today), re-runs the winds/stats as the popup's Done did, and re-runs the check. **Terminal areas** (`_terminalRouting`) moves to ⋯. **Plan route** becomes a toolbar button.

### 6. Routes (replaces "Plans")

A sheet with two tabs, built on the existing trip store (`TripStore`, IndexedDB `flypi-flights` / `trips`, keyPath `id`; `_doApply` already auto-saves every applied trip there).

- **Recents:** `TripStore.list()`, newest first, at most 20 rows. Each row reads "KLKR → KAIK via CAYCE · 88 nm · 3,000′"; a tap loads it with `open(trip)`.
- **Favorites:** trips with `favorite: true`, a new optional field on the trip record (no migration; absent = false). A star on each row toggles it (`TripStore.get` → set → `TripStore.save`).
- PlanSync's cloud tab stays reachable from ⋯ → "Cloud plans".

### 7. Toolbar

`[Plan route] [Routes] [Save] [⋯] [Apply]`. ⋯ contains Paste route, Copy route, Compact view, Terminal areas, Cloud plans.

## What does not change

The route table, the map, Direct-To from airport popups, approach loading (`insertApproach`), REV/UNDO on the route strip, `app.applyRouteEdit`, saved-plan storage (only an optional `favorite` field is added), and every `flypi_*` key.

## Testing

- **vitest, `RouteCheck`,** with fixtures cut from the real October NASR bundle (T437 with coords, MITVE, GREAT, CAYCE, KAIK, KLKR, KMDT):
  - each rule, positive and negative;
  - the reroute `KLKR MITVE T437 CAYCE KAIK` → `entry-not-on-airway` with GREAT/RICHE/ZUKUR, plus `exit-not-on-airway`;
  - `KLKR GREAT T437 CAYCE KAIK` → no red;
  - fuel limit at exactly / just over / under;
  - `below-reserve`;
  - detour at 124% / 126%.
- **vitest, panel:**
  - token commit and placement;
  - Insert before/after;
  - first/last token become dep/dest;
  - an unknown id is kept;
  - Apply with red problems asks, and amber doesn't;
  - airway expansion at Apply;
  - Paste passes `routingMode`;
  - the settings grid writes the same fields and `_saveOpts` shape;
  - the fuel check uses Apply's `computed`.
- **Chromium end-to-end with touch,** real NASR, portrait 1250×2000:
  - Dana's reroute: shows the red problem; one tap "Join T437 at GREAT"; Apply; the route table follows T437 through GREAT, BLOTS, BEFTY, CAYCE;
  - KLKR → KMDT at a 2 h limit shows `fuel-over-limit`; Add fuel stop; pick; Apply;
  - REV/UNDO still work.
- **On the tablet with Dana:** typing with the Android keyboard (and Gboard's IME behaviour), the settings pickers, the airport-tap check (CLAUDE.md), and sunlight readability.
- The user manual's Route Planning section is rewritten in the same commit as the feature (CLAUDE.md).

## Open choices (defaults chosen; change at spec review)

- Detour amber threshold: 25% over direct.
- Nearest-fix suggestions: 3 per problem.
- Recents: 20 trips.
- An unknown id is kept as a red bubble rather than refused at entry.
