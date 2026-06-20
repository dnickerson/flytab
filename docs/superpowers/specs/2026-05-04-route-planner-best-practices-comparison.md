# FlyTab Route Planner: Best Practices Comparison

*Date: 2026-05-04*
*Context: Assessment of FlyTab's route editor against modern EFB route-planning practices, scoped to an RV-9A VFR-primary mission profile.*

## Executive read

FlyTab has the **bones** of a modern planner — directed airway/fix graph, A* search, first-class airways with MEA, basic SUA conflict checking, fuel-stop logic, persistent flight plans. It is missing most of the **sensing layers** that turn a graph search into a flight plan: wind-corrected ETE, magnetic variation, altitude-aware optimization, terrain/MEA enforcement, weather/TFR-in-the-loop checks, validation warnings, and standard export formats. For a VFR-primary RV-9A EFB, the gaps that actually bite a pilot are #1 (wind), #2 (mag var), #5 (altitude rule), #8 (validation), #9 (TFRs) — far more than airway-graph polish.

## What FlyTab has today

Inventory of the current implementation, sourced from `routePlanner.js`, `routeEditor.html`, `web/cockpit/route-*.js`, `web/shared/flight-plan-model.js`, and `web/shared/weather-client.js`.

- **Waypoint types:** airport, VOR/navaid, named fix, lat/lon GPS direct, airway label. No user-defined waypoint UI; all fixes come from IndexedDB stores `airports`, `navaids`, `fixes`.
- **Route entry & editing:** typed string in `routeEditor.html`, manual pill entry with type selector, automatic A* routing via `RoutePlanner.plan()`. Drag reorder, delete, insert before/after, change type via right-click. Persists to `flight_plans` IDB store (`routePlanner.js:939-950`).
- **Airways:** first-class. `AirwayGraph` (`routePlanner.js:261-356`) builds a bidirectional graph with `{to, distNm, mea, airway}` edges from CIFP. A* prefers airways purely on distance cost; MEA is reported but not used in pathfinding (`routePlanner.js:381-382`).
- **Leg computation:** distance (haversine), true course, ETE (distance ÷ KTAS), fuel burn (time × GPH), cumulative time/fuel, ARTCC by latitude band (`routePlanner.js:733-789`). **Magnetic variation is not implemented.**
- **Wind aloft:** `WeatherClient.fetchWindsAloft()` exists (`weather-client.js:100`) but is **not applied** to leg ETE/GS.
- **MEA / MOCA / terrain:** MEA parsed and stored per segment (`routePlanner.js:242-245, 311`) but not enforced. Terrain shown on profile (`route-profile.js:29-38`) but not used for planning warnings.
- **Airspace:** SUA R/P only with 5 NM buffer + DC P-40 hardcoded (`routePlanner.js:61, 194-212`). Avoidance fix insertion if conflict detected (`routePlanner.js:541-584`). **Class B/C/D/E and TFRs are not checked.**
- **NOTAMs / weather:** fetched post-route via `WeatherClient.fetchAllForRoute()` (`weather-client.js:21-54`); cached to `weather_cache`. NOTAMs and TFRs are placeholders (empty arrays, `weather-client.js:40-41`).
- **Optimization:** shortest-path only. No fastest, most-fuel-efficient, or weather-avoidance modes. Fuel-stop sequencing is greedy nearest-stop (`routePlanner.js:684-725`).
- **Alternates / W&B:** alternates field exists in model (`flight-plan-model.js:57`) but unpopulated. `WbCalculator` exists but isn't called by route planner.
- **Export:** track-log CSV/GPX only. **No route export** to GPX, FPL, ICAO Field 15, or KML.

## What modern EFBs do

Synthesized from documentation for ForeFlight, Garmin Pilot, FltPlan, SkyVector, autorouter.aero, plus academic work (NASA NTRS, EUROCONTROL BADA, OpenAP).

