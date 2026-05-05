# flywhere-planning

Shared flight planning library — pure math + stateful planner. No DOM, no IDB,
no network. Adapters are injected by the consumer.

See `docs/superpowers/specs/2026-05-04-planning-lib-architecture-sketch.md` for
the full design.

## Public API

- `RoutePlanner({ aero, weather, plans, profiles, network, clock })` — A* over
  the airway graph; methods: `plan(opts)`, `parseRoute(str)`, `recomputeLegs(plan)`.
- `Optimizer(adapters)` — least-fuel / least-time / best-altitude modes.
- `AirwayGraph(aero, opts)` — loads + caches airway adjacency, filterable by
  routing mode.
- Math helpers under `math/`.
- Type `@typedef`s under `types/`.
- Adapter `@interface` definitions under `adapters/`.

## Adapters expected by the consumer

See `adapters/*.js` for full contracts. Six required:
`AeroDataSource`, `WeatherSource`, `PlanStore`, `ProfileStore`,
`NetworkStatus`, `Clock`.
