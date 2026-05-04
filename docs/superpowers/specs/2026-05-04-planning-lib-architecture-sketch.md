# Planning Library Architecture Sketch

*Status: approved 2026-05-04 (5-question hybrid sketch).*
*Lightweight design fixed before Spec B (route editing UX) so module boundaries don't shift mid-feature.*
*Defers all strategic questions about converging flywhere + flytab into a unified app — see "Deferred questions" at the end.*

## TL;DR — five decisions

| # | Question | Answer |
|---|---|---|
| 1 | Where does the lib live? | **flytab repo, `web/shared/planning/`** as vanilla JS. flywhere imports it. flytab-first. |
| 2 | Public interface shape | **ESM modules**, pure functions for math + classes for stateful ops, sync where possible / async where data must, **JSDoc with `@ts-check`**. No globals. |
| 3 | Runtime detection | **Pure dependency injection.** Lib knows nothing about Capacitor / browser / server. Each shell injects adapters. |
| 4 | Storage model | **Multiple domain-specific adapter interfaces** — `AeroDataSource`, `WeatherSource`, `PlanStore`, `ProfileStore`, `NetworkStatus`, `Clock`. Lib defines data shapes via JSDoc typedefs. |
| 5 | flywhere consumption | **`file:` sibling dependency.** `flywhere/package.json` → `"flywhere-planning": "file:../flytab/web/shared/planning"`. |

## Repo layout (what lives where)

```
~/flytab/
  web/shared/planning/                  ← THE LIB. Single source of truth.
    package.json                          ONLY for flywhere's npm consumption.
                                            { "name": "flywhere-planning", "type": "module", "main": "./index.js" }
                                            flytab itself loads files via <script type="module">, doesn't read this.
    index.js                              re-exports the public API
    README.md                             this doc, summarized
    types/                                JSDoc @typedef definitions only
      airport.js
      navaid.js
      fix.js
      aircraft-profile.js
      flight-plan.js
      weather.js
    math/                                 pure functions
      route-math.js                       haversine, true/magnetic course, leg time
      engine-data.js                      tas/gph/climbRate (port of flywhere/lib/plan/engine-data.ts)
      fuel-phases.js                      taxi/climb/cruise/descent burn
    planner/                              stateful classes
      route-planner.js                    RoutePlanner class — A* over airway graph
      airway-graph.js                     AirwayGraph class — load + cache
      optimizer.js                        Optimizer — least-fuel / least-time / best-altitude modes
      avoidance.js                        airspace-avoidance constraints → A* cost penalties
    adapters/                             interface definitions only (no impls)
      aero-data-source.js
      weather-source.js
      plan-store.js
      profile-store.js
      network-status.js
      clock.js

  web/shared/planning-adapters/         ← flytab's adapter implementations (NOT in the lib)
    idb-aero.js                           reads NASR from IndexedDB
    fisb-weather.js                       Stratux FIS-B (in-flight tier — direct, no internet)
    flywhere-weather.js                   AWC/NOTAMs/TFRs via flywhere.app proxy (online tier — see below)
    weather-router.js                     selects fisb-weather vs flywhere-weather by NetworkStatus.mode()
    idb-plan.js                           flight plans in IDB
    idb-profile.js                        aircraft profiles in IDB
    capacitor-network.js                  Capacitor Network plugin → online/mode

~/flywhere/
  package.json                            "flywhere-planning": "file:../flytab/web/shared/planning"
  lib/adapters/                           flywhere's adapter implementations
    supabase-aero.ts
    awc-weather.ts
    supabase-plan.ts
    supabase-profile.ts
    browser-network.ts
```

**Importable module names from flywhere:**
- `flywhere-planning` — top-level (re-exports public API)
- `flywhere-planning/math/engine-data`
- `flywhere-planning/math/route-math`
- `flywhere-planning/planner/route-planner`
- `flywhere-planning/planner/optimizer`
- `flywhere-planning/types/flight-plan`
- etc.

**flytab loads the same files via `<script type="module">`** in `index.html`:
```html
<script type="module" src="shared/planning/index.js"></script>
```
Other flytab scripts stay as plain `<script>` tags. Only the planning lib uses ESM.

## Adapter interfaces (contracts the lib expects)

All adapters are **duck-typed** — JSDoc defines the shape; the lib doesn't `instanceof`-check.

