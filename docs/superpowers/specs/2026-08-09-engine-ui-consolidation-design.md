# Engine UI Consolidation — Design

## Goals

1. **One engine-monitor UI, not two.** FlyTab's ENG page (`web/cockpit/engine-page.js`) becomes the only human-facing engine-monitor UI. The Pi's own embedded dashboard (`engine-monitor/engine_monitor.py`'s `HTML_TEMPLATE`, served at `/`) is deleted. The Pi keeps providing data/control over its existing HTTP/WebSocket API — it just stops rendering a page.
2. **Fix the bug that motivated this**, not just the duplication. `auto_capture_monitor` has no "manually stopped" latch: any Stop while the engine is still running gets silently overridden ~15s later, regardless of which UI (or how many) issued it. This is fixed as part of this work, independent of the UI consolidation itself — removing the second UI does not fix it on its own.
3. **Reduce Pi CPU/network load**, since the Pi also runs Stratux (ADS-B/GPS/UAT) and that's the safety-critical service on the device. The dashboard's own JS polls the Pi continuously when open in a browser (`/api/status` at 1Hz, chart data every 2s, `/api/files` every 10s — `engine_monitor.py:3347-3352`) — load that exists purely because a second UI exists. Deleting it removes that polling path entirely. Retiring the dead server-side sticky-valve computation (see below) is a smaller additional saving in the same direction.
4. Port the Pi-only features that have real pilot value into FlyTab; drop the ones that don't, rather than porting everything reflexively.

## Non-Goals

- Not fixing `/api/shutdown` or `/api/atis`'s lack of authentication (same class of issue as the `/api/upload` fix in `d499cb3`) — flagged for separate follow-up, not blocking this work.
- Not wiring up the K-factor "apply" flow (`POST /api/fuel/calibration/applied`) — it has no caller in either UI today; that's a pre-existing gap, not something this consolidation broke or is responsible for fixing.
- Not touching `EngineAdvisor.java`'s on-device sticky-valve ML advisory (`STICKY_VALVE_LAG_THRESHOLD_F`) — different algorithm, different runtime (always-on-device vs. Pi-dependent), and its threshold is an explicitly unvalidated placeholder per existing CLAUDE.md guidance. Left alone.
- Not touching the deliberate fuel-sync mirror (`fuel-overlay.js` posting to `/api/fuel/set`/`/api/fuel/add`) — documented as intentional in `docs/superpowers/specs/2026-07-31-fuel-management-consistency-design.md:38`.
- Not finishing `flight-sync.js`'s Phase 3 (device file sync/download) — made unnecessary by the captured-files decision below, stays a stub for whatever future need reopens it.

## Architecture: Pi dashboard removal

Delete `engine_monitor.py`'s `HTML_TEMPLATE` and the `do_GET('/')` branch that serves it, along with everything embedded in that one page: the header (Start/Stop/Shutdown buttons, status/connection badges), all gauges, the recording section, the captured-files browser, the ATIS override form, and the browser-based script-upload form (`<input id="uploadInput">`). None of these are separate routes — they're all one HTML template — so this is a single deletion, not several.

Replace `/` with a minimal static-text response (e.g. `"Engine Monitor API running — see FlyTab"`, `Content-Type: text/plain`) so a browser hitting the Pi's IP during ground troubleshooting gets a sane reachability signal instead of a 404.

**All API routes are unchanged** — `GET /api/status`, `POST /api/start`, `POST /api/stop`, `GET/POST /api/atis`, `GET /api/fuel/*`, `POST /api/upload`, `GET /api/files`, `GET /static/chart.min.js`, etc. all stay exactly as they are today. FlyTab already depends on most of these; this consolidation only changes who calls `/api/files` and the upload endpoint (nobody, after this — see below), not their shape.

`deploy-pi.sh`'s rsync-over-SSH remains the supported way to update `engine_monitor.py` on the Pi. The browser upload form is dropped without replacement.

## Feature disposition

| Feature | Decision | Notes |
|---|---|---|
| RPM, MAP, FF, OilTemp, OilPress, Volts, CarbTemp, %Power, Mixture, BSFC, EGT×4, CHT×4 (+trends), fuel display | No change | Already rendered 1:1 by FlyTab; Pi copies just stop existing when the dashboard is deleted |
| Start/Stop (capture) | Consolidate on FlyTab's existing controls | Already hits the same `/api/start`/`/api/stop` from both UIs today — this is the original duplication; after this work only FlyTab calls them |
| Shutdown | **Drop, do not port** | Systemd (`deploy-pi.sh` installs `engine-monitor.service` with `Restart=always`, `RestartSec=5`, `WantedBy=multi-user.target`, enabled) auto-restarts the process ~5s after `server.shutdown()` — this button is really "bounce the process," not a durable stop. Its own confirm-dialog text ("You will need to restart it manually or reboot") is already stale relative to the systemd-managed deploy. Real-recovery path (`ssh ... systemctl restart engine-monitor`) is already documented in `deploy-pi.sh`'s own output and stays SSH-only. |
| TAS | **Port**, relabeled | Pi's `tas` field (`get_status()`) is `ground_speed × (1 + density_altitude/1000 × 0.02)` — a wind-uncorrected approximation per the Python function's own docstring, not a true pitot-derived airspeed. Display in `engine-page.js` with wording that doesn't imply instrument accuracy, e.g. "Est. TAS (no wind corr.)". `engine-client.js` does not currently parse `tas` at all — needs adding. |
| Cruise Targets (target FF / power / mixture mode) | **Port** | Status payload fields: `target_fuel_flow` (number, GPH), `target_power` (number, %), `target_mode` (string) — all already published by `get_status()`, just unconsumed by `engine-client.js` today. |
| ATIS manual altimeter/OAT override | **Port** | `POST /api/atis` body `{altimeter: number|null, oat: number|null}` (either key omitted = no change, `null` = clear override, matching the Pi dashboard's existing `atisAltimeter`/`atisOat` form behavior at `engine_monitor.py:3718-3742`). Current override state is echoed back in `get_status()` as `manual_altimeter`/`manual_oat` (`null` when unset) — FlyTab's UI should reflect an active override the same way the Pi dashboard does today (highlight/badge), not just provide a blind input field. |
| Captured-files browser + download | **Drop entirely** | Tablet's own recording (`engine-ml.js`'s 1Hz ring buffer, `flypi_ml_logs` IDB store via `logbook.js`) already covers the flight-review use case pilots actually need. Note the tablet log is a reduced set — 12 ML-model channels at 1Hz, capped at 3 hours (`engine-ml.js:17`) — not a byte-for-byte copy of the Pi's raw serial-capture CSV (more raw fields, no duration cap, native poll rate). Raw CSVs keep being written on the Pi as they are today; they're just SCP/SSH-only from here, no UI on either side. `GET /api/files` stays as an API route even though nothing calls it after this, since it costs nothing to leave and a future tool might. |
| Browser-based script-upload form | **Drop**, no replacement | See Architecture section — `deploy-pi.sh` is the real deploy path. |

## Root-cause fix: `auto_capture_monitor` manual-stop latch

**Problem** (`engine_monitor.py:4677-4711`): `auto_capture_monitor` runs in a background thread and, whenever `state.capturing` is `False`, probes the serial port every ~15s and calls `start_capture()` if it sees live EDM data. It has no way to distinguish "capture never started this session" from "pilot just deliberately stopped it and the engine is still running" — so a manual Stop gets silently overridden within ~15s if the engine hasn't been shut down, fragmenting recordings into multiple files and making FlyTab's "✓ Saved" confirmation transient (reverts to "● REC" within seconds).

**Fix:** Add a `state.manually_stopped` boolean (or equivalent), initialized `False`:
- Set `True` inside `stop_capture()` whenever it's invoked via the `/api/stop` HTTP path (i.e. an explicit pilot action), not on any other exit path.
- Cleared (`False`) by `start_capture()` — an explicit Start re-arms auto-capture — and by RPM dropping below 300 (the same threshold used elsewhere in this codebase — e.g. `engine-page.js`'s sticky-valve check — as the "engine has stopped" convention, kept independent of `check_sticky_valve()` itself since that function is deleted below). This is a simple inline check inside `auto_capture_monitor`'s own loop (it already reads the latest sample each pass) — no new state-tracking function needed. This ensures the *next* flight's auto-capture isn't permanently disabled by this flight's manual stop.
- `auto_capture_monitor`'s loop skips the `start_capture()` call (but keeps probing on its normal cadence, so it still recovers state correctly on the next real engine-start) while `state.manually_stopped` is `True`.

This directly closes the traced bug (fragmented recordings, transient "✓ Saved") independent of the UI-consolidation work — even a single remaining UI would hit this without this fix.

## Sticky-valve detection disposition

Three independent implementations exist today, not two:

1. **Python, `check_sticky_valve()`** (`engine_monitor.py:1251`) — EGT-ratio threshold + time-persistence during a warmup window, runs server-side on the Pi. **No consumer**: `engine-client.js` never reads any sticky-valve field from the Pi's status payload. This implementation only ever reached a human via the Pi's own dashboard.
2. **JS, `engine-page.js:_checkStickyValve()`** (line 695) — same strategy (ratio + persistence), independently parameterized (`stickyValveEgtRatio: 0.50`, `stickyValveMinEgt: 200`, `stickyValvePersistSec: 30`, `stickyValveWarmupMin: 10`), fully tablet-side. This is the signal FlyTab pilots actually see today.
3. **Java, `EngineAdvisor.addStickyValveCheck()`** — a different algorithm (EGT rise-rate lag comparison vs. an absolute-ratio threshold), gated on the 12-phase FSM's `startup` phase, also fully tablet-side, part of the on-device EngineML pipeline. `STICKY_VALVE_LAG_THRESHOLD_F` (150°F) is an explicitly unvalidated placeholder per existing CLAUDE.md guidance.

**Decision:**
- Delete Python's `check_sticky_valve()`, its call sites, and associated `state.sticky_valve_*`/`/api/dismiss_sticky_valve` machinery — dead code once the dashboard is gone, no consumer ever existed on the FlyTab side.
- Keep #2 (`engine-page.js`) as the primary, always-active sticky-valve signal — it's the mature implementation, mirrors the original validated Python design intent, and already runs entirely on-device.
- Leave #3 (`EngineAdvisor.java`) untouched as a secondary, still-experimental signal. **Do not merge #2 and #3** — different algorithms, different validation status; merging now would mean shipping the unvalidated threshold as if it were load-bearing for the primary signal.

## Testing & verification

- `npm test` covers `web/shared/planning/` and any `tests/cockpit/*.test.js` files (e.g. the pattern in `tests/cockpit/engine-overlay.test.js`) — new FlyTab-side logic (TAS display, Cruise Targets, ATIS override UI, the ported fields in `engine-client.js`) should get equivalent coverage where the existing test harness pattern applies (`new Function(src + '\nreturn ClassName;')()`, see any file under `tests/cockpit/`).
- `auto_capture_monitor`'s manual-stop latch has no JS test coverage possible (pure Python, Pi-side, no serial hardware in CI) — verify via `test-pipeline.sh` (full pipeline replay) plus a direct manual test: start capture, hit Stop while a simulated engine is still "running" (via `data_simulator.py`), confirm capture does *not* resume within the old ~15-20s window, confirm it *does* resume on the next real engine start after this flight ends.
- Pi dashboard deletion: verify `GET /` returns the new plain-text response and that every API route FlyTab depends on (`/api/status`, `/api/start`, `/api/stop`, `/api/atis`, `/api/fuel/*`) still returns identical shapes to before — this should be a pure subtraction of dashboard code with zero change to any API handler.
- No `PI_API_CONTRACT` bump needed — every field being newly *consumed* by FlyTab (`tas`, `target_fuel_flow`, `target_power`, `target_mode`, `manual_altimeter`, `manual_oat`) already exists on the wire today; nothing about the wire shape changes.
- Per CLAUDE.md's Tap Handler Regression Rule and general UI-testing requirement: any change to `engine-page.js` needs on-device or CDP verification that the ENG page still renders and updates correctly, not just `npm test` passing.
