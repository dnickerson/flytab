# Replacing the current Route Planner with the new one (preview → main)

Date: 2026-10-16. Branch: `feat/route-planner-redesign` (stacked on `fix/route-reverse` → `perf/map-load`, PR #174).
Status: **approved direction — nothing switched yet.**

**Decisions (Dana, 2026-10-16):**
- All four gap features are required before the switch: altitude comparison table (+MOS), MEA check (amber route
  check), avoid-list editing (Avoid in a bubble's sheet), terminal T-route wizard.
- Order: Dana tests v11.47 on the tablet first; then land the PR stack (step 0) and start steps 1-2.

## Where things stand

- The new planner (`RoutePlannerV2`, `web/cockpit/route-planner-v2.js`, MORE → *Route Planner (preview)*) has had two
  critical reviews (four reviewers each); all reproduced findings are fixed (commits `e1d0003`, `9eeb085`). Suite:
  1847/1847. Desktop end-to-end runs pass (plan, fuel stops, Apply, departure tomorrow with that period's winds).
- **Not yet done:** testing of v11.44–v11.47 on the tablet (nothing since v11.43 has been tried there).
- The new planner is a subclass of the current one and **depends on it**: it borrows its route engine
  (`get _planner()` → `this._main._planner`; its own `_startBuildPlanner` is empty) and its airway cache, and
  `app.js` only builds it `if (this.routePlannerPanel)`.

## Every entry point today (verified in the code)

| Entry point | Goes to | Needed for the switch |
|---|---|---|
| Route table **EDIT** (`route-table.js:2493`) and **CLEAR → new route** (`:2454`) | current planner (`app.openRoutePlanner`) | dispatch to the active planner |
| Airport popup **Direct-To** (`app.js:796`) → `routePlannerPanel.setDirectTo` | current planner | dispatch; `setDirectTo` on the active one |
| Approach chart **Load procedure** (`cifp:load-procedure`, `app.js:1017`) | preview only if it is already open, else current | dispatch |
| Plan sync **Replan with current winds** (`plan-sync.js:354`) | current planner (`open` + `_onRecomputeTap`) | the new planner has no Recompute: open + winds + check |
| Route table **REV** (`app.reverseActiveRoute` → `reverseAndApply` → `_headless()`) | a headless **current** planner: no airway expansion, full tanks | headless instance of the active class |
| CLR **TO PLANNER** (`app.routeFromClearance`) | preview | — |
| MORE → *Route Planner (preview)* (`tab-bar.js:163`) | preview | rename / remove |
| #74 diagnostic (`app.js:1630`) compares `routePlannerPanel._route` | wrong instance when the preview is open (log noise) | read the active planner |

## What the current planner has that the new one does not

| Feature | Notes | Proposal |
|---|---|---|
| **Altitude comparison table** (ETE/GS/wind/fuel by altitude, ★ fastest) + MOS smooth/bumpy | `_renderOptTable`, `_computeAltComparison`, `_fetchMos` | **Decide** — useful for picking an altitude; could become a sheet from the ALTITUDE box |
| **MEA badges** on airway bubbles | `_fetchRouteMea`; no MEA check in the route checks | **Decide** — an amber check "planned altitude below MEA on V37" fits the route checks |
| Avoid & re-plan / avoid list editor | the list now shows in the preview (amber, *Stop avoiding*) but can't be added to | Decide: drop, or add "Avoid…" to a bubble's sheet |
| Terminal-area T-route wizard | `terminalRouting: 't-routes'` is silently ignored by the preview | Decide: drop (and clear the setting) or port |
| Any date/time departure | preview: today/tomorrow, whole hours (winds only reach ~24 h) | probably enough |
| Reserve 1–30 gal | preview 5–20 | widen the list (small) |
| Drag to reorder; "Change type" menu | preview: Replace / Insert / Remove / Start/End here | drop (drag was unreliable) |

Deliberately dropped already: Recompute (the preview recomputes on every change), Clear's confirm (Undo instead),
self-serve fuel (no NASR data).

## Steps (each small, reversible, tested, its own version)

0. **Land the stack first.** Merge PR #174, then `fix/route-reverse`, then this branch (rebased), after a tablet test of
   the current build. Both stacked branches touch `app.js` and `route-table.js`, so the switch must not start on stale code.
1. **[done v11.50]** **New planner stands alone.** It builds its own route engine and airway cache when there is no current planner;
   `app.js` builds it without depending on `routePlannerPanel`. No visible change. Tests: engine built, Plan route works
   with no `main`.
2. **[done v11.50 — also a Route Planner choice in the config editor]** **One switch, `cockpit-config.json` → `routePlanner: "legacy" | "new"` (default `legacy`).** `app.activeRoutePlanner()`
   and `app.openRoutePlanner(plan)` dispatch on it; all entry points above go through it (EDIT, CLEAR, Direct-To,
   Load procedure, Replan, REV headless via `this.constructor`, the #74 check). Flipping the setting back restores today's
   behaviour exactly. Tests per entry point. **Airport-popup tap check on the tablet** (CLAUDE.md rule) since Direct-To
   is touched.
3. **Parity items (all four required):** altitude comparison table (+MOS), MEA amber check, Avoid in the bubble sheet,
   terminal T-route wizard — each with tests.
4. **Default `new`.** Tablet test (ground, then a flight), user manual rewritten for the new planner in the same commit,
   "(preview)" dropped, MORE entry removed. The current planner stays in the code behind `legacy` for a while.
5. **Later, remove the old screen:** split `RoutePlannerPanel` into a base without UI (keep `_doApply`, `_saveCurrentTrip`,
   `_loadPlan`, `_pillsToWaypoints`, `reversePills`, the fuel-stop picker, `_profileForPower`); delete its DOM/popup/menu/drag/
   altitude-table code, ~200 dead `rpp-` CSS rules, `#routePlannerPanel`, and its Playwright component/smoke specs.

## Data and settings (unchanged by the switch)

- Same keys, never renamed: `flypi_planner_opts` (shared), `flypi_planner_start_fuel` (new planner), `flypi_active_plan`,
  trips via `TripStore`. Both planners write the same trip shape through the shared `_doApply` / `_saveCurrentTrip`.
- One difference to know: the new planner's Apply adds the fixes **along** a typed airway as waypoints (so the magenta
  line follows the airway). `flight_plan.route` is still the bubbles; reload restores by position.

## Risks

- Switching before step 1: the new planner would have no route engine.
- Losing the altitude table / MEA badges quietly removes information a pilot uses.
- REV from the route table uses the old planner's rules until step 2 (full tanks, no airway expansion).
- Everything since v11.43 is untested on the tablet.