A complete modern route planner is built around a **directed airway/fix graph** queried with bidirectional A* (or contraction-hierarchy-accelerated Dijkstra) whose edge cost is **time over ground using GFS winds aloft** rather than great-circle distance, with edges parameterized by altitude so the search jointly picks route + altitude. On top of that:

- A **performance model** (POH lookup tables interpolated bilinearly in altitude/temperature/weight, sometimes fitted as bivariate polynomials BADA/OpenAP-style) drives fuel/ETE.
- A **rule layer** scores candidates against FAA Preferred Routes, TEC routes, recent ATC clearances, and (in EU) IFPS/CFMU validation. ForeFlight's Recommended Route engine "analyzes thousands of possible routes... while also accounting for preferred routes, recent ATC cleared routes, and how frequently a given route is assigned" — explicitly mining up to a year of clearance history per city pair.
- A **hazard layer** intersects the corridor against terrain (DEM), Class B/C/D/E, SUA/MOA, TFR polygons, SIGMET/AIRMET volumes, freezing-level forecasts, and PIREPs.
- UX is two-modal: a **typed ICAO Field-15 route bar** and a **rubber-band-on-map** editor, both backed by the same canonical route object that round-trips to ICAO, GPX, FPL, FMS, and .pln.

## Topic-by-topic comparison

| # | Topic | Industry standard | FlyTab today | Gap |
|---|---|---|---|---|
| 1 | **Routing graph & search** | Bidirectional A* with vertical-profile heuristic; CH for repeat queries | A* with distance heuristic over NASR airway graph (`routePlanner.js:390-439`) | Heuristic is great-circle distance, not time. Fine for MVP. |
| 2 | **VFR vs IFR mode** | Same graph, different penalties (DCT free in VFR, MEA off, Class B floor stay-below) | No mode switch; one graph behavior | Missing a pilot-visible "VFR direct ↔ IFR airway" toggle |
| 3 | **Preferred / TEC routes** | FAA NFDC PRD + recent-clearance database scored into edge weight | None | Skip for now — not VFR-relevant; add if IFR usage grows |
| 4 | **Wind-optimal** | Edge cost = ETE using GFS winds aloft per altitude | TAS is constant, no wind applied. `WeatherClient.fetchWindsAloft()` exists but isn't wired to legs (`weather-client.js:100`) | **Major.** ETE/fuel are wrong on every leg. 1-day fix to apply forecast wind post-route; 1-week to put it in the search. |
| 5 | **Altitude optimization** | FAR 91.159 hemispheric rule + MEA + wind-vs-TAS tradeoff | User picks one cruise altitude; no rule check, no MEA enforcement | **Major for RV-9A.** Hemispheric-rule warning is ~1 hour of work. |
| 6 | **Performance modeling** | POH bilinear table (alt, temp, weight) → climb rate, TAS, FF | Single KTAS + GPH constants on aircraft profile | Aircraft is fixed (one O-360); can promote `aircraft-config.json` to alt/temp tables |
| 7 | **Fuel planning** | Taxi + climb + cruise + descent + reserve + alternate + contingency | Cruise + reserve only; alternate field exists but unpopulated (`flight-plan-model.js:57`) | Climb-fuel and taxi-fuel buckets are easy wins |
| 8 | **Terrain / obstacle clearance** | DEM corridor sampling, max-elevation per leg, vertical profile | Profile view exists (`route-profile.js:29`) but doesn't drive warnings or auto-altitude | The data is in the app; just needs a "min safe altitude per leg" badge |
| 9 | **Airspace checking** | Polygon-polygon corridor sweep against B/C/D/E + SUA + TFR with active-time | SUA R/P only with 5 NM buffer (`routePlanner.js:194`); no Class B/C/D/E, no TFR | TFR is the highest-value add — pilots violate them constantly. FAA TFR GeoJSON feed is straightforward |
| 10 | **Weather per leg** | METAR/TAF interp at samples, SIGMET/AIRMET hit-test, freezing-level vs cruise | Briefing pulls weather post-route (`weather-client.js:21-54`); not per-leg, no freezing-level check | wx-briefing already has the data — wiring it to leg highlights is mostly UI |
| 11 | **Route entry syntax** | ICAO Field 15 (`KJFK V16 KEMPR DCT...`), tolerant parser | Pill editor + add-input; airway-aware. No paste-from-clearance | Add an ICAO Field 15 paste box; ~half day |
| 12 | **UX patterns** | Typed bar + map rubber-band, both editing same model | Pill editor with drag/right-click; map tap to add waypoint exists | Solid; matches modern EFBs. Rubber-band drag of in-flight legs is the next step |
| 13 | **Validation warnings** | Backtrack / >1.3× GC / restricted transit / fuel short / runway short / ETA past sunset / MEA > ceiling | Reserve check only (`routePlanner.js:767`) | Each of the others is ~30 lines of code; biggest pilot-safety lever in the list |
| 14 | **Export formats** | ICAO F15, Garmin .FPL, X-Plane .FMS, GPX, ForeFlight | None — JSON to IDB only | Add GPX (universal) + Garmin .FPL (so pilot can load the route into the panel GPS as backup). Half day each. |
| 15 | **Notable algorithms** | autorouter heuristic search, NASA DWR, BADA/OpenAP perf | n/a | Not relevant to single-pilot piston EFB |