```js
// adapters/aero-data-source.js
/**
 * @interface AeroDataSource
 *   Read-only NASR/CIFP queries.
 */
class AeroDataSource {
  /** @param {string} icao @returns {Promise<import('../types/airport.js').Airport|null>} */
  async getAirport(icao) {}
  /** @param {string} id   @returns {Promise<import('../types/navaid.js').Navaid|null>} */
  async getNavaid(id) {}
  /** @param {string} name @returns {Promise<import('../types/fix.js').Fix|null>} */
  async getFix(name) {}
  /** @param {string} airwayId @returns {Promise<Airway|null>} */
  async getAirway(airwayId) {}
  /** @returns {Promise<Airspace[]>} */
  async listAirspace() {}
}
```

```js
// adapters/weather-source.js
/**
 * @interface WeatherSource
 *   Read-only weather. Implementation may pull from FIS-B (in flight),
 *   AWC (online), or a cache (offline).
 */
class WeatherSource {
  /** @param {string} icao @returns {Promise<Metar|null>} */
  async getMetar(icao) {}
  /** @param {{lat:number,lon:number}} point @param {number} altFt @returns {Promise<WindAloft|null>} */
  async getWindAloft(point, altFt) {}
  /** @returns {Promise<Tfr[]>} */          async listActiveTfrs() {}
  /** @returns {Promise<Sigmet[]>} */       async listSigmets() {}
  /** @returns {Promise<Airmet[]>} */       async listAirmets() {}
}
```

```js
// adapters/plan-store.js — read/write
class PlanStore {
  /** @param {string} id @returns {Promise<FlightPlan|null>} */ async get(id) {}
  /** @param {FlightPlan} plan @returns {Promise<string>} id */ async put(plan) {}
  /** @returns {Promise<FlightPlan[]>} */                       async list() {}
  /** @param {string} id @returns {Promise<void>} */            async delete(id) {}
}
```

```js
// adapters/profile-store.js — same shape as PlanStore for AircraftProfile

// adapters/network-status.js
class NetworkStatus {
  /** @returns {boolean} */                                     isOnline() {}
  /** @returns {'home'|'tailscale'|'internet'|'offline'} */     mode() {}
}

// adapters/clock.js
class Clock {
  /** @returns {number} ms since epoch */                       now() {}
}
```

## Boot sequences

### flytab (Capacitor on tablet)

```js
// web/app.js (excerpt)
import { RoutePlanner, Optimizer } from './shared/planning/index.js';
import { IdbAeroData }       from './shared/planning-adapters/idb-aero.js';
import { FisbWeather }       from './shared/planning-adapters/fisb-weather.js';
import { FlywhereWeather }   from './shared/planning-adapters/flywhere-weather.js';
import { WeatherRouter }     from './shared/planning-adapters/weather-router.js';
import { IdbPlanStore }      from './shared/planning-adapters/idb-plan.js';
import { IdbProfileStore }   from './shared/planning-adapters/idb-profile.js';
import { CapacitorNetwork }  from './shared/planning-adapters/capacitor-network.js';

const network = new CapacitorNetwork();

const adapters = {
  aero:     new IdbAeroData(idb),
  weather:  new WeatherRouter(network, {
              inFlight: new FisbWeather(stratuxClient),
              online:   new FlywhereWeather('https://flywhere.app/api'),
            }),
  plans:    new IdbPlanStore(idb),
  profiles: new IdbProfileStore(idb),
  network,
  clock:    { now: () => Date.now() },
};
this.routePlanner = new RoutePlanner(adapters);
this.optimizer    = new Optimizer(adapters);
```

### flywhere (Next.js on Vercel)

```ts
// app/(pilot)/plan/components/PlanWorkflow.tsx (excerpt)
import { RoutePlanner, Optimizer } from 'flywhere-planning';
import { SupabaseAeroData } from '@/lib/adapters/supabase-aero';
import { AwcWeather }       from '@/lib/adapters/awc-weather';
// ... etc

const adapters = { aero, weather, plans, profiles, network, clock };
const planner = new RoutePlanner(adapters);
```

**Adapters always live in the shell's repo, never in the lib.**

## Online data routes through flywhere.app

flytab's online weather/NOTAMs/TFRs/winds are **proxied through flywhere.app**, not fetched directly from AWC / FAA NMS-API / NWS. This is non-negotiable because:

- **CORS.** AWC partially supports CORS; FAA NMS-API and several NOTAM/TFR feeds do not. A flytab browser shell at `localhost:8000` (dev) or any non-`*.aviationweather.gov` origin gets blocked by the browser's preflight check. Capacitor on Android escapes CORS via the native bridge, but the same code in any browser shell hits the wall.
- **Rate-limiting and API keys.** FAA NMS-API requires registered credentials; embedding them in client code (especially on a tablet APK) leaks them. flywhere.app holds the credentials server-side.
- **Caching and amortization.** flywhere.app can cache aggressively (METARs revalidate every minute, TFRs every 5 min, winds every hour) and serve all of flytab's calls from cache. Direct calls would hit upstream providers redundantly.
- **One throat to choke.** When AWC changes a field name (and they do), one update to flywhere.app's proxy fixes flytab everywhere. No client deploys required.

**Consequence on the architecture:** the lib's `WeatherSource` interface is unchanged — it still asks `getMetar(icao)`. Where the call goes is an **adapter implementation** decision, set at boot:

| Tier | flytab adapter | Where it actually fetches from |
|---|---|---|
| In-flight (no internet, FIS-B available) | `FisbWeather` | Stratux WebSocket — direct, no proxy |
| Online (any internet path: home WiFi, Tailscale, cellular) | `FlywhereWeather` | `https://flywhere.app/api/wx/*` — proxied |
| flywhere shell itself | `AwcWeather` (server-side) | Direct from AWC/FAA — server can call without CORS |

The `WeatherRouter` adapter (in flytab's adapter dir, not in the lib) inspects `NetworkStatus.mode()` and delegates to the right tier on each call.

**flywhere.app endpoint shape (TBD in its own brainstorm — this sketch only commits to the routing decision):**
```
GET  /api/wx/metar?icao=KLKR
GET  /api/wx/taf?icao=KLKR
GET  /api/wx/winds-aloft?lat=33.0&lon=-85.0&alt=6000
GET  /api/wx/tfrs?bbox=...
GET  /api/wx/sigmets
GET  /api/wx/airmets
GET  /api/notam?icao=KLKR
```
Each returns the same JSON shape the corresponding `@typedef` in `web/shared/planning/types/weather.js` defines. flywhere is responsible for normalizing AWC/FAA quirks (e.g., G-AIRMET altitudes-in-hundreds-of-feet, FZL string handling per CLAUDE.md) before returning.

**Failure path:** if `https://flywhere.app/api/*` returns 5xx or times out, the `FlywhereWeather` adapter throws a typed `WeatherUnavailable` error. The Spec B UI handles it with a "weather data unavailable — using cached" badge; the planner uses last-cached values from IDB.

## Sibling-repo setup (one-time)

```bash
# Confirm sibling layout (already true on your workstation):
ls ~/flytab ~/flywhere

# In flywhere, install the file: dep:
cd ~/flywhere
npm install
# Picks up file:../flytab/web/shared/planning automatically.
```

If you ever need a writable dev link instead of an install snapshot:
```bash
cd ~/flywhere && npm link ../flytab/web/shared/planning
```

## CI configuration (flywhere only)

flytab's CI doesn't need flywhere. flywhere's CI needs flytab cloned as a sibling:

```yaml
# .github/workflows/build.yml
- uses: actions/checkout@v4
  with: { repository: dnickerson/flywhere, path: flywhere }
- uses: actions/checkout@v4
  with: { repository: dnickerson/flytab,  path: flytab }
- run: cd flywhere && npm install && npm run build
```

The relative `file:../flytab/...` path resolves correctly inside the runner because the two checkouts are siblings.

## Day-to-day development workflow

**Edit lib code:** edit files in `~/flytab/web/shared/planning/`.
- **flytab** picks up immediately on next page reload — no build step.
- **flywhere** picks up after `npm install` (or `npm link` during active dev).

**Type-check the lib (no emit):**
```bash
cd ~/flytab/web/shared/planning
npx tsc --noEmit --allowJs --checkJs --target es2022 --module esnext --moduleResolution bundler
```
JSDoc `@ts-check` directives at the top of each file enable the checker. No `tsconfig.json` for emit; just for checking.

**Test (no DOM, no network):**
```js
// example
import { RoutePlanner } from 'flywhere-planning';

const fakeAero = { getAirport: async (icao) => ({ icao, lat: 33.0, lon: -85.0 }) };
const fakeWx   = { getMetar: async () => null, listActiveTfrs: async () => [] };
const planner  = new RoutePlanner({ aero: fakeAero, weather: fakeWx, /* … */ });
const plan = await planner.plan({ departure: 'KLKR', destination: 'K44N' });
```

## Debugging cheat sheet

| Symptom | First check |
|---|---|
| flywhere can't `import 'flywhere-planning'` | `~/flytab` and `~/flywhere` are siblings? `cd ~/flywhere && npm install` was run? `flywhere-planning/package.json` has `"name": "flywhere-planning"` and `"main": "./index.js"`? |
| flytab `Failed to load module script` | Tag is `<script type="module">` not bare `<script>`? Path is from `web/` root? File ends in `.js`? |
| `RoutePlanner is not a constructor` | Imported from `flywhere-planning` (which re-exports) or directly from `flywhere-planning/planner/route-planner`? Each module uses named exports. |
| Adapter throws "method not implemented" | Compare your impl to the JSDoc `@interface` in `adapters/<name>.js` — implement every method, even if it returns `null` / `[]`. |
| flywhere `tsc` errors on lib types | Lib JSDoc and adapter implementation drifted. Run `tsc --noEmit` in the lib dir to see which `@typedef` changed. |
| Stale data in flywhere after editing lib | `npm install` doesn't re-link. Use `npm link` during active development, or re-run `npm install`. |
| flytab WebView crashes on `import` | Capacitor's WebView on Android < 5 doesn't support ESM. flytab targets API 21+ which does. Check `android/app/build.gradle` `minSdkVersion`. |
| Tests pass on flywhere but plan is wrong on flytab | Check the adapter implementations — math is shared, data plumbing is not. Likely the FIS-B weather adapter is returning a different shape than AWC. Use the JSDoc `@typedef` as the contract. |
| flytab in browser shows "weather data unavailable" | `https://flywhere.app/api/wx/*` reachable from your browser? Open one in a new tab. CORS preflight passing? Check Network tab for OPTIONS. Don't try to call AWC directly to "fix" it — that's exactly the CORS issue this routing solves. |
| flytab in flight has no weather | Stratux WebSocket connected? `FisbWeather` adapter receiving frames? `WeatherRouter` should auto-fall through to FIS-B when `NetworkStatus.mode() === 'offline'`. |

## What this enables

- **Unit-test the planner with mock adapters.** No DOM, no network, no IDB. ~5 lines of test setup.
- **Add a new shell (CLI, edge function, second mobile app)** by writing 5–7 adapter classes. Lib unchanged.
- **flywhere and flytab share the same fuel/wind/optimize math.** No drift, no parallel implementations.
- **Migration from flywhere TypeScript:** copy `flywhere/lib/plan/*.ts` → `flytab/web/shared/planning/math/*.js`; replace `interface X` with `@typedef X`; replace `: number` with `/** @type {number} */`; mechanical.

## What this does NOT address (correctly out of scope)

- **Cross-runtime UI sharing.** Each shell owns its UI; the planning lib has no DOM, no React, no styling.
- **Auth model.** flywhere has Supabase auth; flytab has none. Adapters handle their own auth.
- **Data sync between shells.** flytab IDB and flywhere Supabase do not sync automatically. Future work.
- **Offline on flywhere.** flywhere is online-only today. If offline is added, adapters get a caching layer; lib unchanged.
- **Versioning the lib.** flywhere consumes whatever HEAD of flytab provides. If a second consumer ever appears, switch to npm publish.
- **Garmin GPS 175 sync.** Out of scope per Connext research (no realistic OSS path).

## Deferred questions (own brainstorms when needed)

1. **Cross-runtime / unified-app strategic direction** — converge flywhere + flytab into one product, or keep them as two apps sharing a lib? 1–2 day brainstorm.
2. **Spec B — Route editing UX** — paste/Apply/Apply-&-Close, bidirectional map↔list, smart-suggest avoidance, three-tier mode awareness, generic copy/share. **Next**, after this sketch is approved.
3. **flywhere.app proxy endpoint design** — exact URL paths, auth (if any), response shapes, rate limits, caching policy, error contract. Bounded by the typedefs in `web/shared/planning/types/weather.js` but the wire protocol is its own design. Must land before flytab's `FlywhereWeather` adapter can be implemented.
4. **Garmin GPS 175 interop** — deferred indefinitely; no realistic OSS path.
5. **Wind-corrected leg ETE & TFR-on-route check** — bundled into Spec B.