## Recommended next steps, ranked for an RV-9A VFR EFB

1. **Wind-correct ETE/fuel on every leg.** `WeatherClient.fetchWindsAloft()` already exists. Apply it in `RoutePlanner.buildLegs()` (`routePlanner.js:733-789`). Day-1 win — every existing route immediately becomes accurate.
2. **Magnetic variation for course.** Carry mag-var per waypoint from NASR (or use a WMM library); display magnetic course alongside true. Pilots fly magnetic; true-only is a foot-gun.
3. **Hemispheric cruising-altitude warning** (FAR 91.159). Compare entered cruise altitude to each leg's magnetic course; flag wrong-side-of-the-rule.
4. **TFR overlay + route conflict check.** FAA's TFR GeoJSON feed → polygon corridor test against the route. Highest safety payoff per LOC.
5. **Validation banner** with backtrack, excessive-deviation, runway-too-short, ETA-past-sunset checks. Each is small; together they're what makes an EFB feel "smart."
6. **Climb/taxi fuel buckets.** Even with constants, splitting fuel planning into start/taxi + climb + cruise + reserve makes the reserve-margin number truthful.
7. **GPX + Garmin .FPL export.** So the pilot can hand the route to the panel GPS and to anyone else.
8. **Class B/C/D ceilings/floors check.** Once SUA polygon machinery is generalized, this is the same code path with different layers.

The MEA-enforcement, altitude-search-in-A*, POH performance tables, and ATC-clearance learning are all real but lower-priority for the RV-9A VFR-day-VMC-primary mission profile.

## Sources consulted

- ForeFlight Recommended Route, Performance Guide v13.7, fuel/altitude support docs
- autorouter.aero wiki (routes, DCTs, FAQ)
- FAA: NFDC Preferred Routes Database, ICAO FPL Quick Reference, Section 17 Preferred IFR Routes, TFR GeoJSON portal
- NASA NTRS: A*-with-vertical-profile, Bellman-Ford for time-varying winds, Dynamic Weather Routes, Traffic Aware Planner
- EUROCONTROL: BADA performance tables, eTOD Manual, IFPS
- Geisberger 2008 (contraction hierarchies)
- OpenAP (MDPI 2020), MDPI Discrete-Continuous Free Flight Planning
- AOPA / FAA PHAK Ch.11 (density altitude), Boldmethod cruise-altitude guide, Code7700 ROC
- Little Navmap route-description and flight-plan-format docs
- FAA-Aviation-Data-Portal/tfrs, pventon/ICAO-F15-Parser, fboes/aerofly-missions
